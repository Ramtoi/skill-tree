"""Tests for the codex harness path of subagents.py + subagent_codex.py.

Isolation: every test isolates $HOME (the codex skills root ~/.agents/skills
resolves via expanduser), $CODEX_HOME (the agents dir), and — via tmp_data_home
— SKILL_HUB_HOME (backups). No test touches the real ~/.codex, ~/.agents or
~/.claude, and none invokes the real codex binary (live gates are separate,
`-m live_codex`).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import subagents
import subagent_codex as sc


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def codex_env(tmp_path, monkeypatch, tmp_data_home):
    """Isolated HOME + CODEX_HOME with agents/ + ~/.agents/skills dirs."""
    home = tmp_path / "home"
    codex_home = tmp_path / "codexhome"
    (codex_home / "agents").mkdir(parents=True)
    (home / ".agents" / "skills").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    # Claude home isolated too — skill_usage scans it.
    claude = tmp_path / "claude"
    (claude / "agents").mkdir(parents=True)
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))
    return {"home": home, "codex_home": codex_home, "claude": claude,
            "skills_root": home / ".agents" / "skills",
            "agents": codex_home / "agents"}


def write_codex_agent(env, filename: str, content: str) -> Path:
    p = env["agents"] / filename
    p.write_text(content)
    return p


def write_codex_skill(env, name: str, disable_invocation: bool = False) -> Path:
    d = env["skills_root"] / name
    d.mkdir(parents=True, exist_ok=True)
    inv = "\ndisable-model-invocation: true" if disable_invocation else ""
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: a skill{inv}\n---\nBody\n")
    return d


def make_save_payload(**over) -> dict:
    safe = {
        "name": "probe", "description": "a probe", "model": "",
        "sandbox_mode": "", "model_reasoning_effort": "",
        "skills": [], "nickname_candidates": [],
    }
    safe.update(over.pop("safe", {}))
    payload = {
        "harness": "codex", "scope": "user", "project": None,
        "original_name": None, "safe": safe,
        "advanced_yaml": "", "body": "Do the thing.\n",
    }
    payload.update(over)
    return payload


REAL_SHAPE = '''name = "pr_explorer"
description = "Read-only codebase explorer."
model = "gpt-5.3-codex-spark"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
developer_instructions = """
Stay in exploration mode.
Prefer fast search over broad scans.
"""
'''


# ─────────────────────────────────────────────────────────────────────────────
# Round-trip
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_real_docs_shape(codex_env):
    doc = sc.parse_codex_agent(REAL_SHAPE)
    fm = doc["frontmatter"]
    assert fm["name"] == "pr_explorer"
    assert fm["sandbox_mode"] == "read-only"
    assert "exploration mode" in doc["body"]


def test_roundtrip_fixed_point_with_unknown_keys(codex_env):
    text = REAL_SHAPE + '\ncustom_key = "kept"\n\n[custom_table]\nx = 1\n'
    write_codex_agent(codex_env, "pr_explorer.toml", text)
    show = subagents.show_agent("pr_explorer", "user", None, None, "codex")
    assert show["exists"] and show["advanced_format"] == "toml"
    assert "custom_key" in show["advanced_yaml"]
    assert "custom_table" in show["advanced_yaml"]
    # Resave untouched → unknown keys survive; parse fixed-point.
    res = subagents.save_agent({
        "harness": "codex", "scope": "user", "original_name": "pr_explorer",
        "safe": show["safe"], "advanced_yaml": show["advanced_yaml"],
        "body": show["body"]}, None)
    assert res["ok"], res
    doc1 = sc.parse_codex_agent(text)
    doc2 = sc.parse_codex_agent(Path(res["file"]).read_text())
    assert doc1["frontmatter"] == doc2["frontmatter"]
    assert doc1["body"] == doc2["body"]


def test_foreign_and_disabled_skill_entries_preserved(codex_env):
    text = ('name = "hand"\ndescription = "d"\ndeveloper_instructions = "x"\n\n'
            '[[skills.config]]\npath = "/somewhere/else/SKILL.md"\nenabled = false\n')
    write_codex_agent(codex_env, "hand.toml", text)
    show = subagents.show_agent("hand", "user", None, None, "codex")
    assert show["safe"]["skills"] == []
    assert show["foreign_skill_entries"] == [
        {"path": "/somewhere/else/SKILL.md", "enabled": False}]
    res = subagents.save_agent({
        "harness": "codex", "scope": "user", "original_name": "hand",
        "safe": show["safe"], "advanced_yaml": show["advanced_yaml"],
        "body": show["body"]}, None)
    assert res["ok"]
    saved = Path(res["file"]).read_text()
    assert '/somewhere/else/SKILL.md' in saved and "enabled = false" in saved


def test_hub_shaped_skill_maps_to_name_and_back(codex_env):
    write_codex_skill(codex_env, "myskill")
    res = subagents.save_agent(make_save_payload(safe={"skills": ["myskill"]}), None)
    assert res["ok"], res
    saved = Path(res["file"]).read_text()
    expected = str(codex_env["skills_root"] / "myskill" / "SKILL.md")
    assert expected in saved and "enabled = true" in saved
    show = subagents.show_agent("probe", "user", None, None, "codex")
    assert show["safe"]["skills"] == ["myskill"]
    assert show["foreign_skill_entries"] == []


def test_multiline_instructions_roundtrip(codex_env):
    body = "Line one.\nLine two with \"quotes\".\n"
    res = subagents.save_agent(make_save_payload(body=body), None)
    assert res["ok"]
    show = subagents.show_agent("probe", "user", None, None, "codex")
    assert show["body"] == body


# ─────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────


def _errors(res):
    return {e["field"] for e in res.get("errors", [])}


def test_validation_name_required_and_slug(codex_env):
    res = subagents.save_agent(make_save_payload(safe={"name": ""}), None)
    assert not res["ok"] and "name" in _errors(res)
    res = subagents.save_agent(make_save_payload(safe={"name": "Bad Name!"}), None)
    assert not res["ok"] and "name" in _errors(res)
    # underscores are legal for codex (pr_explorer style)
    res = subagents.save_agent(make_save_payload(safe={"name": "pr_probe_2"}), None)
    assert res["ok"], res


def test_validation_description_and_body_required(codex_env):
    res = subagents.save_agent(make_save_payload(safe={"description": ""}), None)
    assert not res["ok"] and "description" in _errors(res)
    res = subagents.save_agent(make_save_payload(body=""), None)
    assert not res["ok"] and "body" in _errors(res)


def test_validation_sandbox_mode_enum(codex_env):
    res = subagents.save_agent(make_save_payload(safe={"sandbox_mode": "yolo"}), None)
    assert not res["ok"] and "sandbox_mode" in _errors(res)
    for ok_mode in ("read-only", "workspace-write", "danger-full-access", ""):
        res = subagents.save_agent(
            make_save_payload(safe={"name": f"m-{ok_mode or 'none'}".replace("--", "-"),
                                    "sandbox_mode": ok_mode}), None)
        assert res["ok"], (ok_mode, res)


def test_validation_unknown_effort_warns_not_blocks(codex_env):
    res = subagents.save_agent(
        make_save_payload(safe={"model_reasoning_effort": "ultra"}), None)
    assert res["ok"]
    assert any(w["field"] == "model_reasoning_effort" and w["level"] == "warn"
               for w in res["warnings"])


def test_validation_nickname_candidates_must_be_list(codex_env):
    res = subagents.save_agent(
        make_save_payload(safe={"nickname_candidates": "Ada"}), None)
    assert not res["ok"] and "nickname_candidates" in _errors(res)


def test_validation_advanced_toml_parse_error_blocks(codex_env):
    res = subagents.save_agent(
        make_save_payload(advanced_yaml="not [valid toml ="), None)
    assert not res["ok"] and "advanced_yaml" in _errors(res)


def test_validation_advanced_shadow_warns(codex_env):
    res = subagents.save_agent(
        make_save_payload(advanced_yaml='name = "shadow"\nok_key = 1\n'), None)
    assert res["ok"]
    assert any(w["field"] == "advanced_yaml" and w["level"] == "warn"
               for w in res["warnings"])
    saved = Path(res["file"]).read_text()
    assert 'name = "probe"' in saved and "ok_key = 1" in saved


def test_validation_non_invocable_skill_blocks(codex_env):
    write_codex_skill(codex_env, "noinvoke", disable_invocation=True)
    res = subagents.save_agent(make_save_payload(safe={"skills": ["noinvoke"]}), None)
    assert not res["ok"] and "skills" in _errors(res)


def test_validation_unresolved_skill_warns(codex_env):
    res = subagents.save_agent(make_save_payload(safe={"skills": ["ghost"]}), None)
    assert res["ok"]
    assert any(w["field"] == "skills" and w["level"] == "warn" for w in res["warnings"])


def test_model_is_freeform(codex_env):
    res = subagents.save_agent(
        make_save_payload(safe={"model": "gpt-9-experimental"}), None)
    assert res["ok"]


# ─────────────────────────────────────────────────────────────────────────────
# Disable lifecycle (D6 / review M5)
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_reenable_byte_equal(codex_env):
    res = subagents.save_agent(make_save_payload(), None)
    before = Path(res["file"]).read_text()
    assert subagents.set_disabled("probe", True, "user", None, None, "codex") is True
    assert not (codex_env["agents"] / "probe.toml").exists()
    assert (codex_env["agents"] / "probe.toml.disabled").exists()
    assert subagents.set_disabled("probe", False, "user", None, None, "codex") is False
    after = (codex_env["agents"] / "probe.toml").read_text()
    assert before == after


def test_disabled_agent_listed_and_editable(codex_env):
    subagents.save_agent(make_save_payload(), None)
    subagents.set_disabled("probe", True, "user", None, None, "codex")
    lst = subagents.list_agents("user", None, None, "codex")
    item = next(a for a in lst["agents"] if a["name"] == "probe")
    assert item["disabled"] is True
    # still show/edit/save-able; disabled state survives the save
    show = subagents.show_agent("probe", "user", None, None, "codex")
    assert show["exists"] and show["disabled"] is True
    res = subagents.save_agent({
        "harness": "codex", "scope": "user", "original_name": "probe",
        "safe": {**show["safe"], "description": "edited"},
        "advanced_yaml": show["advanced_yaml"], "body": show["body"]}, None)
    assert res["ok"]
    assert res["file"].endswith(".toml.disabled")


def test_collision_domain_includes_disabled(codex_env):
    subagents.save_agent(make_save_payload(), None)
    subagents.set_disabled("probe", True, "user", None, None, "codex")
    res = subagents.save_agent(make_save_payload(), None)  # new agent, same name
    assert not res["ok"] and "name" in _errors(res)


def test_rename_preserves_disabled_state(codex_env):
    subagents.save_agent(make_save_payload(), None)
    subagents.set_disabled("probe", True, "user", None, None, "codex")
    show = subagents.show_agent("probe", "user", None, None, "codex")
    res = subagents.save_agent({
        "harness": "codex", "scope": "user", "original_name": "probe",
        "safe": {**show["safe"], "name": "probe_two"},
        "advanced_yaml": show["advanced_yaml"], "body": show["body"]}, None)
    assert res["ok"] and res["renamed_from"] == "probe"
    assert (codex_env["agents"] / "probe_two.toml.disabled").exists()
    assert not (codex_env["agents"] / "probe.toml.disabled").exists()


def test_builtin_codex_disable_raises(codex_env):
    with pytest.raises(ValueError, match="built-in"):
        subagents.set_disabled("worker", True, "user", None, None, "codex")


def test_delete_removes_disabled_file(codex_env):
    subagents.save_agent(make_save_payload(), None)
    subagents.set_disabled("probe", True, "user", None, None, "codex")
    res = subagents.delete_agent("probe", "user", None, None, "codex")
    assert res["ok"]
    assert not (codex_env["agents"] / "probe.toml.disabled").exists()


# ─────────────────────────────────────────────────────────────────────────────
# Scope gating + contract shape
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_project_scope_clean_error(codex_env):
    with pytest.raises(ValueError, match="later wave"):
        subagents.list_agents("project", "someproj", {}, "codex")
    res = subagents.save_agent(make_save_payload(scope="project"), None)
    assert not res["ok"] and "scope" in _errors(res)
    with pytest.raises(ValueError, match="later wave"):
        subagents.attachable_skills("project", "someproj", {}, "codex")


def test_unknown_and_unsupported_harness(codex_env):
    with pytest.raises(ValueError, match="unknown harness"):
        subagents.list_agents("user", None, None, "nope")
    with pytest.raises(ValueError, match="does not support"):
        subagents.list_agents("user", None, None, "pi")


def test_default_harness_is_claude(codex_env):
    lst = subagents.list_agents("user", None, None)
    assert lst["harness"] == "claude-code"
    assert lst["settings_path"] != ""


def test_codex_list_contract_shape(codex_env):
    subagents.save_agent(make_save_payload(safe={"sandbox_mode": "read-only"}), None)
    lst = subagents.list_agents("user", None, None, "codex")
    assert lst["harness"] == "codex"
    assert lst["settings_path"] == ""
    item = lst["agents"][0]
    # inert claude defaults + codex extras
    assert item["tools_mode"] == "all" and item["tools"] == [] and item["color"] == ""
    assert item["sandbox_mode"] == "read-only"
    assert [b["name"] for b in lst["builtins"]] == ["default", "worker", "explorer"]
    assert all(b["disabled"] is False for b in lst["builtins"])


def test_broken_toml_file_stays_visible(codex_env):
    write_codex_agent(codex_env, "broken.toml", "not [valid toml =")
    lst = subagents.list_agents("user", None, None, "codex")
    item = next(a for a in lst["agents"] if a.get("broken"))
    assert item["name"] == "broken" and item["valid"] is False


def test_attachable_skills_codex_root(codex_env):
    write_codex_skill(codex_env, "attachme")
    write_codex_skill(codex_env, "noinvoke", disable_invocation=True)
    out = subagents.attachable_skills("user", None, None, "codex")
    by = {s["name"]: s for s in out}
    assert by["attachme"]["attachable"] is True
    assert by["noinvoke"]["attachable"] is False


def test_skill_usage_includes_codex_with_harness_key(codex_env):
    write_codex_skill(codex_env, "used")
    subagents.save_agent(make_save_payload(safe={"skills": ["used"]}), None)
    # a claude agent using the same skill name
    (codex_env["claude"] / "agents" / "ca.md").write_text(
        "---\nname: ca\ndescription: d\nskills:\n  - used\n---\nB\n")
    usage = subagents.skill_usage({})
    entries = usage["used"]
    harnesses = {e["harness"] for e in entries}
    assert harnesses == {"claude-code", "codex"}


# ─────────────────────────────────────────────────────────────────────────────
# CLI e2e (subprocess — real `hub subagent --harness codex`)
# ─────────────────────────────────────────────────────────────────────────────


def _cli_env(codex_env, tmp_data_home):
    env = {**os.environ,
           "SKILL_HUB_HOME": str(tmp_data_home),
           "SKILL_HUB_CLAUDE_HOME": str(codex_env["claude"]),
           "CODEX_HOME": str(codex_env["codex_home"]),
           "HOME": str(codex_env["home"])}
    env.pop("SKILL_HUB_DIR", None)
    return env


def _run(args, env, input_text=None):
    return subprocess.run([sys.executable, "hub.py", *args],
                          input=input_text, capture_output=True, text=True,
                          env=env, cwd=os.getcwd())


def test_cli_codex_full_journey(codex_env, tmp_data_home):
    env = _cli_env(codex_env, tmp_data_home)

    payload = json.dumps(make_save_payload(safe={"name": "cli_probe",
                                                 "sandbox_mode": "read-only"}))
    p = _run(["subagent", "save", "--json"], env, input_text=payload)
    assert p.returncode == 0, p.stdout + p.stderr
    assert json.loads(p.stdout)["ok"] is True

    p = _run(["subagent", "list", "--harness", "codex", "--json"], env)
    assert p.returncode == 0
    data = json.loads(p.stdout)
    assert data["harness"] == "codex"
    assert any(a["name"] == "cli_probe" for a in data["agents"])

    p = _run(["subagent", "show", "--harness", "codex", "--name", "cli_probe", "--json"], env)
    assert p.returncode == 0
    show = json.loads(p.stdout)
    assert show["exists"] and show["advanced_format"] == "toml"

    p = _run(["subagent", "set-disabled", "--harness", "codex", "--name", "cli_probe",
              "--disabled", "true", "--json"], env)
    assert p.returncode == 0
    assert json.loads(p.stdout)["disabled"] is True

    p = _run(["subagent", "delete", "--harness", "codex", "--name", "cli_probe", "--json"], env)
    assert p.returncode == 0
    assert json.loads(p.stdout)["ok"] is True
    assert not any(codex_env["agents"].iterdir())


def test_cli_unknown_harness_fails_cleanly(codex_env, tmp_data_home):
    env = _cli_env(codex_env, tmp_data_home)
    p = _run(["subagent", "list", "--harness", "nope", "--json"], env)
    assert p.returncode != 0
    assert "Traceback" not in p.stderr


def test_cli_save_codex_project_scope_fails_cleanly(codex_env, tmp_data_home):
    env = _cli_env(codex_env, tmp_data_home)
    payload = json.dumps(make_save_payload(scope="project"))
    p = _run(["subagent", "save", "--json"], env, input_text=payload)
    assert p.returncode != 0
    assert "Traceback" not in p.stderr
    assert json.loads(p.stdout)["ok"] is False


# ─────────────────────────────────────────────────────────────────────────────
# emit_schema capability (review M4 — data path for the frontend)
# ─────────────────────────────────────────────────────────────────────────────


def test_emit_schema_carries_agent_capability():
    import harnesses
    by_id = {h["id"]: h for h in harnesses.emit_schema()}
    assert by_id["claude-code"]["agents"] == {
        "supported": True, "format": "md",
        "agents_dir": "~/.claude/agents", "project_agents_dir": ".claude/agents"}
    assert by_id["codex"]["agents"]["supported"] is True
    assert by_id["codex"]["agents"]["format"] == "toml"
    assert by_id["pi"]["agents"]["supported"] is False
    assert by_id["opencode"]["agents"]["supported"] is False
