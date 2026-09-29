"""Tests for `risks.detect_companion_risks` — the `ships_with` doctor leg (W3
of the ships-with orchestration workspace, milestone 5, plan 1).

Registry-level, like `detect_hook_script_risks`/`detect_backup_risks`: every
test drives the detector with a plain registry dict (no SKILL.md, no tmp_path)
since `ships_with.orphans`/`ships_with.pending` (which the detector wraps) read
only `skills.<n>.ships_with` (the D1 mirror) and `projects.<n>.companions`
(the D4 ledger). The two reconcile-fed codes below (`COMPANION_REF_MISSING`,
`COMPANION_AGENT_DRIFT`) are reached through `ships_with_reconcile.classify`,
which `plan_reconcile`-derived tests in `tests/test_ships_with_reconcile.py`
already exercise end to end (real SKILL.md + real agent files); here the
detector's own translation of `classify()`'s shape into findings is what is
under test, so `classify` is monkeypatched rather than re-driving the whole
reconcile machinery through tmp files.
"""

from __future__ import annotations

from skill_hub.application.skills import ships_with_reconcile
from skill_hub.domain.diagnostics import risks


def test_orphaned_ledger_entry_surfaces_finding():
    """A ledger entry survives a `--keep-companions` disable (or a companion
    reached only via a bundle): the skill fell out of the project's active
    set, but its companions are still provisioned. COMPANION_ORPHANED, warning,
    and (per the doctor's own contract) never fails `hub sync` on its own."""
    registry = {
        "skills": {
            "orchestrate-advanced": {
                "ships_with": {
                    "agents": ["orch-implementer"],
                    "hooks": [{"name": "orch-scope-guard", "event": "PreToolUse"}],
                }
            },
        },
        "projects": {
            "notes-vault": {
                "path": "/tmp/notes-vault",
                "enabled": [],  # orchestrate-advanced is NOT active here
                "companions": {
                    "orchestrate-advanced": {
                        "hooks": ["orch-scope-guard"],
                        "agents": ["orch-implementer"],
                        "provisioned_at": "2026-09-05T00:00:00Z",
                    }
                },
            }
        },
    }

    findings = risks.detect_companion_risks(registry)

    assert [f.code for f in findings] == ["COMPANION_ORPHANED"]
    assert findings[0].severity == "warning"
    assert "notes-vault" in findings[0].detail
    assert "orchestrate-advanced" in findings[0].detail


def test_bundle_equipped_skill_surfaces_companions_pending():
    """A `ships_with` skill reached only through a bundle (W2 — bundles equip
    skill-only, no consent flow, no ledger entry) is active with nothing in
    the ledger. COMPANIONS_PENDING, info, basis is the resolved-skills set
    (bundle ∪ enabled), not `enabled` alone."""
    registry = {
        "skills": {
            "orchestrate-advanced": {
                "ships_with": {"agents": ["orch-implementer"]},
            },
        },
        "bundles": {
            "guild": {
                "scope": "project-specific",
                "skills": ["orchestrate-advanced"],
            }
        },
        "projects": {
            "notes-vault": {
                "path": "/tmp/notes-vault",
                "bundles": ["guild"],
                "enabled": [],
                # no `companions` key at all
            }
        },
    }

    findings = risks.detect_companion_risks(registry)

    assert [f.code for f in findings] == ["COMPANIONS_PENDING"]
    assert findings[0].severity == "info"
    assert "notes-vault" in findings[0].detail
    assert "orchestrate-advanced" in findings[0].detail


def test_upstream_dropped_block_surfaces_orphan_not_removal():
    """The skill is still active and its ledger entry is untouched — only its
    CURRENT `ships_with` declaration lost the hook (an upstream source sync
    or a hand-edit). The doctor surfaces this as an orphaned ledger ITEM; it
    must never auto-remove anything (read-only detector)."""
    registry = {
        "skills": {
            "orchestrate-advanced": {
                # a skill_dir is required by `plan_reconcile` (via
                # `skill_meta.skill_source`) whenever the skill is active AND
                # ledgered, even on this pending-agent-only path — a dummy
                # path is fine here since nothing under it is ever read.
                "source": "/tmp/ships-with-doctor-fixture/orchestrate-advanced",
                # `hooks` dropped upstream — only `agents` remains declared
                "ships_with": {"agents": ["orch-implementer"]},
            },
        },
        "projects": {
            "notes-vault": {
                "path": "/tmp/notes-vault",
                "enabled": ["orchestrate-advanced"],  # still active
                "companions": {
                    "orchestrate-advanced": {
                        "hooks": ["orch-scope-guard"],
                        "agents": ["orch-implementer"],
                        "provisioned_at": "2026-09-05T00:00:00Z",
                    }
                },
            }
        },
    }
    before = registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"][
        "hooks"
    ][:]

    findings = risks.detect_companion_risks(registry)

    assert [f.code for f in findings] == ["COMPANION_ORPHANED"]
    assert findings[0].severity == "warning"
    assert "orch-scope-guard" in findings[0].detail
    assert "hook" in findings[0].detail
    # Never a removal — the ledger is exactly as it was handed in.
    assert (
        registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"][
            "hooks"
        ]
        == before
    )


def test_emit_schema_includes_both_companion_codes():
    schema = risks.emit_schema()
    by_code = {entry["code"]: entry for entry in schema}

    assert by_code["COMPANION_ORPHANED"]["severity"] == "warning"
    assert by_code["COMPANIONS_PENDING"]["severity"] == "info"
    for code in ("COMPANION_ORPHANED", "COMPANIONS_PENDING"):
        assert by_code[code]["explanation"]


def test_ref_missing_and_agent_drift_findings_reach_emit_schema(monkeypatch):
    """A `{ref}` hook whose library entry vanished, and a companion agent
    hand-edited outside the skill, both reach the doctor through
    `ships_with_reconcile.classify` — and both are warnings, so `hub sync`
    (which fails only on `severity == "danger"`, per Sync Behavior #9) still
    exits 0 on their account alone."""

    def fake_classify(registry):
        assert registry == {}  # the detector passes its own argument through
        return {
            "missing_refs": [
                {
                    "scope": "notes-vault",
                    "skill": "orchestrate-advanced",
                    "name": "lib-hook",
                    "ref": "lib-hook",
                }
            ],
            "agent_drift": [
                {
                    "scope": "notes-vault",
                    "skill": "orchestrate-advanced",
                    "agent": "orch-implementer",
                    "harnesses": ["claude-code"],
                }
            ],
        }

    monkeypatch.setattr(ships_with_reconcile, "classify", fake_classify)

    findings = risks.detect_companion_risks({})

    assert sorted(f.code for f in findings) == [
        "COMPANION_AGENT_DRIFT",
        "COMPANION_REF_MISSING",
    ]
    by_code = {f.code: f for f in findings}
    assert by_code["COMPANION_REF_MISSING"].severity == "warning"
    assert by_code["COMPANION_AGENT_DRIFT"].severity == "warning"
    assert "lib-hook" in by_code["COMPANION_REF_MISSING"].detail
    assert "orch-implementer" in by_code["COMPANION_AGENT_DRIFT"].detail
    assert "claude-code" in by_code["COMPANION_AGENT_DRIFT"].detail

    schema = risks.emit_schema()
    by_schema_code = {entry["code"]: entry for entry in schema}
    for code in ("COMPANION_REF_MISSING", "COMPANION_AGENT_DRIFT"):
        assert by_schema_code[code]["severity"] == "warning"
        assert by_schema_code[code]["explanation"]


def test_classify_raising_is_guarded_never_raises_and_drops_only_its_findings(
    monkeypatch, capsys
):
    """R9: `detect_companion_risks` documents "never raises" — `classify` must
    actually be guarded, not merely unlucky not to fail in a few tries. A
    raising `classify` must not escape, must print one warning line, and must
    drop only the two `classify`-fed codes — the `COMPANION_ORPHANED` finding
    from `ships_with.orphans` (computed before the `classify` call) still
    comes back."""

    def raising_classify(registry):
        raise RuntimeError("boom: malformed ledger shape")

    monkeypatch.setattr(ships_with_reconcile, "classify", raising_classify)

    registry = {
        "skills": {
            "orchestrate-advanced": {
                "ships_with": {"agents": ["orch-implementer"]},
            },
        },
        "projects": {
            "notes-vault": {
                "path": "/tmp/notes-vault",
                "enabled": [],  # orchestrate-advanced is NOT active here
                "companions": {
                    "orchestrate-advanced": {
                        "hooks": [],
                        "agents": ["orch-implementer"],
                        "provisioned_at": "2026-09-05T00:00:00Z",
                    }
                },
            }
        },
    }

    findings = risks.detect_companion_risks(registry)  # must not raise

    assert [f.code for f in findings] == ["COMPANION_ORPHANED"]
    assert not any(
        f.code in ("COMPANION_REF_MISSING", "COMPANION_AGENT_DRIFT") for f in findings
    )
    out = capsys.readouterr().out
    assert "companion" in out.lower()
    assert "boom: malformed ledger shape" in out
