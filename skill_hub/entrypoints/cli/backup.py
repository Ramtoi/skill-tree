"""`hub backup` — git-snapshot sync backend.

The heavy lifting (manifests, snapshot assembly, path transform, git ops, auth
ladder) lives in backup.py; these are thin CLI marshals plus the `hub sync`
tail pass. See openspec/changes/backup-and-restore/design.md.

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    YELLOW,
    c,
    collapse_home,
    parse_csv,
    registry_mutation,
)

NAME = "backup"

p_backup = None


def _operation_context(args):
    """Use one supplied snapshot or build the cache-only backup snapshot."""
    context = getattr(args, "_operation_context", None)
    if context is not None:
        return context
    from skill_hub.application.harnesses.harness_operation_context import KNOWN_HARNESSES, build_operation_context

    context = build_operation_context(
        hub_core.data_home(),
        KNOWN_HARNESSES,
        requested_features=("backup",),
        needs_selection=False,
    )
    try:
        args._operation_context = context
    except AttributeError:
        pass
    return context


def register(sub) -> None:
    global p_backup

    p_backup = sub.add_parser(
        "backup", help="Snapshot Skill Tree state into a private git backup repo"
    )
    backup_sub = p_backup.add_subparsers(dest="backup_cmd")

    p_backup_init = backup_sub.add_parser(
        "init", help="Create/wire the local backup repo and record the backup: block"
    )
    g_backup_target = p_backup_init.add_mutually_exclusive_group()
    g_backup_target.add_argument("--repo", help="GitHub repo as owner/name")
    g_backup_target.add_argument("--remote", help="Explicit git remote URL")
    p_backup_init.add_argument(
        "--create",
        action="store_true",
        help="Create the PRIVATE GitHub repo first (needs an authenticated `gh` — "
        "fine-grained PATs cannot create repos)",
    )
    p_backup_init.add_argument(
        "--dir", help="Backup repo location (default ~/.skill-tree-backup)"
    )
    p_backup_init.add_argument("--json", action="store_true", help="Emit JSON")

    p_backup_now = backup_sub.add_parser("now", help="Snapshot, commit, and push now")
    p_backup_now.add_argument(
        "--no-push", dest="no_push", action="store_true", help="Commit locally, do not push"
    )
    p_backup_now.add_argument(
        "--allow-secret",
        dest="allow_secret",
        help="Comma-separated finding sha256s to acknowledge (printed by a refused commit)",
    )
    p_backup_now.add_argument(
        "--acknowledge-restore",
        dest="acknowledge_restore",
        action="store_true",
        help="Clear backup.pending_reconcile — the post-restore push hold. Say this "
        "only after reviewing the restored state.",
    )
    p_backup_now.add_argument("--json", action="store_true", help="Emit JSON")

    p_backup_status = backup_sub.add_parser("status", help="Backup repo status + drift")
    p_backup_status.add_argument("--json", action="store_true", help="Emit JSON")

    p_backup_auth = backup_sub.add_parser("auth", help="Show/modify the credential ladder")
    p_backup_auth.add_argument(
        "--login-pat",
        dest="login_pat",
        action="store_true",
        help="Read a GitHub PAT from STDIN and store it in the OS keychain "
        "(stdin only — deliberately never an argv flag)",
    )
    p_backup_auth.add_argument(
        "--logout", action="store_true", help="Delete the stored PAT from the OS keychain"
    )
    p_backup_auth.add_argument("--json", action="store_true", help="Emit JSON")

    p_backup_enable = backup_sub.add_parser("enable", help="Set backup.enabled = true")
    p_backup_enable.add_argument("--json", action="store_true", help="Emit JSON")
    p_backup_disable = backup_sub.add_parser("disable", help="Set backup.enabled = false")
    p_backup_disable.add_argument("--json", action="store_true", help="Emit JSON")


def dispatch(args) -> None:
    bk = getattr(args, "backup_cmd", None)
    if bk == "init":
        cmd_backup_init(args)
    elif bk == "now":
        cmd_backup_now(args)
    elif bk == "status":
        cmd_backup_status(args)
    elif bk == "auth":
        cmd_backup_auth(args)
    elif bk == "enable":
        cmd_backup_enable(args)
    elif bk == "disable":
        cmd_backup_disable(args)
    else:
        p_backup.print_help()




def _backup_fail(message: str, json_out: bool, **extra):
    """Uniform error exit for the backup verbs (JSON-aware)."""
    if json_out:
        payload = {"ok": False, "error": message}
        payload.update(extra)
        print(json.dumps(payload, indent=2))
    else:
        print(f"  {c('!', RED)} {message}")
    sys.exit(1)


@registry_mutation("backup-init")
def cmd_backup_init(args):
    """`hub backup init [--repo owner/name | --remote URL] [--create] [--dir PATH]`.

    Creates/wires the local backup repo and records the `backup:` block. The
    remote URL form follows the resolved PUSH rung (ssh remote for an ssh
    credential, https otherwise), so the first push works without the user
    picking a transport. `--create` uses `gh` only — a fine-grained PAT scoped to
    one repo cannot create repositories, and account-wide admin is too much to
    ask for a backup.
    """
    from skill_hub.application.backup import backup as _backup

    json_out = bool(getattr(args, "json", False))
    repo = getattr(args, "repo", None)
    remote = getattr(args, "remote", None)
    if repo and remote:
        _backup_fail("--repo and --remote are mutually exclusive", json_out)

    registry = hub_core.load_registry()
    cfg = _backup.load_backup_config(registry)
    if getattr(args, "dir", None):
        cfg["dir"] = collapse_home(Path(args.dir).expanduser().absolute())
    dest = Path(cfg["dir"]).expanduser()
    branch = cfg["branch"]

    try:
        _backup.validate_backup_dir(dest)
    except _backup.BackupError as exc:
        _backup_fail(str(exc), json_out)
        return

    auth = _backup.detect_auth(cfg.get("auth"))
    warnings: list = []
    created = False
    create_detail = ""

    if getattr(args, "create", False):
        if not repo:
            _backup_fail("--create requires --repo owner/name", json_out)
        if auth["create_method"] != "gh":
            _backup_fail(
                "--create needs an authenticated `gh` CLI. Otherwise: "
                + _backup.manual_create_instructions(repo),
                json_out,
            )
        try:
            info = _backup.create_github_repo(repo)
        except _backup.BackupError as exc:
            _backup_fail(str(exc), json_out)
            return
        created = bool(info.get("created"))
        create_detail = info.get("detail", "")
        # Record WHICH gh account created it — this machine has more than one,
        # and a later silent `gh auth switch` would otherwise go unnoticed.
        cfg["gh_login"] = auth["gh_login"] or _backup.gh_active_login()

    if remote:
        cfg["remote"] = remote
        cfg["repo"] = None
    elif repo:
        cfg["repo"] = _backup.normalize_repo(repo)
        cfg["remote"] = _backup.remote_url_for(repo, auth["method"])

    try:
        _backup.git_init(dest, branch)
        if cfg.get("remote"):
            _backup.git_set_remote(dest, str(cfg["remote"]))
            verdict = _backup.verify_remote_is_ours(dest, branch)
            if not verdict["verified"]:
                warnings.append(verdict["detail"] + " — it will be verified on the first push")
    except _backup.BackupError as exc:
        _backup_fail(str(exc), json_out)
        return

    if auth["method"] is None:
        warnings.append(
            "no usable GitHub credential yet — snapshots will commit locally but "
            "not push (see `hub backup auth`)"
        )
    if not cfg.get("remote"):
        warnings.append(
            "no remote configured — snapshots stay local (re-run with --repo owner/name)"
        )

    cfg["enabled"] = True
    cfg["push_failures"] = 0
    cfg["last_push_error"] = None
    _backup.save_backup_config(registry, cfg)
    hub_core.save_registry(registry)

    payload = {
        "ok": True,
        "dir": str(dest),
        "remote": cfg.get("remote"),
        "repo": cfg.get("repo"),
        "branch": branch,
        "created": created,
        "create_detail": create_detail,
        "auth": auth["method"],
        "gh_login": cfg.get("gh_login"),
        "enabled": True,
        "initialized": _backup.is_git_repo(dest),
        "warnings": warnings,
    }
    if json_out:
        print(json.dumps(payload, indent=2))
        return
    print(f"\n{c('hub backup init', BOLD, CYAN)}\n")
    print(f"  {c('✓', GREEN)} repo    {dest} ({branch})")
    print(f"  {c('·', DIM)} remote  {cfg.get('remote') or c('(none)', DIM)}")
    print(f"  {c('·', DIM)} auth    {auth['method'] or c('none', YELLOW)}")
    if create_detail:
        print(f"  {c('·', DIM)} create  {create_detail}")
    for warning in warnings:
        print(f"  {c('!', YELLOW)} {warning}")
    print()


def cmd_backup_now(args):
    """`hub backup now [--no-push] [--allow-secret SHA] [--json]`.

    Read-only against the data home (pure gather + git write). `run_backup`
    takes the data-home lock itself, scoped to assembly + commit — deliberately
    NOT wrapped here, so the lock is released before the network push instead of
    blocking every other hub process for a GitHub round-trip.
    """
    from skill_hub.application.backup import backup as _backup
    from skill_hub.application.sync.sync_engine import record_backup_attempt

    json_out = bool(getattr(args, "json", False))
    registry = hub_core.load_registry()
    if not _backup.has_backup_config(registry):
        _backup_fail("backup is not configured — run `hub backup init` first", json_out)
    push = not bool(getattr(args, "no_push", False))

    allow = parse_csv(getattr(args, "allow_secret", None) or "")
    if allow:
        cfg = _backup.load_backup_config(registry)
        merged = sorted(set(cfg.get("allowed_secrets") or []) | set(allow))
        cfg["allowed_secrets"] = merged
        _backup.save_backup_config(registry, cfg)
        hub_core.save_registry(registry)

    # `--acknowledge-restore` is the ONE way the post-restore push hold is
    # lifted: it is an explicit statement that the restored state has been
    # reviewed and may now be published over the snapshot it came from.
    acknowledged = False
    if getattr(args, "acknowledge_restore", False):
        acknowledged = cmd_backup_acknowledge_restore(registry)
        if acknowledged:
            hub_core.save_registry(registry)

    try:
        operation_context = _operation_context(args)
        result = _backup.run_backup(
            registry,
            push=push,
            force=True,  # an explicit `backup now` always re-assembles
            push_timeout=_backup.INTERACTIVE_PUSH_TIMEOUT,
            operation_context=operation_context,
        )
    except (_backup.SecretLeakError, _backup.PrefixLeakError) as exc:
        # A fail-CLOSED refusal is a categorically different event from an
        # ordinary failure, and a caller reading JSON must be able to tell them
        # apart WITHOUT parsing prose. Same `error_kind` vocabulary the sync
        # report's `global.backup` slot uses.
        kind = "secret_leak" if isinstance(exc, _backup.SecretLeakError) else "prefix_leak"
        record_backup_attempt({"error": str(exc)}, error_kind=kind)
        _backup_fail(
            str(exc),
            json_out,
            error_kind=kind,
        )
        return
    except _backup.BackupError as exc:
        record_backup_attempt({"error": str(exc)}, error_kind="error")
        _backup_fail(str(exc), json_out, error_kind="error")
        return

    if _backup.record_push_outcome(registry, result):
        hub_core.save_registry(registry)

    record_backup_attempt(result, error_kind="error" if result.get("error") else None)

    result["acknowledged_restore"] = acknowledged
    if json_out:
        print(json.dumps(result, indent=2))
    else:
        print(f"\n{c('hub backup now', BOLD, CYAN)}\n")
        if acknowledged:
            print(f"  {c('✓', GREEN)} restore acknowledged — pushes are unblocked")
        counts = result.get("counts") or {}
        if counts:
            print(
                f"  {c('·', DIM)} snapshot  skills {counts.get('skills', 0)}, "
                f"mcp {counts.get('mcp_servers', 0)}, snippets {counts.get('snippets', 0)}, "
                f"connectors {counts.get('connectors', 0)}, "
                f"sub-agents {counts.get('subagents', 0)}, "
                f"global-docs {counts.get('global_docs', 0)}"
            )
        if result.get("committed"):
            print(f"  {c('✓', GREEN)} commit    {str(result['commit'])[:12]}")
        else:
            print(f"  {c('·', DIM)} commit    no changes since the last snapshot")
        mark = c("✓", GREEN) if result.get("pushed") else c("·", DIM)
        print(f"  {mark} push      {result.get('push_detail') or 'not pushed'}")
        for warning in result.get("warnings") or []:
            print(f"  {c('!', YELLOW)} {warning}")
        if result.get("error"):
            print(f"  {c('✗', RED)} {result['error']}")
        print()
    if not result.get("ok", True):
        sys.exit(1)


def cmd_backup_status(args):
    """`hub backup status [--json]` — cheap status; no auth dial except gh account."""
    import hub
    from skill_hub.application.backup import backup as _backup

    json_out = bool(getattr(args, "json", False))
    registry = hub._read_registry_optional()
    status = _backup.backup_status(registry, operation_context=_operation_context(args))

    if json_out:
        print(json.dumps(status, indent=2))
        return

    print(f"\n{c('hub backup status', BOLD, CYAN)}\n")
    state = c("on", GREEN) if status["enabled"] else c("off", DIM)
    print(f"  {'enabled':<10}{state}")
    print(f"  {'dir':<10}{status['dir']}")
    print(f"  {'remote':<10}{status['remote'] or c('(none)', DIM)}")
    print(f"  {'branch':<10}{status['branch'] or c('(none)', DIM)}")
    if not status["initialized"]:
        print(f"\n  {c('!', YELLOW)} not initialized — run `hub backup init`\n")
        return
    last = status["last_commit"]
    if last:
        print(f"  {'last':<10}{last['ts']}  {last['sha'][:12]}  {last['subject']}")
    else:
        print(f"  {'last':<10}{c('no snapshot committed yet', DIM)}")
    drift = status["drift"]
    tone = GREEN if drift == "in-sync" else (DIM if drift == "unknown" else YELLOW)
    detail = ""
    if status["ahead"] is not None:
        detail = f" (ahead {status['ahead']}, behind {status['behind']})"
    print(f"  {'drift':<10}{c(drift, tone)}{detail}")
    # Said ONCE, straight from the counters. `backup_status` deliberately no
    # longer duplicates this into `warnings` — the app rendered that copy in its
    # blue informational channel right beside the same fact in red.
    failures = int(status.get("push_failures") or 0)
    if failures:
        reason = status.get("last_push_error") or "unknown error"
        print(f"  {c('✗', RED)} {failures} consecutive push failures ({reason})")
    for warning in status.get("warnings") or []:
        print(f"  {c('✗', RED)} {warning}")
    print()


def cmd_backup_auth(args):
    """`hub backup auth [--json] [--login-pat] [--logout]`.

    `--login-pat` reads the token from STDIN only — never from argv, so it
    cannot land in a shell history or a process listing.
    """
    import hub
    from skill_hub.application.backup import backup as _backup

    json_out = bool(getattr(args, "json", False))
    registry = hub._read_registry_optional()
    cfg = _backup.load_backup_config(registry)

    stored = None
    deleted = None
    if getattr(args, "login_pat", False):
        token = sys.stdin.read()
        try:
            _backup.store_pat(token)
        except _backup.BackupError as exc:
            _backup_fail(str(exc), json_out)
            return
        stored = True
    if getattr(args, "logout", False):
        deleted = _backup.delete_pat()

    payload = _backup.detect_auth(cfg.get("auth"))
    payload["ok"] = True
    if stored is not None:
        payload["stored"] = stored
    if deleted is not None:
        payload["deleted"] = deleted

    if json_out:
        print(json.dumps(payload, indent=2))
        return

    print(f"\n{c('hub backup auth', BOLD, CYAN)}\n")
    for rung in payload["ladder"]:
        mark = c("✓", GREEN) if rung["available"] else c("·", DIM)
        chosen = c(" ← used for push", CYAN) if rung["method"] == payload["method"] else ""
        print(f"  {mark} {rung['method']:<5}{rung['detail']}{chosen}")
    if payload["method"] is None:
        print(
            f"\n  {c('!', YELLOW)} no usable credential — set up an ssh key, or store a PAT "
            f"({_backup.PAT_SCOPE_HELP}):\n"
            f"      printf '%s' <token> | hub backup auth --login-pat"
        )
    if stored:
        print(f"\n  {c('✓', GREEN)} PAT stored in the OS keychain ({_backup.PAT_SECRET_REF})")
    if deleted is not None:
        mark = c("✓", GREEN) if deleted else c("·", DIM)
        print(f"  {mark} PAT {'deleted' if deleted else 'was not stored'}")
    print()


def _cmd_backup_set_enabled(args, enabled: bool):
    from skill_hub.application.backup import backup as _backup

    json_out = bool(getattr(args, "json", False))
    registry = hub_core.load_registry()
    cfg = _backup.load_backup_config(registry)
    cfg["enabled"] = enabled
    _backup.save_backup_config(registry, cfg)
    hub_core.save_registry(registry)
    if json_out:
        print(json.dumps({"ok": True, "enabled": enabled}, indent=2))
        return
    state = c("enabled", GREEN) if enabled else c("disabled", DIM)
    print(f"  {c('✓', GREEN)} backup {state}")


@registry_mutation("backup-enable")
def cmd_backup_enable(args):
    _cmd_backup_set_enabled(args, True)


@registry_mutation("backup-disable")
def cmd_backup_disable(args):
    _cmd_backup_set_enabled(args, False)


def cmd_backup_acknowledge_restore(registry: dict) -> bool:
    """Clear `backup.pending_reconcile`. True when it actually changed."""
    from skill_hub.application.backup import backup as _backup

    cfg = _backup.load_backup_config(registry)
    if not cfg.get("pending_reconcile"):
        return False
    cfg["pending_reconcile"] = False
    _backup.save_backup_config(registry, cfg)
    return True
