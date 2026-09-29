"""Round-trip tests for a `ships_with` skill crossing hub-to-hub boundaries
(W6 of the ships-with-4 orchestration workspace, milestone 5a, plan 1).

Proves the additive executable bit (W1 pack, W2 `SkillTree`, W3 SSH
transport) and the auto-sync-on-import mirror (W5) together, against the
full on-disk `orchestrate-advanced` fixture (four `scripts/*.sh`, six
`agents/*.md`, three hooks) that `tests/test_ships_with_cli.py` and
`tests/test_ships_with_companions_cli.py` already exercise for provisioning.

Every test copies the fixture fresh into `tmp_path` — the checked-in tree
under `tests/fixtures/ships_with/orchestrate-advanced` is never mutated.
"""

from __future__ import annotations

import json
import shutil
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

import hub
from skill_hub import hub_core
from skill_hub.domain.skills import ships_with, skill_meta
from skill_hub.infrastructure.harnesses import harness_probe

FIXTURE_ORCHESTRATE_ADVANCED = (
    Path(__file__).parent / "fixtures" / "ships_with" / "orchestrate-advanced"
)

FIXTURE_SCRIPTS = [
    "scope-guard.sh",
    "report-guard.sh",
    "unit-brief.sh",
    "run-codex-chunk.sh",
]

FIXTURE_AGENTS = [
    "orch-sub-orchestrator",
    "orch-researcher",
    "orch-planner",
    "orch-griller",
    "orch-implementer",
    "orch-reviewer",
]

FIXTURE_HOOK_NAMES = {"orch-scope-guard", "orch-report-guard", "orch-unit-brief"}


def _seed_probe_cache(data_home: Path, harness_ids=("claude-code", "codex")) -> None:
    cache = {
        hid: harness_probe.HookCapability(harness_id=hid, verdict="supported", reason="ok")
        for hid in harness_ids
    }
    harness_probe.save_cache(cache, data_home)


@pytest.fixture
def env(tmp_path, monkeypatch, tmp_data_home):
    """claude-code + codex installed, one project, harness-probe cache
    seeded `supported` — the `cli_env` shape from
    `tests/test_ships_with_companions_cli.py`. Each test registers its own
    fresh copy of the fixture at the point in the story it needs one."""
    home = tmp_path / "home"
    claude = home / ".claude"
    codex = home / ".codex"
    (claude / "projects").mkdir(parents=True)  # claude-code detection marker
    (claude / "agents").mkdir(parents=True)
    (codex / "agents").mkdir(parents=True)
    (codex / "config.toml").write_text("")  # codex detection marker

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))

    proj_path = tmp_path / "proj"
    proj_path.mkdir()

    registry = {
        "harnesses_global": ["claude-code", "codex"],
        "skills": {},
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
        "proj_path": proj_path,
        "claude_agents": claude / "agents",
        "codex_agents": codex / "agents",
        "data_home": tmp_data_home,
    }


def _register_fixture_copy(tmp_path: Path, name: str = "orchestrate-advanced") -> Path:
    """A fresh copy of the checked-in fixture, registered as `name`."""
    skill_dir = tmp_path / "skills" / name
    shutil.copytree(FIXTURE_ORCHESTRATE_ADVANCED, skill_dir)
    reg = hub.load_registry()
    reg.setdefault("skills", {})[name] = {
        "type": "claude-skill",
        "scope": "portable",
        "source": str(skill_dir),
        "description": "x",
    }
    hub_core.save_registry(reg)
    return skill_dir


def _export_pack(name: str, out: Path) -> None:
    hub.cmd_skill_export(Namespace(name=name, out=str(out), json=False))


def _import_pack(pack: Path, *, name=None, json_mode=False):
    hub.cmd_skill_import(Namespace(file=str(pack), dry_run=False, name=name, json=json_mode))


def _roundtrip(tmp_path: Path, *, imported_name: str = "orchestrate-advanced-2") -> Path:
    """Register the fixture, export it, import it under `imported_name`.

    Returns the imported skill's on-disk dir.
    """
    _register_fixture_copy(tmp_path)
    pack_path = tmp_path / "orchestrate-advanced.skillpack"
    _export_pack("orchestrate-advanced", pack_path)
    _import_pack(pack_path, name=imported_name)
    return hub.hub_skills_dir() / imported_name


def _enable_args(**overrides) -> Namespace:
    base = dict(
        skill="orchestrate-advanced-2",
        project="notes-vault",
        with_refs=False,
        with_companions=False,
        skill_only=False,
        json=False,
    )
    base.update(overrides)
    return Namespace(**base)


def test_pack_roundtrip_preserves_ships_with_and_exec_bit(env, tmp_path):
    dest = _roundtrip(env["tmp_path"])

    assert dest.is_dir()

    src_meta = skill_meta.parse_skill_frontmatter(FIXTURE_ORCHESTRATE_ADVANCED / "SKILL.md")
    dst_meta = skill_meta.parse_skill_frontmatter(dest / "SKILL.md")
    assert dst_meta["ships_with"] == src_meta["ships_with"]

    for script in FIXTURE_SCRIPTS:
        assert (dest / "scripts" / script).stat().st_mode & 0o100, (
            f"{script} lost its executable bit on import"
        )

    # A control file written by `write_bytes` in THIS process, so the
    # "unchanged mode" assertion holds at any umask (the T1.5 idiom).
    control = tmp_path / "control.md"
    control.write_bytes(b"control\n")
    for agent in FIXTURE_AGENTS:
        src_file = FIXTURE_ORCHESTRATE_ADVANCED / "agents" / f"{agent}.md"
        dst_file = dest / "agents" / f"{agent}.md"
        assert dst_file.is_file()
        assert dst_file.read_text() == src_file.read_text()
        assert dst_file.stat().st_mode == control.stat().st_mode


def test_pack_roundtrip_then_enable_with_companions_succeeds(env, tmp_path, capsys):
    dest = _roundtrip(env["tmp_path"])
    capsys.readouterr()  # discard export/import chatter

    hub.cmd_enable(_enable_args(with_companions=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True

    reg = hub.load_registry()
    assert "orch-scope-guard" in (reg.get("hooks") or {})
    command = reg["hooks"]["orch-scope-guard"]["command"]
    expected = (dest / "scripts" / "scope-guard.sh").resolve(strict=False)
    assert Path(command).resolve(strict=False) == expected
    assert Path(command).is_file()
    assert Path(command).stat().st_mode & 0o100, "resolved hook command is not executable"


def test_pack_import_mirrors_ships_with_without_manual_sync(env, tmp_path):
    _roundtrip(env["tmp_path"])

    reg = hub.load_registry()
    mirror = reg["skills"]["orchestrate-advanced-2"].get("ships_with")
    assert mirror is not None, "the ships_with mirror must land in the import command itself"
    assert sorted(mirror.get("agents") or []) == sorted(FIXTURE_AGENTS)
    assert {h["name"] for h in mirror.get("hooks") or []} == FIXTURE_HOOK_NAMES
    assert mirror.get("permissions") == {
        "deny": ["Bash(git push --force:*)"],
        "ask": ["Bash(gh pr merge:*)"],
    }


def test_project_import_skill_roundtrip_preserves_exec_bit_and_mirror(env):
    proj_path = env["proj_path"]
    project_skill_dir = proj_path / ".claude" / "skills" / "orchestrate-advanced"
    shutil.copytree(FIXTURE_ORCHESTRATE_ADVANCED, project_skill_dir)

    hub.cmd_project_import_skill(
        SimpleNamespace(project="notes-vault", name="orchestrate-advanced")
    )

    reg = hub.load_registry()
    dest = hub.hub_skills_dir() / "orchestrate-advanced"
    assert dest.is_dir()
    assert "orchestrate-advanced" in (reg["projects"]["notes-vault"].get("enabled") or [])

    for script in FIXTURE_SCRIPTS:
        assert (dest / "scripts" / script).stat().st_mode & 0o100, (
            f"{script} lost its executable bit through copytree adoption"
        )

    mirror = reg["skills"]["orchestrate-advanced"].get("ships_with")
    assert mirror is not None, "the mirror must land in the import command itself"
    assert sorted(mirror.get("agents") or []) == sorted(FIXTURE_AGENTS)
    assert {h["name"] for h in mirror.get("hooks") or []} == FIXTURE_HOOK_NAMES


def test_roundtrip_with_an_agentless_harness_in_the_effective_set(env, tmp_path, capsys):
    """The pattern of the two newest tests in `tests/test_ships_with_cli.py`:
    `harnesses_global` widens to include `pi`, whose install marker is
    present but which has no sub-agent concept — `plan_provision` must
    report its agent rows `unsupported` (never feeding `pi` to
    `subagents._find_agent_file`, which raises for it), and provisioning
    the ROUND-TRIPPED (imported) skill must still succeed end to end."""
    dest = _roundtrip(env["tmp_path"])
    capsys.readouterr()  # discard export/import chatter

    (env["home"] / ".pi" / "agent").mkdir(parents=True)  # pi's install marker
    reg = hub.load_registry()
    reg["harnesses_global"] = ["claude-code", "pi", "codex"]
    hub_core.save_registry(reg)

    plan = ships_with.plan_provision(
        "orchestrate-advanced-2", "notes-vault", hub.load_registry()
    )
    pi_rows = [it for it in plan["items"] if it["kind"] == "agent" and it["harness"] == "pi"]
    assert pi_rows and all(it["verdict"] == "unsupported" for it in pi_rows)
    assert plan["linked"] is True  # claude-code + codex still both qualify

    hub.cmd_enable(_enable_args(with_companions=True, json=True))
    payload = json.loads(capsys.readouterr().out.splitlines()[0])
    assert payload["ok"] is True
    assert sorted(payload["provisioned"]["agents"]) == sorted(FIXTURE_AGENTS)

    reg = hub.load_registry()
    entry = ships_with.ledger_entry(reg["projects"]["notes-vault"], "orchestrate-advanced-2")
    assert sorted(entry["agents"]) == sorted(FIXTURE_AGENTS)
    for agent in FIXTURE_AGENTS:
        assert sorted(entry["agent_state"][agent]["files"]) == ["claude-code", "codex"]

    # And the resolved hook command still points at the imported, executable
    # script — the round trip's whole point, now proven under a third
    # effective harness that ships no agents at all.
    command = reg["hooks"]["orch-scope-guard"]["command"]
    assert Path(command).resolve(strict=False) == (
        dest / "scripts" / "scope-guard.sh"
    ).resolve(strict=False)
    assert Path(command).stat().st_mode & 0o100
