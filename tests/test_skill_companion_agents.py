from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import yaml

import hub
import skill_hub.entrypoints.cli.companions as companions
from skill_hub import hub_core
from skill_hub.application.skills import ships_with_reconcile as swr
from skill_hub.domain.skills import ships_with
from skill_hub.infrastructure.harnesses import subagent_links, subagents

AGENT = """---
name: worker
description: Old description
tier: planner
custom_field: keep me
harnesses:
  codex:
    model: ""
    model_reasoning_effort: medium
---
Shared body.
"""


def _fixture(tmp_path: Path, tmp_data_home: Path) -> tuple[Path, dict]:
    skill_dir = tmp_path / "demo"
    (skill_dir / "agents").mkdir(parents=True)
    (skill_dir / "agents" / "worker.md").write_text(AGENT)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo\nships_with:\n  agents: [worker]\n---\nBody\n"
    )
    registry = {
        "skills": {"demo": {"type": "claude-skill", "source": str(skill_dir)}},
        "projects": {},
        "harnesses_global": ["claude-code", "codex", "pi"],
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    return skill_dir, registry


def test_renderer_uses_explicit_empty_and_unknown_source_fields(tmp_path):
    skill_dir = tmp_path / "demo"
    (skill_dir / "agents").mkdir(parents=True)
    (skill_dir / "agents" / "worker.md").write_text(AGENT)
    registry = {"skills": {"demo": {"type": "claude-skill", "source": str(skill_dir)}}}

    claude = ships_with.render_agent_payload("demo", "worker", "claude-code", registry)
    codex = ships_with.render_agent_payload("demo", "worker", "codex", registry)
    assert claude["safe"]["model"] == "opus"
    # Native Claude/Codex serializers omit an empty model to represent
    # session inheritance; the source read contract expands it to "".
    assert "model" not in codex["safe"]
    assert codex["safe"]["model_reasoning_effort"] == "medium"


def test_source_agent_rejects_agents_directory_symlink_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "worker.md").write_text(AGENT)
    skill_dir = tmp_path / "demo"
    skill_dir.mkdir()
    (skill_dir / "agents").symlink_to(outside, target_is_directory=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\nships_with:\n  agents: [worker]\n---\nBody\n"
    )
    registry = {"skills": {"demo": {"type": "claude-skill", "source": str(skill_dir)}}}
    payload = companions._agent_read_payload("demo", "worker", registry)
    assert payload["ok"] is False
    assert "outside" in payload["error"]


def test_cli_agent_read_is_wired_through_hub_main(tmp_path, tmp_data_home, monkeypatch, capsys):
    _fixture(tmp_path, tmp_data_home)
    monkeypatch.setattr(
        sys,
        "argv",
        ["hub", "skill", "companions", "agent", "demo", "--agent", "worker", "--json"],
    )
    hub.main()
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["editable"] is True
    assert payload["harnesses"]["claude-code"]["model"] == "opus"
    assert payload["harnesses"]["codex"]["model"] == ""


def test_save_preserves_unknown_frontmatter_and_rejects_stale_hash(tmp_path, tmp_data_home, capsys):
    skill_dir, registry = _fixture(tmp_path, tmp_data_home)
    current = companions._agent_read_payload("demo", "worker", registry)
    body = {
        "expected_hash": current["hash"],
        "description": "New description",
        "body": "New shared body.",
        "harnesses": {
            "claude-code": {"model": "claude-custom"},
            "codex": {"model": "gpt-custom", "model_reasoning_effort": ""},
        },
    }
    companions.cmd_companions_save_agent(
        type("Args", (), {"name": "demo", "agent": "worker", "json_body": json.dumps(body)})()
    )
    first = json.loads(capsys.readouterr().out)
    assert first["ok"] is True
    saved = subagents.parse_agent((skill_dir / "agents" / "worker.md").read_text())
    assert saved["frontmatter"]["custom_field"] == "keep me"
    assert saved["frontmatter"]["harnesses"]["codex"]["model"] == "gpt-custom"
    assert saved["frontmatter"]["harnesses"]["codex"]["model_reasoning_effort"] == ""

    stale = dict(body)
    stale["expected_hash"] = current["hash"]
    companions.cmd_companions_save_agent(
        type("Args", (), {"name": "demo", "agent": "worker", "json_body": json.dumps(stale)})()
    )
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is False and result["conflict"] is True


def _provisioned_fixture(tmp_path: Path, tmp_data_home: Path, monkeypatch):
    skill_dir, registry = _fixture(tmp_path, tmp_data_home)
    home = tmp_path / "home"
    claude = home / ".claude"
    codex = home / ".codex"
    (claude / "agents").mkdir(parents=True)
    (codex / "agents").mkdir(parents=True)
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    written = {}
    for hid in ("claude-code", "codex"):
        result = subagents.save_agent(
            ships_with.render_agent_payload("demo", "worker", hid, registry), registry
        )
        assert result["ok"], result
        written[hid] = {
            "sha256": swr.agent_file_sha256(Path(result["file"])),
            "written": True,
        }
    source_hash = swr.agent_file_sha256(skill_dir / "agents" / "worker.md")
    registry["companions_global"] = {
        "demo": {
            "agents": ["worker"],
            "agent_state": {"worker": {"source_sha256": source_hash, "files": written}},
        }
    }
    hub_core.save_registry(registry)
    return skill_dir, registry, claude / "agents" / "worker.md", codex / "agents" / "worker.toml"


def test_save_reconciles_clean_owned_native_files(tmp_path, tmp_data_home, monkeypatch, capsys):
    skill_dir, _registry, claude_file, codex_file = _provisioned_fixture(
        tmp_path, tmp_data_home, monkeypatch
    )
    monkeypatch.setattr(companions, "_operation_context_for_args", lambda args, registry: None)
    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    body = {
        "expected_hash": opened["hash"],
        "description": "Changed description",
        "body": "Changed shared body.",
        "harnesses": {
            "claude-code": {"model": "claude-custom"},
            "codex": {"model": "gpt-5.6-custom", "model_reasoning_effort": "low"},
        },
    }
    companions.cmd_companions_save_agent(
        type("Args", (), {"name": "demo", "agent": "worker", "json_body": json.dumps(body)})()
    )
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True
    assert len(result["reconcile"]["updated"]) == 2
    assert subagents.parse_agent(claude_file.read_text())["frontmatter"]["model"] == "claude-custom"
    assert "Changed shared body." in claude_file.read_text()
    codex_doc = subagents._codex().parse_codex_agent(codex_file.read_text())
    assert codex_doc["frontmatter"]["model"] == "gpt-5.6-custom"
    assert codex_doc["frontmatter"]["model_reasoning_effort"] == "low"
    assert "Changed shared body." in codex_file.read_text()
    assert "custom_field: keep me" in (skill_dir / "agents" / "worker.md").read_text()


def test_save_does_not_overwrite_drifted_native_copy(tmp_path, tmp_data_home, monkeypatch, capsys):
    _skill_dir, _registry, claude_file, codex_file = _provisioned_fixture(
        tmp_path, tmp_data_home, monkeypatch
    )
    original_claude = claude_file.read_text()
    claude_file.write_text(original_claude + "\nManual native edit.\n")
    monkeypatch.setattr(companions, "_operation_context_for_args", lambda args, registry: None)
    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    body = {
        "expected_hash": opened["hash"],
        "description": "Changed description",
        "body": "Changed shared body.",
        "harnesses": {
            "claude-code": {"model": "claude-custom"},
            "codex": {"model": "gpt-5.6-custom", "model_reasoning_effort": "low"},
        },
    }
    companions.cmd_companions_save_agent(
        type("Args", (), {"name": "demo", "agent": "worker", "json_body": json.dumps(body)})()
    )
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True
    assert result["reconcile"]["drift"]
    assert "Manual native edit." in claude_file.read_text()
    assert "Changed shared body." in codex_file.read_text()


def _linked_multi_claim_fixture(tmp_path: Path, tmp_data_home: Path, monkeypatch):
    skill_dir, registry, claude_file, codex_file = _provisioned_fixture(
        tmp_path, tmp_data_home, monkeypatch
    )
    link = subagent_links.link_agents("worker", ["claude-code", "codex"], "user", None)
    assert link["ok"], link
    baseline = copy.deepcopy(registry["companions_global"]["demo"])
    for project_name in ("alpha", "beta"):
        project_path = tmp_path / project_name
        project_path.mkdir()
        registry.setdefault("projects", {})[project_name] = {
            "path": str(project_path),
            "enabled": ["demo"],
            "bundles": [],
            "harnesses": [],
            "companions": {"demo": copy.deepcopy(baseline)},
        }
    hub_core.save_registry(registry)
    return skill_dir, claude_file, codex_file


def _save_body(
    opened: dict,
    *,
    description: str,
    body: str,
    claude: str,
    codex: str,
    reasoning: str = "low",
) -> dict:
    return {
        "expected_hash": opened["hash"],
        "description": description,
        "body": body,
        "harnesses": {
            "claude-code": {"model": claude},
            "codex": {"model": codex, "model_reasoning_effort": reasoning},
        },
    }


def test_legacy_save_keeps_tier_defaults_omitted_until_changed(
    tmp_path, tmp_data_home, monkeypatch, capsys
):
    skill_dir, _registry = _fixture(tmp_path, tmp_data_home)
    legacy = AGENT.replace(
        "harnesses:\n  codex:\n    model: \"\"\n    model_reasoning_effort: medium\n", ""
    )
    (skill_dir / "agents" / "worker.md").write_text(legacy)
    monkeypatch.setattr(companions, "_operation_context_for_args", lambda args, registry: None)
    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    args = type("Args", (), {"name": "demo", "agent": "worker", "json_body": ""})()
    args.json_body = json.dumps(
        _save_body(
            opened,
            description=opened["description"],
            body="Body-only update.",
            claude=opened["harnesses"]["claude-code"]["model"],
            codex=opened["harnesses"]["codex"]["model"],
            reasoning=opened["harnesses"]["codex"]["model_reasoning_effort"],
        )
    )
    companions.cmd_companions_save_agent(args)
    assert json.loads(capsys.readouterr().out)["ok"] is True
    saved = subagents.parse_agent((skill_dir / "agents" / "worker.md").read_text())
    assert "harnesses" not in saved["frontmatter"]

    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    args.json_body = json.dumps(
        _save_body(
            opened,
            description=opened["description"],
            body="Model update.",
            claude="claude-custom",
            codex=opened["harnesses"]["codex"]["model"],
            reasoning=opened["harnesses"]["codex"]["model_reasoning_effort"],
        )
    )
    companions.cmd_companions_save_agent(args)
    assert json.loads(capsys.readouterr().out)["ok"] is True
    saved = subagents.parse_agent((skill_dir / "agents" / "worker.md").read_text())
    assert saved["frontmatter"]["harnesses"] == {"claude-code": {"model": "claude-custom"}}


def _assert_claim_hashes_match_native() -> None:
    registry = hub_core.load_registry()
    claude = subagents._find_agent_file("worker", "user", None, registry, "claude-code")
    codex = subagents._find_agent_file("worker", "user", None, registry, "codex")
    assert claude is not None and codex is not None
    actual = {
        "claude-code": swr.agent_file_sha256(claude),
        "codex": swr.agent_file_sha256(codex),
    }
    for _scope, container in ships_with.ledger_scopes(registry):
        files = container["demo"]["agent_state"]["worker"]["files"]
        assert all(files[hid]["sha256"] == digest for hid, digest in actual.items())


def test_repeated_linked_saves_update_every_project_claim(tmp_path, tmp_data_home, monkeypatch, capsys):
    _skill_dir, _claude_file, _codex_file = _linked_multi_claim_fixture(
        tmp_path, tmp_data_home, monkeypatch
    )
    monkeypatch.setattr(companions, "_operation_context_for_args", lambda args, registry: None)
    args = type("Args", (), {"name": "demo", "agent": "worker", "json_body": ""})()
    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    args.json_body = json.dumps(
        _save_body(
            opened,
            description="First save",
            body="First shared body.",
            claude="claude-first",
            codex="gpt-5.6-first",
        )
    )
    companions.cmd_companions_save_agent(args)
    first = json.loads(capsys.readouterr().out)
    assert first["ok"] and len(first["reconcile"]["updated"]) == 6
    _assert_claim_hashes_match_native()

    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    args.json_body = json.dumps(
        _save_body(
            opened,
            description="Second save",
            body="Second shared body.",
            claude="claude-second",
            codex="gpt-5.6-second",
        )
    )
    companions.cmd_companions_save_agent(args)
    second = json.loads(capsys.readouterr().out)
    assert second["ok"] and len(second["reconcile"]["updated"]) == 6
    _assert_claim_hashes_match_native()


def test_linked_drift_preserves_both_native_files(tmp_path, tmp_data_home, monkeypatch, capsys):
    _skill_dir, claude_file, codex_file = _linked_multi_claim_fixture(
        tmp_path, tmp_data_home, monkeypatch
    )
    claude_file.write_text(claude_file.read_text() + "\nManual linked edit.\n")
    codex_before = codex_file.read_bytes()
    monkeypatch.setattr(companions, "_operation_context_for_args", lambda args, registry: None)
    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    args = type(
        "Args",
        (),
        {
            "name": "demo",
            "agent": "worker",
            "json_body": json.dumps(
                _save_body(
                    opened,
                    description="Drift save",
                    body="Must not overwrite twins.",
                    claude="claude-drift",
                    codex="gpt-5.6-drift",
                )
            ),
        },
    )()
    companions.cmd_companions_save_agent(args)
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] and result["reconcile"]["drift"]
    assert "Manual linked edit." in claude_file.read_text()
    assert codex_file.read_bytes() == codex_before


def test_read_only_source_refuses_save(tmp_path, tmp_data_home, capsys):
    skill_dir, registry = _fixture(tmp_path, tmp_data_home)
    registry["skills"]["demo"]["managed"] = "starter"
    hub_core.save_registry(registry)
    before = (skill_dir / "agents" / "worker.md").read_bytes()
    opened = companions._agent_read_payload("demo", "worker", registry)
    assert opened["ok"] and opened["editable"] is False
    args = type(
        "Args",
        (),
        {
            "name": "demo",
            "agent": "worker",
            "json_body": json.dumps(
                _save_body(opened, description="x", body="y", claude="x", codex="y")
            ),
        },
    )()
    companions.cmd_companions_save_agent(args)
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is False and "read-only" in result["error"]
    assert (skill_dir / "agents" / "worker.md").read_bytes() == before


def test_source_save_reports_reconcile_exception_after_source_write(
    tmp_path, tmp_data_home, monkeypatch, capsys
):
    skill_dir, _registry = _fixture(tmp_path, tmp_data_home)
    opened = companions._agent_read_payload("demo", "worker", hub_core.load_registry())
    args = type(
        "Args",
        (),
        {
            "name": "demo",
            "agent": "worker",
            "json_body": json.dumps(
                _save_body(opened, description="saved", body="saved body", claude="x", codex="y")
            ),
        },
    )()
    monkeypatch.setattr(
        companions,
        "_operation_context_for_args",
        lambda args, registry: (_ for _ in ()).throw(RuntimeError("context unavailable")),
    )
    companions.cmd_companions_save_agent(args)
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True and result["source_saved"] is True
    assert result["reconcile"]["ok"] is False
    assert "context unavailable" in str(result["reconcile"]["errors"])
    assert "saved body" in (skill_dir / "agents" / "worker.md").read_text()
