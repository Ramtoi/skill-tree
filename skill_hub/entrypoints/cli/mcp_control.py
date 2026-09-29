"""`hub mcp-control` — register/unregister the control-plane MCP server.

Registers the Skill Hub MCP server itself (`skill_hub_mcp_server.py`) as a
`scope: global` `mcp-server` skill so it reaches every harness on the next
`hub sync`. Carved out of `hub.py` (S5 slice) — see `hub_cli/__init__.py` for
the module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Optional, Sequence

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    c,
    registry_mutation,
)

NAME = "mcp-control"

p_mcpctl = None

MCP_CONTROL_SKILL_NAME = "skill-tree"
LEGACY_MCP_CONTROL_SKILL_NAME = "skill-hub"
MCP_CONTROL_OPT_OUT_KEY = "control_plane_mcp"


def register(sub) -> None:
    global p_mcpctl

    # mcp-control — register/unregister the control-plane MCP server
    p_mcpctl = sub.add_parser(
        "mcp-control",
        help="Register/unregister the Skill Hub control-plane MCP server",
    )
    mcpctl_sub = p_mcpctl.add_subparsers(dest="mcp_control_cmd")
    mcpctl_sub.add_parser("install", help="Register the control-plane MCP server")
    mcpctl_sub.add_parser("uninstall", help="Remove the control-plane MCP server")
    mcpctl_sub.add_parser("status", help="Show registration status + resolved path")


def dispatch(args) -> None:
    cmd_mcp_control(args)


# ─────────────────────────────────────────────────────────────────────────────
# hub mcp-control — register/unregister the control-plane MCP server
# ─────────────────────────────────────────────────────────────────────────────


def _mcp_control_server_path() -> Path:
    return hub_core.code_home() / "skill_hub/entrypoints/mcp/skill_hub_mcp_server.py"


def _mcp_control_entry() -> dict:
    server_path = str(_mcp_control_server_path())
    return {
        "type": "mcp-server",
        "version": "1.0.0",
        "description": "Skill Tree control-plane MCP server (manage skills + bundles).",
        "scope": "global",
        "source": None,
        "upstream": None,
        "mcp": {
            "runtime": "python",
            "command": sys.executable,
            "args": [server_path],
            # Tag mutations made through the MCP server so the audit log
            # distinguishes them from human `hub` CLI use.
            "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
        },
    }


def _is_managed_control_entry(entry: object) -> bool:
    """Return whether ``entry`` is the control server written by Skill Tree.

    The legacy registration used the name ``skill-hub`` and ``python3``.  The
    actor and bundled server path are stronger ownership signals, so a user
    registration that happens to use either name is left untouched.
    """
    if not isinstance(entry, dict) or entry.get("type") != "mcp-server":
        return False
    mcp = entry.get("mcp")
    if not isinstance(mcp, dict):
        return False
    env = mcp.get("env") or {}
    if not isinstance(env, dict) or env.get("SKILL_HUB_ACTOR") != "skill-hub-mcp":
        return False
    args = mcp.get("args") or []
    if not isinstance(args, list) or not args:
        return False
    try:
        return Path(str(args[0])).name == "skill_hub_mcp_server.py"
    except (OSError, ValueError):
        return False


def _setup_opted_out(registry: dict) -> bool:
    state = registry.get(MCP_CONTROL_OPT_OUT_KEY) or {}
    return isinstance(state, dict) and state.get("opted_out") is True


def _set_setup_opt_out(registry: dict, opted_out: bool) -> None:
    state = registry.setdefault(MCP_CONTROL_OPT_OUT_KEY, {})
    state["opted_out"] = opted_out


def bundled_control_available() -> bool:
    from skill_hub.application.skills import starter_skills

    return any(item["name"] == "skt-mcp" for item in
               starter_skills.discover_starter_skills(starter_skills.starter_skills_root()))


def _provision_companion(
    registry: dict, selected_harnesses: Optional[Sequence[str]], starter_skills
) -> tuple[bool, str]:
    """Register and promote the bundled ``skt-mcp`` skill when available."""
    skills = registry.setdefault("skills", {})
    starter_result = starter_skills.reconcile_starter_skills(registry)
    changed = bool(starter_result["changed"])
    companion = skills.get("skt-mcp")
    if not isinstance(companion, dict):
        return changed, "skipped"
    if not starter_skills.is_starter_skill("skt-mcp", companion):
        return changed, "collision"
    state = registry.setdefault(MCP_CONTROL_OPT_OUT_KEY, {})
    if state.get("companion_initialized"):
        return changed, "existing"
    state["companion_initialized"] = True
    changed = True
    if companion.get("scope") != "global":
        companion["scope"] = "global"
        changed = True
    if selected_harnesses:
        affinity = sorted({str(h) for h in selected_harnesses})
        if companion.get("harnesses") != affinity:
            companion["harnesses"] = affinity
            changed = True
    return changed, "provisioned"


def ensure_control_plane_setup(
    registry: dict, *, selected_harnesses: Optional[Sequence[str]] = None
) -> dict:
    """Provision the control server and companion skill for initial setup.

    This helper is intentionally called by bootstrap/restore, never by every
    sync.  It is additive, idempotent, and preserves user-owned collisions.
    The returned report is suitable for concise setup diagnostics.
    """
    from skill_hub.application.skills import starter_skills

    report = {"changed": False, "server": "skipped", "companion": "skipped"}
    if _setup_opted_out(registry):
        report["server"] = "opted_out"
        return report

    skills = registry.setdefault("skills", {})
    if not isinstance(skills, dict):
        skills = {}
        registry["skills"] = skills

    desired = _mcp_control_entry()
    canonical = skills.get(MCP_CONTROL_SKILL_NAME)
    legacy = skills.get(LEGACY_MCP_CONTROL_SKILL_NAME)
    if canonical is not None and not _is_managed_control_entry(canonical):
        report["server"] = "collision"
    elif canonical is None and legacy is not None and not _is_managed_control_entry(legacy):
        report["server"] = "legacy_collision"
    else:
        existing = canonical if canonical is not None else legacy
        if existing is not None:
            desired = copy.deepcopy(existing)
            desired["mcp"]["command"] = sys.executable
            desired["mcp"]["args"] = [str(_mcp_control_server_path()), *existing["mcp"]["args"][1:]]
        elif selected_harnesses:
            desired["harnesses"] = sorted(set(selected_harnesses))
        if canonical != desired:
            skills[MCP_CONTROL_SKILL_NAME] = desired
            report["changed"] = True
        if legacy is not None and _is_managed_control_entry(legacy):
            import hub

            hub._prune_skill_references(registry, LEGACY_MCP_CONTROL_SKILL_NAME,
                                    replacement=MCP_CONTROL_SKILL_NAME)
            del skills[LEGACY_MCP_CONTROL_SKILL_NAME]
            report["changed"] = True
        report["server"] = "existing" if canonical is not None else (
            "migrated" if legacy is not None else "registered")

    companion_changed, companion_status = _provision_companion(
        registry, selected_harnesses, starter_skills
    )
    report["changed"] = report["changed"] or companion_changed
    report["companion"] = companion_status
    return report


@registry_mutation("mcp-control-install")
def cmd_mcp_control_install(_args):
    registry = hub_core.load_registry()
    _set_setup_opt_out(registry, False)
    result = ensure_control_plane_setup(registry)
    hub_core.save_registry(registry)
    if result["server"] in {"collision", "legacy_collision"}:
        print("Control-plane setup preserved a custom server registration.")
    else:
        print(f"Control-plane MCP '{MCP_CONTROL_SKILL_NAME}': {result['server']}.")
    print(f"  → run `{c('hub sync', CYAN)}` to dispatch the configuration")


@registry_mutation("mcp-control-uninstall")
def cmd_mcp_control_uninstall(_args):
    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    for name in (MCP_CONTROL_SKILL_NAME, LEGACY_MCP_CONTROL_SKILL_NAME):
        if _is_managed_control_entry(skills.get(name)):
            import hub

            hub._prune_skill_references(registry, name)
            del skills[name]
    _set_setup_opt_out(registry, True)
    hub_core.save_registry(registry)
    print("Managed control-plane MCP removed; automatic setup is disabled.")
    print(f"  → run `{c('hub sync', CYAN)}` to remove its native configuration")


def cmd_mcp_control_status(_args):
    server_path = _mcp_control_server_path()
    import hub

    registry = hub._read_registry_optional()
    entry = (registry.get("skills") or {}).get(MCP_CONTROL_SKILL_NAME)
    registered = entry is not None
    print(f"\n{c('Control-plane MCP server', BOLD, CYAN)}\n")
    print(f"  name:       {MCP_CONTROL_SKILL_NAME}")
    print(f"  server:     {server_path}")
    print(f"  exists:     {'yes' if server_path.exists() else 'no'}")
    print(
        f"  registered: {c('yes', GREEN) if registered else c('no', DIM)}"
    )
    if registered:
        args_path = ((entry.get("mcp") or {}).get("args") or ["?"])[0]
        print(f"  registry args[0]: {args_path}")


def cmd_mcp_control(args):
    sub = getattr(args, "mcp_control_cmd", None)
    if sub == "install":
        cmd_mcp_control_install(args)
    elif sub == "uninstall":
        cmd_mcp_control_uninstall(args)
    elif sub == "status":
        cmd_mcp_control_status(args)
    else:
        print("Usage: hub mcp-control {install|uninstall|status}")
