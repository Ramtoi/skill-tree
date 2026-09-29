"""Host context snapshots and atomic exports of canonical Usage summaries."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from skill_hub import hub_core
from skill_hub.application.usage import usage_summary_projection
from skill_hub.infrastructure.usage import usage_loadouts
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def _tracked_files(path: str) -> int | None:
    try:
        result = subprocess.run(
            ["git", "ls-files", "-z"], cwd=path, capture_output=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.count(b"\0") if result.returncode == 0 else None


def prepare_context(store: InspectionStore, scan_id: str, registry: dict, now: datetime) -> dict:
    """Reuse the pass snapshot before reading any live host projection inputs."""
    existing = usage_summary_projection.load_context(store.db, scan_id)
    if existing is not None:
        return existing
    loadouts, _warnings = usage_loadouts.read_loadout_rows()
    projects = registry.get("projects") or {}
    counts = {
        key: _tracked_files(value["path"])
        for key, value in projects.items()
        if isinstance(value, dict) and isinstance(value.get("path"), str)
    }
    skills = registry.get("skills") or {}
    context = {
        "registry": {"skills": {key: {} for key in skills}},
        "loadout_rows": loadouts, "tracked_files": counts, "now": now.isoformat(),
    }
    store.db.execute("BEGIN IMMEDIATE")
    try:
        saved = usage_summary_projection.save_context(store.db, scan_id, context)
        store.db.execute("COMMIT")
        return saved
    except BaseException:
        store.db.execute("ROLLBACK")
        raise


def _legacy_rows(path: Path) -> tuple[list[dict], int]:
    rows = []
    rejected = 0
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError:
                rejected += 1
                continue
            if not isinstance(value, dict):
                rejected += 1
                continue
            rows.append(value)
    return rows, rejected


def export_rows(
    store: InspectionStore, rows: list[dict[str, Any]], *, index: dict, revision: int,
) -> None:
    """Write a private complete file, then atomically publish its projection revision."""
    inspection = {(row["harness"], row["session_id"]): row for row in index["sessions"]}
    projected = []
    for row in rows:
        value = dict(row)
        key = (value["harness"], value["session_id"])
        if (key in inspection and value.get("summary_provenance") == "canonical"
                and value.get("capture_coverage") == "complete"):
            value["inspection"] = inspection[key]
        value["excerpt_redaction_version"] = 1
        projected.append(value)
    text = "".join(json.dumps(row, sort_keys=True) + "\n" for row in sorted(
        projected, key=lambda row: (row["harness"], row["session_id"])
    ))
    path = hub_core.data_home() / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    encoded = text.encode("utf-8")
    if not path.exists() or path.read_bytes() != encoded:
        fd, name = tempfile.mkstemp(prefix="sessions.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, path)
        finally:
            Path(name).unlink(missing_ok=True)
    store.set_projection_revision(revision)


def refresh_and_export(
    store: InspectionStore, *, context: dict, incomplete_sources: set[str] | None = None,
    pending_sources: bool = False,
) -> dict[str, Any]:
    """Commit successful reductions and legacy supersession before exporting."""
    with hub_core.data_home_lock():
        path = hub_core.data_home() / "state/usage/sessions.jsonl"
        store.db.execute("BEGIN IMMEDIATE")
        try:
            imported = store.db.execute(
                "SELECT value FROM usage_summary_metadata WHERE key='legacy_import_complete'"
            ).fetchone()
            legacy, rejected = _legacy_rows(path) if imported is None else ([], 0)
            before = {(row["harness"], row["session_id"]): row
                      for row in usage_summary_projection.effective_summaries(store.db)}
            scopes = store._read_set().scopes()
            keys = {
                (fact["harness"], fact["source_session_id"])
                for fact in scopes
                if fact["harness"] == "codex" or fact["source_session_id"] == fact["root_session_id"]
            }
            sessions = {key: store.summary_facts(*key) for key in keys}
            for facts in sessions.values():
                for coverage in facts["coverage"]:
                    if pending_sources or coverage["source_id"] in (incomplete_sources or set()):
                        coverage["status"] = "partial"
            rows = usage_summary_projection.refresh_summaries(
                store.db, context=context, sessions=sessions, revision=store.canonical_revision(), legacy_rows=legacy,
            )
            if imported is None and rejected:
                store.db.execute(
                    "UPDATE usage_summary_metadata SET value=CAST(value AS INTEGER)+? "
                    "WHERE key='last_import_rejected'", (rejected,),
                )
            index = store.index_payload()
            revision = store.canonical_revision()
            import_rejections = store.db.execute(
                "SELECT value FROM usage_summary_metadata WHERE key='last_import_rejected'"
            ).fetchone()
            rejected = int(import_rejections[0]) if import_rejections is not None else 0
            store.db.execute("COMMIT")
        except BaseException:
            store.db.execute("ROLLBACK")
            raise
        export_rows(store, rows, index=index, revision=revision)
        changed = [row for row in rows if before.get((row["harness"], row["session_id"])) != row]
        return {
            "rows_written": len(changed), "malformed_rows_dropped": rejected,
            "row_counts": {
                "frozen": sum(bool(row.get("frozen")) for row in rows),
                "unregistered": sum(row.get("project") == "unregistered" for row in rows),
                "by_harness": {harness: sum(row["harness"] == harness for row in changed)
                               for harness in {row["harness"] for row in rows}},
            },
        }
