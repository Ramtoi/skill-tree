"""Permission adapters: round-trip, sidecar-driven cleanup, no metadata pollution."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from skill_hub.domain.permissions.permissions import (
    DirectoryLedgerIdentity,
    GlobalScope,
    Hook,
    NormalizedPermissions,
    PermissionFeature,
    ProjectScope,
    Rule,
    directory_sidecar_path,
    read_sidecar,
    write_directory_sidecar,
)
from skill_hub.infrastructure.permissions import permission_adapter_codex as pac
from skill_hub.infrastructure.permissions import permission_adapters as pa


@pytest.fixture(autouse=True)
def _reset_backup_state():
    pa._reset_backup_session_state_for_tests()
    yield
    pa._reset_backup_session_state_for_tests()


def _claude_proj_target(tmp_path: Path, harness: str = "claude-code") -> Path:
    return tmp_path / (".claude/settings.json" if harness == "claude-code" else ".pi/agent/settings.json")


def test_claude_round_trip_preserves_unrelated(tmp_data_home, tmp_path):
    target = _claude_proj_target(tmp_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "model": "claude-sonnet-4-6",
                "permissions": {
                    "allow": ["UserAuthored(*)"],
                },
                "unrelated": {"foo": "bar"},
            }
        )
    )

    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
    )
    adapter = pa.ClaudePermissionAdapter()
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    result = adapter.translate(perms, scope, "claude-code")
    assert len(result.writes) == 1
    adapter.apply(scope, result.writes[0], "claude-code")

    data = json.loads(target.read_text())
    assert data["model"] == "claude-sonnet-4-6"
    assert data["unrelated"] == {"foo": "bar"}
    assert "UserAuthored(*)" in data["permissions"]["allow"]
    assert "Bash(npm:*)" in data["permissions"]["allow"]


def test_claude_pi_writes_to_pi_settings_via_claude_adapter(tmp_data_home, tmp_path):
    """Pi reuses ClaudePermissionAdapter — target file path differs."""
    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(npm:*)", kind="allow")])
    adapter = pa.get_adapter("claude")
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    result = adapter.translate(perms, scope, "pi")
    adapter.apply(scope, result.writes[0], "pi")

    pi_path = tmp_path / ".pi/agent/settings.json"
    claude_path = tmp_path / ".claude/settings.json"
    assert pi_path.exists()
    assert not claude_path.exists()
    data = json.loads(pi_path.read_text())
    assert "Bash(npm:*)" in data["permissions"]["allow"]


@pytest.mark.parametrize("harness", ["claude-code", "pi"])
def test_claude_family_reapply_discover_cleanup_preserves_foreign_entries(
    tmp_data_home, tmp_path, harness
):
    target = _claude_proj_target(tmp_path, harness)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({
        "hooks": {"PreToolUse": [{"matcher": "*", "hooks": []}]},
        "permissions": {"allow": ["Foreign(*)", "Foreign(*)"], "ask": [1]},
        "model": "keep",
    }))
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    adapter = pa.ClaudePermissionAdapter()
    perms = NormalizedPermissions(allow=[Rule(pattern="Hub(*)", kind="allow")])
    write = adapter.translate(perms, scope, harness).writes[0]
    assert adapter.apply(scope, write, harness)
    assert adapter.discover_existing(scope, harness).allow[-1].pattern == "Hub(*)"
    assert adapter.apply(scope, write, harness)
    adapter.cleanup(scope, harness)
    data = json.loads(target.read_text())
    assert data["model"] == "keep"
    assert data["hooks"]["PreToolUse"] == [{"matcher": "*", "hooks": []}]
    assert data["permissions"]["allow"] == ["Foreign(*)", "Foreign(*)"]
    assert data["permissions"]["ask"] == [1]


def test_claude_user_config_never_contains_hub_metadata(tmp_data_home, tmp_path):
    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
        hooks=[Hook(event="PreToolUse", matcher="Bash", command="/x")],
    )
    adapter = pa.ClaudePermissionAdapter()
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    result = adapter.translate(perms, scope, "claude-code")
    adapter.apply(scope, result.writes[0], "claude-code")

    raw = _claude_proj_target(tmp_path).read_text()
    assert "_hub_managed_keys" not in raw
    assert "hub-managed" not in raw


def test_claude_cleanup_leaves_user_rules_intact(tmp_data_home, tmp_path):
    adapter = pa.ClaudePermissionAdapter()
    scope = ProjectScope(name="alpha", path=str(tmp_path))

    target = _claude_proj_target(tmp_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"permissions": {"allow": ["UserAuthored(*)"]}}))

    perms = NormalizedPermissions(allow=[Rule(pattern="Hub(*)", kind="allow")])
    result = adapter.translate(perms, scope, "claude-code")
    adapter.apply(scope, result.writes[0], "claude-code")
    # Both rules now in file
    assert json.loads(target.read_text())["permissions"]["allow"] == ["UserAuthored(*)", "Hub(*)"]
    # Cleanup should drop only Hub(*)
    adapter.cleanup(scope, "claude-code")
    surviving = json.loads(target.read_text())["permissions"]["allow"]
    assert surviving == ["UserAuthored(*)"]
    assert read_sidecar("claude-code", scope) is None


def test_atomic_write_no_partial_on_simulated_interrupt(tmp_data_home, tmp_path, monkeypatch):
    """Simulated interrupt during write must NOT corrupt the target file."""
    target = tmp_path / ".claude/settings.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    original = '{"model": "x"}\n'
    target.write_text(original)

    # Make os.fsync raise after temp file is written but before replace.
    real_fsync = os.fsync

    def boom(*args, **kwargs):
        raise OSError("simulated interrupt")

    monkeypatch.setattr(os, "fsync", boom)
    with pytest.raises(OSError):
        pa._atomic_replace(target, '{"corrupted": true}')
    # Target unchanged
    assert target.read_text() == original
    monkeypatch.setattr(os, "fsync", real_fsync)


def test_capabilities_documented_sets():
    claude = pa.get_adapter("claude")
    codex = pa.get_adapter("codex")
    assert PermissionFeature.TOOL_ALLOWLIST in claude.capabilities()
    assert PermissionFeature.HOOKS in claude.capabilities()
    assert PermissionFeature.SANDBOX_MODE not in claude.capabilities()
    assert PermissionFeature.SANDBOX_MODE in codex.capabilities()
    assert PermissionFeature.APPROVAL_POLICY in codex.capabilities()
    # Codex now advertises Bash-scoped command-rule support.
    assert PermissionFeature.TOOL_ALLOWLIST in codex.capabilities()
    assert PermissionFeature.TOOL_DENYLIST in codex.capabilities()
    assert PermissionFeature.TOOL_ASK in codex.capabilities()


def test_codex_validate_ok_for_bash_unsupported_otherwise():
    """validate() ok for a translatable Bash rule; not-ok for non-Bash / unbounded."""
    codex = pa.get_adapter("codex")
    assert codex.validate(Rule(pattern="Bash(npm:*)", kind="allow")).ok
    assert codex.validate(Rule(pattern="Bash(git push:*)", kind="deny")).ok
    assert not codex.validate(Rule(pattern="Bash(*)", kind="allow")).ok
    assert not codex.validate(Rule(pattern="Read(*)", kind="allow")).ok


def test_unsupported_rule_emits_skip_not_raise(tmp_data_home, tmp_path):
    """A translatable Bash rule is written; a non-Bash rule produces a SkipReason."""
    perms = NormalizedPermissions(
        allow=[
            Rule(pattern="Bash(npm:*)", kind="allow"),
            Rule(pattern="Read(*)", kind="allow"),
        ],
        sandbox_mode="workspace-write",
    )
    adapter = pa.CodexPermissionAdapter()
    scope = GlobalScope()
    # No raise
    result = adapter.translate(perms, scope, "codex")
    codes = {s.feature for s in result.skipped}
    # The Bash rule is NOT skipped; the non-Bash Read(*) IS skipped.
    assert PermissionFeature.TOOL_ALLOWLIST.value in codes
    assert any(s.rule_pattern == "Read(*)" for s in result.skipped)
    assert not any(s.rule_pattern == "Bash(npm:*)" for s in result.skipped)
    # Two writes: sandbox_mode TOML + the starlark rules file.
    formats = {w.format for w in result.writes}
    assert formats == {"toml", "starlark"}


def test_codex_round_trip_preserves_unrelated(tmp_data_home, tmp_path, monkeypatch):
    """Codex adapter uses a fixed global path; redirect via monkeypatching."""
    import tomlkit

    fake_codex = tmp_path / ".codex" / "config.toml"
    fake_codex.parent.mkdir(parents=True, exist_ok=True)
    fake_codex.write_text(
        'model = "gpt-5"\n\n[projects."/other"]\ntrust_level = "untrusted"\n\n[mcp_servers.foo]\ncommand = "x"\n'
    )
    adapter = pa.CodexPermissionAdapter()
    monkeypatch.setattr(adapter, "target_files", lambda scope, harness_id="codex": fake_codex)

    perms = NormalizedPermissions(
        approval_policy="on-failure",
        sandbox_mode="workspace-write",
    )
    scope = GlobalScope()
    result = adapter.translate(perms, scope, "codex")
    adapter.apply(scope, result.writes[0], "codex")

    doc = tomlkit.parse(fake_codex.read_text())
    assert str(doc["model"]) == "gpt-5"
    # Unrelated tables preserved
    assert "/other" in doc["projects"]
    assert "foo" in doc["mcp_servers"]
    # Hub-managed keys present
    assert str(doc["approval_policy"]) == "on-failure"
    assert str(doc["sandbox_mode"]) == "workspace-write"
    # No hub-internal metadata in user file
    raw = fake_codex.read_text()
    assert "_hub_managed_keys" not in raw
    assert "hub-managed" not in raw


def test_translate_result_populates_risks_field():
    """TranslateResult.risks is populated by detect_risks against the adapter's caps."""
    from skill_hub.domain.permissions.permissions import GlobalScope

    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(*)", kind="allow")])
    claude = pa.ClaudePermissionAdapter()
    tr = claude.translate(perms, GlobalScope(), "claude-code")
    codes = {f.code for f in tr.risks}
    assert "UNBOUNDED_BASH" in codes


def test_codex_rejects_unknown_harness_id():
    """target_files validates harness_id; unknown ids raise before any filesystem access."""
    codex = pa.CodexPermissionAdapter()
    with pytest.raises(ValueError, match="unsupported harness"):
        codex.target_files(GlobalScope(), "claude-code")


def test_extras_emits_skip_reason_per_unknown_key():
    """Adapters that don't recognise an extras key emit a SkipReason naming the feature."""
    from skill_hub.domain.permissions.permissions import GlobalScope

    perms = NormalizedPermissions(extras={"shell_environment_policy": {"foo": 1}})
    for adapter, harness_id in (
        (pa.ClaudePermissionAdapter(), "claude-code"),
        (pa.CodexPermissionAdapter(), "codex"),
    ):
        tr = adapter.translate(perms, GlobalScope(), harness_id)
        features = {s.feature for s in tr.skipped}
        assert "shell_environment_policy" in features, f"missing for {harness_id}"


def test_codex_cleanup_removes_only_managed_keys(tmp_data_home, tmp_path, monkeypatch):
    import tomlkit

    fake_codex = tmp_path / ".codex" / "config.toml"
    fake_codex.parent.mkdir(parents=True, exist_ok=True)
    fake_codex.write_text('model = "gpt-5"\n')
    adapter = pa.CodexPermissionAdapter()
    monkeypatch.setattr(adapter, "target_files", lambda scope, harness_id="codex": fake_codex)

    perms = NormalizedPermissions(approval_policy="on-failure", sandbox_mode="workspace-write")
    scope = GlobalScope()
    result = adapter.translate(perms, scope, "codex")
    adapter.apply(scope, result.writes[0], "codex")
    adapter.cleanup(scope, "codex")

    doc = tomlkit.parse(fake_codex.read_text())
    assert str(doc["model"]) == "gpt-5"
    assert "approval_policy" not in doc
    assert "sandbox_mode" not in doc


# ─────────────────────────────────────────────────────────────────────────────
# Codex command-rules (Starlark prefix_rule) — Phase A
# ─────────────────────────────────────────────────────────────────────────────


def _redirect_codex(adapter, monkeypatch, tmp_path):
    """Point the Codex adapter's config.toml + global rules file into tmp_path."""
    fake_codex = tmp_path / ".codex" / "config.toml"
    fake_codex.parent.mkdir(parents=True, exist_ok=True)
    fake_rules = tmp_path / ".codex" / "rules" / "skill-hub.rules"
    monkeypatch.setattr(adapter, "target_files", lambda scope, harness_id="codex": fake_codex)
    monkeypatch.setattr(pac, "_codex_rules_target", lambda scope: fake_rules)
    return fake_codex, fake_rules


def test_codex_translate_kind_to_decision_mapping(tmp_data_home):
    from skill_hub.domain.permissions.permissions import GlobalScope

    adapter = pa.CodexPermissionAdapter()
    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
        ask=[Rule(pattern="Bash(git:*)", kind="ask")],
        deny=[Rule(pattern="Bash(rm:*)", kind="deny")],
    )
    result = adapter.translate(perms, GlobalScope(), "codex")
    star = [w for w in result.writes if w.format == "starlark"]
    assert len(star) == 1
    content = star[0].payload
    assert 'prefix_rule(pattern = ["npm"], decision = "allow"' in content
    assert 'prefix_rule(pattern = ["git"], decision = "prompt"' in content
    assert 'prefix_rule(pattern = ["rm"], decision = "forbidden"' in content


def test_codex_translate_skips_unsupported_shapes(tmp_data_home):
    from skill_hub.domain.permissions.permissions import GlobalScope, Hook

    adapter = pa.CodexPermissionAdapter()
    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(*)", kind="allow"), Rule(pattern="Read(*)", kind="allow")],
        hooks=[Hook(event="PreToolUse", matcher="Bash", command="/x")],
        additional_dirs=["/tmp/extra"],
    )
    result = adapter.translate(perms, GlobalScope(), "codex")
    # No starlark write — nothing translatable.
    assert not [w for w in result.writes if w.format == "starlark"]
    patterns = {s.rule_pattern for s in result.skipped}
    assert "Bash(*)" in patterns
    assert "Read(*)" in patterns
    features = {s.feature for s in result.skipped}
    # Permission-block hooks are retired (hooks-surface D6) — no hook skip emitted.
    assert "hooks" not in features
    assert "additional_directories" not in features


def test_claude_borrowed_directory_survives_cleanup(tmp_data_home, tmp_path):
    from skill_hub.domain.permissions.permissions import ProjectScope

    scope = ProjectScope("borrowed", str(tmp_path))
    target = tmp_path / ".claude" / "settings.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"permissions": {"additionalDirectories": [str(tmp_path)]}}))
    adapter = pa.ClaudePermissionAdapter()
    plan = adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (str(tmp_path),)),), "claude-code")
    adapter.apply_directories(scope, plan, "claude-code")
    adapter.cleanup_directories(scope, "claude-code")
    assert json.loads(target.read_text())["permissions"]["additionalDirectories"] == [str(tmp_path)]


def test_claude_directory_owned_transition_preserves_borrowed_and_manual_duplicate(tmp_data_home, tmp_path):
    from skill_hub.domain.permissions.permissions import ProjectScope

    scope = ProjectScope("transition", str(tmp_path))
    target = tmp_path / ".claude" / "settings.json"
    target.parent.mkdir(parents=True)
    borrowed = str(tmp_path / "borrowed")
    target.write_text(json.dumps({"permissions": {"additionalDirectories": [borrowed, borrowed]}}))
    adapter = pa.ClaudePermissionAdapter()
    plan = adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (borrowed,)),), "claude-code")
    adapter.apply_directories(scope, plan, "claude-code")
    adapter.apply_directories(scope, plan, "claude-code")
    empty = adapter.plan_directories(scope, (), "claude-code")
    adapter.apply_directories(scope, empty, "claude-code")
    assert json.loads(target.read_text())["permissions"]["additionalDirectories"] == [borrowed, borrowed]


def test_codex_directory_owned_transition_preserves_borrowed_and_manual_duplicate(tmp_data_home, tmp_path, monkeypatch):
    import tomlkit

    scope = ProjectScope("codex-transition", str(tmp_path))
    target = tmp_path / ".codex" / "config.toml"
    target.parent.mkdir(parents=True)
    borrowed = str(tmp_path / "borrowed")
    target.write_text('[sandbox_workspace_write]\nwritable_roots = ["%s", "%s"]\n' % (borrowed, borrowed))
    adapter = pa.CodexPermissionAdapter()
    monkeypatch.setattr(adapter, "target_files", lambda scope, harness_id="codex": target)
    contribution = (pa.DirectoryContribution("worktree", (borrowed,)),)
    adapter.apply_directories(scope, adapter.plan_directories(scope, contribution, "codex"), "codex")
    adapter.apply_directories(scope, adapter.plan_directories(scope, (), "codex"), "codex")
    assert list(tomlkit.parse(target.read_text())["sandbox_workspace_write"]["writable_roots"]) == [borrowed, borrowed]
    identity = DirectoryLedgerIdentity.from_scope(scope, "codex")
    assert not directory_sidecar_path("codex", identity).exists()


def test_directory_malformed_native_retains_sidecar_and_bytes(tmp_data_home, tmp_path):
    scope = ProjectScope("malformed", str(tmp_path))
    target = tmp_path / ".claude" / "settings.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"permissions": {"additionalDirectories": "bad"}}\n')
    adapter = pa.ClaudePermissionAdapter()
    identity = DirectoryLedgerIdentity.from_scope(scope, "claude-code")
    write_directory_sidecar(
        identity,
        target,
        {
            "native_key": "permissions.additionalDirectories",
            "entries": {"/owned": {"owned_count": 1}},
            "contributions": {},
        },
    )
    before = target.read_bytes()
    status = adapter.apply_directories(scope, adapter.plan_directories(scope, (), "claude-code"), "claude-code")
    assert status.config_state == "failed"
    assert target.read_bytes() == before
    assert directory_sidecar_path("claude-code", identity).exists()


def test_directory_cleanup_retries_after_native_repair(tmp_data_home, tmp_path):
    scope = ProjectScope("retry", str(tmp_path))
    target = tmp_path / ".claude" / "settings.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"permissions": {"additionalDirectories": "bad"}}\n')
    identity = DirectoryLedgerIdentity.from_scope(scope, "claude-code")
    write_directory_sidecar(
        identity,
        target,
        {
            "native_key": "permissions.additionalDirectories",
            "entries": {"/owned": {"owned_count": 1}},
            "contributions": {},
        },
    )
    adapter = pa.ClaudePermissionAdapter()
    assert adapter.cleanup_directories(scope, "claude-code").config_state == "failed"
    target.write_text(json.dumps({"permissions": {"additionalDirectories": ["/owned", "/manual"]}}))
    assert adapter.cleanup_directories(scope, "claude-code").config_state == "removed"
    assert json.loads(target.read_text())["permissions"]["additionalDirectories"] == ["/manual"]
    assert not directory_sidecar_path("claude-code", identity).exists()


def test_codex_named_profile_writes_workspace_roots_and_rejects_read_only(tmp_data_home, tmp_path, monkeypatch):
    import tomlkit

    target = tmp_path / ".codex" / "config.toml"
    target.parent.mkdir(parents=True)
    target.write_text(
        'default_permissions = "edit"\n[permissions.edit]\nextends = ":workspace"\n[permissions.edit.workspace_roots]\n'
    )
    adapter = pa.CodexPermissionAdapter()
    monkeypatch.setattr(adapter, "target_files", lambda scope, harness_id="codex": target)
    scope = ProjectScope("profile", str(tmp_path))
    path = str(tmp_path / "worktrees")
    status = adapter.apply_directories(
        scope, adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (path,)),), "codex"), "codex"
    )
    assert status.config_state == "configured"
    assert tomlkit.parse(target.read_text())["permissions"]["edit"]["workspace_roots"][path] is True
    target.write_text('default_permissions = ":read-only"\n')
    assert (
        adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (path,)),), "codex").config_state
        == "unsupported"
    )


def test_codex_multi_word_prefix(tmp_data_home):
    from skill_hub.domain.permissions.permissions import GlobalScope

    adapter = pa.CodexPermissionAdapter()
    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(git push:*)", kind="allow")])
    result = adapter.translate(perms, GlobalScope(), "codex")
    content = [w for w in result.writes if w.format == "starlark"][0].payload
    assert 'prefix_rule(pattern = ["git", "push"], decision = "allow"' in content


def test_codex_global_apply_writes_rules_leaves_default_untouched(tmp_data_home, tmp_path, monkeypatch):
    import tomlkit

    adapter = pa.CodexPermissionAdapter()
    fake_codex, fake_rules = _redirect_codex(adapter, monkeypatch, tmp_path)
    fake_codex.write_text('model = "gpt-5"\n')
    # A sibling default.rules the user owns — must stay byte-for-byte.
    default_rules = fake_rules.parent
    default_rules.mkdir(parents=True, exist_ok=True)
    default_file = default_rules / "default.rules"
    default_content = 'prefix_rule(\n    pattern = ["ls"],\n    decision = "allow",\n)\n'
    default_file.write_text(default_content)

    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
        sandbox_mode="workspace-write",
    )
    scope = GlobalScope()
    result = adapter.translate(perms, scope, "codex")
    for w in result.writes:
        adapter.apply(scope, w, "codex")

    assert 'prefix_rule(pattern = ["npm"], decision = "allow"' in fake_rules.read_text()
    assert default_file.read_text() == default_content  # untouched
    doc = tomlkit.parse(fake_codex.read_text())
    assert str(doc["model"]) == "gpt-5"
    assert str(doc["sandbox_mode"]) == "workspace-write"


def test_codex_project_apply_sets_trust_and_warns(tmp_data_home, tmp_path, monkeypatch):
    import tomlkit

    adapter = pa.CodexPermissionAdapter()
    fake_codex = tmp_path / "home" / ".codex" / "config.toml"
    fake_codex.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(adapter, "target_files", lambda scope, harness_id="codex": fake_codex)
    repo = tmp_path / "repo"
    repo.mkdir()
    scope = ProjectScope(name="alpha", path=str(repo))

    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(npm:*)", kind="allow")])
    result = adapter.translate(perms, scope, "codex")
    # Trust auto-granted → warning present.
    assert result.warnings
    assert any("trust" in w.lower() for w in result.warnings)
    assert any(f.code == "CODEX_PROJECT_TRUST_GRANTED" for f in result.risks)
    for w in result.writes:
        adapter.apply(scope, w, "codex")

    rules_file = repo / ".codex" / "rules" / "skill-hub.rules"
    assert rules_file.exists()
    assert 'prefix_rule(pattern = ["npm"]' in rules_file.read_text()
    doc = tomlkit.parse(fake_codex.read_text())
    assert str(doc["projects"][str(repo)]["trust_level"]) == "trusted"


def test_codex_apply_toml_skips_gracefully_without_tomlkit(tmp_data_home, tmp_path, monkeypatch):
    """A Python env without tomlkit (e.g. a CI job that never pip-installs it)
    must degrade the TOML write to a clean skip, not crash the whole sync with
    an uncaught ImportError (the sudden-uninstalled-dependency regression the
    hooks-surface review panel's CI run caught for the FIRST time)."""
    adapter = pa.CodexPermissionAdapter()
    fake_codex, fake_rules = _redirect_codex(adapter, monkeypatch, tmp_path)
    monkeypatch.setattr(pac, "_tomlkit_missing", lambda: True)

    perms = NormalizedPermissions(sandbox_mode="workspace-write")
    result = adapter.translate(perms, GlobalScope(), "codex")
    toml_write = next(w for w in result.writes if w.format != "starlark")
    ok = adapter.apply(GlobalScope(), toml_write, "codex")
    assert ok is False  # skip, not an exception
    assert not fake_codex.exists()

    # cleanup() and discover_existing() must also degrade gracefully.
    assert adapter.cleanup(GlobalScope(), "codex") is False
    assert adapter.discover_existing(GlobalScope(), "codex") == NormalizedPermissions()


def test_codex_rules_idempotent_and_removal(tmp_data_home, tmp_path, monkeypatch):
    adapter = pa.CodexPermissionAdapter()
    fake_codex, fake_rules = _redirect_codex(adapter, monkeypatch, tmp_path)
    scope = GlobalScope()

    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(npm:*)", kind="allow")])
    r1 = adapter.translate(perms, scope, "codex")
    for w in r1.writes:
        adapter.apply(scope, w, "codex")
    first = fake_rules.read_text()

    r2 = adapter.translate(perms, scope, "codex")
    for w in r2.writes:
        adapter.apply(scope, w, "codex")
    assert fake_rules.read_text() == first  # byte-identical re-sync

    # Remove the rule → regenerated file (deletion write) drops it.
    empty = NormalizedPermissions()
    r3 = adapter.translate(empty, scope, "codex")
    for w in r3.writes:
        adapter.apply(scope, w, "codex")
    assert not fake_rules.exists()


def test_codex_cleanup_removes_both_writes(tmp_data_home, tmp_path, monkeypatch):
    """D9 regression: cleanup removes BOTH the config.toml managed keys and the
    rules file after both writes were applied for one (codex, scope)."""
    from skill_hub.domain.permissions.permissions import read_sidecar

    adapter = pa.CodexPermissionAdapter()
    fake_codex, fake_rules = _redirect_codex(adapter, monkeypatch, tmp_path)
    fake_codex.write_text('model = "gpt-5"\n')
    scope = GlobalScope()

    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
        sandbox_mode="workspace-write",
    )
    result = adapter.translate(perms, scope, "codex")
    assert len(result.writes) == 2
    for w in result.writes:
        adapter.apply(scope, w, "codex")
    assert fake_rules.exists()
    assert read_sidecar("codex", scope) is not None
    assert read_sidecar("codex", scope, kind="rules") is not None

    adapter.cleanup(scope, "codex")
    assert not fake_rules.exists()
    assert read_sidecar("codex", scope) is None
    assert read_sidecar("codex", scope, kind="rules") is None
    import tomlkit

    doc = tomlkit.parse(fake_codex.read_text())
    assert str(doc["model"]) == "gpt-5"
    assert "sandbox_mode" not in doc


def test_codex_partial_capability_still_skips_non_bash(tmp_data_home):
    """D6: TOOL_ALLOWLIST advertised, but a non-Bash Read(*) still skips."""
    from skill_hub.domain.permissions.permissions import GlobalScope

    adapter = pa.CodexPermissionAdapter()
    assert PermissionFeature.TOOL_ALLOWLIST in adapter.capabilities()
    perms = NormalizedPermissions(allow=[Rule(pattern="Read(*)", kind="allow")])
    result = adapter.translate(perms, GlobalScope(), "codex")
    assert any(s.rule_pattern == "Read(*)" for s in result.skipped)
    assert not [w for w in result.writes if w.format == "starlark"]


# ─────────────────────────────────────────────────────────────────────────────
# Phase B: default.rules parsing, MOVE/excise, reconciliation
# ─────────────────────────────────────────────────────────────────────────────


# TA-1-f47f: `test_parse_prefix_rules_shapes` pinned the same five input
# shapes through this private wrapper that tests/test_harness_permission_codec.py
# already pins through the public `CodexPermissionCodec.decode`, so the two
# could only fail together. Deleted; the wrapper's key-renaming mapping (this
# module's only real addition over the codec) is carried by
# `test_codex_discover_candidates_from_default_rules` and
# `test_codex_excise_rule_preserves_siblings` below, both of which read the
# wrapper's dict keys as real callers do.


def test_parse_prefix_rules_raises_on_garbage():
    import pytest

    with pytest.raises((SyntaxError, ValueError)):
        pa._parse_prefix_rules("this is (not valid python := !!!\n")


def test_codex_discover_candidates_from_default_rules(tmp_data_home, tmp_path, monkeypatch):
    adapter = pa.CodexPermissionAdapter()
    rules_dir = tmp_path / ".codex" / "rules"
    rules_dir.mkdir(parents=True)
    (rules_dir / "default.rules").write_text('prefix_rule(\n    pattern = ["npm"],\n    decision = "allow",\n)\n')
    monkeypatch.setattr(pac, "_codex_default_rules_target", lambda scope: rules_dir / "default.rules")
    monkeypatch.setattr(pac, "_codex_rules_target", lambda scope: rules_dir / "skill-hub.rules")
    cands = adapter.discover_candidates(GlobalScope(), "codex")
    assert len(cands) == 1
    c = cands[0]
    assert c["pattern"] == "Bash(npm:*)"
    assert c["kind"] == "allow"
    assert c["source"] == "default.rules"
    assert c["importable"]


def test_codex_excise_rule_preserves_siblings(tmp_data_home, tmp_path):
    adapter = pa.CodexPermissionAdapter()
    f = tmp_path / "default.rules"
    f.write_text(
        "# header comment\n"
        'prefix_rule(pattern = ["npm"], decision = "allow")\n'
        "prefix_rule(\n"
        '    pattern = ["git"],\n'
        '    decision = "prompt",\n'
        ")\n"
        'prefix_rule(pattern = ["rm"], decision = "forbidden")\n'
    )
    parsed = pa._parse_prefix_rules(f.read_text())
    git_rule = [p for p in parsed if p["tokens"] == ["git"]][0]
    assert adapter.excise_rule(f, git_rule["lineno"], git_rule["end_lineno"])
    out = f.read_text()
    assert "# header comment" in out
    assert '["npm"]' in out
    assert '["rm"]' in out
    assert '["git"]' not in out


def test_reconcile_collapse_conflict_unimportable():
    candidates = [
        # same command + same decision across two harnesses → collapse
        {
            "pattern": "Bash(npm:*)",
            "kind": "allow",
            "harness": "claude-code",
            "importable": True,
            "source": "settings.json",
        },
        {"pattern": "Bash(npm:*)", "kind": "allow", "harness": "codex", "importable": True, "source": "default.rules"},
        # divergent decision → conflict
        {
            "pattern": "Bash(git:*)",
            "kind": "allow",
            "harness": "claude-code",
            "importable": True,
            "source": "settings.json",
        },
        {"pattern": "Bash(git:*)", "kind": "ask", "harness": "codex", "importable": True, "source": "default.rules"},
        # un-importable codex shape
        {
            "pattern": None,
            "kind": None,
            "harness": "codex",
            "importable": False,
            "reason": "uses match/not_match argument constraints",
            "source": "default.rules",
        },
    ]
    out = pa.reconcile_candidates(candidates)
    assert len(out["merged"]) == 1
    assert out["merged"][0]["pattern"] == "Bash(npm:*)"
    assert out["merged"][0]["harnesses"] is None
    assert len(out["merged"][0]["sources"]) == 2  # both origins for MOVE
    assert len(out["conflicts"]) == 1
    assert set(out["conflicts"][0]["options"]) == {"allow", "ask"}
    assert len(out["un_importable"]) == 1


# ─────────────────────────────────────────────────────────────────────────────
# Claude permission adapter no longer authors hooks (hooks-surface task 2.2):
# hooks live in the hook library + hook_adapters. The perms adapter neither
# translates, writes, nor discovers a `hooks:` section. Its generic sidecar
# cleanup still strips any legacy hook keys still recorded in a perms sidecar.
# ─────────────────────────────────────────────────────────────────────────────


def test_translate_no_longer_emits_hook_keys(tmp_data_home, tmp_path):
    """A perms block carrying hooks produces NO hook managed keys or writes."""
    perms = NormalizedPermissions(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
        hooks=[Hook(event="PostToolUse", matcher="Edit", command="echo hi")],
    )
    adapter = pa.ClaudePermissionAdapter()
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    result = adapter.translate(perms, scope, "claude-code")
    assert not any(k.startswith("hooks.") for k in result.writes[0].managed_keys)
    adapter.apply(scope, result.writes[0], "claude-code")
    data = json.loads(_claude_proj_target(tmp_path).read_text())
    assert "hooks" not in data


def test_discover_no_longer_returns_hooks(tmp_data_home, tmp_path):
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    target = _claude_proj_target(tmp_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "permissions": {"allow": ["Read(*)"]},
                "hooks": {
                    "PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "echo hi"}]}]
                },
            }
        )
    )
    adapter = pa.ClaudePermissionAdapter()
    perms = adapter.discover_existing(scope, "claude-code")
    assert perms.hooks == []
    assert [r.pattern for r in perms.allow] == ["Read(*)"]


def test_cleanup_strips_managed_nested_entry_neighbor_survives(tmp_data_home, tmp_path):
    """Managed nested entry 0 removed; user-authored entry 1 survives byte-identical."""
    from skill_hub.domain.permissions.permissions import write_sidecar

    scope = ProjectScope(name="alpha", path=str(tmp_path))
    target = _claude_proj_target(tmp_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    user_entry = {"matcher": "Bash", "hooks": [{"type": "command", "command": "user-cmd"}]}
    hub_entry = {"matcher": "Edit", "hooks": [{"type": "command", "command": "hub-cmd"}]}
    target.write_text(json.dumps({"hooks": {"PostToolUse": [hub_entry, user_entry]}}, indent=2) + "\n")
    write_sidecar("claude-code", scope, ["hooks.PostToolUse[0]"], target)

    adapter = pa.ClaudePermissionAdapter()
    assert adapter.cleanup(scope, "claude-code") is True

    data = json.loads(target.read_text())
    # Only the user-authored entry remains, content intact.
    assert data["hooks"]["PostToolUse"] == [user_entry]
    assert read_sidecar("claude-code", scope) is None


@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_project_sync_emits_worktree_to_real_native_target(tmp_data_home, tmp_path, harness):
    from skill_hub.domain.permissions.permissions import ProjectScope

    project = tmp_path / "checkout"
    project.mkdir()
    requested = tmp_path / "external-parent" / "worktree-alpha"
    adapter = pa.get_adapter("claude" if harness == "claude-code" else "codex")
    scope = ProjectScope("alpha", str(project), personal=harness == "claude-code")
    plan = adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (str(requested),)),), harness)
    status = adapter.apply_directories(scope, plan, harness)
    assert status.config_state == "configured"
    assert status.requested_path == str(requested)
    assert not requested.exists()
    if harness == "claude-code":
        native = project / ".claude" / "settings.local.json"
        assert json.loads(native.read_text())["permissions"]["additionalDirectories"] == [str(requested)]
    else:
        import tomlkit

        native = project / ".codex" / "config.toml"
        assert str(requested) in list(tomlkit.parse(native.read_text())["sandbox_workspace_write"]["writable_roots"])


def test_claude_personal_worktree_cleanup_uses_local_target(tmp_data_home, tmp_path):
    scope = ProjectScope("alpha", str(tmp_path), personal=True)
    adapter = pa.ClaudePermissionAdapter()
    path = str(tmp_path / "wt")
    plan = adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (path,)),), "claude-code")
    adapter.apply_directories(scope, plan, "claude-code")
    assert adapter.cleanup_directories(scope, "claude-code").config_state == "removed"
    assert (
        not json.loads((tmp_path / ".claude" / "settings.local.json").read_text())
        .get("permissions", {})
        .get("additionalDirectories")
    )


def test_forged_directory_sidecar_identity_is_rejected_without_mutation(tmp_data_home, tmp_path):
    scope = ProjectScope("alpha", str(tmp_path))
    target = tmp_path / ".claude" / "settings.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"permissions": {"additionalDirectories": ["/user"]}}))
    identity = DirectoryLedgerIdentity.from_scope(scope, "claude-code")
    write_directory_sidecar(
        identity,
        target,
        {
            "native_key": "permissions.additionalDirectories",
            "entries": {"/hub": {"owned_count": 1}},
            "contributions": {},
        },
    )
    forged_path = directory_sidecar_path("claude-code", identity)
    forged = json.loads(forged_path.read_text())
    forged["directory_ledger"]["identity"]["project_name"] = "other"
    forged_path.write_text(json.dumps(forged))
    before = target.read_bytes()
    adapter_cleanup = pa.ClaudePermissionAdapter().cleanup_directories(scope, "claude-code")
    assert adapter_cleanup
    assert adapter_cleanup.config_state == "failed"
    assert target.read_bytes() == before


@pytest.mark.parametrize(
    "field,value",
    [
        ("harness", "codex"),
        ("scope", "project-other"),
        ("file", "/tmp/other"),
        ("native_key", "permissions.allow"),
    ],
)
def test_forged_directory_sidecar_fields_fail_closed(tmp_data_home, tmp_path, field, value):
    scope = ProjectScope("alpha", str(tmp_path))
    target = tmp_path / ".claude" / "settings.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"permissions": {"additionalDirectories": ["/manual"]}}')
    identity = DirectoryLedgerIdentity.from_scope(scope, "claude-code")
    write_directory_sidecar(
        identity,
        target,
        {
            "native_key": "permissions.additionalDirectories",
            "entries": {"/owned": {"owned_count": 1}},
            "contributions": {},
        },
    )
    sidecar_path = directory_sidecar_path("claude-code", identity)
    data = json.loads(sidecar_path.read_text())
    if field == "native_key":
        data["directory_ledger"]["native_key"] = value
    else:
        data[field] = value
    sidecar_path.write_text(json.dumps(data))
    before = target.read_bytes()
    assert pa.ClaudePermissionAdapter().cleanup_directories(scope, "claude-code").config_state == "failed"
    assert target.read_bytes() == before


def test_user_selected_codex_profile_extends_apply(tmp_data_home, tmp_path, monkeypatch):
    import tomlkit

    home_cfg = tmp_path / "user-config.toml"
    home_cfg.write_text('default_permissions = "edit"\n[permissions.edit]\nextends = ":workspace"\n')
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(pac, "_CODEX_GLOBAL", home_cfg)
    adapter = pa.CodexPermissionAdapter()
    scope = ProjectScope("alpha", str(project))
    path = str(tmp_path / "wt")
    plan = adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (path,)),), "codex")
    status = adapter.apply_directories(scope, plan, "codex")
    assert status.config_state == "configured"
    doc = tomlkit.parse((project / ".codex" / "config.toml").read_text())
    assert doc["permissions"]["edit"]["workspace_roots"][path] is True


def test_global_directory_clear_removes_owned_entry_preserves_unrelated(tmp_data_home, tmp_path, monkeypatch):
    target = tmp_path / "settings.json"
    target.write_text(json.dumps({"permissions": {"additionalDirectories": ["/manual"]}}))
    adapter = pa.ClaudePermissionAdapter()
    monkeypatch.setattr(adapter, "target_files", lambda scope, harness_id="claude-code": target)
    scope = GlobalScope()
    owned = str(tmp_path / "owned")
    adapter.apply_directories(
        scope,
        adapter.plan_directories(scope, (pa.DirectoryContribution("generic:global", (owned,)),), "claude-code"),
        "claude-code",
    )
    adapter.apply_directories(scope, adapter.plan_directories(scope, (), "claude-code"), "claude-code")
    assert json.loads(target.read_text())["permissions"]["additionalDirectories"] == ["/manual"]
