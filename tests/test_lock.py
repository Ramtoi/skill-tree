"""Tests for the data_home_lock() context manager (task 7.5)."""

from __future__ import annotations

import os
import subprocess
import sys
import time
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
