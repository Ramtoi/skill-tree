"""CLI e2e contract test for `hub subagent` (claude-subagents-manager, task 1.10).

Spawns the REAL CLI as a subprocess (`python3 hub.py subagent …`) against a fully
ISOLATED tmp environment:
  - SKILL_HUB_HOME       → tmp data home (with a minimal registry.yaml + one project)
  - SKILL_HUB_CLAUDE_HOME → tmp ~/.claude root (user agents + settings.json live here)
  - SKILL_HUB_DIR        → unset (no legacy alias leaking in)

This proves the CLI/JSON contract end to end: exit codes, stdout JSON shapes, the
save-via-stdin path, the disable mechanism writing `Agent(<name>)` to the tmp
settings.json deny (other keys intact), and delete stripping both the file and the
deny entry. NEVER touches the real ~/.claude. Mirrors the style of cliContract.test.ts.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HUB = REPO_ROOT / "hub.py"


# ─────────────────────────────────────────────────────────────────────────────
# Isolated environment fixture (modeled on conftest's tmp_data_home, but for the
# subprocess path — we control env via a dict, not monkeypatch, since the CLI is
# a fresh process).
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    """Return (env, ctx) for an isolated subagent CLI run.

    ctx exposes: data_home, claude_home, agents_dir, settings_path, project_dir,
    project_name.
    """
    data_home = tmp_path / "data"
    claude_home = tmp_path / "claude"
    project_dir = tmp_path / "myproj"

    (data_home).mkdir(parents=True)
    (claude_home / "agents").mkdir(parents=True)
    (claude_home / "skills").mkdir(parents=True)
    (project_dir / ".claude" / "agents").mkdir(parents=True)
    (project_dir / ".claude" / "skills").mkdir(parents=True)

    # Minimal registry.yaml with one project pointing at the tmp project dir.
    registry = {
        "projects": {"myproj": {"path": str(project_dir)}},
    }
    import yaml

    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    # Build a clean env: inherit PATH etc., but force the isolation vars and unset
    # SKILL_HUB_DIR so the legacy alias can't leak the real home in.
    import os

    env = dict(os.environ)
    env["SKILL_HUB_HOME"] = str(data_home)
    env["SKILL_HUB_CLAUDE_HOME"] = str(claude_home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.data_home = data_home
    ctx.claude_home = claude_home
    ctx.agents_dir = claude_home / "agents"
    ctx.settings_path = claude_home / "settings.json"
    ctx.skills_dir = claude_home / "skills"
    ctx.project_dir = project_dir
    ctx.project_name = "myproj"
    return env, ctx


def run_subagent(env, *args, stdin: str | None = None):
    """Run `python3 hub.py subagent <args>` and return (proc, parsed_json|None)."""
    proc = subprocess.run(
        [sys.executable, str(HUB), "subagent", *args],
        cwd=str(REPO_ROOT),
        env=env,
        input=stdin,
        capture_output=True,
        text=True,
    )
    parsed = None
    if proc.stdout.strip():
        try:
            parsed = json.loads(proc.stdout)
        except json.JSONDecodeError:
            parsed = None
    return proc, parsed


def write_skill(skills_root: Path, name: str, disable_invocation: bool = False) -> None:
    d = skills_root / name
    d.mkdir(parents=True, exist_ok=True)
    inv = "\ndisable-model-invocation: true" if disable_invocation else ""
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: a skill{inv}\n---\nBody\n"
    )


def _save_payload(name, description, *, scope="user", project=None,
                  original_name=None, model="sonnet", tools_mode="all",
                  tools=None, disallowed_tools=None, allow_skill_discovery=True,
                  skills=None, color="", advanced_yaml="", body="Hello.\n"):
    return {
        "scope": scope,
        "project": project,
        "original_name": original_name,
        "safe": {
            "name": name,
            "description": description,
            "model": model,
            "tools_mode": tools_mode,
            "tools": tools or [],
            "disallowed_tools": disallowed_tools or [],
            "allow_skill_discovery": allow_skill_discovery,
            "skills": skills or [],
            "color": color,
        },
        "advanced_yaml": advanced_yaml,
        "body": body,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Full journey
# ─────────────────────────────────────────────────────────────────────────────


def test_cli_full_journey(cli_env):
    env, ctx = cli_env

    # ── save a new user-scope agent (payload on stdin) with an advanced field ──
    payload = _save_payload(
        "reviewer", "Reviews code carefully.",
        model="sonnet", color="green",
        advanced_yaml="permissionMode: plan\n",
        body="You are a careful reviewer.\n",
    )
    proc, out = run_subagent(env, "save", stdin=json.dumps(payload))
    assert proc.returncode == 0, proc.stderr
    assert out is not None and out["ok"] is True
    assert out["name"] == "reviewer"
    assert Path(out["file"]).exists()
    # file landed in the ISOLATED tmp claude home, not the real ~/.claude
    assert str(ctx.agents_dir) in out["file"]

    # ── list --scope user --json shows it with correct fields ──
    proc, out = run_subagent(env, "list", "--scope", "user", "--json")
    assert proc.returncode == 0, proc.stderr
    assert out["scope"] == "user"
    assert out["agents_dir"] == str(ctx.agents_dir)
    by_name = {a["name"]: a for a in out["agents"]}
    assert "reviewer" in by_name
    rv = by_name["reviewer"]
    assert rv["model"] == "sonnet"
    assert rv["color"] == "green"
    assert rv["tools_mode"] == "all"
    assert rv["disabled"] is False
    assert rv["valid"] is True
    # built-ins surfaced read-only
    assert {b["name"] for b in out["builtins"]} == {"general-purpose", "Explore", "Plan"}

    # ── show --scope user --name reviewer --json round-trips safe+advanced+body ──
    proc, out = run_subagent(env, "show", "--scope", "user", "--name", "reviewer", "--json")
    assert proc.returncode == 0, proc.stderr
    assert out["exists"] is True
    assert out["safe"]["name"] == "reviewer"
    assert out["safe"]["description"] == "Reviews code carefully."
    assert out["safe"]["model"] == "sonnet"
    assert out["safe"]["color"] == "green"
    assert "permissionMode: plan" in out["advanced_yaml"]
    assert out["body"].startswith("You are a careful reviewer.")
    assert out["validation"]["valid"] is True

    # ── attach a skill: good (invocable) + bad (disable-model-invocation) ──
    write_skill(ctx.skills_dir, "good-skill")
    write_skill(ctx.skills_dir, "bad-skill", disable_invocation=True)

    # save with the good skill → ok
    payload = _save_payload(
        "reviewer", "Reviews code carefully.",
        original_name="reviewer", model="sonnet", color="green",
        skills=["good-skill"], advanced_yaml="permissionMode: plan\n",
        body="You are a careful reviewer.\n",
    )
    proc, out = run_subagent(env, "save", stdin=json.dumps(payload))
    assert proc.returncode == 0, proc.stderr
    assert out["ok"] is True
    # confirm skills: landed
    proc, show = run_subagent(env, "show", "--scope", "user", "--name", "reviewer", "--json")
    assert show["safe"]["skills"] == ["good-skill"]

    # capture the current on-disk content before the bad save
    agent_file = ctx.agents_dir / "reviewer.md"
    before = agent_file.read_text()

    # save with the bad skill → blocking error, file UNCHANGED
    bad_payload = _save_payload(
        "reviewer", "Reviews code carefully.",
        original_name="reviewer", model="sonnet", color="green",
        skills=["bad-skill"], advanced_yaml="permissionMode: plan\n",
        body="You are a careful reviewer.\n",
    )
    proc, out = run_subagent(env, "save", stdin=json.dumps(bad_payload))
    assert proc.returncode != 0
    assert out is not None and out["ok"] is False
    assert any(e["field"] == "skills" and e["level"] == "error" for e in out["errors"])
    assert agent_file.read_text() == before, "blocked save must not mutate the file"

    # ── set-disabled --disabled true writes Agent(reviewer) to deny; allow survives ──
    # seed an unrelated allow entry first
    ctx.settings_path.write_text(json.dumps(
        {"permissions": {"allow": ["Bash(npm:*)"]}}, indent=2))

    proc, out = run_subagent(
        env, "set-disabled", "--scope", "user", "--name", "reviewer", "--disabled", "true")
    assert proc.returncode == 0, proc.stderr
    assert out["ok"] is True and out["disabled"] is True

    settings = json.loads(ctx.settings_path.read_text())
    assert "Agent(reviewer)" in settings["permissions"]["deny"]
    assert settings["permissions"]["allow"] == ["Bash(npm:*)"], "unrelated allow must survive"

    # ── set-disabled --disabled false removes the exact entry ──
    proc, out = run_subagent(
        env, "set-disabled", "--scope", "user", "--name", "reviewer", "--disabled", "false")
    assert proc.returncode == 0, proc.stderr
    assert out["disabled"] is False
    settings = json.loads(ctx.settings_path.read_text())
    assert "Agent(reviewer)" not in settings["permissions"].get("deny", [])
    # allow still intact
    assert settings["permissions"]["allow"] == ["Bash(npm:*)"]

    # ── delete removes the agent file AND strips any deny entry ──
    # re-disable so there is a deny entry to strip
    run_subagent(env, "set-disabled", "--scope", "user", "--name", "reviewer", "--disabled", "true")
    settings = json.loads(ctx.settings_path.read_text())
    assert "Agent(reviewer)" in settings["permissions"]["deny"]

    proc, out = run_subagent(env, "delete", "--scope", "user", "--name", "reviewer", "--json")
    assert proc.returncode == 0, proc.stderr
    assert out["ok"] is True
    assert not agent_file.exists()
    settings = json.loads(ctx.settings_path.read_text())
    assert "Agent(reviewer)" not in settings["permissions"].get("deny", [])


def test_cli_save_invalid_name_blocks_and_no_file(cli_env):
    """Negative case: an invalid name → nonzero exit / ok:false, no file created."""
    env, ctx = cli_env
    payload = _save_payload("Bad Name", "d")
    proc, out = run_subagent(env, "save", stdin=json.dumps(payload))
    assert proc.returncode != 0
    assert out is not None and out["ok"] is False
    assert any(e["field"] == "name" for e in out["errors"])
    # no file with that (or any) name was created
    assert list(ctx.agents_dir.iterdir()) == []


def test_cli_save_malformed_advanced_yaml_blocks(cli_env):
    """A non-mapping advanced_yaml is a blocking error; file not created."""
    env, ctx = cli_env
    payload = _save_payload("x", "d", advanced_yaml="- not\n- a\n- map")
    proc, out = run_subagent(env, "save", stdin=json.dumps(payload))
    assert proc.returncode != 0
    assert out["ok"] is False
    assert any(e["field"] == "advanced_yaml" for e in out["errors"])
    assert not (ctx.agents_dir / "x.md").exists()


def test_cli_save_invalid_json_payload_exits_nonzero(cli_env):
    """Garbage on stdin → ok:false with a payload error and nonzero exit."""
    env, ctx = cli_env
    proc, out = run_subagent(env, "save", stdin="{not json")
    assert proc.returncode != 0
    assert out is not None and out["ok"] is False
    assert any(e["field"] == "payload" for e in out["errors"])


def test_cli_project_scope_journey(cli_env):
    """save + list + disable in PROJECT scope resolve via the registry project."""
    env, ctx = cli_env
    payload = _save_payload(
        "proj-agent", "A project agent.",
        scope="project", project=ctx.project_name, body="Project body.\n")
    proc, out = run_subagent(env, "save", stdin=json.dumps(payload))
    assert proc.returncode == 0, proc.stderr
    assert out["ok"] is True
    expected = ctx.project_dir / ".claude" / "agents" / "proj-agent.md"
    assert expected.exists()
    assert out["file"] == str(expected)

    proc, out = run_subagent(env, "list", "--scope", "project", "--project", ctx.project_name, "--json")
    assert proc.returncode == 0, proc.stderr
    assert out["project"] == ctx.project_name
    assert "proj-agent" in {a["name"] for a in out["agents"]}

    proc, out = run_subagent(
        env, "set-disabled", "--scope", "project", "--project", ctx.project_name,
        "--name", "proj-agent", "--disabled", "true")
    assert proc.returncode == 0, proc.stderr
    proj_settings = ctx.project_dir / ".claude" / "settings.json"
    settings = json.loads(proj_settings.read_text())
    assert "Agent(proj-agent)" in settings["permissions"]["deny"]


def test_cli_skill_usage_reverse_index(cli_env):
    """skill-usage returns the reverse index across user + project agent dirs."""
    env, ctx = cli_env
    write_skill(ctx.skills_dir, "shared")
    write_skill(ctx.project_dir / ".claude" / "skills", "shared")

    run_subagent(env, "save", stdin=json.dumps(_save_payload(
        "u-agent", "d", skills=["shared"])))
    run_subagent(env, "save", stdin=json.dumps(_save_payload(
        "p-agent", "d", scope="project", project=ctx.project_name, skills=["shared"])))

    proc, out = run_subagent(env, "skill-usage", "--json")
    assert proc.returncode == 0, proc.stderr
    agents = {u["agent"] for u in out["shared"]}
    assert agents == {"u-agent", "p-agent"}
