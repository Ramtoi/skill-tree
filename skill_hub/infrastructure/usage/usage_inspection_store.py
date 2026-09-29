"""Private SQLite store for retained Usage inspection evidence."""
# ruff: noqa: E501
from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, Literal

import skill_hub.application.usage.usage_publication_reads as usage_publication_reads
import skill_hub.application.usage.usage_summary_projection as usage_summary_projection
import skill_hub.hub_core as hub_core
import skill_hub.infrastructure.usage.usage_publication as usage_publication
import skill_hub.infrastructure.usage.usage_source_versions as usage_source_versions
from skill_hub.domain.usage.usage_inspection_capture import (
    TIER_A_INPUT_BODY_LIMIT,
    BodyPartInput,
    CaptureBatch,
    MergeResult,
    ReaderBinding,
    SourceCursor,
    SourceFingerprint,
    body_identity,
    bounded_body,
    load_resume_state,
    operation_hash,
    retention_tier,
)
from skill_hub.infrastructure.usage.usage_capture_summary import operation_summary as capture_operation_summary

SCHEMA_VERSION = 7
DB_REL = "state/usage/inspection.sqlite3"
CHUNK_BYTES = 64 * 1024
_ID_RE = re.compile(r"^[A-Za-z0-9_.:/-]{1,512}$")
DEFAULT_RETENTION_DAYS = 90
DEFAULT_MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024
RETENTION_CONFIG_REL = "state/usage/inspection-retention.json"


def _safe_operation_summary(tool_name: str, operation_json: str | None) -> str | None:
    """Build the bounded display value while migrating legacy signatures.

    Old databases can contain serialized Edit/Write or patch content in the
    signature column.  Those values must never be copied into the replacement
    summary, even when the old value is not valid JSON.
    """
    if operation_json is None:
        return None
    try:
        parsed = json.loads(operation_json)
    except (TypeError, ValueError):
        parsed = None
    if tool_name in {"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"}:
        if isinstance(parsed, dict):
            path = parsed.get("file_path") or parsed.get("path")
            if isinstance(path, str):
                return capture_operation_summary(tool_name, json.dumps({"path": path}))
        return tool_name
    if parsed is None:
        return capture_operation_summary(tool_name, tool_name)
    if isinstance(parsed, (dict, list)):
        # Keep only the request's safe scalar shape.  The capture adapter owns
        # the richer redaction for new records; migration must be conservative.
        if isinstance(parsed, dict):
            safe = {key: value for key, value in parsed.items() if key in {"command", "cmd", "pattern", "path", "file_path", "query", "prompt", "skill", "name"} and isinstance(value, (str, int, float, bool))}
            value = json.dumps(safe, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        else:
            value = tool_name
    else:
        value = tool_name
    return capture_operation_summary(tool_name, value)


def _sanitize_resume_state(raw: str | None) -> str:
    """Keep resume references and derived facts, dropping raw invocation data."""
    if not raw:
        return raw or ""
    try:
        state = json.loads(raw)
    except (TypeError, ValueError):
        return ""
    if not isinstance(state, dict):
        return ""
    forbidden = {"input", "arguments", "operation_json", "operation_signature", "body", "content", "raw"}

    def clean(value: object) -> object:
        if isinstance(value, dict):
            return {str(key): clean(item) for key, item in value.items() if str(key) not in forbidden}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value

    return json.dumps(clean(state), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class InspectionStoreError(RuntimeError):
    def __init__(self, reason: str, message: str | None = None):
        self.reason = reason
        super().__init__(message or reason)


def db_path() -> Path:
    return hub_core.data_home() / DB_REL


def load_retention_config() -> dict[str, int]:
    """Read persisted retention settings without opening or migrating SQLite."""
    defaults = {"older_than_days": DEFAULT_RETENTION_DAYS, "max_store_bytes": DEFAULT_MAX_STORE_BYTES}
    path = hub_core.data_home() / RETENTION_CONFIG_REL
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return defaults
    if not isinstance(value, dict):
        return defaults
    for key in defaults:
        candidate = value.get(key)
        if isinstance(candidate, int) and candidate >= 0:
            defaults[key] = candidate
    return defaults


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _cursor_token(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise InspectionStoreError("invalid_cursor")
    return value


def _tool_cursor(value: str | None) -> tuple[str | None, str | None]:
    """Decode the chronological `(at, call_id)` cursor used by tool pages."""
    if value is None:
        return None, None
    if not isinstance(value, str) or "|" not in value:
        return None, _cursor_token(value)
    at, call_id = value.split("|", 1)
    if at and not _ID_RE.fullmatch(at):
        raise InspectionStoreError("invalid_cursor")
    return at or "", _cursor_token(call_id)


def _fingerprint(value: SourceFingerprint) -> tuple:
    return (value.device, value.inode, value.size, value.mtime_ns, value.prefix_sha256, value.boundary_sha256)


def _scope(token_values: dict[str, int], *, status: str = "available", cost: float | None = None, cost_status: str = "unpriced", first: str | None = None, last: str | None = None, active_ms: int | None = None, timing_status: str = "unavailable", evidence: list[dict[str, str]] | None = None) -> dict:
    if status == "unavailable":
        exposed: dict[str, int | None] = {key: None for key in token_values}
        total: int | None = None
    elif status == "partial":
        exposed = {key: value if value > 0 else None for key, value in token_values.items()}
        total = token_values.get("total", sum(value for value in token_values.values() if value > 0)) or None
    else:
        exposed = dict(token_values)
        total = token_values.get("total", sum(token_values.values()))
    return {
        "tokens": {**exposed, "total": total, "status": status},
        "cost": {"currency": "USD", "value": cost, "status": cost_status},
        "timing": {"first_at": first, "last_at": last, "active_ms": active_ms, "status": timing_status},
        "evidence": evidence or [],
    }


def _pricing() -> dict[str, dict[str, float]]:
    try:
        root = Path(__file__).resolve().parents[3] / "ccusage-pricing.json"
        data = json.loads(root.read_text(encoding="utf-8"))
        value = data.get("defaults", {}).get("pricingOverrides", {})
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _cost(models: dict[str, dict[str, int]]) -> tuple[float | None, str]:
    if not models:
        return None, "unavailable"
    rates = _pricing()
    total = 0.0
    missing: list[str] = []
    for model, values in models.items():
        rate = rates.get(model)
        if not isinstance(rate, dict):
            if sum(values.values()):
                missing.append(model)
            continue
        total += sum(values[key] * float(rate.get(name, 0.0)) for key, name in (("input", "inputCostPerToken"), ("output", "outputCostPerToken"), ("cache_creation", "cacheCreationInputTokenCost"), ("cache_read", "cacheReadInputTokenCost")))
    if missing and not total:
        return None, "unpriced"
    return total, "partial" if missing else "known"


class InspectionStore:
    """One SQLite connection and transaction owner for the inspection DB."""

    def __init__(self, connection: sqlite3.Connection, *, status: str = "complete"):
        self.db = connection
        self.status = status
        self._readsets: dict[tuple[Any, ...], usage_publication_reads.CurrentReadSet] = {}
        self._readsets_revision = connection.total_changes

        # Per-run reads repeat many times inside one payload build: every
        # run's own scope, its parent's children scope, and every ancestor's
        # subtree scope all re-read the same token samples and events. This
        # memo caches the COMPUTED result, where `_read_set` above caches the
        # underlying publication rows. It lives only for the duration of one
        # payload build (see `_memoized`), so a capture merge never observes a
        # stale read.
        self._run_tokens_memo: dict[str, dict[str, Any]] | None = None
        self._run_activity_memo: dict[str, list[dict[str, str | None]]] | None = None

    def _read_set(self, *, harness: str | None = None, session_id: str | None = None, run_ids: set[str] | None = None) -> usage_publication_reads.CurrentReadSet:
        if self._readsets_revision != self.db.total_changes:
            self._readsets.clear()
            self._readsets_revision = self.db.total_changes
        key = (harness, session_id, frozenset(run_ids or ()))
        if key not in self._readsets:
            self._readsets[key] = usage_publication_reads.CurrentReadSet(
                self.db, harness=harness, session_id=session_id, run_ids=run_ids
            )
        return self._readsets[key]

    def _current_facts(self, kind: str, *, harness: str | None = None, session_id: str | None = None, run_ids: set[str] | None = None) -> list[dict[str, Any]]:
        return self._read_set(harness=harness, session_id=session_id, run_ids=run_ids).facts(kind)

    @contextmanager
    def _memoized(self) -> Iterator[None]:
        """Cache per-run token and activity reads for one payload build."""
        if self._run_tokens_memo is not None:
            yield
            return
        self._run_tokens_memo, self._run_activity_memo = {}, {}
        try:
            yield
        finally:
            self._run_tokens_memo, self._run_activity_memo = None, None

    @classmethod
    def open(cls) -> "InspectionStore":
        # Serialize the probe, backup, migration, and restore decision. The
        # lock is re-entrant for facade callers that already hold it.
        with hub_core.data_home_lock():
            return cls._open_locked()

    @classmethod
    def _open_locked(cls) -> "InspectionStore":
        path = db_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection: sqlite3.Connection | None = None
        existed = path.exists()
        needs_migration = not existed
        migration_backup = path.with_name(path.name + ".migration-backup")
        try:
            os.chmod(path.parent, 0o700)
            if existed:
                probe = sqlite3.connect(path, timeout=30)
                try:
                    version_row = probe.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone() if cls._has_metadata(probe) else None
                    if version_row is not None and int(version_row[0]) > SCHEMA_VERSION:
                        raise InspectionStoreError("inspection_version_unsupported")
                    needs_migration = version_row is None or int(version_row[0]) != SCHEMA_VERSION or cls._needs_migration(probe)
                finally:
                    probe.close()
                if needs_migration:
                    cls._backup_database(path, migration_backup)
            connection = sqlite3.connect(path, isolation_level=None, timeout=30)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            if needs_migration:
                cls._migrate(connection)
            # Each captured tool resolves its native identity. Without this
            # index every lookup scans all prior calls, making backfill quadratic.
            # Add it to existing stores without copying their retained bodies.
            connection.execute("CREATE INDEX IF NOT EXISTS tool_calls_run_native ON tool_calls(run_id, native_call_id)")
            # Summary metrics read events per run; timelines read per source.
            # Neither query should walk the rest of the retained history.
            connection.execute("CREATE INDEX IF NOT EXISTS events_run_at ON events(run_id, at)")
            connection.execute("CREATE INDEX IF NOT EXISTS events_epoch_at ON events(source_epoch, at)")
            # Every run in an overview counts its edits. Without this index
            # each count scans the whole changes table once per run.
            connection.execute("CREATE INDEX IF NOT EXISTS changes_run_id ON changes(run_id)")
            os.chmod(path, 0o600)
            # Keep the pre-migration copy as an explicit recovery artifact.
            # It is removed only when a failed migration is restored above.
            return cls(connection)
        except InspectionStoreError:
            raise
        except (sqlite3.DatabaseError, OSError, ValueError) as exc:
            try:
                if connection is not None:
                    connection.close()
            except Exception:
                pass
            if existed and migration_backup.exists():
                try:
                    shutil.copy2(migration_backup, path)
                    migration_backup.unlink()
                except OSError:
                    pass
            raise InspectionStoreError("inspection_corrupt", str(exc)) from exc

    @classmethod
    def open_readonly_for_prune(cls) -> "InspectionStore | None":
        """Open a read-only snapshot for dry-run planning.

        Dry-run planning must not copy the retained body store into memory.
        A current schema can be queried directly through SQLite's read-only
        URI.  An older schema needs the normal additive migration first; make
        that requirement explicit rather than mutating or projecting a full
        store just to estimate a plan.
        """
        path = db_path()
        if not path.exists():
            return None
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
            connection.row_factory = sqlite3.Row
            version_row = connection.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone() if cls._has_metadata(connection) else None
            if version_row is not None and int(version_row[0]) > SCHEMA_VERSION:
                raise InspectionStoreError("inspection_version_unsupported")
            if version_row is None or int(version_row[0]) != SCHEMA_VERSION or cls._needs_migration(connection):
                raise InspectionStoreError("inspection_migration_required")
            return cls(connection)
        except InspectionStoreError:
            if connection is not None:
                connection.close()
            raise
        except (sqlite3.DatabaseError, OSError, ValueError) as exc:
            try:
                if connection is not None:
                    connection.close()
            except sqlite3.Error:
                pass
            raise InspectionStoreError("inspection_corrupt", str(exc)) from exc

    @staticmethod
    def _backup_database(path: Path, destination: Path) -> None:
        """Make a consistent SQLite backup before attempting migration."""
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
        source: sqlite3.Connection | None = None
        backup: sqlite3.Connection | None = None
        try:
            source = sqlite3.connect(path, timeout=30)
            backup = sqlite3.connect(destination, timeout=30)
            source.backup(backup)
            backup.commit()
            os.chmod(destination, 0o600)
        except sqlite3.DatabaseError:
            if destination.exists():
                destination.unlink()
            shutil.copy2(path, destination)
            os.chmod(destination, 0o600)
        finally:
            if backup is not None:
                backup.close()
            if source is not None:
                source.close()

    @staticmethod
    def _needs_migration(db: sqlite3.Connection) -> bool:
        required = {
            "sources": {"source_id", "generation_id", "revision", "offset", "parser_version", "committed_prefix_sha256", "committed_boundary_sha256", "resume_state", "resume_version", "reader_revision", "normalization_version", "reader_id"},
            "events": {"run_id", "correlation_id", "source_ordinal", "block_ordinal", "role_ordinal"},
            "token_samples": {"total", "source_epoch", "parser_version", "origin", "source_ordinal", "block_ordinal", "role_ordinal", "first_turn_input_total"},
            "runs": {"locations", "native_facts"},
            "run_members": {"captured_revision"},
            "tool_parts": {"mirror_part_key", "tombstone_body_id", "source_epoch", "retained_version", "retention_tier", "pruned_at", "evidenced_at"},
            "change_parts": {"mirror_part_key", "tombstone_body_id", "source_epoch", "retained_version", "retention_tier", "pruned_at", "evidenced_at"},
            "tool_calls": {"operation_summary", "collision_of", "source_ordinal", "block_ordinal", "role_ordinal", "activity_class", "skill_key", "invocation_origin", "read_file_hash", "edit_file_hash", "mcp_server", "mcp_tool", "child_run_id"},
            "bodies": {"pruned_at"},
        }
        for table, columns in required.items():
            rows = db.execute(f"PRAGMA table_info({table})").fetchall()
            present = {str(row[1]) for row in rows}
            if not columns <= present:
                return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_passes'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_pass_sources'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_pass_reader_bindings'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reader_policies'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reader_binding_observations'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='summary_event_seeds'").fetchone() is None:
            return True
        if "count" not in {str(row[1]) for row in db.execute("PRAGMA table_info(summary_event_seeds)").fetchall()}:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_capture_context'").fetchone() is None:
            return True
        for table in (
            "source_versions",
            "source_heads",
            "version_facts",
            "publication_body_authorizations",
            "publication_fact_index",
            "canonical_session_summaries",
            "usage_summary_contexts",
            "legacy_session_summaries",
            "usage_summary_metadata",
        ):
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is None:
                return True
        scan_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(scan_passes)").fetchall()}
        if "reader_policy_bindings" not in scan_columns or "capture_context_digest" not in scan_columns:
            return True
        if "reader_catalog_json" not in scan_columns or "reader_catalog_digest" not in scan_columns:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='body_tombstones'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_issues'").fetchone() is None:
            return True
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_members'").fetchone() is None:
            return True
        tombstone_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(body_tombstones)").fetchall()}
        if "run_id" not in tombstone_columns:
            return True
        source_info = db.execute("PRAGMA table_info(sources)").fetchall()
        source_pk = {str(row[1]): int(row[5]) for row in source_info}
        return source_pk.get("source_id") == 1 and source_pk.get("generation_id", 0) == 0

    @staticmethod
    def _has_metadata(db: sqlite3.Connection) -> bool:
        row = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").fetchone()
        return row is not None

    @staticmethod
    def _migrate(db: sqlite3.Connection) -> None:
        try:
            db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (harness TEXT NOT NULL, session_id TEXT NOT NULL, root_session_id TEXT NOT NULL, parent_session_id TEXT, state TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'available', captured_at TEXT NOT NULL, PRIMARY KEY(harness, session_id));
            CREATE TABLE IF NOT EXISTS sources (source_id TEXT NOT NULL, harness TEXT NOT NULL, source_session_id TEXT NOT NULL, generation_id TEXT NOT NULL, revision INTEGER NOT NULL, offset INTEGER NOT NULL, device INTEGER, inode INTEGER, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, prefix_sha256 TEXT NOT NULL, boundary_sha256 TEXT NOT NULL, status TEXT NOT NULL, captured_at TEXT NOT NULL, parser_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(source_id, generation_id));
            CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, harness TEXT NOT NULL, source_session_id TEXT NOT NULL, native_run_id TEXT NOT NULL, parent_run_id TEXT, role TEXT, models TEXT NOT NULL, started_at TEXT, ended_at TEXT, locations TEXT NOT NULL DEFAULT '[]', native_facts TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS identity_issues (harness TEXT NOT NULL, physical_run_id TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(harness,physical_run_id));
            CREATE TABLE IF NOT EXISTS run_members (logical_id TEXT NOT NULL, physical_run_id TEXT NOT NULL PRIMARY KEY, harness TEXT NOT NULL, root_session_id TEXT NOT NULL, source_id TEXT NOT NULL, origin TEXT NOT NULL, captured_revision INTEGER NOT NULL DEFAULT 0, UNIQUE(logical_id,source_id));
            CREATE TABLE IF NOT EXISTS token_samples (run_id TEXT NOT NULL, sample_id TEXT NOT NULL, model TEXT, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_creation INTEGER NOT NULL, cache_read INTEGER NOT NULL, cumulative INTEGER NOT NULL, epoch_marker INTEGER NOT NULL, at TEXT, total INTEGER, source_epoch TEXT NOT NULL DEFAULT '', parser_version INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(run_id, sample_id));
            CREATE TABLE IF NOT EXISTS bodies (body_id TEXT PRIMARY KEY, status TEXT NOT NULL, content_type TEXT NOT NULL, total_bytes INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS body_chunks (body_id TEXT NOT NULL REFERENCES bodies(body_id) ON DELETE CASCADE, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(body_id, seq));
            CREATE TABLE IF NOT EXISTS tool_calls (call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, native_call_id TEXT NOT NULL, at TEXT, tool_name TEXT NOT NULL, tool_kind TEXT NOT NULL, operation_signature TEXT, execution TEXT NOT NULL, source_epoch TEXT NOT NULL, evidence TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tool_parts (call_id TEXT NOT NULL REFERENCES tool_calls(call_id) ON DELETE CASCADE, side TEXT NOT NULL, ordinal INTEGER NOT NULL, part_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL, body_id TEXT, source_locator TEXT, source_epoch TEXT NOT NULL DEFAULT '', retained_version INTEGER NOT NULL DEFAULT 0, retention_tier TEXT NOT NULL DEFAULT 'B', pruned_at TEXT, evidenced_at TEXT, PRIMARY KEY(call_id, side, ordinal));
            CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, source_epoch TEXT NOT NULL, source_record_id TEXT, at TEXT, kind TEXT NOT NULL, payload_hash TEXT NOT NULL, run_id TEXT, correlation_id TEXT);
            CREATE TABLE IF NOT EXISTS relationships (relationship_id TEXT PRIMARY KEY, source_epoch TEXT NOT NULL, source_event_id TEXT NOT NULL, from_run_id TEXT NOT NULL, to_run_id TEXT, kind TEXT NOT NULL, at TEXT, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS changes (change_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_epoch TEXT NOT NULL, source_event_id TEXT NOT NULL, tool_call_id TEXT, kind TEXT NOT NULL, attribution TEXT NOT NULL, repository_id TEXT, revision_id TEXT, base_id TEXT, merge_base_id TEXT, files TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS change_parts (change_id TEXT NOT NULL REFERENCES changes(change_id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, part_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL, body_id TEXT, source_locator TEXT, source_epoch TEXT NOT NULL DEFAULT '', retained_version INTEGER NOT NULL DEFAULT 0, retention_tier TEXT NOT NULL DEFAULT 'B', pruned_at TEXT, evidenced_at TEXT, PRIMARY KEY(change_id, ordinal));
            CREATE TABLE IF NOT EXISTS prs (pr_id TEXT PRIMARY KEY, source_epoch TEXT NOT NULL, source_event_id TEXT NOT NULL, repository_id TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL, relationship TEXT NOT NULL, evidenced_at TEXT, first_seen TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pins (harness TEXT NOT NULL, source_session_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(harness, source_session_id, run_id));
            CREATE TABLE IF NOT EXISTS projection (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT OR IGNORE INTO metadata(key,value) VALUES ('schema_version','7');
            INSERT OR IGNORE INTO metadata(key,value) VALUES ('canonical_revision','0');
            INSERT OR IGNORE INTO metadata(key,value) VALUES ('projection_revision','0');
            """)
            member_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(run_members)")}
            if "captured_revision" not in member_columns:
                db.execute("ALTER TABLE run_members ADD COLUMN captured_revision INTEGER NOT NULL DEFAULT 0")
            source_info = db.execute("PRAGMA table_info(sources)").fetchall()
            source_pk = {str(row[1]): int(row[5]) for row in source_info}
            if source_pk.get("source_id") == 1 and source_pk.get("generation_id", 0) == 0:
                # Development databases from the first scaffold keyed one
                # path to one row. Rebuild only that table so retained
                # generations can coexist while preserving its evidence.
                db.execute("ALTER TABLE sources RENAME TO sources_legacy")
                db.execute("CREATE TABLE sources (source_id TEXT NOT NULL, harness TEXT NOT NULL, source_session_id TEXT NOT NULL, generation_id TEXT NOT NULL, revision INTEGER NOT NULL, offset INTEGER NOT NULL, device INTEGER, inode INTEGER, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, prefix_sha256 TEXT NOT NULL, boundary_sha256 TEXT NOT NULL, status TEXT NOT NULL, captured_at TEXT NOT NULL, parser_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(source_id, generation_id))")
                columns = {str(row[1]) for row in source_info}
                if "generation_id" in columns:
                    db.execute("INSERT INTO sources(source_id,harness,source_session_id,generation_id,revision,offset,device,inode,size,mtime_ns,prefix_sha256,boundary_sha256,status,captured_at) SELECT source_id,harness,source_session_id,generation_id,revision,offset,device,inode,size,mtime_ns,prefix_sha256,boundary_sha256,status,captured_at FROM sources_legacy")
                else:
                    db.execute("INSERT INTO sources(source_id,harness,source_session_id,generation_id,revision,offset,device,inode,size,mtime_ns,prefix_sha256,boundary_sha256,status,captured_at) SELECT source_id,harness,source_session_id,'generation:' || source_id,revision,offset,device,inode,size,mtime_ns,prefix_sha256,boundary_sha256,status,captured_at FROM sources_legacy")
                db.execute("DROP TABLE sources_legacy")
            columns = {row[1] for row in db.execute("PRAGMA table_info(events)").fetchall()}
            source_columns = {row[1] for row in db.execute("PRAGMA table_info(sources)").fetchall()}
            if "parser_version" not in source_columns:
                db.execute("ALTER TABLE sources ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1")
            if "run_id" not in columns:
                db.execute("ALTER TABLE events ADD COLUMN run_id TEXT")
            if "correlation_id" not in columns:
                db.execute("ALTER TABLE events ADD COLUMN correlation_id TEXT")
            for column in ("source_ordinal", "block_ordinal", "role_ordinal"):
                if column not in columns:
                    db.execute(f"ALTER TABLE events ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
            token_columns = {row[1] for row in db.execute("PRAGMA table_info(token_samples)").fetchall()}
            for column, definition in (("source_epoch", "TEXT NOT NULL DEFAULT ''"), ("parser_version", "INTEGER NOT NULL DEFAULT 1"), ("origin", "TEXT NOT NULL DEFAULT 'legacy'")):
                if column not in token_columns:
                    db.execute(f"ALTER TABLE token_samples ADD COLUMN {column} {definition}")
            if "total" not in token_columns:
                db.execute("ALTER TABLE token_samples ADD COLUMN total INTEGER")
            for column, definition in (("source_ordinal", "INTEGER NOT NULL DEFAULT 0"), ("block_ordinal", "INTEGER NOT NULL DEFAULT 0"), ("role_ordinal", "INTEGER NOT NULL DEFAULT 0"), ("first_turn_input_total", "INTEGER")):
                if column not in token_columns:
                    db.execute(f"ALTER TABLE token_samples ADD COLUMN {column} {definition}")
            run_columns = {row[1] for row in db.execute("PRAGMA table_info(runs)").fetchall()}
            if "locations" not in run_columns:
                db.execute("ALTER TABLE runs ADD COLUMN locations TEXT NOT NULL DEFAULT '[]'")
            if "native_facts" not in run_columns:
                db.execute("ALTER TABLE runs ADD COLUMN native_facts TEXT NOT NULL DEFAULT '{}'")
            for table in ("tool_parts", "change_parts"):
                part_columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
                if "source_epoch" not in part_columns:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN source_epoch TEXT NOT NULL DEFAULT ''")
                if "retained_version" not in part_columns:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN retained_version INTEGER NOT NULL DEFAULT 0")
                if "retention_tier" not in part_columns:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN retention_tier TEXT NOT NULL DEFAULT 'B'")
                if "pruned_at" not in part_columns:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN pruned_at TEXT")
                if "evidenced_at" not in part_columns:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN evidenced_at TEXT")
            body_columns = {row[1] for row in db.execute("PRAGMA table_info(bodies)").fetchall()}
            if "pruned_at" not in body_columns:
                db.execute("ALTER TABLE bodies ADD COLUMN pruned_at TEXT")
            call_columns = {row[1] for row in db.execute("PRAGMA table_info(tool_calls)").fetchall()}
            if "operation_summary" not in call_columns:
                db.execute("ALTER TABLE tool_calls ADD COLUMN operation_summary TEXT")
            if "collision_of" not in call_columns:
                db.execute("ALTER TABLE tool_calls ADD COLUMN collision_of TEXT")
            for column in ("source_ordinal", "block_ordinal", "role_ordinal"):
                if column not in call_columns:
                    db.execute(f"ALTER TABLE tool_calls ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
            for column in ("activity_class", "skill_key", "invocation_origin", "read_file_hash", "edit_file_hash", "mcp_server", "mcp_tool", "child_run_id"):
                if column not in call_columns:
                    db.execute(f"ALTER TABLE tool_calls ADD COLUMN {column} TEXT")
            source_columns = {row[1] for row in db.execute("PRAGMA table_info(sources)").fetchall()}
            for column, definition in (
                ("committed_prefix_sha256", "TEXT NOT NULL DEFAULT ''"),
                ("committed_boundary_sha256", "TEXT NOT NULL DEFAULT ''"),
                ("resume_state", "TEXT NOT NULL DEFAULT ''"),
                ("resume_version", "INTEGER NOT NULL DEFAULT 0"),
                ("reader_id", "TEXT NOT NULL DEFAULT ''"),
                ("reader_revision", "INTEGER NOT NULL DEFAULT 0"),
                ("normalization_version", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if column not in source_columns:
                    db.execute(f"ALTER TABLE sources ADD COLUMN {column} {definition}")
            db.execute("CREATE TABLE IF NOT EXISTS scan_passes (scan_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL, harnesses TEXT NOT NULL, reader_bindings TEXT NOT NULL, errors TEXT NOT NULL DEFAULT '[]')")
            db.execute("CREATE TABLE IF NOT EXISTS scan_pass_sources (scan_id TEXT NOT NULL REFERENCES scan_passes(scan_id) ON DELETE CASCADE, source_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, attempted_at TEXT, PRIMARY KEY(scan_id, source_id))")
            scan_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(scan_passes)").fetchall()}
            if "reader_policy_bindings" not in scan_columns:
                db.execute("ALTER TABLE scan_passes ADD COLUMN reader_policy_bindings TEXT NOT NULL DEFAULT '{}'")
            if "capture_context_digest" not in scan_columns:
                db.execute("ALTER TABLE scan_passes ADD COLUMN capture_context_digest TEXT NOT NULL DEFAULT ''")
            if "reader_catalog_json" not in scan_columns:
                db.execute("ALTER TABLE scan_passes ADD COLUMN reader_catalog_json TEXT NOT NULL DEFAULT ''")
            if "reader_catalog_digest" not in scan_columns:
                db.execute("ALTER TABLE scan_passes ADD COLUMN reader_catalog_digest TEXT NOT NULL DEFAULT ''")
            db.execute(
                "CREATE TABLE IF NOT EXISTS scan_pass_reader_bindings ("
                "scan_id TEXT NOT NULL REFERENCES scan_passes(scan_id) ON DELETE CASCADE, "
                "source_id TEXT NOT NULL, generation_id TEXT NOT NULL, schema_version INTEGER NOT NULL, "
                "reader_ref_json TEXT NOT NULL, policy_json TEXT NOT NULL, recognition_json TEXT NOT NULL, "
                "catalog_digest TEXT NOT NULL, PRIMARY KEY(scan_id,source_id,generation_id))"
            )
            db.execute("CREATE TABLE IF NOT EXISTS reader_policies (binding_digest TEXT PRIMARY KEY, policy_json TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS reader_binding_observations (source_id TEXT NOT NULL, generation_id TEXT NOT NULL, binding_digest TEXT NOT NULL REFERENCES reader_policies(binding_digest), source_evidence_json TEXT NOT NULL, PRIMARY KEY(source_id,generation_id,binding_digest))")
            db.execute("CREATE TABLE IF NOT EXISTS messages (message_id TEXT NOT NULL, source_epoch TEXT NOT NULL, run_id TEXT NOT NULL, source_ordinal INTEGER NOT NULL, block_ordinal INTEGER NOT NULL, role_ordinal INTEGER NOT NULL, at TEXT, role TEXT NOT NULL, kind TEXT NOT NULL, text_len INTEGER NOT NULL, thinking_len INTEGER NOT NULL, is_steering INTEGER NOT NULL, slash_command TEXT, excerpt TEXT NOT NULL, first_turn_input_total INTEGER, stacked INTEGER NOT NULL, interrupted INTEGER NOT NULL, synthetic INTEGER NOT NULL, native_kind TEXT, PRIMARY KEY(message_id,source_epoch))")
            db.execute("CREATE TABLE IF NOT EXISTS summary_event_seeds (event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_epoch TEXT NOT NULL, source_ordinal INTEGER NOT NULL, block_ordinal INTEGER NOT NULL, role_ordinal INTEGER NOT NULL, at TEXT, kind TEXT NOT NULL, name TEXT, invoker TEXT, correlation_id TEXT, message_id TEXT, model TEXT, stacked INTEGER NOT NULL, interrupted INTEGER NOT NULL, additive INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)")
            seed_columns = {row[1] for row in db.execute("PRAGMA table_info(summary_event_seeds)")}
            if "count" not in seed_columns:
                db.execute("ALTER TABLE summary_event_seeds ADD COLUMN count INTEGER NOT NULL DEFAULT 1")
            db.execute("CREATE TABLE IF NOT EXISTS source_capture_context (source_id TEXT NOT NULL, generation_id TEXT NOT NULL, project_key TEXT, attribution TEXT NOT NULL, PRIMARY KEY(source_id,generation_id))")
            db.execute("CREATE TABLE IF NOT EXISTS body_tombstones (body_id TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT '', pruned_at TEXT NOT NULL, PRIMARY KEY(body_id, harness, session_id, run_id))")
            for part_table in ("tool_parts", "change_parts"):
                part_columns = {row[1] for row in db.execute(f"PRAGMA table_info({part_table})")}
                for column in ("mirror_part_key", "tombstone_body_id"):
                    if column not in part_columns:
                        db.execute(f"ALTER TABLE {part_table} ADD COLUMN {column} TEXT")
            tombstone_columns = {row[1] for row in db.execute("PRAGMA table_info(body_tombstones)").fetchall()}
            if "run_id" not in tombstone_columns:
                db.execute("ALTER TABLE body_tombstones RENAME TO body_tombstones_legacy")
                db.execute("CREATE TABLE body_tombstones (body_id TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT '', pruned_at TEXT NOT NULL, PRIMARY KEY(body_id, harness, session_id, run_id))")
                db.execute("INSERT OR IGNORE INTO body_tombstones(body_id,harness,session_id,run_id,pruned_at) SELECT body_id,harness,session_id,'',pruned_at FROM body_tombstones_legacy")
                db.execute("DROP TABLE body_tombstones_legacy")
            db.execute("CREATE INDEX IF NOT EXISTS tool_parts_retention ON tool_parts(retention_tier, pruned_at)")
            db.execute("CREATE INDEX IF NOT EXISTS change_parts_retention ON change_parts(retention_tier, pruned_at)")
            db.execute("CREATE INDEX IF NOT EXISTS tool_parts_eligibility ON tool_parts(retention_tier, status, evidenced_at, body_id)")
            db.execute("CREATE INDEX IF NOT EXISTS change_parts_eligibility ON change_parts(retention_tier, status, evidenced_at, body_id)")
            # Convert legacy full invocation columns in place. Bodies remain
            # untouched; only the public signature and safe display summary
            # change, so migration never rereads a transcript.
            last_call_id = ""
            while True:
                calls = db.execute(
                    "SELECT call_id,tool_name,operation_signature FROM tool_calls "
                    "WHERE operation_signature IS NOT NULL "
                    "AND call_id>? ORDER BY call_id LIMIT 128",
                    (last_call_id,),
                ).fetchall()
                if not calls:
                    break
                for call in calls:
                    old = str(call["operation_signature"])
                    db.execute("UPDATE tool_calls SET operation_signature=?,operation_summary=? WHERE call_id=?", (operation_hash(old), _safe_operation_summary(str(call["tool_name"]), old), call["call_id"]))
                last_call_id = str(calls[-1]["call_id"])
            db.execute("UPDATE tool_calls SET collision_of=substr(call_id,1,instr(call_id,':collision:')-1) WHERE collision_of IS NULL AND instr(call_id,':collision:') > 0")
            db.execute("UPDATE tool_parts SET retention_tier=CASE WHEN side='result' OR kind='persisted_output_attachment' OR kind='unsupported' OR (side='input' AND call_id IN (SELECT call_id FROM tool_calls WHERE tool_name IN ('Edit','Write','MultiEdit','NotebookEdit','apply_patch'))) THEN 'B' ELSE 'A' END WHERE retention_tier='B'")
            db.execute("UPDATE change_parts SET retention_tier='B'")
            # v1 had no per-part clock. Call/event time is the migration
            # fallback; new captures fill this column from the evidence event.
            db.execute(
                """UPDATE tool_parts SET evidenced_at=COALESCE(
                       evidenced_at,
                       CASE WHEN side='result' THEN (
                           SELECT e.at FROM events e JOIN tool_calls c ON c.call_id=tool_parts.call_id
                            WHERE e.kind='tool_result' AND e.correlation_id=c.native_call_id
                              AND e.source_epoch=c.source_epoch AND e.run_id=c.run_id
                            ORDER BY e.at DESC LIMIT 1
                       ) END,
                       (SELECT at FROM tool_calls WHERE call_id=tool_parts.call_id)
                   ) WHERE evidenced_at IS NULL"""
            )
            db.execute("UPDATE change_parts SET evidenced_at=COALESCE(evidenced_at,(SELECT e.at FROM events e JOIN changes c ON c.source_event_id=e.event_id WHERE c.change_id=change_parts.change_id)) WHERE evidenced_at IS NULL")
            # Legacy A bodies may be larger than the durable input limit. Keep
            # only their prefix in a new content-addressed body. This reads
            # SQLite chunks, never the source transcript.
            last_part: tuple[str, str, int] = ("", "", -1)
            while True:
                parts = db.execute(
                    "SELECT call_id,side,ordinal,body_id FROM tool_parts "
                    "WHERE retention_tier='A' AND body_id IS NOT NULL "
                    "AND (call_id,side,ordinal)>(?,?,?) ORDER BY call_id,side,ordinal LIMIT 128",
                    last_part,
                ).fetchall()
                if not parts:
                    break
                for part in parts:
                    body = db.execute("SELECT total_bytes FROM bodies WHERE body_id=?", (part["body_id"],)).fetchone()
                    if body is None or int(body[0]) <= TIER_A_INPUT_BODY_LIMIT:
                        continue
                    chunks = db.execute(
                        "SELECT substr(bytes,1,?) FROM body_chunks WHERE body_id=? ORDER BY seq",
                        (TIER_A_INPUT_BODY_LIMIT, part["body_id"]),
                    )
                    prefix = bytearray()
                    for chunk in chunks:
                        prefix.extend(chunk[0] or b"")
                        if len(prefix) >= TIER_A_INPUT_BODY_LIMIT:
                            break
                    bounded_prefix = bytes(prefix[:TIER_A_INPUT_BODY_LIMIT])
                    new_id = body_identity(bounded_prefix)
                    db.execute("INSERT OR IGNORE INTO bodies(body_id,status,content_type,total_bytes,pruned_at) SELECT ?, 'truncated', content_type, ?, pruned_at FROM bodies WHERE body_id=?", (new_id, len(bounded_prefix), part["body_id"]))
                    if db.execute("SELECT 1 FROM body_chunks WHERE body_id=? LIMIT 1", (new_id,)).fetchone() is None:
                        for seq in range(0, len(bounded_prefix), CHUNK_BYTES):
                            db.execute("INSERT INTO body_chunks(body_id,seq,bytes) VALUES (?,?,?)", (new_id, seq // CHUNK_BYTES, bounded_prefix[seq : seq + CHUNK_BYTES]))
                    db.execute("UPDATE tool_parts SET body_id=?,bytes=?,status='truncated' WHERE call_id=? AND side=? AND ordinal=?", (new_id, len(bounded_prefix), part["call_id"], part["side"], part["ordinal"]))
                last_part = (str(parts[-1]["call_id"]), str(parts[-1]["side"]), int(parts[-1]["ordinal"]))
            db.execute("DELETE FROM body_chunks WHERE body_id IN (SELECT b.body_id FROM bodies b LEFT JOIN tool_parts p ON p.body_id=b.body_id LEFT JOIN change_parts cp ON cp.body_id=b.body_id WHERE p.body_id IS NULL AND cp.body_id IS NULL)")
            db.execute("DELETE FROM bodies WHERE body_id NOT IN (SELECT body_id FROM tool_parts WHERE body_id IS NOT NULL UNION SELECT body_id FROM change_parts WHERE body_id IS NOT NULL)")
            last_source: tuple[str, str] = ("", "")
            while True:
                sources = db.execute(
                    "SELECT source_id,generation_id,resume_state FROM sources "
                    "WHERE resume_state IS NOT NULL AND resume_state != '' "
                    "AND (source_id,generation_id)>(?,?) ORDER BY source_id,generation_id LIMIT 128",
                    last_source,
                ).fetchall()
                if not sources:
                    break
                for source in sources:
                    cleaned = _sanitize_resume_state(source["resume_state"])
                    if cleaned != source["resume_state"]:
                        db.execute("UPDATE sources SET resume_state=? WHERE source_id=? AND generation_id=?", (cleaned, source["source_id"], source["generation_id"]))
                last_source = (str(sources[-1]["source_id"]), str(sources[-1]["generation_id"]))
            usage_source_versions.install_schema(db)
            usage_publication_reads.install_schema(db)
            usage_summary_projection.install_schema(db)
            for version in db.execute("SELECT publication_id FROM source_versions").fetchall():
                usage_publication_reads.index_publication(db, str(version[0]))
            db.execute(
                "CREATE TABLE IF NOT EXISTS publication_body_authorizations("
                "body_id TEXT NOT NULL,harness TEXT NOT NULL,root_session_id TEXT NOT NULL,"
                "run_id TEXT NOT NULL,source_id TEXT NOT NULL,publication_id TEXT NOT NULL,"
                "PRIMARY KEY(body_id,harness,root_session_id,run_id,source_id,publication_id))"
            )
            db.execute("UPDATE metadata SET value='7' WHERE key='schema_version'")
            # Older development databases used one source row per path and a
            # unique PR index.  Keep them readable while allowing retained
            # source generations and relationship evidence to coexist.
            db.execute("DROP INDEX IF EXISTS prs_repo_num")
            db.commit()
        except Exception:
            db.rollback()
            raise

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "InspectionStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _cursor(self, row: sqlite3.Row | None, source_id: str, fallback: SourceFingerprint | None = None) -> SourceCursor:
        if row is None:
            fp = fallback or SourceFingerprint(None, None, 0, 0, "", "")
            return SourceCursor(source_id, "", 0, 0, fp)
        return SourceCursor(source_id, row["generation_id"], int(row["revision"]), int(row["offset"]), SourceFingerprint(row["device"], row["inode"], row["size"], row["mtime_ns"], row["prefix_sha256"], row["boundary_sha256"]), row["committed_prefix_sha256"], row["committed_boundary_sha256"], row["resume_state"], int(row["resume_version"] or 0), row["reader_id"], int(row["reader_revision"] or 0), int(row["normalization_version"] or 0))

    def source_cursor(self, source_id: str) -> SourceCursor:
        row = self.db.execute("SELECT * FROM sources WHERE source_id=? ORDER BY revision DESC, captured_at DESC LIMIT 1", (source_id,)).fetchone()
        return self._cursor(row, source_id)

    def save_reader_catalog(self, scan_id: str, catalog_json: str, catalog_digest: str) -> None:
        """Persist the immutable Usage catalog before source preflight."""
        existing = self.db.execute(
            "SELECT reader_catalog_json,reader_catalog_digest FROM scan_passes WHERE scan_id=?",
            (scan_id,),
        ).fetchone()
        if existing is not None and (existing[0] or existing[1]):
            if str(existing[0]) != catalog_json or str(existing[1]) != catalog_digest:
                raise InspectionStoreError("reader_catalog_conflict")
            return
        self.db.execute(
            "UPDATE scan_passes SET reader_catalog_json=?,reader_catalog_digest=? WHERE scan_id=?",
            (catalog_json, catalog_digest, scan_id),
        )

    def reader_catalog(self, scan_id: str) -> tuple[str, str] | None:
        row = self.db.execute(
            "SELECT reader_catalog_json,reader_catalog_digest FROM scan_passes WHERE scan_id=?",
            (scan_id,),
        ).fetchone()
        if row is None or not row[0] or not row[1]:
            return None
        return str(row[0]), str(row[1])

    def saved_reader_binding(self, scan_id: str, source_id: str, generation_id: str) -> dict[str, str] | None:
        row = self.db.execute(
            "SELECT schema_version,reader_ref_json,policy_json,recognition_json,catalog_digest "
            "FROM scan_pass_reader_bindings WHERE scan_id=? AND source_id=? AND generation_id=?",
            (scan_id, source_id, generation_id),
        ).fetchone()
        return dict(row) if row is not None else None

    def save_reader_binding(
        self,
        scan_id: str,
        source_id: str,
        generation_id: str,
        schema_version: int,
        reader_ref_json: str,
        policy_json: str,
        recognition_json: str,
        catalog_digest: str,
    ) -> None:
        self.db.execute(
            "INSERT INTO scan_pass_reader_bindings "
            "(scan_id,source_id,generation_id,schema_version,reader_ref_json,policy_json,recognition_json,catalog_digest) "
            "VALUES (?,?,?,?,?,?,?,?) "
            "ON CONFLICT(scan_id,source_id,generation_id) DO NOTHING",
            (scan_id, source_id, generation_id, schema_version, reader_ref_json, policy_json, recognition_json, catalog_digest),
        )
        existing = self.db.execute(
            "SELECT schema_version,reader_ref_json,policy_json,recognition_json,catalog_digest "
            "FROM scan_pass_reader_bindings WHERE scan_id=? AND source_id=? AND generation_id=?",
            (scan_id, source_id, generation_id),
        ).fetchone()
        if existing is None or tuple(existing) != (
            schema_version, reader_ref_json, policy_json, recognition_json, catalog_digest
        ):
            raise InspectionStoreError("reader_binding_conflict")

    def has_reader_binding(self, source_id: str, generation_id: str, binding_digest: str) -> bool:
        """Return whether this exact source epoch has immutable binding evidence."""
        return self.db.execute(
            "SELECT 1 FROM reader_binding_observations "
            "WHERE source_id=? AND generation_id=? AND binding_digest=?",
            (source_id, generation_id, binding_digest),
        ).fetchone() is not None

    @staticmethod
    def _validate_reader_binding(binding: ReaderBinding) -> tuple[str, str, str]:
        """Accept only bundled, path-free reader recognition evidence."""
        try:
            digest = binding.digest()
            policy_json = binding.policy.canonical_json()
            evidence_json = binding.source_evidence.canonical_json()
            policy = json.loads(policy_json)
            evidence = json.loads(evidence_json)
        except (AttributeError, TypeError, ValueError):
            raise InspectionStoreError("invalid_reader_binding") from None
        allowed = {
            ("usage_inspection_claude", "claude-code", "claude-jsonl"),
            ("usage_inspection_codex", "codex", "codex-rollout-jsonl"),
            ("usage_inspection_claude", "unknown_legacy", "unknown_legacy"),
            ("usage_inspection_codex", "unknown_legacy", "unknown_legacy"),
        }
        if (
            not isinstance(digest, str)
            or not digest.startswith("binding:")
            or not isinstance(policy, dict)
            or not isinstance(evidence, dict)
            or (policy.get("reader_id"), evidence.get("producer"), evidence.get("native_format")) not in allowed
            or any(key not in policy for key in (
                "capture_contract_version", "host_contract_version", "reader_id", "reader_revision",
                "normalization_version", "resume_version", "capture_schema_version", "adapter_digest", "parser_version",
            ))
            or set(evidence) != {"format_fingerprint", "native_format", "producer"}
            or not isinstance(evidence.get("format_fingerprint"), str)
            or len(evidence["format_fingerprint"]) > 128
            or not re.fullmatch(r"[0-9a-f]{64}", evidence["format_fingerprint"])
            or any(
                not isinstance(policy.get(key), int)
                or isinstance(policy.get(key), bool)
                or not 1 <= policy[key] <= 1_000_000
                for key in (
                    "capture_contract_version", "host_contract_version", "reader_revision",
                    "normalization_version", "resume_version", "capture_schema_version", "parser_version",
                )
            )
            or policy["capture_contract_version"] != 1
            or policy["host_contract_version"] != 1
            or not isinstance(policy.get("adapter_digest"), (str, type(None)))
            or (isinstance(policy.get("adapter_digest"), str) and not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", policy["adapter_digest"]))
        ):
            raise InspectionStoreError("invalid_reader_binding")
        return digest, policy_json, evidence_json

    def _persist_reader_binding(self, source_id: str, generation_id: str, binding: ReaderBinding) -> None:
        digest, policy_json, evidence_json = self._validate_reader_binding(binding)
        self.db.execute(
            "INSERT INTO reader_policies(binding_digest,policy_json) VALUES (?,?) ON CONFLICT(binding_digest) DO NOTHING",
            (digest, policy_json),
        )
        policy_row = self.db.execute("SELECT policy_json FROM reader_policies WHERE binding_digest=?", (digest,)).fetchone()
        if policy_row is None or str(policy_row[0]) != policy_json:
            raise InspectionStoreError("reader_policy_conflict")
        self.db.execute(
            "INSERT INTO reader_binding_observations(source_id,generation_id,binding_digest,source_evidence_json) VALUES (?,?,?,?) ON CONFLICT(source_id,generation_id,binding_digest) DO NOTHING",
            (source_id, generation_id, digest, evidence_json),
        )
        observed = self.db.execute(
            "SELECT source_evidence_json FROM reader_binding_observations WHERE source_id=? AND generation_id=? AND binding_digest=?",
            (source_id, generation_id, digest),
        ).fetchone()
        if observed is None or str(observed[0]) != evidence_json:
            raise InspectionStoreError("reader_binding_conflict")

    @staticmethod
    def _identity_id(*parts: str) -> str:
        return "identity:" + hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]

    def _normalize_batch(self, batch: CaptureBatch, *, persist: bool = False) -> CaptureBatch:
        """Bind native children to source-specific observations without rewriting old IDs."""
        run_ids: dict[str, str] = {}
        session_ids: dict[str, str] = {}
        members: list[tuple[str, str, str, str, str, str]] = []
        for run in batch.runs:
            ref = run.native_ref
            if ref is None:
                run_ids[run.run_id] = run.run_id
                continue
            if ref.root_session_id != batch.root.root_session_id or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,119}", ref.native_id) or ref.origin not in {"source", "inline_sidechain"}:
                raise InspectionStoreError("invalid_native_identity")
            logical = self._identity_id(batch.root.harness, ref.root_session_id, ref.native_id)
            assigned = self.db.execute("SELECT physical_run_id FROM run_members WHERE logical_id=? AND source_id=?", (logical, batch.source.source_id)).fetchone()
            physical = str(assigned[0]) if assigned else self._identity_id(logical, batch.source.source_id)
            if assigned is None:
                legacy = self.db.execute("SELECT * FROM runs WHERE run_id=? AND harness=?", (run.run_id, batch.root.harness)).fetchone()
                occupied = self.db.execute("SELECT 1 FROM run_members WHERE physical_run_id=?", (run.run_id,)).fetchone()
                if legacy is not None and occupied is None and legacy["parent_run_id"] == run.parent_run_id:
                    # Parent labels alone cannot prove ownership: old short IDs
                    # could have been overwritten by a different root/source.
                    epochs = self.db.execute(
                        "SELECT source_epoch FROM token_samples WHERE run_id=? UNION SELECT source_epoch FROM tool_calls WHERE run_id=? "
                        "UNION SELECT source_epoch FROM events WHERE run_id=? UNION SELECT source_epoch FROM changes WHERE run_id=?",
                        (run.run_id,) * 4,
                    ).fetchall()
                    owners: set[str] = set()
                    for epoch in epochs:
                        owners.update(str(row[0]) for row in self.db.execute("SELECT source_id FROM sources WHERE generation_id=? AND harness=?", (epoch[0], batch.root.harness)))
                    if owners == {batch.source.source_id}:
                        physical = run.run_id
                    elif persist:
                        self.db.execute("INSERT OR IGNORE INTO identity_issues VALUES (?,?,?)", (batch.root.harness, run.run_id, "identity_ambiguous"))
            run_ids[run.run_id] = physical
            session_ids[run.run_id] = self._identity_id("source-session", logical, batch.source.source_id)
            members.append((logical, physical, batch.root.harness, ref.root_session_id, batch.source.source_id, ref.origin))
        if persist:
            for member in members:
                existing = self.db.execute("SELECT logical_id,source_id FROM run_members WHERE physical_run_id=?", (member[1],)).fetchone()
                if existing is not None and tuple(existing) != (member[0], member[4]):
                    raise InspectionStoreError("identity_ambiguous")
                self.db.execute("INSERT INTO run_members VALUES (?,?,?,?,?,?,?) ON CONFLICT(physical_run_id) DO UPDATE SET captured_revision=excluded.captured_revision", (*member, self.canonical_revision() + 1))
            for run in batch.runs:
                if run.run_id in session_ids:
                    status = "available" if batch.source.status == "active" else ("partial" if batch.source.status == "incomplete" else "unavailable")
                    self.db.execute("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?)", (batch.root.harness, session_ids[run.run_id], batch.root.root_session_id, batch.root.root_session_id, "child", status, batch.captured_at))

        def remap(value: str | None) -> str | None:
            return run_ids.get(value, value) if value is not None else None

        calls = {tool.call_id: (self._identity_id("call", run_ids.get(tool.run_id, tool.run_id), tool.call_id) if run_ids.get(tool.run_id, tool.run_id) != tool.run_id else tool.call_id) for tool in batch.tool_calls}
        runs = tuple(replace(run, run_id=remap(run.run_id) or run.run_id, parent_run_id=remap(run.parent_run_id), source_session_id=session_ids.get(run.run_id, run.source_session_id), native_run_id=run.native_ref.native_id if run.native_ref else run.native_run_id) for run in batch.runs)
        samples = tuple(replace(sample, run_id=remap(sample.run_id) or sample.run_id, sample_id=self._identity_id(run_ids[sample.run_id], sample.native_sample_key) if run_ids.get(sample.run_id, sample.run_id) != sample.run_id and sample.native_sample_key else sample.sample_id) for sample in batch.token_samples)
        tools = tuple(replace(tool, run_id=remap(tool.run_id) or tool.run_id, call_id=calls[tool.call_id], child_run_id=remap(tool.child_run_id)) for tool in batch.tool_calls)
        events = tuple(replace(event, run_id=remap(event.run_id)) for event in batch.events)
        messages = tuple(replace(message, run_id=remap(message.run_id) or message.run_id) for message in batch.messages)
        seeds = tuple(replace(seed, run_id=remap(seed.run_id) or seed.run_id, message_id=(self._identity_id("message", run_ids.get(seed.run_id, seed.run_id), seed.message_id) if seed.message_id and run_ids.get(seed.run_id, seed.run_id) != seed.run_id else seed.message_id)) for seed in batch.event_seeds)
        message_ids = {message.message_id: (self._identity_id("message", run_ids.get(message.run_id, message.run_id), message.message_id) if run_ids.get(message.run_id, message.run_id) != message.run_id else message.message_id) for message in batch.messages}
        messages = tuple(replace(message, message_id=message_ids[message.message_id]) for message in messages)
        seeds = tuple(
            replace(seed, message_id=message_ids.get(seed.message_id, seed.message_id))
            if seed.message_id is not None
            else seed
            for seed in seeds
        )
        relationships = tuple(replace(rel, from_run_id=remap(rel.from_run_id) or rel.from_run_id, to_run_id=remap(rel.to_run_id)) for rel in batch.relationships)
        changes = tuple(replace(change, run_id=remap(change.run_id) or change.run_id, tool_call_id=calls.get(change.tool_call_id, change.tool_call_id) if change.tool_call_id else None) for change in batch.changes)
        dedicated = next((run for run in batch.runs if run.native_ref and run.native_ref.origin == "source" and run.source_session_id == batch.source.source_session_id), None)
        root, source = batch.root, batch.source
        if dedicated is not None:
            key = session_ids[dedicated.run_id]
            root = replace(root, source_session_id=key)
            source = replace(source, source_session_id=key)
        return replace(batch, root=root, source=source, runs=runs, token_samples=samples, tool_calls=tools, events=events, relationships=relationships, changes=changes, messages=messages, event_seeds=seeds)

    def merge_capture(self, batch: CaptureBatch) -> MergeResult:
        if batch.source.reader_binding is not None:
            binding = batch.source.reader_binding
            self._validate_reader_binding(binding)
            policy = binding.policy
            source = batch.source
            if (
                policy.reader_id != source.reader_id
                or policy.reader_revision != source.reader_revision
                or policy.normalization_version != source.normalization_version
                or policy.resume_version != source.resume_version
                or policy.parser_version != source.parser_version
                or policy.capture_schema_version != batch.schema_version
                or binding.source_evidence != source.reader_source_evidence
                or binding.source_evidence.producer not in {source.harness, "unknown_legacy"}
            ):
                raise InspectionStoreError("reader_binding_mismatch")
        native_batch = batch
        batch = self._normalize_batch(batch)
        source = batch.source
        # A source path can have several retained generations.  Compare the
        # incoming cursor with the latest generation so an append after a
        # replacement can converge instead of retrying against an old row.
        row = self.db.execute(
            "SELECT * FROM sources WHERE source_id=? "
            "ORDER BY revision DESC, captured_at DESC, rowid DESC LIMIT 1",
            (source.source_id,),
        ).fetchone()
        current = self._cursor(row, source.source_id, source.fingerprint)
        if row is not None and current.revision != source.expected_revision:
            return MergeResult("retry_required", self.canonical_revision(), batch.root.root_session_id, current)
        if (
            row is not None
            and source.generation_id == current.generation_id
            and source.offset_end <= current.offset
            and _fingerprint(source.fingerprint) == _fingerprint(current.fingerprint)
            and int(row["parser_version"] or 1) == source.parser_version
            and int(row["resume_version"] or 0) == source.resume_version
            and int(row["reader_revision"] or 0) == source.reader_revision
            and int(row["normalization_version"] or 0) == source.normalization_version
            and str(row["source_session_id"]) == source.source_session_id
            and str(row["status"]) == source.status
            and (
                not source.reader_id
                or load_resume_state(
                    current, reader_id=source.reader_id,
                    reader_revision=source.reader_revision,
                    normalization_version=source.normalization_version,
                ) is not None
            )
            and not self._batch_has_new_body(batch)
            and (
                source.reader_binding is None
                or self.db.execute(
                    "SELECT 1 FROM source_heads h JOIN source_versions v "
                    "ON v.publication_id=h.publication_id "
                    "WHERE h.source_id=? AND v.generation_id=? "
                    "AND v.binding_digest=? AND v.state='complete'",
                    (source.source_id, source.generation_id, source.reader_binding.digest()),
                ).fetchone() is not None
            )
        ):
            return MergeResult("unchanged", self.canonical_revision(), batch.root.root_session_id, current)
        before = self.canonical_revision()
        try:
            self.db.execute("BEGIN IMMEDIATE")
            batch = self._normalize_batch(native_batch, persist=True)
            source = batch.source
            if (
                row is not None
                and row["generation_id"] == source.generation_id
                and (
                    int(row["parser_version"] or 1) != source.parser_version
                    or str(row["source_session_id"]) != source.source_session_id
                )
            ):
                self._repair_source_attribution(batch)
            if batch.root.parent_session_id and batch.root.root_session_id != batch.root.source_session_id:
                self.db.execute("INSERT OR IGNORE INTO sessions(harness,session_id,root_session_id,parent_session_id,state,status,captured_at) VALUES (?,?,?,?,?,?,?)", (batch.root.harness, batch.root.root_session_id, batch.root.root_session_id, None, "orphan", "unavailable", batch.captured_at))
            session_status = "partial" if source.status == "incomplete" else ("unavailable" if source.status == "unavailable" else "available")
            self.db.execute("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?)", (batch.root.harness, batch.root.source_session_id, batch.root.root_session_id, batch.root.parent_session_id, batch.root.state, session_status, batch.captured_at))
            source_values = (source.source_id, source.harness, source.source_session_id, source.generation_id, source.expected_revision + 1, source.offset_end, *(_fingerprint(source.fingerprint)), source.status, batch.captured_at, source.parser_version, source.committed_prefix_sha256, source.committed_boundary_sha256, source.resume_state, source.resume_version, source.reader_id, source.reader_revision, source.normalization_version)
            if row is not None and row["generation_id"] == source.generation_id:
                self.db.execute("UPDATE sources SET harness=?,source_session_id=?,revision=?,offset=?,device=?,inode=?,size=?,mtime_ns=?,prefix_sha256=?,boundary_sha256=?,status=?,captured_at=?,parser_version=?,committed_prefix_sha256=?,committed_boundary_sha256=?,resume_state=?,resume_version=?,reader_id=?,reader_revision=?,normalization_version=? WHERE source_id=? AND generation_id=?", (source.harness, source.source_session_id, source.expected_revision + 1, source.offset_end, *(_fingerprint(source.fingerprint)), source.status, batch.captured_at, source.parser_version, source.committed_prefix_sha256, source.committed_boundary_sha256, source.resume_state, source.resume_version, source.reader_id, source.reader_revision, source.normalization_version, source.source_id, source.generation_id))
            else:
                self.db.execute("INSERT INTO sources(source_id,harness,source_session_id,generation_id,revision,offset,device,inode,size,mtime_ns,prefix_sha256,boundary_sha256,status,captured_at,parser_version,committed_prefix_sha256,committed_boundary_sha256,resume_state,resume_version,reader_id,reader_revision,normalization_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", source_values)
            if source.reader_binding is not None:
                self._persist_reader_binding(source.source_id, source.generation_id, source.reader_binding)
            self.db.execute("INSERT INTO source_capture_context VALUES (?,?,?,?) ON CONFLICT(source_id,generation_id) DO UPDATE SET project_key=excluded.project_key,attribution=excluded.attribution", (source.source_id, source.generation_id, source.project_key, source.project_attribution))
            call_ids = {tool.call_id: self._call_key(tool) for tool in batch.tool_calls}
            for run in batch.runs:
                prior = self.db.execute("SELECT parent_run_id,models,started_at,ended_at,locations,native_facts FROM runs WHERE run_id=?", (run.run_id,)).fetchone()
                old_locations = json.loads(prior[4]) if prior and prior[4] else []
                locations = list(old_locations)
                for location in run.locations:
                    if location not in locations:
                        locations.append(location)
                old_models = json.loads(prior[1]) if prior and prior[1] else []
                models = tuple(sorted(set(str(value) for value in old_models) | set(run.models)))
                started = min((value for value in (prior[2] if prior else None, run.started_at) if value), default=None)
                ended = max((value for value in (prior[3] if prior else None, run.ended_at) if value), default=None)
                parent_run_id = run.parent_run_id or (prior[0] if prior else None)
                old_facts = json.loads(prior[5]) if prior and prior[5] else {}
                incoming = {
                    "lines_added": run.native_lines_added if isinstance(run.native_lines_added, int) and not isinstance(run.native_lines_added, bool) and run.native_lines_added >= 0 else None,
                    "lines_removed": run.native_lines_removed if isinstance(run.native_lines_removed, int) and not isinstance(run.native_lines_removed, bool) and run.native_lines_removed >= 0 else None,
                    "duration_ms": run.native_duration_ms if isinstance(run.native_duration_ms, int) and not isinstance(run.native_duration_ms, bool) and run.native_duration_ms >= 0 else None,
                    "branch": run.native_branch if isinstance(run.native_branch, str) else None,
                }
                facts = {key: value for key, value in old_facts.items() if value is not None}
                facts.update({key: value for key, value in incoming.items() if value is not None})
                # Keep the last capture's completeness after source disappearance.
                # An inferred child run is not proof that its own source was read.
                if source.status in {"incomplete", "unavailable"} and run.source_session_id == source.source_session_id:
                    facts["tool_capture_complete"] = False
                elif (source.reader_id and source.reader_revision >= 4
                      and run.source_session_id == source.source_session_id):
                    facts["tool_capture_complete"] = source.status == "active"
                self.db.execute("INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)", (run.run_id, batch.root.harness, run.source_session_id, run.native_run_id, parent_run_id, run.role, _json(models), started, ended, _json(locations), _json(facts)))
            for sample in batch.token_samples:
                self.db.execute("INSERT OR REPLACE INTO token_samples(run_id,sample_id,model,input,output,cache_creation,cache_read,cumulative,epoch_marker,at,total,source_epoch,parser_version,origin,source_ordinal,block_ordinal,role_ordinal,first_turn_input_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (sample.run_id, sample.sample_id, sample.model, sample.input, sample.output, sample.cache_creation, sample.cache_read, int(sample.cumulative), int(sample.epoch_marker), sample.at, sample.total, source.generation_id, source.parser_version, sample.origin, sample.source_ordinal, sample.block_ordinal, sample.role_ordinal, sample.first_turn_input_total))
            for tool in batch.tool_calls:
                call_id = call_ids[tool.call_id]
                evidence = ["collision"] if call_id != tool.call_id else []
                raw_signature = tool.operation_signature
                signature = operation_hash(raw_signature, already_hashed=tool.operation_signature_hashed)
                summary = tool.operation_summary
                if summary is None:
                    summary = _safe_operation_summary(tool.tool_name, raw_signature) if tool.tool_name in {"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"} else (tool.tool_name if raw_signature is not None and raw_signature.startswith("op:") else capture_operation_summary(tool.tool_name, raw_signature))
                if summary is not None:
                    summary = str(summary)[:200]
                self.db.execute("INSERT INTO tool_calls(call_id,run_id,native_call_id,at,tool_name,tool_kind,operation_signature,operation_summary,collision_of,execution,source_epoch,evidence,source_ordinal,block_ordinal,role_ordinal,activity_class,skill_key,invocation_origin,read_file_hash,edit_file_hash,mcp_server,mcp_tool,child_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET run_id=excluded.run_id,native_call_id=excluded.native_call_id,at=excluded.at,tool_name=excluded.tool_name,tool_kind=excluded.tool_kind,operation_signature=excluded.operation_signature,operation_summary=COALESCE(excluded.operation_summary,tool_calls.operation_summary),execution=excluded.execution,source_epoch=excluded.source_epoch,evidence=excluded.evidence,source_ordinal=excluded.source_ordinal,block_ordinal=excluded.block_ordinal,role_ordinal=excluded.role_ordinal,activity_class=COALESCE(excluded.activity_class,tool_calls.activity_class),skill_key=COALESCE(excluded.skill_key,tool_calls.skill_key),invocation_origin=COALESCE(excluded.invocation_origin,tool_calls.invocation_origin),read_file_hash=COALESCE(excluded.read_file_hash,tool_calls.read_file_hash),edit_file_hash=COALESCE(excluded.edit_file_hash,tool_calls.edit_file_hash),mcp_server=COALESCE(excluded.mcp_server,tool_calls.mcp_server),mcp_tool=COALESCE(excluded.mcp_tool,tool_calls.mcp_tool),child_run_id=COALESCE(excluded.child_run_id,tool_calls.child_run_id)", (call_id, tool.run_id, tool.native_call_id, tool.at, tool.tool_name, tool.tool_kind, signature, summary, tool.call_id if call_id != tool.call_id else None, tool.execution, source.generation_id, _json(evidence), tool.source_ordinal, tool.block_ordinal, tool.role_ordinal, tool.activity_class, tool.skill_key, tool.invocation_origin, tool.read_file_hash, tool.edit_file_hash, tool.mcp_server, tool.mcp_tool, tool.child_run_id))
                event_times = {(event.kind, event.correlation_id): event.at for event in batch.events if event.at}
                for side, parts in (("input", tool.input_parts), ("result", tool.result_parts)):
                    for ordinal, part in enumerate(parts):
                        evidence_at = tool.at if side == "input" else event_times.get(("tool_result", tool.native_call_id), tool.at)
                        self._insert_preserving_part("tool_parts", call_id, side, ordinal, bounded_body(part) if retention_tier(tool.tool_name, side, part.kind) == "A" else part, source.generation_id, retention_tier(tool.tool_name, side, part.kind), evidence_at)
            for event in batch.events:
                self.db.execute("INSERT OR REPLACE INTO events(event_id,source_epoch,source_record_id,at,kind,payload_hash,run_id,correlation_id,source_ordinal,block_ordinal,role_ordinal) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (event.event_id, event.source_epoch, event.source_record_id, event.at, event.kind, event.payload_hash, event.run_id, event.correlation_id, event.source_ordinal, event.block_ordinal, event.role_ordinal))
            for message in batch.messages:
                self.db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id,source_epoch) DO NOTHING", (message.message_id, message.source_epoch, message.run_id, message.source_ordinal, message.block_ordinal, message.role_ordinal, message.at, message.role, message.kind, message.text_len, message.thinking_len, int(message.is_steering), message.slash_command, message.excerpt, message.first_turn_input_total, int(message.stacked), int(message.interrupted), int(message.synthetic), message.native_kind))
            for seed in batch.event_seeds:
                self.db.execute("INSERT INTO summary_event_seeds VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING", (seed.event_id, seed.run_id, seed.source_epoch, seed.source_ordinal, seed.block_ordinal, seed.role_ordinal, seed.at, seed.kind, seed.name, seed.invoker, seed.correlation_id, seed.message_id, seed.model, int(seed.stacked), int(seed.interrupted), int(seed.additive), seed.count))
            for relation in batch.relationships:
                self.db.execute("INSERT OR REPLACE INTO relationships VALUES (?,?,?,?,?,?,?,?)", (relation.relationship_id, relation.source_epoch, relation.source_event_id, relation.from_run_id, relation.to_run_id, relation.kind, relation.at, relation.status))
            for change in batch.changes:
                physical_call_id = call_ids.get(change.tool_call_id) if change.tool_call_id else None
                self.db.execute("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(change_id) DO UPDATE SET run_id=excluded.run_id,source_epoch=excluded.source_epoch,source_event_id=excluded.source_event_id,tool_call_id=excluded.tool_call_id,kind=excluded.kind,attribution=excluded.attribution,repository_id=excluded.repository_id,revision_id=excluded.revision_id,base_id=excluded.base_id,merge_base_id=excluded.merge_base_id,files=excluded.files", (change.change_id, change.run_id, change.source_epoch, change.source_event_id, physical_call_id, change.kind, change.attribution, change.repository_id, change.revision_id, change.base_id, change.merge_base_id, _json(change.files)))
                for ordinal, part in enumerate(change.body_parts):
                    change_event = next((candidate for candidate in batch.events if candidate.event_id == change.source_event_id), None)
                    self._insert_preserving_part("change_parts", change.change_id, None, ordinal, part, change.source_epoch, "B", change_event.at if change_event else None)
            for pr in batch.prs:
                old = self.db.execute("SELECT first_seen FROM prs WHERE pr_id=?", (pr.pr_id,)).fetchone()
                self.db.execute("INSERT OR REPLACE INTO prs VALUES (?,?,?,?,?,?,?,?,?)", (pr.pr_id, pr.source_epoch, pr.source_event_id, pr.repository_id, pr.number, pr.url, pr.relationship, pr.evidenced_at, old[0] if old else (pr.evidenced_at or batch.captured_at)))
            part_refs: dict[str, dict[str, Any]] = {}
            for tool in batch.tool_calls:
                call_id = call_ids[tool.call_id]
                for side, parts in (("input", tool.input_parts), ("result", tool.result_parts)):
                    for ordinal, part in enumerate(parts):
                        row = self.db.execute(
                            "SELECT ordinal,part_id,kind,status,content_type,body_id,bytes,retention_tier,"
                            "pruned_at,evidenced_at,source_locator,source_epoch,retained_version,"
                            "tombstone_body_id,mirror_part_key FROM tool_parts "
                            "WHERE call_id=? AND side=? AND (part_id=? OR (? IS NOT NULL AND source_locator=?)) "
                            "ORDER BY retained_version,ordinal DESC LIMIT 1",
                            (call_id, side, part.part_id, part.source_locator, part.source_locator),
                        ).fetchone()
                        if row is not None:
                            part_refs[f"{call_id}:{side}:{ordinal}"] = {**dict(row), "run_id": tool.run_id}
            for change in batch.changes:
                for ordinal, part in enumerate(change.body_parts):
                    row = self.db.execute(
                        "SELECT ordinal,part_id,kind,status,content_type,body_id,bytes,retention_tier,"
                        "pruned_at,evidenced_at,source_locator,source_epoch,retained_version,"
                        "tombstone_body_id,mirror_part_key FROM change_parts "
                        "WHERE change_id=? AND (part_id=? OR (? IS NOT NULL AND source_locator=?)) "
                        "ORDER BY retained_version,ordinal DESC LIMIT 1",
                        (change.change_id, part.part_id, part.source_locator, part.source_locator),
                    ).fetchone()
                    if row is not None:
                        part_refs[f"{change.change_id}:change:{ordinal}"] = {**dict(row), "run_id": change.run_id}
            membership = {}
            for run in batch.runs:
                for physical in (run.run_id, run.parent_run_id):
                    if physical is not None:
                        member = self.db.execute(
                            "SELECT logical_id,origin FROM run_members WHERE physical_run_id=?", (physical,)
                        ).fetchone()
                        if member is not None:
                            membership[physical] = dict(member)
            publication = usage_publication.stage_capture(
                self.db, batch, usage_publication.capture_facts(
                    batch, call_ids=call_ids, part_refs=part_refs, run_members=membership
                )
            )
            if publication.publication_id is not None:
                for auth_ref in part_refs.values():
                    body_id = auth_ref.get("body_id")
                    if body_id:
                        self.db.execute(
                            "INSERT OR IGNORE INTO publication_body_authorizations "
                            "VALUES (?,?,?,?,?,?)",
                            (
                                body_id, batch.root.harness, batch.root.root_session_id, str(auth_ref["run_id"]),
                                batch.source.source_id, publication.publication_id,
                            ),
                        )
            if batch.source.reader_binding is not None and source.status == "active" and not publication.published:
                raise InspectionStoreError("publication_stale")
            self._repair_hierarchy(batch.root.harness)
            revision = before + 1 if (publication.published or batch.source.reader_binding is None) else before
            if revision != before:
                self.db.execute("UPDATE metadata SET value=? WHERE key='canonical_revision'", (str(revision),))
            self.db.execute("COMMIT")
            outcome: Literal["captured", "incomplete"] = "incomplete" if source.status == "incomplete" else "captured"
            return MergeResult(outcome, revision, batch.root.root_session_id, self.source_cursor(source.source_id), bytes_read=max(0, source.offset_end - source.offset_start))
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def _repair_source_attribution(self, batch: CaptureBatch) -> None:
        """Move only this source's observed calls. Preserve IDs, parts and pins.

        Legacy Codex samples lack source provenance and can share a real parent
        run. Keep them as evidence; _run_tokens excludes that legacy projection.
        The adapter preserves v1 call identities while correcting ownership.
        """
        for tool in batch.tool_calls:
            self.db.execute(
                "UPDATE tool_calls SET run_id=? WHERE call_id=? AND source_epoch=?",
                (tool.run_id, tool.call_id, batch.source.generation_id),
            )
        # V1 Codex captures could attribute a fork's token sample to the
        # parent run.  The source generation is the durable boundary for this
        # repair; move only legacy samples from that generation to the run
        # emitted by the current source.  Native samples from other sources
        # remain untouched.
        run_ids = {run.run_id for run in batch.runs} | {sample.run_id for sample in batch.token_samples}
        if len(run_ids) == 1:
            run_id = next(iter(run_ids))
            self.db.execute(
                "UPDATE token_samples SET run_id=? WHERE source_epoch=? AND parser_version < 2 AND run_id != ?",
                (run_id, batch.source.generation_id, run_id),
            )
            if not batch.tool_calls:
                self.db.execute(
                    "UPDATE tool_calls SET run_id=? WHERE source_epoch=? AND run_id != ?",
                    (run_id, batch.source.generation_id, run_id),
                )

    def _repair_hierarchy(self, harness: str) -> None:
        """Resolve roots from all retained parent edges after each merge.

        Adapters see one source at a time, while Codex can deliver a grandchild
        before its parent.  Recomputing the small session graph makes orphan
        and cycle states converge when the missing source appears later.
        """
        rows = self.db.execute("SELECT session_id,parent_session_id,status FROM sessions WHERE harness=?", (harness,)).fetchall()
        parents = {str(row["session_id"]): row["parent_session_id"] for row in rows}
        statuses = {str(row["session_id"]): str(row["status"]) for row in rows}
        for session_id in parents:
            current = session_id
            chain: list[str] = []
            state = "root"
            while parents.get(current):
                if current in chain:
                    state = "cycle"
                    cycle = chain[chain.index(current):]
                    root = min(cycle)
                    break
                chain.append(current)
                parent = str(parents[current])
                if parent not in parents:
                    state = "orphan"
                    root = parent
                    break
                current = parent
            else:
                root = current
            prior_status = statuses.get(session_id, "unavailable")
            source_states = [str(item[0]) for item in self.db.execute("SELECT status FROM sources WHERE harness=? AND source_session_id=?", (harness, session_id)).fetchall()]
            if "incomplete" in source_states:
                status = "partial"
            elif "active" in source_states:
                status = "available"
            elif "unavailable" in source_states:
                status = "unavailable"
            else:
                status = prior_status if prior_status in {"partial", "unavailable"} else ("available" if state == "root" else "unavailable")
            self.db.execute("UPDATE sessions SET root_session_id=?,state=?,status=? WHERE harness=? AND session_id=?", (root, state, status, harness, session_id))

    def _call_key(self, tool: Any) -> str:
        signature = operation_hash(tool.operation_signature, already_hashed=tool.operation_signature_hashed)
        expected = (tool.run_id, tool.tool_name, tool.tool_kind, signature)
        row = self.db.execute("SELECT call_id,run_id,tool_name,tool_kind,operation_signature FROM tool_calls WHERE call_id=?", (tool.call_id,)).fetchone()
        native_rows = self.db.execute("SELECT call_id,run_id,tool_name,tool_kind,operation_signature FROM tool_calls WHERE run_id=? AND native_call_id=? ORDER BY rowid", (tool.run_id, tool.native_call_id)).fetchall()
        existing_rows = (*native_rows, row) if row is not None else tuple(native_rows)
        for existing in existing_rows:
            if tuple(existing[1:]) == expected:
                return str(existing[0])
        # Collision IDs created before migration used the old full signature
        # in their suffix. Reuse the row by its durable base and hash instead
        # of minting a second row after the signature migration.
        existing_collision = self.db.execute(
            "SELECT call_id FROM tool_calls WHERE collision_of=? AND run_id=? AND tool_name=? AND tool_kind=? AND operation_signature=? ORDER BY rowid LIMIT 1",
            (tool.call_id, tool.run_id, tool.tool_name, tool.tool_kind, signature),
        ).fetchone()
        if existing_collision is not None:
            return str(existing_collision[0])
        if native_rows or row is not None:
            digest = hashlib.sha256(_json((tool.tool_name, tool.tool_kind, signature)).encode("utf-8")).hexdigest()[:16]
            return f"{tool.call_id}:collision:{digest}"
        return tool.call_id

    def _batch_has_new_body(self, batch: CaptureBatch) -> bool:
        for tool in batch.tool_calls:
            call_id = self._call_key(tool)
            for side, parts in (("input", tool.input_parts), ("result", tool.result_parts)):
                for part in parts:
                    if not self._part_is_current("tool_parts", call_id, side, part):
                        return True
        for change in batch.changes:
            for ordinal, part in enumerate(change.body_parts):
                if not self._part_is_current("change_parts", change.change_id, None, part, ordinal):
                    return True
        return False

    def _part_is_current(self, table: str, key: str, side: str | None, part: BodyPartInput, ordinal: int | None = None) -> bool:
        """Return whether this logical part already has the current body."""
        if table == "tool_parts":
            rows = self.db.execute(
                "SELECT part_id,source_locator,body_id,retained_version,status FROM tool_parts WHERE call_id=? AND side=?",
                (key, side),
            ).fetchall()
        else:
            rows = self.db.execute(
                "SELECT part_id,source_locator,body_id,retained_version,status FROM change_parts WHERE change_id=?",
                (key,),
            ).fetchall()
        body_id = body_identity(part.bytes_value) if part.bytes_value is not None and part.status not in ("unavailable", "unsupported") else None
        return any(
            row["retained_version"] == 0
            and (
                row["part_id"] == part.part_id
                or (part.source_locator is not None and row["source_locator"] == part.source_locator)
                or (table == "change_parts" and ordinal is not None and int(row["ordinal"]) == ordinal)
            )
            and (row["status"] == "pruned" or row["body_id"] == body_id)
            for row in rows
        )

    def _store_part(self, part: BodyPartInput) -> str | None:
        if part.bytes_value is None or part.status in ("unavailable", "unsupported"):
            return None
        body_id = body_identity(part.bytes_value)
        self.db.execute("INSERT OR IGNORE INTO bodies(body_id,status,content_type,total_bytes,pruned_at) VALUES (?,?,?,?,NULL)", (body_id, part.status, part.content_type, len(part.bytes_value)))
        if self.db.execute("SELECT 1 FROM body_chunks WHERE body_id=? LIMIT 1", (body_id,)).fetchone() is None:
            for seq in range(0, len(part.bytes_value), CHUNK_BYTES):
                self.db.execute("INSERT INTO body_chunks VALUES (?,?,?)", (body_id, seq // CHUNK_BYTES, part.bytes_value[seq : seq + CHUNK_BYTES]))
        return body_id

    def _retention_issue(self, call_id: str) -> None:
        self.db.execute("INSERT OR IGNORE INTO identity_issues SELECT r.harness,r.run_id,'retention_unbridged' FROM runs r JOIN tool_calls c ON c.run_id=r.run_id WHERE c.call_id=?", (call_id,))

    def _mirror_retention(self, call_id: str, side: str | None, part: BodyPartInput, body_id: str | None) -> tuple[str | None, str | None]:
        if body_id is None:
            return None, None
        rows = self.db.execute(
            "SELECT p.mirror_part_key,p.tombstone_body_id,p.pruned_at FROM tool_calls current "
            "JOIN run_members cm ON cm.physical_run_id=current.run_id "
            "JOIN run_members om ON om.logical_id=cm.logical_id "
            "JOIN tool_calls old ON old.run_id=om.physical_run_id "
            "JOIN tool_parts p ON p.call_id=old.call_id "
            "WHERE current.call_id=? AND old.native_call_id=current.native_call_id "
            "AND old.tool_name=current.tool_name AND old.tool_kind=current.tool_kind "
            "AND old.operation_signature IS current.operation_signature "
            "AND p.side=? AND p.kind=? AND p.status='pruned'",
            (call_id, side, part.kind),
        ).fetchall()
        for row in rows:
            if part.mirror_part_key and row[0] == part.mirror_part_key and row[1] == body_id:
                return "pruned", row[2]
        if rows and (part.mirror_part_key is None or any(row[0] is None or (row[0] == part.mirror_part_key and row[1] is None) for row in rows)):
            self._retention_issue(call_id)
            return "unavailable", None
        return None, None

    def _change_mirror_retention(self, change_id: str, part: BodyPartInput, body_id: str | None) -> tuple[str | None, str | None]:
        if body_id is None:
            return None, None
        rows = self.db.execute(
            "SELECT p.mirror_part_key,p.tombstone_body_id,p.pruned_at FROM changes current "
            "JOIN run_members cm ON cm.physical_run_id=current.run_id "
            "JOIN run_members om ON om.logical_id=cm.logical_id "
            "JOIN changes old ON old.run_id=om.physical_run_id AND old.kind=current.kind "
            "JOIN change_parts p ON p.change_id=old.change_id "
            "LEFT JOIN tool_calls ct ON ct.call_id=current.tool_call_id "
            "LEFT JOIN tool_calls ot ON ot.call_id=old.tool_call_id "
            "WHERE current.change_id=? AND p.kind=? AND p.status='pruned' "
            "AND ((current.tool_call_id IS NULL AND old.tool_call_id IS NULL) OR "
            "(ct.native_call_id=ot.native_call_id AND ct.tool_name=ot.tool_name AND ct.tool_kind=ot.tool_kind "
            "AND ct.operation_signature IS ot.operation_signature))",
            (change_id, part.kind),
        ).fetchall()
        for row in rows:
            if part.mirror_part_key and row[0] == part.mirror_part_key and row[1] == body_id:
                return "pruned", row[2]
        if rows and (part.mirror_part_key is None or any(row[0] is None or (row[0] == part.mirror_part_key and row[1] is None) for row in rows)):
            self.db.execute("INSERT OR IGNORE INTO identity_issues SELECT r.harness,r.run_id,'retention_unbridged' FROM runs r JOIN changes c ON c.run_id=r.run_id WHERE c.change_id=?", (change_id,))
            return "unavailable", None
        return None, None

    def _insert_preserving_part(self, table: str, key: str, side: str | None, ordinal: int, part: BodyPartInput, source_epoch: str, tier: str = "B", evidenced_at: str | None = None) -> None:
        """Keep prior body observations when a repeated call is rewritten."""
        if table == "tool_parts":
            rows = self.db.execute("SELECT ordinal,body_id,part_id,source_locator FROM tool_parts WHERE call_id=? AND side=?", (key, side)).fetchall()
            occupied = {int(row[0]) for row in rows}
            matching = [row for row in rows if row[2] == part.part_id or (part.source_locator is not None and row[3] == part.source_locator)]
            if any(row[1] is None and self.db.execute("SELECT status FROM tool_parts WHERE call_id=? AND side=? AND ordinal=?", (key, side, row[0])).fetchone()[0] == "pruned" for row in matching):
                # A later source generation may replay a pruned part. Keep the
                # tombstoned row detached instead of silently restoring bytes.
                return
            body_id = body_identity(part.bytes_value) if part.bytes_value is not None and part.status not in ("unavailable", "unsupported") else None
            # An exact old reference whose bytes were already removed cannot
            # acquire bytes again merely because a reader is replayed.
            if body_id is not None and any(self.db.execute("SELECT 1 FROM tool_parts WHERE call_id=? AND side=? AND ordinal=? AND body_id IS NULL AND tombstone_body_id=? AND status IN ('pruned','unavailable')", (key, side, row[0], body_id)).fetchone() is not None for row in matching):
                return
            dangling = [row for row in matching if row[1] == body_id and body_id is not None and self.db.execute("SELECT 1 FROM bodies WHERE body_id=?", (body_id,)).fetchone() is None]
            if dangling:
                for row in dangling:
                    self.db.execute("UPDATE tool_parts SET tombstone_body_id=body_id,body_id=NULL,status='unavailable' WHERE call_id=? AND side=? AND ordinal=?", (key, side, row[0]))
                self._retention_issue(key)
                return
            retained_status, retained_at = self._mirror_retention(key, side, part, body_id)
            if retained_status:
                if any(self.db.execute("SELECT 1 FROM tool_parts WHERE call_id=? AND side=? AND ordinal=? AND status=? AND body_id IS NULL", (key, side, row[0], retained_status)).fetchone() is not None for row in matching):
                    return
                target = ordinal if ordinal not in occupied else max(occupied, default=-1) + 1
                self.db.execute("INSERT INTO tool_parts(call_id,side,ordinal,part_id,kind,status,content_type,bytes,body_id,source_locator,source_epoch,retained_version,retention_tier,pruned_at,evidenced_at,mirror_part_key,tombstone_body_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (key, side, target, part.part_id, part.kind, retained_status, part.content_type, len(part.bytes_value or b""), None, part.source_locator, source_epoch, 0, tier, retained_at, evidenced_at, part.mirror_part_key, body_id if retained_status == "pruned" else None))
                return
            body_id = self._store_part(part)
            same_body = [row for row in matching if (body_id is not None and row[1] == body_id) or (body_id is None and row[1] is None)]
            if same_body:
                current_ordinal = max(int(row[0]) for row in same_body)
                self.db.execute(
                    "UPDATE tool_parts SET mirror_part_key=CASE WHEN ordinal=? THEN COALESCE(mirror_part_key,?) ELSE mirror_part_key END, retained_version=CASE WHEN ordinal=? THEN 0 ELSE 1 END, source_epoch=CASE WHEN ordinal=? THEN ? ELSE source_epoch END, evidenced_at=COALESCE(?,evidenced_at) WHERE call_id=? AND side=? AND (part_id=? OR (? IS NOT NULL AND source_locator=?))",
                    (current_ordinal, part.mirror_part_key, current_ordinal, current_ordinal, source_epoch, evidenced_at, key, side, part.part_id, part.source_locator, part.source_locator),
                )
                return
            target = ordinal if ordinal not in occupied else max(occupied, default=-1) + 1
            if target != ordinal:
                # A call can have independent metadata, invocation, and
                # attachment parts.  A rewrite ages only the logical part
                # whose identity is being observed again.
                self.db.execute(
                    "UPDATE tool_parts SET retained_version=1 WHERE call_id=? AND side=? AND (part_id=? OR (? IS NOT NULL AND source_locator=?))",
                    (key, side, part.part_id, part.source_locator, part.source_locator),
                )
            self.db.execute("INSERT INTO tool_parts(call_id,side,ordinal,part_id,kind,status,content_type,bytes,body_id,source_locator,source_epoch,retained_version,retention_tier,pruned_at,evidenced_at,mirror_part_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (key, side, target, part.part_id, part.kind, part.status, part.content_type, len(part.bytes_value or b""), body_id, part.source_locator, source_epoch, 0, tier, None, evidenced_at, part.mirror_part_key))
            return
        else:
            rows = self.db.execute("SELECT ordinal,body_id,part_id,source_locator,status FROM change_parts WHERE change_id=?", (key,)).fetchall()
            occupied = {int(row[0]) for row in rows}
            matching = [row for row in rows if row[2] == part.part_id or (part.source_locator is not None and row[3] == part.source_locator)]
            if not matching:
                matching = [row for row in rows if int(row[0]) == ordinal and row[4] == "pruned"]
            if any(row[1] is None and row[4] == "pruned" for row in matching):
                return
            incoming_body = body_identity(part.bytes_value) if part.bytes_value is not None and part.status not in ("unavailable", "unsupported") else None
            if incoming_body is not None and any(self.db.execute("SELECT 1 FROM change_parts WHERE change_id=? AND ordinal=? AND body_id IS NULL AND tombstone_body_id=? AND status IN ('pruned','unavailable')", (key, row[0], incoming_body)).fetchone() is not None for row in matching):
                return
            dangling = [row for row in matching if row[1] == incoming_body and incoming_body is not None and self.db.execute("SELECT 1 FROM bodies WHERE body_id=?", (incoming_body,)).fetchone() is None]
            if dangling:
                for row in dangling:
                    self.db.execute("UPDATE change_parts SET tombstone_body_id=body_id,body_id=NULL,status='unavailable' WHERE change_id=? AND ordinal=?", (key, row[0]))
                self.db.execute("INSERT OR IGNORE INTO identity_issues SELECT r.harness,r.run_id,'retention_unbridged' FROM runs r JOIN changes c ON c.run_id=r.run_id WHERE c.change_id=?", (key,))
                return
            retained_status, retained_at = self._change_mirror_retention(key, part, incoming_body)
            if retained_status:
                if any(row[4] == retained_status and row[1] is None for row in matching):
                    return
                target = ordinal if ordinal not in occupied else max(occupied, default=-1) + 1
                self.db.execute("INSERT INTO change_parts(change_id,ordinal,part_id,kind,status,content_type,bytes,body_id,source_locator,source_epoch,retained_version,retention_tier,pruned_at,evidenced_at,mirror_part_key,tombstone_body_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (key, target, part.part_id, part.kind, retained_status, part.content_type, len(part.bytes_value or b""), None, part.source_locator, source_epoch, 0, tier, retained_at, evidenced_at, part.mirror_part_key, incoming_body if retained_status == "pruned" else None))
                return
            body_id = self._store_part(part)
            same_body = [row for row in matching if (body_id is not None and row[1] == body_id) or (body_id is None and row[1] is None)]
            if same_body:
                current_ordinal = max(int(row[0]) for row in same_body)
                self.db.execute(
                    "UPDATE change_parts SET mirror_part_key=CASE WHEN ordinal=? THEN COALESCE(mirror_part_key,?) ELSE mirror_part_key END, retained_version=CASE WHEN ordinal=? THEN 0 ELSE 1 END, source_epoch=CASE WHEN ordinal=? THEN ? ELSE source_epoch END, evidenced_at=COALESCE(?,evidenced_at) WHERE change_id=? AND (part_id=? OR (? IS NOT NULL AND source_locator=?))",
                    (current_ordinal, part.mirror_part_key, current_ordinal, current_ordinal, source_epoch, evidenced_at, key, part.part_id, part.source_locator, part.source_locator),
                )
                return
            target = ordinal if ordinal not in occupied else max(occupied, default=-1) + 1
            if target != ordinal:
                self.db.execute(
                    "UPDATE change_parts SET retained_version=1 WHERE change_id=? AND (part_id=? OR (? IS NOT NULL AND source_locator=?))",
                    (key, part.part_id, part.source_locator, part.source_locator),
                )
            self.db.execute("INSERT INTO change_parts(change_id,ordinal,part_id,kind,status,content_type,bytes,body_id,source_locator,source_epoch,retained_version,retention_tier,pruned_at,evidenced_at,mirror_part_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (key, target, part.part_id, part.kind, part.status, part.content_type, len(part.bytes_value or b""), body_id, part.source_locator, source_epoch, 0, tier, None, evidenced_at, part.mirror_part_key))

    def canonical_revision(self) -> int:
        row = self.db.execute("SELECT value FROM metadata WHERE key='canonical_revision'").fetchone()
        return int(row[0]) if row else 0

    def set_projection_revision(self, revision: int) -> None:
        self.db.execute("INSERT INTO metadata(key,value) VALUES ('projection_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(revision),))

    def mark_missing_sources(self, harness: str, source_ids: set[str]) -> int:
        """Mark retained sources absent from the current inventory unavailable."""
        rows = self.db.execute("SELECT source_id FROM sources WHERE harness=? GROUP BY source_id", (harness,)).fetchall()
        missing = [str(row[0]) for row in rows if str(row[0]) not in source_ids]
        if missing:
            self.db.executemany("UPDATE sources SET status='unavailable' WHERE harness=? AND source_id=?", ((harness, source_id) for source_id in missing))
            self.db.executemany("UPDATE sessions SET status='unavailable' WHERE harness=? AND session_id=(SELECT source_session_id FROM sources WHERE harness=? AND source_id=? LIMIT 1)", ((harness, harness, source_id) for source_id in missing))
        return len(missing)

    def _run_tokens(self, run_id: str) -> dict[str, Any]:
        memo = self._run_tokens_memo
        if memo is None:
            return self._read_run_tokens(run_id)
        if run_id not in memo:
            memo[run_id] = self._read_run_tokens(run_id)
        return memo[run_id]

    def _read_run_tokens(self, run_id: str) -> dict[str, Any]:
        published = [
            fact for fact in self._current_facts("token", run_ids={run_id})
            if fact.get("run_id") == run_id
        ]
        published_run = self._published_run(run_id)
        if published or published_run is not None:
            rows: Any = sorted(published, key=lambda fact: (fact.get("source_ordinal", 0), fact.get("block_ordinal", 0), fact.get("role_ordinal", 0), fact["sample_id"]))
            run: Any = {"harness": published_run.get("harness")} if published_run else None
            for token in rows:
                token["parser_version"] = 2
        else:
            rows = self.db.execute("SELECT * FROM token_samples WHERE run_id=? ORDER BY source_ordinal, block_ordinal, role_ordinal, at, sample_id", (run_id,)).fetchall()
            run = self.db.execute("SELECT harness FROM runs WHERE run_id=?", (run_id,)).fetchone()
        native_present = any(str(row["origin"] or "legacy") == "native" for row in rows)
        legacy = bool(run and run["harness"] == "codex" and any(row["parser_version"] < 2 or str(row["origin"] or "legacy") == "legacy" for row in rows))
        if native_present:
            rows = [row for row in rows if str(row["origin"] or "legacy") != "event_mirror"]
        if run and run["harness"] == "codex":
            source_versions = {
                str(source[0]): int(source[1] or 1)
                for source in self.db.execute(
                    "SELECT generation_id,MAX(parser_version) FROM sources GROUP BY generation_id"
                ).fetchall()
            }
            # A repaired v1 sample may be attributed to its fork after a v2
            # rescan.  Accept it only when that generation has since been
            # parsed by the current adapter; an isolated old source remains
            # explicitly unavailable.
            rows = [
                row for row in rows
                if int(row["parser_version"] or 1) >= 2
                or (native_present and str(row["origin"] or "legacy") == "native" and source_versions.get(str(row["source_epoch"]), 1) >= 2)
            ]
        totals = {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0, "total": 0}
        models: dict[str, dict[str, int]] = {}
        previous: dict[str | None, tuple[int, int, int, int]] = {}
        previous_total: dict[str | None, int | None] = {}
        reset_detected = False
        first = last = None
        for row in rows:
            vals = (int(row["input"]), int(row["output"]), int(row["cache_creation"]), int(row["cache_read"]))
            if row["total"] is not None:
                # Codex reports cache reads inside input_tokens.  Keep the
                # buckets useful while making the aggregate equal its
                # authoritative total_tokens field.
                visible_cache = max(0, int(row["total"]) - vals[0] - vals[1] - vals[2])
                vals = (vals[0], vals[1], vals[2], min(vals[3], visible_cache))
            total_delta = int(row["total"]) if row["total"] is not None else sum(vals)
            if row["cumulative"]:
                old = previous.get(row["model"], (0, 0, 0, 0))
                old_total = previous_total.get(row["model"])
                decreased = any(a < b for a, b in zip(vals, old)) or (
                    row["total"] is not None and old_total is not None and int(row["total"]) < old_total
                )
                if decreased:
                    # A lower cumulative sample is a new accounting epoch.
                    # Treat it as a fresh observation instead of silently
                    # dropping the reset to zero.
                    reset_detected = True
                delta = vals if row["epoch_marker"] or decreased else tuple(max(0, a - b) for a, b in zip(vals, old))
                if not row["epoch_marker"] and not decreased and row["total"] is not None and old_total is not None:
                    target = max(0, int(row["total"] or 0) - int(previous_total[row["model"]] or 0))
                    excess = max(0, sum(delta) - target)
                    delta = (delta[0], delta[1], delta[2], max(0, delta[3] - excess))
                if not row["epoch_marker"] and not decreased:
                    total_delta = max(0, total_delta - (old_total if old_total is not None else sum(old)))
                previous[row["model"]] = vals
                previous_total[row["model"]] = int(row["total"]) if row["total"] is not None else None
            else:
                delta = vals
            for key, value in zip(totals, (*delta, total_delta)):
                totals[key] += value
            model = row["model"] or "unknown"
            bucket = models.setdefault(model, {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0, "total": 0})
            for key, value in zip(bucket, (*delta, total_delta)):
                bucket[key] += value
            first = first or row["at"]
            last = row["at"] or last
        activity = self._run_activity(run_id)
        if activity:
            observed = [item["start"] for item in activity] + [item["end"] for item in activity]
            observed = [item for item in observed if item]
            first = min([value for value in (first, *observed) if value], default=None)
            last = max([value for value in (last, *observed) if value], default=None)
        status = "partial" if reset_detected else ("available" if rows else "unavailable")
        evidence = ([{"kind": "accounting_reset", "status": "observed"}] if reset_detected else [])
        if legacy and not rows:
            evidence.append({"kind": "legacy_codex_accounting", "status": "unavailable"})
        cost, cost_status = _cost(models)
        active_ms = self._interval_duration(activity) if activity else (0 if first else None)
        return {"tokens": _scope(totals, status=status, cost=cost, cost_status=cost_status, first=first, last=last, active_ms=active_ms, timing_status="observed" if first else "unavailable", evidence=evidence), "models": models, "first": first, "last": last, "model_names": sorted(models)}

    @staticmethod
    def _elapsed_ms(start: str | None, end: str | None) -> int:
        if not start or not end:
            return 0
        try:
            left = _dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
            right = _dt.datetime.fromisoformat(end.replace("Z", "+00:00"))
            return max(0, int((right - left).total_seconds() * 1000))
        except ValueError:
            return 0

    def _run_activity(self, run_id: str) -> list[dict[str, str | None]]:
        memo = self._run_activity_memo
        if memo is None:
            return self._read_run_activity(run_id)
        if run_id not in memo:
            memo[run_id] = self._read_run_activity(run_id)
        return memo[run_id]

    def _read_run_activity(self, run_id: str) -> list[dict[str, str | None]]:
        # Same-timestamp records must retain capture order so a result cannot
        # sort ahead of its start merely because its opaque ID differs.
        published = [
            fact for fact in self._current_facts("event", run_ids={run_id})
            if fact.get("run_id") == run_id and fact.get("at") is not None
        ]
        published_run = self._published_run(run_id)
        rows: Any = (
            sorted(
                published,
                key=lambda fact: (
                    fact.get("at") or "", fact.get("source_ordinal", 0),
                    fact.get("block_ordinal", 0), fact.get("role_ordinal", 0), fact["event_id"],
                ),
            )
            if published or published_run is not None
            else self.db.execute(
                "SELECT at,kind,correlation_id FROM events WHERE run_id=? AND at IS NOT NULL ORDER BY at,rowid",
                (run_id,),
            ).fetchall()
        )
        intervals: list[dict[str, str | None]] = []
        starts: dict[str | None, list[str]] = {}
        for row in rows:
            at = row["at"]
            if row["kind"] in ("tool_started", "task_started") and at:
                starts.setdefault(row["correlation_id"], []).append(at)
            elif row["kind"] in ("tool_result", "task_complete") and at:
                key = row["correlation_id"]
                queue = starts.get(key) or starts.get(None)
                if queue:
                    intervals.append({"start": queue.pop(0), "end": at, "status": "observed"})
        # Wait intervals are deliberately omitted here.  They are exposed by
        # _timeline_payload and must not inflate active work duration.
        return sorted(intervals, key=lambda item: (item["start"] or "", item["end"] or ""))

    def _interval_duration(self, intervals: list[dict[str, str | None]]) -> int:
        """Return the union duration so overlapping work is counted once."""
        ordered = sorted((item for item in intervals if item.get("start")), key=lambda item: (item["start"] or "", item["end"] or ""))
        if not ordered:
            return 0
        total = 0
        start = ordered[0]["start"]
        end = ordered[0]["end"] or start
        for item in ordered[1:]:
            next_start = item["start"]
            next_end = item["end"] or next_start
            if next_start and end and next_start <= end:
                if next_end and next_end > end:
                    end = next_end
                continue
            total += self._elapsed_ms(start, end)
            start, end = next_start, next_end
        return total + self._elapsed_ms(start, end)

    def _logical_run_id(self, run_id: str) -> str:
        member = self.db.execute("SELECT logical_id FROM run_members WHERE physical_run_id=?", (run_id,)).fetchone()
        return str(member[0]) if member else run_id

    def _published_scope(self, harness: str, session_id: str) -> bool:
        return self._published_scope_fact(harness, session_id) is not None

    def _published_scope_facts(self, harness: str, session_id: str) -> list[dict[str, Any]]:
        return [
            fact for fact in self._read_set(harness=harness, session_id=session_id).scopes()
            if (
                fact.get("record_type") == "source_scope"
                and fact.get("harness") == harness
                and (fact.get("root_session_id") == session_id or fact.get("source_session_id") == session_id)
            )
        ]

    def _published_run(self, run_id: str) -> dict[str, Any] | None:
        return next(
            (
                fact for fact in self._current_facts("run", run_ids={run_id})
                if fact.get("run_id") == run_id
            ),
            None,
        )

    def _published_scope_fact(self, harness: str, session_id: str) -> dict[str, Any] | None:
        facts = self._published_scope_facts(harness, session_id)
        return next(
            (fact for fact in facts if fact.get("source_session_id") == session_id),
            facts[0] if facts else None,
        )

    @staticmethod
    def _published_prs(facts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rank = {"associated": 0, "reviewed": 1, "changed": 2, "created": 3}
        grouped: dict[tuple[str, int], dict[str, Any]] = {}
        for fact in facts:
            key = (str(fact["repository_id"]), int(fact["number"]))
            candidate = {
                "repository_id": key[0], "number": key[1], "url": fact.get("url"),
                "relationship": fact["relationship"],
                "last_evidenced_at": fact.get("evidenced_at"),
                "first_seen": fact.get("evidenced_at"),
            }
            current = grouped.get(key)
            if current is None or rank.get(candidate["relationship"], 0) > rank.get(current["relationship"], 0):
                grouped[key] = candidate
            elif (
                rank.get(candidate["relationship"], 0) == rank.get(current["relationship"], 0)
                and (candidate["last_evidenced_at"] or "") >= (current["last_evidenced_at"] or "")
            ):
                grouped[key] = candidate
        return sorted(grouped.values(), key=lambda item: (item["last_evidenced_at"] or "", item["repository_id"], item["number"]), reverse=True)

    def _member_run_ids(self, run_id: str) -> tuple[str, ...]:
        logical = self._logical_run_id(run_id)
        rows = self.db.execute("SELECT physical_run_id FROM run_members WHERE logical_id=? ORDER BY physical_run_id", (logical,)).fetchall()
        return tuple(str(row[0]) for row in rows) if rows else (run_id,)

    def _selected_run_id(self, run_id: str) -> str:
        published = self._published_run(run_id)
        if published is not None:
            return str(published["run_id"])
        logical = self._logical_run_id(run_id)
        row = self.db.execute("SELECT physical_run_id FROM run_members WHERE logical_id=? ORDER BY CASE WHEN origin='source' THEN 0 ELSE 1 END,captured_revision DESC,physical_run_id LIMIT 1", (logical,)).fetchone()
        return str(row[0]) if row else run_id

    def _family_run_rows(self, harness: str, session_id: str) -> list[dict[str, Any]]:
        all_published = [
            fact for fact in self._current_facts("run", harness=harness, session_id=session_id)
            if fact.get("harness") == harness
        ]
        published = [
            fact for fact in all_published
            if fact.get("root_session_id") == session_id or fact.get("source_session_id") == session_id
        ]
        included = {fact["run_id"] for fact in published}
        while included:
            descendants = [fact for fact in all_published if fact.get("parent_run_id") in included]
            additions = {fact["run_id"] for fact in descendants} - included
            if not additions:
                break
            included.update(additions)
            published.extend(fact for fact in descendants if fact["run_id"] in additions)
        if published:
            return [
                {
                    "run_id": fact["run_id"], "harness": harness,
                    "source_session_id": fact["source_session_id"],
                    "native_run_id": fact["native_run_id"], "parent_run_id": fact.get("parent_run_id"),
                    "role": fact.get("role"), "models": _json(fact.get("models") or []),
                    "started_at": fact.get("started_at"), "ended_at": fact.get("ended_at"),
                    "locations": _json(fact.get("locations") or []),
                    "native_facts": _json(fact.get("native_facts") or {}),
                    "capture_status": fact.get("capture_status"),
                }
                for fact in published
            ]
        if self._published_scope(harness, session_id):
            return []
        session = self.db.execute("SELECT root_session_id FROM sessions WHERE harness=? AND session_id=?", (harness, session_id)).fetchone()
        root = session[0] if session else session_id
        rows = self.db.execute(
            "WITH RECURSIVE family(run_id) AS ("
            "SELECT run_id FROM runs WHERE harness=? AND source_session_id IN "
            "(SELECT session_id FROM sessions WHERE harness=? AND root_session_id=?) "
            "UNION SELECT physical_run_id FROM run_members WHERE harness=? AND root_session_id=? "
            "UNION SELECT child.run_id FROM runs child JOIN family parent ON child.parent_run_id=parent.run_id "
            "WHERE child.harness=? ) SELECT runs.* FROM runs JOIN family ON family.run_id=runs.run_id "
            "WHERE NOT EXISTS(SELECT 1 FROM run_members m WHERE m.physical_run_id=runs.run_id AND (m.harness<>? OR m.root_session_id<>?))",
            (harness, harness, root, harness, root, harness, harness, root),
        ).fetchall()
        return [dict(row) for row in rows]

    def _identity_evidence(self, harness: str | None = None, session_id: str | None = None) -> dict:
        rows = self.db.execute("SELECT harness,physical_run_id,reason FROM identity_issues").fetchall()
        allowed = {row["run_id"] for row in self._family_run_rows(harness, session_id)} if harness and session_id else None
        reasons = {str(row[2]) for row in rows if (harness is None or row[0] == harness) and (allowed is None or row[1] in allowed)}
        messages = {
            "identity_ambiguous": "Some historical runs cannot be assigned to a session safely. Their totals are excluded; inspect the source identity before retrying capture.",
            "retention_unbridged": "Some historical parts lack retention provenance. Their bodies remain unavailable; changing readers will not restore them.",
        }
        return {"status": "partial" if reasons else "complete", "notices": [messages.get(reason, reason) for reason in sorted(reasons)]}

    def _session_rows(self, harness: str, session_id: str) -> list[dict[str, Any]]:
        rows = self._family_run_rows(harness, session_id)
        ambiguous = {str(row[0]) for row in self.db.execute("SELECT physical_run_id FROM identity_issues WHERE harness=? AND reason='identity_ambiguous'", (harness,))}
        selected = []
        for row in rows:
            run_id = str(row["run_id"])
            if run_id in ambiguous or self._selected_run_id(run_id) != run_id:
                continue
            row["parent_run_id"] = self._selected_run_id(row["parent_run_id"]) if row["parent_run_id"] else None
            selected.append(row)
        return sorted(selected, key=lambda row: (0 if row["parent_run_id"] is None else 1, row["started_at"] or "", row["run_id"]))

    def summary_facts(self, harness: str, session_id: str) -> dict[str, list[dict[str, Any]]]:
        """Provide the current published session and descendants to the reducer."""
        runs = self._session_rows(harness, session_id)
        selected = {row["run_id"] for row in runs if row["source_session_id"] == session_id}
        while selected:
            children = {row["run_id"] for row in runs if row["parent_run_id"] in selected}
            if children <= selected:
                break
            selected.update(children)
        facts = {}
        for kind in ("run", "token", "call", "message", "structural"):
            facts[kind] = [
                fact for fact in self._current_facts(kind, harness=harness, session_id=session_id)
                if fact.get("run_id") in selected
            ]
        selected_children = {self._logical_run_id(row["run_id"]): row["run_id"] for row in runs}
        facts["call"] = [
            {**fact, "child_run_id": selected_children.get(self._logical_run_id(fact["child_run_id"]), fact["child_run_id"])}
            if fact.get("child_run_id") else fact
            for fact in facts["call"]
        ]
        scopes = [fact for fact in self._published_scope_facts(harness, session_id)
                  if fact.get("source_session_id") == session_id
                  or any(row["source_session_id"] == fact.get("source_session_id")
                         for row in runs if row["run_id"] in selected)]
        # A child can be inspected as its own summary while retaining the
        # captured parent reference. The reducer's root is the requested session.
        facts["structural"].extend({**fact, "root_session_id": session_id} for fact in scopes)
        facts["run"] = [{**fact, "root_session_id": session_id} for fact in facts["run"]]
        facts["coverage"] = [
            {"source_id": fact["_source_id"],
             "status": "complete" if fact.get("capture_status") == "active" else "partial"}
            for fact in scopes
        ]
        return facts

    def _session_epochs(self, harness: str, session_id: str) -> tuple[str, ...]:
        session = self.db.execute("SELECT root_session_id FROM sessions WHERE harness=? AND session_id=?", (harness, session_id)).fetchone()
        root = session[0] if session else session_id
        rows = self.db.execute("SELECT generation_id FROM sources WHERE harness=? AND source_session_id IN (SELECT session_id FROM sessions WHERE harness=? AND root_session_id=?) ORDER BY captured_at, generation_id", (harness, harness, root)).fetchall()
        return tuple(str(row[0]) for row in rows)

    def _scopes(self, runs: list[dict[str, Any]], selected: str | None = None) -> dict:
        selected_id = self._selected_run_id(selected) if selected else (runs[0]["run_id"] if runs else "")
        own = self._run_tokens(selected_id) if runs else self._run_tokens("")
        by_parent: dict[str | None, list[str]] = {}
        for run in runs:
            by_parent.setdefault(run["parent_run_id"], []).append(run["run_id"])
        child_ids: set[str] = set()
        pending = list(by_parent.get(selected_id, []))
        while pending:
            child = pending.pop()
            if child in child_ids or child == selected_id:
                continue
            child_ids.add(child)
            pending.extend(by_parent.get(child, []))
        child_scope = self._aggregate_scope(sorted(child_ids))
        subtree = self._aggregate_scope([selected_id, *sorted(child_ids)])
        return {"own": own["tokens"], "children": child_scope, "subtree": subtree}

    def _native_run(self, run_id: str) -> dict[str, Any]:
        published_runs = [
            fact for fact in self._current_facts("run", run_ids={run_id}) if fact.get("run_id") == run_id
        ]
        row = self.db.execute("SELECT native_facts,harness,source_session_id FROM runs WHERE run_id=?", (run_id,)).fetchone()
        try:
            facts = published_runs[0].get("native_facts", {}) if published_runs else (json.loads(row[0]) if row and row[0] else {})
        except (TypeError, ValueError):
            facts = {}
        if not isinstance(facts, dict):
            facts = {}
        published_calls = [
            fact for fact in self._current_facts("call", run_ids={run_id}) if fact.get("run_id") == run_id
        ]
        if published_calls or published_runs:
            counts: dict[str, int] = {}
            for call in published_calls:
                name = str(call["tool_name"])
                counts[name] = counts.get(name, 0) + 1
            breakdown: list[dict[str, Any]] = [{"name": name, "count": count} for name, count in counts.items()]
        else:
            count_rows = self.db.execute("SELECT tool_name,count(*) AS count FROM tool_calls WHERE run_id=? GROUP BY tool_name", (run_id,)).fetchall()
            breakdown = [{"name": str(r[0]), "count": int(r[1])} for r in count_rows]
        breakdown.sort(key=lambda item: (-item["count"], item["name"]))
        coverage = facts.get("tool_capture_complete")
        has_native_facts = any(facts.get(key) is not None for key in ("lines_added", "lines_removed", "duration_ms", "branch"))
        tool_status = "observed" if coverage is True else (
            "partial" if coverage is False and breakdown else
            "observed" if coverage is None and breakdown else "unavailable"
        )
        result: dict[str, Any] = {
            "lines_added": facts.get("lines_added"), "lines_removed": facts.get("lines_removed"),
            "duration_ms": facts.get("duration_ms"), "branch": facts.get("branch"),
            "tool_calls": sum(item["count"] for item in breakdown) if tool_status != "unavailable" else None,
            "tool_breakdown": breakdown,
        }
        result["field_status"] = {
            key: "observed" if result[key] is not None else "unavailable"
            for key in ("lines_added", "lines_removed", "duration_ms", "branch")
        }
        result["field_status"].update(tool_calls=tool_status, tool_breakdown=tool_status)
        statuses = set(result["field_status"].values())
        result["status"] = "partial" if "partial" in statuses else (
            "observed" if "observed" in statuses else "unavailable"
        )
        if coverage is False and has_native_facts:
            result["status"] = "partial"
        return result

    def _native_scope(self, run_ids: list[str]) -> dict[str, Any]:
        values = [self._native_run(run_id) for run_id in run_ids]
        if not values:
            return {"lines_added": None, "lines_removed": None, "duration_ms": None, "branch": None, "tool_calls": None, "tool_breakdown": [], "status": "unavailable", "field_status": {key: "unavailable" for key in ("lines_added", "lines_removed", "duration_ms", "branch", "tool_calls", "tool_breakdown")}}
        def summed(key: str) -> int | None:
            present = [value[key] for value in values if isinstance(value.get(key), int) and value[key] >= 0]
            return sum(present) if present else None
        tools: dict[str, int] = {}
        for value in values:
            for item in value["tool_breakdown"]:
                tools[item["name"]] = tools.get(item["name"], 0) + item["count"]
        breakdown: list[dict[str, Any]] = [{"name": name, "count": count} for name, count in tools.items()]
        breakdown.sort(key=lambda item: (-item["count"], item["name"]))
        observed = any(value["status"] != "unavailable" for value in values)
        branches = {value["branch"] for value in values if isinstance(value.get("branch"), str)}
        result: dict[str, Any] = {"lines_added": summed("lines_added"), "lines_removed": summed("lines_removed"), "duration_ms": summed("duration_ms"), "branch": next(iter(branches)) if len(branches) == 1 else None, "tool_calls": summed("tool_calls"), "tool_breakdown": breakdown, "status": "observed" if observed else "unavailable"}
        fields = ("lines_added", "lines_removed", "duration_ms", "branch", "tool_calls", "tool_breakdown")
        result["field_status"] = {}
        for key in fields:
            availability = [value["field_status"][key] for value in values]
            result["field_status"][key] = "observed" if all(item == "observed" for item in availability) else ("partial" if any(item != "unavailable" for item in availability) else "unavailable")
        if len(branches) > 1:
            result["field_status"]["branch"] = "partial"
        if "partial" in result["field_status"].values() or any(value["status"] == "partial" for value in values):
            result["status"] = "partial"
        return result

    def _native_projection(self, runs: list[dict[str, Any]], selected: str) -> dict[str, Any]:
        by_parent: dict[str | None, list[str]] = {}
        for run in runs:
            by_parent.setdefault(run["parent_run_id"], []).append(run["run_id"])
        child_ids: list[str] = []
        pending = list(by_parent.get(selected, []))
        while pending:
            child = pending.pop()
            if child in child_ids or child == selected:
                continue
            child_ids.append(child)
            pending.extend(by_parent.get(child, []))
        own = self._native_run(selected)
        children = self._native_scope(sorted(child_ids))
        subtree = self._native_scope([selected, *sorted(child_ids)])
        # Keep the established nested own/children/subtree contract, while
        # exposing one aggregate status for consumers that need to distinguish
        # observed data from an incomplete capture.
        return {"own": own, "children": children, "subtree": subtree}

    def _prs_for_runs(self, epochs: tuple[str, ...], run_ids: set[str] | None = None, *, unassociated_epochs: tuple[str, ...] = ()) -> list[dict]:
        if not epochs:
            return []
        placeholders = ",".join("?" for _ in epochs)
        rows = self.db.execute(
            f"SELECT * FROM prs WHERE source_epoch IN ({placeholders}) ORDER BY evidenced_at DESC, first_seen DESC, pr_id",
            epochs,
        ).fetchall()
        if run_ids is None:
            return self._dedupe_prs(rows)
        # PR rows predate durable run association.  Their same-event change is
        # the retained evidence that ties an inline sidechain PR to its run.
        associated = self.db.execute(
            f"SELECT source_epoch,source_event_id,run_id FROM changes WHERE source_epoch IN ({placeholders}) "
            f"UNION SELECT source_epoch,event_id,run_id FROM events WHERE source_epoch IN ({placeholders}) AND run_id IS NOT NULL",
            (*epochs, *epochs),
        ).fetchall()
        attributed = {(str(item[0]), str(item[1])) for item in associated}
        owned = {(str(item[0]), str(item[1])) for item in associated if str(item[2]) in run_ids}
        # Older PR observations only identified their source. Preserve that
        # source owner unless retained evidence explicitly names another run.
        return self._dedupe_prs(row for row in rows if (
            (str(row["source_epoch"]), str(row["source_event_id"])) in owned
            or (row["source_epoch"] in unassociated_epochs
                and (str(row["source_epoch"]), str(row["source_event_id"])) not in attributed)
        ))

    def _aggregate_scope(self, run_ids: list[str]) -> dict:
        if not run_ids:
            return _scope({"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0}, status="unavailable")
        totals = {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0, "total": 0}
        models: dict[str, dict[str, int]] = {}
        intervals: list[dict[str, str | None]] = []
        coverage: list[str] = []
        observed_starts: list[str] = []
        observed_ends: list[str] = []
        scope_evidence: list[dict] = []
        for run_id in run_ids:
            metric = self._run_tokens(run_id)
            for notice in metric["tokens"].get("evidence", []):
                if notice not in scope_evidence:
                    scope_evidence.append(notice)
            coverage.append(str(metric["tokens"]["tokens"]["status"]))
            if metric["first"]:
                observed_starts.append(str(metric["first"]))
            if metric["last"]:
                observed_ends.append(str(metric["last"]))
            for model, values in metric["models"].items():
                bucket = models.setdefault(model, {key: 0 for key in totals})
                for key in totals:
                    amount = int(values[key])
                    bucket[key] += amount
                    totals[key] += amount
            intervals.extend(self._run_activity(run_id))
        starts = [str(item["start"]) for item in intervals if item.get("start")]
        ends = [str(item["end"] or item["start"]) for item in intervals if item.get("start")]
        first = min([*starts, *observed_starts], default=None)
        last = max([*ends, *observed_ends], default=None)
        cost, cost_status = _cost(models)
        active_ms = self._interval_duration(intervals)
        token_status = "unavailable" if all(item == "unavailable" for item in coverage) else ("partial" if any(item != "available" for item in coverage) else "available")
        evidence = scope_evidence
        return _scope(totals, status=token_status, cost=cost, cost_status=cost_status, first=first, last=last, active_ms=active_ms, timing_status="observed" if first else "unavailable", evidence=evidence)

    def index_payload(self) -> dict:
        with self._memoized():
            return self._index_payload()

    def _index_payload(self) -> dict:
        summaries = {
            (row["harness"], row["session_id"]): row
            for row in usage_summary_projection.effective_summaries(self.db)
        }
        sessions = []
        roots: dict[tuple[str, str], dict[str, Any]] = {}
        for row in self.db.execute("SELECT * FROM sessions ORDER BY harness, root_session_id").fetchall():
            if row["session_id"] == row["root_session_id"]:
                roots[(str(row["harness"]), str(row["session_id"]))] = {
                    "status": str(row["status"]), "published": False,
                }
        for fact in self._read_set().scopes():
            if fact.get("record_type") != "source_scope":
                continue
            key = (str(fact["harness"]), str(fact["root_session_id"]))
            roots[key] = {"status": {"active": "available", "incomplete": "partial"}.get(str(fact.get("capture_status") or ""), "unavailable"), "published": True}
        for (harness, session_id), details in sorted(roots.items()):
            runs = self._session_rows(harness, session_id)
            run_id = runs[0]["run_id"] if runs else None
            epochs = self._session_epochs(harness, session_id)
            source_ids = {fact["_source_id"] for fact in self._published_scope_facts(harness, session_id)}
            pr_items = (
                self._published_prs([
                    fact for fact in self._current_facts("pr", harness=harness, session_id=session_id)
                    if fact["_source_id"] in source_ids
                ])
                if source_ids
                else self._prs_for_runs(epochs) if runs else []
            )
            latest = pr_items[0] if pr_items else None
            pinned = self.db.execute("SELECT 1 FROM pins WHERE harness=? AND source_session_id=?", (harness, session_id)).fetchone() is not None
            native = self._native_projection(runs, run_id) if run_id else self._native_scope([])
            agents = []
            for run in runs:
                if run["source_session_id"] == session_id:
                    continue
                agent_epochs = tuple(str(item[0]) for item in self.db.execute("SELECT generation_id FROM sources WHERE harness=? AND source_session_id=?", (harness, run["source_session_id"])).fetchall())
                # Inline sidechains share the parent source epoch; use the
                # event/change run association to keep their PRs scoped.
                agent_prs = self._prs_for_runs(epochs, {str(run["run_id"])}, unassociated_epochs=agent_epochs)
                agent_session = self.db.execute("SELECT status FROM sessions WHERE harness=? AND session_id=?", (harness, run["source_session_id"])).fetchone()
                is_identity_member = self.db.execute("SELECT 1 FROM run_members WHERE physical_run_id=?", (run["run_id"],)).fetchone() is not None
                public_id = run["native_run_id"] if is_identity_member else run["source_session_id"]
                agents.append({"session_id": public_id or run["source_session_id"], "run_id": self._logical_run_id(run["run_id"]), "status": ({"active": "available", "incomplete": "partial"}.get(run["capture_status"], "unavailable") if run.get("capture_status") else agent_session[0] if agent_session else "unavailable"), "scopes": self._scopes(runs, run["run_id"]), "native": self._native_projection(runs, run["run_id"]), "latest_pr": agent_prs[0] if agent_prs else None, "prs": agent_prs, "additional_pr_count": max(0, len(agent_prs) - 1)})
            sessions.append({"harness": harness, "session_id": session_id, "root_session_id": session_id, "run_id": run_id, "agents": agents, "status": details["status"], "scopes": self._scopes(runs), "native": native, "latest_pr": latest, "prs": pr_items, "additional_pr_count": max(0, len(pr_items) - 1), "pinned": pinned})
        for session in sessions:
            summary = summaries.get((session["harness"], session["session_id"]), {})
            session["summary_provenance"] = summary.get("summary_provenance")
            session["capture_coverage"] = summary.get("capture_coverage", "unavailable")
            for agent in session["agents"]:
                # A complete root summary requires compatible heads for all children.
                # Missing or partial root coverage cannot certify a child's own total.
                agent["summary_provenance"] = session["summary_provenance"]
                agent["capture_coverage"] = session["capture_coverage"]
        return {"ok": True, "schema_version": 1, "sessions": sessions, "evidence": self._identity_evidence()}

    @staticmethod
    def _dedupe_prs(rows: Any) -> list[dict]:
        rank = {"associated": 0, "reviewed": 1, "changed": 2, "created": 3}
        grouped: dict[tuple[str, int], dict] = {}
        for row in rows:
            key = (str(row["repository_id"]), int(row["number"]))
            evidenced = row["evidenced_at"] or row["first_seen"]
            current = grouped.get(key)
            candidate = {
                "repository_id": key[0], "number": key[1], "url": row["url"],
                "relationship": row["relationship"], "last_evidenced_at": evidenced,
                "first_seen": row["first_seen"],
            }
            if current is None:
                grouped[key] = candidate
                continue
            latest = max(current["last_evidenced_at"], evidenced)
            if rank.get(candidate["relationship"], 0) > rank.get(current["relationship"], 0):
                candidate["last_evidenced_at"] = latest
                candidate["first_seen"] = min(candidate["first_seen"], current["first_seen"])
                grouped[key] = candidate
                continue
            if rank.get(candidate["relationship"], 0) == rank.get(current["relationship"], 0) and evidenced > current["last_evidenced_at"]:
                current.update({"url": candidate["url"]})
            current["last_evidenced_at"] = latest
            current["first_seen"] = min(candidate["first_seen"], current["first_seen"])
        return sorted(grouped.values(), key=lambda item: (item["last_evidenced_at"], item["repository_id"], item["number"]), reverse=True)

    def _pr_payload(self, row: sqlite3.Row) -> dict:
        return {"repository_id": row["repository_id"], "number": row["number"], "url": row["url"], "relationship": row["relationship"], "last_evidenced_at": row["evidenced_at"] or row["first_seen"]}

    def inspection_payload(self, harness: str, session_id: str, view: str = "overview", run_id: str | None = None, after: str | None = None, limit: int = 100) -> dict:
        with self._memoized():
            return self._inspection_payload(harness, session_id, view, run_id, after, limit)

    def _inspection_payload(self, harness: str, session_id: str, view: str, run_id: str | None, after: str | None, limit: int) -> dict:
        if not _ID_RE.fullmatch(session_id or "") or not _ID_RE.fullmatch(harness or ""):
            return {"ok": False, "reason": "invalid_identifier"}
        row = self.db.execute("SELECT * FROM sessions WHERE harness=? AND session_id=?", (harness, session_id)).fetchone()
        if row is None:
            return {"ok": False, "reason": "not_captured"}
        if view == "body":
            return {"ok": False, "reason": "unavailable"}
        runs = self._session_rows(harness, session_id)
        scope_fact = self._published_scope_fact(harness, session_id)
        root = scope_fact["root_session_id"] if scope_fact is not None else row["root_session_id"]
        valid_runs = {item["run_id"] for item in runs}
        if run_id is not None:
            run_id = self._selected_run_id(run_id)
        if run_id is not None and run_id not in valid_runs:
            return {"ok": False, "reason": "invalid_identifier"}
        if view == "tools":
            tools = self._tools_payload(runs, after, run_id, limit)
            return {"ok": True, "schema_version": 1, "tool_calls": tools, **tools}
        if view == "changes":
            return {"ok": True, "schema_version": 1, **self._changes_payload(runs)}
        scopes = self._scopes(runs, run_id)
        run_payload = [self._run_payload(r, scopes if r["run_id"] == (run_id or (runs[0]["run_id"] if runs else "")) else self._scopes(runs, r["run_id"]), self._run_depth(r, runs)) for r in runs]
        session_epochs = self._session_epochs(harness, session_id) if runs else ()
        epochs = [dict(r) for r in self.db.execute("SELECT generation_id id, status, captured_at FROM sources WHERE generation_id IN (%s) ORDER BY captured_at, generation_id" % ",".join("?" for _ in session_epochs), session_epochs).fetchall()] if session_epochs else []
        timeline = (
            {"events": [], "gaps": [], "wait_intervals": [], "relationship_edges": []}
            if scope_fact is not None and not runs
            else self._timeline_payload(runs)
        )
        generation_ids = session_epochs
        published_source_ids = {fact["_source_id"] for fact in self._published_scope_facts(harness, root)}
        if published_source_ids:
            pr_items = self._published_prs([
                fact for fact in self._current_facts("pr", harness=harness, session_id=root)
                if fact["_source_id"] in published_source_ids
            ])
        else:
            pr_rows = self.db.execute("SELECT * FROM prs WHERE source_epoch IN (%s) ORDER BY evidenced_at, first_seen" % ",".join("?" for _ in generation_ids), generation_ids).fetchall() if generation_ids else ()
            pr_items = self._dedupe_prs(pr_rows)
        pin_rows = self.db.execute("SELECT * FROM pins WHERE harness=? AND source_session_id=?", (harness, root)).fetchall()
        by_id = {item["run_id"]: item for item in runs}
        pins = []
        for pin in pin_rows:
            selected = pin["run_id"]
            selected_scopes = scopes if selected == "session" else self._scopes(runs, selected)
            breadcrumb: list[dict[str, str]] = []
            current = by_id.get(self._selected_run_id(selected))
            seen: set[str] = set()
            while current is not None and current["parent_run_id"] and current["parent_run_id"] not in seen:
                seen.add(current["parent_run_id"])
                parent = by_id.get(current["parent_run_id"])
                breadcrumb.insert(0, {"label": (parent["role"] if parent else "Main session"), "status": "available" if parent else "unavailable"})
                current = parent
            pins.append({"harness": pin["harness"], "session_id": pin["source_session_id"], "root_session_id": root, "run_id": None if selected == "session" else selected, "root_type": "session" if selected == "session" else "agent", "breadcrumb": breadcrumb, "status": row["status"], "scopes": {"own": selected_scopes["own"], "subtree": selected_scopes["subtree"]}})
        return {"ok": True, "schema_version": 1, "session": {"key": {"harness": harness, "session_id": root}, "status": row["status"], "source_epochs": epochs, "summary": scopes}, "runs": run_payload, "timeline": {"origin": min((r["started_at"] for r in runs if r["started_at"]), default=None), "events": timeline["events"], "gaps": timeline["gaps"], "wait_intervals": timeline["wait_intervals"], "relationship_edges": timeline["relationship_edges"]}, "tool_calls": self._tools_payload(runs, None), "changes": self._changes_payload(runs).get("changes", []), "prs": pr_items, "pins": pins, "evidence": self._identity_evidence(harness, session_id)}

    def _timeline_payload(self, runs: list[dict[str, Any]]) -> dict:
        selected_ids = {str(run["run_id"]) for run in runs}
        published_events = [
            fact for fact in self._current_facts("event", run_ids=selected_ids)
            if fact.get("run_id") in selected_ids
        ]
        published_relations = [
            fact for fact in self._current_facts("relationship", run_ids=selected_ids)
            if fact.get("from_run_id") in selected_ids
        ]
        if published_events or any(
            self._published_scope(str(run["harness"]), str(run["source_session_id"]))
            for run in runs
        ):
            event_payload = [
                {
                    "id": fact["event_id"], "run_id": self._logical_run_id(fact["run_id"]),
                    "at": fact.get("at"), "kind": fact["kind"], "status": "observed",
                    "_order": (fact.get("source_ordinal", 0), fact.get("block_ordinal", 0), fact.get("role_ordinal", 0)),
                }
                for fact in published_events
            ]
            event_payload.sort(key=lambda event: (event["at"] or "", event["_order"], event["id"]))
            for event in event_payload:
                event.pop("_order")
            published_waits: list[dict[str, str | None]] = []
            published_open_waits: dict[str | None, list[str]] = {}
            for event in event_payload:
                if event["kind"] == "wait_started" and event["at"]:
                    published_open_waits.setdefault(event["run_id"], []).append(event["at"])
                elif event["kind"] == "wait_result" and event["at"] and published_open_waits.get(event["run_id"]):
                    published_waits.append({"start": published_open_waits[event["run_id"]].pop(0), "end": event["at"], "run_id": event["run_id"], "status": "observed"})
            points = [event["at"] for event in event_payload if event["at"]]
            published_gaps = [
                {"start": left, "end": right, "duration_ms": self._elapsed_ms(left, right)}
                for left, right in zip(points, points[1:])
                if self._elapsed_ms(left, right) > 300000
            ]
            return {
                "events": event_payload, "gaps": published_gaps, "wait_intervals": published_waits,
                "relationship_edges": [
                    {
                        "from_run_id": self._logical_run_id(fact["from_run_id"]),
                        "to_run_id": self._logical_run_id(fact["to_run_id"]) if fact.get("to_run_id") else None,
                        "kind": fact["kind"], "at": fact.get("at"), "status": fact["status"],
                    }
                    for fact in published_relations
                ],
            }
        epochs: set[str] = set()
        run_by_epoch: dict[str, str] = {}
        for run in runs:
            for source in self.db.execute("SELECT generation_id FROM sources WHERE harness=? AND source_session_id=?", (run["harness"], run["source_session_id"])):
                epochs.add(str(source[0]))
                run_by_epoch.setdefault(str(source[0]), str(run["run_id"]))
        ids = tuple(sorted(selected_ids))
        epoch_ids = tuple(sorted(epochs))
        id_marks = ",".join("?" for _ in ids)
        epoch_marks = ",".join("?" for _ in epoch_ids)
        events = self.db.execute(
            f"SELECT * FROM events WHERE run_id IN ({id_marks}) OR (run_id IS NULL AND source_epoch IN ({epoch_marks})) ORDER BY at,rowid",
            (*ids, *epoch_ids),
        ).fetchall() if ids else ()
        relations = self.db.execute(
            f"SELECT * FROM relationships WHERE from_run_id IN ({id_marks}) ORDER BY at,rowid", ids,
        ).fetchall() if ids else ()
        event_payload = [{"id": r["event_id"], "run_id": self._logical_run_id(r["run_id"] or run_by_epoch[r["source_epoch"]]), "at": r["at"], "kind": r["kind"], "status": "observed"} for r in events]
        waits: list[dict[str, str | None]] = []
        open_waits: dict[str | None, list[str]] = {}
        for event in event_payload:
            run_id = event["run_id"]
            if event["kind"] == "wait_started" and event["at"]:
                open_waits.setdefault(run_id, []).append(event["at"])
            elif event["kind"] == "wait_result" and event["at"] and open_waits.get(run_id):
                waits.append({"start": open_waits[run_id].pop(0), "end": event["at"], "run_id": run_id, "status": "observed"})
        points = [event["at"] for event in event_payload if event["at"]]
        gaps: list[dict[str, str | int]] = []
        for left, right in zip(points, points[1:]):
            duration = self._elapsed_ms(left, right)
            if duration > 300000:
                gaps.append({"start": left, "end": right, "duration_ms": duration})
        return {"events": event_payload, "gaps": gaps, "wait_intervals": waits, "relationship_edges": [{"from_run_id": self._logical_run_id(r["from_run_id"]), "to_run_id": self._logical_run_id(r["to_run_id"]) if r["to_run_id"] else None, "kind": r["kind"], "at": r["at"], "status": r["status"]} for r in relations]}

    def _run_payload(self, row: dict[str, Any], scopes: dict, depth: int = 0) -> dict:
        own = self._run_tokens(row["run_id"])
        activity = self._run_activity(row["run_id"])
        start = own["first"] or row["started_at"]
        end = row["ended_at"] or own["last"]
        published_runs = [
            fact for fact in self._current_facts("run", run_ids={row["run_id"]}) if fact.get("run_id") == row["run_id"]
        ]
        if published_runs:
            edits = sum(
                fact.get("run_id") == row["run_id"]
                and fact.get("kind") in {"session_edit", "tool_patch", "runtime_patch", "worktree_patch"}
                and fact.get("attribution") in {"confirmed", "captured"}
                for fact in self._current_facts("change", run_ids={row["run_id"]})
            )
        else:
            edits = self.db.execute(
                "SELECT count(*) FROM changes WHERE run_id=? AND kind IN ('session_edit','tool_patch','runtime_patch','worktree_patch') AND attribution IN ('confirmed','captured')",
                (row["run_id"],),
            ).fetchone()[0]
        locations = json.loads(row["locations"]) if row["locations"] else []
        worktree = {
            "label": locations[0]["label"] if locations else None,
            "status": "observed" if locations else "unknown",
            "locations": locations,
        }
        tool_count = (
            sum(fact.get("run_id") == row["run_id"] for fact in self._current_facts("call", run_ids={row["run_id"]}))
            if published_runs
            else self.db.execute("SELECT count(*) FROM tool_calls WHERE run_id=?", (row["run_id"],)).fetchone()[0]
        )
        return {"id": self._logical_run_id(row["run_id"]), "parent_id": self._logical_run_id(row["parent_run_id"]) if row["parent_run_id"] else None, "depth": depth, "label": row["role"] or ("Main session" if row["parent_run_id"] is None else "Agent"), "role": {"value": row["role"], "status": "observed" if row["role"] else "unavailable"}, "models": json.loads(row["models"]), "start": {"at": start, "status": "observed" if start else "unavailable"}, "activity_intervals": activity, "lifespan": {"start": start, "end": end, "status": "observed" if start or end else "unavailable"}, "worktree": worktree, "scopes": scopes, "tool_calls": tool_count, "edits": edits, "evidence": []}

    @staticmethod
    def _run_depth(row: dict[str, Any], runs: list[dict[str, Any]]) -> int:
        parents = {r["run_id"]: r["parent_run_id"] for r in runs}
        depth = 0
        parent = row["parent_run_id"]
        seen: set[str] = set()
        while parent and parent not in seen:
            seen.add(parent)
            depth += 1
            parent = parents.get(parent)
        return depth

    def _parts_payload(self, call_id: str, side: str) -> list[dict]:
        rows = self.db.execute("SELECT * FROM tool_parts WHERE call_id=? AND side=? ORDER BY ordinal", (call_id, side)).fetchall()
        return [{"kind": r["kind"], "status": r["status"], "pruned_at": r["pruned_at"], "content_type": r["content_type"], "bytes": r["bytes"], "retention_tier": r["retention_tier"], "retained_version": bool(r["retained_version"]), "source_epoch": r["source_epoch"], **({"body_id": r["body_id"]} if r["body_id"] else {})} for r in rows]

    def _tools_payload(self, runs: list[dict[str, Any]], after: str | None, selected_run: str | None = None, limit: int = 100) -> dict:
        if limit < 1 or limit > 10000:
            return {"items": [], "next_after": None, "total": 0, "status": "unavailable", "reason": "invalid_cursor"}
        cursor_at, cursor_id = _tool_cursor(after)
        ids = (selected_run,) if selected_run else tuple(r["run_id"] for r in runs)
        if not ids:
            return {"items": [], "next_after": None, "total": 0, "status": "complete"}
        published = [
            fact for fact in self._current_facts("call", run_ids=set(ids))
            if fact.get("run_id") in ids
        ]
        if published or any(
            self._published_scope(str(run["harness"]), str(run["source_session_id"]))
            for run in runs
        ):
            parts = self._current_facts("part", run_ids=set(ids))

            def published_parts(call_id: str, side: str) -> list[dict[str, Any]]:
                result = []
                for fact in sorted(parts, key=lambda item: item.get("stored_ordinal", item.get("ordinal", 0))):
                    if fact.get("owner_kind") != "tool" or fact.get("call_id") != call_id or fact.get("side") != side:
                        continue
                    row = self.db.execute(
                        "SELECT status,pruned_at,body_id,bytes,retention_tier FROM tool_parts "
                        "WHERE call_id=? AND side=? AND ordinal=? AND part_id=? "
                        "AND (body_id=? OR tombstone_body_id=?)",
                        (call_id, side, fact.get("stored_ordinal", fact["ordinal"]), fact["part_id"], fact.get("body_id"), fact.get("body_id")),
                    ).fetchone()
                    status = str(row["status"]) if row is not None else fact["status"]
                    body_id = row["body_id"] if row is not None else fact.get("body_id")
                    result.append({
                        "kind": fact["kind"], "status": status,
                        "pruned_at": row["pruned_at"] if row is not None else None,
                        "content_type": fact["content_type"], "bytes": row["bytes"] if row is not None else fact.get("byte_count", 0),
                        "retention_tier": row["retention_tier"] if row is not None else fact.get("retention_tier", "B"), "retained_version": bool(fact.get("retained_version", False)),
                        "source_epoch": fact.get("source_epoch", "published"), **({"body_id": body_id} if body_id else {}),
                    })
                return result

            published.sort(key=lambda fact: (fact.get("at") or "", fact["call_id"]))
            if cursor_id is not None:
                published = [
                    fact for fact in published
                    if (fact.get("at") or "", fact["call_id"]) > (cursor_at or "", cursor_id)
                ]
            page = published[:limit]
            return {
                "items": [
                    {
                        "id": fact["call_id"], "run_id": self._logical_run_id(fact["run_id"]),
                        "ordinal": ordinal, "at": fact.get("at"),
                        "tool": {"name": fact["tool_name"], "kind": fact["tool_kind"]},
                        "operation": {"summary": fact.get("operation_summary"), "signature": fact.get("operation_signature"), "status": "available" if fact.get("operation_signature") else "unavailable"},
                        "execution": fact["execution"],
                        "input_parts": published_parts(fact["call_id"], "input"),
                        "result_parts": published_parts(fact["call_id"], "result"),
                        "source_epoch": fact["source_epoch"], "evidence": fact.get("evidence", []),
                    }
                    for ordinal, fact in enumerate(page)
                ],
                "next_after": f"{page[-1].get('at') or ''}|{page[-1]['call_id']}" if len(published) > limit else None,
                "total": len(published), "status": "complete",
            }
        placeholders = ",".join("?" for _ in ids)
        where = f"run_id IN ({placeholders})"
        total = int(self.db.execute(f"SELECT count(*) FROM tool_calls WHERE {where}", ids).fetchone()[0])
        args: tuple[Any, ...] = ids
        if cursor_id is not None and cursor_at is not None:
            cursor_clause = " AND (COALESCE(at,'') > ? OR (COALESCE(at,'') = ? AND call_id > ?))"
            args += (cursor_at, cursor_at, cursor_id)
        elif cursor_id is not None:
            # Accept cursors emitted by the first implementation while all
            # newly emitted cursors carry the timestamp tie-breaker.
            cursor_clause = " AND call_id > ?"
            args += (cursor_id,)
        else:
            cursor_clause = ""
        rows = self.db.execute(
            f"SELECT * FROM tool_calls WHERE {where}{cursor_clause} "
            "ORDER BY COALESCE(at,''), call_id LIMIT ?",
            args + (limit + 1,),
        ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            items.append({"id": row["call_id"], "run_id": self._logical_run_id(row["run_id"]), "ordinal": len(items), "at": row["at"], "tool": {"name": row["tool_name"], "kind": row["tool_kind"]}, "operation": {"summary": row["operation_summary"], "signature": row["operation_signature"], "status": "available" if row["operation_signature"] else "unavailable"}, "execution": row["execution"], "input_parts": self._parts_payload(row["call_id"], "input"), "result_parts": self._parts_payload(row["call_id"], "result"), "source_epoch": row["source_epoch"], "evidence": json.loads(row["evidence"])})
        more = len(items) > limit
        page = items[:limit]
        next_after = f"{page[-1]['at'] or ''}|{page[-1]['id']}" if more and page else None
        return {"items": page, "next_after": next_after, "total": total, "status": "complete"}

    def _changes_payload(self, runs: list[dict[str, Any]]) -> dict:
        ids = tuple(r["run_id"] for r in runs)
        if not ids:
            return {"changes": []}
        published = [
            fact for fact in self._current_facts("change", run_ids=set(ids))
            if fact.get("run_id") in ids
        ]
        if published or any(self._published_run(str(run_id)) is not None for run_id in ids):
            parts = self._current_facts("part", run_ids=set(ids))
            changes = []
            for fact in published:
                candidates = [
                    part for part in parts
                    if part.get("owner_kind") == "change" and part.get("change_id") == fact["change_id"]
                ]
                patch = None
                if candidates:
                    published_part = min(candidates, key=lambda item: (
                        int(item.get("retained_version", False)),
                        {"patch": 0, "invocation": 1, "runtime_event": 2, "pr_change": 3}.get(item["kind"], 10),
                        item.get("stored_ordinal", item["ordinal"]),
                    ))
                    row = self.db.execute(
                        "SELECT status,pruned_at,body_id,bytes,retention_tier FROM change_parts "
                        "WHERE change_id=? AND ordinal=? AND part_id=? "
                        "AND (body_id=? OR tombstone_body_id=?)",
                        (fact["change_id"], published_part.get("stored_ordinal", published_part["ordinal"]), published_part["part_id"], published_part.get("body_id"), published_part.get("body_id")),
                    ).fetchone()
                    status = str(row["status"]) if row is not None else published_part["status"]
                    body_id = row["body_id"] if row is not None else published_part.get("body_id")
                    patch = {
                        "kind": published_part["kind"], "status": status,
                        "pruned_at": row["pruned_at"] if row is not None else published_part.get("pruned_at"),
                        "retention_tier": row["retention_tier"] if row is not None else published_part.get("retention_tier", "B"), "content_type": published_part["content_type"],
                        "bytes": row["bytes"] if row is not None else published_part.get("byte_count", 0), "retained_version": bool(published_part.get("retained_version", False)), "source_epoch": published_part.get("source_epoch", "published"),
                        **({"body_id": body_id} if body_id else {}),
                    }
                changes.append({
                    "id": fact["change_id"], "kind": fact["kind"], "source": fact.get("source_epoch", "published"),
                    "repository_id": fact.get("repository_id"), "revision_id": fact.get("revision_id"),
                    "base_id": fact.get("base_id"), "merge_base_id": fact.get("merge_base_id"),
                    "captured_at": fact.get("captured_at"), "files": fact["files"],
                    "attribution": fact["attribution"], "patch": patch,
                })
            return {"changes": sorted(changes, key=lambda item: (
                item["captured_at"] or "", item["repository_id"] or "",
                item["revision_id"] or "", item["base_id"] or "",
                item["merge_base_id"] or "", item["kind"], tuple(item["files"]),
                (item["patch"] or {}).get("body_id", ""),
            ))}
        rows = self.db.execute("SELECT * FROM changes ORDER BY change_id").fetchall()
        changes = []
        for row in rows:
            if ids and row["run_id"] not in ids:
                continue
            parts = self.db.execute("SELECT * FROM change_parts WHERE change_id=?", (row["change_id"],)).fetchall()
            part_priority = {"patch": 0, "invocation": 1, "runtime_event": 2, "pr_change": 3}
            part = min(
                parts,
                key=lambda value: (
                    int(value["retained_version"]),
                    part_priority.get(str(value["kind"]), 10),
                    int(value["ordinal"]),
                ),
            ) if parts else None
            event = self.db.execute("SELECT at FROM events WHERE event_id=?", (row["source_event_id"],)).fetchone()
            captured_at = event["at"] if event else None
            if captured_at is None and row["tool_call_id"]:
                tool = self.db.execute("SELECT at FROM tool_calls WHERE call_id=?", (row["tool_call_id"],)).fetchone()
                captured_at = tool["at"] if tool else None
            patch = None
            if part is not None:
                patch = {"kind": part["kind"], "status": part["status"], "pruned_at": part["pruned_at"], "retention_tier": part["retention_tier"], "content_type": part["content_type"], "bytes": part["bytes"], "retained_version": bool(part["retained_version"]), "source_epoch": part["source_epoch"], **({"body_id": part["body_id"]} if part["body_id"] else {})}
            changes.append({"id": row["change_id"], "kind": row["kind"], "source": row["source_epoch"], "repository_id": row["repository_id"], "revision_id": row["revision_id"], "base_id": row["base_id"], "merge_base_id": row["merge_base_id"], "captured_at": captured_at, "files": json.loads(row["files"]), "attribution": row["attribution"], "patch": patch})
        # Change IDs include source-specific entropy (for example a Codex
        # generation path), so ordering by that opaque ID makes a public
        # payload vary between temporary capture roots.  Prefer observed
        # chronology and then stable semantic fields; exact timestamp ties
        # retain source order, which is itself deterministic for one source.
        changes.sort(key=lambda item: (
            item["captured_at"] or "",
            item["repository_id"] or "",
            item["revision_id"] or "",
            item["base_id"] or "",
            item["merge_base_id"] or "",
            item["kind"],
            tuple(item["files"]),
            (item["patch"] or {}).get("body_id", ""),
        ))
        return {"changes": changes}

    def read_body(self, body_id: str, after_chunk: int | None = None, limit_chunks: int = 32) -> dict:
        if not _ID_RE.fullmatch(body_id or "") or limit_chunks < 1 or limit_chunks > 10000:
            return {"ok": False, "reason": "invalid_identifier" if not _ID_RE.fullmatch(body_id or "") else "invalid_cursor"}
        start = 0 if after_chunk is None else after_chunk + 1
        if start < 0:
            return {"ok": False, "reason": "invalid_cursor"}
        body = self.db.execute("SELECT * FROM bodies WHERE body_id=?", (body_id,)).fetchone()
        if body is None:
            tombstone = self.db.execute("SELECT pruned_at FROM body_tombstones WHERE body_id=? ORDER BY pruned_at DESC LIMIT 1", (body_id,)).fetchone()
            if tombstone is not None:
                return {"ok": False, "reason": "pruned", "pruned_at": tombstone[0]}
            return {"ok": False, "reason": "unavailable"}
        if body["status"] == "pruned":
            return {"ok": False, "reason": "pruned", "pruned_at": body["pruned_at"]}
        rows = self.db.execute("SELECT seq,bytes FROM body_chunks WHERE body_id=? AND seq>=? ORDER BY seq LIMIT ?", (body_id, start, limit_chunks + 1)).fetchall()
        more = len(rows) > limit_chunks
        rows = rows[:limit_chunks]
        chunks = [{"seq": r["seq"], "bytes": len(r["bytes"]), "base64": base64.b64encode(r["bytes"]).decode("ascii")} for r in rows]
        next_after = chunks[-1]["seq"] if more and chunks else None
        return {"ok": True, "body_id": body_id, "status": body["status"], "content_type": body["content_type"], "total_bytes": body["total_bytes"], "chunks": chunks, "next_after_chunk": next_after}

    def body_belongs_to(self, harness: str, session_id: str, body_id: str) -> bool:
        status, _pruned_at = self.body_access_for_session(harness, session_id, body_id)
        return status != "unavailable"

    def body_access_for_session(self, harness: str, session_id: str, body_id: str) -> tuple[str, str | None]:
        """Return access scoped to the requested session subtree.

        A retained reference in another session must not make a pruned body
        appear available to the session that owns only its tombstone.
        """
        historical = self.db.execute(
            "SELECT a.root_session_id,a.run_id FROM publication_body_authorizations a "
            "JOIN source_versions v ON v.publication_id=a.publication_id "
            "WHERE a.body_id=? AND a.harness=? AND a.root_session_id=? AND v.state='complete' LIMIT 1",
            (body_id, harness, session_id),
        ).fetchone()
        if historical is not None:
            tombstone = self.db.execute(
                "SELECT pruned_at FROM body_tombstones WHERE body_id=? AND harness=? "
                "AND session_id=? AND (run_id='' OR run_id=?) ORDER BY pruned_at DESC LIMIT 1",
                (body_id, harness, historical["root_session_id"], historical["run_id"]),
            ).fetchone()
            if tombstone is not None:
                return "pruned", str(tombstone[0])
            present = self.db.execute("SELECT 1 FROM bodies WHERE body_id=?", (body_id,)).fetchone()
            return ("available", None) if present is not None else ("unavailable", None)
        ids = tuple(str(row["run_id"]) for row in self._family_run_rows(harness, session_id))
        if not ids:
            return "unavailable", None
        placeholders = ",".join("?" for _ in ids)
        for parts, owners, key in (("tool_parts", "tool_calls", "call_id"), ("change_parts", "changes", "change_id")):
            row = self.db.execute(f"SELECT 1 FROM {parts} p JOIN {owners} c ON c.{key}=p.{key} WHERE c.run_id IN ({placeholders}) AND p.body_id=? LIMIT 1", (*ids, body_id)).fetchone()
            if row is not None:
                return "available", None
        tombstone = self.db.execute(f"SELECT pruned_at FROM body_tombstones WHERE body_id=? AND harness=? AND (run_id IN ({placeholders}) OR (run_id='' AND session_id=?)) ORDER BY pruned_at DESC LIMIT 1", (body_id, harness, *ids, session_id)).fetchone()
        if tombstone is not None:
            return "pruned", str(tombstone[0])
        return "unavailable", None

    def prune_bodies(self, *, older_than_days: int = DEFAULT_RETENTION_DAYS, max_store_bytes: int = DEFAULT_MAX_STORE_BYTES, dry_run: bool = False, vacuum: bool = False, now: _dt.datetime | None = None) -> dict:
        """Detach eligible tier-B references while preserving their part rows.

        Selection is made per physical body, then eligible references are
        detached individually. A body shared by a durable, pinned, or
        otherwise retained reference stays available until its last retained
        reference is gone. Logical bytes describe content-addressed bodies
        removed from the store; SQLite file size is reported separately
        because only VACUUM can reclaim its free pages.
        """
        effective_now = now or _dt.datetime.now(_dt.timezone.utc)
        if effective_now.tzinfo is None:
            effective_now = effective_now.replace(tzinfo=_dt.timezone.utc)
        cutoff = (effective_now.astimezone(_dt.timezone.utc) - _dt.timedelta(days=max(0, older_than_days))).isoformat()
        path = db_path()
        physical_before = path.stat().st_size if path.exists() else 0
        page_count = int(self.db.execute("PRAGMA page_count").fetchone()[0])
        page_size = int(self.db.execute("PRAGMA page_size").fetchone()[0])
        free_pages = int(self.db.execute("PRAGMA freelist_count").fetchone()[0])
        allocated_before = max(0, page_count - free_pages) * page_size
        candidate_cursor = self.db.execute(
            """SELECT p.body_id,p.retention_tier,p.status,p.call_id AS owner,p.side,p.ordinal,
                      c.run_id,r.harness,r.source_session_id,COALESCE(s.root_session_id,r.source_session_id),
                      CASE WHEN p.side='result' THEN COALESCE(
                          p.evidenced_at,
                          (SELECT e.at FROM events e WHERE e.kind='tool_result'
                            AND e.correlation_id=c.native_call_id
                            AND e.source_epoch=c.source_epoch AND e.run_id=c.run_id
                            ORDER BY e.at DESC LIMIT 1),
                          c.at, s.captured_at)
                           ELSE COALESCE(p.evidenced_at,c.at,s.captured_at) END AS evidence_at,'tool' AS table_name
                 FROM tool_parts p JOIN tool_calls c ON c.call_id=p.call_id
                 JOIN runs r ON r.run_id=c.run_id
                 LEFT JOIN sessions s ON s.harness=r.harness AND s.session_id=r.source_session_id
                WHERE p.body_id IS NOT NULL AND p.retention_tier='B' AND p.status != 'pruned'
               UNION ALL
               SELECT p.body_id,p.retention_tier,p.status,p.change_id AS owner,NULL,p.ordinal,
                      c.run_id,r.harness,r.source_session_id,COALESCE(s.root_session_id,r.source_session_id),
                      COALESCE(p.evidenced_at,e.at,s.captured_at,'') AS evidence_at,'change' AS table_name
                 FROM change_parts p JOIN changes c ON c.change_id=p.change_id
                 JOIN runs r ON r.run_id=c.run_id
                 LEFT JOIN sessions s ON s.harness=r.harness AND s.session_id=r.source_session_id
                 LEFT JOIN events e ON e.event_id=c.source_event_id
                WHERE p.body_id IS NOT NULL AND p.retention_tier='B' AND p.status != 'pruned'
                ORDER BY evidence_at
                LIMIT 2048"""
        )
        candidate_refs: list[sqlite3.Row] = []
        while len(candidate_refs) < 2048:
            chunk = candidate_cursor.fetchmany(min(256, 2048 - len(candidate_refs)))
            if not chunk:
                break
            candidate_refs.extend(chunk)
        candidate_body_ids = tuple(dict.fromkeys(str(ref[0]) for ref in candidate_refs))
        references: list[sqlite3.Row] = []
        if candidate_body_ids:
            marks = ",".join("?" for _ in candidate_body_ids)
            reference_cursor = self.db.execute(
                f"""SELECT p.body_id,p.retention_tier,p.status,p.call_id AS owner,p.side,p.ordinal,
                          c.run_id,r.harness,r.source_session_id,s.root_session_id,
                          CASE WHEN p.side='result' THEN COALESCE(
                              p.evidenced_at,
                              (SELECT e.at FROM events e WHERE e.kind='tool_result'
                                AND e.correlation_id=c.native_call_id
                                AND e.source_epoch=c.source_epoch AND e.run_id=c.run_id
                                ORDER BY e.at DESC LIMIT 1),
                              c.at, s.captured_at)
                               ELSE COALESCE(p.evidenced_at,c.at,s.captured_at) END AS evidence_at,'tool' AS table_name
                     FROM tool_parts p JOIN tool_calls c ON c.call_id=p.call_id
                     JOIN runs r ON r.run_id=c.run_id
                     JOIN sessions s ON s.harness=r.harness AND s.session_id=r.source_session_id
                    WHERE p.body_id IN ({marks})
                    UNION ALL
                    SELECT p.body_id,p.retention_tier,p.status,p.change_id AS owner,NULL,p.ordinal,
                          c.run_id,r.harness,r.source_session_id,s.root_session_id,
                          COALESCE(p.evidenced_at,e.at,s.captured_at,'') AS evidence_at,'change' AS table_name
                     FROM change_parts p JOIN changes c ON c.change_id=p.change_id
                     JOIN runs r ON r.run_id=c.run_id
                     JOIN sessions s ON s.harness=r.harness AND s.session_id=r.source_session_id
                     LEFT JOIN events e ON e.event_id=c.source_event_id
                    WHERE p.body_id IN ({marks})""",
                candidate_body_ids + candidate_body_ids,
            )
            while True:
                chunk = reference_cursor.fetchmany(256)
                if not chunk:
                    break
                references.extend(chunk)

        # A pin targets a logical subtree, including retained mirror members.
        pin_rows = self.db.execute("SELECT harness,source_session_id,run_id FROM pins").fetchall()
        protected: set[tuple[str, str]] = set()
        for pin in pin_rows:
            harness, root, pin_target = str(pin[0]), str(pin[1]), str(pin[2])
            family = self._family_run_rows(harness, root)
            # Pins protect retained history as well as today's selected member.
            # Published ancestry, not mutable current rows, proves old subtrees.
            historical = self.db.execute(
                "SELECT DISTINCT f.metadata_json FROM version_facts f "
                "JOIN source_versions v ON v.publication_id=f.publication_id "
                "WHERE f.kind='run' AND v.state='complete' "
                "AND json_extract(f.metadata_json,'$.harness')=? "
                "AND json_extract(f.metadata_json,'$.root_session_id')=?", (harness, root)
            ).fetchall()
            family.extend(json.loads(item[0]) for item in historical)
            def pinned_logical(row: dict[str, Any]) -> str:
                return str(row.get("logical_run_id") or self._logical_run_id(row["run_id"]))

            def parent_logical(row: dict[str, Any]) -> str | None:
                if "parent_logical_run_id" in row:
                    return row["parent_logical_run_id"]
                return self._logical_run_id(row["parent_run_id"]) if row["parent_run_id"] else None

            selected = {self._logical_run_id(pin_target)}
            if pin_target == "session":
                selected = {pinned_logical(row) for row in family}
            else:
                while True:
                    expanded = selected | {pinned_logical(row) for row in family if parent_logical(row) in selected}
                    if expanded == selected:
                        break
                    selected = expanded
            protected.update((harness, row["run_id"]) for row in family if pinned_logical(row) in selected)
        pinned_body_ids: set[str] = set()
        for _harness, run_id in protected:
            pinned_body_ids.update(str(row[0]) for row in self.db.execute(
                "SELECT p.body_id FROM tool_parts p JOIN tool_calls c ON c.call_id=p.call_id WHERE c.run_id=? AND p.body_id IS NOT NULL "
                "UNION SELECT p.body_id FROM change_parts p JOIN changes c ON c.change_id=p.change_id WHERE c.run_id=? AND p.body_id IS NOT NULL",
                (run_id, run_id),
            ))

        grouped: dict[str, list[sqlite3.Row]] = {}
        for ref in references:
            grouped.setdefault(str(ref[0]), []).append(ref)
        body_ids = tuple(grouped)
        body_rows = self.db.execute(
            f"SELECT body_id,total_bytes FROM bodies WHERE status != 'pruned' AND body_id IN ({','.join('?' for _ in body_ids)})",
            body_ids,
        ).fetchall() if body_ids else ()
        sizes = {str(row[0]): int(row[1]) for row in body_rows}

        def eligible(ref: sqlite3.Row) -> bool:
            return str(ref[1]) == "B" and str(ref[2]) != "pruned" and (str(ref[7]), str(ref[6])) not in protected

        # A durable or protected reference blocks physical deletion. This is
        # the key invariant for content-addressed bodies shared across calls.
        body_candidates: list[tuple[str, str, list[sqlite3.Row]]] = []
        pinned_exempt = len(pinned_body_ids)
        for body_id, refs in grouped.items():
            if body_id not in sizes:
                continue
            oldest = min((str(ref[10]) for ref in refs), default="9999")
            if any(eligible(ref) for ref in refs):
                body_candidates.append((body_id, oldest, refs))
        body_candidates.sort(key=lambda value: value[1])
        target = max(0, allocated_before - max(0, max_store_bytes))
        selected_refs: list[sqlite3.Row] = []
        selected_keys: set[tuple[str, str, str, str, int]] = set()
        reclaimed = 0
        for body_id, _oldest, refs in body_candidates:
            for ref in refs:
                if eligible(ref) and str(ref[10]) < cutoff:
                    selected_refs.append(ref)
                    selected_keys.add((body_id, str(ref[11]), str(ref[3]), str(ref[4]), int(ref[5])))
            active = [ref for ref in refs if str(ref[2]) != "pruned"]
            if active and all((body_id, str(ref[11]), str(ref[3]), str(ref[4]), int(ref[5])) in selected_keys for ref in active):
                reclaimed += sizes[body_id]
        # Cap pruning consumes the oldest eligible references. It never marks
        # a newer sibling merely because it shares the same physical body.
        if reclaimed < target:
            for body_id, _oldest, refs in body_candidates:
                for ref in refs:
                    key = (body_id, str(ref[11]), str(ref[3]), str(ref[4]), int(ref[5]))
                    if key in selected_keys or not eligible(ref):
                        continue
                    selected_refs.append(ref)
                    selected_keys.add(key)
                    active = [candidate for candidate in refs if str(candidate[2]) != "pruned"]
                    if active and all((body_id, str(candidate[11]), str(candidate[3]), str(candidate[4]), int(candidate[5])) in selected_keys for candidate in active):
                        reclaimed += sizes[body_id]
                    if reclaimed >= target:
                        break
                if reclaimed >= target:
                    break
        selected_bodies = {str(ref[0]) for ref in selected_refs}
        delete_bodies = {
            body_id
            for body_id in selected_bodies
            if all(
                str(ref[2]) == "pruned"
                or (body_id, str(ref[11]), str(ref[3]), str(ref[4]), int(ref[5])) in selected_keys
                for ref in grouped[body_id]
            )
        }
        logical = reclaimed
        sessions_touched = {str(ref[9]) for ref in selected_refs}
        pruned_at = effective_now.astimezone(_dt.timezone.utc).isoformat()
        if not dry_run and selected_refs:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                for ref in selected_refs:
                    authorized_sessions = {str(ref[8]), str(ref[9])}
                    for authorized_session in authorized_sessions:
                        self.db.execute(
                            "INSERT OR IGNORE INTO body_tombstones(body_id,harness,session_id,run_id,pruned_at) VALUES (?,?,?,?,?)",
                            (ref[0], ref[7], authorized_session, ref[6], pruned_at),
                        )
                    if ref[11] == "tool":
                        self.db.execute("UPDATE tool_parts SET tombstone_body_id=body_id,body_id=NULL,status='pruned',pruned_at=? WHERE call_id=? AND side=? AND ordinal=?", (pruned_at, ref[3], ref[4], ref[5]))
                    else:
                        self.db.execute("UPDATE change_parts SET tombstone_body_id=body_id,body_id=NULL,status='pruned',pruned_at=? WHERE change_id=? AND ordinal=?", (pruned_at, ref[3], ref[5]))
                if delete_bodies:
                    marks = ",".join("?" for _ in delete_bodies)
                    self.db.execute(f"DELETE FROM body_chunks WHERE body_id IN ({marks})", tuple(delete_bodies))
                    self.db.execute(f"DELETE FROM bodies WHERE body_id IN ({marks})", tuple(delete_bodies))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
        if not dry_run and vacuum:
            self.db.execute("VACUUM")
        if not dry_run:
            config_path = hub_core.data_home() / RETENTION_CONFIG_REL
            config_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            config_path.write_text(_json({"older_than_days": older_than_days, "max_store_bytes": max_store_bytes}) + "\n", encoding="utf-8")
            config_path.chmod(0o600)
        physical_after = path.stat().st_size if path.exists() else physical_before
        after_page_count = int(self.db.execute("PRAGMA page_count").fetchone()[0])
        after_free_pages = int(self.db.execute("PRAGMA freelist_count").fetchone()[0])
        allocated_after = max(0, after_page_count - after_free_pages) * page_size
        unmet = max(0, allocated_after - max(0, max_store_bytes))
        return {
            "ok": True,
            "dry_run": dry_run,
            "older_than_days": older_than_days,
            "max_store_bytes": max_store_bytes,
            "bodies_pruned": len(delete_bodies),
            "parts_pruned": len(selected_refs),
            "bytes_freed": logical,
            "logical_bytes_freed": logical,
            "physical_bytes_before": physical_before,
            "physical_bytes_after": physical_after,
            "logical_allocation_before": allocated_before,
            "logical_allocation_after": allocated_after,
            "sessions_touched": len(sessions_touched),
            "pinned_exempt": pinned_exempt,
            "unmet_target": bool(unmet),
            "unmet_target_bytes": unmet,
        }

    def mutate_pin(self, harness: str, session_id: str, run_id: str | None, action: str) -> dict:
        if action not in ("add", "remove") or not all(_ID_RE.fullmatch(x or "") for x in (harness, session_id)) or (run_id is not None and not _ID_RE.fullmatch(run_id)):
            return {"ok": False, "reason": "invalid_identifier"}
        row = self.db.execute("SELECT * FROM sessions WHERE harness=? AND session_id=?", (harness, session_id)).fetchone()
        if row is None:
            return {"ok": False, "reason": "not_captured"}
        target = run_id or "session"
        allowed = {str(item["run_id"]) for item in self._family_run_rows(harness, row["root_session_id"])}
        if run_id is not None and not allowed.intersection(self._member_run_ids(run_id)):
            return {"ok": False, "reason": "invalid_identifier"}
        aliases = tuple(sorted({target, self._logical_run_id(target), *self._member_run_ids(target)})) if run_id else (target,)
        marks = ",".join("?" for _ in aliases)
        params = (harness, row["root_session_id"], *aliases)
        target = self._logical_run_id(target) if run_id else target
        if action == "add":
            if self.db.execute(f"SELECT 1 FROM pins WHERE harness=? AND source_session_id=? AND run_id IN ({marks})", params).fetchone() is None:
                self.db.execute("INSERT OR IGNORE INTO pins VALUES (?,?,?,?)", (harness, row["root_session_id"], target, str(time.time())))
        else:
            self.db.execute(f"DELETE FROM pins WHERE harness=? AND source_session_id=? AND run_id IN ({marks})", params)
        return {"ok": True, "schema_version": 1, "action": action, "pin": {"harness": harness, "session_id": row["root_session_id"], "run_id": None if target == "session" else target}}

    def list_pins(self, after: str | None = None, limit: int = 50) -> dict:
        token = _cursor_token(after)
        if limit < 1 or limit > 10000:
            return {"ok": False, "reason": "invalid_cursor"}
        rows = self.db.execute("SELECT * FROM pins ORDER BY harness, source_session_id, run_id").fetchall()
        items = []
        for row in rows:
            key = f"{row['harness']}:{row['source_session_id']}:{row['run_id']}"
            if token and key <= token:
                continue
            session = self.db.execute("SELECT * FROM sessions WHERE harness=? AND session_id=?", (row["harness"], row["source_session_id"])).fetchone()
            scope_fact = self._published_scope_fact(row["harness"], row["source_session_id"])
            root_session_id = scope_fact["root_session_id"] if scope_fact is not None else (session["root_session_id"] if session else row["source_session_id"])
            runs = self._session_rows(row["harness"], root_session_id)
            full_scopes = self._scopes(runs, row["run_id"] if row["run_id"] != "session" else None) if runs else {}
            items.append({"harness": row["harness"], "session_id": row["source_session_id"], "root_session_id": root_session_id, "run_id": None if row["run_id"] == "session" else row["run_id"], "root_type": "session" if row["run_id"] == "session" else "agent", "breadcrumb": [{"label": "Main session", "status": "available"}] if row["run_id"] != "session" else [], "status": "available" if scope_fact is not None else (session["status"] if session else "unavailable"), "scopes": {"own": full_scopes.get("own", {}), "subtree": full_scopes.get("subtree", {})}})
            if len(items) >= limit:
                break
        next_after = None if len(items) < limit else f"{items[-1]['harness']}:{items[-1]['session_id']}:{items[-1]['run_id'] or 'session'}"
        return {"ok": True, "schema_version": 1, "items": items, "next_after": next_after, "evidence": {"status": "complete", "notices": []}}
