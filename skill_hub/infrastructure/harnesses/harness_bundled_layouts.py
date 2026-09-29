"""Bundled native harness layouts.

The records here are SDK data only.  Home expansion, filesystem detection, and
user-facing labels remain responsibilities of the host ``harnesses`` module.
"""

from __future__ import annotations

from typing import Mapping

from skill_hub.domain.harnesses.harness_adapter_api import HarnessNativeLayout

_LAYOUTS: Mapping[str, HarnessNativeLayout] = {
    "claude-code": HarnessNativeLayout(
        id="claude-code",
        project_skills_dir=".claude/skills",
        global_skills_dir="~/.claude/skills",
        detector_dir="~/.claude",
        detector_marker="projects",
        mcp_adapter_key="claude",
        permission_adapter_key="claude",
        root_doc="CLAUDE.md",
        global_doc="~/.claude/CLAUDE.md",
        global_mcp_config="~/.claude.json",
        agents_dir="~/.claude/agents",
        project_agents_dir=".claude/agents",
        agent_format="md",
        hook_mechanism="command",
    ),
    "codex": HarnessNativeLayout(
        id="codex",
        project_skills_dir=".agents/skills",
        global_skills_dir="~/.agents/skills",
        detector_dir="~/.codex",
        detector_marker="config.toml",
        mcp_adapter_key="codex",
        legacy_global_skills_dirs=("~/.codex/skills",),
        permission_adapter_key="codex",
        global_doc="~/.codex/AGENTS.md",
        global_mcp_config="~/.codex/config.toml",
        agents_dir="~/.codex/agents",
        project_agents_dir=".codex/agents",
        agent_format="toml",
        hook_mechanism="command",
    ),
    "pi": HarnessNativeLayout(
        id="pi",
        project_skills_dir=".agents/skills",
        global_skills_dir="~/.pi/agent/skills",
        detector_dir="~/.pi",
        detector_marker="agent",
        mcp_adapter_key="claude",
        permission_adapter_key="claude",
        global_doc="~/.pi/agent/AGENTS.md",
    ),
    "opencode": HarnessNativeLayout(
        id="opencode",
        project_skills_dir=".agents/skills",
        global_skills_dir="~/.agents/skills",
        detector_dir="~/.local/share/opencode",
        detector_marker="auth.json",
        mcp_adapter_key="opencode",
        permission_adapter_key="opencode",
        root_doc="AGENTS.md",
        global_doc="~/.config/opencode/AGENTS.md",
        hook_mechanism="plugin",
    ),
}


def bundled_layout(harness_id: str) -> HarnessNativeLayout:
    """Return the immutable layout for ``harness_id``."""
    try:
        return _LAYOUTS[harness_id]
    except KeyError as exc:
        raise ValueError(f"unknown harness layout: {harness_id!r}") from exc


def bundled_layouts() -> tuple[HarnessNativeLayout, ...]:
    """Return all bundled layouts in the registry's stable declaration order."""
    return tuple(_LAYOUTS.values())
