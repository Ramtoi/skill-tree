"""Tests for the `hub skill companions` CLI slice (W2 of the ships-with-2
orchestration workspace, milestone 5, plan 1): the I5 read (`cmd_skill_companions`,
extended for `state`/`reason`/`route`/`summary`/`project_context`), the I6
whole-block `set`/`add`/`remove` transaction, the I9 `resolve` verb, the
`run_reconcile_pass` sync wiring (A16/W8), and A22's bundle-only-skip on
`hub enable --with-companions`.

Fixture: the same `orchestrate-advanced`-shaped skill
`tests/test_ships_with_cli.py` uses (two agents, one hook whose command is a
script inside the skill dir, a deny/ask permission pair) — built fresh here so
this file owns its own on-disk environment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

import pytest
import yaml

import hub
from skill_hub import hub_core
from skill_hub.domain.skills import ships_with
from skill_hub.entrypoints.cli import companions
from skill_hub.infrastructure.harnesses import harness_probe

AGENT_IMPLEMENTER_MD = """\
---
name: orch-implementer
description: Implements one chunk of the plan.
tier: worker
tools: [Read, Edit, Write, Bash]
---
You implement one chunk at a time.
"""

AGENT_REVIEWER_MD = """\
---
name: orch-reviewer
description: Reviews one chunk of the plan.
tier: planner
tools: [Read]
---
You review one chunk at a time.
"""

SHIPS_WITH_YAML = """\
ships_with:
  agents: [orch-implementer, orch-reviewer]
  hooks:
    - name: orch-scope-guard
      event: PreToolUse
      tools: [Edit, Write, MultiEdit]
      command: scripts/scope-guard.sh
      activation: while-running
  permissions:
    deny: ["Bash(git push --force:*)"]
    ask: ["Bash(gh pr merge:*)"]
"""


def _skill_md(name: str = "orchestrate-advanced", ships_with_yaml: str = SHIPS_WITH_YAML) -> str:
    return (
        "---\n"
        f"name: {name}\n"
        "description: Deep orchestrator with a chunk contract and two runners.\n"
        f"{ships_with_yaml}"
        "---\n"
        "Body.\n"
    )


def _write_skill_dir(root: Path, name: str = "orchestrate-advanced") -> Path:
    d = root / name
    (d / "agents").mkdir(parents=True)
    (d / "scripts").mkdir(parents=True)
    (d / "agents" / "orch-implementer.md").write_text(AGENT_IMPLEMENTER_MD)
    (d / "agents" / "orch-reviewer.md").write_text(AGENT_REVIEWER_MD)
    (d / "scripts" / "scope-guard.sh").write_text("#!/bin/sh\nexit 0\n")
    (d / "SKILL.md").write_text(_skill_md(name))
    return d


def _seed_probe_cache(data_home: Path, harnesses_ids=("claude-code", "codex")) -> None:
    cache = {
        hid: harness_probe.HookCapability(harness_id=hid, verdict="supported", reason="ok")
        for hid in harnesses_ids
    }
    harness_probe.save_cache(cache, data_home)


@pytest.fixture
def cli_env(tmp_path, monkeypatch, tmp_data_home):
    """Two harnesses (claude-code + codex) installed, one project, one
    ships_with skill on disk, and a harness-probe cache marking both
    'supported' so `plan_provision` never spawns the real binaries."""
    home = tmp_path / "home"
    claude = home / ".claude"
    codex = home / ".codex"
    (claude / "projects").mkdir(parents=True)
    (claude / "agents").mkdir(parents=True)
    (codex / "agents").mkdir(parents=True)
    (codex / "config.toml").write_text("")

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))

    skill_dir = _write_skill_dir(tmp_path / "skills")
    proj_path = tmp_path / "proj"
    proj_path.mkdir()

    registry = {
        "harnesses_global": ["claude-code", "codex"],
        "skills": {
            "orchestrate-advanced": {
                "type": "claude-skill",
                "scope": "portable",
                "source": str(skill_dir),
                "description": "x",
            }
        },
        "projects": {
            "notes-vault": {
                "path": str(proj_path),
                "enabled": [],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    _seed_probe_cache(tmp_data_home)

    hub._DATA_HOME_CACHE = None
    return {
        "home": home,
        "tmp_path": tmp_path,
        "skill_dir": skill_dir,
        "proj_path": proj_path,
        "claude_agents": claude / "agents",
        "codex_agents": codex / "agents",
        "data_home": tmp_data_home,
    }


# D17 (plan 1, ships-with-3) — the bigger on-disk `orchestrate-advanced`
# fixture (6 agents, 3 hooks, 2 permission buckets) that
# `tests/test_ships_with_cli.py` and the evidence log's `11 provisioned`
# figure are built on. Copied fresh per test so nothing mutates the checked-
# in fixture tree.
FIXTURE_ORCHESTRATE_ADVANCED = Path(__file__).parent / "fixtures" / "ships_with" / "orchestrate-advanced"


def _write_full_skill_dir(root: Path, name: str = "orchestrate-advanced") -> Path:
    dest = root / name
    shutil.copytree(FIXTURE_ORCHESTRATE_ADVANCED, dest)
    return dest


@pytest.fixture
def cli_env_full(tmp_path, monkeypatch, tmp_data_home):
    """Same two-harness setup as `cli_env`, but the skill is the bigger
    on-disk `orchestrate-advanced` fixture and there are TWO projects
    (`proj-a`, `proj-b`) — the shape the D17 `11 provisioned` / multi-scope
    test tasks need."""
    home = tmp_path / "home"
    claude = home / ".claude"
    codex = home / ".codex"
    (claude / "projects").mkdir(parents=True)
    (claude / "agents").mkdir(parents=True)
    (codex / "agents").mkdir(parents=True)
    (codex / "config.toml").write_text("")

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))

    skill_dir = _write_full_skill_dir(tmp_path / "skills")
    proj_a = tmp_path / "proj-a"
    proj_a.mkdir()
    proj_b = tmp_path / "proj-b"
    proj_b.mkdir()

    registry = {
        "harnesses_global": ["claude-code", "codex"],
        "skills": {
            "orchestrate-advanced": {
                "type": "claude-skill",
                "scope": "portable",
                "source": str(skill_dir),
                "description": "x",
            }
        },
        "projects": {
            "proj-a": {"path": str(proj_a), "enabled": [], "bundles": [], "harnesses": []},
            "proj-b": {"path": str(proj_b), "enabled": [], "bundles": [], "harnesses": []},
        },
        "bundles": {},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    _seed_probe_cache(tmp_data_home)

    hub._DATA_HOME_CACHE = None
    return {
        "home": home,
        "tmp_path": tmp_path,
        "skill_dir": skill_dir,
        "proj_a": proj_a,
        "proj_b": proj_b,
        "claude_agents": claude / "agents",
        "codex_agents": codex / "agents",
        "data_home": tmp_data_home,
    }


def _reload() -> dict:
    hub._DATA_HOME_CACHE = None
    return hub.load_registry()


def _set_args(name: str, body: dict, **overrides) -> argparse.Namespace:
    base = dict(
        target="set", name=name, project=None, global_=False, json=False,
        json_stdin=False, json_body=json.dumps(body), kind=None, item=None,
        rule_kind=None, agent=None, op=None,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def _enable_args(**overrides) -> argparse.Namespace:
    base = dict(
        skill="orchestrate-advanced", project="notes-vault", with_refs=False,
        with_companions=False, skill_only=False, json=False,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def _basic_body(agents=("orch-implementer", "orch-reviewer"), hooks=None, permissions=None) -> dict:
    if hooks is None:
        hooks = [{
            "name": "orch-scope-guard", "event": "PreToolUse",
            "tools": ["Edit", "Write", "MultiEdit"],
            "command": "scripts/scope-guard.sh", "activation": "while-running",
        }]
    if permissions is None:
        permissions = {"allow": [], "deny": ["Bash(git push --force:*)"], "ask": ["Bash(gh pr merge:*)"]}
    return {"agents": [{"name": a} for a in agents], "hooks": hooks, "permissions": permissions}


# ─────────────────────────────────────────────────────────────────────────────
# 17. `set` rewrites the frontmatter and prints the reconcile result first
# ─────────────────────────────────────────────────────────────────────────────


def test_set_rewrites_frontmatter_and_prints_reconcile_first(cli_env, capsys):
    args = _set_args("orchestrate-advanced", _basic_body())
    companions.cmd_companions_set(args)

    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines, "nothing printed"
    payload = json.loads(lines[0])  # must parse standalone
    assert payload["ok"] is True
    assert payload["skill"] == "orchestrate-advanced"
    assert payload["block"]["agents"] == ["orch-implementer", "orch-reviewer"]
    assert "global" in payload["reconcile"]
    assert "projects" in payload["reconcile"]
    assert payload["kept_files"] == []
    assert len(lines) > 1  # the auto-sync tail follows

    reg = _reload()
    assert reg["skills"]["orchestrate-advanced"]["ships_with"]["agents"] == [
        "orch-implementer", "orch-reviewer",
    ]
    assert "ships_with:" in (cli_env["skill_dir"] / "SKILL.md").read_text()


# ─────────────────────────────────────────────────────────────────────────────
# 18. W3 — staged `from:` agent copies land BEFORE validation; a removed
#     agent's file stays on disk and is reported as `kept_files`
# ─────────────────────────────────────────────────────────────────────────────


def test_set_stages_agent_files_before_validation_and_keeps_removed_ones(cli_env, capsys):
    (cli_env["claude_agents"] / "helper-agent.md").write_text(
        "---\nname: helper-agent\ndescription: A helper.\ntools: [Read]\n---\nHelp body.\n"
    )
    body = _basic_body(agents=("orch-implementer",))
    body["agents"].append({"name": "helper-agent", "from": {"harness": "claude-code"}})

    args = _set_args("orchestrate-advanced", body)
    companions.cmd_companions_set(args)
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["block"]["agents"] == ["orch-implementer", "helper-agent"]

    staged = cli_env["skill_dir"] / "agents" / "helper-agent.md"
    assert staged.is_file()
    doc_text = staged.read_text()
    assert "tier: worker" in doc_text
    assert "tools" in doc_text

    kept = payload["kept_files"]
    assert any(k.endswith("orch-reviewer.md") for k in kept)
    assert (cli_env["skill_dir"] / "agents" / "orch-reviewer.md").is_file()


# ─────────────────────────────────────────────────────────────────────────────
# 20. `managed: external` refuses with the invocation-override wording;
#     SKILL.md is byte-identical afterward
# ─────────────────────────────────────────────────────────────────────────────


def test_set_refuses_source_managed_skill(cli_env, capsys):
    reg = _reload()
    reg["skills"]["orchestrate-advanced"]["managed"] = "external"
    reg["skills"]["orchestrate-advanced"]["origin"] = {"source": "org-skills"}
    hub_core.save_registry(reg)

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    args = _set_args("orchestrate-advanced", _basic_body())
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert "external source" in payload["error"]
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original


# ─────────────────────────────────────────────────────────────────────────────
# W4 (ships-with-4, plan 1) — the remote-quarantine predicate reads the
# top-level `origin` string (mirroring `hub._provision_skill`'s working
# guard), not the dead `source`-prefix branch it used to check.
# ─────────────────────────────────────────────────────────────────────────────

REMOTE_QUARANTINE_CORPUS = (
    Path(__file__).parent / "fixtures" / "remote_quarantine_corpus.json"
)


def test_remote_quarantine_id_matches_the_shared_corpus():
    """T4.0 — the Python half of the cross-plan contract: wave 4c's TS twin
    reads this SAME fixture, so the two predicates can never drift."""
    cases = json.loads(REMOTE_QUARANTINE_CORPUS.read_text())["cases"]
    assert cases, "corpus fixture must not be empty"
    for row in cases:
        skill_cfg = {"origin": row["origin"]}
        assert companions._remote_quarantine_id(skill_cfg) == row["remote_id"], row["case"]


def test_companions_set_refused_for_remote_origin_skill(cli_env, capsys):
    """T4.1"""
    reg = _reload()
    reg["skills"]["orchestrate-advanced"]["origin"] = "remote:hermes"
    hub_core.save_registry(reg)

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    args = _set_args("orchestrate-advanced", _basic_body())
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert "hermes" in payload["error"]
    assert "quarantined" in payload["error"]
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original


def test_companions_add_and_remove_refused_for_remote_origin_skill(cli_env, capsys):
    """T4.2 — the refusal covers all three verbs (`set` / `add` / `remove`)."""
    reg = _reload()
    reg["skills"]["orchestrate-advanced"]["origin"] = "remote:hermes"
    hub_core.save_registry(reg)

    add_args = _set_args(
        "orchestrate-advanced", {},
        target="add", kind="agent", item="orch-implementer",
    )
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_add(add_args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert "hermes" in payload["error"]

    rm_args = _set_args(
        "orchestrate-advanced", {},
        target="remove", kind="agent", item="orch-implementer",
    )
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_remove(rm_args)
    assert ei.value.code == 1
    payload2 = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload2["ok"] is False
    assert "hermes" in payload2["error"]


def test_companions_set_allowed_when_origin_is_a_source_dict(cli_env, capsys):
    """T4.3 — a git-sourced skill's `origin` is a DICT
    (`{"source": <id>}`), never the `remote:<id>` STRING the quarantine
    guard looks for, so the two guards stay distinct: this hits the
    external-source refusal (when `managed: external`), never the
    quarantine one."""
    reg = _reload()
    reg["skills"]["orchestrate-advanced"]["managed"] = "external"
    reg["skills"]["orchestrate-advanced"]["origin"] = {"source": "org-skills"}
    hub_core.save_registry(reg)

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    args = _set_args("orchestrate-advanced", _basic_body())
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert "external source" in payload["error"]
    assert "quarantined" not in payload["error"]
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original


# ─────────────────────────────────────────────────────────────────────────────
# 21. A4 — `set` plans/writes from the frontmatter even when the registry
#     mirror has never been synced
# ─────────────────────────────────────────────────────────────────────────────


def test_set_on_a_never_synced_skill_plans_from_frontmatter(cli_env, capsys):
    reg = _reload()
    bare_dir = cli_env["tmp_path"] / "skills" / "bare-skill"
    (bare_dir / "agents").mkdir(parents=True)
    (bare_dir / "scripts").mkdir(parents=True)
    (bare_dir / "agents" / "bare-agent.md").write_text(
        AGENT_IMPLEMENTER_MD.replace("orch-implementer", "bare-agent")
    )
    (bare_dir / "scripts" / "guard.sh").write_text("#!/bin/sh\nexit 0\n")
    (bare_dir / "SKILL.md").write_text("---\nname: bare-skill\ndescription: no ships_with yet.\n---\nBody.\n")
    reg["skills"]["bare-skill"] = {
        "type": "claude-skill", "scope": "portable", "source": str(bare_dir), "description": "x",
    }
    reg["projects"]["notes-vault"]["enabled"].append("bare-skill")
    hub_core.save_registry(reg)
    assert "ships_with" not in reg["skills"]["bare-skill"]  # never mirrored

    body = {
        "agents": [{"name": "bare-agent"}],
        "hooks": [{"name": "bare-hook", "event": "PreToolUse", "command": "scripts/guard.sh", "activation": "always"}],
        "permissions": {"allow": [], "deny": [], "ask": []},
    }
    args = _set_args("bare-skill", body)
    companions.cmd_companions_set(args)
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["block"]["agents"] == ["bare-agent"]

    reg2 = _reload()
    assert reg2["skills"]["bare-skill"]["ships_with"]["agents"] == ["bare-agent"]


# ─────────────────────────────────────────────────────────────────────────────
# 22. Rollback: staged agents removed + SKILL.md restored when the
#     frontmatter write fails after the agent file write
# ─────────────────────────────────────────────────────────────────────────────


def test_set_rollback_restores_skill_md_and_removes_staged_agents(cli_env, capsys, monkeypatch):
    from skill_hub.domain.skills import skill_meta

    (cli_env["claude_agents"] / "helper-agent.md").write_text(
        "---\nname: helper-agent\ndescription: A helper.\ntools: [Read]\n---\nHelp body.\n"
    )
    monkeypatch.setattr(skill_meta, "render_frontmatter_block", lambda *a, **k: None)

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    body = _basic_body()
    body["agents"].append({"name": "helper-agent", "from": {"harness": "claude-code"}})
    args = _set_args("orchestrate-advanced", body)
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert not (cli_env["skill_dir"] / "agents" / "helper-agent.md").exists()
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original


# ─────────────────────────────────────────────────────────────────────────────
# 23. W4 — `render_frontmatter_block` preserves other keys, drops comments
#     inside the replaced block, and handles a `--force:*` pattern
# ─────────────────────────────────────────────────────────────────────────────


def test_render_frontmatter_block_preserves_other_keys_and_drops_comments():
    import re

    from skill_hub.domain.skills import skill_meta

    text = (
        "---\n"
        "name: sample\n"
        "description: A sample skill.\n"
        "ships_with:\n"
        "  permissions:\n"
        '    deny: ["Bash(git push:*)"]  # old rule, replaced below\n'
        "---\n"
        "Body text.\n"
    )
    new_block = {"permissions": {"deny": ["Bash(git push --force:*)"]}}
    new_text = skill_meta.render_frontmatter_block(text, "ships_with", new_block)
    assert new_text is not None
    assert "# old rule" not in new_text
    assert new_text.endswith("Body text.\n")
    # R1/R7(a) — `ships_with:` is the LAST frontmatter key here (the
    # canonical layout). A real fenced-frontmatter shape check, not the
    # naive `split("---", 2)` the old oracle shared with the bug it was
    # supposed to catch: a genuine closing `---` line, newline-terminated,
    # separate from the last content line.
    assert re.match(r"^---\n.*?\n---\n", new_text, re.S), f"no real closing fence: {new_text!r}"

    parsed = skill_meta.parse_frontmatter_text(new_text)
    assert parsed["name"] == "sample"
    assert parsed["description"] == "A sample skill."
    assert parsed["ships_with"]["permissions"]["deny"] == ["Bash(git push --force:*)"]

    cleared = skill_meta.render_frontmatter_block(new_text, "ships_with", None)
    assert cleared is not None
    parsed2 = skill_meta.parse_frontmatter_text(cleared)
    assert "ships_with" not in parsed2
    assert parsed2["name"] == "sample"


# ─────────────────────────────────────────────────────────────────────────────
# 24. W7 — the reconcile pass the auto-sync tail runs after `set` is a no-op
# ─────────────────────────────────────────────────────────────────────────────


def test_second_reconcile_pass_from_auto_sync_is_a_no_op(cli_env, capsys):
    args = _set_args("orchestrate-advanced", _basic_body())
    companions.cmd_companions_set(args)
    capsys.readouterr()

    reg = _reload()
    from skill_hub.application.skills import ships_with_reconcile as swr

    plan = swr.plan_reconcile(reg)
    assert plan["ops"] == []


# ─────────────────────────────────────────────────────────────────────────────
# 25. `add`/`remove` splice one item over the same `set` body; S1 refuses
#     a skill literally named a verb with no second positional
# ─────────────────────────────────────────────────────────────────────────────


def test_add_remove_alias_over_set_and_verb_name_collision_is_refused(cli_env, capsys):
    add_args = _set_args(
        "orchestrate-advanced", {}, kind="permission", item="Bash(npm:*)", rule_kind="allow",
    )
    companions.cmd_companions_add(add_args)
    capsys.readouterr()
    reg = _reload()
    assert "Bash(npm:*)" in reg["skills"]["orchestrate-advanced"]["ships_with"]["permissions"]["allow"]

    rm_args = _set_args(
        "orchestrate-advanced", {}, kind="permission", item="Bash(npm:*)", rule_kind="allow",
    )
    companions.cmd_companions_remove(rm_args)
    capsys.readouterr()
    reg2 = _reload()
    allow = (reg2["skills"]["orchestrate-advanced"]["ships_with"].get("permissions") or {}).get("allow") or []
    assert "Bash(npm:*)" not in allow

    # S1 — a skill literally named "set" with no second positional is refused,
    # never guessed.
    reg2["skills"]["set"] = {
        "type": "claude-skill", "scope": "portable", "source": str(cli_env["skill_dir"]), "description": "x",
    }
    hub_core.save_registry(reg2)
    args3 = argparse.Namespace(target="set", name=None, project=None, json=False)
    with pytest.raises(SystemExit):
        companions.dispatch_companions(args3)


# ─────────────────────────────────────────────────────────────────────────────
# 27. I5 `state`/`reason`/`route`/`summary`; codex project hook unsupported;
#     a global skill's project-less read is project_context; a portable
#     skill's project-less read is present/absent
# ─────────────────────────────────────────────────────────────────────────────


def test_companions_json_states_per_harness_including_unsupported(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    args = argparse.Namespace(name="orchestrate-advanced", project="notes-vault", json=True)
    companions.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["project_context"] is True

    codex_hook = next(i for i in payload["items"] if i["kind"] == "hook" and i["harness"] == "codex")
    assert codex_hook["state"] == "unsupported"
    assert codex_hook["reason"]
    assert codex_hook["route"] == "/hook/orch-scope-guard"

    agent_items = [i for i in payload["items"] if i["kind"] == "agent"]
    assert agent_items and all(i["state"] == "provisioned" for i in agent_items)
    assert all(i["route"] and i["route"].startswith("/harness/") for i in agent_items)

    rule_item = next(i for i in payload["items"] if i["kind"] == "permission")
    assert rule_item["route"].startswith("/project/notes-vault?tab=permissions&focus=")

    assert payload["summary"]["provisioned"] >= 1
    assert payload["summary"]["pending"] == 0

    # Portable skill, no project -> present/absent (or, D17, provisioned —
    # this fixture's companions ledger already claims it on "notes-vault"
    # from the --with-companions equip above), never pending.
    args2 = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args2)
    payload2 = json.loads(capsys.readouterr().out)
    assert payload2["project_context"] is False
    assert payload2["provisioned_on"] == ["notes-vault"]
    assert all("provisioned" not in i for i in payload2["items"])
    assert {i["state"] for i in payload2["items"]} <= {
        "provisioned", "present", "absent", "unsupported", "missing",
    }

    # A `scope: global` skill's project-less read IS project_context (A17).
    reg = _reload()
    reg["skills"]["orchestrate-advanced"]["scope"] = "global"
    hub_core.save_registry(reg)
    args3 = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args3)
    payload3 = json.loads(capsys.readouterr().out)
    assert payload3["project_context"] is True


# ─────────────────────────────────────────────────────────────────────────────
# D17 (ships-with-3, plan 1) — the project-less read learns WHERE a skill is
# actually provisioned instead of always reporting `absent`/`will_write`.
# ─────────────────────────────────────────────────────────────────────────────


def test_provisioned_on_project_less_read_after_equip(cli_env_full, capsys):
    """After `--with-companions` on project A, the project-less read says so:
    `provisioned_on == ["A"]`, every non-unsupported item is `provisioned`
    with `reason == "from A"`, `summary.provisioned == 11` (6 agents, 3 hooks,
    2 permission buckets), and `project_context` stays False (F1)."""
    hub.cmd_enable(argparse.Namespace(
        skill="orchestrate-advanced", project="proj-a", with_refs=False,
        with_companions=True, skill_only=False, json=False,
    ))
    capsys.readouterr()

    args = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)

    assert payload["project_context"] is False
    assert payload["provisioned_on"] == ["proj-a"]
    assert payload["summary"]["provisioned"] == 11
    assert payload["summary"]["pending"] == 0

    for it in payload["items"]:
        if it["state"] == "unsupported":
            continue
        assert it["state"] == "provisioned", it
        assert it["reason"] == "from proj-a"


def test_provisioned_on_lists_every_claiming_scope(cli_env_full, capsys):
    """Provisioned on A AND B → `provisioned_on == ["proj-a", "proj-b"]`
    (sorted) and every shared item's reason joins both names."""
    for project in ("proj-a", "proj-b"):
        hub.cmd_enable(argparse.Namespace(
            skill="orchestrate-advanced", project=project, with_refs=False,
            with_companions=True, skill_only=False, json=False,
        ))
        capsys.readouterr()

    args = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)

    assert payload["provisioned_on"] == ["proj-a", "proj-b"]
    for it in payload["items"]:
        if it["state"] == "unsupported":
            continue
        assert it["state"] == "provisioned", it
        assert it["reason"] == "from proj-a, proj-b"


def test_provisioned_on_empty_and_states_unchanged_with_no_ledger_anywhere(cli_env, capsys):
    """No `--with-companions` equip has ever run: `provisioned_on == []` on
    both a `--project` and a project-less read, and the pre-D17 states are
    byte-identical — the codex hook is still `unsupported` (the codex+project
    restriction, unrelated to D17) and the project-less read still says only
    present/absent/unsupported/missing, never `provisioned`."""
    args = argparse.Namespace(name="orchestrate-advanced", project="notes-vault", json=True)
    companions.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["provisioned_on"] == []
    codex_hook = next(i for i in payload["items"] if i["kind"] == "hook" and i["harness"] == "codex")
    assert codex_hook["state"] == "unsupported"

    args2 = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args2)
    payload2 = json.loads(capsys.readouterr().out)
    assert payload2["provisioned_on"] == []
    assert payload2["project_context"] is False
    assert all("provisioned" not in i for i in payload2["items"])
    assert {i["state"] for i in payload2["items"]} <= {"present", "absent", "unsupported", "missing"}


def test_provisioned_on_project_scoped_read_and_global_scope_skill(cli_env_full, capsys):
    """W2: `provisioned_on` lists EVERY claiming scope, always — including
    under `--project P`. Equip on BOTH proj-a and proj-b, then a `--project
    proj-a` read still carries `["proj-a", "proj-b"]` (never narrowed to
    just the named project). A `scope: global` skill's project-less read
    carries `["global"]` when `companions_global` holds it (A17's global
    ledger, via `GLOBAL_SCOPE`)."""
    for project in ("proj-a", "proj-b"):
        hub.cmd_enable(argparse.Namespace(
            skill="orchestrate-advanced", project=project, with_refs=False,
            with_companions=True, skill_only=False, json=False,
        ))
        capsys.readouterr()

    args = argparse.Namespace(name="orchestrate-advanced", project="proj-a", json=True)
    companions.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["provisioned_on"] == ["proj-a", "proj-b"]

    reg = _reload()
    _register_global_orch_skill(cli_env_full, reg)
    hub_core.save_registry(reg)
    hub.cmd_enable(_enable_global_args())
    capsys.readouterr()

    args2 = argparse.Namespace(name="global-orch", project=None, json=True)
    companions.cmd_skill_companions(args2)
    payload2 = json.loads(capsys.readouterr().out)
    assert payload2["provisioned_on"] == [ships_with.GLOBAL_SCOPE]


def test_provisioned_on_agent_disk_truth_outranks_stale_ledger(cli_env_full, capsys):
    """W1: the ledger can go stale without hub ever knowing (an agent file
    deleted straight off disk, e.g. from the Harnesses screen, never clears
    the companions ledger). After `--with-companions` on proj-a, delete the
    rendered `orch-implementer` file from BOTH agent-capable harnesses' dirs
    — its project-less item must read `absent` (not `provisioned`, and it
    must not carry a `reason`), while every OTHER agent stays `provisioned`."""
    hub.cmd_enable(argparse.Namespace(
        skill="orchestrate-advanced", project="proj-a", with_refs=False,
        with_companions=True, skill_only=False, json=False,
    ))
    capsys.readouterr()

    (cli_env_full["claude_agents"] / "orch-implementer.md").unlink()
    for f in cli_env_full["codex_agents"].glob("orch-implementer.*"):
        f.unlink()

    args = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)

    deleted_items = [i for i in payload["items"] if i["kind"] == "agent" and i["name"] == "orch-implementer"]
    assert deleted_items
    for it in deleted_items:
        assert it["state"] == "absent", it
        assert not it.get("reason")

    other_agent_items = [
        i for i in payload["items"] if i["kind"] == "agent" and i["name"] != "orch-implementer"
    ]
    assert other_agent_items
    for it in other_agent_items:
        assert it["state"] == "provisioned", it
        assert it["reason"] == "from proj-a"


def test_companion_route_permission_project_less_single_vs_multi_scope(cli_env_full, capsys):
    """W4: a project-less permission item whose `provisioned_on` names
    exactly one project routes to THAT project's Permissions tab — the
    global `/permissions` screen never lists a project-scoped rule. With 0
    or 2+ claiming scopes there is no single project to route to, so the
    existing global-screen fallback stays."""
    hub.cmd_enable(argparse.Namespace(
        skill="orchestrate-advanced", project="proj-a", with_refs=False,
        with_companions=True, skill_only=False, json=False,
    ))
    capsys.readouterr()

    args = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)
    perm_items = [i for i in payload["items"] if i["kind"] == "permission"]
    assert perm_items
    for it in perm_items:
        assert it["route"].startswith("/project/proj-a?tab=permissions&focus="), it

    hub.cmd_enable(argparse.Namespace(
        skill="orchestrate-advanced", project="proj-b", with_refs=False,
        with_companions=True, skill_only=False, json=False,
    ))
    capsys.readouterr()

    args2 = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    companions.cmd_skill_companions(args2)
    payload2 = json.loads(capsys.readouterr().out)
    perm_items2 = [i for i in payload2["items"] if i["kind"] == "permission"]
    assert perm_items2
    for it in perm_items2:
        assert it["route"].startswith("/permissions?focus="), it


# ─────────────────────────────────────────────────────────────────────────────
# 28. A22/W9 — `--with-companions` on a bundle-only skill leaves `enabled`
#     alone (a plain `hub bundle remove` still removes it)
# ─────────────────────────────────────────────────────────────────────────────


def test_enable_with_companions_on_a_bundle_only_skill_leaves_enabled_alone(cli_env, capsys):
    reg = _reload()
    reg["bundles"]["orch-bundle"] = {
        "description": "x", "icon": "📦", "scope": "project-specific",
        "skills": ["orchestrate-advanced"],
    }
    reg["projects"]["notes-vault"]["bundles"] = ["orch-bundle"]
    hub_core.save_registry(reg)

    # A24/R4 (R7d) — replay the REAL two-call app flow: call 1 is the plain
    # gate (no flag, exit 2); call 2 is the confirmation. The bug was that
    # call 1 ALONE already appended the skill to `enabled` before the
    # `--with-companions` guard ever ran.
    with pytest.raises(SystemExit) as ei:
        hub.cmd_enable(_enable_args())
    assert ei.value.code == 2
    capsys.readouterr()

    reg_after_call1 = _reload()
    assert "orchestrate-advanced" not in (reg_after_call1["projects"]["notes-vault"].get("enabled") or [])

    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    reg2 = _reload()
    proj = reg2["projects"]["notes-vault"]
    assert "orchestrate-advanced" not in (proj.get("enabled") or [])
    assert "orchestrate-advanced" in ships_with.ledger(proj)
    assert (cli_env["claude_agents"] / "orch-implementer.md").exists()


# ─────────────────────────────────────────────────────────────────────────────
# R2/R3 (A23, R7c) — a `{ref}` hook ATTACHES an existing library definition
# without ever refusing, and a `from:`-copied agent CLAIMS its pre-existing
# harness file (`written: false`, never touched) instead of hard-refusing.
# Neither the CLI `set` step alone nor a pre-ledgered fixture (wave 1's own
# reconcile test) exercised the actual PROVISION call before this fix.
# ─────────────────────────────────────────────────────────────────────────────


def test_ref_hook_and_from_copied_agent_actually_provision(cli_env, capsys):
    from skill_hub.infrastructure.harnesses import subagents

    reg = _reload()
    reg["hooks"] = {"lib-hook": {"event": "PreToolUse", "command": "/usr/bin/true"}}
    hub_core.save_registry(reg)

    # An existing, UNRELATED claude-code agent, built through the SAME
    # renderer `render_agent_payload` uses for tier "worker" (model: sonnet)
    # so the skill's own copy round-trips byte-identically back out to this
    # harness — exactly the "equal by construction" case A23 describes.
    safe = {
        "name": "copied-agent", "description": "A pre-existing agent.",
        "model": "sonnet", "effort": "medium",
    }
    fm, _ = subagents.build_frontmatter(safe, "")
    original_text = subagents.serialize_agent(fm, subagents.normalize_body("Existing body.\n"))
    original_file = cli_env["claude_agents"] / "copied-agent.md"
    original_file.write_text(original_text)

    body = {
        "agents": [{"name": "copied-agent", "from": {"harness": "claude-code"}}],
        "hooks": [{"ref": "lib-hook"}],
        "permissions": {"allow": [], "deny": [], "ask": []},
    }
    companions.cmd_companions_set(_set_args("orchestrate-advanced", body))
    capsys.readouterr()

    hub.cmd_enable(_enable_args(with_companions=True))
    out = capsys.readouterr().out
    assert "refused" not in out

    reg2 = _reload()
    proj = reg2["projects"]["notes-vault"]
    entry = ships_with.ledger_entry(proj, "orchestrate-advanced")

    assert "lib-hook" in entry["hooks"]
    assert entry["hook_state"]["lib-hook"]["origin"] == "ref"
    assert "lib-hook" in (proj.get("hooks") or [])  # actually attached, not just ledgered

    assert "copied-agent" in entry["agents"]
    assert entry["agent_state"]["copied-agent"]["files"]["claude-code"]["written"] is False
    assert original_file.read_text() == original_text  # the claim never touched it
    # Codex has no pre-existing file for this agent — it still gets a fresh write.
    assert entry["agent_state"]["copied-agent"]["files"]["codex"]["written"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 29. I9 — `resolve keep-mine` re-records the on-disk hash; `resolve
#     keep-skill` deletes both twins, re-renders, re-links, re-records
# ─────────────────────────────────────────────────────────────────────────────


def test_resolve_keep_mine_and_keep_skill(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    claude_file = cli_env["claude_agents"] / "orch-implementer.md"
    codex_file = cli_env["codex_agents"] / "orch-implementer.toml"  # Codex agents render as .toml
    assert claude_file.exists() and codex_file.exists()

    claude_file.write_text(claude_file.read_text() + "\nHand-edited line.\n")

    resolve_keep_mine = argparse.Namespace(
        name="orchestrate-advanced", agent="orch-implementer", op="keep-mine",
        project="notes-vault", global_=False, json=True,
    )
    companions.cmd_companions_resolve(resolve_keep_mine)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert set(payload["harnesses"]) == {"claude-code", "codex"}

    reg = _reload()
    a_state = reg["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]["agent_state"]["orch-implementer"]
    assert a_state["files"]["claude-code"]["sha256"] == hashlib.sha256(claude_file.read_bytes()).hexdigest()
    assert "Hand-edited line." in claude_file.read_text()  # keep-mine never touches the file

    claude_file.write_text(claude_file.read_text() + "\nAnother hand edit.\n")
    resolve_keep_skill = argparse.Namespace(
        name="orchestrate-advanced", agent="orch-implementer", op="keep-skill",
        project="notes-vault", global_=False, json=True,
    )
    companions.cmd_companions_resolve(resolve_keep_skill)
    payload2 = json.loads(capsys.readouterr().out)
    assert payload2["ok"] is True

    new_text = claude_file.read_text()
    assert "Another hand edit." not in new_text
    assert "You implement one chunk at a time." in new_text


# ─────────────────────────────────────────────────────────────────────────────
# 30. A16/W8 — every registered project gets a `companions` sync-report
#     record, even one `plan_reconcile` never walked
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_writes_a_companions_record_for_every_scope(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    reg = _reload()
    reg["projects"]["untouched"] = {
        "path": str(cli_env["proj_path"]), "enabled": [], "bundles": [], "harnesses": [],
    }
    hub_core.save_registry(reg)
    reg = _reload()

    report = hub.new_sync_report()
    result = companions.run_reconcile_pass(reg, report=report)

    assert "companions" in report["global"]
    assert "companions" in report["projects"]["notes-vault"]
    assert "companions" in report["projects"]["untouched"]
    assert report["projects"]["untouched"]["companions"]["pending"] == []
    assert report["projects"]["untouched"]["companions"]["errors"] == []
    assert result["projects"]["notes-vault"]["pending"] == []


# ─────────────────────────────────────────────────────────────────────────────
# 31. W8 — `--skip-hooks` still reports but applies no ops
# ─────────────────────────────────────────────────────────────────────────────


def test_skip_hooks_reports_but_applies_nothing(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    # An upstream drop of the whole declaration would normally de-provision
    # everything — but under --skip-hooks nothing may be touched.
    (cli_env["skill_dir"] / "SKILL.md").write_text(_skill_md(ships_with_yaml=""))

    reg = _reload()
    before = json.dumps(reg["projects"]["notes-vault"], sort_keys=True)
    result = companions.run_reconcile_pass(reg, skip_hooks=True)
    after = json.dumps(reg["projects"]["notes-vault"], sort_keys=True)

    assert before == after
    assert result["projects"]["notes-vault"]["skipped"] == "hooks"
    assert "orch-scope-guard" in reg["projects"]["notes-vault"]["hooks"]


# ─────────────────────────────────────────────────────────────────────────────
# R6 — `companions_global` teardown had no CLI path on `hub archive` / `hub
# rename` (only `hub disable --global` was fixed in the prior retry). One
# test per verb: archive fully deprovisions the global ledger (but keeps a
# user-scope agent file another ledger still claims); rename re-keys it.
# ─────────────────────────────────────────────────────────────────────────────


def _register_global_orch_skill(cli_env, reg: dict, name: str = "global-orch") -> Path:
    skill_dir = cli_env["tmp_path"] / "skills" / name
    (skill_dir / "agents").mkdir(parents=True)
    (skill_dir / "scripts").mkdir(parents=True)
    (skill_dir / "agents" / "shared-agent.md").write_text(
        AGENT_IMPLEMENTER_MD.replace("orch-implementer", "shared-agent")
    )
    (skill_dir / "scripts" / "guard.sh").write_text("#!/bin/sh\nexit 0\n")
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        f"name: {name}\n"
        "description: A global companion-shipping skill.\n"
        "scope: global\n"
        "ships_with:\n"
        "  agents: [shared-agent]\n"
        "  hooks:\n"
        "    - name: global-guard\n"
        "      event: PreToolUse\n"
        "      command: scripts/guard.sh\n"
        "      activation: always\n"
        "  permissions:\n"
        '    deny: ["Bash(rm -rf:*)"]\n'
        "---\n"
        "Body.\n"
    )
    reg["skills"][name] = {
        "type": "claude-skill", "scope": "global", "source": str(skill_dir), "description": "x",
    }
    return skill_dir


def _enable_global_args(**overrides) -> argparse.Namespace:
    base = dict(
        skill="global-orch", project=None, with_refs=False,
        with_companions=True, skill_only=False, json=False,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def test_enable_global_with_unavailable_context_writes_no_permission_rows(
    cli_env, capsys, tmp_data_home, monkeypatch
):
    from dataclasses import replace

    from skill_hub.application.harnesses import harness_operation_context as contexts

    reg = _reload()
    _register_global_orch_skill(cli_env, reg)
    hub_core.save_registry(reg)
    operation_context = contexts.build_operation_context(
        tmp_data_home,
        ("claude-code", "codex"),
        requested_features=("companions", "permissions", "hooks"),
        installed_harness_ids=("claude-code", "codex"),
    )
    operation_context = replace(operation_context, routes={})
    captures = []
    monkeypatch.setattr(
        contexts,
        "build_operation_context",
        lambda *args, **kwargs: captures.append((args, kwargs)) or operation_context,
    )

    hub.cmd_enable(_enable_global_args(json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert len(captures) == 1

    reg = _reload()
    assert not any(reg.get("permissions_global", {}).get(kind) for kind in ("allow", "deny", "ask"))
    entry = ships_with.global_ledger(reg)["global-orch"]
    assert entry.get("permissions") == []
    assert payload["provisioned"]["permissions"] == []


def test_archive_global_scope_skill_tears_down_companions_global(cli_env, capsys):
    reg = _reload()
    _register_global_orch_skill(cli_env, reg)
    hub_core.save_registry(reg)

    hub.cmd_enable(_enable_global_args())
    capsys.readouterr()

    reg2 = _reload()
    assert "global-orch" in ships_with.global_ledger(reg2)
    assert "global-guard" in (reg2.get("hooks_global") or [])
    agent_file = cli_env["claude_agents"] / "shared-agent.md"
    assert agent_file.exists()

    # A DIFFERENT (project, skill) ledger claims the same agent NAME —
    # archiving global-orch must leave that file alone (kept_shared).
    reg2["projects"]["notes-vault"]["companions"] = {
        "unrelated-skill": {"agents": ["shared-agent"], "hooks": [], "permissions": []}
    }
    hub_core.save_registry(reg2)

    hub.cmd_archive(argparse.Namespace(skills=["global-orch"], dry_run=False, json=True))
    # cmd_archive pretty-prints the payload, then _auto_sync chatter follows —
    # decode only the leading JSON value, same posture as parseCmdPayload.
    out, _ = json.JSONDecoder().raw_decode(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["archived"][0]["references"]["companions_global"]

    reg3 = _reload()
    assert "global-orch" not in ships_with.global_ledger(reg3)
    assert "global-guard" not in (reg3.get("hooks_global") or [])
    assert agent_file.exists()  # kept — another ledger still claims "shared-agent"
    assert "global-orch" not in reg3["skills"]


def test_rename_global_scope_skill_rekeys_companions_global(cli_env, capsys):
    reg = _reload()
    _register_global_orch_skill(cli_env, reg)
    hub_core.save_registry(reg)

    hub.cmd_enable(_enable_global_args())
    capsys.readouterr()

    reg1 = _reload()
    assert "global-orch" in ships_with.global_ledger(reg1)

    hub.cmd_rename(argparse.Namespace(old_name="global-orch", new_name="global-orch-2", dry_run=False))
    capsys.readouterr()

    reg2 = _reload()
    assert "global-orch" not in ships_with.global_ledger(reg2)
    assert "global-orch-2" in ships_with.global_ledger(reg2)
    assert "global-orch-2" in reg2["skills"]
    assert "global-orch" not in reg2["skills"]
    # Re-keying never touches the provisioned file or the hook attach.
    assert (cli_env["claude_agents"] / "shared-agent.md").exists()
    assert "global-guard" in (reg2.get("hooks_global") or [])


# ═════════════════════════════════════════════════════════════════════════════
# Wave 4c unit 1 (`cli-hook-scaffold`, plans/3.md §5 Unit 1) — T1-T8, incl.
# T3b and T7b. Real-home safety (grill #17): every task below runs under
# `cli_env`/the autouse `_fake_home` net; T1/T2 are pure functions and touch
# no home at all, but still run under the same net.
# ═════════════════════════════════════════════════════════════════════════════


def _new_hook_args(name: str, item: str, **overrides) -> argparse.Namespace:
    base = dict(
        target="new-hook", name=name, project=None, global_=False, json=False,
        json_stdin=False, json_body=None, kind=None, item=item, rule_kind=None,
        agent=None, op=None, event="PreToolUse", tools=None,
        activation="while-running", hook_command=None, no_scaffold=False,
    )
    # The CLI flag is `--command`, but its dest is `hook_command`: argparse's
    # `command` dest is the top-level subcommand and must never be shadowed.
    if "command" in overrides:
        overrides["hook_command"] = overrides.pop("command")
    base.update(overrides)
    return argparse.Namespace(**base)


def _inline_hook_with_scaffold(
    name: str = "orch-new-guard",
    command: str = "scripts/new-guard.sh",
    event: str = "PreToolUse",
    template: str = "bash",
) -> dict:
    return {
        "name": name,
        "event": event,
        "tools": ["Edit"],
        "command": command,
        "activation": "while-running",
        "scaffold": {"template": template},
    }


# ─────────────────────────────────────────────────────────────────────────────
# T1 — `hook_script_template` (pure function)
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_script_template_bash_pre_tool_use_deny_shape():
    script = ships_with.hook_script_template("scope-guard", "PreToolUse")
    assert script.startswith("#!/bin/bash\n")
    assert "set -euo pipefail" in script
    assert "hookSpecificOutput" in script


def test_hook_script_template_bash_subagent_stop_block_shape():
    script = ships_with.hook_script_template("report-check", "SubagentStop")
    assert script.startswith("#!/bin/bash\n")
    assert '"decision": "block"' in script


def test_hook_script_template_bash_session_start_cannot_block():
    script = ships_with.hook_script_template("session-note", "SessionStart")
    assert "cannot block" in script


def test_hook_script_template_python3_variant():
    script = ships_with.hook_script_template("scope-guard", "PreToolUse", template="python3")
    assert script.startswith("#!/usr/bin/env python3\n")
    assert "hookSpecificOutput" in script


# ─────────────────────────────────────────────────────────────────────────────
# T2 — `validate_scaffold_target` (pure function)
# ─────────────────────────────────────────────────────────────────────────────


def test_validate_scaffold_target_four_reasons(tmp_path):
    skill_dir = tmp_path / "skill"
    (skill_dir / "scripts").mkdir(parents=True)
    (skill_dir / "helpers").mkdir(parents=True)

    assert ships_with.validate_scaffold_target(skill_dir, "../x.sh") == (None, "outside_skill_dir")
    assert ships_with.validate_scaffold_target(skill_dir, "helpers/x.sh") == (None, "not_under_scripts")
    assert ships_with.validate_scaffold_target(skill_dir, "scripts/x.rb") == (None, "unsupported_suffix")

    (skill_dir / "scripts" / "existing.sh").mkdir()
    assert ships_with.validate_scaffold_target(skill_dir, "scripts/existing.sh") == (
        None, "is_a_directory",
    )

    assert ships_with.validate_scaffold_target(skill_dir, "scripts/new.sh") == ("scripts/new.sh", None)


# ─────────────────────────────────────────────────────────────────────────────
# T3 — `set --json-body` with an inline hook carrying `scaffold` CREATES the
# script, executable, and the payload names the absolute path.
# ─────────────────────────────────────────────────────────────────────────────


def test_set_scaffolds_a_new_inline_hook_script(cli_env, capsys):
    body = _basic_body(hooks=[_inline_hook_with_scaffold()])
    args = _set_args("orchestrate-advanced", body)
    companions.cmd_companions_set(args)
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True

    script = cli_env["skill_dir"] / "scripts" / "new-guard.sh"
    assert script.is_file()
    assert os.access(script, os.X_OK)
    assert script.stat().st_mode & 0o111
    assert str(script) in payload["scaffolded"]
    assert payload["missing_commands"] == []

    reg = _reload()
    names = [h["name"] for h in reg["skills"]["orchestrate-advanced"]["ships_with"]["hooks"]]
    assert "orch-new-guard" in names


# ─────────────────────────────────────────────────────────────────────────────
# T4 — a second call with the SAME scaffolded hook never rewrites the file
# ─────────────────────────────────────────────────────────────────────────────


def test_set_scaffold_never_overwrites_existing_script(cli_env, capsys):
    body = _basic_body(hooks=[_inline_hook_with_scaffold()])
    companions.cmd_companions_set(_set_args("orchestrate-advanced", body))
    capsys.readouterr()

    script = cli_env["skill_dir"] / "scripts" / "new-guard.sh"
    custom_bytes = b"#!/bin/sh\n# hand-edited, never touch me\nexit 1\n"
    script.write_bytes(custom_bytes)

    companions.cmd_companions_set(_set_args("orchestrate-advanced", body))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["scaffolded"] == []
    assert script.read_bytes() == custom_bytes


# ─────────────────────────────────────────────────────────────────────────────
# T3b (grill #13, CRITICAL) — a NEW inline hook may not take a hooks-library
# name; three sub-cases, incl. the mandatory re-save carve-out.
# ─────────────────────────────────────────────────────────────────────────────


def test_set_refuses_inline_hook_named_same_as_registry_hook(cli_env, capsys):
    """(i) the name is a plain `registry["hooks"]` entry."""
    reg = _reload()
    reg["hooks"] = {"orch-new-guard": {"event": "PreToolUse", "command": "/usr/bin/true"}}
    hub_core.save_registry(reg)

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    body = _basic_body(hooks=[_inline_hook_with_scaffold()])
    args = _set_args("orchestrate-advanced", body)
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[orch-new-guard]"
    assert not (cli_env["skill_dir"] / "scripts" / "new-guard.sh").exists()
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original


def test_set_refuses_inline_hook_named_same_as_builtin(cli_env, capsys):
    """(ii) the name is a built-in (`hooks_model.all_definitions` merges
    built-ins, so `lsp-report` must be refused too)."""
    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    hook = _inline_hook_with_scaffold(name="lsp-report", command="scripts/lsp-report.sh")
    body = _basic_body(hooks=[hook])
    args = _set_args("orchestrate-advanced", body)
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[lsp-report]"
    assert not (cli_env["skill_dir"] / "scripts" / "lsp-report.sh").exists()
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original


def test_set_carve_out_allows_re_save_of_already_provisioned_inline_hook(cli_env, capsys):
    """(iii) the carve-out — a skill that already declares this inline hook,
    whose provisioning wrote the same name into `registry["hooks"]` via
    `_hook_new`, re-saves successfully. This is the regression the carve-out
    exists to prevent."""
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    reg = _reload()
    assert "orch-scope-guard" in (reg.get("hooks") or {})  # provisioned into the library

    args = _set_args("orchestrate-advanced", _basic_body())
    companions.cmd_companions_set(args)
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True


# ─────────────────────────────────────────────────────────────────────────────
# T5 — rollback: a failure after the frontmatter write, and a pre-validation
# failure on a LATER hook, leave nothing behind (script + created dir).
# ─────────────────────────────────────────────────────────────────────────────


def test_set_rollback_after_frontmatter_write_removes_scaffold_and_created_dir(
    cli_env, capsys, monkeypatch
):
    from skill_hub.domain.skills import skill_meta

    shutil.rmtree(cli_env["skill_dir"] / "scripts")

    def _boom(*_a, **_k):
        raise RuntimeError("boom")

    monkeypatch.setattr(skill_meta, "sync_skill_frontmatter_metadata", _boom)

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    body = _basic_body(hooks=[_inline_hook_with_scaffold()])
    args = _set_args("orchestrate-advanced", body)
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original
    assert not (cli_env["skill_dir"] / "scripts" / "new-guard.sh").exists()
    assert not (cli_env["skill_dir"] / "scripts").exists()


def test_set_rollback_on_pre_validation_failure_of_a_later_hook(cli_env, capsys):
    shutil.rmtree(cli_env["skill_dir"] / "scripts")

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    bad_hook = {
        "name": "orch-bad-guard",
        "event": "NotAnEvent",
        "command": "scripts/bad-guard.sh",
        "activation": "while-running",
    }
    body = _basic_body(hooks=[_inline_hook_with_scaffold(), bad_hook])
    args = _set_args("orchestrate-advanced", body)
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original
    assert not (cli_env["skill_dir"] / "scripts" / "new-guard.sh").exists()
    assert not (cli_env["skill_dir"] / "scripts").exists()


def test_set_rollback_after_skipped_scaffold_leaves_pre_existing_file_intact(cli_env, capsys):
    """R5 (opus review 6-review-4c.md finding 5) — when the scaffold target
    ALREADY EXISTS, `_stage_hook_script` skips it (returns `None`, nothing is
    staged for that entry, R3's own "hub never overwrites a script" rule); a
    LATER hook's validation failure still triggers `_rollback_staged`, which
    must never touch a file/dir it never staged. Unlike the two T5 cases
    above, `scripts/` is left exactly as the fixture wrote it (no
    `shutil.rmtree`) and the scaffold target is pre-seeded by hand."""
    existing_script = cli_env["skill_dir"] / "scripts" / "new-guard.sh"
    custom_bytes = b"#!/bin/sh\n# hand-authored, pre-existing\nexit 0\n"
    existing_script.write_bytes(custom_bytes)

    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    bad_hook = {
        "name": "orch-bad-guard",
        "event": "NotAnEvent",
        "command": "scripts/bad-guard-2.sh",
        "activation": "while-running",
    }
    body = _basic_body(hooks=[_inline_hook_with_scaffold(), bad_hook])
    args = _set_args("orchestrate-advanced", body)
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original
    # The pre-existing scaffold target was skipped (never staged) — it must
    # survive the rollback byte-for-byte, not merely "still exist".
    assert existing_script.read_bytes() == custom_bytes
    # The pre-existing `scripts/scope-guard.sh` (from the fixture) and the
    # dir itself are equally untouched.
    assert (cli_env["skill_dir"] / "scripts" / "scope-guard.sh").is_file()
    assert (cli_env["skill_dir"] / "scripts").is_dir()


def test_set_refuses_scaffold_on_a_ref_entry(cli_env, capsys):
    """Suggestion 14 (opus review 6-review-4c.md) — a `{ref}` entry names a
    hooks-library definition, which already owns its own script (if any); a
    `scaffold` request on it used to be silently dropped rather than
    refused."""
    original = (cli_env["skill_dir"] / "SKILL.md").read_text()
    body = {
        "agents": [],
        "hooks": [{"ref": "lint-report", "name": "lint-report", "scaffold": {"template": "bash"}}],
        "permissions": {"allow": [], "deny": [], "ask": []},
    }
    args = _set_args("orchestrate-advanced", body)
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_set(args)
    assert ei.value.code == 1

    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[lint-report]"
    assert (cli_env["skill_dir"] / "SKILL.md").read_text() == original


# ─────────────────────────────────────────────────────────────────────────────
# T6 — `missing_commands` lists a declared inline hook with no scaffold whose
# file is absent; the call still succeeds (reporting only).
# ─────────────────────────────────────────────────────────────────────────────


def test_set_reports_missing_commands_for_unscaffolded_declared_hook(cli_env, capsys):
    hook = {
        "name": "orch-ghost-guard",
        "event": "PreToolUse",
        "command": "scripts/ghost-guard.sh",
        "activation": "while-running",
    }
    body = _basic_body(hooks=[hook])
    args = _set_args("orchestrate-advanced", body)
    companions.cmd_companions_set(args)
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert "scripts/ghost-guard.sh" in payload["missing_commands"]
    assert not (cli_env["skill_dir"] / "scripts" / "ghost-guard.sh").exists()


# ─────────────────────────────────────────────────────────────────────────────
# T7 — `new-hook` end to end
# ─────────────────────────────────────────────────────────────────────────────


def test_new_hook_declares_and_scaffolds(cli_env, capsys):
    args = _new_hook_args("orchestrate-advanced", "orch-fresh-guard", tools="Edit,Write")
    companions.cmd_companions_new_hook(args)
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True

    script = cli_env["skill_dir"] / "scripts" / "orch-fresh-guard.sh"
    assert script.is_file()
    assert script.stat().st_mode & 0o111
    assert str(script) in payload["scaffolded"]

    reg = _reload()
    names = [h["name"] for h in reg["skills"]["orchestrate-advanced"]["ships_with"]["hooks"]]
    assert "orch-fresh-guard" in names


def test_new_hook_no_scaffold_declares_only(cli_env, capsys):
    args = _new_hook_args("orchestrate-advanced", "orch-quiet-guard", no_scaffold=True)
    companions.cmd_companions_new_hook(args)
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["scaffolded"] == []

    script = cli_env["skill_dir"] / "scripts" / "orch-quiet-guard.sh"
    assert not script.exists()
    assert "scripts/orch-quiet-guard.sh" in payload["missing_commands"]


def test_new_hook_refuses_duplicate_inline_name(cli_env, capsys):
    args = _new_hook_args("orchestrate-advanced", "orch-scope-guard")  # already declared inline
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[orch-scope-guard]"


def test_new_hook_refuses_duplicate_ref_name(cli_env, capsys):
    reg = _reload()
    reg["hooks"] = {"lib-hook": {"event": "PreToolUse", "command": "/usr/bin/true"}}
    hub_core.save_registry(reg)
    body = {"agents": [], "hooks": [{"ref": "lib-hook"}], "permissions": {"allow": [], "deny": [], "ask": []}}
    companions.cmd_companions_set(_set_args("orchestrate-advanced", body))
    capsys.readouterr()

    args = _new_hook_args("orchestrate-advanced", "lib-hook")
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[lib-hook]"


def test_new_hook_refuses_unknown_event(cli_env, capsys):
    args = _new_hook_args("orchestrate-advanced", "orch-weird-guard", event="NotReal")
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[orch-weird-guard].event"


def test_new_hook_refuses_command_outside_scripts(cli_env, capsys):
    args = _new_hook_args(
        "orchestrate-advanced", "orch-outside-guard", command="helpers/outside.sh"
    )
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[orch-outside-guard].command"
    assert not (cli_env["skill_dir"] / "helpers" / "outside.sh").exists()


# ─────────────────────────────────────────────────────────────────────────────
# T7b (grill #13) — `new-hook` refuses a hooks-library name outright (the
# FULL HOOK_NAME_TAKEN set, no carve-out: the verb only ever creates).
# ─────────────────────────────────────────────────────────────────────────────


def test_new_hook_refuses_registry_library_name(cli_env, capsys):
    reg = _reload()
    reg["hooks"] = {"my-lib-hook": {"event": "PreToolUse", "command": "/usr/bin/true"}}
    hub_core.save_registry(reg)

    args = _new_hook_args("orchestrate-advanced", "my-lib-hook")
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[my-lib-hook]"
    assert "add --kind hook --item my-lib-hook" in payload["error"]
    assert not (cli_env["skill_dir"] / "scripts" / "my-lib-hook.sh").exists()


def test_new_hook_refuses_builtin_library_name(cli_env, capsys):
    args = _new_hook_args("orchestrate-advanced", "lsp-report")
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert payload["field"] == "hooks[lsp-report]"
    assert "add --kind hook --item lsp-report" in payload["error"]
    assert not (cli_env["skill_dir"] / "scripts" / "lsp-report.sh").exists()


# ─────────────────────────────────────────────────────────────────────────────
# T8 — `new-hook` refuses a `managed: "external"` skill AND a remote-origin
# skill. Both halves must pass — no `xfail`.
# ─────────────────────────────────────────────────────────────────────────────


def test_new_hook_refuses_source_managed_skill(cli_env, capsys):
    reg = _reload()
    reg["skills"]["orchestrate-advanced"]["managed"] = "external"
    reg["skills"]["orchestrate-advanced"]["origin"] = {"source": "org-skills"}
    hub_core.save_registry(reg)

    args = _new_hook_args("orchestrate-advanced", "orch-new-guard")
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert "external source" in payload["error"]


def test_new_hook_refuses_remote_origin_skill(cli_env, capsys):
    reg = _reload()
    reg["skills"]["orchestrate-advanced"]["origin"] = "remote:hermes"
    hub_core.save_registry(reg)

    args = _new_hook_args("orchestrate-advanced", "orch-new-guard")
    with pytest.raises(SystemExit) as ei:
        companions.cmd_companions_new_hook(args)
    assert ei.value.code == 1
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is False
    assert "quarantined" in payload["error"]


# ─────────────────────────────────────────────────────────────────────────────
# `--help` lists the five new flags (brief's done-when clause)
# ─────────────────────────────────────────────────────────────────────────────


def test_new_hook_help_lists_five_new_flags():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")
    companions.register_companions(sub)
    help_text = companions.p_skill_companions.format_help()
    for flag in ("--event", "--tools", "--activation", "--command", "--no-scaffold"):
        assert flag in help_text




def test_companions_argv_survives_argparse_end_to_end(cli_env, capsys, monkeypatch):
    """Regression: the `new-hook` verb's `--command` option was stored as
    `args.command`, clobbering the top-level subcommand (`skill`) with None, so
    `hub skill companions <skill> --json` — the app's read path — printed the
    top-level help and exited 0. Every companions argv must go through the
    REAL parser (hub.main), not a hand-built Namespace."""
    import sys

    monkeypatch.setattr(sys, "argv", ["hub", "skill", "companions", "orchestrate-advanced", "--json"])
    hub.main()
    out = capsys.readouterr().out
    assert out.lstrip().startswith("{"), out[:120]
    payload = json.loads(out[: out.index("\n}") + 2]) if "\n}" in out else json.loads(out.splitlines()[0])
    assert payload["skill"] == "orchestrate-advanced"

    monkeypatch.setattr(
        sys, "argv",
        ["hub", "skill", "companions", "new-hook", "orchestrate-advanced", "--item", "argv-guard",
         "--event", "PreToolUse", "--command", "scripts/argv-guard.sh", "--json"],
    )
    hub.main()
    out = capsys.readouterr().out
    first = json.loads(out.splitlines()[0])
    assert first.get("ok") is True, first
    assert (cli_env["skill_dir"] / "scripts" / "argv-guard.sh").exists()
