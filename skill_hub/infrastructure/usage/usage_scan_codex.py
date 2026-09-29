"""Compatibility entry point for the canonical Codex capture workflow."""

from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Optional

from skill_hub.application.usage.usage_source_layout import UsageLayout, capture_usage_layout

SESSIONS_REL = "state/usage/sessions.jsonl"
CURSOR_REL = "state/usage/scan-cursor.json"


def transcript_root(layout: Optional[UsageLayout] = None) -> Optional[Path]:
    captured = layout if layout is not None else capture_usage_layout()
    return captured.root("codex")


def scan_sessions(*, now: _dt.datetime | None = None, layout: UsageLayout | None = None) -> dict:
    from skill_hub.infrastructure.usage import usage_scan

    return usage_scan.scan_sessions(harness="codex", now=now, layout=layout)
