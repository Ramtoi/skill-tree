#!/usr/bin/env python3
"""
subagents — sub-agent management, in place, per harness.

Claude Code sub-agents are Markdown files with YAML frontmatter living at:
  - user scope:    ~/.claude/agents/*.md
  - project scope: <project_path>/.claude/agents/*.md

Codex custom agents are TOML files (see subagent_codex.py) at:
  - user scope:    $CODEX_HOME/agents/*.toml  (+ *.toml.disabled — hub disable)
  - project scope: NOT supported yet (trust-gated; ships in a later wave)

Identity is the `name` field, NOT the filename. The `body` contract slot is the
agent's system prompt (Claude: the markdown body; Codex: `developer_instructions`).
Disabling: Claude = `Agent(<name>)` in the scope settings.json `permissions.deny`;
Codex = renaming the file out of the `*.toml` glob (suffix is the sole state).

Every public function takes a trailing `harness_id` (default "claude-code" —
the shipped Claude contract is byte-identical when defaulted). This module is
the single validator + serializer (design D1–D5 + cross-harness-subagents);
`hub.py` only wires the CLI and Rust marshals subprocess calls.

The Claude home (~/.claude) is resolvable via $SKILL_HUB_CLAUDE_HOME and the
Codex home via $CODEX_HOME so tests can inject tmp roots.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

import yaml

# ─────────────────────────────────────────────────────────────────────────────
# Constants — the safe/advanced split, enums, known tools (design D2/D3)
# ─────────────────────────────────────────────────────────────────────────────

# Safe fields are guided-form-editable; everything else in frontmatter is
# "advanced" and round-trips verbatim through `advanced_yaml`.
SAFE_KEYS = ["name", "description", "model", "tools", "disallowedTools", "skills", "color"]
SAFE_KEY_SET = set(SAFE_KEYS)

# Canonical key order on serialize (advanced keys appended afterwards, in their
# own original order). `tools`/`disallowedTools` share the same slot.
FRONTMATTER_ORDER = ["name", "description", "model", "tools", "disallowedTools", "skills", "color"]

VALID_MODELS = {"", "inherit", "sonnet", "opus", "haiku", "fable"}
MODEL_ID_RE = re.compile(r"^claude-[a-z0-9.\-]+$")

VALID_COLORS = {"red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan", ""}

SLUG_RE = re.compile(r"^[a-z0-9-]+$")

# Known built-in tool tokens. Unknown tokens are WARN, never error (new tools
# appear). `Agent(...)` and `mcp__*` patterns are also accepted.
KNOWN_TOOLS = {
    # Core file/exec/search
    "Read", "Write", "Edit", "MultiEdit", "Bash", "BashOutput", "KillShell",
    "Glob", "Grep", "NotebookEdit", "NotebookRead",
    # Web + skills + delegation
    "WebFetch", "WebSearch", "Skill", "SlashCommand", "Agent", "Task", "TodoWrite",
    # Task/team/messaging surface (real tools, commonly listed in agent files)
    "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "TaskOutput", "TaskStop",
    "TeamCreate", "TeamDelete", "SendMessage",
    # Planning / flow / tooling
    "EnterPlanMode", "ExitPlanMode", "ToolSearch", "Monitor", "ScheduleWakeup",
    "PushNotification", "AskUserQuestion", "Artifact",
    # Worktrees + MCP resource tools
    "EnterWorktree", "ExitWorktree", "WaitForMcpServers",
    "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
    # Scheduling / misc built-ins
    "CronCreate", "CronDelete", "CronList", "DesignSync", "RemoteTrigger", "LSP",
}
_AGENT_TOOL_RE = re.compile(r"^Agent\(.+\)$")
_MCP_TOOL_RE = re.compile(r"^mcp__.+$")

# Built-in agents surfaced read-only (disable-toggle only; no file).
BUILTIN_AGENTS = [
    {"name": "general-purpose", "model": "inherit",
     "description": "General-purpose agent for researching complex questions and multi-step tasks."},
    {"name": "Explore", "model": "inherit",
     "description": "Read-only search agent for broad fan-out searches."},
    {"name": "Plan", "model": "inherit",
     "description": "Software architect agent for designing implementation plans."},
]


# ─────────────────────────────────────────────────────────────────────────────
# Path resolution
# ─────────────────────────────────────────────────────────────────────────────

def claude_home() -> Path:
    """Root of the Claude config dir (~/.claude), overridable for tests."""
    env = os.environ.get("SKILL_HUB_CLAUDE_HOME", "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".claude"


def _validate_harness(harness_id: Optional[str]) -> str:
    """Normalize + validate a harness id against the agent capability in the
    harness registry. Raises ValueError for unknown/unsupported harnesses."""
    hid = (harness_id or "claude-code").strip() or "claude-code"
    import harnesses
    h = harnesses.HARNESSES.get(hid)
    if h is None:
        raise ValueError(f"unknown harness '{hid}'")
    if h.agents_dir is None:
        raise ValueError(f"harness '{hid}' does not support sub-agent definitions")
    return hid


def _codex():
    import subagent_codex
    return subagent_codex


def _project_path(project: Optional[str], registry: Optional[dict]) -> Path:
    if not project:
        raise ValueError("project scope requires --project NAME")
    reg = registry or {}
    projects = reg.get("projects") or {}
    cfg = projects.get(project)
    if not isinstance(cfg, dict) or not cfg.get("path"):
        raise ValueError(f"unknown project '{project}' (no path in registry)")
    return Path(str(cfg["path"])).expanduser()


def agents_dir(scope: str, project: Optional[str] = None, registry: Optional[dict] = None,
               harness_id: str = "claude-code") -> Path:
    """Resolve the agents directory for a scope + harness."""
    hid = _validate_harness(harness_id)
    if hid == "codex":
        if scope == "user":
            return _codex().codex_home() / "agents"
        if scope == "project":
            raise ValueError(
                "codex project-scope agents are not supported yet (ships in a later wave)")
        raise ValueError(f"invalid scope '{scope}' (expected user|project)")
    if scope == "user":
        return claude_home() / "agents"
    if scope == "project":
        return _project_path(project, registry) / ".claude" / "agents"
    raise ValueError(f"invalid scope '{scope}' (expected user|project)")


def settings_path(scope: str, project: Optional[str] = None, registry: Optional[dict] = None) -> Path:
    """Resolve the settings.json path for a scope (where deny entries live)."""
    if scope == "user":
        return claude_home() / "settings.json"
    if scope == "project":
        return _project_path(project, registry) / ".claude" / "settings.json"
    raise ValueError(f"invalid scope '{scope}' (expected user|project)")


def _skills_dir(scope: str, project: Optional[str] = None, registry: Optional[dict] = None,
                harness_id: str = "claude-code") -> Path:
    """Where attached skills resolve from for this scope + harness."""
    if harness_id == "codex":
        if scope == "user":
            return _codex().codex_skills_root()
        raise ValueError(
            "codex project-scope agents are not supported yet (ships in a later wave)")
    if scope == "user":
        return claude_home() / "skills"
    return _project_path(project, registry) / ".claude" / "skills"


# ─────────────────────────────────────────────────────────────────────────────
# Frontmatter parse / serialize (round-trip fidelity, design D5)
# ─────────────────────────────────────────────────────────────────────────────

class ParseError(Exception):
    pass


def _split_frontmatter(text: str) -> tuple[str, str]:
    """Return (frontmatter_text, body) by locating the opening + closing `---`
    fence lines. Splits on fence LINES (not bare `---` substrings) so a body or
    value containing `---` does not corrupt the split.
    """
    lines = text.splitlines(keepends=True)
    # Opening fence: first non-empty line must be `---`.
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if i >= len(lines) or lines[i].strip() != "---":
        raise ParseError("missing frontmatter fence")
    start = i + 1
    # Closing fence: next line that is exactly `---`.
    for j in range(start, len(lines)):
        if lines[j].strip() == "---":
            fm = "".join(lines[start:j])
            body = "".join(lines[j + 1:])
            return fm, body
    raise ParseError("incomplete frontmatter fence")


def _lenient_frontmatter(fm_text: str) -> dict:
    """Lenient line-based parser for Claude Code's flat agent frontmatter.

    Real CC agent files use unquoted single-line `key: value` pairs whose value
    can contain `: ` (e.g. `description: ... Context: User ...`), which strict
    PyYAML rejects. Each top-level `^key: ` line starts a new key; everything
    after the first `: ` is the verbatim scalar. Continuation lines (indented or
    starting with `-`) append to the current key's value. Preserves key order.
    """
    meta: dict = {}
    key_re = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t](.*))?$")
    cur_key: Optional[str] = None
    for raw in fm_text.splitlines():
        m = key_re.match(raw)
        if m and not raw.startswith((" ", "\t", "-")):
            cur_key = m.group(1)
            meta[cur_key] = m.group(2) if m.group(2) is not None else ""
        elif cur_key is not None:
            # Continuation / list-ish line — append raw to the current value.
            meta[cur_key] = (str(meta[cur_key]) + "\n" + raw).strip("\n")
    return meta


def parse_agent(text: str) -> dict:
    """Parse an agent file's content into {frontmatter: dict, body: str}.

    Preserves frontmatter key order. Tries strict PyYAML first; on a YAML error
    falls back to the lenient line parser so real Claude Code files (unquoted
    descriptions with embedded `: `) round-trip faithfully.
    """
    fm_text, body = _split_frontmatter(text)
    try:
        meta = yaml.safe_load(fm_text)
        if meta is None:
            meta = {}
        if not isinstance(meta, dict):
            raise ParseError("frontmatter is not a mapping")
    except yaml.YAMLError:
        meta = _lenient_frontmatter(fm_text)
        if not meta:
            raise ParseError("frontmatter is empty or unparseable")
    return {"frontmatter": meta, "body": body}


def serialize_agent(frontmatter: dict, body: str) -> str:
    """Serialize {frontmatter, body} back to file text with canonical key order.

    Safe keys first in FRONTMATTER_ORDER, then advanced keys in their existing
    order. Dump is sort_keys=False / allow_unicode=True / wide width.
    """
    ordered: dict = {}
    for key in FRONTMATTER_ORDER:
        if key in frontmatter:
            ordered[key] = frontmatter[key]
    for key, val in frontmatter.items():
        if key not in ordered:
            ordered[key] = val
    fm = yaml.safe_dump(
        ordered,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=4096,
    )
    # yaml.safe_dump ends with a trailing newline already.
    return f"---\n{fm}---\n{body}"


def normalize_body(body: str) -> str:
    """Round-trip-stable body normalization: ensure a trailing newline."""
    if body and not body.endswith("\n"):
        return body + "\n"
    return body


# ─────────────────────────────────────────────────────────────────────────────
# tools_mode / safe-field derivation (design D2)
# ─────────────────────────────────────────────────────────────────────────────

def _as_tool_list(value: Any) -> list[str]:
    """Accept CSV string or YAML list; return a clean token list."""
    if value is None:
        return []
    if isinstance(value, str):
        return [t.strip() for t in value.split(",") if t.strip()]
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for item in value:
            if item is None:
                continue
            s = str(item).strip()
            if s:
                out.append(s)
        return out
    return [str(value).strip()]


def derive_tools(frontmatter: dict) -> dict:
    """Return {tools_mode, tools[], disallowed_tools[], allow_skill_discovery}."""
    has_tools = "tools" in frontmatter and frontmatter.get("tools") not in (None, "")
    has_disallowed = (
        "disallowedTools" in frontmatter
        and frontmatter.get("disallowedTools") not in (None, "")
    )
    tools = _as_tool_list(frontmatter.get("tools"))
    disallowed = _as_tool_list(frontmatter.get("disallowedTools"))

    if has_tools:
        tools_mode = "allowlist"
    elif has_disallowed:
        tools_mode = "denylist"
    else:
        tools_mode = "all"

    # allow_skill_discovery: can the Skill tool be reached in this mode?
    if tools_mode == "all":
        allow_skill_discovery = True
    elif tools_mode == "allowlist":
        allow_skill_discovery = "Skill" in tools
    else:  # denylist
        allow_skill_discovery = "Skill" not in disallowed

    return {
        "tools_mode": tools_mode,
        "tools": tools,
        "disallowed_tools": disallowed,
        "allow_skill_discovery": allow_skill_discovery,
    }


def split_safe_advanced(frontmatter: dict) -> tuple[dict, str]:
    """Split frontmatter into (safe-dict-as-contract, advanced_yaml-string)."""
    derived = derive_tools(frontmatter)
    safe = {
        "name": str(frontmatter.get("name") or ""),
        # Coerce to str: a YAML scalar like `description: 123` would otherwise emit
        # a JSON number and break the Rust DTO (String) deserialization for the
        # whole list/show response.
        "description": "" if frontmatter.get("description") is None else str(frontmatter.get("description")),
        "model": str(frontmatter.get("model") or ""),
        "tools_mode": derived["tools_mode"],
        "tools": derived["tools"],
        "disallowed_tools": derived["disallowed_tools"],
        "allow_skill_discovery": derived["allow_skill_discovery"],
        "skills": _as_tool_list(frontmatter.get("skills")),
        "color": str(frontmatter.get("color") or ""),
    }
    advanced = {k: v for k, v in frontmatter.items() if k not in SAFE_KEY_SET}
    if advanced:
        advanced_yaml = yaml.safe_dump(
            advanced, sort_keys=False, allow_unicode=True,
            default_flow_style=False, width=4096,
        )
    else:
        advanced_yaml = ""
    return safe, advanced_yaml


# ─────────────────────────────────────────────────────────────────────────────
# Build frontmatter from a save payload (safe + advanced merge, design D2)
# ─────────────────────────────────────────────────────────────────────────────

def build_frontmatter(safe: dict, advanced_yaml: str) -> tuple[dict, list[dict]]:
    """Merge a save payload's `safe` block + parsed `advanced_yaml` into one
    order-preserving frontmatter dict. Advanced keys can NOT override a safe key.

    Returns (frontmatter, warnings). A non-mapping advanced_yaml is reported as a
    blocking error here via warnings (level=error); the caller blocks on it.
    """
    warnings: list[dict] = []
    fm: dict = {}

    name = str(safe.get("name") or "").strip()
    description = safe.get("description")
    model = str(safe.get("model") or "").strip()
    color = str(safe.get("color") or "").strip()
    skills = [str(s).strip() for s in (safe.get("skills") or []) if str(s).strip()]
    tools_mode = safe.get("tools_mode") or "all"
    tools = [str(t).strip() for t in (safe.get("tools") or []) if str(t).strip()]
    disallowed = [str(t).strip() for t in (safe.get("disallowed_tools") or []) if str(t).strip()]
    allow_skill_discovery = safe.get("allow_skill_discovery", True)

    # Skill-discovery toggle controls reachability of the Skill tool (D2/spec).
    if tools_mode == "allowlist":
        if allow_skill_discovery and "Skill" not in tools:
            tools = tools + ["Skill"]
        if not allow_skill_discovery and "Skill" in tools:
            tools = [t for t in tools if t != "Skill"]
    elif tools_mode == "denylist":
        if not allow_skill_discovery and "Skill" not in disallowed:
            disallowed = disallowed + ["Skill"]
        if allow_skill_discovery and "Skill" in disallowed:
            disallowed = [t for t in disallowed if t != "Skill"]

    fm["name"] = name
    fm["description"] = description if description is not None else ""
    if model:
        fm["model"] = model
    if tools_mode == "allowlist":
        fm["tools"] = ", ".join(tools)
    elif tools_mode == "denylist":
        fm["disallowedTools"] = ", ".join(disallowed)
    if skills:
        fm["skills"] = skills
    if color:
        fm["color"] = color

    # Parse + merge advanced. Must be a mapping or empty.
    adv_text = (advanced_yaml or "").strip()
    if adv_text:
        try:
            parsed = yaml.safe_load(advanced_yaml)
        except yaml.YAMLError as e:
            warnings.append({"field": "advanced_yaml", "level": "error",
                             "message": f"advanced YAML does not parse: {e}", "value": ""})
            return fm, warnings
        if parsed is None:
            parsed = {}
        if not isinstance(parsed, dict):
            warnings.append({"field": "advanced_yaml", "level": "error",
                             "message": "advanced YAML must be a mapping", "value": ""})
            return fm, warnings
        for k, v in parsed.items():
            if k in SAFE_KEY_SET:
                warnings.append({"field": "advanced_yaml", "level": "warn",
                                 "message": f"advanced key '{k}' shadows a safe field; ignored", "value": k})
                continue
            fm[k] = v

    return fm, warnings


# ─────────────────────────────────────────────────────────────────────────────
# Validation (design D3)
# ─────────────────────────────────────────────────────────────────────────────

def _classify_tool_token(tok: str) -> bool:
    """True if a tool token is recognized; False ⇒ warn (unknown)."""
    if tok in KNOWN_TOOLS:
        return True
    if _AGENT_TOOL_RE.match(tok) or tok == "Agent":
        return True
    if _MCP_TOOL_RE.match(tok):
        return True
    return False


def _resolve_skill(skill_name: str, scope: str, project: Optional[str],
                   registry: Optional[dict],
                   harness_id: str = "claude-code") -> tuple[bool, Optional[Path], bool]:
    """Return (resolved_in_scope, skill_md_path_or_None, present_in_project_only).

    present_in_project_only is True when a user-scope agent references a skill
    that is NOT in the user skill dir but IS in some registered project skill dir
    (checked against the harness's own project skills dir).
    """
    scope_dir = _skills_dir(scope, project, registry, harness_id)
    in_scope_md = scope_dir / skill_name / "SKILL.md"
    if in_scope_md.exists():
        return True, in_scope_md, False

    present_in_project_only = False
    if scope == "user":
        proj_rel = ".claude/skills" if harness_id == "claude-code" else ".agents/skills"
        reg = registry or {}
        for cfg in (reg.get("projects") or {}).values():
            if not isinstance(cfg, dict) or not cfg.get("path"):
                continue
            md = Path(str(cfg["path"])).expanduser() / proj_rel / skill_name / "SKILL.md"
            if md.exists():
                present_in_project_only = True
                break
    return False, None, present_in_project_only


_DISABLE_INVOCATION_RE = re.compile(
    r"(?m)^\s*disable-model-invocation\s*:\s*true\b")


def _skill_is_invocable(skill_md: Path) -> bool:
    """False if SKILL.md sets `disable-model-invocation: true`.

    Fails closed on the FLAG: if the frontmatter YAML can't be parsed (a real
    SKILL.md may use quirky YAML, as agent files do), we still scan the raw text
    for the flag rather than assuming invocable. A genuinely unreadable file with
    no detectable flag stays invocable (don't false-block a valid skill).
    """
    try:
        text = skill_md.read_text()
    except OSError:
        return True
    if not text.lstrip().startswith("---"):
        return True
    parts = text.split("---", 2)
    if len(parts) < 3:
        return True
    try:
        meta = yaml.safe_load(parts[1]) or {}
        if isinstance(meta, dict):
            return not bool(meta.get("disable-model-invocation"))
    except yaml.YAMLError:
        pass
    # YAML unparseable or not a mapping — detect the flag in the raw frontmatter.
    return not bool(_DISABLE_INVOCATION_RE.search(parts[1]))


def attachable_skills(scope: str, project: Optional[str] = None,
                      registry: Optional[dict] = None,
                      harness_id: str = "claude-code") -> list[dict]:
    """List skills the picker can offer for the `skills:` preload field, each
    marked with point-of-choice attachability so the UI can prevent mistakes.

    Union of registry-known skills and skills physically present in the scope's
    skill dir (per harness), so the picker reflects what will actually resolve.
    Per entry:
      {name, description, resolved, invocable, project_only, attachable, reason}
    `attachable` is True only when the skill resolves in scope AND is
    model-invocable (i.e. attaching it produces no validation error).
    """
    hid = _validate_harness(harness_id)
    reg = registry or {}
    # Resolve the scope dir up front so a bad/missing project fails consistently
    # (ValueError propagates) regardless of how many registry skills exist.
    scope_dir = _skills_dir(scope, project, reg, hid)
    skills_meta = reg.get("skills") or {}
    names: set[str] = {str(n) for n in skills_meta.keys()}

    # union with on-disk skills present in the scope's skill dir
    try:
        if scope_dir.is_dir():
            for child in scope_dir.iterdir():
                if (child / "SKILL.md").exists():
                    names.add(child.name)
    except OSError:
        pass

    out: list[dict] = []
    for name in sorted(names):
        resolved, md, project_only = _resolve_skill(name, scope, project, reg, hid)
        invocable = True
        reason = ""
        if resolved and md is not None:
            invocable = _skill_is_invocable(md)
            if not invocable:
                reason = "sets disable-model-invocation: true — cannot be preloaded"
        elif project_only:
            reason = "only present in a project, not this scope"
        else:
            reason = "not synced/resolvable in this scope"
        meta = skills_meta.get(name)
        description = meta.get("description", "") if isinstance(meta, dict) else ""
        out.append({
            "name": name,
            "description": description,
            "resolved": resolved,
            "invocable": invocable,
            "project_only": project_only,
            "attachable": bool(resolved and invocable),
            "reason": reason,
        })
    return out


def provisioning_detail(skill_name: str, scope: str, project: Optional[str],
                        registry: Optional[dict]) -> Optional[dict]:
    """Build a blocking-error warning carrying a `needs_provisioning` detail for a
    NEWLY-attached, unresolved skill (design D5, two-phase protocol).

    Returns None when the skill is NOT in the registry — there is nothing to
    provision, so the caller emits a plain warning exactly as before. Otherwise a
    `{field:"skills", level:"error", ... needs_provisioning:{skill, scope_fix,
    consequence}}` dict. `scope_fix` = "make-global" for a user-scope agent,
    "project-enable" for a project-scope agent.
    """
    reg = registry or {}
    if skill_name not in (reg.get("skills") or {}):
        return None
    if scope == "user":
        scope_fix = "make-global"
        consequence = (
            f"Makes the skill '{skill_name}' global — it is installed into every "
            f"harness's user-level skill directory, not just this agent.")
    else:
        scope_fix = "project-enable"
        consequence = (
            f"Enables the skill '{skill_name}' for project '{project or '?'}' and "
            f"syncs it into that project's skill directory.")
    return {
        "field": "skills", "level": "error",
        "message": (
            f"skill '{skill_name}' is attached but does not yet resolve in this "
            f"scope — provision it before saving"),
        "value": skill_name,
        "needs_provisioning": {
            "skill": skill_name, "scope_fix": scope_fix, "consequence": consequence},
    }


def _original_skills_set(original_name: Optional[str], scope: str,
                         project: Optional[str], registry: Optional[dict],
                         harness_id: str) -> set:
    """The `skills:` list already present in the on-disk agent being edited.

    Used to tell NEWLY-attached skills (which trigger provisioning) from
    pre-existing ones (which stay plain warnings). A brand-new agent (no
    original_name / no file) yields the empty set — every attached skill is new.
    """
    if not original_name:
        return set()
    f = _find_agent_file(original_name, scope, project, registry, harness_id)
    if f is None:
        return set()
    doc = load_agent_file(f, harness_id)
    if not doc:
        return set()
    return set(_as_tool_list(doc["frontmatter"].get("skills")))


def validate_agent(frontmatter: dict, scope: str, project: Optional[str],
                   registry: Optional[dict], original_name: Optional[str] = None,
                   existing_names: Optional[set] = None,
                   original_skills: Optional[set] = None,
                   harness_id: str = "claude-code") -> dict:
    """Validate a frontmatter dict. Returns {valid, warnings:[{field,level,message,value}]}.

    `valid` is False iff any warning has level=="error" (errors block save).
    `existing_names` is the set of OTHER agents' names already present in scope;
    a collision (excluding original_name on rename) is an error.

    `original_skills` gates the two-phase provisioning protocol (design D5):
    when it is a set (SAVE context), a newly-attached skill (not in the set) that
    is unresolved AND in the registry becomes a BLOCKING error carrying a
    `needs_provisioning` detail. When it is None (display/list/show context), all
    unresolved skills stay plain warnings — the shipped behavior.
    """
    warnings: list[dict] = []

    def err(field, message, value=""):
        warnings.append({"field": field, "level": "error", "message": message, "value": value})

    def warn(field, message, value=""):
        warnings.append({"field": field, "level": "warn", "message": message, "value": value})

    # name
    name = str(frontmatter.get("name") or "").strip()
    if not name:
        err("name", "name is required")
    elif not SLUG_RE.match(name):
        err("name", "name must match [a-z0-9-]+", name)
    else:
        others = existing_names or set()
        if original_name is not None:
            others = {n for n in others if n != original_name}
        if name in others:
            err("name", f"another agent named '{name}' already exists in this scope", name)

    # description
    desc = frontmatter.get("description")
    if desc is None or (isinstance(desc, str) and not desc.strip()):
        err("description", "description is required")

    # model
    model = str(frontmatter.get("model") or "").strip()
    if model not in VALID_MODELS and not MODEL_ID_RE.match(model):
        err("model", "model must be empty/inherit/sonnet/opus/haiku/fable or a claude-* id", model)

    # color
    color = str(frontmatter.get("color") or "").strip()
    if color not in VALID_COLORS:
        err("color", "color must be one of red/blue/green/yellow/purple/orange/pink/cyan or empty", color)

    # tool tokens (warn only)
    for field in ("tools", "disallowedTools"):
        for tok in _as_tool_list(frontmatter.get(field)):
            if not _classify_tool_token(tok):
                warn(field, f"unknown tool token '{tok}'", tok)

    # attached skills
    for skill_name in _as_tool_list(frontmatter.get("skills")):
        resolved, md, project_only = _resolve_skill(
            skill_name, scope, project, registry, harness_id)
        if resolved and md is not None:
            if not _skill_is_invocable(md):
                err("skills", f"skill '{skill_name}' sets disable-model-invocation: true and cannot be preloaded", skill_name)
            continue
        # Unresolved (project-only or absent). A newly-attached registry skill in
        # a SAVE context becomes a blocking provisioning error (design D5).
        newly = original_skills is not None and skill_name not in original_skills
        prov = provisioning_detail(skill_name, scope, project, registry) if newly else None
        if prov is not None:
            warnings.append(prov)
        elif project_only:
            warn("skills", f"skill '{skill_name}' is only present in a project, not the user scope", skill_name)
        else:
            warn("skills", f"skill '{skill_name}' does not resolve in this scope", skill_name)

    # advanced: bypassPermissions loud warn (permissionMode is an advanced key)
    pm = frontmatter.get("permissionMode")
    if isinstance(pm, str) and pm.strip() == "bypassPermissions":
        warn("permissionMode", "permissionMode: bypassPermissions grants the agent unrestricted tool access", pm)

    valid = not any(w["level"] == "error" for w in warnings)
    return {"valid": valid, "warnings": warnings}


# ─────────────────────────────────────────────────────────────────────────────
# settings.json read / write (disable mechanism, design D4)
# ─────────────────────────────────────────────────────────────────────────────

def _read_settings(path: Path, strict: bool = False) -> dict:
    """Read a settings.json into a dict.

    With `strict=True` (mutation paths), an existing-but-unparseable file raises
    instead of defaulting to `{}` — otherwise a write would silently clobber the
    user's entire settings down to just our deny block. Read-only callers default
    to `{}`.
    """
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        if strict:
            raise ValueError(
                f"refusing to modify {path}: it exists but could not be parsed "
                f"as JSON ({e}); fix or remove the file first") from e
        return {}
    if not isinstance(data, dict):
        if strict:
            raise ValueError(
                f"refusing to modify {path}: top-level JSON is not an object")
        return {}
    return data


def _backup_settings(path: Path) -> Optional[Path]:
    """Backup a settings.json (or agent file) under ~/.skill-hub/_hub-backups."""
    if not path.exists():
        return None
    import hub
    import datetime as _dt
    root = hub.data_home() / "_hub-backups" / "subagents"
    root.mkdir(parents=True, exist_ok=True)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    dest = root / f"{path.name}.{stamp}.bak"
    shutil.copy2(path, dest)
    return dest


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_disabled(name: str, scope: str, project: Optional[str] = None,
                  registry: Optional[dict] = None,
                  harness_id: str = "claude-code") -> bool:
    """Claude: True if `Agent(<name>)` is in the scope settings.json deny array.
    Codex: True iff the agent's file carries the `.toml.disabled` suffix."""
    if harness_id == "codex":
        f = _find_agent_file(name, scope, project, registry, harness_id)
        return f is not None and _codex().is_disabled_file(f)
    path = settings_path(scope, project, registry)
    data = _read_settings(path)
    deny = (((data.get("permissions") or {}).get("deny")) or [])
    return f"Agent({name})" in deny


def set_disabled(name: str, disabled: bool, scope: str, project: Optional[str] = None,
                 registry: Optional[dict] = None,
                 harness_id: str = "claude-code") -> bool:
    """Toggle an agent's disabled state.

    Claude: merge-preserving add/remove of `Agent(<name>)` in the scope deny
    array (touches ONLY that element; creates missing permissions/deny;
    backup-first; atomic). Codex: rename the file out of / back into the
    `*.toml` glob — the suffix is the sole state (design D6).
    Returns the resulting disabled state.
    """
    if harness_id == "codex":
        sc = _codex()
        f = _find_agent_file(name, scope, project, registry, harness_id)
        if f is None:
            if name in sc.BUILTIN_CODEX_NAMES:
                raise ValueError(
                    f"built-in codex agent '{name}' cannot be disabled (it has no file)")
            raise ValueError(f"agent '{name}' not found")
        currently = sc.is_disabled_file(f)
        if currently == disabled:
            return disabled
        stem = sc.agent_file_stem(f)
        target = f.with_name(stem + (sc.DISABLED_SUFFIX if disabled else sc.ENABLED_SUFFIX))
        if target.exists():
            raise ValueError(
                f"cannot toggle '{name}': target file '{target.name}' already exists")
        _backup_settings(f)
        f.rename(target)
        return disabled
    path = settings_path(scope, project, registry)
    data = _read_settings(path, strict=True)
    entry = f"Agent({name})"

    perms = data.get("permissions")
    if not isinstance(perms, dict):
        perms = {}
    deny = perms.get("deny")
    if not isinstance(deny, list):
        deny = []

    present = entry in deny
    changed = False
    if disabled and not present:
        deny = list(deny) + [entry]
        changed = True
    elif not disabled and present:
        deny = [d for d in deny if d != entry]
        changed = True

    if changed:
        _backup_settings(path)
        perms["deny"] = deny
        data["permissions"] = perms
        _atomic_write(path, json.dumps(data, indent=2, sort_keys=False) + "\n")
    return disabled


def remove_disabled_entry(name: str, scope: str, project: Optional[str] = None,
                          registry: Optional[dict] = None) -> bool:
    """Strip `Agent(<name>)` from deny if present (used on delete). Returns True
    if an entry was removed."""
    path = settings_path(scope, project, registry)
    if not path.exists():
        return False
    data = _read_settings(path, strict=True)
    perms = data.get("permissions")
    if not isinstance(perms, dict):
        return False
    deny = perms.get("deny")
    if not isinstance(deny, list) or f"Agent({name})" not in deny:
        return False
    _backup_settings(path)
    perms["deny"] = [d for d in deny if d != f"Agent({name})"]
    data["permissions"] = perms
    _atomic_write(path, json.dumps(data, indent=2, sort_keys=False) + "\n")
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Listing / loading
# ─────────────────────────────────────────────────────────────────────────────

def _iter_agent_files(adir: Path, harness_id: str = "claude-code"):
    if not adir.is_dir():
        return
    for entry in sorted(adir.iterdir()):
        if not entry.is_file():
            continue
        if harness_id == "codex":
            # Enabled AND hub-disabled files (suffix is the sole disable state).
            if entry.name.endswith(".toml") or entry.name.endswith(".toml.disabled"):
                yield entry
        elif entry.suffix == ".md":
            yield entry


def load_agent_file(path: Path, harness_id: str = "claude-code") -> Optional[dict]:
    """Parse an agent file; return {frontmatter, body, ...} or None on failure."""
    try:
        text = path.read_text()
    except OSError:
        return None
    if harness_id == "codex":
        try:
            return _codex().parse_codex_agent(text)
        except ValueError:
            return None
    try:
        return parse_agent(text)
    except ParseError:
        return None


def _validate_for_harness(fm: dict, body: str, scope: str, project: Optional[str],
                          registry: Optional[dict], harness_id: str,
                          original_name: Optional[str],
                          existing_names: Optional[set],
                          original_skills: Optional[set] = None) -> dict:
    """Dispatch validation per harness (claude keeps the shipped validator).

    `original_skills` (a set in SAVE contexts, None for display) drives the D5
    two-phase provisioning protocol identically across harnesses.
    """
    if harness_id == "codex":
        sc = _codex()
        return sc.validate_codex_agent(
            fm, body,
            resolve_skill=lambda s: _resolve_skill(s, scope, project, registry, harness_id),
            skill_is_invocable=_skill_is_invocable,
            original_name=original_name, existing_names=existing_names,
            original_skills=original_skills,
            provisioning_for=lambda s: provisioning_detail(s, scope, project, registry))
    return validate_agent(fm, scope, project, registry,
                          original_name=original_name, existing_names=existing_names,
                          original_skills=original_skills, harness_id=harness_id)


def list_agents(scope: str, project: Optional[str] = None,
                registry: Optional[dict] = None,
                harness_id: str = "claude-code") -> dict:
    """Build the `list` contract for a scope + harness."""
    hid = _validate_harness(harness_id)
    adir = agents_dir(scope, project, registry, hid)
    spath = "" if hid == "codex" else str(settings_path(scope, project, registry))

    # Collect names first for within-scope collision detection.
    parsed: list[tuple[Path, dict]] = []
    broken: list[Path] = []
    name_counts: dict[str, int] = {}
    for f in _iter_agent_files(adir, hid):
        doc = load_agent_file(f, hid)
        if doc is None:
            # A malformed file must stay VISIBLE so the user can repair/delete it,
            # not silently vanish from list/show/delete.
            broken.append(f)
            continue
        nm = str(doc["frontmatter"].get("name") or "").strip()
        if nm:
            name_counts[nm] = name_counts.get(nm, 0) + 1
        parsed.append((f, doc))

    all_names = {nm for nm, _ in [(str(d["frontmatter"].get("name") or "").strip(), d) for _, d in parsed] if nm}

    agents: list[dict] = []
    for f, doc in parsed:
        fm = doc["frontmatter"]
        nm = str(fm.get("name") or "").strip()
        derived = derive_tools(fm)
        existing_others = {n for n in all_names if n != nm}
        v = _validate_for_harness(fm, doc.get("body") or "", scope, project, registry,
                                  hid, original_name=nm, existing_names=existing_others)
        warnings = list(v["warnings"])
        # Surface a within-scope duplicate as an error on this entry.
        if nm and name_counts.get(nm, 0) > 1:
            warnings.append({"field": "name", "level": "error",
                             "message": f"duplicate agent name '{nm}' within scope", "value": nm})
        valid = not any(w["level"] == "error" for w in warnings)
        if hid == "codex":
            disabled = _codex().is_disabled_file(f)
        else:
            disabled = read_disabled(nm, scope, project, registry) if nm else False
        item = {
            "name": nm,
            "file": str(f),
            "relpath": f.name,
            "description": "" if fm.get("description") is None else str(fm.get("description")),
            "model": str(fm.get("model") or ""),
            "tools_mode": derived["tools_mode"],
            "tools": derived["tools"],
            "disallowed_tools": derived["disallowed_tools"],
            "skills": _as_tool_list(fm.get("skills")),
            "color": str(fm.get("color") or ""),
            "disabled": disabled,
            "builtin": False,
            "valid": valid,
            "warnings": warnings,
        }
        if hid == "codex":
            item["sandbox_mode"] = str(fm.get("sandbox_mode") or "")
            item["model_reasoning_effort"] = str(fm.get("model_reasoning_effort") or "")
            item["nickname_candidates"] = [str(x) for x in (fm.get("nickname_candidates") or [])]
        agents.append(item)

    # Broken (unparseable) files surface as invalid entries keyed on the filename
    # stem, so they remain visible and deletable in the UI.
    for f in broken:
        stem = _codex().agent_file_stem(f) if hid == "codex" else f.stem
        agents.append({
            "name": stem,
            "file": str(f),
            "relpath": f.name,
            "description": "",
            "model": "",
            "tools_mode": "all",
            "tools": [],
            "disallowed_tools": [],
            "skills": [],
            "color": "",
            "disabled": _codex().is_disabled_file(f) if hid == "codex" else False,
            "builtin": False,
            "valid": False,
            "broken": True,
            "warnings": [{
                "field": "file", "level": "error",
                "message": "could not parse this agent file — fix or delete it",
                "value": f.name,
            }],
        })

    # Linked-twin presence/suggestion (cheap: one scan of each agent-capable
    # harness dir). Additive `link` field per agent (cross-harness-subagents D3).
    links_warning = None
    try:
        import subagent_links as _links
        _link_list, links_warning = _links.read_links()
        _present = _links.present_names_by_harness(scope, registry)
        for item in agents:
            item["link"] = _links.link_info_for(
                item["name"], hid, scope, _link_list, _present)
    except Exception:  # noqa: BLE001 — link info is best-effort, never crashes list
        for item in agents:
            item.setdefault("link", None)

    builtins = []
    if hid == "codex":
        for b in _codex().BUILTIN_AGENTS_CODEX:
            builtins.append({
                "name": b["name"],
                "model": b["model"],
                "description": b["description"],
                "disabled": False,  # no file, no deny mechanism — read-only
                "builtin": True,
            })
    else:
        for b in BUILTIN_AGENTS:
            builtins.append({
                "name": b["name"],
                "model": b["model"],
                "description": b["description"],
                "disabled": read_disabled(b["name"], scope, project, registry),
                "builtin": True,
            })

    return {
        "harness": hid,
        "scope": scope,
        "project": project,
        "agents_dir": str(adir),
        "settings_path": spath,
        "agents": agents,
        "builtins": builtins,
        "links_warning": links_warning,
    }


def _find_agent_file(name: str, scope: str, project: Optional[str],
                     registry: Optional[dict],
                     harness_id: str = "claude-code") -> Optional[Path]:
    """Find the file whose `name` field == name (identity is name, not file).
    For codex this searches enabled AND disabled suffixes."""
    adir = agents_dir(scope, project, registry, harness_id)
    for f in _iter_agent_files(adir, harness_id):
        doc = load_agent_file(f, harness_id)
        if doc and str(doc["frontmatter"].get("name") or "").strip() == name:
            return f
    return None


def _codex_safe(fm: dict) -> dict:
    """Codex `safe` block: the shared subset + inert claude defaults (wire
    contract, review M10) + codex-only fields."""
    return {
        "name": str(fm.get("name") or ""),
        "description": "" if fm.get("description") is None else str(fm.get("description")),
        "model": str(fm.get("model") or ""),
        "tools_mode": "all",
        "tools": [],
        "disallowed_tools": [],
        "allow_skill_discovery": True,
        "skills": _as_tool_list(fm.get("skills")),
        "color": "",
        "sandbox_mode": str(fm.get("sandbox_mode") or ""),
        "model_reasoning_effort": str(fm.get("model_reasoning_effort") or ""),
        "nickname_candidates": [str(x) for x in (fm.get("nickname_candidates") or [])],
    }


def show_agent(name: str, scope: str, project: Optional[str] = None,
               registry: Optional[dict] = None,
               harness_id: str = "claude-code") -> dict:
    """Build the `show` contract for one agent."""
    hid = _validate_harness(harness_id)
    f = _find_agent_file(name, scope, project, registry, hid)
    adir = agents_dir(scope, project, registry, hid)
    adv_format = "toml" if hid == "codex" else "yaml"
    default_ext = ".toml" if hid == "codex" else ".md"
    if f is None:
        return {
            "harness": hid,
            "name": name, "scope": scope, "file": str(adir / f"{name}{default_ext}"),
            "exists": False, "safe": {}, "advanced_yaml": "", "advanced_format": adv_format,
            "body": "", "foreign_skill_entries": [],
            "disabled": read_disabled(name, scope, project, registry, hid),
            "link": None, "drift": None,
            "validation": {"valid": False, "warnings": [
                {"field": "name", "level": "error", "message": "agent not found", "value": name}]},
        }
    doc = load_agent_file(f, hid)
    fm = doc["frontmatter"]
    if hid == "codex":
        sc = _codex()
        safe = _codex_safe(fm)
        try:
            advanced_yaml = sc.advanced_fragment(doc.get("raw_text") or "")
        except ValueError:
            advanced_yaml = ""
        foreign = doc.get("foreign_skill_entries") or []
        disabled = sc.is_disabled_file(f)
    else:
        safe, advanced_yaml = split_safe_advanced(fm)
        foreign = []
        disabled = read_disabled(name, scope, project, registry)
    # Collision detection across scope for validation.
    existing_others = set()
    for other in _iter_agent_files(adir, hid):
        if other == f:
            continue
        odoc = load_agent_file(other, hid)
        if odoc:
            onm = str(odoc["frontmatter"].get("name") or "").strip()
            if onm:
                existing_others.add(onm)
    v = _validate_for_harness(fm, doc.get("body") or "", scope, project, registry,
                              hid, original_name=name, existing_names=existing_others)
    # Linked-twin presence + per-field drift (D3). Drift is null unless linked
    # with a present twin that diverges on a shared-core field.
    link_info = None
    drift = None
    links_warning = None
    try:
        import subagent_links as _links
        _link_list, links_warning = _links.read_links()
        _present = _links.present_names_by_harness(scope, registry)
        link_info = _links.link_info_for(name, hid, scope, _link_list, _present)
        _link_entry = _links.find_link(name, scope)
        if _link_entry and hid in (_link_entry.get("harnesses") or []):
            hs = _link_entry.get("harnesses") or []
            cores = {h: _links._core_for(name, h, scope, registry) for h in hs}
            d = _links.compute_drift(cores)
            drift = d or None
    except Exception:  # noqa: BLE001 — link/drift is best-effort
        pass
    return {
        "harness": hid,
        "name": name,
        "scope": scope,
        "file": str(f),
        "exists": True,
        "safe": safe,
        "advanced_yaml": advanced_yaml,
        "advanced_format": adv_format,
        "body": doc["body"],
        "foreign_skill_entries": foreign,
        "disabled": disabled,
        "link": link_info,
        "drift": drift,
        "links_warning": links_warning,
        "validation": v,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Save / delete
# ─────────────────────────────────────────────────────────────────────────────

def save_agent(payload: dict, registry: Optional[dict] = None) -> dict:
    """Validate + write an agent from a save payload.

    payload = {scope, project, original_name|null, safe:{...}, advanced_yaml,
    body, harness?} — `harness` defaults to claude-code (review MINOR-3: it
    rides in the payload like `scope`, not as a CLI flag).
    Returns {ok, name, file, warnings, renamed_from} | {ok:False, errors:[...]}.
    """
    hid = _validate_harness(payload.get("harness") or "claude-code")
    scope = payload.get("scope") or "user"
    original_name = payload.get("original_name")
    # Linked-twin co-write path (user scope only): if this agent is recorded in
    # the link sidecar for this harness, save writes both files (D3).
    if scope == "user" and original_name:
        import subagent_links as _links
        link = _links.find_link(original_name, scope)
        if link and hid in (link.get("harnesses") or []):
            return _links.save_linked(payload, registry, link, hid)
    if hid == "codex":
        return _save_codex_agent(payload, registry)
    project = payload.get("project")
    safe = payload.get("safe") or {}
    advanced_yaml = payload.get("advanced_yaml") or ""
    body = payload.get("body") or ""

    fm, build_warnings = build_frontmatter(safe, advanced_yaml)

    adir = agents_dir(scope, project, registry)
    # Existing names in scope (excluding the file we're editing, matched by original_name).
    existing_names = set()
    for f in _iter_agent_files(adir):
        doc = load_agent_file(f)
        if doc:
            nm = str(doc["frontmatter"].get("name") or "").strip()
            if nm:
                existing_names.add(nm)

    original_skills = _original_skills_set(
        original_name, scope, project, registry, "claude-code")
    v = validate_agent(fm, scope, project, registry,
                       original_name=original_name, existing_names=existing_names,
                       original_skills=original_skills, harness_id="claude-code")
    all_warnings = build_warnings + v["warnings"]
    errors = [w for w in all_warnings if w["level"] == "error"]
    if errors:
        return {"ok": False, "errors": errors}

    new_name = str(fm.get("name")).strip()
    content = serialize_agent(fm, normalize_body(body))

    new_path = adir / f"{new_name}.md"

    renamed_from = None
    old_path = None
    if original_name:
        old_path = _find_agent_file(original_name, scope, project, registry)

    # Rename collision: a different existing file already uses the new name.
    if old_path is not None and new_name != original_name:
        target_existing = _find_agent_file(new_name, scope, project, registry)
        if target_existing is not None and target_existing != old_path:
            return {"ok": False, "errors": [{
                "field": "name", "level": "error",
                "message": f"cannot rename to '{new_name}': an agent with that name already exists",
                "value": new_name}]}
        renamed_from = original_name

    # Brand-new agent colliding with an existing file.
    if old_path is None:
        target_existing = _find_agent_file(new_name, scope, project, registry)
        if target_existing is not None:
            return {"ok": False, "errors": [{
                "field": "name", "level": "error",
                "message": f"an agent named '{new_name}' already exists",
                "value": new_name}]}

    # Backup any file we're about to overwrite, then write atomically.
    if new_path.exists():
        _backup_settings(new_path)
    elif old_path is not None and old_path != new_path:
        _backup_settings(old_path)
    _atomic_write(new_path, content)

    # Remove the old file if the name changed (after successful write).
    if old_path is not None and old_path != new_path and old_path.exists():
        old_path.unlink()

    return {
        "ok": True,
        "name": new_name,
        "file": str(new_path),
        "warnings": all_warnings,
        "renamed_from": renamed_from,
    }


def _save_codex_agent(payload: dict, registry: Optional[dict] = None) -> dict:
    """Codex save path: TOML render onto the existing document (round-trip
    preserving), collision domain = enabled ∪ disabled names, disabled state
    (file suffix) survives a save/rename."""
    sc = _codex()
    scope = payload.get("scope") or "user"
    if scope != "user":
        return {"ok": False, "errors": [{
            "field": "scope", "level": "error",
            "message": "codex project-scope agents are not supported yet (ships in a later wave)",
            "value": scope}]}
    project = None
    original_name = payload.get("original_name")
    safe = payload.get("safe") or {}
    advanced_toml = payload.get("advanced_yaml") or ""
    body = payload.get("body") or ""

    fm, build_warnings = sc.build_frontmatter_view(safe, advanced_toml)

    adir = agents_dir(scope, project, registry, "codex")
    existing_names = set()
    for f in _iter_agent_files(adir, "codex"):
        doc = load_agent_file(f, "codex")
        if doc:
            nm = str(doc["frontmatter"].get("name") or "").strip()
            if nm:
                existing_names.add(nm)

    original_skills = _original_skills_set(
        original_name, scope, project, registry, "codex")
    v = sc.validate_codex_agent(
        fm, body,
        resolve_skill=lambda s: _resolve_skill(s, scope, project, registry, "codex"),
        skill_is_invocable=_skill_is_invocable,
        original_name=original_name, existing_names=existing_names,
        original_skills=original_skills,
        provisioning_for=lambda s: provisioning_detail(s, scope, project, registry))
    all_warnings = build_warnings + v["warnings"]
    errors = [w for w in all_warnings if w["level"] == "error"]
    if errors:
        return {"ok": False, "errors": errors}

    new_name = str(fm.get("name")).strip()

    renamed_from = None
    old_path = None
    if original_name:
        old_path = _find_agent_file(original_name, scope, project, registry, "codex")

    # Disabled state survives save/rename: the suffix is the sole state (D6).
    disabled = old_path is not None and sc.is_disabled_file(old_path)
    suffix = sc.DISABLED_SUFFIX if disabled else sc.ENABLED_SUFFIX
    new_path = adir / f"{new_name}{suffix}"

    if old_path is not None and new_name != original_name:
        target_existing = _find_agent_file(new_name, scope, project, registry, "codex")
        if target_existing is not None and target_existing != old_path:
            return {"ok": False, "errors": [{
                "field": "name", "level": "error",
                "message": f"cannot rename to '{new_name}': an agent with that name already exists",
                "value": new_name}]}
        renamed_from = original_name

    if old_path is None:
        target_existing = _find_agent_file(new_name, scope, project, registry, "codex")
        if target_existing is not None:
            return {"ok": False, "errors": [{
                "field": "name", "level": "error",
                "message": f"an agent named '{new_name}' already exists",
                "value": new_name}]}

    existing_text = None
    if old_path is not None:
        try:
            existing_text = old_path.read_text()
        except OSError:
            existing_text = None
    try:
        content = sc.render_codex_agent(existing_text, safe, advanced_toml, body)
    except ValueError as e:
        return {"ok": False, "errors": [{
            "field": "advanced_yaml", "level": "error", "message": str(e), "value": ""}]}

    if new_path.exists():
        _backup_settings(new_path)
    elif old_path is not None and old_path != new_path:
        _backup_settings(old_path)
    _atomic_write(new_path, content)

    if old_path is not None and old_path != new_path and old_path.exists():
        old_path.unlink()

    return {
        "ok": True,
        "name": new_name,
        "file": str(new_path),
        "warnings": all_warnings,
        "renamed_from": renamed_from,
    }


def delete_agent(name: str, scope: str, project: Optional[str] = None,
                 registry: Optional[dict] = None,
                 harness_id: str = "claude-code",
                 link_action: str = "this") -> dict:
    """Backup + remove the agent file. Claude additionally strips any
    Agent(name) deny entry; codex removes the file in whichever suffix state.

    On a LINKED agent (user scope), `link_action` selects the twin handling:
      - "this" (default): delete only this harness's file and unlink the pair
        (the survivor no longer reports a lost twin).
      - "both": delete every linked harness's file, then drop the sidecar entry.
    """
    hid = _validate_harness(harness_id)
    f = _find_agent_file(name, scope, project, registry, hid)
    if f is None:
        return {"ok": False, "errors": [{
            "field": "name", "level": "error", "message": "agent not found", "value": name}]}

    link = None
    if scope == "user":
        import subagent_links as _links
        link = _links.find_link(name, scope)
        if link is not None and hid not in (link.get("harnesses") or []):
            link = None

    # Transactional across the pair (mirrors the linked-rename standard, D3):
    # every removed file is backed up first; if a LATER step fails, the files
    # already removed are restored from those backups so a linked delete is
    # all-or-nothing — never one twin silently gone.
    deleted: list[tuple[Path, Path]] = []  # (original_path, backup_path)
    stripped_deny = False  # claude deny entry removed pre-unlink (restore on rollback)

    def _delete_one(hh: str, ff: Path) -> None:
        nonlocal stripped_deny
        if hh == "claude-code":
            # Strip the deny entry FIRST: if settings.json is malformed this
            # raises before the file is touched, so we never end up
            # file-gone-but-still-denied.
            if remove_disabled_entry(name, scope, project, registry):
                stripped_deny = True
        bak = _backup_settings(ff)
        ff.unlink()
        if bak is not None:
            deleted.append((ff, bak))

    def _restore_deleted() -> None:
        for orig, bak in deleted:
            try:
                shutil.copy2(bak, orig)
            except OSError:
                pass  # backup remains under _hub-backups either way
        if stripped_deny:
            # The agent was disabled — a rolled-back delete must not silently
            # re-enable it.
            try:
                set_disabled(name, True, scope, project, registry)
            except (OSError, ValueError):
                pass  # settings backup exists under _hub-backups

    try:
        _delete_one(hid, f)
        if link is not None and link_action == "both":
            for oh in (link.get("harnesses") or []):
                if oh == hid:
                    continue
                of = _find_agent_file(name, scope, project, registry, oh)
                if of is not None:
                    _delete_one(oh, of)
    except (OSError, ValueError) as e:
        _restore_deleted()
        return {"ok": False, "errors": [{
            "field": "name", "level": "error",
            "message": f"linked delete failed and was rolled back: {e}",
            "value": name}]}

    if link is not None:
        import subagent_links as _links
        _links.unlink_agents(name, scope)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# skill-usage reverse index (design D2)
# ─────────────────────────────────────────────────────────────────────────────

def skill_usage(registry: Optional[dict] = None) -> dict:
    """Reverse index {skill_name: [{agent, scope, project|null, harness}]}
    across the claude user scope + every registered project's claude agents dir
    + the codex user scope. The `harness` key is additive (cross-harness
    change); pre-existing consumers ignore it."""
    index: dict[str, list[dict]] = {}

    def record(skill_name: str, agent: str, scope: str, project: Optional[str],
               harness: str):
        index.setdefault(skill_name, []).append(
            {"agent": agent, "scope": scope, "project": project, "harness": harness})

    # claude user scope
    for f in _iter_agent_files(agents_dir("user")):
        doc = load_agent_file(f)
        if not doc:
            continue
        nm = str(doc["frontmatter"].get("name") or "").strip()
        for sk in _as_tool_list(doc["frontmatter"].get("skills")):
            record(sk, nm, "user", None, "claude-code")

    # claude project scopes
    reg = registry or {}
    for pname, cfg in (reg.get("projects") or {}).items():
        if not isinstance(cfg, dict) or not cfg.get("path"):
            continue
        adir = Path(str(cfg["path"])).expanduser() / ".claude" / "agents"
        for f in _iter_agent_files(adir):
            doc = load_agent_file(f)
            if not doc:
                continue
            nm = str(doc["frontmatter"].get("name") or "").strip()
            for sk in _as_tool_list(doc["frontmatter"].get("skills")):
                record(sk, nm, "project", pname, "claude-code")

    # codex user scope (project scope ships in a later wave)
    for f in _iter_agent_files(agents_dir("user", harness_id="codex"), "codex"):
        doc = load_agent_file(f, "codex")
        if not doc:
            continue
        nm = str(doc["frontmatter"].get("name") or "").strip()
        for sk in _as_tool_list(doc["frontmatter"].get("skills")):
            record(sk, nm, "user", None, "codex")

    return index


# ─────────────────────────────────────────────────────────────────────────────
# Starter templates (for `new` via the UI; CLI save builds the content)
# ─────────────────────────────────────────────────────────────────────────────

STARTER_PRESETS = {
    "blank": {"safe": {"tools_mode": "all", "allow_skill_discovery": True},
              "body": "You are a helpful assistant.\n"},
    "read-only": {
        "safe": {"tools_mode": "allowlist",
                 "tools": ["Read", "Glob", "Grep", "WebFetch"],
                 "allow_skill_discovery": True},
        "body": "You are a read-only reviewer. Inspect and report; do not modify files.\n"},
    "general": {"safe": {"tools_mode": "all", "allow_skill_discovery": True},
                "body": "You are a general-purpose agent for multi-step tasks.\n"},
}
