"""SDK/native parity checks for bundled subagent format codecs."""

import os
import shutil
import subprocess
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from skill_hub.domain.harnesses.harness_adapter_api import CodexRenderInput, NativeAgentDocument
from skill_hub.infrastructure.harnesses.harness_bundled_subagents import (
    ParseError,
    advanced_codex_fragment,
    bundled_agent_codec,
    parse_claude_agent,
    parse_codex_agent,
    render_codex_agent,
    serialize_claude_agent,
)


def test_agent_document_is_immutable_and_values_are_frozen() -> None:
    frontmatter = {"name": "worker", "tools": ["Read"]}
    document = NativeAgentDocument(frontmatter=frontmatter, native_skills=[{"enabled": True}])
    frontmatter["tools"].append("Write")
    assert document.frontmatter["tools"] == ("Read",)
    assert document.native_skills[0]["enabled"] is True
    with pytest.raises(FrozenInstanceError):
        document.body = "changed"  # type: ignore[misc]


def test_claude_codec_preserves_lenient_colon_and_body() -> None:
    text = "---\nname: worker\ndescription: Keep Context: User supplied\n---\nBody"
    document = parse_claude_agent(text)
    assert document.frontmatter["description"] == "Keep Context: User supplied"
    assert document.body == "Body"
    serialized = serialize_claude_agent(dict(document.frontmatter), document.body)
    assert parse_claude_agent(serialized).body == "Body"


def test_claude_codec_rejects_missing_fence() -> None:
    with pytest.raises(ParseError, match="missing frontmatter fence"):
        parse_claude_agent("name: worker\n---\nBody")


def test_codex_codec_preserves_unknowns_and_unmatched_skill_nodes() -> None:
    text = (
        'name = "worker"\n'
        'description = "d"\n'
        'developer_instructions = "body"\n'
        "\n# Keep this comment\n"
        "[[skills.config]]\npath = \"/hub/managed/SKILL.md\"\nenabled = true\n"
        "[[skills.config]]\npath = \"/foreign/SKILL.md\"\nenabled = false\n"
        "\n[unknown]\nvalue = 4\n"
    )
    document = parse_codex_agent(text)
    assert len(document.native_skills) == 2
    assert document.frontmatter["name"] == "worker"
    assert "unknown" in advanced_codex_fragment(text)
    rendered = render_codex_agent(CodexRenderInput(
        existing_text=text,
        frontmatter={"name": "worker", "description": "changed"},
        advanced_toml=advanced_codex_fragment(text),
        body="body",
        managed_skill_indices=(0,),
        replacement_skill_paths=("/hub/new/SKILL.md",),
    ))
    assert "/hub/new/SKILL.md" in rendered
    assert "/foreign/SKILL.md" in rendered
    assert "# Keep this comment" in rendered
    assert "value = 4" in rendered


def test_codex_codec_rejects_invalid_managed_index() -> None:
    with pytest.raises(ValueError, match="managed skill index"):
        render_codex_agent(CodexRenderInput(
            existing_text='name = "x"\n', frontmatter={}, advanced_toml="", body="",
            managed_skill_indices=(0,), replacement_skill_paths=(),
        ))


def test_codec_facade_selects_only_known_native_formats() -> None:
    assert bundled_agent_codec("claude-code").parse("---\nname: x\n---\n").body == ""
    assert bundled_agent_codec("codex").parse('name = "x"\n').frontmatter["name"] == "x"
    with pytest.raises(ValueError, match="unknown subagent harness"):
        bundled_agent_codec("unknown")


def test_codec_imports_with_only_declared_format_dependencies(tmp_path: Path) -> None:
    """The bundled codec must not pull host modules into an SDK-only checkout."""
    import tomlkit
    import yaml

    root = Path(__file__).resolve().parents[1]
    (tmp_path / "skill_hub/domain/harnesses/harness_adapter_api.py").parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(
        root / "skill_hub/domain/harnesses/harness_adapter_api.py",
        tmp_path / "skill_hub/domain/harnesses/harness_adapter_api.py",
    )
    (tmp_path / "skill_hub/infrastructure/harnesses/harness_bundled_subagents.py").parent.mkdir(
        parents=True, exist_ok=True
    )
    shutil.copy2(
        root / "skill_hub/infrastructure/harnesses/harness_bundled_subagents.py",
        tmp_path / "skill_hub/infrastructure/harnesses/harness_bundled_subagents.py",
    )
    shutil.copytree(
        Path(yaml.__file__).parent, tmp_path / "yaml",
        ignore=shutil.ignore_patterns("*.so", "*.dylib", "*.pyd", "__pycache__"),
    )
    shutil.copytree(Path(tomlkit.__file__).parent, tmp_path / "tomlkit")
    env = os.environ.copy()
    env["PYTHONPATH"] = str(tmp_path)
    script = (
        "import sys; "
        "from skill_hub.infrastructure.harnesses.harness_bundled_subagents "
        "import parse_claude_agent, parse_codex_agent; "
        "assert parse_claude_agent('---\\nname: x\\n---\\n').body == ''; "
        "assert parse_codex_agent('name = \\\"x\\\"\\n').frontmatter['name'] == 'x'; "
        "assert not any(name in sys.modules for name in ("
        "'skill_hub.infrastructure.harnesses.subagents', "
        "'skill_hub.infrastructure.harnesses.subagent_codex', "
        "'skill_hub.infrastructure.harnesses.harnesses', 'skill_hub.hub_core'))"
    )
    result = subprocess.run(
        [sys.executable, "-S", "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_yaml_native_mapping_keys_survive_public_round_trip():
    from skill_hub.infrastructure.harnesses import subagents

    text = "---\n2: preserved\nfalse: disabled\nadvanced:\n  3: [nested]\n---\nbody"
    parsed = subagents.parse_agent(text)
    assert parsed["frontmatter"] == {2: "preserved", False: "disabled", "advanced": {3: ["nested"]}}
    rendered = subagents.serialize_agent(parsed["frontmatter"], parsed["body"])
    assert subagents.parse_agent(rendered) == parsed


def test_claude_sdk_renderer_accepts_nested_immutable_request():
    from skill_hub.domain.harnesses.harness_adapter_api import thaw_native_value

    metadata = {"name": "worker", "tools": ["Read"], "advanced": {2: ["keep", {"enabled": False}]}}
    request = CodexRenderInput(None, metadata, "", "body")
    codec = bundled_agent_codec("claude-code")

    rendered = codec.render(request)

    assert thaw_native_value(codec.parse(rendered).frontmatter) == metadata
    assert request.frontmatter["tools"] == ("Read",)
    assert codec.parse(rendered).body == "body"
