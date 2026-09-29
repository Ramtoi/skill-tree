"""Tests for the ships_with CLI + lifecycle wave (W2 of the ships-with
orchestration workspace, milestone 5, plan 1): the `hub enable`
`--with-companions`/`--skill-only` two-phase gate (D2/A4), `hub disable`'s
ledger-scoped removal + A13 payload, `hub skill companions` (A5), and the
`hub project remove` / `hub archive` / `hub rename` lifecycle hooks (W3).

Fixture: an inline `orchestrate-advanced`-shaped skill (two agents, one
hook whose command is a script inside the skill dir, a deny/ask permission
pair) — the same shape `tests/test_ships_with_model.py` uses, built fresh
here so this file owns its own on-disk environment (a real project dir, a
real `registry.yaml`, and both claude-code + codex "installed" via their
detection markers).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest
import yaml

import hub
from skill_hub import hub_core
from skill_hub.domain.skills import ships_with
from skill_hub.entrypoints.cli import skill as skill_cli
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
    (claude / "projects").mkdir(parents=True)  # claude-code detection marker
    (claude / "agents").mkdir(parents=True)
    (codex / "agents").mkdir(parents=True)
    (codex / "config.toml").write_text("")  # codex detection marker

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
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
        "skill_dir": skill_dir,
        "proj_path": proj_path,
        "claude_agents": claude / "agents",
        "codex_agents": codex / "agents",
        "data_home": tmp_data_home,
    }


def _reload() -> dict:
    hub._DATA_HOME_CACHE = None
    return hub.load_registry()


def _enable_args(**overrides) -> argparse.Namespace:
    base = dict(
        skill="orchestrate-advanced",
        project="notes-vault",
        with_refs=False,
        with_companions=False,
        skill_only=False,
        json=False,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def _disable_args(**overrides) -> argparse.Namespace:
    base = dict(skill="orchestrate-advanced", project="notes-vault", keep_companions=False, json=False)
    base.update(overrides)
    return argparse.Namespace(**base)


# ─────────────────────────────────────────────────────────────────────────────
# 9. exit-2 payload is the first stdout line (A4)
# ─────────────────────────────────────────────────────────────────────────────


def test_enable_exit_2_payload_is_first_stdout_line(cli_env, capsys):
    with pytest.raises(SystemExit) as ei:
        hub.cmd_enable(_enable_args())
    assert ei.value.code == 2

    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines, "nothing printed on the gate path"
    payload = json.loads(lines[0])  # must parse standalone
    np = payload["needs_provisioning"]
    assert np["skill"] == "orchestrate-advanced"
    assert np["project"] == "notes-vault"
    assert np["items"]
    assert {i["kind"] for i in np["items"]} >= {"agent", "hook", "permission"}
    # tail chatter (the auto-sync pass) follows the JSON line.
    assert len(lines) > 1

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    assert "orchestrate-advanced" in proj["enabled"]  # the equip landed
    assert "orchestrate-advanced" not in ships_with.ledger(proj)  # companions did not


def test_enable_project_with_unavailable_context_writes_no_permission_or_trust_rows(
    cli_env, capsys, tmp_data_home, monkeypatch
):
    from dataclasses import replace

    from skill_hub.application.harnesses import harness_operation_context as contexts

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
    hub.cmd_enable(_enable_args(with_companions=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert len(captures) == 1

    reg = _reload()
    project = reg["projects"]["notes-vault"]
    permissions = project.get("permissions") or {}
    assert not permissions.get("project_trust")
    assert not any(permissions.get(kind) for kind in ("allow", "deny", "ask"))
    entry = ships_with.ledger_entry(project, "orchestrate-advanced")
    assert entry.get("permissions") == []
    assert payload["provisioned"]["permissions"] == []


# ─────────────────────────────────────────────────────────────────────────────
# 9b. the REAL two-call app flow: gate call, then a SECOND process confirms
# with --with-companions on an ALREADY-enabled skill (proof-unit finding)
# ─────────────────────────────────────────────────────────────────────────────


def test_two_call_flow_confirm_after_gate_still_provisions(cli_env, capsys):
    # Call 1 — no flag: equips, exits 2, companions untouched.
    with pytest.raises(SystemExit) as ei:
        hub.cmd_enable(_enable_args())
    assert ei.value.code == 2
    capsys.readouterr()

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    assert "orchestrate-advanced" in proj["enabled"]
    assert "orchestrate-advanced" not in ships_with.ledger(proj)

    # Call 2 — a SEPARATE process, `--with-companions`, on a skill that is
    # now `already_enabled`. Must NOT hit the "already enabled" no-op path.
    hub.cmd_enable(_enable_args(with_companions=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["already_enabled"] is True
    assert sorted(payload["provisioned"]["agents"]) == ["orch-implementer", "orch-reviewer"]

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    entry = ships_with.ledger_entry(proj, "orchestrate-advanced")
    assert sorted(entry["agents"]) == ["orch-implementer", "orch-reviewer"]
    assert entry["hooks"] == ["orch-scope-guard"]
    assert (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert (cli_env["codex_agents"] / "orch-implementer.toml").exists()


def test_two_call_flow_skill_only_after_gate_is_a_json_aware_noop(cli_env, capsys):
    with pytest.raises(SystemExit):
        hub.cmd_enable(_enable_args())
    capsys.readouterr()

    hub.cmd_enable(_enable_args(skill_only=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["already_enabled"] is True
    assert payload["provisioned"] == {}

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    assert "orchestrate-advanced" not in ships_with.ledger(proj)  # still untouched


# ─────────────────────────────────────────────────────────────────────────────
# 10. a never-synced skill still gates completely (C3ii)
# ─────────────────────────────────────────────────────────────────────────────


def test_enable_plans_a_never_synced_skill(cli_env, capsys):
    reg = _reload()
    assert "ships_with" not in reg["skills"]["orchestrate-advanced"]  # never synced

    with pytest.raises(SystemExit) as ei:
        hub.cmd_enable(_enable_args())
    assert ei.value.code == 2
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["needs_provisioning"]["items"]  # plan read the frontmatter directly


# ─────────────────────────────────────────────────────────────────────────────
# 11. the exit-2 path still writes an audit record (S1)
# ─────────────────────────────────────────────────────────────────────────────


def test_exit_2_path_writes_an_audit_record(cli_env, capsys):
    with pytest.raises(SystemExit):
        hub.cmd_enable(_enable_args())
    capsys.readouterr()

    log = hub_core.audit_log_path()
    assert log.exists()
    records = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    assert any(r.get("verb") == "enable" for r in records)


# ─────────────────────────────────────────────────────────────────────────────
# 12. --with-companions writes ledger + hooks + rules + agents (full apply)
# ─────────────────────────────────────────────────────────────────────────────


def test_enable_with_companions_writes_ledger_hooks_rules_agents(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    assert "orchestrate-advanced" in proj["enabled"]

    entry = ships_with.ledger_entry(proj, "orchestrate-advanced")
    assert entry["hooks"] == ["orch-scope-guard"]
    assert sorted(entry["agents"]) == ["orch-implementer", "orch-reviewer"]
    # A19/C2 (wave 2): a freshly-applied ledger is native v2 — every rule this
    # call added carries `added: True` (it wasn't already present).
    assert {"pattern": "Bash(git push --force:*)", "kind": "deny", "added": True} in entry["permissions"]
    assert {"pattern": "Bash(gh pr merge:*)", "kind": "ask", "added": True} in entry["permissions"]
    assert entry["schema"] == 2

    # Hook definition created + attached at project scope.
    assert "orch-scope-guard" in reg["hooks"]
    baked = reg["hooks"]["orch-scope-guard"]["command"]
    assert baked == str(cli_env["skill_dir"] / "scripts" / "scope-guard.sh")
    assert "orch-scope-guard" in proj["hooks"]

    # Permission rules landed in the project's OWN block (not global).
    perm = proj.get("permissions") or {}
    assert any(r.get("pattern") == "Bash(git push --force:*)" for r in perm.get("deny") or [])
    assert any(r.get("pattern") == "Bash(gh pr merge:*)" for r in perm.get("ask") or [])

    # Agent files on disk for both harnesses, and linked (2 agent-capable harnesses).
    assert (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert (cli_env["codex_agents"] / "orch-implementer.toml").exists()
    assert (cli_env["claude_agents"] / "orch-reviewer.md").exists()
    assert (cli_env["codex_agents"] / "orch-reviewer.toml").exists()
    from skill_hub.infrastructure.harnesses import subagent_links

    links, _warn = subagent_links.read_links()
    linked_names = {e["name"] for e in links}
    assert {"orch-implementer", "orch-reviewer"} <= linked_names


# ─────────────────────────────────────────────────────────────────────────────
# 12b. --with-companions on a SECOND project shares the already-written
# agent instead of refusing (C-1, review milestone 6)
# ─────────────────────────────────────────────────────────────────────────────


def test_enable_with_companions_second_project_shares_agent(cli_env, capsys, monkeypatch):
    reg = _reload()
    other_path = cli_env["skill_dir"].parent.parent / "other"
    other_path.mkdir()
    reg["projects"]["other"] = {
        "path": str(other_path), "enabled": [], "bundles": [], "harnesses": [],
    }
    hub_core.save_registry(reg)

    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()  # discard the first project's own stdout

    from skill_hub.infrastructure.harnesses import subagents

    calls = []
    orig = subagents.save_agent

    def _tracked(payload, registry=None):
        calls.append(payload)
        return orig(payload, registry)

    monkeypatch.setattr(subagents, "save_agent", _tracked)

    # The LIVE second-project run C-1 asked for — not a hand-built ledger.
    hub.cmd_enable(_enable_args(project="other", with_companions=True))
    assert not calls, "save_agent must not be called for an agent already on disk"

    reg = _reload()
    other_proj = reg["projects"]["other"]
    assert "orchestrate-advanced" in (other_proj.get("enabled") or [])
    entry = ships_with.ledger_entry(other_proj, "orchestrate-advanced")
    assert sorted(entry["agents"]) == ["orch-implementer", "orch-reviewer"]
    assert entry["hooks"] == ["orch-scope-guard"]
    assert "orch-scope-guard" in other_proj["hooks"]

    # Both projects now claim the same shared user-scope agent.
    assert ships_with.agent_refcount("orch-implementer", reg) == 2
    assert ships_with.agent_refcount("orch-reviewer", reg) == 2
    # Still exactly one file per harness — never rewritten, never duplicated.
    assert (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert (cli_env["codex_agents"] / "orch-implementer.toml").exists()


# ─────────────────────────────────────────────────────────────────────────────
# C-2 (review milestone 6) — the codex trust grant is ledgered and revoked
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_clears_trust_when_no_other_ledger_needs_it(cli_env):
    hub.cmd_enable(_enable_args(with_companions=True))

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    entry = ships_with.ledger_entry(proj, "orchestrate-advanced")
    assert entry.get("trust") is True
    assert proj["permissions"]["project_trust"] is True

    hub.cmd_disable(_disable_args())

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    assert "orchestrate-advanced" not in ships_with.ledger(proj)
    assert "project_trust" not in (proj.get("permissions") or {})


def test_disable_keeps_trust_when_another_ledger_still_needs_it(cli_env):
    hub.cmd_enable(_enable_args(with_companions=True))

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    # A second skill's ledger entry on the SAME project also needs trust.
    ships_with.set_ledger_entry(
        proj, "other-skill", {"hooks": [], "permissions": [], "agents": [], "trust": True},
    )
    hub_core.save_registry(reg)

    hub.cmd_disable(_disable_args())

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    assert proj["permissions"]["project_trust"] is True  # still needed


# ─────────────────────────────────────────────────────────────────────────────
# 13. reprovision skips an already-present agent (W1)
# ─────────────────────────────────────────────────────────────────────────────


def test_reprovision_skips_already_present_agent(cli_env, monkeypatch):
    hub.cmd_enable(_enable_args(with_companions=True))

    reg = _reload()
    plan = ships_with.plan_provision("orchestrate-advanced", "notes-vault", reg)
    agent_items = [i for i in plan["items"] if i["kind"] == "agent"]
    assert agent_items and all(i["verdict"] == "already_present" for i in agent_items)

    from skill_hub.infrastructure.harnesses import subagents

    calls = []
    orig = subagents.save_agent

    def _tracked(payload, registry=None):
        calls.append(payload)
        return orig(payload, registry)

    monkeypatch.setattr(subagents, "save_agent", _tracked)

    result = skill_cli._apply_companions(reg, "orchestrate-advanced", "notes-vault", plan)
    assert not calls, "save_agent must not be called for an already-claimed agent"
    assert result["agents"] == []  # nothing NEWLY provisioned


# ─────────────────────────────────────────────────────────────────────────────
# 14. rollback on a mid-transaction failure unlinks agents + the sidecar (W1)
# ─────────────────────────────────────────────────────────────────────────────


def test_rollback_unlinks_agents_and_links_sidecar(cli_env, monkeypatch):
    from skill_hub.infrastructure.harnesses import subagent_links, subagents

    reg = _reload()
    plan = ships_with.plan_provision("orchestrate-advanced", "notes-vault", reg)
    agent_items = [i for i in plan["items"] if i["kind"] == "agent"]
    assert len(agent_items) == 4  # 2 agents x 2 harnesses, all will_write

    calls = {"n": 0}
    orig = subagents.save_agent

    def _flaky(payload, registry=None):
        calls["n"] += 1
        if calls["n"] == 4:  # the second agent's second harness
            return {"ok": False, "errors": [{"message": "boom"}]}
        return orig(payload, registry)

    monkeypatch.setattr(subagents, "save_agent", _flaky)

    with pytest.raises(skill_cli._CompanionApplyError):
        skill_cli._apply_companions(reg, "orchestrate-advanced", "notes-vault", plan)

    assert calls["n"] == 4
    assert not (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert not (cli_env["codex_agents"] / "orch-implementer.toml").exists()
    assert not (cli_env["claude_agents"] / "orch-reviewer.md").exists()
    links, _warn = subagent_links.read_links()
    assert not any(e.get("name") == "orch-implementer" for e in links)

    on_disk = _reload()
    assert "orchestrate-advanced" not in (on_disk["projects"]["notes-vault"].get("enabled") or [])
    assert "hooks" not in on_disk  # nothing was ever saved


# ─────────────────────────────────────────────────────────────────────────────
# 15. a single agent-capable harness reports linked: false (W1)
# ─────────────────────────────────────────────────────────────────────────────


def test_single_agent_harness_reports_linked_false(tmp_path, monkeypatch, tmp_data_home):
    home = tmp_path / "home"
    claude = home / ".claude"
    (claude / "projects").mkdir(parents=True)
    (claude / "agents").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))
    monkeypatch.delenv("CODEX_HOME", raising=False)

    skill_dir = _write_skill_dir(tmp_path / "skills")
    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "skills": {
            "orchestrate-advanced": {
                "type": "claude-skill", "scope": "portable",
                "source": str(skill_dir), "description": "x",
            }
        },
        "projects": {"notes-vault": {"path": str(proj_path), "enabled": [], "bundles": [], "harnesses": []}},
        "bundles": {},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    _seed_probe_cache(tmp_data_home, ("claude-code",))
    hub._DATA_HOME_CACHE = None

    with pytest.raises(SystemExit) as ei:
        hub.cmd_enable(_enable_args())
    assert ei.value.code == 2

    reg = _reload()
    plan = ships_with.plan_provision("orchestrate-advanced", "notes-vault", reg)
    assert plan["linked"] is False

    result = skill_cli._apply_companions(reg, "orchestrate-advanced", "notes-vault", plan)
    assert result["agents"] == ["orch-implementer", "orch-reviewer"]
    links_path = tmp_data_home / "state" / "subagents" / "links.json"
    assert not links_path.exists()


# ─────────────────────────────────────────────────────────────────────────────
# 16. an unclaimed collision on a hook/agent name refuses (exit 1, nothing written)
# ─────────────────────────────────────────────────────────────────────────────


def test_enable_refuses_unclaimed_hook_or_agent_collision(cli_env, capsys):
    reg = _reload()
    reg.setdefault("hooks", {})["orch-scope-guard"] = {
        "event": "PreToolUse", "command": "/bin/true",
    }
    hub_core.save_registry(reg)

    with pytest.raises(SystemExit) as ei:
        hub.cmd_enable(_enable_args(with_companions=True))
    assert ei.value.code == 1

    on_disk = _reload()
    assert "orchestrate-advanced" not in (on_disk["projects"]["notes-vault"].get("enabled") or [])
    assert on_disk["hooks"]["orch-scope-guard"]["command"] == "/bin/true"  # untouched
    assert not (cli_env["claude_agents"] / "orch-implementer.md").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 17. --with-refs + --skill-only compose (Req 3)
# ─────────────────────────────────────────────────────────────────────────────


def test_with_refs_and_skill_only_compose(cli_env, capsys):
    helper_dir = _write_skill_dir(cli_env["skill_dir"].parent, name="orch-helper")
    reg = _reload()
    reg["skills"]["orch-helper"] = {
        "type": "claude-skill", "scope": "portable", "source": str(helper_dir), "description": "x",
    }
    # The primary skill's body mentions the helper (backtick reference form).
    skill_md = cli_env["skill_dir"] / "SKILL.md"
    skill_md.write_text(skill_md.read_text().replace("Body.\n", "Body. See `orch-helper`.\n"))
    hub_core.save_registry(reg)

    hub.cmd_enable(_enable_args(with_refs=True, skill_only=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["companions_pending"] == ["orch-helper"]

    on_disk = _reload()
    proj = on_disk["projects"]["notes-vault"]
    assert "orch-helper" in proj["enabled"]
    # Refs are ALWAYS skill-only — never provisioned in the same command.
    assert "orch-helper" not in ships_with.ledger(proj)
    assert "orchestrate-advanced" not in ships_with.ledger(proj)  # --skill-only too


# ─────────────────────────────────────────────────────────────────────────────
# 18. disable removes only ledger items (hand-added twins survive; edited rule kept)
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_removes_only_ledger_items(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()  # discard the enable call's own stdout

    reg = _reload()
    proj = reg["projects"]["notes-vault"]
    # Hand-edit one provisioned rule away — disable must treat it as `kept`,
    # never error, and never touch a hand-added twin.
    proj["permissions"]["deny"] = [
        r for r in proj["permissions"]["deny"] if r.get("pattern") != "Bash(git push --force:*)"
    ]
    proj["permissions"]["deny"].append({"pattern": "Bash(git push --force:*) (hand-edited)", "kind": "deny"})
    hub_core.save_registry(reg)

    hub.cmd_disable(_disable_args(json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    removed = payload["removed_companions"]
    assert removed["hooks"] == ["orch-scope-guard"]
    assert sorted(removed["agents"]) == ["orch-implementer", "orch-reviewer"]
    # The edited-away rule was never in the removed list; the ask rule was.
    # A19/C2 (wave 2): the ledger's own v2 shape carries `added: True`.
    assert {"pattern": "Bash(git push --force:*)", "kind": "deny"} not in removed["permissions"]
    assert {"pattern": "Bash(gh pr merge:*)", "kind": "ask", "added": True} in removed["permissions"]

    on_disk = _reload()
    proj = on_disk["projects"]["notes-vault"]
    assert "orchestrate-advanced" not in ships_with.ledger(proj)
    assert "orch-scope-guard" not in (on_disk.get("hooks") or {})
    # The hand-edited twin survives disable untouched.
    assert any(
        r.get("pattern") == "Bash(git push --force:*) (hand-edited)"
        for r in proj["permissions"]["deny"]
    )
    assert not (cli_env["claude_agents"] / "orch-implementer.md").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 19. disable keeps an agent still referenced by another project's ledger
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_keeps_agent_referenced_by_another_project(cli_env):
    hub.cmd_enable(_enable_args(with_companions=True))

    # A second project's ledger independently claims the SAME shared agent —
    # set up directly here (the disable-side refcount is the thing under
    # test), NOT via a second live `--with-companions` run; that path is
    # covered end-to-end by `test_enable_with_companions_second_project_shares_agent`.
    reg = _reload()
    proj2_path = cli_env["skill_dir"].parent.parent / "proj2"
    proj2_path.mkdir()
    reg["projects"]["other"] = {"path": str(proj2_path), "enabled": [], "bundles": [], "harnesses": []}
    ships_with.set_ledger_entry(
        reg["projects"]["other"], "orchestrate-advanced",
        {"hooks": [], "permissions": [], "agents": ["orch-implementer"]},
    )
    hub_core.save_registry(reg)

    hub.cmd_disable(_disable_args())

    on_disk = _reload()
    assert "orchestrate-advanced" not in ships_with.ledger(on_disk["projects"]["notes-vault"])
    # orch-implementer is still claimed by 'other' -> kept on disk.
    assert (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert (cli_env["codex_agents"] / "orch-implementer.toml").exists()
    # orch-reviewer has no other claimant -> removed.
    assert not (cli_env["claude_agents"] / "orch-reviewer.md").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 20. disable keeps companions when the skill is still active via a bundle (W2)
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_keeps_companions_when_still_active_via_bundle(cli_env):
    hub.cmd_enable(_enable_args(with_companions=True))

    reg = _reload()
    reg["bundles"]["orch-bundle"] = {
        "description": "x", "icon": "📦", "scope": "project-specific",
        "skills": ["orchestrate-advanced"],
    }
    reg["projects"]["notes-vault"]["bundles"] = ["orch-bundle"]
    hub_core.save_registry(reg)

    hub.cmd_disable(_disable_args())

    on_disk = _reload()
    proj = on_disk["projects"]["notes-vault"]
    # Direct equip is gone, but the bundle keeps it active -> companions kept.
    assert "orchestrate-advanced" not in (proj.get("enabled") or [])
    assert "orchestrate-advanced" in ships_with.ledger(proj)
    assert (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert "orch-scope-guard" in (on_disk.get("hooks") or {})


# ─────────────────────────────────────────────────────────────────────────────
# 21. `hub skill companions` JSON shape (A5)
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_companions_json_shape(cli_env, capsys):
    from skill_hub.domain.skills import skill_meta

    # Populate the registry mirror (A6) once, the way `hub sync` would.
    reg = _reload()
    skill_meta.sync_skill_frontmatter_metadata(reg)
    hub_core.save_registry(reg)

    args = argparse.Namespace(name="orchestrate-advanced", project=None, json=True)
    skill_cli.cmd_skill_companions(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["skill"] == "orchestrate-advanced"
    assert payload["project"] is None
    assert payload["declared"]["agents"] == ["orch-implementer", "orch-reviewer"]
    assert payload["items"]
    assert all("provisioned" not in i for i in payload["items"])  # no project given

    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()  # discard the enable call's own stdout
    args2 = argparse.Namespace(name="orchestrate-advanced", project="notes-vault", json=True)
    skill_cli.cmd_skill_companions(args2)
    payload2 = json.loads(capsys.readouterr().out)
    assert payload2["project"] == "notes-vault"
    agent_items = [i for i in payload2["items"] if i["kind"] == "agent"]
    assert agent_items and all(i["provisioned"] is True for i in agent_items)


# ─────────────────────────────────────────────────────────────────────────────
# 22. `hub project remove` / `hub archive` deprovision companions (W3)
# ─────────────────────────────────────────────────────────────────────────────


def test_project_remove_and_archive_deprovision_companions(cli_env):
    hub.cmd_enable(_enable_args(with_companions=True))

    hub.cmd_project_remove(argparse.Namespace(name="notes-vault", dry_run=False, json=False))

    reg = _reload()
    assert "notes-vault" not in reg["projects"]
    assert "orch-scope-guard" not in (reg.get("hooks") or {})
    assert not (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert not (cli_env["codex_agents"] / "orch-reviewer.toml").exists()

    # Re-register a project and re-provision, then archive the skill outright.
    proj2_path = cli_env["skill_dir"].parent.parent / "proj2"
    proj2_path.mkdir()
    reg = _reload()
    reg["projects"]["notes-vault"] = {
        "path": str(proj2_path), "enabled": [], "bundles": [], "harnesses": [],
    }
    hub_core.save_registry(reg)
    hub.cmd_enable(_enable_args(with_companions=True))

    hub.cmd_archive(argparse.Namespace(skills=["orchestrate-advanced"], dry_run=False, json=False))

    reg = _reload()
    assert "orchestrate-advanced" not in reg["skills"]
    assert "orch-scope-guard" not in (reg.get("hooks") or {})
    assert "orchestrate-advanced" not in ships_with.ledger(reg["projects"]["notes-vault"])
    assert not (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert not (cli_env["codex_agents"] / "orch-reviewer.toml").exists()


# ─────────────────────────────────────────────────────────────────────────────
# W-2 (review milestone 6) — dry-run previews the companions that would be
# deprovisioned, and `hub unarchive` is honest about not restoring them
# ─────────────────────────────────────────────────────────────────────────────


def test_project_remove_dry_run_json_lists_companions(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    hub.cmd_project_remove(argparse.Namespace(name="notes-vault", dry_run=True, json=True))
    plan = json.loads(capsys.readouterr().out)
    comp = plan["companions"]["orchestrate-advanced"]
    assert comp["hooks"] == ["orch-scope-guard"]
    assert sorted(comp["agents"]) == ["orch-implementer", "orch-reviewer"]

    # Dry-run — nothing actually touched.
    reg = _reload()
    assert "notes-vault" in reg["projects"]
    assert "orch-scope-guard" in (reg.get("hooks") or {})


def test_archive_dry_run_json_lists_companions(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    hub.cmd_archive(
        argparse.Namespace(skills=["orchestrate-advanced"], dry_run=True, json=True)
    )
    payload = json.loads(capsys.readouterr().out)
    refs = payload["plan"][0]["references"]
    comp = refs["companions"]["notes-vault"]
    assert comp["hooks"] == ["orch-scope-guard"]
    assert sorted(comp["agents"]) == ["orch-implementer", "orch-reviewer"]

    # Dry-run — nothing actually touched.
    reg = _reload()
    assert "orchestrate-advanced" in reg["skills"]
    assert "orch-scope-guard" in (reg.get("hooks") or {})


def test_unarchive_reports_companions_not_restored(cli_env, capsys):
    hub.cmd_enable(_enable_args(with_companions=True))
    capsys.readouterr()

    hub.cmd_archive(argparse.Namespace(skills=["orchestrate-advanced"], dry_run=False, json=False))
    capsys.readouterr()

    hub.cmd_unarchive(argparse.Namespace(skills=["orchestrate-advanced"], json=True))
    # `json.dumps(..., indent=2)` is multi-line, and the auto-sync tail's own
    # chatter follows it on the same stream — decode just the leading object.
    payload, _end = json.JSONDecoder().raw_decode(capsys.readouterr().out)
    assert payload["restored"] == ["orchestrate-advanced"]
    assert payload["companions_not_restored"] == {"orchestrate-advanced": ["notes-vault"]}

    reg = _reload()
    assert "orchestrate-advanced" in reg["skills"]
    proj = reg["projects"]["notes-vault"]
    # Consistent with what archive did: the skill is back, equipped, but its
    # ships_with companions were fully deprovisioned and are NOT silently
    # resurrected — the ledger stays empty, nothing is on disk to claim.
    assert "orchestrate-advanced" in (proj.get("enabled") or [])
    assert "orchestrate-advanced" not in ships_with.ledger(proj)
    assert "orch-scope-guard" not in (reg.get("hooks") or {})
    assert not (cli_env["claude_agents"] / "orch-implementer.md").exists()


def test_provision_with_an_effective_harness_that_has_no_agents_skips_it(cli_env, capsys):
    """The real first equip: `harnesses_global` = claude-code + pi + codex.
    `pi` has no sub-agent concept, so `plan_provision` emits an `unsupported`
    row for it — and the apply must never feed that id to
    `subagents._find_agent_file` (which raises `ValueError` for it). Before
    the fix, the link-eligibility check did exactly that after every agent
    file was written, and the rollback undid the whole provisioning while
    the equip itself stayed — hooks absent from the library, no ledger."""
    home = cli_env["home"]
    (home / ".pi" / "agent").mkdir(parents=True)  # pi's install marker
    reg = _reload()
    reg["harnesses_global"] = ["claude-code", "pi", "codex"]
    hub_core.save_registry(reg)

    plan = ships_with.plan_provision("orchestrate-advanced", "notes-vault", _reload())
    pi_rows = [it for it in plan["items"] if it["kind"] == "agent" and it["harness"] == "pi"]
    assert pi_rows and all(it["verdict"] == "unsupported" for it in pi_rows)
    assert plan["linked"] is True  # claude-code + codex still qualify

    hub.cmd_enable(_enable_args(with_companions=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert sorted(payload["provisioned"]["agents"]) == ["orch-implementer", "orch-reviewer"]

    reg = _reload()
    entry = ships_with.ledger_entry(reg["projects"]["notes-vault"], "orchestrate-advanced")
    assert sorted(entry["agents"]) == ["orch-implementer", "orch-reviewer"]
    assert entry["hooks"] == ["orch-scope-guard"]
    assert "orch-scope-guard" in reg["hooks"]
    assert (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert (cli_env["codex_agents"] / "orch-implementer.toml").exists()
    assert sorted(entry["agent_state"]["orch-implementer"]["files"]) == ["claude-code", "codex"]

    from skill_hub.infrastructure.harnesses import subagent_links

    link = subagent_links.find_link("orch-implementer", scope="user")
    assert link is not None and sorted(link["harnesses"]) == ["claude-code", "codex"]


def test_provision_with_only_agentless_harnesses_claims_no_agent(cli_env, capsys):
    """Review R1 on the fix above: a project whose ONLY effective harness has
    no sub-agent concept must not report agents as provisioned (with
    `files: {}`) — hooks and rules still land, agents are simply not claimed,
    so a later disable has nothing phantom to remove."""
    home = cli_env["home"]
    (home / ".pi" / "agent").mkdir(parents=True)
    reg = _reload()
    reg["harnesses_global"] = ["pi"]
    hub_core.save_registry(reg)

    hub.cmd_enable(_enable_args(with_companions=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert payload["provisioned"]["agents"] == []

    reg = _reload()
    entry = ships_with.ledger_entry(reg["projects"]["notes-vault"], "orchestrate-advanced")
    assert entry["agents"] == []
    assert entry.get("agent_state", {}) == {}
    assert not (cli_env["claude_agents"] / "orch-implementer.md").exists()
    assert not (cli_env["codex_agents"] / "orch-implementer.toml").exists()
