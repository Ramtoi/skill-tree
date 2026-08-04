"""Tests for subagent_links.py — linked twins (sidecar, co-write, drift).

Isolation mirrors test_subagents_codex.py: every test isolates $HOME (codex
skills root), $CODEX_HOME (codex agents dir), $SKILL_HUB_CLAUDE_HOME (claude
home) and — via tmp_data_home — SKILL_HUB_HOME (the link sidecar + backups).
No test touches the real ~/.claude, ~/.codex or ~/.agents.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import subagents
import subagent_links as sl
import subagent_codex as sc


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures + helpers
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def twin_env(tmp_path, monkeypatch, tmp_data_home):
    """Isolated HOME + CODEX_HOME + SKILL_HUB_CLAUDE_HOME + data home."""
    home = tmp_path / "home"
    codex_home = tmp_path / "codexhome"
    (codex_home / "agents").mkdir(parents=True)
    (home / ".agents" / "skills").mkdir(parents=True)
    claude = tmp_path / "claude"
    (claude / "agents").mkdir(parents=True)
    (claude / "skills").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude))
    return {
        "home": home,
        "codex_home": codex_home,
        "claude": claude,
        "claude_agents": claude / "agents",
        "codex_agents": codex_home / "agents",
        "codex_skills_root": home / ".agents" / "skills",
        "data_home": tmp_data_home,
        "sidecar": tmp_data_home / "state" / "subagents" / "links.json",
    }


def claude_payload(name="twin", description="a twin", body="Do things.\n",
                   model="", skills=None, color="", original_name=None,
                   advanced_yaml=""):
    return {
        "harness": "claude-code", "scope": "user", "project": None,
        "original_name": original_name,
        "safe": {"name": name, "description": description, "model": model,
                 "tools_mode": "all", "tools": [], "disallowed_tools": [],
                 "allow_skill_discovery": True, "skills": skills or [],
                 "color": color},
        "advanced_yaml": advanced_yaml, "body": body,
    }


def codex_payload(name="twin", description="a twin", body="Do things.\n",
                  model="", skills=None, sandbox_mode="", original_name=None,
                  advanced_yaml=""):
    return {
        "harness": "codex", "scope": "user", "project": None,
        "original_name": original_name,
        "safe": {"name": name, "description": description, "model": model,
                 "sandbox_mode": sandbox_mode, "model_reasoning_effort": "",
                 "skills": skills or [], "nickname_candidates": []},
        "advanced_yaml": advanced_yaml, "body": body,
    }


def make_pair(twin_env, name="twin", claude_over=None, codex_over=None):
    """Create the same-named agent in both harnesses and link them."""
    res = subagents.save_agent(claude_payload(name=name, **(claude_over or {})), None)
    assert res["ok"], res
    res = subagents.save_agent(codex_payload(name=name, **(codex_over or {})), None)
    assert res["ok"], res
    link = sl.link_agents(name, ["claude-code", "codex"], "user", None)
    assert link["ok"], link
    return link


def show(name, hid):
    return subagents.show_agent(name, "user", None, None, hid)


def write_claude_skill(twin_env, name):
    d = twin_env["claude"] / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: s\n---\nB\n")


def write_codex_skill(twin_env, name):
    d = twin_env["codex_skills_root"] / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: s\n---\nB\n")


# ─────────────────────────────────────────────────────────────────────────────
# Sidecar
# ─────────────────────────────────────────────────────────────────────────────


def test_link_writes_membership_only_sidecar(twin_env):
    make_pair(twin_env)
    data = json.loads(twin_env["sidecar"].read_text())
    assert set(data.keys()) == {"links"}
    entry = data["links"][0]
    assert entry["name"] == "twin"
    assert entry["scope"] == "user"
    assert entry["harnesses"] == ["claude-code", "codex"]
    assert entry["linked_at"]
    # membership only — never content
    assert "description" not in entry and "body" not in entry


def test_corrupt_sidecar_tolerated(twin_env):
    twin_env["sidecar"].parent.mkdir(parents=True, exist_ok=True)
    twin_env["sidecar"].write_text("not json {{{")
    links, warn = sl.read_links()
    assert links == [] and warn
    # list/show never crash; the warning surfaces in the result
    subagents.save_agent(claude_payload(), None)
    lst = subagents.list_agents("user", None, None)
    assert lst["links_warning"]
    st = sl.link_status("user", None)
    assert st["links"] == [] and st.get("links_warning")
    # link ops still functional (overwrite the corrupt file)
    subagents.save_agent(codex_payload(), None)
    res = sl.link_agents("twin", ["claude-code", "codex"], "user", None)
    assert res["ok"]
    assert json.loads(twin_env["sidecar"].read_text())["links"][0]["name"] == "twin"


def test_project_scope_link_rejected(twin_env):
    res = sl.link_agents("twin", ["claude-code", "codex"], "project", None)
    assert not res["ok"] and "user-scope" in res["error"]
    res = sl.unlink_agents("twin", "user")  # user scope fine even when unlinked
    assert res["ok"] and res["unlinked"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Linking / suggestions / twin-lost
# ─────────────────────────────────────────────────────────────────────────────


def test_link_requires_both_files_or_copy_from(twin_env):
    subagents.save_agent(claude_payload(), None)
    res = sl.link_agents("twin", ["claude-code", "codex"], "user", None)
    assert not res["ok"] and "missing" in res["error"]


def test_copy_from_projects_core_model_not_carried(twin_env):
    write_codex_skill(twin_env, "solo-skill")
    res = subagents.save_agent(codex_payload(
        name="solo", description="codex desc", body="Codex body.\n",
        model="gpt-9-experimental", sandbox_mode="read-only",
        skills=["solo-skill"]), None)
    assert res["ok"], res
    res = sl.link_agents("solo", ["claude-code", "codex"], "user", None,
                         copy_from="codex")
    assert res["ok"], res
    cs = show("solo", "claude-code")
    assert cs["exists"]
    # shared core projected
    assert cs["safe"]["description"] == "codex desc"
    assert cs["body"].rstrip() == "Codex body."
    assert cs["safe"]["skills"] == ["solo-skill"]
    # model NOT carried (inherit) and overlay empty
    assert cs["safe"]["model"] == ""
    assert cs["safe"]["color"] == ""
    assert "sandbox_mode" not in (cs["advanced_yaml"] or "")
    # codex side untouched (keeps its own model + overlay)
    xs = show("solo", "codex")
    assert xs["safe"]["model"] == "gpt-9-experimental"
    assert xs["safe"]["sandbox_mode"] == "read-only"


def test_link_claude_illegal_name_fails_cleanly(twin_env):
    res = subagents.save_agent(codex_payload(name="pr_probe"), None)
    assert res["ok"]
    res = sl.link_agents("pr_probe", ["claude-code", "codex"], "user", None,
                         copy_from="codex")
    assert not res["ok"]
    assert "not a valid agent name" in res["error"]
    assert not twin_env["sidecar"].exists() or \
        json.loads(twin_env["sidecar"].read_text())["links"] == []


def test_same_name_unlinked_is_suggestion_only(twin_env):
    subagents.save_agent(claude_payload(), None)
    subagents.save_agent(codex_payload(), None)
    lst = subagents.list_agents("user", None, None)
    item = next(a for a in lst["agents"] if a["name"] == "twin")
    assert item["link"] == {"linked": False, "harnesses": ["claude-code", "codex"],
                            "twin_lost": False, "suggested": True}
    st = sl.link_status("user", None)
    assert st["links"] == []
    assert st["suggestions"] == [{"name": "twin", "harnesses": ["claude-code", "codex"]}]


def test_linked_list_and_show_link_shape(twin_env):
    make_pair(twin_env)
    for hid in ("claude-code", "codex"):
        lst = subagents.list_agents("user", None, None, hid)
        item = next(a for a in lst["agents"] if a["name"] == "twin")
        assert item["link"] == {"linked": True, "harnesses": ["claude-code", "codex"],
                                "twin_lost": False, "suggested": False}
        s = show("twin", hid)
        assert s["link"]["linked"] is True and s["drift"] is None


def test_standalone_agent_has_null_link(twin_env):
    subagents.save_agent(claude_payload(name="loner"), None)
    lst = subagents.list_agents("user", None, None)
    item = next(a for a in lst["agents"] if a["name"] == "loner")
    assert item["link"] is None
    assert show("loner", "claude-code")["link"] is None


def test_unlink_durable_no_auto_relink(twin_env):
    make_pair(twin_env)
    res = sl.unlink_agents("twin", "user")
    assert res["ok"] and res["unlinked"] is True
    # both files still on disk, pair now a suggestion — never auto-relinked
    assert (twin_env["claude_agents"] / "twin.md").exists()
    assert (twin_env["codex_agents"] / "twin.toml").exists()
    lst = subagents.list_agents("user", None, None)
    item = next(a for a in lst["agents"] if a["name"] == "twin")
    assert item["link"]["suggested"] is True and item["link"]["linked"] is False
    # a save on one side stays one-sided after unlink
    s = show("twin", "claude-code")
    res = subagents.save_agent(claude_payload(
        description="claude only edit", body=s["body"],
        original_name="twin"), None)
    assert res["ok"]
    assert show("twin", "codex")["safe"]["description"] == "a twin"
    st = sl.link_status("user", None)
    assert st["links"] == [] and st["suggestions"][0]["name"] == "twin"


def test_hand_deleted_twin_is_twin_lost(twin_env):
    make_pair(twin_env)
    (twin_env["codex_agents"] / "twin.toml").unlink()
    lst = subagents.list_agents("user", None, None)
    item = next(a for a in lst["agents"] if a["name"] == "twin")
    assert item["link"]["linked"] is True and item["link"]["twin_lost"] is True
    assert show("twin", "claude-code")["link"]["twin_lost"] is True
    st = sl.link_status("user", None)
    assert st["links"][0]["twin_lost"] is True


def test_hand_renamed_twin_is_twin_lost(twin_env):
    make_pair(twin_env)
    # identity is the name FIELD — hand-rename it inside the codex file
    f = twin_env["codex_agents"] / "twin.toml"
    f.write_text(f.read_text().replace('name = "twin"', 'name = "renamed"'))
    item = next(a for a in subagents.list_agents("user", None, None)["agents"]
                if a["name"] == "twin")
    assert item["link"]["twin_lost"] is True
    assert sl.link_status("user", None)["links"][0]["twin_lost"] is True


# ─────────────────────────────────────────────────────────────────────────────
# Co-write (shared core both directions; overlay/model never cross-maps)
# ─────────────────────────────────────────────────────────────────────────────


def test_cowrite_claude_to_codex(twin_env):
    write_claude_skill(twin_env, "shared-skill")
    write_codex_skill(twin_env, "shared-skill")
    make_pair(twin_env)
    s = show("twin", "claude-code")
    res = subagents.save_agent(claude_payload(
        description="updated desc", body="New shared body.\n",
        skills=["shared-skill"], original_name="twin"), None)
    assert res["ok"], res
    assert res["cowrote_twin"] is True and res["twin_harness"] == "codex"
    xs = show("twin", "codex")
    assert xs["safe"]["description"] == "updated desc"
    assert xs["body"].rstrip() == "New shared body."
    assert xs["safe"]["skills"] == ["shared-skill"]
    # codex file holds a real [[skills.config]] absolute path (D2 translation)
    raw = (twin_env["codex_agents"] / "twin.toml").read_text()
    assert str(twin_env["codex_skills_root"] / "shared-skill" / "SKILL.md") in raw


def test_cowrite_codex_to_claude(twin_env):
    write_claude_skill(twin_env, "shared-skill")
    write_codex_skill(twin_env, "shared-skill")
    make_pair(twin_env)
    res = subagents.save_agent(codex_payload(
        description="from codex", body="Codex-authored body.\n",
        skills=["shared-skill"], original_name="twin"), None)
    assert res["ok"], res
    assert res["cowrote_twin"] is True and res["twin_harness"] == "claude-code"
    cs = show("twin", "claude-code")
    assert cs["safe"]["description"] == "from codex"
    assert cs["body"] == "Codex-authored body.\n"
    assert cs["safe"]["skills"] == ["shared-skill"]


def test_overlay_and_model_never_cross_map(twin_env):
    subagents.save_agent(claude_payload(model="sonnet", color="red"), None)
    subagents.save_agent(codex_payload(model="gpt-9", sandbox_mode="read-only"), None)
    sl.link_agents("twin", ["claude-code", "codex"], "user", None)
    # co-write from claude (shared change) …
    res = subagents.save_agent(claude_payload(
        model="opus", color="blue", description="shared edit",
        original_name="twin"), None)
    assert res["ok"], res
    xs = show("twin", "codex")
    # … codex keeps its OWN model + overlay; claude's model/color never arrive
    assert xs["safe"]["model"] == "gpt-9"
    assert xs["safe"]["sandbox_mode"] == "read-only"
    raw = (twin_env["codex_agents"] / "twin.toml").read_text()
    assert "opus" not in raw and "color" not in raw
    # and back: a codex save must not push model/sandbox into claude
    res = subagents.save_agent(codex_payload(
        model="gpt-10", sandbox_mode="workspace-write",
        description="shared edit 2", original_name="twin"), None)
    assert res["ok"], res
    cs = show("twin", "claude-code")
    assert cs["safe"]["model"] == "opus"
    assert cs["safe"]["color"] == "blue"
    raw = (twin_env["claude_agents"] / "twin.md").read_text()
    assert "gpt-10" not in raw and "sandbox" not in raw


def test_cowrite_preserves_twin_advanced_keys(twin_env):
    make_pair(twin_env)
    f = twin_env["codex_agents"] / "twin.toml"
    f.write_text(f.read_text() + '\ncustom_key = "kept"\n')
    res = subagents.save_agent(claude_payload(
        description="advance check", original_name="twin"), None)
    assert res["ok"]
    raw = f.read_text()
    assert 'custom_key = "kept"' in raw
    assert 'description = "advance check"' in raw


def test_no_false_instructions_drift_after_normal_save(twin_env):
    """Claude normalize_body appends \\n; TOML strings don't — a normal save
    must not manufacture perpetual instructions drift (review MINOR-5)."""
    make_pair(twin_env)
    res = subagents.save_agent(claude_payload(
        body="No trailing newline here", original_name="twin"), None)
    assert res["ok"]
    assert show("twin", "claude-code")["drift"] is None
    assert show("twin", "codex")["drift"] is None
    assert sl.link_status("user", None)["links"][0]["drift"] == []
    # and from the codex side too
    res = subagents.save_agent(codex_payload(
        body="Another body.\n", original_name="twin"), None)
    assert res["ok"]
    assert show("twin", "claude-code")["drift"] is None
    assert show("twin", "codex")["drift"] is None


# ─────────────────────────────────────────────────────────────────────────────
# Drift: surfacing, freeze, resolution
# ─────────────────────────────────────────────────────────────────────────────


def hand_drift_codex_description(twin_env, new_desc="hand-tuned"):
    f = twin_env["codex_agents"] / "twin.toml"
    f.write_text(f.read_text().replace('description = "a twin"',
                                       f'description = "{new_desc}"'))


def test_hand_edit_codex_surfaces_drift(twin_env):
    make_pair(twin_env)
    hand_drift_codex_description(twin_env)
    s = show("twin", "claude-code")
    assert s["drift"] == [{
        "field": "description",
        "values": {"claude-code": "a twin", "codex": "hand-tuned"}}]
    st = sl.link_status("user", None)
    assert st["links"][0]["drift"] == s["drift"]


def test_save_changing_drifted_field_is_blocked(twin_env):
    make_pair(twin_env)
    hand_drift_codex_description(twin_env)
    res = subagents.save_agent(claude_payload(
        description="my new desc", original_name="twin"), None)
    assert not res["ok"]
    err = res["errors"][0]
    assert err["field"] == "description" and err["level"] == "error"
    assert "resolve the drift first" in err["message"]
    # neither file changed
    assert show("twin", "claude-code")["safe"]["description"] == "a twin"
    assert show("twin", "codex")["safe"]["description"] == "hand-tuned"


def test_save_nondrifted_field_succeeds_and_freezes_drifted(twin_env):
    make_pair(twin_env)
    hand_drift_codex_description(twin_env)
    res = subagents.save_agent(claude_payload(
        body="Fresh instructions.\n", original_name="twin"), None)
    assert res["ok"], res
    # body co-written to the twin …
    assert show("twin", "codex")["body"].rstrip() == "Fresh instructions."
    # … while the drifted field stays frozen on BOTH sides
    assert show("twin", "claude-code")["safe"]["description"] == "a twin"
    assert show("twin", "codex")["safe"]["description"] == "hand-tuned"
    # drift still reported after the save
    assert show("twin", "claude-code")["drift"][0]["field"] == "description"


def test_resolve_drift_writes_winner_into_loser(twin_env):
    make_pair(twin_env)
    hand_drift_codex_description(twin_env)
    res = sl.resolve_drift("twin", "user", None, {"description": "codex"})
    assert res["ok"] and res["drift"] == []
    assert show("twin", "claude-code")["safe"]["description"] == "hand-tuned"
    assert show("twin", "claude-code")["drift"] is None


def test_resolve_drift_claude_wins(twin_env):
    make_pair(twin_env)
    hand_drift_codex_description(twin_env)
    res = sl.resolve_drift("twin", "user", None, {"description": "claude-code"})
    assert res["ok"] and res["drift"] == []
    assert show("twin", "codex")["safe"]["description"] == "a twin"


def test_resolve_drift_validates_input(twin_env):
    make_pair(twin_env)
    res = sl.resolve_drift("twin", "user", None, {"nope": "codex"})
    assert not res["ok"] and "unknown shared-core field" in res["error"]
    res = sl.resolve_drift("twin", "user", None, {"description": "pi"})
    assert not res["ok"]
    res = sl.resolve_drift("ghost", "user", None, {"description": "codex"})
    assert not res["ok"] and "not linked" in res["error"]


# ─────────────────────────────────────────────────────────────────────────────
# Linked rename (transactional) + delete (this|both)
# ─────────────────────────────────────────────────────────────────────────────


def test_linked_rename_renames_both_files(twin_env):
    make_pair(twin_env)
    s = show("twin", "claude-code")
    res = subagents.save_agent(claude_payload(
        name="twin-two", body=s["body"], original_name="twin"), None)
    assert res["ok"] and res["renamed_from"] == "twin"
    assert (twin_env["claude_agents"] / "twin-two.md").exists()
    assert (twin_env["codex_agents"] / "twin-two.toml").exists()
    assert not (twin_env["claude_agents"] / "twin.md").exists()
    assert not (twin_env["codex_agents"] / "twin.toml").exists()
    # sidecar follows the rename
    entry = json.loads(twin_env["sidecar"].read_text())["links"][0]
    assert entry["name"] == "twin-two"
    assert show("twin-two", "codex")["link"]["linked"] is True


def test_linked_rename_transactional_rollback(twin_env, monkeypatch):
    make_pair(twin_env)
    claude_before = (twin_env["claude_agents"] / "twin.md").read_bytes()
    codex_before = (twin_env["codex_agents"] / "twin.toml").read_bytes()

    real_replace = os.replace

    def failing_replace(src, dst, *a, **kw):
        # fail the SECOND file write (the codex twin) — injected failure
        if "codexhome" in str(dst):
            raise OSError("disk on fire")
        return real_replace(src, dst, *a, **kw)

    monkeypatch.setattr(os, "replace", failing_replace)
    res = subagents.save_agent(claude_payload(
        name="twin-two", original_name="twin"), None)
    monkeypatch.setattr(os, "replace", real_replace)

    assert res["ok"] is False
    assert "rolled back" in res["errors"][0]["message"]
    # both files restored byte-for-byte, no half-renamed state
    assert (twin_env["claude_agents"] / "twin.md").read_bytes() == claude_before
    assert (twin_env["codex_agents"] / "twin.toml").read_bytes() == codex_before
    assert not (twin_env["claude_agents"] / "twin-two.md").exists()
    assert not (twin_env["codex_agents"] / "twin-two.toml").exists()
    # sidecar untouched (still the old name)
    assert json.loads(twin_env["sidecar"].read_text())["links"][0]["name"] == "twin"


def test_delete_link_action_this_unlinks_and_keeps_twin(twin_env):
    make_pair(twin_env)
    res = subagents.delete_agent("twin", "user", None, None, "claude-code", "this")
    assert res["ok"]
    assert not (twin_env["claude_agents"] / "twin.md").exists()
    assert (twin_env["codex_agents"] / "twin.toml").exists()
    # pair unlinked — the survivor does NOT report a lost twin
    assert sl.find_link("twin", "user") is None
    item = next(a for a in subagents.list_agents("user", None, None, "codex")["agents"]
                if a["name"] == "twin")
    assert item["link"] is None


def test_delete_link_action_both_removes_both(twin_env):
    make_pair(twin_env)
    res = subagents.delete_agent("twin", "user", None, None, "codex", "both")
    assert res["ok"]
    assert not (twin_env["claude_agents"] / "twin.md").exists()
    assert not (twin_env["codex_agents"] / "twin.toml").exists()
    assert sl.find_link("twin", "user") is None


# ─────────────────────────────────────────────────────────────────────────────
# CLI e2e (subprocess — real `hub subagent link/unlink/link-status/resolve-drift`)
# ─────────────────────────────────────────────────────────────────────────────


def _cli_env(twin_env):
    env = {**os.environ,
           "SKILL_HUB_HOME": str(twin_env["data_home"]),
           "SKILL_HUB_CLAUDE_HOME": str(twin_env["claude"]),
           "CODEX_HOME": str(twin_env["codex_home"]),
           "HOME": str(twin_env["home"])}
    env.pop("SKILL_HUB_DIR", None)
    return env


def _run(args, env, input_text=None):
    return subprocess.run([sys.executable, "hub.py", *args],
                          input=input_text, capture_output=True, text=True,
                          env=env, cwd=os.getcwd())


def test_cli_link_journey(twin_env):
    env = _cli_env(twin_env)

    p = _run(["subagent", "save", "--json"], env,
             input_text=json.dumps(claude_payload()))
    assert p.returncode == 0, p.stdout + p.stderr

    # link with --copy-from: codex twin projected from claude
    p = _run(["subagent", "link", "--name", "twin",
              "--harnesses", "claude-code,codex",
              "--copy-from", "claude-code", "--json"], env)
    assert p.returncode == 0, p.stdout + p.stderr
    data = json.loads(p.stdout)
    assert data["ok"] and data["harnesses"] == ["claude-code", "codex"]
    assert (twin_env["codex_agents"] / "twin.toml").exists()

    p = _run(["subagent", "link-status", "--json"], env)
    assert p.returncode == 0
    st = json.loads(p.stdout)
    assert st["links"][0]["name"] == "twin"
    assert st["links"][0]["twin_lost"] is False and st["links"][0]["drift"] == []

    # hand-drift the codex file, resolve via CLI (codex wins)
    f = twin_env["codex_agents"] / "twin.toml"
    f.write_text(f.read_text().replace('description = "a twin"',
                                       'description = "box truth"'))
    p = _run(["subagent", "link-status", "--json"], env)
    st = json.loads(p.stdout)
    assert st["links"][0]["drift"][0]["field"] == "description"

    p = _run(["subagent", "resolve-drift", "--name", "twin", "--json"], env,
             input_text=json.dumps({"decisions": {"description": "codex"}}))
    assert p.returncode == 0, p.stdout + p.stderr
    out = json.loads(p.stdout)
    assert out["ok"] and out["drift"] == []
    assert "box truth" in (twin_env["claude_agents"] / "twin.md").read_text()

    p = _run(["subagent", "unlink", "--name", "twin", "--json"], env)
    assert p.returncode == 0
    assert json.loads(p.stdout)["unlinked"] is True
    p = _run(["subagent", "link-status", "--json"], env)
    st = json.loads(p.stdout)
    assert st["links"] == []
    assert st["suggestions"] == [{"name": "twin",
                                  "harnesses": ["claude-code", "codex"]}]


def test_cli_link_missing_twin_without_copy_from_fails(twin_env):
    env = _cli_env(twin_env)
    p = _run(["subagent", "save", "--json"], env,
             input_text=json.dumps(claude_payload()))
    assert p.returncode == 0
    p = _run(["subagent", "link", "--name", "twin", "--json"], env)
    assert p.returncode != 0
    assert "Traceback" not in p.stderr
    assert json.loads(p.stdout)["ok"] is False


def test_cli_resolve_drift_bad_payload_fails_cleanly(twin_env):
    env = _cli_env(twin_env)
    p = _run(["subagent", "resolve-drift", "--name", "x", "--json"], env,
             input_text="not json")
    assert p.returncode != 0 and "Traceback" not in p.stderr
    p = _run(["subagent", "resolve-drift", "--name", "x", "--json"], env,
             input_text=json.dumps({"decisions": {}}))
    assert p.returncode != 0 and "Traceback" not in p.stderr


def test_cli_delete_link_action_both(twin_env):
    env = _cli_env(twin_env)
    make_pair(twin_env)
    p = _run(["subagent", "delete", "--name", "twin", "--link-action", "both",
              "--json"], env)
    assert p.returncode == 0, p.stdout + p.stderr
    assert not (twin_env["claude_agents"] / "twin.md").exists()
    assert not (twin_env["codex_agents"] / "twin.toml").exists()


def test_linked_delete_both_rolls_back_on_twin_failure(twin_env, monkeypatch):
    """Transactional linked delete (tywin r3): if deleting the twin fails after
    the first file was removed, the first file is restored — all-or-nothing."""
    from pathlib import Path

    make_pair(twin_env)
    claude_file = twin_env["claude_agents"] / "twin.md"
    codex_file = twin_env["codex_agents"] / "twin.toml"
    assert claude_file.exists() and codex_file.exists()

    real_unlink = Path.unlink

    def failing_unlink(self, *a, **kw):
        if self.name.endswith(".toml"):
            raise OSError("injected: cannot remove twin")
        return real_unlink(self, *a, **kw)

    monkeypatch.setattr(Path, "unlink", failing_unlink)
    res = subagents.delete_agent("twin", "user", None, None, "claude-code", "both")
    monkeypatch.setattr(Path, "unlink", real_unlink)
    assert res["ok"] is False
    assert "rolled back" in res["errors"][0]["message"]
    assert claude_file.exists(), "first-deleted file must be restored"
    assert codex_file.exists()
    # link untouched — the pair is still linked
    assert sl.find_link("twin", "user") is not None
