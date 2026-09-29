"""Delivery policy and explicit fleet delivery stay isolated from ordinary sync."""

from __future__ import annotations

import json
import sys

import pytest


def _headless(*, enabled=True):
    return {"connector": "headless-loadouts", "sync_enabled": enabled}


def test_delivery_settings_default_and_reject_malformed_values():
    from skill_hub.infrastructure.remotes.remotes import remote_delivery_settings

    assert remote_delivery_settings({}) == {"publish_on_sync": True}
    assert remote_delivery_settings({"remote_delivery": {"publish_on_sync": False}}) == {
        "publish_on_sync": False
    }
    for value in (None, {}, {"publish_on_sync": 1}, {"publish_on_sync": True, "extra": False}):
        with pytest.raises(ValueError):
            remote_delivery_settings({"remote_delivery": value})


def test_disabled_ordinary_dispatch_skips_headless_before_connector_lookup(tmp_data_home, monkeypatch):
    from skill_hub.application.sync import remote_dispatch
    from skill_hub.infrastructure import connectors

    monkeypatch.setattr(
        connectors,
        "get_connector",
        lambda key: pytest.fail("disabled headless delivery must not reach connector lookup"),
    )
    report = {"global": {"remotes": {}}}
    remote_dispatch._run_remote_dispatch(
        {"remote_delivery": {"publish_on_sync": False}, "remotes": {"box-a": _headless()}},
        set(),
        report=report,
    )
    assert report["global"]["remotes"]["targets"]["box-a"]["state"] == "delivery_disabled"


def test_explicit_remote_sync_bypasses_delivery_preference(tmp_data_home, monkeypatch):
    from skill_hub.application.sync import remote_dispatch
    from skill_hub.infrastructure import connectors

    class Connector:
        deployment_kind = "project-loadouts"

        def sync_deployment(self, target, registry):
            return {"state": "applied", "error": None}

    monkeypatch.setattr(connectors, "get_connector", lambda key: Connector())
    report = {"global": {"remotes": {}}}
    remote_dispatch._run_remote_dispatch(
        {"remote_delivery": {"publish_on_sync": False}, "remotes": {"box-a": _headless()}},
        set(),
        only="box-a",
        report=report,
    )
    assert report["global"]["remotes"]["targets"]["box-a"]["state"] == "applied"


def test_malformed_policy_fails_closed_for_headless_only(tmp_data_home, monkeypatch):
    from skill_hub.application.sync import remote_dispatch
    from skill_hub.infrastructure import connectors

    seen = []

    class Connector:
        def health_check(self, target):
            return type(
                "Health",
                (),
                {"ok": False, "reachable": False, "authenticated": False, "host_key_match": False, "detail": "offline"},
            )()

    monkeypatch.setattr(connectors, "get_connector", lambda key: seen.append(key) or Connector())
    remote_dispatch._run_remote_dispatch(
        {
            "remote_delivery": {"publish_on_sync": "no"},
            "remotes": {"box-a": _headless(), "other": {"connector": "hermes"}},
        },
        set(),
    )
    assert seen == ["hermes"]


def test_fleet_run_skips_paused_isolates_failure_and_persists(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.registry import loadout_machine

    registry = {"remotes": {
        "paused": _headless(enabled=False),
        "broken": _headless(),
        "ready": _headless(),
        "other": {"connector": "hermes"},
    }}

    def publish(registry, target, *, immediate):
        assert immediate is True
        assert target.id != "paused"
        if target.id == "broken":
            raise RuntimeError("private transport detail")
        if target.id == "ready":
            return {"ok": True, "state": "approval_required", "error": None}
        return {"state": "applied", "error": None}

    monkeypatch.setattr(loadout_machine, "publish", publish)
    result = loadout_machine.run_delivery(registry)
    assert [(row["id"], row["state"]) for row in result["results"]] == [
        ("paused", "paused"),
        ("broken", "delivery_failed"),
        ("ready", "approval_required"),
    ]
    assert result["results"][1]["message"] == (
        "Could not deliver this machine's loadout. Retry after checking its setup."
    )
    assert loadout_machine.last_delivery_run() == result


def test_fleet_run_rejects_malformed_remotes_before_success_receipt(tmp_data_home):
    from skill_hub.infrastructure.registry import loadout_machine

    with pytest.raises(ValueError, match="Remotes must be a mapping"):
        loadout_machine.run_delivery({"remotes": []})


def test_delivery_cli_uses_parser_and_returns_json_errors_at_exit_zero(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.infrastructure.registry import loadout_machine

    monkeypatch.setattr(
        sys,
        "argv",
        ["hub", "remote", "delivery", "set", "--publish-on-sync", "false", "--json"],
    )
    hub.main()
    set_reply = json.loads(capsys.readouterr().out)
    assert set_reply["ok"] is True and set_reply["settings"] == {"publish_on_sync": False}

    monkeypatch.setattr(sys, "argv", ["hub", "remote", "delivery", "show", "--json"])
    hub.main()
    show_reply = json.loads(capsys.readouterr().out)
    assert show_reply == {"ok": True, "settings": {"publish_on_sync": False}, "last_run": None, "error": None}

    monkeypatch.setattr(
        loadout_machine,
        "run_delivery",
        lambda registry: {"at": "2026-09-17T00:00:00+00:00", "results": []},
    )
    monkeypatch.setattr(sys, "argv", ["hub", "remote", "delivery", "run", "--json"])
    hub.main()
    assert json.loads(capsys.readouterr().out)["last_run"]["results"] == []

    (tmp_data_home / "registry.yaml").write_text("remote_delivery:\n  publish_on_sync: 1\n")
    monkeypatch.setattr(sys, "argv", ["hub", "remote", "delivery", "show", "--json"])
    hub.main()
    bad_reply = json.loads(capsys.readouterr().out)
    assert bad_reply["ok"] is False and bad_reply["error"]["code"] == "invalid_remote_delivery"

    monkeypatch.setattr(
        sys,
        "argv",
        ["hub", "remote", "delivery", "set", "--publish-on-sync", "yes", "--json"],
    )
    hub.main()
    invalid_value = json.loads(capsys.readouterr().out)
    assert invalid_value["ok"] is False and invalid_value["error"]["code"] == "invalid_remote_delivery"

    monkeypatch.setattr(
        sys,
        "argv",
        ["hub", "remote", "delivery", "set", "--publish-on-sync", "true", "--json"],
    )
    hub.main()
    repaired = json.loads(capsys.readouterr().out)
    assert repaired["ok"] is True and repaired["settings"] == {"publish_on_sync": True}
