"""The same receiver operation serves immediate delivery and periodic pulls."""

import subprocess

import pytest

from skill_hub.application.loadout.loadout_receive import Receiver
from skill_hub.domain.loadout.loadout_native_codec import CAPABILITIES, capabilities, capture_loadout_codec_context
from skill_hub.domain.loadout.loadout_profiles import ProfileError, ReceiverProfiles
from skill_hub.domain.loadout.loadout_projection import compile_projection
from skill_hub.infrastructure.connectors.signing import ensure_signing_key
from skill_hub.infrastructure.loadout.loadout_feed import GitFeed
from skill_hub.infrastructure.registry.loadout_bindings import proposed_binding
from skill_hub.infrastructure.remotes.remotes import RemoteTarget


@pytest.fixture
def scenario(tmp_data_home):
    home = tmp_data_home / "receiver-home"
    home.mkdir()
    checkout = home / "project"
    checkout.mkdir()
    source = tmp_data_home / "skills/example"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: example\ndescription: Example\n---\nHello\n")
    registry = {
        "projects": {"app": {"path": str(source.parent), "enabled": ["example"]}},
        "bundles": {},
        "skills": {"example": {"source": str(source), "scope": "portable", "type": "claude-skill"}},
    }
    binding = proposed_binding(registry, project="app", destination_key="app", harnesses=["codex"], manual=True)
    state = home / "receiver"
    profiles = ReceiverProfiles(state)
    profiles.initialize("box-a")
    binding["confirmation"] = profiles.confirm("main", binding, checkout, installed={"codex"})
    target = RemoteTarget.from_dict(
        "box-a", {"connector": "headless-loadouts", "project_bindings": {"main": binding}, "retired_bindings": {}}
    )
    remote = tmp_data_home / "feed.git"
    subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)
    key = ensure_signing_key()

    def factory(cache, url, receiver_id):
        return GitFeed(cache, url, receiver_id, allow_local=True)

    receiver = Receiver(state, home=home, installed={"codex"}, feed_factory=factory)
    receiver.configure(str(remote), "a" * 32, key, 60)
    publisher = factory(tmp_data_home / "publisher", str(remote), "box-a")

    def publish(generation=1, previous=None, codec_context=None):
        codec_context = codec_context or capture_loadout_codec_context()
        projection, assets = compile_projection(
            registry, target, feed_id="a" * 32, generation=generation, previous=previous,
            codec_context=codec_context,
        )
        return publisher.publish(projection, assets, parent=previous)

    return receiver, publish, checkout, source, registry, target


def test_preview_then_immediate_and_periodic_receive_share_revision(scenario):
    receiver, publish, checkout, source, _, _ = scenario
    first = publish()
    preview = receiver.plan()
    assert preview["ok"] and preview["changes"]
    native = checkout / ".agents/skills/example/SKILL.md"
    assert not native.exists()
    receipt = receiver.once(expected_revision=first)
    assert receipt["state"] == "applied" and receipt["applied"]["revision"] == first
    assert native.read_bytes() == (source / "SKILL.md").read_bytes()
    assert receiver.once()["state"] == "unchanged"
    (source / "SKILL.md").write_text("---\nname: example\ndescription: Example\n---\nUpdated\n")
    second = publish(2, first)
    assert receiver.once(expected_revision=second)["applied"]["revision"] == second
    assert b"Updated" in native.read_bytes()


def test_drift_and_replaced_checkout_cannot_be_reported_unchanged(scenario):
    receiver, publish, checkout, _, _, _ = scenario
    first = publish()
    receiver.once(first)
    native = checkout / ".agents/skills/example/SKILL.md"
    native.write_text("my local edit")
    receipt = receiver.once(first)
    assert receipt["state"] == "blocked_drift"
    assert native.read_text() == "my local edit"
    checkout.rename(checkout.with_name("old"))
    checkout.mkdir()
    assert receiver.plan()["state"] == "checkout_replaced"
    assert list(checkout.iterdir()) == []


def test_owned_global_file_already_matching_new_signed_asset_advances_without_replacement(scenario):
    receiver, publish, _, source, registry, _ = scenario
    registry["skills"]["example"]["scope"] = "global"
    first = publish()
    receiver.approve(receiver.plan()["approval_digest"])
    assert receiver.once(first)["state"] == "applied"
    native = receiver.home / ".agents/skills/example/SKILL.md"
    old_inode = native.stat().st_ino

    source_file = source / "SKILL.md"
    source_file.write_text("---\nname: example\ndescription: Example\n---\nUpdated\n")
    second = publish(2, first)
    native.write_bytes(source_file.read_bytes())
    changed_inode = native.stat().st_ino
    assert changed_inode == old_inode

    preview = receiver.plan()
    assert preview["state"] == "approval_required"
    receiver.approve(preview["approval_digest"])
    receipt = receiver.once(second)
    assert receipt["state"] == "applied"
    assert receipt["applied"]["revision"] == second
    assert native.stat().st_ino == changed_inode
    assert native.read_bytes() == source_file.read_bytes()


@pytest.mark.parametrize("edit", ["other_content", "wrong_mode", "symlink"])
def test_owned_global_file_that_does_not_exactly_match_signed_asset_stays_blocked(scenario, edit):
    receiver, publish, _, source, registry, _ = scenario
    registry["skills"]["example"]["scope"] = "global"
    first = publish()
    receiver.approve(receiver.plan()["approval_digest"])
    receiver.once(first)
    native = receiver.home / ".agents/skills/example/SKILL.md"
    (source / "SKILL.md").write_text("---\nname: example\ndescription: Example\n---\nUpdated\n")
    publish(2, first)
    if edit == "other_content":
        native.write_text("local edit")
    elif edit == "wrong_mode":
        native.write_bytes((source / "SKILL.md").read_bytes())
        native.chmod(0o755)
    else:
        native.unlink()
        native.symlink_to(source / "SKILL.md")

    assert receiver.plan()["state"] == "blocked_drift"
    assert receiver.once()["state"] == "blocked_drift"


def test_unowned_global_file_matching_signed_asset_stays_unmanaged(scenario):
    receiver, publish, _, source, registry, _ = scenario
    registry["skills"]["example"]["scope"] = "global"
    publish()
    native = receiver.home / ".agents/skills/example/SKILL.md"
    native.parent.mkdir(parents=True)
    native.write_bytes((source / "SKILL.md").read_bytes())

    assert receiver.plan()["state"] == "unmanaged_existing"
    assert receiver.once()["state"] == "unmanaged_existing"
    assert native.read_bytes() == (source / "SKILL.md").read_bytes()


def test_removed_owned_file_with_local_edit_stays_blocked(scenario):
    receiver, publish, checkout, _, registry, _ = scenario
    first = publish()
    receiver.once(first)
    native = checkout / ".agents/skills/example/SKILL.md"
    native.write_text("local edit")
    registry["projects"]["app"]["enabled"] = []
    publish(2, first)

    assert receiver.plan()["state"] == "blocked_drift"
    assert receiver.once()["state"] == "blocked_drift"
    assert native.read_text() == "local edit"


def test_global_requires_review_and_pause_preserves_applied_files(scenario):
    receiver, publish, _, source, registry, _ = scenario
    registry["skills"]["example"]["scope"] = "global"
    revision = publish()
    preview = receiver.plan()
    assert preview["state"] == "approval_required"
    native = receiver.home / ".agents/skills/example/SKILL.md"
    assert not native.exists()
    receiver.approve(preview["approval_digest"])
    assert receiver.once(revision)["state"] == "applied"
    assert native.read_bytes() == (source / "SKILL.md").read_bytes()
    receiver.pause()
    assert receiver.once()["state"] == "paused" and native.exists()


def test_corrupt_applied_state_blocks_preview(scenario):
    receiver, publish, checkout, _, _, _ = scenario
    revision = publish()
    receiver.once(revision)
    (receiver.root / "applied.json").write_text("null")
    assert receiver.plan()["blockers"][0]["code"] == "receiver_state_invalid"
    with pytest.raises(ProfileError):
        receiver.once()
    assert (checkout / ".agents/skills/example/SKILL.md").exists()


def test_changed_content_requires_new_reviewed_plan(scenario):
    receiver, publish, checkout, source, _, _ = scenario
    first = publish()
    reviewed = receiver.plan()["plan_digest"]
    assert receiver.plan()["plan_digest"] == reviewed  # timestamp does not expire a review
    (source / "SKILL.md").write_text("---\nname: example\ndescription: Example\n---\nChanged after review\n")
    second = publish(2, first)
    with pytest.raises(ProfileError) as error:
        receiver.once(second, expected_plan_digest=reviewed)
    assert error.value.code == "preview_changed"
    assert not (checkout / ".agents").exists()
    latest = receiver.plan()["plan_digest"]
    assert receiver.once(second, expected_plan_digest=latest)["state"] == "applied"


def _semantics_context(version: int):
    capability = dict(CAPABILITIES)
    capability["native_semantics"] = version
    return capture_loadout_codec_context(capability=capability)


def _add_native_mcp(registry):
    registry["skills"]["search"] = {"type": "mcp-server", "mcp": {"command": "python3"}}
    registry["projects"]["app"]["enabled"].append("search")


def _signed_projection(receiver, revision, context):
    channel = receiver._channel()
    feed = receiver._feed(channel)
    assert feed.fetch() == revision
    projection, _ = feed.read(revision, channel["pubkey"])
    assert projection["schema"] == 2
    assert projection["capabilities"] == capabilities(context)["digest"]
    return projection


def test_semantics3_signed_feed_is_readable_but_semantics4_receiver_writes_nothing(scenario):
    receiver, publish, checkout, _, registry, _ = scenario
    _add_native_mcp(registry)
    first = publish()
    _signed_projection(receiver, first, _semantics_context(4))
    preview = receiver.plan()
    assert preview["state"] == "approval_required"
    receiver.approve(preview["approval_digest"])
    assert receiver.once(first)["state"] == "applied"
    skill = checkout / ".agents/skills/example/SKILL.md"
    config = checkout / ".codex/config.toml"
    before_skill = skill.read_bytes()
    before_config = config.read_bytes()
    before_state = receiver._applied()
    before_ownership = {path: tuple(record["owners"]) for path, record in before_state["files"].items()}
    legacy = publish(2, first, _semantics_context(3))
    _signed_projection(receiver, legacy, _semantics_context(3))
    assert receiver.plan()["state"] == "receiver_capability_changed"
    with pytest.raises(ProfileError) as error:
        receiver.once(legacy)
    assert error.value.code == "receiver_capability_changed"
    assert skill.read_bytes() == before_skill
    assert config.read_bytes() == before_config
    assert receiver._applied() == before_state
    assert {
        path: tuple(record["owners"])
        for path, record in receiver._applied()["files"].items()
    } == before_ownership


def test_semantics3_receiver_refuses_semantics4_before_render_or_write(scenario, monkeypatch):
    receiver, publish, checkout, _, registry, _ = scenario
    _add_native_mcp(registry)
    revision = publish()
    _signed_projection(receiver, revision, _semantics_context(4))
    from skill_hub.domain.loadout import loadout_native_codec

    monkeypatch.setattr(loadout_native_codec, "capture_loadout_codec_context", lambda: _semantics_context(3))
    assert receiver.plan()["state"] == "receiver_capability_changed"
    assert not (checkout / ".agents/skills/example/SKILL.md").exists()
    assert receiver._applied() is None
    with pytest.raises(ProfileError) as error:
        receiver.once(revision)
    assert error.value.code == "receiver_capability_changed"
    assert not (checkout / ".agents/skills/example/SKILL.md").exists()
    assert receiver._applied() is None


def test_retired_missing_checkout_does_not_block_remaining_binding(scenario):
    import shutil

    receiver, publish, checkout, _, registry, target = scenario
    other = receiver.home / "other"
    other.mkdir()
    second = proposed_binding(registry, project="app", destination_key="other", harnesses=["codex"], manual=True)
    second["confirmation"] = receiver.profiles.confirm("other", second, other, installed={"codex"})
    target.project_bindings["other"] = second
    first = publish()
    assert receiver.once(first)["state"] == "applied"
    old = target.project_bindings.pop("main")
    target.retired_bindings["main"] = {"binding": old, "disposition": "retain"}
    shutil.rmtree(checkout)
    second_revision = publish(2, first)
    assert receiver.once(second_revision)["state"] == "applied"
    assert (other / ".agents/skills/example/SKILL.md").exists()


def test_inline_rollback_cannot_restore_into_replaced_checkout(scenario, monkeypatch):
    import shutil

    from skill_hub.application.loadout import loadout_receive
    from skill_hub.application.loadout.loadout_transaction import ReceiverTransaction

    receiver, publish, checkout, source, _, _ = scenario
    (source / "reference.md").write_text("Second file\n")
    revision = publish()

    def replace_after_write(event):
        if event == "after:0":
            moved = checkout.with_name("original")
            checkout.rename(moved)
            shutil.copytree(moved, checkout)
            raise RuntimeError("Later operation failed after checkout replacement")

    monkeypatch.setattr(
        loadout_receive,
        "ReceiverTransaction",
        lambda root, roots: ReceiverTransaction(root, roots, checkpoint=replace_after_write),
    )
    with pytest.raises(ProfileError) as error:
        receiver.once(revision)
    assert error.value.code == "partial_apply"
    # Identical bytes in the replacement do not authorize rolling them back.
    assert list(checkout.rglob("SKILL.md")) or list(checkout.rglob("reference.md"))
    assert receiver._applied() is None


def test_repeated_asset_budget_blocks_before_encoding_or_writes(scenario, monkeypatch):
    from skill_hub.application.loadout import loadout_transaction

    receiver, publish, checkout, source, registry, target = scenario
    other = receiver.home / "other"
    other.mkdir()
    binding = proposed_binding(registry, project="app", destination_key="other", harnesses=["codex"], manual=True)
    binding["confirmation"] = receiver.profiles.confirm("other", binding, other, installed={"codex"})
    target.project_bindings["other"] = binding
    publish()
    # One asset fits, but its two distinct destinations do not.
    encoded_size = 4 * ((len((source / "SKILL.md").read_bytes()) + 2) // 3)
    monkeypatch.setattr(loadout_transaction, "MAX_IMAGES", encoded_size, raising=False)

    def unexpected_encoding(*args, **kwargs):
        pytest.fail("Oversized expanded delivery reached image allocation")

    monkeypatch.setattr(loadout_transaction.base64, "b64encode", unexpected_encoding)
    preview = receiver.plan()
    assert preview["state"] == "invalid_write_plan"
    assert list(checkout.iterdir()) == list(other.iterdir()) == []
    assert not (receiver.root / "transaction.json").exists()


def test_configure_without_rotate_refuses_identity_change_on_applied_channel(scenario):
    receiver, publish, _, _, _, _ = scenario
    revision = publish()
    receiver.once(revision)
    channel_before = receiver._channel()
    applied_before = receiver._applied()
    with pytest.raises(ProfileError) as error:
        receiver.configure(channel_before["url"], "b" * 32, channel_before["pubkey"], 60)
    assert error.value.code == "channel_rotation_required"
    assert receiver._channel() == channel_before
    assert receiver._applied() == applied_before


def test_rotate_writes_paused_channel_with_cleared_approvals_and_keeps_applied(scenario, tmp_data_home, monkeypatch):
    import hub as hub_module
    from skill_hub.infrastructure.connectors.signing import key_id

    receiver, publish, checkout, source, registry, _ = scenario
    registry["skills"]["example"]["scope"] = "global"
    revision = publish()
    preview = receiver.plan()
    receiver.approve(preview["approval_digest"])
    receiver.once(revision)
    applied_before = receiver._applied()
    channel_before = receiver._channel()
    assert channel_before["approvals"]

    # Simulate a fresh Mac: a new controller signing key under a separate data home.
    new_home = tmp_data_home.parent / "new-mac-key"
    new_home.mkdir()
    monkeypatch.setenv("SKILL_HUB_HOME", str(new_home))
    hub_module._DATA_HOME_CACHE = None
    new_key = ensure_signing_key()
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_data_home))
    hub_module._DATA_HOME_CACHE = None

    rotated = receiver.configure(channel_before["url"], "b" * 32, new_key, 90, rotate=True)
    assert rotated["paused"] is True
    assert rotated["approvals"] == {}
    assert rotated["feed_id"] == "b" * 32
    assert rotated["pubkey"] == new_key.strip()
    assert receiver._applied() == applied_before
    assert receiver.status()["publisher_key_id"] == key_id(new_key)


def test_rotated_feed_grafts_onto_foreign_head_and_resumes_delivery(scenario, tmp_data_home, monkeypatch):
    import hub as hub_module

    receiver, publish, checkout, source, registry, target = scenario
    old_head = publish()
    receipt = receiver.once(old_head)
    assert receipt["state"] == "applied"
    delivered = checkout / ".agents/skills/example/SKILL.md"
    assert delivered.exists()

    # Simulate a fresh Mac: a new controller signing key under a separate data home.
    new_home = tmp_data_home.parent / "new-mac-graft"
    new_home.mkdir()
    monkeypatch.setenv("SKILL_HUB_HOME", str(new_home))
    hub_module._DATA_HOME_CACHE = None
    new_key = ensure_signing_key()

    channel = receiver._channel()
    rotated = receiver.configure(channel["url"], "c" * 32, new_key, 60, rotate=True)
    assert rotated["paused"] is True

    def factory(cache, url, receiver_id):
        return GitFeed(cache, url, receiver_id, allow_local=True)

    new_publisher = factory(tmp_data_home / "new-publisher", channel["url"], "box-a")
    projection, assets = compile_projection(
        registry, target, feed_id="c" * 32, generation=1, previous=old_head,
        codec_context=capture_loadout_codec_context(),
    )
    # This publish is signed with the new Mac's key (the current data home).
    new_head = new_publisher.publish(projection, assets, parent=old_head, replace_foreign=True)

    # Restore this test process's own signing key context.
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_data_home))
    hub_module._DATA_HOME_CACHE = None

    preview = receiver.plan()
    # This scenario has no native units and a project-scoped (not global)
    # binding, so a clean graft never needs a fresh native/global approval.
    assert preview["ok"] and preview["state"] == "ready"
    assert preview["candidate"]["feed_id"] == "c" * 32
    assert not any(item["action"] == "delete" for item in preview["changes"])

    receiver.pause(False)
    receipt = receiver.once(new_head)
    assert receipt["state"] == "applied"
    assert receiver._applied()["feed_id"] == "c" * 32
    assert delivered.exists()

    # A second call against the same revision observes no further work.
    assert receiver.once()["state"] == "unchanged"


def test_rotate_with_same_feed_id_but_a_new_key_clears_approvals(scenario, tmp_data_home, monkeypatch):
    import hub as hub_module

    receiver, publish, checkout, source, registry, _ = scenario
    registry["skills"]["example"]["scope"] = "global"
    revision = publish()
    preview = receiver.plan()
    receiver.approve(preview["approval_digest"])
    receiver.once(revision)
    channel_before = receiver._channel()
    assert channel_before["approvals"]

    # Simulate a fresh Mac: a new controller signing key under a separate data home.
    new_home = tmp_data_home.parent / "new-mac-samefeed"
    new_home.mkdir()
    monkeypatch.setenv("SKILL_HUB_HOME", str(new_home))
    hub_module._DATA_HOME_CACHE = None
    new_key = ensure_signing_key()
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_data_home))
    hub_module._DATA_HOME_CACHE = None

    rotated = receiver.configure(channel_before["url"], channel_before["feed_id"], new_key, 90, rotate=True)
    assert rotated["feed_id"] == channel_before["feed_id"]
    assert rotated["pubkey"] == new_key.strip()
    assert rotated["approvals"] == {}


def test_configure_checks_feed_before_recording_new_channel(scenario, monkeypatch):
    receiver, _, _, _, _, _ = scenario
    before = receiver.channel_path.read_bytes()
    channel = receiver._channel()

    def unavailable(self):
        raise ProfileError("feed_authentication_failed", "no access")

    monkeypatch.setattr(GitFeed, "fetch", unavailable)
    with pytest.raises(ProfileError, match="no access"):
        receiver.configure(channel["url"], channel["feed_id"], channel["pubkey"], 120)
    assert receiver.channel_path.read_bytes() == before


def test_headless_provider_can_be_prepared_before_its_first_session(tmp_data_home, monkeypatch):
    from skill_hub.application.loadout import loadout_receive

    home = tmp_data_home / "new-home"
    binary = home / ".local/bin/codex"
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\nexit 99\n")
    binary.chmod(0o755)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setattr(loadout_receive, "detect_installed", lambda: set())
    assert not (home / ".codex/config.toml").exists()
    receiver = Receiver(tmp_data_home / "receiver", home=home)
    assert "codex" in receiver.installed
    profiles = ReceiverProfiles(receiver.root)
    profiles.initialize("box-a")
    checkout = home / "project"
    checkout.mkdir()
    proposal = {"mode": "manual", "source_fingerprint": "a" * 64, "destination_key": "app", "harnesses": ["codex"]}
    assert profiles.confirm("app", proposal, checkout, installed=receiver.installed)["receiver_id"] == "box-a"


def test_first_session_provider_detection_uses_receiver_home_without_path(tmp_data_home, monkeypatch):
    from pathlib import Path

    from skill_hub.application.loadout.loadout_receive import installed_providers

    monkeypatch.setenv("HOME", str(tmp_data_home))
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(Path, "home", lambda: tmp_data_home)
    binary = tmp_data_home / ".local/bin/codex"
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    assert "codex" in installed_providers()
