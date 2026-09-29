"""`hub bootstrap` / `hub migrate-home` — first-run wizard + legacy-home move.

`bootstrap` initializes the data home (optionally offering a legacy-home
migration or a from-backup restore first), then runs the import wizard and
the global-permissions adoption prompt before a full sync. `migrate-home` is
the narrower, explicitly-invoked half of that same legacy-home move — both
share `_migrate_one_legacy` / `_move_path` / `_merge_move_dir`.

`_confirm` stays in `hub.py` (the restore and remote slices call it as
`hub._confirm`, and tests stub it there); everything else this module needs
from the monolith is reached through `hub.<name>` (a function-local
`import hub` as the first statement of any function that needs one) so
monkeypatching `hub.X` keeps working. Registry I/O and the other names tests
rebind through the `hub` ↔ `hub_core` facade (`load_registry`, `save_registry`,
`registry_file`, `MIN_PYTHON`, `DEFAULT_DATA_HOME`, `LEGACY_DATA_HOMES`) go
through the `hub_core.` module attribute, never a value-imported copy — see
`hub_cli/source.py`'s header comment for why that matters.

Carved out of `hub.py` (S5 slice E) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Optional

import yaml

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    YELLOW,
    _now_iso,
    c,
    data_home_lock,
)

NAME = "bootstrap"

p_bootstrap = None


def register(sub) -> None:
    global p_bootstrap

    # bootstrap
    p_bootstrap = sub.add_parser(
        "bootstrap",
        help="Initialize data home, optionally import global skills (first-run wizard)",
    )
    p_bootstrap.add_argument(
        "--force", action="store_true", help="Re-run even if already bootstrapped"
    )
    p_bootstrap.add_argument(
        "--yes", action="store_true", help="Accept defaults (no prompts)"
    )
    p_bootstrap.add_argument(
        "--dry-run", action="store_true", help="Print plan without writing"
    )
    p_bootstrap.add_argument("--json", action="store_true", help="Emit dry-run as JSON")
    p_bootstrap.add_argument(
        "--skip-migrate",
        action="store_true",
        help="Do not auto-migrate legacy data home",
    )
    p_bootstrap.add_argument(
        "--plan-stdin",
        dest="plan_stdin",
        action="store_true",
        help=(
            "Read an explicit apply-plan JSON from stdin (UI wizard) instead of "
            "the --yes defaults: {register:[path...], "
            "conflict_actions:{path: skip|replace|suffix}, adopt:[path...]}. "
            "Unknown paths/actions fail closed (nothing applied)."
        ),
    )
    p_bootstrap.add_argument(
        "--restore-from",
        dest="restore_from",
        help="Restore from a backup snapshot (URL or path) INSTEAD of the import "
        "wizard. Runs before any import scanning.",
    )
    p_bootstrap.add_argument(
        "--restore-mode",
        dest="restore_mode",
        choices=["replace", "merge"],
        help="Registry mode for --restore-from (default: replace)",
    )
    p_bootstrap.add_argument(
        "--restore-branch", dest="restore_branch", help="Branch to restore from"
    )
    p_bootstrap.add_argument(
        "--accept-executable-state",
        dest="accept_executable_state",
        action="store_true",
        help="Consent to restoring hooks / permission rules / Codex trust grants",
    )
    p_bootstrap.add_argument(
        "--trust-new-key",
        dest="trust_new_key",
        action="store_true",
        help="Accept (and pin) a snapshot signed by a key this machine has not seen",
    )


def dispatch(args) -> None:
    cmd_bootstrap(args)


# ─────────────────────────────────────────────────────────────────────────────
# hub bootstrap / hub migrate-home
# ─────────────────────────────────────────────────────────────────────────────


def _migration_target_home() -> Path:
    """Target for migrate-home, ignoring legacy fallback.

    data_home() intentionally falls back to ~/Dev/.skill-hub when the new
    default has no registry yet. migrate-home is the command that should end
    that fallback, so its target must be the explicit/new home instead.
    """
    home_env = os.environ.get("SKILL_HUB_HOME", "").strip()
    if home_env:
        return Path(home_env).expanduser().absolute()
    return hub_core.DEFAULT_DATA_HOME.absolute()


def _migration_legacy_candidates(target: Path) -> list[Path]:
    """Legacy homes eligible to migrate into target."""
    out: list[Path] = []
    seen: set[Path] = set()
    candidates = [*hub_core.LEGACY_DATA_HOMES]
    dir_env = os.environ.get("SKILL_HUB_DIR", "").strip()
    if dir_env:
        candidates.append(Path(dir_env).expanduser())
    for legacy in candidates:
        legacy = legacy.absolute()
        try:
            if legacy.resolve() == target.resolve():
                continue
            key = legacy.resolve()
        except OSError:
            key = legacy
        if key in seen:
            continue
        seen.add(key)
        if (legacy / "registry.yaml").exists():
            out.append(legacy)
    return out


def cmd_migrate_home(args):
    """Move legacy data home into the explicit/default data home."""
    import hub

    target = _migration_target_home()
    legacies = _migration_legacy_candidates(target)
    if not legacies:
        print(f"{c('No legacy data home detected.', DIM)}")
        return
    print(f"\n{c('hub migrate-home', BOLD, CYAN)}")
    print(f"  Target: {target}")
    for legacy in legacies:
        print(f"  Legacy: {legacy}")

    if not getattr(args, "yes", False):
        try:
            response = input("Proceed with migration? [y/N] ").strip().lower()
        except EOFError:
            response = "n"
        if response != "y":
            print("Aborted.")
            return

    with data_home_lock():
        for legacy in legacies:
            _migrate_one_legacy(legacy, target)

    # Refresh cache so subsequent calls see the migrated state. The cache lives
    # in hub_core (S5) — a bare `global` here would create a SECOND, shadowing
    # binding in hub.__dict__ and leave the real resolver's cache stale.
    hub_core._DATA_HOME_CACHE = None

    print(f"\n{c('Running sync against new data home...', DIM)}")

    # Explicit user-invoked flow (migrate-home): run the FULL sync incl. remote dispatch —
    # NOT the mutation-path _auto_sync() which skips remotes.
    class _A:
        pass

    hub.cmd_sync(_A())


def _move_path(src: Path, dst: Path) -> bool:
    """`os.replace`, falling back to `shutil.move` across filesystems."""
    try:
        os.replace(str(src), str(dst))
        return True
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
        shutil.move(str(src), str(dst))
        return True


def _merge_move_dir(src: Path, dst: Path, label: str) -> int:
    """Move `src` into an EXISTING `dst`, resolving collisions per child.

    Used for `state/`: the target data home may already hold a partial `state/`
    (sync writes one on first use), and skipping the whole directory would
    strand the legacy signing keys and sub-agent link membership at the old
    home — exactly the data a migration must not abandon. Returns the number of
    entries moved.
    """
    moved = 0
    try:
        children = sorted(src.iterdir())
    except OSError:
        return 0
    for child in children:
        target = dst / child.name
        child_label = label + "/" + child.name
        if not target.exists() and not target.is_symlink():
            try:
                dst.mkdir(parents=True, exist_ok=True)
                _move_path(child, target)
                moved += 1
            except OSError as e:
                print(f"  {c('!', RED)} failed to move {child_label}: {e}")
            continue
        if child.is_dir() and target.is_dir() and not child.is_symlink():
            moved += _merge_move_dir(child, target, child_label)
            continue
        print(f"  {c('!', YELLOW)} {child_label} exists at target; left in place")
    try:
        src.rmdir()  # only succeeds when fully drained
    except OSError:
        pass
    return moved


def _migrate_one_legacy(legacy: Path, target: Path) -> None:
    """Move one legacy data home into `target`.

    The entry list comes from the canonical manifest table in `backup.py` so
    migrate, backup, and (M3) restore can never drift. Unknown top-level entries
    are moved too — a local move must never abandon user data just because the
    table has not heard of it yet. `_hub-backups/`, `usage/`, and `sources/` all
    travel: they are "derived" only from a BACKUP standpoint, and stranding a
    user's rollback snapshots at the old path would silently destroy the undo
    story.
    """
    from skill_hub.application.backup import backup as _backup

    moved_any = False
    #: Entries still (wholly or partly) living at the legacy home after this
    #: pass. Their registry paths must NOT be rewritten to the new home.
    stayed: set[str] = set()
    for entry_name in _backup.migrate_entries(legacy):
        src = legacy / entry_name
        if not src.exists() and not src.is_symlink():
            continue
        dst = target / entry_name
        if dst.exists():
            # data_home() auto-creates empty skills/, mcp-servers/, _hub-backups/
            # at the target. Those empty placeholders aren't real collisions.
            if dst.is_dir() and not any(dst.iterdir()):
                try:
                    dst.rmdir()
                except OSError:
                    print(f"  {c('!', YELLOW)} {entry_name} exists at target; skipping")
                    stayed.add(entry_name)
                    continue
            elif entry_name in _backup.MIGRATE_MERGE_ENTRIES and dst.is_dir() and src.is_dir():
                merged = _merge_move_dir(src, dst, entry_name)
                if merged:
                    print(f"  {c('→', CYAN)} merged {merged} entries into {entry_name}/")
                    moved_any = True
                # A per-child merge can leave colliding children behind, so this
                # entry is only fully migrated once its legacy dir is gone.
                if src.exists():
                    stayed.add(entry_name)
                continue
            else:
                print(f"  {c('!', YELLOW)} {entry_name} exists at target; skipping")
                stayed.add(entry_name)
                continue
        try:
            _move_path(src, dst)
            print(f"  {c('→', CYAN)} moved {entry_name}")
            moved_any = True
        except OSError as e:
            print(f"  {c('!', RED)} failed to move {entry_name}: {e}")
            stayed.add(entry_name)

    # Rewrite EVERY path in the registry that named the legacy home. A blanket
    # prefix sweep is correct here (unlike the portable transform, which must be
    # field-scoped): after a local move, every string naming the old location is
    # stale. This covers `skills.*.source`, `sources.*.cache`, `mcp.args`, and
    # anything else — moving sources/ without rewriting its cache paths would
    # break every git-sourced skill.
    #
    # EXCEPT for entries that did not actually move: rewriting those would point
    # the registry at a path that holds nothing (the files are still at the
    # legacy home), converting a visible partial migration into a silent set of
    # dangling references. Those keep the old path and are reported.
    reg_path = target / "registry.yaml"
    if reg_path.exists() and moved_any:
        with open(reg_path) as f:
            reg = yaml.safe_load(f) or {}
        left_behind: list[str] = []
        rewritten = _backup.remap_prefix(
            reg, legacy, target, skip_entries=stayed, left_behind=left_behind
        )
        if left_behind:
            print(
                f"  {c('!', YELLOW)} {len(left_behind)} registry path(s) still point at "
                f"{legacy} because their entry did not move "
                f"({', '.join(sorted(stayed))}):"
            )
            for value in sorted(set(left_behind)):
                print(f"      {value}")
        if rewritten != reg:
            with open(reg_path, "w") as f:
                yaml.dump(
                    rewritten,
                    f,
                    default_flow_style=False,
                    allow_unicode=True,
                    sort_keys=False,
                )
            print(f"  {c('✓', GREEN)} rewrote legacy paths in registry.yaml")

    # Leave a forwarding pointer
    pointer = legacy / "LEGACY-MOVED.txt"
    try:
        pointer.write_text(
            f"Skill Hub data moved to {target} on {_now_iso()}\n"
            f"This directory may still hold app source code; only data was moved.\n"
        )
    except OSError:
        pass


def _detect_restore_source(registry: Optional[dict]) -> Optional[str]:
    """A local snapshot this machine could restore from, or None.

    Detection is a pure existence check (`manifest.json` at the tip of the
    configured backup dir, else the default location) — it never clones, never
    dials the network, and never mutates. Bootstrap uses it to OFFER the restore
    path; the app reads it from the dry-run payload.
    """
    from skill_hub.application.backup import backup as _backup

    cfg = _backup.load_backup_config(registry or {})
    seen: set = set()
    for candidate in (cfg.get("dir"), _backup.DEFAULT_BACKUP_DIR):
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        path = Path(str(candidate)).expanduser()
        if (path / _backup.MANIFEST_FILE).is_file():
            return str(path)
    return None


def _bootstrap_restore(args, source: str) -> None:
    """The `hub bootstrap --restore-from …` branch: restore, then sync.

    Deliberately skips BOTH the import wizard and the global-permissions
    adoption prompt: the snapshot already carries the answer to each, and
    adopting this machine's pre-existing native rules on top of a just-restored
    `permissions_global` would silently merge two unrelated configurations.
    `hub restore` writes the `bootstrap:` block itself (with `restored_from`),
    so there is nothing left for bootstrap to stamp.
    """
    import hub

    print(f"\n{c('Restoring from', BOLD, CYAN)} {source}\n")
    restore_args = argparse.Namespace(
        from_=source,
        mode=getattr(args, "restore_mode", None) or "replace",
        apply=True,
        force=bool(getattr(args, "force", False)),
        trust_new_key=bool(getattr(args, "trust_new_key", False)),
        accept_executable_state=bool(getattr(args, "accept_executable_state", False)),
        branch=getattr(args, "restore_branch", None),
        sync=False,
        json=bool(getattr(args, "json", False)),
    )
    hub.cmd_restore(restore_args)

    class _A:
        _operation_context = getattr(restore_args, "_operation_context", None)

    hub.cmd_sync(_A())


def _provision_initial_setup(selected: tuple[str, ...], *, fresh_registry: bool = False) -> dict:
    """Install first-run control-plane defaults before the first sync."""
    import hub
    from skill_hub.entrypoints.cli.mcp_control import bundled_control_available, ensure_control_plane_setup
    if not bundled_control_available():
        return {"changed": False, "server": "unavailable", "companion": "unavailable"}
    registry = hub_core.load_registry()
    if fresh_registry and selected and registry.get("harnesses_global") == ["claude-code"]:
        registry["harnesses_global"] = list(selected)
        hub_core.save_registry(registry)
    result = ensure_control_plane_setup(registry, selected_harnesses=selected)
    if result["changed"]:
        hub_core.save_registry(registry)
    if result["server"] in {"registered", "migrated"}:
        print(
            f"  {c('✓', GREEN)} control-plane MCP server ready as "
            f"'{hub.MCP_CONTROL_SKILL_NAME}'"
        )
    elif result["server"] in {"collision", "legacy_collision"}:
        print(
            f"  {c('·', DIM)} control-plane MCP setup preserved a user-owned "
            f"registration ({result['server']})"
        )
    if result["companion"] == "provisioned":
        print(f"  {c('✓', GREEN)} companion skill 'skt-mcp' ready")
    return result


def cmd_bootstrap(args):
    """Initialize data home, optionally migrate legacy, run import wizard."""
    import hub

    # Precondition
    if sys.version_info < hub_core.MIN_PYTHON:
        msg = (
            f"Python {hub_core.MIN_PYTHON[0]}.{hub_core.MIN_PYTHON[1]}+ required "
            f"(running {sys.version_info.major}.{sys.version_info.minor})"
        )
        if getattr(args, "json", False):
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(f"{c('!', RED)} {msg}")
        sys.exit(1)

    force = getattr(args, "force", False)
    dry_run = getattr(args, "dry_run", False)
    json_out = getattr(args, "json", False)
    yes = getattr(args, "yes", False)
    skip_migrate = getattr(args, "skip_migrate", False)
    plan_stdin = getattr(args, "plan_stdin", False)
    # An explicit UI apply-plan is non-interactive by construction: auto-accept
    # the legacy-migration step (the wizard footer already promises it) rather
    # than blocking on a prompt that can never be answered.
    auto_yes = yes or plan_stdin

    def _fail_bootstrap(msg: str) -> None:
        if json_out:
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(f"{c('!', RED)} {msg}")
        sys.exit(1)

    # Read the explicit apply-plan up front (before any prompt could also try to
    # consume stdin). FAIL-CLOSED: a malformed plan aborts before any mutation.
    plan: Optional[dict] = None
    if plan_stdin:
        raw_plan = sys.stdin.read()
        try:
            parsed = json.loads(raw_plan) if raw_plan.strip() else {}
        except json.JSONDecodeError as exc:
            _fail_bootstrap(f"invalid apply-plan JSON: {exc}")
            return
        if not isinstance(parsed, dict):
            _fail_bootstrap("apply-plan must be a JSON object")
            return
        register = parsed.get("register") or []
        conflict_actions_in = parsed.get("conflict_actions") or {}
        adopt_in = parsed.get("adopt") or []
        # `offered` = the candidate paths the wizard actually DISPLAYED as rows.
        # Optional (older callers omit it → `None`, keeping strict validation).
        # When present it lets apply tolerate the post-migration flip where a NEW
        # candidate the wizard showed became ALREADY_MANAGED, and apply the --yes
        # defaults to candidates that only appeared AFTER migration.
        offered_in = parsed.get("offered", None)
        if not isinstance(register, list) or not all(
            isinstance(x, str) for x in register
        ):
            _fail_bootstrap("apply-plan 'register' must be a list of paths")
            return
        if not isinstance(adopt_in, list) or not all(
            isinstance(x, str) for x in adopt_in
        ):
            _fail_bootstrap("apply-plan 'adopt' must be a list of paths")
            return
        if not isinstance(conflict_actions_in, dict):
            _fail_bootstrap("apply-plan 'conflict_actions' must be an object")
            return
        if offered_in is not None and (
            not isinstance(offered_in, list)
            or not all(isinstance(x, str) for x in offered_in)
        ):
            _fail_bootstrap("apply-plan 'offered' must be a list of paths")
            return
        plan = {
            "register": register,
            "conflict_actions": conflict_actions_in,
            "adopt": adopt_in,
            "offered": offered_in,
        }

    # Read registry without sys.exit on missing
    fresh_registry = not hub_core.registry_file().exists()
    reg = hub._read_registry_optional()
    state = hub.bootstrap_state(reg)

    if state["completed_at"] and not force and not dry_run:
        if json_out:
            print(json.dumps({"ok": True, "already_bootstrapped": True, **state}))
        else:
            print(f"{c('✓', GREEN)} Already bootstrapped at {state['completed_at']}")
        return

    # ── Restore branch (design v2 §8) ──────────────────────────────────────
    # Runs BEFORE any import scanning: a machine being restored is not a machine
    # whose stray `~/.claude/skills/` dirs should be adopted — the snapshot IS
    # the answer, and scanning first would offer to import skills the restore is
    # about to install anyway.
    restore_from = getattr(args, "restore_from", None)
    restore_available = _detect_restore_source(reg)
    interactive = (
        getattr(sys, "stdin", None) is not None
        and sys.stdin.isatty()
        and not auto_yes
        and not json_out
    )
    if not restore_from and not dry_run and interactive and restore_available:
        print(
            f"\n{c('A Skill Tree backup was found at', BOLD)} {restore_available}"
        )
        if hub._confirm("Restore from it instead of setting up a new library?"):
            restore_from = restore_available

    if restore_from and not dry_run:
        _bootstrap_restore(args, restore_from)
        return

    legacy_candidates = state["legacy_detected"]
    candidates = hub.scan_import_candidates(reg)
    blocked = [c for c in candidates if c["category"] == "INVALID_NAME"]
    conflicts = [c for c in candidates if c["category"] == "CONFLICT"]
    new_candidates = [c for c in candidates if c["category"] in ("NEW", "BROKEN")]
    already = [c for c in candidates if c["category"] == "ALREADY_MANAGED"]
    silent_skip = [c for c in candidates if c["category"] == "SILENT_SKIP"]

    if dry_run:
        payload = {
            "legacy_detected": legacy_candidates,
            "candidates": new_candidates,
            "conflicts": conflicts,
            "blocked": blocked,
            "already_managed": [c["name"] for c in already],
            "silent_skip": [c["name"] for c in silent_skip],
            # Additive (M4): lets the wizard offer "Restore from backup" as its
            # first decision without a second round-trip. Never a mutation.
            "restore_available": restore_available,
        }
        if json_out:
            print(json.dumps(payload, indent=2))
        else:
            print(json.dumps(payload, indent=2))
        return

    # Migration
    if legacy_candidates and not skip_migrate:
        if auto_yes or hub._confirm(f"Migrate legacy data home(s) {legacy_candidates}?"):
            args_obj = argparse.Namespace(yes=True)
            cmd_migrate_home(args_obj)
            reg = hub._read_registry_optional()
            candidates = hub.scan_import_candidates(reg)
            blocked = [c for c in candidates if c["category"] == "INVALID_NAME"]
            conflicts = [c for c in candidates if c["category"] == "CONFLICT"]
            new_candidates = [
                c for c in candidates if c["category"] in ("NEW", "BROKEN")
            ]
            # Migration can flip a NEW candidate to ALREADY_MANAGED (its skill dir
            # is now symlinked into the moved data home) — recompute so apply can
            # tolerate a plan path that became already-managed.
            already = [c for c in candidates if c["category"] == "ALREADY_MANAGED"]

    # Resolve the selection sets: either the explicit UI plan (--plan-stdin) or
    # the CLI default (select all NEW; conflicts default to skip).
    if plan is not None:
        # Candidates keyed by their unique path — recomputed AFTER any migration,
        # so the sets reflect post-migration reality.
        by_path = {c["path"]: c for c in (new_candidates + conflicts)}
        already_paths = {c["path"] for c in already}
        # `offered` = the paths the wizard displayed. Present → we can distinguish
        # a candidate the wizard showed from one that only appeared post-migration.
        offered = plan.get("offered")
        offered_set: Optional[set] = (
            set(offered) if isinstance(offered, list) else None
        )
        errors: list[str] = []
        tolerated: list[str] = []

        def _resolve_plan_path(p: str, ctx: str) -> bool:
            """True if `p` is a live candidate to act on. Case (a): a plan path
            that flipped to ALREADY_MANAGED after migration is TOLERATED (warn +
            skip). Case (b): a path that is neither a candidate nor already-managed
            is a hard error (fail-closed)."""
            if p in by_path:
                return True
            if p in already_paths:
                tolerated.append(p)
                return False
            errors.append(f"unknown candidate path in {ctx}: {p}")
            return False

        register_ok = [p for p in plan["register"] if _resolve_plan_path(p, "register")]
        conflict_ok: dict = {}
        for p, action in plan["conflict_actions"].items():
            if action not in ("skip", "replace", "suffix"):
                errors.append(
                    f"unknown conflict action '{action}' for {p} "
                    f"(expected skip|replace|suffix)"
                )
                continue
            if _resolve_plan_path(p, "conflict_actions"):
                conflict_ok[p] = action
        adopt_ok = [p for p in plan["adopt"] if _resolve_plan_path(p, "adopt")]
        if errors:
            _fail_bootstrap("apply-plan rejected: " + "; ".join(errors))
            return
        if tolerated:
            print(
                f"{c('·', DIM)} skipping "
                f"{len(tolerated)} plan item(s) already managed after migration: "
                + ", ".join(tolerated)
            )
        selections = [by_path[p] for p in register_ok]
        actions = {by_path[p]["name"]: a for p, a in conflict_ok.items()}
        adopt_set = {by_path[p]["name"] for p in adopt_ok}

        # Case (c): candidates that appeared only AFTER migration (never shown to
        # the wizard) get the `--yes` defaults — NEW/BROKEN register, CONFLICT
        # skip. Only when `offered` was supplied (else we can't tell what the
        # wizard displayed, so we act strictly on the plan alone).
        if offered_set is not None:
            registered_paths = {c["path"] for c in selections}
            for p, cand in by_path.items():
                if p in offered_set or p in registered_paths:
                    continue
                if cand.get("category") in ("NEW", "BROKEN"):
                    selections.append(cand)
                # CONFLICT default is skip → leave it out.
    else:
        selections = new_candidates + conflicts
        actions = {c["name"]: "skip" for c in conflicts}
        adopt_set: set = set()

    # Apply imports
    with data_home_lock():
        registry_now = hub._read_registry_optional()
        result = hub.apply_import(
            registry_now, selections, conflict_actions=actions, adopt_set=adopt_set
        )
        if blocked:
            print(f"\n{c('Blocked candidates (invalid names):', YELLOW)}")
            for b in blocked:
                print(f"  · {b['path']} — {b.get('reason', '')}")
        registry_now.setdefault("bootstrap", {})
        registry_now["bootstrap"] = {
            "completed_at": _now_iso(),
            "version": 1,
        }
        # Write registry directly (we're holding the lock)
        reg_file = hub_core.registry_file()
        tmp = reg_file.with_suffix(".yaml.tmp")
        with open(tmp, "w") as f:
            yaml.dump(
                registry_now,
                f,
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
            )
        os.replace(tmp, reg_file)
        print(
            f"\n{c('✓', GREEN)} bootstrap complete — registered {len(result['registered'])}, "
            f"skipped {len(result['skipped'])}, blocked {len(blocked)}"
        )

    # Global permissions adoption (idempotent — only prompts when discovery finds
    # pre-existing rules AND permissions_global has no managed entries for that harness).
    # Bootstrap is an explicit setup operation, so it may coordinate one
    # fresh selection after discovering installed harnesses.  The resulting
    # context is passed unchanged to adoption and the nested sync.
    from skill_hub.application.harnesses.harness_operation_context import WORKFLOW_FEATURES, build_operation_context
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    installed = tuple(sorted(_harnesses.detect_installed()))
    operation_context = build_operation_context(
        hub_core.data_home(),
        installed,
        requested_features=WORKFLOW_FEATURES,
        needs_selection=True,
        force_refresh=True,
        installed_harness_ids=installed,
    )
    _provision_initial_setup(installed, fresh_registry=fresh_registry and not legacy_candidates)
    # Keep older embedders that replaced the no-argument adoption hook working;
    # production uses the context-aware signature above.
    import inspect

    if inspect.signature(_bootstrap_global_permissions_adopt).parameters:
        _bootstrap_global_permissions_adopt(operation_context)
    else:
        _bootstrap_global_permissions_adopt()

    # Sync — first-run wizard: run the FULL sync incl. remote dispatch (user asked for a
    # complete setup here), NOT the mutation-path _auto_sync() which skips remotes.
    class _A:
        _operation_context = operation_context

    hub.cmd_sync(_A())


def _bootstrap_global_permissions_adopt(operation_context=None) -> None:
    """Bootstrap-time global-scope adoption decision per installed harness.

    Idempotent: re-running with an already-populated `permissions_global` is a
    no-op. Prompts the user for `import | replace | skip` per harness whose
    global config has pre-existing permissions.
    """
    import hub
    from skill_hub.domain.permissions.permissions import GlobalScope
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    registry = hub_core.load_registry()
    global_block = registry.get("permissions_global") or {}
    if hub._has_any_managed_perms(global_block):
        return
    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses as _harnesses

        installed = _harnesses.detect_installed()
    else:
        installed = getattr(operation_context, "installed_harness_ids", ())
    print(f"\n{c('Global permissions adoption', BOLD)}")
    decided = False
    for h_id in sorted(installed):
        layout = (
            operation_context.layout(h_id) if operation_context is not None else None
        )
        if operation_context is not None:
            if layout is None:
                continue
            label = layout.label
        else:
            from skill_hub.infrastructure.harnesses import harnesses as _harnesses

            harness = _harnesses.HARNESSES.get(h_id)
            if harness is None or harness.permission_adapter_key is None:
                continue
            label = harness.label
        selection = pa.select_permission_adapter(operation_context, h_id)
        adapter = selection.adapter
        if adapter is None or getattr(selection.route, "status", "unavailable") == "unavailable":
            continue
        if hub._scope_managed_before(h_id, GlobalScope()):
            # Hub already manages this scope; an empty registry block is a
            # deliberate delete, not a cue to re-adopt native rules.
            continue
        discovered = adapter.discover_existing(GlobalScope(), h_id)
        if not hub._discovered_has_anything(discovered):
            continue
        decided = True
        if getattr(sys, "stdin", None) is None or not sys.stdin.isatty():
            print(
                f"  {c('·', DIM)} {label}: pre-existing permissions detected "
                f"(non-interactive — skipped; run `hub permissions adopt --global "
                f"--harness {h_id}` to resolve)"
            )
            continue
        choice = ""
        while choice not in {"i", "r", "s"}:
            choice = (
                input(
                    f"  {label}: pre-existing permissions found. "
                    f"[i]mport / [r]eplace / [s]kip? "
                )
                .strip()
                .lower()[:1]
            )
        action = {"i": "import", "r": "replace", "s": "skip"}[choice]

        class _N:
            pass

        ns = _N()
        ns.global_ = True
        ns.project = None
        ns.action = action
        ns.harness = h_id
        ns._operation_context = operation_context
        hub.cmd_permissions_adopt(ns)
    if not decided:
        print(f"  {c('·', DIM)} nothing to adopt")
