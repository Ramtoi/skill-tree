"""Receiver-owned checkout confirmations, independent of controller registry paths.

A feed can reference these records but cannot create or redirect them. Callers
must hold the receiver lock across profile changes and delivery.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skill_hub.infrastructure.registry import project_repository


class ProfileError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _slug(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
        raise ProfileError("invalid_binding", "Receiver and binding keys must be slugs.")
    return value


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def strict_json(payload: bytes) -> Any:
    def unique(pairs):
        result: dict = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON field.")
            result[key] = value
        return result

    def invalid(value):
        raise ValueError("Non-finite JSON number.")

    return json.loads(payload.decode("utf-8"), object_pairs_hook=unique, parse_constant=invalid)


def atomic_json(path: Path, value: Any) -> None:
    """Durably replace private state; native provider files use the journal."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".loadout-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.lexists(name):
            os.unlink(name)


def binding_digest(binding_id: str, binding: dict) -> str:
    from skill_hub.infrastructure.harnesses.harnesses import HARNESSES

    _slug(binding_id)
    if not isinstance(binding, dict) or binding.get("mode") not in ("manual", "repository"):
        raise ProfileError("invalid_binding", "Choose repository matching or explicit manual mapping.")
    _slug(binding.get("destination_key"))
    fingerprint = binding.get("source_fingerprint")
    providers = binding.get("harnesses")
    if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise ProfileError("invalid_binding", "A source fingerprint is required.")
    if (
        not isinstance(providers, list)
        or not providers
        or any(not isinstance(p, str) or p not in HARNESSES for p in providers)
        or providers != sorted(set(providers))
    ):
        raise ProfileError("invalid_binding", "Select a sorted set of known providers.")
    mode = binding.get("mode")
    body = {key: binding[key] for key in ("destination_key", "source_fingerprint", "harnesses", "mode")}
    if mode == "repository":
        for key in ("source_repository", "destination_repository"):
            project_repository.validate_repository_association(binding.get(key))
            body[key] = binding[key]
        if not project_repository.same_repository(body["source_repository"], body["destination_repository"]):
            raise ProfileError("destination_repository_mismatch", "The source and destination repositories differ.")
    elif mode != "manual" or "source_repository" in binding or "destination_repository" in binding:
        raise ProfileError("invalid_binding", "Choose repository matching or explicit manual mapping.")
    from skill_hub.domain.loadout.loadout_native_codec import selections

    body.update(selections(binding))
    body["binding_id"] = binding_id
    return hashlib.sha256(canonical(body)).hexdigest()


def _directory(path: Path) -> tuple[Path, list[int]]:
    try:
        resolved = path.expanduser().resolve(strict=True)
        if not resolved.is_dir():
            raise OSError()
        stat = resolved.stat()
        return resolved, [stat.st_dev, stat.st_ino]
    except (OSError, RuntimeError):
        raise ProfileError("checkout_missing", "Choose an existing checkout directory.") from None


def _check_repository(binding: dict, path: Path) -> None:
    if binding["mode"] != "repository":
        return
    expected = project_repository.validate_repository_association(binding["destination_repository"])
    actual = project_repository.inspect_project_repository(path, remote=expected.remote)
    if not project_repository.same_repository(expected, actual.association):
        raise ProfileError(
            "destination_repository_mismatch", "The checkout no longer matches the confirmed repository."
        )


class ReceiverProfiles:
    """Owns local identity evidence; never loads or mutates the main registry."""

    def __init__(self, state_root: Path):
        self.path = state_root / "profile.json"

    def read(self) -> dict:
        try:
            if self.path.is_symlink() or self.path.stat().st_size > 1024 * 1024:
                raise ValueError()
            value = strict_json(self.path.read_bytes())
            if (
                not isinstance(value, dict)
                or set(value) - {"schema", "receiver_id", "installation_id", "revision", "bindings", "generation"}
                or not {"schema", "receiver_id", "installation_id", "revision", "bindings"}.issubset(value)
                or (
                    "generation" in value
                    and (
                        not isinstance(value["generation"], str)
                        or not re.fullmatch(r"[a-f0-9]{64}", value["generation"])
                    )
                )
                or value["schema"] != 1
                or type(value["revision"]) is not int
                or value["revision"] < 0
                or not isinstance(value["bindings"], dict)
                or len(value["bindings"]) > 64
            ):
                raise ValueError()
            _slug(value["receiver_id"])
            uuid.UUID(value["installation_id"])
            for key, record in value["bindings"].items():
                _slug(key)
                if (
                    not isinstance(record, dict)
                    or set(record) != {"path", "directory_identity", "binding", "confirmation"}
                    or not isinstance(record["path"], str)
                    or not Path(record["path"]).is_absolute()
                    or not isinstance(record["directory_identity"], list)
                    or len(record["directory_identity"]) != 2
                    or any(type(item) is not int for item in record["directory_identity"])
                ):
                    raise ValueError()
                saved = record["binding"]
                fields = {"mode", "destination_key", "source_fingerprint", "harnesses"}
                if isinstance(saved, dict) and saved.get("mode") == "repository":
                    fields |= {"source_repository", "destination_repository"}
                from skill_hub.domain.loadout.loadout_native_codec import selections

                if isinstance(saved, dict):
                    fields |= set(selections(saved))
                if not isinstance(saved, dict) or set(saved) != fields:
                    raise ValueError()
                receipt = record["confirmation"]
                if (
                    not isinstance(receipt, dict)
                    or set(receipt)
                    != {"receiver_id", "installation_id", "profile_revision", "binding_digest", "observed_at"}
                    or receipt["receiver_id"] != value["receiver_id"]
                    or receipt["installation_id"] != value["installation_id"]
                    or type(receipt["profile_revision"]) is not int
                    or not 0 < receipt["profile_revision"] <= value["revision"]
                    or receipt["binding_digest"] != binding_digest(key, record["binding"])
                ):
                    raise ValueError()
                timestamp = receipt["observed_at"]
                if not isinstance(timestamp, str) or len(timestamp) > 64:
                    raise ValueError()
                observed = datetime.fromisoformat(timestamp)
                offset = observed.utcoffset()
                if offset is None or offset.total_seconds() != 0:
                    raise ValueError()
            return value
        except FileNotFoundError:
            raise ProfileError(
                "receiver_not_configured", "Initialize this receiver before confirming checkouts."
            ) from None
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            raise ProfileError("receiver_profile_invalid", "Receiver profile is invalid; repair it locally.") from None

    def initialize(self, receiver_id: str, generation: str | None = None) -> dict:
        _slug(receiver_id)
        if generation is not None and not re.fullmatch(r"[a-f0-9]{64}", generation):
            raise ProfileError("invalid_installation", "The installation generation is malformed.")
        if os.path.lexists(self.path):
            value = self.read()
            if value["receiver_id"] != receiver_id:
                raise ProfileError("receiver_identity_mismatch", "This installation belongs to a different receiver.")
            if generation is not None and value.get("generation") != generation:
                value["generation"] = generation
                value["installation_id"] = str(uuid.uuid4())
                value["revision"] += 1
                for record in value["bindings"].values():
                    record["confirmation"].update(
                        installation_id=value["installation_id"],
                        profile_revision=value["revision"],
                        observed_at=datetime.now(timezone.utc).isoformat(),
                    )
                atomic_json(self.path, value)
            return value
        value = {
            "schema": 1,
            "receiver_id": receiver_id,
            "installation_id": str(uuid.uuid4()),
            "revision": 0,
            "bindings": {},
        }
        if generation is not None:
            value["generation"] = generation
        atomic_json(self.path, value)
        return value

    def confirm(self, binding_id: str, binding: dict, path: Path, *, installed: set[str]) -> dict:
        digest = binding_digest(binding_id, binding)
        value = self.read()
        if any(provider not in installed for provider in binding["harnesses"]):
            raise ProfileError("receiver_provider_unavailable", "Install each selected provider before confirming.")
        resolved, identity = _directory(path)
        _check_repository(binding, resolved)
        if binding_id not in value["bindings"] and len(value["bindings"]) >= 64:
            raise ProfileError("receiver_binding_limit", "This receiver already has 64 bindings.")
        for other_id, record in value["bindings"].items():
            if other_id == binding_id:
                continue
            other = Path(record["path"]).resolve()
            if (
                resolved == other
                or resolved in other.parents
                or other in resolved.parents
                or binding["destination_key"] == record["binding"]["destination_key"]
            ):
                raise ProfileError("overlapping_checkouts", "Another binding already controls this destination.")
        prior = value["bindings"].get(binding_id)
        if (
            prior
            and prior["path"] == str(resolved)
            and prior["directory_identity"] == identity
            and prior["confirmation"]["binding_digest"] == digest
        ):
            return prior["confirmation"]
        value["revision"] += 1
        confirmation = {
            "receiver_id": value["receiver_id"],
            "installation_id": value["installation_id"],
            "profile_revision": value["revision"],
            "binding_digest": digest,
            "observed_at": datetime.now(timezone.utc).isoformat(),
        }
        # Store only the authorization inputs. Controller names and prior receipts
        # are lookup/display state and cannot affect receiver ownership.
        saved = {key: binding[key] for key in ("mode", "destination_key", "source_fingerprint", "harnesses")}
        if binding["mode"] == "repository":
            saved.update({key: binding[key] for key in ("source_repository", "destination_repository")})
        from skill_hub.domain.loadout.loadout_native_codec import selections

        saved.update(selections(binding))
        value["bindings"][binding_id] = {
            "path": str(resolved),
            "directory_identity": identity,
            "binding": saved,
            "confirmation": confirmation,
        }
        atomic_json(self.path, value)
        return confirmation

    def checkout(self, binding_id: str, binding: dict, confirmation: dict) -> Path:
        value = self.read()
        record = value["bindings"].get(binding_id)
        if (
            not record
            or record["confirmation"] != confirmation
            or confirmation.get("binding_digest") != binding_digest(binding_id, binding)
        ):
            raise ProfileError("binding_confirmation_required", "Fresh receiver confirmation is required.")
        resolved, identity = _directory(Path(record["path"]))
        if str(resolved) != record["path"] or identity != record["directory_identity"]:
            raise ProfileError("checkout_replaced", "The confirmed checkout directory was replaced; confirm it again.")
        _check_repository(binding, resolved)
        return resolved
