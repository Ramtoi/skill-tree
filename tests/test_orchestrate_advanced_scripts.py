"""Shell-level tests for the `orchestrate-advanced` fixture skill's three hook
scripts and its `run-codex-chunk.sh` runner.

Every test shells the real `.sh` files from the repo fixture copy (D6:
`tests/fixtures/ships_with/orchestrate-advanced/`) inside a throwaway git
worktree under `tmp_path`, with `HOME` also pointed at `tmp_path`, so nothing
here can reach a real workspace, a real `~/.claude`, or a real git repo. See
`plans/3.md`'s Test tasks table (T0-T6) and `plans/0-direction.md`'s A14 for
the `.git`-pointer correction the discovery helpers below exercise.

T0 (run `claude --version`, confirm the SubagentStop/SubagentStart shapes
against the installed Claude Code's hooks reference) is a manual check
recorded in the delivery report, not a test here: both shapes plans/3.md
specifies -- a top-level `{"decision": "block", "reason": ...}` for
SubagentStop, and `{"hookSpecificOutput": {"hookEventName": "SubagentStart",
"additionalContext": ...}}` for SubagentStart -- were confirmed verbatim
against https://code.claude.com/docs/en/hooks.md.
"""

from __future__ import annotations

import json
import os
import pty
import subprocess
from pathlib import Path

import pytest
import yaml

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "ships_with" / "orchestrate-advanced"
STDIN_DIR = Path(__file__).parent / "fixtures" / "ships_with" / "stdin"
SCRIPTS_DIR = FIXTURE_ROOT / "scripts"
AGENTS_DIR = FIXTURE_ROOT / "agents"

UNIT_AGENT_TYPES = [
    "orch-researcher",
    "orch-planner",
    "orch-griller",
    "orch-implementer",
    "orch-reviewer",
]


# ─────────────────────────────────────────────────────────────────────────────
# Shared plumbing
# ─────────────────────────────────────────────────────────────────────────────


def _load_stdin(name: str, substitutions: dict) -> bytes:
    """Load a `stdin/*.json` template and substitute placeholder string
    VALUES (never key names) with real per-test values, returning encoded
    JSON bytes ready to pipe to a script's stdin."""
    data = json.loads((STDIN_DIR / name).read_text())

    def walk(node):
        if isinstance(node, dict):
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, str) and node in substitutions:
            return substitutions[node]
        return node

    return json.dumps(walk(data)).encode()


def _run_hook(script: str, payload: bytes, *, home: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["HOME"] = str(home)
    return subprocess.run(
        ["/bin/bash", str(SCRIPTS_DIR / script)],
        input=payload,
        capture_output=True,
        env=env,
    )


class Chunk:
    """A throwaway main repo + one linked worktree, entirely under tmp_path,
    with the `.git/orch-units` pointer (A14) and a `units/` dir wired up the
    way the super would before spawning a chunk's sub-orchestrator."""

    def __init__(self, tmp_path: Path, chunk_id: str = "py-leaf"):
        self.home = tmp_path / "home"
        self.home.mkdir()
        self.repo = tmp_path / "repo"
        self.worktree = tmp_path / "wt"
        self.workspace = tmp_path / "ws"
        self.units_dir = self.workspace / "units"
        (self.units_dir / "_pending").mkdir(parents=True)
        self.chunk_id = chunk_id
        self.brief_path = self.workspace / "plans" / "chunks" / f"{chunk_id}.md"
        self.brief_path.parent.mkdir(parents=True)
        self.brief_path.write_text(f"Chunk: {chunk_id}\nObjective: test\n")
        self.report_path = self.workspace / "reports" / "chunks" / f"{chunk_id}.md"
        self.report_path.parent.mkdir(parents=True)

        self._git("init", "-q", str(self.repo), cwd=tmp_path)
        self._git("commit", "-q", "--allow-empty", "-m", "init", cwd=self.repo)
        self._git("worktree", "add", "-q", str(self.worktree), "-b", "feat", cwd=self.repo)

        pointer = self.git_dir() / "orch-units"
        pointer.write_text(str(self.units_dir))

    def _git(self, *args, cwd) -> None:
        env = dict(os.environ)
        env.update(
            {
                "HOME": str(self.home),
                "GIT_AUTHOR_NAME": "test",
                "GIT_AUTHOR_EMAIL": "test@example.com",
                "GIT_COMMITTER_NAME": "test",
                "GIT_COMMITTER_EMAIL": "test@example.com",
            }
        )
        subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)

    def git_dir(self) -> Path:
        out = subprocess.run(
            ["git", "-C", str(self.worktree), "rev-parse", "--git-dir"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        path = Path(out)
        return path if path.is_absolute() else self.worktree / path

    def write_pending(self, allowed: list[str]) -> None:
        payload = {
            "schema_version": 1,
            "chunk": self.chunk_id,
            "slug": "ships-with-test",
            "depth": 2,
            "runner": "claude-nested",
            "worktree": str(self.worktree),
            "workspace": str(self.workspace),
            "brief_path": str(self.brief_path),
            "report_path": str(self.report_path),
            "allowed": allowed,
            "created_at": "2026-09-05T12:00:00Z",
            "notes": [],
        }
        (self.units_dir / "_pending" / f"{self.chunk_id}.json").write_text(json.dumps(payload))

    def write_claimed(self, agent_id: str, *, role: str, allowed: list[str], report_path: Path | None = None) -> Path:
        payload = {
            "schema_version": 1,
            "chunk": self.chunk_id,
            "slug": "ships-with-test",
            "depth": 2,
            "runner": "claude-nested",
            "role": role,
            "worktree": str(self.worktree),
            "workspace": str(self.workspace),
            "brief_path": str(self.brief_path),
            "report_path": str(report_path or self.report_path),
            "allowed": allowed,
            "agent_id": agent_id,
            "agent_type": "orch-implementer" if role == "unit" else "orch-sub-orchestrator",
            "created_at": "2026-09-05T12:00:00Z",
            "claimed_at": "2026-09-05T12:01:00Z",
            "notes": [],
        }
        marker = self.units_dir / f"{agent_id}.json"
        marker.write_text(json.dumps(payload))
        return marker

    def marker(self, agent_id: str) -> dict:
        return json.loads((self.units_dir / f"{agent_id}.json").read_text())


# ─────────────────────────────────────────────────────────────────────────────
# T1 -- scope-guard.sh (PreToolUse)
# ─────────────────────────────────────────────────────────────────────────────


def test_scope_guard_allowed_edit_is_silent(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py", "tests/", "docs/*.md"])
    payload = _load_stdin(
        "pretooluse_edit.json",
        {"__CWD__": str(chunk.worktree), "__FILE_PATH__": "allowed/file.py", "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


def test_scope_guard_outside_edit_denies_with_json(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py", "tests/", "docs/*.md"])
    payload = _load_stdin(
        "pretooluse_edit.json",
        {"__CWD__": str(chunk.worktree), "__FILE_PATH__": "secret/other.py", "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["permissionDecision"] == "deny"
    assert "secret/other.py" in hso["permissionDecisionReason"]
    assert chunk.chunk_id in hso["permissionDecisionReason"]


def test_scope_guard_no_claimed_marker_is_silent(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_pending(["allowed/file.py"])  # pending only, nothing claimed yet
    payload = _load_stdin(
        "pretooluse_edit.json",
        {"__CWD__": str(chunk.worktree), "__FILE_PATH__": "secret/other.py", "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


def test_scope_guard_no_agent_id_is_the_human_and_is_silent(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py"])
    payload = _load_stdin(
        "pretooluse_no_agent.json",
        {"__CWD__": str(chunk.worktree), "__FILE_PATH__": "secret/other.py"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


def test_scope_guard_apply_patch_resolves_like_file_path(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py"])
    command = "*** Begin Patch\n*** Update File: secret/x.py\n*** End Patch"
    payload = _load_stdin(
        "pretooluse_apply_patch.json",
        {"__CWD__": str(chunk.worktree), "__PATCH_COMMAND__": command, "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "secret/x.py" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_scope_guard_apply_patch_allowed_path_is_silent(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py"])
    command = "*** Begin Patch\n*** Update File: allowed/file.py\n*** End Patch"
    payload = _load_stdin(
        "pretooluse_apply_patch.json",
        {"__CWD__": str(chunk.worktree), "__PATCH_COMMAND__": command, "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


def test_scope_guard_bash_git_commit_denied_under_unit_role(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py"])
    payload = _load_stdin(
        "pretooluse_bash.json",
        {"__CWD__": str(chunk.worktree), "__BASH_COMMAND__": "git commit -m x", "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "git commit" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_scope_guard_bash_git_commit_allowed_under_sub_orchestrator_role(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-2", role="sub-orchestrator", allowed=["allowed/file.py"])
    payload = _load_stdin(
        "pretooluse_bash.json",
        {"__CWD__": str(chunk.worktree), "__BASH_COMMAND__": "git commit -m x", "__AGENT_ID__": "agent-2",
         "__AGENT_TYPE__": "orch-sub-orchestrator"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


@pytest.mark.parametrize(
    "command,expected_subcommand",
    [
        pytest.param("git -C some/dir push", "push", id="global-option-C-before-subcommand"),
        pytest.param("git -c user.email=x commit -m y", "commit", id="global-option-c-keyvalue"),
        pytest.param("pytest -q && git push origin main", "push", id="chained-and-and"),
        pytest.param("echo hi; git rebase -i main", "rebase", id="chained-semicolon"),
    ],
)
def test_scope_guard_bash_git_matcher_catches_every_form(tmp_path, command, expected_subcommand):
    # S-5: the matcher must not be form-specific -- a subcommand after global
    # options, or reached via && / ; chaining, is still gatekept under
    # role: unit.
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py"])
    payload = _load_stdin(
        "pretooluse_bash.json",
        {"__CWD__": str(chunk.worktree), "__BASH_COMMAND__": command, "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert f"git {expected_subcommand}" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_scope_guard_bash_other_command_is_silent(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py"])
    payload = _load_stdin(
        "pretooluse_bash.json",
        {"__CWD__": str(chunk.worktree), "__BASH_COMMAND__": "pytest -q", "__AGENT_ID__": "agent-1",
         "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("scope-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


# ─────────────────────────────────────────────────────────────────────────────
# T2 -- report-guard.sh (SubagentStop)
# ─────────────────────────────────────────────────────────────────────────────


def _subagentstop_payload(chunk: Chunk, agent_id: str, agent_type: str, lines: int) -> bytes:
    message = "\n".join(f"line {i}" for i in range(1, lines + 1))
    return _load_stdin(
        "subagentstop.json",
        {
            "__CWD__": str(chunk.worktree),
            "__AGENT_ID__": agent_id,
            "__AGENT_TYPE__": agent_type,
            "__AGENT_TRANSCRIPT_PATH__": str(chunk.workspace / "transcript.jsonl"),
            "__LAST_MSG__": message,
        },
    )


def test_report_guard_unit_role_never_refuses(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-1", role="unit", allowed=["allowed/file.py"])
    # No report on disk and a 20-line message would refuse a sub-orchestrator;
    # a unit-role marker must be exempt outright (C5).
    payload = _subagentstop_payload(chunk, "agent-1", "orch-implementer", lines=20)
    result = _run_hook("report-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


def test_report_guard_sub_orchestrator_missing_report_blocks(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-2", role="sub-orchestrator", allowed=["allowed/file.py"])
    assert not chunk.report_path.exists()
    payload = _subagentstop_payload(chunk, "agent-2", "orch-sub-orchestrator", lines=5)
    result = _run_hook("report-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["decision"] == "block"
    assert str(chunk.report_path) in out["reason"]


def test_report_guard_sub_orchestrator_13_lines_blocks(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-2", role="sub-orchestrator", allowed=["allowed/file.py"])
    chunk.report_path.write_text("chunk: py-leaf\n")
    payload = _subagentstop_payload(chunk, "agent-2", "orch-sub-orchestrator", lines=13)
    result = _run_hook("report-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["decision"] == "block"


def test_report_guard_sub_orchestrator_12_lines_and_report_present_is_silent(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-2", role="sub-orchestrator", allowed=["allowed/file.py"])
    chunk.report_path.write_text("chunk: py-leaf\n")
    payload = _subagentstop_payload(chunk, "agent-2", "orch-sub-orchestrator", lines=12)
    result = _run_hook("report-guard.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""


def test_report_guard_third_call_after_two_denials_allows_and_notes(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_claimed("agent-2", role="sub-orchestrator", allowed=["allowed/file.py"])
    payload = _subagentstop_payload(chunk, "agent-2", "orch-sub-orchestrator", lines=13)

    first = _run_hook("report-guard.sh", payload, home=chunk.home)
    assert json.loads(first.stdout)["decision"] == "block"

    second = _run_hook("report-guard.sh", payload, home=chunk.home)
    assert json.loads(second.stdout)["decision"] == "block"

    third = _run_hook("report-guard.sh", payload, home=chunk.home)
    assert third.returncode == 0
    assert third.stdout == b""

    notes = chunk.marker("agent-2")["notes"]
    assert any("gave up after 2 refusals" in n for n in notes)


# ─────────────────────────────────────────────────────────────────────────────
# T3 -- unit-brief.sh (SubagentStart)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("agent_type", UNIT_AGENT_TYPES)
def test_unit_brief_claims_pending_marker_as_unit_role(tmp_path, agent_type):
    chunk = Chunk(tmp_path)
    chunk.write_pending(["allowed/file.py", "tests/"])
    payload = _load_stdin(
        "subagentstart.json",
        {"__CWD__": str(chunk.worktree), "__AGENT_ID__": "agent-9", "__AGENT_TYPE__": agent_type},
    )
    result = _run_hook("unit-brief.sh", payload, home=chunk.home)
    assert result.returncode == 0

    out = json.loads(result.stdout)
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "SubagentStart"
    assert "Chunk: py-leaf" in hso["additionalContext"]

    marker = chunk.marker("agent-9")
    assert marker["agent_id"] == "agent-9"
    assert marker["agent_type"] == agent_type
    assert marker["role"] == "unit"
    assert "claimed_at" in marker

    # The pending file must survive the claim -- the next agent in the same
    # chunk claims it too.
    assert (chunk.units_dir / "_pending" / f"{chunk.chunk_id}.json").exists()


def test_unit_brief_claims_pending_marker_as_sub_orchestrator_role(tmp_path):
    chunk = Chunk(tmp_path)
    chunk.write_pending(["allowed/file.py"])
    payload = _load_stdin(
        "subagentstart.json",
        {"__CWD__": str(chunk.worktree), "__AGENT_ID__": "agent-10", "__AGENT_TYPE__": "orch-sub-orchestrator"},
    )
    result = _run_hook("unit-brief.sh", payload, home=chunk.home)
    assert result.returncode == 0
    marker = chunk.marker("agent-10")
    assert marker["role"] == "sub-orchestrator"


@pytest.mark.parametrize("agent_type", ["general-purpose", "Explore", "Plan", "some-other-agent"])
def test_unit_brief_unknown_agent_type_claims_nothing(tmp_path, agent_type):
    # W-6: an agent_type outside the five orch-* unit names and
    # orch-sub-orchestrator must never default to "sub-orchestrator" -- it
    # claims nothing at all: no marker is written, and the pending file is
    # left untouched for whichever agent actually claims this chunk.
    chunk = Chunk(tmp_path)
    chunk.write_pending(["allowed/file.py"])
    payload = _load_stdin(
        "subagentstart.json",
        {"__CWD__": str(chunk.worktree), "__AGENT_ID__": "agent-99", "__AGENT_TYPE__": agent_type},
    )
    result = _run_hook("unit-brief.sh", payload, home=chunk.home)
    assert result.returncode == 0
    assert result.stdout == b""
    assert not (chunk.units_dir / "agent-99.json").exists()
    assert (chunk.units_dir / "_pending" / f"{chunk.chunk_id}.json").exists()


def test_unit_brief_no_pointer_is_silent(tmp_path):
    # A plain, non-worktree git repo with no `.git/orch-units` pointer at all.
    home = tmp_path / "home"
    home.mkdir()
    repo = tmp_path / "plain-repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
    payload = _load_stdin(
        "subagentstart.json",
        {"__CWD__": str(repo), "__AGENT_ID__": "agent-1", "__AGENT_TYPE__": "orch-implementer"},
    )
    result = _run_hook("unit-brief.sh", payload, home=home)
    assert result.returncode == 0
    assert result.stdout == b""


# ─────────────────────────────────────────────────────────────────────────────
# T4 -- run-codex-chunk.sh
# ─────────────────────────────────────────────────────────────────────────────


def test_run_codex_chunk_pty_stdin_exits_2_and_names_the_redirect(tmp_path):
    script = str(SCRIPTS_DIR / "run-codex-chunk.sh")
    master, slave = pty.openpty()
    try:
        proc = subprocess.Popen(
            ["/bin/bash", script, "--worktree", str(tmp_path), "--report", str(tmp_path / "r.md"),
             "--model", "gpt-5.6-luna", "--", "hello"],
            stdin=slave,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        os.close(slave)
        slave = -1
        _, err = proc.communicate(timeout=10)
    finally:
        os.close(master)
        if slave != -1:
            os.close(slave)
    assert proc.returncode == 2
    assert "/dev/null" in err.decode()


def test_run_codex_chunk_dry_run_pins_argv_order(tmp_path):
    report = tmp_path / "report.md"
    env = dict(os.environ)
    env["ORCH_DRY_RUN"] = "1"
    result = subprocess.run(
        ["/bin/bash", str(SCRIPTS_DIR / "run-codex-chunk.sh"), "--worktree", str(tmp_path),
         "--report", str(report), "--model", "gpt-5.6-luna", "--", "do the chunk thing"],
        capture_output=True,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    assert result.returncode == 0
    tokens = result.stdout.decode().splitlines()
    assert tokens == [
        "codex", "exec", "-s", "workspace-write", "-m", "gpt-5.6-luna", "-o", str(report),
        "--json", "-C", str(tmp_path), "--", "do the chunk thing",
    ]


def test_run_codex_chunk_missing_worktree_exits_2(tmp_path):
    result = subprocess.run(
        ["/bin/bash", str(SCRIPTS_DIR / "run-codex-chunk.sh"), "--report", str(tmp_path / "r.md"),
         "--model", "gpt-5.6-luna", "--", "hello"],
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )
    assert result.returncode == 2
    assert "--worktree" in result.stderr.decode()


def test_run_codex_chunk_empty_prompt_exits_2(tmp_path):
    result = subprocess.run(
        ["/bin/bash", str(SCRIPTS_DIR / "run-codex-chunk.sh"), "--worktree", str(tmp_path),
         "--report", str(tmp_path / "r.md"), "--model", "gpt-5.6-luna", "--"],
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )
    assert result.returncode == 2
    assert "prompt" in result.stderr.decode()


# ─────────────────────────────────────────────────────────────────────────────
# T5 -- the fixture's ships_with frontmatter shape
# ─────────────────────────────────────────────────────────────────────────────


def _frontmatter(path: Path) -> dict:
    text = path.read_text()
    assert text.startswith("---\n"), f"{path} has no frontmatter fence"
    _, rest = text.split("---\n", 1)
    fm_text, _ = rest.split("\n---", 1)
    return yaml.safe_load(fm_text)


def test_fixture_ships_with_shape():
    fm = _frontmatter(FIXTURE_ROOT / "SKILL.md")
    ships_with = fm["ships_with"]

    assert ships_with["agents"] == [
        "orch-sub-orchestrator", "orch-researcher", "orch-planner", "orch-griller",
        "orch-implementer", "orch-reviewer",
    ]
    assert len(ships_with["agents"]) == 6

    hooks = ships_with["hooks"]
    assert len(hooks) == 3
    events = {h["name"]: h["event"] for h in hooks}
    assert events == {
        "orch-scope-guard": "PreToolUse",
        "orch-report-guard": "SubagentStop",
        "orch-unit-brief": "SubagentStart",
    }
    for hook in hooks:
        assert hook["activation"] == "while-running"
        assert "harnesses" not in hook  # no per-hook affinity, on purpose (I2/A3)
        script_path = FIXTURE_ROOT / hook["command"]
        assert script_path.is_file(), f"{hook['command']} does not resolve to a file"
        assert os.access(script_path, os.X_OK), f"{hook['command']} is not executable"

    permissions = ships_with["permissions"]
    assert permissions["deny"] == ["Bash(git push --force:*)"]
    assert permissions["ask"] == ["Bash(gh pr merge:*)"]
    assert "allow" not in permissions or permissions["allow"] == []


# ─────────────────────────────────────────────────────────────────────────────
# T6 -- agents/*.md frontmatter
# ─────────────────────────────────────────────────────────────────────────────


AGENT_NAMES = [
    "orch-sub-orchestrator", "orch-researcher", "orch-planner", "orch-griller",
    "orch-implementer", "orch-reviewer",
]


@pytest.mark.parametrize("name", AGENT_NAMES)
def test_fixture_agent_frontmatter(name):
    fm = _frontmatter(AGENTS_DIR / f"{name}.md")
    assert fm["name"] == name
    assert isinstance(fm["description"], str) and fm["description"]
    assert fm["tier"] in ("deep", "planner", "worker")
    assert isinstance(fm["tools"], list) and fm["tools"]


def test_fixture_only_sub_orchestrator_carries_agent_tool():
    for name in AGENT_NAMES:
        fm = _frontmatter(AGENTS_DIR / f"{name}.md")
        has_agent = "Agent" in fm["tools"]
        if name == "orch-sub-orchestrator":
            assert has_agent, "orch-sub-orchestrator must carry the Agent tool"
        else:
            assert not has_agent, f"{name} must not carry the Agent tool (depth cap, W10)"


def test_fixture_griller_and_reviewer_carry_no_write_tools():
    for name in ("orch-griller", "orch-reviewer"):
        fm = _frontmatter(AGENTS_DIR / f"{name}.md")
        assert "Edit" not in fm["tools"]
        assert "Write" not in fm["tools"]
