"""Reader policy and source-recognition evidence stay immutable across captures."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import nullcontext
from dataclasses import replace
from pathlib import Path

import pytest

from skill_hub.application.usage.usage_inspection_scan import capture_pass
from skill_hub.domain.usage.usage_inspection_capture import (
    MergeResult,
    ReaderBinding,
    ReaderBindingPolicy,
    ReaderBindingSourceEvidence,
)
from skill_hub.infrastructure.usage.usage_inspection_claude import (
    READER_REVISION,
    capture_claude_source,
    reader_source_evidence,
)
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, InspectionStoreError

SESSION = "aaaaaaaa-1111-4111-8111-111111111111"


def _policy() -> ReaderBindingPolicy:
    return ReaderBindingPolicy(1, 1, "usage_inspection_claude", READER_REVISION, 1, 1, 1)


def _record() -> str:
    return json.dumps(
        {
            "type": "assistant",
            "timestamp": "2026-09-16T12:00:00Z",
            "sessionId": SESSION,
            "message": {"id": "message-1", "role": "assistant", "content": []},
        }
    )


def _bound(batch):
    assert batch.source.reader_source_evidence is not None
    return replace(
        batch,
        source=replace(batch.source, reader_binding=ReaderBinding(_policy(), batch.source.reader_source_evidence)),
    )


def _use_direct_reader_path(monkeypatch):
    """Keep in-process test doubles local without requiring POSIX signals.

    Real signal timeouts and spawned worker isolation have separate tests.
    """
    from skill_hub.application.usage import usage_inspection_scan

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: True)
    monkeypatch.setattr(
        usage_inspection_scan, "_source_guard",
        lambda seconds: nullcontext(time.monotonic() + seconds),
    )


def test_binding_digest_is_canonical_and_binds_policy_and_evidence():
    policy = _policy()
    evidence = ReaderBindingSourceEvidence("claude-code", "claude-jsonl", "format:v1")
    first = ReaderBinding(policy, evidence)
    same = ReaderBinding(
        ReaderBindingPolicy(1, 1, "usage_inspection_claude", READER_REVISION, 1, 1, 1),
        ReaderBindingSourceEvidence("claude-code", "claude-jsonl", "format:v1"),
    )
    changed = ReaderBinding(policy, ReaderBindingSourceEvidence("claude-code", "claude-jsonl", "format:v2"))

    assert first.canonical_json() == same.canonical_json()
    assert first.digest() == same.digest()
    assert first.digest() != changed.digest()
    assert "/" not in first.canonical_json()


def test_adapter_evidence_is_allowlisted_and_unknown_legacy_is_explicit():
    known = reader_source_evidence([json.loads(_record())])
    legacy = reader_source_evidence([{}])

    assert (known.producer, known.native_format) == ("claude-code", "claude-jsonl")
    assert (legacy.producer, legacy.native_format) == ("unknown_legacy", "unknown_legacy")
    assert set(json.loads(known.canonical_json())) == {"format_fingerprint", "native_format", "producer"}


def test_append_reuses_the_same_immutable_binding(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    with InspectionStore.open() as store:
        first = _bound(capture_claude_source(path))
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
        path.write_text(_record() + "\n" + _record() + "\n")
        store.merge_capture(_bound(capture_claude_source(path, cursor)))

        digest = first.source.reader_binding.digest()  # type: ignore[union-attr]
        assert store.has_reader_binding(first.source.source_id, cursor.generation_id, digest)
        assert store.db.execute("SELECT COUNT(*) FROM reader_policies").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM reader_binding_observations").fetchone()[0] == 1


def test_resume_keeps_the_fixed_pass_policy(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    roots = {"claude-code": tmp_path}

    paused = capture_pass(roots, max_sources=0)
    with InspectionStore.open() as store:
        before = store.db.execute(
            "SELECT reader_policy_bindings FROM scan_passes WHERE scan_id=?", (paused["scan_id"],)
        ).fetchone()[0]
    resumed = capture_pass(roots, scan_id=paused["scan_id"])
    with InspectionStore.open() as store:
        after = store.db.execute(
            "SELECT reader_policy_bindings FROM scan_passes WHERE scan_id=?", (resumed["scan_id"],)
        ).fetchone()[0]

    assert resumed["state"] == "complete"
    assert before == after


def test_pass_catalog_is_persisted_before_source_resolution(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    paused = capture_pass({"claude-code": tmp_path}, max_sources=0)

    with InspectionStore.open() as store:
        row = store.db.execute(
            "SELECT reader_catalog_json,reader_catalog_digest FROM scan_passes WHERE scan_id=?",
            (paused["scan_id"],),
        ).fetchone()
        assert row is not None and row[0] and row[1].startswith("catalog:")
        assert store.db.execute(
            "SELECT name FROM sqlite_master WHERE name='scan_pass_reader_bindings'"
        ).fetchone() is not None


@pytest.mark.parametrize("portable", [False, True])
def test_resume_uses_pinned_catalog_when_default_catalog_changes(
    tmp_data_home, tmp_path: Path, monkeypatch, portable
):
    from skill_hub.application.usage import usage_inspection_scan

    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")

    expected = capture_claude_source(path)
    captured = []
    original_parse = usage_inspection_scan._portable_parse

    def observed_parse(*args, **kwargs):
        batch = original_parse(*args, **kwargs)
        captured.append((kwargs["reader_ref"], batch))
        return batch

    if portable:
        monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
        monkeypatch.setattr(usage_inspection_scan, "_portable_parse", observed_parse)

    original_catalog = usage_inspection_scan.capture_reader_catalog
    bundled = next(
        descriptor for descriptor in original_catalog().available_readers
        if descriptor.harness == "claude-code"
    )
    pinned_inactive = replace(bundled, active=False)
    monkeypatch.setattr(
        usage_inspection_scan,
        "capture_reader_catalog",
        lambda *args, **kwargs: original_catalog((pinned_inactive,)),
    )
    paused = capture_pass({"claude-code": tmp_path}, max_sources=0)

    def changed_default_catalog(*args, **kwargs):
        raise AssertionError("resume must use the persisted pass catalog")

    monkeypatch.setattr(usage_inspection_scan, "capture_reader_catalog", changed_default_catalog)
    resumed = capture_pass({"claude-code": tmp_path}, scan_id=paused["scan_id"])

    assert resumed["state"] == "complete"
    with InspectionStore.open() as store:
        binding = store.db.execute(
            "SELECT reader_ref_json,policy_json FROM scan_pass_reader_bindings WHERE scan_id=?",
            (paused["scan_id"],),
        ).fetchone()
        assert json.loads(binding["reader_ref_json"]) == {
            "reader_id": bundled.ref.reader_id,
            "revision": bundled.ref.revision,
            "contract_version": bundled.ref.contract_version,
        }
        assert binding["policy_json"] == bundled.policy.canonical_json()
        assert store.source_cursor(expected.source.source_id).offset == len(path.read_bytes())
    if portable:
        assert len(captured) == 1
        ref, batch = captured[0]
        assert ref == bundled.ref
        for field in ("runs", "token_samples", "tool_calls", "events", "relationships",
                      "changes", "prs", "messages", "event_seeds"):
            assert getattr(batch, field) == getattr(expected, field)


def test_new_source_on_resume_uses_pinned_catalog(tmp_data_home, tmp_path: Path, monkeypatch):
    from skill_hub.application.usage import usage_inspection_scan

    (tmp_path / f"{SESSION}.jsonl").write_text(_record() + "\n")
    paused = capture_pass({"claude-code": tmp_path}, max_sources=0)
    second = "bbbbbbbb-2222-4222-8222-222222222222"
    (tmp_path / f"{second}.jsonl").write_text(
        _record().replace(SESSION, second) + "\n"
    )

    monkeypatch.setattr(
        usage_inspection_scan,
        "capture_reader_catalog",
        lambda *args, **kwargs: pytest.fail("resume must restore the pinned catalog"),
    )
    resumed = capture_pass({"claude-code": tmp_path}, scan_id=paused["scan_id"])

    assert resumed["state"] == "complete"
    assert resumed["sources_done"] == 2
    with InspectionStore.open() as store:
        catalog_digest = store.db.execute(
            "SELECT reader_catalog_digest FROM scan_passes WHERE scan_id=?",
            (paused["scan_id"],),
        ).fetchone()[0]
        rows = store.db.execute(
            "SELECT reader_ref_json,catalog_digest FROM scan_pass_reader_bindings "
            "WHERE scan_id=?",
            (paused["scan_id"],),
        ).fetchall()
        assert len(rows) == 2
        assert {json.loads(row[0])["reader_id"] for row in rows} == {
            "usage_inspection_claude"
        }
        assert {row[1] for row in rows} == {catalog_digest}


def test_reader_replan_skips_summary_retention_and_publication(tmp_data_home, tmp_path: Path, monkeypatch):
    from skill_hub.application.usage import usage_inspection_scan

    _use_direct_reader_path(monkeypatch)

    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    prepared = []
    exported = []
    retained = []

    def fail_resolution(*args, **kwargs):
        from skill_hub.domain.usage.usage_reader_resolution import ReplanRequired

        raise ReplanRequired("reader_unavailable")

    monkeypatch.setattr(usage_inspection_scan, "resolve_source_reader", fail_resolution)
    monkeypatch.setattr(
        "skill_hub.application.usage.usage_summary_export.prepare_context", lambda *args, **kwargs: prepared.append(1)
    )
    monkeypatch.setattr(
        "skill_hub.application.usage.usage_summary_export.refresh_and_export",
        lambda *args, **kwargs: exported.append(1),
    )
    monkeypatch.setattr(InspectionStore, "mark_missing_sources", lambda *args, **kwargs: retained.append(1))

    result = capture_pass({"claude-code": tmp_path})

    assert result["state"] == "replan_required"
    assert result["partial"] is True
    assert result["errors"][0]["kind"] == "replan_required"
    assert not prepared and not exported and not retained


def test_saved_policy_mismatch_replans_before_summary_side_effects(tmp_data_home, tmp_path: Path, monkeypatch):
    from skill_hub.application.usage import usage_inspection_scan

    first = tmp_path / f"{SESSION}.jsonl"
    first.write_text(_record() + "\n")
    second = "bbbbbbbb-2222-4222-8222-222222222222"
    (tmp_path / f"{second}.jsonl").write_text(_record().replace(SESSION, second) + "\n")
    paused = capture_pass({"claude-code": tmp_path}, max_sources=1, order="path")
    db_path = tmp_data_home / "state/usage/inspection.sqlite3"
    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE scan_pass_reader_bindings SET policy_json=? WHERE scan_id=?",
            ('{"reader_id":"incompatible"}', paused["scan_id"]),
        )
        db.commit()

    prepared = []
    monkeypatch.setattr(
        "skill_hub.application.usage.usage_summary_export.prepare_context", lambda *args, **kwargs: prepared.append(1)
    )
    monkeypatch.setattr(usage_inspection_scan, "capture_reader_catalog", lambda: pytest.fail("catalog changed"))
    resumed = capture_pass({"claude-code": tmp_path}, scan_id=paused["scan_id"], order="path")

    assert resumed["state"] == "replan_required"
    assert resumed["errors"][0]["reason"] == "reader_binding_invalid"
    assert not prepared


def test_schema6_resume_rejects_stored_policy_mismatch(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    paused = capture_pass({"claude-code": tmp_path}, max_sources=0)
    db_path = tmp_data_home / "state/usage/inspection.sqlite3"
    with sqlite3.connect(db_path) as db:
        stored = json.loads(
            db.execute(
                "SELECT reader_policy_bindings FROM scan_passes WHERE scan_id=?",
                (paused["scan_id"],),
            ).fetchone()[0]
        )
        stored["claude-code"]["policy"]["parser_version"] = 999
        db.execute(
            "UPDATE scan_passes SET reader_catalog_json='',reader_catalog_digest='',"
            "reader_policy_bindings=? WHERE scan_id=?",
            (json.dumps(stored), paused["scan_id"]),
        )
        db.commit()

    resumed = capture_pass({"claude-code": tmp_path}, scan_id=paused["scan_id"])

    assert resumed["state"] == "replan_required"
    assert resumed["errors"][0]["reason"] == "reader_policy_incompatible"


def test_schema6_resume_rejects_missing_policy_with_mismatched_legacy_fields(
    tmp_data_home, tmp_path: Path
):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    paused = capture_pass({"claude-code": tmp_path}, max_sources=0)
    db_path = tmp_data_home / "state/usage/inspection.sqlite3"
    with sqlite3.connect(db_path) as db:
        bindings = json.loads(
            db.execute(
                "SELECT reader_bindings FROM scan_passes WHERE scan_id=?",
                (paused["scan_id"],),
            ).fetchone()[0]
        )
        bindings["claude-code"]["normalization"] = 999
        db.execute(
            "UPDATE scan_passes SET reader_catalog_json='',reader_catalog_digest='',"
            "reader_policy_bindings='{}',reader_bindings=? WHERE scan_id=?",
            (json.dumps(bindings), paused["scan_id"]),
        )
        db.commit()

    resumed = capture_pass({"claude-code": tmp_path}, scan_id=paused["scan_id"])

    assert resumed["state"] == "replan_required"
    assert resumed["errors"][0]["reason"] == "reader_policy_incompatible"


def test_disappeared_source_binding_is_validated_before_discovery(
    tmp_data_home, tmp_path: Path
):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    paused = capture_pass({"claude-code": tmp_path}, max_sources=0)
    db_path = tmp_data_home / "state/usage/inspection.sqlite3"
    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE scan_pass_reader_bindings SET reader_ref_json=? WHERE scan_id=?",
            ('{"contract_version":1,"reader_id":"gone","revision":1}', paused["scan_id"]),
        )
        db.commit()
    path.unlink()

    resumed = capture_pass({"claude-code": tmp_path}, scan_id=paused["scan_id"])

    assert resumed["state"] == "replan_required"
    assert resumed["errors"][0]["reason"] == "reader_binding_invalid"


def test_cas_retry_reprobes_replacement_and_pins_its_generation(
    tmp_data_home, tmp_path: Path, monkeypatch
):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    original_merge = InspectionStore.merge_capture
    attempts = 0

    def racing_merge(self, batch):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            replacement = _record().replace("message-1", "replacement-message")
            path.write_text(replacement + "\n")
            return MergeResult(
                "retry_required",
                self.canonical_revision(),
                batch.root.root_session_id,
                self.source_cursor(batch.source.source_id),
            )
        return original_merge(self, batch)

    monkeypatch.setattr(InspectionStore, "merge_capture", racing_merge)
    result = capture_pass({"claude-code": tmp_path})

    assert result["state"] == "complete"
    assert attempts == 2
    with InspectionStore.open() as store:
        bindings = store.db.execute(
            "SELECT generation_id,reader_ref_json,policy_json "
            "FROM scan_pass_reader_bindings WHERE scan_id=? ORDER BY generation_id",
            (result["scan_id"],),
        ).fetchall()
        assert len(bindings) == 2
        committed = store.db.execute("SELECT generation_id FROM sources").fetchone()[0]
        assert committed in {row[0] for row in bindings}
        assert {
            json.loads(row[1])["reader_id"] for row in bindings
        } == {"usage_inspection_claude"}
        assert len({row[2] for row in bindings}) == 1


def test_capture_batch_reader_mismatch_replans_before_publication(
    tmp_data_home, tmp_path: Path, monkeypatch
):
    from skill_hub.application.usage import usage_inspection_scan

    _use_direct_reader_path(monkeypatch)

    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    load_reader = usage_inspection_scan.load_usage_reader

    class WrongBatchReader:
        def __init__(self, delegate):
            self.delegate = delegate

        def __getattr__(self, name):
            return getattr(self.delegate, name)

        def capture(self, *args, **kwargs):
            batch = self.delegate.capture(*args, **kwargs)
            return replace(
                batch,
                source=replace(batch.source, reader_revision=batch.source.reader_revision + 1),
            )

    monkeypatch.setattr(
        usage_inspection_scan,
        "load_usage_reader",
        lambda ref: WrongBatchReader(load_reader(ref)),
    )
    result = capture_pass({"claude-code": tmp_path})

    assert result["state"] == "replan_required"
    assert result["errors"][0]["reason"] == "reader_batch_mismatch"
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0


def test_runtime_policy_drift_replans_before_summary_or_missing_source_updates(
    tmp_data_home, tmp_path: Path, monkeypatch
):
    from skill_hub.application.usage import usage_inspection_scan

    _use_direct_reader_path(monkeypatch)

    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    load_reader = usage_inspection_scan.load_usage_reader
    prepared = []
    missing = []

    class DriftedReader:
        NORMALIZATION_VERSION = 999

        def __init__(self, delegate):
            self.delegate = delegate

        def __getattr__(self, name):
            return getattr(self.delegate, name)

    monkeypatch.setattr(
        usage_inspection_scan,
        "load_usage_reader",
        lambda ref: DriftedReader(load_reader(ref)),
    )
    monkeypatch.setattr(
        "skill_hub.application.usage.usage_summary_export.prepare_context", lambda *args, **kwargs: prepared.append(1)
    )
    monkeypatch.setattr(
        InspectionStore,
        "mark_missing_sources",
        lambda *args, **kwargs: missing.append(1),
    )

    result = capture_pass({"claude-code": tmp_path})

    assert result["state"] == "replan_required"
    assert result["errors"][0]["reason"] == "reader_policy_incompatible"
    assert not prepared and not missing


def test_binding_conflict_rolls_back_the_capture_atomically(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    batch = _bound(capture_claude_source(path))
    binding = batch.source.reader_binding
    assert binding is not None
    with InspectionStore.open() as store:
        store.db.execute(
            "INSERT INTO reader_policies(binding_digest,policy_json) VALUES (?,?)",
            (binding.digest(), binding.policy.canonical_json()),
        )
        store.db.execute(
            "INSERT INTO reader_binding_observations"
            "(source_id,generation_id,binding_digest,source_evidence_json) VALUES (?,?,?,?)",
            (
                batch.source.source_id,
                batch.source.generation_id,
                binding.digest(),
                '{"format_fingerprint":"other","native_format":"claude-jsonl","producer":"claude-code"}',
            ),
        )
        with pytest.raises(InspectionStoreError, match="reader_binding_conflict"):
            store.merge_capture(batch)
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0


def test_legacy_direct_capture_keeps_missing_binding_evidence(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    with InspectionStore.open() as store:
        batch = capture_claude_source(path)
        store.merge_capture(batch)
        assert store.db.execute("SELECT COUNT(*) FROM reader_binding_observations").fetchone()[0] == 0


@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_header_recognition_survives_unrecognized_append(tmp_data_home, tmp_path, harness):
    from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source

    parser = capture_claude_source if harness == "claude-code" else capture_codex_source
    header = (
        json.loads(_record())
        if harness == "claude-code"
        else {
            "type": "session_meta",
            "payload": {"id": SESSION},
        }
    )
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(json.dumps(header) + "\n")
    with InspectionStore.open() as store:
        first = parser(path)
        store.merge_capture(first)
        with path.open("a") as stream:
            stream.write(json.dumps({"type": "diagnostic", "timestamp": "2026-09-16T12:01:00Z"}) + "\n")
        appended = parser(path, store.source_cursor(first.source.source_id))
        assert appended.source.offset_start > 0
        assert appended.source.reader_source_evidence == first.source.reader_source_evidence


def test_policy_must_describe_the_captured_reader(tmp_data_home, tmp_path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    batch = _bound(capture_claude_source(path))
    binding = batch.source.reader_binding
    assert binding is not None
    wrong = replace(binding, policy=replace(binding.policy, reader_revision=999))
    with InspectionStore.open() as store:
        with pytest.raises(InspectionStoreError, match="reader_binding_mismatch"):
            store.merge_capture(replace(batch, source=replace(batch.source, reader_binding=wrong)))
        assert store.canonical_revision() == 0


def test_recognition_rejects_path_shaped_provenance(tmp_data_home, tmp_path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(_record() + "\n")
    batch = _bound(capture_claude_source(path))
    binding = batch.source.reader_binding
    assert binding is not None
    evidence = replace(binding.source_evidence, format_fingerprint="/private/transcripts/session.jsonl")
    source = replace(
        batch.source, reader_binding=replace(binding, source_evidence=evidence), reader_source_evidence=evidence
    )
    with InspectionStore.open() as store:
        with pytest.raises(InspectionStoreError, match="invalid_reader_binding"):
            store.merge_capture(replace(batch, source=source))
        assert store.canonical_revision() == 0
