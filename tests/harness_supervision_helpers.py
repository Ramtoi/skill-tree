"""Explicit fixture execution for testing reports, never OS enforcement proof."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from skill_hub.infrastructure.harnesses import harness_execution_supervisor as supervisor


class FixtureProcess:
    memory_mode = "fixture_unbounded"

    def __init__(self, process):
        self.process = process

    def close(self):
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.process.wait(timeout=2)
        return True


def fixture_launch(argv, *, cwd, env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                   memory_bytes=supervisor.DEFAULT_MEMORY_BYTES, **kwargs):
    if sys.platform != "darwin":
        return supervisor.launch(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr,
                                 memory_bytes=memory_bytes, lock_path=Path(cwd) / "fixture-execution.lock")
    # macOS cannot enforce the required memory ceiling. These unit tests only
    # exercise reporting/cleanup with harmless synthetic Python programs.
    return FixtureProcess(subprocess.Popen(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr,
                                          start_new_session=True, bufsize=0))


@pytest.fixture(autouse=True)
def fixture_supervision(request, monkeypatch):
    if request.node.get_closest_marker("real_execution_supervisor"):
        return
    from skill_hub.infrastructure.harnesses import harness_validation

    monkeypatch.setattr(harness_validation, "_launch", fixture_launch)
