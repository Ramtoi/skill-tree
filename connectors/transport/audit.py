"""Append-only JSONL audit log for remote writes.

One log per remote at

    <data_home>/state/remote_<id>/audit.log

Each line is a JSON object: timestamp (UTC ISO-8601), action, artifact, and the
sha-before/after of the affected content. Secrets are NEVER recorded here
(spec: secret value "never written to ... the audit log").

Append-only by contract: callers only ever `append(...)`; the log is opened in
``"a"`` mode and never truncated/rewritten.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _state_root() -> Path:
    import hub  # local import to avoid a cycle at module load

    return hub.data_home() / "state"


def _safe_id(remote_id: str) -> str:
    return _SAFE.sub("-", remote_id).strip("-") or "remote"


def audit_log_path(remote_id: str) -> Path:
    return _state_root() / f"remote_{_safe_id(remote_id)}" / "audit.log"


def append(
    remote_id: str,
    action: str,
    artifact: str,
    *,
    sha_before: Optional[str] = None,
    sha_after: Optional[str] = None,
    detail: Optional[str] = None,
) -> None:
    """Append one audit entry. Creates the log + parent dir on first write."""
    entry = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "action": action,
        "artifact": artifact,
        "sha_before": sha_before,
        "sha_after": sha_after,
    }
    if detail is not None:
        entry["detail"] = detail
    path = audit_log_path(remote_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read_all(remote_id: str) -> list[dict]:
    """Read back every audit entry (for inspection/tests). Empty if absent."""
    path = audit_log_path(remote_id)
    if not path.exists():
        return []
    out: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out
