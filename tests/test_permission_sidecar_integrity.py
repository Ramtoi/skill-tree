"""Sidecar v2 (value-verified strips) + native conflict findings.

Regression suite for the 2026-09-01 permissions-divergence incident
(openspec change `permissions-divergence-fixes`): positional sidecar keys
went stale against an externally-edited native file, and hub had no eyes on
duplicate / ask-shadowed / blanket-shadowed rules it did not write.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from skill_hub.domain.diagnostics import risks
from skill_hub.domain.permissions.permissions import (
    NormalizedPermissions,
    ProjectScope,
    Rule,
    read_sidecar,
    write_sidecar,
)
from skill_hub.infrastructure.permissions import permission_adapters as pa

FIXTURE = Path(__file__).parent / "fixtures" / "permissions_incident_20260901.json"

HUB_8 = [
    "Bash(git:*)", "Bash(python3:*)", "Bash(python:*)", "Bash(pip:*)",
    "Bash(pytest:*)", "Bash(cargo:*)", "Bash(grep:*)", "Bash(find:*)",
]


@pytest.fixture(autouse=True)
def _reset_backup_state():
    pa._reset_backup_session_state_for_tests()
    yield
    pa._reset_backup_session_state_for_tests()


def _target(tmp_path: Path) -> Path:
    return tmp_path / ".claude/settings.json"


def _apply(tmp_path: Path, perms: NormalizedPermissions, name: str = "alpha"):
    adapter = pa.ClaudePermissionAdapter()
    scope = ProjectScope(name=name, path=str(tmp_path))
    result = adapter.translate(perms, scope, "claude-code")
    assert adapter.apply(scope, result.writes[0], "claude-code")
    return scope


def _perms(*patterns: str, kind: str = "allow") -> NormalizedPermissions:
    return NormalizedPermissions(allow=[Rule(pattern=p, kind=kind) for p in patterns])


# ── sidecar v2 shape ─────────────────────────────────────────────────────────


def test_apply_writes_v2_sidecar_with_values_and_block_hash(tmp_data_home, tmp_path):
    scope = _apply(tmp_path, _perms("Bash(git:*)", "Bash(npm:*)"))
    sc = read_sidecar("claude-code", scope)
    assert sc is not None
    assert sc.version == 2
    assert sc.managed_values == {
        "permissions.allow[0]": "Bash(git:*)",
        "permissions.allow[1]": "Bash(npm:*)",
    }
    assert sc.block_sha256 and len(sc.block_sha256) == 64
    assert sc.drift_events == []


def test_v1_sidecar_still_reads_and_strips_legacy(tmp_data_home, tmp_path):
    target = _target(tmp_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({
        "permissions": {"allow": ["Bash(old:*)", "UserAuthored(*)"]}
    }))
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    # Hand-written v1 sidecar: bare string keys, no values.
    write_sidecar("claude-code", scope, ["permissions.allow[0]"], target)
    assert read_sidecar("claude-code", scope).version == 1

    _apply(tmp_path, _perms("Bash(new:*)"))
    data = json.loads(target.read_text())
    # Legacy positional strip removed index 0 (hub's old rule); user rule intact.
    assert data["permissions"]["allow"] == ["UserAuthored(*)", "Bash(new:*)"]


# ── value-verified strips ────────────────────────────────────────────────────


def test_external_insert_before_hub_block_strips_only_hub_values(
    tmp_data_home, tmp_path, capsys
):
    scope = _apply(tmp_path, _perms("Bash(git:*)", "Bash(npm:*)"))
    target = _target(tmp_path)

    # External edit: two user rules inserted BEFORE hub's block → the sidecar's
    # recorded indices now point at user rules.
    data = json.loads(target.read_text())
    data["permissions"]["allow"] = ["User(one:*)", "User(two:*)"] + data["permissions"]["allow"]
    target.write_text(json.dumps(data))

    _apply(tmp_path, _perms("Bash(git:*)", "Bash(npm:*)"))
    data = json.loads(target.read_text())
    # User rules survive; hub's rules present exactly once, re-appended at end.
    assert data["permissions"]["allow"] == [
        "User(one:*)", "User(two:*)", "Bash(git:*)", "Bash(npm:*)",
    ]
    sc = read_sidecar("claude-code", scope)
    assert [ev["mode"] for ev in sc.drift_events] == ["fallback", "fallback"]
    assert "sidecar index drift" in capsys.readouterr().err


def test_pre_v2_behavior_would_have_deleted_user_rules(tmp_data_home, tmp_path):
    """The bug the guard exists for: a raw positional strip on a reordered file
    deletes whatever sits at the recorded indices."""
    data = {"permissions": {"allow": ["User(one:*)", "User(two:*)", "Bash(git:*)"]}}
    pa._strip_managed_from_json(data, ["permissions.allow[0]"])  # stale index
    assert "User(one:*)" not in data["permissions"]["allow"]  # user rule gone

    data = {"permissions": {"allow": ["User(one:*)", "User(two:*)", "Bash(git:*)"]}}
    drift = pa._strip_managed_verified(
        data,
        ["permissions.allow[0]"],
        {"permissions.allow[0]": "Bash(git:*)"},
    )
    assert data["permissions"]["allow"] == ["User(one:*)", "User(two:*)"]
    assert drift == [
        {"key": "permissions.allow[0]", "expected": "Bash(git:*)", "mode": "fallback"}
    ]


def test_vanished_value_removes_nothing(tmp_data_home, tmp_path):
    scope = _apply(tmp_path, _perms("Bash(git:*)"))
    target = _target(tmp_path)
    data = json.loads(target.read_text())
    data["permissions"]["allow"] = ["User(kept:*)"]  # user deleted hub's rule
    target.write_text(json.dumps(data))

    _apply(tmp_path, _perms("Bash(git:*)"))
    data = json.loads(target.read_text())
    assert data["permissions"]["allow"] == ["User(kept:*)", "Bash(git:*)"]
    sc = read_sidecar("claude-code", scope)
    assert [ev["mode"] for ev in sc.drift_events] == ["missing"]


def test_cleanup_verifies_values(tmp_data_home, tmp_path):
    scope = _apply(tmp_path, _perms("Bash(git:*)"))
    target = _target(tmp_path)
    data = json.loads(target.read_text())
    data["permissions"]["allow"] = ["User(new:*)"] + data["permissions"]["allow"]
    target.write_text(json.dumps(data))

    adapter = pa.ClaudePermissionAdapter()
    assert adapter.cleanup(scope, "claude-code")
    data = json.loads(target.read_text())
    assert data["permissions"]["allow"] == ["User(new:*)"]
    assert read_sidecar("claude-code", scope) is None


# ── the incident fixture ─────────────────────────────────────────────────────


def _seed_incident(tmp_path: Path) -> Path:
    target = _target(tmp_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fixture = json.loads(FIXTURE.read_text())
    fixture.pop("_comment", None)
    target.write_text(json.dumps(fixture, indent=2) + "\n")
    return target


def _incident_registry_perms() -> NormalizedPermissions:
    # The registry as it stood at the Aug 26 sync: 8 allow + 3 ask.
    return NormalizedPermissions(
        allow=[Rule(pattern=p, kind="allow") for p in HUB_8],
        ask=[Rule(pattern=p, kind="ask")
             for p in ("Bash(node:*)", "Bash(npx:*)", "Bash(npm:*)")],
    )


def test_incident_sync_strips_only_hub_values_and_is_idempotent(
    tmp_data_home, tmp_path
):
    target = _seed_incident(tmp_path)
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    # The incident's v1 sidecar: hub claims allow[40..47] + ask[0..2].
    write_sidecar(
        "claude-code",
        scope,
        [f"permissions.allow[{i}]" for i in range(40, 48)]
        + [f"permissions.ask[{i}]" for i in range(3)],
        target,
    )

    _apply(tmp_path, _incident_registry_perms())
    data = json.loads(target.read_text())
    allow = data["permissions"]["allow"]
    # User accumulation untouched: 14x npm + npx + node + 8 singles + 16x blanket.
    assert allow[:40] == json.loads(FIXTURE.read_text())["permissions"]["allow"][:40]
    # Hub's generation re-appended exactly once.
    assert allow[40:] == HUB_8
    assert data["permissions"]["ask"] == ["Bash(node:*)", "Bash(npx:*)", "Bash(npm:*)"]
    assert data["unrelated"] == {"kept": True}
    assert data["model"] == "claude-fable-5[1m]"

    # Second sync: byte-stable.
    first = target.read_bytes()
    pa._reset_backup_session_state_for_tests()
    _apply(tmp_path, _incident_registry_perms())
    assert target.read_bytes() == first


def test_incident_registry_flip_to_allow_clears_ask(tmp_data_home, tmp_path):
    """The user's actual fix: registry flips node/npx/npm ask→allow; the next
    sync must remove hub's ask entries and land the 11 allow rules."""
    target = _seed_incident(tmp_path)
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    write_sidecar(
        "claude-code",
        scope,
        [f"permissions.allow[{i}]" for i in range(40, 48)]
        + [f"permissions.ask[{i}]" for i in range(3)],
        target,
    )

    eleven = HUB_8 + ["Bash(node:*)", "Bash(npx:*)", "Bash(npm:*)"]
    _apply(tmp_path, _perms(*eleven))
    data = json.loads(target.read_text())
    assert data["permissions"]["allow"][40:] == eleven
    assert data["permissions"].get("ask", []) == []


# ── native conflict findings ─────────────────────────────────────────────────


def _discovered_from(target: Path) -> NormalizedPermissions:
    data = json.loads(target.read_text())
    block = data.get("permissions") or {}
    return NormalizedPermissions(
        allow=[Rule(pattern=p, kind="allow") for p in block.get("allow", [])],
        deny=[Rule(pattern=p, kind="deny") for p in block.get("deny", [])],
        ask=[Rule(pattern=p, kind="ask") for p in block.get("ask", [])],
    )


def test_native_conflicts_on_incident_fixture(tmp_data_home, tmp_path):
    target = _seed_incident(tmp_path)
    discovered = _discovered_from(target)
    registry = NormalizedPermissions(
        allow=[Rule(pattern=p, kind="allow") for p in HUB_8]
    )
    findings = risks.detect_native_conflicts(discovered, registry, str(target))
    by_code = {}
    for f in findings:
        by_code.setdefault(f.code, []).append(f)

    dup_details = {f.detail for f in by_code["DUPLICATE_NATIVE_RULES"]}
    assert any("Bash(npm:*) appears 14x in allow" in d for d in dup_details)
    assert any("Bash(*) appears 16x in allow" in d for d in dup_details)
    assert any("Bash(git:*) appears 2x in allow" in d for d in dup_details)

    ask_shadow = {f.detail for f in by_code["ASK_SHADOWS_ALLOW"]}
    assert len(ask_shadow) == 3  # node, npx, npm all prompt despite allow
    assert all(f.severity == "warning" for f in by_code["ASK_SHADOWS_ALLOW"])

    blanket = by_code["BLANKET_ALLOW_SHADOWS"]
    assert len(blanket) == 1
    assert blanket[0].severity == "info"
    assert "Bash(*)" in blanket[0].detail


def test_ask_shadow_suppressed_when_registry_declares_ask():
    discovered = NormalizedPermissions(
        allow=[Rule(pattern="Bash(npm:*)", kind="allow")],
        ask=[Rule(pattern="Bash(npm:*)", kind="ask")],
    )
    registry = NormalizedPermissions(
        ask=[Rule(pattern="Bash(npm:*)", kind="ask")],
    )
    findings = risks.detect_native_conflicts(discovered, registry)
    assert not [f for f in findings if f.code == "ASK_SHADOWS_ALLOW"]


def test_ask_shadow_fires_against_registry_allow_only():
    # Pattern allowed only in the registry, asked only in the native file.
    discovered = NormalizedPermissions(
        ask=[Rule(pattern="Bash(node:*)", kind="ask")],
    )
    registry = NormalizedPermissions(
        allow=[Rule(pattern="Bash(node:*)", kind="allow")],
    )
    findings = risks.detect_native_conflicts(discovered, registry)
    assert [f.code for f in findings] == ["ASK_SHADOWS_ALLOW"]


def test_clean_file_yields_no_findings():
    discovered = NormalizedPermissions(
        allow=[Rule(pattern="Bash(git:*)", kind="allow"),
               Rule(pattern="Bash(npm:*)", kind="allow")],
    )
    assert risks.detect_native_conflicts(discovered, discovered) == []


def test_sidecar_drift_finding_fallback_only():
    class _SC:
        file = "/x/settings.json"
        drift_events = [
            {"key": "permissions.allow[0]", "expected": "Bash(a:*)", "mode": "fallback"},
            {"key": "permissions.allow[1]", "expected": "Bash(b:*)", "mode": "missing"},
        ]

    findings = risks.detect_sidecar_drift(_SC())
    assert len(findings) == 1
    assert findings[0].code == "SIDECAR_INDEX_DRIFT"
    assert "1 rule(s) moved" in findings[0].detail

    _SC.drift_events = [
        {"key": "permissions.allow[1]", "expected": "Bash(b:*)", "mode": "missing"}
    ]
    assert risks.detect_sidecar_drift(_SC()) == []
    assert risks.detect_sidecar_drift(None) == []
