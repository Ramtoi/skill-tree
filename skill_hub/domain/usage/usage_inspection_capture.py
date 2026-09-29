"""Immutable records shared by Usage transcript adapters and the store.

The scanner adapters normalize harness records here.  Keeping this module
free of filesystem discovery makes malformed or unsupported input safe to
retain and easy to test.
"""
# ruff: noqa: E501
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Literal

SourceStatus = Literal["active", "replaced", "truncated", "unavailable", "incomplete"]
BodyStatus = Literal["available", "truncated", "external_file", "unsupported", "unavailable"]


class SourceChangedError(RuntimeError):
    """The source changed while a bounded capture read was in progress."""


@dataclass(frozen=True)
class SourceFingerprint:
    device: int | None
    inode: int | None
    size: int
    mtime_ns: int
    prefix_sha256: str
    boundary_sha256: str


@dataclass(frozen=True)
class SourceCursor:
    source_id: str
    generation_id: str
    revision: int
    offset: int
    fingerprint: SourceFingerprint
    committed_prefix_sha256: str = ""
    committed_boundary_sha256: str = ""
    resume_state: str = ""
    resume_version: int = 0
    reader_id: str = ""
    reader_revision: int = 0
    normalization_version: int = 0


@dataclass(frozen=True)
class ReaderBindingPolicy:
    """Versioned host policy for one transcript reader."""

    capture_contract_version: int
    host_contract_version: int
    reader_id: str
    reader_revision: int
    normalization_version: int
    resume_version: int
    capture_schema_version: int
    adapter_digest: str | None = None
    parser_version: int = 1

    def canonical_json(self) -> str:
        return json.dumps(
            {
                "adapter_digest": self.adapter_digest,
                "parser_version": self.parser_version,
                "capture_contract_version": self.capture_contract_version,
                "capture_schema_version": self.capture_schema_version,
                "host_contract_version": self.host_contract_version,
                "normalization_version": self.normalization_version,
                "reader_id": self.reader_id,
                "reader_revision": self.reader_revision,
                "resume_version": self.resume_version,
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def digest(self) -> str:
        return "policy:" + hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ReaderBindingSourceEvidence:
    """Bounded adapter recognition evidence, safe to retain with a source."""

    producer: str
    native_format: str
    format_fingerprint: str

    def canonical_json(self) -> str:
        return json.dumps(
            {
                "format_fingerprint": self.format_fingerprint,
                "native_format": self.native_format,
                "producer": self.producer,
            },
            sort_keys=True,
            separators=(",", ":"),
        )


@dataclass(frozen=True)
class ReaderBinding:
    """The immutable policy and source evidence committed with a capture."""

    policy: ReaderBindingPolicy
    source_evidence: ReaderBindingSourceEvidence

    def canonical_json(self) -> str:
        return json.dumps(
            {
                "policy": json.loads(self.policy.canonical_json()),
                "source_evidence": json.loads(self.source_evidence.canonical_json()),
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def digest(self) -> str:
        return "binding:" + hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CaptureSource:
    source_id: str
    harness: str
    source_session_id: str


@dataclass(frozen=True)
class SourceInput:
    source_id: str
    harness: str
    source_session_id: str
    generation_id: str
    expected_revision: int
    offset_start: int
    offset_end: int
    fingerprint: SourceFingerprint
    status: SourceStatus
    parser_version: int = 1
    committed_prefix_sha256: str = ""
    committed_boundary_sha256: str = ""
    resume_state: str = ""
    resume_version: int = 1
    reader_id: str = ""
    reader_revision: int = 1
    normalization_version: int = 1
    reader_source_evidence: ReaderBindingSourceEvidence | None = None
    reader_binding: ReaderBinding | None = None
    working_directory_hint: str | None = None
    project_key: str | None = None
    project_attribution: str = "unavailable"
    observed_start: str | None = None
    observed_end: str | None = None


@dataclass(frozen=True)
class RootResolution:
    harness: str
    source_session_id: str
    root_session_id: str
    parent_session_id: str | None
    state: Literal["root", "child", "orphan", "cycle"]


@dataclass(frozen=True)
class NativeRunRef:
    root_session_id: str
    native_id: str
    origin: Literal["source", "inline_sidechain"]


@dataclass(frozen=True)
class RunInput:
    run_id: str
    source_session_id: str
    native_run_id: str
    parent_run_id: str | None
    role: str | None
    models: tuple[str, ...]
    started_at: str | None
    ended_at: str | None
    locations: tuple[dict[str, str], ...] = ()
    # Native transcript facts are immutable observations.  They are kept
    # separate from derived active timing and token accounting.
    native_lines_added: int | None = None
    native_lines_removed: int | None = None
    native_duration_ms: int | None = None
    native_branch: str | None = None
    native_ref: NativeRunRef | None = None


@dataclass(frozen=True)
class TokenSampleInput:
    run_id: str
    sample_id: str
    model: str | None
    input: int
    output: int
    cache_creation: int
    cache_read: int
    cumulative: bool
    epoch_marker: bool
    at: str | None
    total: int | None = None
    origin: Literal["native", "event_mirror", "legacy"] = "legacy"
    native_sample_key: str | None = None
    source_ordinal: int = 0
    block_ordinal: int = 0
    role_ordinal: int = 0
    first_turn_input_total: int | None = None


@dataclass(frozen=True)
class BodyPartInput:
    part_id: str
    kind: str
    status: BodyStatus
    content_type: str
    bytes_value: bytes | None
    source_locator: str | None
    mirror_part_key: str | None = None


@dataclass(frozen=True)
class ToolCallInput:
    call_id: str
    run_id: str
    native_call_id: str
    at: str | None
    tool_name: str
    tool_kind: str
    operation_signature: str | None
    execution: str
    input_parts: tuple[BodyPartInput, ...]
    result_parts: tuple[BodyPartInput, ...]
    operation_summary: str | None = None
    operation_signature_hashed: bool = False
    source_ordinal: int = 0
    block_ordinal: int = 0
    role_ordinal: int = 0
    activity_class: str | None = None
    skill_key: str | None = None
    invocation_origin: str | None = None
    read_file_hash: str | None = None
    edit_file_hash: str | None = None
    mcp_server: str | None = None
    mcp_tool: str | None = None
    child_run_id: str | None = None


@dataclass(frozen=True)
class EventInput:
    event_id: str
    source_epoch: str
    source_record_id: str | None
    at: str | None
    kind: Literal["message", "tool_started", "tool_result", "task_started", "task_complete", "wait_started", "wait_result", "patch_apply_end", "pr_link"]
    payload_hash: str
    run_id: str | None = None
    correlation_id: str | None = None
    source_ordinal: int = 0
    block_ordinal: int = 0
    role_ordinal: int = 0


@dataclass(frozen=True)
class MessageInput:
    message_id: str
    run_id: str
    source_epoch: str
    source_ordinal: int
    block_ordinal: int
    role_ordinal: int
    at: str | None
    role: str
    kind: str
    text_len: int
    thinking_len: int
    is_steering: bool
    slash_command: str | None
    excerpt: str = ""
    first_turn_input_total: int | None = None
    stacked: bool = False
    interrupted: bool = False
    synthetic: bool = False
    native_kind: str | None = None
    excerpt_hint: str | None = None


@dataclass(frozen=True)
class SummaryEventSeedInput:
    event_id: str
    run_id: str
    source_epoch: str
    source_ordinal: int
    block_ordinal: int
    role_ordinal: int
    at: str | None
    kind: str
    name: str | None
    invoker: str | None
    correlation_id: str | None
    message_id: str | None = None
    model: str | None = None
    stacked: bool = False
    interrupted: bool = False
    additive: bool = False
    count: int = 1
    text_hint: str | None = None


@dataclass(frozen=True)
class RelationshipInput:
    relationship_id: str
    source_epoch: str
    source_event_id: str
    from_run_id: str
    to_run_id: str | None
    kind: Literal["spawn", "resume", "async_launch", "completion", "targeted_wait", "generic_wait"]
    at: str | None
    status: Literal["observed", "unavailable"]


@dataclass(frozen=True)
class ChangeInput:
    change_id: str
    run_id: str
    source_epoch: str
    source_event_id: str
    tool_call_id: str | None
    kind: Literal["session_edit", "tool_patch", "runtime_patch", "worktree_patch", "current_snapshot", "pr_change"]
    attribution: Literal["confirmed", "attempted", "captured", "current", "associated", "unavailable"]
    repository_id: str | None
    revision_id: str | None
    base_id: str | None
    merge_base_id: str | None
    files: tuple[str, ...]
    body_parts: tuple[BodyPartInput, ...]


@dataclass(frozen=True)
class PrInput:
    pr_id: str
    source_epoch: str
    source_event_id: str
    repository_id: str
    number: int
    url: str
    relationship: Literal["created", "changed", "reviewed", "associated"]
    evidenced_at: str | None


@dataclass(frozen=True)
class CaptureBatch:
    schema_version: Literal[1]
    captured_at: str
    root: RootResolution
    source: SourceInput
    runs: tuple[RunInput, ...] = ()
    token_samples: tuple[TokenSampleInput, ...] = ()
    tool_calls: tuple[ToolCallInput, ...] = ()
    events: tuple[EventInput, ...] = ()
    relationships: tuple[RelationshipInput, ...] = ()
    changes: tuple[ChangeInput, ...] = ()
    prs: tuple[PrInput, ...] = ()
    messages: tuple[MessageInput, ...] = ()
    event_seeds: tuple[SummaryEventSeedInput, ...] = ()


@dataclass(frozen=True)
class MergeResult:
    outcome: Literal["captured", "unchanged", "retry_required", "incomplete"]
    canonical_revision: int
    root_session_id: str
    committed_cursor: SourceCursor
    errors: tuple[str, ...] = ()
    bytes_read: int = 0


def stable_id(*parts: object) -> str:
    """Return an opaque stable identity for normalized immutable fields."""
    encoded = "\x1f".join(json.dumps(part, sort_keys=True, separators=(",", ":")) for part in parts)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def body_identity(value: bytes) -> str:
    return "body:" + hashlib.sha256(value).hexdigest()


RESUME_STATE_VERSION = 1


def new_resume_state(reader_id: str, reader_revision: int, normalization_version: int) -> dict:
    """Return an empty v1 resume state for a source with no prior generation."""
    return {
        "version": RESUME_STATE_VERSION,
        "reader": {"id": reader_id, "revision": reader_revision},
        "normalization_version": normalization_version,
        "record_ordinal": 0,
        "session": {},
        "runs": {},
        "child_ids": {},
        "repo_info": {},
        "open_calls": {},
        "extra": {},
        "captured_at": "",
    }


def load_resume_state(cursor: SourceCursor, *, reader_id: str, reader_revision: int, normalization_version: int) -> dict | None:
    """Return the decoded resume state, or None when a full reparse is required.

    None on a version/reader/normalization mismatch, missing state, or a
    malformed payload -- the caller then reparses the whole source once and
    the fingerprint skip applies again afterwards (BRIEF.md §3).
    """
    if not cursor.resume_state or cursor.resume_version != RESUME_STATE_VERSION:
        return None
    if cursor.reader_id != reader_id or cursor.reader_revision != reader_revision:
        return None
    if cursor.normalization_version != normalization_version:
        return None
    try:
        state = json.loads(cursor.resume_state)
    except ValueError:
        return None
    if not isinstance(state, dict) or state.get("version") != RESUME_STATE_VERSION:
        return None
    return state


def dump_resume_state(state: dict) -> str:
    return json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


RetentionTier = Literal["A", "B"]
TIER_B_INPUT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"})
TIER_A_INPUT_BODY_LIMIT = 16384
OPERATION_SUMMARY_LIMIT = 200
_OPERATION_HASH_RE = re.compile(r"^op:[0-9a-f]{64}$")


def retention_tier(tool_name: str, side: str, kind: str) -> RetentionTier:
    """Classify one part for the accepted retention tiers (PLAN.md C2).

    Tier A (durable): request-shaped tool inputs. Tier B (prunable): every
    result, every Edit/Write-family input (reproducible from git), and every
    attachment/change part. Unknown/unsupported records stay tier B.
    """
    if side == "result":
        return "B"
    if kind in ("persisted_output_attachment",):
        return "B"
    if side == "input" and tool_name in TIER_B_INPUT_TOOLS:
        return "B"
    if kind == "unsupported":
        return "B"
    if side == "input" and kind == "invocation":
        return "A"
    return "B"


def bounded_body(part: BodyPartInput, *, limit: int = TIER_A_INPUT_BODY_LIMIT) -> BodyPartInput:
    """Cap a tier-A input body, marking it truncated when it exceeds `limit`."""
    if part.bytes_value is None or len(part.bytes_value) <= limit:
        return part
    return BodyPartInput(part.part_id, part.kind, "truncated", part.content_type, part.bytes_value[:limit], part.source_locator, part.mirror_part_key)


def operation_hash(operation_json: str | None, *, already_hashed: bool = False) -> str | None:
    """Return the public operation signature: a hash over the full canonical invocation.

    Identity (`call_id`) is computed from the same `operation_json` before
    this hash is taken, so re-keying never happens here.
    """
    if operation_json is None:
        return None
    if already_hashed:
        if not _OPERATION_HASH_RE.fullmatch(operation_json):
            raise ValueError("invalid prehashed operation signature")
        return operation_json
    return "op:" + hashlib.sha256(operation_json.encode("utf-8")).hexdigest()


def json_body(part_id: str, kind: str, value: object, *, status: BodyStatus = "available") -> BodyPartInput:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return BodyPartInput(part_id, kind, status, "application/json", data, None)


def text_body(part_id: str, kind: str, value: str | bytes, *, status: BodyStatus = "available") -> BodyPartInput:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return BodyPartInput(part_id, kind, status, "text/plain", data, None)
