"""Publication success and receiver application are separate durable facts."""

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from test_loadout_receive import scenario as receiver_scenario

from skill_hub.application.loadout.loadout_publish import last_result, publish, result_path
from skill_hub.domain.loadout.loadout_profiles import ProfileError
from skill_hub.infrastructure.loadout.loadout_feed import GitFeed
from skill_hub.infrastructure.remotes.remotes import RemoteTarget

scenario = receiver_scenario


def configured(scenario):
    receiver, _, checkout, source, registry, target = scenario
    channel = receiver._channel()
    value = target.to_dict()
    value["transport"] = {
        "receiver_ready": True,
        "loadout_feed": {"url": channel["url"], "feed_id": channel["feed_id"]},
    }

    def factory(cache, url, identity):
        return GitFeed(cache, url, identity, allow_local=True)

    return receiver, registry, RemoteTarget.from_dict(target.id, value), factory, source


def add_native_mcp(registry):
    registry["skills"]["search"] = {"type": "mcp-server", "mcp": {"command": "python3"}}
    registry["projects"]["app"]["enabled"].append("search")


def test_offline_then_immediate_receipt_reuses_publication(scenario):
    receiver, registry, target, factory, _ = configured(scenario)

    def offline(*args):
        raise OSError("offline")

    first = publish(registry, target, feed_factory=factory, control=offline)
    assert first["state"] == "published_waiting_for_receiver" and first["applied"] is None
    assert last_result(target.id)["published"] == first["published"]
    second = publish(registry, target, feed_factory=factory, control=lambda target, args: receiver.once(args[-1]))
    assert second["state"] == "applied" and second["published"] == first["published"]
    assert second["applied"]["revision"] == first["published"]["revision"]
    assert last_result(target.id) == second


def test_drift_remains_blocked_and_keeps_last_applied_revision(scenario):
    receiver, registry, target, factory, source = configured(scenario)

    def control(target, args):
        return receiver.once(args[-1])

    first = publish(registry, target, feed_factory=factory, control=control)
    native = next(iter(first["applied"]["files"]))
    from pathlib import Path

    Path(native).write_text("local edit")
    (source / "SKILL.md").write_text("---\nname: example\ndescription: Example\n---\nChanged\n")
    second = publish(registry, target, feed_factory=factory, control=control)
    assert not second["ok"] and second["state"] == "blocked_drift"
    assert second["applied"]["revision"] == first["applied"]["revision"]
    assert second["published"]["revision"] != first["published"]["revision"]
    assert Path(native).read_text() == "local edit"
    assert last_result(target.id) == second


def test_corrupt_receipt_blocks_before_network(scenario):
    _, registry, target, _, _ = configured(scenario)
    path = result_path(target.id)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"target": target.id, "published": {}}))
    with pytest.raises(ProfileError) as error:
        publish(registry, target, feed_factory=lambda *a: pytest.fail("no network"))
    assert error.value.code == "controller_receipt_invalid"


def test_wrong_revision_is_never_claimed_applied(scenario):
    receiver, registry, target, factory, _ = configured(scenario)

    def bad_receipt(target, args):
        receipt = receiver.once(args[-1])
        receipt["applied"]["revision"] = "0" * 40
        return receipt

    result = publish(registry, target, feed_factory=factory, control=bad_receipt)
    assert result["state"] == "published_waiting_for_receiver" and result["applied"] is None
    assert result["error"]["code"] == "receiver_protocol_invalid"


def test_native_unmanaged_existing_remains_a_blocked_receipt(scenario):
    from skill_hub.domain.loadout.loadout_native_codec import capabilities, capture_loadout_codec_context

    receiver, registry, target, factory, _ = configured(scenario)
    registry["skills"]["search"] = {"type": "mcp-server", "mcp": {"command": "python3"}}
    registry["projects"]["app"]["enabled"].append("search")
    config = receiver.home / "project/.codex/config.toml"
    config.parent.mkdir()
    config.write_text('[mcp_servers.search]\ncommand="local"\n')

    def control(target, args):
        if args == ["inspect"]:
            return {"native": capabilities(capture_loadout_codec_context()), "profile": receiver.profiles.read()}
        return receiver.once(args[-1])

    result = publish(registry, target, feed_factory=factory, control=control)
    assert result["state"] == "unmanaged_existing" and not result["ok"]
    assert result["error"]["code"] == "unmanaged_existing" and not result["error"]["retryable"]
    assert result["applied"] is None and result["published"]
    assert "local" in config.read_text()


def test_native_wrong_receiver_identity_blocks_before_feed(scenario):
    from skill_hub.domain.loadout.loadout_native_codec import capabilities, capture_loadout_codec_context

    receiver, registry, target, _, _ = configured(scenario)
    registry["skills"]["search"] = {"type": "mcp-server", "mcp": {"command": "python3"}}
    registry["projects"]["app"]["enabled"].append("search")
    profile = receiver.profiles.read()
    profile["receiver_id"] = "wrong-box"
    result = publish(
        registry,
        target,
        control=lambda *a: {"native": capabilities(capture_loadout_codec_context()), "profile": profile},
        feed_factory=lambda *a: pytest.fail("must not access feed"),
    )
    assert result["state"] == "receiver_capability_changed" and result["published"] is None


def test_controller_capture_is_once_per_native_publication(scenario, monkeypatch):
    receiver, registry, target, factory, _ = configured(scenario)
    from skill_hub.domain.loadout import loadout_native_codec

    add_native_mcp(registry)
    context = loadout_native_codec.capture_loadout_codec_context()
    captures = []
    capability_contexts = []
    real_capabilities = loadout_native_codec.capabilities
    monkeypatch.setattr(
        loadout_native_codec,
        "capture_loadout_codec_context",
        lambda: captures.append(context) or context,
    )
    monkeypatch.setattr(
        loadout_native_codec,
        "capabilities",
        lambda observed: capability_contexts.append(observed) or real_capabilities(observed),
    )
    result = publish(
        registry,
        target,
        feed_factory=factory,
        immediate=False,
        control=lambda target, args: {
            "native": loadout_native_codec.capabilities(context),
            "profile": receiver.profiles.read(),
        },
    )
    assert result["published"] and captures == [context]
    assert result["published"]["generation"] == 1
    assert capability_contexts == [context, context, context]


def test_receiver_capture_is_once_and_shared_by_native_compare_and_render(scenario, monkeypatch):
    receiver, registry, _, _, _ = configured(scenario)
    receiver_publish = scenario[1]
    add_native_mcp(registry)
    revision = receiver_publish()
    from skill_hub.domain.loadout import loadout_native_codec

    calls = set()
    base = loadout_native_codec.capture_loadout_codec_context()

    class RecordingMcp:
        def __init__(self, inner):
            self.inner = inner

        def encode(self, request):
            calls.add("mcp.encode")
            return self.inner.encode(request)

    context = replace(base, mcp={key: RecordingMcp(codec) for key, codec in base.mcp.items()})
    captures = []
    capability_contexts = []
    real_capabilities = loadout_native_codec.capabilities
    monkeypatch.setattr(
        loadout_native_codec,
        "capture_loadout_codec_context",
        lambda: captures.append(context) or context,
    )
    monkeypatch.setattr(
        loadout_native_codec,
        "capabilities",
        lambda observed: capability_contexts.append(observed) or real_capabilities(observed),
    )
    preview = receiver.plan()
    assert preview["candidate"]["schema"] == 2
    assert captures == [context]
    assert capability_contexts == [context, context]
    assert "mcp.encode" in calls
    assert real_capabilities(base)["digest"] == real_capabilities(context)["digest"]
    assert revision == preview["candidate"]["revision"]


def test_publisher_appends_current_native_generation_to_signed_semantics3_parent(scenario, tmp_data_home):
    from skill_hub.domain.loadout.loadout_native_codec import CAPABILITIES, capabilities, capture_loadout_codec_context
    from skill_hub.domain.loadout.loadout_projection import compile_projection

    receiver, registry, target, factory, _ = configured(scenario)
    add_native_mcp(registry)
    capability = dict(CAPABILITIES)
    capability["native_semantics"] = 3
    legacy_context = capture_loadout_codec_context(capability=capability)
    channel = receiver._channel()
    legacy_projection, legacy_assets = compile_projection(
        registry,
        target,
        feed_id=channel["feed_id"],
        generation=1,
        previous=None,
        codec_context=legacy_context,
    )
    legacy_feed = factory(tmp_data_home / "legacy-publisher", channel["url"], target.id)
    legacy = legacy_feed.publish(legacy_projection, legacy_assets, parent=None)
    assert legacy_projection["schema"] == 2
    assert legacy_projection["capabilities"] == capabilities(legacy_context)["digest"]

    current_context = capture_loadout_codec_context()
    result = publish(
        registry,
        target,
        immediate=False,
        feed_factory=factory,
        control=lambda target, args: {
            "native": capabilities(current_context),
            "profile": receiver.profiles.read(),
        },
    )
    assert result["ok"] and result["published"]["generation"] == 2
    current = result["published"]["revision"]
    assert legacy_feed.fetch() == current
    projection, _ = legacy_feed.read(current, channel["pubkey"])
    assert projection["schema"] == 2
    assert projection["capabilities"] == capabilities(current_context)["digest"]
    assert projection["previous"] == legacy


def test_cli_inspect_captures_native_context_once(tmp_data_home, monkeypatch):
    import skill_hub.entrypoints.cli.receive
    from skill_hub import hub_core
    from skill_hub.domain.loadout import loadout_native_codec
    from skill_hub.domain.loadout.loadout_profiles import ReceiverProfiles

    monkeypatch.setattr(hub_core, "data_home", lambda: tmp_data_home)
    root = tmp_data_home / "state/loadouts"
    ReceiverProfiles(root).initialize("box-a")
    context = loadout_native_codec.capture_loadout_codec_context()
    captures = []
    monkeypatch.setattr(
        loadout_native_codec,
        "capture_loadout_codec_context",
        lambda: captures.append(context) or context,
    )
    skill_hub.entrypoints.cli.receive.dispatch(SimpleNamespace(receive_cmd="inspect", json=True))
    assert captures == [context]


@pytest.mark.parametrize("providers", [{"codex"}, {"codex", "claude-code"}, {"codex", "pi"}])
def test_model_only_publishes_and_applies_with_a_reported_provider_limitation(scenario, providers):
    from skill_hub.infrastructure.registry.loadout_bindings import proposed_binding

    receiver, registry, target, factory, source = configured(scenario)
    receiver.installed = providers
    binding = proposed_binding(registry, project="app", destination_key="app", harnesses=sorted(providers), manual=True)
    binding["confirmation"] = receiver.profiles.confirm("main", binding, receiver.home / "project", installed=providers)
    target.project_bindings["main"] = binding
    registry["skills"]["example"]["invocation"] = "model-only"
    policy = source / "agents/openai.yaml"
    policy.parent.mkdir()
    policy.write_text("policy:\n  allow_implicit_invocation: false\n")
    result = publish(
        registry, target, feed_factory=factory,
        control=lambda target, args: receiver.once(args[-1]),
    )
    assert result["ok"] and result["state"] == "applied"
    assert result["error"] is None
    assert result["applied"]["revision"] == result["published"]["revision"]
    outcome = result["invocation"][0]
    assert outcome["support"] == "unsupported" and outcome["harness"] == "codex"
    assert outcome["requested_mode"] == "model-only"
    assert outcome["implicit_behavior"] == "enabled"
    assert outcome["explicit_behavior"] == "available"
    assert outcome["limitations"]
    assert last_result(target.id)["invocation"] == result["invocation"]
    delivered = receiver.home / "project/.agents/skills/example/agents/openai.yaml"
    from skill_hub.application.skills.skill_invocation import codex_implicit

    assert codex_implicit(delivered.read_bytes()) is True
    assert codex_implicit(policy.read_bytes()) is False


def test_invocation_receipt_is_backward_compatible_and_validated(scenario):
    _, registry, target, factory, _ = configured(scenario)
    result = publish(registry, target, feed_factory=factory, immediate=False)
    result.pop("invocation")
    result.pop("invocation_total")
    result.pop("native_limitations")
    result_path(target.id).write_text(json.dumps(result))
    assert last_result(target.id) == result
    result["invocation"] = "corrupt"
    result["invocation_total"] = 1
    result_path(target.id).write_text(json.dumps(result))
    with pytest.raises(ProfileError) as error:
        last_result(target.id)
    assert error.value.code == "controller_receipt_invalid"


def test_invocation_report_is_bounded_without_losing_the_total():
    from skill_hub.application.loadout.loadout_publish import _invocation_report
    from skill_hub.application.skills.skill_invocation import render_native_invocation

    _, rows = render_native_invocation("example", {"codex"}, "model-only", None)
    report = _invocation_report(rows * 300)
    assert len(report["invocation"]) == 256
    assert report["invocation_total"] == 300


@pytest.mark.parametrize("rows", [
    "corrupt", [{}], [{"area": "mcp", "harness": "codex", "name": "server", "message": 42}],
])
def test_invalid_native_limitation_receipt_is_rejected(scenario, rows):
    _, registry, target, factory, _ = configured(scenario)
    result = publish(registry, target, feed_factory=factory, immediate=False)
    result["native_limitations"] = rows
    result_path(target.id).write_text(json.dumps(result))
    with pytest.raises(ProfileError, match="observation"):
        last_result(target.id)


def test_preview_names_nonportable_hook_without_exposing_its_command(scenario):
    receiver, registry, target, factory, _ = configured(scenario)
    binding = target.project_bindings['main']
    binding['harnesses'] = ['claude-code', 'codex']
    binding['confirmation'] = receiver.profiles.confirm(
        'main', binding, scenario[2], installed={'claude-code', 'codex'}
    )
    registry['hooks'] = {'resume-example': {
        'event': 'UserPromptSubmit',
        'command': 'python3 ~/.skill-hub/hooks/example.py secret-do-not-show',
    }}
    registry['projects']['app']['hooks'] = ['resume-example']
    result = publish(registry, target, immediate=False, feed_factory=factory)
    assert result['state'] == 'native_unportable_path'
    assert 'resume-example' in result['error']['message']
    assert 'managed script' in result['error']['message']
    assert 'secret-do-not-show' not in json.dumps(result)
    assert '~/.skill-hub' not in json.dumps(result)
    assert result['published'] is None
    assert last_result(target.id) == result


def test_replace_feed_publishes_generation_one_on_a_foreign_head(scenario, tmp_data_home, monkeypatch):
    import subprocess

    import hub as hub_module
    from skill_hub.infrastructure.connectors.signing import ensure_signing_key

    receiver, registry, target, factory, _ = configured(scenario)

    def control(target, args):
        return receiver.once(args[-1])

    # The prior Mac's own publication, signed with this test process's key.
    first = publish(registry, target, feed_factory=factory, control=control)
    old_head = first["published"]["revision"]
    channel_url = target.transport["loadout_feed"]["url"]

    # Simulate a fresh Mac: point signing at a second, separate data home so
    # the graft target (old_head) is signed by a genuinely different key.
    new_home = tmp_data_home.parent / "new-mac-publish"
    new_home.mkdir()
    monkeypatch.setenv("SKILL_HUB_HOME", str(new_home))
    hub_module._DATA_HOME_CACHE = None
    new_key = ensure_signing_key()

    # A new feed id, as if this machine reconnected with a fresh identity.
    value = target.to_dict()
    new_feed_id = "c" * 32
    value["transport"]["loadout_feed"]["feed_id"] = new_feed_id
    reconnected_target = RemoteTarget.from_dict(target.id, value)

    result = publish(
        registry, reconnected_target, feed_factory=factory, immediate=False, replace_feed=True
    )
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_data_home))
    hub_module._DATA_HOME_CACHE = None

    assert result["ok"] and result["published"]["generation"] == 1
    assert result["published"]["feed_id"] == new_feed_id
    new_head = result["published"]["revision"]
    assert new_head != old_head

    parents = subprocess.check_output(
        ["git", "--git-dir", channel_url, "rev-list", "--parents", "-n", "1", new_head]
    ).strip().decode().split()[1:]
    assert parents == [old_head]

    # A Receiver-style read, pinned to the new Mac's key, accepts the graft.
    reading_feed = factory(tmp_data_home / "reader", channel_url, target.id)
    assert reading_feed.fetch() == new_head
    projection, _ = reading_feed.read(new_head, new_key)
    assert projection["feed_id"] == new_feed_id and projection["generation"] == 1


def test_replace_feed_with_an_own_chain_head_continues_normally(scenario):
    receiver, registry, target, factory, source = configured(scenario)

    def control(target, args):
        return receiver.once(args[-1])

    first = publish(registry, target, feed_factory=factory, control=control)
    old_head = first["published"]["revision"]

    # Drop the saved receipt so the "published" prior pointer is unknown,
    # as if local state were lost, while the branch head is still our own.
    result_path(target.id).unlink()
    (source / "SKILL.md").write_text("---\nname: example\ndescription: Example\n---\nUpdated\n")

    result = publish(registry, target, feed_factory=factory, immediate=False, replace_feed=True)
    assert result["ok"] and result["error"] is None
    assert result["published"]["feed_id"] == target.transport["loadout_feed"]["feed_id"]
    assert result["published"]["generation"] == 2
    assert result["published"]["revision"] != old_head


def test_replace_feed_false_on_a_foreign_head_raises_feed_reconnect_required(scenario):
    receiver, registry, target, factory, _ = configured(scenario)

    def control(target, args):
        return receiver.once(args[-1])

    publish(registry, target, feed_factory=factory, control=control)

    value = target.to_dict()
    new_feed_id = "c" * 32
    value["transport"]["loadout_feed"]["feed_id"] = new_feed_id
    reconnected_target = RemoteTarget.from_dict(target.id, value)

    result = publish(registry, reconnected_target, feed_factory=factory, immediate=False)
    assert result["state"] == "feed_reconnect_required"
    assert result["error"]["code"] == "feed_reconnect_required"
    assert "Reconnect the receiver" in result["error"]["message"]


def test_transient_feed_unavailable_from_accept_is_re_raised_not_grafted(scenario, monkeypatch):
    receiver, registry, target, factory, _ = configured(scenario)

    def control(target, args):
        return receiver.once(args[-1])

    publish(registry, target, feed_factory=factory, control=control)

    value = target.to_dict()
    new_feed_id = "c" * 32
    value["transport"]["loadout_feed"]["feed_id"] = new_feed_id
    reconnected_target = RemoteTarget.from_dict(target.id, value)

    def flaky_accept(self, *args, **kwargs):
        raise ProfileError("feed_unavailable", "Git could not access the loadout feed.")

    monkeypatch.setattr(GitFeed, "accept", flaky_accept)
    result = publish(
        registry, reconnected_target, feed_factory=factory, immediate=False, replace_feed=True
    )
    assert not result["ok"]
    assert result["state"] == "feed_unavailable"


def test_saved_result_with_a_different_feed_id_is_ignored_as_prior(scenario, tmp_data_home):
    import subprocess

    _, registry, target, factory, _ = configured(scenario)

    stale = {
        "ok": True,
        "target": target.id,
        "state": "published_waiting_for_receiver",
        "desired": {"digest": "a" * 64},
        "published": {"revision": "b" * 40, "generation": 3, "feed_id": "a" * 32, "digest": "c" * 64},
        "applied": None,
        "observed_at": None,
        "bindings": [],
        "error": None,
    }
    result_path(target.id).parent.mkdir(parents=True, exist_ok=True)
    result_path(target.id).write_text(json.dumps(stale))

    # The configured feed id now differs from the stale published record, and
    # the branch for this fresh feed id has never been published.
    fresh_remote = tmp_data_home / "fresh-feed.git"
    subprocess.run(["git", "init", "--bare", "--quiet", str(fresh_remote)], check=True)
    value = target.to_dict()
    value["transport"]["loadout_feed"] = {"url": str(fresh_remote), "feed_id": "c" * 32}
    reconnected_target = RemoteTarget.from_dict(target.id, value)

    # The saved published record belongs to the old feed id and must not be
    # treated as a prior; an empty branch for the new feed id must not raise
    # "the previously published feed ref is missing".
    result = publish(registry, reconnected_target, feed_factory=factory, immediate=False)
    assert result["state"] != "feed_integrity_error"
    assert result["ok"] and result["published"]["generation"] == 1
    assert result["published"]["feed_id"] == "c" * 32


def test_setup_required_keeps_its_curated_message(scenario):
    _, registry, target, factory, _ = configured(scenario)
    value = target.to_dict()
    value["transport"] = {}
    incomplete_target = RemoteTarget.from_dict(target.id, value)
    result = publish(registry, incomplete_target, feed_factory=factory, immediate=False)
    assert result["state"] == "setup_required"
    assert result["error"]["message"] == "Finish receiver onboarding before publishing."


def test_source_failure_names_asset_without_disclosing_external_content(scenario):
    _, registry, target, factory, source = configured(scenario)
    outside = source.parent / 'private.txt'
    outside.write_text('secret-do-not-show')
    (source / 'reference.md').symlink_to(outside)
    result = publish(registry, target, immediate=False, feed_factory=factory)
    assert result['state'] == 'unsupported_source'
    assert "skill 'example'" in result['error']['message']
    assert 'reference.md' in result['error']['message']
    assert 'registered skill source' in result['error']['message']
    assert 'secret-do-not-show' not in json.dumps(result)
    assert str(outside) not in json.dumps(result)
    assert result['published'] is None
