"""Consumer-level native invocation acceptance, independent of variant naming."""
from __future__ import annotations

import argparse
import itertools
import json
import os
import platform
from pathlib import Path

import pytest
import yaml


def seed(tmp_data_home, monkeypatch, *, source_policy=None, targets=("codex",), scope="portable"):
    from skill_hub.infrastructure.harnesses import harnesses
    source = tmp_data_home / "skills" / "demo"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: demo\ndescription: Demo\n---\nBody\n")
    if source_policy is not None:
        (source / "agents").mkdir()
        (source / "agents" / "openai.yaml").write_text(source_policy)
    project = tmp_data_home / "project"
    project.mkdir()
    cfg = {"source": str(source), "type": "claude-skill", "scope": scope, "harnesses": list(targets)}
    registry = {"version": "1", "harnesses_global": list(targets), "skills": {"demo": cfg},
                "projects": {"p": {"path": str(project), "enabled": ["demo"], "bundles": [], "harnesses": []}},
                "bundles": {}}
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry))
    monkeypatch.setattr(harnesses, "detect_installed", lambda: set(targets))
    return source, project, registry


def set_mode(root, mode):
    import hub
    from skill_hub.entrypoints.cli.skill import register_set_meta_arguments
    parser = argparse.ArgumentParser()
    register_set_meta_arguments(parser)
    hub.cmd_set_meta(parser.parse_args(["demo", "--invocation", mode]))


def sync():
    import hub
    hub.cmd_sync(argparse.Namespace(skip_permissions=True, skip_remotes=True))


def policy(link):
    path = link / "agents" / "openai.yaml"
    if not path.exists():
        return True
    return yaml.safe_load(path.read_text()).get("policy", {}).get("allow_implicit_invocation", True)


def _seed_opencode_selection(monkeypatch):
    """Bind the synthetic OpenCode runtime used by command-delivery tests."""
    from skill_hub.application.harnesses import harness_operation_context, harness_runtime
    from skill_hub.domain.harnesses.harness_adapter_api import RuntimeIdentity, Version
    from skill_hub.infrastructure.harnesses import harness_probe

    inventory = harness_runtime.RuntimeInventory(
        (RuntimeIdentity(
            harness_id="opencode",
            installation_id="fixture-opencode",
            raw_version="1.18.31",
            version=Version(1, 18, 31),
            os_name=platform.system().lower(),
            architecture=platform.machine(),
            evidence="fixture",
        ),),
        "fixture-opencode-request",
        observed_at="2026-09-16T00:00:00+00:00",
    )
    observation = {
        "profile": "opencode-v1.18.31",
        "request_fingerprint": inventory.request_fingerprint,
        "installation_id": "fixture-opencode",
        "runtime_version": "1.18.31",
    }
    monkeypatch.setattr(harness_runtime, "inventory", lambda *a, **k: inventory)
    monkeypatch.setattr(harness_operation_context, "read_inventory_cache", lambda *a, **k: inventory)
    monkeypatch.setattr(
        harness_probe, "load_cached", lambda *a: {"invocation": {"opencode": observation}}
    )
    monkeypatch.setattr(
        harness_probe,
        "refresh_operation_capabilities",
        lambda *a, **k: {"invocation": {"opencode": observation}, "harnesses": {}},
    )


@pytest.mark.parametrize("first,second", itertools.permutations(("auto", "user-only", "model-only"), 2))
def test_each_library_transition_reaches_native_destination(tmp_data_home, monkeypatch, first, second):
    source, project, _ = seed(tmp_data_home, monkeypatch)
    set_mode(tmp_data_home, first)
    set_mode(tmp_data_home, second)
    link = project / ".agents" / "skills" / "demo"
    assert (link / "SKILL.md").is_file()
    assert policy(link) is (second != "user-only")
    assert not (source / "agents" / "openai.yaml").exists()
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert registry["skills"]["demo"]["harnesses"] == ["codex"]


def test_source_false_and_shared_claude_codex_survive_cleanup(tmp_data_home, monkeypatch):
    _, project, _ = seed(tmp_data_home, monkeypatch, source_policy="policy:\n  allow_implicit_invocation: false\n",
                         targets=("claude-code", "codex"))
    set_mode(tmp_data_home, "user-only")
    for folder in (".claude", ".agents"):
        assert (project / folder / "skills" / "demo" / "SKILL.md").is_file()
    assert policy(project / ".agents" / "skills" / "demo") is False


def test_full_second_sync_has_no_skill_artifact_writes(tmp_data_home, monkeypatch):
    _, project, _ = seed(tmp_data_home, monkeypatch)
    set_mode(tmp_data_home, "user-only")
    link = project / ".agents" / "skills" / "demo"
    paths = [link, link / "SKILL.md", link / "agents" / "openai.yaml"]
    before = [(p.lstat().st_mtime_ns, os.readlink(p) if p.is_symlink() else p.read_bytes()) for p in paths]
    sync()
    assert [(p.lstat().st_mtime_ns, os.readlink(p) if p.is_symlink() else p.read_bytes()) for p in paths] == before
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert report["projects"]["p"]["writes"] == 0
    assert report["projects"]["p"]["removed"] == 0


def test_rollback_reconciles_native_links_without_changing_intent(tmp_data_home, monkeypatch):
    from scripts.reconcile_native_invocation import reconcile

    source, project, registry = seed(tmp_data_home, monkeypatch)
    registry["projects"]["p"]["invocation_overrides"] = {"demo": "user-only"}
    registry_path = tmp_data_home / "registry.yaml"
    registry_path.write_text(yaml.safe_dump(registry))
    sync()
    before = registry_path.read_bytes()
    source_before = (source / "SKILL.md").read_bytes()
    link = project / ".agents" / "skills" / "demo"
    native_target = link.resolve()
    assert policy(link) is False
    preview = reconcile(registry)
    assert preview["links"] and not preview["errors"]
    assert link.resolve() == native_target
    result = reconcile(registry, apply=True)
    assert not result["errors"]
    assert link.resolve().name == "demo@user-only"
    assert "disable-model-invocation: true" in (link / "SKILL.md").read_text()
    assert not (link / "agents" / "openai.yaml").exists()
    assert not native_target.exists()
    assert registry_path.read_bytes() == before
    assert (source / "SKILL.md").read_bytes() == source_before


def test_opencode_command_is_removed_when_harness_is_no_longer_targeted(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses

    _, project, _ = seed(tmp_data_home, monkeypatch, targets=("opencode",))
    _seed_opencode_selection(monkeypatch)
    set_mode(tmp_data_home, "user-only")
    command = project / ".opencode" / "commands" / "demo.md"
    assert command.is_symlink()
    payload = command.resolve()
    registry_path = tmp_data_home / "registry.yaml"
    registry = yaml.safe_load(registry_path.read_text())
    registry["harnesses_global"] = ["codex"]
    registry["skills"]["demo"]["harnesses"] = ["codex"]
    registry_path.write_text(yaml.safe_dump(registry))
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"codex"})
    sync()
    assert not command.is_symlink()
    assert not payload.exists()
    assert policy(project / ".agents" / "skills" / "demo") is False


def test_consumer_publication_failure_keeps_last_good_link(tmp_data_home, monkeypatch):
    _, project, _ = seed(tmp_data_home, monkeypatch)
    set_mode(tmp_data_home, "user-only")
    link = project / ".agents" / "skills" / "demo"
    previous = os.readlink(link)
    replace = os.replace
    def fail_publication(source, destination):
        if Path(destination) == link:
            assert os.readlink(link) == previous
            raise OSError("injected publication failure")
        return replace(source, destination)
    monkeypatch.setattr(os, "replace", fail_publication)
    set_mode(tmp_data_home, "model-only")
    assert os.readlink(link) == previous
    assert policy(link) is False
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    row = report["projects"]["p"]["invocation"][0]
    assert row["delivery"] == "failed"
    assert row["requested_mode"] == "model-only"
    assert row["applied_mode"] == "user-only"


@pytest.mark.parametrize("policy_text", [None, "policy:\n  allow_implicit_invocation: false\n"])
def test_mixed_project_override_keeps_each_destination_live(tmp_data_home, monkeypatch, policy_text):
    _, project, registry = seed(tmp_data_home, monkeypatch, source_policy=policy_text,
                               targets=("claude-code", "codex", "pi"))
    registry["projects"]["p"]["invocation_overrides"] = {"demo": "user-only"}
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry))
    sync()
    for folder in (".claude", ".agents"):
        link = project / folder / "skills" / "demo"
        assert (link / "SKILL.md").is_file(), str(link)
        assert "disable-model-invocation: true" in (link / "SKILL.md").read_text()
    assert policy(project / ".agents" / "skills" / "demo") is False


def test_source_directory_symlink_changes_stale_native_evidence(tmp_data_home, monkeypatch):
    from dataclasses import replace

    from skill_hub.application.harnesses import harness_operation_context
    from skill_hub.entrypoints.cli.skill import invocation_status
    source, _, _ = seed(tmp_data_home, monkeypatch)
    assets = tmp_data_home / "external-assets"
    assets.mkdir()
    native = assets / "openai.yaml"
    native.write_text("policy: {allow_implicit_invocation: true}\n")
    (source / "agents").symlink_to(assets, target_is_directory=True)
    set_mode(tmp_data_home, "user-only")
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    context = harness_operation_context.build_operation_context(
        tmp_data_home,
        ("codex",),
        requested_features=("skills", "invocation"),
        installed_harness_ids=("codex",),
    )
    context = replace(
        context, invocation_observations={"codex": {"profile": "codex-policy"}}
    )
    before = invocation_status(registry, "demo", "p", operation_context=context)
    assert before["outcomes"][0]["delivery"] in {"applied", "unchanged"}
    native.write_text("policy: {allow_implicit_invocation: false}\n")
    after = invocation_status(registry, "demo", "p", operation_context=context)
    assert after["outcomes"][0]["delivery"] == "pending"
    assert after["outcomes"][0]["input_fingerprint"] != before["outcomes"][0]["input_fingerprint"]


def test_global_library_default_creates_native_policy_and_rolls_up_failure(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses
    source, _, _ = seed(tmp_data_home, monkeypatch, scope="global")
    set_mode(tmp_data_home, "user-only")
    link = Path(str(harnesses.HARNESSES["codex"].global_skills_dir)).expanduser() / "demo"
    assert policy(link) is False
    assert not (source / "agents" / "openai.yaml").exists()
    (source / "agents").mkdir()
    (source / "agents" / "openai.yaml").write_text("policy: [bad\n")
    previous = os.readlink(link)
    sync()
    assert os.readlink(link) == previous
    assert policy(link) is False
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert report["global"]["skills"]["ok"] is False
    assert report["global"]["skills"]["invocation"][0]["applied_mode"] == "user-only"
    assert report["ok"] is False


def test_native_yaml_file_symlink_and_siblings_remain_source_owned(tmp_data_home, monkeypatch):
    source, project, _ = seed(tmp_data_home, monkeypatch)
    (source / "agents").mkdir()
    external = tmp_data_home / "policy.yaml"
    external.write_text('interface: {display_name: "Demo"}\npolicy: {allow_implicit_invocation: true}\n')
    native = source / "agents" / "openai.yaml"
    native.symlink_to(external)
    companion = source / "agents" / "helper.md"
    companion.write_text("old")
    set_mode(tmp_data_home, "user-only")
    delivered = project / ".agents" / "skills" / "demo"
    assert policy(delivered) is False
    assert native.is_symlink() and "true" in external.read_text()
    companion.unlink()
    (source / "agents" / "new.md").write_text("new")
    sync()
    assert (delivered / "agents" / "new.md").read_text() == "new"
    assert not (delivered / "agents" / "helper.md").exists()
    assert native.is_symlink() and "true" in external.read_text()


@pytest.mark.parametrize("scope", ["portable", "global"])
def test_native_delivery_survives_cleanup_through_data_home_alias(tmp_data_home, monkeypatch, scope):
    import hub
    from skill_hub.infrastructure.harnesses import harnesses

    alias = tmp_data_home.parent / (tmp_data_home.name + "-alias")
    alias.symlink_to(tmp_data_home, target_is_directory=True)
    monkeypatch.setenv("SKILL_HUB_HOME", str(alias))
    hub._DATA_HOME_CACHE = None
    source, project, _ = seed(alias, monkeypatch, scope=scope)
    set_mode(alias, "user-only")
    link = (project / ".agents" / "skills" / "demo" if scope == "portable" else
            Path(str(harnesses.HARNESSES["codex"].global_skills_dir)).expanduser() / "demo")
    assert (link / "SKILL.md").is_file()
    assert policy(link) is False
    assert not (source / "agents" / "openai.yaml").exists()

    orphan = alias / "state" / "skill_variants" / "unused@user-only"
    orphan.mkdir()
    sync()
    assert not orphan.exists()
    assert (link / "SKILL.md").is_file()
    assert policy(link) is False
