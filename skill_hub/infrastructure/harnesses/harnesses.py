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
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Optional, Protocol

from skill_hub.domain.harnesses.harness_adapter_api import HarnessNativeLayout
from skill_hub.infrastructure.harnesses.harness_bundled_layouts import bundled_layouts

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
    # Static build-time hook mechanism (hooks-surface D4). Describes HOW this
    # harness accepts hooks, NOT whether they're currently enabled (that is the
    # dynamic runtime verdict from harness_probe.py). "command" = command hooks
    # in a settings/config file (claude-code, codex); "plugin" = a plugin/LSP
    # surface not hub-managed in v1 (opencode); "none" = no hook concept (pi v1).
    hook_mechanism: str = "none"                    # "command" | "plugin" | "none"


# ─────────────────────────────────────────────────────────────────────────────
# Registry — one entry per supported harness
# ─────────────────────────────────────────────────────────────────────────────


_HARNESS_LABELS = {
    "claude-code": "Claude Code",
    "codex": "Codex",
    "pi": "Pi",
    "opencode": "opencode",
}


def _from_native_layout(layout: HarnessNativeLayout) -> Harness:
    """Build the host-facing registry entry from an immutable SDK layout."""
    return Harness(
        id=layout.id,
        label=_HARNESS_LABELS[layout.id],
        detect=DotDirWithMarker(dir=layout.detector_dir, marker=layout.detector_marker),
        project_skills_dir=PurePath(layout.project_skills_dir),
        global_skills_dir=PurePath(layout.global_skills_dir),
        mcp_adapter_key=layout.mcp_adapter_key,
        legacy_global_skills_dirs=tuple(PurePath(path) for path in layout.legacy_global_skills_dirs),
        permission_adapter_key=layout.permission_adapter_key,
        root_doc=layout.root_doc,
        global_doc=PurePath(layout.global_doc) if layout.global_doc is not None else None,
        global_mcp_config=(
            PurePath(layout.global_mcp_config) if layout.global_mcp_config is not None else None
        ),
        agents_dir=PurePath(layout.agents_dir) if layout.agents_dir is not None else None,
        project_agents_dir=(
            PurePath(layout.project_agents_dir) if layout.project_agents_dir is not None else None
        ),
        agent_format=layout.agent_format,
        hook_mechanism=layout.hook_mechanism,
    )


HARNESSES: dict[str, Harness] = {
    layout.id: _from_native_layout(layout) for layout in bundled_layouts()
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
                # Static build-time hook mechanism (hooks-surface D4). Distinct
                # from the dynamic runtime verdicts in harness_probe.py: this only
                # says HOW the harness accepts hooks, not whether it's enabled.
                "hooks": {"mechanism": h.hook_mechanism},
            }
        )
    return out


def emit_schema_json() -> str:
    """JSON-encoded schema with stable key order. Used by build.rs."""
    return json.dumps(emit_schema(), indent=2, sort_keys=True)
