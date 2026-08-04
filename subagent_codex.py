#!/usr/bin/env python3
"""subagent_codex — Codex CLI custom-agent TOML format engine.

Codex custom agents are TOML files (one agent per file) at:
  - user scope:    $CODEX_HOME/agents/*.toml   (default ~/.codex/agents)
  - disabled:      $CODEX_HOME/agents/*.toml.disabled  (hub-owned rename; the
                   file suffix is the SOLE disable state — no sidecar)

Required fields: `name`, `description`, `developer_instructions` (the system
prompt — carried in the JSON contract's `body` slot). Optional: `model`,
`model_reasoning_effort`, `sandbox_mode`, `nickname_candidates`, and
`[[skills.config]]` entries `{path = <absolute SKILL.md path>, enabled = bool}`.

Skills mapping (design D2 / review M6 — partial ownership): an entry whose
`path` sits under the codex skills root (`~/.agents/skills/<name>/SKILL.md`)
AND has `enabled = true` maps to the bare skill name in `safe.skills`; ANY
other entry (foreign path, `enabled = false`) is preserved verbatim on
round-trip and surfaced read-only via `foreign_skill_entries`.

Everything TOML goes through tomlkit (vendored) so unknown keys, comments and
formatting round-trip. tomlkit is imported lazily so claude-only use of
subagents.py never needs it.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Callable, Optional

# Top-level TOML keys the guided editor models; everything else is "advanced"
# and round-trips verbatim (carried as TOML text in the `advanced_yaml` contract
# slot — the key name is a wart kept for zero churn on the shipped Claude path;
# `advanced_format: "toml"` disambiguates). The `skills` table is modeled via
# `skills.config` only; other subkeys under [skills] are preserved in place on
# save but are not surfaced in the advanced editor.
CODEX_MODELED_KEYS = {
    "name", "description", "developer_instructions", "model",
    "model_reasoning_effort", "sandbox_mode", "nickname_candidates", "skills",
}

VALID_SANDBOX_MODES = {"", "read-only", "workspace-write", "danger-full-access"}
# Unknown efforts WARN (the value set moves fast); bad sandbox_mode ERRORS.
KNOWN_REASONING_EFFORTS = {"", "minimal", "low", "medium", "high", "xhigh"}

# Codex examples use underscores (pr_explorer) — allow them, unlike claude.
CODEX_SLUG_RE = re.compile(r"^[a-z0-9_-]+$")

ENABLED_SUFFIX = ".toml"
DISABLED_SUFFIX = ".toml.disabled"

# Built-in Codex agents (read-only; no file, cannot be disabled by the hub).
BUILTIN_AGENTS_CODEX = [
    {"name": "default", "model": "inherit",
     "description": "General-purpose fallback agent."},
    {"name": "worker", "model": "inherit",
     "description": "Execution-focused agent for implementation tasks."},
    {"name": "explorer", "model": "inherit",
     "description": "Read-heavy codebase exploration agent."},
]
BUILTIN_CODEX_NAMES = {b["name"] for b in BUILTIN_AGENTS_CODEX}


def _tomlkit():
    """Lazy tomlkit import (vendored) — claude-only paths never pay for it."""
    import tomlkit
    return tomlkit


# ─────────────────────────────────────────────────────────────────────────────
# Path resolution
# ─────────────────────────────────────────────────────────────────────────────

def codex_home() -> Path:
    """Root of the Codex config dir, honoring $CODEX_HOME (tests + real codex)."""
    env = os.environ.get("CODEX_HOME", "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".codex"


def codex_skills_root() -> Path:
    """The codex global skills dir, derived from the ONE harness registry default
    (never a second hardcoded literal — review M7). expanduser resolves via
    $HOME, which is how tests isolate this root."""
    import harnesses
    return Path(str(harnesses.HARNESSES["codex"].global_skills_dir)).expanduser()


def agent_file_stem(path: Path) -> str:
    """`foo.toml` / `foo.toml.disabled` → `foo`."""
    name = path.name
    if name.endswith(DISABLED_SUFFIX):
        return name[: -len(DISABLED_SUFFIX)]
    if name.endswith(ENABLED_SUFFIX):
        return name[: -len(ENABLED_SUFFIX)]
    return name


def is_disabled_file(path: Path) -> bool:
    return path.name.endswith(DISABLED_SUFFIX)


# ─────────────────────────────────────────────────────────────────────────────
# skills.config mapping (partial ownership, review M6)
# ─────────────────────────────────────────────────────────────────────────────

def _name_from_path(path_str: str, root: Path) -> Optional[str]:
    """Map an absolute skills.config path to a bare skill name iff it is
    hub-shaped: `<root>/<name>/SKILL.md` or `<root>/<name>`."""
    if not path_str:
        return None
    try:
        p = Path(path_str).expanduser()
        rel = p.relative_to(root)
    except (ValueError, OSError):
        return None
    parts = rel.parts
    if len(parts) == 1 and parts[0]:
        return parts[0]
    if len(parts) == 2 and parts[1] == "SKILL.md":
        return parts[0]
    return None


def _map_skills_config(skills_val: Any, root: Path) -> tuple[list[str], list[dict]]:
    """Split raw `skills.config` entries into (mapped_names, foreign_entries)."""
    names: list[str] = []
    foreign: list[dict] = []
    cfg = None
    if isinstance(skills_val, dict):
        cfg = skills_val.get("config")
    if not isinstance(cfg, list):
        return names, foreign
    for entry in cfg:
        if not isinstance(entry, dict):
            foreign.append({"path": str(entry), "enabled": True})
            continue
        path_str = str(entry.get("path") or "")
        enabled = entry.get("enabled", True)
        name = _name_from_path(path_str, root)
        if name is not None and enabled is True:
            names.append(name)
        else:
            foreign.append({"path": path_str, "enabled": bool(enabled)})
    return names, foreign


# ─────────────────────────────────────────────────────────────────────────────
# Parse / advanced fragment
# ─────────────────────────────────────────────────────────────────────────────

def parse_codex_agent(text: str) -> dict:
    """Parse an agent TOML into the uniform doc shape used by subagents.py:
    {frontmatter, body, foreign_skill_entries, raw_text}. `frontmatter` merges
    the modeled keys (skills as mapped bare names) with advanced keys as plain
    values, so shared list/validate plumbing can treat both harnesses alike.

    Raises ValueError on unparseable TOML or a non-table document.
    """
    tomlkit = _tomlkit()
    try:
        doc = tomlkit.parse(text)
    except Exception as e:  # tomlkit raises its own ParseError hierarchy
        raise ValueError(f"invalid TOML: {e}") from e
    data = doc.unwrap()
    if not isinstance(data, dict):
        raise ValueError("agent TOML is not a table")

    root = codex_skills_root()
    skill_names, foreign = _map_skills_config(data.get("skills"), root)

    fm: dict = {}
    for key in ("name", "description", "model", "model_reasoning_effort",
                "sandbox_mode", "nickname_candidates"):
        if key in data:
            fm[key] = data[key]
    if skill_names:
        fm["skills"] = skill_names
    for key, val in data.items():
        if key not in CODEX_MODELED_KEYS:
            fm[key] = val

    body = data.get("developer_instructions")
    body = "" if body is None else str(body)
    return {
        "frontmatter": fm,
        "body": body,
        "foreign_skill_entries": foreign,
        "raw_text": text,
    }


def advanced_fragment(text: str) -> str:
    """TOML text of the unmodeled top-level keys (the advanced editor content).
    Returns "" when there are none. Raises ValueError on unparseable TOML."""
    tomlkit = _tomlkit()
    try:
        doc = tomlkit.parse(text)
    except Exception as e:
        raise ValueError(f"invalid TOML: {e}") from e
    out = tomlkit.document()
    for key in list(doc.keys()):
        if key not in CODEX_MODELED_KEYS:
            out[key] = doc[key]
    dumped = tomlkit.dumps(out)
    return dumped if dumped.strip() else ""


# ─────────────────────────────────────────────────────────────────────────────
# Build (save payload → validation view) / render (→ final TOML text)
# ─────────────────────────────────────────────────────────────────────────────

def build_frontmatter_view(safe: dict, advanced_toml: str) -> tuple[dict, list[dict]]:
    """Merge a save payload's `safe` block + parsed advanced TOML into one plain
    dict for validation (mirror of subagents.build_frontmatter). Advanced keys
    cannot override a modeled key. A non-parsing advanced fragment is a blocking
    error (level=error) reported in warnings."""
    warnings: list[dict] = []
    fm: dict = {}

    fm["name"] = str(safe.get("name") or "").strip()
    desc = safe.get("description")
    fm["description"] = "" if desc is None else str(desc)
    for key in ("model", "model_reasoning_effort", "sandbox_mode"):
        val = str(safe.get(key) or "").strip()
        if val:
            fm[key] = val
    nick = safe.get("nickname_candidates") or []
    if nick:
        fm["nickname_candidates"] = nick
    skills = [str(s).strip() for s in (safe.get("skills") or []) if str(s).strip()]
    if skills:
        fm["skills"] = skills

    adv_text = (advanced_toml or "").strip()
    if adv_text:
        try:
            parsed = _tomlkit().parse(advanced_toml).unwrap()
        except Exception as e:
            warnings.append({"field": "advanced_yaml", "level": "error",
                             "message": f"advanced TOML does not parse: {e}", "value": ""})
            return fm, warnings
        for key, val in parsed.items():
            if key in CODEX_MODELED_KEYS:
                warnings.append({"field": "advanced_yaml", "level": "warn",
                                 "message": f"advanced key '{key}' shadows a modeled field; ignored",
                                 "value": key})
                continue
            fm[key] = val

    return fm, warnings


def render_codex_agent(existing_text: Optional[str], safe: dict,
                       advanced_toml: str, body: str) -> str:
    """Produce the final agent TOML. Edits the EXISTING document in place
    (tomlkit) so unknown keys/comments/formatting are preserved; a fresh file
    starts from an empty document. Assumes validation already passed."""
    tomlkit = _tomlkit()
    doc = tomlkit.parse(existing_text) if existing_text else tomlkit.document()
    root = codex_skills_root()

    doc["name"] = str(safe.get("name") or "").strip()
    desc = safe.get("description")
    doc["description"] = "" if desc is None else str(desc)

    body_text = body or ""
    if "\n" in body_text:
        try:
            doc["developer_instructions"] = tomlkit.string(body_text, multiline=True)
        except Exception:
            doc["developer_instructions"] = body_text
    else:
        doc["developer_instructions"] = body_text

    for key in ("model", "model_reasoning_effort", "sandbox_mode"):
        val = str(safe.get(key) or "").strip()
        if val:
            doc[key] = val
        elif key in doc:
            del doc[key]

    nick = [str(x) for x in (safe.get("nickname_candidates") or []) if str(x).strip()]
    if nick:
        doc["nickname_candidates"] = nick
    elif "nickname_candidates" in doc:
        del doc["nickname_candidates"]

    # skills.config = mapped names (hub-shaped, enabled) + preserved foreign
    # entries carried over verbatim from the existing document (review M6).
    existing_foreign_items: list = []
    skills_tbl = doc.get("skills") if "skills" in doc else None
    if skills_tbl is not None and "config" in skills_tbl:
        for item in skills_tbl["config"]:
            try:
                entry = item.unwrap()
            except AttributeError:
                entry = dict(item)
            path_str = str(entry.get("path") or "") if isinstance(entry, dict) else ""
            enabled = entry.get("enabled", True) if isinstance(entry, dict) else True
            if not (_name_from_path(path_str, root) is not None and enabled is True):
                existing_foreign_items.append(item)

    names = [str(s).strip() for s in (safe.get("skills") or []) if str(s).strip()]
    if names or existing_foreign_items:
        aot = tomlkit.aot()
        for n in names:
            t = tomlkit.table()
            t["path"] = str(root / n / "SKILL.md")
            t["enabled"] = True
            aot.append(t)
        for item in existing_foreign_items:
            aot.append(item)
        if skills_tbl is None:
            doc["skills"] = tomlkit.table()
            skills_tbl = doc["skills"]
        skills_tbl["config"] = aot
    elif skills_tbl is not None:
        if "config" in skills_tbl:
            del skills_tbl["config"]
        if len(list(skills_tbl.keys())) == 0:
            del doc["skills"]

    # Advanced merge — skipped entirely when the submitted fragment matches the
    # document's current fragment, so an untouched advanced panel preserves the
    # original bytes (incl. comments) of unknown keys.
    submitted = advanced_toml or ""
    try:
        current = advanced_fragment(tomlkit.dumps(doc))
    except ValueError:
        current = ""
    if submitted.strip() != current.strip():
        adv_doc = tomlkit.parse(submitted) if submitted.strip() else tomlkit.document()
        for key in [k for k in list(doc.keys()) if k not in CODEX_MODELED_KEYS]:
            if key not in adv_doc:
                del doc[key]
        for key in adv_doc.keys():
            if key in CODEX_MODELED_KEYS:
                continue  # shadow — already warned in build_frontmatter_view
            doc[key] = adv_doc[key]

    return tomlkit.dumps(doc)


# ─────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────

def validate_codex_agent(frontmatter: dict, body: str,
                         resolve_skill: Callable[[str], tuple[bool, Optional[Path], bool]],
                         skill_is_invocable: Callable[[Path], bool],
                         original_name: Optional[str] = None,
                         existing_names: Optional[set] = None,
                         original_skills: Optional[set] = None,
                         provisioning_for: Optional[Callable[[str], Optional[dict]]] = None) -> dict:
    """Validate a codex frontmatter view + body. Same warning shape and
    error-blocks-save semantics as the claude validator.

    `original_skills` + `provisioning_for` drive the D5 two-phase provisioning
    protocol: a newly-attached (not in `original_skills`) unresolved skill for
    which `provisioning_for` returns a blocking-error detail becomes an error.
    When either is None (display context), unresolved skills stay plain warnings.
    """
    warnings: list[dict] = []

    def err(field, message, value=""):
        warnings.append({"field": field, "level": "error", "message": message, "value": value})

    def warn(field, message, value=""):
        warnings.append({"field": field, "level": "warn", "message": message, "value": value})

    name = str(frontmatter.get("name") or "").strip()
    if not name:
        err("name", "name is required")
    elif not CODEX_SLUG_RE.match(name):
        err("name", "name must match [a-z0-9_-]+", name)
    else:
        others = existing_names or set()
        if original_name is not None:
            others = {n for n in others if n != original_name}
        if name in others:
            err("name", f"another agent named '{name}' already exists in this scope", name)

    desc = frontmatter.get("description")
    if desc is None or (isinstance(desc, str) and not desc.strip()):
        err("description", "description is required")

    if not (body or "").strip():
        err("body", "developer_instructions (the system prompt) is required")

    sandbox = str(frontmatter.get("sandbox_mode") or "").strip()
    if sandbox not in VALID_SANDBOX_MODES:
        err("sandbox_mode",
            "sandbox_mode must be read-only, workspace-write or danger-full-access",
            sandbox)

    effort = str(frontmatter.get("model_reasoning_effort") or "").strip()
    if effort not in KNOWN_REASONING_EFFORTS:
        warn("model_reasoning_effort", f"unknown reasoning effort '{effort}'", effort)

    nick = frontmatter.get("nickname_candidates")
    if nick is not None and not (
        isinstance(nick, (list, tuple))
        and all(isinstance(x, str) or isinstance(x, (int, float)) for x in nick)
    ):
        err("nickname_candidates", "nickname_candidates must be a list of strings",
            str(nick))

    skills = frontmatter.get("skills") or []
    for skill_name in [str(s).strip() for s in skills if str(s).strip()]:
        resolved, md, project_only = resolve_skill(skill_name)
        if resolved and md is not None:
            if not skill_is_invocable(md):
                err("skills",
                    f"skill '{skill_name}' sets disable-model-invocation: true and cannot be preloaded",
                    skill_name)
            continue
        # Unresolved. A newly-attached registry skill in a SAVE context becomes a
        # blocking provisioning error (design D5).
        newly = original_skills is not None and skill_name not in original_skills
        prov = provisioning_for(skill_name) if (newly and provisioning_for) else None
        if prov is not None:
            warnings.append(prov)
        elif project_only:
            warn("skills", f"skill '{skill_name}' is only present in a project, not the user scope",
                 skill_name)
        else:
            warn("skills", f"skill '{skill_name}' does not resolve in this scope", skill_name)

    valid = not any(w["level"] == "error" for w in warnings)
    return {"valid": valid, "warnings": warnings}
