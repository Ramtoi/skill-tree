#!/usr/bin/env python3
"""
hub — central skill registry CLI
"""

import argparse
import base64
import json
import os
import re
import shutil
import sys
from pathlib import Path

# Vendored pure-Python dependencies (PyYAML, tomlkit) ship inside the app bundle
# under vendor/ next to this file (generated at build time from requirements.txt).
# Prepend it so `import yaml` resolves against the bundled copy regardless of what
# the host interpreter has installed — a clean install needs no pip. The guard
# below still reports cleanly if even the vendored copy is missing. See the
# `harden-onboarding` change.
_VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if _VENDOR_DIR.is_dir() and str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

try:
    import yaml  # noqa: F401  — the guard's job is the friendly error below; hub.py itself stopped reading yaml in wave 23d
except ImportError:
    print("Error: pyyaml not installed. Run: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__" and "hub" not in sys.modules:
    # Running as a script: alias ourselves so a later `import hub` from a
    # sibling module (backup.py, harness_probe.py, ...) returns THIS module
    # instead of loading a second copy — a second copy has its own
    # _LOCK_DEPTH=0, which defeats data_home_lock()'s re-entrancy guard and
    # self-deadlocks any @registry_mutation command whose sync tail re-takes
    # the lock (backup.py:_data_home_lock).
    sys.modules["hub"] = sys.modules[__name__]

# ─────────────────────────────────────────────────────────────────────────────
# The hub → hub_core facade (S5)
#
# `from skill_hub.hub_core import *` COPIES bindings, which is not enough on its own:
# tests rebind through THIS module (`hub._DATA_HOME_CACHE = None` in
# tests/conftest.py, ~30 `monkeypatch.setattr(hub, …)` targets) and read the
# mutable counters live (`hub._LOCK_DEPTH`). `_HubFacade` — installed as this
# module's class at the very bottom of the file — forwards those reads and
# writes to hub_core so both namespaces can never disagree.
# ─────────────────────────────────────────────────────────────────────────────

import sys as _sys  # noqa: E402  — alias only; plain `sys` is used ~200× below
import types as _types  # noqa: E402

from skill_hub import hub_core  # noqa: E402
from skill_hub.hub_core import *  # noqa: E402,F401,F403
from skill_hub.hub_core import _MUTABLE_STATE as _CORE_STATE  # noqa: E402

_CORE_FORWARD = frozenset(hub_core.__all__) | frozenset(_CORE_STATE)

from skill_hub.application.sync.sync_engine import (  # noqa: E402,F401
    _auto_sync,
    _auto_sync_tail,
    _cmd_sync_backup_tail,
    _cmd_sync_body,
    _new_backup_report_slot,
    _record_backup_block_error,
    _registry_fingerprint,
    _run_agent_docs_detection,
    _run_backup_pass,
    _run_project_skill_detection,
    _skill_affinity,
    _sync_global_skills,
    _sync_report_ok,
    cmd_sync,
    new_project_report,
    new_sync_report,
    resolve_project_skills,
    scan_project_skill_candidates,
    sync_report_path,
    write_sync_report,
)
from skill_hub.domain.skills.skill_meta import (  # noqa: E402,F401
    PROJECT_INVOCATION_MODES,
    RENAME_MARKER_COMMENT,
    RENAME_VARIANT_MODE,
    VALID_INVOCATIONS,
    VARIANT_MARKER_COMMENT,
    _validate_harness_affinity,
    hub_mcp_servers_dir,
    hub_skills_dir,
    invocation_from_frontmatter,
    parse_frontmatter_text,
    parse_skill_frontmatter,
    parse_skill_frontmatter_name,
    render_invocation_frontmatter,
    render_name_frontmatter,
    rewrite_frontmatter_name,
    skill_invocation,
    skill_rename_patch,
    skill_source,
    sync_skill_frontmatter_metadata,
    validate_registry_skills,
)

# ─────────────────────────────────────────────────────────────────────────────
# Self-version + release coordinates
#
# The single source of truth is the root VERSION file, shipped into code_home as
# hub/VERSION (see tauri.conf.json bundle.resources). `hub update` compares it
# against the latest GitHub Release on the public mirror.
# ─────────────────────────────────────────────────────────────────────────────

GITHUB_REPO = "Ramtoi/skill-tree"
GITHUB_API_LATEST = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
GITHUB_RELEASES_URL = f"https://github.com/{GITHUB_REPO}/releases"

# `hub_version()` + `FALLBACK_VERSION` live in hub_core (re-exported above):
# backup.py stamps every snapshot manifest with the version and must not import
# the CLI monolith to do it.


def _version_tuple(v: str) -> tuple:
    """Comparable (major, minor, patch) — pre-release/build suffixes ignored."""
    core = re.split(r"[-+]", v.strip().lstrip("v"), maxsplit=1)[0]
    parts = core.split(".")
    out = []
    for i in range(3):
        try:
            out.append(int(parts[i]))
        except (IndexError, ValueError):
            out.append(0)
    return tuple(out)


from skill_hub.application.skills.import_scanner import (  # noqa: E402,F401
    _empty_registry,
    _parse_skill_md,
    _read_registry_optional,
    apply_import,
    bootstrap_state,
    scan_import_candidates,
)
from skill_hub.application.sync.mcp_sync import (  # noqa: E402,F401
    _global_mcp_sidecar_path,
    _read_global_mcp_sidecar,
    _representative_harness,
    _run_global_mcp_dispatch,
    _spec_from_skill,
    _write_global_mcp_sidecar,
    project_has_mcp_target,
    sync_mcp_for_project,
)
from skill_hub.application.sync.remote_dispatch import (  # noqa: E402,F401
    _is_alarming_remote_failure,
    _remote_has_owned_artifacts,
    _run_remote_dispatch,
    build_remote_desired_state,
)
from skill_hub.infrastructure.filesystem.sync_links import (  # noqa: E402,F401
    HUB_LINKED_SUBTREES,
    _warn_links_left_in_place,
    backup_path_for,
    ensure_symlink,
    hub_owned_link_roots,
    is_hub_owned_link,
    link_target_abs,
    remove_symlink,
    remove_unmanaged_entries,
)
from skill_hub.infrastructure.registry.sources import (  # noqa: E402,F401
    _SOURCE_ENABLED_WARNED,
    BUILT_IN_SOURCE_IDS,
    SOURCE_STATUS_BUNDLED,
    SOURCE_STATUS_ERROR,
    SOURCE_STATUS_LOCAL,
    SOURCE_STATUS_SYNCING,
    SOURCE_STATUS_UNKNOWN,
    SOURCE_STATUS_UP_TO_DATE,
    SOURCE_STATUS_UPDATE_AVAILABLE,
    SOURCE_TYPES,
    VALID_SOURCE_STATUSES,
    builtin_source_entries,
    disabled_source_ids,
    imported_skills_for_source,
    infer_skill_ownership,
    linked_bundle_names,
    list_sources,
    normalize_subpath_within,
    reconcile_bundle_membership,
    reconcile_linked_bundles,
    skills_from_disabled_sources,
    source_cache_dir,
    source_enabled,
    source_include_names,
    source_owned_skill_names,
    source_worktree_dir,
    sources_dir,
    validate_source_id,
    validate_sources_registry,
)


def _confirm(prompt: str) -> bool:
    try:
        response = input(f"{prompt} [y/N] ").strip().lower()
    except EOFError:
        return False
    return response == "y"


from skill_hub.application.skills.skill_variants import (  # noqa: E402,F401
    _apply_invocation_override,
    _cleanup_variant_orphans,
    _demanded_variant_names,
    _sync_project_skills,
    _variant_dir_name,
    _write_skill_variant,
    effective_skill_source,
    ensure_skill_variant,
    project_sync_skip_reason,
    skill_variants_root,
)
from skill_hub.application.sync.hooks_stream import (  # noqa: E402,F401
    _run_doctor_rollup,
    _run_hooks_stream,
    _scope_from_slug,
    _SlugScope,
    migrate_permissions_hook_sidecars,
)
from skill_hub.application.sync.permissions_stream import (  # noqa: E402,F401
    _canonicalize_permissions_block,
    _dedupe_registry_permissions,
    _discovered_has_anything,
    _has_any_managed_perms,
    _permissions_duplicate_count,
    _run_permissions_stream,
    _scope_managed_before,
    _serialize_perms_block,
    _unmanaged_list,
)

# ─────────────────────────────────────────────────────────────────────────────
# hub skill export / import — the portable `.skillpack` format (v1)
#
# A skillpack is a SINGLE JSON envelope (not a tarball) so a recipient can read
# every byte before it lands on disk: the app previews name/version/description
# and the full file list before the user confirms. Text files ride as `utf8`,
# anything undecodable as `base64`; the file list is sorted so the same skill
# always produces the same bytes.
#
# v1 refuses `type: mcp-server` in BOTH directions — an MCP entry's runtime
# block (`command`/`args`/`env`) lives in the registry, and `env` can hold
# secrets. Sharing one safely needs a redaction story we deliberately defer.
# ─────────────────────────────────────────────────────────────────────────────

def _skillpack_ignored(rel_parts: tuple) -> bool:
    """True when any path segment is machine noise we never ship."""
    for part in rel_parts:
        if part == ".DS_Store" or part == "__pycache__" or part.startswith(".hub-bak"):
            return True
    return False


def _resolves_inside(path: Path, root_real: str) -> bool:
    """True when `path` really lives under `root_real` (symlinks resolved)."""
    real = os.path.realpath(path)
    return real == root_real or real.startswith(root_real.rstrip(os.sep) + os.sep)


def _pack_exec_eligible(rel_posix: str) -> bool:
    """True when a pack relpath may carry the executable bit — `scripts/` only.

    Confines both the emit and apply side; the leaf-side twin is
    `connectors/layouts/agentskills.py::_exec_eligible` (a leaf may not import
    `hub`), same rule, pinned by a shared test corpus.
    """
    return rel_posix.startswith("scripts/")


def collect_skill_pack_files(root: Path) -> list[dict]:
    """Walk a skill dir into sorted, deterministic pack file entries.

    Symlinks are exported BY CONTENT (so a pack is self-contained) ONLY when they
    resolve back inside the skill dir. A link pointing OUTSIDE the skill —
    `notes.txt -> ~/.ssh/id_rsa` — is skipped with a warning: a pack is meant to
    be handed to someone else, and `is_file()` following the link would otherwise
    embed those bytes in it. Broken links and directories are skipped too.

    An entry gains `"executable": True` only when `_pack_exec_eligible` AND the
    owner-execute bit is set — additive-only, so a skill with no executable
    file produces the exact same envelope as before this field existed.
    """
    root_real = os.path.realpath(root)
    entries: list[dict] = []
    for path in root.rglob("*"):
        if path.is_dir() or not path.is_file():
            continue
        rel = path.relative_to(root)
        if _skillpack_ignored(rel.parts):
            continue
        if path.is_symlink() and not _resolves_inside(path, root_real):
            print(
                f"  {c('!', YELLOW)} skipping '{rel.as_posix()}': symlink resolves "
                f"outside the skill dir ({os.path.realpath(path)})",
                file=sys.stderr,
            )
            continue
        rel_posix = rel.as_posix()
        data = path.read_bytes()
        try:
            entry = {"path": rel_posix, "encoding": "utf8", "content": data.decode("utf-8")}
        except UnicodeDecodeError:
            entry = {
                "path": rel_posix,
                "encoding": "base64",
                "content": base64.b64encode(data).decode("ascii"),
            }
        if _pack_exec_eligible(rel_posix) and path.stat().st_mode & 0o100:
            entry["executable"] = True
        entries.append(entry)
    entries.sort(key=lambda e: e["path"])
    return entries


def decode_skill_pack_entry(entry: dict) -> bytes:
    """Decode one pack file entry to bytes. Raises ValueError when malformed."""
    encoding = entry.get("encoding")
    content = entry.get("content")
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    if encoding == "utf8":
        return content.encode("utf-8")
    if encoding == "base64":
        try:
            return base64.b64decode(content, validate=True)
        except Exception as exc:
            raise ValueError(f"undecodable base64 content ({exc})") from exc
    raise ValueError(f"unknown encoding {encoding!r} (expected utf8 or base64)")


def pack_entry_is_executable(entry: dict) -> bool:
    """True only for an exact boolean `executable: true` on a `scripts/` relpath.

    The single read-side predicate — validate and import both call this, so
    they can never disagree about confinement. Anything but the literal
    `True` is fail-closed to "not executable".
    """
    return entry.get("executable") is True and _pack_exec_eligible(entry.get("path") or "")


# ─────────────────────────────────────────────────────────────────────────────
# hub migrate
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("migrate")
def cmd_migrate(args):
    registry = load_registry()
    skills = registry.get("skills", {})
    name = args.skill

    if name not in skills:
        print(f"Unknown skill '{name}'.")
        sys.exit(1)

    cfg = skills[name]
    current_src = skill_source(cfg)
    hub_target = hub_skills_dir() / name

    if hub_target.exists() or hub_target.is_symlink():
        print(f"Already at hub location: {hub_target}")
        return

    if not current_src.exists():
        print(f"Source not found: {current_src}")
        sys.exit(1)

    # Copy to data home
    shutil.copytree(current_src, hub_target, symlinks=True)
    new_source = collapse_home(hub_target)
    skills[name]["source"] = new_source
    save_registry(registry)
    print(f"{c('✓', GREEN)} migrated '{name}' to hub")
    print(f"  source updated → {new_source}")
    print(f"  original still at {current_src} (delete manually if satisfied)")
    print("  run 'hub sync' to rebuild symlinks")


# ─────────────────────────────────────────────────────────────────────────────
# hub skill metadata
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# hub cleanup-backups
# ─────────────────────────────────────────────────────────────────────────────


def cmd_cleanup_backups(_args):
    backup_dirs = [
        Path.home() / ".claude" / "_hub-backups",
        PI_AGENT_DIR / "_hub-backups",
    ]

    removed = 0
    for backup_dir in backup_dirs:
        if not backup_dir.exists():
            continue
        for path in sorted(backup_dir.rglob("*"), reverse=True):
            if path.is_file() or path.is_symlink():
                path.unlink()
                removed += 1
            elif path.is_dir():
                try:
                    path.rmdir()
                except OSError:
                    pass
        try:
            backup_dir.rmdir()
        except OSError:
            pass

    print(f"{c('✓', GREEN)} removed {removed} backup artifact(s)")


# ─────────────────────────────────────────────────────────────────────────────
# hub version
# ─────────────────────────────────────────────────────────────────────────────


def cmd_selfcheck(args):
    """Registry-free runtime self-check used by the app's preflight.

    Reaching this function proves `hub.py` loaded and its load-time dependency
    (`yaml`, via the vendor shim) imported successfully — without touching
    `data_home()` or the registry, since the preflight runs *before* bootstrap.
    Optional/lazy dependencies (`tomlkit`, used only for Codex sync) are reported
    as non-fatal warnings, never failures, so a Codex-only gap can't block
    onboarding. Always exits 0 when the onboarding-critical chain is intact;
    any hard failure (missing vendor, syntax error, broken interpreter) surfaces
    as a non-zero exit with a real traceback for the preflight to relay.
    """
    warnings: list[str] = []
    try:
        import tomlkit  # noqa: F401
    except ImportError:
        warnings.append(
            "tomlkit unavailable — Codex MCP/permission sync will be degraded"
        )

    payload = {
        "ok": True,
        "python": (
            f"{sys.version_info.major}."
            f"{sys.version_info.minor}."
            f"{sys.version_info.micro}"
        ),
        "vendor_dir": str(_VENDOR_DIR) if _VENDOR_DIR.is_dir() else None,
        "warnings": warnings,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload))
    else:
        vendor = "yes" if payload["vendor_dir"] else "no"
        print(f"ok  python={payload['python']}  vendor={vendor}")
        for w in warnings:
            print(f"warning: {w}")


def cmd_version(_args):
    registry = load_registry()
    skills = registry.get("skills", {})
    print(f"\n{c('Skill Hub v' + hub_version(), BOLD)}")
    print(f"Data home: {data_home()}")
    print(f"Code home: {code_home()}")
    print(f"Registry:  {registry_file()}")
    print(f"Skills: {len(skills)} registered")
    global_count = sum(1 for s in skills.values() if s.get("scope") == "global")
    portable_count = sum(1 for s in skills.values() if s.get("scope") == "portable")
    ps_count = sum(1 for s in skills.values() if s.get("scope") == "project-specific")
    mcp_count = sum(1 for s in skills.values() if s.get("type") == "mcp-server")
    print(
        f"  {global_count} global, {portable_count} portable, {ps_count} project-specific, {mcp_count} MCP servers"
    )
    print()


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        prog="hub",
        description="Skill Hub — central skill registry and project linker",
    )
    sub = parser.add_subparsers(dest="command")

    # list
    p_list = sub.add_parser("list", help="List all skills and their status")
    p_list.add_argument("--project", "-p", help="Filter by project name")

    # enable
    p_enable = sub.add_parser("enable", help="Enable a skill for a project")
    p_enable.add_argument("skill", help="Skill name")
    p_enable.add_argument(
        "--project", "-p", help="Project name (required for non-global skills)"
    )
    p_enable.add_argument(
        "--with-refs",
        action="store_true",
        help="Also equip the skills this skill's body references (one level)",
    )
    p_enable_companions = p_enable.add_mutually_exclusive_group()
    p_enable_companions.add_argument(
        "--with-companions",
        action="store_true",
        help="Also provision this skill's ships_with agents/hooks/permission rules",
    )
    p_enable_companions.add_argument(
        "--skill-only",
        action="store_true",
        help="Equip the skill only — never provision its ships_with companions",
    )
    p_enable.add_argument("--json", action="store_true", help="Emit JSON")

    # disable
    p_disable = sub.add_parser("disable", help="Disable a skill for a project")
    p_disable.add_argument("skill", help="Skill name")
    p_disable.add_argument("--project", "-p", help="Project name")
    p_disable.add_argument(
        "--global",
        dest="global_",
        action="store_true",
        help="Remove a `scope: global` skill's companions_global ledger instead of a project's (R6)",
    )
    p_disable.add_argument(
        "--keep-companions",
        action="store_true",
        help="Leave this skill's provisioned ships_with companions in place",
    )
    p_disable.add_argument("--json", action="store_true", help="Emit JSON")

    # sync
    p_sync = sub.add_parser(
        "sync", help="Rebuild all symlinks and MCP configs from registry"
    )
    p_sync.add_argument(
        "--skip-permissions",
        action="store_true",
        help="Bypass the permissions stream (the doctor still covers hooks)",
    )
    p_sync.add_argument(
        "--skip-hooks",
        action="store_true",
        help="Bypass the hooks stream (the doctor still covers permissions)",
    )
    p_sync.add_argument(
        "--skip-remotes",
        action="store_true",
        help="Bypass the remote connector dispatch pass",
    )
    p_sync.add_argument(
        "--skip-backup",
        action="store_true",
        help="Bypass the backup tail pass (it is fail-open anyway)",
    )
    p_sync.add_argument(
        "--strict-remotes",
        action="store_true",
        help="Exit non-zero on an ALARMING remote failure (auth / host-key mismatch "
        "/ integrity); unreachable remotes stay quiet (L1, mirrors the perms doctor)",
    )

    # new
    p_new = sub.add_parser("new", help="Scaffold a new skill or MCP server")
    p_new.add_argument("kind", choices=["skill", "mcp"], help="Type to create")
    p_new.add_argument("name", help="Name for the new skill/mcp")
    p_new.add_argument("--scope", choices=sorted(VALID_SCOPES), help="Initial scope")
    p_new.add_argument("--description", help="Initial description")
    p_new.add_argument(
        "--type",
        choices=["claude-skill", "mcp-server"],
        help="Accepted for UI compatibility; inferred from kind",
    )

    # migrate
    p_migrate = sub.add_parser(
        "migrate", help="Move an existing skill into the hub's skills/ dir"
    )
    p_migrate.add_argument("skill", help="Skill name to migrate")

    # project
    skill_hub.entrypoints.cli.project.register(sub)

    # agent-docs (top-level): canonical root strategy + migration
    skill_hub.entrypoints.cli.agent_docs.register(sub)

    # snippet: reusable agent-doc instruction blocks
    skill_hub.entrypoints.cli.snippet.register(sub)

    skill_hub.entrypoints.cli.skill.register(sub)

    p_set_meta = sub.add_parser("set-meta", help="Update skill metadata in registry")
    skill_hub.entrypoints.cli.skill.register_set_meta_arguments(p_set_meta)

    # archive
    skill_hub.entrypoints.cli.archive.register(sub)

    # unarchive
    p_unarchive = sub.add_parser(
        "unarchive",
        help="Undo `hub archive`: restore the dir + registry entry + references",
    )
    p_unarchive.add_argument("skills", nargs="+", help="Skill name(s) to restore")
    p_unarchive.add_argument("--json", action="store_true", help="Emit JSON")

    # rename
    p_rename = sub.add_parser(
        "rename", help="Rename a skill (updates registry, files, symlinks)"
    )
    p_rename.add_argument("old_name", help="Current skill name")
    p_rename.add_argument("new_name", help="New skill name")
    p_rename.add_argument(
        "--dry-run", action="store_true", help="Print the plan without applying"
    )
    p_rename.add_argument("--json", action="store_true", help="Emit JSON")
    p_rename.add_argument("--rewrite-refs", action="store_true", help="Rewrite mentions in other skills + snippets")
    p_rename.add_argument("--rewrite-agent-docs", action="store_true", help="Rewrite agent docs (needs --rewrite-refs)")

    skill_hub.entrypoints.cli.bundle.register(sub)

    # dashboard
    p_dash = sub.add_parser("dashboard", help="Launch Skill Tree native app")
    p_dash.add_argument(
        "--dev", action="store_true", help="Launch in Vite HMR dev mode"
    )

    # app
    skill_hub.entrypoints.cli.app.register(sub)

    # update
    skill_hub.entrypoints.cli.update.register(sub)

    # cleanup-backups
    sub.add_parser(
        "cleanup-backups",
        help="Delete hub-created backup artifacts outside managed skill dirs",
    )

    skill_hub.entrypoints.cli.bootstrap.register(sub)

    # restore
    skill_hub.entrypoints.cli.restore.register(sub)

    # recovery — resumable post-restore attach/source-recovery/local-sync journey
    skill_hub.entrypoints.cli.recovery.register(sub)

    # migrate-home
    p_mh = sub.add_parser(
        "migrate-home", help="Move data from legacy ~/Dev/.skill-hub/ to ~/.skill-hub/"
    )
    p_mh.add_argument("--yes", action="store_true", help="Skip confirmation prompt")

    # harnesses (Rust-mirror emission + future read commands)
    p_harn = sub.add_parser(
        "harnesses",
        help="Inspect the harness registry (claude-code, codex, pi, opencode)",
    )
    harn_sub = p_harn.add_subparsers(dest="harnesses_cmd")
    harn_sub.add_parser(
        "emit-schema",
        help="Print the harness registry as JSON (consumed by app build.rs)",
    )

    # `hub harness ...` — top-level alias for the CLI surface in the spec
    skill_hub.entrypoints.cli.harness.register(sub)

    # subagent — manage sub-agents in place (claude-subagents-manager +
    # cross-harness-subagents: claude-code .md and codex .toml)
    skill_hub.entrypoints.cli.subagent.register(sub)

    # usage — durable per-day usage-history ledger (record/history/import-claude-stats)
    skill_hub.entrypoints.cli.usage.register(sub)

    # remote — manage remote connector targets (Hermes, etc.)
    skill_hub.entrypoints.cli.cloud.register(sub)
    skill_hub.entrypoints.cli.remote.register(sub)
    skill_hub.entrypoints.cli.receive.register(sub)

    # permissions
    skill_hub.entrypoints.cli.permissions.register(sub)

    skill_hub.entrypoints.cli.integration.register(sub)

    skill_hub.entrypoints.cli.source.register(sub)
    # version
    sub.add_parser("version", help="Show hub version and stats")

    # selfcheck — registry-free runtime probe consumed by the app's preflight
    p_selfcheck = sub.add_parser(
        "selfcheck",
        help="Registry-free runtime self-check (used by the Skill Tree app preflight)",
    )
    p_selfcheck.add_argument("--json", action="store_true", help="Emit JSON")

    # mcp-control — register/unregister the control-plane MCP server
    skill_hub.entrypoints.cli.mcp_control.register(sub)
    skill_hub.entrypoints.cli.mcp.register(sub)

    skill_hub.entrypoints.cli.hook.register(sub)
    # backup
    skill_hub.entrypoints.cli.backup.register(sub)

    args = parser.parse_args()

    dispatch = {
        "list": cmd_list,
        "enable": cmd_enable,
        "disable": cmd_disable,
        "sync": cmd_sync,
        "new": cmd_new,
        "migrate": cmd_migrate,
        "set-meta": cmd_set_meta,
        "unarchive": cmd_unarchive,
        "rename": cmd_rename,
        "dashboard": cmd_dashboard,
        "app-dev": cmd_app_dev,
        "app-build": cmd_app_build,
        "cleanup-backups": cmd_cleanup_backups,
        "version": cmd_version,
        "selfcheck": cmd_selfcheck,
        "migrate-home": cmd_migrate_home,
    }

    for _mod in (
        skill_hub.entrypoints.cli.agent_docs,
        skill_hub.entrypoints.cli.app,
        skill_hub.entrypoints.cli.archive,
        skill_hub.entrypoints.cli.backup,
        skill_hub.entrypoints.cli.bootstrap,
        skill_hub.entrypoints.cli.bundle,
        skill_hub.entrypoints.cli.cloud,
        skill_hub.entrypoints.cli.harness,
        skill_hub.entrypoints.cli.hook,
        skill_hub.entrypoints.cli.integration,
        skill_hub.entrypoints.cli.mcp,
        skill_hub.entrypoints.cli.mcp_control,
        skill_hub.entrypoints.cli.permissions,
        skill_hub.entrypoints.cli.project,
        skill_hub.entrypoints.cli.remote,
        skill_hub.entrypoints.cli.receive,
        skill_hub.entrypoints.cli.recovery,
        skill_hub.entrypoints.cli.restore,
        skill_hub.entrypoints.cli.skill,
        skill_hub.entrypoints.cli.snippet,
        skill_hub.entrypoints.cli.source,
        skill_hub.entrypoints.cli.subagent,
        skill_hub.entrypoints.cli.update,
        skill_hub.entrypoints.cli.usage,
    ):
        if args.command == _mod.NAME:
            result = _mod.dispatch(args)
            return result if isinstance(result, int) else None

    if args.command == "harnesses":
        if args.harnesses_cmd == "emit-schema":
            cmd_harnesses_emit_schema(args)
        else:
            p_harn.print_help()
    elif args.command in dispatch:
        dispatch[args.command](args)
    else:
        parser.print_help()


import skill_hub.entrypoints.cli.agent_docs
import skill_hub.entrypoints.cli.app
import skill_hub.entrypoints.cli.archive
import skill_hub.entrypoints.cli.backup
import skill_hub.entrypoints.cli.bootstrap
import skill_hub.entrypoints.cli.bundle
import skill_hub.entrypoints.cli.cloud
import skill_hub.entrypoints.cli.companions
import skill_hub.entrypoints.cli.harness
import skill_hub.entrypoints.cli.hook
import skill_hub.entrypoints.cli.integration
import skill_hub.entrypoints.cli.mcp
import skill_hub.entrypoints.cli.mcp_control
import skill_hub.entrypoints.cli.permissions
import skill_hub.entrypoints.cli.project
import skill_hub.entrypoints.cli.receive
import skill_hub.entrypoints.cli.recovery
import skill_hub.entrypoints.cli.remote
import skill_hub.entrypoints.cli.restore
import skill_hub.entrypoints.cli.skill
import skill_hub.entrypoints.cli.snippet
import skill_hub.entrypoints.cli.source  # noqa: E402
import skill_hub.entrypoints.cli.subagent
import skill_hub.entrypoints.cli.update
import skill_hub.entrypoints.cli.usage  # noqa: E402
from skill_hub.entrypoints.cli.agent_docs import (  # noqa: F401
    _resolve_project_target,
    cmd_agent_docs_fix,
    cmd_agent_docs_resolve,
    cmd_agent_docs_status,
    cmd_agent_docs_strategy,
)
from skill_hub.entrypoints.cli.app import (  # noqa: F401
    cmd_app_build,
    cmd_app_dev,
    cmd_dashboard,
)
from skill_hub.entrypoints.cli.archive import (  # noqa: F401
    _BUNDLE_REFERENCE_SITE_LABELS,
    _REFERENCE_SITE_LABELS,
    _cloud_targets_equipping,
    _prune_bundle_references,
    _prune_cloud_equip,
    _prune_skill_references,
    _skill_reference_sites,
    cmd_archive,
    cmd_unarchive,
)
from skill_hub.entrypoints.cli.backup import (  # noqa: F401
    cmd_backup_acknowledge_restore,
    cmd_backup_auth,
    cmd_backup_disable,
    cmd_backup_enable,
    cmd_backup_init,
    cmd_backup_now,
    cmd_backup_status,
)
from skill_hub.entrypoints.cli.bootstrap import (  # noqa: F401
    cmd_bootstrap,
    cmd_migrate_home,
)
from skill_hub.entrypoints.cli.bundle import (  # noqa: F401
    cmd_bundle,
    cmd_bundle_apply,
    cmd_bundle_delete,
    cmd_bundle_list,
    cmd_bundle_new,
    cmd_bundle_remove,
    cmd_bundle_rename,
    cmd_bundle_update,
)
from skill_hub.entrypoints.cli.cloud import (  # noqa: F401
    cmd_cloud_equip,
    cmd_cloud_export,
    cmd_cloud_status,
    cmd_cloud_targets,
)
from skill_hub.entrypoints.cli.harness import (  # noqa: F401
    cmd_harness_disable,
    cmd_harness_doc_link,
    cmd_harness_doc_status,
    cmd_harness_doc_unlink,
    cmd_harness_enable,
    cmd_harness_list,
    cmd_harnesses_emit_schema,
)
from skill_hub.entrypoints.cli.hook import (  # noqa: F401
    cmd_hook_attach,
    cmd_hook_delete,
    cmd_hook_detach,
    cmd_hook_doctor,
    cmd_hook_edit,
    cmd_hook_list,
    cmd_hook_new,
    cmd_hook_script_save,
    cmd_hook_script_show,
    cmd_hook_set_settings,
    cmd_hook_show,
)
from skill_hub.entrypoints.cli.mcp_control import (  # noqa: F401
    MCP_CONTROL_SKILL_NAME,
    cmd_mcp_control,
    cmd_mcp_control_install,
    cmd_mcp_control_status,
    cmd_mcp_control_uninstall,
)
from skill_hub.entrypoints.cli.permissions import (  # noqa: F401
    _project_files_have_global_duplicates,
    cmd_permissions_add,
    cmd_permissions_adopt,
    cmd_permissions_capabilities,
    cmd_permissions_disable,
    cmd_permissions_doctor,
    cmd_permissions_hooks_add,
    cmd_permissions_hooks_remove,
    cmd_permissions_import,
    cmd_permissions_list,
    cmd_permissions_migrate_scope,
    cmd_permissions_presets_apply,
    cmd_permissions_presets_delete,
    cmd_permissions_presets_list,
    cmd_permissions_presets_new,
    cmd_permissions_presets_show,
    cmd_permissions_presets_update,
    cmd_permissions_reconcile,
    cmd_permissions_remove,
    cmd_permissions_set,
    cmd_permissions_show,
    cmd_permissions_validate,
)
from skill_hub.entrypoints.cli.project import (  # noqa: F401
    clean_project_artifacts,
    cmd_project_add,
    cmd_project_agent_docs,
    cmd_project_edit_path,
    cmd_project_harnesses,
    cmd_project_import_skill,
    cmd_project_invocation,
    cmd_project_remove,
    cmd_project_rename,
    cmd_project_repository,
    cmd_project_scan_skills,
)
from skill_hub.entrypoints.cli.remote import (  # noqa: F401
    _resolve_revoke_plan,
    cmd_remote_add,
    cmd_remote_clear,
    cmd_remote_connectors,
    cmd_remote_diff,
    cmd_remote_disable,
    cmd_remote_doctor,
    cmd_remote_enable,
    cmd_remote_equip,
    cmd_remote_fetch_doc,
    cmd_remote_health,
    cmd_remote_import_skill,
    cmd_remote_keyscan,
    cmd_remote_list,
    cmd_remote_list_docs,
    cmd_remote_pin,
    cmd_remote_probe,
    cmd_remote_push_doc,
    cmd_remote_remove,
    cmd_remote_repin,
    cmd_remote_resolve,
    cmd_remote_revoke_key,
    cmd_remote_rotate_token,
    cmd_remote_set_global,
    cmd_remote_setup_codex_helper,
    cmd_remote_setup_helper,
    cmd_remote_setup_key,
    cmd_remote_show,
    cmd_remote_signing_key,
    cmd_remote_sync,
    pinned_signing_pubkey,
)
from skill_hub.entrypoints.cli.restore import (  # noqa: F401
    _print_restore_plan,
    cmd_restore,
    cmd_source_restore,
    restore_mod,
)
from skill_hub.entrypoints.cli.skill import (  # noqa: F401
    _missing_refs_hint_for,
    _print_missing_refs_hint,
    apply_skill_rename_to_pack_files,
    build_skill_pack,
    cmd_disable,
    cmd_enable,
    cmd_list,
    cmd_new,
    cmd_rename,
    cmd_set_meta,
    cmd_skill_export,
    cmd_skill_import,
    cmd_skill_refs,
    validate_skill_pack,
)
from skill_hub.entrypoints.cli.snippet import (  # noqa: F401
    cmd_snippet_apply,
    cmd_snippet_delete,
    cmd_snippet_edit,
    cmd_snippet_list,
    cmd_snippet_new,
    cmd_snippet_reconcile,
    cmd_snippet_reconcile_content,
    cmd_snippet_remove,
    cmd_snippet_rename,
    cmd_snippet_show,
    cmd_snippet_status,
    cmd_snippet_update,
)
from skill_hub.entrypoints.cli.source import (  # noqa: F401
    # Discovery/conflict-decision helpers exercised directly by
    # tests/test_source_add.py, which historically called them as
    # `hub.<name>` unit-under-test rather than through the CLI.
    MAX_SCAN_DEPTH,
    _do_source_add_clone_and_report,
    _scan_base_hint,
    classify_candidates,
    cmd_source_add_git,
    cmd_source_check,
    cmd_source_disable,
    cmd_source_duplicate,
    cmd_source_edit,
    cmd_source_enable,
    cmd_source_list,
    cmd_source_remove,
    cmd_source_status,
    cmd_source_sync,
    derive_source_id_from_url,
    discover_candidates,
    normalize_scanned_path,
    parse_git_url,
    resolve_source_scan_path,
)
from skill_hub.entrypoints.cli.subagent import (  # noqa: F401
    _provision_skill,
    cmd_subagent_attachable_skills,
    cmd_subagent_delete,
    cmd_subagent_link,
    cmd_subagent_link_status,
    cmd_subagent_list,
    cmd_subagent_provision_skill,
    cmd_subagent_resolve_drift,
    cmd_subagent_save,
    cmd_subagent_set_disabled,
    cmd_subagent_show,
    cmd_subagent_skill_usage,
    cmd_subagent_unlink,
)
from skill_hub.entrypoints.cli.update import (  # noqa: F401
    _cmd_update_self,
    _code_home_kind,
    _safe_extract,
    cmd_update,
)


class _HubFacade(_types.ModuleType):
    """Keep `hub.<core name>` and `hub_core.<core name>` the SAME binding.

    `from skill_hub.hub_core import *` only COPIES bindings. Tests rebind through this
    module (`hub._DATA_HOME_CACHE = None` in tests/conftest.py, ~30 distinct
    `monkeypatch.setattr(hub, …)` targets) and read the mutable counters live
    (`hub._LOCK_DEPTH` in tests/test_agent_tooling_layer0.py). Without this
    class a rebind would leave hub_core's own global untouched — `data_home()`
    would keep the stale cache and a test would write to the REAL ~/.skill-hub,
    where a sweep can unlink the developer's live `~/.claude/skills` symlinks.

    Three rules make it work:

    1. The four `_CORE_STATE` names must NEVER appear in `hub.__dict__` — hence
       their exclusion from `hub_core.__all__`, and the `__setattr__` branch
       that skips `super().__setattr__()` for them. A module `__getattr__` only
       fires on a MISS; a copied binding would shadow it and freeze
       `_LOCK_DEPTH` at whatever it held at import time.
    2. Everything else IS in `hub.__dict__` — functions defined in this file
       resolve their globals through the module dict, which `__getattr__` does
       NOT service — and a write forwards to BOTH namespaces.
    3. The class swap happens LAST, so this module's own top-level assignments
       during import are never forwarded into hub_core.
    """

    def __getattr__(self, name):  # only fires for names absent from hub.__dict__
        if name in _CORE_STATE:
            return getattr(hub_core, name)
        raise AttributeError(f"module 'hub' has no attribute {name!r}")

    def __setattr__(self, name, value):
        if name in _CORE_FORWARD:
            setattr(hub_core, name, value)
        if name not in _CORE_STATE:
            super().__setattr__(name, value)


# Script mode aliases this module into sys.modules["hub"] (top of the file), so
# the swap covers both names — it is the same object.
_sys.modules[__name__].__class__ = _HubFacade


if __name__ == "__main__":
    raise SystemExit(main())
