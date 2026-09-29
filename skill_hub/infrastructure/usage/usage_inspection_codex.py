"""Codex rollout JSONL normalizer for durable Usage inspection."""
# ruff: noqa: E501
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import shlex
import time
from pathlib import Path
from typing import Any, cast

from skill_hub.domain.harnesses.harness_usage_api import (
    CaptureHost,
    ReaderSource,
    SourceProbe,
    SourceRecognition,
    capture_operation_summary,
    capture_records,
    source_generation,
)
from skill_hub.domain.usage.usage_inspection_capture import (
    BodyPartInput,
    CaptureBatch,
    ChangeInput,
    EventInput,
    MessageInput,
    PrInput,
    ReaderBindingSourceEvidence,
    RelationshipInput,
    RootResolution,
    RunInput,
    SourceCursor,
    SourceInput,
    SummaryEventSeedInput,
    TokenSampleInput,
    ToolCallInput,
    dump_resume_state,
    json_body,
    load_resume_state,
    operation_hash,
    stable_id,
    text_body,
)
from skill_hub.infrastructure.usage.usage_capture_io import (
    append_proven,
    capture_revision_patch,
    hashes_for_commit,
    read_complete_suffix,
    snapshot_fingerprint_matches,
    source_fingerprint,
)
from skill_hub.infrastructure.usage.usage_capture_summary import with_operation_summary_v1
from skill_hub.infrastructure.usage.usage_reader_context import SourceBoundCaptureHost

CAPTURE_PARSER_VERSION = 2
_ROLLOUT_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


class CodexIdentityError(ValueError):
    """The native identity does not match a recognized rollout filename."""

    kind = "identity_mismatch"


def _item(record: dict[str, Any]) -> Any:
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return record
    # The streamed writer wraps the same item in
    # response.output_item.done.item. Preserve its actual call body so the
    # persisted call_id can still pair with a later output item.
    if payload.get("type") == "response.output_item.done" and isinstance(payload.get("item"), dict):
        return payload["item"]
    return payload


READER_ID = "usage_inspection_codex"
READER_REVISION = 6
NORMALIZATION_VERSION = 1
CAPTURE_CONTRACT_VERSION = 1


def reader_source_evidence(records: list[dict]) -> ReaderBindingSourceEvidence:
    recognized = any(record.get("type") in {"session_meta", "response_item"} for record in records)
    return _source_evidence(recognized)


def _source_evidence(recognized: bool) -> ReaderBindingSourceEvidence:
    return ReaderBindingSourceEvidence(
        producer="codex" if recognized else "unknown_legacy",
        native_format="codex-rollout-jsonl" if recognized else "unknown_legacy",
        format_fingerprint=stable_id("codex", "rollout-jsonl", "v1") if recognized else stable_id("unknown_legacy", "v1"),
    )


def recognize_source(probe: SourceProbe) -> SourceRecognition:
    """Recognize Codex rollouts from Codex-specific record structure only."""

    recognized = any(
        isinstance(value := record.get("type"), str)
        and value in {"session_meta", "response_item"}
        for record in probe.records
    )
    legacy_eligible = any(
        isinstance(record.get("type"), str)
        and record.get("type") in {"event_msg", "turn_context", "compacted"}
        and isinstance(record.get("payload"), dict)
        for record in probe.records
    )
    complete = probe.stop_reason == "eof"
    return SourceRecognition(
        "codex" if recognized else None,
        None,
        "codex-rollout-jsonl" if recognized else None,
        stable_id("codex", "rollout-jsonl", "v1") if recognized else None,
        "complete" if complete else "partial",
        "recognized" if recognized else "legacy_eligible" if legacy_eligible else "inconclusive",
    )


def _timestamp(value: object) -> str | None:
    if isinstance(value, str):
        return value.replace("+00:00", "Z") if value.endswith("+00:00") else value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except (ValueError, OverflowError, OSError):
            return None
    return None


def capture_codex_source(
    path: Path | ReaderSource,
    cursor: SourceCursor | None = None,
    host: CaptureHost | None = None,
    *,
    deadline: float | None = None,
) -> CaptureBatch:
    if isinstance(path, ReaderSource):
        reader_source: ReaderSource | None = path
        source_path = Path(path.lexical_path)
    else:
        reader_source = None
        source_path = path
    session_hint = reader_source.source_session_id if reader_source is not None else ""
    if host is None:
        host = SourceBoundCaptureHost(
            source_path,
            source_session_id=session_hint,
            fingerprint_fn=source_fingerprint,
            append_proven_fn=append_proven,
            read_complete_suffix_fn=read_complete_suffix,
            snapshot_matches_fn=snapshot_fingerprint_matches,
            hashes_for_commit_fn=hashes_for_commit,
        )
    host = with_operation_summary_v1(host)
    source_id_hint = reader_source.source_id if reader_source is not None else "codex:" + hashlib.sha256(str(source_path).encode()).hexdigest()
    cursor = cursor or SourceCursor(source_id_hint, "", 0, 0, host.fingerprint())
    raw, fp, offset_start, offset_end, partial = host.read_complete_suffix(cursor, deadline)
    state = load_resume_state(cursor, reader_id=READER_ID, reader_revision=READER_REVISION, normalization_version=NORMALIZATION_VERSION)
    if offset_start and state is None:
        # A stale reader state gets one safe full reparse. Use the same
        # complete-line reader as incremental capture so a partial final JSONL
        # record remains pending for the next pass.
        reset_cursor = SourceCursor(source_id_hint, "", 0, 0, cursor.fingerprint)
        raw, fp, offset_start, offset_end, partial = host.read_complete_suffix(reset_cursor, deadline)
    incremental = offset_start > 0 and state is not None
    generation = source_generation(
        source_path, cursor, fp, lambda: host.append_proven(cursor)
    )
    source_id = source_id_hint
    records = list(capture_records(host, raw, fp, offset_start, deadline=deadline))
    filename_match = _ROLLOUT_UUID.search(source_path.stem)
    # Native rollouts normally carry a timestamp before the trailing UUID.
    # Short fixture names and older exports may omit that prefix; the UUID is
    # still the stable source identity in both forms.
    session_id = session_hint or (filename_match.group(0) if filename_match is not None else source_path.stem.removeprefix("rollout-"))
    root_id = session_id
    parent_id: str | None = None
    role: str | None = None
    if state is not None:
        saved_session = cast(dict[str, Any], state.get("session") if isinstance(state.get("session"), dict) else {})
        session_id = str(saved_session.get("source_session_id") or session_id)
        root_id = str(saved_session.get("root_session_id") or session_id)
        parent_value = saved_session.get("parent_session_id")
        parent_id = parent_value if isinstance(parent_value, str) else None
    runs: dict[str, RunInput] = {}
    run_id = stable_id("codex", session_id, session_id)
    calls: dict[str, dict] = {}
    existing_calls: set[str] = set()
    if state is not None:
        for native, value in (state.get("open_calls") or {}).items():
            if isinstance(value, dict):
                calls[str(native)] = {**value, "input": None, "operation": value.get("operation_hash"), "operation_hashed": bool(value.get("operation_signature_hashed")), "operation_summary": value.get("operation_summary")}
                existing_calls.add(str(native))
    results: dict[str, list[BodyPartInput]] = {}
    samples: list[TokenSampleInput] = []
    seen_sample_ids: set[str] = set()
    events: list[EventInput] = []
    compaction_markers = set(state.get("compaction_markers") or ()) if state is not None else set()
    messages: list[MessageInput] = []
    seeds: list[SummaryEventSeedInput] = []
    relationships: list[RelationshipInput] = []
    changes: list[ChangeInput] = []
    prs: list[PrInput] = []
    repo_info: dict[str, str] = {}
    run_locations: dict[str, list[dict[str, str]]] = {}
    turn_models: dict[str, str] = {}
    own_identity: str | None = None
    identity_record_seen = False
    if state is not None and isinstance(state.get("session"), dict):
        saved_identity = state["session"].get("source_session_id")
        if isinstance(saved_identity, str):
            own_identity = saved_identity
    # IDs persisted by v1 remain stable even where ownership was wrong.
    identity_run_id = run_id
    native_thread_ids: set[str | None] = set()
    if state is not None:
        saved_native = state.get("native_thread_ids")
        if isinstance(saved_native, list):
            native_thread_ids.update(value if value is None or isinstance(value, str) else None for value in saved_native)
        saved_models = state.get("turn_models")
        if isinstance(saved_models, dict):
            turn_models.update({str(key): str(value) for key, value in saved_models.items() if isinstance(value, str)})
    for record in records:
        if record.get("type") not in {"token_usage_record", "compacted"}:
            continue
        candidate = _item(record)
        if record.get("type") == "compacted":
            candidate = candidate.get("latest_token_usage_record")
            if not isinstance(candidate, dict):
                continue
        usage = candidate.get("thread_token_usage") or candidate.get("usage")
        thread_id = candidate.get("thread_id")
        if (thread_id is None or isinstance(thread_id, str)) and isinstance(usage, dict) and any(
            key in usage for key in ("input_tokens", "output_tokens", "input", "output", "total_tokens")
        ):
            native_thread_ids.add(thread_id)
    record_base = int(state.get("record_ordinal", 0)) if state is not None else 0
    first_turn_seen = bool(state.get("first_turn_token_seen")) if state is not None else False
    latest_model = state.get("latest_model") if state is not None else None
    observed_start = state.get("observed_start") if state is not None else None
    observed_end = state.get("observed_end") if state is not None else None
    for relative_ordinal, record in enumerate(records):
        if deadline is not None and time.monotonic() > deadline:
            raise TimeoutError("source budget exceeded")
        ordinal = record_base + relative_ordinal
        payload = _item(record)
        typ = str(record.get("type") or payload.get("type") or "")
        if typ == "session_meta" or payload.get("type") == "session_meta":
            identity_record_seen = True
            meta = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
            legacy_id = str(meta.get("id") or session_id)
            legacy_spawn = meta.get("source", {})
            if isinstance(legacy_spawn, dict):
                legacy_spawn = legacy_spawn.get("subagent", {})
                if isinstance(legacy_spawn, dict):
                    legacy_spawn = legacy_spawn.get("thread_spawn", {})
                    if isinstance(legacy_spawn, dict) and isinstance(legacy_spawn.get("thread_id"), str):
                        legacy_id = legacy_spawn["thread_id"]
            identity_run_id = stable_id("codex", legacy_id, legacy_id)
            candidate = meta.get("id") or meta.get("session_id")
            if own_identity is not None and candidate and str(candidate) != own_identity:
                # A child rollout can retain its parent's old header after its
                # own header. Accept that inherited evidence, while rejecting
                # an unrelated identity even when it arrives in an appended
                # suffix after a valid prefix.
                if str(candidate) not in {parent_id, root_id}:
                    raise CodexIdentityError("identity_mismatch")
                continue
            if own_identity is None and candidate:
                own_identity = str(candidate)
                session_id = own_identity
            top_parent = meta.get("parent_thread_id")
            source = meta.get("source") if isinstance(meta.get("source"), dict) else {}
            subagent = source.get("subagent") if isinstance(source.get("subagent"), dict) else {}
            spawn_candidate = subagent.get("thread_spawn") if isinstance(subagent, dict) else None
            spawn_meta = cast(dict[str, Any], spawn_candidate) if isinstance(spawn_candidate, dict) else {}
            parent_id = top_parent if isinstance(top_parent, str) else (spawn_meta.get("parent_thread_id") if isinstance(spawn_meta.get("parent_thread_id"), str) else parent_id)
            role = meta.get("agent_role") if isinstance(meta.get("agent_role"), str) else (spawn_meta.get("agent_role") if isinstance(spawn_meta.get("agent_role"), str) else role)
            root_id = parent_id or session_id
            run_id = stable_id("codex", session_id, session_id)
            for key in ("cwd", "repository", "repo", "worktree"):
                if isinstance(meta.get(key), str):
                    repo_info["path"] = meta[key]
            for key in ("revision", "revision_id", "head", "commit"):
                if isinstance(meta.get(key), str):
                    repo_info["revision"] = meta[key]
            for key in ("base", "base_id", "base_commit"):
                if isinstance(meta.get(key), str):
                    repo_info["base"] = meta[key]
            for key in ("merge_base", "merge_base_id"):
                if isinstance(meta.get(key), str):
                    repo_info["merge_base"] = meta[key]
        at = _timestamp(record.get("timestamp")) or _timestamp(payload.get("timestamp"))
        record_token = payload if typ == "token_usage_record" else (
            payload.get("latest_token_usage_record") if typ == "compacted" else None
        )
        inherited_parent_record = (
            isinstance(record_token, dict)
            and parent_id is not None
            and record_token.get("thread_id") == parent_id
        )
        if at is not None and not inherited_parent_record:
            observed_start = min(value for value in (observed_start, at) if isinstance(value, str))
            observed_end = max(value for value in (observed_end, at) if isinstance(value, str))
        if typ == "pr-link" and isinstance(payload.get("prUrl"), str) and isinstance(payload.get("prNumber"), int) and payload.get("prNumber", 0) > 0 and payload["prUrl"].startswith("https://"):
            repo = payload.get("prRepository") if isinstance(payload.get("prRepository"), str) else "unknown"
            prs.append(PrInput("pr:" + stable_id(repo, payload["prNumber"], "associated", ordinal), generation, "event:" + stable_id(generation, ordinal, "pr"), repo, payload["prNumber"], payload["prUrl"], "associated", at))
            unavailable = BodyPartInput("body:" + stable_id(generation, ordinal, "pr-change"), "pr_change", "unavailable", "text/x-diff", None, None)
            changes.append(ChangeInput("change:" + stable_id(generation, ordinal, "pr-change"), run_id, generation, "event:" + stable_id(generation, ordinal, "pr"), None, "pr_change", "associated", repo, None, None, None, (), (unavailable,)))
        if typ == "turn_context" and isinstance(payload.get("model"), str):
            turn_models[str(payload.get("turn_id") or "")] = payload["model"]
            latest_model = payload["model"]
        if typ == "compacted":
            marker = str(payload.get("turn_id") or at or "")
            if marker not in compaction_markers:
                compaction_markers.add(marker)
                seeds.append(SummaryEventSeedInput("seed:" + stable_id(generation, ordinal, "compaction"), run_id, generation, ordinal, 0, 0, at, "compaction", None, "model", None))
        if typ in {"event_msg", "response_item"}:
            event_kind = str(payload.get("type") or "")
            if event_kind in ("user_message", "task_started", "task_complete", "wait_started", "wait_result"):
                mapped = cast(Any, {"user_message": "message", "task_started": "task_started", "task_complete": "task_complete", "wait_started": "wait_started", "wait_result": "wait_result"}[event_kind])
                events.append(EventInput("event:" + stable_id(generation, record.get("id"), ordinal), generation, str(record.get("id")) if record.get("id") else None, at, mapped, stable_id(payload), run_id, None, ordinal, 0, 0))
            if event_kind == "user_message":
                text = str(payload.get("message") or "")
                message_id = "message:" + stable_id(generation, ordinal, "user")
                messages.append(MessageInput(message_id, run_id, generation, ordinal, 0, 0, at, "user", "human_turn", len(text), 0, False, None, native_kind=event_kind, excerpt_hint=text))
                seeds.append(SummaryEventSeedInput("seed:" + stable_id(generation, ordinal, "human"), run_id, generation, ordinal, 0, 0, at, "human_turn", None, "you", None, message_id))
            source = payload.get("source")
            spawn = source.get("subagent") if isinstance(source, dict) else None
            spawned = spawn.get("thread_spawn") if isinstance(spawn, dict) else None
            if isinstance(spawned, dict) and isinstance(spawned.get("thread_id"), str):
                target = stable_id("codex", spawned["thread_id"], spawned["thread_id"])
                relationships.append(RelationshipInput("relationship:" + stable_id(generation, ordinal), generation, "event:" + stable_id(generation, record.get("id"), ordinal), run_id, target, "spawn", at, "observed"))
            wrapper_payload = record.get("payload")
            item = wrapper_payload.get("item") if isinstance(wrapper_payload, dict) else None
            if isinstance(item, dict) and item.get("type") == "FileChange":
                changes_map = item.get("changes")
                if isinstance(changes_map, dict):
                    files = tuple(sorted(str(name) for name in changes_map))
                    body = json_body("body:" + stable_id(generation, ordinal, "change"), "runtime_event", changes_map)
                    changes.append(ChangeInput("change:" + stable_id(generation, ordinal), run_id, generation, "event:" + stable_id(generation, record.get("id"), ordinal), None, "runtime_patch", "captured", None, None, None, None, files, (body,)))
            runtime_item = item if isinstance(item, dict) else {}
            item_type = runtime_item.get("type") or payload.get("item_type")
            runtime_types = {"CommandExecution", "FileChange", "ImageView", "Extension", "SubAgentActivity", "CollabAgentToolCall", "McpToolCall"}
            runtime_model = turn_models.get(str(payload.get("turn_id") or "")) or latest_model
            def seed(kind: str, name: str | None = None, *, index: int = 0, text_hint: str | None = None) -> None:
                seeds.append(SummaryEventSeedInput(
                    "seed:" + stable_id(generation, ordinal, kind, index), run_id, generation,
                    ordinal, index, 0, at, kind, name, "model", None,
                    model=runtime_model, text_hint=text_hint,
                ))
            if item_type == "ContextCompaction":
                marker = str(payload.get("turn_id") or at or "")
                if marker not in compaction_markers:
                    compaction_markers.add(marker)
                    seed("compaction")
            elif item_type in runtime_types:
                runtime_name = str(runtime_item.get("name") or runtime_item.get("tool") or item_type)
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", runtime_name):
                    runtime_name = str(item_type)
                if item_type == "McpToolCall":
                    server = runtime_item.get("server") or runtime_item.get("server_name")
                    tool = runtime_item.get("tool") or runtime_item.get("name")
                    if all(isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,96}", v) for v in (server, tool)):
                        seed("tool", f"{server}/{tool}")
                    seed("activity", "external")
                else:
                    # Preserve the legacy event kind. Delegation is an activity;
                    # these runtime records were emitted as tool events.
                    seed("tool", runtime_name)
                    if item_type == "CommandExecution":
                        command = runtime_item.get("command")
                        if isinstance(command, str):
                            seed("skill_text", text_hint=command)
                        for index, part in enumerate(runtime_item.get("parsed_cmd") or ()):
                            if not isinstance(part, dict):
                                continue
                            seed("activity", "read" if part.get("type") in {"read", "list_files", "search"} else "operate", index=index)
                            path_value = part.get("path")
                            if isinstance(path_value, str) and path_value:
                                seed("read_file", "path:" + hashlib.sha256(path_value.encode()).hexdigest(), index=index)
                    elif item_type == "FileChange":
                        seed("activity", "edit")
                        for index, path_value in enumerate(runtime_item.get("changes") or {}):
                            if isinstance(path_value, str):
                                seed("edit_file", "path:" + hashlib.sha256(path_value.encode()).hexdigest(), index=index)
                    else:
                        seed("activity", {"ImageView": "read", "Extension": "operate", "SubAgentActivity": "delegate", "CollabAgentToolCall": "delegate"}[str(item_type)])
        token_payload = payload if typ == "token_usage_record" else (
            payload.get("latest_token_usage_record") if typ == "compacted" else None
        )
        if isinstance(token_payload, dict):
            token_thread = token_payload.get("thread_id")
            if parent_id is not None and token_thread == parent_id:
                continue
            token_run_id = run_id
            if isinstance(token_thread, str) and token_thread != session_id:
                token_run_id = stable_id("codex", token_thread, token_thread)
                runs[token_run_id] = RunInput(
                    token_run_id,
                    token_thread,
                    token_thread,
                    run_id,
                    None,
                    (),
                    None,
                    None,
                    (),
                )
            cumulative = isinstance(token_payload.get("thread_token_usage"), dict)
            usage = token_payload.get("thread_token_usage") if cumulative else token_payload.get("usage")
            if isinstance(usage, dict) and any(
                key in usage for key in ("input_tokens", "output_tokens", "input", "output", "total_tokens")
            ):
                first = None if first_turn_seen or token_run_id != run_id else int(usage.get("input_tokens") or usage.get("input") or 0) + int(usage.get("cache_creation_input_tokens") or usage.get("cache_creation") or usage.get("cache_write_input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or usage.get("cache_read") or usage.get("cached_input_tokens") or 0)
                turn_usage = token_payload.get("turn_token_usage")
                if not first_turn_seen and token_run_id == run_id and isinstance(turn_usage, dict):
                    first = int(turn_usage.get("input_tokens") or 0) + int(turn_usage.get("cache_write_input_tokens", turn_usage.get("cache_creation_input_tokens", 0)) or 0) + int(turn_usage.get("cached_input_tokens", turn_usage.get("cache_read_input_tokens", 0)) or 0)
                first_turn_seen = first_turn_seen or first is not None
                native_sample = token_payload.get("response_id") or record.get("id") or ordinal
                sample_id = stable_id("codex-sample-v2", token_run_id, native_sample)
                if sample_id not in seen_sample_ids:
                    seen_sample_ids.add(sample_id)
                    native_key = (
                        "record:" + str(native_sample)
                        if token_payload.get("response_id") or record.get("id")
                        else "ordinal:" + str(ordinal)
                    )
                    samples.append(TokenSampleInput(token_run_id, sample_id, turn_models.get(str(token_payload.get("turn_id") or "")), int(usage.get("input_tokens") or usage.get("input") or 0), int(usage.get("output_tokens") or usage.get("output") or 0), int(usage.get("cache_creation_input_tokens") or usage.get("cache_creation") or usage.get("cache_write_input_tokens") or 0), int(usage.get("cache_read_input_tokens") or usage.get("cache_read") or usage.get("cached_input_tokens") or 0), cumulative, typ == "compacted", at, int(usage["total_tokens"]) if usage.get("total_tokens") is not None else None, "native", native_key, ordinal, 0, 0, first))
                reasoning = usage.get("reasoning_output_tokens") or token_payload.get("reasoning_output_tokens")
                if isinstance(reasoning, int) and reasoning > 0:
                    seeds.append(SummaryEventSeedInput("seed:" + stable_id(generation, ordinal, "reasoning"), run_id, generation, ordinal, 0, 1, at, "thinking", None, "model", None, model=turn_models.get(str(token_payload.get("turn_id") or "")) or latest_model, count=reasoning))
        if not ({None, session_id} & native_thread_ids) and typ == "event_msg" and payload.get("type") == "token_count":
            info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
            usage = info.get("total_token_usage") if isinstance(info.get("total_token_usage"), dict) else None
            if usage and any(key in usage for key in ("input_tokens", "output_tokens")):
                first = None if first_turn_seen else int(usage.get("input_tokens") or 0) + int(usage.get("cache_write_input_tokens") or usage.get("cache_creation_input_tokens") or 0) + int(usage.get("cached_input_tokens") or usage.get("cache_read_input_tokens") or 0)
                first_turn_seen = first_turn_seen or first is not None
                samples.append(TokenSampleInput(run_id, stable_id("codex-sample-v2", run_id, payload.get("id") or record.get("id"), ordinal), None, int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0), int(usage.get("cache_write_input_tokens") or usage.get("cache_creation_input_tokens") or 0), int(usage.get("cached_input_tokens") or usage.get("cache_read_input_tokens") or 0), True, False, at, int(usage["total_tokens"]) if usage.get("total_tokens") is not None else None, "event_mirror", None, ordinal, 0, 0, first))
        call_type = typ
        if typ in ("response_item", "response.output_item.done"):
            payload = _item(record)
            call_type = str(payload.get("type") or "")
        if call_type in ("function_call", "custom_tool_call"):
            native = str(payload.get("call_id") or payload.get("id") or stable_id(payload, ordinal))
            name = str(payload.get("name") or "unknown")
            raw_input = payload.get("arguments") if call_type == "function_call" else payload.get("input")
            if isinstance(raw_input, str):
                input_part = text_body("body:" + stable_id(identity_run_id, native, "input"), "invocation", raw_input)
                try:
                    operation = json.dumps(json.loads(raw_input), sort_keys=True, separators=(",", ":"))
                except (ValueError, TypeError):
                    operation = raw_input
            elif raw_input is not None:
                input_part = json_body("body:" + stable_id(identity_run_id, native, "input"), "invocation", raw_input)
                operation = json.dumps(raw_input, sort_keys=True, separators=(",", ":"))
            else:
                input_part = BodyPartInput("body:" + stable_id(identity_run_id, native, "input"), "invocation", "unavailable", "application/json", None, None)
                operation = None
            call_id = "call:" + stable_id(identity_run_id, native, name, operation or "")
            calls[native] = {"call_id": call_id, "native": native, "name": name, "at": at, "input": input_part, "operation": operation, "source_ordinal": ordinal, "block_ordinal": 0}
            if name in {"shell", "Bash", "bash"}:
                command_value = raw_input if isinstance(raw_input, dict) else None
                command_text = command_value.get("command") if isinstance(command_value, dict) else None
                argv = shlex.split(command_text) if isinstance(command_text, str) and not re.search(r"[;&|<>$`]", command_text) else []
                calls[native]["pr_action"] = argv[2] if len(argv) > 2 and argv[:2] == ["gh", "pr"] else None
            if name == "exec_command" and isinstance(raw_input, str):
                try:
                    command_args = json.loads(raw_input)
                except (ValueError, TypeError):
                    command_args = None
            else:
                command_args = raw_input if isinstance(raw_input, dict) else None
            if name == "exec_command" and isinstance(command_args, dict):
                requested = command_args.get("workdir") or command_args.get("cwd")
                if isinstance(requested, str) and requested and Path(requested).is_absolute():
                    calls[native]["requested_location"] = requested
            kind = "function" if call_type == "function_call" else "local"
            events.append(EventInput("event:" + stable_id(generation, record.get("id"), native, "start"), generation, str(record.get("id")) if record.get("id") else None, at, "tool_started", stable_id(payload), run_id, native, ordinal, 0, 0))
        elif call_type in ("function_call_output", "custom_tool_call_output"):
            native = str(payload.get("call_id") or payload.get("id") or "")
            matching = calls.get(native)
            if matching is not None:
                output = payload.get("output")
                if isinstance(output, str):
                    part = text_body("body:" + stable_id(matching["call_id"], "output"), "function_output", output)
                else:
                    part = json_body("body:" + stable_id(matching["call_id"], "output"), "function_output", output) if output is not None else BodyPartInput("body:" + stable_id(matching["call_id"], "output"), "function_output", "unavailable", "text/plain", None, None)
                has_success = payload.get("success") is not None or payload.get("exit_code") is not None
                matching["result_success"] = (
                    payload.get("success") is True or payload.get("exit_code") == 0
                ) if has_success else None
                if matching.get("requested_location") and matching["result_success"] is True:
                    run_locations.setdefault(run_id, []).append({
                        "id": matching["requested_location"],
                        "label": matching["requested_location"],
                        "basis": "command_workdir",
                    })
                results[native] = [part]
                events.append(EventInput("event:" + stable_id(generation, record.get("id"), native, "result"), generation, str(record.get("id")) if record.get("id") else None, at, "tool_result", stable_id(payload), run_id, native, ordinal, 0, 0))
        elif call_type == "patch_apply_end" or (typ == "event_msg" and payload.get("type") == "patch_apply_end"):
            changes_map = payload.get("changes")
            events.append(EventInput("event:" + stable_id(generation, record.get("id"), "patch"), generation, str(record.get("id")) if record.get("id") else None, at, "patch_apply_end", stable_id(changes_map), run_id, None, ordinal, 0, 0))
            if isinstance(changes_map, dict):
                files = tuple(sorted(str(name) for name in changes_map))
                success = payload.get("success") is True
                status = cast(Any, "available" if success else "unavailable")
                body = json_body("body:" + stable_id(generation, ordinal, "patch"), "runtime_event", changes_map, status=status)
                changes.append(ChangeInput("change:" + stable_id(identity_run_id, str(record.get("id") or ordinal), "runtime_patch"), run_id, generation, "event:" + stable_id(generation, record.get("id"), "patch"), None, "runtime_patch", "confirmed" if success else "unavailable", None, None, None, None, files, (body,)))
        elif call_type and call_type not in {"session_meta", "turn_context", "token_usage_record", "event_msg", "compacted"}:
            native = str(payload.get("id") or record.get("id") or stable_id(payload, ordinal))
            call_id = "call:" + stable_id(identity_run_id, native, call_type)
            raw_part = json_body("body:" + stable_id(call_id, "input"), "unsupported", payload, status="unsupported")
            calls[native] = {"call_id": call_id, "native": native, "name": call_type, "at": at, "input": raw_part, "operation": None, "source_ordinal": ordinal, "block_ordinal": 0}
    runs[run_id] = RunInput(run_id, session_id, session_id, stable_id("codex", parent_id, parent_id) if parent_id else None, role, tuple(sorted(set(turn_models.values()))), None, None, tuple(run_locations.get(run_id, ())))
    tools = [
        ToolCallInput(
            value["call_id"], run_id, value["native"], value["at"], value["name"],
            "function" if value["name"] != "apply_patch" else "local", operation_hash(value["operation"], already_hashed=bool(value.get("operation_hashed"))),
            "failed" if native in results and value.get("result_success") is False
            else ("completed" if native in results else "pending"),
            ((value["input"],) if value.get("input") is not None else ()), tuple(results.get(native, ())),
            value.get("operation_summary") or capture_operation_summary(host, value["name"], value.get("operation")), True,
            int(value.get("source_ordinal", 0)), int(value.get("block_ordinal", 0)), 0,
        )
        for native, value in calls.items()
        if not (incremental and native in existing_calls and not results.get(native))
    ]
    for native, value in calls.items():
        result_parts = tuple(results.get(native, ()))
        if value["name"] == "apply_patch" and result_parts:
            patch_text = value["input"].bytes_value if value.get("input") is not None else b""
            files = tuple(sorted(set(re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", patch_text.decode("utf-8", "replace"), re.MULTILINE))))
            success = value.get("result_success") is not False
            for part in result_parts:
                try:
                    payload_result = json.loads(part.bytes_value or b"{}")
                    if isinstance(payload_result, dict) and (payload_result.get("success") is False or payload_result.get("exit_code") not in (None, 0)):
                        success = False
                except (ValueError, TypeError):
                    pass
                if part.bytes_value and b'"success":false' in part.bytes_value.replace(b" ", b""):
                    success = False
            changes.append(ChangeInput("change:" + stable_id(value["call_id"], "tool_patch"), run_id, generation, "event:" + stable_id(generation, native, "patch"), value["call_id"], "tool_patch", "confirmed" if success else "attempted", None, None, None, None, files, (value["input"], *result_parts)))
        if value["name"] not in {"shell", "Bash", "bash"} or not result_parts:
            continue
        try:
            if value.get("input") is None:
                action = value.get("pr_action")
                argv = []
            else:
                invocation = json.loads(value["input"].bytes_value or b"{}")
                command = invocation.get("command") if isinstance(invocation, dict) else None
                argv = shlex.split(command) if isinstance(command, str) and not re.search(r"[;&|<>$`]", command) else []
                action = argv[2] if len(argv) > 2 and argv[:2] == ["gh", "pr"] else None
            if action not in {"create", "edit", "review"}:
                continue
            output = b"\n".join(part.bytes_value or b"" for part in result_parts)
            match = re.search(rb"https://github\.com/([^/]+/[^/]+)/pull/(\d+)", output)
            if not match:
                continue
            repo = "github.com/" + match.group(1).decode("utf-8", "replace")
            number = int(match.group(2))
            relation = cast(Any, {"create": "created", "edit": "changed", "review": "reviewed"}[action])
            prs.append(PrInput("pr:" + stable_id(repo, number, relation, native), generation, "event:" + stable_id(generation, native, action), repo, number, match.group(0).decode(), relation, value["at"]))
            unavailable = BodyPartInput("body:" + stable_id(generation, native, "pr-change"), "pr_change", "unavailable", "text/x-diff", None, None)
            changes.append(ChangeInput("change:" + stable_id(generation, native, "pr-change"), run_id, generation, "event:" + stable_id(generation, native, action), value["call_id"], "pr_change", "associated", repo, None, None, None, (), (unavailable,)))
        except (ValueError, TypeError):
            pass
    filename_identity = _ROLLOUT_UUID.search(source_path.stem)
    if (
        filename_identity is not None
        and identity_record_seen
        and own_identity != filename_identity.group(0)
    ):
        raise CodexIdentityError("identity_mismatch")
    if repo_info.get("path") and repo_info.get("revision") and repo_info.get("base"):
        if hasattr(host, "capture_revision_patch"):
            changes.append(host.capture_revision_patch(repo_info["path"], run_id=run_id, source_epoch=generation, source_event_id="event:" + stable_id(generation, "revision"), repository_id=repo_info["path"], revision_id=repo_info["revision"], base_id=repo_info["base"], merge_base_id=repo_info.get("merge_base"), deadline=deadline))
        else:
            changes.append(capture_revision_patch(Path(repo_info["path"]), run_id=run_id, source_epoch=generation, source_event_id="event:" + stable_id(generation, "revision"), repository_id=repo_info["path"], revision_id=repo_info["revision"], base_id=repo_info["base"], merge_base_id=repo_info.get("merge_base"), deadline=deadline))
    captured_at = cast(str, next((r.get("timestamp") for r in reversed(records) if isinstance(r.get("timestamp"), str)), ""))
    evidence = reader_source_evidence(records)
    if incremental:
        saved_evidence = state.get("reader_source_evidence") if state is not None else None
        # Older cursor state has no recognition proof. Keep that absence
        # explicit until a complete reparse recognizes the source again.
        evidence = reader_source_evidence([])
        if saved_evidence is not None:
            allowed_evidence = (evidence, _source_evidence(True))
            matches = [item for item in allowed_evidence if json.loads(item.canonical_json()) == saved_evidence]
            if not matches:
                raise ValueError("incompatible reader source evidence")
            evidence = matches[0]
    state_out = {
        "reader_source_evidence": json.loads(evidence.canonical_json()),
        "version": 1,
        "reader": {"id": READER_ID, "revision": READER_REVISION},
        "normalization_version": NORMALIZATION_VERSION,
        "record_ordinal": record_base + len(records),
        "first_turn_token_seen": first_turn_seen,
        "compaction_markers": sorted(compaction_markers),
        "session": {"source_session_id": session_id, "root_session_id": root_id, "parent_session_id": parent_id, "state": "child" if parent_id else "root"},
        "runs": {rid: {"native_run_id": run.native_run_id, "parent_run_id": run.parent_run_id, "role": run.role, "models": list(run.models), "started_at": run.started_at, "ended_at": run.ended_at, "locations": list(run.locations)} for rid, run in runs.items()},
        "child_ids": {},
        "native_thread_ids": list(native_thread_ids),
        "turn_models": turn_models,
        "latest_model": latest_model,
        "observed_start": observed_start,
        "observed_end": observed_end,
        "repo_info": repo_info,
        "open_calls": {native: {"call_id": item["call_id"], "native": item["native"], "name": item["name"], "at": item["at"], "operation_hash": operation_hash(item.get("operation"), already_hashed=bool(item.get("operation_hashed"))), "operation_signature_hashed": True, "operation_summary": item.get("operation_summary") or (capture_operation_summary(host, item["name"], item.get("operation")) if item["name"] in {"Edit", "Write", "MultiEdit", "NotebookEdit"} else item["name"]), "requested_location": item.get("requested_location"), "pr_action": item.get("pr_action"), "source_ordinal": item.get("source_ordinal", 0), "block_ordinal": item.get("block_ordinal", 0)} for native, item in calls.items() if native not in results},
        "captured_at": captured_at,
    }
    if not host.snapshot_matches(fp):
        # Parsing happened outside the store lock. Keep the prior cursor when
        # the source was replaced or rewritten before this batch commits.
        from skill_hub.domain.usage.usage_inspection_capture import SourceChangedError
        raise SourceChangedError("source changed while parsing")
    prefix_hash, boundary_hash = host.hashes_for_commit(offset_end)
    source = SourceInput(source_id, "codex", session_id, generation, cursor.revision, offset_start, offset_end, fp, "incomplete" if partial else "active", CAPTURE_PARSER_VERSION, prefix_hash, boundary_hash, dump_resume_state(state_out), 1, READER_ID, READER_REVISION, NORMALIZATION_VERSION, evidence, None, repo_info.get("path"), observed_start=observed_start, observed_end=observed_end)
    resolution = RootResolution("codex", session_id, root_id, parent_id, "child" if parent_id else "root")
    ordered_runs = (runs[run_id], *(run for key, run in runs.items() if key != run_id))
    return CaptureBatch(1, captured_at, resolution, source, ordered_runs, tuple(samples), tuple(tools), tuple(events), tuple(relationships), tuple(changes), tuple(prs), tuple(messages), tuple(seeds))
