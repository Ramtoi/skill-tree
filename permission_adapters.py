"""Permission adapters — translate NormalizedPermissions → per-harness native writes.

Mirrors `mcp_adapters.py`. Each harness's `permission_adapter_key` selects an
adapter from the `ADAPTERS` registry. Adapters expose:

    translate(perms, scope, harness_id) -> TranslateResult
    apply(scope, native_write, harness_id) -> bool
    cleanup(scope, harness_id) -> bool
    capabilities() -> set[PermissionFeature]
    validate(rule) -> ValidationResult
    discover_existing(scope, harness_id) -> NormalizedPermissions

Round-trip writes preserve unrelated user keys. Cleanup is driven by sidecar
state at `~/.skill-hub/state/<harness>/<scope>.managed.json` — user config files
never contain hub-internal metadata.
"""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Protocol

from permissions import (
    GlobalScope,
    Hook,
    NormalizedPermissions,
    PermissionFeature,
    ProjectScope,
    Rule,
    Scope,
    SidecarState,
    delete_sidecar,
    read_sidecar,
    sidecar_path,
    write_sidecar,
)


# ─────────────────────────────────────────────────────────────────────────────
# Result types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class SkipReason:
    feature: str            # PermissionFeature value
    reason: str             # human-readable why (e.g. "Codex has no per-tool allowlist")
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
    target_path: Path                  # absolute target file
    payload: Any                       # adapter-specific representation
    managed_keys: list[str]            # JSONPath-ish segments owned by hub
    format: str                        # "json" | "toml" | "starlark"


@dataclass
class TranslateResult:
    writes: list[NativeWrite] = field(default_factory=list)
    skipped: list[SkipReason] = field(default_factory=list)
    risks: list = field(default_factory=list)  # list[RiskFinding] — typed lazily to avoid import cycle
    warnings: list[str] = field(default_factory=list)  # human-readable side-effect notices (e.g. auto-granted project trust)


@dataclass
class ValidationResult:
    ok: bool
    error: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Protocol
# ─────────────────────────────────────────────────────────────────────────────


class PermissionAdapter(Protocol):
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
    import risks as _risks
    return _risks.detect_risks(perms, capabilities)


# ─────────────────────────────────────────────────────────────────────────────
# Shared safe-write helpers
# ─────────────────────────────────────────────────────────────────────────────


_BACKUP_SESSION: set[str] = set()  # (harness_id, scope.slug) keys already backed up this session


def _backups_root() -> Path:
    import hub
    return hub.data_home() / "_hub-backups" / "permissions"


def _backup_once_per_session(
    target: Path, scope: Scope, harness_id: str
) -> Optional[Path]:
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
    fd, tmp_name = tempfile.mkstemp(
        prefix=target.name + ".", suffix=".tmp", dir=str(target.parent)
    )
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
# Claude / Pi adapter (JSON settings file)
# ─────────────────────────────────────────────────────────────────────────────


_CLAUDE_PATHS = {
    "claude-code": {
        "project": Path(".claude/settings.json"),
        # Personal, gitignored per-project tier (the harness's native local
        # layer). Targeted only by a ProjectScope with personal=True so a
        # developer can keep per-project rules out of the committed settings.
        "project_local": Path(".claude/settings.local.json"),
        "global": Path("~/.claude/settings.json"),
    },
    "pi": {
        "project": Path(".pi/agent/settings.json"),
        # Pi's personal-file analog under its own settings dir (same
        # settings.local.json convention as Claude Code).
        "project_local": Path(".pi/agent/settings.local.json"),
        "global": Path("~/.pi/agent/settings.json"),
    },
}


# Tool(arg) pattern: a tool name (alnum/underscore) optionally followed by a
# parenthesised argument spec, OR a `Tool:arg` colon form. Used by the
# Claude-family validator below.
_CLAUDE_PATTERN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\(.*\)|:[^()]*)?$")


def _validate_claude_pattern(pattern: str) -> ValidationResult:
    """Syntactic validation of a Claude-family permission pattern.

    Rejects malformed patterns the harness would silently ignore at runtime:
      * unbalanced parentheses (e.g. ``Bash(npm:*`` — missing close paren),
      * empty / missing tool name,
      * stray characters outside the ``Tool(arg)`` / ``Tool:arg`` shapes.

    Valid: ``Bash(npm:*)``, ``Bash(git push:*)``, ``Read(secrets/**)``,
    ``WebFetch(*)``, ``Bash:*``, bare ``Bash``.
    """
    p = pattern.strip()
    if not p:
        return ValidationResult(ok=False, error="empty pattern")
    if p.count("(") != p.count(")"):
        return ValidationResult(ok=False, error="unbalanced parentheses")
    if not _CLAUDE_PATTERN_RE.match(p):
        return ValidationResult(
            ok=False, error="malformed pattern (expected Tool(arg) or Tool:arg)"
        )
    return ValidationResult(ok=True)


_CLAUDE_CAPS = {
    PermissionFeature.TOOL_ALLOWLIST,
    PermissionFeature.TOOL_DENYLIST,
    PermissionFeature.TOOL_ASK,
    PermissionFeature.HOOKS,
    PermissionFeature.ADDITIONAL_DIRECTORIES,
}


class ClaudePermissionAdapter:
    """Writes JSON settings for Claude-shape harnesses (claude-code and pi).

    File target depends on `harness_id` (see `target_files`). Adapter body is
    harness-agnostic; only the path resolver branches.
    """

    def target_files(self, scope: Scope, harness_id: str) -> Path:
        paths = _CLAUDE_PATHS.get(harness_id)
        if paths is None:
            raise ValueError(f"ClaudePermissionAdapter: no path config for harness {harness_id!r}")
        if isinstance(scope, GlobalScope):
            return Path(str(paths["global"])).expanduser()
        # ProjectScope: a personal scope routes to the gitignored local file
        # (.claude/settings.local.json), the shared scope to the committed one.
        if getattr(scope, "personal", False):
            return Path(scope.path) / paths["project_local"]
        return Path(scope.path) / paths["project"]

    def capabilities(self) -> set:
        return set(_CLAUDE_CAPS)

    def validate(self, rule: Rule) -> ValidationResult:
        if not rule.pattern:
            return ValidationResult(ok=False, error="empty pattern")
        if rule.kind not in {"allow", "deny", "ask"}:
            return ValidationResult(ok=False, error=f"unknown kind {rule.kind!r}")
        return _validate_claude_pattern(rule.pattern)

    def translate(
        self,
        perms: NormalizedPermissions,
        scope: Scope,
        harness_id: str,
    ) -> TranslateResult:
        target = self.target_files(scope, harness_id)
        result = TranslateResult()
        caps = self.capabilities()

        # Filter rules by harness affinity (None = all) and feature support.
        def feature_for_kind(kind: str) -> PermissionFeature:
            return {
                "allow": PermissionFeature.TOOL_ALLOWLIST,
                "deny": PermissionFeature.TOOL_DENYLIST,
                "ask": PermissionFeature.TOOL_ASK,
            }[kind]

        def applicable(rule: Rule) -> bool:
            if rule.harnesses is not None and harness_id not in rule.harnesses:
                return False
            return feature_for_kind(rule.kind) in caps

        allow = [r for r in perms.allow if applicable(r)]
        deny = [r for r in perms.deny if applicable(r)]
        ask = [r for r in perms.ask if applicable(r)]

        hooks_applicable: list[Hook] = []
        if PermissionFeature.HOOKS in caps:
            for h in perms.hooks:
                if h.harnesses is None or harness_id in h.harnesses:
                    hooks_applicable.append(h)

        additional_dirs = list(perms.additional_dirs)

        # Skips: typed Codex-only fields not applicable here.
        if perms.sandbox_mode is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.SANDBOX_MODE.value,
                reason=f"{harness_id} has no sandbox_mode field",
            ))
        if perms.approval_policy is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.APPROVAL_POLICY.value,
                reason=f"{harness_id} has no approval_policy field",
            ))
        if perms.project_trust is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.PROJECT_TRUST.value,
                reason=f"{harness_id} has no project_trust field",
            ))

        # Forward-compat: unknown `extras` keys are not recognised by this adapter.
        for extras_key in perms.extras.keys():
            result.skipped.append(SkipReason(
                feature=extras_key,
                reason=f"{harness_id} adapter does not recognise extras key {extras_key!r}",
            ))

        managed_keys: list[str] = []
        for i, _ in enumerate(allow):
            managed_keys.append(f"permissions.allow[{i}]")
        for i, _ in enumerate(deny):
            managed_keys.append(f"permissions.deny[{i}]")
        for i, _ in enumerate(ask):
            managed_keys.append(f"permissions.ask[{i}]")
        # Hooks per-event index will be assigned at apply-time after grouping.
        # We pre-compute it here by grouping:
        events_grouped: dict[str, list[Hook]] = {}
        for h in hooks_applicable:
            events_grouped.setdefault(h.event, []).append(h)
        for event, lst in events_grouped.items():
            for i, _ in enumerate(lst):
                managed_keys.append(f"hooks.{event}[{i}]")
        for i, _ in enumerate(additional_dirs):
            managed_keys.append(f"additionalDirectories[{i}]")

        payload = {
            "allow": allow,
            "deny": deny,
            "ask": ask,
            "hooks_grouped": events_grouped,
            "additional_dirs": additional_dirs,
        }

        result.writes.append(NativeWrite(
            target_path=target,
            payload=payload,
            managed_keys=managed_keys,
            format="json",
        ))
        result.risks = _detect_risks_for_translate(perms, self.capabilities())
        return result

    def apply(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool:
        target = write.target_path

        # 1. Backup once per session if file already exists.
        _backup_once_per_session(target, scope, harness_id)

        # 2. Strip previously-managed keys (sidecar-driven) before re-writing.
        existing: dict = {}
        if target.exists():
            try:
                with open(target) as f:
                    existing = json.load(f)
            except (OSError, json.JSONDecodeError):
                existing = {}

        prior = read_sidecar(harness_id, scope)
        if prior is not None and prior.managed_keys:
            existing = _strip_managed_from_json(existing, prior.managed_keys)

        # 3. Splice in the new managed payload.
        payload = write.payload
        new_managed_keys: list[str] = []

        if payload["allow"] or payload["deny"] or payload["ask"]:
            permissions_section = existing.get("permissions")
            if not isinstance(permissions_section, dict):
                permissions_section = {}
            for kind in ("allow", "deny", "ask"):
                rules = payload[kind]
                if not rules:
                    continue
                lst = list(permissions_section.get(kind) or [])
                base = len(lst)
                for r in rules:
                    lst.append(r.pattern)
                    new_managed_keys.append(f"permissions.{kind}[{base}]")
                    base += 1
                permissions_section[kind] = lst
            existing["permissions"] = permissions_section

        events_grouped: dict[str, list[Hook]] = payload["hooks_grouped"]
        if events_grouped:
            hooks_section = existing.get("hooks")
            if not isinstance(hooks_section, dict):
                hooks_section = {}
            for event, lst in events_grouped.items():
                existing_event_list = list(hooks_section.get(event) or [])
                base = len(existing_event_list)
                for h in lst:
                    existing_event_list.append({
                        "matcher": h.matcher,
                        "command": h.command,
                    })
                    new_managed_keys.append(f"hooks.{event}[{base}]")
                    base += 1
                hooks_section[event] = existing_event_list
            existing["hooks"] = hooks_section

        if payload["additional_dirs"]:
            existing_dirs = list(existing.get("additionalDirectories") or [])
            base = len(existing_dirs)
            for d in payload["additional_dirs"]:
                existing_dirs.append(d)
                new_managed_keys.append(f"additionalDirectories[{base}]")
                base += 1
            existing["additionalDirectories"] = existing_dirs

        # 4. Atomic write of the user-config file.
        content = json.dumps(existing, indent=2, sort_keys=False) + "\n"
        _atomic_replace(target, content)

        # 5. Update sidecar with the new managed keys.
        write_sidecar(harness_id, scope, new_managed_keys, target)
        return True

    def cleanup(self, scope: Scope, harness_id: str) -> bool:
        sc = read_sidecar(harness_id, scope)
        if sc is None:
            return False
        target = Path(sc.file)
        if not target.exists():
            delete_sidecar(harness_id, scope)
            return True
        try:
            with open(target) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return False
        data = _strip_managed_from_json(data, sc.managed_keys)
        _atomic_replace(target, json.dumps(data, indent=2) + "\n")
        delete_sidecar(harness_id, scope)
        return True

    def discover_existing(
        self,
        scope: Scope,
        harness_id: str,
        project_path: Optional[Path] = None,
    ) -> NormalizedPermissions:
        target = self.target_files(scope, harness_id)
        if not target.exists():
            return NormalizedPermissions()
        try:
            with open(target) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return NormalizedPermissions()
        perms_block = data.get("permissions") or {}
        allow = [Rule(pattern=str(p), kind="allow") for p in (perms_block.get("allow") or [])]
        deny = [Rule(pattern=str(p), kind="deny") for p in (perms_block.get("deny") or [])]
        ask = [Rule(pattern=str(p), kind="ask") for p in (perms_block.get("ask") or [])]
        hooks_section = data.get("hooks") or {}
        hooks: list[Hook] = []
        if isinstance(hooks_section, dict):
            for event, entries in hooks_section.items():
                for entry in entries or []:
                    if isinstance(entry, dict):
                        hooks.append(Hook(
                            event=str(event),
                            matcher=str(entry.get("matcher", "")),
                            command=str(entry.get("command", "")),
                        ))
        additional_dirs = list(data.get("additionalDirectories") or [])
        return NormalizedPermissions(
            allow=allow,
            deny=deny,
            ask=ask,
            hooks=hooks,
            additional_dirs=additional_dirs,
        )

    def discover_candidates(
        self,
        scope: Scope,
        harness_id: str,
    ) -> list[dict]:
        """Discovered allow/deny/ask rules as import candidates (cross-harness
        reconciliation). Claude-family rules are always representable (the
        registry pattern model is Claude-shaped). No line span — Claude `drop`
        removes the rule from the JSON settings, not via a source excise.

        Hub-managed rules (those at sidecar `managed_keys` indices) are excluded
        so a rule hub already imported/auto-synced does not re-surface as a fresh
        candidate, and a deliberately-deleted scope (empty managed set) never
        re-prompts (D3 first-contact guarantee)."""
        target = self.target_files(scope, harness_id)
        if not target.exists():
            return []
        try:
            with open(target) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return []
        perms_block = data.get("permissions") or {}

        # Indices hub owns, per kind — exclude them from candidates.
        managed: dict[str, set] = {"allow": set(), "deny": set(), "ask": set()}
        sc = read_sidecar(harness_id, scope)
        if sc is not None:
            for key in sc.managed_keys:
                parsed = _parse_managed_key(key)
                if parsed is None:
                    continue
                path, idx = parsed
                if len(path) == 2 and path[0] == "permissions" and path[1] in managed:
                    managed[path[1]].add(idx)

        out: list[dict] = []
        for kind in ("allow", "deny", "ask"):
            arr = perms_block.get(kind) or []
            for i, p in enumerate(arr):
                if i in managed[kind]:
                    continue  # hub-managed — not a pre-existing user rule
                out.append({
                    "pattern": str(p),
                    "kind": kind,
                    "decision": None,
                    "source": target.name,
                    "harness": harness_id,
                    "file": str(target),
                    "lineno": None,
                    "end_lineno": None,
                    "importable": True,
                    "reason": None,
                })
        return out


# ─────────────────────────────────────────────────────────────────────────────
# Codex pattern-mapping helpers (registry Bash rules ⇄ Starlark prefix_rule)
# ─────────────────────────────────────────────────────────────────────────────


_CODEX_GLOBAL = Path("~/.codex/config.toml")

_CODEX_CAPS = {
    PermissionFeature.SANDBOX_MODE,
    PermissionFeature.APPROVAL_POLICY,
    PermissionFeature.PROJECT_TRUST,
    PermissionFeature.TOOL_ALLOWLIST,
    PermissionFeature.TOOL_DENYLIST,
    PermissionFeature.TOOL_ASK,
}

# kind ↔ Codex decision, both directions (translate + discover).
_KIND_TO_DECISION = {"allow": "allow", "ask": "prompt", "deny": "forbidden"}
_DECISION_TO_KIND = {v: k for k, v in _KIND_TO_DECISION.items()}

_CODEX_RULES_HEADER = (
    "# Generated by Skill Hub — do not edit; managed via the hub registry."
)
_RULES_SIDECAR_KIND = "rules"  # sidecar `kind` for the skill-hub.rules write (D9)

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


def _emit_prefix_rule_line(
    tokens: list[str], decision: str, kind: str, pattern: str
) -> str:
    """Render a single-line `prefix_rule(...)` (D8). `json.dumps` yields the exact
    double-quoted Starlark string/list literals Codex expects."""
    toks_repr = "[" + ", ".join(json.dumps(t) for t in tokens) + "]"
    justification = json.dumps(f"skill-hub: {kind} {pattern}")
    return (
        f"prefix_rule(pattern = {toks_repr}, "
        f"decision = {json.dumps(decision)}, "
        f"justification = {justification})"
    )


def _render_codex_rules_file(entries: list[tuple]) -> str:
    """Deterministically render the full `skill-hub.rules` file from
    `(tokens, decision, kind, pattern)` entries (one prefix_rule per line)."""
    lines = [_CODEX_RULES_HEADER, ""]
    for tokens, decision, kind, pattern in entries:
        lines.append(_emit_prefix_rule_line(tokens, decision, kind, pattern))
    return "\n".join(lines) + "\n"


def _codex_rules_target(scope: Scope) -> Path:
    """`~/.codex/rules/skill-hub.rules` (global) or `<repo>/.codex/rules/skill-hub.rules`."""
    if isinstance(scope, GlobalScope):
        return Path("~/.codex/rules/skill-hub.rules").expanduser()
    return Path(scope.path) / ".codex" / "rules" / "skill-hub.rules"


def _codex_default_rules_target(scope: Scope) -> Path:
    """The user's TUI-owned `default.rules` for a scope (read/import only)."""
    if isinstance(scope, GlobalScope):
        return Path("~/.codex/rules/default.rules").expanduser()
    return Path(scope.path) / ".codex" / "rules" / "default.rules"


def _nonempty_literal(node) -> bool:
    """True if an ast node is a non-empty literal (or can't be proven empty)."""
    try:
        return bool(ast.literal_eval(node))
    except Exception:
        return True


def _parse_prefix_rules(text: str) -> list[dict]:
    """Parse `prefix_rule()` calls from Starlark/Python text via `ast` (D4).

    Returns a list of dicts with keys: `tokens` (list[str] | None),
    `decision`, `justification`, `has_match` (bool), `lineno`, `end_lineno`,
    `importable` (bool), `reason` (str | None). Raises on parse failure — the
    caller decides how to skip a non-parseable file.
    """
    tree = ast.parse(text)
    out: list[dict] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Name) and func.id == "prefix_rule"):
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}

        decision = "allow"
        if "decision" in kwargs:
            try:
                decision = ast.literal_eval(kwargs["decision"])
            except Exception:
                decision = None
        justification = None
        if "justification" in kwargs:
            try:
                justification = ast.literal_eval(kwargs["justification"])
            except Exception:
                justification = None

        has_match = (
            "match" in kwargs and _nonempty_literal(kwargs["match"])
        ) or (
            "not_match" in kwargs and _nonempty_literal(kwargs["not_match"])
        )

        tokens: Optional[list[str]] = None
        importable = True
        reason: Optional[str] = None
        pattern_node = kwargs.get("pattern")
        try:
            pat_val = ast.literal_eval(pattern_node) if pattern_node is not None else None
        except Exception:
            pat_val = None
        if (
            isinstance(pat_val, list)
            and pat_val
            and all(isinstance(t, str) for t in pat_val)
        ):
            tokens = [str(t) for t in pat_val]
        else:
            importable = False
            reason = "pattern is not a flat list of string literals (union/multi-alternative)"

        if has_match:
            importable = False
            reason = "uses match/not_match argument constraints"
        if decision not in _DECISION_TO_KIND:
            importable = False
            reason = reason or f"unsupported decision {decision!r}"

        out.append({
            "tokens": tokens,
            "decision": decision,
            "justification": justification,
            "has_match": has_match,
            "lineno": node.lineno,
            "end_lineno": getattr(node, "end_lineno", node.lineno),
            "importable": importable,
            "reason": reason,
        })
    return out


def _prefix_rule_to_registry_pattern(tokens: list[str]) -> str:
    """`["git", "push"]` → `Bash(git push:*)`."""
    return f"Bash({' '.join(tokens)}:*)"


# ─────────────────────────────────────────────────────────────────────────────
# Codex adapter (TOML config + Starlark rules)
# ─────────────────────────────────────────────────────────────────────────────


class CodexPermissionAdapter:
    """Writes `~/.codex/config.toml` (typed knobs + project trust) AND a
    hub-owned Starlark rules file (`skill-hub.rules`) for translatable Bash
    command rules.

    Global scope: top-level keys (`approval_policy`, `sandbox_mode`) +
    `~/.codex/rules/skill-hub.rules`.
    Project scope: `[projects."<abs-path>"]` table with `trust_level = "trusted"`
    + `<repo>/.codex/rules/skill-hub.rules`.
    """

    def target_files(self, scope: Scope, harness_id: str = "codex") -> Path:
        # Codex is global-only on disk; project-scope writes also land in the
        # global file under `[projects."<path>"]`. This is the primary
        # (config.toml) target; the Starlark rules file has its own resolver.
        if harness_id != "codex":
            raise ValueError(
                f"CodexPermissionAdapter: unsupported harness {harness_id!r}"
            )
        return Path(str(_CODEX_GLOBAL)).expanduser()

    def rules_file(self, scope: Scope) -> Path:
        return _codex_rules_target(scope)

    def capabilities(self) -> set:
        return set(_CODEX_CAPS)

    def validate(self, rule: Rule) -> ValidationResult:
        # Translatable iff it yields a bounded Bash prefix; everything else
        # (non-Bash tools, unbounded Bash(*)) is unsupported here.
        if not rule.pattern:
            return ValidationResult(ok=False, error="empty pattern")
        if rule.kind not in _KIND_TO_DECISION:
            return ValidationResult(ok=False, error=f"unknown kind {rule.kind!r}")
        if _bash_prefix_tokens(rule.pattern) is None:
            return ValidationResult(
                ok=False,
                error="Codex command rules require a bounded Bash prefix (Bash(<cmd>:*))",
            )
        return ValidationResult(ok=True)

    def _load_doc(self, path: Path):
        import tomlkit
        if not path.exists():
            return tomlkit.document()
        try:
            return tomlkit.parse(path.read_text())
        except Exception as e:
            print(f"warning: cannot parse {path}: {e} — skipping Codex permission write",
                  file=sys.stderr)
            return None

    def translate(
        self,
        perms: NormalizedPermissions,
        scope: Scope,
        harness_id: str,
    ) -> TranslateResult:
        target = self.target_files(scope, harness_id)
        result = TranslateResult()

        def applicable(harnesses: Optional[list[str]]) -> bool:
            return harnesses is None or harness_id in harnesses

        # ── Partition allow/deny/ask into translatable prefix rules vs skips ──
        rule_entries: list[tuple] = []  # (tokens, decision, kind, pattern)
        has_command_rule = False
        for kind, rules in (
            ("allow", perms.allow),
            ("deny", perms.deny),
            ("ask", perms.ask),
        ):
            for r in rules:
                if not applicable(r.harnesses):
                    continue
                tokens = _bash_prefix_tokens(r.pattern)
                if tokens is None:
                    result.skipped.append(SkipReason(
                        feature=_kind_feature(kind).value,
                        reason=(
                            "Codex command rules require a bounded Bash prefix "
                            "(Bash(<cmd>:*)); no prefix could be derived"
                        ),
                        rule_pattern=r.pattern,
                    ))
                    # Dropping a security CONTROL (deny/ask) is a regression, not
                    # a dropped convenience — escalate to a risk finding.
                    if kind in ("deny", "ask"):
                        import risks as _risks
                        result.risks.append(
                            _risks.dropped_deny_finding(r.pattern, harness_id, kind)
                        )
                    continue
                rule_entries.append((tokens, _KIND_TO_DECISION[kind], kind, r.pattern))
                has_command_rule = True

        for h in perms.hooks:
            if applicable(h.harnesses):
                result.skipped.append(SkipReason(
                    feature=PermissionFeature.HOOKS.value,
                    reason="Codex has no hooks",
                    detail=f"{h.event}/{h.matcher}",
                ))
                import risks as _risks
                result.risks.append(
                    _risks.dropped_hook_finding(h.event, h.matcher, harness_id)
                )
        if perms.additional_dirs:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.ADDITIONAL_DIRECTORIES.value,
                reason="Codex has no additionalDirectories field",
            ))

        # Forward-compat: unknown `extras` keys are not recognised by this adapter.
        for extras_key in perms.extras.keys():
            result.skipped.append(SkipReason(
                feature=extras_key,
                reason=f"codex adapter does not recognise extras key {extras_key!r}",
            ))

        # ── config.toml payload (typed knobs + project trust) ──
        toml_managed: list[str] = []
        toml_payload: dict[str, Any] = {}
        trust_auto_granted = False

        if isinstance(scope, GlobalScope):
            if perms.approval_policy is not None:
                toml_payload["approval_policy"] = perms.approval_policy
                toml_managed.append("approval_policy")
            if perms.sandbox_mode is not None:
                toml_payload["sandbox_mode"] = perms.sandbox_mode
                toml_managed.append("sandbox_mode")
        elif isinstance(scope, ProjectScope):
            grant_trust = perms.project_trust is True
            # Auto-grant trust so Codex loads the project rules file (D5).
            if has_command_rule and not grant_trust:
                grant_trust = True
                trust_auto_granted = True
            if grant_trust:
                toml_payload["projects"] = {scope.path: {"trust_level": "trusted"}}
                toml_managed.append(
                    f'projects.{_codex_project_key(scope.path)}.trust_level'
                )

        # Prepend the base risk findings (the partition loop above may already
        # have appended DROPPED_DENY/DROPPED_HOOK escalations — keep those).
        result.risks = (
            _detect_risks_for_translate(perms, self.capabilities()) + result.risks
        )

        if trust_auto_granted:
            warning = (
                f"Codex project trust auto-granted for {scope.name!r} "
                f"({scope.path}) so its command rules load — this also activates "
                f"any committed .codex/config.toml and project-local hooks."
            )
            result.warnings.append(warning)
            import risks as _risks
            result.risks.append(_risks.RiskFinding(
                code="CODEX_PROJECT_TRUST_GRANTED",
                severity="warning",
                explanation=(
                    "Writing project command rules auto-granted trust to the project's "
                    ".codex/ layer, activating any committed config.toml and hooks."
                ),
                detail=f"{scope.name} ({scope.path})",
            ))

        # ── Emit writes ──
        if toml_payload:
            result.writes.append(NativeWrite(
                target_path=target,
                payload=toml_payload,
                managed_keys=toml_managed,
                format="toml",
            ))

        if rule_entries:
            content = _render_codex_rules_file(rule_entries)
            managed = [f"prefix_rule[{i}]" for i in range(len(rule_entries))]
            result.writes.append(NativeWrite(
                target_path=_codex_rules_target(scope),
                payload=content,
                managed_keys=managed,
                format="starlark",
            ))
        elif read_sidecar(harness_id, scope, _RULES_SIDECAR_KIND) is not None:
            # All translatable rules removed but a hub rules file still exists —
            # emit a deletion write so re-sync clears the stale file (no ghosts).
            result.writes.append(NativeWrite(
                target_path=_codex_rules_target(scope),
                payload=None,
                managed_keys=[],
                format="starlark",
            ))

        return result

    def apply(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool:
        if write.format == "starlark":
            return self._apply_rules(scope, write, harness_id)
        return self._apply_toml(scope, write, harness_id)

    def _apply_rules(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool:
        target = write.target_path
        _backup_once_per_session(target, scope, harness_id)
        if write.payload is None:
            # Deletion write — remove the hub rules file + its sidecar.
            if target.exists():
                try:
                    target.unlink()
                except OSError:
                    pass
            delete_sidecar(harness_id, scope, _RULES_SIDECAR_KIND)
            return True
        _atomic_replace(target, write.payload)
        write_sidecar(harness_id, scope, write.managed_keys, target, _RULES_SIDECAR_KIND)
        return True

    def _apply_toml(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool:
        import tomlkit
        target = write.target_path
        _backup_once_per_session(target, scope, harness_id)

        doc = self._load_doc(target)
        if doc is None:
            return False

        # Strip prior managed keys
        prior = read_sidecar(harness_id, scope)
        if prior is not None and prior.managed_keys:
            for key in prior.managed_keys:
                _codex_strip_key(doc, key)

        payload = write.payload
        new_managed_keys: list[str] = []
        for k, v in payload.items():
            if k == "projects" and isinstance(v, dict):
                projects_tbl = doc.get("projects")
                if projects_tbl is None:
                    projects_tbl = tomlkit.table()
                    doc["projects"] = projects_tbl
                for proj_path, proj_data in v.items():
                    proj_tbl = projects_tbl.get(proj_path)
                    if proj_tbl is None:
                        proj_tbl = tomlkit.table()
                        projects_tbl[proj_path] = proj_tbl
                    for pk, pv in proj_data.items():
                        proj_tbl[pk] = pv
                        new_managed_keys.append(f'projects.{_codex_project_key(proj_path)}.{pk}')
            else:
                doc[k] = v
                new_managed_keys.append(k)

        _atomic_replace(target, tomlkit.dumps(doc))
        write_sidecar(harness_id, scope, new_managed_keys, target)
        return True

    def cleanup(self, scope: Scope, harness_id: str) -> bool:
        import tomlkit
        did = False

        # ── TOML sidecar: strip managed keys from config.toml ──
        sc = read_sidecar(harness_id, scope)
        if sc is not None:
            target = Path(sc.file)
            if not target.exists():
                delete_sidecar(harness_id, scope)
                did = True
            else:
                doc = self._load_doc(target)
                if doc is not None:
                    for key in sc.managed_keys:
                        _codex_strip_key(doc, key)
                    _atomic_replace(target, tomlkit.dumps(doc))
                    delete_sidecar(harness_id, scope)
                    did = True

        # ── Rules sidecar: delete the hub-owned skill-hub.rules file ──
        rsc = read_sidecar(harness_id, scope, _RULES_SIDECAR_KIND)
        if rsc is not None:
            rules_file = Path(rsc.file)
            if rules_file.exists():
                try:
                    rules_file.unlink()
                except OSError:
                    pass
            delete_sidecar(harness_id, scope, _RULES_SIDECAR_KIND)
            did = True

        return did

    def discover_existing(
        self,
        scope: Scope,
        harness_id: str,
        project_path: Optional[Path] = None,
    ) -> NormalizedPermissions:
        # Reads only config.toml typed knobs / project trust. The user's
        # `default.rules` command rules are surfaced via `discover_candidates`
        # for the interactive import wizard (MOVE semantics), NOT auto-imported
        # during ordinary sync (D10/8.3).
        import tomlkit
        target = self.target_files(scope, harness_id)
        if not target.exists():
            return NormalizedPermissions()
        try:
            doc = tomlkit.parse(target.read_text())
        except Exception:
            return NormalizedPermissions()

        if isinstance(scope, GlobalScope):
            return NormalizedPermissions(
                approval_policy=doc.get("approval_policy"),
                sandbox_mode=doc.get("sandbox_mode"),
            )
        # Project scope
        projects = doc.get("projects") or {}
        proj_path = scope.path
        proj = projects.get(proj_path) if hasattr(projects, "get") else None
        if proj is None:
            return NormalizedPermissions()
        trust = proj.get("trust_level") if hasattr(proj, "get") else None
        return NormalizedPermissions(
            project_trust=(str(trust) == "trusted") if trust is not None else None,
        )

    def discover_candidates(
        self,
        scope: Scope,
        harness_id: str = "codex",
    ) -> list[dict]:
        """Discover importable command rules from the user's `default.rules`
        (and hub's own `skill-hub.rules`) for the interactive import wizard.

        Each candidate dict carries: `pattern` (registry-shaped, or None when
        un-importable), `kind`, `decision`, `source` ("default.rules" |
        "skill-hub.rules"), `harness`, `file`, `lineno`, `end_lineno`,
        `importable`, `reason`. A file that fails to parse is skipped with a
        warning (D4).
        """
        candidates: list[dict] = []
        for source, path in (
            ("default.rules", _codex_default_rules_target(scope)),
            ("skill-hub.rules", _codex_rules_target(scope)),
        ):
            if not path.exists():
                continue
            try:
                parsed = _parse_prefix_rules(path.read_text())
            except (SyntaxError, ValueError) as e:
                print(
                    f"warning: cannot parse {path}: {e} — skipping for import",
                    file=sys.stderr,
                )
                continue
            for pr in parsed:
                importable = pr["importable"]
                pattern = None
                kind = None
                if importable and pr["tokens"] is not None:
                    pattern = _prefix_rule_to_registry_pattern(pr["tokens"])
                    kind = _DECISION_TO_KIND.get(pr["decision"])
                    if kind is None:
                        importable = False
                candidates.append({
                    "pattern": pattern,
                    "kind": kind,
                    "decision": pr["decision"],
                    "source": source,
                    "harness": harness_id,
                    "file": str(path),
                    "lineno": pr["lineno"],
                    "end_lineno": pr["end_lineno"],
                    "importable": importable,
                    "reason": pr["reason"],
                })
        return candidates

    def excise_rule(self, file_path: Path, lineno: int, end_lineno: int) -> bool:
        """Surgically remove the `prefix_rule()` call spanning `lineno`..`end_lineno`
        (1-based, inclusive) from a `.rules` file, preserving everything else (D10).

        The file is backed up once per session before the first edit. Returns
        True on success, False if the file is gone.
        """
        if not file_path.exists():
            return False
        # Back up default.rules (user-owned) before the first surgical edit.
        scope_for_backup = GlobalScope()
        _backup_once_per_session(file_path, scope_for_backup, "codex")
        lines = file_path.read_text().splitlines(keepends=True)
        # Convert to 0-based slice; clamp defensively.
        start = max(0, lineno - 1)
        end = min(len(lines), end_lineno)
        if start >= end:
            return False
        del lines[start:end]
        _atomic_replace(file_path, "".join(lines))
        return True

    def excise_pattern(
        self, file_path: Path, pattern: str, kind: Optional[str] = None
    ) -> bool:
        """Excise the `prefix_rule()` matching `pattern` (and optional `kind`)
        from a `.rules` file. Re-parses on each call so successive excises see
        fresh line spans. Returns True iff a matching rule was removed."""
        if not file_path.exists():
            return False
        try:
            parsed = _parse_prefix_rules(file_path.read_text())
        except (SyntaxError, ValueError):
            return False
        for pr in parsed:
            if not pr["tokens"]:
                continue
            if _prefix_rule_to_registry_pattern(pr["tokens"]) != pattern:
                continue
            if kind is not None and _DECISION_TO_KIND.get(pr["decision"]) != kind:
                continue
            return self.excise_rule(file_path, pr["lineno"], pr["end_lineno"])
        return False


def _codex_project_key(path: str) -> str:
    # Embed an absolute path inside a dotted JSONPath-ish key. We use a
    # bracketed-string-style segment to keep parsing simple in `_codex_strip_key`.
    return f'"{path}"'


def _codex_strip_key(doc, key: str) -> None:
    """Strip a single managed key path from a tomlkit doc.

    Supported forms:
        approval_policy
        sandbox_mode
        projects."<abs-path>".trust_level
    """
    # Special-case the projects."<path>".<field> form.
    if key.startswith("projects."):
        # Strip leading "projects." then peel off bracketed quoted path.
        rest = key[len("projects."):]
        if not rest.startswith('"'):
            return
        end = rest.find('"', 1)
        if end == -1:
            return
        proj_path = rest[1:end]
        tail = rest[end + 1 :]
        if not tail.startswith(".") or not tail[1:]:
            return
        field_name = tail[1:]
        projects = doc.get("projects")
        if projects is None:
            return
        proj = projects.get(proj_path) if hasattr(projects, "get") else None
        if proj is None:
            return
        try:
            del proj[field_name]
        except KeyError:
            return
        # Optionally remove empty per-project table
        try:
            keys = list(proj.keys())
        except Exception:
            keys = []
        if not keys:
            try:
                del projects[proj_path]
            except KeyError:
                pass
        return

    # Plain top-level key
    try:
        del doc[key]
    except KeyError:
        return


# ─────────────────────────────────────────────────────────────────────────────
# Cross-harness import reconciliation (D11)
# ─────────────────────────────────────────────────────────────────────────────


def gather_import_candidates(scope: Scope, harness_ids: list[str]) -> list[dict]:
    """Collect import candidates from every installed harness that exposes
    `discover_candidates`, tagged by source file + harness."""
    import harnesses as _harnesses

    out: list[dict] = []
    for h_id in harness_ids:
        harness = _harnesses.HARNESSES.get(h_id)
        if harness is None or harness.permission_adapter_key is None:
            continue
        adapter = get_adapter(harness.permission_adapter_key)
        if adapter is None or not hasattr(adapter, "discover_candidates"):
            continue
        try:
            out.extend(adapter.discover_candidates(scope, h_id))
        except Exception as e:
            print(f"warning: discover_candidates failed for {h_id}: {e}", file=sys.stderr)
    return out


def reconcile_candidates(candidates: list[dict]) -> dict:
    """Reconcile cross-harness candidates into the single registry model (D11).

    - Same command (registry pattern) + same kind across harnesses → one
      affinity-free `merged` rule (collapsed; `sources` records every origin so
      import can MOVE/excise each).
    - Same command + divergent kind across harnesses → a `conflict` (never
      auto-picked); `options` maps kind → harness ids.
    - Un-representable candidates (Codex `match`/`not_match`, unions) pass
      through as `un_importable` with their reason.
    """
    importable = [c for c in candidates if c.get("importable") and c.get("pattern")]
    un_importable = [c for c in candidates if not c.get("importable")]

    by_pattern: dict[str, list[dict]] = {}
    for c in importable:
        by_pattern.setdefault(c["pattern"], []).append(c)

    merged: list[dict] = []
    conflicts: list[dict] = []
    for pattern in sorted(by_pattern):
        group = by_pattern[pattern]
        kinds = {c["kind"] for c in group}
        if len(kinds) == 1:
            merged.append({
                "pattern": pattern,
                "kind": next(iter(kinds)),
                "harnesses": None,  # collapses → applies to all
                "sources": group,
            })
        else:
            options: dict[str, list[str]] = {}
            for c in group:
                options.setdefault(c["kind"], []).append(c["harness"])
            conflicts.append({
                "pattern": pattern,
                "options": {k: sorted(set(v)) for k, v in options.items()},
                "sources": group,
            })
    return {"merged": merged, "conflicts": conflicts, "un_importable": un_importable}


# ─────────────────────────────────────────────────────────────────────────────
# opencode adapter — opencode.json `permission.bash` (last-match-wins prefixes)
# ─────────────────────────────────────────────────────────────────────────────


_OPENCODE_CAPS = {
    PermissionFeature.TOOL_ALLOWLIST,
    PermissionFeature.TOOL_DENYLIST,
    PermissionFeature.TOOL_ASK,
}

# opencode permission action == hub kind, 1:1 (cleaner than Codex's `prompt`).
# Verified against https://opencode.ai/config.json (fetched 2026-06-10).
_OPENCODE_DECISION = {"allow": "allow", "ask": "ask", "deny": "deny"}

_OPENCODE_BASH_PREFIX = "permission.bash."  # managed-key namespace in the sidecar


def _opencode_target(scope: Scope) -> Path:
    """`~/.config/opencode/opencode.json` (global) or `<repo>/opencode.json`."""
    if isinstance(scope, GlobalScope):
        return Path("~/.config/opencode/opencode.json").expanduser()
    return Path(scope.path) / "opencode.json"


def _opencode_bash_prefix(tokens: list[str]) -> str:
    """`["git", "push"]` → `"git push *"` (opencode space-separated glob prefix)."""
    return " ".join(tokens) + " *"


def _opencode_pattern_from_prefix(prefix: str) -> Optional[str]:
    """Reverse of `_opencode_bash_prefix`: `"git push *"` → `Bash(git push:*)`.

    Returns None for the catch-all `"*"` (an unbounded `Bash(*)` the hub model
    deliberately does not represent as a discrete rule)."""
    p = prefix.strip()
    if p.endswith(" *"):
        p = p[:-2].strip()
    elif p.endswith("*"):
        p = p[:-1].strip()
    if not p or p == "*":
        return None
    return f"Bash({p}:*)"


def _opencode_sort_key(tokens: list[str]) -> tuple:
    """Order most-specific-LAST for opencode's last-match-wins bash matching:
    fewer / shorter prefixes sort first, so a more specific rule (more tokens)
    is emitted after — and therefore overrides — a broader one."""
    return (len(tokens), len(" ".join(tokens)), tokens)


class OpenCodePermissionAdapter:
    """Writes opencode per-command bash permissions into `opencode.json`.

    opencode stores permissions under the top-level `permission` key in the
    SAME file the MCP adapter targets — global `~/.config/opencode/
    opencode.json`, project `<repo>/opencode.json`. Per-command bash rules live
    under `permission.bash` as an OBJECT mapping space-separated glob prefixes
    to actions (`"npm *": "allow"`), evaluated **last-match-wins**. Verified
    against https://opencode.ai/config.json (fetched 2026-06-10).

    Translation: each registry `Bash(<cmd…>:*)` rule → one `permission.bash`
    entry (`_bash_prefix_tokens` → `"<cmd…> *"`); kinds map 1:1
    (`allow`/`ask`/`deny`). Rules are emitted most-specific-last so a specific
    rule overrides a broader one under last-match-wins. Non-Bash tool rules,
    unbounded `Bash(*)`, and ALL hooks are skipped (opencode has no
    permission-hook target). The bash map is a dict, not an indexed list, so
    this adapter owns its own strip/splice (it cannot use the index-based
    `_strip_managed_from_json`). Managed keys are tracked as
    `permission.bash.<prefix>` in the per-file sidecar; writes are
    merge-preserving (user `permission.*` keys and the `mcp` block survive).
    """

    def target_files(self, scope: Scope, harness_id: str) -> Path:
        return _opencode_target(scope)

    def capabilities(self) -> set:
        return set(_OPENCODE_CAPS)

    def validate(self, rule: Rule) -> ValidationResult:
        if not rule.pattern:
            return ValidationResult(ok=False, error="empty pattern")
        if rule.kind not in {"allow", "deny", "ask"}:
            return ValidationResult(ok=False, error=f"unknown kind {rule.kind!r}")
        return ValidationResult(ok=True)

    def translate(
        self,
        perms: NormalizedPermissions,
        scope: Scope,
        harness_id: str,
    ) -> TranslateResult:
        target = self.target_files(scope, harness_id)
        result = TranslateResult()
        caps = self.capabilities()

        def applicable(rule: Rule) -> bool:
            if rule.harnesses is not None and harness_id not in rule.harnesses:
                return False
            return _kind_feature(rule.kind) in caps

        # Collect (tokens, kind) for translatable Bash rules; skip the rest.
        entries: list[tuple[list[str], str]] = []
        for kind, rules in (("allow", perms.allow), ("deny", perms.deny), ("ask", perms.ask)):
            for r in rules:
                if not applicable(r):
                    continue
                tokens = _bash_prefix_tokens(r.pattern)
                if tokens is None:
                    result.skipped.append(SkipReason(
                        feature=_kind_feature(kind).value,
                        reason=(
                            "opencode bash rules need a bounded command prefix; "
                            "non-Bash tools and unbounded Bash(*) are not translatable"
                        ),
                        rule_pattern=r.pattern,
                    ))
                    # Dropping a deny/ask security control is a regression — escalate.
                    if kind in ("deny", "ask"):
                        import risks as _risks
                        result.risks.append(
                            _risks.dropped_deny_finding(r.pattern, harness_id, kind)
                        )
                    continue
                entries.append((tokens, kind))

        # Hooks: opencode has no permission-hook equivalent.
        for h in perms.hooks:
            if h.harnesses is None or harness_id in h.harnesses:
                result.skipped.append(SkipReason(
                    feature=PermissionFeature.HOOKS.value,
                    reason="opencode has no permission-hook target",
                    detail=f"{h.event}:{h.matcher}",
                ))
                import risks as _risks
                result.risks.append(
                    _risks.dropped_hook_finding(h.event, h.matcher, harness_id)
                )

        # Typed Codex-only fields + additional dirs + extras are not representable.
        if perms.sandbox_mode is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.SANDBOX_MODE.value,
                reason="opencode has no sandbox_mode field",
            ))
        if perms.approval_policy is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.APPROVAL_POLICY.value,
                reason="opencode has no approval_policy field",
            ))
        if perms.project_trust is not None:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.PROJECT_TRUST.value,
                reason="opencode has no project_trust field",
            ))
        for d in perms.additional_dirs:
            result.skipped.append(SkipReason(
                feature=PermissionFeature.ADDITIONAL_DIRECTORIES.value,
                reason="opencode has no additional-directories permission field",
                detail=d,
            ))
        for extras_key in perms.extras.keys():
            result.skipped.append(SkipReason(
                feature=extras_key,
                reason=f"opencode adapter does not recognise extras key {extras_key!r}",
            ))

        # Order most-specific-LAST (last-match-wins). Insertion order into the
        # dict == JSON key order == opencode evaluation order. A later duplicate
        # prefix (same command, divergent kind) wins, matching opencode runtime.
        entries.sort(key=lambda e: _opencode_sort_key(e[0]))
        bash_rules: dict[str, str] = {}
        for tokens, kind in entries:
            bash_rules[_opencode_bash_prefix(tokens)] = _OPENCODE_DECISION[kind]

        managed_keys = [f"{_OPENCODE_BASH_PREFIX}{prefix}" for prefix in bash_rules]

        result.writes.append(NativeWrite(
            target_path=target,
            payload={"bash": bash_rules},
            managed_keys=managed_keys,
            format="json",
        ))
        # Keep any DROPPED_DENY/DROPPED_HOOK escalations appended above.
        result.risks = _detect_risks_for_translate(perms, caps) + result.risks
        return result

    # ── apply / cleanup own their dict-keyed strip (not the list-index helper) ──

    def _strip_managed(self, data: dict, managed_keys: list[str]) -> None:
        perm = data.get("permission")
        if not isinstance(perm, dict):
            return
        bash = perm.get("bash")
        if not isinstance(bash, dict):
            return
        for key in managed_keys:
            if not key.startswith(_OPENCODE_BASH_PREFIX):
                continue
            prefix = key[len(_OPENCODE_BASH_PREFIX):]
            bash.pop(prefix, None)
        if not bash:
            perm.pop("bash", None)
        if not perm:
            data.pop("permission", None)

    def apply(self, scope: Scope, write: NativeWrite, harness_id: str) -> bool:
        target = write.target_path
        bash_rules: dict[str, str] = write.payload["bash"]

        prior = read_sidecar(harness_id, scope)
        # Nothing to write and nothing previously managed → never create a file.
        if not bash_rules and not target.exists() and (prior is None or not prior.managed_keys):
            return False

        _backup_once_per_session(target, scope, harness_id)

        existing: dict = {}
        if target.exists():
            try:
                with open(target) as f:
                    loaded = json.load(f)
                existing = loaded if isinstance(loaded, dict) else {}
            except (OSError, json.JSONDecodeError):
                existing = {}

        if prior is not None and prior.managed_keys:
            self._strip_managed(existing, prior.managed_keys)

        new_managed_keys: list[str] = []
        if bash_rules:
            perm_section = existing.get("permission")
            if not isinstance(perm_section, dict):
                perm_section = {}
            bash_section = perm_section.get("bash")
            # opencode allows `bash` to be a bare action string; promote it to
            # object form under "*" so we can splice without losing the user's
            # global default.
            if isinstance(bash_section, str):
                bash_section = {"*": bash_section}
            elif not isinstance(bash_section, dict):
                bash_section = {}
            for prefix, decision in bash_rules.items():
                bash_section[prefix] = decision
                new_managed_keys.append(f"{_OPENCODE_BASH_PREFIX}{prefix}")
            perm_section["bash"] = bash_section
            existing["permission"] = perm_section

        _atomic_replace(target, json.dumps(existing, indent=2, sort_keys=False) + "\n")
        write_sidecar(harness_id, scope, new_managed_keys, target)
        return True

    def cleanup(self, scope: Scope, harness_id: str) -> bool:
        sc = read_sidecar(harness_id, scope)
        if sc is None:
            return False
        target = Path(sc.file)
        if not target.exists():
            delete_sidecar(harness_id, scope)
            return True
        try:
            with open(target) as f:
                loaded = json.load(f)
            data = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError):
            return False
        self._strip_managed(data, sc.managed_keys)
        _atomic_replace(target, json.dumps(data, indent=2) + "\n")
        delete_sidecar(harness_id, scope)
        return True

    def discover_existing(
        self,
        scope: Scope,
        harness_id: str,
        project_path: Optional[Path] = None,
    ) -> NormalizedPermissions:
        target = self.target_files(scope, harness_id)
        if not target.exists():
            return NormalizedPermissions()
        try:
            with open(target) as f:
                loaded = json.load(f)
            data = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError):
            return NormalizedPermissions()
        perm = data.get("permission")
        bash = perm.get("bash") if isinstance(perm, dict) else None
        buckets: dict[str, list[Rule]] = {"allow": [], "deny": [], "ask": []}
        if isinstance(bash, dict):
            for prefix, decision in bash.items():
                kind = {"allow": "allow", "ask": "ask", "deny": "deny"}.get(str(decision))
                if kind is None:
                    continue
                pattern = _opencode_pattern_from_prefix(str(prefix))
                if pattern is None:
                    continue
                buckets[kind].append(Rule(pattern=pattern, kind=kind))
        return NormalizedPermissions(
            allow=buckets["allow"], deny=buckets["deny"], ask=buckets["ask"]
        )

    def discover_candidates(self, scope: Scope, harness_id: str) -> list[dict]:
        """opencode bash rules as cross-harness import candidates. Every
        translatable prefix round-trips through the registry's Bash model, so
        all discovered rules are importable; `drop` later removes the key from
        `opencode.json` directly (no source span needed)."""
        discovered = self.discover_existing(scope, harness_id)
        target = self.target_files(scope, harness_id)
        out: list[dict] = []
        for kind, rules in (
            ("allow", discovered.allow),
            ("deny", discovered.deny),
            ("ask", discovered.ask),
        ):
            for r in rules:
                out.append({
                    "pattern": r.pattern,
                    "kind": kind,
                    "decision": None,
                    "source": target.name,
                    "harness": harness_id,
                    "file": str(target),
                    "lineno": None,
                    "end_lineno": None,
                    "importable": True,
                    "reason": None,
                })
        return out


# ─────────────────────────────────────────────────────────────────────────────
# Adapter registry
# ─────────────────────────────────────────────────────────────────────────────


_CLAUDE_ADAPTER = ClaudePermissionAdapter()
_CODEX_ADAPTER = CodexPermissionAdapter()
_OPENCODE_ADAPTER = OpenCodePermissionAdapter()

ADAPTERS: dict[str, PermissionAdapter] = {
    "claude": _CLAUDE_ADAPTER,
    "codex": _CODEX_ADAPTER,
    "opencode": _OPENCODE_ADAPTER,
}


def get_adapter(key: Optional[str]) -> Optional[PermissionAdapter]:
    if key is None:
        return None
    return ADAPTERS.get(key)


# ─────────────────────────────────────────────────────────────────────────────
# Rule simulator — "what decision would command X get?"
# ─────────────────────────────────────────────────────────────────────────────


def _command_tokens(command: str) -> list[str]:
    """Split a concrete shell command into its leading tokens for prefix matching.

    Best-effort: whitespace split is enough to match `Bash(<prefix>:*)` rules,
    whose patterns are themselves whitespace-split prefixes.
    """
    return command.strip().split()


def _bash_rule_matches_command(pattern: str, cmd_tokens: list[str]) -> Optional[int]:
    """Return the prefix length (specificity) a `Bash(...)` pattern matches the
    command with, or None when it does not apply.

    `Bash(*)` (unbounded) matches everything with specificity 0. A bounded
    prefix `Bash(git push:*)` matches `git push origin main` with specificity 2
    (it is a token-wise prefix of the command). A longer/divergent prefix does
    not match.
    """
    m = _BASH_PATTERN_RE.match(pattern.strip())
    if not m:
        return None  # non-Bash tool pattern — simulator only models Bash
    tokens = _bash_prefix_tokens(pattern)
    if tokens is None:
        # Unbounded Bash(*) (or empty) — matches any command, lowest specificity.
        inner = m.group(1).strip()
        if inner in ("*", ""):
            return 0
        return None
    if len(tokens) > len(cmd_tokens):
        return None
    if cmd_tokens[: len(tokens)] != tokens:
        return None
    return len(tokens)


def evaluate_decision(perms: NormalizedPermissions, command: str) -> str:
    """Resolve a concrete shell command against a rule set (Claude-family
    semantics) and return the effective decision: "allow" | "ask" | "deny".

    Precedence:
      * Among matching rules, the MOST SPECIFIC (longest matched prefix) wins.
      * On a specificity tie, kind precedence breaks it: deny > ask > allow.
        (A deny exception carved out of a broader allow therefore wins because
        it is more specific; an equally-specific deny still beats an allow.)
      * No matching rule → the implicit default "ask" (the harness prompts).
    """
    cmd_tokens = _command_tokens(command)
    kind_rank = {"deny": 2, "ask": 1, "allow": 0}
    best: Optional[tuple[int, int, str]] = None  # (specificity, kind_rank, kind)
    for kind, rules in (
        ("allow", perms.allow),
        ("ask", perms.ask),
        ("deny", perms.deny),
    ):
        for r in rules:
            spec = _bash_rule_matches_command(r.pattern, cmd_tokens)
            if spec is None:
                continue
            candidate = (spec, kind_rank[kind], kind)
            if best is None or candidate > best:
                best = candidate
    if best is None:
        return "ask"
    return best[2]


# ─────────────────────────────────────────────────────────────────────────────
# Test seam (reset backup session state)
# ─────────────────────────────────────────────────────────────────────────────


def _reset_backup_session_state_for_tests() -> None:
    _BACKUP_SESSION.clear()
