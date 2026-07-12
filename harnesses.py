"""Harness registry — code-side declaration of supported coding harnesses.

A harness is a runtime that consumes the skills Skill Hub syncs (Claude Code,
Codex, Pi). Each entry declares its on-disk contract: project-local skills dir,
global skills dir, MCP adapter, and a detection signal so we can identify what
the user has installed on this machine.

Resolution semantics (additive):
    effective(project) = (harnesses_global ∪ project.harnesses) ∩ installed

Adding a new harness is a single dict entry. The Rust side reads this registry
via build-time emission of `emit_schema_json()` (see `build.rs`).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Callable, Iterable, Optional, Protocol


# ─────────────────────────────────────────────────────────────────────────────
# Detection
# ─────────────────────────────────────────────────────────────────────────────


class HarnessDetector(Protocol):
    """A detector returns True iff the harness is installed on this machine.

    Detectors MUST be cheap (a couple of stat() calls at most). They run on
    every `hub harness list` invocation in the CLI and once per app session
    in the Tauri app.
    """

    def __call__(self) -> bool: ...

    # Optional: subclasses expose .dir and .marker for the Rust mirror.


@dataclass(frozen=True)
class DotDirWithMarker:
    """Detect presence by dotdir + an expected sub-marker inside it.

    Dotdir alone is too permissive (a brief experiment leaves a `~/.claude/`
    behind even after uninstall). The marker is a path the harness creates on
    first real use (e.g. `~/.claude/projects/` for Claude Code).
    """

    dir: str       # e.g. "~/.claude"
    marker: str    # e.g. "projects" — relative to dir

    def __call__(self) -> bool:
        base = Path(self.dir).expanduser()
        return base.is_dir() and (base / self.marker).exists()


@dataclass(frozen=True)
class Harness:
    id: str
    label: str
    detect: HarnessDetector
    project_skills_dir: PurePath          # relative to project root
    global_skills_dir: PurePath           # absolute (uses ~)
    mcp_adapter_key: Optional[str]        # identifier into the MCP adapter registry
    legacy_global_skills_dirs: tuple[PurePath, ...] = ()
    permission_adapter_key: Optional[str] = None  # identifier into permission_adapters.ADAPTERS
    root_doc: str = "AGENTS.md"           # canonical root instruction file this harness reads
    # Absolute (uses ~) user-level GLOBAL agent-instruction doc this harness
    # reads for every session (distinct from the per-project root_doc). None ⇒
    # the harness has no user-global instruction file concept. Consumed by the
    # Rust global-doc read/write commands + the Harnesses screen affordance.
    global_doc: Optional[PurePath] = None
    # Absolute (uses ~) user-global MCP config file. None ⇒ no global MCP write
    # for this harness (pi reads project-local .mcp.json only; opencode is
    # project-only). Dispatched by the global-MCP pass in `hub sync`.
    global_mcp_config: Optional[PurePath] = None
    # Sub-agent definition capability (cross-harness-subagents change, D1).
    # These are capability flags + DEFAULT locations only — actual resolution
    # (honoring $CODEX_HOME / $SKILL_HUB_CLAUDE_HOME) lives in subagents.py
    # dispatch; do NOT expanduser these fields directly. None ⇒ the harness has
    # no agent-definition concept and gets no Sub-Agents surface.
    agents_dir: Optional[PurePath] = None          # user-scope agents dir (~)
    project_agents_dir: Optional[PurePath] = None  # relative to project root
    agent_format: Optional[str] = None             # "md" | "toml"


# ─────────────────────────────────────────────────────────────────────────────
# Registry — one entry per supported harness
# ─────────────────────────────────────────────────────────────────────────────


HARNESSES: dict[str, Harness] = {
    "claude-code": Harness(
        id="claude-code",
        label="Claude Code",
        detect=DotDirWithMarker(dir="~/.claude", marker="projects"),
        project_skills_dir=PurePath(".claude/skills"),
        global_skills_dir=PurePath("~/.claude/skills"),
        mcp_adapter_key="claude",
        permission_adapter_key="claude",
        root_doc="CLAUDE.md",  # only Claude Code reads CLAUDE.md
        global_doc=PurePath("~/.claude/CLAUDE.md"),  # user-global instructions
        global_mcp_config=PurePath("~/.claude.json"),  # mcpServers object
        agents_dir=PurePath("~/.claude/agents"),
        project_agents_dir=PurePath(".claude/agents"),
        agent_format="md",
    ),
    "codex": Harness(
        id="codex",
        label="Codex",
        detect=DotDirWithMarker(dir="~/.codex", marker="config.toml"),
        project_skills_dir=PurePath(".agents/skills"),  # shared with pi
        global_skills_dir=PurePath("~/.agents/skills"),
        mcp_adapter_key="codex",
        legacy_global_skills_dirs=(PurePath("~/.codex/skills"),),
        permission_adapter_key="codex",
        global_doc=PurePath("~/.codex/AGENTS.md"),  # user-global instructions
        global_mcp_config=PurePath("~/.codex/config.toml"),  # [mcp_servers.*]
        agents_dir=PurePath("~/.codex/agents"),
        project_agents_dir=PurePath(".codex/agents"),
        agent_format="toml",
    ),
    "pi": Harness(
        id="pi",
        label="Pi",
        detect=DotDirWithMarker(dir="~/.pi", marker="agent"),
        project_skills_dir=PurePath(".agents/skills"),  # shared with codex
        global_skills_dir=PurePath("~/.pi/agent/skills"),
        mcp_adapter_key="claude",  # Pi uses .mcp.json (same as claude-code)
        permission_adapter_key="claude",  # Pi reuses Claude adapter; target path is parameterised on harness id
        # Pi's resource-loader loads a user-global context file from its agent
        # dir (candidates AGENTS.md → CLAUDE.md); AGENTS.md is canonical.
        global_doc=PurePath("~/.pi/agent/AGENTS.md"),
    ),
    "opencode": Harness(
        id="opencode",
        label="opencode",
        # Detection marker is the XDG data dir opencode creates on first run.
        # NOTE: verify dir/marker against a live opencode install before release
        # (auth.json exists once the user has authenticated). The harness model
        # treats a wrong guess as "not installed" — non-destructive.
        detect=DotDirWithMarker(dir="~/.local/share/opencode", marker="auth.json"),
        # opencode discovers skills from .opencode/skills/, .claude/skills/, AND
        # .agents/skills/ (+ the ~ globals), so we target the same shared dir
        # codex/pi already write — sync dedup collapses all three to one symlink.
        project_skills_dir=PurePath(".agents/skills"),  # shared with codex + pi
        global_skills_dir=PurePath("~/.agents/skills"),  # shared with codex global
        mcp_adapter_key="opencode",  # opencode.json `mcp` — not .mcp.json-shaped
        permission_adapter_key="opencode",  # opencode.json `permission.bash`
        root_doc="AGENTS.md",  # opencode follows AGENTS.md (CLAUDE.md fallback)
        # opencode reads a user-global AGENTS.md from its XDG config dir.
        global_doc=PurePath("~/.config/opencode/AGENTS.md"),
    ),
}


# ─────────────────────────────────────────────────────────────────────────────
# Detection + resolution helpers
# ─────────────────────────────────────────────────────────────────────────────


def detect_installed() -> set[str]:
    """Return the set of installed harness ids on this machine."""
    return {h.id for h in HARNESSES.values() if h.detect()}


def resolve_effective(
    project: dict,
    registry: dict,
    installed: Optional[set[str]] = None,
) -> set[str]:
    """Compute the effective harness set for a project.

    `effective(project) = (harnesses_global ∪ project.harnesses) ∩ installed`

    Unknown ids in either list are silently ignored at resolution time
    (sync logs a warning at the call site — kept inert here to keep this
    function pure).
    """
    if installed is None:
        installed = detect_installed()
    global_set = set(registry.get("harnesses_global") or [])
    project_set = set(project.get("harnesses") or [])
    union = global_set | project_set
    known = {h_id for h_id in union if h_id in HARNESSES}
    return known & installed


# ─────────────────────────────────────────────────────────────────────────────
# Schema emission (for the Rust mirror)
# ─────────────────────────────────────────────────────────────────────────────


def emit_schema() -> list[dict]:
    """Serialize HARNESSES to a Rust-friendly structure.

    Output is sorted by `id` for deterministic builds. The Rust side embeds
    this via `include_str!(env!("OUT_DIR")/harnesses.generated.json)`.
    """
    out: list[dict] = []
    for h in sorted(HARNESSES.values(), key=lambda x: x.id):
        detector = h.detect
        if isinstance(detector, DotDirWithMarker):
            detect_payload = {"dir": detector.dir, "marker": detector.marker}
        else:
            # Future detector types — emit only the kind for forward-compat.
            detect_payload = {"dir": None, "marker": None}
        out.append(
            {
                "id": h.id,
                "label": h.label,
                "project_skills_dir": str(h.project_skills_dir),
                "global_skills_dir": str(h.global_skills_dir),
                "mcp_adapter_key": h.mcp_adapter_key,
                "permission_adapter_key": h.permission_adapter_key,
                "root_doc": h.root_doc,
                "global_doc": (
                    str(h.global_doc) if h.global_doc is not None else None
                ),
                "global_mcp_config": (
                    str(h.global_mcp_config) if h.global_mcp_config is not None else None
                ),
                "detect": detect_payload,
                "legacy_global_skills_dirs": [str(p) for p in h.legacy_global_skills_dirs],
                # Sub-agent capability (additive — Rust deserializers without the
                # field ignore it; Wave 2 consumes it for UI gating).
                "agents": {
                    "supported": h.agents_dir is not None,
                    "format": h.agent_format,
                    "agents_dir": str(h.agents_dir) if h.agents_dir is not None else None,
                    "project_agents_dir": (
                        str(h.project_agents_dir) if h.project_agents_dir is not None else None
                    ),
                },
            }
        )
    return out


def emit_schema_json() -> str:
    """JSON-encoded schema with stable key order. Used by build.rs."""
    return json.dumps(emit_schema(), indent=2, sort_keys=True)
