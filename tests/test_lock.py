"""Tests for the data_home_lock() context manager (task 7.5)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

HOLDER_SCRIPT = """
import sys, time
sys.path.insert(0, {repo!r})
import hub
import os
os.environ["SKILL_HUB_HOME"] = {target!r}
hub._DATA_HOME_CACHE = None
with hub.data_home_lock():
    print("LOCKED", flush=True)
    time.sleep(2)
"""

WAITER_SCRIPT = """
import sys, time
sys.path.insert(0, {repo!r})
import hub
import os
os.environ["SKILL_HUB_HOME"] = {target!r}
hub._DATA_HOME_CACHE = None
start = time.time()
with hub.data_home_lock():
    elapsed = time.time() - start
    print(f"WAITED:{{elapsed:.2f}}", flush=True)
"""


def test_lock_blocks_concurrent_acquisition(tmp_data_home):
    """Second process trying to take the lock must wait until the first releases it."""
    repo = str(Path(__file__).resolve().parent.parent)
    target = str(tmp_data_home)

    holder = subprocess.Popen(
        [sys.executable, "-c", HOLDER_SCRIPT.format(repo=repo, target=target)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        # Wait until the holder has acquired the lock
        line = holder.stdout.readline()
        assert line.strip() == "LOCKED", f"unexpected holder output: {line!r}"

        # Now start the waiter
        waiter = subprocess.Popen(
            [sys.executable, "-c", WAITER_SCRIPT.format(repo=repo, target=target)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            stdout, _ = waiter.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            waiter.kill()
            pytest.fail("waiter never acquired the lock")

        # The waiter should have waited at least ~1 second for the holder to finish.
        for line in stdout.splitlines():
            if line.startswith("WAITED:"):
                elapsed = float(line.split(":")[1])
                assert elapsed >= 1.0, f"waiter did not block (waited only {elapsed:.2f}s)"
                break
        else:
            pytest.fail(f"no WAITED line in waiter output:\n{stdout}")
    finally:
        holder.wait(timeout=5)


def test_lock_released_on_process_exit(tmp_data_home):
    """When the holder exits abruptly (os._exit) the lock is freed (fd close)."""
    repo = str(Path(__file__).resolve().parent.parent)
    target = str(tmp_data_home)

    # Holder takes the lock then hard-exits without releasing
    crash_script = f"""
import sys, os
sys.path.insert(0, {repo!r})
os.environ['SKILL_HUB_HOME'] = {target!r}
import hub
hub._DATA_HOME_CACHE = None
ctx = hub.data_home_lock()
ctx.__enter__()
print('LOCKED', flush=True)
os._exit(7)
"""
    holder = subprocess.Popen(
        [sys.executable, "-c", crash_script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    line = holder.stdout.readline()
    assert line.strip() == "LOCKED"
    holder.wait(timeout=5)
    assert holder.returncode == 7

    # Now a second process should acquire immediately (no leftover lock)
    quick_script = f"""
import sys, time, os
sys.path.insert(0, {repo!r})
os.environ['SKILL_HUB_HOME'] = {target!r}
import hub
hub._DATA_HOME_CACHE = None
start = time.time()
with hub.data_home_lock():
    elapsed = time.time() - start
    print(f'WAITED:{{elapsed:.2f}}', flush=True)
"""
    waiter = subprocess.run(
        [sys.executable, "-c", quick_script],
        capture_output=True,
        text=True,
        timeout=10,
    )
    for line in waiter.stdout.splitlines():
        if line.startswith("WAITED:"):
            elapsed = float(line.split(":")[1])
            assert elapsed < 1.0, f"waiter blocked unexpectedly: {elapsed:.2f}s"
            break
    else:
        pytest.fail(f"no WAITED line:\n{waiter.stdout}\n---\n{waiter.stderr}")


def test_script_mode_mutation_with_backup_tail_does_not_deadlock(
    tmp_data_home, tmp_path_factory
):
    """`python3 hub.py <mutation>` must not self-deadlock on its own lock.

    Regression: hub.py runs as `__main__`, so a sibling's `import hub`
    (backup.py's `_hub()`) used to load a SECOND module object with its own
    `_LOCK_DEPTH = 0`. The `@registry_mutation` decorator holds the data-home
    lock across the whole command — including `_auto_sync()` → `cmd_sync` →
    backup tail → `backup._data_home_lock()` — so that second module took a REAL
    second `flock()` on a new fd of the same file and blocked forever (observed
    in production: the process held fd3 and waited on fd6). The fix aliases the
    running module into `sys.modules["hub"]`, so the depth counter is shared.
    """
    import yaml

    from skill_hub.application.backup import backup

    repo = Path(__file__).resolve().parent.parent
    data_home = tmp_data_home

    # A minimal registry with one skill we can legally `set-meta --invocation`.
    src = data_home / "skills" / "t-skill"
    src.mkdir(parents=True, exist_ok=True)
    (src / "SKILL.md").write_text("---\nname: t-skill\ndescription: t\n---\nbody\n")
    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "t-skill": {
                "version": "1.0.0",
                "description": "",
                "source": str(src),
                "type": "claude-skill",
                "scope": "portable",
            }
        },
        "projects": {},
        "bundles": {},
    }

    # Backup must be enabled AND initialized for the sync tail to reach
    # `run_backup` (and therefore the second lock acquisition). No remote: the
    # auto-sync path passes push=False anyway, so nothing dials the network.
    outside = tmp_path_factory.mktemp("outside")
    dest = outside / "backup-repo"
    cfg = backup.load_backup_config(registry)
    cfg["dir"] = str(dest)
    cfg["enabled"] = True
    backup.save_backup_config(registry, cfg)
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    backup.git_init(dest)

    # An isolated HOME so the child's sync never touches the real harness dirs
    # (the autouse isolation fixtures are in-process only; env vars travel).
    fake_home = outside / "home"
    fake_home.mkdir()
    # …but a fake HOME also hides this interpreter's per-user site-packages, so
    # hand the child the dirs our own third-party imports came from.
    dep_dirs = [str(Path(yaml.__file__).resolve().parent.parent)]
    try:
        import tomlkit

        dep_dirs.append(str(Path(tomlkit.__file__).resolve().parent.parent))
    except ImportError:  # pragma: no cover - tomlkit is a hard dep in practice
        pass
    if os.environ.get("PYTHONPATH"):
        dep_dirs.append(os.environ["PYTHONPATH"])
    env = {
        **os.environ,
        "HOME": str(fake_home),
        "PYTHONPATH": os.pathsep.join(dict.fromkeys(dep_dirs)),
        "SKILL_HUB_HOME": str(data_home),
        "SKILL_HUB_CODE": str(repo),
    }

    try:
        proc = subprocess.run(
            [
                sys.executable,
                str(repo / "hub.py"),
                "set-meta",
                "t-skill",
                "--invocation",
                "user-only",
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=90,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(
            "script-mode mutation deadlocked on the data-home lock "
            "(regression: __main__/import-hub double module)"
        )

    assert proc.returncode == 0, (
        f"set-meta failed (rc={proc.returncode})\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    )

    # Vacuity guard: prove the sync tail actually ran through `run_backup` (so
    # the second lock acquisition really happened) instead of short-circuiting.
    log = subprocess.run(
        ["git", "-C", str(dest), "rev-list", "--count", "HEAD"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert log.returncode == 0 and int((log.stdout or "0").strip() or 0) >= 1, (
        "the backup repo has no commit — the sync tail never reached "
        f"run_backup, so this test is vacuous.\n--- sync stdout ---\n{proc.stdout}"
    )
