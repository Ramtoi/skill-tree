"""Desktop policy follows canonical projects and captured installed participants."""

import argparse
import json
import sys

import hub
from skill_hub import hub_core
from skill_hub.entrypoints.cli import agent_docs as cli
from skill_hub.infrastructure.harnesses import harnesses


def test_policy_parser_matches_registered_symlink(tmp_data_home, tmp_path, monkeypatch, capsys):
    real = tmp_path / "project"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"demo": {"path": str(alias), "agent_docs": {"root_strategy": "import"}}},
    }
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"claude-code"})
    rows = []
    for path in (alias, real):
        monkeypatch.setattr(sys, "argv", ["hub", "agent-docs", "policy", "--project-path", str(path), "--json"])
        hub.main()
        rows.append(json.loads(capsys.readouterr().out))
    assert rows[0] == rows[1]
    assert rows[1]["strategy"] == "import"


def test_policy_parser_excludes_configured_absent_harness(tmp_data_home, tmp_path, monkeypatch, capsys):
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"demo": {"path": str(tmp_path), "harnesses": ["codex"]}},
    }
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    calls = []

    def installed():
        calls.append(True)
        return {"claude-code"}

    monkeypatch.setattr(harnesses, "detect_installed", installed)
    monkeypatch.setattr(sys, "argv", ["hub", "agent-docs", "policy", "--project-path", str(tmp_path), "--json"])
    hub.main()
    row = json.loads(capsys.readouterr().out)
    assert not row["requires_agent"]
    assert row["requires_claude"]
    assert row["agent_harnesses"] == []
    assert row["claude_harnesses"] == ["claude-code"]
    assert len(calls) == 1


def test_supplied_policy_context_never_redetects(tmp_data_home, tmp_path, monkeypatch, capsys):
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context

    registry = {"harnesses_global": ["claude-code", "codex"]}
    context = build_operation_context(
        tmp_data_home, ("claude-code", "codex"), requested_features=("agent_docs",),
        installed_harness_ids=("claude-code",),
    )
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)

    def unexpected():
        raise AssertionError("supplied context must not detect installed harnesses")

    monkeypatch.setattr(harnesses, "detect_installed", unexpected)
    cli.cmd_agent_docs_policy(argparse.Namespace(project_path=str(tmp_path), json=True, _operation_context=context))
    row = json.loads(capsys.readouterr().out)
    assert row["requires_claude"]
    assert not row["requires_agent"]
    assert row["agent_harnesses"] == []
