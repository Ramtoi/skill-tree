"""Contract tests for the SDK-native harness layout records."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from skill_hub.infrastructure.harnesses import harnesses
from skill_hub.infrastructure.harnesses.harness_bundled_layouts import bundled_layout, bundled_layouts

EXPECTED = {
    "claude-code": {
        "project_skills_dir": ".claude/skills",
        "global_skills_dir": "~/.claude/skills",
        "detector_dir": "~/.claude",
        "detector_marker": "projects",
        "mcp_adapter_key": "claude",
        "legacy_global_skills_dirs": (),
        "permission_adapter_key": "claude",
        "root_doc": "CLAUDE.md",
        "global_doc": "~/.claude/CLAUDE.md",
        "global_mcp_config": "~/.claude.json",
        "agents_dir": "~/.claude/agents",
        "project_agents_dir": ".claude/agents",
        "agent_format": "md",
        "hook_mechanism": "command",
    },
    "codex": {
        "project_skills_dir": ".agents/skills",
        "global_skills_dir": "~/.agents/skills",
        "detector_dir": "~/.codex",
        "detector_marker": "config.toml",
        "mcp_adapter_key": "codex",
        "legacy_global_skills_dirs": ("~/.codex/skills",),
        "permission_adapter_key": "codex",
        "root_doc": "AGENTS.md",
        "global_doc": "~/.codex/AGENTS.md",
        "global_mcp_config": "~/.codex/config.toml",
        "agents_dir": "~/.codex/agents",
        "project_agents_dir": ".codex/agents",
        "agent_format": "toml",
        "hook_mechanism": "command",
    },
    "pi": {
        "project_skills_dir": ".agents/skills",
        "global_skills_dir": "~/.pi/agent/skills",
        "detector_dir": "~/.pi",
        "detector_marker": "agent",
        "mcp_adapter_key": "claude",
        "legacy_global_skills_dirs": (),
        "permission_adapter_key": "claude",
        "root_doc": "AGENTS.md",
        "global_doc": "~/.pi/agent/AGENTS.md",
        "global_mcp_config": None,
        "agents_dir": None,
        "project_agents_dir": None,
        "agent_format": None,
        "hook_mechanism": "none",
    },
    "opencode": {
        "project_skills_dir": ".agents/skills",
        "global_skills_dir": "~/.agents/skills",
        "detector_dir": "~/.local/share/opencode",
        "detector_marker": "auth.json",
        "mcp_adapter_key": "opencode",
        "legacy_global_skills_dirs": (),
        "permission_adapter_key": "opencode",
        "root_doc": "AGENTS.md",
        "global_doc": "~/.config/opencode/AGENTS.md",
        "global_mcp_config": None,
        "agents_dir": None,
        "project_agents_dir": None,
        "agent_format": None,
        "hook_mechanism": "plugin",
    },
}


@pytest.mark.parametrize("harness_id", EXPECTED)
def test_bundled_layout_literals(harness_id: str) -> None:
    layout = bundled_layout(harness_id)
    assert layout.id == harness_id
    for field, expected in EXPECTED[harness_id].items():
        assert getattr(layout, field) == expected


def test_layout_records_are_immutable_and_ordered() -> None:
    assert [layout.id for layout in bundled_layouts()] == list(EXPECTED)
    layout = bundled_layout("codex")
    with pytest.raises(FrozenInstanceError):
        layout.global_skills_dir = "~/.other"  # type: ignore[misc]
    with pytest.raises(TypeError):
        layout.legacy_global_skills_dirs[0] = "~/.other"  # type: ignore[index]


def test_unknown_layout_has_clear_error() -> None:
    with pytest.raises(ValueError, match="unknown harness layout"):
        bundled_layout("future-harness")


def test_host_registry_is_built_from_layouts_without_literal_drift() -> None:
    for harness_id, expected in EXPECTED.items():
        host = harnesses.HARNESSES[harness_id]
        layout = bundled_layout(harness_id)
        assert host.label in {"Claude Code", "Codex", "Pi", "opencode"}
        assert host.project_skills_dir.as_posix() == layout.project_skills_dir
        assert host.global_skills_dir.as_posix() == layout.global_skills_dir
        assert host.detect.dir == layout.detector_dir
        assert host.detect.marker == layout.detector_marker
        legacy = tuple(path.as_posix() for path in host.legacy_global_skills_dirs)
        assert legacy == expected["legacy_global_skills_dirs"]


def test_layout_codec_imports_with_sdk_only_modules(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    (tmp_path / "skill_hub/domain/harnesses/harness_adapter_api.py").parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(
        root / "skill_hub/domain/harnesses/harness_adapter_api.py",
        tmp_path / "skill_hub/domain/harnesses/harness_adapter_api.py",
    )
    (tmp_path / "skill_hub/infrastructure/harnesses/harness_bundled_layouts.py").parent.mkdir(
        parents=True, exist_ok=True
    )
    shutil.copy2(
        root / "skill_hub/infrastructure/harnesses/harness_bundled_layouts.py",
        tmp_path / "skill_hub/infrastructure/harnesses/harness_bundled_layouts.py",
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(tmp_path)
    completed = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            "from skill_hub.infrastructure.harnesses.harness_bundled_layouts import bundled_layout; "
            "assert bundled_layout('codex').global_skills_dir == '~/.agents/skills'",
        ],
        cwd=tmp_path,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr


def test_emitted_schema_matches_independent_native_contract(monkeypatch):
    from pathlib import PurePath

    monkeypatch.setattr(harnesses, "HARNESSES", {
        layout.id: harnesses._from_native_layout(layout) for layout in bundled_layouts()
    })
    labels = {"claude-code": "Claude Code", "codex": "Codex", "pi": "Pi", "opencode": "opencode"}
    rows = []
    for harness_id, fields in sorted(EXPECTED.items()):
        def path(field):
            value = fields[field]
            return str(PurePath(value)) if value is not None else None

        rows.append({
            "id": harness_id, "label": labels[harness_id],
            "project_skills_dir": path("project_skills_dir"),
            "global_skills_dir": path("global_skills_dir"),
            "mcp_adapter_key": fields["mcp_adapter_key"],
            "permission_adapter_key": fields["permission_adapter_key"],
            "root_doc": fields["root_doc"], "global_doc": path("global_doc"),
            "global_mcp_config": path("global_mcp_config"),
            "detect": {"dir": fields["detector_dir"], "marker": fields["detector_marker"]},
            "legacy_global_skills_dirs": [str(PurePath(value)) for value in fields["legacy_global_skills_dirs"]],
            "agents": {
                "supported": fields["agents_dir"] is not None, "format": fields["agent_format"],
                "agents_dir": path("agents_dir"), "project_agents_dir": path("project_agents_dir"),
            },
            "hooks": {"mechanism": fields["hook_mechanism"]},
        })
    assert harnesses.emit_schema() == rows
