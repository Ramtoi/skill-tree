"""User timers only execute the managed receiver and preserve partial outcomes."""

import hashlib
from types import SimpleNamespace

import pytest

from skill_hub.domain.loadout.loadout_profiles import ProfileError, atomic_json
from skill_hub.infrastructure.loadout import loadout_timer as timer


@pytest.fixture
def managed(tmp_path):
    home = tmp_path / "home"
    root = home / ".local/share/skill-tree/receiver"
    launcher = root / "bin/hub"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("#!/bin/sh\nexit 0\n")
    launcher.chmod(0o755)
    atomic_json(
        root / "installation.json",
        {"command": str(launcher), "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest()},
    )
    return home, launcher


def test_install_runs_only_user_timer_and_reports_actual_status(managed, monkeypatch):
    home, launcher = managed
    calls = []
    monkeypatch.setattr(timer, "_run", lambda *args: calls.append(args) or SimpleNamespace(returncode=0))
    result = timer.install(home, launcher, 60)
    assert result == {
        "enabled": True,
        "active": True,
        "interval_seconds": 60,
        "configured": True,
        "partial": False,
        "error": None,
    }
    service = (home / ".config/systemd/user" / timer.SERVICE).read_text()
    assert "receive once --json" in service and str(launcher) in service
    assert ("enable", "--now", timer.TIMER) in calls


@pytest.mark.parametrize("kind", ["arbitrary", "home_link", "launcher_link", "unmanaged", "directory_link"])
def test_refuses_conflicting_or_redirected_installation(managed, tmp_path, monkeypatch, kind):
    home, launcher = managed
    calls = []
    monkeypatch.setattr(timer, "_run", lambda *args: calls.append(args) or SimpleNamespace(returncode=0))
    if kind == "arbitrary":
        launcher = tmp_path / "other"
        launcher.write_text("#!/bin/sh\n")
        launcher.chmod(0o755)
    elif kind == "home_link":
        link = tmp_path / "link"
        link.symlink_to(home, target_is_directory=True)
        home = link
    elif kind == "launcher_link":
        real = launcher.with_name("real")
        launcher.rename(real)
        launcher.symlink_to(real)
    elif kind == "unmanaged":
        units = home / ".config/systemd/user"
        units.mkdir(parents=True)
        (units / timer.SERVICE).write_text("user service")
    else:
        outside = tmp_path / "outside"
        outside.mkdir()
        (home / ".config").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ProfileError):
        timer.install(home, launcher, 60)
    assert calls == []


def test_failed_activation_is_saved_as_partial_not_ready(managed, monkeypatch):
    home, launcher = managed

    def run(*args):
        return SimpleNamespace(returncode=0 if args[0] == "show-environment" else 1)

    monkeypatch.setattr(timer, "_run", run)
    result = timer.install(home, launcher, 90)
    assert result["partial"] and not result["active"] and not result["enabled"]
    assert (launcher.parent.parent / "timer.json").exists()
    assert (home / ".config/systemd/user" / timer.TIMER).exists()
