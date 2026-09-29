"""Public Usage inspection facade.

This module is the only read/write boundary used by the CLI and scanners.
"""
# ruff: noqa: E501
from __future__ import annotations

import datetime as _dt
from dataclasses import replace
from typing import Callable, Literal

from skill_hub import hub_core
from skill_hub.application.usage.usage_capture_enrichment import CaptureEnrichmentContext, enrich_capture_batch
from skill_hub.domain.usage.usage_inspection_capture import (
    CaptureBatch,
    CaptureSource,
    MergeResult,
    ReaderBinding,
    ReaderBindingPolicy,
    SourceCursor,
)
from skill_hub.infrastructure.usage.usage_inspection_store import (
    InspectionStore,
    InspectionStoreError,
    db_path,
    load_retention_config,
)


def _store() -> InspectionStore:
    return InspectionStore.open()


def backfill_needed(source: CaptureSource, capture_version: int) -> bool:
    try:
        with _store() as store:
            row = store.db.execute("SELECT 1 FROM sources WHERE source_id=?", (source.source_id,)).fetchone()
            return row is None or capture_version != 1
    except InspectionStoreError:
        return True


def source_policy_matches(store: InspectionStore, cursor: SourceCursor, policy: ReaderBindingPolicy) -> bool:
    """Match the policy of current capture progress, including a staged resume."""
    row = store.db.execute(
        "SELECT p.policy_json FROM source_versions v "
        "JOIN reader_policies p ON p.binding_digest=v.binding_digest "
        "LEFT JOIN source_heads h ON h.source_id=v.source_id AND h.publication_id=v.publication_id "
        "WHERE v.source_id=? AND v.generation_id=? "
        "AND (v.state='staged' OR h.publication_id IS NOT NULL) ORDER BY v.rowid DESC LIMIT 1",
        (cursor.source_id, cursor.generation_id),
    ).fetchone()
    return row is not None and str(row[0]) == policy.canonical_json()


def capture_scan_source(source: CaptureSource, build_batch: Callable[[SourceCursor], CaptureBatch], store: InspectionStore | None = None, reader_policy: ReaderBindingPolicy | None = None, enrichment: CaptureEnrichmentContext | None = None) -> MergeResult:
    """Build outside the data-home lock, then CAS-merge and retry stale reads."""
    active_store = store
    for _ in range(3):
        if active_store is None:
            with _store() as opened:
                cursor = opened.source_cursor(source.source_id)
                compatible = reader_policy is None or source_policy_matches(opened, cursor, reader_policy)
        else:
            cursor = active_store.source_cursor(source.source_id)
            compatible = reader_policy is None or source_policy_matches(active_store, cursor, reader_policy)
        if not compatible:
            # Keep the compare-and-swap revision, but discard old parser progress.
            cursor = replace(cursor, offset=0, resume_state="", resume_version=0)
        batch = build_batch(cursor)
        batch = enrich_capture_batch(batch, enrichment or CaptureEnrichmentContext.empty())
        if reader_policy is not None and batch.source.reader_source_evidence is not None:
            binding = ReaderBinding(reader_policy, batch.source.reader_source_evidence)
            batch = replace(batch, source=replace(batch.source, reader_binding=binding))
        with hub_core.data_home_lock():
            if active_store is None:
                with _store() as opened:
                    result = opened.merge_capture(batch)
            else:
                result = active_store.merge_capture(batch)
        if result.outcome != "retry_required":
            return result
    return result


def merge_capture(batch: CaptureBatch) -> MergeResult:
    with hub_core.data_home_lock():
        with _store() as store:
            return store.merge_capture(enrich_capture_batch(batch, CaptureEnrichmentContext.empty()))


def _rebuild_summary_projection(store: InspectionStore) -> int:
    from skill_hub.application.usage import usage_summary_export, usage_summary_projection

    revision = store.canonical_revision()
    imported = store.db.execute(
        "SELECT value FROM usage_summary_metadata WHERE key='legacy_import_complete'"
    ).fetchone()
    if imported is None:
        # Only the scan transaction can import and supersede historical rows.
        return revision
    rows = usage_summary_projection.effective_summaries(store.db)
    usage_summary_export.export_rows(
        store, rows, index=store.index_payload(), revision=revision
    )
    return revision


def rebuild_summary_projection(store: InspectionStore | None = None) -> int:
    """Rewrite the legacy JSONL summary from canonical sessions atomically."""
    if store is not None:
        with hub_core.data_home_lock():
            return _rebuild_summary_projection(store)
    with hub_core.data_home_lock():
        with _store() as opened:
            return _rebuild_summary_projection(opened)


def index_payload() -> dict:
    try:
        with _store() as store:
            return store.index_payload()
    except InspectionStoreError as exc:
        return {"ok": False, "reason": exc.reason}


def inspection_payload(harness: str, session_id: str, view: Literal["overview", "tools", "changes"], run_id: str | None = None, after: str | None = None, limit: int = 100) -> dict:
    try:
        with _store() as store:
            return store.inspection_payload(harness, session_id, view, run_id, after, limit)
    except InspectionStoreError as exc:
        return {"ok": False, "reason": exc.reason}


def read_body(body_id: str, after_chunk: int | None = None, limit_chunks: int = 32) -> dict:
    try:
        with _store() as store:
            return store.read_body(body_id, after_chunk, limit_chunks)
    except InspectionStoreError as exc:
        return {"ok": False, "reason": exc.reason}


def read_body_for_session(harness: str, session_id: str, body_id: str, after_chunk: int | None = None, limit_chunks: int = 32) -> dict:
    try:
        with _store() as store:
            access, pruned_at = store.body_access_for_session(harness, session_id, body_id)
            if access == "unavailable":
                return {"ok": False, "reason": "unavailable"}
            if access == "pruned":
                return {"ok": False, "reason": "pruned", "pruned_at": pruned_at}
            return store.read_body(body_id, after_chunk, limit_chunks)
    except InspectionStoreError as exc:
        return {"ok": False, "reason": exc.reason}


def mutate_pin(harness: str, session_id: str, run_id: str | None, action: Literal["add", "remove"]) -> dict:
    try:
        with hub_core.data_home_lock():
            with _store() as store:
                return store.mutate_pin(harness, session_id, run_id, action)
    except InspectionStoreError as exc:
        return {"ok": False, "reason": exc.reason}


def list_pins(after: str | None = None, limit: int = 50) -> dict:
    try:
        with _store() as store:
            return store.list_pins(after, limit)
    except InspectionStoreError as exc:
        return {"ok": False, "reason": exc.reason}


def prune_bodies(older_than: int | None = None, max_store_bytes: int | None = None, vacuum: bool = False, dry_run: bool = False, now: _dt.datetime | None = None) -> dict:
    settings = load_retention_config()
    days = settings["older_than_days"] if older_than is None else older_than
    cap = settings["max_store_bytes"] if max_store_bytes is None else max_store_bytes
    if dry_run and not db_path().exists():
        return {"ok": True, "dry_run": True, "older_than_days": days, "max_store_bytes": cap, "bodies_pruned": 0, "parts_pruned": 0, "bytes_freed": 0, "logical_bytes_freed": 0, "physical_bytes_before": 0, "physical_bytes_after": 0, "sessions_touched": 0, "pinned_exempt": 0, "unmet_target": False, "unmet_target_bytes": 0}
    try:
        if dry_run:
            with hub_core.data_home_lock():
                readonly = InspectionStore.open_readonly_for_prune()
                if readonly is None:
                    return {"ok": True, "dry_run": True, "older_than_days": days, "max_store_bytes": cap, "bodies_pruned": 0, "parts_pruned": 0, "bytes_freed": 0, "logical_bytes_freed": 0, "physical_bytes_before": 0, "physical_bytes_after": 0, "sessions_touched": 0, "pinned_exempt": 0, "unmet_target": False, "unmet_target_bytes": 0}
                try:
                    return readonly.prune_bodies(older_than_days=days, max_store_bytes=cap, vacuum=vacuum, dry_run=True, now=now)
                finally:
                    readonly.close()
        with hub_core.data_home_lock():
            with _store() as store:
                return store.prune_bodies(older_than_days=days, max_store_bytes=cap, vacuum=vacuum, dry_run=dry_run, now=now)
    except InspectionStoreError as exc:
        return {"ok": False, "reason": exc.reason}
