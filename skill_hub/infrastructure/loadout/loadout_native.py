"""Plan fragment-owned native documents without invoking ordinary sync writers."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from skill_hub.application.loadout.loadout_transaction import FileMutation, Image, ImageBudget, snapshot
from skill_hub.domain.loadout.loadout_profiles import ProfileError, canonical, strict_json

MAX_DOCUMENT = 1024 * 1024
MAX_NATIVE = 16 * 1024 * 1024
MAX_FRAGMENTS = 4096


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


@dataclass(frozen=True)
class DocumentOp:
    # Only local codecs construct these paths/selectors, never feed JSON.
    path: Path
    format: str
    kind: str
    selector: tuple[str, ...]
    value: Any
    owner: str


def _identity(kind: str, selector: list[str], value: Any) -> str:
    return digest([kind, selector, value if kind == "array" else None])


def validate_ledger(value: Any) -> dict:
    if not isinstance(value, dict) or len(canonical(value)) > MAX_NATIVE:
        raise ValueError("Invalid native ledger")
    count = 0
    for path, record in value.items():
        if (
            not isinstance(path, str)
            or not Path(path).is_absolute()
            or str(Path(path)) != path
            or ".." in Path(path).parts
            or not isinstance(record, dict)
            or set(record) != {"format", "codec_version", "created", "postimage_sha256", "mode", "fragments"}
            or record["format"] not in {"json", "toml"}
            or type(record["codec_version"]) is not int
            or record["codec_version"] != 1
            or type(record["created"]) is not bool
            or not isinstance(record["postimage_sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", record["postimage_sha256"])
            or type(record["mode"]) is not int
            or not 0 <= record["mode"] <= 0o777
            or not isinstance(record["fragments"], dict)
        ):
            raise ValueError("Invalid native file")
        for identity, fragment in record["fragments"].items():
            count += 1
            if (
                count > MAX_FRAGMENTS
                or not isinstance(fragment, dict)
                or set(fragment) != {"kind", "selector", "value", "sha256", "owners"}
                or fragment["kind"] not in {"object", "array"}
                or not isinstance(fragment["selector"], list)
                or not 1 <= len(fragment["selector"]) <= 8
                or any(not isinstance(k, str) or not k or len(k) > 256 for k in fragment["selector"])
                or identity != _identity(fragment["kind"], fragment["selector"], fragment["value"])
                or fragment["sha256"] != digest(fragment["value"])
                or not isinstance(fragment["owners"], list)
                or not fragment["owners"]
                or any(
                    not isinstance(o, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", o)
                    for o in fragment["owners"]
                )
                or fragment["owners"] != sorted(set(fragment["owners"]))
            ):
                raise ValueError("Invalid native fragment")
    return value


def _unwrap(value):
    return value.unwrap() if hasattr(value, "unwrap") else value


def _parent(document, selector, *, create=False):
    current = document
    for part in selector[:-1]:
        if part not in current:
            if not create:
                return None
            current[part] = {}
        current = current[part]
        if not isinstance(_unwrap(current), dict):
            raise ProfileError("native_structure_conflict", "A native section has an incompatible type.")
    return current


def _occurrences(document, fragment):
    parent = _parent(document, fragment["selector"])
    key = fragment["selector"][-1]
    if parent is None or key not in parent:
        return []
    value = _unwrap(parent[key])
    if fragment["kind"] == "object":
        return [value]
    if not isinstance(value, list):
        raise ProfileError("native_structure_conflict", "A native array has an incompatible type.")
    return [entry for entry in value if digest(entry) == fragment["sha256"]]


def _remove(document, fragment):
    parent = _parent(document, fragment["selector"])
    key = fragment["selector"][-1]
    if fragment["kind"] == "object":
        del parent[key]
    else:
        array = parent[key]
        index = next(i for i, item in enumerate(array) if digest(_unwrap(item)) == fragment["sha256"])
        del array[index]


def _add(document, fragment):
    parent = _parent(document, fragment["selector"], create=True)
    key = fragment["selector"][-1]
    if fragment["kind"] == "object":
        parent[key] = copy.deepcopy(fragment["value"])
    else:
        if key not in parent:
            parent[key] = []
        parent[key].append(copy.deepcopy(fragment["value"]))


def plan_documents(
    operations: list[DocumentOp],
    previous: dict,
    roots: tuple[Path, ...],
    retired: set[str],
    active: set[str],
    whole_paths: set[str],
    *,
    budget: ImageBudget | None = None,
) -> tuple[dict, list[FileMutation], list[dict]]:
    """Return candidate ownership, file mutations and blockers, with no writes."""
    validate_ledger(previous)
    budget = budget if budget is not None else ImageBudget()
    if len(operations) > MAX_FRAGMENTS:
        raise ProfileError("native_limit", "Too many native operations.")
    for operation in operations:
        try:
            if (
                not operation.path.is_absolute()
                or ".." in operation.path.parts
                or not any(root in operation.path.parents for root in roots)
                or operation.format not in {"json", "toml"}
                or operation.kind not in {"object", "array"}
                or not isinstance(operation.selector, tuple)
                or not 1 <= len(operation.selector) <= 8
                or any(not isinstance(key, str) or not key or len(key) > 256 for key in operation.selector)
                or operation.owner not in active
                or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", operation.owner)
                or len(canonical(operation.value)) > MAX_DOCUMENT
            ):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ProfileError("native_invalid", "Invalid native document operation.") from None
    desired: dict[str, dict] = {}
    blockers: list[dict] = []
    for operation in operations:
        path = str(operation.path)
        record = desired.setdefault(path, {"format": operation.format, "fragments": {}})
        selector = list(operation.selector)
        identity = _identity(operation.kind, selector, operation.value)
        fragment = {
            "kind": operation.kind,
            "selector": selector,
            "value": operation.value,
            "sha256": digest(operation.value),
            "owners": [operation.owner],
        }
        existing = record["fragments"].get(identity)
        if record["format"] != operation.format or (existing and existing["sha256"] != fragment["sha256"]):
            blockers.append({"code": "native_conflict", "path": path})
        elif existing:
            existing["owners"] = sorted(set(existing["owners"] + [operation.owner]))
        else:
            record["fragments"][identity] = fragment
    if sum(len(v["fragments"]) for v in desired.values()) > MAX_FRAGMENTS or len(canonical(desired)) > MAX_NATIVE:
        raise ProfileError("native_limit", "The native plan exceeds its size limit.")
    result = {}
    mutations = []
    total = 0
    output_total = 0
    for path in sorted(set(previous) | set(desired)):
        old = previous.get(path)
        want = desired.get(path)
        if path in whole_paths:
            blockers.append({"code": "native_path_conflict", "path": path})
            continue
        old_fragments = old["fragments"] if old else {}
        new_fragments = copy.deepcopy(want["fragments"] if want else {})
        # Fully retired files require no read and cannot erase even a local edit.
        if not want and all(set(f["owners"]) <= retired for f in old_fragments.values()):
            continue
        try:
            before = snapshot(Path(path), roots, budget=budget)
            if before.kind not in {"missing", "file"}:
                raise ProfileError("unmanaged_existing", "Native settings must be regular files.")
            content = base64.b64decode(before.content) if before.kind == "file" else b""
            total += len(content)
            if len(content) > MAX_DOCUMENT or total > MAX_NATIVE:
                raise ProfileError("native_limit", "Native documents exceed their size limit.")
            fmt = want["format"] if want else (old or {})["format"]
            if old and old["format"] != fmt:
                raise ProfileError("native_structure_conflict", "The native document format changed.")
            if fmt == "json":
                document = strict_json(content) if content else {}
                if not isinstance(document, dict):
                    raise ValueError()
            elif fmt == "toml":
                import tomlkit

                document = tomlkit.parse(content.decode()) if content else tomlkit.document()
            else:
                raise ValueError()
            # Reject ancestor selectors; equal arrays allow independent entries.
            fragments = list({**old_fragments, **new_fragments}.values())
            for index, left in enumerate(fragments):
                for right in fragments[index + 1 :]:
                    a, b = left["selector"], right["selector"]
                    if a == b and left["kind"] == right["kind"] == "array":
                        continue
                    if a == b or a[: len(b)] == b or b[: len(a)] == a:
                        raise ProfileError("native_structure_conflict", "Native selectors overlap.")
            changed = False
            for identity, fragment in old_fragments.items():
                owners = set(fragment["owners"])
                retained = owners & retired
                requested = new_fragments.get(identity)
                if retained:
                    if requested:
                        if requested["sha256"] != fragment["sha256"]:
                            raise ProfileError("retained_fragment_conflict", "A retained contribution cannot change.")
                        matches = _occurrences(document, fragment)
                        if len(matches) != 1 or digest(matches[0]) != fragment["sha256"]:
                            raise ProfileError("blocked_drift", "A shared retained entry changed on this receiver.")
                        requested["owners"] = sorted(set(requested["owners"]) | retained)
                    continue
                if owners - active:
                    raise ProfileError("retirement_review", "A native contribution needs an explicit disposition.")
                matches = _occurrences(document, fragment)
                if len(matches) != 1 or digest(matches[0]) != fragment["sha256"]:
                    raise ProfileError("blocked_drift", "A managed native entry changed on this receiver.")
                if requested and requested["sha256"] == fragment["sha256"]:
                    continue
                _remove(document, fragment)
                changed = True
            for identity, fragment in new_fragments.items():
                prior = old_fragments.get(identity)
                if prior and prior["sha256"] == fragment["sha256"]:
                    continue
                if _occurrences(document, fragment):
                    raise ProfileError(
                        "unmanaged_existing", "A native entry already exists outside receiver ownership."
                    )
                _add(document, fragment)
                changed = True
            if fmt == "json":
                after_content = (
                    (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode() if changed else content
                )
            else:
                after_content = tomlkit.dumps(document).encode() if changed else content
            output_total += len(after_content)
            if len(after_content) > MAX_DOCUMENT or output_total > MAX_NATIVE:
                raise ProfileError("native_limit", "The rendered native document exceeds its size limit.")
            mode = before.mode if before.kind == "file" else 0o600
            if changed:
                mutations.append(
                    FileMutation(Path(path), before, Image.file(after_content, mode, budget=budget), "native")
                )
            if new_fragments:
                result[path] = {
                    "format": fmt,
                    "codec_version": 1,
                    "created": old["created"] if old else before.kind == "missing",
                    "postimage_sha256": hashlib.sha256(after_content).hexdigest(),
                    "mode": mode,
                    "fragments": new_fragments,
                }
        except ProfileError as exc:
            blockers.append({"code": exc.code, "path": path})
        except (ValueError, UnicodeError, TypeError):
            blockers.append({"code": "native_parse_error", "path": path})
    validate_ledger(result)
    return result, mutations, blockers
