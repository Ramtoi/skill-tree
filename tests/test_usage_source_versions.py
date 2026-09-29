"""SQLite contracts for immutable, source-owned Usage publications."""

from __future__ import annotations

import sqlite3

import pytest

from skill_hub.infrastructure.usage import usage_source_versions as versions

DIGEST = "binding:" + "a" * 64
OTHER_DIGEST = "binding:" + "b" * 64


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    versions.install_schema(db)
    db.execute("BEGIN")
    return db


def _fact(physical_id: str, ordinal: int, **metadata: object) -> versions.VersionFact:
    return versions.VersionFact("message", physical_id, ordinal, metadata)


def test_schema_does_not_commit_a_caller_transaction() -> None:
    db = sqlite3.connect(":memory:")
    db.execute("BEGIN")
    versions.install_schema(db)
    assert db.in_transaction is True
    db.rollback()
    assert db.execute("SELECT name FROM sqlite_master WHERE name = 'source_versions'").fetchone() is None


def test_mutations_require_a_caller_owned_transaction() -> None:
    db = sqlite3.connect(":memory:")
    versions.install_schema(db)
    with pytest.raises(ValueError, match="caller-owned transaction"):
        versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)


def test_replacement_hides_old_facts_but_historical_version_stays_resolvable() -> None:
    db = _db()
    first = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    versions.append_facts(db, first, [_fact("record-1", 4, role="user", text_len=7)])
    assert versions.complete_publication(db, first) is True
    second = versions.begin_replacement(db, "claude:source", "cursor-2", DIGEST, first)
    assert versions.complete_publication(db, second) is True
    assert versions.resolve_facts(db, "claude:source") == []
    historical = versions.resolve_facts(db, "claude:source", publication_id=first)
    assert [(fact.physical_id, fact.source_ordinal) for fact in historical] == [("record-1", 4)]


def test_append_inherits_parent_and_requires_its_generation_and_binding() -> None:
    db = _db()
    first = versions.begin_replacement(db, "codex:source", "cursor-1", DIGEST, None)
    versions.append_facts(db, first, [_fact("record-1", 1, role="user")])
    assert versions.complete_publication(db, first) is True
    with pytest.raises(ValueError, match="generation"):
        versions.begin_append(db, "codex:source", "cursor-2", DIGEST, first)
    with pytest.raises(ValueError, match="binding"):
        versions.begin_append(db, "codex:source", "cursor-1", OTHER_DIGEST, first)
    appended = versions.begin_append(db, "codex:source", "cursor-1", DIGEST, first)
    versions.append_facts(db, appended, [_fact("record-2", 2, role="assistant")])
    assert versions.complete_publication(db, appended) is True
    assert [(fact.physical_id, fact.source_ordinal) for fact in versions.resolve_facts(db, "codex:source")] == [
        ("record-1", 1),
        ("record-2", 2),
    ]


def test_staged_chunk_refinement_is_monotonic_and_replay_is_idempotent() -> None:
    db = _db()
    staged = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    original = _fact("record-1", 1, model="unknown")
    refined = _fact("record-1", 2, model="opus", end_time="2026-09-17T12:00:00Z")
    versions.append_facts(db, staged, [original])
    versions.append_facts(db, staged, [original])
    versions.append_facts(db, staged, [refined])
    with pytest.raises(ValueError, match="advance"):
        versions.append_facts(db, staged, [_fact("record-1", 1, model="conflict")])
    rows = db.execute(
        "SELECT source_ordinal, metadata_json FROM version_facts WHERE publication_id = ?", (staged,)
    ).fetchall()
    assert [(row["source_ordinal"], row["metadata_json"]) for row in rows] == [
        (2, '{"end_time":"2026-09-17T12:00:00Z","model":"opus"}')
    ]


def test_invalid_chunk_is_all_or_nothing() -> None:
    db = _db()
    staged = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    versions.append_facts(db, staged, [_fact("record-1", 2, model="opus")])
    with pytest.raises(ValueError, match="advance"):
        versions.append_facts(
            db,
            staged,
            [_fact("record-2", 3, role="user"), _fact("record-1", 1, model="old")],
        )
    assert [row["physical_id"] for row in db.execute(
        "SELECT physical_id FROM version_facts WHERE publication_id = ?", (staged,)
    )] == ["record-1"]


def test_stale_or_failed_stage_never_replaces_the_published_head() -> None:
    db = _db()
    first = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    versions.append_facts(db, first, [_fact("record-1", 1)])
    assert versions.complete_publication(db, first) is True
    winner = versions.begin_replacement(db, "claude:source", "cursor-2", DIGEST, first)
    versions.append_facts(db, winner, [_fact("record-2", 2)])
    stale = versions.begin_replacement(db, "claude:source", "cursor-3", DIGEST, first)
    assert versions.complete_publication(db, winner) is True
    assert versions.complete_publication(db, stale) is False
    assert versions.fail_publication(db, stale, "decoder_error") is True
    assert [fact.physical_id for fact in versions.resolve_facts(db, "claude:source")] == ["record-2"]


def test_complete_is_atomic_inside_the_caller_transaction() -> None:
    db = _db()
    staged = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    assert versions.complete_publication(db, staged) is True
    assert db.in_transaction is True
    db.rollback()
    assert db.execute("SELECT * FROM source_heads").fetchall() == []


def test_rejects_cross_source_parent_and_unsafe_fact_metadata() -> None:
    db = _db()
    first = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    assert versions.complete_publication(db, first) is True
    with pytest.raises(ValueError, match="another source"):
        versions.begin_append(db, "codex:source", "cursor-1", DIGEST, first)
    staged = versions.begin_replacement(db, "codex:source", "cursor-1", DIGEST, None)
    with pytest.raises(ValueError, match="body"):
        versions.append_facts(db, staged, [_fact("record-1", 1, body="raw bytes")])
    with pytest.raises(ValueError, match="kind"):
        versions.append_facts(db, staged, [versions.VersionFact("unknown", "record-1", 1, {})])


def test_checkpoint_preserves_original_proof_without_growing_lineage() -> None:
    db = _db()
    first = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    versions.append_facts(db, first, [_fact("record-1", 7, role="user", mirror_part_key="p1")])
    assert versions.complete_publication(db, first) is True
    second = versions.begin_append(db, "claude:source", "cursor-1", DIGEST, first)
    versions.append_facts(db, second, [_fact("record-2", 9, role="assistant")])
    assert versions.complete_publication(db, second) is True
    checkpoint = versions.checkpoint_ancestry(db, "claude:source", threshold=1)
    assert checkpoint is not None
    suffix = versions.begin_append(db, "claude:source", "cursor-1", DIGEST, checkpoint)
    versions.append_facts(db, suffix, [_fact("record-3", 10, role="tool")])
    assert versions.complete_publication(db, suffix) is True
    second_checkpoint = versions.checkpoint_ancestry(db, "claude:source", threshold=1)
    assert second_checkpoint is not None
    facts = versions.resolve_facts(db, "claude:source")
    assert [(fact.physical_id, fact.source_ordinal, fact.metadata) for fact in facts] == [
        ("record-1", 7, {"mirror_part_key": "p1", "role": "user"}),
        ("record-2", 9, {"role": "assistant"}),
        ("record-3", 10, {"role": "tool"}),
    ]
    assert facts[0].origin_version_id == first
    assert facts[0].lineage == (first, second_checkpoint)
    assert all(len(fact.lineage) <= 2 for fact in facts)


def test_metadata_has_bounded_depth_and_canonical_json_encoding() -> None:
    db = _db()
    staged = versions.begin_replacement(db, "claude:source", "cursor-1", DIGEST, None)
    too_large = {"proof": "x" * (versions.METADATA_LIMIT + 1)}
    with pytest.raises(ValueError, match="metadata"):
        versions.append_facts(db, staged, [_fact("record-1", 1, **too_large)])
    nested: object = "leaf"
    for _ in range(versions.MAX_METADATA_DEPTH + 1):
        nested = {"next": nested}
    with pytest.raises(ValueError, match="depth"):
        versions.append_facts(db, staged, [_fact("record-2", 2, proof=nested)])


def test_sql_current_facts_separate_sources_and_hide_unpublished_replacements():
    db = _db()
    heads = {}
    for source in ("source:a", "source:b"):
        version = versions.begin_replacement(db, source, "same-epoch", DIGEST, None)
        versions.append_facts(db, version, [_fact("same-id", 0, owner=source)])
        assert versions.complete_publication(db, version)
        heads[source] = version
    pending = versions.begin_replacement(db, "source:a", "replacement", OTHER_DIGEST, heads["source:a"])
    versions.append_facts(db, pending, [_fact("new-id", 1, owner="new")])
    rows = db.execute("SELECT source_id,physical_id FROM current_source_facts ORDER BY source_id").fetchall()
    assert [tuple(row) for row in rows] == [("source:a", "same-id"), ("source:b", "same-id")]
    assert versions.complete_publication(db, pending)
    rows = db.execute("SELECT source_id,physical_id FROM current_source_facts ORDER BY source_id").fetchall()
    assert [tuple(row) for row in rows] == [("source:a", "new-id"), ("source:b", "same-id")]
    appended = versions.begin_append(db, "source:a", "replacement", OTHER_DIGEST, pending)
    versions.append_facts(db, appended, [_fact("new-id", 2, owner="refined")])
    assert versions.complete_publication(db, appended)
    actual = db.execute(
        "SELECT physical_id,source_ordinal,metadata_json FROM current_source_facts WHERE source_id='source:a'"
    ).fetchall()
    assert [(row[0], row[1]) for row in actual] == [("new-id", 2)]
    assert '"owner":"refined"' in actual[0][2]
    checkpoint = versions.checkpoint_ancestry(db, "source:a", threshold=1)
    assert checkpoint is not None
    after = db.execute(
        "SELECT physical_id,source_ordinal,metadata_json FROM current_source_facts WHERE source_id='source:a'"
    ).fetchall()
    assert [tuple(row) for row in after] == [tuple(row) for row in actual]


@pytest.mark.parametrize("physical_id", ["existing", "new"])
def test_append_rejects_records_before_inherited_suffix_boundary(physical_id):
    db = _db()
    first = versions.begin_replacement(db, "source", "epoch", DIGEST, None)
    versions.append_facts(db, first, [_fact("existing", 100, role="user")])
    assert versions.complete_publication(db, first)
    appended = versions.begin_append(db, "source", "epoch", DIGEST, first)
    with pytest.raises(ValueError, match="suffix boundary"):
        versions.append_facts(db, appended, [_fact(physical_id, 0, role="assistant")])
    assert db.execute("SELECT COUNT(*) FROM version_facts WHERE publication_id=?", (appended,)).fetchone()[0] == 0
    assert versions.resolve_facts(db, "source")[0].source_ordinal == 100
