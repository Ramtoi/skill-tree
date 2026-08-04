"""Sync-time materialization for the built-in ``lsp-report`` hook (hooks-surface
D5 / tasks 4.2–4.3).

Two jobs, run from ``hub._run_hooks_stream`` BEFORE resolved hooks reach an
adapter:

  1. **Per-scope config** — serialize a resolved ``lsp-report`` hook's merged
     settings to ``<data_home>/state/hooks/lsp-report.<scope>.json`` (atomic,
     no-op on unchanged content) so the shipped ``lsp_report.py`` can read its
     per-language ``{enabled, mode, timeout}`` config at runtime.
  2. **Interpreter baking** — resolve the Python interpreter mirroring the Rust
     ``detect_python()`` precedence (``SKILL_TREE_PYTHON`` → bundled runtime →
     system ``python3``) and REWRITE the resolved hook's ``command`` to bake that
     absolute interpreter path + the ``--config`` path. Because the rewrite runs
     fresh every sync, it is naturally idempotent: unchanged interpreter ⇒
     identical command string ⇒ the adapter's byte-stable re-sync writes nothing;
     a changed interpreter ⇒ different string ⇒ the adapter writes a diff.

This module is deliberately separate from ``hub.py`` so the logic is unit-testable
in isolation and hub's diff stays a few lines of glue.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from permission_adapters import _atomic_replace

if TYPE_CHECKING:  # pragma: no cover - typing only
    from hooks_model import ResolvedHook
    from permissions import Scope

LSP_REPORT_NAME = "lsp-report"


# ─────────────────────────────────────────────────────────────────────────────
# Interpreter resolution (mirrors Rust detect_python precedence)
# ─────────────────────────────────────────────────────────────────────────────


def _bundled_python(code_home: Path) -> Optional[Path]:
    """The interpreter bundled in a packaged ``.app`` given ``code_home``.

    Packaged layout: ``code_home()`` is ``<App>/Contents/Resources/hub`` and the
    bundled runtime sits alongside at ``<App>/Contents/Resources/python/bin`` —
    so ``code_home.parent / "python" / "bin"``. Mirrors the Rust
    ``bundled_python``: prefer the ``python3`` symlink, else the version-qualified
    ``python3.<minor>`` binary (the symlink can be lost during resource packaging).
    Returns None in dev builds (no such tree ⇒ fall through to the system probe).
    """
    bin_dir = code_home.parent / "python" / "bin"
    direct = bin_dir / "python3"
    if direct.exists():
        return direct
    try:
        entries = sorted(bin_dir.iterdir())
    except (FileNotFoundError, NotADirectoryError, OSError):
        return None
    for entry in entries:
        name = entry.name
        if name.startswith("python3.") and "-" not in name:
            return entry
    return None


def resolve_lsp_interpreter(code_home: Optional[Path] = None) -> str:
    """Resolve the Python interpreter for the baked ``lsp-report`` command.

    Precedence (mirrors ``detect_python()`` in ``app/src-tauri/src/commands/
    hub.rs``): ``SKILL_TREE_PYTHON`` env → bundled ``.app`` runtime → system
    ``python3``/``python`` on PATH → the current interpreter. Always returns an
    ABSOLUTE, ``stat``-able path so future doctor logic can check it exists.
    """
    override = os.environ.get("SKILL_TREE_PYTHON", "").strip()
    if override:
        return override

    if code_home is None:
        import hub

        code_home = hub.code_home()
    bundled = _bundled_python(Path(code_home))
    if bundled is not None:
        return str(bundled)

    for name in ("python3", "python"):
        found = shutil.which(name)
        if found:
            return found
    return sys.executable


# ─────────────────────────────────────────────────────────────────────────────
# Per-scope config materialization
# ─────────────────────────────────────────────────────────────────────────────


def _config_payload(settings: dict) -> dict:
    """The per-scope config shape written to disk: the merged settings verbatim,
    guaranteeing a ``languages`` map (the shape ``risks.py`` reads —
    ``settings.languages.<lang>.enabled``)."""
    payload = dict(settings or {})
    if not isinstance(payload.get("languages"), dict):
        payload["languages"] = {}
    return payload


def config_path_for(scope_label: str, data_home: Path) -> Path:
    return Path(data_home) / "state" / "hooks" / f"lsp-report.{scope_label}.json"


def materialize_lsp_report(
    resolved_hook: "ResolvedHook", scope_label: str, data_home: Path
) -> Path:
    """Write ``state/hooks/lsp-report.<scope>.json`` from the hook's merged
    settings and return its path.

    ``resolved_hook.settings`` is already the global-defaults ⊕ project
    ``hook_settings`` deep-merge (done by ``hooks_model.resolve_*_hooks``), so this
    just serializes it. Atomic (temp + replace); a byte-identical file is left
    untouched to avoid needless mtime churn.
    """
    config_path = config_path_for(scope_label, data_home)
    new_text = json.dumps(_config_payload(resolved_hook.settings), indent=2, sort_keys=True) + "\n"
    existing = config_path.read_text() if config_path.exists() else None
    if new_text != existing:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_replace(config_path, new_text)
    return config_path


# ─────────────────────────────────────────────────────────────────────────────
# Command baking + glue
# ─────────────────────────────────────────────────────────────────────────────


def lsp_report_command(interpreter: str, config_path: Path, code_home: Path) -> str:
    """The materialized command: baked interpreter + absolute script + config.

    Every path component is shell-quoted (``shlex.quote``): harnesses execute
    hook commands through a shell, and both the packaged app's default
    `code_home()` (``/Applications/Skill Tree.app/Contents/Resources/hub`` — a
    space in "Skill Tree") and a user's own project path can contain spaces or
    shell metacharacters. An unquoted command silently mis-splits into extra
    argv tokens and the hook fails to run at all.
    """
    script = Path(code_home) / "hooks" / LSP_REPORT_NAME / "lsp_report.py"
    return (
        f"{shlex.quote(str(interpreter))} {shlex.quote(str(script))} "
        f"--config {shlex.quote(str(config_path))}"
    )


def _is_builtin_lsp_report(rh: "ResolvedHook") -> bool:
    """Only the BUILT-IN ``lsp-report`` gets its command baked.

    A registry `hooks:` entry named ``lsp-report`` legitimately SHADOWS the
    built-in (``hooks_model.resolve_definition``), and docs/HOOKS.md promises a
    shadowing definition is "used in full". Matching on the name alone rewrote
    that user definition's own ``command`` with the built-in's baked command —
    silently running code the user never asked for. The provenance check keeps
    the shadow intact.
    """
    return rh.name == LSP_REPORT_NAME and getattr(rh, "provenance", "") == "builtin"


def bake_resolved_hooks(
    resolved_hooks: list["ResolvedHook"],
    scope: "Scope",
    *,
    data_home: Optional[Path] = None,
    code_home: Optional[Path] = None,
) -> None:
    """In-place: for every resolved BUILT-IN ``lsp-report`` hook in the list, write
    its per-scope config and rewrite ``command`` with the baked interpreter +
    config path. Every other hook — including a user definition that shadows the
    built-in by name — is left untouched. Called once per scope from
    ``_run_hooks_stream`` before the harness/adapter loop.
    """
    if not any(_is_builtin_lsp_report(rh) for rh in resolved_hooks):
        return
    import hub

    if data_home is None:
        data_home = hub.data_home()
    if code_home is None:
        code_home = hub.code_home()
    interpreter = resolve_lsp_interpreter(Path(code_home))
    for rh in resolved_hooks:
        if not _is_builtin_lsp_report(rh):
            continue
        config_path = materialize_lsp_report(rh, scope.slug, data_home)
        rh.command = lsp_report_command(interpreter, config_path, Path(code_home))
