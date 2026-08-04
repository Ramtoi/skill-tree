"""LIVE codex gate (tasks 1.9 / 6.4 of cross-harness-subagents).

Proves the real signal path: an agent authored via `hub subagent save
--harness codex` is DISCOVERED and SPAWNED by a real `codex exec`, and its
attached skill loads through the hub-shaped `[[skills.config]]` absolute path.
Asserts on the successful SpawnAgent (no `unknown agent_type` in the run log),
never just on a token echo — the model will happily shell-read the TOML and
parrot a token even when the spawn fails (review M11 false-positive trap).

LIVE-VERIFIED CONSTRAINT (2026-07-04): `skills.config` entries only activate
skills that codex has ALREADY DISCOVERED from its real skill roots
(`$HOME/.agents/skills`) — a path outside the discovery root is silently
inert. This is exactly the D5 premise (the hub's global-skills sync populates
that root), and it means this test must place its throwaway skill in the REAL
`~/.agents/skills` (guarded: aborts if the name exists; always removed).

`codex exec` reads a piped stdin even when a prompt argument is given — stdin
must be DEVNULL or the run hangs on "Reading additional input from stdin...".

EXCLUDED from the default run: needs auth + takes ~30s-4min.
Run explicitly:  RUN_LIVE_CODEX=1 python3 -m pytest tests/test_subagents_live_codex.py -v -s

Isolation: agents live in a throwaway CODEX_HOME (real ~/.codex is never
written); auth.json + config.toml are COPIED into it for the run and deleted
in a finally block (auth bytes must never linger in tmp).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

LIVE = bool(os.environ.get("RUN_LIVE_CODEX"))
CODEX_BIN = shutil.which("codex") or str(Path.home() / ".local/bin/codex")
REAL_CODEX = Path.home() / ".codex"
REAL_SKILLS_ROOT = Path.home() / ".agents" / "skills"

pytestmark = [
    pytest.mark.live_codex,
    pytest.mark.skipif(not LIVE, reason="live codex gate — set RUN_LIVE_CODEX=1"),
    pytest.mark.skipif(not Path(CODEX_BIN).exists(), reason="codex binary not found"),
    pytest.mark.skipif(not (REAL_CODEX / "auth.json").exists(),
                       reason="no codex auth on this machine"),
]

SKILL_NAME = "st_live_gate_skill"
SKILL_TOKEN = "STGATE_SKILL_7431"


def test_hub_authored_agent_spawns_and_skill_loads(tmp_path):
    codex_home = tmp_path / "codexhome"
    work = tmp_path / "work"
    hub_home = tmp_path / "hub"
    for d in (codex_home / "agents", work, hub_home):
        d.mkdir(parents=True)

    # Throwaway skill in the REAL discovery root (see module docstring).
    skill_dir = REAL_SKILLS_ROOT / SKILL_NAME
    assert not skill_dir.exists(), (
        f"refusing to run: {skill_dir} already exists (not ours to clobber)")
    skill_dir.mkdir(parents=True)
    try:
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {SKILL_NAME}\n"
            "description: Skill Tree live-gate probe skill. Provides the gate token.\n---\n"
            f"The gate token is {SKILL_TOKEN}. When asked for your token, "
            f"reply with exactly {SKILL_TOKEN}.\n")

        # Author the agent THROUGH THE HUB (the real production path). Real
        # HOME so the serializer embeds the real discovery-root path.
        payload = json.dumps({
            "harness": "codex", "scope": "user", "project": None,
            "original_name": None,
            "safe": {"name": "st_gate", "description":
                     "Skill Tree live-gate probe. Use when asked to run the st gate.",
                     "model": "", "sandbox_mode": "read-only",
                     "model_reasoning_effort": "", "skills": [SKILL_NAME],
                     "nickname_candidates": []},
            "advanced_yaml": "",
            "body": ("You are a probe verifying skill preload. You have one "
                     "attached skill which defines a gate token. Reply with "
                     "EXACTLY that token and nothing else."),
        })
        save_env = {**os.environ, "SKILL_HUB_HOME": str(hub_home),
                    "CODEX_HOME": str(codex_home)}
        save_env.pop("SKILL_HUB_DIR", None)
        p = subprocess.run([sys.executable, "hub.py", "subagent", "save", "--json"],
                           input=payload, capture_output=True, text=True,
                           env=save_env, cwd=os.getcwd())
        assert p.returncode == 0, p.stdout + p.stderr
        agent_file = codex_home / "agents" / "st_gate.toml"
        assert str(skill_dir / "SKILL.md") in agent_file.read_text()

        # Bring auth into the isolated home; ALWAYS delete it afterwards.
        shutil.copy2(REAL_CODEX / "auth.json", codex_home / "auth.json")
        if (REAL_CODEX / "config.toml").exists():
            shutil.copy2(REAL_CODEX / "config.toml", codex_home / "config.toml")
        try:
            run_env = {**os.environ, "CODEX_HOME": str(codex_home)}
            last = tmp_path / "last.txt"
            proc = subprocess.run(
                [CODEX_BIN, "exec", "--skip-git-repo-check", "-C", str(work),
                 "-s", "read-only", "-o", str(last),
                 "Spawn the custom subagent named st_gate and return verbatim "
                 "exactly what it outputs. Do not read any files yourself. "
                 "Do nothing else."],
                capture_output=True, text=True, env=run_env, timeout=540,
                stdin=subprocess.DEVNULL)
            log = proc.stdout + proc.stderr

            # Load-bearing: the spawn SUCCEEDED (discovery worked).
            assert "unknown agent_type" not in log, (
                "codex did not discover the hub-authored agent:\n" + log[-2000:])
            assert "SpawnAgent" in log, "no SpawnAgent in run log:\n" + log[-2000:]

            # Skill-preload proof (D5 premise): the token only exists inside
            # the skill file; the orchestrating prompt forbids file reads, so
            # the token can only arrive via the sub-agent's loaded skill.
            out = last.read_text() if last.exists() else ""
            assert SKILL_TOKEN in out, (
                f"spawn succeeded but the skill token did not round-trip; "
                f"last message: {out!r}\nlog tail:\n" + log[-2000:])
        finally:
            (codex_home / "auth.json").unlink(missing_ok=True)
    finally:
        shutil.rmtree(skill_dir, ignore_errors=True)
