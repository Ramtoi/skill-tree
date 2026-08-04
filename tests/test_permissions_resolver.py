"""Resolver: project-wins precedence, provenance, set-union additional_dirs."""

from __future__ import annotations

import pytest

from permissions import (
    Hook,
    NormalizedPermissions,
    Rule,
    migrate_permissions_schema,
    resolve_effective,
)


def _reg(*, global_block=None, project_block=None) -> tuple[dict, dict]:
    project = {"path": "/tmp/p", "permissions": project_block or {}}
    registry = {
        "permissions_global": global_block or {},
        "projects": {"alpha": project},
    }
    return project, registry


def test_project_wins_on_pattern_kind_dedupe():
    project, registry = _reg(
        global_block={
            "allow": [
                {"pattern": "Bash(git:*)", "kind": "allow"},
                {"pattern": "Bash(npm:*)", "kind": "allow"},
            ],
        },
        project_block={
            "allow": [
                {"pattern": "Bash(git:*)", "kind": "allow",
                 "harnesses": ["claude-code"]},
            ],
        },
    )
    eff = resolve_effective(project, registry)
    patterns = [(r.pattern, r.origin, r.harnesses) for r in eff.allow]
    assert ("Bash(git:*)", "project", ["claude-code"]) in patterns
    # The global Bash(git:*) entry must be shadowed
    assert ("Bash(git:*)", "global", None) not in patterns
    # Other global rule survives unchanged
    assert ("Bash(npm:*)", "global", None) in patterns


def test_hook_dedupe_on_event_matcher_command():
    project, registry = _reg(
        global_block={
            "hooks": [
                {"event": "PreToolUse", "matcher": "Bash", "command": "/x"},
                {"event": "PreToolUse", "matcher": "Read", "command": "/y"},
            ],
        },
        project_block={
            "hooks": [
                {"event": "PreToolUse", "matcher": "Bash", "command": "/x",
                 "harnesses": ["claude-code"]},
            ],
        },
    )
    eff = resolve_effective(project, registry)
    origins = {(h.event, h.matcher, h.command, h.origin) for h in eff.hooks}
    assert ("PreToolUse", "Bash", "/x", "project") in origins
    assert ("PreToolUse", "Bash", "/x", "global") not in origins
    assert ("PreToolUse", "Read", "/y", "global") in origins


def test_typed_field_shadowing():
    project, registry = _reg(
        global_block={"sandbox_mode": "workspace-write",
                      "approval_policy": "untrusted"},
        project_block={"sandbox_mode": "danger-full-access"},
    )
    eff = resolve_effective(project, registry)
    assert eff.sandbox_mode == "danger-full-access"
    # global fallback when project leaves it None
    assert eff.approval_policy == "untrusted"


def test_additional_dirs_union_order_preserving():
    project, registry = _reg(
        global_block={"additional_dirs": ["/a", "/b"]},
        project_block={"additional_dirs": ["/b", "/c"]},
    )
    eff = resolve_effective(project, registry)
    assert eff.additional_dirs == ["/a", "/b", "/c"]


def test_extras_project_shadow_global():
    project, registry = _reg(
        global_block={"extras": {"foo": 1, "bar": 2}},
        project_block={"extras": {"bar": 99, "baz": 3}},
    )
    eff = resolve_effective(project, registry)
    assert eff.extras == {"foo": 1, "bar": 99, "baz": 3}


def test_origin_attached_to_every_rule_and_hook():
    project, registry = _reg(
        global_block={"allow": [{"pattern": "X", "kind": "allow"}]},
        project_block={"deny": [{"pattern": "Y", "kind": "deny"}],
                       "hooks": [{"event": "E", "matcher": "M", "command": "C"}]},
    )
    eff = resolve_effective(project, registry)
    assert all(r.origin in {"global", "project"} for r in eff.allow + eff.deny + eff.ask)
    assert all(h.origin in {"global", "project"} for h in eff.hooks)


def test_migrate_permissions_schema_idempotent():
    reg = {"projects": {"alpha": {"path": "/p"}}}
    assert migrate_permissions_schema(reg) is True
    assert "permissions_global" in reg
    assert reg["projects"]["alpha"]["permissions"] == {}
    # Second call is a no-op
    assert migrate_permissions_schema(reg) is False


def test_migrate_permissions_preserves_existing_block():
    reg = {
        "permissions_global": {"allow": [{"pattern": "X", "kind": "allow"}]},
        "projects": {"alpha": {"path": "/p", "permissions": {"deny": []}}},
    }
    assert migrate_permissions_schema(reg) is False
    assert reg["permissions_global"]["allow"]


def test_unmanaged_set_unioned_not_replaced():
    """D5: resolve_effective set-unions _unmanaged from global and project."""
    project, registry = _reg(
        global_block={"_unmanaged": ["pi"]},
        project_block={"_unmanaged": ["codex"]},
    )
    eff = resolve_effective(project, registry)
    assert "pi" in eff._unmanaged
    assert "codex" in eff._unmanaged


def test_unmanaged_empty_project_inherits_global():
    """D5: empty project _unmanaged falls back to global (via union)."""
    project, registry = _reg(
        global_block={"_unmanaged": ["codex"]},
        project_block={},
    )
    eff = resolve_effective(project, registry)
    assert "codex" in eff._unmanaged


def test_affinity_nonoverlapping_global_rule_survives():
    """D6: global rule [codex] is not shadowed by project rule [claude-code]."""
    project, registry = _reg(
        global_block={
            "allow": [{"pattern": "Bash(npm:*)", "kind": "allow", "harnesses": ["codex"]}],
        },
        project_block={
            "allow": [{"pattern": "Bash(npm:*)", "kind": "allow", "harnesses": ["claude-code"]}],
        },
    )
    eff = resolve_effective(project, registry)
    # Both rules must survive: non-overlapping affinity means no shadow.
    patterns = [(r.origin, r.harnesses) for r in eff.allow]
    assert any(o == "global" and h == ["codex"] for o, h in patterns)
    assert any(o == "project" and h == ["claude-code"] for o, h in patterns)


def test_affinity_overlapping_global_rule_shadowed():
    """D6: global rule [codex] IS shadowed by a project rule with no affinity (all)."""
    project, registry = _reg(
        global_block={
            "allow": [{"pattern": "Bash(npm:*)", "kind": "allow", "harnesses": ["codex"]}],
        },
        project_block={
            "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}],  # all harnesses
        },
    )
    eff = resolve_effective(project, registry)
    assert len(eff.allow) == 1
    assert eff.allow[0].origin == "project"
    assert eff.allow[0].harnesses is None
