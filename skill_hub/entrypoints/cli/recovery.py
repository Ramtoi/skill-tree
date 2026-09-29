"""`hub recovery` — resumable post-restore recovery journey (design PLAN §1-4,7).

Thin marshals over `skill_hub.application.backup.recovery`: this module owns
the registry mutation, the data-home lock, and JSON I/O only. Every command
prints a JSON verdict and exits 0 — including an unknown project/skill or a
bad path — so the Tauri bridge (which turns any nonzero exit into `Err` and
blanks the app's query) never loses a normal refusal. Only an argparse usage
error (missing required flag) exits nonzero, and that is argparse's own
behavior.

Carved out following the contract in `skill_hub/entrypoints/cli/AGENTS.md`
(`NAME`, `register`, `dispatch`) — never `import hub` at module scope.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.application.backup import recovery as _recovery
from skill_hub.hub_core import registry_mutation
from skill_hub.infrastructure.registry import project_repository as repositories

NAME = "recovery"

p_recovery = None


def register(sub) -> None:
    global p_recovery

    p_recovery = sub.add_parser(
        "recovery",
        help="Resumable post-restore recovery: attach projects, recover sources, run a local sync",
    )
    rec_sub = p_recovery.add_subparsers(dest="recovery_cmd")

    p_status = rec_sub.add_parser("status", help="Show recovery progress (read-only)")
    p_status.add_argument("--json", action="store_true")

    p_start = rec_sub.add_parser("start", help="Enter/resume persisted recovery for the current snapshot")
    p_start.add_argument("--stage")
    p_start.add_argument("--json", action="store_true")

    p_stage = rec_sub.add_parser("stage", help="Update the current recovery stage")
    p_stage.add_argument("--stage", required=True)
    p_stage.add_argument("--json", action="store_true")

    p_finish = rec_sub.add_parser("finish", help="Mark the recovery journey finished")
    p_finish.add_argument(
        "--defer", action="store_true",
        help="Finish even with unresolved items — marks them 'deferred' (never silently 'skipped')",
    )
    p_finish.add_argument("--json", action="store_true")

    p_skip = rec_sub.add_parser("skip", help="Explicitly skip a project (record-only; no registry write)")
    p_skip.add_argument("--project", required=True)
    p_skip.add_argument("--reason")
    p_skip.add_argument("--json", action="store_true")

    p_set_repo = rec_sub.add_parser("set-repository", help="Associate a repository with a project (no attachment)")
    p_set_repo.add_argument("--project", required=True)
    p_set_repo.add_argument("--url", required=True)
    p_set_repo.add_argument("--remote", default="origin")
    p_set_repo.add_argument("--subdirectory", default=".")
    p_set_repo.add_argument("--json", action="store_true")

    p_gh = rec_sub.add_parser("github-repos", help="List repositories accessible to the authenticated gh account")
    p_gh.add_argument("--query")
    p_gh.add_argument("--page", type=int, default=1)
    p_gh.add_argument("--per-page", dest="per_page", type=int, default=30)
    p_gh.add_argument(
        "--fetch-more", action="store_true",
        help="A prior search for this query came back truncated — fetch the next chunk of the account",
    )
    p_gh.add_argument("--json", action="store_true")

    p_discover = rec_sub.add_parser("discover", help="Identity-only local checkout discovery for a project")
    p_discover.add_argument("--project", required=True)
    p_discover.add_argument("--root", dest="roots", action="append", required=True)
    p_discover.add_argument("--json", action="store_true")

    p_attach = rec_sub.add_parser("attach", help="Attach a validated local checkout to a project")
    p_attach.add_argument("--project", required=True)
    p_attach.add_argument("--path", required=True)
    p_attach.add_argument("--remote")
    p_attach.add_argument("--json", action="store_true")

    p_clone = rec_sub.add_parser("clone", help="Clone a project's associated repository, then attach it")
    p_clone.add_argument("--project", required=True)
    p_clone.add_argument("--destination", required=True)
    p_clone.add_argument("--branch")
    p_clone.add_argument("--remote")
    p_clone.add_argument("--json", action="store_true")

    p_restore_source = rec_sub.add_parser("restore-source", help="Re-clone one or every registered git source")
    p_restore_source.add_argument("id", nargs="?")
    p_restore_source.add_argument("--all", action="store_true")
    p_restore_source.add_argument("--json", action="store_true")

    p_skip_source = rec_sub.add_parser("skip-source", help="Explicitly skip a git source (record-only)")
    p_skip_source.add_argument("id")
    p_skip_source.add_argument("--reason")
    p_skip_source.add_argument("--json", action="store_true")

    p_set_local = rec_sub.add_parser("set-local-source", help="Point a local-only skill source at replacement content")
    p_set_local.add_argument("--skill", required=True)
    p_set_local.add_argument("--path", required=True)
    p_set_local.add_argument("--json", action="store_true")

    p_skip_local = rec_sub.add_parser(
        "skip-local-source", help="Explicitly skip a local-only skill source (record-only)"
    )
    p_skip_local.add_argument("--skill", required=True)
    p_skip_local.add_argument("--reason")
    p_skip_local.add_argument("--json", action="store_true")

    p_sync = rec_sub.add_parser("sync", help="Run a local-only sync (skips backup + remotes) and report the result")
    p_sync.add_argument("--json", action="store_true")


def dispatch(args) -> None:
    handlers = {
        "status": cmd_recovery_status,
        "start": cmd_recovery_start,
        "stage": cmd_recovery_stage,
        "finish": cmd_recovery_finish,
        "skip": cmd_recovery_skip,
        "set-repository": cmd_recovery_set_repository,
        "github-repos": cmd_recovery_github_repos,
        "discover": cmd_recovery_discover,
        "attach": cmd_recovery_attach,
        "clone": cmd_recovery_clone,
        "restore-source": cmd_recovery_restore_source,
        "skip-source": cmd_recovery_skip_source,
        "set-local-source": cmd_recovery_set_local_source,
        "skip-local-source": cmd_recovery_skip_local_source,
        "sync": cmd_recovery_sync,
    }
    handler = handlers.get(getattr(args, "recovery_cmd", None))
    if handler is None:
        p_recovery.print_help()
        return
    handler(args)


# ─────────────────────────────────────────────────────────────────────────────
# Small helpers
# ─────────────────────────────────────────────────────────────────────────────


def _emit(args, payload: dict) -> None:
    print(json.dumps(payload, indent=2, default=str))


def _error_payload(exc) -> dict:
    return {"ok": False, "error": {"code": getattr(exc, "code", "recovery_error"), "message": str(exc)}}


def _unknown(kind: str, name: str) -> dict:
    return {"ok": False, "error": {"code": f"unknown_{kind}", "message": f"unknown {kind} '{name}'"}}


def _current_snapshot_key(registry: dict) -> Optional[str]:
    return _recovery.current_snapshot_identity(registry)


# ─────────────────────────────────────────────────────────────────────────────
# Read-only
# ─────────────────────────────────────────────────────────────────────────────


def cmd_recovery_status(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    payload = _recovery.build_status(registry)
    payload["ok"] = True
    _emit(args, payload)


def cmd_recovery_github_repos(args) -> None:
    payload = _recovery.list_github_repositories(
        getattr(args, "query", None), page=args.page, per_page=args.per_page,
        fetch_more=getattr(args, "fetch_more", False),
    )
    _emit(args, payload)


def cmd_recovery_discover(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    try:
        result = _recovery.discover_matches(registry, args.project, args.roots)
    except _recovery.RecoveryError as exc:
        # `RecoveryDiscoverResult.error` (recoveryContract.ts) is a flat
        # string, not the nested `{code, message}` shape other actions use.
        _emit(args, {"ok": False, "matches": [], "issues": [], "truncated": False, "error": str(exc)})
        return
    # `RecoveryDiscoverResult.issues` (recoveryContract.ts) is `string[]`; the
    # application layer's richer `{code, message, field}` rows are flattened
    # to their message here, at the wire boundary only.
    issues = [issue["message"] for issue in result.get("issues") or []]
    _emit(args, {"ok": True, **{**result, "issues": issues}, "error": None})


# ─────────────────────────────────────────────────────────────────────────────
# Journey bookkeeping (record-only; still locked, to serialize concurrent writers)
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("recovery-start")
def cmd_recovery_start(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    record = _recovery.read_record()
    record = _recovery.start_operation(
        record, snapshot_key=_current_snapshot_key(registry), stage=getattr(args, "stage", None)
    )
    _recovery.write_record(record)
    payload = _recovery.build_status(registry, record)
    payload["ok"] = True
    _emit(args, payload)


@registry_mutation("recovery-stage")
def cmd_recovery_stage(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    _recovery.set_stage(record, args.stage)
    _recovery.write_record(record)
    _emit(args, {"ok": True, "stage": record["stage"]})


@registry_mutation("recovery-finish")
def cmd_recovery_finish(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    try:
        record = _recovery.finish_operation(registry, record, defer=getattr(args, "defer", False))
    except _recovery.RecoveryError as exc:
        _emit(args, _error_payload(exc))
        return
    _recovery.write_record(record)
    payload = _recovery.build_status(registry, record)
    payload["ok"] = True
    _emit(args, payload)


@registry_mutation("recovery-skip")
def cmd_recovery_skip(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    if args.project not in (registry.get("projects") or {}):
        _emit(args, _unknown("project", args.project))
        return
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    _recovery.set_project_job(record, args.project, "skipped", detail=args.reason or "explicit skip")
    _recovery.write_record(record)
    _emit(args, {"ok": True, "project": args.project, "status": "skipped"})


@registry_mutation("recovery-skip-source")
def cmd_recovery_skip_source(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    if args.id not in (registry.get("sources") or {}):
        _emit(args, _unknown("source", args.id))
        return
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    _recovery.set_source_job(record, args.id, "skipped", detail=args.reason or "explicit skip")
    _recovery.write_record(record)
    _emit(args, {"ok": True, "source": args.id, "status": "skipped"})


@registry_mutation("recovery-skip-local-source")
def cmd_recovery_skip_local_source(args) -> None:
    import hub

    registry = hub._read_registry_optional()
    if args.skill not in (registry.get("skills") or {}):
        _emit(args, _unknown("skill", args.skill))
        return
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    _recovery.set_local_source_job(record, args.skill, "skipped", detail=args.reason or "explicit skip")
    _recovery.write_record(record)
    _emit(args, {"ok": True, "skill": args.skill, "status": "skipped"})


# ─────────────────────────────────────────────────────────────────────────────
# Repository association (PLAN §2/§3)
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("recovery-set-repository")
def cmd_recovery_set_repository(args) -> None:
    registry = hub_core.load_registry()
    if args.project not in (registry.get("projects") or {}):
        _emit(args, _unknown("project", args.project))
        return
    try:
        result = _recovery.set_repository(
            registry, args.project, args.url, remote=args.remote, subdirectory=args.subdirectory
        )
    except _recovery.RecoveryError as exc:
        _emit(args, _error_payload(exc))
        return
    hub_core.save_registry(registry)
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    proj_entry = (record.get("projects") or {}).get(args.project) or {}
    write_needed = proj_entry.get("status") in ("skipped", "deferred")
    if write_needed:
        _recovery.clear_project_job(record, args.project)
    _recovery.write_record(record)
    _emit(args, {"ok": True, **result})


# ─────────────────────────────────────────────────────────────────────────────
# Attach / clone (PLAN §2/§3, A4-A8) — never touches clean_project_artifacts
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("recovery-attach")
def cmd_recovery_attach(args) -> None:
    registry = hub_core.load_registry()
    if args.project not in (registry.get("projects") or {}):
        _emit(args, _unknown("project", args.project))
        return
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    _recovery.set_project_job(record, args.project, "running", pid=os.getpid())
    _recovery.write_record(record)
    try:
        plan = _recovery.plan_attach(registry, args.project, args.path, remote=getattr(args, "remote", None))
    except _recovery.RecoveryError as exc:
        record = _recovery.read_record()
        _recovery.set_project_job(record, args.project, "failed", detail=str(exc))
        _recovery.write_record(record)
        _emit(args, _error_payload(exc))
        return
    _apply_attach_plan(registry, args.project, plan)
    hub_core.save_registry(registry)
    record = _recovery.read_record()
    _recovery.set_project_job(record, args.project, "ready", detail="attached")
    _recovery.write_record(record)
    _emit(args, {"ok": True, **plan})


def _apply_attach_plan(registry: dict, project_name: str, plan: dict) -> None:
    cfg = registry["projects"][project_name]
    cfg["path"] = plan["new_path"]
    cfg.pop("path_unresolved", None)
    if plan.get("adopted_repository") and not cfg.get("repository"):
        cfg["repository"] = plan["adopted_repository"]
    if plan.get("old_path") and plan["old_path"] != plan["new_path"]:
        from skill_hub.infrastructure.registry import loadout_bindings

        loadout_bindings.invalidate_source(registry, project_name, "source_path_changed")


def cmd_recovery_clone(args) -> None:
    """No `@registry_mutation` here on purpose: the network clone must NOT
    hold the data-home lock (it would serialize every other recovery command
    — including `status`'s own callers checking on progress, and a `skip`/
    `finish` on an unrelated project — behind one slow `git clone`). The lock
    is taken twice, briefly: once to record the job as running, once to
    revalidate and commit. Everything in between (`stage_clone`, the actual
    network I/O) runs unlocked.

    Validation (identity, subdirectory, destination collision) happens
    against the STAGED clone BEFORE `commit_clone` ever renames it into
    place (item 4) — a failed validation must never leave an unattached
    checkout sitting at the real destination.
    """
    with hub_core.data_home_lock():
        registry = hub_core.load_registry()
        projects = registry.get("projects") or {}
        if args.project not in projects:
            _emit(args, _unknown("project", args.project))
            return
        cfg = projects[args.project]
        saved = cfg.get("repository")
        if saved is None:
            _emit(
                args,
                {
                    "ok": False,
                    "error": {
                        "code": "no_repository",
                        "message": f"project '{args.project}' has no repository association",
                    },
                },
            )
            return
        try:
            association = repositories.validate_repository_association(saved)
        except repositories.RepositoryError as exc:
            _emit(args, {"ok": False, "error": {"code": exc.code, "message": str(exc)}})
            return
        # Snapshot of the project's OWN current attachment state, not just
        # its repository association — the final revalidation below must
        # catch a concurrent explicit `attach`/`skip` on this SAME project
        # too, not only a changed association.
        original_path = cfg.get("path")
        original_path_unresolved = bool(cfg.get("path_unresolved"))
        record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
        clone_job = _recovery.set_project_job(record, args.project, "running", pid=os.getpid())
        clone_operation_id = record.get("operation_id")
        clone_snapshot_key = _current_snapshot_key(registry)
        _recovery.write_record(record)

    def _fail(exc, *, staged=None) -> None:
        if staged is not None:
            _recovery.cleanup_clone_temp(staged["temp_dir"])
        detail = str(exc)
        with hub_core.data_home_lock():
            record = _recovery.read_record()
            if (record.get("operation_id") == clone_operation_id
                    and (record.get("projects") or {}).get(args.project) == clone_job):
                _recovery.set_project_job(record, args.project, "failed", detail=detail)
                _recovery.write_record(record)
        code = getattr(exc, "code", "clone_failed")
        _emit(args, {"ok": False, "error": {"code": code, "message": detail}})

    staged = None
    try:
        staged = _recovery.stage_clone(
            association.url,
            args.destination,
            branch=getattr(args, "branch", None),
            registry=registry,
        )
    except _recovery.RecoveryError as exc:
        _fail(exc)
        return

    with hub_core.data_home_lock():
        # Re-read fresh: the user may have changed this project's repository
        # association, its path/attachment, or removed the project entirely
        # while the network clone ran unlocked. Validate/commit/attach only
        # against the CURRENT truth, never the snapshot taken before the
        # network call.
        fresh_registry = hub_core.load_registry()
        fresh_record = _recovery.read_record()
        if (_current_snapshot_key(fresh_registry) != clone_snapshot_key
                or fresh_record.get("operation_id") != clone_operation_id
                or (fresh_record.get("projects") or {}).get(args.project) != clone_job):
            _fail(_recovery.RecoveryError(
                "another recovery decision superseded this clone; the staged checkout was discarded",
                code="project_changed",
            ), staged=staged)
            return
        fresh_cfg = (fresh_registry.get("projects") or {}).get(args.project)
        if not isinstance(fresh_cfg, dict):
            _fail(_recovery.RecoveryError(f"project '{args.project}' no longer exists", code="unknown_project"),
                  staged=staged)
            return
        if fresh_cfg.get("repository") != saved:
            _fail(
                _recovery.RecoveryError(
                    "the project's repository association changed while cloning — the clone was "
                    "discarded; retry with the current association",
                    code="association_changed",
                ),
                staged=staged,
            )
            return
        if fresh_cfg.get("path") != original_path or bool(fresh_cfg.get("path_unresolved")) != original_path_unresolved:
            _fail(
                _recovery.RecoveryError(
                    "this project was attached or skipped by another action while cloning — the "
                    "clone was discarded; check its current state",
                    code="project_changed",
                ),
                staged=staged,
            )
            return

        subdir = association.subdirectory
        temp_root = Path(staged["temp_dir"])
        final_root = Path(staged["destination"])
        staged_target = temp_root if subdir in (".", "", None) else (temp_root / subdir)
        final_target = final_root if subdir in (".", "", None) else (final_root / subdir)
        try:
            # Identity/subdirectory validated against the STAGED (unrenamed)
            # clone; `new_path`/the destination-collision check use the
            # EVENTUAL destination — `git clone` always names the remote it
            # creates "origin", regardless of what name the STORED
            # association used (`set-repository --remote upstream` records
            # "upstream"; the fresh checkout still only has "origin").
            plan = _recovery.plan_attach(
                fresh_registry, args.project, staged_target, remote="origin", final_path=final_target
            )
        except (_recovery.RecoveryError, repositories.RepositoryError) as exc:
            _fail(exc, staged=staged)
            return

        try:
            _recovery.commit_clone(staged["temp_dir"], staged["destination"])
        except _recovery.RecoveryError as exc:
            _fail(exc, staged=staged)
            return
        staged = None  # committed — no longer ours to clean up on a later failure

        _apply_attach_plan(fresh_registry, args.project, plan)
        hub_core.save_registry(fresh_registry)
        record = _recovery.read_record()
        _recovery.set_project_job(record, args.project, "ready", detail="cloned")
        _recovery.write_record(record)

    _emit(args, {"ok": True, **plan})


# ─────────────────────────────────────────────────────────────────────────────
# Source / local-only-source recovery (PLAN §4, A9/A12)
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("recovery-restore-source")
def cmd_recovery_restore_source(args) -> None:
    """A single explicit id ALWAYS retries (item 5) — the user chose THIS
    one deliberately, and that choice clears any prior skip/deferred by
    simply overwriting the record entry below. `--all` is the batch/resume
    case: it skips a source that is already `ready` (live health, not a
    stale record entry) with no side effects, and never touches one
    explicitly `skipped`/`deferred` — a decision, not an interruption.
    """
    registry = hub_core.load_registry()
    sources_cfg = registry.get("sources") or {}
    explicit_single = not getattr(args, "all", False)
    if explicit_single:
        if not getattr(args, "id", None):
            _emit(args, {"ok": False, "error": {"code": "missing_id", "message": "pass an id or --all"}})
            return
        if args.id not in sources_cfg:
            _emit(args, _unknown("source", args.id))
            return
        ids = [args.id]
    else:
        ids = [
            sid
            for sid, cfg in sorted(sources_cfg.items())
            if isinstance(cfg, dict) and (cfg.get("type") or "git") == "git"
        ]

    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    _recovery.write_record(record)

    already_settled: list = []
    rows_by_id: dict = {}
    if explicit_single:
        to_run = ids
    else:
        rows_by_id = {row["id"]: row for row in _recovery.source_status_rows(registry, record)}
        to_run = [sid for sid in ids if _recovery.is_outstanding_status(rows_by_id.get(sid, {}).get("status"))]
        already_settled = [sid for sid in ids if sid not in to_run]

    results = []
    for source_id in to_run:
        record = _recovery.read_record()
        _recovery.set_source_job(record, source_id, "running", pid=os.getpid())
        _recovery.write_record(record)

        result = _recovery.restore_one_source(registry, source_id)
        # Persisted per source, not once after the whole batch: a later
        # source raising must never cost an earlier source's already-
        # successful cache/registry mutation (A9/A10).
        hub_core.save_registry(registry)

        status = "ready" if result.get("ok") else "failed"
        detail = result.get("detail") or result.get("error")
        if result.get("missing_skill_paths"):
            missing = ", ".join(result["missing_skill_paths"])
            detail = f"{detail} (missing skill paths: {missing})" if detail else f"missing skill paths: {missing}"
        record = _recovery.read_record()
        _recovery.set_source_job(record, source_id, status, detail=detail)
        _recovery.write_record(record)
        results.append(result)

    for source_id in already_settled:
        row = rows_by_id.get(source_id) or {}
        results.append(
            {
                "ok": row.get("status") != "failed",
                "source": source_id,
                "skipped": row.get("status") in ("skipped", "deferred"),
                "status": row.get("status"),
                "detail": row.get("detail"),
            }
        )

    _emit(args, {"ok": all(r.get("ok") for r in results), "results": results})


@registry_mutation("recovery-set-local-source")
def cmd_recovery_set_local_source(args) -> None:
    registry = hub_core.load_registry()
    if args.skill not in (registry.get("skills") or {}):
        _emit(args, _unknown("skill", args.skill))
        return
    record = _recovery.ensure_active_operation(_recovery.read_record(), registry)
    _recovery.set_local_source_job(record, args.skill, "running", pid=os.getpid())
    _recovery.write_record(record)
    try:
        result = _recovery.set_local_source(registry, args.skill, args.path)
    except _recovery.RecoveryError as exc:
        record = _recovery.read_record()
        _recovery.set_local_source_job(record, args.skill, "failed", detail=str(exc))
        _recovery.write_record(record)
        _emit(args, _error_payload(exc))
        return
    hub_core.save_registry(registry)
    record = _recovery.read_record()
    _recovery.set_local_source_job(record, args.skill, "ready", detail=None, path=result["source"])
    _recovery.write_record(record)
    _emit(args, {"ok": True, **result})


# ─────────────────────────────────────────────────────────────────────────────
# Local sync (PLAN §7, A13) — the ONE place recovery touches sync at all
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("recovery-sync")
def cmd_recovery_sync(args) -> None:
    """Never trusts whatever happens to be at `sync_report_path()` (item 3):
    captures a pre-call stat signature and only accepts a report that
    actually changed after this call — a `cmd_sync` that crashed before
    writing its own report (or raced with something else touching the file)
    must never make a PRIOR run's success/failure look like this run's.
    """
    import hub
    from skill_hub.application.sync import sync_engine

    class _RecoverySyncArgs:
        skip_remotes = True
        skip_backup = True
        _operation_context = None

    report_path = sync_engine.sync_report_path()

    def _signature():
        try:
            st = report_path.stat()
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_ino, st.st_size)

    pre_signature = _signature()

    sync_exit_code = 0
    crashed: Optional[str] = None
    try:
        with contextlib.redirect_stdout(sys.stderr):
            hub.cmd_sync(_RecoverySyncArgs())
    except SystemExit as exc:
        # `cmd_sync`'s own try/finally still wrote the CURRENT run's report
        # before this propagated (stream failure rc1 / doctor danger rc2) —
        # the freshness check below confirms that, rather than assuming it.
        sync_exit_code = exc.code if isinstance(exc.code, int) else 1
    except Exception as exc:  # pragma: no cover - defensive
        # A genuinely unexpected crash may have happened BEFORE cmd_sync's
        # own report write — there is no "current run" report to trust.
        crashed = str(exc)
        sync_exit_code = 1

    def _persist_and_emit(result: dict, *, summary=None, report=None) -> None:
        registry = hub._read_registry_optional()
        record = _recovery.read_record()
        record = _recovery.ensure_active_operation(record, registry)
        _recovery.record_sync_result(record, result, registry_hash=_recovery.registry_content_hash())
        _recovery.write_record(record)
        payload = dict(result)
        if summary is not None:
            payload["summary"] = summary
        if report is not None:
            payload["report"] = report
        _emit(args, payload)

    def _failure(message: str) -> dict:
        return {
            "ok": False, "counts": {"success": 0, "skipped": 0, "failed": 0},
            "failed_projects": [], "project_failures": {}, "global_failures": [],
            "error": message, "sync_exit_code": sync_exit_code,
        }

    if crashed is not None:
        _persist_and_emit(_failure(crashed))
        return

    if _signature() in (None, pre_signature):
        # `cmd_sync` ran (or absorbed a SystemExit) but never actually wrote
        # a FRESH report — reading whatever is on disk here would show a
        # STALE prior run's outcome as though it were this one's.
        detail = "local sync did not produce a fresh report"
        if sync_exit_code:
            detail += f" (exit code {sync_exit_code})"
        _persist_and_emit(_failure(detail))
        return

    try:
        report = json.loads(report_path.read_text())
    except (OSError, ValueError) as exc:
        _persist_and_emit(_failure(str(exc)))
        return

    summary = _recovery.summarize_sync_report(report)
    ok = summary["ok"] and sync_exit_code == 0
    global_failures = [f"{gf['scope']}: {gf['error']}" for gf in summary["global_failures"]]
    if sync_exit_code:
        global_failures = global_failures + [f"local sync exited with code {sync_exit_code}"]

    # `RecoverySyncResult` (recoveryContract.ts) is a flat wire shape:
    # `counts` (numbers), `failed_projects`/`global_failures` as plain
    # strings. `summary`/`report` stay available for server-side inspection.
    result = {
        "ok": ok,
        "counts": {
            "success": len(summary["ready"]), "skipped": len(summary["skipped"]), "failed": len(summary["failed"]),
        },
        "failed_projects": summary["failed"],
        "project_failures": summary["project_failures"],
        "global_failures": global_failures,
        "error": None if sync_exit_code == 0 else f"local sync exited with code {sync_exit_code}",
        "sync_exit_code": sync_exit_code,
    }
    _persist_and_emit(result, summary=summary, report=report)
