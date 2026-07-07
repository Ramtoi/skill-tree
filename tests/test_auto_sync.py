"""Tests for the post-mutation `_auto_sync()` path (M2 — scoped auto-sync).

Registry mutations (enable/disable/bundle ops/…) run a LOCAL sync after saving,
but must NOT trigger the remote-SSH dispatch — that is deferred to an explicit
`hub sync` / `hub remote sync`. These tests pin that contract:

- `cmd_enable` / `cmd_disable` / a bundle mutation → ZERO `_run_remote_dispatch`.
- The permissions stream + doctor STAY enabled on the auto-sync path.
- A bare explicit `cmd_sync` (default args, `skip_remotes` falsy) DOES dispatch remotes.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml


def _write_registry(data_home: Path) -> Path:
    """A project + skill + a fake `sync_enabled: true` remote.

    The remote makes the remote dispatch something that WOULD run if the
    mutation path did not skip it — so a zero call count is meaningful.
    """
    skill_src = data_home / "skills" / "brainstorm"
    skill_src.mkdir(parents=True, exist_ok=True)
    (skill_src / "SKILL.md").write_text(
        "---\nname: brainstorm\ndescription: t\n---\n"
    )

    proj_path = data_home / "projects" / "alpha"
    proj_path.mkdir(parents=True, exist_ok=True)

    registry = {
        "version": "1",
        "harnesses_global": [],
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "",
                "source": str(skill_src),
                "type": "claude-skill",
                "scope": "portable",
                "upstream": None,
            }
        },
        "projects": {
            "alpha": {
                "path": str(proj_path),
                "enabled": [],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {
            "starter": {
                "description": "",
                "icon": "📦",
                "scope": "project-specific",
                "skills": ["brainstorm"],
            }
        },
        "remotes": {
            "fake-box": {
                "connector": "hermes",
                "transport": {"ssh_host": "nobody@203.0.113.1"},
                "host_key_sha256": "SHA256:deadbeef",
                "sync_enabled": True,
                "bundles": [],
                "enabled": ["brainstorm"],
            }
        },
    }
    reg_file = data_home / "registry.yaml"
    reg_file.write_text(yaml.safe_dump(registry, sort_keys=False))
    return reg_file


class _Counter:
    def __init__(self, ret=0):
        self.calls = 0
        self._ret = ret

    def __call__(self, *args, **kwargs):
        self.calls += 1
        return self._ret


def _patch_streams(monkeypatch):
    """Replace remote dispatch + permissions stream with counters.

    Keeps the test hermetic (no SSH, no real ~/.claude reads/writes) while still
    proving (a) remotes are skipped on the mutation path and (b) the permissions
    stream is NOT skipped by `_auto_sync()`.
    """
    import hub

    remote = _Counter(ret=0)
    perms = _Counter(ret=0)
    monkeypatch.setattr(hub, "_run_remote_dispatch", remote)
    monkeypatch.setattr(hub, "_run_permissions_stream", perms)
    return remote, perms


def test_cmd_enable_skips_remote_dispatch(tmp_data_home, monkeypatch, capsys):
    import hub

    _write_registry(tmp_data_home)
    remote, perms = _patch_streams(monkeypatch)

    hub.cmd_enable(argparse.Namespace(skill="brainstorm", project="alpha"))
    capsys.readouterr()

    assert remote.calls == 0, "enable must NOT trigger remote dispatch"
    assert perms.calls >= 1, "enable's auto-sync must keep the permissions stream"

    # Mutation actually landed.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "brainstorm" in reg["projects"]["alpha"]["enabled"]


def test_cmd_disable_skips_remote_dispatch(tmp_data_home, monkeypatch, capsys):
    import hub

    _write_registry(tmp_data_home)
    # Pre-enable so disable has work to do.
    hub.cmd_enable(argparse.Namespace(skill="brainstorm", project="alpha"))
    capsys.readouterr()

    remote, perms = _patch_streams(monkeypatch)
    hub.cmd_disable(argparse.Namespace(skill="brainstorm", project="alpha"))
    capsys.readouterr()

    assert remote.calls == 0, "disable must NOT trigger remote dispatch"
    assert perms.calls >= 1, "disable's auto-sync must keep the permissions stream"


def test_bundle_apply_skips_remote_dispatch(tmp_data_home, monkeypatch, capsys):
    import hub

    _write_registry(tmp_data_home)
    remote, perms = _patch_streams(monkeypatch)

    hub.cmd_bundle_apply(
        argparse.Namespace(bundle_name="starter", project="alpha")
    )
    capsys.readouterr()

    assert remote.calls == 0, "bundle apply must NOT trigger remote dispatch"
    assert perms.calls >= 1, "bundle apply's auto-sync must keep the permissions stream"

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "starter" in reg["projects"]["alpha"]["bundles"]


def test_explicit_sync_runs_remote_dispatch(tmp_data_home, monkeypatch, capsys):
    """A bare `cmd_sync` (default args → skip_remotes falsy) DOES dispatch remotes."""
    import hub

    _write_registry(tmp_data_home)
    remote, perms = _patch_streams(monkeypatch)

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert remote.calls == 1, "explicit full sync must run remote dispatch exactly once"


def test_auto_sync_helper_sets_skip_remotes(tmp_data_home, monkeypatch, capsys):
    """`_auto_sync()` calls `cmd_sync` with skip_remotes=True but NOT skip_permissions."""
    import hub

    _write_registry(tmp_data_home)

    seen = {}

    def _fake_sync(args):
        seen["skip_remotes"] = getattr(args, "skip_remotes", False)
        seen["skip_permissions"] = getattr(args, "skip_permissions", False)

    monkeypatch.setattr(hub, "cmd_sync", _fake_sync)
    hub._auto_sync()

    assert seen["skip_remotes"] is True
    assert seen["skip_permissions"] is False
