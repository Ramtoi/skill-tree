"""Host-owned operation summary redaction for Usage capture."""

from __future__ import annotations

import json
from typing import Any

import skill_hub.domain.usage.usage_classify as usage_classify
from skill_hub.domain.usage.usage_inspection_capture import OPERATION_SUMMARY_LIMIT, TIER_B_INPUT_TOOLS


def operation_summary(
    tool_name: str,
    operation_json: str | None,
    *,
    limit: int = OPERATION_SUMMARY_LIMIT,
) -> str | None:
    """Return a bounded, redacted, human-readable description.

    The operation summary intentionally excludes file and patch content.  It
    remains host-owned because redaction uses the host's home and configured
    secret patterns at call time.
    """
    if operation_json is None:
        return None
    try:
        value = json.loads(operation_json)
    except ValueError:
        value = operation_json
    if tool_name in TIER_B_INPUT_TOOLS:
        path = value.get("file_path") or value.get("path") if isinstance(value, dict) else None
        text = f"{tool_name} {path}" if isinstance(path, str) else tool_name
    else:
        text = operation_json if isinstance(value, (dict, list)) else str(value)
    return usage_classify.redact_excerpt(text, limit=limit)


class _OperationSummaryHostCompatibility:
    """Delegate an old host while adding the host-owned summary capability."""

    def __init__(self, host: Any) -> None:
        self._host = host

    def operation_summary_v1(
        self,
        tool_name: str,
        operation_json: str | None,
        *,
        limit: int = OPERATION_SUMMARY_LIMIT,
    ) -> str | None:
        return operation_summary(tool_name, operation_json, limit=limit)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._host, name)


def with_operation_summary_v1(host: Any) -> Any:
    """Return a capable host or a transparent adapter for an old host."""
    if callable(getattr(host, "operation_summary_v1", None)):
        return host
    return _OperationSummaryHostCompatibility(host)


__all__ = ["OPERATION_SUMMARY_LIMIT", "operation_summary", "with_operation_summary_v1"]
