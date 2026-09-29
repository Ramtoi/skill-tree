"""`hub restore` — restore Skill Tree state from a backup snapshot (design v2 §5, §6).

The destructive counterpart to `hub backup`. Dry run is the default; `--apply`
is required for any write; and restore never runs sync and never pushes —
installing restored configuration into the harnesses is a separate, explicit
act (`--sync` opts in). Also carries `hub source restore`'s handler, which
shares the snapshot/registry machinery. The planning/merging/verification
logic lives in `restore.py`; these are CLI marshals.

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    YELLOW,
    c,
    data_home,
    data_home_lock,
    registry_mutation,
)

NAME = "restore"

p_restore = None


def _restore_operation_context(args, snapshot):
    context = getattr(args, "_operation_context", None)
    if context is not None:
        return context
    from skill_hub.application.backup import restore as _restore
    from skill_hub.application.harnesses.harness_operation_context import WORKFLOW_FEATURES, build_operation_context

    manifest = _restore._backup.read_manifest(Path(snapshot["dir"])) or {}
    harness_ids = set()
    for key in ("subagents", "global_docs"):
        for rel in manifest.get(key) or ():
            parts = str(rel).split("/")
            if len(parts) >= 2 and parts[0] in {"harness", "global-docs"}:
                harness_ids.add(parts[1])
    from skill_hub.infrastructure.harnesses import harnesses

    installed = harnesses.detect_installed()
    if getattr(args, "sync", False):
        harness_ids.update(installed)
    context = build_operation_context(
        data_home(),
        tuple(sorted(harness_ids)),
        installed_harness_ids=tuple(sorted(installed)),
        requested_features=WORKFLOW_FEATURES if getattr(args, "sync", False) else ("restore",),
        needs_selection=False,
    )
    try:
        args._operation_context = context
    except AttributeError:
        pass
    return context


def register(sub) -> None:
    global p_restore

    p_restore = sub.add_parser(
        "restore",
        help="Restore Skill Tree state from a backup snapshot (dry run by default)",
    )
    p_restore.add_argument(
        "--from",
        dest="from_",
        help="Snapshot URL or path (default: the configured backup dir)",
    )
    p_restore.add_argument("--branch", help="Branch to restore from")
    p_restore.add_argument(
        "--mode",
        choices=["replace", "merge"],
        help="replace = take the backup wholesale; merge = union, backup wins on "
        "conflict. Required when the target registry already has content.",
    )
    p_restore.add_argument(
        "--apply", action="store_true", help="Actually write (default is a dry run)"
    )
    p_restore.add_argument(
        "--force",
        action="store_true",
        help="Overwrite locally-diverged sub-agent / global-doc files (backed up "
        "first) instead of writing a .from-backup sibling",
    )
    p_restore.add_argument(
        "--accept-executable-state",
        dest="accept_executable_state",
        action="store_true",
        help="Consent to restoring hooks / permission rules / Codex trust grants",
    )
    p_restore.add_argument(
        "--trust-new-key",
        dest="trust_new_key",
        action="store_true",
        help="Accept (and pin) a snapshot signed by a key this machine has not seen",
    )
    p_restore.add_argument(
        "--sync",
        action="store_true",
        help="Run a LOCAL sync after applying (skips remotes and the backup push)",
    )
    p_restore.add_argument("--json", action="store_true", help="Emit JSON")


def dispatch(args) -> None:
    cmd_restore(args)




def _restore_public(plan: dict) -> dict:
    """Plan minus the full resolved registry (megabytes of detail no caller needs).

    The app's `restore_preview` / `restore_apply` bridge consumes exactly this
    shape, so the resolved registry stays an internal apply input rather than
    something a UI has to scroll past.
    """
    return {k: v for k, v in plan.items() if k != "resolved_registry"}


def _print_executable_state(exec_state: dict) -> None:
    """Enumerate everything a restore would install that this machine will RUN.

    Shared by the dry-run/apply report and the interactive consent prompt, so
    the prompt can never ask about less than the report shows.
    """
    if not exec_state.get("any"):
        return
    print(f"\n  {c('Executable state being restored', BOLD, YELLOW)}")
    for hook in exec_state.get("hooks") or []:
        flag = c(" [BROKEN: missing script]", RED) if hook["broken"] else ""
        print(f"    hook {hook['name']} ({hook['event']}){flag}")
        print(f"      {c(hook['command'], DIM)}")
    rules = exec_state.get("permission_rules") or []
    if rules:
        print(f"    {len(rules)} permission rule(s):")
        for rule in rules[:20]:
            print(f"      [{rule['kind']}] {rule['pattern']}  ({rule['scope']})")
        if len(rules) > 20:
            print(f"      … and {len(rules) - 20} more")
    for grant in exec_state.get("codex_trust") or []:
        print(
            f"    {c('!', YELLOW)} Codex trust for {grant['project']} "
            f"({grant['path']}) — {grant['reason']}"
        )
    incoming = [
        d for d in (exec_state.get("code_dirs") or []) if d["action"] != "identical"
    ]
    if incoming:
        print(f"    {len(incoming)} executable dir(s) — code this machine will run:")
        for item in incoming:
            print(
                f"      {c(item['action'], YELLOW)} {item['kind']} {item['name']}"
                f"  ({len(item['files'])} file(s))"
            )


def _companion_resolve_command(pair: dict, *, agent: str) -> str:
    """One RUNNABLE `hub skill companions resolve` command for a single
    `{skill, scope}` claim. `hub_cli/companions.py`'s `resolve` verb fails
    closed (`pass exactly one of --project <p> or --global`) without a scope
    flag, so the command this prints must carry one — review 4b #1."""
    scope = pair["scope"]
    scope_flag = "--global" if scope == "global" else f"--project {scope}"
    return (
        f"hub skill companions resolve {pair['skill']} --agent {agent} "
        f"{scope_flag} --op keep-mine|keep-skill"
    )


def _companion_notes(comp: dict) -> list:
    """The `·`-bullet line(s) for one subagent row's `companion` claim.

    A `written` claim (drift) gets one runnable resolve command per
    `(skill, scope)` pair — never a single skill picked arbitrarily out of
    several claimants (review 4b #1/#4). An unwritten claim is split by
    ledger version (review 4b #2/#3): a pre-v2 (`is_backfill`) entry says the
    next `hub sync` still adopts or removes the file; a v2 `already_present`
    (D9) entry keeps the old "leaves it alone" wording, which is the only
    case that sentence is still true for.
    """
    notes: list = []
    agent = comp["agent"]

    written_pairs = comp.get("written_pairs") or []
    if written_pairs:
        skills = ", ".join(sorted({p["skill"] for p in written_pairs}))
        scopes = ", ".join(sorted({p["scope"] for p in written_pairs}))
        commands = [_companion_resolve_command(p, agent=agent) for p in written_pairs]
        if len(commands) == 1:
            notes.append(
                f"ships_with companion of {skills} ({scopes}) — `hub sync` "
                f"reports a mismatch here as companion drift and never "
                f"overwrites it; resolve with `{commands[0]}`"
            )
        else:
            notes.append(
                f"ships_with companion of {skills} ({scopes}) — `hub sync` "
                f"reports a mismatch here as companion drift and never "
                f"overwrites it; each claiming skill needs its own resolve:"
            )
            notes.extend(f"`{command}`" for command in commands)

    backfill_pairs = comp.get("backfill_pairs") or []
    if backfill_pairs:
        skills = ", ".join(sorted({p["skill"] for p in backfill_pairs}))
        scopes = ", ".join(sorted({p["scope"] for p in backfill_pairs}))
        notes.append(
            f"ships_with companion of {skills} ({scopes}) — a pre-v2 ledger "
            f"entry claims this agent with no per-harness record yet; the "
            f"next `hub sync` records this file as the tracked copy if the "
            f"skill still ships this agent, or deletes it if it no longer does"
        )

    d9_pairs = comp.get("d9_pairs") or []
    if d9_pairs:
        skills = ", ".join(sorted({p["skill"] for p in d9_pairs}))
        scopes = ", ".join(sorted({p["scope"] for p in d9_pairs}))
        notes.append(
            f"ships_with companion of {skills} ({scopes}) — the ledger "
            f"claims this agent but records no copy hub wrote, so `hub sync` "
            f"leaves its content alone"
        )

    return notes


def _print_restore_plan(plan: dict, *, applied: Optional[dict] = None) -> None:
    header = "hub restore (applied)" if applied else "hub restore (dry run — nothing written)"
    print(f"\n{c(header, BOLD, CYAN)}\n")
    print(f"  {'source':<12}{plan.get('source')}")
    print(f"  {'snapshot':<12}{plan.get('snapshot_dir')}")
    man = plan.get("manifest") or {}
    if man.get("created_at"):
        print(
            f"  {'taken':<12}{man.get('created_at')} on {man.get('hostname')} "
            f"(hub {man.get('hub_version')})"
        )

    integrity = plan.get("integrity") or {}
    digest = integrity.get("tree_digest") or {}
    trust = integrity.get("trust") or {}
    mark = c("✓", GREEN) if digest.get("ok") else c("✗", RED)
    print(f"  {mark} integrity  {digest.get('detail')}")
    state = trust.get("state")
    if state == restore_mod().TRUST_VERIFIED:
        print(f"  {c('✓', GREEN)} signature  {trust.get('detail')}")
    elif trust.get("hard"):
        print(f"  {c('✗', RED)} signature  {trust.get('detail')}")
    else:
        print(f"  {c('!', YELLOW)} signature  {trust.get('detail')}")
    if plan.get("fatal"):
        for err in plan.get("errors") or []:
            print(f"  {c('✗', RED)} {err}")
        print()
        return

    reg = plan.get("registry") or {}
    diff = reg.get("diff") or {}
    totals = diff.get("totals") or {}
    if plan.get("mode"):
        mode_label = str(plan["mode"])
    elif reg.get("mode_required"):
        mode_label = c("(none chosen — required)", YELLOW)
    else:
        mode_label = c("replace (the target registry is empty)", DIM)
    print(
        f"\n  {c('Registry', BOLD)}  mode={mode_label}  "
        f"+{totals.get('added', 0)} / -{totals.get('lost', 0)} lost / "
        f"{totals.get('conflicts', 0)} conflicts"
    )
    for section, info in sorted((diff.get("sections") or {}).items()):
        if not (info["added"] or info["lost"] or info["conflicts"]):
            continue
        if info["lost"] and plan.get("mode") != "merge":
            print(f"    {c('✗', RED)} {section}: LOST {', '.join(info['lost'])}")
        if info["added"]:
            print(f"    {c('+', GREEN)} {section}: {', '.join(info['added'])}")
        if info["conflicts"]:
            print(
                f"    {c('~', YELLOW)} {section}: conflicts (backup wins) "
                f"{', '.join(info['conflicts'])}"
            )
    for key in diff.get("top_level_lost") or []:
        if plan.get("mode") != "merge":
            print(f"    {c('✗', RED)} top-level key LOST: {key}")

    _print_executable_state(plan.get("executable_state") or {})

    report = plan.get("report") or {}
    lines: list = []
    for item in report.get("dangling_secret_refs") or []:
        lines.append(
            f"remote '{item['remote']}' needs its token re-provisioned "
            f"({item['secret_ref']}): {item['fix']}"
        )
    for item in report.get("redacted_mcp_env") or []:
        lines.append(
            f"skill '{item['skill']}' MCP env values were redacted — re-enter: "
            + ", ".join(item["keys"])
        )
    for item in report.get("dangling_skill_sources") or []:
        lines.append(
            f"skill '{item['skill']}' source is {item['class']} — its content is NOT "
            f"in the snapshot"
        )
    for item in report.get("external_connectors") or []:
        lines.append(
            f"connector '{item.get('name')}' was a symlink out of the data home "
            f"({item.get('target')}) — its code is not in the snapshot"
        )
    for item in report.get("machine_absolute") or []:
        if item.get("rewritten"):
            lines.append(
                f"{item['field']} = {item['value']} — rewritten for this machine's data home"
            )
        else:
            lines.append(
                f"{item['field']} = {item['value']} — carried verbatim; verify on this machine"
            )
    for name in report.get("unresolved_projects") or []:
        lines.append(f"project '{name}' path does not exist here — QUARANTINED")
    retained = report.get("retained_extra_files") or []
    for item in retained[:10]:
        lines.append(
            f"{item['section']}/{item['path']} exists here but not in the snapshot — "
            f"RETAINED (restore overlays, it never deletes)"
        )
    if len(retained) > 10:
        lines.append(
            f"… and {len(retained) - 10} more local file(s) retained alongside the "
            f"restored ones"
        )
    if report.get("audit_ledgers_note"):
        lines.append(report["audit_ledgers_note"])
    if report.get("usage_ledgers_note"):
        lines.append(report["usage_ledgers_note"])
    if report.get("remote_baseline_note"):
        lines.append(report["remote_baseline_note"])
    for rejected in plan.get("rejected") or []:
        lines.append(f"rejected snapshot entry {rejected['rel']}: {rejected['reason']}")
    for dropped in (plan.get("links") or {}).get("dropped") or []:
        lines.append(f"link '{dropped['name']}' dropped — {dropped['reason']}")
    for retained_link in (plan.get("links") or {}).get("retained") or []:
        lines.append(f"link '{retained_link['name']}' retained: {retained_link['reason']}")
    if lines:
        print(f"\n  {c('Needs your attention', BOLD)}")
        for line in lines:
            print(f"    {c('•', YELLOW)} {line}")

    files = (plan.get("subagents") or []) + (plan.get("global_docs") or [])
    if files:
        print(f"\n  {c('Out-of-data-home files', BOLD)}")
        for item in files:
            tone = {"write": GREEN, "overwrite": YELLOW, "sibling": YELLOW}.get(
                item["action"], DIM
            )
            print(
                f"    {c(item['action'], tone):<12} {item['harness']}/{item['name']}"
                f"  → {item.get('target')}"
            )
            if item["action"] in ("sibling", "overwrite") and item.get("companion"):
                for note in _companion_notes(item["companion"]):
                    print(f"                 {c('·', DIM)} {note}")

    data = plan.get("data") or {}
    summary = ", ".join(
        f"{section} {info['files']}" for section, info in sorted(data.items())
    )
    if summary:
        print(f"\n  {c('Data home', BOLD)}  files: {summary}")

    if applied:
        print(f"\n  {c('✓', GREEN)} applied — {len(applied.get('writes') or [])} write(s)")
        if applied.get("backup_dir"):
            print(f"  {c('·', DIM)} overwritten files backed up to {applied['backup_dir']}")
        if applied.get("registry_backup"):
            print(f"  {c('·', DIM)} previous registry at {applied['registry_backup']}")
        if applied.get("pinned"):
            print(f"  {c('·', DIM)} pinned this source's signing key {applied['pinned']}")
    else:
        for err in plan.get("errors") or []:
            print(f"\n  {c('✗', RED)} {err}")

    print(f"\n  {c('Next steps', BOLD)}")
    for step in plan.get("next_steps") or []:
        print(f"    {c('→', CYAN)} {step}")
    print()


def restore_mod():
    from skill_hub.application.backup import restore as _restore

    return _restore


def cmd_restore(args):
    """`hub restore [--from URL|PATH] [--mode replace|merge] [--apply] …`.

    Dry run by default. `--apply` requires a mode whenever the target registry
    already holds content, and `--accept-executable-state` whenever the snapshot
    carries hooks / permission rules / Codex trust grants. Restore NEVER syncs
    and never pushes; `--sync` opts into a LOCAL sync afterwards
    (`skip_backup`, `skip_remotes`) so a restored, unreviewed state cannot be
    published over the snapshot it came from or pushed to a live box.
    """
    import hub

    _restore = restore_mod()

    json_out = bool(getattr(args, "json", False))
    apply_it = bool(getattr(args, "apply", False))
    registry = hub._read_registry_optional()

    def _fail(message: str, **extra):
        if json_out:
            payload = {"ok": False, "applied": False, "error": message}
            payload.update(extra)
            print(json.dumps(payload, indent=2, default=str))
        else:
            print(f"\n  {c('✗', RED)} {message}\n")
        sys.exit(1)

    try:
        snapshot = _restore.resolve_snapshot(
            getattr(args, "from_", None),
            registry=registry,
            branch=getattr(args, "branch", None),
        )
    except (_restore.RestoreError, ValueError) as exc:
        _fail(str(exc))
        return

    try:
        code_home_path = hub_core.code_home()
    except Exception:
        code_home_path = None
    operation_context = _restore_operation_context(args, snapshot)

    trust_new_key = bool(getattr(args, "trust_new_key", False))
    accept_exec = bool(getattr(args, "accept_executable_state", False))

    def _plan_now():
        plan = _restore.build_plan(
            snapshot,
            target_registry=registry,
            mode=getattr(args, "mode", None),
            data_home=data_home(),
            code_home=code_home_path,
            home=Path.home(),
            force=bool(getattr(args, "force", False)),
            trust_new_key=trust_new_key,
            accept_executable_state=accept_exec,
            operation_context=operation_context,
        )
        from skill_hub.entrypoints.cli.mcp_control import (
            MCP_CONTROL_OPT_OUT_KEY,
            bundled_control_available,
            ensure_control_plane_setup,
        )

        # A local explicit opt-out takes precedence over an older snapshot.
        if not plan.get("fatal") and (registry.get(MCP_CONTROL_OPT_OUT_KEY) or {}).get("opted_out"):
            plan["resolved_registry"][MCP_CONTROL_OPT_OUT_KEY] = dict(registry[MCP_CONTROL_OPT_OUT_KEY])
        if (not plan.get("fatal") and bundled_control_available()
                and not (registry.get("bootstrap") or {}).get("completed_at")):
            resolved = plan["resolved_registry"]
            selected = tuple(getattr(operation_context, "installed_harness_ids", ()) or ())
            setup = ensure_control_plane_setup(resolved, selected_harnesses=selected)
            plan["control_plane_setup"] = setup
            plan.setdefault("next_steps", []).append(
                "Built-in control MCP setup: " + setup["server"]
                + "; companion skt-mcp: " + setup["companion"] + "."
            )
        return plan

    try:
        plan = _plan_now()
    except (_restore.RestoreError, ValueError) as exc:
        _fail(str(exc))
        return

    def _interactive() -> bool:
        # A human at a terminal may consent in the moment; a pipe or `--json`
        # never can, so those must pass the flag.
        return (
            apply_it
            and not plan["fatal"]
            and not json_out
            and sys.stdin is not None
            and sys.stdin.isatty()
        )

    # Interactive TOFU: accept (and pin) an unrecognised signing key.
    trust = (plan.get("integrity") or {}).get("trust") or {}
    if _interactive() and not trust.get("ok"):
        print(f"\n  {c('!', YELLOW)} {trust.get('detail')}")
        if hub._confirm("Trust and pin this signing key?"):
            trust_new_key = True
            try:
                plan = _plan_now()
            except _restore.RestoreError as exc:
                _fail(str(exc))
                return

    # Interactive executable-state consent — the SAME shape as the TOFU loop
    # above. Without it an interactive `hub restore --apply` (and every
    # `hub bootstrap --restore-from …`, which routes through here) dead-ended:
    # the one snapshot worth restoring is the one carrying hooks and permission
    # rules, so the apply always refused, and the only way out was to know a
    # flag the failure text mentions but the wizard never offers.
    exec_state = plan.get("executable_state") or {}
    if _interactive() and exec_state.get("any") and not exec_state.get("accepted"):
        _print_executable_state(exec_state)
        if hub._confirm("Install this executable state?"):
            accept_exec = True
            try:
                plan = _plan_now()
            except _restore.RestoreError as exc:
                _fail(str(exc))
                return

    applied = None
    if apply_it and plan["ok"]:
        with data_home_lock():
            applied = _restore.apply_plan(
                plan, data_home=data_home(), operation_context=operation_context
            )
        plan["apply"] = True

    payload = _restore_public(plan)
    if applied is not None:
        payload["applied"] = applied

    # Emit the report BEFORE the optional sync. `cmd_sync` can `sys.exit(2)` on a
    # doctor danger finding, and it used to do so with the entire applied report
    # still unprinted — so the run that most needed its "here is what landed and
    # what needs your attention" output was exactly the run that swallowed it.
    if json_out:
        print(json.dumps(payload, indent=2, default=str))
    else:
        _print_restore_plan(plan, applied=applied)
    sys.stdout.flush()

    if getattr(args, "sync", False) and applied is not None:

        class _RestoreSyncArgs:
            skip_remotes = True
            skip_backup = True
            _operation_context = operation_context

        if json_out:
            # stdout is a JSON document and nothing else; the sync's human
            # output goes to stderr rather than corrupting it.
            with contextlib.redirect_stdout(sys.stderr):
                hub.cmd_sync(_RestoreSyncArgs())
        else:
            print(f"\n{c('Running a local sync (--sync)…', BOLD)}")
            hub.cmd_sync(_RestoreSyncArgs())

    if plan.get("fatal") or (apply_it and not plan["ok"]):
        sys.exit(1)


@registry_mutation("source-restore")
def cmd_source_restore(args):
    """`hub source restore <id> | --all` — re-clone a git source's missing cache.

    `sources/` never travels in a snapshot (it is a re-derivable clone of someone
    else's repo) and `hub source sync` FAILS outright on a missing cache, so this
    is the only recovery path after a restore. Idempotent: a present, healthy
    cache is left alone.
    """
    _restore = restore_mod()
    json_out = bool(getattr(args, "json", False))
    registry = hub_core.load_registry()
    sources = registry.get("sources") or {}

    if getattr(args, "all", False):
        ids = [
            sid
            for sid, cfg in sorted(sources.items())
            if isinstance(cfg, dict) and (cfg.get("type") or "git") == "git"
        ]
    else:
        ids = [args.id]
    if not ids:
        payload = {"ok": True, "results": [], "detail": "no git sources registered"}
        if json_out:
            print(json.dumps(payload, indent=2))
        else:
            print(f"  {c('·', DIM)} no git sources registered")
        return

    results: list = []
    failures = 0
    for source_id in ids:
        try:
            results.append(_restore.restore_source(registry, source_id))
        except _restore.RestoreError as exc:
            failures += 1
            results.append({"ok": False, "source": source_id, "error": str(exc)})
    hub_core.save_registry(registry)

    payload = {"ok": failures == 0, "results": results}
    if json_out:
        print(json.dumps(payload, indent=2))
    else:
        print(f"\n{c('hub source restore', BOLD, CYAN)}\n")
        for res in results:
            if res.get("ok"):
                mark = c("✓", GREEN) if res.get("cloned") else c("·", DIM)
                print(f"  {mark} {res['source']:<20}{res['detail']}")
                print(f"    {c(res['cache'], DIM)}")
            else:
                print(f"  {c('✗', RED)} {res['source']:<20}{res.get('error')}")
        print()
    if failures:
        sys.exit(1)
