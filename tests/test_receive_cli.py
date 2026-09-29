"""The receiver CLI never invokes controller sync or mutates its registry."""

import io
import json
import sys


def call(monkeypatch, capsys, *args):
    import hub

    monkeypatch.setattr(sys, "argv", ["hub", "receive", *args, "--json"])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    return code, json.loads(capsys.readouterr().out)


def test_receiver_confirmation_roundtrip_no_registry(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.loadout import loadout_receive

    monkeypatch.setattr(hub, "_auto_sync", lambda: (_ for _ in ()).throw(AssertionError("no sync")))
    monkeypatch.setattr(loadout_receive, "installed_providers", lambda: {"codex"})
    assert call(monkeypatch, capsys, "init", "--receiver-id", "box-a")[1]["ok"]
    path = tmp_data_home / "project"
    path.mkdir()
    binding = {"mode": "manual", "source_fingerprint": "a" * 64, "destination_key": "app", "harnesses": ["codex"]}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(binding)))
    code, result = call(
        monkeypatch, capsys, "confirm", "--binding", "main", "--checkout", str(path), "--proposal-stdin"
    )
    assert code == 0 and result["result"]["confirmation"]["receiver_id"] == "box-a", result
    code, result = call(monkeypatch, capsys, "inspect")
    assert result["result"]["profile"]["bindings"]["main"]["path"] == str(path.resolve())
    assert not (tmp_data_home / "registry.yaml").exists()
    assert list(path.iterdir()) == []


def test_receiver_missing_is_readonly_and_bad_proposal_rejected(tmp_data_home, monkeypatch, capsys):
    code, result = call(monkeypatch, capsys, "inspect")
    assert code == 0 and result["error"]["code"] == "receiver_not_configured"
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"mode":"manual","mode":"repository"}'))
    code, result = call(
        monkeypatch, capsys, "confirm", "--binding", "main", "--checkout", str(tmp_data_home), "--proposal-stdin"
    )
    assert code == 1 and result["error"]["code"] == "invalid_binding"


def test_machine_binding_parser_preserves_global_native_choices(tmp_data_home, monkeypatch, capsys):
    import sys

    import hub
    from skill_hub.infrastructure.registry import loadout_machine

    captured = {}

    def operate(machine_id, action, registry, **options):
        captured.update(options)
        return {"id": machine_id, "phase": "bound"}

    monkeypatch.setattr(loadout_machine, "operate", operate)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "hub",
            "remote",
            "machine",
            "bind",
            "box-a",
            "--binding",
            "app",
            "--project",
            "app",
            "--checkout",
            "/fixture/app",
            "--harness",
            "codex",
            "--global-native",
            "agents",
            "--global-agent",
            "pr_explorer",
            "--manual",
            "--json",
        ],
    )
    hub.main()
    assert captured["global_native"] == ["agents"]
    assert captured["global_agents"] == ["pr_explorer"]
    assert captured["harnesses"] == ["codex"]
