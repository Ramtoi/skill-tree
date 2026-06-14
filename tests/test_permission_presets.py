"""Unit tests for permission_presets.py — data model, built-in definitions,
and rule-stamping semantics."""

from __future__ import annotations

import pytest

from permission_presets import (
    BUILTIN_PRESETS,
    PermissionPreset,
    PresetRule,
    all_presets,
    apply_preset,
    get_preset,
    is_builtin,
)


# ─── Built-in shape ──────────────────────────────────────────────────────────


def test_builtin_presets_have_git_safe_and_android_gradle():
    ids = {p.id for p in BUILTIN_PRESETS}
    assert {"git-safe", "android-gradle"}.issubset(ids)


def test_git_safe_rule_count():
    preset = next(p for p in BUILTIN_PRESETS if p.id == "git-safe")
    assert len(preset.rules) == 16


def test_android_gradle_rule_count():
    preset = next(p for p in BUILTIN_PRESETS if p.id == "android-gradle")
    assert len(preset.rules) == 19


def test_git_safe_default_enabled_rules_are_read_only():
    """No mutating git subcommand may be enabled by default."""
    preset = next(p for p in BUILTIN_PRESETS if p.id == "git-safe")
    allowed_subcommands = {
        "status", "log", "diff", "show", "branch", "remote",
        "stash list", "stash show", "tag", "ls-files", "blame",
        "shortlog", "describe", "rev-parse", "cat-file",
    }
    forbidden_substrings = [
        "push", "commit", "add", "rm", "reset", "revert", "merge",
        "rebase", "checkout", "switch", "restore", "cherry-pick",
        "pull", "clean", "stash push", "stash pop", "stash drop",
    ]
    for rule in preset.rules:
        if not rule.enabled_by_default:
            continue
        # Extract subcommand from "Bash(git X*)" pattern.
        inner = rule.pattern.removeprefix("Bash(git ").removesuffix("*)")
        assert any(
            inner.startswith(sub) for sub in allowed_subcommands
        ), f"{rule.pattern!r} not in read-only allowlist"
        for bad in forbidden_substrings:
            assert bad not in inner, (
                f"{rule.pattern!r} matches forbidden mutating substring {bad!r}"
            )


def test_git_fetch_present_but_off_by_default():
    preset = next(p for p in BUILTIN_PRESETS if p.id == "git-safe")
    fetch_rules = [r for r in preset.rules if "git fetch" in r.pattern]
    assert len(fetch_rules) == 1
    assert fetch_rules[0].enabled_by_default is False


def test_android_gradle_includes_windows_wrapper():
    preset = next(p for p in BUILTIN_PRESETS if p.id == "android-gradle")
    patterns = {r.pattern for r in preset.rules}
    assert "Bash(gradlew*)" in patterns
    # Windows wrapper enabled by default.
    rule = next(r for r in preset.rules if r.pattern == "Bash(gradlew*)")
    assert rule.enabled_by_default is True


def test_android_gradle_covers_standard_loop():
    preset = next(p for p in BUILTIN_PRESETS if p.id == "android-gradle")
    patterns = {r.pattern for r in preset.rules}
    required = {
        "Bash(./gradlew tasks*)",
        "Bash(./gradlew dependencies*)",
        "Bash(./gradlew clean*)",
        "Bash(./gradlew build*)",
        "Bash(./gradlew assembleDebug*)",
        "Bash(./gradlew assembleRelease*)",
        "Bash(./gradlew test*)",
        "Bash(./gradlew lint*)",
        "Bash(./gradlew connectedAndroidTest*)",
    }
    assert required.issubset(patterns)


def test_builtin_presets_are_marked_builtin():
    for p in BUILTIN_PRESETS:
        assert p.builtin is True


def test_is_builtin():
    assert is_builtin("git-safe")
    assert is_builtin("android-gradle")
    assert not is_builtin("my-custom")


# ─── all_presets / get_preset ────────────────────────────────────────────────


def test_all_presets_with_empty_registry():
    out = all_presets({})
    assert len(out) == len(BUILTIN_PRESETS)
    assert {p.id for p in out} == {p.id for p in BUILTIN_PRESETS}


def test_all_presets_merges_user_presets():
    registry = {
        "permission_presets": {
            "my-npm": {
                "name": "NPM scripts",
                "description": "Common npm dev tasks",
                "icon": "📦",
                "category": "custom",
                "rules": [
                    {
                        "pattern": "Bash(npm run *)",
                        "kind": "allow",
                        "description": "any npm script",
                        "enabled_by_default": True,
                    }
                ],
            }
        }
    }
    presets = all_presets(registry)
    ids = [p.id for p in presets]
    assert ids[: len(BUILTIN_PRESETS)] == [p.id for p in BUILTIN_PRESETS]
    assert "my-npm" in ids
    user = next(p for p in presets if p.id == "my-npm")
    assert user.builtin is False
    assert user.name == "NPM scripts"
    assert len(user.rules) == 1


def test_user_preset_colliding_with_builtin_id_is_skipped():
    registry = {
        "permission_presets": {
            "git-safe": {"name": "spoofed", "rules": []}
        }
    }
    git_safe = next(p for p in all_presets(registry) if p.id == "git-safe")
    assert git_safe.builtin is True
    assert git_safe.name != "spoofed"


def test_get_preset_returns_none_for_unknown():
    assert get_preset("nope", {}) is None


def test_get_preset_finds_builtin():
    p = get_preset("git-safe", {})
    assert p is not None
    assert p.builtin is True


# ─── apply_preset ────────────────────────────────────────────────────────────


def _preset_with(rules: list[PresetRule]) -> PermissionPreset:
    return PermissionPreset(
        id="t", name="t", description="", icon="🔧", category="custom",
        builtin=False, rules=rules,
    )


def test_apply_preset_defaults_picks_enabled_by_default_only():
    preset = _preset_with([
        PresetRule("Bash(a*)", enabled_by_default=True),
        PresetRule("Bash(b*)", enabled_by_default=False),
        PresetRule("Bash(c*)", enabled_by_default=True),
    ])
    out = apply_preset(preset, None, [])
    patterns = [r["pattern"] for r in out]
    assert patterns == ["Bash(a*)", "Bash(c*)"]


def test_apply_preset_filter_picks_only_named_patterns():
    preset = _preset_with([
        PresetRule("Bash(a*)", enabled_by_default=False),  # explicitly named
        PresetRule("Bash(b*)", enabled_by_default=True),   # ignored — not in filter
        PresetRule("Bash(c*)", enabled_by_default=True),
    ])
    out = apply_preset(preset, ["Bash(a*)", "Bash(c*)"], [])
    patterns = [r["pattern"] for r in out]
    assert sorted(patterns) == ["Bash(a*)", "Bash(c*)"]


def test_apply_preset_dedupes_against_existing_rules():
    preset = _preset_with([
        PresetRule("Bash(git log*)"),
        PresetRule("Bash(git diff*)"),
    ])
    existing = [{"pattern": "Bash(git log*)", "kind": "allow"}]
    out = apply_preset(preset, None, existing)
    patterns = [r["pattern"] for r in out]
    assert patterns.count("Bash(git log*)") == 1
    assert "Bash(git diff*)" in patterns


def test_apply_preset_idempotent_on_repeat():
    preset = _preset_with([
        PresetRule("Bash(a*)"),
        PresetRule("Bash(b*)"),
    ])
    first = apply_preset(preset, None, [])
    second = apply_preset(preset, None, first)
    assert first == second


def test_apply_preset_does_not_mutate_input():
    preset = _preset_with([PresetRule("Bash(a*)")])
    existing = [{"pattern": "Bash(z*)", "kind": "allow"}]
    out = apply_preset(preset, None, existing)
    assert existing == [{"pattern": "Bash(z*)", "kind": "allow"}]
    assert out is not existing


def test_apply_preset_tolerates_string_existing_rules():
    """Some pre-existing rules may be bare strings rather than dicts."""
    preset = _preset_with([
        PresetRule("Bash(git log*)"),
        PresetRule("Bash(git diff*)"),
    ])
    existing = ["Bash(git log*)"]
    out = apply_preset(preset, None, existing)
    patterns = [r if isinstance(r, str) else r["pattern"] for r in out]
    assert patterns.count("Bash(git log*)") == 1
    assert "Bash(git diff*)" in patterns
