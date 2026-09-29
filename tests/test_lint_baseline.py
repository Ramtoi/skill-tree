"""Guard tests for the Python lint baseline (ruff + mypy in `pyproject.toml`).

RED before the baseline lands (no `pyproject.toml`, no CI job, markers still
registered via `pytest_configure` in `conftest.py`); GREEN after.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

import pytest
import tomlkit
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = REPO_ROOT / "pyproject.toml"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
ALLOW_MISSING_LINTERS_ENV = "SKILL_HUB_ALLOW_MISSING_LINTERS"

# Captured at collection time, before the autouse `_fake_home` fixture
# (tests/conftest.py) monkeypatches $HOME for each test. A `--user`-installed
# `mypy` is a Python entry-point script that needs the REAL $HOME to resolve
# its own package via user site-packages — unlike `ruff`, a self-contained
# binary. Without this, this test spuriously fails under a fake $HOME even
# though `mypy` (run directly, outside pytest) is perfectly clean.
_REAL_HOME = os.environ.get("HOME")

MYPY_MODULES = {
    "skill_hub/infrastructure/filesystem/cloud_targets.py",
    "skill_hub/infrastructure/harnesses/harness_probe.py",
    "skill_hub/application/sync/lsp_report_sync.py",
    "skill_hub/infrastructure/mcp/mcp_adapters.py",
    "skill_hub/infrastructure/mcp/mcp_delivery.py",
    "skill_hub/infrastructure/mcp/mcp_probe.py",
    "skill_hub/infrastructure/mcp/mcp_reconcile.py",
    "skill_hub/domain/mcp/mcp_spec.py",
    "skill_hub/domain/permissions/permissions.py",
    "skill_hub/infrastructure/remotes/remotes.py",
    "skill_hub/domain/diagnostics/risks.py",
    "skill_hub/entrypoints/mcp/skill_hub_mcp_server.py",
    "skill_hub/infrastructure/harnesses/subagent_codex.py",
    "skill_hub/domain/diagnostics/tool_catalog.py",
}


def _load_pyproject():
    if not PYPROJECT.exists():
        pytest.fail(f"{PYPROJECT} does not exist")
    return tomlkit.parse(PYPROJECT.read_text(encoding="utf-8"))


def test_pyproject_declares_ruff_baseline():
    doc = _load_pyproject()
    ruff = doc["tool"]["ruff"]
    assert ruff["line-length"] == 120
    assert ruff["target-version"] == "py39"
    lint = ruff["lint"]
    assert list(lint["select"]) == ["E", "F", "I", "W"]
    assert set(lint["ignore"]) == {"E402", "E741", "F841", "F405"}


def test_pyproject_declares_mypy_scope():
    doc = _load_pyproject()
    mypy = doc["tool"]["mypy"]
    assert set(mypy["files"]) >= MYPY_MODULES
    assert mypy["follow_imports"] == "silent"


def test_pytest_markers_moved_out_of_conftest():
    doc = _load_pyproject()
    markers = doc["tool"]["pytest"]["ini_options"]["markers"]
    marker_names = {str(m).split(":", 1)[0].strip() for m in markers}
    assert marker_names == {"live_codex", "slow", "real_harness_paths", "real_execution_supervisor"}
    addopts = doc["tool"]["pytest"]["ini_options"]["addopts"]
    assert "--strict-markers" in addopts

    conftest_text = (REPO_ROOT / "tests" / "conftest.py").read_text(encoding="utf-8")
    assert "def pytest_configure" not in conftest_text


def _find_python_job(doc):
    jobs = doc["jobs"]
    for job in jobs.values():
        if job.get("name") == "Python":
            return job
    pytest.fail("no job named 'Python' in ci.yml")


def test_ci_runs_python_lint():
    """Parses the workflow instead of grepping text: a step surviving a move
    to a job with no trigger, or gated `if: false`, must turn this red (the
    old grep-based version could not see either)."""
    doc = yaml.safe_load(CI_WORKFLOW.read_text(encoding="utf-8"))
    job = _find_python_job(doc)

    # The immutable plan decides applicability and verified full-result reuse.
    job_if = job.get("if", "")
    assert "needs.plan.outputs.python == 'true'" in job_if
    assert "needs.plan.outputs.reuse != 'true'" in job_if
    assert job["needs"] == "plan"

    steps = job["steps"]
    install_step = next(s for s in steps if s.get("name") == "Install dependencies")
    assert "ruff==0.16.4" in install_step["run"]
    assert "mypy==1.19.1" in install_step["run"]

    ruff_step = next(s for s in steps if s.get("run", "").strip() == "ruff check .")
    mypy_step = next(s for s in steps if s.get("run", "").strip() == "mypy")

    for step in (ruff_step, mypy_step):
        step_if = step.get("if", "")
        # Default step execution requires all preceding steps to succeed.
        # Keep installation ahead of lint and reject disabled/ignored checks.
        assert steps.index(install_step) < steps.index(step)
        assert step_if in ("", "success()", "${{ success() }}")
        assert not step.get("continue-on-error", False)
    assert not install_step.get("continue-on-error", False)
    assert install_step.get("if", "") in ("", "success()", "${{ success() }}")


def _linter_argv(name: str) -> Optional[List[str]]:
    """The command that runs a linter: the PATH binary, else the module
    through this interpreter, else None when it is not installed at all."""
    exe = shutil.which(name)
    if exe:
        return [exe]
    if importlib.util.find_spec(name) is not None:
        return [sys.executable, "-m", name]
    return None


def test_ruff_and_mypy_are_clean(tmp_path):
    ruff_exe = _linter_argv("ruff")
    mypy_exe = _linter_argv("mypy")
    allow_missing = os.environ.get(ALLOW_MISSING_LINTERS_ENV) == "1"
    if not ruff_exe or not mypy_exe:
        missing = [n for n, e in (("ruff", ruff_exe), ("mypy", mypy_exe)) if not e]
        if allow_missing:
            pytest.skip(
                f"{', '.join(missing)} not installed (no PATH binary and no importable module) — "
                f"skip allowed via {ALLOW_MISSING_LINTERS_ENV}=1"
            )
        pytest.fail(
            f"{', '.join(missing)} not installed (no PATH binary and no importable module). Install them, or opt "
            f"out explicitly with {ALLOW_MISSING_LINTERS_ENV}=1 (CI always installs both)."
        )

    env = {**os.environ, "HOME": _REAL_HOME} if _REAL_HOME else None

    ruff_result = subprocess.run(
        # `--config <path>` pins the exact baseline file and, per ruff's own
        # docs, cannot be combined with `--isolated` (ruff rejects that
        # combination outright). Passing an explicit `--config` already
        # removes the seam: ruff resolves that one file instead of walking
        # up from cwd or falling back to a user-level `~/.config/ruff/`.
        [*ruff_exe, "check", "--config", str(PYPROJECT), "--no-cache", "."],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env=env,
    )
    assert ruff_result.returncode == 0, ruff_result.stdout + ruff_result.stderr

    mypy_cache_dir = tmp_path / "mypy_cache"
    mypy_result = subprocess.run(
        [*mypy_exe, "--config-file", str(PYPROJECT)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env={**env, "MYPY_CACHE_DIR": str(mypy_cache_dir)} if env else {"MYPY_CACHE_DIR": str(mypy_cache_dir)},
    )
    assert mypy_result.returncode == 0, mypy_result.stdout + mypy_result.stderr
