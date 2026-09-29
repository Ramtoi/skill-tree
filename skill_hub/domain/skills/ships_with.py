"""ships_with — the `ships_with:` frontmatter axis (companion agents, hooks,
permission rules a skill declares for itself).

A leaf: at module scope it imports `hub_core`, `skill_meta` and stdlib only,
never `hub` or `hub_cli` (mirroring the posture of `skill_meta.py`). Every
other sibling this module reaches into — `harnesses`, `harness_probe`,
`tool_catalog`, `subagents`, `subagent_links`, `hook_adapters`,
`permission_adapters`, `permissions` — is imported FUNCTION-scoped, both to
keep import cost low on the common path and, in `skill_meta.py`'s case, to
break the two-way dependency (`sync_skill_frontmatter_metadata` calls this
module; this module never calls back into `skill_meta` at its own module
top — it imports `skill_meta` directly since that direction is one-way).

Design: `plans/0-direction.md` D1-D6 + amendments A1-A12 (orchestration
workspace `ships-with`, milestone 5). This wave (W1) owns the model only:
schema validation + mirror normalizer (`normalize_block`), the provisioning
plan builder (`plan_provision`), the per-harness agent renderer
(`render_agent_payload`), and the per-project ownership ledger accessors.
`hub enable`/`hub disable` (W2), the doctor findings (W3) and the MCP `equip`
flag (W4) land in later waves — this module exposes exactly the surface they
need and nothing that reaches into `hub.py`.

`ships_with:` frontmatter (D1 shape, mirrored verbatim into
`skills.<n>.ships_with` — permissions as BARE pattern strings under
allow/deny/ask; only the per-project LEDGER uses `{pattern, kind}` dicts):

    ships_with:
      agents: [orch-implementer, orch-reviewer]   # <skill>/agents/<name>.md
      hooks:
        - name: orch-scope-guard
          event: PreToolUse
          tools: [Edit, Write, MultiEdit]
          command: scripts/scope-guard.sh          # relative to the skill dir
          activation: while-running                # always | while-running
          harnesses: [claude-code, codex]           # optional affinity
      permissions:
        deny: ["Bash(git push --force:*)"]
        ask: ["Bash(gh pr merge:*)"]

A malformed block (any single field failing validation) drops the WHOLE block
with one warning — never a partial retention, never a raised exception. An
absent block simply mirrors to nothing.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable, Optional

from skill_hub import hub_core
from skill_hub.domain.skills import skill_meta

# ─────────────────────────────────────────────────────────────────────────────
# Vocabulary
# ─────────────────────────────────────────────────────────────────────────────

ACTIVATIONS = ("always", "while-running")  # A1 — `project` dropped (already implied)
TIERS = ("utility", "scout", "worker", "planner", "deep")
KINDS = ("agent", "hook", "permission", "trust")  # A2
VERDICTS = ("will_write", "already_present", "unsupported", "feature_off", "not_installed")
PERMISSION_KINDS = ("allow", "deny", "ask")

# A10 — the ONE edit point for tier → per-harness model mapping.
TIER_MODELS: dict[str, dict[str, dict[str, str]]] = {
    "utility": {
        "claude-code": {"model": "haiku", "effort": "medium"},
        "codex": {"model": "gpt-6-luna", "model_reasoning_effort": "low"},
    },
    "scout": {
        "claude-code": {"model": "sonnet", "effort": "low"},
        "codex": {"model": "gpt-6-luna", "model_reasoning_effort": "medium"},
    },
    "worker": {
        "claude-code": {"model": "sonnet", "effort": "medium"},
        "codex": {"model": "gpt-6-luna", "model_reasoning_effort": "high"},
    },
    "planner": {
        "claude-code": {"model": "opus", "effort": "medium"},
        "codex": {"model": "gpt-6-sol", "model_reasoning_effort": "medium"},
    },
    "deep": {
        "claude-code": {"model": "fable", "effort": "high"},
        "codex": {"model": "gpt-6-astra", "model_reasoning_effort": "medium"},
    },
}

# The literal reason Codex's hook adapter gives for a project-scope hook
# (hook_adapters.CodexHookAdapter.apply — v1 is global-only). Duplicated here
# (rather than imported) because computing it for real would mean invoking
# the adapter's `apply()`, which does real filesystem I/O; the plan is a
# read-only preview.
_CODEX_PROJECT_HOOK_REASON = (
    "Codex receives only globally-attached hooks in v1; "
    "project-attached hooks are not written to config.toml"
)

_CODEX_TRUST_REASON = "Codex runs a project's committed config.toml and hooks once trusted"


def _warn(warn: Optional[Callable[[str], None]], message: str) -> None:
    if warn is not None:
        warn(message)
        return
    print(f"  {hub_core.c('!', hub_core.YELLOW)} {message}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# Frontmatter validation + mirror normalizer
# ─────────────────────────────────────────────────────────────────────────────


def _validate_hook_command(skill_dir: Path, command: Any) -> Optional[str]:
    """A hook `command` must be a relative path resolving INSIDE `skill_dir` —
    no `..`, no absolute path (POSIX or Windows drive), no escaping symlink.
    Returns the cleaned relative string, or None on any rejection (never
    raises) — the posture of `sources.normalize_subpath_within`, but
    reporting-not-raising."""
    if not isinstance(command, str):
        return None
    cleaned = command.strip()
    if not cleaned:
        return None
    if cleaned.startswith("/") or cleaned.startswith("~"):
        return None
    if len(cleaned) > 1 and cleaned[1] == ":":  # Windows drive letter
        return None
    try:
        base_resolved = skill_dir.resolve(strict=False)
        candidate = (skill_dir / cleaned).resolve(strict=False)
    except (OSError, RuntimeError):
        return None
    try:
        candidate.relative_to(base_resolved)
    except ValueError:
        return None
    return cleaned


def _validate_pattern(pattern: str, kind: str) -> tuple[bool, str]:
    """Validate frontmatter metadata against the explicit portable baseline."""
    from skill_hub.domain.permissions.permissions import Rule
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    result = pa.validate_rule_across_adapters(
        Rule(pattern=pattern, kind=kind), mode="baseline"
    )
    return result.ok, result.error or "invalid pattern"


# ─────────────────────────────────────────────────────────────────────────────
# Hook script scaffold (wave 4c unit 1: cli-hook-scaffold, plans/3.md §3.1-3.2)
# ─────────────────────────────────────────────────────────────────────────────

HOOK_SCRIPT_DIR = "scripts"

_HOOK_SLUG_RE = re.compile(r"[^a-z0-9]+")
_HOOK_SCRIPT_SUFFIX_TEMPLATE = {".sh": "bash", ".py": "python3"}

# Event families driving the scaffold's commented-out refusal shape (§3.2).
_HOOK_EVENTS_DENY_JSON = ("PreToolUse", "PermissionRequest")
_HOOK_EVENTS_BLOCK_JSON = ("SubagentStop", "Stop")


def default_hook_script_rel(hook_name: str) -> Optional[str]:
    """Derive `scripts/<slug>.sh` from a hook name — "scope-guard" ->
    "scripts/scope-guard.sh". Returns `None` when the name slugifies to
    nothing (never a bare "scripts/.sh")."""
    if not isinstance(hook_name, str):
        return None
    slug = _HOOK_SLUG_RE.sub("-", hook_name.strip().lower()).strip("-")
    if not slug:
        return None
    return f"{HOOK_SCRIPT_DIR}/{slug}.sh"


def _hook_refusal_comment_bash(event: str) -> str:
    if event in _HOOK_EVENTS_DENY_JSON:
        return (
            "# TODO: to refuse, print the deny JSON below and exit 0:\n"
            "# python3 -c '\n"
            "# import json\n"
            '# print(json.dumps({"hookSpecificOutput": {\n'
            f'#     "hookEventName": "{event}",\n'
            '#     "permissionDecision": "deny",\n'
            '#     "permissionDecisionReason": "<why>",\n'
            "# }}))\n"
            "# '\n"
        )
    if event in _HOOK_EVENTS_BLOCK_JSON:
        return (
            "# TODO: to refuse, print the block JSON below and exit 0:\n"
            "# python3 -c '\n"
            "# import json\n"
            '# print(json.dumps({"decision": "block", "reason": "<why>"}))\n'
            "# '\n"
        )
    return "# This event cannot block -- stdout is informational.\n"


def _hook_refusal_comment_python(event: str) -> str:
    if event in _HOOK_EVENTS_DENY_JSON:
        return (
            "# TODO: to refuse, print the deny JSON below and exit 0:\n"
            '# print(json.dumps({"hookSpecificOutput": {\n'
            f'#     "hookEventName": "{event}",\n'
            '#     "permissionDecision": "deny",\n'
            '#     "permissionDecisionReason": "<why>",\n'
            "# }}))\n"
        )
    if event in _HOOK_EVENTS_BLOCK_JSON:
        return (
            "# TODO: to refuse, print the block JSON below and exit 0:\n"
            '# print(json.dumps({"decision": "block", "reason": "<why>"}))\n'
        )
    return "# This event cannot block -- stdout is informational.\n"


def hook_script_template(hook_name: str, event: str, *, template: str = "bash") -> str:
    """Render a fail-open scaffold body for a brand-new inline hook script —
    the same contract the shipped `orchestrate-advanced` fixture scripts
    follow: read the JSON payload on stdin and, with nothing to say, exit 0
    having written nothing. The commented-out TODO block's refusal shape is
    keyed on `event`'s family: `PreToolUse`/`PermissionRequest` get the
    nested `hookSpecificOutput.permissionDecision` deny JSON,
    `SubagentStop`/`Stop` get the top-level `{"decision":"block"}` shape,
    every other event gets a one-line "cannot block" comment. `template` is
    `"bash"` (default) or `"python3"`."""
    name = hook_name or "hook"
    if template == "python3":
        header = (
            "#!/usr/bin/env python3\n"
            f"# {name}.py -- {event} hook (scaffolded by `hub skill companions new-hook`).\n"
            "#\n"
            "# Fail-open by default: reads the JSON payload on stdin and, with\n"
            "# nothing to say, exits 0 having written nothing.\n"
            "import json\n"
            "import sys\n"
            "\n"
            "try:\n"
            "    payload = json.load(sys.stdin)\n"
            "except Exception:\n"
            "    raise SystemExit(0)\n"
            "\n"
        )
        return header + _hook_refusal_comment_python(event) + "\nsys.exit(0)\n"

    header = (
        "#!/bin/bash\n"
        f"# {name}.sh -- {event} hook (scaffolded by `hub skill companions new-hook`).\n"
        "#\n"
        "# Fail-open by default: reads the JSON payload on stdin and, with\n"
        "# nothing to say, exits 0 having written nothing.\n"
    )
    body = r'''set -euo pipefail

PAYLOAD="$(cat)"

extract_str() {
  local key="$1"
  if [[ "$PAYLOAD" =~ \"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

'''
    return header + body + _hook_refusal_comment_bash(event) + "\nexit 0\n"


def validate_scaffold_target(skill_dir: Path, command: Any) -> tuple[Optional[str], Optional[str]]:
    """Validate a scaffold `command` target for `_stage_hook_script`: it must
    resolve INSIDE `skill_dir` (no `..`, no absolute path, no escaping
    symlink — the `_validate_hook_command` rule), live under
    `HOOK_SCRIPT_DIR`, carry a `.sh`/`.py` suffix, and not already be a
    directory. Returns `(cleaned_rel, None)` on success or `(None, reason)`,
    `reason` one of `"outside_skill_dir"`, `"not_under_scripts"`,
    `"unsupported_suffix"`, `"is_a_directory"`. Never raises."""
    if not isinstance(command, str):
        return None, "outside_skill_dir"
    cleaned = command.strip()
    if not cleaned:
        return None, "outside_skill_dir"
    if cleaned.startswith("/") or cleaned.startswith("~"):
        return None, "outside_skill_dir"
    if len(cleaned) > 1 and cleaned[1] == ":":  # Windows drive letter
        return None, "outside_skill_dir"
    try:
        base_resolved = skill_dir.resolve(strict=False)
        candidate = (skill_dir / cleaned).resolve(strict=False)
    except (OSError, RuntimeError):
        return None, "outside_skill_dir"
    try:
        rel = candidate.relative_to(base_resolved)
    except ValueError:
        return None, "outside_skill_dir"
    if rel.parts[:1] != (HOOK_SCRIPT_DIR,):
        return None, "not_under_scripts"
    if candidate.suffix not in _HOOK_SCRIPT_SUFFIX_TEMPLATE:
        return None, "unsupported_suffix"
    if candidate.is_dir():
        return None, "is_a_directory"
    return cleaned, None


def normalize_block(
    raw: Any, skill_dir: Path, *, warn: Optional[Callable[[str], None]] = None
) -> Optional[dict]:
    """The D1 shape verbatim (permissions as bare pattern strings), or None.

    Never raises. Any single validation failure drops the WHOLE block with one
    warning — no partial retention. An absent/empty/non-dict `raw` is simply
    "nothing declared" (also None, no warning: that is not malformed, it's
    absent).
    """
    if raw is None:
        return None
    if not isinstance(raw, dict) or not raw:
        if raw:  # non-empty but not a dict — that IS malformed
            _warn(warn, "ships_with: must be a mapping")
        return None

    result: dict = {}

    # ── agents ──
    raw_agents = raw.get("agents")
    if raw_agents is not None:
        if not isinstance(raw_agents, list) or not all(
            isinstance(a, str) and a.strip() for a in raw_agents
        ):
            _warn(warn, "ships_with.agents: must be a list of non-empty strings")
            return None
        agents: list[str] = []
        for a in raw_agents:
            name = a.strip()
            agent_file = skill_dir / "agents" / f"{name}.md"
            if not agent_file.is_file():
                _warn(warn, f"ships_with.agents: no agent file at {agent_file}")
                return None
            agents.append(name)
        if agents:
            result["agents"] = agents

    # ── hooks ──
    raw_hooks = raw.get("hooks")
    if raw_hooks is not None:
        if not isinstance(raw_hooks, list):
            _warn(warn, "ships_with.hooks: must be a list")
            return None
        from skill_hub.domain.diagnostics import tool_catalog

        hooks: list[dict] = []
        seen_names: set[str] = set()
        for h in raw_hooks:
            if not isinstance(h, dict):
                _warn(warn, "ships_with.hooks: each entry must be a mapping")
                return None

            # A18/C5: a hook entry may be a REFERENCE into the hooks library —
            # `{"ref": <name>}` — instead of an inline definition. Normalized
            # to EXACTLY `{"ref": r, "name": r}` and nothing else; whether the
            # reference actually resolves is a plan/reconcile concern (this
            # function has no registry to check against).
            if "ref" in h:
                ref = h.get("ref")
                if not isinstance(ref, str) or not ref.strip():
                    _warn(warn, "ships_with.hooks: 'ref' must be a non-empty string")
                    return None
                ref = ref.strip()
                if ref in seen_names:
                    _warn(
                        warn,
                        f"ships_with.hooks: '{ref}' is declared more than once "
                        f"(an inline hook and a ref may not share a name)",
                    )
                    return None
                seen_names.add(ref)
                hooks.append({"ref": ref, "name": ref})
                continue

            name = h.get("name")
            if not isinstance(name, str) or not name.strip():
                _warn(warn, "ships_with.hooks: 'name' is required")
                return None
            name = name.strip()
            if name in seen_names:
                _warn(
                    warn,
                    f"ships_with.hooks: '{name}' is declared more than once "
                    f"(an inline hook and a ref may not share a name)",
                )
                return None
            seen_names.add(name)
            event = h.get("event")
            if event not in tool_catalog.CANONICAL_EVENTS:
                _warn(warn, f"ships_with.hooks[{name}]: unknown event '{event}'")
                return None
            activation = h.get("activation", "always")
            if activation not in ACTIVATIONS:
                _warn(
                    warn,
                    f"ships_with.hooks[{name}]: activation '{activation}' invalid "
                    f"(expected one of {ACTIVATIONS})",
                )
                return None
            rel_command = _validate_hook_command(skill_dir, h.get("command"))
            if rel_command is None:
                _warn(
                    warn,
                    f"ships_with.hooks[{name}]: command must be a path inside the "
                    f"skill dir (no '..', no absolute path, no escaping symlink)",
                )
                return None
            tools = h.get("tools")
            if tools is not None and (
                not isinstance(tools, list)
                or not all(isinstance(t, str) and t.strip() for t in tools)
            ):
                _warn(warn, f"ships_with.hooks[{name}]: 'tools' must be a list of strings")
                return None
            norm: dict = {
                "name": name,
                "event": event,
                "command": rel_command,
                "activation": activation,
            }
            if tools:
                norm["tools"] = [str(t).strip() for t in tools]
            harnesses_aff = h.get("harnesses")
            if harnesses_aff is not None:
                if not isinstance(harnesses_aff, list) or not all(
                    isinstance(x, str) for x in harnesses_aff
                ):
                    _warn(
                        warn,
                        f"ships_with.hooks[{name}]: 'harnesses' must be a list of strings",
                    )
                    return None
                norm["harnesses"] = skill_meta._validate_harness_affinity(
                    harnesses_aff, f"ships_with.hooks[{name}]"
                )
            hooks.append(norm)
        if hooks:
            result["hooks"] = hooks

    # ── permissions ──
    raw_perms = raw.get("permissions")
    if raw_perms is not None:
        if not isinstance(raw_perms, dict):
            _warn(warn, "ships_with.permissions: must be a mapping")
            return None
        perms: dict = {}
        for kind in PERMISSION_KINDS:
            vals = raw_perms.get(kind)
            if vals is None:
                continue
            if not isinstance(vals, list) or not all(
                isinstance(v, str) and v.strip() for v in vals
            ):
                _warn(warn, f"ships_with.permissions.{kind}: must be a list of strings")
                return None
            cleaned: list[str] = []
            for v in vals:
                v = v.strip()
                ok, err = _validate_pattern(v, kind)
                if not ok:
                    _warn(
                        warn,
                        f"ships_with.permissions.{kind}: pattern '{v}' rejected: {err}",
                    )
                    return None
                cleaned.append(v)
            if cleaned:
                perms[kind] = cleaned
        if perms:
            result["permissions"] = perms

    if not result:
        return None
    return result


def declared(skill_cfg: dict) -> dict:
    """Registry accessor: the mirrored `ships_with` block (absent = {})."""
    return (skill_cfg or {}).get("ships_with") or {}


# ─────────────────────────────────────────────────────────────────────────────
# Provisioning plan (D2, verdict = probe ∩ scope rule per A3, trust row A2)
# ─────────────────────────────────────────────────────────────────────────────


def _hook_target(hid: str, scope: Any, operation_context: Any = None) -> Optional[str]:
    if operation_context is not None:
        from skill_hub.domain.permissions.permissions import GlobalScope
        from skill_hub.infrastructure.hooks import hook_adapters

        selection = hook_adapters.select_hook_adapter(operation_context, hid)
        layout = operation_context.layout(hid)
        if selection.adapter is None or layout is None:
            return None
        if isinstance(scope, GlobalScope):
            return str(layout.hook_global_config) if layout.hook_global_config is not None else None
        relative = layout.hook_project_config
        return str(Path(scope.path) / relative) if relative is not None else None

    if hid in ("claude-code", "pi"):
        from skill_hub.infrastructure.hooks import hook_adapters

        return str(hook_adapters.ClaudeHookAdapter()._target(scope, hid))
    if hid == "codex":
        from skill_hub.infrastructure.hooks import hook_adapters

        return str(hook_adapters._codex_config_target())
    return None


def plan_provision(
    skill_name: str,
    project: Optional[str],
    registry: dict,
    *,
    installed: Optional[set] = None,
    capabilities: Optional[dict] = None,
    operation_context: Any = None,
) -> dict:
    """Build the per-harness provisioning plan for a `ships_with` skill.

    Reads the skill's SKILL.md FRONTMATTER directly (A4) — never the registry
    mirror — so a never-synced or hand-edited skill still plans correctly.
    Verdict = probe verdict ∩ scope rule (A3); appends the Codex trust row
    (A2) when a Codex permission row is `will_write` and the project is not
    yet trusted. `capabilities` defaults to `harness_probe.load_cached()` and
    probes only on a cache miss (S5). Never raises: an unresolvable skill,
    project, or frontmatter yields an empty plan rather than an exception —
    including for pi/opencode agent rows, which are reported `unsupported`
    without ever calling `subagents.agents_dir` (which raises for those ids).

    Returns `{"skill", "project", "items": [CompanionItem…], "linked": bool,
    "companions_pending": []}`. `companions_pending` is always empty here —
    it is populated by the CLI layer (W2, Req 3) around this plan, not by the
    planner itself.
    """
    from skill_hub.infrastructure.harnesses import harnesses

    result: dict = {
        "skill": skill_name,
        "project": project,
        "items": [],
        "linked": False,
        "companions_pending": [],
    }

    skills_cfg = (registry.get("skills") or {}).get(skill_name)
    if not isinstance(skills_cfg, dict):
        return result
    block = declared_from_frontmatter(skill_name, registry)
    if not block:
        return result

    # A17 — a `scope: global` skill planned with NO project is planned for
    # the GLOBAL scope for real: hook/permission targets are the actual
    # user-level files (not the "present/absent" placeholder a project-less
    # plan otherwise means for a portable/project-specific skill), and its
    # ledger is `companions_global.<skill>`, not an (absent) project's.
    skill_scope = skills_cfg.get("scope") or "portable"
    is_global_request = project is None and skill_scope == "global"

    projects_cfg = registry.get("projects") or {}
    project_cfg = projects_cfg.get(project) if project else None
    if not isinstance(project_cfg, dict):
        project_cfg = {}

    if operation_context is not None:
        configured = set(registry.get("harnesses_global") or [])
        configured.update(project_cfg.get("harnesses") or [])
        context_ids = set(getattr(operation_context, "installed_harness_ids", ())
                          or getattr(operation_context, "harness_ids", ()))
        effective_for = getattr(operation_context, "effective_harness_ids", None)
        if callable(effective_for):
            effective = sorted(set(effective_for(project_cfg, registry)))
        else:
            effective = sorted(configured & context_ids)
    elif installed is None:
        installed = harnesses.detect_installed()
        effective = sorted(harnesses.resolve_effective(project_cfg, registry, installed))
    else:
        effective = sorted(harnesses.resolve_effective(project_cfg, registry, installed))

    if capabilities is None and operation_context is not None:
        capabilities = dict(getattr(operation_context, "hook_observations", {}) or {})
    elif capabilities is None:
        from skill_hub.infrastructure.harnesses import harness_probe

        cached = harness_probe.load_cached()
        capabilities = (cached or {}).get("harnesses") or {}

    def _cap(hid: str) -> tuple[str, str]:
        if operation_context is not None:
            route_for = getattr(operation_context, "route", None)
            if not callable(route_for):
                return "unsupported", "companions route unavailable"
            try:
                route = route_for(hid, "companions")
            except (OSError, TypeError, ValueError, KeyError):
                return "unsupported", "companions route unavailable"
            if (getattr(route, "status", None) != "shadow"
                    or getattr(route, "mode", None) != "legacy_shadow"):
                return "unsupported", "companions route unavailable"
        entry = capabilities.get(hid) if capabilities else None
        if entry is not None:
            if isinstance(entry, Mapping):
                return entry.get("verdict", "unsupported"), entry.get("reason", "")
            return entry.verdict, entry.reason
        from skill_hub.infrastructure.harnesses import harness_probe

        if operation_context is not None:
            # Legacy-shadow contexts preserve the host planner's historical
            # behavior when no capability observation was captured. The route
            # remains explicitly shadow and never claims verified support.
            return "supported", "legacy_shadow"
        cap = harness_probe.probe_harness(hid, installed=installed)
        return cap.verdict, cap.reason

    def _agent_route_capable(hid: str) -> bool:
        if operation_context is not None:
            layout = operation_context.layout(hid)
            route_for = getattr(operation_context, "route", None)
            if not callable(route_for):
                return False
            try:
                route = route_for(hid, "subagents")
            except (OSError, TypeError, ValueError, KeyError):
                return False
            return (
                layout is not None
                and getattr(layout, "agents_dir", None) is not None
                and getattr(route, "status", None) == "shadow"
                and getattr(route, "mode", None) == "legacy_shadow"
            )
        harness = harnesses.HARNESSES.get(hid)
        return harness is not None and harness.agents_dir is not None

    from skill_hub.domain.permissions import permissions as perms_mod

    if project:
        path_raw = project_cfg.get("path")
        proj_path = str(hub_core.expand(str(path_raw))) if path_raw else ""
        scope: Any = perms_mod.ProjectScope(name=project, path=proj_path)
    else:
        scope = perms_mod.GlobalScope()

    if project:
        ledger_ent = ledger_entry(project_cfg, skill_name)
    elif is_global_request:
        ledger_ent = global_ledger(registry).get(skill_name) or {}
    else:
        ledger_ent = {}

    items: list[dict] = []

    # ── Agents ──
    declared_agents = block.get("agents") or []
    if declared_agents:
        from skill_hub.infrastructure.harnesses import subagents

        agent_capable_effective = [
            hid for hid in effective if _agent_route_capable(hid)
        ]
        result["linked"] = len(agent_capable_effective) >= 2
        for agent_name in declared_agents:
            for hid in effective:
                if not _agent_route_capable(hid):
                    items.append(
                        {
                            "kind": "agent",
                            "name": agent_name,
                            "harness": hid,
                            "target": None,
                            "verdict": "unsupported",
                            "reason": "no sub-agent definitions",
                            "scope": "user",
                        }
                    )
                    continue
                adir = subagents.agents_dir("user", None, registry, hid,
                                            context=operation_context)
                if adir is None:
                    continue
                target = str(adir / f"{agent_name}.md")
                exists = (
                    subagents._find_agent_file(agent_name, "user", None, registry, hid,
                                               context=operation_context)
                    is not None
                )
                # C-1: "claimed" is ANY ledger entry for this skill, on ANY
                # project — not just this project's own. A user-scope agent is
                # shared by name across every project that equips the same
                # skill (D4), so the SECOND project to provision it must see
                # the already-written file as `already_present`, never a fresh
                # `will_write` (which would collide inside `subagents.save_agent`,
                # since a re-provision always passes `original_name=None`).
                claimed = agent_name in (ledger_ent.get("agents") or []) or (
                    agent_refcount(agent_name, registry) > 0
                )
                verdict = "already_present" if exists and claimed else "will_write"
                items.append(
                    {
                        "kind": "agent",
                        "name": agent_name,
                        "harness": hid,
                        "target": target,
                        "verdict": verdict,
                        "scope": "user",
                    }
                )

    # ── Hooks ──
    from skill_hub.domain.diagnostics import tool_catalog

    ledger_hooks = ledger_ent.get("hooks") or []
    # A17: with a real project, "already attached" reads that project's own
    # `hooks:` list; for a `scope: global` skill planned with no project it
    # reads `hooks_global` instead (the real global attach list); any other
    # project-less plan (a portable/project skill's present/absent view)
    # never has a real attach list to consult.
    if project:
        project_attached_hooks = project_cfg.get("hooks") or []
    elif is_global_request:
        project_attached_hooks = registry.get("hooks_global") or []
    else:
        project_attached_hooks = []

    all_hook_defs: Optional[dict] = None
    for hook_decl in block.get("hooks") or []:
        # A18/D9 — a `{"ref": r, "name": r}` entry attaches an EXISTING hooks-
        # library definition as-is; event/harness-affinity come from THAT
        # definition (never carried in the ships_with block itself); a
        # missing library entry can't be planned per-harness at all, so it
        # reports once per effective harness rather than crashing on the
        # inline-only fields below.
        if "ref" in hook_decl:
            if all_hook_defs is None:
                from skill_hub.domain.hooks import hooks_model

                all_hook_defs = hooks_model.all_definitions(registry)
            resolved = all_hook_defs.get(hook_decl["ref"])
            if resolved is None:
                for hid in effective:
                    items.append(
                        {
                            "kind": "hook",
                            "name": hook_decl["name"],
                            "harness": hid,
                            "activation": "always",
                            "target": None,
                            "verdict": "unsupported",
                            "reason": (
                                f"referenced hook definition '{hook_decl['ref']}' not found"
                            ),
                        }
                    )
                continue
            event = resolved.event
            aff = resolved.harnesses
            activation = "always"  # a ref carries no activation of its own
        else:
            event = hook_decl["event"]
            aff = hook_decl.get("harnesses")
            activation = hook_decl["activation"]

        target_harnesses = [hid for hid in effective if aff is None or hid in aff]
        for hid in target_harnesses:
            if hid == "codex" and project:
                items.append(
                    {
                        "kind": "hook",
                        "name": hook_decl["name"],
                        "harness": "codex",
                        "target": "<repo>",
                        "verdict": "unsupported",
                        "reason": _CODEX_PROJECT_HOOK_REASON,
                        "activation": activation,
                    }
                )
                continue
            item: dict = {
                "kind": "hook",
                "name": hook_decl["name"],
                "harness": hid,
                "activation": activation,
                # A17: a `scope: global` skill planned with no project writes
                # a REAL global-scope target; any other project-less plan
                # only ever writes at PROJECT scope in this flow — never claim
                # a global file would be touched (the GlobalScope() above is
                # a rule/trust computation aid there, not a real write
                # target).
                "target": _hook_target(hid, scope, operation_context) if (project or is_global_request) else None,
            }
            # W-3: verdict = probe verdict ∩ scope rule ∩ EVENT CATALOGUE
            # (A3) — a harness that has never heard of this event cannot
            # write the hook regardless of what the probe says.
            if not tool_catalog.event_supported(event, hid):
                item["verdict"] = "unsupported"
                item["reason"] = f"{hid} does not support the {event} hook event"
                items.append(item)
                continue
            if operation_context is not None:
                from skill_hub.infrastructure.hooks import hook_adapters

                if hook_adapters.select_hook_adapter(operation_context, hid).adapter is None:
                    item.update(verdict="unsupported", reason="hook route unavailable", target=None)
                    items.append(item)
                    continue
            verdict, reason = _cap(hid)
            if verdict != "supported":
                item["verdict"] = verdict
                item["reason"] = reason
            else:
                # W-1: already attached + already claimed by THIS scope's
                # ledger → nothing to do, never re-gate on a plain re-run of
                # `hub enable` with no flag.
                already_present = (
                    hook_decl["name"] in ledger_hooks
                    and hook_decl["name"] in project_attached_hooks
                )
                item["verdict"] = "already_present" if already_present else "will_write"
            items.append(item)

    # ── Permissions (+ trust row, A2) ──
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    if project:
        own = perms_mod.resolve_project_own(project_cfg)
    elif is_global_request:
        # A17: the real global rule bucket, not the (absent) project's own.
        own = perms_mod.NormalizedPermissions.from_block(registry.get("permissions_global") or {})
    else:
        own = perms_mod.NormalizedPermissions()
    own_rules = own.allow + own.deny + own.ask
    codex_will_write = False
    for rule_kind in PERMISSION_KINDS:
        for pattern in (block.get("permissions") or {}).get(rule_kind) or []:
            for hid in effective:
                if operation_context is None:
                    h = harnesses.HARNESSES.get(hid)
                    adapter = pa.get_adapter(h.permission_adapter_key) if h is not None else None
                else:
                    adapter = pa.select_permission_adapter(operation_context, hid).adapter
                if adapter is None:
                    if operation_context is not None:
                        items.append({
                            "kind": "permission", "name": pattern, "rule_kind": rule_kind,
                            "harness": hid, "target": None, "verdict": "unsupported",
                            "reason": "permission route unavailable",
                        })
                    continue
                rule = perms_mod.Rule(pattern=pattern, kind=rule_kind)
                vres = pa.validate_rule_for_harness(
                    rule,
                    hid,
                    operation_context=operation_context,
                    mode="operation" if operation_context is not None else "baseline",
                )
                item = {
                    "kind": "permission",
                    "name": pattern,
                    "rule_kind": rule_kind,
                    "harness": hid,
                }
                if not vres.ok:
                    item["verdict"] = "unsupported"
                    item["reason"] = vres.error
                    item["target"] = None
                else:
                    already = any(
                        r.pattern == pattern and r.kind == rule_kind for r in own_rules
                    )
                    item["verdict"] = "already_present" if already else "will_write"
                    if not project and not is_global_request:
                        # W-4: same posture as the hook target above — a
                        # permission rule only ever lands in a PROJECT file
                        # (or, for a `scope: global` skill, the real global
                        # file below — A17).
                        item["target"] = None
                    elif hid == "codex":
                        # `rules_file` is Codex-adapter-specific, not part of
                        # the base `PermissionAdapter` Protocol — this branch
                        # only reaches a real `CodexPermissionAdapter` at
                        # runtime (guarded by `hid == "codex"` above).
                        item["target"] = str(adapter.rules_file(scope))  # type: ignore[attr-defined]
                        if item["verdict"] == "will_write":
                            codex_will_write = True
                    else:
                        item["target"] = str(adapter.target_files(scope, hid))  # type: ignore[attr-defined]
                items.append(item)

    if codex_will_write and project and "codex" in effective:
        codex_adapter = (
            pa.select_permission_adapter(operation_context, "codex").adapter
            if operation_context is not None else pa.get_adapter("codex")
        )
        trusted = False
        codex_target = "~/.codex/config.toml"
        if codex_adapter is not None:
            existing = codex_adapter.discover_existing(scope, "codex")
            trusted = bool(existing.project_trust)
            codex_target = str(codex_adapter.target_files(scope, "codex"))  # type: ignore[attr-defined]
        if not trusted:
            items.append(
                {
                    "kind": "trust",
                    "name": "trust_level",
                    "harness": "codex",
                    "target": codex_target,
                    "verdict": "will_write",
                    "reason": _CODEX_TRUST_REASON,
                }
            )

    result["items"] = items
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Agent renderer (A10)
# ─────────────────────────────────────────────────────────────────────────────


def render_agent_payload(
    skill_name: str, agent_name: str, harness_id: str, registry: dict, *, rerender: bool = False
) -> dict:
    """Build a `subagents.save_agent`-shaped payload (`scope="user"`) for
    `<skill>/agents/<agent_name>.md`, rendering the declared TIER to a
    per-harness model via `TIER_MODELS`, overridden by optional canonical
    `harnesses` frontmatter. Adds a top-level `warnings` list for fields the
    target harness drops (Codex has no `tools` key).

    `original_name` is `None` (the default; a brand-new agent write, refused
    by `subagents.save_agent` if a same-named file already exists and isn't
    ours to overwrite) UNLESS `rerender=True` — the `ships_with_reconcile`
    `AGENT_RERENDER` op's path (W1), which is deliberately an IN-PLACE edit
    of an existing, hub-written file: passing the agent's own name as
    `original_name` makes `save_agent` treat it as "editing this file"
    (backup-first overwrite) rather than "creating a new one" (collision
    refusal)."""
    skills_cfg = (registry.get("skills") or {}).get(skill_name) or {}
    skill_dir = skill_meta.skill_source(skills_cfg)
    agent_file = skill_dir / "agents" / f"{agent_name}.md"

    from skill_hub.infrastructure.harnesses import subagents

    doc = subagents.parse_agent(agent_file.read_text())
    fm = doc["frontmatter"]
    body = doc["body"]

    tier = str(fm.get("tier") or "worker").strip()
    if tier not in TIERS:
        tier = "worker"
    model_cfg = dict(TIER_MODELS.get(tier, TIER_MODELS["worker"]).get(harness_id, {}))

    # The skill-owned source is the authority for per-harness overrides.  An
    # omitted field keeps the tier default; an explicitly empty value means
    # inherit from the session and therefore suppresses that default.
    raw_harnesses = fm.get("harnesses")
    if isinstance(raw_harnesses, Mapping):
        override = raw_harnesses.get(harness_id)
        if isinstance(override, Mapping):
            for field in ("model", "model_reasoning_effort"):
                if field in override and isinstance(override[field], str):
                    model_cfg[field] = override[field]

    warnings: list[dict] = []
    safe: dict = {
        "name": str(fm.get("name") or agent_name).strip(),
        "description": "" if fm.get("description") is None else str(fm.get("description")),
    }
    if model_cfg.get("model"):
        safe["model"] = model_cfg["model"]

    if harness_id == "claude-code":
        if model_cfg.get("effort"):
            safe["effort"] = model_cfg["effort"]

    if harness_id == "codex":
        if model_cfg.get("model_reasoning_effort"):
            safe["model_reasoning_effort"] = model_cfg["model_reasoning_effort"]
        if fm.get("tools"):
            warnings.append(
                {
                    "field": "tools",
                    "level": "warn",
                    "message": "codex has no `tools` key — dropped",
                    "value": "tools",
                }
            )
    else:
        tools = fm.get("tools")
        if tools:
            safe["tools"] = list(tools) if isinstance(tools, list) else [str(tools)]

    return {
        "harness": harness_id,
        "scope": "user",
        "project": None,
        "original_name": agent_name if rerender else None,
        "safe": safe,
        "advanced_yaml": "",
        "body": body,
        "warnings": warnings,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Ledger accessors (D4 — `projects.<n>.companions`)
# ─────────────────────────────────────────────────────────────────────────────


def ledger(project_cfg: dict) -> dict:
    """`projects.<n>.companions` — never None."""
    if not isinstance(project_cfg, dict):
        return {}
    return project_cfg.get("companions") or {}


def ledger_entry(project_cfg: dict, skill: str) -> dict:
    return ledger(project_cfg).get(skill) or {}


def set_ledger_entry(project_cfg: dict, skill: str, entry: dict) -> None:
    comp = project_cfg.setdefault("companions", {})
    comp[skill] = entry


def drop_ledger_entry(project_cfg: dict, skill: str) -> None:
    comp = project_cfg.get("companions")
    if not comp:
        return
    comp.pop(skill, None)
    if not comp:
        project_cfg.pop("companions", None)


# ── A17/C3: global-scope ledger (`companions_global.<skill>`) + one scope
# iterator over BOTH the global ledger and every project's ledger.
# ─────────────────────────────────────────────────────────────────────────────


def global_ledger(registry: dict) -> dict:
    """`companions_global` — never None. The global-scope twin of `ledger()`,
    for `scope: global` skills provisioned with no `--project` (A17)."""
    if not isinstance(registry, dict):
        return {}
    return registry.get("companions_global") or {}


def ledger_container(registry: dict, project: Optional[str]) -> dict:
    """The companions ledger dict for ONE scope: `global_ledger(registry)`
    when `project` is `None`, else `ledger(projects[project])` — `{}` for an
    unknown project. Read-only; callers wanting to MUTATE the global scope use
    `set_global_ledger_entry`/`drop_global_ledger_entry` below (mirroring the
    project-scoped `set_ledger_entry`/`drop_ledger_entry`, which already take
    `project_cfg` directly)."""
    if project is None:
        return global_ledger(registry)
    proj_cfg = (registry.get("projects") or {}).get(project)
    return ledger(proj_cfg) if isinstance(proj_cfg, dict) else {}


def set_global_ledger_entry(registry: dict, skill: str, entry: dict) -> None:
    comp = registry.setdefault("companions_global", {})
    if not isinstance(comp, dict):
        comp = {}
        registry["companions_global"] = comp
    comp[skill] = entry


def drop_global_ledger_entry(registry: dict, skill: str) -> None:
    comp = registry.get("companions_global")
    if not comp:
        return
    comp.pop(skill, None)
    if not comp:
        registry.pop("companions_global", None)


# C3 — the scope key for the global ledger is the literal string "global"
# (never `None`): a project cannot be named "global" (it would collide with
# this sentinel), and every op/report keys scopes by this string uniformly so
# a `(scope, skill)` pair is always hashable/comparable the same way.
GLOBAL_SCOPE = "global"


def ledger_scopes(registry: dict) -> list[tuple[str, dict]]:
    """C3 — one iterator over EVERY companions ledger: `(GLOBAL_SCOPE,
    companions_global)` plus `(project_name, projects[p].companions)` for
    every registered project. Backs `agent_refcount`,
    `hub_cli/skill.py::_companion_claim_count` and `plan_provision`'s `claimed`
    check, so a project's stale-removal can no longer delete a user-scope
    agent file the GLOBAL ledger (or another project's ledger) still claims.

    The scope key is ALWAYS a real `str` — `GLOBAL_SCOPE` ("global") for the
    global ledger, a project name for every other entry — never `None`; a
    project-scoped caller passes `None` for "no project" elsewhere in this
    module, but that is a DIFFERENT axis from this iterator's scope key."""
    scopes: list[tuple[str, dict]] = [(GLOBAL_SCOPE, global_ledger(registry))]
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        if isinstance(proj_cfg, dict):
            scopes.append((proj_name, ledger(proj_cfg)))
    return scopes


def hook_state(entry: dict, name: str) -> dict:
    """`entry.hook_state.<name>` — never None. `{}` for a hook the ledger
    hasn't recorded a v2 state for yet (a not-yet-backfilled v1 entry, or a
    name the ledger doesn't claim at all)."""
    return ((entry or {}).get("hook_state") or {}).get(name) or {}


def agent_state(entry: dict, name: str) -> dict:
    """`entry.agent_state.<name>` — never None (see `hook_state`)."""
    return ((entry or {}).get("agent_state") or {}).get(name) or {}


def declared_from_frontmatter(skill_name: str, registry: dict) -> Optional[dict]:
    """The declared `ships_with:` block, read from the SKILL.md FRONTMATTER —
    never the registry mirror (A4) — for a resolvable `claude-skill`. Returns
    `None` for an unknown skill, one with no `source:`, or an absent/malformed
    block. Shared by `plan_provision` and `ships_with_reconcile.plan_reconcile`
    so both always agree on what "declared" means."""
    skills_cfg = (registry.get("skills") or {}).get(skill_name)
    if not isinstance(skills_cfg, dict):
        return None
    raw_source = skills_cfg.get("source")
    if not isinstance(raw_source, str) or not raw_source.strip():
        return None
    skill_dir = skill_meta.skill_source(skills_cfg)
    meta = skill_meta.parse_skill_frontmatter(skill_dir / "SKILL.md") or {}
    return normalize_block(meta.get("ships_with"), skill_dir)


# R22: `set_declared_block` (a thin `render_frontmatter_block` wrapper) had
# no caller anywhere in the tree and no test — dead code, removed. The `set`
# CLI verb (`hub_cli/companions.py`) writes the `ships_with:` key directly
# through `skill_meta.render_frontmatter_block`.


def agent_refcount(agent: str, registry: dict, *, exclude: Optional[tuple[str, str]] = None) -> int:
    """How many (scope, skill) ledger entries — other than `exclude` — still
    name `agent`. `scope` is a project name OR `GLOBAL_SCOPE` (C3, via
    `ledger_scopes`) — so a project can no longer delete a user-scope agent
    file the GLOBAL ledger, or another project's ledger, still claims."""
    count = 0
    for scope, container in ledger_scopes(registry):
        for skill_name, entry in container.items():
            if exclude is not None and (scope, skill_name) == exclude:
                continue
            if agent in ((entry or {}).get("agents") or []):
                count += 1
    return count


def _resolve_project_skills(proj_cfg: dict, registry: dict) -> list[str]:
    """Local mirror of `hub.resolve_project_skills` (registry-only logic; a
    leaf cannot import `hub.py`). Kept small and self-contained on purpose —
    a drift here is caught by `tests/test_ships_with_doctor.py` (W3)."""
    bundles_cfg = registry.get("bundles") or {}
    global_bundle_skills: list[str] = []
    for cfg in bundles_cfg.values():
        if hub_core.bundle_scope(cfg) == "global":
            global_bundle_skills.extend(cfg.get("skills", []))
    project_bundle_skills: list[str] = []
    for b in proj_cfg.get("bundles", []) or []:
        project_bundle_skills.extend((bundles_cfg.get(b) or {}).get("skills", []))
    all_skills = global_bundle_skills + project_bundle_skills + (proj_cfg.get("enabled") or [])
    return list(dict.fromkeys(all_skills))


def orphans(registry: dict) -> list[dict]:
    """Ledger entries whose skill left the project's active set (W2 — a
    bundle-only path, no `disable` ever ran), plus ledger ITEMS absent from
    the skill's CURRENT `ships_with` declaration (W3 — an upstream drop).
    Read-only; never mutates the registry."""
    found: list[dict] = []
    projects_cfg = registry.get("projects") or {}
    skills_cfg = registry.get("skills") or {}
    for proj_name, proj_cfg in projects_cfg.items():
        if not isinstance(proj_cfg, dict):
            continue
        active = set(_resolve_project_skills(proj_cfg, registry))
        for skill_name, entry in ledger(proj_cfg).items():
            entry = entry or {}
            if skill_name not in active:
                found.append(
                    {
                        "project": proj_name,
                        "skill": skill_name,
                        "reason": "skill_not_active",
                        "entry": entry,
                    }
                )
                continue
            skill_cfg = skills_cfg.get(skill_name)
            current = declared(skill_cfg) if isinstance(skill_cfg, dict) else {}
            declared_hook_names = {
                h.get("name") for h in (current.get("hooks") or []) if isinstance(h, dict)
            }
            declared_agent_names = set(current.get("agents") or [])
            for name in entry.get("hooks") or []:
                if name not in declared_hook_names:
                    found.append(
                        {
                            "project": proj_name,
                            "skill": skill_name,
                            "reason": "declaration_dropped",
                            "kind": "hook",
                            "name": name,
                        }
                    )
            for name in entry.get("agents") or []:
                if name not in declared_agent_names:
                    found.append(
                        {
                            "project": proj_name,
                            "skill": skill_name,
                            "reason": "declaration_dropped",
                            "kind": "agent",
                            "name": name,
                        }
                    )
    return found


def pending(registry: dict) -> list[dict]:
    """Active `ships_with` skills with no ledger entry on a project — reached
    via a bundle (W2, no consent flow) or an equipped-via-refs skill-only
    companion (Req 3)."""
    found: list[dict] = []
    projects_cfg = registry.get("projects") or {}
    skills_cfg = registry.get("skills") or {}
    for proj_name, proj_cfg in projects_cfg.items():
        if not isinstance(proj_cfg, dict):
            continue
        active = _resolve_project_skills(proj_cfg, registry)
        comp = ledger(proj_cfg)
        for skill_name in active:
            skill_cfg = skills_cfg.get(skill_name)
            if not isinstance(skill_cfg, dict) or not declared(skill_cfg):
                continue
            if skill_name not in comp:
                found.append({"project": proj_name, "skill": skill_name})
    return found
