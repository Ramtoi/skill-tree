"""Translate normalized capture records into immutable source publications."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

import skill_hub.application.usage.usage_publication_reads as reads
import skill_hub.infrastructure.usage.usage_source_versions as versions
from skill_hub.domain.usage.usage_inspection_capture import CaptureBatch, body_identity, operation_hash
from skill_hub.infrastructure.usage.usage_capture_summary import operation_summary


@dataclass(frozen=True)
class PublicationResult:
    publication_id: str | None
    published: bool


def stage_capture(
    db: sqlite3.Connection,
    batch: CaptureBatch,
    facts: list[versions.VersionFact],
) -> PublicationResult:
    """Stage one normalized capture and publish only its complete head.

    Unbound captures deliberately stay in the legacy compatibility path.  A
    caller supplies stored physical IDs in ``facts`` after its own collision
    and identity mapping has completed.
    """
    binding = batch.source.reader_binding
    if binding is None:
        return PublicationResult(None, False)
    source = batch.source
    digest = binding.digest()
    existing = db.execute(
        """
        SELECT publication_id FROM source_versions
        WHERE source_id=? AND generation_id=? AND binding_digest=? AND state='staged'
        ORDER BY rowid DESC LIMIT 1
        """,
        (source.source_id, source.generation_id, digest),
    ).fetchone()
    if existing is not None:
        publication_id = str(existing[0])
    else:
        head = db.execute(
            "SELECT publication_id FROM source_heads WHERE source_id=?", (source.source_id,)
        ).fetchone()
        parent = None
        if head is not None:
            parent = db.execute(
                "SELECT generation_id,binding_digest,last_source_ordinal "
                "FROM source_versions WHERE publication_id=?",
                (head[0],),
            ).fetchone()
        if (
            head is not None
            and parent is not None
            and source.offset_start > 0
            and str(parent["generation_id"]) == source.generation_id
            and str(parent["binding_digest"]) == digest
        ):
            boundary = int(parent["last_source_ordinal"])
            inherited = {
                (fact.kind, fact.physical_id): fact
                for fact in versions.resolve_facts(db, source.source_id, publication_id=str(head[0]))
            }
            facts = [
                fact for fact in facts
                if not (
                    fact.source_ordinal <= boundary
                    and (previous := inherited.get((fact.kind, fact.physical_id))) is not None
                    and fact.metadata == previous.metadata
                )
            ]
            if not facts:
                return PublicationResult(str(head[0]), True)
            publication_id = versions.begin_append(
                db, source.source_id, source.generation_id, digest, str(head[0])
            )
        else:
            publication_id = versions.begin_replacement(
                db,
                source.source_id,
                source.generation_id,
                digest,
                str(head[0]) if head is not None else None,
            )
    versions.append_facts(db, publication_id, facts)
    reads.index_publication(db, publication_id)
    if source.status != "active":
        return PublicationResult(publication_id, False)
    published = versions.complete_publication(db, publication_id)
    if published:
        checkpoint = versions.checkpoint_ancestry(db, source.source_id)
        if checkpoint is not None:
            reads.index_publication(db, checkpoint)
    return PublicationResult(publication_id, published)


def capture_facts(
    batch: CaptureBatch, *, call_ids: dict[str, str], part_refs: dict[str, dict[str, Any]] | None = None,
    run_members: dict[str, dict[str, Any]] | None = None
) -> list[versions.VersionFact]:
    """Return body-free facts keyed by the store's finalized physical IDs."""
    facts: list[versions.VersionFact] = []
    part_refs = part_refs or {}
    run_members = run_members or {}
    event_ordinals = {event.event_id: event.source_ordinal for event in batch.events}
    event_times = {event.event_id: event.at for event in batch.events}
    call_times = {tool.call_id: tool.at for tool in batch.tool_calls}
    result_ordinals = {
        event.correlation_id: event.source_ordinal
        for event in batch.events
        if event.kind == "tool_result" and event.correlation_id is not None
    }
    call_ordinals = {
        call_ids[tool.call_id]: result_ordinals.get(tool.native_call_id, tool.source_ordinal)
        for tool in batch.tool_calls
    }
    resume_ordinal = _resume_record_ordinal(batch.source.resume_state)
    latest = max(
        *event_ordinals.values(), *call_ordinals.values(),
        *(sample.source_ordinal for sample in batch.token_samples),
        *(message.source_ordinal for message in batch.messages),
        *(seed.source_ordinal for seed in batch.event_seeds),
        resume_ordinal,
        0,
    )
    facts.append(_fact("structural", f"source:{batch.source.source_id}", latest, {
        "record_type": "source_scope", "harness": batch.root.harness,
        "source_session_id": batch.root.source_session_id,
        "root_session_id": batch.root.root_session_id,
        "parent_session_id": batch.root.parent_session_id,
        "state": batch.root.state,
        "project_key": batch.source.project_key,
        "project_attribution": batch.source.project_attribution,
        "capture_status": batch.source.status,
        "observed_start": batch.source.observed_start, "observed_end": batch.source.observed_end,
    }))
    for run in batch.runs:
        facts.append(_fact("run", run.run_id, latest, {
            "run_id": run.run_id, "source_session_id": run.source_session_id,
            "logical_run_id": run_members.get(run.run_id, {}).get("logical_id", run.run_id),
            "origin": run_members.get(run.run_id, {}).get(
                "origin", "inline_sidechain" if batch.root.harness == "codex"
                and run.source_session_id != batch.source.source_session_id else "source"
            ),
            "parent_logical_run_id": run_members.get(run.parent_run_id or "", {}).get(
                "logical_id", run.parent_run_id
            ),
            "capture_status": batch.source.status,
            "native_run_id": run.native_run_id, "parent_run_id": run.parent_run_id,
            "role": run.role, "models": list(run.models), "started_at": run.started_at,
            "ended_at": run.ended_at, "locations": list(run.locations),
            "native_facts": _native_facts(run, batch.source),
            "harness": batch.root.harness, "root_session_id": batch.root.root_session_id,
        }))
    for sample in batch.token_samples:
        facts.append(_fact("token", sample.sample_id, sample.source_ordinal, {
            "run_id": sample.run_id, "sample_id": sample.sample_id, "model": sample.model,
            "input": sample.input, "output": sample.output, "cache_creation": sample.cache_creation,
            "cache_read": sample.cache_read, "cumulative": sample.cumulative,
            "epoch_marker": sample.epoch_marker, "at": sample.at, "total": sample.total,
            "origin": sample.origin, "source_ordinal": sample.source_ordinal,
            "block_ordinal": sample.block_ordinal, "role_ordinal": sample.role_ordinal,
            "first_turn_input_total": sample.first_turn_input_total,
        }))
    for tool in batch.tool_calls:
        call_id = call_ids[tool.call_id]
        call_ordinal = call_ordinals[call_id]
        facts.append(_fact("call", call_id, call_ordinal, {
            "call_id": call_id, "run_id": tool.run_id, "native_call_id": tool.native_call_id,
            "at": tool.at, "tool_name": tool.tool_name, "tool_kind": tool.tool_kind,
            "operation_signature": operation_hash(
                tool.operation_signature, already_hashed=tool.operation_signature_hashed
            ),
            "operation_summary": _safe_operation_summary(tool),
            "execution": tool.execution, "source_ordinal": tool.source_ordinal,
            "block_ordinal": tool.block_ordinal, "role_ordinal": tool.role_ordinal,
            "activity_class": tool.activity_class, "skill_key": tool.skill_key,
            "invocation_origin": tool.invocation_origin, "read_file_hash": tool.read_file_hash,
            "edit_file_hash": tool.edit_file_hash, "mcp_server": tool.mcp_server,
            "mcp_tool": tool.mcp_tool, "child_run_id": tool.child_run_id,
            "source_epoch": batch.source.generation_id,
            "evidence": ["collision"] if call_id != tool.call_id else [],
        }))
        for side, parts in (("input", tool.input_parts), ("result", tool.result_parts)):
            for ordinal, part in enumerate(parts):
                physical_id = _part_id(call_id, side, ordinal)
                stored = part_refs.get(physical_id, {})
                facts.append(_fact("part", physical_id, call_ordinal, {
                    "owner_kind": "tool", "call_id": call_id, "side": side, "ordinal": ordinal,
                    "stored_ordinal": stored.get("ordinal", ordinal),
                    "part_id": stored.get("part_id", part.part_id), "kind": stored.get("kind", part.kind),
                    "status": stored.get("status", part.status),
                    "content_type": stored.get("content_type", part.content_type),
                    "body_id": stored.get("body_id", _body_id(part)),
                    "byte_count": stored.get("bytes", len(part.bytes_value or b"")),
                    "retention_tier": stored.get("retention_tier", "B"),
                    "pruned_at": stored.get("pruned_at"), "evidenced_at": stored.get("evidenced_at"),
                    "source_locator": stored.get("source_locator", part.source_locator),
                    "source_epoch": stored.get("source_epoch"),
                    "retained_version": stored.get("retained_version", False),
                    "tombstone_body_id": stored.get("tombstone_body_id"),
                    "mirror_part_key": stored.get("mirror_part_key", part.mirror_part_key),
                }))
    for event in batch.events:
        facts.append(_fact("event", event.event_id, event.source_ordinal, {
            "event_id": event.event_id, "run_id": event.run_id, "at": event.at,
            "kind": event.kind, "correlation_id": event.correlation_id,
            "source_ordinal": event.source_ordinal, "block_ordinal": event.block_ordinal,
            "role_ordinal": event.role_ordinal,
        }))
    for relation in batch.relationships:
        relationship_ordinal = event_ordinals.get(relation.source_event_id, latest)
        facts.append(_fact("relationship", relation.relationship_id, relationship_ordinal, {
            "relationship_id": relation.relationship_id, "from_run_id": relation.from_run_id,
            "to_run_id": relation.to_run_id, "kind": relation.kind, "at": relation.at,
            "status": relation.status, "source_epoch": batch.source.generation_id,
        }))
    for change in batch.changes:
        change_call_id = call_ids.get(change.tool_call_id) if change.tool_call_id else None
        change_ordinal = event_ordinals.get(
            change.source_event_id, call_ordinals.get(change_call_id, latest) if change_call_id else latest
        )
        facts.append(_fact("change", change.change_id, change_ordinal, {
            "change_id": change.change_id, "run_id": change.run_id,
            "source_event_id": change.source_event_id, "tool_call_id": change_call_id,
            "kind": change.kind, "attribution": change.attribution, "repository_id": change.repository_id,
            "revision_id": change.revision_id, "base_id": change.base_id,
            "merge_base_id": change.merge_base_id, "files": list(change.files),
            "source_epoch": batch.source.generation_id,
            "captured_at": event_times.get(change.source_event_id) or call_times.get(change.tool_call_id or ""),
        }))
        for ordinal, part in enumerate(change.body_parts):
            physical_id = _part_id(change.change_id, "change", ordinal)
            stored = part_refs.get(physical_id, {})
            facts.append(_fact("part", physical_id, change_ordinal, {
                "owner_kind": "change", "change_id": change.change_id, "ordinal": ordinal,
                "stored_ordinal": stored.get("ordinal", ordinal),
                "part_id": stored.get("part_id", part.part_id), "kind": stored.get("kind", part.kind),
                "status": stored.get("status", part.status),
                "content_type": stored.get("content_type", part.content_type),
                "body_id": stored.get("body_id", _body_id(part)),
                "byte_count": stored.get("bytes", len(part.bytes_value or b"")),
                "retention_tier": stored.get("retention_tier", "B"),
                "pruned_at": stored.get("pruned_at"), "evidenced_at": stored.get("evidenced_at"),
                "source_locator": stored.get("source_locator", part.source_locator),
                "source_epoch": stored.get("source_epoch"),
                "retained_version": stored.get("retained_version", False),
                "tombstone_body_id": stored.get("tombstone_body_id"),
                "mirror_part_key": stored.get("mirror_part_key", part.mirror_part_key),
            }))
    for pr in batch.prs:
        facts.append(_fact("pr", pr.pr_id, event_ordinals.get(pr.source_event_id, latest), {
            "pr_id": pr.pr_id, "source_event_id": pr.source_event_id,
            "repository_id": pr.repository_id, "number": pr.number, "url": pr.url,
            "relationship": pr.relationship, "evidenced_at": pr.evidenced_at,
            "source_epoch": batch.source.generation_id,
        }))
    for message in batch.messages:
        facts.append(_fact("message", message.message_id, message.source_ordinal, {
            "message_id": message.message_id, "run_id": message.run_id, "at": message.at,
            "role": message.role, "kind": message.kind, "text_len": message.text_len,
            "thinking_len": message.thinking_len, "is_steering": message.is_steering,
            "slash_command": message.slash_command, "excerpt": message.excerpt,
            "first_turn_input_total": message.first_turn_input_total, "stacked": message.stacked,
            "interrupted": message.interrupted, "synthetic": message.synthetic,
            "native_kind": message.native_kind, "source_ordinal": message.source_ordinal,
            "block_ordinal": message.block_ordinal, "role_ordinal": message.role_ordinal,
        }))
    for seed in batch.event_seeds:
        facts.append(_fact("structural", seed.event_id, seed.source_ordinal, {
            "event_id": seed.event_id, "run_id": seed.run_id, "at": seed.at, "kind": seed.kind,
            "name": seed.name, "invoker": seed.invoker, "correlation_id": seed.correlation_id,
            "message_id": seed.message_id, "model": seed.model, "stacked": seed.stacked,
            "interrupted": seed.interrupted, "additive": seed.additive,
            "count": seed.count,
            "source_ordinal": seed.source_ordinal, "block_ordinal": seed.block_ordinal,
            "role_ordinal": seed.role_ordinal,
        }))
    return facts


def current_members(db: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return all selected members for inventory callers."""
    return reads.CurrentReadSet(db).members()


def current_facts(db: sqlite3.Connection, kind: str) -> list[dict[str, Any]]:
    """Read completed facts for inventory callers; scoped readers reuse a read set."""
    return reads.CurrentReadSet(db).facts(kind)


def _fact(kind: str, physical_id: str, ordinal: int, metadata: dict[str, Any]) -> versions.VersionFact:
    return versions.VersionFact(kind, physical_id, max(0, ordinal), metadata)


def _part_id(call_id: str, side: str, ordinal: int) -> str:
    return f"{call_id}:{side}:{ordinal}"


def _resume_record_ordinal(resume_state: str) -> int:
    try:
        value = json.loads(resume_state)
    except (TypeError, ValueError):
        return 0
    ordinal = value.get("record_ordinal") if isinstance(value, dict) else None
    return ordinal - 1 if isinstance(ordinal, int) and ordinal > 0 else 0


def _body_id(part: Any) -> str | None:
    if part.bytes_value is None or part.status in {"unavailable", "unsupported"}:
        return None
    return body_identity(part.bytes_value)


def _native_facts(run: Any, source: Any) -> dict[str, Any]:
    facts = {
        key: value
        for key, value in {
            "lines_added": run.native_lines_added, "lines_removed": run.native_lines_removed,
            "duration_ms": run.native_duration_ms, "branch": run.native_branch,
        }.items()
        if value is not None
    }

    if run.source_session_id == source.source_session_id:
        if source.status in {"incomplete", "unavailable"}:
            facts["tool_capture_complete"] = False
        elif source.reader_id and source.reader_revision >= 4:
            facts["tool_capture_complete"] = source.status == "active"
    return facts


def _safe_operation_summary(tool: Any) -> str | None:
    """Publish only the adapter's bounded display summary."""
    if tool.operation_summary is not None:
        summary = tool.operation_summary
    elif tool.operation_signature is None or tool.operation_signature.startswith("op:"):
        return tool.tool_name
    else:
        summary = operation_summary(tool.tool_name, tool.operation_signature)
    # Invocation summaries are optional display metadata. A secret-shaped
    # value has no safe abbreviated form, so retain only the tool label.
    if summary is not None and "secret" in summary.lower():
        return tool.tool_name
    return summary
