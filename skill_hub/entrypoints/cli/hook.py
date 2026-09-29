"""`hub hook` — the hook library CLI (hooks-surface task 2.6).

Definitions, attach/detach, and managed-script bodies for the hook library
that PostToolUse/PreToolUse/etc. hooks are drawn from. All the storage model
(`hooks:`, `hooks_global`, `projects.<n>.hooks`) lives in the registry;
`hooks_model.py` / `hook_adapters.py` do the per-harness translation at sync
time. These handlers are marshalling + output only.

Carved out of `hub.py` (S5 slice B) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Any, Mapping, Optional

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    DIM,
    GREEN,
    RED,
    YELLOW,
    c,
    expand,
    fail,
    parse_csv,
    registry_mutation,
    validate_slug,
)

NAME = "hook"

p_hook = None
p_hook_script = None


def register(sub) -> None:
    global p_hook, p_hook_script

    # hook — the hook library CLI (hooks-surface task 2.6)
    p_hook = sub.add_parser("hook", help="Manage the hook library (definitions + attach)")
    hook_sub = p_hook.add_subparsers(dest="hook_cmd")

    p_hook_list = hook_sub.add_parser("list", help="List every hook definition + reach")
    p_hook_list.add_argument("--json", action="store_true")

    p_hook_show = hook_sub.add_parser("show", help="Show one hook definition + resolved settings")
    p_hook_show.add_argument("name")
    p_hook_show.add_argument("--json", action="store_true")

    p_hook_doctor = hook_sub.add_parser(
        "doctor", help="Scan every attached hook for health risks"
    )
    p_hook_doctor.add_argument("--json", action="store_true")

    def _add_script_flags(parser, *, clearable: bool):
        clear_note = "; pass an empty string to clear the script" if clearable else ""
        parser.add_argument(
            "--script-source",
            help=f"managed|repo — use a script instead of --command{clear_note}",
        )
        parser.add_argument("--script-interpreter", help="bash|python3")
        parser.add_argument(
            "--script-path", help="repo scripts only: path relative to the project root"
        )
        parser.add_argument(
            "--script-args", help="Appended verbatim to the baked command line"
        )
        parser.add_argument(
            "--script-body-file",
            help="managed scripts only: seed the body from this file",
        )

    p_hook_new = hook_sub.add_parser("new", help="Create a new user hook definition")
    p_hook_new.add_argument("name")
    p_hook_new.add_argument("--event", required=True)
    # dest avoids colliding with the top-level subparser dest="command".
    p_hook_new.add_argument("--command", dest="hook_command")
    p_hook_new.add_argument("--description", help="One-line summary of what the hook does")
    p_hook_new.add_argument("--tools", help="CSV of canonical tool names")
    p_hook_new.add_argument("--matcher", help="Raw matcher regex (wins over --tools)")
    p_hook_new.add_argument("--timeout", type=int)
    p_hook_new.add_argument("--harnesses", help="CSV of harness ids; default = all")
    _add_script_flags(p_hook_new, clearable=False)

    p_hook_edit = hook_sub.add_parser("edit", help="Edit a user hook definition (built-ins are read-only)")
    p_hook_edit.add_argument("name")
    p_hook_edit.add_argument("--event")
    p_hook_edit.add_argument("--command", dest="hook_command")
    p_hook_edit.add_argument(
        "--description",
        help="One-line summary; pass an empty string to clear an existing one",
    )
    p_hook_edit.add_argument("--tools")
    p_hook_edit.add_argument("--matcher")
    p_hook_edit.add_argument(
        "--timeout",
        help="Seconds; pass an empty string to clear an existing timeout",
    )
    p_hook_edit.add_argument("--harnesses")
    _add_script_flags(p_hook_edit, clearable=True)

    p_hook_script = hook_sub.add_parser(
        "script", help="Read/write a managed hook script body"
    )
    hook_script_sub = p_hook_script.add_subparsers(dest="hook_script_cmd")
    p_hook_script_show = hook_script_sub.add_parser("show", help="Print the managed body")
    p_hook_script_show.add_argument("name")
    p_hook_script_show.add_argument("--json", action="store_true")
    p_hook_script_save = hook_script_sub.add_parser("save", help="Overwrite the managed body")
    p_hook_script_save.add_argument("name")
    p_hook_script_save.add_argument("--body-file", help="File whose contents become the body")
    p_hook_script_save.add_argument(
        "--stdin", action="store_true", help="Read the body from stdin"
    )

    p_hook_delete = hook_sub.add_parser("delete", help="Delete a user hook + detach it everywhere")
    p_hook_delete.add_argument("name")
    p_hook_delete.add_argument("--yes", action="store_true", help="Confirm the destructive delete")

    p_hook_attach = hook_sub.add_parser("attach", help="Attach a hook at a scope")
    p_hook_attach.add_argument("name")
    g_attach = p_hook_attach.add_mutually_exclusive_group()
    g_attach.add_argument("--global", dest="global_", action="store_true")
    g_attach.add_argument("--project")

    p_hook_detach = hook_sub.add_parser("detach", help="Detach a hook from a scope")
    p_hook_detach.add_argument("name")
    g_detach = p_hook_detach.add_mutually_exclusive_group()
    g_detach.add_argument("--global", dest="global_", action="store_true")
    g_detach.add_argument("--project")

    p_hook_ss = hook_sub.add_parser("set-settings", help="Deep-merge settings for a hook")
    p_hook_ss.add_argument("name")
    g_ss = p_hook_ss.add_mutually_exclusive_group()
    g_ss.add_argument("--global", dest="global_", action="store_true")
    g_ss.add_argument("--project")
    p_hook_ss.add_argument("--json", required=True, help="JSON object of settings to merge")



def dispatch(args) -> None:
    hk = getattr(args, "hook_cmd", None)
    if hk == "list":
        cmd_hook_list(args)
    elif hk == "show":
        cmd_hook_show(args)
    elif hk == "doctor":
        cmd_hook_doctor(args)
    elif hk == "new":
        cmd_hook_new(args)
    elif hk == "edit":
        cmd_hook_edit(args)
    elif hk == "delete":
        cmd_hook_delete(args)
    elif hk == "attach":
        cmd_hook_attach(args)
    elif hk == "detach":
        cmd_hook_detach(args)
    elif hk == "set-settings":
        cmd_hook_set_settings(args)
    elif hk == "script":
        hs = getattr(args, "hook_script_cmd", None)
        if hs == "show":
            cmd_hook_script_show(args)
        elif hs == "save":
            cmd_hook_script_save(args)
        else:
            p_hook_script.print_help()
    else:
        p_hook.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# hub hook … (the hook library CLI — hooks-surface task 2.6)
# ─────────────────────────────────────────────────────────────────────────────


def _hook_command_arg(args):
    """Read the hook command, tolerating both the argparse dest (`hook_command`,
    renamed to avoid colliding with the top-level subparser dest `command`) and a
    plain `command` attribute (direct callers / tests).

    `hook_command` being PRESENT is authoritative even when it is None — that is
    argparse telling us `--command` was not passed. Falling through to `command`
    in that case read the TOP-LEVEL subparser dest instead (the literal string
    "hook"), which silently rewrote a hook's command to `"hook"` on any
    `hub hook edit <name>` that did not pass `--command`.
    """
    if hasattr(args, "hook_command"):
        return args.hook_command
    return getattr(args, "command", None)


def _hook_all_defs(registry: dict):
    from skill_hub.domain.hooks import hooks_model

    return hooks_model.all_definitions(registry)


def _hook_registry_defs(registry: dict):
    from skill_hub.domain.hooks import hooks_model

    return hooks_model.parse_registry_hooks(registry)


def _hook_builtin_defs():
    from skill_hub.domain.hooks import hooks_model

    return hooks_model.load_builtin_hooks()


def _hook_attach_summary(registry: dict, name: str) -> tuple[bool, list[str]]:
    global_attached = name in (registry.get("hooks_global") or [])
    projects_attached = sorted(
        p
        for p, pc in (registry.get("projects") or {}).items()
        if name in ((pc or {}).get("hooks") or [])
    )
    return global_attached, projects_attached


def _hook_operation_context():
    """Build the one cache-only capability snapshot used by read commands."""
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context
    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    installed = _harnesses.detect_installed()
    return build_operation_context(
        hub_core.data_home(),
        tuple(sorted(_harnesses.HARNESSES)),
        requested_features=("hooks",),
        installed_harness_ids=tuple(sorted(installed)),
        host_version=Version.parse(hub_core.hub_version()),
        sdk_version=SDK_VERSION,
    )


def _hook_reach(operation_context=None) -> dict[str, str]:
    """Per-harness capability verdicts from one operation snapshot."""
    if operation_context is None:
        # Compatibility for callers that use this private helper directly.
        from skill_hub.infrastructure.harnesses import harness_probe

        cached = harness_probe.load_cached() or {}
        harnesses = cached.get("harnesses") or {}
    else:
        harnesses = operation_context.hook_observations
    return {
        h_id: (entry or {}).get("verdict", "")
        for h_id, entry in harnesses.items()
    }


def _hook_effective_harnesses(project_cfg, registry, operation_context, installed):
    requested = set(registry.get("harnesses_global") or []) | set(
        project_cfg.get("harnesses") or []
    )
    available = set(operation_context.installed_harness_ids or ())
    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses as _harnesses

        return _harnesses.resolve_effective(project_cfg, registry, installed=installed)
    return {
        harness_id
        for harness_id in requested & available
        if operation_context.layout(harness_id) is not None
    }


def _hook_script_body_arg(args) -> Optional[str]:
    """Contents of `--script-body-file`, or None when the flag was not passed."""
    body_file = getattr(args, "script_body_file", None)
    if not body_file:
        return None
    try:
        return Path(body_file).expanduser().read_text()
    except OSError as e:
        fail(f"cannot read --script-body-file {body_file}: {e}")


def _hook_script_from_args(args, *, existing=None):
    """Resolve the `--script-*` flags into `(intent, script, body)`.

    `intent` is `keep` (no script flag passed), `clear` (`--script-source ""`) or
    `set`. On `set` the passed flags are merged over `existing` so a lone
    `--script-args` edit does not have to restate the source/interpreter.
    """
    from skill_hub.domain.hooks import hooks_model

    source = getattr(args, "script_source", None)
    interpreter = getattr(args, "script_interpreter", None)
    path = getattr(args, "script_path", None)
    script_args = getattr(args, "script_args", None)
    body = _hook_script_body_arg(args)
    if all(v is None for v in (source, interpreter, path, script_args)) and body is None:
        return "keep", None, None

    if source is not None and not str(source).strip():
        if body is not None or any(
            v is not None for v in (interpreter, path, script_args)
        ):
            fail("--script-source '' clears the script — pass no other --script-* flag with it")
        return "clear", None, None

    new_source = str(source).strip() if source is not None else (existing.source if existing else "")
    new_interp = (
        str(interpreter).strip()
        if interpreter is not None
        else (existing.interpreter if existing else "")
    )
    new_path = str(path).strip() if path is not None else (existing.path if existing else "")
    new_args = (
        str(script_args).strip()
        if script_args is not None
        else (existing.args if existing else "")
    )
    if not new_source:
        fail("--script-source is required (managed|repo)")
    if not new_interp:
        fail("--script-interpreter is required (bash|python3)")
    # Switching repo → managed drops the now-meaningless inherited path; an
    # EXPLICIT --script-path with managed is still an error (validate catches it).
    if new_source == "managed" and path is None:
        new_path = ""
    if new_source != "managed" and body is not None:
        fail("--script-body-file only applies to a managed script")

    script = hooks_model.HookScript(
        source=new_source, interpreter=new_interp, path=new_path, args=new_args
    )
    try:
        script.validate()
        if script.source == "repo":
            script.path = hooks_model.normalize_repo_script_path(script.path)
    except ValueError as e:
        fail(str(e))
    return "set", script, body


def _hook_new(
    registry: dict,
    name: str,
    *,
    event: str,
    command: str,
    tools: Optional[list[str]],
    matcher: Optional[str],
    timeout: Optional[int],
    harnesses: Optional[list[str]],
    script=None,
    description: str = "",
) -> None:
    """Create a new user hook definition in `registry["hooks"]`. Validates the
    slug, event, and non-collision with an existing definition or built-in."""
    from skill_hub.domain.diagnostics.tool_catalog import CANONICAL_EVENTS
    from skill_hub.domain.hooks import hooks_model

    validate_slug(name, label="hook name")
    if name == "new":
        fail(
            "hook name 'new' is reserved (the app's /hook/new create-mode route "
            "would make it permanently unreachable in the editor); pick a "
            "different name"
        )
    all_defs = hooks_model.all_definitions(registry)
    if name in all_defs:
        prov = all_defs[name].provenance
        fail(f"hook '{name}' already exists ({prov}); pick a different name")
    if not event:
        fail("--event is required")
    if event not in CANONICAL_EVENTS:
        fail(
            f"unknown event '{event}'. Valid events: {', '.join(CANONICAL_EVENTS)}"
        )
    if command and script is not None:
        fail("a hook is either a command or a script — pass --command OR --script-source")
    if not command and script is None:
        fail(
            "--command is required (or --script-source managed|repo "
            "--script-interpreter bash|python3)"
        )
    definition = hooks_model.HookDefinition(
        name=name,
        event=event,
        command=command,
        description=description or "",
        tools=list(tools or []),
        matcher=matcher or "",
        timeout=timeout,
        harnesses=list(harnesses) if harnesses else None,
        script=script,
    )
    hooks_map = registry.setdefault("hooks", {})
    if not isinstance(hooks_map, dict):
        hooks_map = {}
        registry["hooks"] = hooks_map
    hooks_map[name] = definition.to_block()


def _hook_attach(
    registry: dict, name: str, *, scope_global: bool, proj_name: Optional[str],
    operation_context: Any = None,
) -> bool:
    """Idempotently attach `name` at a scope. Returns True if it was newly added."""
    if scope_global:
        lst = registry.setdefault("hooks_global", [])
        if not isinstance(lst, list):
            lst = []
            registry["hooks_global"] = lst
        if name in lst:
            return False
        lst.append(name)
        return True
    projects = registry.get("projects") or {}
    if proj_name not in projects:
        fail(f"unknown project '{proj_name}'")
    proj = projects[proj_name]
    lst = proj.setdefault("hooks", [])
    if not isinstance(lst, list):
        lst = []
        proj["hooks"] = lst
    if name in lst:
        return False
    lst.append(name)
    return True


def _hook_detach(
    registry: dict, name: str, *, scope_global: bool, proj_name: Optional[str],
    operation_context: Any = None,
) -> bool:
    """Idempotently detach `name` from a scope. Returns True if it was removed."""
    if scope_global:
        lst = list(registry.get("hooks_global") or [])
        if name not in lst:
            return False
        registry["hooks_global"] = [n for n in lst if n != name]
        return True
    projects = registry.get("projects") or {}
    if proj_name not in projects:
        fail(f"unknown project '{proj_name}'")
    proj = projects[proj_name]
    lst = list(proj.get("hooks") or [])
    if name not in lst:
        return False
    proj["hooks"] = [n for n in lst if n != name]
    return True


def _hook_update(
    registry: dict, name: str, *, operation_context: Any = None, **fields: Any
) -> None:
    """Rewrite a USER, non-script hook definition's core fields in place — the
    write path behind (W5) the `ships_with` reconcile's `HOOK_REDEFINE` op
    (`hub_cli/companions.CliOps.hook_update`), used when a `ships_with`
    declaration's inline hook definition changed. `event`/`command` are always
    set to the given values; `tools`/`matcher`/`timeout`/`harnesses` each
    follow "a falsy value clears, anything else sets" — the shape a
    `ships_with` hook declaration always carries (it has no matcher/timeout of
    its own, so a redefine always clears those back to absent). Refuses an
    unknown, built-in (read-only), or script-backed (edited only via
    `hub hook edit --script-*`) hook — user-provenance, command-based hooks
    only, mirroring `cmd_hook_edit`'s own built-in refusal.

    Deliberately independent of `cmd_hook_edit`'s own inline block-mutation
    (which keeps its argparse not-passed-vs-cleared convention and its
    script/managed-script lifecycle unchanged) — this is a narrower, purely
    programmatic sibling for the reconcile `Ops` caller.
    """
    registry_defs = _hook_registry_defs(registry)
    if name not in registry_defs:
        if name in _hook_builtin_defs():
            fail(f"hook '{name}' is a built-in — its definition cannot be redefined here")
        fail(f"unknown user hook '{name}'")
    existing = registry_defs[name]
    if existing.script is not None:
        fail(f"hook '{name}' is script-backed — edited via 'hub hook edit --script-*', not this path")

    block = dict(registry.get("hooks", {}).get(name) or {})
    block["event"] = fields["event"]
    block["command"] = fields["command"]
    for key in ("tools", "matcher", "timeout", "harnesses"):
        val = fields.get(key)
        if val:
            block[key] = val
        else:
            block.pop(key, None)
    registry.setdefault("hooks", {})[name] = block


def _hook_action(d) -> str:
    """The action discriminator: `command` | `script:managed` | `script:repo`."""
    return "command" if d.script is None else f"script:{d.script.source}"


def _hook_script_dict(d) -> Optional[dict]:
    """The `script` payload (no body — `hook show` adds that for managed)."""
    if d.script is None:
        return None
    out = {"source": d.script.source, "interpreter": d.script.interpreter}
    if d.script.source == "repo":
        out["path"] = d.script.path
    if d.script.args:
        out["args"] = d.script.args
    return out


def _hook_managed_path_or_none(name: str, script):
    """The managed body path, or `None` when the hook's NAME cannot address one.

    Read-only surfaces (`hook show`) must survive a hand-edited registry that
    carries a non-slug name; `hook_scripts` refuses to build such a path so the
    name can never escape the data home.
    """
    from skill_hub.infrastructure.hooks import hook_scripts

    try:
        return hook_scripts.managed_script_path(name, script)
    except ValueError:
        return None


def _hook_script_projects(registry: dict, name: str, d) -> list[dict]:
    """Per-attached-project existence of a REPO script (global attach ⇒ every
    registered project). Empty for command hooks and managed scripts."""
    if d.script is None or d.script.source != "repo":
        return []
    projects = registry.get("projects") or {}
    attached_global = name in (registry.get("hooks_global") or [])
    rows = []
    for p_name in sorted(projects):
        p_cfg = projects[p_name] or {}
        if not (attached_global or name in (p_cfg.get("hooks") or [])):
            continue
        root = p_cfg.get("path") or ""
        exists = bool(root) and (expand(root) / d.script.path).exists()
        rows.append({"project": p_name, "path_exists": exists})
    return rows


def _hook_bake_command_for_scope(
    name: str, provenance: str, script, command: str, scope_slug: str
) -> Optional[str]:
    """The command line the harness actually receives after sync, at
    `scope_slug`. Read-only — a built-in's config path is COMPUTED, never
    materialized (a read must never write under `state/hooks/`). Shared by
    `_hook_baked_command` (`hook show`, always the global scope) and
    `cmd_hook_doctor` (every scope a hook reaches)."""
    try:
        if provenance == "builtin" and name == "lsp-report":
            from skill_hub.application.sync import lsp_report_sync
            from skill_hub.hub_core import code_home, data_home

            code_h = code_home()
            interpreter = lsp_report_sync.resolve_lsp_interpreter(code_h)
            config_path = lsp_report_sync.config_path_for(scope_slug, data_home())
            return lsp_report_sync.lsp_report_command(interpreter, config_path, code_h)
        if provenance == "builtin":
            return command
        if script is not None:
            from skill_hub.infrastructure.hooks import hook_scripts

            return hook_scripts.script_command(name, script)
        return command
    except (OSError, ValueError, ImportError, RuntimeError):
        return None


def _hook_baked_command(name: str, d) -> Optional[str]:
    """The command line the harness actually receives after sync, at the
    GLOBAL scope. Read-only — a built-in's config path is COMPUTED, never
    materialized (`hub hook show` must not write under `state/hooks/`)."""
    return _hook_bake_command_for_scope(
        name, d.provenance, d.script, d.command, "global"
    )


def _hook_doctor_bake(resolved_hooks: list, scope_slug: str) -> None:
    """In-place: rewrite `command` on every resolved hook for `scope_slug`,
    WITHOUT writing anything to disk (never `materialize_lsp_report` /
    `bake_script_hooks`). A hook whose command cannot be baked (e.g. a
    hand-edited registry name that cannot address a managed path) is left
    with its unbaked `command` rather than dropped — the doctor still wants
    to attribute findings to it."""
    for rh in resolved_hooks:
        baked = _hook_bake_command_for_scope(
            rh.name, rh.provenance, rh.script, rh.command, scope_slug
        )
        if baked is not None:
            rh.command = baked


_MAX_SCRIPT_BODY_BYTES = 512 * 1024


def _read_capped_text(path: Path) -> tuple[Optional[str], Optional[str]]:
    """UTF-8 text capped at 512 KiB. Returns `(body, reason)` — `reason` is
    `"too_large"` or `"unreadable"` when `body` is `None`, else `None`. The one
    capped reader shared by `_hook_builtin_info` and `_hook_command_script`."""
    try:
        if path.stat().st_size > _MAX_SCRIPT_BODY_BYTES:
            return None, "too_large"
    except OSError:
        return None, "unreadable"
    try:
        return path.read_text(encoding="utf-8"), None
    except (OSError, UnicodeDecodeError):
        return None, "unreadable"


def _hook_builtin_info(name: str, d) -> Optional[dict]:
    """`{dir, files: [{name, path, body}]}` for a provenance-`builtin` hook,
    else `None`. Every regular, non-dotfile entry directly inside the
    built-in's dir (no recursion), sorted so `hook.yaml` comes LAST and the
    rest alphabetical. `body` is `None` when unreadable or over 512 KiB."""
    if d.provenance != "builtin":
        return None
    from skill_hub.domain.hooks import hooks_model
    from skill_hub.hub_core import code_home

    root = hooks_model.builtin_hooks_dir(code_home()) / name
    try:
        entries = [
            p for p in root.iterdir() if p.is_file() and not p.name.startswith(".")
        ]
    except OSError:
        return None
    entries.sort(key=lambda p: (p.name == "hook.yaml", p.name))
    files = []
    for p in entries:
        body, _reason = _read_capped_text(p)
        files.append({"name": p.name, "path": str(p), "body": body})
    return {"dir": str(root), "files": files}


def _command_script_location(project: Optional[str], path: Path) -> dict:
    """One `command_script.locations[]` entry for a resolved candidate path."""
    try:
        exists = path.is_file()
    except OSError:
        exists = False
    if not exists:
        return {
            "project": project, "path": str(path), "exists": False,
            "body": None, "reason": None,
        }
    body, reason = _read_capped_text(path)
    return {
        "project": project, "path": str(path), "exists": True,
        "body": body, "reason": reason,
    }


def _hook_command_script(registry: dict, name: str, d) -> Optional[dict]:
    """`command_script` — the script file a plain COMMAND hook's command line
    references, when it references one. `None` for built-ins and for
    script-backed hooks (their body already has a dedicated field) and when the
    command carries no candidate script-path token at all.

    Detection reuses the same heuristic as the doctor's broken-script check
    (`risks.candidate_script_paths`) — the FIRST candidate token wins."""
    if d.provenance == "builtin" or d.script is not None:
        return None
    from skill_hub.domain.diagnostics import risks

    candidates = risks.candidate_script_paths(d.command or "")
    if not candidates:
        return None
    token = candidates[0]

    if token.startswith("/") or token.startswith("~"):
        kind = "absolute" if token.startswith("/") else "home"
        try:
            resolved = expand(token)
        except (RuntimeError, OSError):
            location = {
                "project": None, "path": str(Path(token)), "exists": False,
                "body": None, "reason": "unresolvable",
            }
        else:
            location = _command_script_location(None, resolved)
        return {"token": token, "kind": kind, "locations": [location]}

    g_attached, projects_attached = _hook_attach_summary(registry, name)
    projects = registry.get("projects") or {}
    attach_names = sorted(projects) if g_attached else projects_attached
    locations = []
    for p_name in attach_names:
        p_cfg = projects.get(p_name) or {}
        root = p_cfg.get("path")
        if not root:
            continue
        try:
            root_path = expand(root)
        except (RuntimeError, OSError):
            continue
        target = (root_path / token).resolve()
        try:
            target.relative_to(root_path)
        except ValueError:
            locations.append({
                "project": p_name, "path": str(target), "exists": False,
                "body": None, "reason": "outside_project",
            })
            continue
        locations.append(_command_script_location(p_name, target))
    return {"token": token, "kind": "relative", "locations": locations}


def _hook_repo_script_conversion(d) -> Optional[dict]:
    """`repo_script_conversion` — a hand-written `<interpreter> <repo path>
    [args]` command hook, recast as `{interpreter, path, args}` so the app can
    offer to convert it into a modelled repo script. `None` for built-ins,
    script-backed hooks, an empty command, a non-script/non-interpreter first
    token, or a path that fails `hooks_model.normalize_repo_script_path`
    (absolute / `~`-anchored / traversing — a repo script is per-project by
    definition, so those are never convertible)."""
    if d.provenance == "builtin" or d.script is not None:
        return None
    command = (d.command or "").strip()
    if not command:
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None

    from skill_hub.domain.diagnostics import risks

    candidates = risks.candidate_script_paths(command)

    if tokens[0] in ("bash", "python3"):
        if len(tokens) < 2:
            return None
        interpreter = tokens[0]
        path_token = tokens[1]
        rest = tokens[2:]
        # `bash -c "…"` / `python3 -m mod` have no repo-script path token at
        # all — only a real script token (extension + separator/`~`, per
        # `candidate_script_paths`) is convertible.
        if path_token.startswith("-") or path_token not in candidates:
            return None
    else:
        lower = tokens[0].lower()
        if lower.endswith(".sh"):
            interpreter = "bash"
        elif lower.endswith(".py"):
            interpreter = "python3"
        else:
            return None
        path_token = tokens[0]
        rest = tokens[1:]
        if path_token not in candidates:
            return None

    from skill_hub.domain.hooks import hooks_model

    try:
        norm_path = hooks_model.normalize_repo_script_path(path_token)
    except ValueError:
        return None
    return {
        "interpreter": interpreter,
        "path": norm_path,
        "args": shlex.join(rest) if rest else "",
    }


def _hook_def_dict(name: str, d) -> dict:
    return {
        "name": name,
        "provenance": d.provenance,
        "event": d.event,
        "command": d.command,
        "action": _hook_action(d),
        "script": _hook_script_dict(d),
        "description": d.description,
        "tools": list(d.tools),
        "matcher": d.matcher,
        "timeout": d.timeout,
        "harnesses": list(d.harnesses) if d.harnesses is not None else None,
        "settings": dict(d.settings),
    }


def cmd_hook_list(args):
    registry = hub_core.load_registry()
    defs = _hook_all_defs(registry)
    reach = _hook_reach(_hook_operation_context())
    as_json = getattr(args, "json", False)

    rows = []
    for name in sorted(defs):
        d = defs[name]
        g_attached, projects_attached = _hook_attach_summary(registry, name)
        rows.append({
            **_hook_def_dict(name, d),
            "attached_global": g_attached,
            "attached_projects": projects_attached,
            "baked_command": _hook_baked_command(name, d),
        })

    if as_json:
        print(json.dumps({"hooks": rows, "reach": reach}, indent=2))
        return

    if not rows:
        print("\nNo hooks defined. Create one with `hub hook new <name> …`.")
        return
    print(f"\n{c('Hooks', BOLD)}")
    print("─" * 72)
    for r in rows:
        prov = c(r["provenance"], DIM)
        scopes = []
        if r["attached_global"]:
            scopes.append("global")
        if r["attached_projects"]:
            scopes.append(f"{len(r['attached_projects'])} project(s)")
        scope_str = ", ".join(scopes) or "unattached"
        print(
            f"  {c(r['name'], BOLD)} [{prov}]  event={r['event'] or '?'}  "
            f"→ {scope_str}"
        )
    if reach:
        reach_str = ", ".join(f"{h}={v}" for h, v in sorted(reach.items()))
        print(f"\n  {c('capability reach:', DIM)} {reach_str}")
    else:
        print(f"\n  {c('capability reach: (run `hub sync` to probe)', DIM)}")


def cmd_hook_show(args):
    registry = hub_core.load_registry()
    defs = _hook_all_defs(registry)
    name = args.name
    if name not in defs:
        fail(f"unknown hook '{name}'")
    d = defs[name]
    g_attached, projects_attached = _hook_attach_summary(registry, name)
    reach = _hook_reach(_hook_operation_context())

    # Resolved settings per attached project (definition default deep-merged with
    # that project's hook_settings override).
    from skill_hub.domain.hooks import hooks_model

    project_settings = {}
    for p in projects_attached:
        pc = (registry.get("projects") or {}).get(p) or {}
        override = (pc.get("hook_settings") or {}).get(name)
        if isinstance(override, dict):
            project_settings[p] = hooks_model.deep_merge(d.settings, override)

    payload = {
        **_hook_def_dict(name, d),
        "attached_global": g_attached,
        "attached_projects": projects_attached,
        "project_settings": project_settings,
        "script_projects": _hook_script_projects(registry, name, d),
        "reach": reach,
        "baked_command": _hook_baked_command(name, d),
        "builtin": _hook_builtin_info(name, d),
        "command_script": _hook_command_script(registry, name, d),
        "repo_script_conversion": _hook_repo_script_conversion(d),
    }
    if d.script is not None and d.script.source == "managed":
        from skill_hub.infrastructure.hooks import hook_scripts

        # `body` is the managed body read fresh off disk — null when the file is
        # gone (doctor reports that as HOOK_SCRIPT_MISSING) or when the name
        # cannot address one at all (`body_path` is null then too).
        body_path = _hook_managed_path_or_none(name, d.script)
        payload["script"] = {
            **(payload["script"] or {}),
            "body": (
                hook_scripts.read_managed_script(name, d.script)
                if body_path is not None
                else None
            ),
            "body_path": str(body_path) if body_path is not None else None,
        }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"\n{c(name, BOLD)}  [{c(d.provenance, DIM)}]")
    print(f"  event    : {d.event or '?'}")
    if d.script is not None:
        if d.script.source == "managed":
            managed_path = _hook_managed_path_or_none(name, d.script)
            where = str(managed_path) if managed_path is not None else "(unaddressable)"
        else:
            where = f"{d.script.path} (in each project)"
        print(f"  script   : {d.script.source} · {d.script.interpreter} · {where}")
        if d.script.args:
            print(f"  args     : {d.script.args}")
        for row in payload["script_projects"]:
            mark = "✓" if row["path_exists"] else "—"
            print(f"             {mark} {row['project']}")
    else:
        print(f"  command  : {d.command or '?'}")
    if d.matcher:
        print(f"  matcher  : {d.matcher}")
    if d.tools:
        print(f"  tools    : {', '.join(d.tools)}")
    if d.timeout is not None:
        print(f"  timeout  : {d.timeout}")
    if d.harnesses is not None:
        print(f"  harnesses: {', '.join(d.harnesses)}")
    if d.settings:
        print(f"  settings : {json.dumps(d.settings)}")
    scopes = (["global"] if g_attached else []) + [f"project:{p}" for p in projects_attached]
    print(f"  attached : {', '.join(scopes) or '(none)'}")
    if reach:
        print(f"  reach    : {', '.join(f'{h}={v}' for h, v in sorted(reach.items()))}")


def cmd_hook_doctor(args):
    """`hub hook doctor [--json]` — a READ-ONLY risk scan over the hook library.

    Mirrors the targets `_run_hooks_stream`/`_run_doctor_rollup` build during a
    real sync (global → every installed harness; per project → its effective
    harnesses) but never writes anything: commands are baked in-memory only
    (`_hook_doctor_bake`, never `materialize_lsp_report` / `bake_script_hooks`),
    and the capability observation is read from one cache-only operation
    context rather than re-probed.

    Findings are attributed to a hook BY CONSTRUCTION, never by parsing
    `detail`: `risks.detect_hook_risks` is called once per (hook, harness) with
    a single-hook list, and `risks.detect_hook_script_risks` once per user
    script hook with a registry trimmed to that one hook's block — so each
    finding's `hook` field is simply the name the call was scoped to.

    A hook attached at the global scope resolves into every installed harness
    AND every project, so the raw per-(scope × harness) scan produces the same
    `(hook, code, detail)` several times over — deduped below to one finding,
    keeping the FIRST occurrence's `scope`/`harness` (global-first, since that
    scan runs before the per-project one). `danger_count` is computed AFTER
    dedupe so it counts distinct risks, not scan repetitions. Quarantined
    projects (`project_sync_skip_reason`, same guard `_run_hooks_stream` uses
    around hub.py's per-project pass) are skipped — sync never touches such a
    project, so it can carry no hook risk either.

    `--json` mode ALWAYS exits 0 — the Rust bridge (`hub_json` in
    `commands/mod.rs`) treats any non-zero exit as a failed read before it ever
    parses stdout, so a danger finding would otherwise blank the app's view.
    Text mode mirrors `hub permissions doctor` and exits 2 when any finding is
    `severity="danger"`.
    """
    import hub
    from skill_hub.domain.diagnostics import risks
    from skill_hub.domain.hooks import hooks_model
    from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope
    from skill_hub.infrastructure.harnesses.harness_probe import HookCapability

    registry = hub_core.load_registry()
    context = _hook_operation_context()
    installed = set(context.installed_harness_ids or ())
    cap_map = {
        h_id: HookCapability.from_dict(dict(entry))
        for h_id, entry in context.hook_observations.items()
        if isinstance(entry, Mapping)
    }
    _silence = lambda _m: None  # noqa: E731 — doctor is a read; warnings are noise here

    all_findings: list[dict] = []
    seen: set[tuple] = set()

    def _emit(hook: str, scope_label: str, harness_id: str, findings) -> None:
        for f in findings:
            key = (hook, f.code, f.detail)
            if key in seen:
                continue
            seen.add(key)
            all_findings.append({
                "hook": hook,
                "scope": scope_label,
                "harness": harness_id,
                **f.to_dict(),
            })

    # ── Global scope ────────────────────────────────────────────────────────
    global_hooks = hooks_model.resolve_global_hooks(registry, warn=_silence)
    _hook_doctor_bake(global_hooks, GlobalScope().slug)
    for h_id in sorted(installed):
        cap = cap_map.get(h_id)
        for rh in global_hooks:
            _emit(rh.name, "global", h_id, risks.detect_hook_risks([rh], cap, h_id))

    # ── Per-project scope ───────────────────────────────────────────────────
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        if hub.project_sync_skip_reason(proj_cfg):
            continue
        effective = _hook_effective_harnesses(
            proj_cfg, registry, context, installed
        )
        if not effective:
            continue
        resolved = hooks_model.resolve_project_hooks(proj_name, registry, warn=_silence)
        scope_slug = ProjectScope(
            name=proj_name, path=str(expand(proj_cfg.get("path") or ""))
        ).slug
        _hook_doctor_bake(resolved, scope_slug)
        for h_id in sorted(effective):
            cap = cap_map.get(h_id)
            for rh in resolved:
                _emit(
                    rh.name,
                    f"project:{proj_name}",
                    h_id,
                    risks.detect_hook_risks([rh], cap, h_id),
                )

    # ── Hook-script leg (registry-level; once per ATTACHED user script hook) ──
    # An unattached definition never runs, so a missing/broken body is inert —
    # scanning it anyway would flag risk in a hook nobody wired up.
    registry_defs = hooks_model.parse_registry_hooks(registry, warn=_silence)
    hooks_block = registry.get("hooks") or {}
    for name in sorted(registry_defs):
        if registry_defs[name].script is None:
            continue
        g_attached, projects_attached = _hook_attach_summary(registry, name)
        if not g_attached and not projects_attached:
            continue
        mini_registry = {
            "hooks": {name: hooks_block.get(name) or {}},
            "projects": registry.get("projects") or {},
            "hooks_global": registry.get("hooks_global") or [],
        }
        _emit(name, "registry", "", risks.detect_hook_script_risks(mini_registry))

    severity_rank = {"danger": 0, "warning": 1, "info": 2}
    all_findings.sort(
        key=lambda f: (severity_rank.get(f["severity"], 99), f["hook"], f["code"])
    )
    danger = sum(1 for f in all_findings if f["severity"] == "danger")

    if getattr(args, "json", False):
        print(json.dumps({"findings": all_findings, "danger_count": danger}, indent=2))
        return

    if not all_findings:
        print(f"{c('✓', GREEN)} no risks detected")
    for f in all_findings:
        colour = RED if f["severity"] == "danger" else YELLOW
        icon = "✗" if f["severity"] == "danger" else "!"
        harness_part = f" [{f['harness']}]" if f["harness"] else ""
        print(
            f"{c(icon, colour)} {f['scope']}{harness_part}  {f['hook']}  "
            f"{f['code']} ({f['severity']}): {f['detail']}"
        )
    if danger > 0:
        sys.exit(2)


@registry_mutation("hook-new")
def cmd_hook_new(args):
    import hub
    from skill_hub.infrastructure.hooks import hook_scripts

    registry = hub_core.load_registry()
    intent, script, body = _hook_script_from_args(args)
    if intent == "clear":
        fail("--script-source '' has nothing to clear on a new hook")
    _hook_new(
        registry,
        args.name,
        event=args.event,
        command=_hook_command_arg(args) or "",
        tools=parse_csv(getattr(args, "tools", None)) or None,
        matcher=getattr(args, "matcher", None),
        timeout=getattr(args, "timeout", None),
        harnesses=parse_csv(getattr(args, "harnesses", None)) or None,
        script=script,
        description=getattr(args, "description", None) or "",
    )
    hub_core.save_registry(registry)
    # Filesystem work happens only after the registry write succeeds, so a
    # rejected definition never leaves an orphan script dir behind.
    if script is not None and script.source == "managed":
        path = hook_scripts.ensure_managed_script(args.name, script, body=body)
        print(f"{c('·', DIM)} script: {path}")
    print(f"{c('✓', GREEN)} created hook '{args.name}'")
    hub._auto_sync()


@registry_mutation("hook-edit")
def cmd_hook_edit(args):
    import hub
    from skill_hub.infrastructure.hooks import hook_scripts

    registry = hub_core.load_registry()
    name = args.name
    registry_defs = _hook_registry_defs(registry)
    builtin_defs = _hook_builtin_defs()
    from skill_hub.domain.diagnostics.tool_catalog import CANONICAL_EVENTS

    edit_command = _hook_command_arg(args)
    if name not in registry_defs:
        if name in builtin_defs:
            fail(
                f"hook '{name}' is a built-in — command/event are read-only. "
                f"Use `hub hook set-settings {name} …` to edit its settings."
            )
        fail(f"unknown hook '{name}'")

    old_script = registry_defs[name].script
    script_intent, new_script, script_body = _hook_script_from_args(
        args, existing=old_script
    )
    touches_core = (
        (edit_command is not None)
        or script_intent != "keep"
        or any(
            getattr(args, f, None) is not None
            for f in ("event", "tools", "matcher", "timeout", "harnesses", "description")
        )
    )
    # Managed-script filesystem work is unreachable for a name that cannot become
    # a path (a hand-edited registry). Refuse BEFORE the registry write so the
    # edit is all-or-nothing rather than half-applied.
    if any(
        s is not None and s.source == "managed" for s in (old_script, new_script)
    ):
        try:
            hook_scripts.validate_managed_name(name)
        except ValueError as e:
            fail(str(e))

    block = dict(registry.get("hooks", {}).get(name) or {})
    if args.event is not None:
        if args.event not in CANONICAL_EVENTS:
            fail(f"unknown event '{args.event}'. Valid: {', '.join(CANONICAL_EVENTS)}")
        block["event"] = args.event
    if edit_command is not None:
        if not edit_command:
            fail("--command cannot be empty")
        if script_intent == "set":
            fail(
                "a hook is either a command or a script — pass --command OR the "
                "--script-* flags"
            )
        # Setting a command switches the hook AWAY from a script.
        block["command"] = edit_command
        block.pop("script", None)
    if script_intent == "set":
        block["script"] = new_script.to_block()
        block.pop("command", None)
    elif script_intent == "clear":
        if not (edit_command or block.get("command")):
            fail(
                "clearing the script would leave the hook with no action — pass "
                "--command <cmd> too"
            )
        block.pop("script", None)
    if getattr(args, "description", None) is not None:
        # Same clear-sentinel convention as --tools/--matcher/--harnesses: an
        # empty string clears the description, a non-empty value sets it.
        if args.description:
            block["description"] = args.description
        else:
            block.pop("description", None)
    if getattr(args, "tools", None) is not None:
        tools = parse_csv(args.tools)
        if tools:
            block["tools"] = tools
        else:
            block.pop("tools", None)
    if getattr(args, "matcher", None) is not None:
        if args.matcher:
            block["matcher"] = args.matcher
        else:
            block.pop("matcher", None)
    if getattr(args, "timeout", None) is not None:
        # Same clear-sentinel convention as --tools/--matcher/--harnesses: an
        # empty string clears a previously-set timeout (block.pop), a non-empty
        # value sets it. `--timeout` is a plain string arg (not argparse
        # type=int) specifically so an empty string can be distinguished from
        # "not passed" (None) — a typed int arg can't express that.
        if args.timeout == "":
            block.pop("timeout", None)
        else:
            try:
                block["timeout"] = int(args.timeout)
            except ValueError:
                fail(f"--timeout must be an integer number of seconds, got {args.timeout!r}")
    if getattr(args, "harnesses", None) is not None:
        harnesses = parse_csv(args.harnesses)
        if harnesses:
            block["harnesses"] = harnesses
        else:
            block.pop("harnesses", None)
    if not touches_core:
        fail("nothing to edit — pass at least one of --event/--command/--description/--tools/--matcher/--timeout/--harnesses/--script-*")  # noqa: E501
    registry["hooks"][name] = block
    hub_core.save_registry(registry)

    # Managed-script lifecycle, always AFTER the registry write: a rejected edit
    # must never have deleted a body. Switching away from managed deletes the
    # hub-owned dir (the editor warns before that switch).
    if script_intent == "set":
        final_script = new_script
    elif script_intent == "clear" or edit_command is not None:
        final_script = None
    else:
        final_script = old_script
    old_managed = old_script is not None and old_script.source == "managed"
    if final_script is not None and final_script.source == "managed":
        if old_managed and old_script.filename != final_script.filename:
            hook_scripts.rename_managed_script(name, old_script, final_script)
        path = hook_scripts.ensure_managed_script(name, final_script, body=script_body)
        print(f"{c('·', DIM)} script: {path}")
    elif old_managed and hook_scripts.remove_managed_script_dir(name):
        print(f"{c('·', DIM)} removed managed script for '{name}'")
    print(f"{c('✓', GREEN)} updated hook '{name}'")
    hub._auto_sync()


@registry_mutation("hook-delete")
def cmd_hook_delete(args):
    import hub
    registry = hub_core.load_registry()
    name = args.name
    registry_defs = _hook_registry_defs(registry)
    builtin_defs = _hook_builtin_defs()

    if name not in registry_defs:
        if name in builtin_defs:
            fail(
                f"hook '{name}' is a built-in and cannot be deleted — detach it with "
                f"`hub hook detach {name} --global|--project <p>` instead."
            )
        fail(f"unknown hook '{name}'")

    g_attached, projects_attached = _hook_attach_summary(registry, name)
    if not getattr(args, "yes", False):
        print(f"\n{c('Would delete hook', YELLOW)} '{name}':")
        print("  remove definition from registry")
        plan_script = registry_defs[name].script
        if plan_script is not None and plan_script.source == "managed":
            from skill_hub.infrastructure.hooks import hook_scripts

            try:
                target = str(hook_scripts.managed_script_dir(name))
            except ValueError:
                # The registry entry still goes; nothing on disk is addressable.
                target = "(none — the name cannot address a managed script dir)"
            print(f"  delete managed script: {target}")
        if g_attached:
            print("  detach from: global")
        for p in projects_attached:
            print(f"  detach from: project '{p}'")
        print(f"\n  Re-run with {c('--yes', BOLD)} to confirm.")
        return

    # Detach from every scope, then drop the definition + any hook_settings.
    _hook_detach(registry, name, scope_global=True, proj_name=None)
    for p in list((registry.get("projects") or {}).keys()):
        _hook_detach(registry, name, scope_global=False, proj_name=p)
        pc = registry["projects"][p]
        hs = pc.get("hook_settings")
        if isinstance(hs, dict) and name in hs:
            del hs[name]
            if not hs:
                pc.pop("hook_settings", None)
    script = registry_defs[name].script
    del registry["hooks"][name]
    if not registry["hooks"]:
        registry.pop("hooks", None)
    hub_core.save_registry(registry)
    if script is not None and script.source == "managed":
        from skill_hub.infrastructure.hooks import hook_scripts

        if hook_scripts.remove_managed_script_dir(name):
            print(f"{c('·', DIM)} removed managed script for '{name}'")
    print(f"{c('✓', GREEN)} deleted hook '{name}' (detached from all scopes)")
    hub._auto_sync()


def _hook_scope_from_args(args) -> tuple[bool, Optional[str]]:
    """Resolve exactly one of --global / --project into (scope_global, proj_name)."""
    is_global = bool(getattr(args, "global_", False))
    proj_name = getattr(args, "project", None)
    if is_global == bool(proj_name):
        fail("specify exactly one of --global or --project <name>")
    return is_global, proj_name


@registry_mutation("hook-attach")
def cmd_hook_attach(args):
    import hub
    registry = hub_core.load_registry()
    name = args.name
    if name not in _hook_all_defs(registry):
        fail(f"unknown hook '{name}' — create it with `hub hook new` first")
    scope_global, proj_name = _hook_scope_from_args(args)
    added = _hook_attach(
        registry,
        name,
        scope_global=scope_global,
        proj_name=proj_name,
        operation_context=getattr(args, "_operation_context", None),
    )
    hub_core.save_registry(registry)
    where = "global" if scope_global else f"project '{proj_name}'"
    if added:
        print(f"{c('✓', GREEN)} attached hook '{name}' to {where}")
    else:
        print(f"{c('·', DIM)} hook '{name}' already attached to {where}")
    hub._auto_sync()


@registry_mutation("hook-detach")
def cmd_hook_detach(args):
    import hub
    registry = hub_core.load_registry()
    name = args.name
    scope_global, proj_name = _hook_scope_from_args(args)
    removed = _hook_detach(
        registry,
        name,
        scope_global=scope_global,
        proj_name=proj_name,
        operation_context=getattr(args, "_operation_context", None),
    )
    hub_core.save_registry(registry)
    where = "global" if scope_global else f"project '{proj_name}'"
    if removed:
        print(f"{c('✓', GREEN)} detached hook '{name}' from {where}")
    else:
        print(f"{c('·', DIM)} hook '{name}' was not attached to {where}")
    hub._auto_sync()


@registry_mutation("hook-set-settings")
def cmd_hook_set_settings(args):
    import hub
    registry = hub_core.load_registry()
    name = args.name
    defs = _hook_all_defs(registry)
    if name not in defs:
        fail(f"unknown hook '{name}'")
    try:
        settings = json.loads(args.json)
    except json.JSONDecodeError as e:
        fail(f"invalid --json settings: {e}")
    if not isinstance(settings, dict):
        fail("--json settings must be a JSON object")

    from skill_hub.domain.hooks import hooks_model

    # Default scope is global when neither flag is passed.
    is_global = bool(getattr(args, "global_", False))
    proj_name = getattr(args, "project", None)
    if is_global and proj_name:
        fail("specify at most one of --global or --project <name>")
    if not proj_name:
        # Global tier = the definition's base settings. Built-in base settings are
        # read-only on-disk defaults (no global override tier in v1), so refuse and
        # point at the per-project override.
        registry_defs = _hook_registry_defs(registry)
        if name not in registry_defs:
            fail(
                f"'{name}' is a built-in — its global default settings are read-only. "
                f"Use `--project <p>` to override its settings for a project."
            )
        block = registry["hooks"][name]
        merged = hooks_model.deep_merge(block.get("settings") or {}, settings)
        if merged:
            block["settings"] = merged
        else:
            block.pop("settings", None)
        hub_core.save_registry(registry)
        print(f"{c('✓', GREEN)} updated global settings for hook '{name}'")
        hub._auto_sync()
        return

    projects = registry.get("projects") or {}
    if proj_name not in projects:
        fail(f"unknown project '{proj_name}'")
    proj = projects[proj_name]
    hook_settings = proj.setdefault("hook_settings", {})
    if not isinstance(hook_settings, dict):
        hook_settings = {}
        proj["hook_settings"] = hook_settings
    merged = hooks_model.deep_merge(hook_settings.get(name) or {}, settings)
    if merged:
        hook_settings[name] = merged
    else:
        hook_settings.pop(name, None)
        if not hook_settings:
            proj.pop("hook_settings", None)
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} updated settings for hook '{name}' in project '{proj_name}'")
    hub._auto_sync()


def _hook_managed_script_or_fail(registry: dict, name: str):
    """The definition + its MANAGED script, failing with the honest reason when
    the hook is a command hook, a repo script, or a built-in."""
    from skill_hub.infrastructure.hooks import hook_scripts

    defs = _hook_all_defs(registry)
    if name not in defs:
        fail(f"unknown hook '{name}'")
    d = defs[name]
    if d.provenance == "builtin":
        # Built-ins own their own body in the code home — it is not a hub-managed
        # script, and the code home is read-only. Same posture as `hub hook edit`.
        fail(
            f"hook '{name}' is a built-in — its script is read-only. "
            f"Use `hub hook set-settings {name} …` to edit its settings."
        )
    try:
        hook_scripts.validate_managed_name(name)
    except ValueError as e:
        fail(str(e))
    if d.script is None:
        fail(
            f"hook '{name}' is a command hook — it has no script body "
            f"(switch it with `hub hook edit {name} --script-source managed …`)"
        )
    if d.script.source != "managed":
        fail(
            f"hook '{name}' uses a repo script ({d.script.path}) — edit it in each "
            f"project, not in Skill Tree"
        )
    return d


def cmd_hook_script_show(args):
    from skill_hub.infrastructure.hooks import hook_scripts

    registry = hub_core.load_registry()
    name = args.name
    d = _hook_managed_script_or_fail(registry, name)
    path = hook_scripts.managed_script_path(name, d.script)
    body = hook_scripts.read_managed_script(name, d.script)
    if getattr(args, "json", False):
        print(json.dumps({
            "name": name,
            "path": str(path),
            "interpreter": d.script.interpreter,
            "args": d.script.args,
            "body": body,
        }, indent=2))
        return
    if body is None:
        fail(f"managed script for '{name}' is missing at {path}")
    print(body, end="" if body.endswith("\n") else "\n")


@registry_mutation("hook-script-save")
def cmd_hook_script_save(args):
    import hub
    from skill_hub.infrastructure.hooks import hook_scripts

    registry = hub_core.load_registry()
    name = args.name
    d = _hook_managed_script_or_fail(registry, name)
    body_file = getattr(args, "body_file", None)
    if getattr(args, "stdin", False):
        if body_file:
            fail("pass either --body-file or --stdin, not both")
        body = sys.stdin.read()
    elif body_file:
        try:
            body = Path(body_file).expanduser().read_text()
        except OSError as e:
            fail(f"cannot read --body-file {body_file}: {e}")
    else:
        fail("pass --body-file <path> or --stdin")
    path = hook_scripts.write_managed_script(name, d.script, body)
    print(f"{c('✓', GREEN)} saved script for hook '{name}' → {path}")
    hub._auto_sync()
