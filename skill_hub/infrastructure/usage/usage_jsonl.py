"""Bounded, replacement-safe framing for Usage JSONL sources.

The host owns byte limits and source snapshots.  Readers use the same decoder
for complete captures and bounded recognition probes so malformed and
non-object frames have one observable interpretation.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any


class JsonlDeadlineError(TimeoutError):
    """The framing budget expired while walking a JSONL payload."""


class JsonlFramingDeadlineError(JsonlDeadlineError):
    """The shared framing pass expired before an optional decoder ran."""


@dataclass(frozen=True)
class JsonlFrame:
    text: str
    start: int
    end: int
    complete: bool


_LINE_BREAK = re.compile(rb"\r\n|[\n\r\v\f\x1c-\x1e]|\xc2\x85|\xe2\x80[\xa8\xa9]")


def _check_deadline(deadline: float | None) -> None:
    if deadline is not None and time.monotonic() >= deadline:
        raise JsonlFramingDeadlineError("source budget exceeded")


def _frame_bounds(raw: bytes, deadline: float | None) -> Iterator[tuple[int, int, int, bool]]:
    """Find splitlines separators at valid UTF-8 boundaries.

    A separator starts with ASCII or a UTF-8 leading byte, never a continuation
    byte. Replacement decoding therefore cannot create or hide a separator.
    Keep offsets only for the current frame, without a per-character table.
    """
    start = 0
    _check_deadline(deadline)
    for match in _LINE_BREAK.finditer(raw):
        _check_deadline(deadline)
        yield start, match.start(), match.end(), True
        start = match.end()
    _check_deadline(deadline)
    if start < len(raw):
        yield start, len(raw), len(raw), False


def iter_jsonl_frames(
    raw: bytes,
    *,
    deadline: float | None = None,
) -> Iterator[JsonlFrame]:
    """Yield splitlines frames with their safe raw byte boundaries."""

    for start, body_end, end, complete in _frame_bounds(raw, deadline):
        text = raw[start:body_end].decode("utf-8", errors="replace")
        _check_deadline(deadline)
        yield JsonlFrame(text, start, end, complete)


def iter_jsonl_lines(
    raw: bytes,
    *,
    deadline: float | None = None,
    max_records: int | None = None,
) -> Iterator[str]:
    """Yield complete text frames with the legacy replacement semantics.

    ``str.splitlines`` remains the framing authority after UTF-8 replacement.
    A frame count is applied before JSON decoding, so invalid and non-object
    frames consume the same probe budget as valid records.
    """

    for index, frame in enumerate(iter_jsonl_frames(raw, deadline=deadline)):
        if max_records is not None and index >= max_records:
            return
        yield frame.text


def decode_jsonl_records(
    raw: bytes,
    *,
    deadline: float | None = None,
    max_records: int | None = None,
) -> tuple[dict[str, Any], ...]:
    """Decode object frames, ignoring malformed and non-object JSON values."""

    records: list[dict[str, Any]] = []
    for line in iter_jsonl_lines(raw, deadline=deadline, max_records=max_records):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        _check_deadline(deadline)
        if isinstance(value, dict):
            records.append(value)
    return tuple(records)


def complete_jsonl_prefix(
    raw: bytes,
    *,
    max_records: int = 32,
    deadline: float | None = None,
) -> tuple[bytes, str, int]:
    """Return the safe byte prefix and frame count for a bounded probe.

    Keeping the byte boundary at a ``splitlines`` separator means a probe
    never hands a reader a truncated UTF-8/JSON frame. The same separator
    rules are used for decoding the resulting prefix.
    """

    if max_records <= 0:
        return b"", "record_limit", 0
    end = 0
    count = 0
    saw_partial = False
    for _, _, frame_end, complete in _frame_bounds(raw, deadline):
        if not complete:
            saw_partial = True
            break
        count += 1
        end = frame_end
        if count >= max_records:
            return raw[:end], "record_limit", count
    if saw_partial:
        return raw[:end], "partial_tail", count
    return raw[:end], "eof", count


__all__ = [
    "JsonlDeadlineError",
    "JsonlFramingDeadlineError",
    "JsonlFrame",
    "complete_jsonl_prefix",
    "decode_jsonl_records",
    "iter_jsonl_frames",
    "iter_jsonl_lines",
]
