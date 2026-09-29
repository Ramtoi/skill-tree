"""Claude Code JSONL to normalized retained inspection evidence."""
# ruff: noqa: E501
from __future__ import annotations

import hashlib
import json
import re
import shlex
import time
from dataclasses import replace
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
    NativeRunRef,
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
    capture_attachment,
    capture_revision_patch,
    hashes_for_commit,
    read_complete_suffix,
    snapshot_fingerprint_matches,
    source_fingerprint,
)
from skill_hub.infrastructure.usage.usage_capture_summary import with_operation_summary_v1
from skill_hub.infrastructure.usage.usage_reader_context import SourceBoundCaptureHost


def _body_id(*parts: object) -> str:
    return "body:" + stable_id(*parts)


def _epoch(path: Path, cursor: SourceCursor, fingerprint, host: CaptureHost | None = None) -> str:
    return source_generation(
        path,
        cursor,
        fingerprint,
        lambda: host.append_proven(cursor) if host is not None else append_proven(path, cursor),
    )


READER_ID = "usage_inspection_claude"
READER_REVISION = 8
NORMALIZATION_VERSION = 1
CAPTURE_CONTRACT_VERSION = 1


def reader_source_evidence(records: list[dict]) -> ReaderBindingSourceEvidence:
    recognized = any(isinstance(record.get("sessionId"), str) or isinstance(record.get("message"), dict) for record in records)
    return _source_evidence(recognized)


def _source_evidence(recognized: bool) -> ReaderBindingSourceEvidence:
    return ReaderBindingSourceEvidence(
        producer="claude-code" if recognized else "unknown_legacy",
        native_format="claude-jsonl" if recognized else "unknown_legacy",
        format_fingerprint=stable_id("claude-code", "jsonl", "v1") if recognized else stable_id("unknown_legacy", "v1"),
    )


def recognize_source(probe: SourceProbe) -> SourceRecognition:
    """Recognize Claude JSONL from Claude-specific record structure only."""

    recognized = any(
        isinstance(record.get("sessionId"), str) or isinstance(record.get("message"), dict)
        for record in probe.records
    )
    legacy_eligible = any(
        (
            isinstance(record.get("type"), str)
            and record.get("type") in {"user", "assistant", "system", "summary"}
            and (
                isinstance(record.get("content"), (str, list))
                or isinstance(record.get("message"), (str, dict))
            )
        )
        or (
            record.get("type") == "cost-state"
            and any(
                isinstance(record.get(field), (int, float))
                and not isinstance(record.get(field), bool)
                for field in ("totalLinesAdded", "totalLinesRemoved", "totalDuration")
            )
        )
        for record in probe.records
    )
    complete = probe.stop_reason == "eof"
    return SourceRecognition(
        "claude-code" if recognized else None,
        None,
        "claude-jsonl" if recognized else None,
        stable_id("claude-code", "jsonl", "v1") if recognized else None,
        "complete" if complete else "partial",
        "recognized" if recognized else "legacy_eligible" if legacy_eligible else "inconclusive",
    )


def _safe_native_label(raw: str, limit: int) -> str | None:
    """Keep branch labels safe for verbatim cache/frontend rendering."""
    value = raw[:4096].strip()
    if not value or any(ord(char) < 32 for char in value) or "\\" in value:
        return None
    lowered = value.lower()
    if re.search(r"(?:~/|/(?:users|home|workspace|projects|tmp|var|private)/|[a-z]:[\\/])", lowered):
        return None
    return value[:limit].strip() or None


def _safe_native_id(raw: object) -> str | None:
    if not isinstance(raw, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,119}", raw):
        return None
    return raw


def _mirror_key(record_id: object, block_index: int, role: str) -> str | None:
    if not isinstance(record_id, str) or not record_id:
        return None
    return "mirror:" + stable_id(record_id, block_index, role)


def capture_claude_source(
    path: Path | ReaderSource,
    cursor: SourceCursor | None = None,
    host: CaptureHost | None = None,
    *,
    deadline: float | None = None,
) -> CaptureBatch:
    """Parse a complete source file. Reads are intentionally outside any lock."""
    if isinstance(path, ReaderSource):
        reader_source: ReaderSource | None = path
        source_path = Path(path.lexical_path)
    else:
        reader_source = None
        source_path = path
    session_hint = reader_source.source_session_id if reader_source is not None else source_path.stem
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
    source_id_hint = reader_source.source_id if reader_source is not None else "claude-code:" + hashlib.sha256(str(source_path).encode()).hexdigest()
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
    generation = _epoch(source_path, cursor, fp, host)
    source_id = source_id_hint
    session_id = session_hint or source_path.stem
    root_session_id = session_id
    parent_session_id = None
    child_directory = next((parent for parent in source_path.parents if parent.name == "subagents"), None)
    if child_directory is not None:
        parent_session_id = child_directory.parent.name
        root_session_id = parent_session_id
    records = list(capture_records(host, raw, fp, offset_start, deadline=deadline))
    calls: dict[str, dict] = {}
    existing_calls: set[str] = set()
    if state is not None:
        for native, value in (state.get("open_calls") or {}).items():
            if isinstance(value, dict):
                calls[str(native)] = {**value, "input": None, "operation": value.get("operation_hash"), "operation_hashed": bool(value.get("operation_signature_hashed")), "operation_summary": value.get("operation_summary")}
                existing_calls.add(str(native))
    tools: list[ToolCallInput] = []
    samples: list[TokenSampleInput] = []
    events: list[EventInput] = []
    messages: list[MessageInput] = []
    seeds: list[SummaryEventSeedInput] = []
    relationships: list[RelationshipInput] = []
    main_run_id = stable_id("claude-code", session_id, session_id)
    parent_run_id = stable_id("claude-code", parent_session_id, parent_session_id) if parent_session_id else None
    source_native_id = session_id.removeprefix("agent-") if parent_session_id and session_id.startswith("agent-") else ""
    source_native_id = _safe_native_id(source_native_id) or ""
    source_ref = NativeRunRef(root_session_id, source_native_id, "source") if parent_session_id and source_native_id else None
    runs = {
        main_run_id: RunInput(
            main_run_id, session_id, session_id, parent_run_id,
            "agent" if parent_session_id else None, (), None, None, native_ref=source_ref,
        )
    }
    child_ids: dict[str, str] = {session_id: main_run_id} if parent_session_id else {}
    if state is not None:
        child_ids.update({str(key): str(value) for key, value in (state.get("child_ids") or {}).items()})
        for rid, value in (state.get("runs") or {}).items():
            if not isinstance(value, dict) or rid == main_run_id:
                continue
            ref_value = value.get("native_ref")
            ref = NativeRunRef(str(ref_value["root_session_id"]), str(ref_value["native_id"]), ref_value["origin"]) if isinstance(ref_value, dict) and ref_value.get("origin") in {"source", "inline_sidechain"} else None
            runs[str(rid)] = RunInput(str(rid), str(value.get("source_session_id") or ""), str(value.get("native_run_id") or ""), value.get("parent_run_id"), value.get("role"), tuple(value.get("models") or ()), value.get("started_at"), value.get("ended_at"), tuple(value.get("locations") or ()), native_ref=ref)
    results: dict[str, list[BodyPartInput]] = {}
    prs: list[PrInput] = []
    changes: list[ChangeInput] = []
    repo_info: dict[str, str] = {}
    native_facts: dict[str, dict[str, Any]] = {}
    if state is not None:
            for rid, value in (state.get("native_facts") or {}).items():
                if isinstance(value, dict):
                    native_facts[str(rid)] = dict(value)
    acknowledged_calls: set[str] = set()
    record_base = int(state.get("record_ordinal", 0)) if state is not None else 0
    first_turn_seen = {str(value) for value in (state.get("first_turn_runs") or [])} if state is not None else set()
    for relative_ordinal, record in enumerate(records):
        if deadline is not None and time.monotonic() > deadline:
            raise TimeoutError("source budget exceeded")
        ordinal = record_base + relative_ordinal
        at = record.get("timestamp") if isinstance(record.get("timestamp"), str) else None
        raw_type = str(record.get("type") or "")
        is_side = bool(record.get("isSidechain"))
        agent = record.get("agentId") if isinstance(record.get("agentId"), str) else None
        for key in ("cwd", "repository", "repo", "worktree"):
            if isinstance(record.get(key), str):
                repo_info["path"] = record[key]
        for key in ("revision", "revision_id", "head", "commit"):
            if isinstance(record.get(key), str):
                repo_info["revision"] = record[key]
        for key in ("base", "base_id", "base_commit"):
            if isinstance(record.get(key), str):
                repo_info["base"] = record[key]
        for key in ("merge_base", "merge_base_id"):
            if isinstance(record.get(key), str):
                repo_info["merge_base"] = record[key]
        run_id = main_run_id
        if is_side and agent:
            run_id = child_ids.setdefault(agent, main_run_id if parent_session_id else stable_id("claude-code", agent, agent))
            child = runs.get(run_id)
            if child is None:
                safe_agent = _safe_native_id(agent)
                runs[run_id] = RunInput(run_id, agent, agent, main_run_id, "agent", (), at, at, native_ref=NativeRunRef(root_session_id, safe_agent, "inline_sidechain") if safe_agent else None)
        facts = native_facts.setdefault(run_id, {})
        if isinstance(record.get("gitBranch"), str) and (safe_native_label := _safe_native_label(record["gitBranch"], 120)):
            facts["branch"] = safe_native_label
        if record.get("type") == "cost-state":
            for key, target in (("totalLinesAdded", "lines_added"), ("totalLinesRemoved", "lines_removed"), ("totalDuration", "duration_ms")):
                value = record.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    facts[target] = value
        if record.get("type") == "pr-link" and isinstance(record.get("prUrl"), str) and not any(char.isspace() for char in record["prUrl"]) and isinstance(record.get("prNumber"), int) and not isinstance(record.get("prNumber"), bool) and record.get("prNumber", 0) > 0:
            url = record["prUrl"]
            if url.startswith("https://"):
                repo = cast(str, record.get("prRepository")) if isinstance(record.get("prRepository"), str) else "unknown"
                prs.append(PrInput("pr:" + stable_id(repo, record["prNumber"], "associated", record.get("uuid")), generation, "event:" + stable_id(generation, record.get("uuid"), "pr"), repo, record["prNumber"], url, cast(Any, "associated"), at))
                unavailable = BodyPartInput(_body_id(generation, record.get("uuid"), "pr-change"), "pr_change", "unavailable", "text/x-diff", None, None)
                changes.append(ChangeInput("change:" + stable_id(generation, record.get("uuid"), "pr-change"), run_id, generation, "event:" + stable_id(generation, record.get("uuid"), "pr"), None, "pr_change", "associated", repo, None, None, None, (), (unavailable,)))
            continue
        msg = record.get("message")
        if raw_type == "user" and isinstance(msg, dict):
            content = msg.get("content")
            blocks = content if isinstance(content, list) else ()
            first = blocks[0] if blocks and isinstance(blocks[0], dict) else {}
            is_result = (
                "toolUseResult" in record
                or first.get("type") == "tool_result"
                or any(isinstance(block, dict) and block.get("tool_use_id") for block in blocks)
            )
            if isinstance(content, str):
                text = "" if record.get("isMeta") in (True, "true") else content
            elif not is_result and not (record.get("isMeta") in (True, "true") and len(blocks) == 1):
                text = first.get("text", "") if first.get("type") == "text" and isinstance(first.get("text"), str) else ""
            else:
                text = ""
            local_echo = text.startswith("<local-command-stdout>") or text.startswith("<local-command-caveat>")
            is_image = first.get("type") == "image"
            if (text or is_image) and not local_echo and not is_result:
                command = re.search(r"<command-name>(.*?)</command-name>", text, re.DOTALL) if isinstance(content, str) else None
                command_name = command.group(1).strip().lstrip("/") if command else None
                message_id = "message:" + stable_id(generation, ordinal, "user")
                interrupted = text.startswith("[Request interrupted by user")
                messages.append(MessageInput(message_id, run_id, generation, ordinal, 0, 0, at, "user", "slash_command" if command_name else "human_turn", len(text), 0, False, command_name, stacked=bool(record.get("stackedExpansion")), interrupted=interrupted, native_kind=raw_type, excerpt_hint=text))
                seeds.append(SummaryEventSeedInput("seed:" + stable_id(generation, ordinal, "user"), run_id, generation, ordinal, 0, 0, at, "slash_command" if command_name else "human_turn", command_name, "you", None, message_id, stacked=bool(record.get("stackedExpansion")), interrupted=interrupted))
                if command_name == "compact":
                    seeds.append(SummaryEventSeedInput("seed:" + stable_id(generation, ordinal, "compaction"), run_id, generation, ordinal, 0, 1, at, "compaction", None, "you", None, message_id))
        if not isinstance(msg, dict):
            continue
        model = msg.get("model") if isinstance(msg.get("model"), str) else None
        usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else None
        if usage is not None:
            sample_key = msg.get("id") if isinstance(msg.get("id"), str) else record.get("uuid")
            if isinstance(msg.get("id"), str):
                native_sample_key = "message:" + msg["id"]
            elif isinstance(record.get("uuid"), str):
                native_sample_key = "record:" + record["uuid"]
            else:
                native_sample_key = "ordinal:" + str(ordinal)
            samples.append(TokenSampleInput(run_id, stable_id("claude-sample", run_id, sample_key), model, int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0), int(usage.get("cache_creation_input_tokens") or 0), int(usage.get("cache_read_input_tokens") or 0), False, False, at, native_sample_key=native_sample_key, source_ordinal=ordinal, block_ordinal=0, role_ordinal=0))
            previous = runs[run_id]
            models = tuple(sorted(set(previous.models) | ({model} if model else set())))
            if previous.started_at is None or (at and at < previous.started_at):
                started = at
            else:
                started = previous.started_at
            runs[run_id] = replace(previous, models=models, started_at=started, ended_at=at or previous.ended_at)
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        text_len = sum(len(block.get("text", "")) for block in content if isinstance(block, dict) and isinstance(block.get("text"), str))
        thinking_len = sum(len(block.get("thinking", "")) for block in content if isinstance(block, dict) and isinstance(block.get("thinking"), str))
        if msg.get("role") == "assistant":
            first_turn = (int(usage.get("input_tokens") or 0) + int(usage.get("cache_creation_input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0)) if usage and model != "<synthetic>" else None
            if first_turn is not None:
                first_turn_seen.add(run_id)
            messages.append(MessageInput("message:" + stable_id(generation, ordinal, msg.get("id") or ordinal), run_id, generation, ordinal, 0, 1, at, "assistant", "assistant", text_len, thinking_len, False, None, first_turn_input_total=first_turn, synthetic=model == "<synthetic>", native_kind=raw_type))
        for block_index, block in enumerate(content):
            if not isinstance(block, dict):
                continue
            typ = block.get("type")
            if typ == "tool_use" and isinstance(block.get("id"), str):
                native = block["id"]
                name = str(block.get("name") or "unknown")
                invocation = block.get("input")
                operation = json.dumps(invocation, ensure_ascii=False, sort_keys=True, separators=(",", ":")) if invocation is not None else None
                call_id = "call:" + stable_id(run_id, native, name, operation or "")
                mirror_key = _mirror_key(record.get("uuid"), block_index, "input")
                input_part = json_body(_body_id(call_id, "input"), "invocation", invocation) if invocation is not None else BodyPartInput(_body_id(call_id, "input"), "invocation", "unavailable", "application/json", None, None, mirror_key)
                if mirror_key and input_part.mirror_part_key is None:
                    input_part = replace(input_part, mirror_part_key=mirror_key)
                calls[native] = {"call_id": call_id, "run_id": run_id, "name": name, "operation": operation, "at": at, "input": input_part, "source_ordinal": ordinal, "block_ordinal": block_index}
                if name == "Agent" and isinstance(invocation, dict):
                    calls[native]["child_type"] = _safe_native_id(invocation.get("subagent_type"))
                if name in {"Edit", "Write", "MultiEdit", "NotebookEdit"} and isinstance(invocation, dict):
                    file_path = invocation.get("file_path") or invocation.get("path")
                    if isinstance(file_path, str):
                        calls[native]["files"] = [file_path]
                if name in {"Bash", "bash"} and isinstance(invocation, dict):
                    command = invocation.get("command")
                    argv = shlex.split(command) if isinstance(command, str) and not re.search(r"[;&|<>$`]", command) else []
                    calls[native]["pr_action"] = argv[2] if len(argv) > 2 and argv[:2] == ["gh", "pr"] else None
                    if "--repo" in argv:
                        repo_index = argv.index("--repo")
                        if repo_index + 1 < len(argv):
                            calls[native]["pr_repository"] = argv[repo_index + 1]
                events.append(EventInput("event:" + stable_id(generation, record.get("uuid"), native, "start"), generation, str(record.get("uuid")) if record.get("uuid") else None, at, "tool_started", stable_id(block), run_id, native, ordinal, block_index, 0))
            elif typ == "tool_result" and isinstance(block.get("tool_use_id"), str):
                native = block["tool_use_id"]
                matching = calls.get(native)
                if matching is None:
                    continue
                value = block.get("content")
                mirror_key = _mirror_key(record.get("uuid"), block_index, "result")
                result_part = json_body(_body_id(matching["call_id"], "content"), "tool_result_content", value) if not isinstance(value, str) else text_body(_body_id(matching["call_id"], "content"), "tool_result_content", value)
                if mirror_key:
                    result_part = replace(result_part, mirror_part_key=mirror_key)
                parts = [result_part]
                meta = record.get("toolUseResult")
                if isinstance(meta, dict):
                    matching["result_meta"] = meta
                    if isinstance(meta.get("agentId"), str):
                        acknowledged_calls.add(native)
                        child_run = child_ids.setdefault(meta["agentId"], stable_id("claude-code", meta["agentId"], meta["agentId"]))
                        matching["child_run_id"] = child_run
                        safe_agent = _safe_native_id(meta["agentId"])
                        runs.setdefault(child_run, RunInput(child_run, meta["agentId"], meta["agentId"], main_run_id, "agent", (), at, None, native_ref=NativeRunRef(root_session_id, safe_agent, "inline_sidechain") if safe_agent else None))
                        relationships.append(RelationshipInput("relationship:" + stable_id(generation, ordinal, native, "async"), generation, "event:" + stable_id(generation, record.get("uuid"), native, "result"), run_id, child_run, "async_launch", at, "observed"))
                        seeds.append(SummaryEventSeedInput(
                            "seed:" + stable_id(generation, ordinal, native, "subagent"), run_id, generation,
                            ordinal, block_index, 1, at, "subagent", matching.get("child_type"), "model", native,
                            model=_safe_native_id(meta.get("resolvedModel")),
                        ))
                    meta_part = json_body(_body_id(matching["call_id"], "meta"), "tool_use_result", meta)
                    meta_key = _mirror_key(record.get("uuid"), block_index, "meta")
                    parts.append(replace(meta_part, mirror_part_key=meta_key) if meta_key else meta_part)
                    attachment = meta.get("persistedOutputPath")
                    if isinstance(attachment, str):
                        if hasattr(host, "capture_attachment"):
                            attachment_part = host.capture_attachment(attachment)
                        else:
                            session_root = source_path.parent.parent if parent_session_id else source_path.parent / session_id
                            attachment_part = capture_attachment(Path(attachment), session_root / "tool-results", locator=attachment)
                        attachment_key = _mirror_key(record.get("uuid"), block_index, "attachment")
                        parts.append(replace(attachment_part, mirror_part_key=attachment_key) if attachment_key else attachment_part)
                results[native] = parts
                events.append(EventInput("event:" + stable_id(generation, record.get("uuid"), native, "result"), generation, str(record.get("uuid")) if record.get("uuid") else None, at, "tool_result", stable_id(block), run_id, native, ordinal, block_index, 0))
    for value in calls.values():
        native = next((key for key, item in calls.items() if item is value), "")
        result_parts = tuple(results.get(native, ()))
        execution = "acknowledged" if native in acknowledged_calls else ("completed" if native in results else "pending")
        if isinstance(value.get("result_meta"), dict) and (value["result_meta"].get("is_error") is True or value["result_meta"].get("exit_code") not in (None, 0)):
            execution = "failed"
        if incremental and native in existing_calls and not result_parts:
            continue
        input_parts = (value["input"],) if value.get("input") is not None else ()
        raw_operation = value["operation"]
        tools.append(ToolCallInput(value["call_id"], value["run_id"], native, value["at"], value["name"], "local", operation_hash(raw_operation, already_hashed=bool(value.get("operation_hashed"))), execution, input_parts, result_parts, value.get("operation_summary") or capture_operation_summary(host, value["name"], raw_operation), True, int(value.get("source_ordinal", 0)), int(value.get("block_ordinal", 0)), 0, child_run_id=value.get("child_run_id")))
        if value["name"] in {"Edit", "Write", "MultiEdit", "NotebookEdit"}:
            stored_files = value.get("files")
            files: tuple[str, ...] = tuple(item for item in stored_files if isinstance(item, str)) if isinstance(stored_files, list) else ()
            try:
                invocation = json.loads(value["input"].bytes_value or b"{}") if value.get("input") is not None else {}
                candidate = invocation.get("file_path") or invocation.get("path") if isinstance(invocation, dict) else None
                files = (candidate,) if isinstance(candidate, str) else files
            except (ValueError, TypeError):
                pass
            result_meta = value.get("result_meta")
            failed = isinstance(result_meta, dict) and (result_meta.get("is_error") is True or result_meta.get("exit_code") not in (None, 0))
            attribution = cast(Any, "attempted" if failed or not result_parts else "confirmed")
            change_parts = ((value["input"],) if value.get("input") is not None else ()) + result_parts
            changes.append(ChangeInput("change:" + stable_id(value["call_id"], "tool_patch"), value["run_id"], generation, "event:" + stable_id(generation, native, "change"), value["call_id"], "tool_patch", attribution, None, None, None, None, files, change_parts))
        if value["name"] in {"Bash", "bash"} and result_parts:
            try:
                meta = value.get("result_meta")
                if isinstance(meta, dict) and (meta.get("is_error") is True or meta.get("exit_code") not in (None, 0)):
                    continue
                if value.get("input") is None:
                    action = value.get("pr_action")
                    requested_repo = value.get("pr_repository")
                    argv = []
                else:
                    invocation = json.loads(value["input"].bytes_value or b"{}")
                    command = invocation.get("command") if isinstance(invocation, dict) else None
                    argv = shlex.split(command) if isinstance(command, str) and not re.search(r"[;&|<>$`]", command) else []
                    action = argv[2] if len(argv) > 2 and argv[:2] == ["gh", "pr"] else None
                    requested_repo = None
                    if "--repo" in argv:
                        repo_index = argv.index("--repo")
                        if repo_index + 1 < len(argv):
                            requested_repo = argv[repo_index + 1]
                if action in {"create", "edit", "review"}:
                    output = b"\n".join(part.bytes_value or b"" for part in result_parts)
                    match = re.search(rb"https://github\.com/([^/]+/[^/]+)/pull/(\d+)", output)
                    if match:
                        repo = match.group(1).decode("utf-8", "replace")
                        if requested_repo and requested_repo != repo:
                            continue
                        number = int(match.group(2))
                        relation = cast(Any, {"create": "created", "edit": "changed", "review": "reviewed"}[action])
                        prs.append(PrInput("pr:" + stable_id(repo, number, relation, native), generation, "event:" + stable_id(generation, native, action), repo, number, match.group(0).decode(), relation, value["at"]))
                        unavailable = BodyPartInput(_body_id(generation, native, "pr-change"), "pr_change", "unavailable", "text/x-diff", None, None)
                        changes.append(ChangeInput("change:" + stable_id(generation, native, "pr-change"), value["run_id"], generation, "event:" + stable_id(generation, native, action), value["call_id"], "pr_change", "associated", repo, None, None, None, (), (unavailable,)))
            except (ValueError, TypeError):
                pass
    if repo_info.get("path") and repo_info.get("revision") and repo_info.get("base"):
        if hasattr(host, "capture_revision_patch"):
            changes.append(host.capture_revision_patch(repo_info["path"], run_id=main_run_id, source_epoch=generation, source_event_id="event:" + stable_id(generation, "revision"), repository_id=repo_info["path"], revision_id=repo_info["revision"], base_id=repo_info["base"], merge_base_id=repo_info.get("merge_base"), deadline=deadline))
        else:
            changes.append(capture_revision_patch(Path(repo_info["path"]), run_id=main_run_id, source_epoch=generation, source_event_id="event:" + stable_id(generation, "revision"), repository_id=repo_info["path"], revision_id=repo_info["revision"], base_id=repo_info["base"], merge_base_id=repo_info.get("merge_base"), deadline=deadline))
    # Attach native observations to each run.  The final cost-state record is
    # authoritative, while tool counts remain additive across incremental
    # suffixes through the resume state's ordinal replay.
    for rid, run in list(runs.items()):
        facts = native_facts.get(rid, {})
        runs[rid] = RunInput(
            run.run_id, run.source_session_id, run.native_run_id, run.parent_run_id,
            run.role, run.models, run.started_at, run.ended_at, run.locations,
            native_lines_added=facts.get("lines_added") if isinstance(facts.get("lines_added"), int) else None,
            native_lines_removed=facts.get("lines_removed") if isinstance(facts.get("lines_removed"), int) else None,
            native_duration_ms=facts.get("duration_ms") if isinstance(facts.get("duration_ms"), int) else None,
            native_branch=facts.get("branch") if isinstance(facts.get("branch"), str) else None,
            native_ref=run.native_ref,
        )
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
        "first_turn_runs": sorted(first_turn_seen),
        "session": {"source_session_id": session_id, "root_session_id": root_session_id, "parent_session_id": parent_session_id, "state": "child" if parent_session_id else "root"},
        "runs": {rid: {"source_session_id": run.source_session_id, "native_run_id": run.native_run_id, "parent_run_id": run.parent_run_id, "role": run.role, "models": list(run.models), "started_at": run.started_at, "ended_at": run.ended_at, "locations": list(run.locations), "native_ref": ({"root_session_id": run.native_ref.root_session_id, "native_id": run.native_ref.native_id, "origin": run.native_ref.origin} if run.native_ref else None)} for rid, run in runs.items()},
        "child_ids": child_ids,
        "repo_info": repo_info,
        "native_facts": native_facts,
        "open_calls": {native: {"call_id": item["call_id"], "run_id": item["run_id"], "name": item["name"], "at": item["at"], "operation_hash": operation_hash(item.get("operation"), already_hashed=bool(item.get("operation_hashed"))), "operation_signature_hashed": True, "operation_summary": item.get("operation_summary") or capture_operation_summary(host, item["name"], item.get("operation")), "child_type": item.get("child_type"), "child_run_id": item.get("child_run_id"), "files": item.get("files"), "pr_action": item.get("pr_action"), "pr_repository": item.get("pr_repository"), "source_ordinal": item.get("source_ordinal", 0), "block_ordinal": item.get("block_ordinal", 0)} for native, item in calls.items() if native not in results},
        "captured_at": captured_at,
    }
    if not host.snapshot_matches(fp):
        # Parsing happened outside the store lock. Keep the prior cursor when
        # the source was replaced or rewritten before this batch commits.
        from skill_hub.domain.usage.usage_inspection_capture import SourceChangedError
        raise SourceChangedError("source changed while parsing")
    prefix_hash, boundary_hash = host.hashes_for_commit(offset_end)
    source = SourceInput(source_id, "claude-code", session_id, generation, cursor.revision, offset_start, offset_end, fp, "incomplete" if partial else "active", 1, prefix_hash, boundary_hash, dump_resume_state(state_out), 1, READER_ID, READER_REVISION, NORMALIZATION_VERSION, evidence, None, repo_info.get("path"))
    root = RootResolution("claude-code", session_id, root_session_id, parent_session_id, "child" if parent_session_id else "root")
    return CaptureBatch(1, captured_at, root, source, tuple(runs.values()), tuple(samples), tuple(tools), tuple(events), tuple(relationships), tuple(changes), tuple(prs), tuple(messages), tuple(seeds))
