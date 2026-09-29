"""Focused delivery tests for native Codex invocation artifacts."""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

import pytest
import yaml


@pytest.fixture(autouse=True)
def _isolated_opencode_environment(monkeypatch):
    """Keep native command discovery inside pytest's fake home."""
    for name in (
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_CONFIG_CONTENT",
    ):
        monkeypatch.delenv(name, raising=False)


def _skill(
    root: Path,
    name: str = "alpha",
    *,
    yaml_text: str | None = None,
    invocation: str | None = None,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    frontmatter = f"---\nname: {name}\ndescription: t\n"
    if invocation == "user-only":
        frontmatter += "disable-model-invocation: true\n"
    frontmatter += "---\n\n# Body\n"
    (root / "SKILL.md").write_text(frontmatter)
    agents = root / "agents"
    agents.mkdir(exist_ok=True)
    if yaml_text is not None:
        (agents / "openai.yaml").write_text(yaml_text)
    (agents / "README.md").write_text("keep me\n")
    return root


def _cfg(src: Path, **extra: object) -> dict:
    value = {
        "version": "1.0.0",
        "description": "",
        "source": str(src),
        "type": "claude-skill",
        "scope": "portable",
        "upstream": None,
    }
    value.update(extra)
    return value


def _setup(data_home: Path, src: Path, project: Path, **cfg_extra: object) -> None:
    project.mkdir(parents=True, exist_ok=True)
    invocation = cfg_extra.get("invocation")
    if invocation == "user-only":
        text = (src / "SKILL.md").read_text()
        text = text.replace(
            "description: t\n", "description: t\ndisable-model-invocation: true\n"
        )
        (src / "SKILL.md").write_text(text)
    elif invocation == "model-only":
        text = (src / "SKILL.md").read_text()
        text = text.replace(
            "description: t\n", "description: t\nuser-invocable: false\n"
        )
        (src / "SKILL.md").write_text(text)
    registry = {
        "version": "1",
        "harnesses_global": ["codex"],
        "skills": {"alpha": _cfg(src, **cfg_extra)},
        "projects": {
            "p1": {
                "path": str(project),
                "enabled": ["alpha"],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


@pytest.fixture
def codex_env(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses

    global_root = tmp_data_home / "globals"
    patched = {}
    for harness_id, harness in harnesses.HARNESSES.items():
        patched[harness_id] = dataclasses.replace(
            harness,
            detect=lambda harness_id=harness_id: harness_id == "codex",
            global_skills_dir=type(harness.global_skills_dir)(
                str(global_root / harness_id / "skills")
            ),
        )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    return tmp_data_home


def _sync() -> None:
    import hub

    hub.cmd_sync(argparse.Namespace(skip_permissions=True, skip_remotes=True))


class _UnavailableOpenCodeContext:
    """Selection context used to exercise fail-closed cleanup behavior."""

    def __init__(self, harness_ids=("opencode",)):
        from skill_hub import hub_core
        from skill_hub.infrastructure.harnesses import harnesses, opencode_invocation

        self.harness_ids = tuple(harness_ids)
        self.installed_harness_ids = self.harness_ids
        self.data_home = str(hub_core.data_home())
        self.opencode_paths = opencode_invocation.capture_native_paths(
            data_home=hub_core._resolve_data_home_path()
        )
        self.layouts = {
            harness_id: harnesses.HARNESSES[harness_id]
            for harness_id in self.harness_ids
            if harness_id in harnesses.HARNESSES
        }
        self.invocation_observations = {}

    def layout(self, harness_id):
        return self.layouts.get(harness_id)

    def route(self, harness_id, feature):
        return type(
            "Route",
            (),
            {"status": "shadow", "mode": "legacy_shadow", "adapter_key": None},
        )()

    def trusted_invocation_profile(self, harness_id):
        return None if harness_id == "opencode" else "codex-policy"

    def trusted_invocation_resolver(self, harness_id):
        return None


def _patch_harness_layouts(monkeypatch, roots: dict[str, Path], installed: set[str]) -> None:
    from skill_hub.infrastructure.harnesses import harnesses

    patched = {
        harness_id: dataclasses.replace(
            harness,
            detect=lambda harness_id=harness_id: harness_id in installed,
            global_skills_dir=type(harness.global_skills_dir)(
                str(roots.get(harness_id, roots["shared"]) / "skills")
            ),
        )
        for harness_id, harness in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)


def _owned_command_fixture(source: Path, project: Path | None, monkeypatch):
    from skill_hub import hub_core
    from skill_hub.infrastructure.harnesses import opencode_invocation

    hub_core._DATA_HOME_CACHE = None
    source_name = source.name
    removable_links = set()
    if project is not None:
        ordinary_link = project / ".agents" / "skills" / source_name
        if ordinary_link.is_symlink():
            removable_links.add(ordinary_link)
    with monkeypatch.context() as provisioning_patch:
        provisioning_patch.setattr(
            opencode_invocation,
            "_project_ancestors",
            lambda path: [path] if path is not None else [],
        )
        plan = opencode_invocation.plan_command(
            source_name,
            source,
            project_path=project,
            target_harnesses={"opencode"},
            profile=opencode_invocation.SUPPORTED_PROFILE,
            removable_links=removable_links,
        )
        assert plan["eligible"], plan
        assert opencode_invocation.apply_command(plan) == 2
    return plan


def _seed_opencode_selection(monkeypatch):
    """Give the coordinator one exact synthetic runtime and bound observation."""
    import platform

    from skill_hub.application.harnesses import harness_operation_context, harness_runtime
    from skill_hub.domain.harnesses.harness_adapter_api import RuntimeIdentity, Version
    from skill_hub.infrastructure.harnesses import harness_probe

    inventory = harness_runtime.RuntimeInventory(
        (
            RuntimeIdentity(
                harness_id="opencode",
                installation_id="fixture-opencode",
                raw_version="1.18.31",
                version=Version(1, 18, 31),
                os_name=platform.system().lower(),
                architecture=platform.machine(),
                evidence="fixture",
            ),
        ),
        "fixture-opencode-request",
        observed_at="2026-09-16T00:00:00+00:00",
    )
    observation = {
        "profile": "opencode-v1.18.31",
        "request_fingerprint": inventory.request_fingerprint,
        "installation_id": "fixture-opencode",
        "runtime_version": "1.18.31",
    }
    monkeypatch.setattr(harness_runtime, "inventory", lambda *args, **kwargs: inventory)
    # Sync and read-only previews consume the same synthetic cached evidence.
    monkeypatch.setattr(harness_operation_context, "read_inventory_cache", lambda *a, **k: inventory)
    monkeypatch.setattr(harness_probe, "load_cached", lambda *a: {"invocation": {"opencode": observation}})
    monkeypatch.setattr(
        harness_probe,
        "cached_invocations",
        lambda data_home=None: {"opencode": dict(observation)},
    )
    monkeypatch.setattr(
        harness_probe,
        "refresh_invocations",
        lambda installed, **kwargs: {"opencode": dict(observation)},
    )
    return inventory


def test_unknown_opencode_global_cleanup_preserves_consumers_but_cleans_claude(
    tmp_data_home, tmp_path, monkeypatch
):
    from skill_hub.application.sync import sync_engine
    from skill_hub.infrastructure.harnesses import opencode_invocation

    source = _skill(tmp_data_home / "skills" / "removed", name="removed", invocation="user-only")
    roots = {
        "shared": tmp_path / "shared-global",
        "claude-code": tmp_path / "claude-global",
    }
    _patch_harness_layouts(monkeypatch, roots, {"claude-code", "opencode"})
    shared_link = roots["shared"] / "skills" / "removed"
    shared_link.parent.mkdir(parents=True, exist_ok=True)
    shared_link.symlink_to(source, target_is_directory=True)
    claude_link = roots["claude-code"] / "skills" / "claude-old"
    claude_link.parent.mkdir(parents=True, exist_ok=True)
    claude_link.symlink_to(source, target_is_directory=True)
    plan = _owned_command_fixture(source, None, monkeypatch)
    foreign = plan["command_path"].parent / "foreign.md"
    foreign.write_text("user-owned\n")

    sync_engine._sync_global_skills(
        {"skills": {}},
        {"claude-code", "opencode"},
        operation_context=_UnavailableOpenCodeContext(("claude-code", "opencode")),
    )

    assert shared_link.is_symlink()
    assert not claude_link.exists()
    assert plan["command_path"].is_symlink()
    assert plan["artifact_path"].exists()
    assert foreign.read_text() == "user-owned\n"
    assert opencode_invocation.collect_orphan_payloads([]) == 0


def test_unknown_opencode_project_cleanup_preserves_removed_consumers(
    tmp_data_home, tmp_path, monkeypatch
):
    from skill_hub.application.skills import skill_variants

    source = _skill(tmp_data_home / "skills" / "removed", name="removed", invocation="user-only")
    project = tmp_path / "project"
    project.mkdir()
    plan = _owned_command_fixture(source, project, monkeypatch)
    link = project / ".agents" / "skills" / "removed"
    link.parent.mkdir(parents=True)
    link.symlink_to(source, target_is_directory=True)

    skill_variants._sync_project_skills(
        "p1",
        project,
        {"path": str(project), "enabled": [], "harnesses": []},
        {"skills": {}},
        {"opencode"},
        {"opencode"},
        operation_context=_UnavailableOpenCodeContext(),
    )

    assert link.is_symlink()
    assert plan["command_path"].is_symlink()
    assert plan["artifact_path"].exists()


def test_unknown_opencode_first_delivery_writes_no_ordinary_link_or_command(
    tmp_data_home, tmp_path, monkeypatch
):
    from skill_hub.application.skills import skill_variants

    source = _skill(tmp_data_home / "skills" / "alpha")
    project = tmp_path / "project"
    project.mkdir()
    registry = {"skills": {"alpha": _cfg(source, invocation="user-only")}}
    skill_variants._sync_project_skills(
        "p1",
        project,
        {"path": str(project), "enabled": ["alpha"], "harnesses": []},
        registry,
        {"opencode"},
        {"opencode"},
        operation_context=_UnavailableOpenCodeContext(),
    )

    assert not (project / ".agents" / "skills" / "alpha").exists()
    assert not (project / ".opencode" / "commands" / "alpha.md").exists()


def test_unknown_opencode_shared_target_defers_link_without_blocking_claude(
    tmp_data_home, tmp_path, monkeypatch
):
    from skill_hub.application.skills import skill_variants

    source = _skill(
        tmp_data_home / "skills" / "alpha",
        yaml_text="policy:\n  allow_implicit_invocation: true\n",
    )
    project = tmp_path / "project"
    project.mkdir()
    registry = {"skills": {"alpha": _cfg(source, invocation="user-only")}}
    skill_variants._sync_project_skills(
        "p1",
        project,
        {"path": str(project), "enabled": ["alpha"], "harnesses": []},
        registry,
        {"claude-code", "codex", "opencode"},
        {"claude-code", "codex", "opencode"},
        operation_context=_UnavailableOpenCodeContext(("claude-code", "codex", "opencode")),
    )

    link = project / ".agents" / "skills" / "alpha"
    assert not link.exists()
    assert (project / ".claude" / "skills" / "alpha").is_symlink()


def test_opencode_delivery_requires_selected_resolver_not_profile_label(tmp_path):
    from skill_hub.application.skills import skill_variants

    source = _skill(tmp_path / "source")
    link = tmp_path / "project" / ".agents" / "skills" / "alpha"
    context = _UnavailableOpenCodeContext()
    context.trusted_invocation_profile = lambda harness_id: "opencode-v1.18.31"
    handled, writes, row = skill_variants._try_opencode_command_delivery(
        "alpha",
        source,
        "user-only",
        {"opencode"},
        project_path=tmp_path / "project",
        link=link,
        profiles={},
        operation_context=context,
    )

    assert handled is True
    assert writes == 0
    assert row is not None and row["reason_code"] == "selection-unavailable"


def test_codex_user_only_writes_derived_policy_without_touching_source(codex_env, capsys):
    data_home = codex_env
    source = _skill(
        data_home / "skills" / "alpha",
        yaml_text="interface:\n  display_name: Alpha\npolicy:\n  allow_implicit_invocation: true\n",
    )
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="user-only", harnesses=["codex"])

    source_yaml = (source / "agents" / "openai.yaml").read_bytes()
    _sync()
    capsys.readouterr()

    link = project / ".agents" / "skills" / "alpha"
    target = link.resolve()
    assert target != source
    assert (target / "agents" / "openai.yaml").read_text().find("allow_implicit_invocation: false") >= 0
    assert (target / "agents" / "README.md").is_symlink()
    assert (source / "agents" / "openai.yaml").read_bytes() == source_yaml


def test_rename_and_codex_policy_are_composed_from_original_source(codex_env, capsys):
    data_home = codex_env
    source = _skill(
        data_home / "sources" / "pack" / "alpha",
        name="upstream",
        yaml_text="policy:\n  allow_implicit_invocation: true\n",
    )
    project = data_home / "projects" / "p1"
    _setup(
        data_home,
        source,
        project,
        managed="external",
        origin={"source": "pack", "path": "alpha", "ref": "main"},
        invocation="user-only",
        harnesses=["codex"],
    )

    _sync()
    capsys.readouterr()
    target = (project / ".agents" / "skills" / "alpha").resolve()
    text = (target / "SKILL.md").read_text()
    assert "name: alpha" in text
    assert "name: upstream" not in text
    assert "allow_implicit_invocation: false" in (target / "agents" / "openai.yaml").read_text()
    assert not (target / "agents" / "openai.yaml").is_symlink()


def test_model_only_restores_codex_implicit_use_and_reports_limit(codex_env, capsys):
    data_home = codex_env
    source = _skill(
        data_home / "skills" / "alpha",
        yaml_text="policy:\n  allow_implicit_invocation: false\n",
    )
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="model-only", harnesses=["codex"])

    _sync()
    capsys.readouterr()
    target = (project / ".agents" / "skills" / "alpha").resolve()
    assert "allow_implicit_invocation: true" in (target / "agents" / "openai.yaml").read_text()
    report = json.loads((data_home / "state" / "sync-report.json").read_text())
    row = report["projects"]["p1"]["invocation"][0]
    assert row["support"] == "unsupported"
    assert row["delivery"] == "applied"


def test_malformed_native_source_keeps_last_good_delivery(codex_env, capsys):
    data_home = codex_env
    source = _skill(
        data_home / "skills" / "alpha",
        yaml_text="policy:\n  allow_implicit_invocation: true\n",
    )
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="user-only", harnesses=["codex"])

    _sync()
    capsys.readouterr()
    link = project / ".agents" / "skills" / "alpha"
    first_target = link.resolve()
    (source / "agents" / "openai.yaml").write_text("policy: [broken\n")

    _sync()
    capsys.readouterr()
    assert link.resolve() == first_target
    report = json.loads((data_home / "state" / "sync-report.json").read_text())
    assert report["ok"] is False
    failure = report["projects"]["p1"]["invocation"][0]
    assert failure["delivery"] == "failed"
    assert failure["applied_mode"] == "user-only"


def test_malformed_already_restricted_source_keeps_snapshot(codex_env, capsys):
    data_home = codex_env
    source = _skill(
        data_home / "skills" / "alpha",
        yaml_text="policy:\n  allow_implicit_invocation: false\n",
    )
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="user-only", harnesses=["codex"])
    _sync()
    capsys.readouterr()
    link = project / ".agents" / "skills" / "alpha"
    previous = link.resolve()
    assert (previous / "agents" / "openai.yaml").read_text().endswith("false\n")

    (source / "agents" / "openai.yaml").write_text("policy: [bad\n")
    _sync()
    capsys.readouterr()
    assert link.resolve() == previous
    assert (link / "agents" / "openai.yaml").read_text().endswith("false\n")


@pytest.mark.parametrize(
    "yaml_text", [None, "policy:\n  allow_implicit_invocation: false\n"]
)
def test_conflicted_intent_preserves_source_without_invalid_renderer(
    codex_env, capsys, yaml_text
):
    data_home = codex_env
    source = _skill(data_home / "skills" / "alpha", yaml_text=yaml_text)
    text = (source / "SKILL.md").read_text().replace(
        "description: t\n", "description: t\ndisable-model-invocation: true\nuser-invocable: false\n"
    )
    (source / "SKILL.md").write_text(text)
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="conflicted", harnesses=["codex"])
    _sync()
    capsys.readouterr()
    link = project / ".agents" / "skills" / "alpha"
    target = link.resolve()
    assert "disable-model-invocation: true" in (target / "SKILL.md").read_text()
    assert "user-invocable: false" in (target / "SKILL.md").read_text()
    if yaml_text is not None:
        assert (target / "agents" / "openai.yaml").read_text() == yaml_text
    report = json.loads((data_home / "state" / "sync-report.json").read_text())
    row = report["projects"]["p1"]["invocation"][0]
    assert row["reason_code"] == "conflicted-intent"
    assert row["support"] == "unknown"


def test_mid_build_failure_keeps_previous_variant_and_link(codex_env, monkeypatch, capsys):
    from skill_hub.application.skills import skill_variants

    data_home = codex_env
    source = _skill(
        data_home / "skills" / "alpha",
        yaml_text="policy:\n  allow_implicit_invocation: true\n",
    )
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="user-only", harnesses=["codex"])
    _sync()
    capsys.readouterr()
    link = project / ".agents" / "skills" / "alpha"
    previous = link.resolve()
    previous_bytes = (previous / "agents" / "openai.yaml").read_bytes()

    (source / "agents" / "openai.yaml").write_text(
        "interface:\n  display_name: Changed\npolicy:\n  allow_implicit_invocation: true\n"
    )
    real = skill_variants._write_skill_variant

    def fail_after_stage(*args, **kwargs):
        real(*args, **kwargs)
        raise OSError("injected stage failure")

    monkeypatch.setattr(skill_variants, "_write_skill_variant", fail_after_stage)
    _sync()
    capsys.readouterr()

    assert link.resolve() == previous
    assert (previous / "agents" / "openai.yaml").read_bytes() == previous_bytes
    assert not list((data_home / "state" / "skill_variants").glob("*.stage-*"))


def test_changed_native_payload_replaces_link_atomically(codex_env, capsys):
    data_home = codex_env
    source = _skill(
        data_home / "skills" / "alpha",
        yaml_text="policy:\n  allow_implicit_invocation: true\n",
    )
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="user-only", harnesses=["codex"])
    _sync()
    capsys.readouterr()
    link = project / ".agents" / "skills" / "alpha"
    previous = link.resolve()
    (source / "agents" / "openai.yaml").write_text(
        "interface:\n  display_name: Changed\npolicy:\n  allow_implicit_invocation: true\n"
    )

    _sync()
    capsys.readouterr()
    current = link.resolve()
    assert current != previous
    assert "display_name: Changed" in (current / "agents" / "openai.yaml").read_text()
    assert not previous.exists()


def test_removed_agents_companion_reconciles_same_native_payload(
    codex_env, capsys
):
    data_home = codex_env
    source = _skill(
        data_home / "skills" / "alpha",
        yaml_text="policy:\n  allow_implicit_invocation: true\n",
    )
    companion = source / "agents" / "schema.json"
    companion.write_text("{}\n")
    project = data_home / "projects" / "p1"
    _setup(data_home, source, project, invocation="user-only", harnesses=["codex"])
    _sync()
    capsys.readouterr()
    link = project / ".agents" / "skills" / "alpha"
    assert (link / "agents" / "schema.json").is_symlink()

    companion.unlink()
    _sync()
    capsys.readouterr()
    assert not (link / "agents" / "schema.json").exists()


def test_opencode_exclusive_user_only_publishes_command_after_eligibility(
    tmp_data_home, monkeypatch, capsys
):
    from skill_hub.infrastructure.harnesses import harnesses

    source = _skill(tmp_data_home / "skills" / "alpha")
    project = tmp_data_home / "projects" / "p1"
    project.mkdir(parents=True)
    (tmp_data_home / "registry.yaml").write_text(
        yaml.safe_dump(
            {
                "version": "1",
                "harnesses_global": ["opencode"],
                "skills": {"alpha": _cfg(source, invocation="user-only")},
                "projects": {
                    "p1": {
                        "path": str(project),
                        "enabled": ["alpha"],
                        "bundles": [],
                        "harnesses": [],
                    }
                },
                "bundles": {},
            },
            sort_keys=False,
        )
    )
    text = (source / "SKILL.md").read_text()
    (source / "SKILL.md").write_text(
        text.replace("description: t\n", "description: t\ndisable-model-invocation: true\n")
    )
    patched = {
        key: dataclasses.replace(
            value,
            detect=lambda key=key: key == "opencode",
            global_skills_dir=type(value.global_skills_dir)(
                str(tmp_data_home / "globals" / key / "skills")
            ),
        )
        for key, value in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    _seed_opencode_selection(monkeypatch)

    _sync()
    capsys.readouterr()
    assert not (project / ".agents" / "skills" / "alpha").exists()
    command = project / ".opencode" / "commands" / "alpha.md"
    assert command.is_symlink()
    assert "@" in command.read_text()
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    outcome = report["projects"]["p1"]["invocation"][0]
    assert outcome["mode_origin"] == "library"
    assert outcome["implicit_behavior"] == "disabled"
    assert outcome["limitations"] == []
    from skill_hub.entrypoints.cli.skill import invocation_status
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    status = invocation_status(registry, "alpha", "p1")
    assert status["outcomes"][0]["delivery"] in {"applied", "unchanged"}
    assert status["outcomes"][0]["implicit_behavior"] == "disabled"
    previous_link = command.readlink()
    previous_mtime = command.stat().st_mtime_ns
    _sync()
    capsys.readouterr()
    assert command.readlink() == previous_link
    assert command.stat().st_mtime_ns == previous_mtime
    repeated = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert repeated["projects"]["p1"]["writes"] == 0
    assert repeated["projects"]["p1"]["removed"] == 0
    from scripts.reconcile_native_invocation import reconcile
    result = reconcile(registry, apply=True)
    assert not result["errors"]
    assert not command.is_symlink()
    assert (project / ".agents" / "skills" / "alpha" / "SKILL.md").is_file()


@pytest.mark.parametrize("harness_order", [("claude-code", "opencode"), ("opencode", "claude-code")])
def test_opencode_command_waits_for_full_skill_target_exclusivity(
    tmp_data_home, monkeypatch, capsys, harness_order
):
    from skill_hub.infrastructure.harnesses import harnesses

    source = _skill(tmp_data_home / "skills" / "alpha")
    project = tmp_data_home / "projects" / "p1"
    _setup(tmp_data_home, source, project, invocation="user-only", harnesses=list(harness_order))
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    registry["harnesses_global"] = list(harness_order)
    registry["skills"]["alpha"]["harnesses"] = list(harness_order)
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    patched = {
        key: dataclasses.replace(
            value,
            detect=lambda key=key: key in set(harness_order),
            global_skills_dir=type(value.global_skills_dir)(
                str(tmp_data_home / "globals" / key / "skills")
            ),
        )
        for key, value in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    _seed_opencode_selection(monkeypatch)

    _sync()
    capsys.readouterr()
    assert (project / ".claude" / "skills" / "alpha").is_symlink()
    assert (project / ".agents" / "skills" / "alpha").is_symlink()
    assert not (project / ".opencode" / "commands" / "alpha.md").exists()
    from skill_hub.entrypoints.cli.skill import invocation_status
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    status = invocation_status(registry, "alpha", "p1")
    outcome = next(row for row in status["outcomes"] if row["harness"] == "opencode")
    assert outcome["delivery"] in {"applied", "unchanged"}
    assert outcome["reason_code"] == "opencode-exclusive-target"


def test_absent_configured_opencode_preserves_global_and_project_consumers(
    tmp_data_home, tmp_path, monkeypatch
):
    from skill_hub.application.sync import sync_engine

    source = _skill(tmp_data_home / "skills" / "removed", name="removed", invocation="user-only")
    project = tmp_path / "project"
    project.mkdir()
    roots = {"shared": tmp_path / "global", "claude-code": tmp_path / "claude"}
    _patch_harness_layouts(monkeypatch, roots, {"claude-code"})
    global_source = _skill(
        tmp_data_home / "skills" / "global-removed", name="global-removed", invocation="user-only"
    )
    global_link = roots["shared"] / "skills" / "global-removed"
    project_link = project / ".agents" / "skills" / "removed"
    for link, target in ((global_link, global_source), (project_link, source)):
        link.parent.mkdir(parents=True)
        link.symlink_to(target, target_is_directory=True)
    commands = [
        _owned_command_fixture(global_source, None, monkeypatch),
        _owned_command_fixture(source, project, monkeypatch),
    ]
    registry = {
        "version": "1", "skills": {}, "bundles": {},
        "harnesses_global": ["opencode"],
        "projects": {"p1": {"path": str(project), "enabled": [], "bundles": [], "harnesses": []}},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry))
    original = sync_engine.build_operation_context
    participants = []
    def capture(data_home, harness_ids, **kwargs):
        participants.append(set(harness_ids))
        return original(data_home, harness_ids, **kwargs)
    monkeypatch.setattr(sync_engine, "build_operation_context", capture)
    import hub
    hub.cmd_sync(argparse.Namespace(skip_permissions=True, skip_hooks=True, skip_remotes=True))

    assert "opencode" in participants[0]
    assert global_link.is_symlink()
    assert project_link.is_symlink()
    for plan in commands:
        assert plan["command_path"].is_symlink()
        assert plan["artifact_path"].exists()


def test_selected_opencode_resolver_can_refuse_delivery(tmp_path, monkeypatch):
    from skill_hub.application.skills import skill_variants
    from skill_hub.domain.harnesses.harness_adapter_api import InvocationCapability
    from skill_hub.infrastructure.harnesses import opencode_invocation

    source = _skill(tmp_path / "source")
    context = _UnavailableOpenCodeContext()
    context.trusted_invocation_profile = lambda harness_id: "opencode-v1.18.31"
    calls = []
    def refuse(harness, mode, **kwargs):
        calls.append((harness, mode, kwargs["profile"]))
        return InvocationCapability(
            support="unknown", implicit_behavior="unknown", explicit_behavior="unknown",
            mechanism="fixture refusal", limitations=(), reason_code="unknown-profile",
        )
    context.trusted_invocation_resolver = lambda harness_id: refuse
    monkeypatch.setattr(
        opencode_invocation, "plan_command", lambda *a, **k: pytest.fail("refused codec reached planning")
    )
    handled, writes, row = skill_variants._try_opencode_command_delivery(
        "alpha", source, "user-only", {"opencode"}, project_path=tmp_path / "project",
        link=tmp_path / "project" / ".agents" / "skills" / "alpha", profiles={}, operation_context=context,
    )
    assert calls == [("opencode", "user-only", "opencode-v1.18.31")]
    assert handled and writes == 0
    assert row["reason_code"] == "selection-unavailable"


def test_other_projects_opencode_selection_does_not_preserve_codex_stale_link(tmp_data_home, tmp_path):
    from skill_hub.application.skills import skill_variants

    source = _skill(tmp_data_home / "skills" / "removed", name="removed")
    project = tmp_path / "codex-project"
    link = project / ".agents" / "skills" / "removed"
    link.parent.mkdir(parents=True)
    link.symlink_to(source, target_is_directory=True)
    registry = {
        "skills": {}, "harnesses_global": [],
        "projects": {"elsewhere": {"path": str(tmp_path / "elsewhere"), "harnesses": ["opencode"]}},
    }
    skill_variants._sync_project_skills(
        "codex-project", project,
        {"path": str(project), "enabled": [], "harnesses": ["codex"]},
        registry, {"codex"}, {"codex", "opencode"},
        operation_context=_UnavailableOpenCodeContext(("codex", "opencode")),
    )
    assert not link.is_symlink()
