"""Headless receiver commands, isolated from ordinary registry sync."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

from skill_hub import hub_core
from skill_hub.domain.loadout.loadout_profiles import ProfileError, ReceiverProfiles, strict_json
from skill_hub.infrastructure.registry.project_repository import (
    RepositoryError,
    discover_checkouts,
    inspect_project_repository,
)

NAME = "receive"
p_receive = None


def register(sub) -> None:
    global p_receive
    p_receive = sub.add_parser(NAME, help="Headless loadout receiver")
    commands = p_receive.add_subparsers(dest="receive_cmd", required=True)
    for verb in (
        "init",
        "inspect",
        "discover",
        "checkout",
        "confirm",
        "configure",
        "plan",
        "approve",
        "once",
        "status",
        "pause",
        "resume",
        "timer",
    ):
        command = commands.add_parser(verb)
        command.add_argument("--json", action="store_true")
        if verb == "init":
            command.add_argument("--receiver-id", required=True)
            command.add_argument("--installation-generation")
        elif verb == "discover":
            command.add_argument("--root", action="append", default=None)
            command.add_argument("--subdirectory", action="append", default=[])
        elif verb == "checkout":
            command.add_argument("--path", required=True)
            command.add_argument("--remote", default="origin")
        elif verb == "confirm":
            command.add_argument("--binding", required=True)
            command.add_argument("--checkout", required=True)
            command.add_argument("--proposal-stdin", action="store_true", required=True)
        elif verb == "configure":
            command.add_argument("--feed-url", required=True)
            command.add_argument("--feed-id", required=True)
            command.add_argument("--poll-interval-seconds", type=int, required=True)
            command.add_argument("--publisher-key-stdin", action="store_true", required=True)
            command.add_argument("--rotate", action="store_true")
        elif verb == "approve":
            command.add_argument("--digest", required=True)
        elif verb == "once":
            command.add_argument("--expected-revision")
            command.add_argument("--expected-plan-digest")
        elif verb == "timer":
            command.add_argument("timer_cmd", choices=("install", "status"))


def _payload() -> dict:
    payload = sys.stdin.read(65537).encode()
    try:
        if len(payload) > 65536:
            raise ValueError()
        value = strict_json(payload)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        raise ProfileError("invalid_binding", "Expected a bounded JSON object on stdin.") from None


def _public_result(result: dict) -> dict:
    """Keep RPC receipts bounded; full ownership evidence stays on the receiver."""
    value = dict(result)
    for key in ("applied", "candidate"):
        record = value.get(key)
        if isinstance(record, dict):
            value[key] = {
                name: record[name]
                for name in ("feed_id", "revision", "generation", "digest", "applied_at")
                if name in record
            }
    value.pop("desired", None)
    for key in ("changes", "blockers"):
        records = value.get(key)
        if isinstance(records, list):
            value[key + "_total"] = len(records)
            value[key] = records[:200]
    return value


def dispatch(args) -> None:
    from skill_hub.application.loadout.loadout_receive import Receiver

    root = hub_core.data_home() / "state" / "loadouts"
    profiles = ReceiverProfiles(root)
    mutation = args.receive_cmd not in ("inspect", "discover", "checkout", "plan", "status")
    try:
        # The same lock covers immediate control, confirmations and timer pulls.
        with hub_core.data_home_lock():
            receiver = Receiver(root)
            verb = args.receive_cmd
            if verb == "init":
                result = profiles.initialize(args.receiver_id, args.installation_generation)
            elif verb == "inspect":
                from skill_hub.domain.loadout.loadout_native_codec import capabilities, capture_loadout_codec_context

                codec_context = capture_loadout_codec_context()

                result = {
                    "profile": profiles.read(),
                    "providers": sorted(receiver.installed),
                    "protocol": 1,
                    "native": capabilities(codec_context),
                }
            elif verb == "discover":
                result = asdict(discover_checkouts(
                    [Path(root) for root in args.root] if args.root else None, subdirectories=args.subdirectory,
                ))
            elif verb == "checkout":
                result = {"inspection": asdict(inspect_project_repository(Path(args.path), remote=args.remote))}
            elif verb == "confirm":
                result = {
                    "confirmation": profiles.confirm(
                        args.binding, _payload(), Path(args.checkout), installed=receiver.installed
                    )
                }
            elif verb == "configure":
                payload = _payload()
                if set(payload) != {"public_key"}:
                    raise ProfileError("invalid_publisher_key", "Supply only the publisher public key.")
                result = receiver.configure(
                    args.feed_url,
                    args.feed_id,
                    payload["public_key"],
                    args.poll_interval_seconds,
                    rotate=args.rotate,
                )
            elif verb == "plan":
                result = receiver.plan()
            elif verb == "approve":
                result = receiver.approve(args.digest)
            elif verb == "once":
                result = receiver.once(args.expected_revision, args.expected_plan_digest)
            elif verb == "status":
                result = receiver.status()
            elif verb in ("pause", "resume"):
                result = receiver.pause(verb == "pause")
            else:
                from skill_hub.infrastructure.loadout import loadout_timer

                if args.timer_cmd == "status":
                    result = loadout_timer.status()
                else:
                    home = Path.home()
                    launcher = home / ".local/share/skill-tree/receiver/bin/hub"
                    result = loadout_timer.install(home, launcher, receiver.status()["interval"])
        reply = {"ok": True, "result": _public_result(result), "error": None}
    except (ProfileError, RepositoryError) as exc:
        reply = {"ok": False, "result": None, "error": {"code": exc.code, "message": str(exc)}}
    except OSError:
        reply = {
            "ok": False,
            "result": None,
            "error": {"code": "receiver_io_error", "message": "Could not access receiver state."},
        }
    print(json.dumps(reply, indent=2))
    if not reply["ok"] and (mutation or not args.json):
        raise SystemExit(1)
