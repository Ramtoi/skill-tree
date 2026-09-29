"""Durable onboarding does no remote work on reads and never enables incomplete setup."""

import pytest

from skill_hub import hub_core
from skill_hub.domain.loadout.loadout_profiles import ProfileError
from skill_hub.infrastructure.registry import loadout_machine as machine

PIN = "SHA256:" + "a" * 43


def test_draft_uses_defaults_once_and_read_is_offline(tmp_data_home, monkeypatch):
    monkeypatch.setattr(machine, "request", lambda *a, **k: pytest.fail("read must not connect"))
    registry = {"remote_defaults": {"poll_interval_seconds": 120}}
    first = machine.save("box-a", {"ssh_host": "box-a", "host_key_sha256": PIN}, registry)
    assert first["draft"]["input"]["poll_interval_seconds"] == 120
    registry["remote_defaults"]["poll_interval_seconds"] = 300
    second = machine.save("box-a", {"feed_url": "git@example.org:private/feed.git"}, registry)
    assert second["draft"]["input"]["poll_interval_seconds"] == 120
    assert second["draft"]["feed_id"] == first["draft"]["feed_id"]
    assert not second["sync_enabled"] and not registry.get("remotes")
    assert machine.list_machines(registry)[0]["id"] == "box-a"


def test_existing_connector_id_is_rejected_before_draft_write(tmp_data_home):
    with pytest.raises(ProfileError, match="existing connector"):
        machine.save("box-a", {}, {"remotes": {"box-a": {"connector": "hermes"}}})
    assert not machine._path("box-a").exists()


def test_discovery_enrichment_matches_monorepo_subdirectory_and_allows_duplicate_clones(tmp_path):
    import subprocess

    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    subprocess.run(
        ["git", "-C", str(source), "remote", "add", "origin", "https://github.com/example/app.git"], check=True
    )
    project_path = source / "packages" / "editor"
    project_path.mkdir(parents=True)
    result = machine._enrich_discovery(
        {"candidates": [{"path": "/box/app", "subdirectories": ["packages/editor"], "remotes": [{
            "url": "git@github.com:example/app.git", "remote": "upstream", "subdirectory": "packages/editor"
        }]}]},
        {"projects": {"app": {"path": str(project_path), "repository": {
            "url": "https://github.com/example/app.git", "remote": "origin", "subdirectory": "packages/editor"
        }}}},
    )
    assert result["candidates"][0]["matches"][0]["destination_remote"] == "upstream"


def connected(tmp_data_home, monkeypatch):
    registry = {}

    class Connection:
        def __init__(self, *args, **kwargs):
            pass

        def verify_host_key(self):
            pass

        def authenticate(self):
            pass

    monkeypatch.setattr(machine, "SshTransport", Connection)
    machine.save("box-a", {"ssh_host": "box-a", "host_key_sha256": PIN}, registry)
    machine.operate("box-a", "connect", registry)
    return registry


def test_installer_receipt_survives_failed_receiver_initialization(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    installation = {"command": "/home/user/.local/share/skill-tree/receiver/bin/hub", "package_digest": "a" * 64}
    monkeypatch.setattr(machine, "install_remote", lambda *a, **k: installation)

    def fail(*args, **kwargs):
        raise ProfileError("receiver_unreachable", "offline")

    monkeypatch.setattr(machine, "request", fail)
    with pytest.raises(ProfileError):
        machine.operate("box-a", "install", registry)
    saved = machine.show("box-a", registry)
    assert saved["draft"]["observations"]["install"] == installation
    assert saved["phase"] == "installed_pending_init" and not saved["sync_enabled"]
    with pytest.raises(ProfileError, match="new machine id"):
        machine.save("box-a", {"ssh_host": "different"}, registry)
    assert hub_core.load_registry()["remotes"]["box-a"]["sync_enabled"] is False


def test_start_needs_fresh_preview_and_confirmed_apply(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"]["configure"] = {"feed_id": draft["feed_id"]}
    draft["observations"]["preview"] = {"plan_digest": "old"}
    machine.atomic_json(machine._path("box-a"), draft)
    calls = []
    monkeypatch.setattr(machine, "publish", lambda *a, **k: {"ok": True, "state": "published_waiting_for_receiver"})
    monkeypatch.setattr(
        machine, "request", lambda target, args, **k: calls.append(args) or {"ok": True, "plan_digest": "new"}
    )
    with pytest.raises(ProfileError) as error:
        machine.operate("box-a", "start", registry, plan_digest="old")
    assert error.value.code == "preview_changed" and calls == [["plan"]]
    assert not registry["remotes"]["box-a"]["sync_enabled"]


def test_start_without_persisted_preview_does_not_publish(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"]["configure"] = {"feed_id": draft["feed_id"]}
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(machine, "publish", lambda *a, **k: pytest.fail("must preview first"))
    with pytest.raises(ProfileError) as error:
        machine.operate("box-a", "start", registry, plan_digest="guessed")
    assert error.value.code == "preview_required"


def test_failed_registry_save_does_not_advance_draft(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    before = machine.read("box-a")
    changed = machine.read("box-a")
    changed["phase"] = "ready"
    monkeypatch.setattr(hub_core, "save_registry", lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        machine._persist(changed, registry, machine._target(changed, registry))
    assert machine.read("box-a") == before


def test_configure_checks_mac_access_before_contacting_receiver(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    machine.save("box-a", {"feed_url": "https://github.com/team/feed.git", "private_feed_confirmed": True}, registry)
    draft = machine.read("box-a")
    draft["observations"]["install"] = {"command": "/home/me/hub"}
    machine.atomic_json(machine._path("box-a"), draft)

    def unavailable(self):
        raise ProfileError("feed_authentication_failed", "no access")

    monkeypatch.setattr(machine.GitFeed, "fetch", unavailable)
    monkeypatch.setattr(machine, "request", lambda *a, **k: pytest.fail("must check Mac access first"))
    with pytest.raises(ProfileError, match="On this Mac: no access"):
        machine.operate("box-a", "configure", registry)
    assert "configure" not in machine.read("box-a")["observations"]


def test_connection_retest_preserves_completed_setup_phase(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["phase"] = "installed"
    draft["observations"]["install"] = {"command": "/home/me/hub"}
    machine.atomic_json(machine._path("box-a"), draft)
    result = machine.operate("box-a", "connect", registry)
    assert result["phase"] == "installed"


def test_preview_surfaces_the_safe_publication_error(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"]["configure"] = {"feed_id": draft["feed_id"]}
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(
        machine,
        "publish",
        lambda *a, **k: {
            "ok": False,
            "state": "unsupported_invocation",
            "error": {"message": "Skill example needs another provider."},
        },
    )
    with pytest.raises(ProfileError, match="Skill example needs another provider"):
        machine.operate("box-a", "preview", registry)


def test_metadata_free_monorepo_discovers_non_origin_and_confirms_actual_subfolder(tmp_path):
    import copy
    import subprocess
    from pathlib import Path

    from skill_hub.domain.loadout.loadout_profiles import ReceiverProfiles
    from skill_hub.infrastructure.registry.loadout_bindings import proposed_binding
    from skill_hub.infrastructure.registry.project_repository import discover_checkouts, inspect_project_repository

    source, remote = tmp_path / "source", tmp_path / "different-layout" / "remote"
    for root in (source, remote):
        root.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(
            ["git", "-C", str(root), "remote", "add", "upstream", "https://github.com/org/repo.git"], check=True
        )
        (root / "packages/editor").mkdir(parents=True)
    subprocess.run(["git", "-C", str(source), "remote", "add", "origin", "https://github.com/org/fork.git"], check=True)
    registry = {"projects": {"editor": {"path": str(source / "packages/editor")}}}
    before = copy.deepcopy(registry)
    import json
    from dataclasses import asdict

    raw = json.loads(json.dumps(asdict(discover_checkouts([remote.parent], subdirectories=["packages/editor"]))))
    discovered = machine._enrich_discovery(raw, registry)
    match = discovered["candidates"][0]["matches"][0]
    assert match["source_remote"] == "upstream"
    assert match["checkout_path"] == str(remote / "packages/editor")
    assert registry == before
    path = Path(match["checkout_path"])
    binding = proposed_binding(
        registry, project="editor", destination_key="editor", harnesses=["codex"],
        source_remote=match["source_remote"],
        destination_repository=asdict(inspect_project_repository(path, remote=match["destination_remote"]).association),
    )
    profile = ReceiverProfiles(tmp_path / "receiver")
    profile.initialize("box-a")
    confirmation = profile.confirm("editor", binding, path, installed={"codex"})
    assert profile.checkout("editor", binding, confirmation) == path


def test_discovery_reports_missing_project_subdirectory(tmp_path):
    import json
    import subprocess
    from dataclasses import asdict

    from skill_hub.infrastructure.registry.project_repository import discover_checkouts

    remote = tmp_path / "remote"
    remote.mkdir()
    subprocess.run(["git", "init", "-q", str(remote)], check=True)
    subprocess.run(["git", "-C", str(remote), "remote", "add", "origin", "https://github.com/org/repo.git"], check=True)
    registry = {"projects": {"editor": {"repository": {
        "url": "https://github.com/org/repo.git", "remote": "origin", "subdirectory": "packages/editor",
    }}}}
    raw = json.loads(json.dumps(asdict(discover_checkouts([remote], subdirectories=["packages/editor"]))))
    result = machine._enrich_discovery(raw, registry)
    assert result["candidates"][0]["matches"] == []
    assert result["issues"][0]["code"] == "project_subdirectory_missing"

@pytest.mark.parametrize("active", [True, False])
def test_interval_save_preserves_delivery_and_review(tmp_data_home, monkeypatch, active):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["input"].update(feed_url="git@example.org:team/feed.git", private_feed_confirmed=True)
    draft["observations"].update(configure={"interval": 60}, preview={"plan_digest": "approved"})
    draft["phase"] = "ready" if active else "paused"
    machine.atomic_json(machine._path("box-a"), draft)
    registry["remotes"]["box-a"]["sync_enabled"] = active
    calls = []
    monkeypatch.setattr(machine, "ensure_signing_key", lambda: "public-key")
    monkeypatch.setattr(machine, "publish", lambda *a, **k: pytest.fail("interval must not publish"))
    monkeypatch.setattr(machine, "request", lambda target, args, **kw: calls.append(args) or
                        {"interval": 120, "enabled": True, "active": True})
    result = machine.operate("box-a", "interval", registry, poll_interval_seconds=120)
    assert result["draft"]["input"]["poll_interval_seconds"] == 120
    assert result["sync_enabled"] is active
    assert result["phase"] == draft["phase"]
    assert result["draft"]["observations"]["preview"] == {"plan_digest": "approved"}
    assert [c[0] for c in calls] == (["configure", "timer"] if active else ["configure"])

@pytest.mark.parametrize("bad", [None, True, 29, 3601, 60.5, "60"])
def test_interval_rejects_invalid_values_before_remote_write(tmp_data_home, monkeypatch, bad):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"]["configure"] = {"interval": 60}
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(machine, "request", lambda *a, **k: pytest.fail("invalid interval must not write"))
    with pytest.raises(ProfileError):
        machine.operate("box-a", "interval", registry, poll_interval_seconds=bad)


def test_interval_cli_passes_value_to_controller(tmp_data_home, monkeypatch, capsys):
    import sys

    import hub

    calls = []
    monkeypatch.setattr(machine, "operate", lambda name, action, registry, **options:
                        calls.append((name, action, options)) or {"id": name})
    monkeypatch.setattr(sys, "argv", ["hub", "remote", "machine", "interval", "box-a",
                                    "--poll-interval-seconds", "120", "--json"])
    hub.main()
    assert calls == [("box-a", "interval", {"poll_interval_seconds": 120})]
    assert '"ok": true' in capsys.readouterr().out


def test_failed_timer_update_keeps_interval_retryable(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["input"]["feed_url"] = "git@example.org:team/feed.git"
    draft["observations"].update(configure={"interval": 60}, preview={"plan_digest": "approved"})
    draft["phase"] = "ready"
    machine.atomic_json(machine._path("box-a"), draft)
    registry["remotes"]["box-a"]["sync_enabled"] = True
    monkeypatch.setattr(machine, "ensure_signing_key", lambda: "public-key")
    monkeypatch.setattr(machine, "request", lambda target, args, **kw:
                        {"partial": True, "active": False} if args[0] == "timer" else {"interval": 120})
    with pytest.raises(ProfileError, match="Retry Save interval"):
        machine.operate("box-a", "interval", registry, poll_interval_seconds=120)
    saved = machine.show("box-a", registry)
    assert saved["phase"] == "timer_pending"
    assert machine.list_machines(registry)[0]["phase"] == "timer_pending"
    assert saved["draft"]["input"]["poll_interval_seconds"] == 60
    assert saved["draft"]["observations"]["preview"] == {"plan_digest": "approved"}
    assert saved["draft"]["observations"]["interval_update"]["requested_interval"] == 120
    assert saved["draft"]["observations"]["interval_update"]["state"] == "timer_pending"
    monkeypatch.setattr(machine, "request", lambda *a, **kw: {"enabled": True, "active": True})
    retried = machine.operate("box-a", "interval", registry, poll_interval_seconds=120)
    assert "interval_update" not in retried["draft"]["observations"]
    assert retried["draft"]["input"]["poll_interval_seconds"] == 120
    assert retried["sync_enabled"] is True


def test_plain_configure_records_only_validated_channel_conflict_fields(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    machine.save("box-a", {"feed_url": "https://github.com/team/feed.git", "private_feed_confirmed": True}, registry)
    draft = machine.read("box-a")
    draft["observations"]["install"] = {"command": "/home/me/hub"}
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(machine.GitFeed, "fetch", lambda self: "deadbeef")
    monkeypatch.setattr(machine, "ensure_signing_key", lambda: "public-key")
    controller_id = machine.key_id("public-key")

    def request(target, args, **kw):
        if args[0] == "status":
            return {
                "feed_id": "a" * 32,
                "publisher_key_id": "SHA256:" + "b" * 16,
                # An invalid extra field: applied.generation must be an int >= 1.
                "applied": {"generation": "not-an-int", "applied_at": "2026-09-24T00:00:00+00:00"},
            }
        raise ProfileError("channel_rotation_required", "the receiver's generic message")

    monkeypatch.setattr(machine, "request", request)
    with pytest.raises(ProfileError) as error:
        machine.operate("box-a", "configure", registry)
    assert error.value.code == "channel_rotation_required"
    assert "another Skill Tree installation" in str(error.value)
    conflict = machine.read("box-a")["observations"]["channel_conflict"]
    assert conflict == {
        "feed_id": "a" * 32,
        "publisher_key_id": "SHA256:" + "b" * 16,
        "controller_key_id": controller_id,
    }
    assert "applied" not in conflict


def test_replace_channel_mints_a_new_feed_id_and_sends_rotate(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    machine.save("box-a", {"feed_url": "https://github.com/team/feed.git", "private_feed_confirmed": True}, registry)
    draft = machine.read("box-a")
    draft["observations"]["install"] = {"command": "/home/me/hub"}
    draft["observations"]["channel_conflict"] = {"feed_id": "a" * 32}
    draft["observations"]["preview"] = {"plan_digest": "stale"}
    draft["observations"]["status"] = {"paused": False}
    old_feed_id = draft["feed_id"]
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(machine.GitFeed, "fetch", lambda self: "deadbeef")
    monkeypatch.setattr(machine, "ensure_signing_key", lambda: "public-key")
    calls = []
    monkeypatch.setattr(machine, "request", lambda target, args, **kw: calls.append(args) or {"paused": True})
    result = machine.operate("box-a", "configure", registry, replace_channel=True)
    assert result["draft"]["feed_id"] != old_feed_id
    assert "--rotate" in calls[0]
    assert result["draft"]["observations"]["configure"] == {
        "feed_id": result["draft"]["feed_id"],
        "interval": draft["input"]["poll_interval_seconds"],
        "replace_feed": True,
    }
    assert "channel_conflict" not in result["draft"]["observations"]
    assert "preview" not in result["draft"]["observations"]
    assert "status" not in result["draft"]["observations"]
    assert result["draft"]["phase"] == "configured"


def test_replace_channel_requires_pausing_delivery_first(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    machine.save("box-a", {"feed_url": "https://github.com/team/feed.git", "private_feed_confirmed": True}, registry)
    draft = machine.read("box-a")
    draft["observations"]["install"] = {"command": "/home/me/hub"}
    old_feed_id = draft["feed_id"]
    machine.atomic_json(machine._path("box-a"), draft)
    registry["remotes"]["box-a"]["sync_enabled"] = True
    monkeypatch.setattr(machine.GitFeed, "fetch", lambda self: "deadbeef")
    monkeypatch.setattr(machine, "ensure_signing_key", lambda: "public-key")
    monkeypatch.setattr(machine, "request", lambda *a, **k: pytest.fail("must pause before reconnecting"))
    with pytest.raises(ProfileError) as error:
        machine.operate("box-a", "configure", registry, replace_channel=True)
    assert error.value.code == "machine_pause_required"
    assert machine.read("box-a")["feed_id"] == old_feed_id


def test_receiver_unavailable_on_replace_path_becomes_receiver_update_required(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    machine.save("box-a", {"feed_url": "https://github.com/team/feed.git", "private_feed_confirmed": True}, registry)
    draft = machine.read("box-a")
    draft["observations"]["install"] = {"command": "/home/me/hub"}
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(machine.GitFeed, "fetch", lambda self: "deadbeef")
    monkeypatch.setattr(machine, "ensure_signing_key", lambda: "public-key")

    def fail(*args, **kwargs):
        raise ProfileError("receiver_unavailable", "The receiver command could not run.")

    monkeypatch.setattr(machine, "request", fail)
    with pytest.raises(ProfileError) as error:
        machine.operate("box-a", "configure", registry, replace_channel=True)
    assert error.value.code == "receiver_update_required"


def test_preview_passes_replace_feed_and_clears_it_once_published(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"]["configure"] = {"feed_id": draft["feed_id"], "interval": 60, "replace_feed": True}
    machine.atomic_json(machine._path("box-a"), draft)
    calls = []

    def fake_publish(reg, target, **kwargs):
        calls.append(kwargs.get("replace_feed"))
        return {
            "ok": True,
            "state": "published_waiting_for_receiver",
            "published": {"feed_id": draft["feed_id"], "generation": 1},
        }

    monkeypatch.setattr(machine, "publish", fake_publish)
    monkeypatch.setattr(machine, "request", lambda target, args, **kw: {"ok": True, "plan_digest": "new"})
    result = machine.operate("box-a", "preview", registry)
    assert calls == [True]
    assert "replace_feed" not in result["draft"]["observations"]["configure"]


def test_start_passes_replace_feed_and_clears_it_once_published(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"].update(
        configure={"feed_id": draft["feed_id"], "interval": 60, "replace_feed": True},
        preview={"plan_digest": "approved"},
    )
    machine.atomic_json(machine._path("box-a"), draft)
    calls = []

    def fake_publish(reg, target, **kwargs):
        calls.append(kwargs.get("replace_feed"))
        return {
            "ok": True,
            "state": "applied",
            "applied": {},
            "published": {"feed_id": draft["feed_id"], "generation": 1},
        }

    monkeypatch.setattr(machine, "publish", fake_publish)
    monkeypatch.setattr(machine, "request", lambda target, args, **kw:
                        {"ok": True, "plan_digest": "approved", "enabled": True, "active": True})
    result = machine.operate("box-a", "start", registry, plan_digest="approved")
    assert calls == [True, True]
    assert "replace_feed" not in result["draft"]["observations"]["configure"]
    assert result["phase"] == "ready"


def test_configure_cli_passes_replace_channel_through_to_operate(tmp_data_home, monkeypatch, capsys):
    import sys

    import hub

    calls = []
    monkeypatch.setattr(machine, "operate", lambda name, action, registry, **options:
                        calls.append((name, action, options)) or {"id": name})
    monkeypatch.setattr(sys, "argv", ["hub", "remote", "machine", "configure", "box-a", "--replace-channel", "--json"])
    hub.main()
    assert calls == [("box-a", "configure", {"replace_channel": True})]
    assert '"ok": true' in capsys.readouterr().out


def test_successful_start_resolves_pending_timer_update(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"].update(
        configure={"interval": 60}, preview={"plan_digest": "approved"},
        interval_update={"requested_interval": 120, "state": "timer_pending", "message": "Retry"},
    )
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(machine, "publish", lambda *a, **k: {"ok": True, "state": "applied", "applied": {}})
    monkeypatch.setattr(machine, "request", lambda target, args, **kw:
                        {"ok": True, "plan_digest": "approved", "enabled": True, "active": True})
    saved = machine.operate("box-a", "start", registry, plan_digest="approved")
    assert saved["phase"] == "ready"
    assert saved["draft"]["input"]["poll_interval_seconds"] == 120
    assert "interval_update" not in saved["draft"]["observations"]


def test_status_inspects_current_blockers_without_publishing_or_replacing_review(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    reviewed = {"ok": True, "state": "ready", "plan_digest": "reviewed"}
    draft["observations"].update(configure={"interval": 60}, preview=reviewed)
    machine.atomic_json(machine._path("box-a"), draft)
    calls = []
    candidate = {"generation": 5, "revision": "a" * 40}
    monkeypatch.setattr(machine, "last_result", lambda machine_id: {"published": candidate})
    plan = {"ok": False, "state": "blocked_drift", "candidate": candidate,
            "blockers": [{"code": "blocked_drift", "path": "/home/user/skill.md"}],
            "plan_digest": "unreviewed", "private_extra": "must not persist"}
    monkeypatch.setattr(machine, "publish", lambda *a, **kw: pytest.fail("status must not publish"))
    monkeypatch.setattr(machine, "request", lambda target, args, **kw:
                        calls.append(args) or ({"paused": False} if args == ["status"] else plan))
    result = machine.operate("box-a", "status", registry)
    observations = result["draft"]["observations"]
    assert calls == [["status"], ["plan"]]
    assert observations["preview"] == reviewed
    assert observations["inspection"]["observed_at"]
    assert observations["inspection"]["plan"]["candidate"] == candidate
    assert observations["inspection"]["published"] == candidate
    assert observations["inspection"]["plan"]["blockers"] == plan["blockers"]
    assert "private_extra" not in observations["inspection"]["plan"]
    with pytest.raises(ProfileError) as error:
        machine.operate("box-a", "start", registry, plan_digest="unreviewed")
    assert error.value.code == "preview_required"


def test_failed_inspection_keeps_previous_observation_time(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    inspection = {"observed_at": "2026-09-25T13:00:00Z", "plan": {"ok": True}}
    draft["observations"].update(configure={"interval": 60}, inspection=inspection)
    machine.atomic_json(machine._path("box-a"), draft)

    def request(target, args, **kw):
        if args == ["plan"]:
            raise ProfileError("receiver_unavailable", "Could not inspect the receiver.")
        return {"paused": False}

    monkeypatch.setattr(machine, "request", request)
    with pytest.raises(ProfileError):
        machine.operate("box-a", "status", registry)
    assert machine.read("box-a")["observations"]["inspection"] == inspection


def test_pause_invalidates_old_inspection(tmp_data_home, monkeypatch):
    registry = connected(tmp_data_home, monkeypatch)
    draft = machine.read("box-a")
    draft["observations"].update(configure={"interval": 60}, inspection={"plan": {"ok": True}})
    machine.atomic_json(machine._path("box-a"), draft)
    monkeypatch.setattr(machine, "request", lambda *a, **kw: {"paused": True})
    result = machine.operate("box-a", "pause", registry)
    assert "inspection" not in result["draft"]["observations"]
