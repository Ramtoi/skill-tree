"""Tests for the app/CLI self-update check (`hub update`).

Covers version parsing, the bundled-VERSION read, install-kind classification,
and the routing + guidance branches of `cmd_update` — all without touching the
network (the GitHub fetch is monkeypatched).
"""

from __future__ import annotations

import argparse
import json

import pytest

import hub


# ── version helpers ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "a,b,expected",
    [
        ("0.2.0", "0.1.0", True),
        ("0.1.0", "0.1.0", False),
        ("1.10.0", "1.9.0", True),  # numeric, not lexicographic
        ("v1.2.3", "1.2.2", True),  # leading v tolerated
        ("1.0.0-rc1", "1.0.0", False),  # suffix ignored → equal cores
    ],
)
def test_version_tuple_ordering(a, b, expected):
    assert (hub._version_tuple(a) > hub._version_tuple(b)) is expected


def test_hub_version_reads_bundled_file(tmp_path, monkeypatch):
    (tmp_path / "VERSION").write_text("3.4.5\n", encoding="utf-8")
    monkeypatch.setattr(hub, "code_home", lambda: tmp_path)
    assert hub.hub_version() == "3.4.5"


def test_hub_version_falls_back_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(hub, "code_home", lambda: tmp_path)  # no VERSION file
    assert hub.hub_version() == hub.FALLBACK_VERSION


# ── install-kind classification ──────────────────────────────────────────────


def test_code_home_kind_git(tmp_path, monkeypatch):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(hub, "code_home", lambda: tmp_path)
    assert hub._code_home_kind() == "git"


def test_code_home_kind_standalone(tmp_path, monkeypatch):
    monkeypatch.setattr(hub, "code_home", lambda: tmp_path)
    assert hub._code_home_kind() == "standalone"


def test_code_home_kind_bundle(tmp_path, monkeypatch):
    bundle = tmp_path / "Skill Tree.app" / "Contents" / "Resources" / "hub"
    bundle.mkdir(parents=True)
    monkeypatch.setattr(hub, "code_home", lambda: bundle)
    assert hub._code_home_kind() == "bundle"


# ── cmd_update routing + self-check branches ─────────────────────────────────


def _args(**kw):
    ns = argparse.Namespace(skill=None, check=False, apply=False, json=False)
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns


def _stub_release(monkeypatch, tag, current="0.1.0", kind="git"):
    monkeypatch.setattr(hub, "hub_version", lambda: current)
    monkeypatch.setattr(hub, "_code_home_kind", lambda: kind)
    monkeypatch.setattr(
        hub,
        "_fetch_latest_release",
        lambda: {"tag_name": tag, "html_url": f"https://x/releases/tag/{tag}"},
    )


def test_update_routes_to_skill_when_named(monkeypatch):
    called = {}
    monkeypatch.setattr(hub, "_cmd_update_skill", lambda s: called.setdefault("skill", s))
    monkeypatch.setattr(hub, "_cmd_update_self", lambda a: called.setdefault("self", True))
    hub.cmd_update(_args(skill="my-skill"))
    assert called == {"skill": "my-skill"}


def test_update_routes_to_self_when_bare(monkeypatch):
    called = {}
    monkeypatch.setattr(hub, "_cmd_update_self", lambda a: called.setdefault("self", True))
    hub.cmd_update(_args())
    assert called == {"self": True}


def test_self_check_up_to_date(monkeypatch, capsys):
    _stub_release(monkeypatch, "v0.1.0", current="0.1.0")
    hub._cmd_update_self(_args())
    out = capsys.readouterr().out
    assert "latest version" in out


def test_self_check_available_git_guidance(monkeypatch, capsys):
    _stub_release(monkeypatch, "v0.2.0", current="0.1.0", kind="git")
    hub._cmd_update_self(_args())
    out = capsys.readouterr().out
    assert "Update available" in out
    assert "git" in out and "pull" in out


def test_self_check_available_bundle_guidance(monkeypatch, capsys):
    _stub_release(monkeypatch, "v0.2.0", current="0.1.0", kind="bundle")
    hub._cmd_update_self(_args())
    out = capsys.readouterr().out
    assert "Skill Tree.app" in out


def test_self_check_available_standalone_hint(monkeypatch, capsys):
    _stub_release(monkeypatch, "v0.2.0", current="0.1.0", kind="standalone")
    hub._cmd_update_self(_args(apply=False))
    out = capsys.readouterr().out
    assert "hub update --apply" in out


def test_self_check_json_shape(monkeypatch, capsys):
    _stub_release(monkeypatch, "v0.2.0", current="0.1.0", kind="git")
    monkeypatch.setattr(hub, "code_home", lambda: hub.Path("/tmp/x"))
    hub._cmd_update_self(_args(json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["current"] == "0.1.0"
    assert payload["latest"] == "0.2.0"
    assert payload["update_available"] is True
    assert payload["install_kind"] == "git"


def test_self_check_network_error_exits_nonzero(monkeypatch, capsys):
    monkeypatch.setattr(hub, "hub_version", lambda: "0.1.0")

    def boom():
        raise OSError("offline")

    monkeypatch.setattr(hub, "_fetch_latest_release", boom)
    with pytest.raises(SystemExit) as exc:
        hub._cmd_update_self(_args())
    assert exc.value.code == 1
    assert "Could not reach GitHub" in capsys.readouterr().out
