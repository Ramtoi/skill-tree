"""Read-only invocation query contracts, using the fixture-owned registry."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import yaml


def _registry(tmp_data_home):
    source = tmp_data_home / "skills" / "demo"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: demo\ndescription: test\ndisable-model-invocation: true\n---\nbody\n")
    project = tmp_data_home / "project"
    project.mkdir()
    registry = {
        "version": "1", "harnesses_global": ["codex", "pi"], "bundles": {},
        "skills": {"demo": {"source": str(source), "type": "claude-skill", "scope": "portable",
                              "invocation": "user-only", "harnesses": ["codex"]}},
        "projects": {"p": {"path": str(project), "enabled": ["demo"], "bundles": [], "harnesses": []}},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry))
    return registry


def test_read_invocation_uses_affinity_and_does_not_probe_or_write(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.infrastructure.harnesses import harness_probe, harnesses
    registry = _registry(tmp_data_home)
    before = (tmp_data_home / "registry.yaml").read_bytes()
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"codex", "pi"})
    def forbidden(*a, **kw):
        raise AssertionError("read invoked probe or sync")
    monkeypatch.setattr(harness_probe, "probe_invocations", forbidden)
    monkeypatch.setattr(hub, "_auto_sync", forbidden)
    monkeypatch.setattr(sys, "argv", ["hub", "skill", "invocation", "demo", "--project", "p", "--json"])
    hub.main()
    payload = json.loads(capsys.readouterr().out)
    assert payload["effective"] == "user-only"
    assert payload["targets"] == ["codex"]
    assert payload["outcomes"][0]["support"] == "enforced"
    assert payload["outcomes"][0]["delivery"] == "pending"
    assert payload["previews"]["model-only"][0]["support"] == "unsupported"
    assert (tmp_data_home / "registry.yaml").read_bytes() == before
    assert not (tmp_data_home / "state").exists()
    assert registry["skills"]["demo"]["harnesses"] == ["codex"]


def test_json_unknown_skill_returns_structured_verdict(tmp_data_home, monkeypatch, capsys):
    import hub
    _registry(tmp_data_home)
    monkeypatch.setattr(sys, "argv", ["hub", "skill", "invocation", "missing", "--json"])
    hub.main()
    assert json.loads(capsys.readouterr().out)["reason_code"] == "not-a-skill"


def test_native_query_uses_no_directory_creating_resolver(tmp_data_home, monkeypatch):
    from skill_hub import hub_core
    from skill_hub.entrypoints.cli.skill import invocation_status
    from skill_hub.infrastructure.harnesses import harnesses

    registry = _registry(tmp_data_home)
    registry["projects"]["p"]["invocation_overrides"] = {"demo": "user-only"}
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"codex"})
    def forbidden():
        raise AssertionError("query used directory-creating data_home")
    monkeypatch.setattr(hub_core, "data_home", forbidden)
    result = invocation_status(registry, "demo", "p")
    assert result["outcomes"][0]["mode_origin"] == "project"


def test_project_invocation_read_does_not_migrate_registry(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.infrastructure.harnesses import harnesses
    _registry(tmp_data_home)
    before = (tmp_data_home / "registry.yaml").read_bytes()
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"codex"})
    monkeypatch.setattr(sys, "argv", ["hub", "project", "invocation", "p", "--json"])
    hub.main()
    row = json.loads(capsys.readouterr().out)["skills"][0]
    assert row["effective"] == "user-only"
    assert row["outcomes"][0]["harness"] == "codex"
    assert (tmp_data_home / "registry.yaml").read_bytes() == before


def test_invocation_read_builds_one_context_and_reuses_it(
    tmp_data_home, monkeypatch
):
    from skill_hub.application.harnesses import harness_operation_context
    from skill_hub.application.skills import skill_variants
    from skill_hub.entrypoints.cli.skill import invocation_status
    from skill_hub.infrastructure.harnesses import harnesses

    registry = _registry(tmp_data_home)
    detect_calls = 0

    def detect_installed():
        nonlocal detect_calls
        detect_calls += 1
        return {"codex"}

    context = SimpleNamespace(
        data_home=str(tmp_data_home),
        installed_harness_ids=("codex",),
        effective_harness_ids=lambda _project, _registry: {"codex"},
    )

    def build(data_home, harness_ids, **kwargs):
        assert Path(data_home) == tmp_data_home
        assert "skills" in kwargs["requested_features"]
        assert "invocation" in kwargs["requested_features"]
        assert kwargs["installed_harness_ids"] == ["codex"]
        return context

    seen_contexts = []

    def preview(*_args, operation_context=None, **_kwargs):
        seen_contexts.append(operation_context)
        return [{"harness": "codex", "support": "pending"}]

    monkeypatch.setattr(harnesses, "detect_installed", detect_installed)
    monkeypatch.setattr(harness_operation_context, "build_operation_context", build)
    monkeypatch.setattr(skill_variants, "invocation_preview", preview)

    result = invocation_status(registry, "demo", "p")

    assert result["ok"] is True
    assert detect_calls == 1
    assert len(seen_contexts) == 4
    assert all(item is context for item in seen_contexts)

    def forbidden_detection():
        raise AssertionError("supplied context triggered ambient detection")
    monkeypatch.setattr(harnesses, "detect_installed", forbidden_detection)
    invocation_status(registry, "demo", "p", operation_context=context)
    assert len(seen_contexts) == 8
    assert all(item is context for item in seen_contexts)
