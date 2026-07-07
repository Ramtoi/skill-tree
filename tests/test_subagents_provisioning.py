"""Tests for the D5 attach-skill provisioning two-phase protocol.

Phase 1: `save` reports a NEWLY-attached, unresolved, in-registry skill as a
BLOCKING error carrying `needs_provisioning`. Phase 2:
`hub subagent provision-skill` flips scope (global) or enables + resyncs
(project), verifies the path on disk, and then a re-save validates clean.

Isolation mirrors test_subagents_codex.py: every test isolates $HOME (claude +
codex detection markers and the ~/.agents/skills root), $CODEX_HOME (codex
agents dir), $SKILL_HUB_CLAUDE_HOME (claude home) and — via tmp_data_home —
SKILL_HUB_HOME (registry + backups). No test touches the real ~/.claude,
~/.codex or ~/.agents, and none invokes the real codex/claude binary.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import hub
import subagents


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures + helpers
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def prov_env(tmp_path, monkeypatch, tmp_data_home):
    """Isolated HOME with BOTH claude-code and codex detected as installed.

    Detection markers (DotDirWithMarker, ~-expanded via $HOME):
      - claude-code: $HOME/.claude/projects
      - codex:       $HOME/.codex/config.toml
    SKILL_HUB_CLAUDE_HOME == $HOME/.claude so the claude skill-resolution dir and
    the claude global_skills_dir are the SAME path; CODEX_HOME == $HOME/.codex so
    codex agents + detection marker are consistent. The codex skills root is
    $HOME/.agents/skills for both resolution and the global pass.
    """
    home = tmp_path / "home"
    claude = home / ".claude"
    codex = home / ".codex"
    (claude / "projects").mkdir(parents=True)   # claude-code detection marker
    (claude / "agents").mkdir(parents=True)
    (claude / "skills").mkdir(parents=True)
    (codex / "agents").mkdir(parents=True)
    (codex / "config.toml").write_text("")      # codex detection marker
    (home / ".agents" / "skills").mkdir(parents=True)

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))

    # A real skill SOURCE dir the registry points at.
    src = tmp_path / "skillsrc" / "myskill"
    src.mkdir(parents=True)
    (src / "SKILL.md").write_text("---\nname: myskill\ndescription: my skill\n---\nBody\n")

    proj = tmp_path / "proj"
    (proj / ".claude" / "agents").mkdir(parents=True)

    env = {
        "home": home,
        "claude": claude,
        "codex": codex,
        "claude_agents": claude / "agents",
        "claude_skills": claude / "skills",
        "codex_agents": codex / "agents",
        "codex_skills_root": home / ".agents" / "skills",
        "src": src,
        "proj": proj,
        "data_home": tmp_data_home,
    }
    write_registry(env)
    return env


def write_registry(env, *, skill_over=None, projects=None):
    """Write registry.yaml with one portable skill `myskill` (+ optional project)."""
    skill = {
        "source": str(env["src"]),
        "scope": "portable",
        "type": "claude-skill",
        "description": "my skill",
    }
    skill.update(skill_over or {})
    reg = {
        "harnesses_global": ["claude-code", "codex"],
        "skills": {"myskill": skill},
        "projects": projects or {},
    }
    (env["data_home"] / "registry.yaml").write_text(yaml.safe_dump(reg))
    return reg


def load_reg():
    hub._DATA_HOME_CACHE = None
    return hub.load_registry()


def claude_payload(name="probe", skills=None, original_name=None):
    return {
        "harness": "claude-code", "scope": "user", "project": None,
        "original_name": original_name,
        "safe": {"name": name, "description": "a probe", "model": "",
                 "tools_mode": "all", "tools": [], "disallowed_tools": [],
                 "allow_skill_discovery": True, "skills": skills or [], "color": ""},
        "advanced_yaml": "", "body": "Do the thing.\n",
    }


def codex_payload(name="probe", skills=None, original_name=None):
    return {
        "harness": "codex", "scope": "user", "project": None,
        "original_name": original_name,
        "safe": {"name": name, "description": "a probe", "model": "",
                 "sandbox_mode": "", "model_reasoning_effort": "",
                 "skills": skills or [], "nickname_candidates": []},
        "advanced_yaml": "", "body": "Do the thing.\n",
    }


def project_claude_payload(name="probe", skills=None, original_name=None):
    return {
        "harness": "claude-code", "scope": "project", "project": "proj",
        "original_name": original_name,
        "safe": {"name": name, "description": "a probe", "model": "",
                 "tools_mode": "all", "tools": [], "disallowed_tools": [],
                 "allow_skill_discovery": True, "skills": skills or [], "color": ""},
        "advanced_yaml": "", "body": "Do the thing.\n",
    }


def prov_warning(res):
    """The first warning carrying a needs_provisioning detail, or None."""
    for w in res.get("errors", []):
        if isinstance(w, dict) and w.get("needs_provisioning"):
            return w
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 — save reports needs_provisioning (never provisions)
# ─────────────────────────────────────────────────────────────────────────────


def test_save_claude_user_attach_registry_skill_blocks_make_global(prov_env):
    res = subagents.save_agent(claude_payload(skills=["myskill"]), load_reg())
    assert res["ok"] is False
    w = prov_warning(res)
    assert w is not None, res
    assert w["field"] == "skills" and w["level"] == "error"
    assert w["value"] == "myskill"
    np = w["needs_provisioning"]
    assert np == {"skill": "myskill", "scope_fix": "make-global",
                  "consequence": np["consequence"]}
    assert "global" in np["consequence"].lower()
    # File was NOT written.
    assert not (prov_env["claude_agents"] / "probe.md").exists()


def test_save_codex_user_attach_registry_skill_blocks_make_global(prov_env):
    res = subagents.save_agent(codex_payload(skills=["myskill"]), load_reg())
    assert res["ok"] is False
    w = prov_warning(res)
    assert w is not None, res
    assert w["needs_provisioning"]["scope_fix"] == "make-global"
    assert not (prov_env["codex_agents"] / "probe.toml").exists()


def test_save_project_attach_registry_skill_blocks_project_enable(prov_env):
    write_registry(prov_env, projects={"proj": {"path": str(prov_env["proj"]),
                                                 "harnesses": []}})
    res = subagents.save_agent(project_claude_payload(skills=["myskill"]), load_reg())
    assert res["ok"] is False
    w = prov_warning(res)
    assert w is not None, res
    assert w["needs_provisioning"]["scope_fix"] == "project-enable"
    assert "proj" in w["needs_provisioning"]["consequence"]


def test_save_non_registry_skill_is_warning_only(prov_env):
    res = subagents.save_agent(claude_payload(skills=["ghost"]), load_reg())
    assert res["ok"] is True, res
    assert prov_warning(res) is None
    assert any(w["field"] == "skills" and w["level"] == "warn"
               for w in res["warnings"])
    assert (prov_env["claude_agents"] / "probe.md").exists()


def test_save_preexisting_unresolved_skill_stays_warning(prov_env):
    """A save that does NOT newly attach the unresolved skill (it was already in
    the file) must stay a plain warning, not start failing."""
    # Seed the agent file directly with an unresolved (but in-registry) skill.
    (prov_env["claude_agents"] / "probe.md").write_text(
        "---\nname: probe\ndescription: a probe\nskills:\n- myskill\n---\nDo the thing.\n")
    # Re-save (edit body only) — myskill is pre-existing, not newly attached.
    res = subagents.save_agent(
        claude_payload(skills=["myskill"], original_name="probe"), load_reg())
    assert res["ok"] is True, res
    assert prov_warning(res) is None
    assert any(w["field"] == "skills" and w["level"] == "warn"
               for w in res["warnings"])


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — provision-skill --global
# ─────────────────────────────────────────────────────────────────────────────


def test_provision_global_flips_scope_and_symlinks_all_harnesses(prov_env):
    res = hub._provision_skill("myskill", None, True, "claude-code", False)
    assert res["ok"] is True, res
    assert res["mode"] == "make-global"
    assert res["widened_affinity"] is False
    # Verified path is the claude global dir.
    assert res["path"] == str(prov_env["claude_skills"] / "myskill" / "SKILL.md")
    assert Path(res["path"]).exists()

    # Symlinks landed in BOTH installed harness global dirs (affinity admits all).
    assert (prov_env["claude_skills"] / "myskill").is_symlink()
    assert (prov_env["codex_skills_root"] / "myskill").is_symlink()

    # Registry scope was flipped to global on disk.
    reg = load_reg()
    assert reg["skills"]["myskill"]["scope"] == "global"

    # Re-save now validates clean (skill resolves via the new symlink).
    res2 = subagents.save_agent(claude_payload(skills=["myskill"]), load_reg())
    assert res2["ok"] is True, res2
    assert prov_warning(res2) is None


def test_provision_global_codex_harness_verifies_agents_skills_path(prov_env):
    res = hub._provision_skill("myskill", None, True, "codex", False)
    assert res["ok"] is True, res
    assert res["path"] == str(prov_env["codex_skills_root"] / "myskill" / "SKILL.md")
    # Codex re-save clean.
    res2 = subagents.save_agent(codex_payload(skills=["myskill"]), load_reg())
    assert res2["ok"] is True, res2


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — provision-skill --project
# ─────────────────────────────────────────────────────────────────────────────


def test_provision_project_enables_and_symlinks(prov_env):
    write_registry(prov_env, projects={"proj": {"path": str(prov_env["proj"]),
                                                 "harnesses": []}})
    res = hub._provision_skill("myskill", "proj", False, "claude-code", False)
    assert res["ok"] is True, res
    assert res["mode"] == "project-enable"
    expected = prov_env["proj"] / ".claude" / "skills" / "myskill" / "SKILL.md"
    assert res["path"] == str(expected)
    assert expected.exists()
    assert (prov_env["proj"] / ".claude" / "skills" / "myskill").is_symlink()

    # enabled[] appended in the registry (deduped).
    reg = load_reg()
    assert reg["projects"]["proj"]["enabled"] == ["myskill"]
    # Idempotent: a second provision does not double-append.
    hub._provision_skill("myskill", "proj", False, "claude-code", False)
    assert load_reg()["projects"]["proj"]["enabled"] == ["myskill"]

    # Re-save of the project agent validates clean.
    res2 = subagents.save_agent(project_claude_payload(skills=["myskill"]), load_reg())
    assert res2["ok"] is True, res2


# ─────────────────────────────────────────────────────────────────────────────
# Guards
# ─────────────────────────────────────────────────────────────────────────────


def test_provision_remote_origin_refused_registry_unchanged(prov_env):
    write_registry(prov_env, skill_over={"origin": "remote:hermes"})
    before = load_reg()["skills"]["myskill"]   # after migration normalization
    res = hub._provision_skill("myskill", None, True, "claude-code", False)
    assert res["ok"] is False
    assert "quarantined" in res["error"].lower()
    assert "hermes" in res["error"]
    # Skill entry untouched (scope not flipped), no symlink created.
    assert load_reg()["skills"]["myskill"] == before
    assert load_reg()["skills"]["myskill"]["scope"] == "portable"
    assert not (prov_env["claude_skills"] / "myskill").exists()


def test_provision_affinity_excluded_refused_then_widened(prov_env):
    # Skill restricted to codex only — provisioning for claude-code would dangle.
    write_registry(prov_env, skill_over={"harnesses": ["codex"]})
    res = hub._provision_skill("myskill", None, True, "claude-code", False)
    assert res["ok"] is False
    assert res["widen_available"] is True
    assert res["affinity"] == ["codex"]
    # Nothing mutated.
    assert load_reg()["skills"]["myskill"]["scope"] == "portable"

    # With --widen-affinity the restriction is CLEARED and provisioning proceeds.
    res2 = hub._provision_skill("myskill", None, True, "claude-code", True)
    assert res2["ok"] is True, res2
    assert res2["widened_affinity"] is True
    reg = load_reg()
    assert "harnesses" not in reg["skills"]["myskill"]     # affinity cleared
    assert reg["skills"]["myskill"]["scope"] == "global"
    assert (prov_env["claude_skills"] / "myskill").is_symlink()


def test_provision_unknown_skill_refused(prov_env):
    res = hub._provision_skill("nope", None, True, "claude-code", False)
    assert res["ok"] is False and "unknown skill" in res["error"]


def test_provision_unknown_project_refused(prov_env):
    res = hub._provision_skill("myskill", "ghost-proj", False, "claude-code", False)
    assert res["ok"] is False and "unknown project" in res["error"]


def test_provision_requires_exactly_one_scope(prov_env):
    # Neither project nor global.
    res = hub._provision_skill("myskill", None, False, "claude-code", False)
    assert res["ok"] is False and "exactly one" in res["error"]


# ─────────────────────────────────────────────────────────────────────────────
# cmd_sync global pass unchanged (extraction sanity)
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_global_skills_pass_symlinks_global_scope(prov_env, capsys):
    """The extracted _sync_global_skills owns the global pass: a scope:global
    skill lands in each installed harness global dir."""
    write_registry(prov_env, skill_over={"scope": "global"})
    reg = load_reg()
    import harnesses as _h
    installed = _h.detect_installed()
    assert {"claude-code", "codex"} <= installed
    names = hub._sync_global_skills(reg, installed)
    assert names == {"myskill"}
    assert (prov_env["claude_skills"] / "myskill").is_symlink()
    assert (prov_env["codex_skills_root"] / "myskill").is_symlink()


# ─────────────────────────────────────────────────────────────────────────────
# CLI e2e (subprocess)
# ─────────────────────────────────────────────────────────────────────────────


def _cli_env(prov_env):
    e = dict(os.environ)
    e["HOME"] = str(prov_env["home"])
    e["CODEX_HOME"] = str(prov_env["codex"])
    e["SKILL_HUB_CLAUDE_HOME"] = str(prov_env["claude"])
    e["SKILL_HUB_HOME"] = str(prov_env["data_home"])
    e.pop("SKILL_HUB_DIR", None)
    e.pop("SKILL_HUB_CODE", None)
    return e


def _run(prov_env, *args):
    proc = subprocess.run(
        [sys.executable, "hub.py", "subagent", "provision-skill", *args],
        cwd=str(Path(__file__).resolve().parent.parent),
        env=_cli_env(prov_env), capture_output=True, text=True)
    return proc


def test_cli_provision_global_ok(prov_env):
    proc = _run(prov_env, "--skill", "myskill", "--global", "--json")
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)   # stdout is clean JSON (sync log → stderr)
    assert out["ok"] is True
    assert out["mode"] == "make-global"
    assert Path(out["path"]).exists()


def test_cli_provision_remote_origin_refused(prov_env):
    write_registry(prov_env, skill_over={"origin": "remote:hermes"})
    proc = _run(prov_env, "--skill", "myskill", "--global", "--json")
    assert proc.returncode == 1
    out = json.loads(proc.stdout)
    assert out["ok"] is False and "quarantined" in out["error"].lower()


# ─────────────────────────────────────────────────────────────────────────────
# Registry rollback on failed verification (tywin findings #2/#3)
# ─────────────────────────────────────────────────────────────────────────────


def test_global_provision_verify_failure_rolls_back_registry(prov_env):
    """A make-global whose sync cannot produce the link (missing source) must
    NOT leave the skill flipped to scope: global (silent fan-out on later
    syncs) nor keep a cleared affinity."""
    import yaml
    reg_path = prov_env["data_home"] / "registry.yaml"
    reg = yaml.safe_load(reg_path.read_text())
    reg["skills"]["ghostsrc"] = {
        "source": "~/nowhere/ghostsrc",   # missing source ⇒ global pass skips it
        "type": "claude-skill",
        "scope": "project-specific",
        "harnesses": ["codex"],           # excludes claude-code ⇒ widen path too
    }
    reg_path.write_text(yaml.safe_dump(reg, sort_keys=False))
    proc = _run(prov_env, "--skill", "ghostsrc", "--global",
                "--harness", "claude-code", "--widen-affinity", "--json")
    assert proc.returncode != 0
    out = json.loads(proc.stdout)
    assert out["ok"] is False and "No registry changes were kept" in out["error"]
    reg2 = yaml.safe_load(reg_path.read_text())
    cfg = reg2["skills"]["ghostsrc"]
    assert cfg["scope"] == "project-specific"      # scope flip rolled back
    assert cfg.get("harnesses") == ["codex"]        # widened affinity restored


def test_project_provision_verify_failure_rolls_back_enabled(prov_env):
    """A project-enable whose targeted sync cannot produce the link must not
    keep the appended `enabled` entry."""
    import yaml
    reg_path = prov_env["data_home"] / "registry.yaml"
    reg = yaml.safe_load(reg_path.read_text())
    reg["skills"]["ghostsrc"] = {
        "source": "~/nowhere/ghostsrc",
        "type": "claude-skill",
        "scope": "project-specific",
    }
    reg["projects"] = {"demo": {"path": str(prov_env["proj"]), "enabled": []}}
    reg_path.write_text(yaml.safe_dump(reg, sort_keys=False))
    proc = _run(prov_env, "--skill", "ghostsrc", "--project", "demo",
                "--harness", "claude-code", "--json")
    assert proc.returncode != 0
    out = json.loads(proc.stdout)
    assert out["ok"] is False and "No registry changes were kept" in out["error"]
    reg2 = yaml.safe_load(reg_path.read_text())
    assert reg2["projects"]["demo"].get("enabled") in ([], None)
