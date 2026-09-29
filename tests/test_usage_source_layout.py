from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from skill_hub.application.usage import usage_source_layout as roots


def test_capture_usage_layout_derives_only_declared_config_dirs(monkeypatch, tmp_path: Path):
    captured = {
        "claude-code": SimpleNamespace(config_dir=tmp_path / "claude-lexical"),
        "codex": SimpleNamespace(config_dir=tmp_path / "codex-lexical"),
    }
    calls = []

    def capture(ids):
        calls.append(tuple(ids))
        return captured

    monkeypatch.setattr(roots, "capture_layouts", capture)
    layout = roots.capture_usage_layout()

    assert calls == [("claude-code", "codex")]
    assert layout.roots() == {
        "claude-code": tmp_path / "claude-lexical" / "projects",
        "codex": tmp_path / "codex-lexical" / "sessions",
    }
    snapshot = layout.roots()
    snapshot["claude-code"] = tmp_path / "wrong"
    assert layout.claude_projects_root == tmp_path / "claude-lexical" / "projects"


def test_real_capture_layout_honors_override_environment_and_supplied_home_precedence(
    monkeypatch, tmp_path: Path
):
    supplied = tmp_path / "supplied-home"
    env_claude = tmp_path / "env-claude"
    env_codex = tmp_path / "env-codex"
    explicit_claude = tmp_path / "explicit-claude"
    monkeypatch.setenv("HOME", str(supplied))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(env_claude))
    monkeypatch.setenv("CODEX_HOME", str(env_codex))

    from skill_hub.application.harnesses.harness_layout_context import capture_layouts

    captured = capture_layouts(
        ("claude-code", "codex"),
        home=supplied,
        home_overrides={"claude-code": explicit_claude, "codex": ""},
    )
    layout = roots.capture_usage_layout(captured)

    assert layout.roots() == {
        "claude-code": explicit_claude / "projects",
        "codex": env_codex / "sessions",
    }


def test_capture_usage_layout_is_frozen_until_the_next_operation(monkeypatch, tmp_path: Path):
    from skill_hub.application.harnesses.harness_layout_context import capture_layouts
    from skill_hub.infrastructure.harnesses import harnesses

    first_home = tmp_path / "first"
    second_home = tmp_path / "second"
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(first_home / ".claude"))
    monkeypatch.setenv("CODEX_HOME", str(first_home / ".codex"))
    first = roots.capture_usage_layout(capture_layouts(("claude-code", "codex"), home=first_home))

    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(second_home / "claude"))
    monkeypatch.setenv("CODEX_HOME", str(second_home / "codex"))
    changed = dict(harnesses.HARNESSES)
    changed.pop("codex", None)
    monkeypatch.setattr(harnesses, "HARNESSES", changed)

    assert first.roots() == {
        "claude-code": first_home / ".claude" / "projects",
        "codex": first_home / ".codex" / "sessions",
    }
    second = roots.capture_usage_layout()
    assert second.roots() == {"claude-code": second_home / "claude" / "projects"}


def test_undeclared_harness_does_not_get_a_guessed_usage_root(monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setattr(harnesses, "HARNESSES", {})
    assert roots.capture_usage_layout().roots() == {}


def test_source_inventory_accepts_current_claude_and_codex_shapes(tmp_path: Path):
    claude = tmp_path / "claude" / "projects"
    uuid = "aaaaaaaa-1111-4111-8111-111111111111"
    accepted = [
        claude / "project" / f"{uuid}.jsonl",
        claude / "project" / "subagents" / "child.jsonl",
        claude / "project" / "subagents" / "workflow" / "agent-child.jsonl",
    ]
    rejected = claude / "project" / "sessions-index.jsonl"
    for path in (*accepted, rejected):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n")

    assert list(roots.iter_source_paths("claude-code", claude)) == sorted(accepted)

    codex = tmp_path / "codex" / "sessions"
    rollout = codex / "2026" / "09" / "rollout-2026-09-18T00-00-00-{uuid}.jsonl"
    archived = codex / "archived" / f"rollout-{uuid}.jsonl.disabled"
    rollout.parent.mkdir(parents=True)
    rollout.write_text("{}\n")
    archived.parent.mkdir(parents=True)
    archived.write_text("{}\n")
    assert list(roots.iter_source_paths("codex", codex)) == [rollout]


def test_source_presence_reuses_captured_roots_and_rejects_path_identifiers(tmp_path: Path):
    claude = tmp_path / "claude" / "projects" / "project"
    session_id = "bbbbbbbb-2222-4222-8222-222222222222"
    child = claude / "subagents" / "workflow" / "agent-child.jsonl"
    child.parent.mkdir(parents=True)
    child.write_text("{}\n")
    codex = tmp_path / "codex" / "sessions" / "2026"
    rollout = codex / f"rollout-2026-09-18T00-00-00-{session_id}.jsonl"
    rollout.parent.mkdir(parents=True)
    rollout.write_text("{}\n")
    layout = roots.UsageLayout(
        (("claude-code", claude.parent), ("codex", codex.parent)),
    )

    assert roots.source_present(layout, "claude-code", "agent-child")
    assert roots.source_present(layout, "codex", session_id)
    assert not roots.source_present(layout, "claude-code", "../agent-child")
    assert not roots.source_present(layout, "codex", "missing")
