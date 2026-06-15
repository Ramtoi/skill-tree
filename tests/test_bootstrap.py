"""Tests for `hub bootstrap` orchestration (task 3.6)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest
import yaml


def test_bootstrap_state_needs_bootstrap_when_block_absent(tmp_data_home):
    import hub

    state = hub.bootstrap_state({"skills": {}})
    assert state["needs_bootstrap"] is True
    assert state["completed_at"] is None


def test_bootstrap_state_complete_when_completed_at_present(tmp_data_home):
    import hub

    state = hub.bootstrap_state(
        {"bootstrap": {"completed_at": "2026-05-21T14:00:00Z", "version": 1}}
    )
    assert state["needs_bootstrap"] is False
    assert state["completed_at"] == "2026-05-21T14:00:00Z"


def test_bootstrap_idempotent_second_run_no_op(tmp_data_home, capsys):
    """After bootstrap completes, second run without --force is a no-op."""
    import hub

    args = argparse.Namespace(
        force=False, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    hub.cmd_bootstrap(args)
    capsys.readouterr()  # discard first-run output

    # Capture the registry file mtime
    reg_file = tmp_data_home / "registry.yaml"
    mtime_before = reg_file.stat().st_mtime

    # Force re-read of registry on second call by ensuring no caching surprises
    hub.cmd_bootstrap(args)
    out = capsys.readouterr().out
    assert "Already bootstrapped" in out
    # Registry file must be unchanged (mtime tolerant since FS may have low resolution)
    assert reg_file.stat().st_mtime == mtime_before


def test_bootstrap_force_reruns(tmp_data_home, capsys):
    import hub

    args = argparse.Namespace(
        force=False, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    hub.cmd_bootstrap(args)
    capsys.readouterr()
    first_completed = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())[
        "bootstrap"
    ]["completed_at"]

    import time
    time.sleep(1.05)  # ensure ISO second-resolution timestamp advances

    args_force = argparse.Namespace(
        force=True, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    hub.cmd_bootstrap(args_force)
    capsys.readouterr()
    second_completed = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())[
        "bootstrap"
    ]["completed_at"]
    assert second_completed != first_completed


def test_bootstrap_dry_run_json_shape(tmp_data_home, capsys):
    """--dry-run --json emits stable keys without touching the registry."""
    import hub

    args = argparse.Namespace(
        force=False, yes=True, dry_run=True, json=True, skip_migrate=True
    )
    hub.cmd_bootstrap(args)
    out = capsys.readouterr().out
    payload = json.loads(out)
    for key in (
        "legacy_detected",
        "candidates",
        "conflicts",
        "blocked",
        "already_managed",
        "silent_skip",
    ):
        assert key in payload, f"missing key: {key}"

    # Registry must not have been created/written
    assert not (tmp_data_home / "registry.yaml").exists()


def test_bootstrap_precondition_python_version(monkeypatch, tmp_data_home, capsys):
    """Refusal on too-old Python.

    Tests by monkeypatching `MIN_PYTHON` since the actual interpreter version
    is fixed at runtime; the precondition logic still gets exercised.
    """
    import hub

    monkeypatch.setattr(hub, "MIN_PYTHON", (99, 0))  # unreachable
    args = argparse.Namespace(
        force=False, yes=True, dry_run=False, json=False, skip_migrate=True
    )
    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_bootstrap(args)
    assert excinfo.value.code == 1
    err = capsys.readouterr().out
    assert "Python" in err and "required" in err
