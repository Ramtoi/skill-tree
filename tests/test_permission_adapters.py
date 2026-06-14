"""Permission adapters: round-trip, sidecar-driven cleanup, no metadata pollution."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

import permission_adapters as pa
from permissions import (
    GlobalScope,
    Hook,
    NormalizedPermissions,
    PermissionFeature,
    ProjectScope,
    Rule,
    read_sidecar,
)


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
    target.write_text(json.dumps({
        "model": "claude-sonnet-4-6",
        "permissions": {
            "allow": ["UserAuthored(*)"],
        },
        "unrelated": {"foo": "bar"},
    }))

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
    assert json.loads(target.read_text())["permissions"]["allow"] == [
        "UserAuthored(*)", "Hub(*)"
    ]
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
        "model = \"gpt-5\"\n"
        "\n"
        "[projects.\"/other\"]\n"
        "trust_level = \"untrusted\"\n"
        "\n"
        "[mcp_servers.foo]\n"
        "command = \"x\"\n"
    )
    adapter = pa.CodexPermissionAdapter()
    monkeypatch.setattr(adapter, "target_files",
                        lambda scope, harness_id="codex": fake_codex)

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
    from permissions import GlobalScope
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
    from permissions import GlobalScope
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
    fake_codex.write_text("model = \"gpt-5\"\n")
    adapter = pa.CodexPermissionAdapter()
    monkeypatch.setattr(adapter, "target_files",
                        lambda scope, harness_id="codex": fake_codex)

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
    monkeypatch.setattr(adapter, "target_files",
                        lambda scope, harness_id="codex": fake_codex)
    monkeypatch.setattr(pa, "_codex_rules_target", lambda scope: fake_rules)
    return fake_codex, fake_rules


def test_codex_translate_kind_to_decision_mapping(tmp_data_home):
    from permissions import GlobalScope
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
    from permissions import GlobalScope, Hook
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
    assert "hooks" in features
    assert "additional_directories" in features


def test_codex_multi_word_prefix(tmp_data_home):
    from permissions import GlobalScope
    adapter = pa.CodexPermissionAdapter()
    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(git push:*)", kind="allow")])
    result = adapter.translate(perms, GlobalScope(), "codex")
    content = [w for w in result.writes if w.format == "starlark"][0].payload
    assert 'prefix_rule(pattern = ["git", "push"], decision = "allow"' in content


def test_codex_global_apply_writes_rules_leaves_default_untouched(
    tmp_data_home, tmp_path, monkeypatch
):
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
    monkeypatch.setattr(adapter, "target_files",
                        lambda scope, harness_id="codex": fake_codex)
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
    from permissions import read_sidecar
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
    from permissions import GlobalScope
    adapter = pa.CodexPermissionAdapter()
    assert PermissionFeature.TOOL_ALLOWLIST in adapter.capabilities()
    perms = NormalizedPermissions(allow=[Rule(pattern="Read(*)", kind="allow")])
    result = adapter.translate(perms, GlobalScope(), "codex")
    assert any(s.rule_pattern == "Read(*)" for s in result.skipped)
    assert not [w for w in result.writes if w.format == "starlark"]


# ─────────────────────────────────────────────────────────────────────────────
# Phase B: default.rules parsing, MOVE/excise, reconciliation
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_prefix_rules_shapes():
    text = (
        "# a comment\n"
        'prefix_rule(pattern = ["npm"], decision = "allow")\n'
        "prefix_rule(\n"
        '    pattern = ["git", "push"],\n'
        '    decision = "prompt",\n'
        ")\n"
        'prefix_rule(pattern = ["rm"])\n'  # default decision = allow
        'prefix_rule(pattern = ["gh"], decision = "allow", not_match = ["--force"])\n'
        'prefix_rule(pattern = [["view", "list"]], decision = "allow")\n'  # union → un-importable
    )
    parsed = pa._parse_prefix_rules(text)
    assert len(parsed) == 5
    assert parsed[0]["tokens"] == ["npm"] and parsed[0]["importable"]
    assert parsed[1]["tokens"] == ["git", "push"] and parsed[1]["decision"] == "prompt"
    # multi-line span captured
    assert parsed[1]["end_lineno"] > parsed[1]["lineno"]
    assert parsed[2]["decision"] == "allow"  # default
    assert not parsed[3]["importable"] and "match" in parsed[3]["reason"]
    assert not parsed[4]["importable"]  # pattern union


def test_parse_prefix_rules_raises_on_garbage():
    import pytest
    with pytest.raises((SyntaxError, ValueError)):
        pa._parse_prefix_rules("this is (not valid python := !!!\n")


def test_codex_discover_candidates_from_default_rules(tmp_data_home, tmp_path, monkeypatch):
    adapter = pa.CodexPermissionAdapter()
    rules_dir = tmp_path / ".codex" / "rules"
    rules_dir.mkdir(parents=True)
    (rules_dir / "default.rules").write_text(
        'prefix_rule(\n    pattern = ["npm"],\n    decision = "allow",\n)\n'
    )
    monkeypatch.setattr(pa, "_codex_default_rules_target",
                        lambda scope: rules_dir / "default.rules")
    monkeypatch.setattr(pa, "_codex_rules_target",
                        lambda scope: rules_dir / "skill-hub.rules")
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
        {"pattern": "Bash(npm:*)", "kind": "allow", "harness": "claude-code",
         "importable": True, "source": "settings.json"},
        {"pattern": "Bash(npm:*)", "kind": "allow", "harness": "codex",
         "importable": True, "source": "default.rules"},
        # divergent decision → conflict
        {"pattern": "Bash(git:*)", "kind": "allow", "harness": "claude-code",
         "importable": True, "source": "settings.json"},
        {"pattern": "Bash(git:*)", "kind": "ask", "harness": "codex",
         "importable": True, "source": "default.rules"},
        # un-importable codex shape
        {"pattern": None, "kind": None, "harness": "codex", "importable": False,
         "reason": "uses match/not_match argument constraints", "source": "default.rules"},
    ]
    out = pa.reconcile_candidates(candidates)
    assert len(out["merged"]) == 1
    assert out["merged"][0]["pattern"] == "Bash(npm:*)"
    assert out["merged"][0]["harnesses"] is None
    assert len(out["merged"][0]["sources"]) == 2  # both origins for MOVE
    assert len(out["conflicts"]) == 1
    assert set(out["conflicts"][0]["options"]) == {"allow", "ask"}
    assert len(out["un_importable"]) == 1
