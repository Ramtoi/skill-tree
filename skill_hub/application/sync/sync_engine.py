"""The sync orchestrator: `cmd_sync`, `_cmd_sync_body`, the auto-sync tail, the
global-skills pass, the read-only detection passes, and the sync report.

Cut verbatim out of hub.py (wave 23h of AUDIT.md), region A (sync report,
hub.py:62-…) followed by region B (hub.py:298-1007) in their original order.
Not a leaf, by design: the tests stub the stream entry points, `_auto_sync`
and `cmd_sync` on `hub` (58 stubs across 14 files), so the three functions
that call them read them as `hub.<name>` through a function-local
`import hub` — call-time reads, so every existing stub keeps landing without
a test edit:
  * `_cmd_sync_body` → `hub._run_permissions_stream`, `hub._run_hooks_stream`,
    `hub._run_doctor_rollup`, `hub._run_remote_dispatch`;
  * `_auto_sync_tail` → `hub._auto_sync`;
  * `_auto_sync` → `hub.cmd_sync`.
Registry I/O is `hub_core.load_registry()` / `hub_core.save_registry()`
(module attribute reads, per the hub_cli contract). Everything else the
engine reads is a module-scope import of a sibling that never imports hub at
module scope (hub_core, skill_meta, sources, sync_links, mcp_sync,
import_scanner, skill_variants). hub.py re-imports every name so `hub.<name>`
keeps resolving (hub_cli/*, skill_hub_mcp_server.py, remotes.py and
cloud_targets.py read `hub.resolve_project_skills`, `hub.cmd_sync`,
`hub._auto_sync`, `hub._sync_global_skills`, `hub.scan_project_skill_candidates`).

Stub visibility: any OTHER intra-module call resolves through this module
(`cmd_sync` → `_cmd_sync_body` / `_cmd_sync_backup_tail` / `write_sync_report`;
`_cmd_sync_body` → `_sync_global_skills` / `_run_agent_docs_detection` /
`_run_project_skill_detection` / `new_sync_report`; `_run_project_skill_detection`
→ `scan_project_skill_candidates`; …). No test stubs those on `hub` today; one
that needs to patches `sync_engine.<name>`.
"""

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.application.harnesses.harness_operation_context import (
    WORKFLOW_FEATURES,
    build_operation_context,
    serialize_operation_context,
)
from skill_hub.application.skills.import_scanner import _parse_skill_md, _read_registry_optional
from skill_hub.application.skills.skill_variants import (
    InvocationError,
    _applied_mode,
    _cached_invocation_profiles,
    _cleanup_variant_orphans,
    _ensure_combined_variant,
    _profiles_from_context,
    _publish_skill_link,
    _record_invocation_failure,
    _record_invocation_outcomes,
    _source_fingerprint,
    _sync_project_skills,
    _try_opencode_command_delivery,
)
from skill_hub.application.sync.mcp_sync import _run_global_mcp_dispatch
from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version
from skill_hub.domain.skills import skill_meta
from skill_hub.domain.skills.skill_meta import (
    RENAME_VARIANT_MODE,
    skill_invocation,
    skill_rename_patch,
    skill_source,
    sync_skill_frontmatter_metadata,
    validate_registry_skills,
)
from skill_hub.hub_core import BOLD, CYAN, DIM, GREEN, RED, SLUG_RE, YELLOW, _now_iso, bundle_scope, c, expand
from skill_hub.infrastructure.filesystem.sync_links import is_hub_owned_link, remove_unmanaged_entries
from skill_hub.infrastructure.registry.sources import skills_from_disabled_sources

# ─────────────────────────────────────────────────────────────────────────────
# Sync report (derived per-run state under <data_home>/state/)
# ─────────────────────────────────────────────────────────────────────────────


def sync_report_path() -> Path:
    return hub_core.data_home() / "state" / "sync-report.json"


def _registry_fingerprint() -> tuple[str, float]:
    """Full SHA-256 hex + st_mtime of registry.yaml (('' , 0.0) if absent).

    Reading the bytes at call time is what makes an idle re-open of a clean sync
    read `fresh` — the fingerprint always reflects the registry after the run's
    final `save_registry`.
    """
    reg = hub_core.registry_file()
    try:
        data = reg.read_bytes()
        mtime = reg.stat().st_mtime
    except OSError:
        return "", 0.0
    return hashlib.sha256(data).hexdigest(), mtime


def new_sync_report() -> dict:
    """A mutable schema_version:1 accumulator, threaded through the sync passes."""
    return {
        "schema_version": 1,
        "generated_at": None,
        "registry_sha256": "",
        "registry_mtime": 0.0,
        "ok": True,
        "global": {
            "skipped": [],
            "skills": {
                "writes": 0,
                "removed": 0,
                "skipped_unowned": 0,
            },
            "mcp": {"writes": 0, "removed": 0, "delivery": []},
            "permissions": {"ok": True, "errors": []},
            "hooks": {"ok": True, "errors": []},
            "doctor": {"ok": True, "errors": []},
            "remotes": {"attempted": 0, "alarming": 0},
            # usage-loadout-analytics design D6: the "2e" sync-tail pass
            # (`usage_loadouts.run_loadout_pass`) overwrites this with its own
            # result shape — same keys, real counts — the moment it runs.
            "loadouts": {"appended": 0, "pairs": 0, "errors": []},
            # Additive: the frontend's `SyncReportGlobal` interface is already a
            # SUBSET of what Python emits (it omits `hooks`/`doctor`), so extra
            # keys are tolerated by every reader and `schema_version` stays 1.
            "backup": _new_backup_report_slot(),
        },
        "projects": {},
    }


def _new_backup_report_slot() -> dict:
    """Staleness surface for the backup tail pass (design v2 §9)."""
    return {
        "ran": False,
        "skipped": None,
        "committed": False,
        "pushed": False,
        "conflict": False,
        "error": None,
        # `secret_leak` / `prefix_leak` = a deliberate fail-CLOSED refusal to
        # publish; `error` = an ordinary fail-open miss (network, git, auth).
        "error_kind": None,
        "at": None,
    }


def new_project_report() -> dict:
    return {
        "ts": _now_iso(),
        "ok": True,
        "errors": [],
        "writes": 0,
        "removed": 0,
        "skipped_unowned": 0,
        "affinity_skips": [],
        "missing_refs": [],
        "mcp_delivery": [],
        "invocation": [],
    }


def _sync_report_ok(report: dict) -> bool:
    projects_ok = all(
        p.get("ok", True) for p in report.get("projects", {}).values()
    )
    g = report.get("global", {})
    perms_ok = bool(g.get("permissions", {}).get("ok", True))
    hooks_ok = bool(g.get("hooks", {}).get("ok", True))
    doctor_ok = bool(g.get("doctor", {}).get("ok", True))
    skills_ok = bool(g.get("skills", {}).get("ok", True))
    global_skill_errors = g.get("skills", {}).get("errors", [])
    return (
        projects_ok
        and perms_ok
        and hooks_ok
        and doctor_ok
        and skills_ok
        and not global_skill_errors
    )


def write_sync_report(report: dict) -> None:
    """Serialize the sync report atomically to <data_home>/state/sync-report.json.

    Stamped here (not by each pass) so EVERY exit path records the registry bytes
    as they stand after the run's final `save_registry`. No backup — the report is
    100% derived state, regenerated by the next sync.
    """
    report["generated_at"] = _now_iso()
    sha, mtime = _registry_fingerprint()
    report["registry_sha256"] = sha
    report["registry_mtime"] = mtime
    report["ok"] = _sync_report_ok(report)
    path = sync_report_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(report, indent=2) + "\n")
    os.replace(tmp, path)


def record_backup_attempt(result: dict, *, error_kind: Optional[str] = None) -> None:
    """Refresh only the backup slot after an explicit backup command.

    Leave the sync timestamp and other results alone: a backup is not a sync.
    A missing report stays missing. Report persistence must not undo a backup.
    """
    try:
        with hub_core.data_home_lock():
            path = sync_report_path()
            if not path.exists():
                return
            report = json.loads(path.read_text())
            if not isinstance(report, dict) or not isinstance(report.get("global"), dict):
                raise ValueError("invalid sync report")
            slot = _new_backup_report_slot()
            slot.update({
                "ran": True, "skipped": result.get("skipped"),
                "committed": bool(result.get("committed")), "pushed": bool(result.get("pushed")),
                "conflict": bool(result.get("conflict")), "error": result.get("error"),
                "error_kind": error_kind, "at": _now_iso(),
            })
            report["global"]["backup"] = slot
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(report, indent=2) + "\n")
            os.replace(tmp, path)
    except (OSError, ValueError, TypeError):
        result.setdefault("warnings", []).append("Could not save the latest backup status in the sync report.")


# ─────────────────────────────────────────────────────────────────────────────
# hub sync
# ─────────────────────────────────────────────────────────────────────────────


def resolve_project_skills(proj_cfg: dict, registry: dict) -> list:
    """Return the full ordered list of active skills for a project."""
    bundles_cfg = registry.get("bundles", {})
    global_bundle_skills = []
    for cfg in bundles_cfg.values():
        if bundle_scope(cfg) == "global":
            global_bundle_skills.extend(cfg.get("skills", []))

    proj_bundles = proj_cfg.get("bundles", [])
    project_bundle_skills = []
    for b in proj_bundles:
        project_bundle_skills.extend(bundles_cfg.get(b, {}).get("skills", []))

    all_skills = (
        global_bundle_skills + project_bundle_skills + proj_cfg.get("enabled", [])
    )
    return list(dict.fromkeys(all_skills))  # deduplicate, preserve order


def scan_project_skill_candidates(registry: Optional[dict] = None, *, operation_context=None) -> list[dict]:
    """Discover hand-authored, untracked skills living inside registered projects.

    The hub is otherwise push-only (registry → harness symlinks) and its import
    scanner (`scan_import_candidates`) only walks USER-GLOBAL skill dirs. A skill
    created directly inside a *project's* `.claude/skills/` (e.g. authored by
    Claude Code) is therefore invisible to the hub: not in the registry, never
    proposed for import, and left untouched by sync cleanup (it is a real dir,
    not a hub-owned symlink). This pass closes that blind spot.

    For each registered project, walk every known harness's `project_skills_dir`
    (deduped, mirroring the sync cleanup walk) and flag entries that are:
      * a real directory (symlinks are hub-managed or external — skipped),
      * containing a parseable SKILL.md,
      * whose name is NOT already a registry skill and NOT active for the project.

    Categories:
      NEW           — valid slug, unknown to the hub → importable
      INVALID_NAME  — has a SKILL.md but the name fails the slug pattern
    """
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    layouts = operation_context.layouts if operation_context is not None else _harnesses.HARNESSES
    reg = registry if registry is not None else _read_registry_optional()
    existing = reg.get("skills") or {}
    projects = reg.get("projects") or {}

    from skill_hub.application.skills.skill_variants import project_sync_skip_reason

    candidates: list[dict] = []
    for proj_name, proj_cfg in projects.items():
        if project_sync_skip_reason(proj_cfg):
            continue
        proj_path = expand(proj_cfg["path"])
        active = set(resolve_project_skills(proj_cfg, reg))
        # Deduped skill dirs across all known harnesses (codex+pi share
        # .agents/skills/ → one dir, walked once).
        skill_dirs = {
            proj_path / Path(str(h.project_skills_dir))
            for h in layouts.values()
        }
        seen_names: set[str] = set()
        for skills_dir in sorted(skill_dirs):
            if not skills_dir.exists() or skills_dir.is_symlink():
                continue
            for entry in sorted(skills_dir.iterdir()):
                if entry.name.startswith("."):
                    continue
                # Symlinks are hub-managed or external; only real dirs are
                # hand-authored project-local skills.
                if entry.is_symlink() or not entry.is_dir():
                    continue
                meta = _parse_skill_md(entry / "SKILL.md")
                if meta is None:
                    continue
                name = meta.get("name")
                if not name:
                    continue
                # Already known to the hub (globally or active here) → not a find.
                if name in existing or name in active:
                    continue
                if name in seen_names:
                    continue
                seen_names.add(name)
                base = {
                    "project": proj_name,
                    "name": name,
                    "path": str(entry),
                    "rel": str(entry.relative_to(proj_path)),
                    "description": meta.get("description") or "",
                    "version": meta.get("version"),
                    "category": "NEW" if SLUG_RE.match(name) else "INVALID_NAME",
                }
                if base["category"] == "INVALID_NAME":
                    base["reason"] = "must match ^[a-z0-9-]+$"
                candidates.append(base)
    return candidates


# Re-export: the implementation moved to `skill_meta.skill_affinity`
# (usage-loadout-analytics design D1) so a leaf module (`usage_loadouts.py`)
# can filter a loadout row by harness affinity without importing this module,
# which reaches the monolith. Kept as `_skill_affinity` here so every
# existing caller in this file keeps resolving.
_skill_affinity = skill_meta.skill_affinity


def _sync_global_skills(
    registry: dict,
    installed: set[str],
    report: Optional[dict] = None,
    variant_cache: Optional[dict] = None,
    operation_context=None,
) -> set[str]:
    """Global-skills pass: symlink every `scope: global` claude-skill into each
    installed harness's global_skills_dir (honoring per-skill `harnesses:`
    affinity), then clean stale global links across EVERY harness dir.

    Extracted verbatim from cmd_sync so `hub subagent provision-skill --global`
    can re-run ONLY this pass without invoking the full sync (which runs remotes
    + permissions and can sys.exit on unrelated failures). cmd_sync's output +
    behavior are unchanged — this is the single owner of the global-skills pass.
    Returns the set of provisioned global skill names.
    """
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    layouts = operation_context.layouts if operation_context is not None else _harnesses.HARNESSES
    if operation_context is not None:
        blocked_dirs = {
            layout.global_skills_dir for h_id, layout in layouts.items()
            if operation_context.route(h_id, "skills").mode != "legacy_shadow"
            or operation_context.route(h_id, "skills").status != "shadow"
        }
        layouts = {
            h_id: layout for h_id, layout in layouts.items()
            if layout.global_skills_dir not in blocked_dirs
        }
        installed = set(operation_context.installed_harness_ids or ()) & set(layouts)
    skills = registry.get("skills", {})
    inactive = skills_from_disabled_sources(registry)
    print(c("Global skills (managed only from hub):", BOLD))
    global_skill_names: set[str] = set()
    writes = 0
    removed = 0
    skipped_unowned = 0
    profiles = _profiles_from_context(operation_context)
    if profiles is None:
        profiles = _cached_invocation_profiles()
    opencode_command_expected: set[str] = set()
    global_targets: dict[Path, set[str]] = {}  # global_skills_dir -> names
    for h_id, h in layouts.items():
        target = Path(str(h.global_skills_dir)).expanduser()
        global_targets[target] = set()

    for name, cfg in skills.items():
        if cfg.get("scope") != "global" or cfg.get("type") != "claude-skill":
            continue
        if name in inactive:
            # Owned by a disabled source: left out of `global_targets`, so the
            # stale-link cleanup below unlinks it.
            print(f"  {c('·', DIM)} source disabled: {name} ({inactive[name]})")
            continue
        src = skill_source(cfg)
        if not src.exists():
            print(f"  {c('!', YELLOW)} source missing: {src}")
            affinity = _skill_affinity(cfg)
            missing_harnesses = set(installed)
            if affinity is not None:
                missing_harnesses &= affinity
            for h_id in missing_harnesses:
                target_dir = Path(
                    str(layouts[h_id].global_skills_dir)
                ).expanduser()
                if (target_dir / name).is_symlink():
                    global_targets.setdefault(target_dir, set()).add(name)
            if "opencode" in missing_harnesses:
                # A failed source read must preserve a last-good command until
                # a later successful reconciliation can replace it.
                opencode_command_expected.add(name)
            if report is not None:
                _record_invocation_failure(
                    report["global"].setdefault("skills", {}),
                    name,
                    missing_harnesses,
                    None,
                    InvocationError(f"source missing: {src}", code="source-missing"),
                    requested_mode=skill_invocation(cfg),
                    profiles=profiles,
                )
            continue
        global_skill_names.add(name)
        affinity = _skill_affinity(cfg)
        target_harnesses: dict[Path, set[str]] = {}
        for h_id, h in layouts.items():
            if h_id not in installed:
                continue
            if affinity is not None and h_id not in affinity:
                continue
            target_dir = Path(str(h.global_skills_dir)).expanduser()
            target_harnesses.setdefault(target_dir, set()).add(h_id)
        original_src = skill_source(cfg)
        rename_patch = skill_rename_patch(name, cfg)
        requested_mode = skill_invocation(cfg)
        if requested_mode not in {"auto", "user-only", "model-only", "conflicted"}:
            requested_mode = "auto"
        build_mode = requested_mode
        if requested_mode == "auto" and rename_patch is not None:
            build_mode = RENAME_VARIANT_MODE
        for target_dir, destination_harnesses in target_harnesses.items():
            link = target_dir / name
            try:
                command_handled, command_writes, command_row = _try_opencode_command_delivery(
                    name,
                    original_src,
                    requested_mode,
                    destination_harnesses,
                    project_path=None,
                    link=link,
                    profiles=profiles,
                    all_target_harnesses=set().union(*target_harnesses.values()),
                    operation_context=operation_context,
                )
                if command_handled:
                    opencode_command_expected.add(name)
                    if command_row is not None and command_row.get("reason_code") == "selection-unavailable":
                        global_targets[target_dir].add(name)
                    writes += command_writes
                    if report is not None and command_row is not None:
                        command_row["input_fingerprint"] = _source_fingerprint(original_src)
                        _record_invocation_outcomes(
                            report["global"].setdefault("skills", {}),
                            [command_row],
                            delivery=(
                                "unchanged"
                                if command_row.get("reason_code") == "selection-unavailable"
                                else "applied"
                            ),
                        )
                    continue
                src, variant_writes, outcomes = _ensure_combined_variant(
                    name,
                    original_src,
                    build_mode,
                    renamed=rename_patch,
                    native_harnesses=destination_harnesses,
                    mode_origin="library",
                    profiles=profiles,
                    native_mode=requested_mode,
                    operation_context=operation_context,
                )
                if _publish_skill_link(link, src):
                    writes += 1
                writes += variant_writes
                if "opencode" in destination_harnesses:
                    from skill_hub.infrastructure.harnesses import opencode_invocation

                    # A command is removed only after the ordinary skill has
                    # been delivered successfully. This also reconciles a
                    # prior command when the target becomes shared or the
                    # capability profile changes.
                    removed += opencode_invocation.remove_owned_command(
                        name, None,
                        native_paths=operation_context.opencode_paths if operation_context is not None else None,
                    )
                if command_row is not None:
                    command_row["delivery"] = "applied"
                    command_row["input_fingerprint"] = _source_fingerprint(original_src)
                    outcomes = [
                        command_row if row.get("harness") == "opencode" else row
                        for row in outcomes
                    ]
                if report is not None:
                    _record_invocation_outcomes(
                        report["global"].setdefault("skills", {}),
                        outcomes,
                        delivery="applied",
                    )
            except (InvocationError, OSError, ValueError, TypeError) as exc:
                # Keep a last-good global consumer in place. On first delivery
                # no link is created and the report carries the failure.
                if link.is_symlink():
                    global_targets[target_dir].add(name)
                if "opencode" in destination_harnesses:
                    opencode_command_expected.add(name)
                if report is not None:
                    _record_invocation_failure(
                        report["global"].setdefault("skills", {}),
                        name,
                        destination_harnesses,
                        None,
                        exc,
                        requested_mode=requested_mode,
                        profiles=profiles,
                        input_fingerprint=_source_fingerprint(original_src),
                        applied_mode=_applied_mode(link),
                    )
                continue
            global_targets[target_dir].add(name)

    from skill_hub.infrastructure.harnesses import opencode_invocation

    if operation_context is not None and "opencode" in layouts and operation_context.opencode_paths is not None:
        if operation_context.trusted_invocation_profile("opencode") is None:
            # An unknown OpenCode binding makes cleanup unsafe: retain every
            # existing Hub-owned command and shared ordinary link until a
            # later selection refresh can establish the consumer set.
            opencode_command_expected.update(
                path.stem for path in opencode_invocation.owned_command_links(
                    None, native_paths=operation_context.opencode_paths
                )
            )
            opencode_layout = layouts.get("opencode")
            preserved_dirs = (
                {Path(str(opencode_layout.global_skills_dir)).expanduser()}
                if opencode_layout is not None else set()
            )
            for target_dir in preserved_dirs:
                if not target_dir.is_dir() or target_dir.is_symlink():
                    continue
                for link in target_dir.iterdir():
                    if link.is_symlink() and is_hub_owned_link(link):
                        global_targets.setdefault(target_dir, set()).add(link.name)

    if operation_context is None or ("opencode" in layouts and operation_context.opencode_paths is not None):
        removed += opencode_invocation.cleanup_commands(
            None, opencode_command_expected,
            native_paths=operation_context.opencode_paths if operation_context is not None else None,
        )

    # Clean stale global links — walk EVERY harness's global dir (even uninstalled)
    for h_id, h in layouts.items():
        target_dir = Path(str(h.global_skills_dir)).expanduser()
        if not target_dir.exists():
            continue
        expected = global_targets.get(target_dir, set())
        # If multiple harnesses share the dir (codex+pi), union their expected sets
        for other_id, other in layouts.items():
            if (
                other_id != h_id
                and Path(str(other.global_skills_dir)).expanduser() == target_dir
            ):
                expected = expected | global_targets.get(target_dir, set())
        dir_removed, dir_unowned = remove_unmanaged_entries(
            target_dir, expected, f"global {h.label} skill"
        )
        removed += dir_removed
        skipped_unowned += dir_unowned

    if report is not None:
        report["global"]["skills"]["writes"] += writes
        report["global"]["skills"]["removed"] += removed
        report["global"]["skills"]["skipped_unowned"] += skipped_unowned

    return global_skill_names


def _run_backup_pass(
    registry: dict,
    *,
    push: bool = True,
    force: bool = True,
    report: Optional[dict] = None,
    operation_context=None,
) -> None:
    """`hub sync` tail pass — snapshot the post-sync state into the backup repo.

    **Fail-open by construction**: every failure path (git missing, network
    down, GitHub unreachable, auth expired, a hung `git` hitting the 20s network
    timeout) logs and returns. Sync must never break because a backup could not
    be taken. Fail-open is NOT fail-silent, though: consecutive push failures are
    counted in the `backup:` block so the doctor and the StatusBar can shout.

    The one thing that is NOT fail-open is a refused publish: `SecretLeakError`
    / `PrefixLeakError` mean hub found credential-shaped material (or a broken
    path transform) in the tree it was about to push. That still cannot break
    sync, but it is recorded as a first-class error kind in the report slot AND
    in the registry's `last_push_error`, so it reaches the doctor and the
    StatusBar instead of scrolling past as one yellow line.

    Runs only when `backup.enabled` AND the backup dir is already an initialized
    repo — `hub backup init` stays the one place that creates state.
    `run_backup` takes the data-home lock itself (assembly + commit only), so
    this pass adds no lock of its own and never holds one across the push.
    """
    from skill_hub.application.backup import backup as _backup

    slot = report["global"].get("backup") if report is not None else None
    if slot is None and report is not None:
        slot = _new_backup_report_slot()
        report["global"]["backup"] = slot

    try:
        if not _backup.has_backup_config(registry):
            # No `backup:` block at all — the user has never run `hub backup
            # init`. Saying "Backup: disabled" on every single sync advertises a
            # feature they did not ask for as if it were broken. Silent, but
            # still stamped in the report so the app can tell the two apart.
            if slot is not None:
                slot["skipped"] = "not-configured"
            return
        cfg = _backup.load_backup_config(registry)
        if not cfg["enabled"]:
            print(f"\n{c('Backup:', BOLD)} disabled")
            if slot is not None:
                slot["skipped"] = "disabled"
            return
        if not _backup.is_initialized(registry):
            print(
                f"\n{c('Backup:', BOLD)} not initialized — run "
                f"{c('hub backup init', CYAN)}"
            )
            if slot is not None:
                slot["skipped"] = "not-initialized"
            return

        print(f"\n{c('Backup:', BOLD)}")
        result = _backup.run_backup(registry, push=push, force=force, operation_context=operation_context)

        if slot is not None:
            slot["ran"] = True
            slot["skipped"] = result.get("skipped")
            slot["committed"] = bool(result.get("committed"))
            slot["pushed"] = bool(result.get("pushed"))
            slot["conflict"] = bool(result.get("conflict"))
            slot["error"] = result.get("error")
            slot["at"] = _now_iso()

        if result.get("skipped") == "unchanged":
            print(f"  {c('·', DIM)} nothing changed since the last snapshot")
        elif result.get("committed"):
            print(f"  {c('✓', GREEN)} snapshot committed {str(result['commit'])[:12]}")
        else:
            print(f"  {c('·', DIM)} snapshot rebuilt, no net change")
        if push and result.get("skipped") != "unchanged":
            mark = c("✓", GREEN) if result.get("pushed") else c("·", DIM)
            print(f"  {mark} {result.get('push_detail') or 'not pushed'}")
        elif not push:
            print(f"  {c('·', DIM)} push deferred to the next explicit `hub sync`")
        for warning in result.get("warnings") or []:
            print(f"  {c('!', YELLOW)} {warning}")
        if result.get("error"):
            print(f"  {c('!', YELLOW)} {result['error']}")

        try:
            if _backup.record_push_outcome(registry, result):
                hub_core.save_registry(registry)
        except Exception:
            pass  # bookkeeping must never break sync either
    except (_backup.SecretLeakError, _backup.PrefixLeakError) as exc:
        # Fail-CLOSED refusal, not a soft failure: the snapshot was withheld on
        # purpose. Still non-fatal to sync, but it must not read like a hiccup.
        kind = "secret_leak" if isinstance(exc, _backup.SecretLeakError) else "prefix_leak"
        if slot is not None:
            slot["error"] = str(exc)
            slot["error_kind"] = kind
            slot["at"] = _now_iso()
        print(f"  {c('✗', RED)} backup REFUSED ({kind}) — nothing was committed or pushed:")
        print(f"    {exc}")
        _record_backup_block_error(registry, kind, str(exc))
    except Exception as exc:  # fail-open: NEVER propagate into sync
        if slot is not None:
            slot["error"] = str(exc)
            slot["error_kind"] = "error"
        print(f"  {c('!', YELLOW)} backup skipped: {exc}")


def _record_backup_block_error(registry: dict, kind: str, detail: str) -> None:
    """Persist a refused-publish reason into the registry `backup:` block.

    Reuses `last_push_error` rather than adding a field so the block's shape
    (and every reader of it) stays put; the `kind:` prefix keeps it legible.
    """
    from skill_hub.application.backup import backup as _backup

    try:
        if not _backup.has_backup_config(registry):
            return
        cfg = _backup.load_backup_config(registry)
        message = kind + ": " + detail.splitlines()[0]
        if cfg.get("last_push_error") == message:
            return
        cfg["last_push_error"] = message
        _backup.save_backup_config(registry, cfg)
        hub_core.save_registry(registry)
    except Exception:
        pass  # bookkeeping must never break sync either


def _auto_sync(*, operation_context=None):
    """Post-mutation sync used by registry mutations (enable/disable/bundle/etc.).

    Runs the full LOCAL sync — skills, MCP, permissions stream, hooks stream, and the
    doctor all stay enabled — but SKIPS the remote-SSH dispatch (`skip_remotes=True`)
    and pushes NOTHING to the backup remote (`backup_push=False`) — the snapshot is
    still committed locally, so no history is lost, but an equip click never waits on
    a network round-trip. The push happens on the next explicit `hub sync`.
    Hooks are kept SYMMETRIC with permissions here: `_auto_sync` skips only remotes
    (the one pass that does slow live SSH), so — like the permissions stream — the
    hooks stream reconciles on every mutation. Remote push is framed as eventual (the
    UI says "Reconciled on next sync"); it happens only on an explicit `hub sync` /
    `hub remote sync <id>`, not on every mutation click.

    NO NETWORK CALL may sit on this path. `backup_push=False` also gates the
    backup repo's `git fetch`/`reset` onto the remote tip (see `run_backup`), and
    `backup_force=False` keeps the snapshot behind its stat fingerprint, so a
    click costs a few hundred `stat()`s and — at most — one local commit.
    """
    import hub

    class _AutoSyncArgs:
        skip_remotes = True
        backup_push = False
        backup_force = False

    args = _AutoSyncArgs()
    if operation_context is not None:
        args._operation_context = operation_context
    hub.cmd_sync(args)
    try:
        return json.loads(sync_report_path().read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _auto_sync_tail(*, operation_context=None) -> bool:
    """Post-mutation auto-sync for commands whose mutation already succeeded.

    `cmd_sync` sys.exit()s on stream write errors (rc 1) and doctor danger
    findings (rc 2). For a mutation command that has already landed its
    registry write, propagating that exit would fail the command, skip the
    `@registry_mutation` audit record, and abort any chained shell step — so
    the exit is caught and reported on stderr instead. An explicit `hub sync`
    keeps the exit-code contract; `cmd_permissions_set` carries the rc in its
    JSON payload instead of using this helper.

    Returns `True` when the auto-sync came back clean (rc 0), `False` when it
    absorbed a rc 1/2 `SystemExit` or another exception — a caller printing a
    "✓ synced" line must gate it on this, never claim success unconditionally
    (a swallowed rc 1/2 is not a clean sync).
    """
    import hub

    try:
        if operation_context is None:
            hub._auto_sync()
        else:
            hub._auto_sync(operation_context=operation_context)
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else 1
        reason = "doctor danger findings" if rc == 2 else "stream write errors"
        print(
            f"  {c('!', YELLOW)} auto-sync exited with rc {rc} ({reason}) — "
            f"the mutation itself succeeded",
            file=sys.stderr,
        )
        return False
    except Exception as e:
        print(
            f"  {c('!', YELLOW)} auto-sync failed: {e} — the mutation itself "
            f"succeeded",
            file=sys.stderr,
        )
        return False
    return True


def cmd_sync(args):
    """Public sync entry point.

    The body runs inside a `try/finally` that does three things, in this order:

    1. **The backup tail pass always runs** — including on the paths where the
       body `sys.exit()`s (stream write errors, doctor danger findings). A tail
       placed after those gates would be unreachable exactly when the
       configuration changed most, i.e. precisely when a snapshot matters. The
       pass itself is fail-open and never raises.
    2. **Exactly one `write_sync_report`**, after the tail has stamped
       `report["global"]["backup"]`. One write in the finally is the only way to
       honour the "written on every exit path" guarantee: an unexpected
       exception in any pass used to escape with no report at all, and moving
       the write inside the tail would skip it whenever the tail early-returns
       (a body that raised before `ctx["registry"]` existed).
    3. **The success banner last**, so the backup summary is not printed after
       the line that says the sync is done.
    """
    ctx: dict = {}
    try:
        _cmd_sync_body(args, ctx)
    finally:
        _cmd_sync_backup_tail(args, ctx)
        report = ctx.get("report")
        if report is not None:
            # Guarded so a report-write failure never masks the real exception.
            try:
                write_sync_report(report)
            except Exception as e:  # pragma: no cover - defensive
                print(
                    f"  {c('!', YELLOW)} could not write sync report: {e}",
                    file=sys.stderr,
                )
        if ctx.get("ok"):
            print(f"\n{c('✓ sync complete', GREEN, BOLD)}\n")


def _cmd_sync_backup_tail(args, ctx: dict) -> None:
    """Run the backup pass once and stamp its report slot. Never raises.

    Does NOT write the report — `cmd_sync`'s finally owns that single write, so
    it happens even on the paths where this returns early.
    """
    if ctx.get("backup_done") or "registry" not in ctx:
        return
    ctx["backup_done"] = True
    report = ctx.get("report")
    try:
        if bool(getattr(args, "skip_backup", False)):
            print(f"\n{c('Backup:', BOLD)} skipped (--skip-backup)")
            if report is not None:
                report["global"]["skipped"].append("backup")
                report["global"]["backup"]["skipped"] = "flag"
        elif ctx.get("operation_context") is None:
            if report is not None:
                report["global"]["backup"]["skipped"] = "selection-unavailable"
        else:
            _run_backup_pass(
                ctx["registry"],
                # `_auto_sync` sets this False: commit locally, defer the push.
                push=bool(getattr(args, "backup_push", True)),
                # …and this False too: an EXPLICIT sync always re-assembles, so
                # the fingerprint-invisible inputs (the audit ledger, which is
                # excluded from the fingerprint precisely because it changes on
                # every mutation) still reach a commit. A per-click `_auto_sync`
                # honours the fingerprint instead and costs a few hundred stats.
                force=bool(getattr(args, "backup_force", True)),
                report=report,
                operation_context=ctx.get("operation_context"),
            )
    except Exception as exc:  # pragma: no cover — belt and braces
        print(f"  {c('!', YELLOW)} backup tail skipped: {exc}")


def _cmd_sync_body(args, ctx: dict):
    import hub
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    registry = hub_core.load_registry()
    ctx["registry"] = registry

    # 0. Built-in skills: register the Starter Pack shipped under
    # code_home()/skills as `managed: starter` entries. Runs BEFORE validation
    # so a freshly registered built-in gets its frontmatter mirror in this
    # same run. Additive and idempotent; a user skill of the same name wins.
    from skill_hub.application.skills import starter_skills as _starter

    starter_result = _starter.reconcile_starter_skills(
        registry,
        warn=lambda m: print(f"  {c('!', YELLOW)} {m}", file=sys.stderr),
    )
    if starter_result["changed"]:
        hub_core.save_registry(registry)

    skills = registry.get("skills", {})
    projects = registry.get("projects", {})
    skip_permissions = bool(getattr(args, "skip_permissions", False))
    skip_hooks = bool(getattr(args, "skip_hooks", False))
    skip_remotes = bool(getattr(args, "skip_remotes", False))
    strict_remotes = bool(getattr(args, "strict_remotes", False))

    operation_context = getattr(args, "_operation_context", None)
    installed = (
        set(operation_context.installed_harness_ids or ())
        if operation_context is not None else _harnesses.detect_installed()
    )
    known_ids = set(operation_context.layouts) if operation_context is not None else set(_harnesses.HARNESSES)

    # Warn once about unknown harness ids referenced anywhere in the registry
    referenced: set[str] = set(registry.get("harnesses_global") or [])
    for p in projects.values():
        referenced.update(p.get("harnesses") or [])
    for unknown in sorted(referenced - known_ids):
        print(
            f"  {c('!', YELLOW)} unknown harness id '{unknown}' in registry — ignored",
            file=sys.stderr,
        )

    print(f"\n{c('hub sync', BOLD, CYAN)}\n")

    if starter_result["changed"]:
        print(c("Built-in skills:", BOLD))
        for name in starter_result["registered"]:
            print(f"  {c('+', GREEN)} registered built-in {name} (managed: starter)")
        for name in starter_result["repointed"]:
            print(f"  {c('→', YELLOW)} re-pointed built-in {name} at the current app")
        for name in starter_result["updated"]:
            print(f"  {c('·', DIM)} refreshed built-in metadata: {name}")
        print()
    for name, reason in starter_result["skipped"]:
        print(f"  {c('!', YELLOW)} built-in {name} not registered: {reason}", file=sys.stderr)

    # Sync report accumulator — threaded through every pass and written on EVERY
    # exit path by `cmd_sync`'s finally (see there): the documented guarantee is
    # "every exit path", and per-exit-point calls could only ever cover the exits
    # someone remembered. An UNEXPECTED exception in any pass (previously: a
    # hook-stream bake failure) used to escape with no report at all, leaving the
    # UI showing stale freshness for a sync that had already written to disk.
    #
    # Published on `ctx` IMMEDIATELY, before any pass runs, so the outer finally
    # can still write it when a pass raises.
    report = new_sync_report()
    ctx["report"] = report

    # One compatibility snapshot is shared by every native/MCP delivery row in
    # this sync. Selection may collect once; all later consumers reuse it.
    if operation_context is None:
        from skill_hub.infrastructure.harnesses.opencode_invocation import owned_command_links

        participants = installed | (referenced & known_ids)
        command_scopes = [None, *(Path(cfg["path"]) for cfg in projects.values() if cfg.get("path"))]
        if any(owned_command_links(scope) for scope in command_scopes):
            participants.add("opencode")
        operation_context = build_operation_context(
            hub_core.data_home(),
            tuple(sorted(participants)),
            installed_harness_ids=tuple(sorted(installed)),
            requested_features=WORKFLOW_FEATURES,
            host_version=Version.parse(hub_core.hub_version()),
            sdk_version=SDK_VERSION,
            needs_selection=True,
        )
    ctx["operation_context"] = operation_context
    report["mcp_operation_context"] = serialize_operation_context(operation_context)

    validate_registry_skills(registry)

    # Pull `harnesses:` frontmatter from SKILL.md files into the registry.
    if sync_skill_frontmatter_metadata(registry):
        hub_core.save_registry(registry)

    # One rename-variant reconcile per skill for the WHOLE run, shared by the
    # global pass and every project pass (the variant dir is shared too).
    variant_cache: dict = {}

    # One reference graph per run (not per project) — building it needs a
    # SKILL.md read per claude-skill, so it is computed once here and threaded
    # into every `_sync_project_skills` call. A failure is logged and the
    # `missing_refs` pass is simply skipped for this run (non-blocking).
    refs_graph: Optional[dict] = None
    try:
        from skill_hub.domain.skills import skill_refs as _skill_refs

        refs_graph = _skill_refs.build_graph(registry)
    except Exception as e:
        print(
            f"  {c('!', YELLOW)} could not build skill-reference graph: {e}",
            file=sys.stderr,
        )

    # 1. Global skills → each installed harness's global_skills_dir
    _sync_global_skills(
        registry,
        installed,
        report=report,
        variant_cache=variant_cache,
        operation_context=operation_context,
    )

    # 1b. Global MCP servers → each installed harness's user-global MCP config.
    # Part of the MCP stream (NOT gated by --skip-permissions).
    _run_global_mcp_dispatch(
        registry, installed, report=report, operation_context=operation_context
    )

    # 1c. Remote connectors → push each sync_enabled remote's desired state.
    # Mirrors the global-MCP pass; non-blocking on drift/conflict/unreachable.
    remote_alarming = 0
    if skip_remotes:
        print(f"\n{c('Remotes:', BOLD)} skipped (--skip-remotes)")
        report["global"]["skipped"].append("remotes")
    else:
        remote_alarming = hub._run_remote_dispatch(
            registry, installed, strict=strict_remotes, report=report
        )

    # 2. Per-project skills (resolved from bundles + individually enabled)
    print(f"\n{c('Project skills:', BOLD)}")
    for proj_name, proj_cfg in projects.items():
        proj_path = expand(proj_cfg["path"])
        effective = operation_context.effective_harness_ids(proj_cfg, registry)
        _sync_project_skills(
            proj_name, proj_path, proj_cfg, registry, effective, installed,
            report=report, variant_cache=variant_cache, refs_graph=refs_graph,
            operation_context=operation_context,
        )

    # Invocation-override variants no longer demanded by any (project, skill)
    # pair are orphans — the whole tree is regenerable, so removal is safe.
    _cleanup_variant_orphans(registry)
    from skill_hub.infrastructure.harnesses.opencode_invocation import collect_orphan_payloads

    preserve_opencode = (
        "opencode" in getattr(operation_context, "harness_ids", ())
        and operation_context.trusted_invocation_profile("opencode") is None
    )
    if (
        "opencode" in operation_context.layouts and not preserve_opencode
        and operation_context.opencode_paths is not None
    ):
        collect_orphan_payloads([
            Path(cfg["path"])
            for cfg in registry.get("projects", {}).values()
            if cfg.get("path")
        ], native_paths=operation_context.opencode_paths)

    # 2b. Agent-docs canonical-root detection (read-only; migration is explicit).
    _run_agent_docs_detection(registry, projects, installed, operation_context=operation_context)

    # 2c. Project-local skill detection (read-only; import is explicit). Surfaces
    # hand-authored skills the hub doesn't track yet so sync no longer ignores them.
    _run_project_skill_detection(registry, operation_context=operation_context)

    # 2d. ships_with companions reconcile (D11/A16) — before the permissions/
    # hooks streams so this run's registry mutations land in the SAME save.
    import skill_hub.entrypoints.cli.companions as _companions

    _companions.run_reconcile_pass(
        registry, report=report, skip_hooks=skip_hooks, skip_permissions=skip_permissions,
        operation_context=operation_context,
    )

    # 2e. Loadout ledger append — one row per (project, harness) whose resolved
    # loadout hash changed since the last row for that pair. Append only.
    from skill_hub.infrastructure.usage import usage_loadouts as _loadouts

    _loadouts.run_loadout_pass(
        registry,
        resolve_skills=resolve_project_skills,
        installed=installed,
        affinity=skill_meta.skill_affinity,
        report=report,
    )

    # 3. Permissions stream, then 3b. Hooks stream, then 3c. shared Doctor
    # rollup. The permissions stream SHALL complete before the hooks stream
    # begins so the two writers never interleave on a shared settings file.
    perm_doctor_targets: list = []
    hook_doctor_targets: list = []
    permissions_write_rc = 0
    hooks_write_rc = 0

    if skip_permissions:
        print(f"\n{c('Permissions:', BOLD)} skipped (--skip-permissions)")
        report["global"]["skipped"].append("permissions")
    else:
        permissions_write_rc = hub._run_permissions_stream(
            registry, projects, installed, _harnesses,
            report=report, doctor_targets=perm_doctor_targets,
            operation_context=operation_context,
        )
        # Persist any registry mutations from auto-import (before hooks run).
        hub_core.save_registry(registry)

    if skip_hooks:
        print(f"\n{c('Hooks:', BOLD)} skipped (--skip-hooks)")
        report["global"]["skipped"].append("hooks")
    else:
        hooks_write_rc = hub._run_hooks_stream(
            registry, projects, installed, _harnesses,
            report=report, hook_targets=hook_doctor_targets,
            operation_context=operation_context,
        )

    # 3c. Shared doctor rollup — runs unless BOTH streams were skipped, so a
    # single-stream skip still surfaces the other stream's findings (task 2.4).
    doctor_rc = 0
    if not (skip_permissions and skip_hooks):
        doctor_rc = hub._run_doctor_rollup(
            perm_doctor_targets,
            hook_doctor_targets,
            _harnesses,
            report=report,
            registry=registry,
            operation_context=operation_context,
        )

    # A danger finding (rc 2) beats a write error (rc 1). Exit non-zero when
    # either stream errored on a write OR the doctor found a danger.
    streams_rc = 2 if doctor_rc == 2 else (
        max(permissions_write_rc, hooks_write_rc)
    )
    if streams_rc != 0:
        if doctor_rc == 2:
            print(f"\n{c('✗ sync completed with danger findings', RED, BOLD)}\n")
        else:
            print(f"\n{c('✗ sync completed with stream errors', RED, BOLD)}\n")
        sys.exit(streams_rc)

    # L1: in --strict-remotes mode, an alarming remote failure (auth / host-key
    # mismatch / integrity) exits non-zero, mirroring the permissions doctor.
    if strict_remotes and remote_alarming:
        print(
            f"\n{c('✗ sync completed with alarming remote failures', RED, BOLD)} "
            f"({remote_alarming})\n"
        )
        sys.exit(2)

    # No `write_sync_report` here (nor on the sys.exit paths above): `cmd_sync`'s
    # finally performs the ONE guaranteed write, after the backup tail has
    # stamped its slot. The success banner is printed there too, so it lands
    # after the backup summary rather than before it.
    ctx["ok"] = True


def _run_agent_docs_detection(registry: dict, projects: dict, installed: set[str], *, operation_context=None) -> None:
    """Read-only pass: flag projects whose root docs differ from canonical.

    Never mutates any root instruction file — the fix is explicit via
    `hub agent-docs fix`. Divergent conflicts are non-blocking. The rollup is
    root-only plus a nested-deviation count to keep sync output small.
    """
    from skill_hub.infrastructure.filesystem import agent_docs

    print(f"\n{c('Agent docs (detection only):', BOLD)}")
    flagged = 0
    for name, proj in projects.items():
        status = agent_docs.detect_status(
            proj, registry, installed=installed, context=operation_context,
            effective=(
                operation_context.effective_harness_ids(proj, registry) if operation_context is not None else None
            ),
        )
        st = status["state"]
        nested = status.get("nested_deviations", 0)
        nested_note = f" (+{nested} nested)" if nested else ""
        if st == "needs_canonicalization":
            flagged += 1
            print(
                f"  {c('•', YELLOW)} {name}: needs canonicalization — {status['reason']}{nested_note} "
                f"(run `hub agent-docs fix --project {name} --apply`)"
            )
        elif st == "conflict":
            flagged += 1
            print(
                f"  {c('!', RED)} {name}: divergent CLAUDE.md vs AGENTS.md{nested_note} — "
                f"resolve via `hub agent-docs resolve`"
            )
        elif nested:
            flagged += 1
            print(
                f"  {c('•', YELLOW)} {name}: root canonical, {nested} nested deviation(s) "
                f"(run `hub agent-docs fix --project {name}`)"
            )
        # An `@` import that points nowhere is a file the agent is told to read
        # and cannot. Reported here so sync and the app say the same thing about
        # the same project — a GUI that warns while the scheduled sync calls it
        # `ok` is worse than the CLI not having the feature at all.
        for importer, missing in sorted(status.get("unresolved_imports", {}).items()):
            flagged += 1
            print(
                f"  {c('•', YELLOW)} {name}: {importer} imports "
                f"{', '.join(missing)} — not found"
            )
    if flagged == 0:
        print(f"  {c('✓', GREEN)} all projects canonical")


def _run_project_skill_detection(registry: dict, *, operation_context=None) -> None:
    """Read-only pass: surface hand-authored skills inside projects that the hub
    doesn't track yet, so a sync no longer silently ignores them.

    Import is explicit via `hub project import-skill`. Non-blocking.
    """
    print(f"\n{c('Project-local skills (detection only):', BOLD)}")
    candidates = scan_project_skill_candidates(registry, operation_context=operation_context)
    if not candidates:
        print(f"  {c('✓', GREEN)} no untracked project-local skills")
        return

    by_proj: dict[str, list[dict]] = {}
    for cand in candidates:
        by_proj.setdefault(cand["project"], []).append(cand)

    for proj_name in sorted(by_proj):
        cands = by_proj[proj_name]
        print(
            f"  {c('⚠', YELLOW)} {proj_name}: {len(cands)} untracked "
            f"project-local skill(s)"
        )
        for cand in cands:
            if cand["category"] == "INVALID_NAME":
                print(
                    f"      {c('✗', RED)} {cand['name']} ({cand['rel']}) — "
                    f"invalid name; rename to ^[a-z0-9-]+$ before import"
                )
            else:
                print(f"      {cand['name']}  ({cand['rel']})")
        first_valid = next((x for x in cands if x["category"] == "NEW"), None)
        if first_valid:
            print(
                f"      → run `hub project import-skill {first_valid['name']} "
                f"--project {proj_name}` to register"
            )
