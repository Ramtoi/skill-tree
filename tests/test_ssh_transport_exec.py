"""Wave 4a W3 — the SSH transport carries the executable bit for `scripts/`.

Covers (plans/1.md §"3. Box side: fold the chmod into the existing atomic
write"):

  * `SshTransport.atomic_write(..., executable=True)` chmods the remote temp
    file to `0o755` BEFORE the rename — no window where the destination exists
    non-executable — and the default (`executable=False`) path's remote
    command is byte-identical to before this flag existed.
  * `_find_relpaths` is the one shared `find` + F3 `safe_relpath` +
    hub-internal-file-filter traversal behind both `list_files` (unchanged
    behaviour) and the new `list_executable_files` (`-perm -u+x`).
  * `read_remote_skill_dir` populates `SkillTree.executable` with the
    `scripts/`-relative paths only.

**T3.x safety rule** (binding on every test in this module): `_bash_runner`
executes the real remote shell string LOCALLY, and `atomic_write`'s command —
unlike `list_files`'s — has no `cd` confinement, so a non-tmp-path in a
bash-backed test is a real local `mv -f` on the developer's machine. Every path
handed to a runner in this module — bash-backed or merely recording — is built
from the test's own `tmp_path` fixture and passed through `_tmp_rooted` first,
so a future edit that hard-codes a path fails loudly instead of writing outside
the sandbox. No test in this module dials a real host, spawns `ssh`, or touches
`~/.skill-hub`, `~/.claude`, or `~/.codex`.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path

import pytest

from skill_hub.infrastructure.connectors.transport.ssh import RunResult, SshCommandError, SshTransport

# ─────────────────────────────────────────────────────────────────────────────
# Safety helper + runners (the latter two copied from tests/test_ssh_transport_batch.py)
# ─────────────────────────────────────────────────────────────────────────────


def _tmp_rooted(tmp_path: Path, p) -> str:
    """Assert `p` is confined to this test's own `tmp_path`; return it as `str`.

    The binding T3.x safety rule for this module: a path that escapes
    `tmp_path` handed to a bash-backed runner would be a REAL local write.
    Every test in this file calls this on every path before handing it to a
    runner, whether or not that runner actually executes anything.
    """
    p = str(p)
    root = str(tmp_path)
    assert p == root or p.startswith(root + os.sep) or p.startswith(root + "/"), (
        f"refusing to hand a non-tmp_path-rooted path to a runner: {p!r} "
        f"(expected it under {root!r})"
    )
    return p


def _recording_runner(calls):
    """Runner that records every argv and returns a canned OK result. Executes nothing."""

    def runner(argv, *, input=None):
        calls.append(list(argv))
        return RunResult(returncode=0, stdout="ok", stderr="")

    return runner


def _bash_runner(argv, *, input=None):
    """Execute the ssh remote command locally via bash (paths are already real).

    Non-ssh argv (e.g. ssh-keyscan) is a no-op OK — these tests use no host-key
    pin so verification never runs.
    """
    if not argv or argv[0] != "ssh":
        return RunResult(returncode=0, stdout="", stderr="")
    remote_cmd = argv[-1]
    proc = subprocess.run(["bash", "-c", remote_cmd], input=input, capture_output=True)
    return RunResult(
        returncode=proc.returncode,
        stdout=proc.stdout.decode("utf-8", "replace"),
        stderr=proc.stderr.decode("utf-8", "replace"),
    )


def _write(path: Path, data: bytes, *, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if mode is not None:
        path.chmod(mode)


# ─────────────────────────────────────────────────────────────────────────────
# T3.1 / T3.2 — atomic_write(executable=...)
# ─────────────────────────────────────────────────────────────────────────────


def test_atomic_write_executable_chmods_the_temp_before_rename(tmp_data_home, tmp_path):
    calls: list[list[str]] = []
    dest = _tmp_rooted(
        tmp_path, tmp_path / "skill-hub" / "orchestrate-advanced" / "scripts" / "scope-guard.sh"
    )
    t = SshTransport("user@host", runner=_recording_runner(calls))

    t.atomic_write(dest, b"#!/bin/sh\necho hi\n", executable=True)

    assert calls, "expected one recorded ssh invocation"
    remote_cmd = calls[-1][-1]
    chmod_idx = remote_cmd.find("chmod 755 ")
    mv_idx = remote_cmd.find(" mv -f ")
    assert chmod_idx != -1, remote_cmd
    assert mv_idx != -1, remote_cmd
    # No window where the destination could exist non-executable: chmod runs
    # BEFORE the rename, in the same remote shell (no extra round trip).
    assert chmod_idx < mv_idx, remote_cmd
    assert "cat > " in remote_cmd
    assert dest in remote_cmd
    # Only one ssh call — the chmod is folded into the existing write, not a
    # second round trip.
    ssh_calls = [c for c in calls if c and c[0] == "ssh"]
    assert len(ssh_calls) == 1


def test_atomic_write_default_command_is_unchanged(tmp_data_home, tmp_path):
    """The `executable=False` (default) path's remote command is byte-identical
    to the command `atomic_write` issued before this flag existed."""
    calls: list[list[str]] = []
    dest = _tmp_rooted(tmp_path, tmp_path / "skill-hub" / "orchestrate-advanced" / "config.yaml")
    t = SshTransport("user@host", runner=_recording_runner(calls))

    t.atomic_write(dest, b"content\n")  # executable omitted -> default False

    remote_cmd = calls[-1][-1]
    assert "chmod" not in remote_cmd

    # Rebuild the expected command around the (unpredictable pid+counter) temp
    # suffix the call actually used, and assert full structural equality —
    # this is the shape `atomic_write` produced before `executable` existed:
    # "mkdir -p <parent> && cat > <tmp> && mv -f <tmp> <dest>".
    marker = "cat > "
    start = remote_cmd.index(marker) + len(marker)
    end = remote_cmd.index(" && mv -f ", start)
    tmp = remote_cmd[start:end]
    parent = shlex.quote(str(Path(dest).parent))
    q = shlex.quote(dest)
    expected = f"mkdir -p {parent} && cat > {tmp} && mv -f {tmp} {q}"
    assert remote_cmd == expected


def test_atomic_write_executable_false_explicit_matches_default(tmp_data_home, tmp_path):
    """Passing `executable=False` explicitly is indistinguishable from omitting it."""
    calls_default: list[list[str]] = []
    calls_explicit: list[list[str]] = []
    dest = _tmp_rooted(tmp_path, tmp_path / "doc.txt")

    t1 = SshTransport("user@host", runner=_recording_runner(calls_default))
    t1.atomic_write(dest, b"x")
    t2 = SshTransport("user@host", runner=_recording_runner(calls_explicit))
    t2.atomic_write(dest, b"x", executable=False)

    cmd1 = calls_default[-1][-1]
    cmd2 = calls_explicit[-1][-1]
    # Both lack a chmod; both have the identical mkdir/cat/mv shape (the temp
    # suffix differs only by the per-process call counter, not by structure).
    assert "chmod" not in cmd1 and "chmod" not in cmd2
    assert cmd1.split(" && mv -f ")[0].startswith("mkdir -p ")
    assert cmd2.split(" && mv -f ")[0].startswith("mkdir -p ")


# ─────────────────────────────────────────────────────────────────────────────
# T3.3 — list_executable_files: real-tree filtering + F3 validation
# ─────────────────────────────────────────────────────────────────────────────


def test_list_executable_files_filters_and_validates(tmp_data_home, tmp_path):
    base = _tmp_rooted(tmp_path, tmp_path / "skill-hub" / "orchestrate-advanced")
    root = Path(base)
    _write(root / "SKILL.md", b"---\nname: orchestrate-advanced\n---\nbody\n", mode=0o644)
    _write(root / "scripts" / "exec.sh", b"#!/bin/sh\necho hi\n", mode=0o755)
    _write(root / "scripts" / "noexec.sh", b"#!/bin/sh\necho hi\n", mode=0o644)
    # A root-level executable — list_executable_files itself does NOT confine
    # to scripts/ (that confinement is read_remote_skill_dir's job, T3.4).
    _write(root / "bin" / "tool", b"#!/bin/sh\necho tool\n", mode=0o755)
    # A hub-internal backup sibling, even if executable, must never surface —
    # same filter list_files already applies.
    _write(root / "scripts" / "exec.sh.hub-bak", b"#!/bin/sh\necho hi\n", mode=0o755)

    t = SshTransport("user@host", runner=_bash_runner)
    found = t.list_executable_files(base)

    assert found == {"scripts/exec.sh", "bin/tool"}


def test_list_executable_files_rejects_escaping_remote_relpath(tmp_data_home, tmp_path):
    """A compromised box returning `../../x` from find is refused at the transport."""
    fake_remote_dir = _tmp_rooted(tmp_path, tmp_path / "box" / "skill-hub" / "evil")

    def evil_runner(argv, *, input=None):
        if argv and argv[0] == "ssh" and "find" in argv[-1]:
            return RunResult(returncode=0, stdout="./scripts/x.sh\n../../ESCAPED\n")
        return RunResult(returncode=0, stdout="")

    t = SshTransport(host="fake@box", host_key_sha256=None, runner=evil_runner)
    with pytest.raises(SshCommandError):
        t.list_executable_files(fake_remote_dir)


def test_list_files_behaviour_is_unchanged_after_the_find_relpaths_extraction(
    tmp_data_home, tmp_path
):
    """`list_files` (unchanged per the plan) still lists every regular file,
    still excludes hub-internal siblings, regardless of any file's mode."""
    base = _tmp_rooted(tmp_path, tmp_path / "skill-hub" / "orchestrate-advanced")
    root = Path(base)
    _write(root / "SKILL.md", b"body\n", mode=0o644)
    _write(root / "scripts" / "exec.sh", b"#!/bin/sh\n", mode=0o755)
    _write(root / "scripts" / "exec.sh.hub-bak", b"#!/bin/sh\n", mode=0o755)
    _write(root / "scripts" / "x.sh.hub-tmp.123.0", b"partial\n", mode=0o644)

    t = SshTransport("user@host", runner=_bash_runner)
    found = set(t.list_files(base))

    assert found == {"SKILL.md", "scripts/exec.sh"}


# ─────────────────────────────────────────────────────────────────────────────
# T3.4 — read_remote_skill_dir reports scripts/-confined executables
# ─────────────────────────────────────────────────────────────────────────────


def test_read_remote_skill_dir_reports_script_executables(tmp_data_home, tmp_path):
    base = _tmp_rooted(tmp_path, tmp_path / "skill-hub" / "orchestrate-advanced")
    root = Path(base)
    skill_md = b"---\nname: orchestrate-advanced\n---\nbody\n"
    script_bytes = b"#!/bin/sh\necho scope-guard\n"
    _write(root / "SKILL.md", skill_md, mode=0o644)
    _write(root / "scripts" / "scope-guard.sh", script_bytes, mode=0o755)
    _write(root / "scripts" / "helper.sh", b"#!/bin/sh\necho helper\n", mode=0o644)
    # Executable OUTSIDE scripts/ — must show up in .files but NOT in .executable.
    _write(root / "bin" / "tool", b"#!/bin/sh\necho tool\n", mode=0o755)
    _write(root / "agents" / "orch.md", b"# agent\n", mode=0o644)

    t = SshTransport("user@host", runner=_bash_runner)
    tree = t.read_remote_skill_dir(base)

    assert tree.name == "orchestrate-advanced"
    assert set(tree.files) == {
        "SKILL.md",
        "scripts/scope-guard.sh",
        "scripts/helper.sh",
        "bin/tool",
        "agents/orch.md",
    }
    assert tree.files["SKILL.md"] == skill_md
    assert tree.files["scripts/scope-guard.sh"] == script_bytes
    # Confined to scripts/: bin/tool is 0o755 on disk but not in .executable.
    assert tree.executable == {"scripts/scope-guard.sh"}
