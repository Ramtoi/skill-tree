"""Focused checks for context bound skill delivery paths."""

from __future__ import annotations

from pathlib import Path, PurePath
from types import SimpleNamespace


class _Context:
    def __init__(self, data_home: Path, layout: object, *, route_status: str = "shadow"):
        self.data_home = str(data_home)
        self.harness_ids = ("claude-code",)
        self.installed_harness_ids = self.harness_ids
        self.layouts = {"claude-code": layout}
        self._route_status = route_status
        self.invocation_observations = {}

    def layout(self, harness_id: str):
        return self.layouts.get(harness_id)

    def route(self, harness_id: str, feature: str):
        return SimpleNamespace(
            status=self._route_status, mode="legacy_shadow", adapter_key=None
        )

    def trusted_invocation_profile(self, harness_id: str):
        return None

    def trusted_invocation_resolver(self, harness_id: str):
        return None


def _layout(global_dir: Path, project_dir: str = ".captured/skills"):
    return SimpleNamespace(
        id="claude-code",
        label="Captured Claude",
        project_skills_dir=PurePath(project_dir),
        global_skills_dir=global_dir,
        mcp_adapter_key=None,
    )


def _cfg(source: Path) -> dict:
    return {
        "version": "1.0.0",
        "description": "",
        "source": str(source),
        "type": "claude-skill",
        "scope": "portable",
        "upstream": None,
    }


def _source(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(
        "---\nname: alpha\ndescription: test\n---\n\n# Body\n"
    )
    return path


def test_variant_store_uses_captured_data_home(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub import hub_core
    from skill_hub.application.skills import skill_variants

    source = _source(tmp_path / "source")
    context = _Context(
        tmp_data_home,
        _layout(tmp_path / "captured-global" / "skills"),
    )
    def fail_ambient_data_home():
        raise AssertionError("ambient data home read")

    monkeypatch.setattr(hub_core, "data_home", fail_ambient_data_home)

    result = skill_variants.ensure_skill_variant(
        "alpha", source, "user-only", operation_context=context
    )

    assert result is not None
    variant_dir, _writes = result
    assert variant_dir.is_relative_to(tmp_data_home / "state" / "skill_variants")


def test_project_skill_delivery_uses_captured_layout(tmp_data_home, tmp_path):
    from skill_hub.application.skills import skill_variants

    source = _source(tmp_data_home / "skills" / "alpha")
    project = tmp_path / "project"
    project.mkdir()
    context = _Context(
        tmp_data_home,
        _layout(tmp_path / "captured-global" / "skills"),
    )
    registry = {"skills": {"alpha": _cfg(source)}}
    project_cfg = {"path": str(project), "enabled": ["alpha"], "harnesses": []}

    skill_variants._sync_project_skills(
        "p1",
        project,
        project_cfg,
        registry,
        {"claude-code"},
        {"claude-code"},
        operation_context=context,
    )

    assert (project / ".captured" / "skills" / "alpha").is_symlink()
    assert not (project / ".claude" / "skills" / "alpha").exists()


def test_unavailable_captured_route_preserves_existing_skill_link(
    tmp_data_home, tmp_path
):
    from skill_hub.application.skills import skill_variants

    source = _source(tmp_data_home / "skills" / "alpha")
    project = tmp_path / "project"
    target_dir = project / ".captured" / "skills"
    target_dir.mkdir(parents=True)
    link = target_dir / "alpha"
    link.symlink_to(source, target_is_directory=True)
    context = _Context(
        tmp_data_home,
        _layout(tmp_path / "captured-global" / "skills"),
        route_status="unavailable",
    )

    skill_variants._sync_project_skills(
        "p1",
        project,
        {"path": str(project), "enabled": [], "harnesses": []},
        {"skills": {}},
        {"claude-code"},
        {"claude-code"},
        operation_context=context,
    )

    assert link.is_symlink()
    assert link.resolve() == source.resolve()


def test_missing_opencode_paths_fail_closed_without_ambient_reads(tmp_path, monkeypatch):
    from skill_hub.application.skills import skill_variants
    from skill_hub.infrastructure.harnesses import opencode_invocation

    source = _source(tmp_path / "source")
    layout = _layout(tmp_path / "captured-global" / "skills", ".agents/skills")
    context = SimpleNamespace(
        harness_ids=("opencode",),
        opencode_paths=None,
        invocation_observations={},
        trusted_invocation_profile=lambda _harness: "opencode-v1.18.31",
        trusted_invocation_resolver=lambda _harness: None,
        layout=lambda harness_id: layout if harness_id == "opencode" else None,
        route=lambda _harness, _feature: SimpleNamespace(
            status="shadow", mode="legacy_shadow"
        ),
    )
    monkeypatch.setattr(
        opencode_invocation,
        "_home",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("ambient OpenCode home read")
        ),
    )

    handled, writes, row = skill_variants._try_opencode_command_delivery(
        "alpha",
        source,
        "user-only",
        {"opencode"},
        project_path=tmp_path / "project",
        link=tmp_path / "project" / ".agents" / "skills" / "alpha",
        profiles={},
        operation_context=context,
    )

    assert handled is True
    assert writes == 0
    assert row is not None and row["reason_code"] == "selection-unavailable"


def test_disabled_mcp_cleanup_uses_captured_adapter_after_registry_mutation(
    tmp_data_home, tmp_path, monkeypatch
):
    from skill_hub.application.skills import skill_variants
    from skill_hub.infrastructure.harnesses import harnesses
    from skill_hub.infrastructure.mcp import mcp_adapters

    project = tmp_path / "project"
    project.mkdir()
    layout = SimpleNamespace(
        id="claude-code",
        label="Captured Claude",
        project_skills_dir=PurePath(".captured/skills"),
        global_skills_dir=tmp_path / "captured-global" / "skills",
        mcp_adapter_key="claude",
    )
    context = SimpleNamespace(
        data_home=str(tmp_data_home),
        harness_ids=("claude-code",),
        installed_harness_ids=("claude-code",),
        layouts={"claude-code": layout},
        invocation_observations={},
        layout=lambda harness_id: layout if harness_id == "claude-code" else None,
        route=lambda _harness, _feature: SimpleNamespace(
            status="shadow", mode="legacy_shadow", adapter_key="claude"
        ),
        trusted_invocation_resolver=lambda _harness: None,
    )
    removed = []

    class Adapter:
        def remove(self, *args, **kwargs):
            removed.append((args, kwargs))
            return SimpleNamespace(removed=True, preserved=[])

    monkeypatch.setattr(mcp_adapters, "select_mcp_adapter", lambda *_args: Adapter())
    monkeypatch.setattr(
        skill_variants,
        "sync_mcp_for_project",
        lambda *args, **kwargs: {},
    )

    class ExplodingHarnesses:
        def __getattr__(self, _name):
            raise AssertionError("ambient harness registry read")

    monkeypatch.setattr(harnesses, "HARNESSES", ExplodingHarnesses())
    registry = {
        "sources": {"org": {"enabled": False}},
        "skills": {
            "ext-mcp": {
                "source": str(tmp_data_home / "sources" / "org" / "ext-mcp"),
                "type": "mcp-server",
                "scope": "portable",
                "managed": "external",
                "origin": {"source": "org"},
                "mcp": {"runtime": "python", "command": "python3", "args": []},
            }
        },
    }

    skill_variants._sync_project_skills(
        "p1",
        project,
        {"path": str(project), "enabled": ["ext-mcp"], "harnesses": []},
        registry,
        {"claude-code"},
        {"claude-code"},
        operation_context=context,
    )

    assert removed and removed[0][1]["harness_id"] == "claude-code"
