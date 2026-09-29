"""Shared permission-adapter plumbing: result types, the `PermissionAdapter`
protocol, and the backup-first / atomic-write helpers every harness adapter
uses. Split out of `permission_adapters.py` (wave 22a) — see that module's
docstring for the adapter contract.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Protocol

from skill_hub.domain.permissions.permissions import (
    DirectoryLedgerIdentity,
    NormalizedPermissions,
    PermissionFeature,
    Rule,
    Scope,
    delete_directory_sidecar,
    read_directory_sidecar,
)

# ─────────────────────────────────────────────────────────────────────────────
# Result types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class SkipReason:
    feature: str  # PermissionFeature value
    reason: str  # human-readable why (e.g. "Codex has no per-tool allowlist")
    rule_pattern: Optional[str] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "feature": self.feature,
            "reason": self.reason,
            "rule_pattern": self.rule_pattern,
            "detail": self.detail,
        }


@dataclass
class NativeWrite:
    target_path: Path  # absolute target file
    payload: Any  # adapter-specific representation
    managed_keys: list[str]  # JSONPath-ish segments owned by hub
    format: str  # "json" | "toml" | "starlark"


@dataclass
class TranslateResult:
    writes: list[NativeWrite] = field(default_factory=list)
    skipped: list[SkipReason] = field(default_factory=list)
    risks: list = field(default_factory=list)  # list[RiskFinding] — typed lazily to avoid import cycle
    warnings: list[str] = field(
        default_factory=list
    )  # human-readable side-effect notices (e.g. auto-granted project trust)  # noqa: E501


@dataclass
class ValidationResult:
    ok: bool
    error: Optional[str] = None


@dataclass(frozen=True)
class DirectoryContribution:
    id: str
    paths: tuple[str, ...]


@dataclass(frozen=True)
class DirectoryPlan:
    target_file: Path
    native_key: str
    contributions: tuple[DirectoryContribution, ...]
    family: str
    config_state: str
    reason_code: str | None = None


@dataclass(frozen=True)
class DirectoryEndpoint:
    target_file: Path
    native_key: str


@dataclass(frozen=True)
class NativeDirectoryMutation:
    target_file: Path
    native_key: str
    content: str | None
    format: str


@dataclass(frozen=True)
class DirectoryCleanupPlan:
    identity: DirectoryLedgerIdentity
    ledger_path: Path
    endpoint: DirectoryEndpoint | None
    native_mutation: NativeDirectoryMutation | None
    status: "WorktreeAccessStatus"
    delete_ledger: bool


@dataclass(frozen=True)
class WorktreeAccessStatus:
    harness: str
    config_state: str
    runtime_state: str
    target_file: str | None = None
    requested_path: str | None = None
    missing_parent: bool = False
    reason_code: str | None = None
    reason: str | None = None


def _directory_failed(harness_id: str, target: Path | None, reason: str) -> WorktreeAccessStatus:
    return WorktreeAccessStatus(
        harness_id,
        "failed",
        "not_applicable",
        str(target) if target is not None else None,
        reason_code="DIRECTORY_LEDGER_INVALID",
        reason=reason,
    )


def plan_directory_cleanup(adapter, scope: Scope, harness_id: str) -> DirectoryCleanupPlan:
    """Validate and plan removal of one identity-specific directory ledger."""
    identity = DirectoryLedgerIdentity.from_scope(scope, harness_id)
    ledger_path = directory_sidecar_path(harness_id, identity)
    try:
        prior = read_directory_sidecar(identity)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        return DirectoryCleanupPlan(
            identity,
            ledger_path,
            None,
            None,
            _directory_failed(harness_id, None, f"invalid directory ledger: {exc}"),
            False,
        )
    if prior is None:
        return DirectoryCleanupPlan(
            identity,
            ledger_path,
            None,
            None,
            WorktreeAccessStatus(harness_id, "unmanaged", "not_applicable", None),
            False,
        )
    target: Path | None = None
    try:
        ledger = prior.directory_ledger
        if not isinstance(ledger, dict):
            raise ValueError("directory ledger must be an object")
        if prior.harness != harness_id or prior.scope != identity.token:
            raise ValueError("sidecar scope identity does not match request")
        parsed_identity = DirectoryLedgerIdentity.from_dict(ledger["identity"])
        if parsed_identity != identity:
            raise ValueError("ledger identity does not match request")
        native_key = ledger["native_key"]
        if not isinstance(native_key, str) or not native_key:
            raise ValueError("ledger native key must be a string")
        entries = ledger["entries"]
        if not isinstance(entries, dict):
            raise ValueError("directory entries must be an object")
        endpoint = adapter.directory_cleanup_endpoint(scope, harness_id, native_key)
        target = endpoint.target_file.resolve(strict=False)
        if Path(prior.file).expanduser().resolve(strict=False) != target:
            raise ValueError("ledger target does not match native endpoint")
        mutation = adapter.plan_owned_directory_removal(endpoint, entries)
        status = WorktreeAccessStatus(harness_id, "removed", "not_applicable", str(target))
        return DirectoryCleanupPlan(identity, ledger_path, endpoint, mutation, status, True)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        return DirectoryCleanupPlan(
            identity,
            ledger_path,
            None,
            None,
            _directory_failed(harness_id, target, f"invalid directory ledger or native target: {exc}"),
            False,
        )


def apply_directory_cleanup(adapter, plan: DirectoryCleanupPlan) -> WorktreeAccessStatus:
    """Apply one previously validated plan, writing native state first."""
    if plan.status.config_state != "removed":
        return plan.status
    try:
        if plan.native_mutation is not None:
            adapter.apply_owned_directory_removal(plan.native_mutation)
        if plan.delete_ledger:
            delete_directory_sidecar(plan.identity)
        return plan.status
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        return _directory_failed(plan.identity.harness, plan.endpoint.target_file if plan.endpoint else None, str(exc))


def directory_sidecar_path(harness_id: str, identity: DirectoryLedgerIdentity) -> Path:
    """Local import wrapper keeps the base module's public contract clear."""
    from skill_hub.domain.permissions.permissions import directory_sidecar_path as _path

    return _path(harness_id, identity)


# ─────────────────────────────────────────────────────────────────────────────
# Protocol
# ─────────────────────────────────────────────────────────────────────────────


class PermissionAdapter(Protocol):
    def plan_directories(
        self, scope: Scope, contributions: tuple[DirectoryContribution, ...], harness_id: str
    ) -> DirectoryPlan: ...

    def apply_directories(self, scope: Scope, plan: DirectoryPlan, harness_id: str) -> WorktreeAccessStatus: ...

    def read_directories(
        self, scope: Scope, contributions: tuple[DirectoryContribution, ...], harness_id: str
    ) -> WorktreeAccessStatus: ...

    def directory_cleanup_endpoint(self, scope: Scope, harness_id: str, native_key: str) -> DirectoryEndpoint: ...

    def plan_owned_directory_removal(
        self, endpoint: DirectoryEndpoint, entries: dict
    ) -> NativeDirectoryMutation | None: ...

    def apply_owned_directory_removal(self, mutation: NativeDirectoryMutation) -> None: ...

    def translate(
        self,
        perms: NormalizedPermissions,
        scope: Scope,
        harness_id: str,
    ) -> TranslateResult: ...

    def apply(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool: ...

    def cleanup(self, scope: Scope, harness_id: str) -> bool: ...

    def capabilities(self) -> set: ...

    def validate(self, rule: Rule) -> ValidationResult: ...

    def discover_existing(
        self, scope: Scope, harness_id: str, project_path: Optional[Path] = None
    ) -> NormalizedPermissions: ...


# ─────────────────────────────────────────────────────────────────────────────
# Risk detection passthrough (lazy import to avoid module load cycle)
# ─────────────────────────────────────────────────────────────────────────────


def _detect_risks_for_translate(perms, capabilities):
    """Run risks.detect_risks; isolated so adapter modules don't import risks at top level."""
    from skill_hub.domain.diagnostics import risks as _risks

    return _risks.detect_risks(perms, capabilities)


# ─────────────────────────────────────────────────────────────────────────────
# Shared safe-write helpers
# ─────────────────────────────────────────────────────────────────────────────


_BACKUP_SESSION: set[str] = set()  # (harness_id, scope.slug) keys already backed up this session


def _backups_root() -> Path:
    from skill_hub import hub_core

    return hub_core.data_home() / "_hub-backups" / "permissions"


def _backup_once_per_session(target: Path, scope: Scope, harness_id: str) -> Optional[Path]:
    """Backup `target` to `~/.skill-hub/_hub-backups/permissions/<harness>/<scope>/<timestamp>.<ext>`.

    Returns the backup path (or None when `target` does not exist OR we already
    backed up this (scope, harness) in the current process).
    """
    if not target.exists():
        return None
    scope_slug = scope.slug
    # Key per target file: one (harness, scope) may now back up multiple files
    # (Codex writes both config.toml and skill-hub.rules), each once per session.
    key = f"{harness_id}::{scope_slug}::{target}"
    if key in _BACKUP_SESSION:
        return None
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    ext = target.suffix.lstrip(".") or "bin"
    backup_dir = _backups_root() / harness_id / scope_slug
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{ts}.{ext}"
    shutil.copy2(target, backup_path)
    _BACKUP_SESSION.add(key)
    return backup_path


def _atomic_replace(target: Path, content: str) -> None:
    """Atomic write: temp file in same dir + fsync + os.replace."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _strip_managed_from_json(data: dict, managed_keys: list[str]) -> dict:
    """Remove only the sidecar-listed managed keys from a JSON-shaped dict.

    `managed_keys` are JSONPath-ish segments — only the formats this module
    writes are supported:
        permissions.allow[<i>]   permissions.deny[<i>]   permissions.ask[<i>]
        hooks.<event>[<i>]       hooks.<event>[<i>].matcher (not used)
        additionalDirectories[<i>]
        permissions.additionalDirectories[<i>]

    Indices are interpreted against the CURRENT file state; we collect them
    per (section, list-name) and delete in reverse to keep earlier indices
    valid. Unknown segments are skipped silently — cleanup is best-effort.
    """
    grouped: dict[tuple, list[int]] = {}
    for key in managed_keys:
        parsed = _parse_managed_key(key)
        if parsed is None:
            continue
        grouped.setdefault(parsed[0], []).append(parsed[1])

    for path, indices in grouped.items():
        target_list = _resolve_list_at_path(data, path)
        if target_list is None:
            continue
        for i in sorted(indices, reverse=True):
            if 0 <= i < len(target_list):
                del target_list[i]
        # Prune empty container paths
        _maybe_prune_empty(data, path)
    return data


def _strip_managed_verified(data: dict, managed_keys: list[str], managed_values: dict) -> list[dict]:
    """Value-verified strip (sidecar v2). Mutates `data` like
    `_strip_managed_from_json`, but an indexed entry with a recorded expected
    value is removed only when the value at that index still matches. On
    mismatch (an external edit reordered the list) the RIGHTMOST occurrence of
    the expected value is removed instead — preferring hub's appended copy —
    and a drift event is recorded. If the expected value is gone from the list
    entirely, nothing is removed for that entry (the user deleted it; deleting
    anything else would destroy a user-authored rule).

    Keys without a recorded value (v1 sidecars, or non-list keys) fall back to
    the legacy positional delete. Returns the drift events:
    `{"key", "expected", "mode": "fallback" | "missing"}`.
    """
    drift: list[dict] = []
    grouped: dict[tuple, list[tuple[int, str]]] = {}
    for key in managed_keys:
        parsed = _parse_managed_key(key)
        if parsed is None:
            continue
        grouped.setdefault(parsed[0], []).append((parsed[1], key))

    for path, entries in grouped.items():
        target_list = _resolve_list_at_path(data, path)
        if target_list is None:
            continue
        # Descending recorded index: legacy deletes keep earlier indices valid,
        # and a fallback delete that shifts later entries self-heals because
        # those entries verify by value before deleting.
        for i, key in sorted(entries, reverse=True):
            expected = managed_values.get(key)
            if expected is None:
                if 0 <= i < len(target_list):
                    del target_list[i]
                continue
            if 0 <= i < len(target_list) and target_list[i] == expected:
                del target_list[i]
                continue
            # Index drifted — remove hub's value wherever it now sits.
            for j in range(len(target_list) - 1, -1, -1):
                if target_list[j] == expected:
                    del target_list[j]
                    drift.append({"key": key, "expected": expected, "mode": "fallback"})
                    break
            else:
                drift.append({"key": key, "expected": expected, "mode": "missing"})
        _maybe_prune_empty(data, path)
    return drift


def permission_block_sha256(payload: dict) -> str:
    """Canonical hash of a translated permissions payload — what apply() is
    about to make true in the native file. Stored in the sidecar so a later
    read can tell whether the registry block changed since the last native
    write (staleness), without diffing files."""
    import hashlib

    canon = {
        "allow": [r.pattern for r in payload.get("allow") or []],
        "deny": [r.pattern for r in payload.get("deny") or []],
        "ask": [r.pattern for r in payload.get("ask") or []],
        "additional_dirs": list(payload.get("additional_dirs") or []),
    }
    return hashlib.sha256(json.dumps(canon, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _parse_managed_key(key: str) -> Optional[tuple[tuple[str, ...], int]]:
    # forms: "permissions.allow[0]", "hooks.PreToolUse[0]", "additionalDirectories[0]"
    import re

    m = re.match(r"^([A-Za-z_.][A-Za-z0-9_.]*)\[(\d+)\]$", key)
    if not m:
        return None
    dotted = tuple(m.group(1).split("."))
    return dotted, int(m.group(2))


def _resolve_list_at_path(root: dict, path: tuple[str, ...]) -> Optional[list]:
    cur: Any = root
    for seg in path:
        if not isinstance(cur, dict) or seg not in cur:
            return None
        cur = cur[seg]
    return cur if isinstance(cur, list) else None


def _maybe_prune_empty(root: dict, path: tuple[str, ...]) -> None:
    cur: Any = root
    parents: list[tuple[dict, str]] = []
    for seg in path:
        if not isinstance(cur, dict) or seg not in cur:
            return
        parents.append((cur, seg))
        cur = cur[seg]
    # Walk back up, deleting empty list/dict containers.
    for parent, seg in reversed(parents):
        val = parent.get(seg)
        if (isinstance(val, list) and not val) or (isinstance(val, dict) and not val):
            del parent[seg]
        else:
            break


# ─────────────────────────────────────────────────────────────────────────────
# `Bash(<prefix…>:*)` pattern grammar shared by the Codex and OpenCode adapters and the rule simulator
# ─────────────────────────────────────────────────────────────────────────────


_BASH_PATTERN_RE = re.compile(r"^Bash\((.*)\)$")


def _bash_prefix_tokens(pattern: str) -> Optional[list[str]]:
    """Parse a registry `Bash(<cmd...>:*)` pattern → prefix token list, or None.

    `Bash(npm:*)` → `["npm"]`; `Bash(git push:*)` → `["git", "push"]`.
    Returns None for `Bash(*)` (no bounded prefix), an empty command, any
    non-Bash tool pattern, or anything unparseable (D3).
    """
    if not pattern:
        return None
    m = _BASH_PATTERN_RE.match(pattern.strip())
    if not m:
        return None
    inner = m.group(1).strip()
    # Strip the trailing argument wildcard marker (`:*` or a bare `*`).
    if inner.endswith(":*"):
        inner = inner[:-2]
    elif inner.endswith("*"):
        inner = inner[:-1].rstrip(":")
    inner = inner.strip()
    if not inner or inner == "*":
        return None
    tokens = inner.split()
    return tokens or None


def _kind_feature(kind: str) -> PermissionFeature:
    return {
        "allow": PermissionFeature.TOOL_ALLOWLIST,
        "deny": PermissionFeature.TOOL_DENYLIST,
        "ask": PermissionFeature.TOOL_ASK,
    }[kind]
