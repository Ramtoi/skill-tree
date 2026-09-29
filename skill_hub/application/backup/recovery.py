"""skill_hub/application/backup/recovery.py — resumable post-restore recovery.

`restore.py` materializes a snapshot and quarantines every incoming project
(`path_unresolved: true`, unconditionally — a historical path string is never
evidence of local attachment). This module is what turns that quarantined
state into a finished setup, one project/source at a time, resumable across
app restarts:

* a versioned, machine-local progress record under `state/` (never backed
  up, never replayed from a snapshot);
* identity-only local-checkout discovery and validated attachment
  (`project_repository.py` does the actual Git inspection — this module
  never matches by folder or project name);
* safe, task-owned-temp-dir cloning that never touches an existing
  directory;
* git-source recovery that rechecks registered skill paths actually exist
  afterwards (`restore.restore_source` alone only proves the clone worked);
* local-only (non-git-source) skill relocation, identity-checked against the
  skill's own frontmatter when one is declared.

This module never runs sync, never publishes a backup, and never dispatches
a remote — `entrypoints/cli/recovery.py`'s `sync` command is the one place
recovery ever touches sync, and it always does so in local-only mode.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

from skill_hub import hub_core
from skill_hub.application.backup import restore as _restore
from skill_hub.domain.skills import skill_meta
from skill_hub.infrastructure.harnesses.harness_probe import resolve_binary
from skill_hub.infrastructure.registry import project_repository as repositories
from skill_hub.infrastructure.registry import sources as _sources

SCHEMA_VERSION = 1
RECOVERY_FILE = "recovery.json"
GITHUB_CACHE_FILE = "recovery-github-cache.json"
GITHUB_CACHE_TTL_SECONDS = 120
MAX_GITHUB_FETCH = 300
GITHUB_PAGE_SIZE = 100
GITHUB_TIMEOUT = 15
CLONE_TIMEOUT = 120

JOB_STATUSES = ("running", "ready", "failed", "skipped", "deferred")
DERIVED_STATUSES = ("ready", "pending", "running", "skipped", "failed", "interrupted", "deferred")

#: Statuses that count as genuinely outstanding work for `needs_recovery` and
#: `finish`'s unresolved-item check. `skipped`/`deferred` are both explicit,
#: acknowledged decisions — neither is "nothing happened here".
_OUTSTANDING_STATUSES = ("pending", "failed", "running", "interrupted")


def is_outstanding_status(status: str) -> bool:
    return status in _OUTSTANDING_STATUSES


class RecoveryError(RuntimeError):
    """Any refusal or hard failure on the recovery path. Always caught by the
    CLI layer and turned into a `{"ok": false, "error": {...}}` payload — see
    entrypoints/cli/recovery.py's contract (JSON reads must exit 0)."""

    def __init__(self, message: str, *, code: str = "recovery_error"):
        self.code = code
        super().__init__(message)


def _stamp() -> str:
    return hub_core._now_iso()


# ─────────────────────────────────────────────────────────────────────────────
# The persisted record
# ─────────────────────────────────────────────────────────────────────────────


def recovery_path(data_home: Optional[Path] = None) -> Path:
    data_home = Path(data_home) if data_home is not None else hub_core.data_home()
    return data_home / "state" / RECOVERY_FILE


def empty_record() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "operation_id": None,
        "snapshot_key": None,
        "stage": None,
        "started_at": None,
        "updated_at": None,
        "completed_at": None,
        "dismissed_at": None,
        "projects": {},
        "sources": {},
        "local_sources": {},
        "sync": None,
    }


def read_record(data_home: Optional[Path] = None) -> dict:
    """The persisted record, or an empty one if there is none yet.

    A store that EXISTS but does not parse is a hard error — same posture as
    `restore.read_pins`: silently discarding a corrupt progress record would
    make the resumable journey quietly restart, which defeats the entire
    point of persisting it (A10).
    """
    path = recovery_path(data_home)
    try:
        raw = path.read_text()
    except OSError:
        return empty_record()
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise RecoveryError(
            f"the recovery record at {path} is corrupt ({exc}) — inspect or delete it.",
            code="record_corrupt",
        )
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
        return empty_record()
    base = empty_record()
    base.update({k: v for k, v in data.items() if k in base})
    for key in ("projects", "sources", "local_sources"):
        if not isinstance(base.get(key), dict):
            base[key] = {}
    return base


def write_record(record: dict, *, data_home: Optional[Path] = None) -> None:
    path = recovery_path(data_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def current_snapshot_identity(registry: dict) -> Optional[str]:
    """A restore OPERATION's identity, not just its source.

    `restore.py` stamps a fresh `bootstrap.restored_at` on every apply, so
    pairing it with `restored_from` is what actually distinguishes two
    restores from the SAME backup repo — `restore.source_key(source)` alone
    collapses them into one identity, which would make `start_operation`
    (and `build_status`'s staleness check below) treat a brand-new restore
    as "the same operation" as one the user already finished or dismissed
    weeks ago.
    """
    bootstrap = registry.get("bootstrap") or {}
    restored_from = bootstrap.get("restored_from")
    if not restored_from:
        return None
    restored_at = bootstrap.get("restored_at") or ""
    return _restore.source_key(str(restored_from)) + "@" + str(restored_at)


def registry_content_hash(data_home: Optional[Path] = None) -> str:
    """SHA-256 of `registry.yaml`'s current bytes, or `""` if unreadable —
    the fingerprint sync evidence is keyed by (item 2): any subsequent
    attach/skip/source-recovery/set-repository changes this, invalidating a
    prior sync's evidence without needing a separate "dirty" flag."""
    reg_file = (Path(data_home) if data_home is not None else hub_core.data_home()) / "registry.yaml"
    try:
        return hashlib.sha256(reg_file.read_bytes()).hexdigest()
    except OSError:
        return ""


def has_restore_evidence(registry: dict, project_rows: Optional[list] = None) -> bool:
    """Is there any actual sign a restore happened on this machine?

    `current_snapshot_identity` covers the normal case (`bootstrap.
    restored_from` present). A project already `path_unresolved` is direct,
    independent evidence too — restore.py is the ONLY writer of that flag —
    covering an edge case where `bootstrap` itself is missing/stripped.
    Gating `needs_recovery` and the auto-init below on this (rather than on
    "is anything merely unhealthy") is what keeps a healthy, NEVER-restored
    install ungated even when it has an unrelated broken local-only source.
    """
    if current_snapshot_identity(registry) is not None:
        return True
    rows = project_rows if project_rows is not None else project_status_rows(registry, empty_record())
    return any(row["path_unresolved"] for row in rows)


def _effective_record(registry: dict, record: dict) -> dict:
    """The record to derive STATUS from — the real one, or a fresh empty one
    when it belongs to an EARLIER restore of the same/another backup.

    A stale record's rows, sync evidence, and stage describe a DIFFERENT
    operation than the one this registry is currently in; discarding all of
    it (not merely its `completed_at`/`dismissed_at`) is what makes a brand
    new restore read as fully outstanding again. This never writes — the
    record on disk is only physically reset the next time a MUTATING command
    calls `ensure_active_operation`, so a read-only `status` call can apply
    this without ever touching disk (item 1: "avoid clearing completed on
    simple status reads" — there is nothing on disk to clear here at all).
    """
    current_identity = current_snapshot_identity(registry)
    stale = (
        record.get("operation_id") is not None
        and record.get("snapshot_key") != current_identity
    )
    return empty_record() if stale else record


def ensure_active_operation(record: dict, registry: dict) -> dict:
    """Auto-initialize (or reset, if stale) the operation the first time ANY
    mutating recovery command touches it — so a direct action (a project's
    own "Attach directory", independent of the wizard) works without
    requiring `hub recovery start` first.

    Only acts when there is actual restore evidence (`has_restore_evidence`)
    — a healthy, never-restored install must never spontaneously grow a
    phantom "active operation" from an ordinary mutation. Never touches an
    already-active record for the CURRENT restore, including one already
    finished/dismissed — an unrelated mutation (a skip on a different,
    still-open item) must not silently reopen a journey the user closed.
    """
    if not has_restore_evidence(registry):
        return record
    identity = current_snapshot_identity(registry)
    if record.get("operation_id") is None or record.get("snapshot_key") != identity:
        return start_operation(record, snapshot_key=identity)
    return record


def start_operation(
    record: dict, *, snapshot_key: Optional[str], stage: Optional[str] = None
) -> dict:
    """Resume in place for the same snapshot; reset only on a new one.

    A `hub recovery start` re-run for the SAME restore (app relaunch, a
    second wizard visit) must never discard completed work, skips, or the
    current stage — only a genuinely new snapshot key (a fresh restore
    actually landed) is a reason to start over.
    """
    if record.get("snapshot_key") == snapshot_key and record.get("operation_id"):
        if stage is not None:
            record["stage"] = stage
        # Re-entering (a reopened wizard, an app relaunch) is not itself a
        # finish or a dismissal — those are their own explicit actions.
        record["completed_at"] = None
        record["dismissed_at"] = None
        record["updated_at"] = _stamp()
        return record
    fresh = empty_record()
    fresh["operation_id"] = uuid.uuid4().hex
    fresh["snapshot_key"] = snapshot_key
    fresh["stage"] = stage or "library"
    fresh["started_at"] = _stamp()
    fresh["updated_at"] = _stamp()
    return fresh


def set_stage(record: dict, stage: str) -> dict:
    record["stage"] = stage
    record["updated_at"] = _stamp()
    return record


def mark_finished(record: dict) -> dict:
    """`finish` closes the journey outright: completed AND dismissed.

    The wizard has exactly one exit action, not two — a `dismiss` with no
    `finish` (abandon without claiming done) is not part of the wired
    contract, so `finish` sets both rather than leaving `dismissed` false
    and `needs_recovery` still gating on stale failures the user just chose
    to leave for later.
    """
    now = _stamp()
    record["completed_at"] = now
    record["dismissed_at"] = now
    record["updated_at"] = now
    return record


def _readable_error(error: Any) -> str:
    """Project/global sync errors are wire data, not Python reprs."""
    if isinstance(error, str):
        return error
    if isinstance(error, dict):
        message = error.get("message") or error.get("error") or error.get("detail") or error.get("reason")
        if message is not None:
            text = str(message)
            stage = error.get("stage")
            return f"{stage}: {text}" if stage else text
        parts = [f"{key}: {_readable_error(value)}" for key, value in error.items() if value is not None]
        return ", ".join(parts) or "sync failed"
    return str(error)


def _readable_errors(errors: Any) -> list[str]:
    values = errors if isinstance(errors, list) else ([] if errors is None else [errors])
    return [message for error in values if (message := _readable_error(error))]


def record_sync_result(record: dict, result: dict, *, registry_hash: str) -> dict:
    """Persist the ACTUAL `hub recovery sync` outcome (item 2) — not just
    `ok`/`at`/`exit_code`. A restart before the app re-reads `status` must be
    able to show the real last counts/failures, not "unknown, go run it
    again". `registry_hash` is the fingerprint this evidence is valid FOR —
    `sync_is_current` invalidates it the instant that hash changes, which
    covers attach/skip/source-recovery/set-repository alike without a
    separate per-mutation "mark dirty" call anywhere else.
    """
    record["sync"] = {
        "ok": bool(result.get("ok")),
        "at": _stamp(),
        "exit_code": result.get("sync_exit_code", 0),
        "counts": result.get("counts") or {"success": 0, "skipped": 0, "failed": 0},
        "failed_projects": list(result.get("failed_projects") or []),
        "project_failures": {
            str(name): _readable_errors(errors)
            for name, errors in (result.get("project_failures") or {}).items()
        },
        "global_failures": _readable_errors(result.get("global_failures") or []),
        "error": result.get("error"),
        "registry_hash": registry_hash,
    }
    record["updated_at"] = _stamp()
    return record


def sync_evidence(record: dict) -> Optional[dict]:
    sync = record.get("sync")
    return sync if isinstance(sync, dict) else None


def sync_ran(record: dict) -> bool:
    """Has `hub recovery sync` actually run at least once THIS operation?

    Recorded by `entrypoints/cli/recovery.py`'s `sync` command after every
    attempt (success or failure) — evidence, not a promise.
    """
    sync = sync_evidence(record)
    return sync is not None and sync.get("at") is not None


def sync_is_current(record: dict, registry: dict, *, data_home: Optional[Path] = None) -> bool:
    """Does the persisted sync evidence still describe THIS registry's
    CURRENT content (item 2)? A prior sync's evidence is invalidated the
    moment anything changes the registry afterward — a new attach, a
    recovered source, a skip — not merely "per UI visit"/a fixed TTL.
    `finish_operation` requires this, not just `sync_ran`: a stale sync must
    not authorize finishing over newer, never-delivered changes.
    """
    sync = sync_evidence(record)
    if sync is None:
        return False
    stored_hash = sync.get("registry_hash")
    if not stored_hash:
        return False
    return stored_hash == registry_content_hash(data_home)


def unresolved_rows(registry: dict, record: dict) -> dict:
    """`{"projects": [...names], "sources": [...ids], "local_sources": [...skills]}`
    for every row still `pending`/`failed`/`running`/`interrupted` — the set
    `finish_operation` refuses to close over silently."""
    return {
        "projects": [
            r["name"] for r in project_status_rows(registry, record) if r["status"] in _OUTSTANDING_STATUSES
        ],
        "sources": [
            r["id"] for r in source_status_rows(registry, record) if r["status"] in _OUTSTANDING_STATUSES
        ],
        "local_sources": [
            r["skill"] for r in local_source_rows(registry, record) if r["status"] in _OUTSTANDING_STATUSES
        ],
    }


def finish_operation(registry: dict, record: dict, *, defer: bool = False) -> dict:
    """Close the journey — but never by silently pretending undecided work
    was resolved.

    Refuses (`unresolved_items`) when any project/source/local-source row is
    still outstanding, or a project was ever attached but a local sync has
    never actually run (`sync` evidence absent) — a "finished" recovery must
    not be able to imply delivery that never happened. `defer=True` is the
    explicit override: untouched/interrupted rows are marked `deferred` (a
    distinct, truthful outcome — never silently relabeled `skipped`), while
    failed rows retain their failure detail and remain retryable after reopen.
    The journey closes either way.
    """
    unresolved = unresolved_rows(registry, record)
    names = list(unresolved["projects"]) + list(unresolved["sources"]) + list(unresolved["local_sources"])
    project_rows = project_status_rows(registry, record)
    source_rows = source_status_rows(registry, record)
    local_rows = local_source_rows(registry, record)
    has_attached = any(row["attached"] for row in project_rows)
    sync_missing = has_attached and not sync_is_current(record, registry)
    sync = sync_evidence(record) or {}
    sync_counts = sync.get("counts")
    if not isinstance(sync_counts, dict):
        sync_counts = {}
    sync_failed = bool(
        sync
        and (
            not bool(sync.get("ok"))
            or bool(sync_counts.get("failed"))
            or bool(sync.get("failed_projects"))
            or bool(sync.get("project_failures"))
            or bool(sync.get("global_failures"))
            or bool(sync.get("error"))
        )
    )
    if sync_missing or sync_failed:
        names = names + ["local sync"]
    if names and not defer:
        raise RecoveryError(
            "cannot finish — unresolved: " + ", ".join(names)
            + " (resolve or skip each item, run `hub recovery sync`, or pass --defer to finish anyway)",
            code="unresolved_items",
        )
    if defer:
        project_status = {row["name"]: row["status"] for row in project_rows}
        source_status = {row["id"]: row["status"] for row in source_rows}
        local_status = {row["skill"]: row["status"] for row in local_rows}
        for name in unresolved["projects"]:
            if project_status.get(name) != "failed":
                set_project_job(record, name, "deferred", detail="left pending at finish (--defer)")
        for source_id in unresolved["sources"]:
            if source_status.get(source_id) != "failed":
                set_source_job(record, source_id, "deferred", detail="left pending at finish (--defer)")
        for skill in unresolved["local_sources"]:
            if local_status.get(skill) != "failed":
                set_local_source_job(record, skill, "deferred", detail="left pending at finish (--defer)")
    return mark_finished(record)


def _set_job_outcome(bucket: dict, key: str, status: str, *, detail: Optional[str] = None, **extra: Any) -> dict:
    if status not in JOB_STATUSES:
        raise ValueError(f"unknown job status: {status}")
    entry = {"status": status, "detail": detail, "updated_at": _stamp()}
    entry.update(extra)
    bucket[key] = entry
    return entry


def set_project_job(
    record: dict, name: str, status: str, *, detail: Optional[str] = None, pid: Optional[int] = None
) -> dict:
    entry = _set_job_outcome(record.setdefault("projects", {}), name, status, detail=detail, pid=pid)
    record["updated_at"] = _stamp()
    return entry


def set_source_job(
    record: dict, source_id: str, status: str, *, detail: Optional[str] = None, pid: Optional[int] = None
) -> dict:
    entry = _set_job_outcome(record.setdefault("sources", {}), source_id, status, detail=detail, pid=pid)
    record["updated_at"] = _stamp()
    return entry


def clear_project_job(record: dict, name: str) -> None:
    """Drop a project's record entry — used when a fresh decision (a new
    repository association) supersedes a prior explicit skip."""
    record.setdefault("projects", {}).pop(name, None)
    record["updated_at"] = _stamp()


def set_local_source_job(
    record: dict, skill_name: str, status: str, *, detail: Optional[str] = None,
    path: Optional[str] = None, pid: Optional[int] = None,
) -> dict:
    entry = _set_job_outcome(
        record.setdefault("local_sources", {}), skill_name, status, detail=detail, pid=pid, path=path,
    )
    record["updated_at"] = _stamp()
    return entry


def _pid_alive(pid: Optional[int]) -> bool:
    """Read-only liveness probe (`status` must never lock or mutate).

    Signal 0 sends nothing; it only asks the kernel whether `pid` exists and
    is visible to us. `PermissionError` still means "exists" (owned by
    another user context); anything else is "gone".
    """
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _derive_status(entry: dict, *, healthy_now: bool) -> str:
    """One job-bucket entry (or `{}`) + a live health check → a DERIVED_STATUSES value.

    `healthy_now` always wins over a stale "ready"/"failed" in the record —
    persisted state is an overlay, never proof (A14): a directory that
    vanished after a successful attach must not keep reading `ready`.
    """
    status = entry.get("status")
    if status == "running":
        return "running" if _pid_alive(entry.get("pid")) else "interrupted"
    if healthy_now:
        return "ready"
    if status in ("skipped", "deferred", "failed"):
        return status
    return "pending"


# ─────────────────────────────────────────────────────────────────────────────
# Status derivation (registry + filesystem + record → one payload)
# ─────────────────────────────────────────────────────────────────────────────


def project_status_rows(registry: dict, record: dict) -> list:
    rows = []
    projects = registry.get("projects") or {}
    proj_record = record.get("projects") or {}
    for name in sorted(projects):
        cfg = projects[name]
        if not isinstance(cfg, dict):
            continue
        entry = proj_record.get(name) or {}
        raw_path = cfg.get("path")
        path_unresolved = bool(cfg.get("path_unresolved"))
        exists = bool(raw_path) and Path(str(raw_path)).expanduser().is_dir()
        attached = exists and not path_unresolved
        rows.append(
            {
                "name": name,
                "path": raw_path,
                "path_unresolved": path_unresolved,
                "attached": attached,
                "repository": cfg.get("repository"),
                "status": _derive_status(entry, healthy_now=attached),
                "detail": entry.get("detail"),
                "updated_at": entry.get("updated_at"),
            }
        )
    return rows


def source_status_rows(registry: dict, record: dict) -> list:
    """`healthy` requires the cache AND every skill this source owns to
    actually resolve (A9) — a present `.git` dir alone previously read
    `ready` even when `restore_sources` had just reported missing registered
    skill paths inside a clone that otherwise "succeeded"."""
    rows = []
    sources_cfg = registry.get("sources") or {}
    src_record = record.get("sources") or {}
    for source_id in sorted(sources_cfg):
        cfg = sources_cfg[source_id]
        if not isinstance(cfg, dict) or (cfg.get("type") or "git") != "git":
            continue
        entry = src_record.get(source_id) or {}
        cache = Path(cfg.get("cache") or str(_sources.source_worktree_dir(source_id))).expanduser()
        cache_healthy = (cache / ".git").exists()
        missing_paths = _source_missing_skill_paths(registry, source_id) if cache_healthy else []
        healthy = cache_healthy and not missing_paths
        detail = entry.get("detail")
        if cache_healthy and missing_paths:
            detail = "cache present but missing registered path(s): " + ", ".join(missing_paths)
        rows.append(
            {
                "id": source_id,
                "url": cfg.get("url"),
                "cache": str(cache),
                "healthy": healthy,
                "status": _derive_status(entry, healthy_now=healthy),
                "detail": detail,
                "updated_at": entry.get("updated_at"),
            }
        )
    return rows


def _local_source_path(skill_cfg: dict) -> Optional[Path]:
    raw = skill_cfg.get("source") if isinstance(skill_cfg, dict) else None
    if not raw:
        return None
    try:
        return Path(str(raw)).expanduser()
    except (OSError, ValueError):
        return None


def local_source_candidates(registry: dict) -> list:
    """Skills owned by no registered git source whose content is missing here (F4)."""
    out = []
    skills = registry.get("skills") or {}
    for name in sorted(skills):
        cfg = skills[name]
        if not isinstance(cfg, dict):
            continue
        ownership = _sources.infer_skill_ownership(name, cfg)
        if ownership["managed"] != "local":
            continue
        path = _local_source_path(cfg)
        if path is None or _skill_source_exists(cfg):
            continue
        out.append({"skill": name, "missing_path": str(path)})
    return out


def local_source_rows(registry: dict, record: dict) -> list:
    rows = []
    loc_record = record.get("local_sources") or {}
    candidates = {row["skill"]: row for row in local_source_candidates(registry)}
    skills = registry.get("skills") or {}
    for name in loc_record:
        cfg = skills.get(name)
        if (name not in candidates and isinstance(cfg, dict)
                and _sources.infer_skill_ownership(name, cfg)["managed"] == "local"):
            candidates[name] = {"skill": name, "missing_path": str(_local_source_path(cfg) or "")}
    for name, candidate in sorted(candidates.items()):
        entry = loc_record.get(name) or {}
        skill_cfg = (registry.get("skills") or {}).get(name) or {}
        healthy = _skill_source_exists(skill_cfg)
        rows.append(
            {
                "skill": name,
                "missing_path": candidate["missing_path"],
                "status": _derive_status(entry, healthy_now=healthy),
                "detail": entry.get("detail"),
                "path": entry.get("path"),
                "updated_at": entry.get("updated_at"),
            }
        )
    return rows


def summarize_rows(rows: list) -> dict:
    counts = {status: 0 for status in DERIVED_STATUSES}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    counts["total"] = len(rows)
    return counts


def build_status(registry: dict, record: Optional[dict] = None, *, data_home: Optional[Path] = None) -> dict:
    if record is None:
        record = read_record(data_home=data_home)
    # A record from a DIFFERENT, earlier restore of the same (or another)
    # backup describes a DIFFERENT operation — none of its rows, sync
    # evidence, or stage apply here. `_effective_record` reads as a fresh
    # empty one in that case; this function never writes, so a genuinely
    # stale record on disk is only physically reset the next time a
    # MUTATING command calls `ensure_active_operation` (item 1: "avoid
    # clearing completed on simple status reads").
    effective = _effective_record(registry, record)
    project_rows = project_status_rows(registry, effective)
    source_rows = source_status_rows(registry, effective)
    local_rows = local_source_rows(registry, effective)
    has_pending_work = any(
        row["status"] in _OUTSTANDING_STATUSES for row in project_rows + source_rows + local_rows
    )
    completed = bool(effective.get("completed_at"))
    dismissed = bool(effective.get("dismissed_at"))
    active_operation = effective.get("operation_id") is not None and not (completed or dismissed)
    # `needs_recovery` stays true for the WHOLE life of an active operation —
    # not just while rows are outstanding — so the reopen banner survives
    # every row becoming ready/skipped up until the user actually runs sync
    # and calls `finish` (item 1). A never-started, never-restored install
    # only gates on genuine live outstanding work AND actual restore evidence
    # (`has_restore_evidence`) — an unrelated broken local-only source on a
    # healthy machine that never restored anything must never trigger this.
    needs_recovery = not (completed or dismissed) and (
        active_operation or (has_restore_evidence(registry, project_rows) and has_pending_work)
    )
    bootstrap = registry.get("bootstrap") or {}
    backup_cfg = registry.get("backup") or {}
    sync_data = sync_evidence(effective)
    return {
        "schema_version": SCHEMA_VERSION,
        "operation_id": effective.get("operation_id"),
        "stage": effective.get("stage"),
        "needs_recovery": needs_recovery,
        "completed": completed,
        "dismissed": dismissed,
        "completed_at": effective.get("completed_at"),
        "dismissed_at": effective.get("dismissed_at"),
        "bootstrap": {
            "completed": bool(bootstrap.get("completed_at")),
            "completed_at": bootstrap.get("completed_at"),
            "restored_from": bootstrap.get("restored_from"),
        },
        "backup": {"pending_reconcile": bool(backup_cfg.get("pending_reconcile"))},
        "projects": project_rows,
        "projects_summary": summarize_rows(project_rows),
        "sources": source_rows,
        "local_sources": local_rows,
        "sync_result": sync_data,
        "sync_current": bool(sync_data) and sync_is_current(effective, registry, data_home=data_home),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Repository association (no attachment implied — PLAN §2/§3)
# ─────────────────────────────────────────────────────────────────────────────


def _project_cfg(registry: dict, name: str) -> dict:
    cfg = (registry.get("projects") or {}).get(name)
    if not isinstance(cfg, dict):
        raise RecoveryError(f"unknown project '{name}'", code="unknown_project")
    return cfg


def set_repository(
    registry: dict, project_name: str, url: str, *, remote: str = "origin", subdirectory: str = "."
) -> dict:
    cfg = _project_cfg(registry, project_name)
    try:
        association = repositories.validate_repository_association(
            {"url": url, "remote": remote, "subdirectory": subdirectory}
        )
    except repositories.RepositoryError as exc:
        raise RecoveryError(str(exc), code=exc.code)
    cfg["repository"] = asdict(association)
    return {"project": project_name, "repository": cfg["repository"]}


# ─────────────────────────────────────────────────────────────────────────────
# Identity-only local discovery (PLAN §2, A4)
# ─────────────────────────────────────────────────────────────────────────────


def discover_matches(registry: dict, project_name: str, roots) -> dict:
    """Identity-only matches, each `path` already the project's REGISTERED
    subdirectory (not the bare checkout root) — `attach` validates the saved
    association's `subdirectory` against whatever `path` it is given, so a
    match discover offers must already point at the right directory or
    `attach` refuses it as a `subdirectory_mismatch` for a "match" that was
    supposed to just work."""
    cfg = _project_cfg(registry, project_name)
    saved = cfg.get("repository")
    if saved is None:
        raise RecoveryError(
            f"project '{project_name}' has no repository association — "
            "connect one first, or choose a local checkout directly",
            code="no_repository",
        )
    try:
        target_assoc = repositories.validate_repository_association(saved)
        target_identity = repositories.normalize_repository_url(target_assoc.url)
    except repositories.RepositoryError as exc:
        raise RecoveryError(str(exc), code=exc.code)
    subdirectory = target_assoc.subdirectory
    result = repositories.discover_checkouts(
        [Path(r) for r in roots],
        subdirectories=(subdirectory,) if subdirectory != "." else (),
    )
    matches = []
    for candidate in result.candidates:
        if subdirectory != "." and subdirectory not in candidate.subdirectories:
            # The checkout is real and the identity may even match, but the
            # exact registered subdirectory isn't present here — not usable.
            continue
        for remote in candidate.remotes:
            try:
                identity = repositories.normalize_repository_url(remote.url)
            except repositories.RepositoryError:
                continue
            if identity == target_identity:
                match_path = (
                    candidate.path if subdirectory == "." else str(Path(candidate.path) / subdirectory)
                )
                matches.append(
                    {
                        "path": match_path,
                        "git_root": candidate.git_root,
                        "is_worktree": candidate.is_worktree,
                        "matched_remote": remote.remote,
                        "subdirectories": list(candidate.subdirectories),
                    }
                )
                break
    return {
        "matches": matches,
        "issues": [{"code": i.code, "message": i.message, "field": i.field} for i in result.issues],
        "truncated": result.truncated,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Attachment (PLAN §2) — never touches `clean_project_artifacts`
# ─────────────────────────────────────────────────────────────────────────────


def plan_attach(
    registry: dict, project_name: str, path, *, remote: Optional[str] = None, final_path=None
) -> dict:
    """Validate a chosen local checkout for `project_name`. Never mutates.

    `final_path`, when given, is the EVENTUAL destination — identity/
    subdirectory validation still inspects `path` (which may be a STAGED,
    not-yet-committed clone), but the returned `new_path` and the
    collision-with-another-project check use `final_path` instead. `clone`
    uses this to validate a staged clone BEFORE renaming it into place
    (item 4): a failed validation must never leave an unattached checkout
    sitting at the real destination.

    Returns `{"new_path", "old_path", "adopted_repository"}` for the CLI
    layer to apply under lock. Raises `RecoveryError` for every refusal —
    unknown project, bad/symlink path, path collision, missing/ambiguous/
    mismatched remote, or a wrong subdirectory — the caller turns each into
    a distinct `error.code` in the JSON payload.
    """
    cfg = _project_cfg(registry, project_name)
    target = Path(path).expanduser()
    if target.is_symlink():
        raise RecoveryError(f"refusing a symlink destination: {target}", code="invalid_path")
    if not target.is_dir():
        raise RecoveryError(f"selected path does not exist or is not a directory: {target}", code="invalid_path")
    destination_target = Path(final_path).expanduser() if final_path is not None else target
    if destination_target.is_symlink():
        raise RecoveryError(f"refusing a symlink destination: {destination_target}", code="invalid_path")
    resolved = destination_target.resolve()

    for other_name, other_cfg in (registry.get("projects") or {}).items():
        if other_name == project_name or not isinstance(other_cfg, dict):
            continue
        if other_cfg.get("path_unresolved"):
            continue
        other_raw = other_cfg.get("path")
        if not other_raw:
            continue
        try:
            if Path(other_raw).expanduser().resolve() == resolved:
                raise RecoveryError(f"path already used by project '{other_name}'", code="path_in_use")
        except OSError:
            continue

    saved = cfg.get("repository")
    adopted = None
    if saved is not None:
        try:
            saved_assoc = repositories.validate_repository_association(saved)
        except repositories.RepositoryError as exc:
            raise RecoveryError(str(exc), code=exc.code) from exc
        _check_identity(target, saved_assoc, remote=remote, require=True)
    else:
        try:
            remotes = repositories.inspect_project_remotes(target)
        except repositories.RepositoryError:
            remotes = ()
        if len(remotes) > 1 and remote is None:
            names = sorted({r.remote for r in remotes})
            raise RecoveryError(
                f"'{target}' has multiple remotes ({', '.join(names)}) — pass --remote to choose one",
                code="ambiguous_remote",
            )
        if remotes:
            try:
                inspection = repositories.inspect_project_repository(target, remote=remote or remotes[0].remote)
                adopted = inspection.association
            except repositories.RepositoryError:
                adopted = None
        # No remotes at all (or inspection failed): a plain local folder —
        # existing non-Git projects remain supported without inventing one.

    old_raw = cfg.get("path")
    return {
        "project": project_name,
        "new_path": str(resolved),
        "old_path": str(Path(old_raw).expanduser()) if old_raw else None,
        "adopted_repository": asdict(adopted) if adopted is not None else None,
    }


def _check_identity(target: Path, saved_assoc, *, remote: Optional[str], require: bool) -> None:
    try:
        remotes = repositories.inspect_project_remotes(target)
    except repositories.RepositoryError as exc:
        if require:
            raise RecoveryError(
                f"'{target}' does not look like the associated repository ({exc}) — "
                "choose a different checkout or change the repository association",
                code="repository_mismatch",
            )
        return
    if not remotes:
        raise RecoveryError(
            f"'{target}' has no Git remotes — choose a different checkout or change the "
            "repository association",
            code="repository_mismatch",
        )
    if remote is not None:
        candidates = [r for r in remotes if r.remote == remote]
        if not candidates:
            raise RecoveryError(f"'{target}' has no remote named '{remote}'", code="repository_mismatch")
    elif len(remotes) > 1:
        matching = [r for r in remotes if repositories.same_repository(r, saved_assoc)]
        if len(matching) == 1:
            candidates = matching
        else:
            names = sorted({r.remote for r in remotes})
            raise RecoveryError(
                f"'{target}' has multiple remotes ({', '.join(names)}) — pass --remote to choose one",
                code="ambiguous_remote",
            )
    else:
        candidates = list(remotes)

    if saved_assoc.subdirectory != ".":
        try:
            inspection = repositories.inspect_project_repository(target, remote=candidates[0].remote)
        except repositories.RepositoryError as exc:
            raise RecoveryError(str(exc), code="repository_mismatch")
        if inspection.association.subdirectory != saved_assoc.subdirectory:
            raise RecoveryError(
                f"'{target}' is at subdirectory '{inspection.association.subdirectory}', "
                f"but the associated repository expects '{saved_assoc.subdirectory}'",
                code="subdirectory_mismatch",
            )
        candidate = inspection.association
    else:
        candidate = candidates[0]

    if not repositories.same_repository(candidate, saved_assoc):
        raise RecoveryError(
            f"'{target}' is a different repository than the one associated with this project — "
            "choose a different checkout or change the repository association",
            code="repository_mismatch",
        )


# ─────────────────────────────────────────────────────────────────────────────
# Safe cloning (PLAN §3, A8)
# ─────────────────────────────────────────────────────────────────────────────


def _git_env() -> dict:
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def stage_clone(
    url: str,
    destination,
    *,
    branch: Optional[str] = None,
    timeout: int = CLONE_TIMEOUT,
    registry: Optional[dict] = None,
) -> dict:
    """Clone into a task-owned temp SIBLING of `destination`. Never touches
    `destination` itself — `commit_clone` does that, under the lock.

    A registry snapshot lets project clones reuse restore's established
    credential-aware GitHub transport. Authentication is passed to this one
    child process and never written back to Git config, remotes, or backup
    state. Direct callers without a registry retain the plain Git transport.
    """
    destination = Path(destination).expanduser()
    try:
        if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
            raise RecoveryError(f"destination is not a regular directory: {destination}", code="invalid_destination")
        if not destination.parent.is_dir():
            raise RecoveryError(
                f"destination's parent directory does not exist: {destination.parent}", code="invalid_destination"
            )
        if destination.exists() and any(destination.iterdir()):
            raise RecoveryError(f"destination is not empty: {destination}", code="destination_not_empty")
        temp_dir = Path(tempfile.mkdtemp(dir=destination.parent, prefix=f".{destination.name}.recovery-clone-"))
    except OSError as exc:
        raise RecoveryError(f"cannot prepare clone destination: {exc}", code="invalid_destination") from exc
    transports: list[dict[str, Any]]
    if registry is None:
        transports = [{"method": "configured", "url": str(url), "args": [], "env": {}}]
    else:
        transports = _restore.source_transport_attempts(str(url), registry)
    attempts: list[dict] = []
    for index, transport in enumerate(transports):
        args = ["git", *transport["args"], "clone", "--quiet"]
        if branch:
            args += ["--branch", branch]
        args += [transport["url"], str(temp_dir)]
        env = _git_env()
        env.update(transport["env"])
        try:
            proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            cleanup_clone_temp(temp_dir)
            raise RecoveryError("git clone timed out", code="clone_timeout")
        except KeyboardInterrupt:
            # A cancelled clone cleans up only the temp dir it created — the
            # interrupt itself still propagates so the caller sees it.
            cleanup_clone_temp(temp_dir)
            raise
        except OSError as exc:
            cleanup_clone_temp(temp_dir)
            raise RecoveryError(f"git clone failed to start: {exc}", code="clone_failed")
        if proc.returncode == 0:
            return {"temp_dir": str(temp_dir), "destination": str(destination)}
        attempts.append(
            {
                "transport": transport["method"],
                "error": _restore._redact_git_detail(proc.stderr or proc.stdout),
            }
        )
        if (
            index + 1 >= len(transports)
            or transport["method"] != "ssh"
            or not _restore._ssh_auth_failure(proc)
        ):
            break
        cleanup_clone_temp(temp_dir)

    cleanup_clone_temp(temp_dir)
    summary = "; ".join(
        item["transport"] + ": " + item["error"] for item in attempts
    )
    raise RecoveryError(summary or "git clone failed", code="clone_failed")


def commit_clone(temp_dir, destination) -> Path:
    """Re-validate at commit time (races the preview may have gone stale
    against) then move the staged clone into place. `destination` present and
    EMPTY is explicitly permitted (removed then replaced); present and
    non-empty is refused — an existing checkout is never overwritten."""
    temp_dir = Path(temp_dir)
    destination = Path(destination).expanduser()
    if not temp_dir.is_dir():
        raise RecoveryError("staged clone is missing", code="stage_missing")
    if destination.is_symlink():
        cleanup_clone_temp(temp_dir)
        raise RecoveryError(f"refusing a symlink destination: {destination}", code="invalid_path")
    if destination.exists():
        if any(destination.iterdir()):
            cleanup_clone_temp(temp_dir)
            raise RecoveryError(f"destination is not empty: {destination}", code="destination_not_empty")
        try:
            destination.rmdir()
        except OSError as exc:
            cleanup_clone_temp(temp_dir)
            raise RecoveryError(f"could not remove empty destination {destination}: {exc}", code="commit_failed")
    if not destination.parent.is_dir():
        cleanup_clone_temp(temp_dir)
        raise RecoveryError(
            f"destination's parent directory no longer exists: {destination.parent}", code="invalid_destination"
        )
    try:
        os.rename(temp_dir, destination)
    except OSError as exc:
        raise RecoveryError(f"could not finalize clone at {destination}: {exc}", code="commit_failed")
    return destination


def cleanup_clone_temp(temp_dir) -> None:
    shutil.rmtree(Path(temp_dir), ignore_errors=True)


# ─────────────────────────────────────────────────────────────────────────────
# GitHub repository selection (PLAN §3, A5) — credential-free, bounded, cached
# ─────────────────────────────────────────────────────────────────────────────


def _github_cache_path(data_home: Optional[Path] = None) -> Path:
    data_home = Path(data_home) if data_home is not None else hub_core.data_home()
    return data_home / "state" / GITHUB_CACHE_FILE


def _github_error(code: str, message: str) -> dict:
    """Flat `error_kind` + `error` (a plain string) — the wire shape
    `RecoveryGithubRepos` in `recoveryContract.ts` reads; a nested
    `{code, message}` object is silently dropped by its `strOrNull` reader."""
    return {
        "ok": False, "repositories": [], "page": None, "per_page": None, "has_more": False,
        "truncated": False, "error_kind": code, "error": message,
    }


def _repo_row(item: dict) -> dict:
    return {
        "full_name": item.get("full_name"),
        "url": item.get("clone_url"),
        "ssh_url": item.get("ssh_url"),
        "private": bool(item.get("private")),
        "updated_at": item.get("updated_at"),
        "default_branch": item.get("default_branch"),
    }


def _gh_api(gh: str, path: str, *, timeout: int) -> tuple[Optional[list], Optional[dict]]:
    try:
        proc = subprocess.run([gh, "api", path], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, {"code": "timeout", "message": "gh api timed out"}
    except OSError as exc:
        return None, {"code": "gh_failed", "message": str(exc)}
    if proc.returncode != 0:
        blob = (proc.stderr or proc.stdout or "").strip()
        if "auth login" in blob.lower() or "authentication" in blob.lower() or "401" in blob:
            return None, {"code": "unauthenticated", "message": "gh is not authenticated — run `gh auth login`"}
        return None, {"code": "gh_failed", "message": blob or "gh api failed"}
    try:
        payload = json.loads(proc.stdout or "[]")
    except ValueError:
        return None, {"code": "gh_failed", "message": "gh api returned unparseable output"}
    if not isinstance(payload, list):
        return None, {"code": "gh_failed", "message": "unexpected gh api response shape"}
    return payload, None


def _fetch_repository_chunk(
    gh: str, *, start_page: int, max_new: int, timeout: int
) -> tuple[Optional[list], int, bool, Optional[dict]]:
    """`(new_repos, next_page, truncated, error)` — fetches starting at
    `start_page`, stopping after `max_new` repos or the account's real end.

    `truncated` is True only when the account genuinely has more beyond this
    chunk: a caller (item 6) can then fetch the NEXT chunk starting at
    `next_page` instead of the search silently looking like "that's
    everything, no matches beyond here" once the account exceeds one chunk.
    """
    out: list = []
    page = start_page
    while len(out) < max_new:
        payload, error = _gh_api(
            gh, f"user/repos?per_page={GITHUB_PAGE_SIZE}&page={page}&sort=full_name", timeout=timeout,
        )
        if error is not None:
            return None, page, False, error
        for item in payload:
            if isinstance(item, dict):
                out.append(_repo_row(item))
        page += 1
        if len(payload) < GITHUB_PAGE_SIZE:
            return out, page, False, None
    return out, page, True, None


def _gh_current_login(gh: str, *, timeout: int) -> Optional[str]:
    """The authenticated account's login, or None. Used ONLY to key the
    search cache — never persisted anywhere else, never in a response body."""
    try:
        proc = subprocess.run([gh, "api", "user"], capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout or "{}")
    except ValueError:
        return None
    login = data.get("login") if isinstance(data, dict) else None
    return str(login) if login else None


def _read_github_cache(data_home: Optional[Path], *, login: Optional[str]) -> Optional[dict]:
    """`{"repositories": [...], "next_page": int, "truncated": bool}`, or None
    on a miss.

    A cache with no known `login` to key it by is NEVER trusted, and never
    written either (below) — switching `gh` accounts must not risk serving
    a previous account's repository list.
    """
    if not login:
        return None
    path = _github_cache_path(data_home)
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("login") != login:
        return None
    fetched_at = raw.get("fetched_at")
    if not isinstance(fetched_at, (int, float)) or time.time() - fetched_at > GITHUB_CACHE_TTL_SECONDS:
        return None
    repos = raw.get("repositories")
    if not isinstance(repos, list):
        return None
    return {
        "repositories": repos,
        "next_page": int(raw.get("next_page") or 1),
        "truncated": bool(raw.get("truncated")),
    }


def _write_github_cache(
    repos: list, *, data_home: Optional[Path], login: Optional[str], next_page: int, truncated: bool
) -> None:
    if not login:
        return
    path = _github_cache_path(data_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(
            {
                "fetched_at": time.time(), "login": login, "repositories": repos,
                "next_page": next_page, "truncated": truncated,
            }
        )
    )
    os.replace(tmp, path)


def list_github_repositories(
    query: Optional[str] = None, *, page: int = 1, per_page: int = 30,
    timeout: int = GITHUB_TIMEOUT, data_home: Optional[Path] = None, fetch_more: bool = False,
) -> dict:
    """`fetch_more=True` (item 6) extends the cached/bounded search by
    another chunk starting where the last fetch left off (`next_page`),
    rather than the account's accessible repositories being silently capped
    at `MAX_GITHUB_FETCH` forever — the caller re-issues the same query with
    `fetch_more` once `truncated` comes back true and it wants to keep
    looking. Cheap when nothing is truncated (or nothing is cached yet):
    behaves exactly like a normal cached search.
    """
    page = max(1, int(page))
    per_page = max(1, min(int(per_page), 100))
    gh = resolve_binary("gh")
    if gh is None:
        return _github_error("gh_unavailable", "the gh CLI is not installed or not on PATH")

    if not query:
        payload, error = _gh_api(gh, f"user/repos?per_page={per_page}&page={page}&sort=full_name", timeout=timeout)
        if error is not None:
            return _github_error(error["code"], error["message"])
        repos = [_repo_row(item) for item in payload if isinstance(item, dict)]
        return {
            "ok": True, "repositories": repos, "page": page, "per_page": per_page,
            "has_more": len(payload) == per_page, "truncated": False, "error_kind": None, "error": None,
        }

    login = _gh_current_login(gh, timeout=timeout)
    cached = _read_github_cache(data_home, login=login)
    if cached is None:
        repos_all, next_page, truncated, error = _fetch_repository_chunk(
            gh, start_page=1, max_new=MAX_GITHUB_FETCH, timeout=timeout
        )
        if error is not None:
            return _github_error(error["code"], error["message"])
        _write_github_cache(repos_all, data_home=data_home, login=login, next_page=next_page, truncated=truncated)
    elif fetch_more and cached["truncated"]:
        more, next_page, truncated, error = _fetch_repository_chunk(
            gh, start_page=cached["next_page"], max_new=MAX_GITHUB_FETCH, timeout=timeout
        )
        if error is not None:
            return _github_error(error["code"], error["message"])
        repos_all = cached["repositories"] + more
        _write_github_cache(repos_all, data_home=data_home, login=login, next_page=next_page, truncated=truncated)
    else:
        repos_all, truncated = cached["repositories"], cached["truncated"]

    needle = query.strip().lower()
    filtered = [r for r in repos_all if needle in (r.get("full_name") or "").lower()]
    start = (page - 1) * per_page
    page_items = filtered[start : start + per_page]
    return {
        "ok": True,
        "repositories": page_items,
        "page": page,
        "per_page": per_page,
        "has_more": start + per_page < len(filtered),
        # True means "the accessible-account fetch itself was capped" — call
        # again with `fetch_more=True` for the next chunk; it does not mean
        # "no more matches anywhere", even when this page has none.
        "truncated": truncated,
        "error_kind": None,
        "error": None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Git-source recovery (PLAN §4, A9) — reuses restore.restore_source verbatim
# ─────────────────────────────────────────────────────────────────────────────


def _skill_source_exists(skill_cfg: dict) -> bool:
    raw = skill_cfg.get("source") if isinstance(skill_cfg, dict) else None
    if not raw:
        return False
    try:
        path = Path(str(raw)).expanduser()
        if skill_cfg.get("type", "claude-skill") == "claude-skill":
            return path.is_dir() and (path / "SKILL.md").is_file()
        return path.exists()
    except (OSError, ValueError):
        return False


def _source_missing_skill_paths(registry: dict, source_id: str) -> list:
    """Every skill this source owns whose registered path does not actually
    exist here — shared by `source_status_rows` (A9's live health check) and
    `restore_one_source` (A9's post-clone recheck): clone success alone never
    proves the registered skill paths inside it are usable."""
    skills = registry.get("skills") or {}
    return [
        name
        for name in _sources.source_owned_skill_names(registry, source_id)
        if isinstance(skills.get(name), dict) and not _skill_source_exists(skills[name])
    ]


def restore_one_source(registry: dict, source_id: str, *, data_home: Optional[Path] = None) -> dict:
    """`restore.restore_source` for ONE id, plus the post-clone skill-path
    recheck PLAN §4 calls out: clone success alone is not sufficient (A9).

    Callers persist `registry` (and the recovery record) after EACH call,
    not once after a whole `--all` batch — a later source crashing must
    never cost an earlier source's already-successful recovery (A9/A10).
    """
    try:
        outcome = _restore.restore_source(registry, source_id, data_home=data_home)
    except _restore.RestoreError as exc:
        return {"ok": False, "source": source_id, "error": str(exc), "missing_skill_paths": []}
    missing = _source_missing_skill_paths(registry, source_id)
    outcome["missing_skill_paths"] = missing
    if missing:
        outcome["ok"] = False
    return outcome


def restore_sources(registry: dict, source_ids, *, data_home: Optional[Path] = None) -> list:
    """Batch convenience for callers that don't need per-id persistence
    between attempts (tests, scripts). `entrypoints/cli/recovery.py`'s
    `restore-source` command calls `restore_one_source` directly instead, so
    it can save the registry and the record after each one."""
    return [restore_one_source(registry, source_id, data_home=data_home) for source_id in source_ids]


# ─────────────────────────────────────────────────────────────────────────────
# Local-only skill source relocation (PLAN §4, F4, A12)
# ─────────────────────────────────────────────────────────────────────────────


def set_local_source(registry: dict, skill_name: str, path) -> dict:
    """Relocate a local-only skill's content — never onto an empty directory
    or unparseable/missing SKILL.md content (F4, A12).

    `claude-skill`: requires a SKILL.md the EXISTING parser can actually
    read (`skill_meta.parse_skill_frontmatter`); a directory with no SKILL.md
    at all, or one whose frontmatter fence doesn't parse, is refused outright
    — explicit selection is never a substitute for actual content. A
    declared name that DIFFERS from `skill_name` is a hard identity
    mismatch. A frontmatter block that parses but OMITS `name:` is accepted
    only when the folder's own identity is otherwise unambiguous — its
    basename matches `skill_name`, or the skill's OWN currently-registered
    source path was already named that way — never on explicit selection
    alone: a random, arbitrarily-named empty-of-identity folder is not
    "clearly this skill" just because the user clicked it.

    `mcp-server`: no SKILL.md is required (unchanged — `skill_source`'s own
    contract), but the directory must still be non-empty; a literal empty
    directory is never valid replacement content for anything.
    """
    skills = registry.get("skills") or {}
    cfg = skills.get(skill_name)
    if not isinstance(cfg, dict):
        raise RecoveryError(f"unknown skill '{skill_name}'", code="unknown_skill")
    candidate = Path(path).expanduser()
    if not candidate.is_dir():
        raise RecoveryError(f"selected path does not exist or is not a directory: {candidate}", code="invalid_path")
    try:
        has_entries = any(candidate.iterdir())
    except OSError as exc:
        raise RecoveryError(f"could not read {candidate}: {exc}", code="invalid_path")
    if not has_entries:
        raise RecoveryError(f"{candidate} is empty — select the skill's actual content", code="empty_directory")

    if (cfg.get("type") or "claude-skill") == "claude-skill":
        skill_md = candidate / "SKILL.md"
        meta = skill_meta.parse_skill_frontmatter(skill_md)
        if meta is None:
            raise RecoveryError(
                f"{candidate} has no valid SKILL.md — select the skill's actual content",
                code="invalid_skill_content",
            )
        frontmatter_name = meta.get("name")
        if frontmatter_name:
            if str(frontmatter_name).strip() != skill_name:
                raise RecoveryError(
                    f"{candidate}'s SKILL.md declares '{frontmatter_name}', not '{skill_name}' — "
                    "refusing to relocate a different skill's content onto this registration",
                    code="identity_mismatch",
                )
        else:
            original_basename = Path(str(cfg.get("source") or "")).name
            if candidate.name != skill_name and original_basename != skill_name:
                raise RecoveryError(
                    f"{candidate}'s SKILL.md declares no name, and its folder name "
                    f"('{candidate.name}') does not match the registered skill '{skill_name}' — "
                    "rename the folder to match, or add a `name:` to its SKILL.md",
                    code="ambiguous_identity",
                )

    cfg["source"] = str(candidate.resolve())
    return {"skill": skill_name, "source": cfg["source"]}


# ─────────────────────────────────────────────────────────────────────────────
# Sync report projection (PLAN §7) — read-only over the REAL post-sync report
# ─────────────────────────────────────────────────────────────────────────────


def summarize_sync_report(report: dict) -> dict:
    """Actual success/skip/fail, from the sync run that just happened — never
    from `build_status`'s pre-sync `attached` projection (attach-ready is not
    sync success)."""
    ready, skipped, failed = [], [], []
    project_failures = {}
    for name, rec in (report.get("projects") or {}).items():
        if not isinstance(rec, dict):
            continue
        if rec.get("quarantined") or rec.get("outcome") == "skipped":
            skipped.append(name)
        elif rec.get("ok", True) and not rec.get("errors"):
            ready.append(name)
        else:
            failed.append(name)
            project_failures[name] = _readable_errors(rec.get("errors"))
    g = report.get("global") or {}
    global_failures: list[dict] = []
    for scope in ("permissions", "hooks", "doctor"):
        block = g.get(scope) or {}
        if not bool(block.get("ok", True)):
            global_failures.extend(
                {"scope": scope, "error": _readable_error(e)} for e in block.get("errors") or []
            )
    for e in (g.get("skills") or {}).get("errors") or []:
        global_failures.append({"scope": "skills", "error": _readable_error(e)})
    return {
        "ok": bool(report.get("ok")),
        "ready": sorted(ready),
        "skipped": sorted(skipped),
        "failed": sorted(failed),
        "project_failures": {
            name: messages for name, messages in sorted(project_failures.items()) if messages
        },
        "global_failures": global_failures,
        "global_skipped": list(g.get("skipped") or []),
    }
