"""M3 (ui-responsiveness) — hardened + batched SSH transport.

Covers the two independent transport fixes that killed the ~30s `remote diff`
freeze:

  1. Every ssh invocation is time-BOUNDED (ConnectTimeout + keepalives) and
     MULTIPLEXED (ControlMaster/ControlPath/ControlPersist) — asserted on the
     argv so a regression that drops them fails here, and a bounded real dial to
     a blackhole IP proves the fail-fast behavior.
  2. Plan-phase hashing is BATCHED (`dir_sha256_batch` / `sha256_batch`) into one
     round-trip whose result is byte-identical to the per-artifact primitives —
     proven against a real local tree driven through a bash-backed fake runner.

The fake runner executes the connector's POSIX remote-shell commands locally via
`bash -c`, so the batch snippet's remote `python3` actually runs — the parity
tests therefore compare the batched output against the live per-artifact code,
not a stub.
"""

from __future__ import annotations

import subprocess
import time

import pytest

from connectors.transport.ssh import (
    RunResult,
    SshCommandError,
    SshTransport,
    _parse_name_sha_lines,
)


# ─────────────────────────────────────────────────────────────────────────────
# Runners
# ─────────────────────────────────────────────────────────────────────────────


def _recording_runner(calls):
    """Runner that records every argv and returns a canned OK result."""

    def runner(argv, *, input=None):
        calls.append(list(argv))
        # `probe` expects stdout == "ok"; harmless for other commands.
        return RunResult(returncode=0, stdout="ok", stderr="")

    return runner


def _bash_runner(argv, *, input=None):
    """Execute the ssh remote command locally via bash (paths are already real).

    Non-ssh argv (e.g. ssh-keyscan) is a no-op OK — the tests use no host-key pin
    so verification never runs.
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


# ─────────────────────────────────────────────────────────────────────────────
# 1. Hardened ssh options are on every invocation
# ─────────────────────────────────────────────────────────────────────────────


def test_ssh_argv_has_timeout_and_multiplexing_options(tmp_data_home):
    calls: list[list[str]] = []
    t = SshTransport("user@host", runner=_recording_runner(calls))
    # Any command that issues an ssh connection.
    t.probe("/home/user")
    argv = calls[-1]
    assert argv[0] == "ssh"

    # Time-bound: fail fast instead of hanging on an unreachable box.
    assert "ConnectTimeout=5" in argv
    assert "ServerAliveInterval=5" in argv
    assert "ServerAliveCountMax=2" in argv

    # Connection multiplexing: share one handshake across a plan's many calls.
    assert "ControlMaster=auto" in argv
    assert "ControlPersist=60" in argv
    ctl = [a for a in argv if a.startswith("ControlPath=")]
    assert ctl, "expected a ControlPath option"
    # Uses the short `%C` token so the socket path stays under sun_path (~104).
    assert ctl[0].endswith("/%C")

    # The original host-key pinning options are still present.
    assert "StrictHostKeyChecking=yes" in argv
    assert "BatchMode=yes" in argv


def test_control_socket_dir_is_created_mode_0700(tmp_data_home):
    import hub

    calls: list[list[str]] = []
    t = SshTransport("user@host", runner=_recording_runner(calls))
    t.probe("/home/user")
    sock_dir = hub.data_home() / "state" / "ssh"
    assert sock_dir.is_dir()
    assert (sock_dir.stat().st_mode & 0o777) == 0o700


# ─────────────────────────────────────────────────────────────────────────────
# 2. Batch-hash line parser
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_name_sha_lines_basic_and_dash():
    text = "alpha\tabc123\nbeta\t-\n"
    assert _parse_name_sha_lines(text, ["alpha", "beta"]) == {
        "alpha": "abc123",
        "beta": None,
    }


def test_parse_name_sha_lines_empty_output():
    assert _parse_name_sha_lines("", ["x", "y"]) == {}


def test_parse_name_sha_lines_odd_names():
    # A name containing a tab: split on the LAST tab so the key survives intact.
    assert _parse_name_sha_lines("na\tme\tdeadbeef\n", ["na\tme"]) == {"na\tme": "deadbeef"}
    # A unicode / spaced name round-trips.
    assert _parse_name_sha_lines("skïll one\tf00\n", ["skïll one"]) == {
        "skïll one": "f00"
    }


def test_parse_name_sha_lines_skips_junk_and_unrequested():
    text = "noseparatorline\n\nghost\tsha\nalpha\tsha1\n"
    # blank + tab-less lines skipped; a key not in `requested` is excluded.
    assert _parse_name_sha_lines(text, ["alpha", "noseparatorline"]) == {"alpha": "sha1"}


# ─────────────────────────────────────────────────────────────────────────────
# 3. Batch == per-artifact parity (real tree via bash-backed runner)
# ─────────────────────────────────────────────────────────────────────────────


def _write(path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_dir_sha256_batch_parity(tmp_data_home, tmp_path):
    hub_dir = tmp_path / "skill-hub"
    # A single-file skill, a nested-file skill, an empty skill dir, and an
    # absent one — the four cases dir_sha256 distinguishes.
    _write(hub_dir / "alpha" / "SKILL.md", b"---\nname: alpha\n---\nbody\n")
    _write(hub_dir / "beta" / "SKILL.md", b"---\nname: beta\n---\nbody\n")
    _write(hub_dir / "beta" / "sub" / "extra.md", b"nested content\n")
    (hub_dir / "gamma").mkdir(parents=True)  # empty dir
    names = ["alpha", "beta", "gamma", "delta-absent"]

    t = SshTransport("user@host", runner=_bash_runner)
    batched = t.dir_sha256_batch(str(hub_dir), names)

    # Every requested name is present in the batch result.
    assert set(batched) == set(names)
    # …and each batched sha equals the per-artifact primitive byte-for-byte.
    for name in names:
        per = t.dir_sha256(str(hub_dir / name))
        assert batched[name] == per, name

    # Sanity on the specific classifications the connector relies on.
    assert batched["delta-absent"] is None            # absent → None
    assert batched["gamma"] is not None               # empty dir → empty-hash
    assert batched["alpha"] != batched["beta"]         # distinct content differs


def test_sha256_batch_parity(tmp_data_home, tmp_path):
    d1 = tmp_path / "SOUL.md"
    d2 = tmp_path / "memories" / "MEMORY.md"
    _write(d1, b"soul bytes\n")
    _write(d2, b"memory bytes\n")
    d3 = tmp_path / "memories" / "MISSING.md"  # absent
    paths = [str(d1), str(d2), str(d3)]

    t = SshTransport("user@host", runner=_bash_runner)
    batched = t.sha256_batch(paths)

    assert set(batched) == set(paths)
    for p in paths:
        assert batched[p] == t.sha256(p), p
    assert batched[str(d3)] is None


def test_batch_falls_back_when_remote_python_missing(tmp_data_home, tmp_path):
    """A non-zero batch call raises so the connector can fall back per-artifact."""

    def broken(argv, *, input=None):
        if argv and argv[0] == "ssh":
            return RunResult(returncode=127, stderr="python3: not found")
        return RunResult(returncode=0)

    t = SshTransport("user@host", runner=broken)
    with pytest.raises(SshCommandError):
        t.dir_sha256_batch(str(tmp_path), ["alpha"])


# ─────────────────────────────────────────────────────────────────────────────
# 4. Unreachable box fails FAST (bounded), not on the OS TCP timeout
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.slow
def test_unreachable_host_fails_within_bound(tmp_data_home):
    """A real dial to a blackhole IP (TEST-NET-3) fails in ≤ ~8s via ConnectTimeout=5.

    Marked slow because it opens a real socket. Skips cleanly if `ssh` is absent.
    Before this change the same dial waited the OS TCP timeout (30–75s).
    """
    import shutil

    if shutil.which("ssh") is None:
        pytest.skip("ssh binary not available")

    # 203.0.113.0/24 is RFC 5737 TEST-NET-3 — guaranteed unroutable.
    t = SshTransport("root@203.0.113.1", runner=None)  # real subprocess runner
    start = time.monotonic()
    with pytest.raises(SshCommandError):
        # probe() raises on ssh exit 255 (connection failure).
        t.probe("/tmp")
    elapsed = time.monotonic() - start
    assert elapsed <= 8.0, f"unreachable dial took {elapsed:.1f}s (expected ≤ 8s)"
