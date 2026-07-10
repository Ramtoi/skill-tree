"""Tests for data_home() / code_home() resolvers and env-var precedence (task 1.7)."""

from __future__ import annotations

from pathlib import Path

import pytest


def test_data_home_uses_skill_hub_home(tmp_path, monkeypatch):
    import hub

    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path))
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    hub._DATA_HOME_CACHE = None
    hub._DEPRECATION_WARNED = False

    resolved = hub.data_home()
    assert resolved == tmp_path.absolute()


def test_data_home_falls_back_to_skill_hub_dir_with_warning(
    tmp_path, monkeypatch, capsys
):
    import hub

    monkeypatch.delenv("SKILL_HUB_HOME", raising=False)
    monkeypatch.setenv("SKILL_HUB_DIR", str(tmp_path))
    hub._DATA_HOME_CACHE = None
    hub._DEPRECATION_WARNED = False

    resolved = hub.data_home()
    assert resolved == tmp_path.absolute()
    err = capsys.readouterr().err
    assert "SKILL_HUB_DIR is deprecated" in err


def test_data_home_home_wins_over_dir_with_ignored_warning(
    tmp_path, monkeypatch, capsys
):
    import hub

    home = tmp_path / "home"
    legacy = tmp_path / "legacy"
    home.mkdir()
    legacy.mkdir()
    monkeypatch.setenv("SKILL_HUB_HOME", str(home))
    monkeypatch.setenv("SKILL_HUB_DIR", str(legacy))
    hub._DATA_HOME_CACHE = None
    hub._DEPRECATION_WARNED = False

    resolved = hub.data_home()
    assert resolved == home.absolute()
    err = capsys.readouterr().err
    assert "ignored" in err and "SKILL_HUB_DIR" in err


def test_data_home_default_when_no_env(tmp_path, monkeypatch):
    import hub

    # Point HOME to a fake to avoid touching the real ~/.skill-hub.
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.delenv("SKILL_HUB_HOME", raising=False)
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    hub._DATA_HOME_CACHE = None
    # Reload the module-level DEFAULT_DATA_HOME since it captures Path.home()
    # at import. We patch it directly for the duration of the test.
    monkeypatch.setattr(hub, "DEFAULT_DATA_HOME", fake_home / ".skill-hub")
    monkeypatch.setattr(hub, "LEGACY_DATA_HOMES", [fake_home / "Dev" / ".skill-hub"])

    resolved = hub.data_home()
    assert resolved == (fake_home / ".skill-hub").absolute()


def test_data_home_first_run_creates_subdirs(tmp_data_home):
    import hub

    resolved = hub.data_home()
    assert (resolved / "skills").is_dir()
    assert (resolved / "mcp-servers").is_dir()
    assert (resolved / "_hub-backups").is_dir()


def test_data_home_caches_after_first_call(tmp_data_home, monkeypatch):
    import hub

    first = hub.data_home()
    # Even if env changes, cached value persists.
    monkeypatch.setenv("SKILL_HUB_HOME", "/tmp/some-other-place")
    second = hub.data_home()
    assert first == second


def test_code_home_env_override_wins(tmp_path, monkeypatch):
    import hub

    monkeypatch.setenv("SKILL_HUB_CODE", str(tmp_path))
    resolved = hub.code_home()
    assert resolved == tmp_path.absolute()


def test_code_home_walks_up_to_repo(monkeypatch):
    import hub

    monkeypatch.delenv("SKILL_HUB_CODE", raising=False)
    resolved = hub.code_home()
    # Must contain hub.py and a current repo marker. The old code-home skills/
    # directory is legacy and no longer exists in this repo layout.
    assert (resolved / "hub.py").exists()
    assert (resolved / "app").is_dir()


def test_collision_rejection_when_home_eq_code(tmp_path, monkeypatch):
    """When SKILL_HUB_HOME and SKILL_HUB_CODE resolve to the same path,
    data_home() must reject with sys.exit(1)."""
    import hub

    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path))
    monkeypatch.setenv("SKILL_HUB_CODE", str(tmp_path))
    hub._DATA_HOME_CACHE = None
    with pytest.raises(SystemExit) as excinfo:
        hub.data_home()
    assert excinfo.value.code == 1
