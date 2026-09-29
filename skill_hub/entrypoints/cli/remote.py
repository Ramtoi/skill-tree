"""`hub remote` — pluggable remote connector targets (Hermes, etc.).

A remote is one destination reached over a connector (SSH today; a
publishable Hermes connector ships with the framework). It equips skills with
the same model as a project (`resolve_remote_skills` → `resolve_project_skills`)
and holds references only — `secret_ref` is an OS-keychain handle, never
secret bytes. These handlers are marshalling + output only; the connector
framework (`connectors/`) and `remotes.py` own the model.

This slice carries every `hub remote` verb: the framework verbs (list/
connectors/add/show/diff/sync/resolve/disable/enable/set-global/equip/remove/
clear/import-skill), the Wave 3 credential-lifecycle verbs (keyscan/setup-key/
setup-helper/setup-codex-helper/signing-key/revoke-key/repin), and the
remaining Wave 3 CLI gap-closure verbs (doc round-trip/health/doctor/pin/
probe/rotate-token). None stay behind in `hub.py`.

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import hashlib
import json
import shutil
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
    SLUG_RE,
    YELLOW,
    c,
    collapse_home,
    data_home,
    data_home_lock,
    fail,
    registry_mutation,
    validate_slug,
)

NAME = "remote"

_REMOTE_DOC_NAMES = ("SOUL.md", "MEMORY.md", "USER.md")

p_remote = None


def register(sub) -> None:
    global p_remote

    p_remote = sub.add_parser("remote", help="Manage remote connector targets")
    remote_sub = p_remote.add_subparsers(dest="remote_cmd")

    p_remote_list = remote_sub.add_parser("list", help="List configured remotes")
    p_remote_list.add_argument(
        "--json", action="store_true", help="Emit JSON instead of a table"
    )

    p_remote_connectors = remote_sub.add_parser(
        "connectors",
        help="List registered connectors + metadata (key/label/transport/source)",
    )
    p_remote_connectors.add_argument(
        "--json", action="store_true", help="Emit JSON instead of a table"
    )

    p_remote_add = remote_sub.add_parser(
        "add", help="Register a remote (references only; no secrets in the registry)"
    )
    p_remote_add.add_argument("id", help="Remote id (registry key under remotes:)")
    p_remote_add.add_argument(
        "--connector", default="hermes", help="Connector key (default: hermes)"
    )
    p_remote_add.add_argument("--ssh-host", help="SSH host/alias (e.g. hermes@moon-base)")
    p_remote_add.add_argument(
        "--endpoint",
        help="HTTPS MCP endpoint URL (for the goalrunner-orchestrator connector). "
        "Stored as transport.endpoint; the connector talks JSON-RPC over it.",
    )
    p_remote_add.add_argument(
        "--token-ref",
        dest="token_ref",
        help="Keychain handle for the bearer token (HTTP/MCP connectors). With "
        "--token / stdin, the provided token is stored under this handle; the "
        "registry holds ONLY the ref. Sets secret_ref.",
    )
    p_remote_add.add_argument(
        "--token",
        help="Bearer token VALUE to store under --token-ref in the OS keychain "
        "(prefer stdin: omit to read one line from stdin). Never persisted in "
        "the registry.",
    )
    p_remote_add.add_argument(
        "--host-key", dest="host_key", action="append",
        help="Pinned TOFU host-key fingerprint (SHA256:...). Repeat or "
        "comma-separate to pin BOTH the ed25519 AND rsa keys (H2.3 multi-key).",
    )
    p_remote_add.add_argument("--secret-ref", dest="secret_ref", help="Keychain handle")
    p_remote_add.add_argument("--home", help="Remote home dir (connector default if omitted)")
    p_remote_add_sync = p_remote_add.add_mutually_exclusive_group()
    p_remote_add_sync.add_argument(
        "--no-sync", action="store_true",
        help="Register with sync_enabled=false (the default for custom/root-transport "
        "connectors like codex-workers, so a UI toggle can't trigger a privileged push)",
    )
    p_remote_add_sync.add_argument(
        "--sync", action="store_true",
        help="Force sync_enabled=true (override the custom/root-transport default-off)",
    )
    p_remote_add_global = p_remote_add.add_mutually_exclusive_group()
    p_remote_add_global.add_argument(
        "--apply-global", dest="apply_global", action="store_true",
        help="Opt this remote into inheriting global-scope bundle skills (D15). "
        "Default OFF: a remote inherits NO global bundle unless this is set. Its "
        "own --bundles/--enabled always apply regardless.",
    )
    p_remote_add_global.add_argument(
        "--no-apply-global", dest="apply_global", action="store_false",
        help="Explicitly do NOT inherit global-scope bundle skills (the default).",
    )
    p_remote_add.set_defaults(apply_global=False)
    p_remote_add.add_argument(
        "--bundles", help="Comma-separated bundles to equip"
    )
    p_remote_add.add_argument(
        "--enabled", help="Comma-separated individual skills to equip"
    )

    p_remote_show = remote_sub.add_parser("show", help="Show one remote's config + resolved skills")
    p_remote_show.add_argument("id", help="Remote id")
    p_remote_show.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_diff = remote_sub.add_parser(
        "diff", help="Read-only plan: per-artifact drift status (no writes)"
    )
    p_remote_diff.add_argument("id", help="Remote id")
    p_remote_diff.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_sync = remote_sub.add_parser("sync", help="Sync one remote now")
    p_remote_sync.add_argument("id", help="Remote id")
    p_remote_sync.add_argument(
        "--force", action="store_true", help="Run even if sync_enabled is false"
    )
    p_remote_sync.add_argument(
        "--strict", action="store_true",
        help="Exit non-zero on an ALARMING failure (auth / host-key mismatch / "
        "integrity); unreachable stays quiet (L1)",
    )

    p_remote_resolve = remote_sub.add_parser(
        "resolve", help="Explicitly resolve a drifted/conflicting artifact"
    )
    p_remote_resolve.add_argument("id", help="Remote id")
    p_remote_resolve.add_argument(
        "--artifact", required=True, help="Artifact name/ref to resolve"
    )
    p_remote_resolve.add_argument(
        "--op",
        required=True,
        choices=["push", "pull", "keep-local", "keep-remote"],
        help="Resolution operation",
    )
    p_remote_resolve.add_argument(
        "--kind", default="skill", choices=["skill", "mcp", "agent_doc"],
        help="Artifact kind (default: skill)",
    )
    p_remote_resolve.add_argument(
        "--yes", action="store_true",
        help="Skip the confirm-on-pull prompt (headless adoption of remote content)",
    )

    p_remote_disable = remote_sub.add_parser("disable", help="Set sync_enabled=false")
    p_remote_disable.add_argument("id", help="Remote id")
    p_remote_disable.add_argument(
        "--revoke-key", dest="revoke_key", action="store_true",
        help="Also revoke the hub's installed authorized_keys line on the box (H2.1)",
    )
    p_remote_disable.add_argument(
        "--yes", action="store_true", help="Skip the revoke confirm (headless)"
    )

    p_remote_enable = remote_sub.add_parser("enable", help="Set sync_enabled=true")
    p_remote_enable.add_argument("id", help="Remote id")

    p_remote_set_global = remote_sub.add_parser(
        "set-global",
        help="Toggle apply_global_bundles (inherit global-scope bundle skills)",
    )
    p_remote_set_global.add_argument("id", help="Remote id")
    p_remote_set_global.add_argument(
        "state", nargs="?", choices=["on", "off"],
        help="on = inherit global bundles; off = don't (default)",
    )
    p_remote_set_global.add_argument(
        "--apply-global", dest="apply_global", choices=["on", "off"],
        help="Alternative to the positional on|off",
    )

    p_remote_equip = remote_sub.add_parser(
        "equip",
        help="Add/remove a bundle or skill on a remote (registry-only; no box push)",
    )
    p_remote_equip.add_argument("id", help="Remote id")
    p_remote_equip.add_argument(
        "--kind", required=True, choices=["bundle", "skill"],
        help="Whether <name> is a bundle or an individual skill",
    )
    p_remote_equip.add_argument(
        "--name", required=True, help="Bundle or skill name to toggle",
    )
    p_remote_equip.add_argument(
        "--state", required=True, choices=["on", "off"],
        help="on = equip; off = unequip",
    )
    p_remote_equip.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_remove = remote_sub.add_parser(
        "remove", help="Unregister a remote (drops the registry entry + sidecars)"
    )
    p_remote_remove.add_argument("id", help="Remote id")
    p_remote_remove.add_argument(
        "--revoke-key", dest="revoke_key", action="store_true",
        help="Also revoke the hub's installed authorized_keys line on the box first (H2.1)",
    )
    p_remote_remove.add_argument(
        "--yes", action="store_true", help="Skip the revoke confirm (headless)"
    )

    p_remote_clear = remote_sub.add_parser(
        "clear", help="Forget hub ownership of a remote's artifacts (clears sidecars)"
    )
    p_remote_clear.add_argument("id", help="Remote id")

    p_remote_import = remote_sub.add_parser(
        "import-skill", help="Adopt a box-native skill into the hub with provenance"
    )
    p_remote_import.add_argument(
        "name", nargs="?", help="Skill name to import (omit with --scan)"
    )
    p_remote_import.add_argument("--remote", required=True, help="Remote id")
    p_remote_import.add_argument(
        "--scan", action="store_true", help="List import candidates instead of importing"
    )
    p_remote_import.add_argument("--json", action="store_true", help="Emit JSON (with --scan)")

    p_remote_keyscan = remote_sub.add_parser(
        "keyscan",
        help="Fetch a host's SHA256 host-key fingerprint for TOFU pinning",
    )
    p_remote_keyscan.add_argument(
        "ssh_host", metavar="ssh-host", help="SSH host/alias (e.g. hermes@moon-base)"
    )
    p_remote_keyscan.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_setup_key = remote_sub.add_parser(
        "setup-key",
        help="One-time ssh-copy-id of our pubkey to a remote (confirmed onboarding)",
    )
    p_remote_setup_key.add_argument(
        "id", nargs="?", help="Remote id (omit when using --ssh-host)"
    )
    p_remote_setup_key.add_argument(
        "--ssh-host",
        help="Raw SSH host/alias to install the key on (pre-registration; "
        "skips the registry lookup)",
    )
    p_remote_setup_key.add_argument("--json", action="store_true", help="Emit JSON")

    for _name, _help in (
        ("setup-helper",
         "Stage a connector's box-side helper install plan (printed, NOT executed)"),
        ("setup-codex-helper",
         "DEPRECATED alias for `setup-helper` (defaults --connector codex-workers)"),
    ):
        _p = remote_sub.add_parser(_name, help=_help)
        _p.add_argument(
            "id", nargs="?",
            help="Remote id (resolves the connector + ssh host for the printed commands)",
        )
        _p.add_argument(
            "--connector",
            help="Connector key, when no remote is registered yet (e.g. codex-workers)",
        )
        _p.add_argument(
            "--init", action="store_true",
            help="Generate the connector's dedicated keypair if absent (default; idempotent)",
        )
        _p.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_list_docs = remote_sub.add_parser(
        "list-docs", help="List the LIVE agent docs present on the box (SOUL/MEMORY/USER)"
    )
    p_remote_list_docs.add_argument("id", help="Remote id")
    p_remote_list_docs.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_fetch_doc = remote_sub.add_parser(
        "fetch-doc", help="Fetch a remote agent-doc's content (SOUL.md/MEMORY.md/USER.md)"
    )
    p_remote_fetch_doc.add_argument("id", help="Remote id")
    p_remote_fetch_doc.add_argument(
        "--doc", required=True, choices=_REMOTE_DOC_NAMES, help="Which agent-doc"
    )
    p_remote_fetch_doc.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_push_doc = remote_sub.add_parser(
        "push-doc",
        help="Push an edited agent-doc back to the box (content on stdin; drift-checked)",
    )
    p_remote_push_doc.add_argument("id", help="Remote id")
    p_remote_push_doc.add_argument(
        "--doc", required=True, choices=_REMOTE_DOC_NAMES, help="Which agent-doc"
    )
    p_remote_push_doc.add_argument(
        "--force", action="store_true", help="Overwrite even if the remote drifted"
    )
    p_remote_push_doc.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_health = remote_sub.add_parser(
        "health", help="Report a remote's connection health (reachable/auth/host-key)"
    )
    p_remote_health.add_argument("id", help="Remote id")
    p_remote_health.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_doctor = remote_sub.add_parser(
        "doctor", help="Detect remote risks (host-key drift, stale sidecars, unreachable, unresolved drift)"
    )
    p_remote_doctor.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_signing = remote_sub.add_parser(
        "signing-key",
        help="Bootstrap (--init) or display (--show) the hub's pinned signing pubkey (C1)",
    )
    p_remote_signing.add_argument(
        "--init", action="store_true",
        help="Generate the hub signing keypair + pin its pubkey in the registry",
    )
    p_remote_signing.add_argument(
        "--show", action="store_true", help="Show the pinned signing pubkey (default)"
    )
    p_remote_signing.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_revoke = remote_sub.add_parser(
        "revoke-key",
        help="Surgically remove THIS connector's hub-installed authorized_keys line "
        "on the box (H2.1; inverse of the key install — idempotent)",
    )
    p_remote_revoke.add_argument("id", help="Remote id")
    p_remote_revoke.add_argument(
        "--yes", action="store_true", help="Skip the confirm prompt (headless)"
    )
    p_remote_revoke.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_repin = remote_sub.add_parser(
        "repin",
        help="Audited host-key rotation — re-pin a legitimately rotated host key "
        "(H2.2; shows OLD→NEW, re-seeds known_hosts, audit-logged)",
    )
    p_remote_repin.add_argument("id", help="Remote id")
    p_remote_repin.add_argument(
        "--accept", help="Pin this exact fingerprint (SHA256:...) instead of the live scan",
    )
    p_remote_repin.add_argument(
        "--yes", action="store_true", help="Accept the live-scanned key without prompting (headless)"
    )
    p_remote_repin.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_pin = remote_sub.add_parser(
        "pin",
        help="Pin (or re-pin) a remote's host key by a live keyscan — recovery for "
        "an unpinned or rotated key; refuses to replace a DIFFERENT pin without --yes",
    )
    p_remote_pin.add_argument("id", help="Remote id")
    p_remote_pin.add_argument(
        "--accept", help="Pin this exact fingerprint (SHA256:...) instead of the live scan",
    )
    p_remote_pin.add_argument(
        "--yes", action="store_true",
        help="Confirm replacing a DIFFERENT existing pin (the possible-MITM case)",
    )
    p_remote_pin.add_argument("--json", action="store_true", help="Emit JSON")

    p_remote_probe = remote_sub.add_parser(
        "probe",
        help="Cheap pre-registration auth probe against a raw ssh-host (wizard "
        "Test connection); JSON only",
    )
    p_remote_probe.add_argument("--ssh-host", dest="ssh_host", required=True, help="user@host or ssh alias")
    p_remote_probe.add_argument("--host-key", dest="host_key", help="Pinned SHA256 fingerprint to enforce")
    p_remote_probe.add_argument("--json", action="store_true", help="Emit JSON (default)")

    p_remote_rotate = remote_sub.add_parser(
        "rotate-token",
        help="Rotate a connector's keychain token (H2.4; no-op for SSH connectors "
        "with no token — new token on stdin for a gateway connector)",
    )
    p_remote_rotate.add_argument("id", help="Remote id")
    p_remote_rotate.add_argument("--json", action="store_true", help="Emit JSON")

    binding = remote_sub.add_parser("binding", help="Manage project references for a headless receiver")
    binding_sub = binding.add_subparsers(dest="binding_cmd", required=True)
    for verb in ("list", "add", "remove", "acknowledge", "confirm"):
        command = binding_sub.add_parser(verb)
        command.add_argument("id", help="Remote id")
        command.add_argument("--json", dest="json", action="store_true")
        if verb != "list":
            command.add_argument("binding", help="Stable binding id")
        if verb == "confirm":
            command.add_argument("--checkout", required=True, help="Existing receiver checkout path to confirm")
        if verb == "add":
            command.add_argument("--project", dest="project", required=True)
            command.add_argument("--destination-key", dest="destination_key", required=True)
        if verb in ("add", "acknowledge"):
            command.add_argument("--harnesses", dest="binding_harnesses", required=verb == "add",
                                 help="Comma-separated providers selected for this receiver")
            command.add_argument("--source-remote", dest="source_remote",
                                 help="Live source-project remote when metadata is absent")
            mode = command.add_mutually_exclusive_group(required=True)
            mode.add_argument("--manual", dest="manual", action="store_true")
            mode.add_argument("--destination-repository-json", dest="destination_repository_json")

    defaults = remote_sub.add_parser("defaults", help="Polling defaults for newly configured machines")
    defaults_sub = defaults.add_subparsers(dest="remote_defaults_cmd", required=True)
    for verb in ("show", "set"):
        command = defaults_sub.add_parser(verb)
        command.add_argument("--json", dest="json", action="store_true")
        if verb == "set":
            command.add_argument("--poll-interval-seconds", dest="poll_interval_seconds", type=int, required=True)

    delivery = remote_sub.add_parser("delivery", help="Configure and run headless machine delivery")
    delivery_sub = delivery.add_subparsers(dest="remote_delivery_cmd", required=True)
    for verb in ("show", "set", "run"):
        command = delivery_sub.add_parser(verb)
        command.add_argument("--json", dest="json", action="store_true")
        if verb == "set":
            command.add_argument("--publish-on-sync", dest="publish_on_sync", required=True)



    machine = remote_sub.add_parser("machine", help="Onboard and manage a headless project receiver")
    machine_sub = machine.add_subparsers(dest="machine_cmd", required=True)
    for verb in ("list", "draft", "show", "connect", "install", "configure", "discover", "bind",
                 "preview", "approve", "start", "status", "pause", "discard", "unbind", "reconfirm", "interval"):
        command = machine_sub.add_parser(verb)
        command.add_argument("--json", action="store_true")
        if verb != "list":
            command.add_argument("id")
        if verb == "draft":
            command.add_argument("--settings-json", required=True,
                                 help="Non-secret machine settings as a JSON object")
        elif verb == "interval":
            command.add_argument("--poll-interval-seconds", dest="poll_interval_seconds", type=int, required=True)
        elif verb == "configure":
            command.add_argument("--replace-channel", dest="replace_channel", action="store_true")
        elif verb == "discover":
            command.add_argument("--root", action="append", default=None)
        elif verb in {"bind", "reconfirm"}:
            command.add_argument("--binding", required=True)
            command.add_argument("--project", required=True)
            command.add_argument("--checkout", required=True)
            command.add_argument("--harness", action="append", required=True)
            command.add_argument("--global-native", action="append", choices=("mcp", "permissions", "hooks", "agents"))
            command.add_argument("--global-agent", action="append")
            command.add_argument("--manual", action="store_true")
            command.add_argument("--remote", default="origin")
            command.add_argument("--source-remote", dest="source_remote")
        elif verb == "unbind":
            command.add_argument("--binding", required=True)
        elif verb == "approve":
            command.add_argument("--digest", required=True)
        elif verb == "start":
            command.add_argument("--plan-digest", required=True)


def dispatch(args) -> None:
    rc = getattr(args, "remote_cmd", None)
    if rc == "machine":
        cmd_remote_machine(args)
    elif rc == "list":
        cmd_remote_list(args)
    elif rc == "connectors":
        cmd_remote_connectors(args)
    elif rc == "add":
        cmd_remote_add(args)
    elif rc == "show":
        cmd_remote_show(args)
    elif rc == "diff":
        cmd_remote_diff(args)
    elif rc == "sync":
        cmd_remote_sync(args)
    elif rc == "resolve":
        cmd_remote_resolve(args)
    elif rc == "disable":
        cmd_remote_disable(args)
    elif rc == "enable":
        cmd_remote_enable(args)
    elif rc == "set-global":
        cmd_remote_set_global(args)
    elif rc == "equip":
        cmd_remote_equip(args)
    elif rc == "remove":
        cmd_remote_remove(args)
    elif rc == "clear":
        cmd_remote_clear(args)
    elif rc == "import-skill":
        cmd_remote_import_skill(args)
    elif rc == "keyscan":
        cmd_remote_keyscan(args)
    elif rc == "setup-key":
        cmd_remote_setup_key(args)
    elif rc == "setup-helper":
        cmd_remote_setup_helper(args)
    elif rc == "setup-codex-helper":
        cmd_remote_setup_codex_helper(args)
    elif rc == "list-docs":
        cmd_remote_list_docs(args)
    elif rc == "fetch-doc":
        cmd_remote_fetch_doc(args)
    elif rc == "push-doc":
        cmd_remote_push_doc(args)
    elif rc == "health":
        cmd_remote_health(args)
    elif rc == "doctor":
        cmd_remote_doctor(args)
    elif rc == "signing-key":
        cmd_remote_signing_key(args)
    elif rc == "revoke-key":
        cmd_remote_revoke_key(args)
    elif rc == "repin":
        cmd_remote_repin(args)
    elif rc == "pin":
        cmd_remote_pin(args)
    elif rc == "probe":
        cmd_remote_probe(args)
    elif rc == "rotate-token":
        cmd_remote_rotate_token(args)
    elif rc == "binding":
        cmd_remote_binding(args)
    elif rc == "defaults":
        cmd_remote_defaults(args)
    elif rc == "delivery":
        cmd_remote_delivery(args)
    else:
        p_remote.print_help()


def _remote_defaults_reply(args, *, mutate=False):
    import hub
    from skill_hub.infrastructure.remotes.remotes import remote_defaults

    registry = hub._read_registry_optional()
    if mutate:
        value = remote_defaults({"remote_defaults": {"poll_interval_seconds": args.poll_interval_seconds}})
        registry["remote_defaults"] = value
        hub_core.save_registry(registry)
    else:
        value = remote_defaults(registry)
    return {"ok": True, "defaults": value, "configured": "remote_defaults" in registry, "error": None}


@registry_mutation("remote-defaults")
def _mutate_remote_defaults(args):
    return _remote_defaults_reply(args, mutate=True)


def cmd_remote_defaults(args):
    mutation = args.remote_defaults_cmd == "set"
    try:
        reply = _mutate_remote_defaults(args) if mutation else _remote_defaults_reply(args)
    except ValueError as exc:
        reply = {"ok": False, "defaults": None, "configured": False,
                 "error": {"code": "invalid_remote_defaults", "message": str(exc), "field": "poll_interval_seconds"}}
    print(json.dumps(reply, indent=2))
    if not reply["ok"] and (mutation or not args.json):
        raise SystemExit(1)


def _delivery_reply(args, registry: dict) -> dict:
    from skill_hub.infrastructure.registry import loadout_machine
    from skill_hub.infrastructure.remotes.remotes import remote_delivery_settings

    action = args.remote_delivery_cmd
    if action == "set":
        values = {"true": True, "false": False}
        value = values.get(args.publish_on_sync.lower()) if isinstance(args.publish_on_sync, str) else None
        if value is None:
            raise ValueError("publish_on_sync must be true or false.")
        registry["remote_delivery"] = {"publish_on_sync": value}
        hub_core.save_registry(registry)
        settings = {"publish_on_sync": value}
        return {"ok": True, "settings": settings, "last_run": loadout_machine.last_delivery_run(), "error": None}

    settings = remote_delivery_settings(registry)
    if action == "run":
        last_run = loadout_machine.run_delivery(registry)
        return {"ok": True, "settings": settings, "last_run": last_run, "error": None}
    elif action != "show":
        raise ValueError("Choose delivery show, set, or run.")
    return {"ok": True, "settings": settings, "last_run": loadout_machine.last_delivery_run(), "error": None}


def cmd_remote_delivery(args):
    import hub

    try:
        with data_home_lock():
            reply = _delivery_reply(args, hub._read_registry_optional())
    except ValueError as exc:
        reply = {"ok": False, "settings": None, "last_run": None,
                 "error": {"code": "invalid_remote_delivery", "message": str(exc)}}
    except Exception:
        reply = {"ok": False, "settings": None, "last_run": None,
                 "error": {"code": "delivery_operation_failed", "message": "Delivery settings could not be updated."}}
    print(json.dumps(reply, indent=2))


def _binding_reply(args, *, mutate=False):
    import hub
    from skill_hub.infrastructure.registry import loadout_bindings
    from skill_hub.infrastructure.registry.project_repository import RepositoryError

    registry = hub._read_registry_optional()
    target = (registry.get("remotes") or {}).get(args.id)
    if not isinstance(target, dict):
        raise RepositoryError("Unknown remote.", code="unknown_remote")
    if target.get("connector") != loadout_bindings.CONNECTOR:
        raise RepositoryError("This connector does not follow project loadouts.", code="unsupported_connector")
    bindings = target.get("project_bindings", {})
    if not isinstance(bindings, dict):
        raise RepositoryError("Invalid project bindings configuration.", code="invalid_bindings")
    if mutate:
        name = args.binding
        # Validate without printing untrusted field content in a failure.
        if not isinstance(name, str) or not SLUG_RE.fullmatch(name):
            raise RepositoryError("Invalid binding id.", code="invalid_binding_id")
        exists = name in bindings
        if args.binding_cmd == "add" and exists:
            raise RepositoryError("This binding already exists.", code="binding_exists")
        if args.binding_cmd != "add" and not exists:
            raise RepositoryError("Unknown binding.", code="unknown_binding")
        if args.binding_cmd == "confirm":
            from skill_hub.application.loadout.loadout_control import confirm
            from skill_hub.infrastructure.remotes.remotes import RemoteTarget

            prior = bindings[name]
            if not isinstance(prior, dict):
                raise RepositoryError("Invalid binding configuration.", code="invalid_bindings")
            prior["confirmation"] = confirm(RemoteTarget.from_dict(args.id, target), name, prior,
                                            args.checkout, registry)
        elif args.binding_cmd == "remove":
            retired = target.setdefault("retired_bindings", {})
            if not isinstance(retired, dict):
                raise RepositoryError("Invalid retired bindings configuration.", code="invalid_bindings")
            # A later publication must send an explicit retain directive. A
            # missing manifest entry must never imply native-file cleanup.
            retired[name] = {"binding": bindings.pop(name), "disposition": "retain"}
        else:
            prior = bindings.get(name) or {}
            if not isinstance(prior, dict):
                raise RepositoryError("Invalid binding configuration.", code="invalid_bindings")
            project = args.project if args.binding_cmd == "add" else prior.get("source_project")
            key = args.destination_key if args.binding_cmd == "add" else prior.get("destination_key")
            raw = getattr(args, "destination_repository_json", None)
            try:
                destination = json.loads(raw) if raw else None
            except (ValueError, TypeError):
                raise RepositoryError("Invalid repository metadata JSON.", code="invalid_repository_metadata") from None
            proposal = loadout_bindings.proposed_binding(
                registry, project=project, destination_key=key,
                harnesses=(args.binding_harnesses.split(",") if args.binding_harnesses
                           else prior.get("harnesses", [])),
                destination_repository=destination, source_remote=args.source_remote, manual=args.manual,
            )
            if any(isinstance(other, dict) and other.get("destination_key") == key
                   for other_name, other in bindings.items() if other_name != name):
                raise RepositoryError("That destination key already has a binding.", code="destination_in_use")
            retired = target.get("retired_bindings") or {}
            if name in retired:
                raise RepositoryError("This binding has a pending retain directive.", code="binding_retiring")
            bindings[name] = proposal
        target["project_bindings"] = bindings
        hub_core.save_registry(registry)
    return {"ok": True, "target": args.id, "bindings": bindings, "error": None}


@registry_mutation("remote-binding")
def _mutate_remote_binding(args):
    return _binding_reply(args, mutate=True)


def cmd_remote_binding(args):
    from skill_hub.domain.loadout.loadout_profiles import ProfileError
    from skill_hub.infrastructure.registry.project_repository import RepositoryError

    mutation = args.binding_cmd != "list"
    try:
        reply = _mutate_remote_binding(args) if mutation else _binding_reply(args)
    except (RepositoryError, ProfileError) as exc:
        reply = {"ok": False, "target": args.id, "bindings": None,
                 "error": {"code": exc.code, "message": str(exc), "field": getattr(exc, "field", None)}}
    except (OSError, RuntimeError):
        reply = {"ok": False, "target": args.id, "bindings": None,
                 "error": {"code": "receiver_unreachable", "message": "Could not reach the receiver.", "field": None}}
    print(json.dumps(reply, indent=2))
    if not reply["ok"] and (mutation or not args.json):
        raise SystemExit(1)


def cmd_remote_list(args):
    """List configured remotes from the `remotes:` block (Wave 0: read-only).

    Wave 1 adds add/show/sync/resolve/etc.; this is the minimal lister the
    framework wave ships so `hub remote list` is wired end-to-end.
    """
    import hub
    from skill_hub.infrastructure.remotes.remotes import load_remotes

    json_out = getattr(args, "json", False)
    registry = hub._read_registry_optional()
    remotes = load_remotes(registry)

    if json_out:
        print(
            json.dumps(
                [
                    {
                        "id": r.id,
                        "connector": r.connector,
                        "sync_enabled": r.sync_enabled,
                        "apply_global_bundles": r.apply_global_bundles,
                        "ssh_host": r.ssh_host,
                        "bundles": list(r.bundles),
                        "enabled": list(r.enabled),
                    }
                    for r in remotes.values()
                ],
                indent=2,
            )
        )
        return

    if not remotes:
        print(c("no remotes configured", DIM))
        return

    print(f"\n{c('Remotes', BOLD, CYAN)}\n")
    header = f"{'REMOTE':<20}{'CONNECTOR':<14}{'SYNC':<8}HOST"
    print(c(header, BOLD))
    for r in remotes.values():
        sync = c("on", GREEN) if r.sync_enabled else c("off", DIM)
        host = r.ssh_host or c("(none)", DIM)
        print(f"{r.id:<20}{r.connector:<14}{sync:<17}{host}")
    print()


def cmd_remote_connectors(args):
    """List every registered connector + its metadata (read-only, no lock).

    Runs discovery (builtin/private/entry-point/drop-in) and emits one row per
    connector with `key/label/description/transport_kind/publishable/available/
    source`. `available` is True for every registered connector — the disabled
    "More connectors" placeholder is a UI-only concept. Drives the app's
    registry-derived connector cards via a Tauri marshal command.
    """
    from skill_hub.infrastructure.connectors import all_connectors, connector_source

    conns = all_connectors()
    rows = [
        {
            "key": key,
            "label": conn.display_label,
            "description": getattr(conn, "description", "") or "",
            "transport_kind": getattr(conn, "transport_kind", "ssh") or "ssh",
            "deployment_kind": getattr(conn, "deployment_kind", "artifacts"),
            "publishable": bool(getattr(conn, "publishable", False)),
            "available": True,
            "source": connector_source(key),
        }
        for key, conn in sorted(conns.items())
    ]

    if getattr(args, "json", False):
        print(json.dumps(rows, indent=2))
        return

    if not rows:
        print(c("no connectors registered", DIM))
        return

    print(f"\n{c('Connectors', BOLD, CYAN)}\n")
    header = f"{'KEY':<24}{'TRANSPORT':<12}{'PUBLISHABLE':<13}{'SOURCE':<12}LABEL"
    print(c(header, BOLD))
    for r in rows:
        pub = c("yes", GREEN) if r["publishable"] else c("no", DIM)
        print(
            f"{r['key']:<24}{r['transport_kind']:<12}{pub:<22}"
            f"{r['source']:<12}{r['label']}"
        )
    print()


@registry_mutation("remote-add")
def cmd_remote_add(args):
    """Register a remote (references only — secrets stay in the OS keychain)."""
    from skill_hub.infrastructure.remotes.remotes import RemoteTarget

    registry = hub_core.load_registry()
    remotes = registry.setdefault("remotes", {})
    rid = args.id
    if rid in remotes:
        fail(f"Remote '{rid}' already exists. Use `hub remote remove {rid}` first.")

    transport = {}
    if getattr(args, "ssh_host", None):
        transport["ssh_host"] = args.ssh_host

    # HTTP/MCP connectors (goalrunner-orchestrator) carry an https endpoint in the
    # transport dict. Enforce https up front so the bearer token can never travel
    # in the clear (fail-closed, parallel to the transport's own guard).
    endpoint = getattr(args, "endpoint", None)
    if endpoint:
        if not str(endpoint).lower().startswith("https://"):
            fail(f"--endpoint must be an https:// URL (got {endpoint!r}); the bearer "
                 "token must never travel over plaintext.")
        transport["endpoint"] = endpoint

    # --token-ref: the keychain handle the connector resolves the bearer token from
    # at call time. The registry stores ONLY the ref (secret_ref) — never the token
    # bytes. If --token (or stdin) supplies a value, store it under the ref now.
    token_ref = getattr(args, "token_ref", None)
    secret_ref = getattr(args, "secret_ref", None) or token_ref
    if token_ref:
        from skill_hub.infrastructure.connectors.transport import keychain

        token_value = getattr(args, "token", None)
        if token_value is None and not sys.stdin.isatty():
            token_value = sys.stdin.readline().rstrip("\n")
        if token_value:
            try:
                keychain.set_secret(token_ref, token_value)
                print(f"  {c('✓', GREEN)} stored bearer token in keychain under {c(token_ref, BOLD)}")
            except Exception as e:
                fail(f"failed to store token in keychain: {e}")
        else:
            print(
                f"  {c('·', DIM)} no token value provided (pass --token or pipe via stdin) — "
                f"registered the ref {token_ref!r} only; store the token before syncing"
            )

    # H2.3 multi-host-key pin: --host-key may be repeated and/or comma-separated.
    # Collapse to a single string when one pin, a list when several.
    host_key = _normalize_host_key_arg(getattr(args, "host_key", None))

    # M1: custom (non-publishable) or root-transport connectors default
    # sync_enabled=false so a UI skill-toggle can't silently trigger a privileged
    # remote write. Hermes (publishable, non-root) keeps default-on. An explicit
    # --sync / --no-sync always wins.
    sync_enabled = _default_sync_enabled(
        args.connector,
        explicit_sync=getattr(args, "sync", False),
        explicit_no_sync=getattr(args, "no_sync", False),
    )

    # D15: per-remote opt-in for global-bundle inheritance, default OFF. A new
    # remote inherits NO global-scope bundle skills unless --apply-global is set.
    apply_global = bool(getattr(args, "apply_global", False))

    target = RemoteTarget(
        id=rid,
        connector=args.connector,
        transport=transport,
        secret_ref=secret_ref,
        host_key_sha256=host_key,
        home=getattr(args, "home", None),
        sync_enabled=sync_enabled,
        apply_global_bundles=apply_global,
        bundles=tuple(_split_csv(getattr(args, "bundles", None))),
        enabled=tuple(_split_csv(getattr(args, "enabled", None))),
    )
    remotes[rid] = target.to_dict()
    hub_core.save_registry(registry)
    print(f"  {c('✓', GREEN)} registered remote {c(rid, BOLD)} (connector: {args.connector})")
    print(
        f"  {c('·', DIM)} apply_global_bundles={apply_global} "
        f"({'inherits' if apply_global else 'does NOT inherit'} global-scope bundle skills)"
    )
    if not target.host_key_sha256:
        print(f"  {c('!', YELLOW)} no host-key pin set — add one before syncing (TOFU)")
    if not sync_enabled:
        print(
            f"  {c('·', DIM)} sync_enabled=false (custom/root-transport connectors "
            f"default off — enable with `hub remote enable {rid}` or re-add with --sync)"
        )


def _normalize_host_key_arg(value):
    """Normalize a repeated/comma-separated --host-key arg → None | str | list[str].

    `argparse action="append"` yields a list (or None). Each element may itself be
    comma-separated. One pin collapses to a bare string (the legacy shape); two or
    more become a list (H2.3 multi-key).
    """
    if not value:
        return None
    fprs: list[str] = []
    items = value if isinstance(value, list) else [value]
    for item in items:
        for part in str(item).split(","):
            part = part.strip()
            if part and part not in fprs:
                fprs.append(part)
    if not fprs:
        return None
    return fprs[0] if len(fprs) == 1 else fprs


def _default_sync_enabled(connector: str, *, explicit_sync: bool, explicit_no_sync: bool) -> bool:
    """M1: decide a new remote's default sync_enabled.

    Explicit --no-sync / --sync always win. Otherwise default OFF for a connector
    that is non-publishable (custom) OR uses a root transport (codex-workers);
    default ON for a publishable non-root connector (Hermes).
    """
    if explicit_no_sync:
        return False
    if explicit_sync:
        return True
    return not _connector_defaults_sync_off(connector)


def _connector_defaults_sync_off(connector: str) -> bool:
    """True when a connector should default to sync_enabled=false (M1).

    A connector defaults OFF if it is non-publishable (custom) OR root-transport.
    Resolution is best-effort against the registered connector instance; an
    unknown connector is treated as custom (off) to fail safe.
    """
    from skill_hub.infrastructure.connectors import all_connectors

    conn = all_connectors().get(connector)
    if conn is None:
        return True  # unknown → treat as custom, default off (fail safe)
    if getattr(conn, "deployment_kind", "artifacts") == "project-loadouts":
        return True  # activation follows confirmed setup and a verified first receipt
    if not getattr(conn, "publishable", False):
        return True  # custom / private connector
    # Root-transport connectors (e.g. codex-workers) also default off, even if a
    # future one were marked publishable.
    if getattr(conn, "root_transport", False):
        return True
    return False


def _split_csv(value) -> list:
    if not value:
        return []
    return [v.strip() for v in str(value).split(",") if v.strip()]


def _require_remote(registry: dict, rid: str):
    from skill_hub.infrastructure.remotes.remotes import load_remotes

    remotes = load_remotes(registry)
    if rid not in remotes:
        fail(f"Unknown remote '{rid}'.")
    return remotes[rid]


def cmd_remote_show(args):
    """Show one remote's config + resolved skills (read-only)."""
    import hub
    from skill_hub.infrastructure.remotes.remotes import resolve_remote_skills

    registry = hub._read_registry_optional()
    target = _require_remote(registry, args.id)
    remote_cfg = (registry.get("remotes") or {}).get(args.id) or {}
    resolved = resolve_remote_skills(remote_cfg, registry)
    info = {
        "id": target.id,
        "connector": target.connector,
        "ssh_host": target.ssh_host,
        "host_key_pinned": bool(target.host_key_sha256),
        "secret_ref": target.secret_ref,
        "home": target.home,
        "sync_enabled": target.sync_enabled,
        "apply_global_bundles": target.apply_global_bundles,
        "bundles": list(target.bundles),
        "enabled": list(target.enabled),
        "resolved_skills": resolved,
    }
    if getattr(args, "json", False):
        print(json.dumps(info, indent=2))
        return
    print(f"\n{c('Remote', BOLD, CYAN)} {c(target.id, BOLD)}\n")
    print(f"  connector:    {target.connector}")
    print(f"  ssh_host:     {target.ssh_host or c('(none)', DIM)}")
    print(f"  host-key pin: {'yes' if target.host_key_sha256 else c('no', YELLOW)}")
    print(f"  secret_ref:   {target.secret_ref or c('(none)', DIM)}")
    print(f"  home:         {target.home or c('(connector default)', DIM)}")
    print(f"  sync_enabled: {target.sync_enabled}")
    print(f"  apply_global: {target.apply_global_bundles}")
    print(f"  bundles:      {', '.join(target.bundles) or c('(none)', DIM)}")
    print(f"  enabled:      {', '.join(target.enabled) or c('(none)', DIM)}")
    print(f"  resolved:     {', '.join(resolved) or c('(none)', DIM)}")
    print()


def cmd_remote_diff(args):
    """Read-only plan: per-artifact drift status. Performs NO remote writes."""
    import hub
    from skill_hub.infrastructure.connectors import get_connector

    registry = hub._read_registry_optional()
    target = _require_remote(registry, args.id)
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))

    health = connector.health_check(target)
    if not health.ok:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "reachable": health.reachable,
                              "authenticated": health.authenticated,
                              "host_key_match": health.host_key_match,
                              "ready": getattr(health, "ready", True),
                              "detail_kind": getattr(health, "detail_kind", "") or "",
                              "ok": False, "detail": health.detail}, indent=2))
        else:
            print(
                f"  {c('!', YELLOW)} {args.id} not ready "
                f"(reachable={health.reachable} auth={health.authenticated} "
                f"host_key={health.host_key_match}): {health.detail}"
            )
        return

    remote_cfg = (registry.get("remotes") or {}).get(args.id) or {}
    desired = hub.build_remote_desired_state(remote_cfg, registry)
    plan = connector.plan(target, desired)
    rows = [
        {"name": a.name, "kind": a.kind, "action": a.action.value,
         "drift": a.drift_status.value if a.drift_status else None}
        for a in plan.actions
    ]
    if getattr(args, "json", False):
        print(json.dumps({"remote": args.id, "actions": rows}, indent=2))
        return
    print(f"\n{c('Plan for', BOLD, CYAN)} {c(args.id, BOLD)} (no writes)\n")
    if not rows:
        print(f"  {c('·', DIM)} nothing to do")
    for r in rows:
        print(f"  {r['kind']:<10} {r['name']:<24} {r['action']:<20} {r['drift'] or ''}")
    print()


def cmd_remote_sync(args):
    """Sync one remote now (honors non-clobber; --force ignores sync_enabled)."""
    import hub

    registry = hub_core.load_registry()
    target = _require_remote(registry, args.id)
    if not target.sync_enabled and not getattr(args, "force", False):
        fail(
            f"Remote '{args.id}' has sync_enabled=false. "
            f"Use `hub remote sync {args.id} --force` to sync anyway."
        )
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    installed = _harnesses.detect_installed()
    strict = bool(getattr(args, "strict", False))
    alarming = hub._run_remote_dispatch(registry, installed, only=args.id, strict=strict)
    if strict and alarming:
        print(f"\n{c('✗ remote sync: alarming failure(s)', RED, BOLD)} ({alarming})\n")
        sys.exit(2)
    print(f"\n{c('✓ remote sync complete', GREEN, BOLD)}\n")


@registry_mutation("remote-resolve")
def cmd_remote_resolve(args):
    """Explicit, non-destructive resolution of a drifted/conflicting artifact.

    push        — force-push local content to the remote (widens allow set)
    pull        — adopt remote content back into the hub (re-base sidecar)
    keep-local  — re-base the sidecar to local so the artifact reads in-sync
    keep-remote — re-base the sidecar to the remote sha (accept the agent's edit)
    """
    import hub
    from skill_hub.infrastructure.connectors import Action, get_connector
    from skill_hub.infrastructure.connectors import hermes as _hermes
    from skill_hub.infrastructure.connectors import sidecar as _sidecar
    from skill_hub.infrastructure.connectors.layouts import agentskills

    # F2: validate the artifact name BEFORE any local or remote path is built.
    # The `pull` op adopts the remote tree into `hub_skills_dir()/<name>` and
    # re-bases a sidecar keyed on the name; an unvalidated `../../tmp/x` would
    # write a local dir outside the skills dir and poison the sidecar with a
    # traversal name. Mirror `import-skill`'s slug guard for skills; doc/mcp
    # names are not slugs (e.g. `MEMORY.md`) so they are constrained to the
    # known doc set / a slash-free server name instead.
    if args.kind == "skill":
        validate_slug(args.artifact, "artifact")
    elif args.kind == "agent_doc":
        from skill_hub.infrastructure.connectors.hermes import DOC_PATHS as _DOC_PATHS
        if args.artifact not in _DOC_PATHS:
            fail(
                f"Unknown agent doc '{args.artifact}'. "
                f"Expected one of: {', '.join(sorted(_DOC_PATHS))}."
            )
    else:  # mcp — a bare server name, never a path
        if "/" in args.artifact or ".." in args.artifact.split("/"):
            fail(f"Invalid mcp server name '{args.artifact}'.")

    registry = hub_core.load_registry()
    target = _require_remote(registry, args.id)
    connector = get_connector(target.connector)
    health = connector.health_check(target)
    if not health.ok:
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    name = args.artifact
    kind = args.kind
    surface = {"skill": "skills", "mcp": "mcp", "agent_doc": "docs"}[kind]
    op = args.op

    remote_cfg = (registry.get("remotes") or {}).get(args.id) or {}
    desired = hub.build_remote_desired_state(remote_cfg, registry)
    desired_item = next(
        (d for d in desired.items() if d.kind == kind and d.name == name), None
    )

    if op == "push":
        if desired_item is None:
            fail(f"No local artifact '{name}' to push.")
        plan = connector.plan(target, desired)
        # Force-push THIS artifact only: `force_names={name}` writes the local
        # payload regardless of drift/conflict and re-bases the sidecar so the
        # drift clears; every co-drifted sibling is left untouched. `allow` stays
        # at the normal write set — forcing does not widen it for other names.
        result = connector.apply(
            target,
            plan,
            allow=frozenset({Action.CREATE, Action.FAST_FORWARD}),
            force_names=frozenset({name}),
        )
        wrote = name in result.forced or name in result.created or name in result.fast_forwarded
        if wrote:
            print(f"  {c('✓', GREEN)} push resolved (forced) — re-run `hub remote diff {args.id}` to confirm")
            return
        # Honest failure: the artifact was NOT written (e.g. remote unreachable
        # mid-apply, or a per-artifact error) — never print a misleading success.
        err = next((e for e in result.errors if e.startswith(f"{name}:")), None)
        if err:
            fail(f"Push failed for '{name}': {err.split(':', 1)[1].strip()}")
        fail(
            f"Push did not write '{name}' (remote unreachable or nothing to push) — "
            f"re-run `hub remote diff {args.id}` to inspect."
        )

    if op in ("pull", "keep-remote"):
        # Fetch the remote artifact + adopt/re-base.
        from skill_hub.infrastructure.connectors.transport import audit as _audit

        home = connector._resolve_home(target, connector._transport(target))
        paths = _hermes._Paths(home)
        if kind == "skill":
            ref = paths.managed_skill_dir(name)
            blob = connector.pull_artifact(target, ref)
            tree = _hermes._decode_skill_tree(name, blob)
            remote_sha = agentskills.tree_sha256(tree)
            if op == "pull":
                # M2 confirm-on-pull: adopting a remote/agent-edited skill brings
                # UNAUTHENTICATED LLM output (OWASP LLM05) into the hub where it
                # can re-propagate via sync. Show a summary + require explicit
                # confirmation (or --yes for headless). NEVER auto-adopt.
                existing = (registry.get("skills") or {}).get(name)
                print(f"\n{c('Pull remote-agent-edited content', BOLD, YELLOW)}")
                print(f"  skill:    {c(name, BOLD)}")
                print(f"  origin:   remote:{args.id}")
                print(f"  remote sha256: {remote_sha}")
                print(f"  files:    {len(tree.files)} ({', '.join(sorted(tree.files)[:6])}"
                      f"{' …' if len(tree.files) > 6 else ''})")
                print("  scope:    project-specific (quarantined — never global)")
                if existing:
                    print(f"  {c('!', YELLOW)} overwrites the existing hub skill {name!r}")
                if not getattr(args, "yes", False) and not hub._confirm(
                    "Adopt this remote-agent-authored content into the hub?"
                ):
                    fail("Pull aborted — no content adopted.")
                # Adopt the remote tree into the hub skill dir + registry.
                dest = hub.hub_skills_dir() / name
                dest.mkdir(parents=True, exist_ok=True)
                agentskills.write_skill_dir(dest, tree)
                skills = registry.setdefault("skills", {})
                entry = skills.get(name) or {}
                entry.setdefault("version", "1.0.0")
                entry["source"] = collapse_home(dest)
                entry["type"] = "claude-skill"
                # M2 quarantine: FORCE project-specific (never global) so a
                # poisoned pull-back can't fan out via global bundles — even if a
                # prior entry was global.
                entry["scope"] = "project-specific"
                entry["origin"] = f"remote:{args.id}"
                skills[name] = entry
                hub_core.save_registry(registry)
                # M2 provenance: tag the content as remote-agent-origin in the
                # audit log so a doctor can later flag a global skill carrying
                # agent-authored bytes.
                _audit.append(
                    args.id, "pull-adopt", f"skill:{name}",
                    sha_after=remote_sha,
                    detail="remote-agent-origin: adopted into hub (scope=project-specific)",
                )
                print(f"  {c('✓', GREEN)} pulled {name} into the hub (origin: remote:{args.id}, quarantined)")
        else:
            ref = name if kind == "mcp" else paths.doc_path(name)
            data = connector.pull_artifact(target, ref)
            remote_sha = hashlib.sha256(data).hexdigest()
            print(f"  {c('✓', GREEN)} fetched remote {kind} {name} ({len(data)} bytes)")
        # Re-base the sidecar to the remote sha.
        sc = _sidecar.read_sidecar(args.id, surface)
        sc.record(name, kind, remote_sha)
        _sidecar.write_sidecar(sc)
        print(f"  {c('✓', GREEN)} sidecar re-based to remote content")
        return

    if op == "keep-local":
        if desired_item is None:
            fail(f"No local artifact '{name}' to keep.")
        sc = _sidecar.read_sidecar(args.id, surface)
        sc.record(name, kind, desired_item.sha256)
        _sidecar.write_sidecar(sc)
        print(
            f"  {c('✓', GREEN)} sidecar re-based to local content — next sync "
            f"reads {name} as local-ahead and fast-forwards it"
        )
        return


@registry_mutation("remote-disable")
def cmd_remote_disable(args):
    registry = hub_core.load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")
    remotes[args.id]["sync_enabled"] = False
    hub_core.save_registry(registry)
    print(f"  {c('✓', GREEN)} {args.id} sync disabled")
    # H2.1: offer the credential off-boarding step (the box still trusts the
    # hub's key until it is revoked). Honored only when --revoke-key is passed,
    # else just a hint so the user knows the follow-up exists.
    if getattr(args, "revoke_key", False):
        cmd_remote_revoke_key(args)
    else:
        print(
            f"  {c('·', DIM)} the box still trusts the hub's key — run "
            f"`hub remote revoke-key {args.id}` (or re-run with --revoke-key) to off-board it"
        )


@registry_mutation("remote-enable")
def cmd_remote_enable(args):
    registry = hub_core.load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")
    remotes[args.id]["sync_enabled"] = True
    hub_core.save_registry(registry)
    print(f"  {c('✓', GREEN)} {args.id} sync enabled")


@registry_mutation("remote-set-global")
def cmd_remote_set_global(args):
    """Flip a remote's `apply_global_bundles` flag (D15).

    `hub remote set-global <id> on|off`. When off (the default), the remote
    inherits NO global-scope bundle skills — only its own bundles + enabled.
    Consistent with `remote enable`/`disable` (the sync toggle).
    """
    state = str(getattr(args, "state", "")).lower()
    # Accept the positional on|off, or an explicit --apply-global on|off.
    explicit = getattr(args, "apply_global", None)
    if explicit is not None:
        state = str(explicit).lower()
    truthy = {"on", "true", "yes", "1"}
    falsy = {"off", "false", "no", "0"}
    if state not in truthy and state not in falsy:
        fail("expected on|off (or --apply-global on|off)")
    value = state in truthy

    registry = hub_core.load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")
    remotes[args.id]["apply_global_bundles"] = value
    hub_core.save_registry(registry)
    print(
        f"  {c('✓', GREEN)} {args.id} apply_global_bundles="
        f"{c('on' if value else 'off', GREEN if value else DIM)} "
        f"({'inherits' if value else 'does NOT inherit'} global-scope bundle skills)"
    )


@registry_mutation("remote-equip")
def cmd_remote_equip(args):
    """`hub remote equip <id> --kind {bundle|skill} --name <name> --state {on|off}`.

    Registry-only toggle of a remote's equipped bundles/skills (D8). Validates the
    remote id and that <name> exists in the registry (bundle in `bundles:`, skill
    in `skills:`); adds/removes it from the remote's `bundles`/`enabled` array.
    NEVER pushes to the box — the remote is reconciled by the next `hub sync` /
    `hub remote sync`. Idempotent (on when present, off when absent).
    """
    kind = args.kind
    name = args.name
    on = args.state == "on"

    registry = hub_core.load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")

    if kind == "bundle":
        if name not in (registry.get("bundles") or {}):
            fail(f"Unknown bundle '{name}'.")
        field = "bundles"
    elif kind == "skill":
        if name not in (registry.get("skills") or {}):
            fail(f"Unknown skill '{name}'.")
        field = "enabled"
    else:
        fail(f"Unknown kind '{kind}' (expected bundle|skill).")

    remote_cfg = remotes[args.id]
    current = list(remote_cfg.get(field) or [])
    if on:
        if name not in current:
            current.append(name)
    else:
        current = [x for x in current if x != name]
    remote_cfg[field] = current
    hub_core.save_registry(registry)

    result = {
        "ok": True,
        "bundles": list(remote_cfg.get("bundles") or []),
        "enabled": list(remote_cfg.get("enabled") or []),
    }
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    else:
        state_str = c("on", GREEN) if on else c("off", DIM)
        print(f"  {c('✓', GREEN)} {args.id}: {kind} {c(name, BOLD)} {state_str}")
    return result


@registry_mutation("remote-remove")
def cmd_remote_remove(args):
    """Unregister a remote: drop the registry entry + its ownership sidecars.

    Never touches the remote box — this is a local de-registration only.
    """
    from skill_hub.infrastructure.connectors import sidecar as _sidecar

    registry = hub_core.load_registry()
    remotes = registry.get("remotes") or {}
    if args.id not in remotes:
        fail(f"Unknown remote '{args.id}'.")

    # H2.1: optionally off-board the credential on the box BEFORE dropping the
    # registry entry (we need the entry to resolve the transport + key material).
    if getattr(args, "revoke_key", False):
        cmd_remote_revoke_key(args)

    del remotes[args.id]
    hub_core.save_registry(registry)
    for surface in ("skills", "mcp", "docs"):
        _sidecar.delete_sidecar(args.id, surface)
    print(f"  {c('✓', GREEN)} removed remote {args.id} (registry entry + sidecars)")
    if not getattr(args, "revoke_key", False):
        print(
            f"  {c('·', DIM)} the box may still trust the hub's key — "
            f"manual off-boarding: see docs/remote-connectors.md (revoke-key was not run)"
        )


def cmd_remote_clear(args):
    """Forget hub ownership of a remote's artifacts (clears sidecars only).

    The remote box is NOT touched; this just makes the hub treat every remote
    artifact as unmanaged (so cleanup becomes a no-op). The registry entry stays.
    """
    import hub
    from skill_hub.infrastructure.connectors import sidecar as _sidecar

    registry = hub._read_registry_optional()
    _require_remote(registry, args.id)
    cleared = []
    for surface in ("skills", "mcp", "docs"):
        if _sidecar.delete_sidecar(args.id, surface):
            cleared.append(surface)
    if cleared:
        print(f"  {c('✓', GREEN)} cleared ownership sidecars: {', '.join(cleared)}")
    else:
        print(f"  {c('·', DIM)} no ownership sidecars to clear for {args.id}")


def cmd_remote_import_skill(args):
    """Adopt a box-native skill into the hub with provenance, or --scan candidates.

    Scan is read-only (lists never-managed box skills). Import fetches the box
    skill, registers it (scope: project-specific) with `origin: remote:<id>`, and
    NEVER mutates the box copy (D9 / skill-import spec).
    """
    import hub
    from skill_hub.infrastructure.connectors import get_connector
    from skill_hub.infrastructure.connectors import hermes as _hermes
    from skill_hub.infrastructure.connectors.layouts import agentskills

    registry = hub._read_registry_optional()
    rid = args.remote
    target = _require_remote(registry, rid)
    connector = get_connector(target.connector)

    if getattr(args, "scan", False):
        health = connector.health_check(target)
        if not health.ok:
            fail(f"Remote '{rid}' not reachable/ready: {health.detail}")
        arts = connector.list_remote_artifacts(target, "skill")
        existing = registry.get("skills") or {}
        candidates = []
        for a in arts:
            if a.managed:
                continue  # already hub-owned
            cat = "NEW" if SLUG_RE.match(a.name) else "INVALID_NAME"
            if a.name in existing:
                cat = "ALREADY_REGISTERED"
            candidates.append({
                "name": a.name,
                "ref": a.ref,
                "sha256": a.sha256,
                "category": cat,
                "origin": f"remote:{rid}",
            })
        if getattr(args, "json", False):
            print(json.dumps({"remote": rid, "candidates": candidates}, indent=2))
            return
        print(f"\n{c('Import candidates', BOLD, CYAN)} on {c(rid, BOLD)}\n")
        if not candidates:
            print(f"  {c('·', DIM)} no box-native skills to import")
        for cand in candidates:
            label = cand["name"]
            note = ""
            if cand["category"] == "INVALID_NAME":
                note = c(" (invalid name)", YELLOW)
            elif cand["category"] == "ALREADY_REGISTERED":
                note = c(" (already registered)", DIM)
            print(f"  {label}{note}  origin={cand['origin']}")
        print()
        return

    name = args.name
    if not name:
        fail("Provide a skill NAME to import, or use --scan to list candidates.")

    health = connector.health_check(target)
    if not health.ok:
        fail(f"Remote '{rid}' not reachable/ready: {health.detail}")

    if not SLUG_RE.match(name):
        fail(f"'{name}' has an invalid skill name (must match ^[a-z0-9-]+$).")

    skills = registry.get("skills") or {}
    if name in skills:
        fail(f"'{name}' is already a registered skill. Nothing to import.")

    # Locate the box-native skill (unmanaged only — never adopt a managed one here).
    arts = connector.list_remote_artifacts(target, "skill")
    match = next((a for a in arts if a.name == name and not a.managed), None)
    if match is None:
        fail(
            f"No never-managed box-native skill '{name}' found on '{rid}'. "
            f"Run `hub remote import-skill --remote {rid} --scan` to list candidates."
        )

    # Read-fetch the whole tree (NEVER mutates the box copy) and adopt locally.
    blob = connector.pull_artifact(target, match.ref)
    tree = _hermes._decode_skill_tree(name, blob)
    dest = hub.hub_skills_dir() / name
    if dest.exists():
        fail(f"{dest} already exists — refusing to overwrite.")
    dest.mkdir(parents=True, exist_ok=True)
    agentskills.write_skill_dir(dest, tree)
    if not (dest / "SKILL.md").exists():
        shutil.rmtree(dest, ignore_errors=True)
        fail("Fetched skill has no SKILL.md; aborted (box copy untouched).")

    with data_home_lock():
        registry = hub_core.load_registry()
        skills = registry.setdefault("skills", {})
        meta = hub._parse_skill_md(dest / "SKILL.md") or {}
        skills[name] = {
            "version": meta.get("version") or "1.0.0",
            "description": meta.get("description") or "",
            "source": collapse_home(dest),
            "type": "claude-skill",
            "scope": "project-specific",
            "upstream": None,
            "origin": f"remote:{rid}",
        }
        hub_core.save_registry(registry)

    # M2 provenance: record the remote-agent origin in the audit log so a later
    # doctor can flag agent-authored bytes that reach a global scope.
    from skill_hub.infrastructure.connectors.transport import audit as _audit
    _audit.append(
        rid, "import", f"skill:{name}",
        sha_after=getattr(match, "sha256", None),
        detail="remote-agent-origin: imported into hub (scope=project-specific)",
    )

    print(f"  {c('✓', GREEN)} imported {name} into the hub (origin: remote:{rid})")
    print(f"  {c('·', DIM)} the box copy under skills/ was read, not modified (D9)")

    # Registry write is already durable; a sync-stream failure past this point
    # must never surface as an import failure. No redirect here (unlike
    # `hub skill import` / `hub source add git`): this command DOES register
    # `--json` (see `p_remote_import` above), but only for the `--scan`
    # branch, which returns well before this tail — the plain-import branch
    # below it has no JSON payload of its own — so the sync chatter stays on
    # stdout where a human expects it.
    hub._auto_sync_tail()


def _transport_for_host(ssh_host: str, *, host_key=None):
    """Build a Wave-0 SshTransport for a bare ssh-host (no registry entry yet)."""
    from skill_hub.infrastructure.connectors.transport.ssh import SshTransport

    return SshTransport(ssh_host, host_key_sha256=host_key)


def cmd_remote_keyscan(args):
    """Fetch the live SHA256 host-key fingerprint for an ssh-host (TOFU pin).

    Accepts a raw ssh-host (e.g. `hermes@moon-base`), NOT a registry id, because
    the onboarding wizard needs this BEFORE a remote is registered. Pure read —
    delegates to `SshTransport.fetch_host_key_fingerprint()`.
    """
    ssh_host = args.ssh_host
    transport = _transport_for_host(ssh_host)
    try:
        fpr = transport.fetch_host_key_fingerprint()
    except Exception as e:  # keyscan tooling missing / resolution failure
        fpr = None
        detail = str(e)
    else:
        detail = "host key fetched" if fpr else "no host key returned by ssh-keyscan"

    if getattr(args, "json", False):
        print(json.dumps({"ssh_host": ssh_host, "fingerprint": fpr, "detail": detail}, indent=2))
        return
    if fpr:
        print(f"  {c('✓', GREEN)} {ssh_host}\n  {c(fpr, BOLD)}")
    else:
        print(f"  {c('!', YELLOW)} {ssh_host}: {detail}")


def pinned_signing_pubkey(registry: dict) -> Optional[str]:
    """The hub signing PUBLIC key pinned in the registry's top-level `signing:` block.

    Returns None when no key is pinned (signing not yet initialized). The block
    holds references only — the PUBLIC key + a short `key_id`; the PRIVATE key
    never enters the registry (it lives in the 0600 hub-owned signing-key file).
    """
    block = registry.get("signing") or {}
    pub = block.get("pubkey")
    return str(pub).strip() if pub else None


def cmd_remote_signing_key(args):
    """Bootstrap (`--init`) or display (`--show`) the hub's pinned signing pubkey.

    `--init` generates the dedicated ed25519 hub signing keypair (private key in a
    0600 hub-owned file, never in the registry or on argv) and PINS the public key
    in the registry's top-level `signing:` block, parallel to a host-key pin.
    Idempotent — a second `--init` re-pins the existing pubkey. `--show` prints the
    pinned pubkey (and whether the on-disk key + ssh-keygen are present).
    """
    import hub
    from skill_hub.infrastructure.connectors import signing as _signing

    do_init = getattr(args, "init", False)
    do_show = getattr(args, "show", False)
    if not do_init and not do_show:
        do_show = True  # default action

    if do_init:
        try:
            pub = _signing.ensure_signing_key()
        except _signing.SigningUnavailable as e:
            fail(f"ssh-keygen unavailable — cannot initialize signing key: {e}")
        except _signing.SigningError as e:
            fail(f"signing key initialization failed: {e}")
        kid = _signing.key_id(pub)
        with data_home_lock():
            # Tolerate a not-yet-bootstrapped data home: seed an empty registry
            # rather than hard-failing — initializing the signing key is itself a
            # bootstrap-adjacent step.
            registry = hub._read_registry_optional()
            registry["signing"] = {"pubkey": pub, "key_id": kid}
            hub_core.save_registry(registry)
        if getattr(args, "json", False):
            print(json.dumps({"initialized": True, "pubkey": pub, "key_id": kid}, indent=2))
            return
        print(f"  {c('✓', GREEN)} hub signing key initialized + pinned in the registry")
        print(f"  {c('key_id', DIM)}  {kid}")
        print(f"  {c('pubkey', DIM)}  {pub}")
        return

    # --show
    registry = hub._read_registry_optional()
    pinned = pinned_signing_pubkey(registry)
    on_disk = _signing.get_public_key()
    available = _signing.is_available()
    if getattr(args, "json", False):
        print(json.dumps({
            "pinned_pubkey": pinned,
            "key_id": (registry.get("signing") or {}).get("key_id"),
            "on_disk_pubkey": on_disk,
            "ssh_keygen_available": available,
        }, indent=2))
        return
    print(f"\n{c('Hub signing key', BOLD, CYAN)}\n")
    if pinned:
        print(f"  pinned:   {pinned}")
        print(f"  key_id:   {(registry.get('signing') or {}).get('key_id') or ''}")
    else:
        print(f"  {c('!', YELLOW)} no signing key pinned — run `hub remote signing-key --init`")
    print(f"  on-disk:  {'yes' if on_disk else c('no', YELLOW)}")
    print(f"  ssh-keygen: {'available' if available else c('MISSING', YELLOW)}")
    print()


def cmd_remote_setup_key(args):
    """One-time `ssh-copy-id` for a remote (confirmed onboarding, D3).

    Accepts EITHER a registered remote id (resolves its ssh_host + pin) OR a raw
    ssh-host via --ssh-host — so the onboarding wizard can install the key BEFORE
    the remote is registered. Attempts to append our pubkey to the remote's
    authorized_keys via the transport's `copy_id`. On failure (no password auth /
    no existing key on a fresh box), prints the EXACT root-side
    fallback the user must run manually; it never attempts the root write itself.
    """
    import hub

    host_key = None
    ssh_host = getattr(args, "ssh_host", None)
    if ssh_host:
        # Raw-host mode (pre-registration): no registry lookup needed.
        rid_label = ssh_host
    elif not getattr(args, "id", None):
        fail("Provide a remote id or --ssh-host <host>.")
    else:
        registry = hub._read_registry_optional()
        target = _require_remote(registry, args.id)
        ssh_host = target.ssh_host
        host_key = target.host_key_sha256
        rid_label = args.id
        if not ssh_host:
            fail(f"Remote '{args.id}' has no ssh_host configured.")

    pubkey = _read_default_ssh_pubkey()
    if pubkey is None:
        detail = (
            "No SSH public key found (looked for ~/.ssh/id_ed25519.pub, "
            "~/.ssh/id_rsa.pub). Generate one first, then retry:\n\n"
            "    ssh-keygen -t ed25519\n"
        )
        if getattr(args, "json", False):
            print(json.dumps({"remote": rid_label, "ok": False, "detail": detail,
                              "no_pubkey": True,
                              "generate_cmd": "ssh-keygen -t ed25519"}, indent=2))
            sys.exit(1)
        fail(detail)

    transport = _transport_for_host(ssh_host, host_key=host_key)
    try:
        transport.copy_id(pubkey)
    except Exception as e:
        # Print the precise root-side fallback (for a fresh box where
        # `ssh hermes@` is not yet authorized).
        user = ssh_host.split("@", 1)[0] if "@" in ssh_host else "hermes"
        bare = ssh_host.split("@", 1)[-1]
        key_line = pubkey.strip()
        fallback = (
            f"ssh root@{bare} "
            f"\"mkdir -p ~{user}/.ssh && "
            f"echo '{key_line}' >> ~{user}/.ssh/authorized_keys && "
            f"chown -R {user}:{user} ~{user}/.ssh && "
            f"chmod 700 ~{user}/.ssh && chmod 600 ~{user}/.ssh/authorized_keys\""
        )
        if getattr(args, "json", False):
            print(json.dumps({"remote": rid_label, "ok": False, "detail": str(e),
                              "fallback": fallback}, indent=2))
            sys.exit(1)
        print(f"  {c('✗', RED)} ssh-copy-id to {ssh_host} failed: {e}")
        print(f"  {c('·', DIM)} If password/existing-key auth is unavailable, run as root:")
        print(f"\n    {fallback}\n")
        sys.exit(1)

    if getattr(args, "json", False):
        print(json.dumps({"remote": rid_label, "ok": True, "detail": "key installed"}, indent=2))
        return
    print(f"  {c('✓', GREEN)} pubkey installed on {ssh_host} (authorized_keys)")


def cmd_remote_setup_helper(args):
    """Stage a connector's box-side helper install (PRINTED, never executed).

    Connector-agnostic: resolves the connector (from a remote id, or an explicit
    `--connector` before the remote is registered) and asks it for a `HelperPlan`
    via the optional `setup_helper_plan()` hook — the same de-special-casing
    pattern as `setup_key_transport`. Core carries ZERO knowledge of which
    connectors need a helper or where a helper artifact lives; a connector
    self-locates its own artifact, so the plan is correct whether the plugin is
    built in, pip-installed, or a `data_home()/connectors/` drop-in.
    """
    import hub
    from skill_hub.infrastructure.connectors import get_connector

    alias = getattr(args, "deprecated_alias", None)
    if alias:
        print(
            f"  {c('!', YELLOW)} `hub remote {alias}` is deprecated — use "
            f"`hub remote setup-helper <id>`."
        )

    rid = getattr(args, "id", None)
    key = getattr(args, "connector", None)
    target = None
    if rid:
        registry = hub._read_registry_optional()
        target = _require_remote(registry, rid)
        key = key or target.connector
    if not key:
        fail("Provide a remote id (`hub remote setup-helper <id>`) or --connector <key>.")

    try:
        conn = get_connector(key)
    except KeyError:
        fail(
            f"The '{key}' connector is not available in this build (its plugin is "
            f"not installed). Local/private connector plugins are drop-ins under "
            f"{data_home() / 'connectors'} — see docs/remote-connectors.md."
        )

    try:
        plan = conn.setup_helper_plan(target)
    except SystemExit:
        raise
    except Exception as e:  # a connector-side failure must not traceback
        fail(f"Could not build the helper plan for connector '{key}': {e}")

    if plan is None:
        fail(
            f"Connector '{key}' has no box-side helper to install — "
            "`setup-helper` is not applicable for it."
        )

    if getattr(args, "json", False):
        print(json.dumps({
            "connector": key,
            "remote": rid,
            "helper_source": str(plan.helper_src),
            "install_path": plan.install_path,
            "dedicated_pubkey": plan.public_key,
            "authorized_keys_line": plan.authorized_keys_line,
            "box_commands": list(plan.box_commands),
            "notes": list(plan.notes),
            "executed": False,
        }, indent=2))
        return

    print(f"\n{c(plan.title, BOLD, CYAN)}\n")
    print(f"  {c('connector', DIM)}         {key}")
    print(f"  {c('helper source', DIM)}     {plan.helper_src}")
    print(f"  {c('install path', DIM)}      {plan.install_path}")
    if plan.public_key:
        print(f"  {c('dedicated pubkey', DIM)}  {plan.public_key}")
    if plan.box_commands:
        print(f"\n  {c('Run these on the box (user-approved; NOT executed here):', BOLD)}\n")
        for line in plan.box_commands:
            print(f"    {line}\n")
    for note in plan.notes:
        print(f"  {c('·', DIM)} {note}")
    print()


def cmd_remote_setup_codex_helper(args):
    """DEPRECATED alias for `hub remote setup-helper` (one release).

    Kept so an existing invocation keeps working; it defaults the connector to
    `codex-workers` when no remote id was given, and errors helpfully when that
    plugin is not installed or has no helper hook.
    """
    args.deprecated_alias = "setup-codex-helper"
    if not getattr(args, "id", None) and not getattr(args, "connector", None):
        args.connector = "codex-workers"
    cmd_remote_setup_helper(args)


# ─────────────────────────────────────────────────────────────────────────────
# H2 — credential lifecycle: revoke-key / repin / rotate-token
# ─────────────────────────────────────────────────────────────────────────────


def _pubkey_body(line: str) -> Optional[str]:
    """Extract the base64 key body from an authorized_keys / pubkey line.

    A pubkey is `<type> <base64-body> [comment]` possibly preceded by options
    (e.g. `command="…",restrict ssh-ed25519 AAAA… comment`). The base64 body is
    the stable identity used to match a specific key surgically — NOT the comment
    (which a user can change) and NOT the whole line (which carries options).
    """
    if not line:
        return None
    toks = line.strip().split()
    for i, tok in enumerate(toks):
        if tok.startswith(("ssh-", "ecdsa-", "sk-")) and i + 1 < len(toks):
            return toks[i + 1]
    return None


def _resolve_revoke_plan(registry: dict, target):
    """Resolve (transport, ak_path, match_pred, key_desc) for a connector's revoke.

    Returns the transport that reaches the authorized_keys file, the remote path
    of that file, a client-side line-matching predicate that surgically selects
    ONLY this connector's hub-installed line, and a human description.

    Raises (via `fail`) when the key material to match cannot be resolved.
    """
    from skill_hub.infrastructure.connectors import get_connector

    connector = target.connector

    try:
        conn = get_connector(connector)
    except KeyError:
        fail(
            f"The '{connector}' connector is not available in this build "
            "(its plugin package is not installed)."
        )

    # A connector that installs a dedicated / privileged key (e.g. codex-workers'
    # root forced-command key) resolves its own transport + surgical matcher via
    # the `setup_key_transport` hook. `None` → fall through to the generic
    # user-key path below. This removes the last connector-name conditional.
    custom = conn.setup_key_transport(target)
    if custom is not None:
        return custom

    # Hermes (and any other non-root connector): remove the hub's OWN pubkey line
    # from the connector user's ~/.ssh/authorized_keys, over the connector's own
    # transport (the hermes user).
    pub = _read_default_ssh_pubkey()
    if not pub:
        fail(
            "No local SSH public key found (looked for ~/.ssh/id_ed25519.pub, "
            "id_rsa.pub) to identify the installed authorized_keys line."
        )
    body = _pubkey_body(pub)
    transport = conn._transport(target)
    ak_path = "~/.ssh/authorized_keys"

    def match(ln: str) -> bool:
        return body is not None and body in ln

    return transport, ak_path, match, "hub pubkey (this connector's installed key)"


def cmd_remote_revoke_key(args):
    """H2.1: surgically remove THIS connector's hub-installed authorized_keys line.

    The inverse of the key install. For Hermes: drops the hub's own pubkey line
    from the hermes user's `~/.ssh/authorized_keys`. For codex-workers: drops the
    `command="…codex-skill-apply…",restrict <dedicated-pubkey>` line from root's
    authorized_keys, matched by the dedicated key body (NOT a blunt truncate —
    every other line is preserved). Idempotent. Shows the line(s) + confirms; pass
    --yes for headless.
    """
    import hub

    registry = hub._read_registry_optional()
    target = _require_remote(registry, args.id)

    transport, ak_path, match, key_desc = _resolve_revoke_plan(registry, target)

    try:
        lines = transport.read_authorized_keys(ak_path)
    except Exception as e:
        fail(f"Could not read {ak_path} on '{args.id}': {e}")

    to_remove = [ln for ln in lines if match(ln)]
    json_out = getattr(args, "json", False)

    if not to_remove:
        if json_out:
            print(json.dumps({"remote": args.id, "removed": 0,
                              "detail": "no matching line (already revoked)"}, indent=2))
        else:
            print(f"  {c('·', DIM)} {args.id}: no matching {key_desc} line — already revoked (no-op)")
        return

    if not json_out:
        print(f"\n{c('Revoke key', BOLD, YELLOW)} on {c(args.id, BOLD)} ({ak_path})\n")
        print(f"  {c('will REMOVE', RED)} ({key_desc}):")
        for ln in to_remove:
            shown = ln if len(ln) <= 100 else ln[:97] + "…"
            print(f"    {c('-', RED)} {shown}")
        print(f"  {c('keeps', GREEN)} {len(lines) - len(to_remove)} other line(s) untouched\n")

    if not getattr(args, "yes", False) and not json_out:
        if not hub._confirm(f"Remove this {key_desc} line from {args.id}?"):
            fail("Revoke aborted — no change made.")

    try:
        removed = transport.revoke_authorized_key(match, ak_path=ak_path)
    except Exception as e:
        fail(f"Revoke failed on '{args.id}': {e}")

    from skill_hub.infrastructure.connectors.transport import audit as _audit
    _audit.append(args.id, "revoke-key", key_desc, detail=f"removed {removed} authorized_keys line(s)")

    if json_out:
        print(json.dumps({"remote": args.id, "removed": removed, "key": key_desc}, indent=2))
        return
    print(f"  {c('✓', GREEN)} revoked {removed} {key_desc} line(s) on {args.id}")


def _apply_host_key_pin(
    registry, remote_id, target, transport, old_pins, new_fpr, *,
    detail_src, audit_action,
):
    """Shared apply tail for `remote pin` / `remote repin`.

    Writes the registry pin (canonical top-level `host_key_sha256`, dropping any
    stale transport-scoped copy), re-seeds the hub-owned known_hosts (drops stale
    lines, adds the new pinned line), and audit-logs the rotation under
    `audit_action` ("pin" | "repin"). The CALLER owns all UX — confirm prompts,
    JSON refusal payloads, idempotent short-circuits, exit codes — this only
    performs the mutation once the caller has decided to proceed. Returns whether
    known_hosts was re-seeded.
    """
    replacing = bool(old_pins)
    remotes = registry.setdefault("remotes", {})
    entry = remotes.get(remote_id) or {}
    entry["host_key_sha256"] = new_fpr
    if isinstance(entry.get("transport"), dict):
        entry["transport"].pop("host_key_sha256", None)
    remotes[remote_id] = entry
    hub_core.save_registry(registry)

    reseeded = _reseed_known_hosts_after_repin(target, transport, old_pins, new_fpr)

    from skill_hub.infrastructure.connectors.transport import audit as _audit
    if audit_action == "repin":
        detail = f"host-key rotation ({detail_src}); known_hosts reseeded={reseeded}"
    else:
        detail = (
            f"host-key pin ({'replaced' if replacing else 'first pin'}, {detail_src}); "
            f"known_hosts reseeded={reseeded}"
        )
    _audit.append(
        remote_id, audit_action,
        f"host-key: {', '.join(old_pins) or '(none)'} → {new_fpr}",
        sha_before=(old_pins[0] if old_pins else None),
        sha_after=new_fpr,
        detail=detail,
    )
    return reseeded


def cmd_remote_repin(args):
    """H2.2: audited host-key rotation — re-pin a legitimately rotated host key.

    Fetches the live fingerprint, shows OLD vs NEW, requires confirmation
    (--yes headless, or --accept <fpr> to pin a specific known-good value),
    replaces the registry pin, re-seeds the hub-owned known_hosts (drops the
    stale line, adds the new), and audit-logs the rotation. Without this a legit
    host rekey hard-fails every op with no recovery path.
    """
    import hub
    from skill_hub.infrastructure.connectors import get_connector

    registry = hub_core.load_registry()
    target = _require_remote(registry, args.id)
    json_out = getattr(args, "json", False)

    old_pin = target.host_key_sha256
    old_pins = []
    if isinstance(old_pin, (list, tuple)):
        old_pins = [str(p) for p in old_pin]
    elif old_pin:
        old_pins = [str(old_pin)]

    accept = getattr(args, "accept", None)
    connector = get_connector(target.connector)
    transport = connector._transport(target)

    if accept:
        new_fpr = accept.strip()
        detail_src = "operator-supplied (--accept)"
    else:
        try:
            new_fpr = transport.fetch_host_key_fingerprint()
        except Exception as e:
            fail(f"Could not fetch the live host key for '{args.id}': {e}")
        detail_src = "live host scan"
        if not new_fpr:
            fail(f"ssh-keyscan returned no host key for '{args.id}'.")

    if new_fpr in old_pins:
        if json_out:
            print(json.dumps({"remote": args.id, "repinned": False,
                              "detail": "live key already matches the pin"}, indent=2))
        else:
            print(f"  {c('·', DIM)} {args.id}: live key already matches the pin — no change")
        return

    if not json_out:
        print(f"\n{c('Host-key rotation (repin)', BOLD, YELLOW)} on {c(args.id, BOLD)}\n")
        print(f"  OLD pin: {', '.join(old_pins) or c('(none — TOFU)', DIM)}")
        print(f"  NEW pin: {c(new_fpr, BOLD)}  ({detail_src})")
        print(f"  {c('!', YELLOW)} only proceed if you KNOW this rotation is legitimate "
              f"(a rekey, not a MITM).\n")

    if not getattr(args, "yes", False) and not accept and not json_out:
        if not hub._confirm(f"Replace the host-key pin for {args.id} with {new_fpr}?"):
            fail("Repin aborted — pin unchanged.")

    # Shared tail: write the registry pin, re-seed the hub-owned known_hosts, and
    # audit-log the rotation (host_key_sha256 lives at the entry top level, the
    # canonical location).
    reseeded = _apply_host_key_pin(
        registry, args.id, target, transport, old_pins, new_fpr,
        detail_src=detail_src, audit_action="repin",
    )

    if json_out:
        print(json.dumps({"remote": args.id, "repinned": True,
                          "old_pins": old_pins, "new_pin": new_fpr,
                          "known_hosts_reseeded": reseeded}, indent=2))
        return
    print(f"  {c('✓', GREEN)} re-pinned {args.id}: now trusts {new_fpr}")
    print(f"  {c('·', DIM)} known_hosts re-seeded (stale entry dropped, new key added)")


def _reseed_known_hosts_after_repin(target, transport, old_pins, new_fpr) -> bool:
    """Drop stale host-key lines from the hub-owned known_hosts + seed the new pin.

    Returns True if the file was rewritten. Best-effort: a missing known_hosts is
    fine (the next verify() seeds it fresh). Re-fetches the live key lines and
    keeps only the line(s) whose fingerprint == the new pin.
    """
    from skill_hub.infrastructure.connectors.transport.ssh import known_hosts_path

    kh = known_hosts_path()
    # Re-scan live lines via the existing transport (its runner is the test/live
    # subprocess) and filter to the new fingerprint.
    try:
        lines = transport._scan_key_lines()  # noqa: SLF001 — our transport
    except Exception:
        lines = []

    existing = kh.read_text().splitlines() if kh.exists() else []
    # Drop any line that fingerprints to an OLD pin (stale) — keep unrelated hosts.
    stale_bodies = set()
    for ln, fpr in (lines or []):
        if fpr in old_pins:
            stale_bodies.add(ln)
    kept = [ln for ln in existing if ln.strip() and ln not in stale_bodies]

    # Add the new pinned line(s) if not already present.
    new_lines = [ln for ln, fpr in (lines or []) if fpr == new_fpr and ln not in kept]
    if not new_lines and not stale_bodies:
        # Nothing to drop and no new line obtained from the scan — leave the file;
        # the next verify() with the new pin will seed it.
        return False
    out = kept + new_lines
    kh.parent.mkdir(parents=True, exist_ok=True)
    kh.write_text(("\n".join(out) + "\n") if out else "")
    try:
        kh.chmod(0o600)
    except OSError:
        pass
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Wave 3 CLI gap closure — the subcommands the Tauri layer marshals so no ssh /
# ssh-keyscan / ssh-copy-id business logic lives in Rust (CLAUDE.md: Rust only
# marshals). All reuse the connector/transport methods; no ssh logic is
# duplicated in hub.py, and secrets never enter argv (SSH auth is via ssh-agent).
# ─────────────────────────────────────────────────────────────────────────────


def cmd_remote_pin(args):
    """R5/R8: pin (or re-pin) a remote's host key by a live keyscan — recovery path.

    Fetches the live SHA256 fingerprint (or takes `--accept <fpr>`) and writes it
    to the registry `host_key_sha256`, re-seeding the hub-owned known_hosts. This
    is the escape hatch for a remote stuck on an unpinned or a legitimately-rotated
    host key. Safety:
      * a FIRST pin (no existing pin — TOFU) applies freely;
      * an idempotent same-key pin is a no-op;
      * REPLACING a DIFFERENT existing pin is the MITM case → REFUSES unless
        `--yes` is passed, printing BOTH fingerprints.

    In `--json` mode a refusal prints `{"refused": true, ...}` and exits 0 (so the
    Tauri layer receives the payload — a non-zero exit would discard stdout); the
    plain-text path exits non-zero on refusal.
    """
    from skill_hub.infrastructure.connectors import get_connector

    registry = hub_core.load_registry()
    target = _require_remote(registry, args.id)
    json_out = getattr(args, "json", False)

    old_pin = target.host_key_sha256
    if isinstance(old_pin, (list, tuple)):
        old_pins = [str(p) for p in old_pin]
    elif old_pin:
        old_pins = [str(old_pin)]
    else:
        old_pins = []

    accept = getattr(args, "accept", None)
    connector = get_connector(target.connector)
    transport = connector._transport(target)

    if accept:
        new_fpr = accept.strip()
        detail_src = "operator-supplied (--accept)"
    else:
        try:
            new_fpr = transport.fetch_host_key_fingerprint()
        except Exception as e:
            fail(f"Could not fetch the live host key for '{args.id}': {e}")
        detail_src = "live host scan"
        if not new_fpr:
            fail(f"ssh-keyscan returned no host key for '{args.id}'.")

    # Idempotent: the live key already matches an existing pin.
    if new_fpr in old_pins:
        if json_out:
            print(json.dumps({"remote": args.id, "pinned": False, "changed": False,
                              "detail": "live key already matches the pin",
                              "fingerprint": new_fpr}, indent=2))
        else:
            print(f"  {c('·', DIM)} {args.id}: live key already matches the pin — no change")
        return

    # Replacing a DIFFERENT existing pin → MITM case; refuse without --yes.
    replacing = bool(old_pins)
    if replacing and not getattr(args, "yes", False):
        payload = {
            "remote": args.id, "pinned": False, "refused": True,
            "reason": "differing-pin", "old_pins": old_pins, "new_pin": new_fpr,
            "detail": (
                "live host key differs from the pinned fingerprint — possible MITM. "
                "Re-pin only if you KNOW this rotation is legitimate (pass --yes)."
            ),
        }
        if json_out:
            print(json.dumps(payload, indent=2))
            return
        print(f"\n{c('Host-key MISMATCH', BOLD, RED)} on {c(args.id, BOLD)}\n")
        print(f"  OLD pin: {', '.join(old_pins)}")
        print(f"  LIVE   : {c(new_fpr, BOLD)}  ({detail_src})")
        print(f"  {c('✗', RED)} refusing to re-pin without --yes (possible MITM).")
        sys.exit(1)

    # Apply: write the pin, re-seed known_hosts, audit-log (shared with repin).
    reseeded = _apply_host_key_pin(
        registry, args.id, target, transport, old_pins, new_fpr,
        detail_src=detail_src, audit_action="pin",
    )

    if json_out:
        print(json.dumps({"remote": args.id, "pinned": True, "changed": True,
                          "old_pins": old_pins, "new_pin": new_fpr,
                          "known_hosts_reseeded": reseeded}, indent=2))
        return
    print(f"  {c('✓', GREEN)} pinned {args.id}: now trusts {new_fpr}")
    if reseeded:
        print(f"  {c('·', DIM)} known_hosts re-seeded")


def cmd_remote_probe(args):
    """R10: cheap pre-registration auth probe against a raw ssh-host (wizard).

    Runs a trivial authenticated command (`ssh <host> true`) so the add-remote
    wizard can verify the box actually accepts our key BEFORE the remote is
    registered. Read-only, JSON-only. Distinguishes reachable/auth via the ssh
    stderr; a `--host-key <fpr>` (the just-pinned fingerprint) is enforced when
    present, else the probe is TOFU (unpinned).
    """
    from skill_hub.infrastructure.connectors.transport.ssh import classify_probe_exception

    ssh_host = args.ssh_host
    host_key = getattr(args, "host_key", None)
    transport = _transport_for_host(ssh_host, host_key=host_key)
    payload: dict = {"ssh_host": ssh_host}
    try:
        transport.authenticate()
    except Exception as e:
        # Shared classifier (same as health_check): a keyscan "could not read host
        # key" blip is `unreachable` (benign), only a real fingerprint mismatch is
        # `host_key_mismatch`, an auth string is `auth_failed`, else `unreachable`.
        cls = classify_probe_exception(e)
        payload.update({
            "reachable": cls.reachable,
            "authenticated": cls.authenticated,
            "ok": False,
            "detail": cls.detail,
            "detail_kind": cls.detail_kind,
        })
    else:
        payload.update({"reachable": True, "authenticated": True, "ok": True,
                        "detail": "ready", "detail_kind": "ready"})
    print(json.dumps(payload, indent=2))


def cmd_remote_rotate_token(args):
    """H2.4: rotate a connector's keychain token (Wave-5 gateway connector).

    For an SSH connector there is no bearer token (auth is via ssh-agent / the
    dedicated key), so this is a no-op-with-message today. For a future gateway
    connector carrying a `secret_ref`, it overwrites the keychain entry with a
    new value read from stdin (never argv). Wave 5 fills in the gateway side.
    """
    import hub

    registry = hub._read_registry_optional()
    target = _require_remote(registry, args.id)
    json_out = getattr(args, "json", False)

    secret_ref = target.secret_ref
    if not secret_ref:
        msg = (
            f"Remote '{args.id}' (connector {target.connector}) has no token "
            f"(secret_ref) — SSH connectors authenticate via ssh-agent / the "
            f"dedicated key, not a bearer token. Nothing to rotate."
        )
        if json_out:
            print(json.dumps({"remote": args.id, "rotated": False, "detail": msg}, indent=2))
        else:
            print(f"  {c('·', DIM)} {msg}")
        return

    # A connector that DOES carry a token (Wave-5 gateway): read the new value
    # from stdin and overwrite the keychain entry. Kept minimal here.
    from skill_hub.infrastructure.connectors.transport import keychain

    if sys.stdin.isatty():
        fail(
            f"Pipe the new token on stdin, e.g. "
            f"`printf '%s' \"$NEW_TOKEN\" | hub remote rotate-token {args.id}`."
        )
    new_value = sys.stdin.read().strip()
    if not new_value:
        fail("Empty token on stdin — nothing rotated.")
    try:
        keychain.set_secret(secret_ref, new_value)
    except Exception as e:
        fail(f"Keychain write failed for {secret_ref!r}: {e}")

    from skill_hub.infrastructure.connectors.transport import audit as _audit
    _audit.append(args.id, "rotate-token", secret_ref, detail="keychain entry overwritten")

    if json_out:
        print(json.dumps({"remote": args.id, "rotated": True, "secret_ref": secret_ref}, indent=2))
        return
    print(f"  {c('✓', GREEN)} rotated token for {args.id} (keychain entry {secret_ref})")


def _read_default_ssh_pubkey() -> Optional[str]:
    """Read the user's default SSH public key (ed25519 preferred, then RSA)."""
    ssh_dir = Path.home() / ".ssh"
    for name in ("id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"):
        p = ssh_dir / name
        if p.exists():
            try:
                text = p.read_text().strip()
            except OSError:
                continue
            if text:
                return text
    return None


def _resolve_remote_for_doc(args):
    """Shared helper: load + validate a remote, connector, and doc name."""
    import hub
    from skill_hub.infrastructure.connectors import get_connector

    registry = hub._read_registry_optional()
    target = _require_remote(registry, args.id)
    doc = args.doc
    if doc not in _REMOTE_DOC_NAMES:
        fail(f"Unknown doc '{doc}'. Expected one of: {', '.join(_REMOTE_DOC_NAMES)}.")
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))
    return registry, target, connector, doc


def cmd_remote_list_docs(args):
    """List the LIVE agent docs present on the box (SOUL.md/MEMORY.md/USER.md).

    Read-only. Surfaces each documented doc independent of any pending diff plan,
    so the UI can show fetch→edit→push for docs that exist on the box even when
    nothing is queued. Backed by `connector.list_remote_artifacts(kind=
    "agent_doc")` (which reads each doc's sha and skips absent ones).
    """
    import hub
    from skill_hub.infrastructure.connectors import get_connector

    registry = hub._read_registry_optional()
    target = _require_remote(registry, args.id)
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))

    health = connector.health_check(target)
    if not health.ok:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "ok": False,
                              "reachable": health.reachable,
                              "detail": health.detail, "docs": []}, indent=2))
            return
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    # _list_docs skips absent docs; report the full documented set with present
    # flags so the UI can show which exist vs which the box does not have yet.
    present = {a.name: a for a in connector.list_remote_artifacts(target, "agent_doc")}
    docs = []
    for name in _REMOTE_DOC_NAMES:
        art = present.get(name)
        docs.append({
            "name": name,
            "present": art is not None,
            "sha256": art.sha256 if art is not None else None,
            "managed": bool(art.managed) if art is not None else False,
        })
    if getattr(args, "json", False):
        print(json.dumps({"remote": args.id, "ok": True, "docs": docs}, indent=2))
        return
    print(f"\n{c('Agent docs', BOLD, CYAN)} on {c(args.id, BOLD)}\n")
    for d in docs:
        mark = c("✓", GREEN) if d["present"] else c("·", DIM)
        suffix = "" if d["present"] else c(" (absent)", DIM)
        print(f"  {mark} {d['name']}{suffix}")
    print()


def cmd_remote_fetch_doc(args):
    """Fetch one remote agent-doc's content (so the app editor loads real text).

    Returns the doc bytes via the connector's `fetch_artifact` against the
    resolved doc path. Read-only; never mutates the box.
    """
    from skill_hub.infrastructure.connectors import hermes as _hermes

    registry, target, connector, doc = _resolve_remote_for_doc(args)
    health = connector.health_check(target)
    if not health.ok:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "doc": doc, "ok": False,
                              "reachable": health.reachable, "detail": health.detail}, indent=2))
            return
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    home = connector._resolve_home(target, connector._transport(target))
    paths = _hermes._Paths(home)
    ref = paths.doc_path(doc)
    try:
        data = connector.fetch_artifact(target, ref)
    except Exception as e:
        if getattr(args, "json", False):
            print(json.dumps({"remote": args.id, "doc": doc, "ok": False, "detail": str(e)}, indent=2))
            return
        fail(f"Could not fetch {doc} from '{args.id}': {e}")
    text = data.decode("utf-8", "replace")
    sha = hashlib.sha256(data).hexdigest()
    if getattr(args, "json", False):
        print(json.dumps({"remote": args.id, "doc": doc, "ok": True,
                          "sha256": sha, "content": text}, indent=2))
        return
    # Raw content to stdout for non-JSON consumers/piping.
    sys.stdout.write(text)


def cmd_remote_push_doc(args):
    """Write an edited agent-doc back to the box (content via stdin).

    Atomic + backup-on-change (transport handles both). Drift-checked: if the
    remote doc has changed since the hub last fetched/pushed it (sidecar base
    sha differs from the live remote sha), the push is REFUSED unless --force,
    so an agent edit on the box is never silently clobbered (D8).
    """
    from skill_hub.infrastructure.connectors import hermes as _hermes
    from skill_hub.infrastructure.connectors import sidecar as _sidecar
    from skill_hub.infrastructure.connectors.transport import audit as _audit

    registry, target, connector, doc = _resolve_remote_for_doc(args)
    health = connector.health_check(target)
    if not health.ok:
        fail(f"Remote '{args.id}' not reachable/ready: {health.detail}")

    # Content arrives on stdin (never argv — keeps large/sensitive bodies out of
    # the process table and logs).
    content = sys.stdin.buffer.read()

    transport = connector._transport(target)
    home = connector._resolve_home(target, transport)
    paths = _hermes._Paths(home)
    ref = paths.doc_path(doc)

    remote_sha = transport.sha256(ref)
    sc = _sidecar.read_sidecar(args.id, _hermes.SURFACE_DOCS)
    base_sha = sc.base_sha(doc)
    force = getattr(args, "force", False)

    # Drift guard: the remote doc changed under us since we last touched it.
    if (
        not force
        and remote_sha is not None
        and base_sha is not None
        and remote_sha != base_sha
    ):
        fail(
            f"Refusing to push {doc}: the remote copy has drifted since the hub "
            f"last fetched it (base {base_sha[:12]}… ≠ remote {remote_sha[:12]}…). "
            f"Re-fetch and re-apply your edit, or pass --force to overwrite."
        )

    new_sha = hashlib.sha256(content).hexdigest()
    if remote_sha == new_sha:
        print(f"  {c('·', DIM)} {doc} already up to date — no write")
        # Still re-base the sidecar so future drift checks have a base.
        sc.record(doc, "agent_doc", new_sha)
        _sidecar.write_sidecar(sc)
        return

    # Atomic + backup-on-change via the transport.
    connector._guard_write_path(paths, ref)
    transport.backup_on_change(ref, content)
    transport.atomic_write(ref, content)
    _audit.append(args.id, "write", f"doc:{doc}", sha_before=remote_sha, sha_after=new_sha)

    # Re-base the sidecar to the just-pushed content (this is now the base).
    sc.record(doc, "agent_doc", new_sha)
    _sidecar.write_sidecar(sc)

    forced = " (forced over drift)" if force and base_sha and remote_sha != base_sha else ""
    print(f"  {c('✓', GREEN)} pushed {doc} to '{args.id}'{forced} ({len(content)} bytes)")


def cmd_remote_health(args):
    """Report a remote's connection health (reachable/auth/host-key-match).

    Thin wrapper over the connector's `health_check` — the dedicated subcommand
    the Tauri layer marshals (previously it had to reuse `remote diff`).
    """
    import hub
    from skill_hub.infrastructure.connectors import get_connector

    registry = hub._read_registry_optional()
    target = _require_remote(registry, args.id)
    try:
        connector = get_connector(target.connector)
    except KeyError as e:
        fail(str(e))
    health = connector.health_check(target)
    kind = getattr(health, "detail_kind", "") or ""
    payload = {
        "remote": args.id,
        "reachable": health.reachable,
        "authenticated": health.authenticated,
        "host_key_match": health.host_key_match,
        "ready": getattr(health, "ready", True),
        "detail_kind": kind,
        "ok": health.ok,
        "detail": health.detail,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    # home_missing is a NEUTRAL informative state (Hermes not installed), not the
    # RED failure `✗` reserved for auth/host-key errors.
    if health.ok:
        icon, colour = ("✓", GREEN)
    elif kind == "home_missing" or not health.reachable:
        icon, colour = ("·", YELLOW)
    else:
        icon, colour = ("✗", RED)
    print(f"  {c(icon, colour)} {args.id}  "
          f"reachable={health.reachable} auth={health.authenticated} "
          f"host_key={health.host_key_match} ready={getattr(health, 'ready', True)}")
    if health.detail:
        print(f"  {c('·', DIM)} {health.detail}")


def cmd_remote_doctor(args):
    """Detect remote-connector risks across every registered remote (task 3.2).

    Checks (per remote):
      * host-key pin mismatch — live fingerprint ≠ pinned `host_key_sha256` (DANGER)
      * unreachable `sync_enabled` remote (warning — sync silently skips it)
      * stale/orphaned sidecar entries — managed names no longer desired AND gone
        from the box (orphan ownership rot; warning)
      * never-clobber sanity — any artifact currently in `remote-drifted`/`conflict`
        that would be silently skipped (warning, so the user knows to resolve it)

    Danger findings exit non-zero (matching `permissions doctor`).
    """
    import hub
    from skill_hub.infrastructure.connectors import Action, get_connector
    from skill_hub.infrastructure.connectors import sidecar as _sidecar
    from skill_hub.infrastructure.remotes.remotes import load_remotes

    registry = hub._read_registry_optional()
    remotes = load_remotes(registry)

    findings: list[dict] = []

    def add(remote_id, code, severity, detail):
        findings.append({"remote": remote_id, "code": code,
                         "severity": severity, "detail": detail})

    # C1 signing check (SHOULD, light): a remote with hub-managed skills but no
    # pinned signing pubkey ships executable content that no verifier can attest.
    signing_pinned = bool(pinned_signing_pubkey(registry))

    for rid, target in remotes.items():
        try:
            connector = get_connector(target.connector)
        except KeyError as e:
            add(rid, "unknown-connector", "danger", str(e))
            continue

        if connector.deployment_kind == "project-loadouts":
            continue  # Machine status is explicit and uses its own protocol.

        if not signing_pinned:
            from skill_hub.infrastructure.connectors import sidecar as _sc_signing
            if _sc_signing.read_sidecar(rid, "skills").managed_names():
                add(rid, "signing-unpinned", "warning",
                    "remote has hub-managed skills but no signing pubkey is pinned "
                    "(run `hub remote signing-key --init`) — pushed skills cannot be "
                    "integrity-verified by a remote verifier")

        # --- host-key pin verification (DANGER on mismatch) ---
        pinned = target.host_key_sha256
        transport = connector._transport(target)
        if not pinned:
            add(rid, "host-key-unpinned", "warning",
                "no host_key_sha256 pin set (TOFU not completed)")
        else:
            try:
                live = transport.fetch_host_key_fingerprint()
            except Exception as e:
                live = None
                add(rid, "host-key-unreadable", "warning",
                    f"could not read live host key to verify the pin: {e}")
            if live is not None and live != pinned:
                add(rid, "host-key-mismatch", "danger",
                    f"live host key {live} != pinned {pinned} — possible MITM; "
                    f"sync will hard-fail")

        # --- reachability for sync_enabled remotes ---
        try:
            health = connector.health_check(target)
        except Exception as e:
            health = None
            add(rid, "health-error", "warning", f"health check errored: {e}")
        if health is not None:
            # NOTE: a mismatch is detected authoritatively above via the live
            # fingerprint comparison. `health.host_key_match` is ALSO False when
            # the box is merely unreachable (the pin can't be checked), so it is
            # NOT used here to avoid a false DANGER on a down box.
            if target.sync_enabled and not health.reachable:
                add(rid, "unreachable", "warning",
                    f"sync_enabled but unreachable: {health.detail}")

        # --- sidecar rot + never-clobber: only when reachable + ready ---
        if health is None or not health.ok:
            continue
        remote_cfg = (registry.get("remotes") or {}).get(rid) or {}
        try:
            desired = hub.build_remote_desired_state(remote_cfg, registry)
            plan = connector.plan(target, desired)
        except Exception as e:
            add(rid, "plan-error", "warning", f"could not compute plan: {e}")
            continue

        drifted = [a.name for a in plan.actions
                   if a.action in (Action.SKIP_REMOTE_DRIFTED, Action.SKIP_CONFLICT)]
        if drifted:
            add(rid, "unresolved-drift", "warning",
                f"{len(drifted)} artifact(s) drifted/conflicting and silently "
                f"skipped by sync: {', '.join(sorted(drifted))} — resolve with "
                f"`hub remote resolve {rid} --artifact <name> --op …`")

        # Stale/orphaned sidecar entries: managed names that are gone both from
        # the desired set AND the box (ownership rot — nothing left to clean).
        desired_names = {(d.kind, d.name) for d in desired.items()}
        for surface in ("skills", "mcp", "docs"):
            sc = _sidecar.read_sidecar(rid, surface)
            for a in sc.artifacts:
                kind = {"skills": "skill", "mcp": "mcp", "docs": "agent_doc"}[surface]
                if (kind, a.name) in desired_names:
                    continue
                # Not desired — is it still on the box? If a corresponding REMOVE
                # or NOOP action wasn't emitted as ORPHANED, the entry is stale.
                planned = next((p for p in plan.actions
                                if p.kind == kind and p.name == a.name), None)
                if planned is None:
                    add(rid, "stale-sidecar", "warning",
                        f"{surface} sidecar lists '{a.name}' but it is neither "
                        f"desired nor present on the box (stale ownership entry)")

    danger = sum(1 for f in findings if f["severity"] == "danger")
    if getattr(args, "json", False):
        print(json.dumps({"findings": findings, "danger_count": danger}, indent=2))
    else:
        print(f"\n{c('Remote doctor', BOLD, CYAN)}\n")
        if not findings:
            print(f"  {c('✓', GREEN)} no remote risks detected")
        for f in findings:
            colour = RED if f["severity"] == "danger" else YELLOW
            icon = "✗" if f["severity"] == "danger" else "!"
            print(f"  {c(icon, colour)} {f['remote']}  "
                  f"{f['code']} ({f['severity']}): {f['detail']}")
        print()
    if danger > 0:
        sys.exit(2)


def cmd_remote_machine(args) -> None:
    import hub
    from skill_hub.domain.loadout.loadout_profiles import ProfileError, strict_json
    from skill_hub.infrastructure.registry import loadout_machine
    from skill_hub.infrastructure.registry.project_repository import RepositoryError

    action = args.machine_cmd
    try:
        # Explicit machine operations never run controller sync or registry migration.
        with data_home_lock():
            registry = hub._read_registry_optional()
            if action == "list":
                result = loadout_machine.list_machines(registry)
            elif action == "show":
                result = loadout_machine.show(args.id, registry)
            elif action == "draft":
                try:
                    payload = args.settings_json.encode()
                    if len(payload) > 65536:
                        raise ValueError()
                    settings = strict_json(payload)
                except (ValueError, UnicodeError):
                    raise ProfileError("invalid_machine_input", "Expected bounded machine settings JSON.") from None
                result = loadout_machine.save(args.id, settings, registry)
            else:
                options = {
                    key: value for key, value in vars(args).items()
                    if key in {"root", "binding", "project", "checkout", "manual", "remote",
                               "source_remote", "digest", "plan_digest", "poll_interval_seconds",
                               "replace_channel"}
                }
                if action in {"bind", "reconfirm"}:
                    options["harnesses"] = args.harness
                    options["global_native"] = args.global_native
                    options["global_agents"] = args.global_agent
                result = loadout_machine.operate(args.id, action, registry, **options)
        reply = {"ok": True, "result": result, "error": None}
    except (ProfileError, RepositoryError) as exc:
        reply = {"ok": False, "result": None, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        reply = {"ok": False, "result": None, "error": {
            "code": "machine_operation_failed", "message": "Machine operation failed. Check the connection and retry."}}
    print(json.dumps(reply, indent=2))
    # JSON always reaches the app, including an actionable mutation error.
    if not args.json and not reply["ok"]:
        raise SystemExit(1)
