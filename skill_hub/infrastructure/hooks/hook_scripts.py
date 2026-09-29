"""Hook scripts — managed bodies on disk + sync-time command baking.

A hook is either a shell ``command`` or a ``script`` (``hooks_model.HookScript``).
A script lives in one of two places:

  * **managed** — a hub-owned body at ``<data_home>/hooks/<name>/script.<sh|py>``,
    project-agnostic, editable in the app, baked into an ABSOLUTE command so it
    runs the same from every project.
  * **repo** — a relative path inside each project the hook is attached to, baked
    verbatim (harnesses run hook commands from the project root — the same
    assumption the built-in ``lsp-report`` bake relies on).

``bake_script_hooks`` generalizes the ``lsp_report_sync`` precedent: it runs once
per scope from ``hub._run_hooks_stream``, right after the lsp-report bake and
before any adapter sees the resolved hooks, and rewrites ``command`` in place. It
NEVER touches a built-in (built-ins own their own materialization) nor a hook
without a script. A managed body that is missing at sync time is DROPPED from the
scope with a warning rather than written as a command that cannot run; the
``HOOK_SCRIPT_MISSING`` doctor finding explains it.
"""

from __future__ import annotations

import re
import shlex
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

from skill_hub import hub_core
from skill_hub.infrastructure.permissions.permission_adapters import _atomic_replace

if TYPE_CHECKING:  # pragma: no cover - typing only
    from skill_hub.domain.hooks.hooks_model import HookScript, ResolvedHook
    from skill_hub.domain.permissions.permissions import Scope

WarnFn = Callable[[str], None]

#: Data-home dir holding every managed script body (one sub-dir per hook).
MANAGED_DIR_NAME = "hooks"

#: A hook name is a slug — `hub hook new` enforces it (``validate_slug``), but the
#: registry is a plain YAML file that a hand edit, a restored backup, or a
#: third-party writer can put an arbitrary string into. `managed_script_dir` is the
#: ONE place where a name becomes a filesystem path, so the slug is re-checked
#: there: without it, a name like ``../victim`` escapes the data home on every
#: ensure/write/rename — and on the ``shutil.rmtree`` in
#: `remove_managed_script_dir`.
_NAME_RE = re.compile(r"[a-z0-9-]+")

_STUBS = {
    "bash": "#!/usr/bin/env bash\n# {name} — managed hook script.\n",
    "python3": '#!/usr/bin/env python3\n"""{name} — managed hook script."""\n',
}


def _default_warn(message: str) -> None:
    print(f"  ! {message}", file=sys.stderr)


def _resolve_data_home(data_home: Optional[Path]) -> Path:
    if data_home is not None:
        return Path(data_home)
    return Path(hub_core.data_home())


# ─────────────────────────────────────────────────────────────────────────────
# Managed body on disk
# ─────────────────────────────────────────────────────────────────────────────


def validate_managed_name(name: str) -> str:
    """Return ``name`` when it can safely address a managed script dir.

    Raises ``ValueError`` otherwise. Write paths let that propagate (fail closed);
    delete/scan paths catch it and stand down (fail open, but never on disk)."""
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
        raise ValueError(
            f"hook name {name!r} is not a slug ([a-z0-9-]+), so it cannot address "
            f"a managed script dir"
        )
    return name


def managed_script_dir(name: str, data_home: Optional[Path] = None) -> Path:
    """``<data_home>/hooks/<name>/`` — the single choke point where a hook name
    becomes a path. Raises ``ValueError`` on a non-slug name (traversal guard)."""
    return _resolve_data_home(data_home) / MANAGED_DIR_NAME / validate_managed_name(name)


def managed_script_path(
    name: str, script: "HookScript", data_home: Optional[Path] = None
) -> Path:
    return managed_script_dir(name, data_home) / script.filename


def default_stub(name: str, interpreter: str) -> str:
    return _STUBS.get(interpreter, _STUBS["bash"]).format(name=name)


def write_managed_script(
    name: str,
    script: "HookScript",
    body: str,
    data_home: Optional[Path] = None,
) -> Path:
    """Overwrite the managed body (atomic). Returns the path written."""
    path = managed_script_path(name, script, data_home)
    text = body if body.endswith("\n") else body + "\n"
    _atomic_replace(path, text)
    try:
        path.chmod(0o755)
    except OSError:  # pragma: no cover - defensive (odd filesystems)
        pass
    return path


def read_managed_script(
    name: str, script: "HookScript", data_home: Optional[Path] = None
) -> Optional[str]:
    """The managed body, or ``None`` when the file is absent/unreadable."""
    path = managed_script_path(name, script, data_home)
    try:
        return path.read_text()
    except (OSError, UnicodeDecodeError):
        return None


def ensure_managed_script(
    name: str,
    script: "HookScript",
    *,
    body: Optional[str] = None,
    data_home: Optional[Path] = None,
) -> Path:
    """Create the managed dir + body if needed. An existing body is left alone
    unless an explicit ``body`` is passed; a missing one is seeded with a stub."""
    path = managed_script_path(name, script, data_home)
    if body is not None:
        return write_managed_script(name, script, body, data_home)
    if path.exists():
        return path
    return write_managed_script(
        name, script, default_stub(name, script.interpreter), data_home
    )


def rename_managed_script(
    name: str,
    old_script: "HookScript",
    new_script: "HookScript",
    data_home: Optional[Path] = None,
) -> Optional[Path]:
    """Carry a managed body across an interpreter change (``script.sh`` →
    ``script.py``). Returns the new path when a body was moved, else ``None``."""
    old_path = managed_script_path(name, old_script, data_home)
    new_path = managed_script_path(name, new_script, data_home)
    if old_path == new_path or not old_path.exists():
        return None
    new_path.parent.mkdir(parents=True, exist_ok=True)
    old_path.replace(new_path)
    return new_path


def remove_managed_script_dir(
    name: str, data_home: Optional[Path] = None, *, warn: Optional[WarnFn] = None
) -> bool:
    """Delete ``<data_home>/hooks/<name>/``. Returns True when something was
    removed. Confined to the data home by construction (the name is re-validated
    as a slug and the path is always rebuilt from ``data_home``).

    A name that cannot address a managed dir is WARNED and skipped rather than
    raising: this is the delete path, and a registry entry with a hostile name
    must stay deletable *from the registry* — it just gets no ``rmtree``."""
    try:
        target = managed_script_dir(name, data_home)
    except ValueError as exc:
        (warn if warn is not None else _default_warn)(
            f"{exc} — no managed script dir removed"
        )
        return False
    if not target.exists():
        return False
    shutil.rmtree(target)
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Command baking
# ─────────────────────────────────────────────────────────────────────────────


def resolve_interpreter(interpreter: str, code_home: Optional[Path] = None) -> str:
    """The executable to bake. ``python3`` reuses the lsp-report precedence
    (``SKILL_TREE_PYTHON`` → bundled runtime → PATH) so a packaged app with no
    system python still runs its hooks; ``bash`` is taken from PATH at run time."""
    if interpreter == "python3":
        from skill_hub.application.sync import lsp_report_sync

        if code_home is None:
            code_home = hub_core.code_home()
        return lsp_report_sync.resolve_lsp_interpreter(Path(code_home))
    return "bash"


def script_command(
    name: str,
    script: "HookScript",
    *,
    data_home: Optional[Path] = None,
    code_home: Optional[Path] = None,
) -> str:
    """The baked command line for a script hook.

    Both the interpreter and the script path are shell-quoted (harnesses run hook
    commands through a shell, and the packaged app's own paths contain spaces);
    ``args`` is appended VERBATIM so `--fix --paths "a b"` reaches the script as
    the user typed it.
    """
    interpreter = resolve_interpreter(script.interpreter, code_home)
    if script.source == "managed":
        target = str(managed_script_path(name, script, data_home))
    else:
        target = script.path
    command = f"{shlex.quote(interpreter)} {shlex.quote(target)}"
    if script.args:
        command = f"{command} {script.args}"
    return command


def _bakeable(rh: "ResolvedHook") -> bool:
    """Only USER hooks carrying a script are baked here — a built-in materializes
    itself (``lsp_report_sync``), including one shadowed by name."""
    return (
        getattr(rh, "script", None) is not None
        and getattr(rh, "provenance", "") != "builtin"
    )


def bake_script_hooks(
    resolved_hooks: list["ResolvedHook"],
    scope: "Scope",
    *,
    data_home: Optional[Path] = None,
    code_home: Optional[Path] = None,
    warn: Optional[WarnFn] = None,
) -> None:
    """In-place: rewrite every script hook's ``command`` for this scope.

    A managed script whose body is missing on disk is REMOVED from the list (and
    warned) — writing a command that cannot run would leave a hook silently
    failing on every event. Repo scripts are baked unconditionally; per-project
    existence is a doctor concern (``HOOK_SCRIPT_MISSING``), not a write gate.
    """
    if not any(_bakeable(rh) for rh in resolved_hooks):
        return
    _warn = warn if warn is not None else _default_warn
    data_home = _resolve_data_home(data_home)
    if code_home is None:
        code_home = Path(hub_core.code_home())

    scope_label = getattr(scope, "slug", "") or str(scope)
    kept: list["ResolvedHook"] = []
    for rh in resolved_hooks:
        if not _bakeable(rh):
            kept.append(rh)
            continue
        script = rh.script
        try:
            if script.source == "managed":
                path = managed_script_path(rh.name, script, data_home)
                if not path.exists():
                    _warn(
                        f"hook '{rh.name}': managed script missing at {path} — "
                        f"skipped for {scope_label}"
                    )
                    continue
            rh.command = script_command(
                rh.name, script, data_home=data_home, code_home=code_home
            )
        except ValueError as exc:
            # A hand-edited registry can carry a name that cannot become a path.
            # Drop the hook from the scope rather than take down the sync stream.
            # `exc` already names the hook, so this does not re-prefix it.
            _warn(f"{exc} — skipped for {scope_label}")
            continue
        kept.append(rh)
    resolved_hooks[:] = kept
