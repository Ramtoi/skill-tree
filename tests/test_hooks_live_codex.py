"""LIVE codex hooks gate (hooks-surface task 0.2).

Proves the ground truth the Codex hook writer (CodexHookAdapter, D2/D9) depends
on, verified against the INSTALLED codex binary (codex-cli 0.142.2 at capture):

1. codex accepts the hub-shaped nested hook TOML
   (`[[hooks.<Event>]]` + nested `[[hooks.<Event>.hooks]]` carrying
   `type="command"`, string `command`, optional `timeout`) with NO config-load
   error, even under `--strict-config`.
2. `command` MUST be a STRING — a TOML array is rejected at config load
   ("invalid type: sequence, expected a string", surfaced "in `hooks`").
   This pins the writer to emit a single-string command (shell-wrapped).
3. A PostToolUse command hook actually FIRES on a real `apply_patch` tool call
   and receives the expected stdin JSON (hook_event_name=PostToolUse,
   tool_name=apply_patch, tool_input.command = the apply_patch envelope string).

TRUST LIMITATION (verified, matches design D9): codex gates hook EXECUTION
behind per-hook trust. In non-interactive `codex exec` an untrusted hook is
SILENTLY SKIPPED — no prompt, and NOTHING is written to `[hooks.state]`. Trust
is granted only through codex's own interactive flow (which writes
`[hooks.state]."<name>".trusted_hash`), OR bypassed for one invocation with the
`--dangerously-bypass-hook-trust` flag. Hub MUST NEVER write `[hooks.state]`
(D9). This test uses `--dangerously-bypass-hook-trust` solely to exercise the
firing path in automation; production hub code never grants trust.

The parse tests (1,2) need NO auth (a valid config reaches the auth 401, which
proves the config parsed). Only the firing test (3) needs codex auth.

EXCLUDED from the default run (needs the codex binary; the fire test needs auth
+ ~30-120s). Run explicitly:
    RUN_LIVE_CODEX=1 python3 -m pytest tests/test_hooks_live_codex.py -v -s

Isolation: everything runs in a throwaway CODEX_HOME (real ~/.codex is never
written). For the fire test, auth.json is COPIED in and deleted in a finally.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

LIVE = bool(os.environ.get("RUN_LIVE_CODEX"))
CODEX_BIN = shutil.which("codex") or str(Path.home() / ".local/bin/codex")
REAL_CODEX = Path.home() / ".codex"

pytestmark = [
    pytest.mark.live_codex,
    pytest.mark.skipif(not LIVE, reason="live codex gate — set RUN_LIVE_CODEX=1"),
    pytest.mark.skipif(not Path(CODEX_BIN).exists(), reason="codex binary not found"),
]

# The exact nested shape the CodexHookAdapter must emit (D2/D9).
VALID_HOOK_TOML = (
    "[[hooks.PostToolUse]]\n"
    'matcher = "apply_patch"\n\n'
    "[[hooks.PostToolUse.hooks]]\n"
    'type = "command"\n'
    'command = "true"\n'
    "timeout = 60\n"
)

# Same shape but command as an array — MUST be rejected (command is a string).
ARRAY_COMMAND_TOML = (
    "[[hooks.PostToolUse]]\n"
    'matcher = "apply_patch"\n\n'
    "[[hooks.PostToolUse.hooks]]\n"
    'type = "command"\n'
    'command = ["sh", "-c", "true"]\n'
)


def _exec(codex_home: Path, work: Path, config: str, *extra: str, timeout: int = 20):
    (codex_home).mkdir(parents=True, exist_ok=True)
    (codex_home / "config.toml").write_text(config)
    work.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            [CODEX_BIN, "exec", "--skip-git-repo-check", "-C", str(work),
             "-s", "read-only", *extra, "hi"],
            capture_output=True, text=True,
            env={**os.environ, "CODEX_HOME": str(codex_home)},
            stdin=subprocess.DEVNULL, timeout=timeout)
        return proc.stdout + proc.stderr
    except subprocess.TimeoutExpired as e:
        # A valid config connects to the network and retries; a timeout here
        # still means the config parsed (we never saw a config error).
        return (e.stdout or b"").decode(errors="replace") + \
               (e.stderr or b"").decode(errors="replace")


def test_codex_accepts_hub_hook_shape(tmp_path):
    """Valid nested hook TOML loads with no config error under --strict-config."""
    out = _exec(tmp_path / "home", tmp_path / "work", VALID_HOOK_TOML,
                "--strict-config")
    assert "Error loading config.toml" not in out, (
        "codex rejected the hub hook shape:\n" + out[-1500:])
    assert "unknown field" not in out.lower(), out[-1500:]


def test_codex_requires_string_command(tmp_path):
    """command as a TOML array is rejected at config load (pins writer to a string)."""
    out = _exec(tmp_path / "home", tmp_path / "work", ARRAY_COMMAND_TOML)
    assert "Error loading config.toml" in out, (
        "expected codex to reject an array command:\n" + out[-1500:])
    assert "expected a string" in out, out[-1500:]


@pytest.mark.skipif(not (REAL_CODEX / "auth.json").exists(),
                    reason="no codex auth on this machine (firing test)")
def test_codex_posttooluse_hook_fires_and_receives_payload(tmp_path):
    """A PostToolUse command hook fires on apply_patch and gets the expected stdin.

    Uses --dangerously-bypass-hook-trust to bypass per-hook trust for this one
    run (production hub NEVER does this and NEVER writes [hooks.state] — D9).
    """
    codex_home = tmp_path / "home"
    work = tmp_path / "work"
    codex_home.mkdir(parents=True)
    work.mkdir(parents=True)
    payload = tmp_path / "payload.json"
    marker = tmp_path / "marker"
    (codex_home / "config.toml").write_text(
        "[[hooks.PostToolUse]]\n"
        'matcher = ""\n\n'
        "[[hooks.PostToolUse.hooks]]\n"
        'type = "command"\n'
        f"command = \"sh -c 'cat > {payload}; echo FIRED > {marker}'\"\n"
        "timeout = 30\n")
    (work / "edit_me.txt").write_text("startval\n")

    shutil.copy2(REAL_CODEX / "auth.json", codex_home / "auth.json")
    try:
        subprocess.run(
            [CODEX_BIN, "exec", "--skip-git-repo-check",
             "--dangerously-bypass-hook-trust",
             "-C", str(work), "-s", "workspace-write",
             "Use apply_patch to edit edit_me.txt: change 'startval' to "
             "'newval'. Do nothing else."],
            capture_output=True, text=True,
            env={**os.environ, "CODEX_HOME": str(codex_home)},
            stdin=subprocess.DEVNULL, timeout=300)
    finally:
        (codex_home / "auth.json").unlink(missing_ok=True)

    assert marker.exists(), "PostToolUse hook did not fire"
    data = json.loads(payload.read_text())
    assert data["hook_event_name"] == "PostToolUse"
    assert data["tool_name"] == "apply_patch"
    # tool_input is NOT opaque: the apply_patch envelope is a parseable string.
    assert "*** Begin Patch" in data["tool_input"]["command"]
    assert "*** Update File: edit_me.txt" in data["tool_input"]["command"]
