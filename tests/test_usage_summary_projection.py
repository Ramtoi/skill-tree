"""Transactional canonical Usage summary projection contracts."""

from __future__ import annotations

import sqlite3

import pytest

from skill_hub.application.usage import usage_summary_projection as projection

ROOT = "root"
CLOCK = "2026-09-17T12:00:00Z"


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("BEGIN")
    projection.install_schema(db)
    db.commit()
    return db


def _context() -> dict:
    return {
        "registry": {"skills": {}},
        "loadout_rows": [],
        "tracked_files": {"alpha": 4},
        "now": CLOCK,
    }


def _facts(*, child_input: int = 700, harness: str = "claude-code", session_id: str = ROOT) -> dict:
    return {
        "coverage": [{"source_id": ROOT, "status": "complete"}],
        "structural": [
            {
                "record_type": "source_scope",
                "harness": harness,
                "source_session_id": session_id,
                "root_session_id": session_id,
                "project_key": "alpha",
                "_published": True,
            }
        ],
        "run": [
            {
                "run_id": session_id,
                "harness": harness,
                "root_session_id": session_id,
                "source_session_id": session_id,
                "models": ["claude"],
                "started_at": "2026-09-17T08:00:00Z",
            },
            {
                "run_id": "child",
                "harness": harness,
                "root_session_id": session_id,
                "source_session_id": "child",
                "parent_run_id": session_id,
                "role": "review",
                "models": ["claude"],
            },
        ],
        "token": [
            {
                "run_id": session_id,
                "origin": "native",
                "at": "2026-09-17T08:00:00Z",
                "input": 100,
                "output": 10,
                "cache_creation": 0,
                "cache_read": 0,
                "cumulative": False,
            },
            {
                "run_id": "child",
                "origin": "native",
                "at": "2026-09-17T08:01:00Z",
                "input": child_input,
                "output": 10,
                "cache_creation": 0,
                "cache_read": 0,
                "cumulative": False,
            },
        ],
        "message": [],
        "call": [],
    }


def _refresh(
    db: sqlite3.Connection,
    sessions: dict[tuple[str, str], dict],
    *,
    legacy_rows: list[dict] | None = None,
    revision: int = 1,
) -> list[dict]:
    db.execute("BEGIN")
    try:
        rows = projection.refresh_summaries(
            db,
            context=_context(),
            sessions=sessions,
            revision=revision,
            legacy_rows=legacy_rows or [],
        )
    except Exception:
        db.rollback()
        raise
    db.commit()
    return rows


def test_context_is_immutable_across_resume_and_requires_a_transaction() -> None:
    db = _db()
    with pytest.raises(ValueError, match="transaction"):
        projection.save_context(db, "scan", _context())

    db.execute("BEGIN")
    assert projection.save_context(db, "scan", _context()) == _context()
    assert projection.load_context(db, "scan") == _context()
    with pytest.raises(ValueError, match="changed"):
        projection.save_context(db, "scan", {**_context(), "now": "2026-09-18T12:00:00Z"})
    db.rollback()


def test_canonical_projection_supersedes_legacy_and_is_idempotent() -> None:
    db = _db()
    legacy = {"harness": "claude-code", "session_id": ROOT, "project": "alpha"}

    first = _refresh(db, {("claude-code", ROOT): _facts()}, legacy_rows=[legacy])
    second = _refresh(db, {("claude-code", ROOT): _facts()}, legacy_rows=[legacy], revision=2)

    assert first == second == projection.effective_summaries(db)
    assert len(first) == 1
    assert first[0]["summary_provenance"] == "canonical"
    assert db.execute("SELECT superseded_at FROM legacy_session_summaries").fetchone()[0] == CLOCK
    assert db.execute("SELECT COUNT(*) FROM canonical_session_summaries").fetchone()[0] == 1


def test_no_head_keeps_legacy_and_never_invents_canonical_capture() -> None:
    db = _db()
    legacy = {"harness": "claude-code", "session_id": "missing", "project": "alpha"}

    rows = _refresh(
        db,
        {("claude-code", "missing"): {"coverage": [{"source_id": "missing", "status": "unavailable"}]}},
        legacy_rows=[legacy],
    )

    assert rows == [{**legacy, "summary_provenance": "legacy_import", "capture_coverage": "unavailable"}]
    assert db.execute("SELECT COUNT(*) FROM canonical_session_summaries").fetchone()[0] == 0


def test_partial_child_coverage_keeps_the_legacy_summary_available() -> None:
    db = _db()
    legacy = {"harness": "claude-code", "session_id": ROOT, "project": "alpha"}
    facts = _facts()
    facts["coverage"].append({"source_id": "child", "status": "partial"})

    rows = _refresh(db, {("claude-code", ROOT): facts}, legacy_rows=[legacy])

    assert rows == [{**legacy, "summary_provenance": "legacy_import", "capture_coverage": "unavailable"}]
    assert db.execute("SELECT COUNT(*) FROM canonical_session_summaries").fetchone()[0] == 0


def test_failed_reduction_rolls_back_and_retains_prior_canonical_projection() -> None:
    db = _db()
    before = _refresh(db, {("claude-code", ROOT): _facts()})

    db.execute("BEGIN")
    with pytest.raises(AttributeError):
        projection.refresh_summaries(
            db,
            context=_context(),
            sessions={
                ("claude-code", ROOT): _facts(child_input=900),
                ("claude-code", "broken"): {**_facts(session_id="broken"), "message": [None]},
            },
            revision=2,
            legacy_rows=[],
        )
    assert projection.effective_summaries(db) == before
    db.rollback()

    assert projection.effective_summaries(db) == before


def test_child_fact_refresh_updates_the_parent_own_and_child_totals() -> None:
    db = _db()
    first = _refresh(db, {("claude-code", ROOT): _facts()})[0]
    second = _refresh(db, {("claude-code", ROOT): _facts(child_input=900)}, revision=2)[0]

    assert first["tokens"]["total"] == second["tokens"]["total"] == 110
    assert first["tokens"]["subagent_total"] == 710
    assert second["tokens"]["subagent_total"] == 910


def test_context_rejects_paths_and_naive_clock_while_snapshotting_only_skill_keys() -> None:
    db = _db()
    cases = [
        {**_context(), "now": "2026-09-17T12:00:00"},
        {**_context(), "registry": {"skills": {}, "projects": {"alpha": {"path": "/private/raw"}}}},
        {**_context(), "loadout_rows": [{"path": "/private/raw"}]},
    ]

    for context in cases:
        db.execute("BEGIN")
        with pytest.raises(ValueError):
            projection.save_context(db, "scan", context)
        db.rollback()

    db.execute("BEGIN")
    stored = projection.save_context(
        db,
        "safe",
        {**_context(), "registry": {"skills": {"safe": {"path": "/private/raw"}}}},
    )
    db.commit()
    assert stored["registry"] == {"skills": {"safe": {}}}


def test_staged_scope_and_tokens_without_a_root_head_do_not_create_a_canonical_row() -> None:
    db = _db()
    facts = _facts()
    facts["run"] = []

    assert _refresh(db, {("claude-code", ROOT): facts}) == []
    assert db.execute("SELECT COUNT(*) FROM canonical_session_summaries").fetchone()[0] == 0


def test_partial_reparse_retains_values_and_surfaces_partial_coverage() -> None:
    db = _db()
    before = _refresh(db, {("claude-code", ROOT): _facts()})
    partial = _facts(child_input=900)
    partial["coverage"].append({"source_id": "child", "status": "partial"})

    rows = _refresh(db, {("claude-code", ROOT): partial}, revision=2)

    assert rows[0]["tokens"] == before[0]["tokens"]
    assert rows[0]["capture_coverage"] == "partial"
    assert rows[0]["summary_provenance"] == "canonical"


def test_no_head_reparse_marks_an_existing_canonical_row_unavailable() -> None:
    db = _db()
    before = _refresh(db, {("claude-code", ROOT): _facts()})[0]
    missing = _facts()
    missing["run"] = []
    missing["coverage"] = [{"source_id": ROOT, "status": "unavailable"}]

    rows = _refresh(db, {("claude-code", ROOT): missing}, revision=2)

    assert rows[0]["tokens"] == before["tokens"]
    assert rows[0]["capture_coverage"] == "unavailable"


def test_codex_never_receives_a_tracked_file_count() -> None:
    db = _db()
    facts = _facts(harness="codex")

    rows = _refresh(db, {("codex", ROOT): facts})

    assert rows[0]["tracked_files"] is None


def test_invalid_legacy_rows_are_counted_without_counting_canonical_export_skips() -> None:
    db = _db()
    canonical_export = {
        "harness": "claude-code",
        "session_id": "canonical-export",
        "summary_provenance": "canonical",
    }

    _refresh(
        db,
        {},
        legacy_rows=[{"harness": "claude-code"}, canonical_export, {"harness": "claude-code", "session_id": "ok"}],
    )

    metadata = dict(db.execute("SELECT key,value FROM usage_summary_metadata").fetchall())
    assert metadata["last_import_rejected"] == "1"
    assert metadata["last_imported"] == "1"


def test_context_rejects_a_path_as_tracked_project_key() -> None:
    db = _db()
    context = _context()
    context["tracked_files"] = {"/private/raw-project": 1}
    db.execute("BEGIN")
    with pytest.raises(ValueError, match="tracked files"):
        projection.save_context(db, "path-key", context)
    db.rollback()
