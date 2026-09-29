"""Resumable controller onboarding for generic headless machines.

Connection details, completed observations and feed references stay in the
private data home. Explicit actions perform remote work; reads never connect.
"""

from __future__ import annotations

import hashlib
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.application.loadout.loadout_control import bounded_runner, confirm, request
from skill_hub.application.loadout.loadout_install import install_remote
from skill_hub.application.loadout.loadout_publish import last_result, publish
from skill_hub.domain.loadout.loadout_profiles import ProfileError, atomic_json, canonical, strict_json
from skill_hub.infrastructure.connectors.signing import ensure_signing_key, key_id
from skill_hub.infrastructure.connectors.transport.ssh import SshTransport
from skill_hub.infrastructure.loadout.loadout_feed import GitFeed
from skill_hub.infrastructure.registry.loadout_bindings import proposed_binding
from skill_hub.infrastructure.remotes.remotes import RemoteTarget, remote_defaults

FIELDS = {"ssh_host", "host_key_sha256", "feed_url", "poll_interval_seconds", "private_feed_confirmed"}
_FEED_ID_RE = re.compile(r"[a-f0-9]{32}")
_PUBLISHER_KEY_ID_RE = re.compile(r"SHA256:[a-f0-9]{16}")


def _channel_conflict(status: dict, controller_key_id: str) -> dict:
    """Only validated, bounded fields cross from the receiver's status into the draft."""
    conflict: dict = {}
    feed_id = status.get("feed_id")
    if isinstance(feed_id, str) and _FEED_ID_RE.fullmatch(feed_id):
        conflict["feed_id"] = feed_id
    publisher_key_id = status.get("publisher_key_id")
    if isinstance(publisher_key_id, str) and _PUBLISHER_KEY_ID_RE.fullmatch(publisher_key_id):
        conflict["publisher_key_id"] = publisher_key_id
    applied = status.get("applied")
    if (
        isinstance(applied, dict)
        and type(applied.get("generation")) is int
        and applied["generation"] >= 1
        and isinstance(applied.get("applied_at"), str)
        and len(applied["applied_at"]) <= 64
    ):
        conflict["applied"] = {"generation": applied["generation"], "applied_at": applied["applied_at"]}
    conflict["controller_key_id"] = controller_key_id
    return conflict


def _delivery_path() -> Path:
    return hub_core.data_home() / "state" / "remotes" / "delivery.json"


def last_delivery_run() -> dict | None:
    """Read the most recent fleet receipt, treating corrupt local state as absent."""
    path = _delivery_path()
    try:
        if not path.exists() or path.is_symlink() or path.stat().st_size > 1024 * 1024:
            return None
        value = strict_json(path.read_bytes())
        if (
            not isinstance(value, dict)
            or set(value) != {"at", "results"}
            or not isinstance(value["at"], str)
            or not isinstance(value["results"], list)
        ):
            return None
        for row in value["results"]:
            if (
                not isinstance(row, dict)
                or set(row) != {"id", "state", "message"}
                or not isinstance(row["id"], str)
                or not isinstance(row["state"], str)
                or (row["message"] is not None and not isinstance(row["message"], str))
            ):
                return None
        return value
    except (OSError, UnicodeError, ValueError, TypeError):
        return None


def run_delivery(registry: dict) -> dict:
    """Publish every enabled headless receiver once, preserving each outcome."""
    results: list[dict[str, Optional[str]]] = []
    remotes = registry.get("remotes", {})
    if not isinstance(remotes, dict):
        raise ValueError("Remotes must be a mapping.")
    for remote_id, raw in remotes.items():
        if not isinstance(raw, dict) or raw.get("connector") != "headless-loadouts":
            continue
        if not isinstance(remote_id, str):
            continue
        try:
            target = RemoteTarget.from_dict(remote_id, raw)
            if not target.sync_enabled:
                results.append({"id": remote_id, "state": "paused", "message": "Delivery is paused."})
                continue
            outcome = publish(registry, target, immediate=True)
            error = outcome.get("error") or {}
            message = error.get("message") if isinstance(error, dict) else None
            results.append({"id": remote_id, "state": str(outcome.get("state", "delivery_failed")),
                            "message": message if isinstance(message, str) else None})
        except Exception:
            results.append({
                "id": remote_id,
                "state": "delivery_failed",
                "message": "Could not deliver this machine's loadout. Retry after checking its setup.",
            })
    result = {"at": datetime.now(timezone.utc).isoformat(), "results": results}
    atomic_json(_delivery_path(), result)
    return result


def _source_repositories(registry: dict):
    from skill_hub.infrastructure.registry import project_repository

    projects = (registry.get("projects") or {}) if isinstance(registry, dict) else {}
    source_rows: list[tuple[str, project_repository.RepositoryAssociation]] = []
    for name, project in projects.items():
        if not isinstance(name, str) or not isinstance(project, dict):
            continue
        try:
            saved = project.get("repository")
            if saved is None and project.get("path_unresolved"):
                continue
            sources = (
                [project_repository.validate_repository_association(saved)]
                if saved is not None
                else project_repository.inspect_project_remotes(project["path"])
            )
        except (KeyError, project_repository.RepositoryError, OSError):
            continue
        source_rows.extend((name, source) for source in sources)
    return source_rows


def _enrich_discovery(result: dict, registry: dict) -> dict:
    """Attach source-project matches without changing registry state."""
    from skill_hub.infrastructure.registry import project_repository

    result["partial"] = bool(result.get("truncated"))
    candidates = result.get("candidates")
    if not isinstance(candidates, list):
        return result
    source_rows = _source_repositories(registry)
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        matches = []
        for name, source in source_rows:
            for destination in candidate.get("remotes") or []:
                try:
                    if (project_repository.normalize_repository_url(source.url)
                            != project_repository.normalize_repository_url(destination["url"])):
                        continue
                except project_repository.RepositoryError:
                    continue
                if source.subdirectory not in candidate.get("subdirectories", ["."]):
                    result.setdefault("issues", []).append({
                        "code": "project_subdirectory_missing",
                        "message": (f"Project {name}: subdirectory {source.subdirectory} "
                                    f"is unavailable in {candidate['path']}."),
                    })
                    continue
                matches.append({
                    "source_project": name,
                    "source_remote": source.remote,
                    "destination_remote": destination["remote"],
                    "checkout_path": (str(Path(candidate["path"]) / source.subdirectory)
                                      if source.subdirectory != "." else candidate["path"]),
                    "association": {**destination, "subdirectory": source.subdirectory},
                })
        matches = list({(row["source_project"], row["source_remote"], row["destination_remote"]): row
                        for row in matches}.values())
        candidate["matches"] = matches
        if matches:
            candidate["association"] = matches[0]["association"]
    return result


def _path(machine_id: str):
    if not isinstance(machine_id, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", machine_id):
        raise ProfileError("invalid_machine_id", "Use a lowercase machine id with letters, digits and hyphens.")
    return hub_core.data_home() / "state" / "remotes" / "drafts" / (machine_id + ".json")


def read(machine_id: str) -> dict:
    path = _path(machine_id)
    try:
        if path.is_symlink() or path.stat().st_size > 1024 * 1024:
            raise ValueError()
        draft = strict_json(path.read_bytes())
        if (
            not isinstance(draft, dict)
            or set(draft) != {"schema", "id", "connector", "revision", "feed_id", "input", "observations", "phase"}
            or draft["schema"] != 1
            or draft["id"] != machine_id
            or draft["connector"] != "headless-loadouts"
            or type(draft["revision"]) is not int
            or draft["revision"] < 1
            or not isinstance(draft["input"], dict)
            or set(draft["input"]) - FIELDS
            or not isinstance(draft["observations"], dict)
        ):
            raise ValueError()
        _validate_input(draft["input"])
        return draft
    except FileNotFoundError:
        raise ProfileError("machine_not_found", "This machine draft does not exist.") from None
    except (OSError, ValueError, TypeError, KeyError):
        raise ProfileError("machine_draft_invalid", "The saved machine draft is invalid; repair it locally.") from None


def _validate_input(value: dict) -> None:
    if set(value) - FIELDS:
        raise ProfileError("invalid_machine_input", "Machine drafts accept only connection and feed settings.")
    host = value.get("ssh_host")
    if host is not None and (
        not isinstance(host, str)
        or not host
        or host.startswith("-")
        or len(host) > 255
        or any(char.isspace() or ord(char) < 32 for char in host)
    ):
        raise ProfileError("invalid_ssh_host", "Enter an SSH host or alias without command arguments.")
    pin = value.get("host_key_sha256")
    if pin is not None and (not isinstance(pin, str) or not re.fullmatch(r"SHA256:[A-Za-z0-9+/]{20,100}={0,2}", pin)):
        raise ProfileError("invalid_host_key", "Confirm a SHA256 SSH host-key fingerprint.")
    if "poll_interval_seconds" in value:
        remote_defaults({"remote_defaults": {"poll_interval_seconds": value["poll_interval_seconds"]}})
    if "feed_url" in value:
        if not isinstance(value["feed_url"], str):
            raise ProfileError("invalid_feed_url", "Enter a private Git feed URL.")
        GitFeed(_path("validation").parent / "unused", value["feed_url"], "validation")
    if "private_feed_confirmed" in value and type(value["private_feed_confirmed"]) is not bool:
        raise ProfileError("invalid_machine_input", "Confirm that the feed repository is private.")


def save(machine_id: str, changes: dict, registry: dict) -> dict:
    if not isinstance(changes, dict):
        raise ProfileError("invalid_machine_input", "Machine settings must be an object.")
    _validate_input(changes)
    existing = (registry.get("remotes") or {}).get(machine_id)
    if existing and existing.get("connector") != "headless-loadouts":
        raise ProfileError("machine_id_in_use", "An existing connector already uses this id.")
    path = _path(machine_id)
    draft = (
        read(machine_id)
        if os.path.lexists(path)
        else {
            "schema": 1,
            "id": machine_id,
            "connector": "headless-loadouts",
            "revision": 0,
            "feed_id": uuid.uuid4().hex,
            "input": remote_defaults(registry),
            "observations": {},
            "phase": "draft",
        }
    )
    if draft["observations"].get("install") and any(
        key in changes and changes[key] != draft["input"].get(key) for key in ("ssh_host", "host_key_sha256")
    ):
        raise ProfileError("machine_connection_locked", "Use a new machine id for another host or SSH identity.")
    updated = {**draft["input"], **changes}
    if updated != draft["input"] and draft["observations"].get("start") and draft["phase"] != "paused":
        raise ProfileError("machine_pause_required", "Pause delivery before changing machine settings.")
    if draft["observations"].get("configure") and updated.get("feed_url") != draft["input"].get("feed_url"):
        raise ProfileError("channel_rotation_required", "Changing a configured feed requires a new receiver identity.")
    if updated != draft["input"]:
        draft["observations"].pop("inspection", None)
        if any(updated.get(key) != draft["input"].get(key) for key in ("ssh_host", "host_key_sha256")):
            draft["observations"] = {}
            draft["phase"] = "draft"
        elif any(
            updated.get(key) != draft["input"].get(key)
            for key in ("feed_url", "private_feed_confirmed", "poll_interval_seconds")
        ):
            draft["observations"].pop("configure", None)
            draft["observations"].pop("preview", None)
            draft["phase"] = "installed" if draft["observations"].get("install") else "draft"
        draft["input"] = updated
    target = _target(draft, registry)
    if not draft["observations"].get("configure") and existing:
        value = target.to_dict()
        value["sync_enabled"] = False
        value["transport"]["receiver_ready"] = False
        registry["remotes"][machine_id] = value
        hub_core.save_registry(registry)
    draft["revision"] += 1
    atomic_json(path, draft)
    return show(machine_id, registry)


def _target(draft: dict, registry: dict) -> RemoteTarget:
    value = (registry.get("remotes") or {}).get(draft["id"], {})
    if value and value.get("connector") != "headless-loadouts":
        raise ProfileError("machine_id_in_use", "An existing connector already uses this id.")
    transport = dict(value.get("transport") or {})
    transport["ssh_host"] = draft["input"].get("ssh_host")
    installed = draft["observations"].get("install")
    if installed:
        transport["receiver_command"] = installed["command"]
    return RemoteTarget.from_dict(
        draft["id"],
        {
            **value,
            "connector": "headless-loadouts",
            "transport": transport,
            "host_key_sha256": draft["input"].get("host_key_sha256"),
            "sync_enabled": value.get("sync_enabled", False),
        },
    )


def _connection_digest(draft: dict) -> str:
    return hashlib.sha256(
        canonical({key: draft["input"].get(key) for key in ("ssh_host", "host_key_sha256")})
    ).hexdigest()


def _require(draft: dict, step: str) -> None:
    if step == "connect":
        valid = draft["observations"].get(step) == _connection_digest(draft)
    else:
        valid = bool(draft["observations"].get(step))
    if not valid:
        raise ProfileError("machine_step_required", "Complete the previous machine setup step first.")


def _persist(draft: dict, registry: dict, target: RemoteTarget) -> dict:
    registry.setdefault("remotes", {})[target.id] = target.to_dict()
    draft["revision"] += 1
    # Persist operational state first. A failed save cannot advance setup. If
    # the later draft write fails, replaying the explicit step is idempotent.
    hub_core.save_registry(registry)
    atomic_json(_path(draft["id"]), draft)
    return show(draft["id"], registry)


def show(machine_id: str, registry: dict) -> dict:
    draft = read(machine_id)
    target = _target(draft, registry)
    return {
        "id": machine_id,
        "connector": "headless-loadouts",
        "phase": "timer_pending" if draft["observations"].get("interval_update") else draft["phase"],
        "sync_enabled": target.sync_enabled,
        "draft": draft,
        "bindings": target.project_bindings or {},
        "delivery": last_result(machine_id),
    }


def list_machines(registry: dict) -> list[dict]:
    directory = _path("listing").parent
    if not directory.exists():
        return []
    result = []
    for path in sorted(directory.glob("*.json")):
        try:
            result.append(show(path.stem, registry))
        except ProfileError:
            result.append(
                {
                    "id": path.stem,
                    "connector": "headless-loadouts",
                    "phase": "draft_invalid",
                    "sync_enabled": False,
                    "error": "This machine draft needs local repair.",
                }
            )
    return result


def _plan_observation(result: dict) -> dict:
    """Persist the public plan separately from action authorization."""
    return {
        "plan_digest": result.get("plan_digest"),
        "approval_digest": result.get("approval_digest"),
        "native_review": result.get("native_review"),
        "limitations": result.get("limitations", []),
        "blockers": result.get("blockers", []),
        "changes": result.get("changes", []),
        "changes_total": result.get("changes_total", len(result.get("changes", []))),
        "ok": result.get("ok", False),
        "state": result.get("state"),
        "candidate": result.get("candidate"),
        "applied": result.get("applied"),
    }


def operate(machine_id: str, action: str, registry: dict, **options) -> dict:
    draft = read(machine_id)
    target = _target(draft, registry)
    result = None
    if action == "discard":
        # Local draft removal is distinct from removing a machine or its timer.
        if draft["observations"].get("install"):
            raise ProfileError("receiver_remains_installed", "Pause the receiver before removing its controller entry.")
        _path(machine_id).unlink()
        return {"id": machine_id, "phase": "discarded", "sync_enabled": False}
    if action == "connect":
        if not target.ssh_host or not target.host_key_sha256:
            raise ProfileError("receiver_connection_required", "Enter the host and confirm its SSH key first.")
        transport = SshTransport(target.ssh_host, host_key_sha256=target.host_key_sha256, runner=bounded_runner)
        transport.verify_host_key()
        transport.authenticate()
        draft["observations"]["connect"] = _connection_digest(draft)
        if draft["phase"] == "draft":
            draft["phase"] = "connected"
    else:
        _require(draft, "connect")
        if action == "install":
            if target.sync_enabled:
                raise ProfileError(
                    "machine_pause_required", "Pause delivery before updating the receiver installation."
                )
            result = install_remote(target, code=hub_core.code_home())
            draft["observations"]["install"] = result
            target = _target(draft, registry)
            draft["phase"] = "installed_pending_init"
            _persist(draft, registry, target)
            request(target, ["init", "--receiver-id", target.id, "--installation-generation", result["package_digest"]])
            draft["phase"] = "installed"
        elif action == "configure":
            _require(draft, "install")
            inputs = draft["input"]
            if not inputs.get("feed_url") or inputs.get("private_feed_confirmed") is not True:
                raise ProfileError(
                    "private_feed_required", "Choose a private Git feed and confirm its access settings."
                )
            try:
                GitFeed(
                    hub_core.data_home() / "state" / "remotes" / "feeds" / target.id, inputs["feed_url"], target.id
                ).fetch()
            except ProfileError as exc:
                raise ProfileError(exc.code, "On this Mac: " + str(exc)) from None
            key = ensure_signing_key()
            replace_channel = bool(options.get("replace_channel"))
            if replace_channel:
                if target.sync_enabled:
                    raise ProfileError(
                        "machine_pause_required", "Pause delivery before reconnecting the receiver."
                    )
                draft["feed_id"] = uuid.uuid4().hex
                try:
                    result = request(
                        target,
                        [
                            "configure",
                            "--feed-url",
                            inputs["feed_url"],
                            "--feed-id",
                            draft["feed_id"],
                            "--poll-interval-seconds",
                            str(inputs["poll_interval_seconds"]),
                            "--publisher-key-stdin",
                            "--rotate",
                        ],
                        payload={"public_key": key},
                    )
                except ProfileError as exc:
                    if exc.code == "receiver_unavailable":
                        raise ProfileError(
                            "receiver_update_required",
                            "The receiver could not run the reconnect command. Repair the receiver "
                            "installation, check the connection, and retry.",
                        ) from None
                    raise
                value = target.to_dict()
                value["transport"].update(
                    loadout_feed={"url": inputs["feed_url"], "feed_id": draft["feed_id"]}, receiver_ready=True
                )
                target = RemoteTarget.from_dict(target.id, value)
                draft["observations"]["configure"] = {
                    "feed_id": draft["feed_id"],
                    "interval": inputs["poll_interval_seconds"],
                    "replace_feed": True,
                }
                draft["observations"].pop("channel_conflict", None)
                draft["observations"].pop("preview", None)
                draft["observations"].pop("status", None)
                draft["phase"] = "configured"
            else:
                try:
                    result = request(
                        target,
                        [
                            "configure",
                            "--feed-url",
                            inputs["feed_url"],
                            "--feed-id",
                            draft["feed_id"],
                            "--poll-interval-seconds",
                            str(inputs["poll_interval_seconds"]),
                            "--publisher-key-stdin",
                        ],
                        payload={"public_key": key},
                    )
                except ProfileError as exc:
                    if exc.code != "channel_rotation_required":
                        raise
                    try:
                        conflict_status = request(target, ["status"])
                    except ProfileError:
                        conflict_status = {}
                    draft["observations"]["channel_conflict"] = _channel_conflict(
                        conflict_status, key_id(key)
                    )
                    _persist(draft, registry, target)
                    raise ProfileError(
                        "channel_rotation_required",
                        "The receiver already delivers loadouts for another Skill Tree installation. "
                        "Reconnect it to replace that channel with this Mac's identity.",
                    ) from None
                value = target.to_dict()
                value["transport"].update(
                    loadout_feed={"url": inputs["feed_url"], "feed_id": draft["feed_id"]}, receiver_ready=True
                )
                target = RemoteTarget.from_dict(target.id, value)
                draft["observations"]["configure"] = {
                    "feed_id": draft["feed_id"],
                    "interval": inputs["poll_interval_seconds"],
                }
                draft["observations"].pop("channel_conflict", None)
                draft["phase"] = "configured"
        elif action == "interval":
            _require(draft, "configure")
            interval = options.get("poll_interval_seconds")
            if type(interval) is not int or not 30 <= interval <= 3600:
                raise ProfileError("invalid_poll_interval", "Polling interval must be a whole number from 30 to 3600.")
            inputs = draft["input"]
            # Reuse the existing receiver protocol with the same channel identity.
            # It retains approvals and pause state; this operation never publishes.
            result = request(
                target,
                ["configure", "--feed-url", inputs["feed_url"], "--feed-id", draft["feed_id"],
                 "--poll-interval-seconds", str(interval), "--publisher-key-stdin"],
                payload={"public_key": ensure_signing_key()},
            )
            if target.sync_enabled:
                try:
                    timer = request(target, ["timer", "install"])
                    if timer.get("partial") or not timer.get("active") or not timer.get("enabled"):
                        raise ProfileError("timer_setup_failed", "Timer activation failed.")
                except ProfileError:
                    message = "The receiver saved the interval, but its timer update failed. Retry Save interval."
                    draft["observations"]["interval_update"] = {
                        "requested_interval": interval, "state": "timer_pending", "message": message,
                    }
                    _persist(draft, registry, target)
                    raise ProfileError("timer_setup_failed", message) from None
            draft["observations"].pop("interval_update", None)
            inputs["poll_interval_seconds"] = interval
            draft["observations"]["configure"]["interval"] = interval
        elif action == "discover":
            _require(draft, "install")
            roots = options.get("root") or []
            command = ["discover"]
            for root in roots:
                command.extend(("--root", root))
            for subdirectory in sorted({source.subdirectory for _, source in _source_repositories(registry)} - {"."}):
                command.extend(("--subdirectory", subdirectory))
            result = _enrich_discovery(request(target, command), registry)
        elif action == "unbind":
            if target.sync_enabled:
                raise ProfileError("machine_pause_required", "Pause delivery before removing a checkout mapping.")
            value = target.to_dict()
            old = (value.get("project_bindings") or {}).pop(options["binding"], None)
            if old is None:
                raise ProfileError("binding_missing", "The checkout binding does not exist.")
            value.setdefault("retired_bindings", {})[options["binding"]] = {"binding": old, "disposition": "retain"}
            target = RemoteTarget.from_dict(target.id, value)
            draft["observations"].pop("preview", None)
            draft["phase"] = "bound"
        elif action in {"bind", "reconfirm"}:
            if target.sync_enabled:
                raise ProfileError("machine_pause_required", "Pause delivery before adding a checkout mapping.")
            _require(draft, "configure")
            if action == "bind" and options["binding"] in (target.project_bindings or {}):
                raise ProfileError("binding_exists", "Remove or review the existing binding before replacing it.")
            if any(
                item.get("destination_key") == options["binding"]
                for key, item in (target.project_bindings or {}).items()
                if key != options["binding"]
            ):
                raise ProfileError("destination_in_use", "This destination is already bound to a project.")
            if action == "reconfirm" and options["binding"] not in (target.project_bindings or {}):
                raise ProfileError("binding_missing", "Choose an existing binding to review.")
            destination = None
            if not options.get("manual", False):
                observed = request(
                    target, ["checkout", "--path", options["checkout"], "--remote", options.get("remote", "origin")]
                )
                destination = observed["inspection"]["association"]
            proposal = proposed_binding(
                registry,
                project=options["project"],
                destination_key=options["binding"],
                harnesses=options["harnesses"],
                destination_repository=destination,
                source_remote=options.get("source_remote"),
                manual=options.get("manual", False),
                global_native=options.get("global_native"),
                global_agents=options.get("global_agents"),
            )
            proposal["confirmation"] = confirm(target, options["binding"], proposal, options["checkout"], registry)
            value = target.to_dict()
            value.setdefault("project_bindings", {})[options["binding"]] = proposal
            value.get("retired_bindings", {}).pop(options["binding"], None)
            target = RemoteTarget.from_dict(target.id, value)
            draft["observations"].pop("preview", None)
            draft["phase"] = "bound"
        elif action in {"preview", "approve", "start", "status", "pause"}:
            _require(draft, "configure")
            if action == "start":
                reviewed = draft["observations"].get("preview") or {}
                if not reviewed.get("plan_digest") or reviewed["plan_digest"] != options.get("plan_digest"):
                    raise ProfileError("preview_required", "Preview this delivery before starting the receiver.")
            if action in {"preview", "start"}:
                replace_feed = bool(draft["observations"]["configure"].get("replace_feed"))
                publication = publish(registry, target, immediate=False, replace_feed=replace_feed)
                published = publication.get("published")
                if published and published.get("feed_id") == draft["feed_id"]:
                    draft["observations"]["configure"].pop("replace_feed", None)
                if not publication["ok"]:
                    raise ProfileError(publication["state"], publication["error"]["message"])
                result = request(target, ["plan"])
                if action == "preview":
                    draft["observations"]["preview"] = _plan_observation(result)
                    draft["phase"] = "previewed"
                else:
                    if not result.get("ok") or result.get("plan_digest") != options.get("plan_digest"):
                        raise ProfileError(
                            "preview_changed", "The delivery plan changed or is blocked. Preview it again."
                        )
                    request(target, ["resume"])
                    result = publish(
                        registry, target, expected_plan_digest=options["plan_digest"], replace_feed=replace_feed
                    )
                    published = result.get("published")
                    if published and published.get("feed_id") == draft["feed_id"]:
                        draft["observations"]["configure"].pop("replace_feed", None)
                    if result["state"] not in {"applied", "unchanged"}:
                        raise ProfileError(
                            "receiver_apply_pending", "The receiver has not confirmed the first delivery."
                        )
                    timer = request(target, ["timer", "install"])
                    if timer.get("partial") or not timer.get("active") or not timer.get("enabled"):
                        raise ProfileError("timer_setup_failed", "The receiver timer is not active yet.")
                    pending_interval = draft["observations"].pop("interval_update", None)
                    if pending_interval:
                        interval = pending_interval["requested_interval"]
                        draft["input"]["poll_interval_seconds"] = interval
                        draft["observations"]["configure"]["interval"] = interval
                    value = target.to_dict()
                    value["sync_enabled"] = True
                    target = RemoteTarget.from_dict(target.id, value)
                    draft["observations"]["start"] = {"timer": timer, "applied": result["applied"]}
                    draft["phase"] = "ready"
            elif action == "approve":
                result = request(target, ["approve", "--digest", options["digest"]])
                draft["observations"]["preview"] = _plan_observation(result)
            elif action == "status":
                result = request(target, ["status"])
                plan = request(target, ["plan"])
                draft["observations"]["status"] = result
                draft["observations"]["inspection"] = {
                    "observed_at": datetime.now(timezone.utc).isoformat(),
                    "plan": _plan_observation(plan),
                    "published": (last_result(machine_id) or {}).get("published"),
                }
            else:
                result = request(target, ["pause"])
                value = target.to_dict()
                value["sync_enabled"] = False
                target = RemoteTarget.from_dict(target.id, value)
                draft["phase"] = "paused"
        else:
            raise ProfileError("unknown_machine_operation", "Unknown machine operation.")
    if action not in {"status", "discover", "connect"}:
        draft["observations"].pop("inspection", None)
    reply = _persist(draft, registry, target)
    if result is not None:
        reply["result"] = result
    return reply
