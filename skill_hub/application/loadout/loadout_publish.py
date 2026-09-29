"""Controller publication and immediate receive, with truthful separate receipts."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.application.loadout.loadout_control import request
from skill_hub.domain.loadout.loadout_native_codec import NativeConfigurationError
from skill_hub.domain.loadout.loadout_profiles import ProfileError, atomic_json, canonical, strict_json
from skill_hub.domain.loadout.loadout_projection import ProjectionSourceError, compile_projection
from skill_hub.infrastructure.connectors.signing import get_public_key
from skill_hub.infrastructure.loadout.loadout_feed import FEED_ERRORS, FOREIGN_HEAD_CODES, GitFeed, asset_digest

PUBLISH_ERRORS = {
    "setup_required": "Finish receiver onboarding before publishing.",
    "signing_required": "Initialize the controller signing key in machine setup.",
    "receiver_capability_changed": "Update and reconfirm the receiver before native publication.",
    "feed_integrity_error": "The published feed does not continue the accepted chain. Review the feed branch.",
    "feed_identity_mismatch": "This publication belongs to a different feed.",
    "stale_publication": "An older publication cannot replace the accepted generation.",
    "feed_advanced": "The feed advanced; rebuild this publication before retrying.",
    "feed_reconnect_required": (
        "The feed branch head was published by another Skill Tree installation. "
        "Reconnect the receiver to publish from this Mac."
    ),
}


def result_path(remote_id: str) -> Path:
    from skill_hub.domain.loadout.loadout_profiles import _slug

    _slug(remote_id)
    return hub_core.data_home() / "state" / "remotes" / "loadouts" / (remote_id + ".json")


def _revision(value: object, *, full: bool = False) -> None:
    if value is None:
        return
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("revision"), str)
        or not re.fullmatch(r"[a-f0-9]{40,64}", value["revision"])
        or type(value.get("generation")) is not int
        or value["generation"] < 1
        or not isinstance(value.get("feed_id"), str)
        or not re.fullmatch(r"[a-f0-9]{32}", value["feed_id"])
        or not isinstance(value.get("digest"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", value["digest"])
    ):
        raise ValueError()
    if full:
        if set(value) == {"feed_id", "revision", "generation", "digest", "applied_at"}:
            if (
                not isinstance(value["applied_at"], str)
                or len(value["applied_at"]) > 64
                or datetime.fromisoformat(value["applied_at"]).tzinfo is None
            ):
                raise ValueError()
        else:
            from skill_hub.application.loadout.loadout_receive import _state

            _state(value)
    elif set(value) != {"revision", "generation", "feed_id", "digest"}:
        raise ValueError()


def _error_envelope(value: object) -> None:
    if value is None:
        return
    if (
        not isinstance(value, dict)
        or set(value) != {"code", "message", "retryable"}
        or not isinstance(value["code"], str)
        or not re.fullmatch(r"[a-z_]{1,64}", value["code"])
        or not isinstance(value["message"], str)
        or len(value["message"]) > 1000
        or type(value["retryable"]) is not bool
    ):
        raise ValueError()


def _invocation_report(outcomes: list[dict]) -> dict:
    limitations = [row for row in outcomes if row["support"] in {"unsupported", "unknown"}]
    kept = []
    size = 0
    for row in limitations[:256]:
        size += len(canonical(row))
        if size > 256 * 1024:
            break
        kept.append(row)
    return {"invocation": kept, "invocation_total": len(limitations)}


def _validate_invocation_report(value: dict) -> None:
    rows, total = value.get("invocation", []), value.get("invocation_total", 0)
    if (not isinstance(rows, list) or len(rows) > 256 or type(total) is not int
            or total < len(rows) or total > 100000 or len(canonical(rows)) > 256 * 1024):
        raise ValueError()
    for row in rows:
        if not isinstance(row, dict) or row.get("support") not in {"unsupported", "unknown"}:
            raise ValueError()
        for key in ("binding", "skill", "harness", "requested_mode", "mode_origin", "capability_profile",
                    "implicit_behavior", "explicit_behavior", "mechanism", "delivery"):
            if not isinstance(row.get(key), str) or len(row[key]) > 8192:
                raise ValueError()
        if (not isinstance(row.get("limitations"), list) or len(row["limitations"]) > 16
                or any(not isinstance(item, str) or len(item) > 8192 for item in row["limitations"])):
            raise ValueError()


def _validate_native_limitations(rows: object) -> None:
    if not isinstance(rows, list) or len(rows) > 256 or len(canonical(rows)) > 256 * 1024:
        raise ValueError()
    for row in rows:
        if not isinstance(row, dict) or not {"area", "harness", "name", "message"} <= set(row):
            raise ValueError()
        if set(row) - {"area", "harness", "name", "message", "binding", "risk"}:
            raise ValueError()
        if any(not isinstance(value, str) or len(value) > 8192 for value in row.values()):
            raise ValueError()


def last_result(remote_id: str) -> Optional[dict]:
    path = result_path(remote_id)
    if not path.exists():
        return None
    try:
        if path.is_symlink() or path.stat().st_size > 1024 * 1024:
            raise ValueError()
        value = strict_json(path.read_bytes())
        if (
            not isinstance(value, dict)
            or set(value)
            != ({"ok", "target", "state", "desired", "published", "applied", "observed_at", "bindings", "error"}
                | ({"invocation", "invocation_total"} if "invocation" in value else set())
                | ({"native_limitations"} if "native_limitations" in value else set()))
            or value["target"] != remote_id
            or type(value["ok"]) is not bool
            or not isinstance(value["state"], str)
            or not re.fullmatch(r"[a-z_]{1,64}", value["state"])
            or value["bindings"] != []
        ):
            raise ValueError()
        _validate_invocation_report(value)
        _validate_native_limitations(value.get("native_limitations", []))
        desired = value["desired"]
        if desired is not None and (
            not isinstance(desired, dict)
            or set(desired) != {"digest"}
            or not isinstance(desired["digest"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", desired["digest"])
        ):
            raise ValueError()
        _revision(value["published"])
        _revision(value["applied"], full=True)
        _error_envelope(value["error"])
        if value["observed_at"] is not None:
            if not isinstance(value["observed_at"], str) or len(value["observed_at"]) > 64:
                raise ValueError()
            if datetime.fromisoformat(value["observed_at"]).tzinfo is None:
                raise ValueError()
        return value
    except (OSError, ValueError, TypeError, KeyError):
        raise ProfileError(
            "controller_receipt_invalid", "The saved receiver observation is invalid; inspect it locally."
        ) from None


def _content_digest(projection):
    return asset_digest(canonical({k: v for k, v in projection.items() if k not in {"previous", "generation"}}))


def publish(
    registry: dict,
    target,
    *,
    immediate=True,
    expected_plan_digest=None,
    feed_factory=GitFeed,
    control=request,
    replace_feed: bool = False,
) -> dict:
    feed_cfg = target.transport.get("loadout_feed")
    prior = last_result(target.id) or {}
    result: dict = {
        "ok": False,
        "target": target.id,
        "state": "setup_required",
        "desired": None,
        "published": prior.get("published"),
        "applied": prior.get("applied"),
        "observed_at": prior.get("observed_at"),
        "bindings": [],
        "error": None,
    }
    try:
        if (
            not isinstance(feed_cfg, dict)
            or set(feed_cfg) != {"url", "feed_id"}
            or target.transport.get("receiver_ready") is not True
        ):
            raise ProfileError("setup_required", "Finish receiver onboarding before publishing.")
        # A reconnected channel does not continue the earlier chain.
        published = prior.get("published")
        if published and published.get("feed_id") != feed_cfg["feed_id"]:
            published = None
        public_key = get_public_key()
        if not public_key:
            raise ProfileError("signing_required", "Initialize the controller signing key in machine setup.")
        # Compile before contacting Git so a missing/stale source never publishes
        # an accidental empty loadout or retirement.
        outcomes: list[dict] = []
        native_limitations: list[dict] = []
        from skill_hub.domain.loadout.loadout_native_codec import capabilities, capture_loadout_codec_context

        codec_context = capture_loadout_codec_context()
        projected, assets = compile_projection(
            registry, target, feed_id=feed_cfg["feed_id"], generation=1, previous=None,
            invocation_outcomes=outcomes, native_limitations=native_limitations,
            codec_context=codec_context,
        )
        result.update(_invocation_report(outcomes))
        _validate_native_limitations(native_limitations)
        result["native_limitations"] = native_limitations
        if projected["schema"] == 2:
            observed = control(target, ["inspect"])
            observed_profile = observed.get("profile")
            if (
                observed.get("native") != capabilities(codec_context)
                or not isinstance(observed_profile, dict)
                or observed_profile.get("receiver_id") != target.id
                or not isinstance(observed_profile.get("bindings"), dict)
                or any(
                    binding["confirmation"]["installation_id"] != observed_profile.get("installation_id")
                    or observed_profile["bindings"].get(key, {}).get("confirmation") != binding["confirmation"]
                    for key, binding in target.project_bindings.items()
                )
            ):
                raise ProfileError(
                    "receiver_capability_changed", "Update and reconfirm the receiver before native publication."
                )
        desired = _content_digest(projected)
        result["desired"] = {"digest": desired}
        feed = feed_factory(
            hub_core.data_home() / "state" / "remotes" / "feeds" / target.id, feed_cfg["url"], target.id
        )
        current = feed.fetch()

        def _continue_chain(previous: dict) -> None:
            nonlocal projected, current
            generation = previous["generation"]
            if _content_digest(previous) == desired:
                projected = previous
            else:
                projected["generation"] = generation + 1
                projected["previous"] = current
                current = feed.publish(projected, assets, parent=current)

        if current:
            if published is None and replace_feed:
                try:
                    previous, _ = feed.accept(current, public_key, feed_cfg["feed_id"], None)
                except ProfileError as exc:
                    if exc.code not in FOREIGN_HEAD_CODES:
                        raise
                    projected["generation"] = 1
                    projected["previous"] = current
                    current = feed.publish(projected, assets, parent=current, replace_foreign=True)
                else:
                    _continue_chain(previous)
            else:
                try:
                    previous, _ = feed.accept(current, public_key, feed_cfg["feed_id"], published)
                except ProfileError as exc:
                    if published is None and exc.code in FOREIGN_HEAD_CODES:
                        raise ProfileError(
                            "feed_reconnect_required",
                            "The feed branch head was published by another Skill Tree installation. "
                            "Reconnect the receiver to publish from this Mac.",
                        ) from None
                    raise
                _continue_chain(previous)
        else:
            if published:
                raise ProfileError("feed_integrity_error", "The previously published feed ref is missing.")
            current = feed.publish(projected, assets, parent=None)
        result["published"] = {
            "revision": current,
            "generation": projected["generation"],
            "feed_id": feed_cfg["feed_id"],
            "digest": asset_digest(canonical(projected)),
        }
        result["ok"] = True
        result["state"] = "published_waiting_for_receiver"
        # Publication is durable even when the following SSH attempt is offline.
        atomic_json(result_path(target.id), result)
        if immediate:
            try:
                args = ["once", "--expected-revision", current]
                if expected_plan_digest is not None:
                    args.extend(["--expected-plan-digest", expected_plan_digest])
                receipt = control(target, args)
                applied = receipt.get("applied")
                try:
                    _revision(applied, full=True)
                    if receipt.get("bindings", []) != []:
                        raise ValueError()
                except (ValueError, TypeError, KeyError):
                    raise ProfileError(
                        "receiver_protocol_invalid", "The receiver returned an invalid apply receipt."
                    ) from None
                if (
                    receipt.get("receiver_id") != target.id
                    or not isinstance(receipt.get("state"), str)
                    or not re.fullmatch(r"[a-z_]{1,64}", receipt["state"])
                    or (
                        receipt["state"] not in {"applied", "unchanged", "paused"}
                        and (
                            receipt.get("ok") is not False
                            or not isinstance(receipt.get("blockers"), list)
                            or not receipt["blockers"]
                            or len(receipt["blockers"]) > 200
                            or any(
                                not isinstance(item, dict)
                                or not isinstance(item.get("code"), str)
                                or not re.fullmatch(r"[a-z_]{1,64}", item["code"])
                                for item in receipt["blockers"]
                            )
                            or receipt["state"] != receipt["blockers"][0]["code"]
                        )
                    )
                    or (
                        applied is not None
                        and (
                            not isinstance(applied, dict)
                            or not isinstance(applied.get("revision"), str)
                            or type(applied.get("generation")) is not int
                        )
                    )
                ):
                    raise ProfileError("receiver_protocol_invalid", "The receiver returned an invalid apply receipt.")
                if receipt["state"] in {"applied", "unchanged"} and (
                    not applied or applied["revision"] != current or applied["generation"] != projected["generation"]
                ):
                    raise ProfileError(
                        "receiver_protocol_invalid", "The receiver did not apply the published revision."
                    )
                result.update(
                    state=receipt["state"],
                    applied=applied,
                    observed_at=datetime.now(timezone.utc).isoformat(),
                    bindings=receipt.get("bindings", []),
                )
                result["ok"] = receipt["state"] in {"applied", "unchanged", "paused"}
                result["error"] = (
                    None
                    if result["ok"]
                    else {
                        "code": receipt["state"],
                        "message": "The receiver blocked delivery. Preview the loadout to review its blockers.",
                        "retryable": False,
                    }
                )
            except Exception as exc:
                code = exc.code if isinstance(exc, ProfileError) else "receiver_unreachable"
                result["error"] = {
                    "code": code,
                    "message": "Published; receiver confirmation is pending.",
                    "retryable": True,
                }
    except Exception as exc:
        code = exc.code if isinstance(exc, ProfileError) else "publication_failed"
        result["state"] = code
        result["error"] = {
            "code": code,
            "message": str(exc)[:1000] if isinstance(
                exc, (NativeConfigurationError, ProjectionSourceError)
            ) else FEED_ERRORS.get(
                code, PUBLISH_ERRORS.get(code, "Could not publish this machine's loadout. Review its setup.")
            ),
            "retryable": code in {"feed_unavailable", "feed_advanced"},
        }
    atomic_json(result_path(target.id), result)
    return result
