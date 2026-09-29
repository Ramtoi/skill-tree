"""Focused contracts for native invocation resolution and Codex policy edits."""

from __future__ import annotations

import pytest

from skill_hub.application.skills.skill_invocation import (
    InvocationError,
    codex_implicit,
    render_codex_policy,
    resolve_invocation,
)


def test_user_only_patches_codex_policy_without_touching_unrelated_yaml() -> None:
    source = (
        b"# keep this comment\r\n"
        b"interface: \"quoted\"\r\n"
        b"dependencies:\r\n"
        b"  - helper\r\n"
        b"policy:\r\n"
        b"  # preserve this comment\r\n"
        b"  allow_implicit_invocation: true # preserve this value comment\r\n"
    )

    rendered = render_codex_policy(source, "user-only")

    assert rendered is not None
    assert b"interface: \"quoted\"\r\n" in rendered
    assert b"dependencies:\r\n  - helper\r\n" in rendered
    assert b"allow_implicit_invocation: false" in rendered
    assert b"# preserve this comment" in rendered
    assert b"\r\n" in rendered
    assert codex_implicit(rendered) is False
    assert source != rendered


def test_modes_without_a_native_patch_preserve_source_bytes() -> None:
    source = b"policy: {allow_implicit_invocation: true}\n"

    assert codex_implicit(None) is True
    assert codex_implicit(b"") is True
    assert codex_implicit(b"interface: cli\n") is True
    assert render_codex_policy(source, "auto") == source
    assert render_codex_policy(source, "model-only") == source
    assert render_codex_policy(None, "auto") is None
    assert render_codex_policy(None, "model-only") is None
    assert codex_implicit(render_codex_policy(None, "user-only")) is False


def test_model_only_overrides_source_false_and_auto_preserves_it() -> None:
    source = b"policy:\n  allow_implicit_invocation: false\n"

    assert codex_implicit(source) is False
    assert codex_implicit(render_codex_policy(source, "model-only")) is True
    assert render_codex_policy(source, "auto") == source


def test_empty_codex_document_can_receive_user_only_policy() -> None:
    rendered = render_codex_policy(b"", "user-only")

    assert rendered is not None
    assert codex_implicit(rendered) is False


@pytest.mark.parametrize(
    ("source", "code"),
    [
        (b"policy: [true]\n", "invalid-policy"),
        (b"policy:\n  allow_implicit_invocation: true\n  allow_implicit_invocation: false\n", "duplicate-key"),
        (b"policy: {allow_implicit_invocation: true}\n---\nother: 1\n", "multiple-documents"),
        (b"policy: [\n", "invalid-yaml"),
    ],
)
def test_codex_rejects_unsafe_documents(source: bytes, code: str) -> None:
    with pytest.raises(InvocationError) as exc_info:
        render_codex_policy(source, "user-only")

    assert exc_info.value.code == code


def test_alias_policy_is_detached_before_editing() -> None:
    source = (
        b"defaults: &defaults\n"
        b"  allow_implicit_invocation: true\n"
        b"policy: *defaults\n"
        b"sibling: *defaults\n"
    )

    rendered = render_codex_policy(source, "user-only")

    assert rendered is not None
    assert b"defaults: &defaults\n  allow_implicit_invocation: true\n" in rendered
    assert b"policy:\n  allow_implicit_invocation: false\n" in rendered
    assert b"sibling: *defaults\n" in rendered
    assert codex_implicit(rendered) is False


def test_merge_key_and_multiline_siblings_survive_policy_edit() -> None:
    source = (
        b"defaults: &defaults\n"
        b"  allow_implicit_invocation: true\n"
        b"interface: |\n"
        b"  first line\n"
        b"  second line\n"
        b"policy:\n"
        b"  <<: *defaults\n"
        b"  retries: 2\n"
    )

    rendered = render_codex_policy(source, "user-only")

    assert rendered is not None
    assert b"interface: |\n  first line\n  second line\n" in rendered
    assert b"<<: *defaults\n  retries: 2\n  allow_implicit_invocation: false\n" in rendered
    assert b"defaults: &defaults\n  allow_implicit_invocation: true\n" in rendered


def test_missing_round_trip_backend_fails_closed(monkeypatch) -> None:
    from skill_hub.application.skills import skill_invocation

    monkeypatch.setattr(skill_invocation, "_RuamelYAML", None)

    with pytest.raises(InvocationError) as exc_info:
        render_codex_policy(b"policy: {}\n", "user-only")

    assert exc_info.value.code == "yaml-backend-unavailable"


def test_invalid_mode_and_invalid_source_are_coded() -> None:
    with pytest.raises(InvocationError) as mode_error:
        render_codex_policy(b"", "manual")
    with pytest.raises(InvocationError) as source_error:
        render_codex_policy("policy: {}", "user-only")  # type: ignore[arg-type]

    assert mode_error.value.code == "invalid-mode"
    assert source_error.value.code == "invalid-source"


def test_resolver_distinguishes_codex_limits_and_delivery() -> None:
    user_only = resolve_invocation(
        "demo",
        "codex",
        "user-only",
        mode_origin="project",
        project="/tmp/project",
        delivery="applied",
    )
    model_only = resolve_invocation("demo", "codex", "model-only")

    assert user_only["support"] == "enforced"
    assert user_only["implicit_behavior"] == "disabled"
    assert user_only["explicit_behavior"] == "available"
    assert user_only["delivery"] == "applied"
    assert user_only["mode_origin"] == "project"
    assert model_only["support"] == "unsupported"
    assert model_only["implicit_behavior"] == "enabled"
    assert model_only["explicit_behavior"] == "available"
    assert model_only["limitations"]


def test_opencode_profiles_are_capability_gated() -> None:
    v1_auto = resolve_invocation("demo", "opencode", "auto", profile="opencode-v1.18.31")
    v1_user = resolve_invocation(
        "demo", "opencode", "user-only", profile="opencode-v1.18.31"
    )
    v2_user = resolve_invocation(
        "demo", "opencode", "user-only", profile="opencode-v2-verified"
    )
    eligible = resolve_invocation(
        "demo",
        "opencode",
        "user-only",
        profile="opencode-v1.18.31-command-eligible",
    )

    assert v1_auto["support"] == "native"
    assert v1_auto["implicit_behavior"] == "enabled"
    assert v1_auto["explicit_behavior"] == "available"
    assert v1_user["support"] == "unsupported"
    assert v2_user["support"] == "unknown"
    assert eligible["support"] == "enforced"
    assert eligible["mechanism"] == "opencode command-only delivery"


@pytest.mark.parametrize("source", [b"[]\n", b"policy: null\n", b'policy: {allow_implicit_invocation: "false"}\n'])
def test_invalid_policy_shapes_fail_even_when_auto_would_preserve_bytes(source):
    with pytest.raises(InvocationError):
        render_codex_policy(source, "auto")


def test_absent_yaml_requires_backend_for_user_only(monkeypatch):
    from skill_hub.application.skills import skill_invocation
    monkeypatch.setattr(skill_invocation, "_RuamelYAML", None)
    with pytest.raises(InvocationError, match="ruamel"):
        render_codex_policy(None, "user-only")


def test_comment_only_yaml_retains_source_comment():
    source = b"# Source policy intentionally unset\n"
    rendered = render_codex_policy(source, "user-only")
    assert b"# Source policy intentionally unset" in rendered
    assert codex_implicit(rendered) is False
