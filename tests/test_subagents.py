"""Tests for subagents.py — Claude Code sub-agent management in place.

The Claude home (~/.claude) is isolated via the SKILL_HUB_CLAUDE_HOME env override
(see subagents.claude_home()), so no test touches the user's real agents/settings.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import subagents


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def claude_home(tmp_path, monkeypatch):
    """Isolated ~/.claude root with agents/ + skills/ dirs.

    Also isolates HOME + CODEX_HOME to empty tmp roots: cross-harness link
    detection (cross-harness-subagents D3) scans every agent-capable harness's
    dir, and this keeps that scan off the real ~/.codex / ~/.agents.
    """
    home = tmp_path / "claude"
    (home / "agents").mkdir(parents=True)
    (home / "skills").mkdir(parents=True)
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(home))
    fake_home = tmp_path / "home"
    fake_home.mkdir(parents=True, exist_ok=True)
    codex_home = tmp_path / "codexhome"
    (codex_home / "agents").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    return home


def write_agent(home: Path, filename: str, content: str) -> Path:
    p = home / "agents" / filename
    p.write_text(content)
    return p


def write_skill(skills_root: Path, name: str, disable_invocation: bool = False) -> Path:
    d = skills_root / name
    d.mkdir(parents=True, exist_ok=True)
    inv = "\ndisable-model-invocation: true" if disable_invocation else ""
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: a skill{inv}\n---\nBody\n")
    return d


def test_list_coerces_non_string_description(claude_home):
    # A numeric description must not break the contract (Rust DTO wants a string).
    (claude_home / "agents" / "numdesc.md").write_text(
        "---\nname: numdesc\ndescription: 123\n---\nBody\n")
    res = subagents.list_agents("user", None, None)
    item = next(a for a in res["agents"] if a["name"] == "numdesc")
    assert isinstance(item["description"], str) and item["description"] == "123"
    show = subagents.show_agent("numdesc", "user", None, None)
    assert isinstance(show["safe"]["description"], str)


def test_delete_strips_deny_before_unlink_on_malformed_settings(claude_home):
    # Malformed settings.json: delete must NOT remove the file (consistency).
    # (Since the transactional linked-delete change this surfaces as a
    # structured {ok: False} rather than a raw ValueError — same guarantee,
    # contract-shaped for the CLI/Rust bridge.)
    (claude_home / "agents" / "doomed.md").write_text(
        "---\nname: doomed\ndescription: d\n---\nB\n")
    (claude_home / "settings.json").write_text('{ broken json')
    res = subagents.delete_agent("doomed", "user", None, None)
    assert res["ok"] is False
    assert (claude_home / "agents" / "doomed.md").exists()  # file preserved


def test_cli_save_rejects_non_object_payload(tmp_data_home, claude_home):
    import subprocess, sys, os
    env = {**os.environ, "SKILL_HUB_HOME": str(tmp_data_home),
           "SKILL_HUB_CLAUDE_HOME": str(claude_home)}
    env.pop("SKILL_HUB_DIR", None)
    for bad in ("[]", '"x"', "5"):
        p = subprocess.run([sys.executable, "hub.py", "subagent", "save", "--json"],
                           input=bad, capture_output=True, text=True, env=env, cwd=os.getcwd())
        assert p.returncode != 0, bad
        assert '"ok": false' in p.stdout.lower() or "ok\": false" in p.stdout.lower()


def test_cli_attachable_skills_project_without_name_no_traceback(tmp_data_home, claude_home):
    import subprocess, sys, os
    env = {**os.environ, "SKILL_HUB_HOME": str(tmp_data_home),
           "SKILL_HUB_CLAUDE_HOME": str(claude_home)}
    env.pop("SKILL_HUB_DIR", None)
    p = subprocess.run([sys.executable, "hub.py", "subagent", "attachable-skills",
                        "--scope", "project", "--json"],
                       capture_output=True, text=True, env=env, cwd=os.getcwd())
    assert p.returncode != 0
    assert "Traceback" not in p.stderr  # graceful, not a raw crash


def test_set_disabled_refuses_to_clobber_malformed_settings(claude_home):
    # An existing but unparseable settings.json must NOT be overwritten.
    settings = claude_home / "settings.json"
    settings.write_text('{ "permissions": { "allow": ["Bash(*)"] }  BROKEN')
    import pytest as _pytest
    with _pytest.raises(ValueError):
        subagents.set_disabled("foo", True, "user", None, None)
    # File left byte-for-byte intact.
    assert settings.read_text() == '{ "permissions": { "allow": ["Bash(*)"] }  BROKEN'


def test_skill_invocable_detects_flag_in_malformed_yaml(claude_home):
    skills = claude_home / "skills"
    d = skills / "weird"
    d.mkdir(parents=True)
    # Unquoted colon breaks strict YAML, but the flag is still present.
    (d / "SKILL.md").write_text(
        "---\ndescription: does X: and Y\ndisable-model-invocation: true\n---\nBody\n")
    assert subagents._skill_is_invocable(d / "SKILL.md") is False


def test_list_surfaces_broken_agent_file(claude_home):
    # A file that can't be parsed must appear as a broken, visible entry.
    (claude_home / "agents" / "ok.md").write_text(
        "---\nname: ok\ndescription: fine\n---\nBody\n")
    (claude_home / "agents" / "busted.md").write_text("not even frontmatter at all")
    res = subagents.list_agents("user", None, None)
    by_name = {a["name"]: a for a in res["agents"]}
    assert "busted" in by_name
    assert by_name["busted"]["valid"] is False
    assert by_name["busted"].get("broken") is True
    assert by_name["ok"]["valid"] is True


def test_attachable_skills_marks_each(claude_home):
    # one invocable skill on disk, one non-invocable, plus a registry-only name
    write_skill(claude_home / "skills", "good-skill")
    write_skill(claude_home / "skills", "no-preload", disable_invocation=True)
    registry = {"skills": {"good-skill": {"description": "g"},
                           "no-preload": {"description": "n"},
                           "ghost": {"description": "not on disk"}}}
    res = {s["name"]: s for s in subagents.attachable_skills("user", None, registry)}
    assert res["good-skill"]["attachable"] is True
    assert res["no-preload"]["attachable"] is False
    assert "disable-model-invocation" in res["no-preload"]["reason"]
    assert res["ghost"]["attachable"] is False
    assert "resolvable" in res["ghost"]["reason"]


SIMPLE_AGENT = """---
name: reviewer
description: Reviews code carefully.
model: sonnet
tools: Read, Grep
color: green
---
You are a careful reviewer.
"""

ADVANCED_AGENT = """---
name: complex
description: Has advanced fields.
model: opus
tools: Read, Write, Edit
skills:
- alpha
- beta
color: blue
permissionMode: default
mcpServers:
  foo:
    command: bar
hooks:
  PreToolUse:
  - matcher: Bash
    command: echo hi
maxTurns: 5
---
System prompt body here.
"""


# ─────────────────────────────────────────────────────────────────────────────
# Round-trip fidelity (D5)
# ─────────────────────────────────────────────────────────────────────────────


def test_roundtrip_simple():
    doc = subagents.parse_agent(SIMPLE_AGENT)
    out = subagents.serialize_agent(doc["frontmatter"], doc["body"])
    reparsed = subagents.parse_agent(out)
    assert reparsed["frontmatter"] == doc["frontmatter"]
    assert reparsed["body"] == doc["body"]


def test_roundtrip_advanced_preserves_all_fields_and_order():
    doc = subagents.parse_agent(ADVANCED_AGENT)
    fm = doc["frontmatter"]
    # advanced fields present
    assert fm["permissionMode"] == "default"
    assert fm["mcpServers"] == {"foo": {"command": "bar"}}
    assert fm["hooks"]["PreToolUse"][0]["command"] == "echo hi"
    assert fm["maxTurns"] == 5
    out = subagents.serialize_agent(fm, doc["body"])
    reparsed = subagents.parse_agent(out)
    assert reparsed["frontmatter"] == fm
    # key order: safe keys first in canonical order, then advanced verbatim order
    keys = list(reparsed["frontmatter"].keys())
    assert keys[:5] == ["name", "description", "model", "tools", "skills"]
    # color is a safe key and must precede advanced keys
    assert keys.index("color") < keys.index("permissionMode")
    assert keys.index("permissionMode") < keys.index("mcpServers") < keys.index("maxTurns")


def test_roundtrip_invariant_parse_serialize_parse():
    """parse(serialize(parse(x))) == parse(x) for advanced agent."""
    p1 = subagents.parse_agent(ADVANCED_AGENT)
    s = subagents.serialize_agent(p1["frontmatter"], p1["body"])
    p2 = subagents.parse_agent(s)
    assert p2 == p1


def test_lenient_parse_for_unquoted_colon_description():
    """Real CC files have unquoted descriptions with embedded `: ` (Context: ...)."""
    raw = (
        "---\n"
        "name: git-committer\n"
        "description: Use when done. Example:\\n\\n<example>\\nContext: User asks to commit\\n</example>\n"
        "tools: Bash, Read\n"
        "model: haiku\n"
        "color: pink\n"
        "---\n"
        "Body.\n"
    )
    doc = subagents.parse_agent(raw)
    fm = doc["frontmatter"]
    assert fm["name"] == "git-committer"
    assert fm["model"] == "haiku"
    assert "Context:" in fm["description"]


# ─────────────────────────────────────────────────────────────────────────────
# tools_mode / safe-advanced split (D2)
# ─────────────────────────────────────────────────────────────────────────────


def test_tools_mode_all():
    d = subagents.derive_tools({"name": "x"})
    assert d["tools_mode"] == "all"
    assert d["allow_skill_discovery"] is True


def test_tools_mode_allowlist_skill_discovery():
    d = subagents.derive_tools({"tools": "Read, Skill"})
    assert d["tools_mode"] == "allowlist"
    assert d["allow_skill_discovery"] is True
    d2 = subagents.derive_tools({"tools": "Read, Grep"})
    assert d2["allow_skill_discovery"] is False


def test_tools_mode_denylist_skill_discovery():
    d = subagents.derive_tools({"disallowedTools": "Skill"})
    assert d["tools_mode"] == "denylist"
    assert d["allow_skill_discovery"] is False
    d2 = subagents.derive_tools({"disallowedTools": "Bash"})
    assert d2["allow_skill_discovery"] is True


def test_split_safe_advanced():
    doc = subagents.parse_agent(ADVANCED_AGENT)
    safe, advanced_yaml = subagents.split_safe_advanced(doc["frontmatter"])
    assert safe["name"] == "complex"
    assert safe["tools_mode"] == "allowlist"
    assert safe["skills"] == ["alpha", "beta"]
    import yaml
    adv = yaml.safe_load(advanced_yaml)
    assert "permissionMode" in adv and "mcpServers" in adv and "maxTurns" in adv
    assert "name" not in adv and "tools" not in adv


# ─────────────────────────────────────────────────────────────────────────────
# build_frontmatter (skill-discovery toggle, advanced merge)
# ─────────────────────────────────────────────────────────────────────────────


def test_build_frontmatter_skill_discovery_off_allowlist():
    fm, warnings = subagents.build_frontmatter(
        {"name": "a", "description": "d", "tools_mode": "allowlist",
         "tools": ["Read", "Skill"], "allow_skill_discovery": False}, "")
    assert "Skill" not in fm["tools"]


def test_build_frontmatter_skill_discovery_on_allowlist_adds_skill():
    fm, warnings = subagents.build_frontmatter(
        {"name": "a", "description": "d", "tools_mode": "allowlist",
         "tools": ["Read"], "allow_skill_discovery": True}, "")
    assert "Skill" in fm["tools"]


def test_build_frontmatter_advanced_cannot_override_safe():
    fm, warnings = subagents.build_frontmatter(
        {"name": "a", "description": "d"}, "name: hacked\nmaxTurns: 3")
    assert fm["name"] == "a"
    assert fm["maxTurns"] == 3
    assert any(w["field"] == "advanced_yaml" and w["level"] == "warn" for w in warnings)


def test_build_frontmatter_advanced_non_mapping_is_error():
    fm, warnings = subagents.build_frontmatter(
        {"name": "a", "description": "d"}, "- just\n- a\n- list")
    assert any(w["level"] == "error" for w in warnings)


# ─────────────────────────────────────────────────────────────────────────────
# Validation (D3) — pass + fail for each rule
# ─────────────────────────────────────────────────────────────────────────────


def _v(fm, **kw):
    return subagents.validate_agent(fm, kw.pop("scope", "user"),
                                    kw.pop("project", None), kw.pop("registry", None), **kw)


def test_validate_name_required():
    assert not _v({"description": "d"})["valid"]


def test_validate_name_slug():
    assert not _v({"name": "Bad Name", "description": "d"})["valid"]
    assert _v({"name": "good-name", "description": "d"})["valid"]


def test_validate_name_collision_is_error():
    res = _v({"name": "dup", "description": "d"}, existing_names={"dup"})
    assert not res["valid"]


def test_validate_name_collision_excludes_original_on_rename():
    res = _v({"name": "dup", "description": "d"},
             original_name="dup", existing_names={"dup"})
    assert res["valid"]


def test_validate_description_required():
    assert not _v({"name": "a", "description": ""})["valid"]
    assert not _v({"name": "a"})["valid"]


def test_validate_model_enum_and_id():
    assert _v({"name": "a", "description": "d", "model": "opus"})["valid"]
    assert _v({"name": "a", "description": "d", "model": "inherit"})["valid"]
    assert _v({"name": "a", "description": "d", "model": ""})["valid"]
    assert _v({"name": "a", "description": "d", "model": "claude-3-5-sonnet-20241022"})["valid"]
    assert not _v({"name": "a", "description": "d", "model": "gpt-4"})["valid"]


def test_validate_color_enum():
    assert _v({"name": "a", "description": "d", "color": "green"})["valid"]
    assert _v({"name": "a", "description": "d", "color": ""})["valid"]
    assert not _v({"name": "a", "description": "d", "color": "chartreuse"})["valid"]


def test_validate_unknown_tool_is_warn_not_error():
    res = _v({"name": "a", "description": "d", "tools": "Read, FrobnicateTool"})
    assert res["valid"]
    assert any(w["level"] == "warn" and w["value"] == "FrobnicateTool" for w in res["warnings"])


def test_validate_known_tools_and_patterns_no_warn():
    res = _v({"name": "a", "description": "d",
              "tools": "Read, Agent(foo), mcp__server__tool, Skill"})
    assert res["valid"]
    assert not any(w["field"] == "tools" for w in res["warnings"])


def test_validate_skill_resolves(claude_home):
    write_skill(claude_home / "skills", "alpha")
    res = _v({"name": "a", "description": "d", "skills": ["alpha"]}, scope="user")
    assert res["valid"]
    assert not any(w["field"] == "skills" for w in res["warnings"])


def test_validate_skill_unresolvable_is_warn(claude_home):
    res = _v({"name": "a", "description": "d", "skills": ["ghost"]}, scope="user")
    assert res["valid"]
    assert any(w["field"] == "skills" and w["level"] == "warn" for w in res["warnings"])


def test_validate_skill_disable_model_invocation_is_error(claude_home):
    write_skill(claude_home / "skills", "noinvoke", disable_invocation=True)
    res = _v({"name": "a", "description": "d", "skills": ["noinvoke"]}, scope="user")
    assert not res["valid"]
    assert any(w["field"] == "skills" and w["level"] == "error" for w in res["warnings"])


def test_validate_user_scope_project_only_skill_is_warn(claude_home, tmp_data_home):
    proj = tmp_data_home.parent / "proj"
    (proj / ".claude" / "skills").mkdir(parents=True)
    write_skill(proj / ".claude" / "skills", "projskill")
    registry = {"projects": {"p": {"path": str(proj)}}}
    res = _v({"name": "a", "description": "d", "skills": ["projskill"]},
             scope="user", registry=registry)
    assert res["valid"]
    assert any(w["field"] == "skills" and "only present in a project" in w["message"]
               for w in res["warnings"])


def test_validate_bypass_permissions_loud_warn():
    res = _v({"name": "a", "description": "d", "permissionMode": "bypassPermissions"})
    assert res["valid"]
    assert any(w["field"] == "permissionMode" and w["level"] == "warn" for w in res["warnings"])


# ─────────────────────────────────────────────────────────────────────────────
# list / show
# ─────────────────────────────────────────────────────────────────────────────


def test_list_agents(claude_home):
    write_agent(claude_home, "reviewer.md", SIMPLE_AGENT)
    write_agent(claude_home, "complex.md", ADVANCED_AGENT)
    result = subagents.list_agents("user")
    names = {a["name"] for a in result["agents"]}
    assert names == {"reviewer", "complex"}
    assert {b["name"] for b in result["builtins"]} == {"general-purpose", "Explore", "Plan"}


def test_list_within_scope_collision_flagged(claude_home):
    write_agent(claude_home, "one.md", SIMPLE_AGENT)
    # second file with the same `name: reviewer`
    write_agent(claude_home, "two.md", SIMPLE_AGENT)
    result = subagents.list_agents("user")
    for a in result["agents"]:
        if a["name"] == "reviewer":
            assert not a["valid"]
            assert any(w["field"] == "name" and "duplicate" in w["message"]
                       for w in a["warnings"])


def test_show_agent(claude_home):
    write_agent(claude_home, "complex.md", ADVANCED_AGENT)
    s = subagents.show_agent("complex", "user")
    assert s["exists"] is True
    assert s["safe"]["name"] == "complex"
    assert "permissionMode" in s["advanced_yaml"]
    assert s["body"].startswith("System prompt body")


def test_show_missing_agent(claude_home):
    s = subagents.show_agent("nope", "user")
    assert s["exists"] is False
    assert not s["validation"]["valid"]


# ─────────────────────────────────────────────────────────────────────────────
# save / rename / delete
# ─────────────────────────────────────────────────────────────────────────────


def test_save_new_agent(claude_home):
    payload = {"scope": "user", "original_name": None,
               "safe": {"name": "fresh", "description": "d", "model": "sonnet",
                        "tools_mode": "all", "allow_skill_discovery": True},
               "advanced_yaml": "", "body": "Hello.\n"}
    res = subagents.save_agent(payload)
    assert res["ok"]
    f = claude_home / "agents" / "fresh.md"
    assert f.exists()
    doc = subagents.parse_agent(f.read_text())
    assert doc["frontmatter"]["name"] == "fresh"


def test_save_invalid_name_blocks_and_leaves_disk_untouched(claude_home):
    write_agent(claude_home, "reviewer.md", SIMPLE_AGENT)
    before = (claude_home / "agents" / "reviewer.md").read_text()
    payload = {"scope": "user", "original_name": "reviewer",
               "safe": {"name": "Bad Name", "description": "d"},
               "advanced_yaml": "", "body": "x"}
    res = subagents.save_agent(payload)
    assert not res["ok"]
    assert (claude_home / "agents" / "reviewer.md").read_text() == before


def test_save_invalid_model_blocks(claude_home):
    payload = {"scope": "user", "original_name": None,
               "safe": {"name": "x", "description": "d", "model": "gpt-4"},
               "advanced_yaml": "", "body": "x"}
    assert not subagents.save_agent(payload)["ok"]


def test_save_malformed_advanced_yaml_blocks(claude_home):
    payload = {"scope": "user", "original_name": None,
               "safe": {"name": "x", "description": "d"},
               "advanced_yaml": "- not\n- a\n- map", "body": "x"}
    assert not subagents.save_agent(payload)["ok"]


def test_save_preserves_advanced_fields(claude_home):
    write_agent(claude_home, "complex.md", ADVANCED_AGENT)
    s = subagents.show_agent("complex", "user")
    # edit only a safe field
    s["safe"]["description"] = "Edited description."
    payload = {"scope": "user", "original_name": "complex",
               "safe": s["safe"], "advanced_yaml": s["advanced_yaml"], "body": s["body"]}
    res = subagents.save_agent(payload)
    assert res["ok"]
    doc = subagents.parse_agent((claude_home / "agents" / "complex.md").read_text())
    assert doc["frontmatter"]["description"] == "Edited description."
    assert doc["frontmatter"]["permissionMode"] == "default"
    assert doc["frontmatter"]["maxTurns"] == 5
    assert doc["frontmatter"]["mcpServers"] == {"foo": {"command": "bar"}}


def test_rename_updates_file_and_removes_old(claude_home):
    write_agent(claude_home, "reviewer.md", SIMPLE_AGENT)
    payload = {"scope": "user", "original_name": "reviewer",
               "safe": {"name": "renamed", "description": "d", "model": "sonnet",
                        "tools_mode": "all", "allow_skill_discovery": True},
               "advanced_yaml": "", "body": "x\n"}
    res = subagents.save_agent(payload)
    assert res["ok"]
    assert res["renamed_from"] == "reviewer"
    assert not (claude_home / "agents" / "reviewer.md").exists()
    assert (claude_home / "agents" / "renamed.md").exists()


def test_rename_collision_blocks(claude_home):
    write_agent(claude_home, "reviewer.md", SIMPLE_AGENT)
    write_agent(claude_home, "complex.md", ADVANCED_AGENT)
    payload = {"scope": "user", "original_name": "reviewer",
               "safe": {"name": "complex", "description": "d", "model": "sonnet",
                        "tools_mode": "all", "allow_skill_discovery": True},
               "advanced_yaml": "", "body": "x"}
    res = subagents.save_agent(payload)
    assert not res["ok"]
    # both originals intact
    assert (claude_home / "agents" / "reviewer.md").exists()
    assert (claude_home / "agents" / "complex.md").exists()


def test_new_agent_name_collision_blocks(claude_home):
    write_agent(claude_home, "reviewer.md", SIMPLE_AGENT)
    payload = {"scope": "user", "original_name": None,
               "safe": {"name": "reviewer", "description": "d", "model": "sonnet",
                        "tools_mode": "all", "allow_skill_discovery": True},
               "advanced_yaml": "", "body": "x"}
    assert not subagents.save_agent(payload)["ok"]


def test_delete_agent_strips_deny(claude_home):
    write_agent(claude_home, "reviewer.md", SIMPLE_AGENT)
    subagents.set_disabled("reviewer", True, "user")
    assert subagents.read_disabled("reviewer", "user")
    res = subagents.delete_agent("reviewer", "user")
    assert res["ok"]
    assert not (claude_home / "agents" / "reviewer.md").exists()
    assert not subagents.read_disabled("reviewer", "user")


# ─────────────────────────────────────────────────────────────────────────────
# disable mechanism (D4) — merge-preserving
# ─────────────────────────────────────────────────────────────────────────────


def test_disable_add_remove(claude_home):
    assert subagents.set_disabled("foo", True, "user") is True
    assert subagents.read_disabled("foo", "user")
    assert subagents.set_disabled("foo", False, "user") is False
    assert not subagents.read_disabled("foo", "user")


def test_disable_preserves_unrelated_settings(claude_home):
    spath = claude_home / "settings.json"
    spath.write_text(json.dumps({
        "model": "opus",
        "permissions": {
            "allow": ["Bash(npm:*)", "Read(*)"],
            "deny": ["Agent(existing)", "Bash(rm:*)"],
        },
        "env": {"FOO": "bar"},
    }, indent=2))
    subagents.set_disabled("newagent", True, "user")
    data = json.loads(spath.read_text())
    assert data["model"] == "opus"
    assert data["env"] == {"FOO": "bar"}
    assert data["permissions"]["allow"] == ["Bash(npm:*)", "Read(*)"]
    # existing deny entries preserved + new one appended
    assert "Agent(existing)" in data["permissions"]["deny"]
    assert "Bash(rm:*)" in data["permissions"]["deny"]
    assert "Agent(newagent)" in data["permissions"]["deny"]


def test_disable_creates_missing_permissions_keys(claude_home):
    spath = claude_home / "settings.json"
    spath.write_text(json.dumps({"model": "opus"}))
    subagents.set_disabled("x", True, "user")
    data = json.loads(spath.read_text())
    assert data["model"] == "opus"
    assert "Agent(x)" in data["permissions"]["deny"]


def test_builtin_disable_no_file(claude_home):
    subagents.set_disabled("Explore", True, "user")
    assert subagents.read_disabled("Explore", "user")
    # no file created in agents dir
    assert list((claude_home / "agents").iterdir()) == []


# ─────────────────────────────────────────────────────────────────────────────
# skill-usage reverse index
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_usage(claude_home, tmp_data_home):
    # user agent preloading alpha + beta
    write_agent(claude_home, "complex.md", ADVANCED_AGENT)
    # project agent preloading alpha
    proj = tmp_data_home.parent / "proj2"
    (proj / ".claude" / "agents").mkdir(parents=True)
    (proj / ".claude" / "agents" / "pa.md").write_text(
        "---\nname: pa\ndescription: d\nskills:\n- alpha\n---\nBody\n")
    registry = {"projects": {"p": {"path": str(proj)}}}
    idx = subagents.skill_usage(registry)
    assert {u["agent"] for u in idx["alpha"]} == {"complex", "pa"}
    scopes = {(u["agent"], u["scope"], u["project"]) for u in idx["alpha"]}
    assert ("complex", "user", None) in scopes
    assert ("pa", "project", "p") in scopes
    assert {u["agent"] for u in idx["beta"]} == {"complex"}


# ─────────────────────────────────────────────────────────────────────────────
# CRITICAL interplay (task 1.8): hub sync's permission stream must NOT clobber a
# pre-existing unmanaged Agent(<name>) deny entry.
# ─────────────────────────────────────────────────────────────────────────────


def _run_claude_permission_apply(scope, settings_target, registry_perms):
    """Run the SAME adapter path hub sync uses for the claude-code harness:
    translate registry permissions → apply (strip prior-managed → splice new).
    """
    import permission_adapters as pa
    from permissions import NormalizedPermissions

    adapter = pa.ClaudePermissionAdapter()
    perms = NormalizedPermissions.from_block(registry_perms)
    result = adapter.translate(perms, scope, "claude-code")
    for w in result.writes:
        # Point the write at our isolated settings file (translate resolves the
        # real ~/.claude path; we override the target to the tmp file).
        w.target_path = settings_target
        adapter.apply(scope, w, "claude-code")


def test_sync_preserves_global_agent_deny(claude_home, tmp_data_home, monkeypatch):
    """Global permission stream leaves an unmanaged Agent(foo) deny intact."""
    from permissions import GlobalScope

    settings = claude_home / "settings.json"
    # Seed: user disabled 'foo' (unmanaged by hub) + has a real allow list.
    settings.write_text(json.dumps({
        "permissions": {
            "allow": ["Bash(git:*)"],
            "deny": ["Agent(foo)"],
        }
    }, indent=2))

    # The registry global permissions hub manages — does NOT include Agent(foo).
    registry_perms = {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}],
                      "deny": [{"pattern": "Bash(rm:*)", "kind": "deny"}]}

    _run_claude_permission_apply(GlobalScope(), settings, registry_perms)

    data = json.loads(settings.read_text())
    assert "Agent(foo)" in data["permissions"]["deny"], \
        "hub sync clobbered the unmanaged Agent(foo) deny entry"
    # hub-managed rules also landed
    assert "Bash(npm:*)" in data["permissions"]["allow"]
    assert "Bash(rm:*)" in data["permissions"]["deny"]
    # pre-existing user allow preserved
    assert "Bash(git:*)" in data["permissions"]["allow"]


def test_sync_preserves_project_agent_deny(tmp_path, tmp_data_home, monkeypatch):
    """Project permission stream leaves an unmanaged Agent(bar) deny intact."""
    from permissions import ProjectScope

    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    settings = proj / ".claude" / "settings.json"
    settings.write_text(json.dumps({
        "permissions": {"deny": ["Agent(bar)"]}
    }, indent=2))

    registry_perms = {"allow": [{"pattern": "Bash(ls:*)", "kind": "allow"}]}
    scope = ProjectScope(name="proj", path=str(proj))
    _run_claude_permission_apply(scope, settings, registry_perms)

    data = json.loads(settings.read_text())
    assert "Agent(bar)" in data["permissions"]["deny"], \
        "hub sync clobbered the unmanaged project Agent(bar) deny entry"


def test_sync_resync_still_preserves_agent_deny(claude_home, tmp_data_home):
    """A second sync (with the sidecar now populated) still preserves Agent(foo)."""
    from permissions import GlobalScope

    settings = claude_home / "settings.json"
    settings.write_text(json.dumps({
        "permissions": {"deny": ["Agent(foo)"]}
    }, indent=2))
    registry_perms = {"deny": [{"pattern": "Bash(rm:*)", "kind": "deny"}]}

    _run_claude_permission_apply(GlobalScope(), settings, registry_perms)
    _run_claude_permission_apply(GlobalScope(), settings, registry_perms)

    data = json.loads(settings.read_text())
    deny = data["permissions"]["deny"]
    assert "Agent(foo)" in deny
    # idempotent: Bash(rm:*) appears exactly once after re-sync
    assert deny.count("Bash(rm:*)") == 1
