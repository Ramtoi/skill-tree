"""Bounded receiver lifecycle for signed skills and native loadout feeds."""

from __future__ import annotations

import base64
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from skill_hub.application.loadout.loadout_transaction import (
    FileMutation,
    Image,
    ImageBudget,
    ReceiverTransaction,
    snapshot,
)
from skill_hub.domain.loadout.loadout_profiles import ProfileError, ReceiverProfiles, atomic_json, canonical
from skill_hub.infrastructure.connectors.signing import key_id
from skill_hub.infrastructure.harnesses.harnesses import HARNESSES, detect_installed
from skill_hub.infrastructure.loadout.loadout_feed import GitFeed, asset_digest, safe_asset_path

_FEED_ID = re.compile(r"[a-f0-9]{32}\Z")
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_KEY = re.compile(r"(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+=*(?: [^\r\n]+)?\Z")


def _error(code: str, message: str) -> ProfileError:
    return ProfileError(code, message)


def _sha(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError()
    return value


def _mode(value: Any) -> int:
    if type(value) is not int or value not in (0o644, 0o755):
        raise ValueError()
    return value


def _state(value: Any) -> dict:
    """Validate the exact applied-state codec before it is used."""
    if (
        not isinstance(value, dict)
        or set(value)
        != (
            {"schema", "feed_id", "revision", "generation", "digest", "applied_at", "files"}
            | ({"native_files", "native_authority"} if value.get("schema") == 2 else set())
        )
        or type(value["schema"]) is not int
        or value["schema"] not in (1, 2)
        or not isinstance(value["feed_id"], str)
        or not _FEED_ID.fullmatch(value["feed_id"])
        or not isinstance(value["revision"], str)
        or not re.fullmatch(r"[a-f0-9]{40,64}", value["revision"])
        or type(value["generation"]) is not int
        or value["generation"] < 1
        or not isinstance(value["digest"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", value["digest"])
        or not isinstance(value["applied_at"], str)
        or not isinstance(value["files"], dict)
    ):
        raise ValueError()
    observed = datetime.fromisoformat(value["applied_at"])
    if observed.tzinfo is None:
        raise ValueError()
    for path, record in value["files"].items():
        if (
            not isinstance(path, str)
            or not Path(path).is_absolute()
            or str(Path(path)) != path
            or ".." in Path(path).parts
            or not isinstance(record, dict)
            or set(record) != {"sha256", "mode", "owners"}
            or not _FEED_ID.fullmatch(value["feed_id"])
            or _sha(record["sha256"]) != record["sha256"]
            or _mode(record["mode"]) != record["mode"]
            or not isinstance(record["owners"], list)
            or not record["owners"]
            or record["owners"] != sorted(set(record["owners"]))
            or any(not isinstance(owner, str) or not _SLUG.fullmatch(owner) for owner in record["owners"])
        ):
            raise ValueError()
    if value["schema"] == 2:
        from skill_hub.infrastructure.loadout.loadout_native import validate_ledger

        validate_ledger(value["native_files"])
        _sha(value["native_authority"])
        if set(value["native_files"]) & set(value["files"]):
            raise ValueError()
    return value


def _image_digest(image: Image) -> Optional[str]:
    if image.kind != "file":
        return None
    try:
        import base64 as _base64

        return hashlib.sha256(_base64.b64decode(image.content, validate=True)).hexdigest()
    except Exception:
        return None


def _global_roots(home: Path) -> Tuple[Path, ...]:
    roots = set()
    for harness in HARNESSES.values():
        path = Path(str(harness.global_skills_dir).replace("~", str(home), 1))
        roots.add(path)
    return tuple(sorted(roots, key=str))


def _under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def installed_providers() -> set[str]:
    """A new headless box may have binaries but no first-session dotfile markers."""
    from skill_hub.infrastructure.harnesses.harness_probe import resolve_binary

    installed = detect_installed()
    for provider in HARNESSES:
        if resolve_binary("claude" if provider == "claude-code" else provider):
            installed.add(provider)
    return installed


class Receiver:
    """Own private feed/channel state and deliver only confirmed skill files."""

    def __init__(
        self,
        root: Path,
        home: Optional[Path] = None,
        installed: Optional[Set[str]] = None,
        feed_factory: Callable[..., GitFeed] = GitFeed,
    ):
        self.root = Path(root)
        self.home = (Path(home) if home is not None else Path.home()).expanduser().resolve()
        self.installed = set(installed_providers() if installed is None else installed)
        self.feed_factory = feed_factory
        self.profiles = ReceiverProfiles(self.root)
        self.channel_path = self.root / "channel.json"
        self.feed_cache = self.root / "feed-cache"

    def _profile(self) -> dict:
        return self.profiles.read()

    def _channel(self) -> dict:
        try:
            if self.channel_path.is_symlink() or self.channel_path.stat().st_size > 64 * 1024:
                raise ValueError()
            from skill_hub.domain.loadout.loadout_profiles import strict_json

            value = strict_json(self.channel_path.read_bytes())
            if (
                not isinstance(value, dict)
                or set(value) != {"schema", "identity", "feed_id", "pubkey", "url", "interval", "paused", "approvals"}
                or value["schema"] != 1
                or not _SLUG.fullmatch(value["identity"])
                or not _FEED_ID.fullmatch(value["feed_id"])
                or not isinstance(value["pubkey"], str)
                or not isinstance(value["url"], str)
                or type(value["interval"]) is not int
                or not 30 <= value["interval"] <= 3600
                or type(value["paused"]) is not bool
                or not isinstance(value["approvals"], dict)
                or set(value["approvals"]) - {"global", "native"}
                or any(
                    not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
                    for key, digest in value["approvals"].items()
                )
            ):
                raise ValueError()
            self._validate_key(value["pubkey"])
            if value["identity"] != self._profile()["receiver_id"]:
                raise ValueError()
            return value
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            raise _error(
                "receiver_channel_invalid", "Receiver channel settings are invalid; repair them locally."
            ) from None

    def _feed(self, channel: dict) -> GitFeed:
        profile = self._profile()
        return self.feed_factory(self.feed_cache, channel["url"], profile["receiver_id"])

    @staticmethod
    def _validate_key(value: str) -> None:
        if not isinstance(value, str) or not _KEY.fullmatch(value.strip()):
            raise _error("invalid_publisher_key", "The publisher key is malformed.")
        try:
            encoded = value.split()[1]
            base64.b64decode(encoded, validate=True)
        except Exception:
            raise _error("invalid_publisher_key", "The publisher key is malformed.") from None

    def configure(
        self,
        feed_url: str,
        feed_id: str,
        publisher_key: str,
        poll_interval_seconds: int,
        *,
        rotate: bool = False,
    ) -> dict:
        profile = self._profile()  # configuration is forbidden before receiver identity exists
        if not isinstance(feed_id, str) or not _FEED_ID.fullmatch(feed_id):
            raise _error("invalid_feed_id", "The feed identifier is malformed.")
        if not isinstance(feed_url, str) or feed_url.lower().startswith("http://"):
            raise _error("invalid_feed_url", "Private feeds require a safe SSH or HTTPS URL.")
        if type(poll_interval_seconds) is not int or not 30 <= poll_interval_seconds <= 3600:
            raise _error("invalid_poll_interval", "Poll interval must be between 30 and 3600 seconds.")
        self._validate_key(publisher_key)
        # Let the selected factory perform its own association checks. This is
        # injectable for local bare repositories in isolated tests.
        feed = self.feed_factory(self.feed_cache, feed_url, profile["receiver_id"])
        previous = None
        if self.channel_path.exists():
            previous = self._channel()
            if previous["identity"] != profile["receiver_id"]:
                raise _error("receiver_identity_mismatch", "This channel belongs to a different receiver.")
        if (
            not rotate
            and previous
            and self._applied() is not None
            and any(
                previous[key] != new
                for key, new in (("feed_id", feed_id), ("pubkey", publisher_key.strip()), ("url", feed_url))
            )
        ):
            raise _error(
                "channel_rotation_required", "An applied channel cannot change feed or signing identity during setup."
            )
        value = {
            "schema": 1,
            "identity": profile["receiver_id"],
            "feed_id": feed_id,
            "pubkey": publisher_key.strip(),
            "url": feed_url,
            "interval": poll_interval_seconds,
            "paused": True if (rotate and previous) else (bool(previous["paused"]) if previous else False),
            "approvals": (
                dict(previous["approvals"])
                if previous
                and previous["feed_id"] == feed_id
                and previous["pubkey"] == publisher_key.strip()
                else {}
            ),
        }
        feed.fetch()  # Verify access before recording a configured channel; an empty branch is valid.
        atomic_json(self.channel_path, value)
        return value

    def _applied(self) -> Optional[dict]:
        # Transaction validates the envelope; receiver validates the exact state codec.
        tx = ReceiverTransaction(self.root, (self.home,))
        result = tx.read_applied()
        if result is None:
            return None
        try:
            return _state(result["state"])
        except (ValueError, TypeError, KeyError):
            raise _error("receiver_state_invalid", "Applied receiver state is invalid; repair it locally.") from None

    def _destination(self, checkout: Path, scope: str, harness: str, name: str, relative: str) -> Path:
        if harness not in HARNESSES or scope not in ("project", "global") or not _SLUG.fullmatch(name):
            raise _error("feed_invalid", "The feed contains an invalid destination.")
        try:
            relative = safe_asset_path(relative)
        except ProfileError:
            raise _error("feed_invalid", "The feed contains an unsafe relative path.") from None
        base = (
            checkout / HARNESSES[harness].project_skills_dir / name
            if scope == "project"
            else self.home / Path(str(HARNESSES[harness].global_skills_dir).replace("~/", "", 1)) / name
        )
        destination = base / relative
        if base not in destination.parents:
            raise _error("feed_invalid", "The feed destination escapes its approved skills directory.")
        return destination

    def _roots(self, checkouts: List[Path]) -> Tuple[Path, ...]:
        roots = set(checkouts) | {self.home}
        return tuple(sorted(roots, key=lambda item: (len(item.parts), str(item))))

    def _details(self) -> Tuple[dict, List[FileMutation], Tuple[Path, ...]]:
        channel = self._channel()
        profile = self._profile()
        applied = self._applied()
        prior_accept = None
        # A rotated channel starts a new signed chain; ownership continuity still comes from the applied record.
        if applied is not None and applied["feed_id"] == channel["feed_id"]:
            prior_accept = {key: applied[key] for key in ("feed_id", "revision", "generation", "digest")}
        feed = self._feed(channel)
        revision = feed.fetch()
        if revision is None:
            raise _error("feed_unavailable", "The configured loadout feed has no publication for this receiver.")
        projection, assets = feed.accept(revision, channel["pubkey"], channel["feed_id"], prior_accept)
        from skill_hub.domain.loadout.loadout_native_codec import (
            capabilities,
            capture_loadout_codec_context,
            decode_unit,
            render_unit,
        )
        from skill_hub.infrastructure.loadout.loadout_native import plan_documents

        # The feed has been authenticated and structurally validated by
        # ``accept``. Capture the immutable codec baseline before comparing the
        # signed capability identity or rendering any native unit.
        codec_context = capture_loadout_codec_context()

        if projection["schema"] == 2 and projection["capabilities"] != capabilities(codec_context)["digest"]:
            raise _error("receiver_capability_changed", "The native receiver capabilities changed; publish again.")
        native_ops = []
        native_whole = {}
        execution_assets = {}
        limitations: List[dict] = []
        checkouts: Dict[str, Path] = {}
        desired: Dict[str, dict] = {}
        blockers: List[dict] = []
        for binding_id, record in projection["bindings"].items():
            try:
                checkout = self.profiles.checkout(binding_id, record["proposal"], record["confirmation"])
                checkouts[binding_id] = checkout
                if any(provider not in self.installed for provider in record["proposal"]["harnesses"]):
                    blockers.append({"code": "receiver_provider_unavailable", "binding": binding_id})
                for item in record["files"]:
                    path = self._destination(checkout, item["scope"], item["harness"], item["name"], item["path"])
                    digest = item["asset"]
                    entry = {"sha256": digest, "mode": item["mode"], "owners": [binding_id]}
                    key = str(path)
                    old = desired.get(key)
                    if old and (old["sha256"] != digest or old["mode"] != item["mode"]):
                        blockers.append(
                            {
                                "code": "global_content_conflict" if item["scope"] == "global" else "content_conflict",
                                "path": key,
                            }
                        )
                    elif old:
                        old["owners"] = sorted(set(old["owners"] + [binding_id]))
                    else:
                        desired[key] = entry
                    desired.setdefault(key, entry)
                    desired[key]["scope"] = item["scope"]
                    desired[key]["asset"] = digest
                executable_skills = {unit["key"] for unit in record.get("native", []) if unit["area"] == "mcp"}
                for item in record["files"]:
                    if item["name"] in executable_skills:
                        execution_assets[
                            binding_id + ":" + item["harness"] + ":" + item["name"] + ":" + item["path"]
                        ] = item["asset"]
                for unit in record.get("native", []):
                    # Resolve roots separately for each provider, including MCP code trees.
                    provider_roots = {
                        item["name"]: self._destination(
                            checkout, item["scope"], item["harness"], item["name"], "SKILL.md"
                        ).parent
                        for item in record["files"]
                        if item["harness"] == unit["harness"]
                    }
                    operations, native_files = render_unit(
                        unit,
                        decode_unit(unit, assets),
                        checkout,
                        self.home,
                        binding_id,
                        provider_roots,
                        limitations=limitations,
                        context=codec_context,
                    )
                    native_ops.extend(operations)
                    for path, data in native_files.items():
                        key = str(path)
                        sha = asset_digest(data)
                        entry = {
                            "sha256": sha,
                            "mode": 0o644,
                            "owners": [binding_id],
                            "scope": unit["scope"],
                            "asset": sha,
                        }
                        if key in desired and desired[key]["sha256"] != sha:
                            blockers.append({"code": "native_conflict", "path": key})
                        elif key in desired:
                            desired[key]["owners"] = sorted(set(desired[key]["owners"] + [binding_id]))
                        else:
                            desired[key] = entry
                        assets[sha] = data
                        native_whole[key] = desired[key]
            except ProfileError as exc:
                blockers.append({"code": exc.code, "binding": binding_id})
        roots = self._roots([Path(record["path"]) for record in profile["bindings"].values()])
        old_files = applied["files"] if applied else {}
        budget = ImageBudget()
        # A deduplicated feed asset can expand into many destinations. Reserve
        # every distinct output before constructing even the first image.
        for destination in desired.values():
            budget.reserve(len(assets[destination["asset"]]))
        mutations: List[FileMutation] = []
        all_paths = set(old_files) | set(desired)
        active = set(projection["bindings"])
        for path_text in sorted(all_paths):
            path = Path(path_text)
            old = old_files.get(path_text)
            want = desired.get(path_text)
            if old and want is None and set(old["owners"]).issubset(set(projection["retired"])):
                continue  # Retain without touching even a locally changed file.
            current = snapshot(path, roots, budget=budget)
            if want is not None:
                retained = set(old["owners"]) & set(projection["retired"]) if old else set()
                if retained and old is not None and (old["sha256"] != want["sha256"] or old["mode"] != want["mode"]):
                    blockers.append({"code": "retained_fragment_conflict", "path": path_text})
                    continue
                if retained:
                    want["owners"] = sorted(set(want["owners"]) | retained)
                if old is None:
                    if current.kind != "missing":
                        blockers.append({"code": "unmanaged_existing", "path": path_text})
                    else:
                        mutations.append(
                            FileMutation(
                                path, current, Image.file(assets[want["asset"]], want["mode"]), ":".join(want["owners"])
                            )
                        )
                else:
                    expected = old["sha256"] == _image_digest(current) and old["mode"] == current.mode
                    if not expected:
                        if current.kind == "file" and (
                            want["sha256"] == _image_digest(current) and want["mode"] == current.mode
                        ):
                            # Recheck this owned file during apply, then advance
                            # the ledger without replacing its current bytes.
                            mutations.append(FileMutation(path, current, current, ":".join(want["owners"])))
                        else:
                            blockers.append({"code": "blocked_drift", "path": path_text})
                    elif old["sha256"] != want["sha256"] or old["mode"] != want["mode"]:
                        mutations.append(
                            FileMutation(
                                path, current, Image.file(assets[want["asset"]], want["mode"]), ":".join(want["owners"])
                            )
                        )
                continue
            if old is None:
                continue
            removed_owners = set(old["owners"]) - active
            if removed_owners and not removed_owners.issubset(set(projection["retired"])):
                blockers.append({"code": "retirement_review", "path": path_text})
                continue
            if removed_owners and removed_owners.issubset(set(projection["retired"])):
                # Explicit retain releases ownership and leaves the native file alone.
                continue
            if current.kind == "missing" or (_image_digest(current) == old["sha256"] and current.mode == old["mode"]):
                if current.kind != "missing":
                    mutations.append(FileMutation(path, current, Image("missing"), ":".join(old["owners"])))
            else:
                blockers.append({"code": "blocked_drift", "path": path_text})

        candidate_files = {
            key: {field: value[field] for field in ("sha256", "mode", "owners")} for key, value in desired.items()
        }
        native_ledger, native_mutations, native_blockers = plan_documents(
            native_ops,
            applied.get("native_files", {}) if applied else {},
            roots,
            set(projection["retired"]),
            active,
            set(old_files) | set(desired),
            budget=budget,
        )
        blockers.extend(native_blockers)
        mutations.extend(native_mutations)
        native_active = bool(native_ops or native_whole or (applied and applied.get("native_authority")))
        native_evidence = {
            "fragments": {path: record["fragments"] for path, record in native_ledger.items()},
            "whole": native_whole,
            "mcp_assets": execution_assets,
            "executables": {
                path: value for path, value in candidate_files.items() if value["mode"] == 0o755 or "/scripts/" in path
            },
            "bindings": {
                key: {
                    "proposal": record["proposal"],
                    "confirmation": record["confirmation"],
                    "checkout": str(checkouts.get(key, "")),
                }
                for key, record in projection["bindings"].items()
            },
            "retired": projection["retired"],
            "capabilities": capabilities(codec_context)["digest"],
        }
        native_authority = asset_digest(canonical(native_evidence))
        native_review = {
            "entries": [
                {
                    "path": str(op.path),
                    "kind": op.kind,
                    "selector": list(op.selector),
                    "value": op.value,
                    "binding": op.owner,
                }
                for op in native_ops
            ],
            "files": [
                {"path": path, "content": assets[entry["asset"]].decode("utf-8")}
                for path, entry in native_whole.items()
            ],
            "removals": [
                {
                    "path": path,
                    "selector": fragment["selector"],
                    "value": fragment["value"],
                    "disposition": "retain" if set(fragment["owners"]) & set(projection["retired"]) else "remove",
                }
                for path, record in (applied.get("native_files", {}) if applied else {}).items()
                for identity, fragment in record["fragments"].items()
                if identity not in native_ledger.get(path, {}).get("fragments", {})
            ],
            "retained_bindings": sorted(projection["retired"]),
        }
        if len(canonical(native_review)) > 512 * 1024:
            raise _error("native_review_limit", "Split this native loadout into smaller reviewed deliveries.")
        candidate = {
            "schema": 1,
            "feed_id": channel["feed_id"],
            "revision": revision,
            "generation": projection["generation"],
            "digest": asset_digest(canonical(projection)),
            "applied_at": datetime.now(timezone.utc).isoformat(),
            "files": candidate_files,
        }
        if native_active:
            candidate.update(schema=2, native_files=native_ledger, native_authority=native_authority)
        prior_global = {
            key: value
            for key, value in (old_files.items() if old_files else [])
            if any(_under(Path(key), root) for root in _global_roots(self.home))
        }
        desired_global = {
            key: value
            for key, value in candidate_files.items()
            if any(_under(Path(key), root) for root in _global_roots(self.home))
        }
        prior_global = {key: {k: v for k, v in value.items() if k != "owners"} for key, value in prior_global.items()}
        desired_global = {
            key: {k: v for k, v in value.items() if k != "owners"} for key, value in desired_global.items()
        }
        approval_scope = "native" if native_active else "global"
        approval_digest = None
        if native_active:
            authority_changed = not applied or applied.get("native_authority") != native_authority
            if authority_changed or desired_global != prior_global:
                approval_digest = asset_digest(canonical({"native": native_evidence, "global": desired_global}))
        elif desired_global != prior_global:
            approval_digest = hashlib.sha256(canonical(desired_global)).hexdigest()
        if approval_digest is not None and channel["approvals"].get(approval_scope) != approval_digest:
            blockers.append({"code": "approval_required", "digest": approval_digest})
        changes = [
            {"path": str(item.path), "action": "delete" if item.after.kind == "missing" else "write"}
            for item in mutations if item.before != item.after
        ]
        plan_evidence = {
            "candidate": {k: v for k, v in candidate.items() if k != "applied_at"},
            "changes": changes,
            "blockers": blockers,
            "preimages": [
                {
                    "path": str(item.path),
                    "kind": item.before.kind,
                    "sha256": _image_digest(item.before),
                    "mode": item.before.mode,
                }
                for item in mutations
            ],
        }
        preview = {
            "ok": not blockers,
            "state": blockers[0]["code"] if blockers else "ready",
            "receiver_id": profile["receiver_id"],
            "candidate": candidate,
            "plan_digest": hashlib.sha256(canonical(plan_evidence)).hexdigest(),
            "approval_digest": approval_digest,
            "approval_scope": approval_scope,
            "native_review": native_review if native_active else None,
            "blockers": blockers,
            "limitations": limitations,
            "changes": changes,
            "desired": candidate_files,
            "applied": applied,
        }
        return preview, mutations, roots

    def plan(self) -> dict:
        try:
            return self._details()[0]
        except ProfileError as exc:
            return {
                "ok": False,
                "state": exc.code,
                "receiver_id": self._profile()["receiver_id"],
                "plan_digest": None,
                "approval_digest": None,
                "blockers": [{"code": exc.code}],
                "limitations": [],
                "changes": [],
                "desired": {},
                "applied": None,
            }

    def approve(self, expected_digest: str) -> dict:
        preview = self.plan()
        if not preview["ok"] and preview.get("approval_digest") != expected_digest:
            raise _error("approval_mismatch", "The approval digest no longer matches the pending plan.")
        if preview.get("approval_digest") != expected_digest:
            raise _error("approval_mismatch", "The approval digest no longer matches the pending plan.")
        channel = self._channel()
        channel["approvals"][preview["approval_scope"]] = expected_digest
        atomic_json(self.channel_path, channel)
        return self.plan()

    def once(self, expected_revision: Optional[str] = None, expected_plan_digest: Optional[str] = None) -> dict:
        channel = self._channel()
        profile = self._profile()
        roots = self._roots([Path(record["path"]) for record in profile["bindings"].values()])

        def recovery_identity(path: Path) -> None:
            for binding_id, record in profile["bindings"].items():
                if Path(record["path"]) in path.parents:
                    self.profiles.checkout(binding_id, record["binding"], record["confirmation"])

        tx = ReceiverTransaction(self.root, roots)
        tx.recover(before_restore=recovery_identity)
        if channel["paused"]:
            return {"ok": True, "receiver_id": profile["receiver_id"], "state": "paused", "applied": self._applied()}
        preview, mutations, roots = self._details()
        if expected_revision is not None and preview["candidate"]["revision"] != expected_revision:
            raise _error("stale_trigger", "The feed advanced beyond this trigger; use the latest publication.")
        if expected_plan_digest is not None and preview["plan_digest"] != expected_plan_digest:
            raise _error("preview_changed", "The reviewed delivery plan changed. Preview it again.")
        if not preview["ok"]:
            return preview
        if (
            not mutations
            and preview["applied"] is not None
            and preview["applied"]["revision"] == preview["candidate"]["revision"]
            and {key: value for key, value in preview["applied"].items() if key != "applied_at"}
            == {key: value for key, value in preview["candidate"].items() if key != "applied_at"}
        ):
            return {
                "ok": True,
                "receiver_id": profile["receiver_id"],
                "state": "unchanged",
                "applied": preview["applied"],
                "changes": [],
                "limitations": preview.get("limitations", []),
            }
        tx.apply(mutations, preview["candidate"], validate_path=recovery_identity)
        return {
            "ok": True,
            "receiver_id": profile["receiver_id"],
            "state": "applied",
            "changes": preview["changes"],
            "limitations": preview.get("limitations", []),
            "applied": preview["candidate"],
        }

    def status(self) -> dict:
        channel = self._channel()
        return {
            "receiver_id": self._profile()["receiver_id"],
            "configured": True,
            "paused": channel["paused"],
            "feed_id": channel["feed_id"],
            "publisher_key_id": key_id(channel["pubkey"]),
            "interval": channel["interval"],
            "applied": self._applied(),
        }

    def pause(self, paused: bool = True) -> dict:
        if type(paused) is not bool:
            raise _error("invalid_pause", "Pause must be true or false.")
        channel = self._channel()
        channel["paused"] = paused
        atomic_json(self.channel_path, channel)
        return channel
