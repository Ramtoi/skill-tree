"""Permissions model — single source of truth for allow/deny/ask/hook rules.

Hybrid `NormalizedPermissions` dataclass:
    - typed fields for the v1 features we explicitly handle (allow/deny/ask
      lists, hooks list, sandbox_mode, approval_policy, project_trust,
      additional_dirs)
    - an `extras: dict` escape hatch for forward-compat Codex/Pi additions

Two resolution paths:
  - `resolve_effective(project, registry)` — merged global+project view with
    `origin` provenance tags. Used for **display** (UI, doctor). NOT used for
    native writes.
  - `resolve_project_own(project)` — project's own permissions block with
    `origin="project"` tags. Used for **native writes** to project files.

Global rules are written **only** to harness user-level files; project files
receive only rules from the project's own block. The harness merges them at
runtime. This eliminates on-disk duplication.

Sidecar state lives at `~/.skill-hub/state/<harness>/<scope>.managed.json` and
records which keys in a user-owned config file the hub manages. User config
files themselves stay free of hub-internal metadata.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Optional, Union


# ─────────────────────────────────────────────────────────────────────────────
# Enums and primitive types
# ─────────────────────────────────────────────────────────────────────────────


class PermissionFeature(str, Enum):
    TOOL_ALLOWLIST = "tool_allowlist"
    TOOL_DENYLIST = "tool_denylist"
    TOOL_ASK = "tool_ask"
    HOOKS = "hooks"
    SANDBOX_MODE = "sandbox_mode"
    APPROVAL_POLICY = "approval_policy"
    PROJECT_TRUST = "project_trust"
    ADDITIONAL_DIRECTORIES = "additional_directories"


class Origin(str, Enum):
    GLOBAL = "global"
    PROJECT = "project"


RuleKind = str  # "allow" | "deny" | "ask"


@dataclass
class Rule:
    pattern: str
    kind: RuleKind
    harnesses: Optional[list[str]] = None
    origin: Optional[str] = None  # populated by resolver
    # Set by resolve_effective on an allow rule whose pattern is denied at a
    # higher-precedence scope (deny wins at runtime → the allow is dead). The UI
    # greys such a rule out. Defaults False; absent from to_dict unless True.
    shadowed_by_deny: bool = False

    def to_dict(self) -> dict:
        out: dict = {"pattern": self.pattern, "kind": self.kind}
        if self.harnesses is not None:
            out["harnesses"] = list(self.harnesses)
        if self.origin is not None:
            out["origin"] = self.origin
        if self.shadowed_by_deny:
            out["shadowed_by_deny"] = True
        return out

    @classmethod
    def from_dict(cls, data: dict) -> "Rule":
        return cls(
            pattern=str(data["pattern"]),
            kind=str(data["kind"]),
            harnesses=list(data["harnesses"])
            if data.get("harnesses") is not None
            else None,
            origin=data.get("origin"),
        )


@dataclass
class Hook:
    event: str
    matcher: str
    command: str
    harnesses: Optional[list[str]] = None
    origin: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "event": self.event,
            "matcher": self.matcher,
            "command": self.command,
        }
        if self.harnesses is not None:
            out["harnesses"] = list(self.harnesses)
        if self.origin is not None:
            out["origin"] = self.origin
        return out

    @classmethod
    def from_dict(cls, data: dict) -> "Hook":
        return cls(
            event=str(data["event"]),
            matcher=str(data["matcher"]),
            command=str(data["command"]),
            harnesses=list(data["harnesses"])
            if data.get("harnesses") is not None
            else None,
            origin=data.get("origin"),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Scope (global vs project)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GlobalScope:
    kind: str = "global"

    @property
    def slug(self) -> str:
        return "global"


@dataclass(frozen=True)
class ProjectScope:
    name: str
    path: str
    kind: str = "project"
    # Personal sub-tier: when True the scope routes to the harness's gitignored
    # personal settings file (Claude family → `.claude/settings.local.json`)
    # instead of the committed `.claude/settings.json`, and carries a distinct
    # `slug` so its sidecar/backups never clobber the shared project scope.
    personal: bool = False

    @property
    def slug(self) -> str:
        base = f"project-{self.name}"
        return f"{base}-local" if self.personal else base


Scope = Union[GlobalScope, ProjectScope]


# ─────────────────────────────────────────────────────────────────────────────
# Normalized permissions
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class NormalizedPermissions:
    allow: list[Rule] = field(default_factory=list)
    deny: list[Rule] = field(default_factory=list)
    ask: list[Rule] = field(default_factory=list)
    hooks: list[Hook] = field(default_factory=list)
    sandbox_mode: Optional[str] = None
    approval_policy: Optional[str] = None
    project_trust: Optional[bool] = None
    additional_dirs: list[str] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)
    _unmanaged: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "allow": [r.to_dict() for r in self.allow],
            "deny": [r.to_dict() for r in self.deny],
            "ask": [r.to_dict() for r in self.ask],
            "hooks": [h.to_dict() for h in self.hooks],
            "sandbox_mode": self.sandbox_mode,
            "approval_policy": self.approval_policy,
            "project_trust": self.project_trust,
            "additional_dirs": list(self.additional_dirs),
            "extras": dict(self.extras),
            "_unmanaged": list(self._unmanaged),
        }

    @classmethod
    def from_block(cls, block: Optional[dict]) -> "NormalizedPermissions":
        """Parse a registry permissions block (dict from YAML) → NormalizedPermissions.

        Tolerant of missing keys, the dict-form rule shape, and absent block.
        Does NOT attach `origin`; that's the resolver's job.
        """
        if not block:
            return cls()
        return cls(
            allow=_dedupe_rules(
                [_rule_from_any(r, "allow") for r in (block.get("allow") or [])]
            ),
            deny=_dedupe_rules(
                [_rule_from_any(r, "deny") for r in (block.get("deny") or [])]
            ),
            ask=_dedupe_rules(
                [_rule_from_any(r, "ask") for r in (block.get("ask") or [])]
            ),
            hooks=_dedupe_hooks(
                [
                    Hook.from_dict(h)
                    if isinstance(h, dict)
                    else Hook(event=str(h), matcher="", command="")
                    for h in (block.get("hooks") or [])
                ]
            ),
            sandbox_mode=block.get("sandbox_mode"),
            approval_policy=block.get("approval_policy"),
            project_trust=block.get("project_trust"),
            additional_dirs=list(block.get("additional_dirs") or []),
            extras=dict(block.get("extras") or {}),
            _unmanaged=list(block.get("_unmanaged") or []),
        )


def _canonical_harnesses(value: Optional[list[str]]) -> Optional[tuple[str, ...]]:
    if value is None:
        return None
    return tuple(sorted(str(v) for v in value))


def _dedupe_rules(rules: list[Rule]) -> list[Rule]:
    """Collapse identical rules, preserving first-seen order."""
    seen: set[tuple[str, str, Optional[tuple[str, ...]]]] = set()
    out: list[Rule] = []
    for r in rules:
        key = (r.kind, r.pattern, _canonical_harnesses(r.harnesses))
        if key in seen:
            continue
        seen.add(key)
        if r.harnesses is not None:
            r.harnesses = list(_canonical_harnesses(r.harnesses) or ())
        out.append(r)
    return out


def _dedupe_hooks(hooks: list[Hook]) -> list[Hook]:
    """Collapse identical hooks, preserving first-seen order."""
    seen: set[tuple[str, str, str, Optional[tuple[str, ...]]]] = set()
    out: list[Hook] = []
    for h in hooks:
        key = (h.event, h.matcher, h.command, _canonical_harnesses(h.harnesses))
        if key in seen:
            continue
        seen.add(key)
        if h.harnesses is not None:
            h.harnesses = list(_canonical_harnesses(h.harnesses) or ())
        out.append(h)
    return out


def _rule_from_any(value: Any, default_kind: str) -> Rule:
    """A rule entry in YAML may be a dict OR a bare string pattern."""
    if isinstance(value, dict):
        return Rule.from_dict({**value, "kind": value.get("kind", default_kind)})
    return Rule(pattern=str(value), kind=default_kind)


def _harnesses_overlap(h1: Optional[list[str]], h2: Optional[list[str]]) -> bool:
    """Return True when two harness affinity sets overlap.

    None means "all harnesses", so any None is always an overlap.
    """
    if h1 is None or h2 is None:
        return True
    return bool(set(h1) & set(h2))


# ─────────────────────────────────────────────────────────────────────────────
# Resolver — project-wins precedence
# ─────────────────────────────────────────────────────────────────────────────


def resolve_effective(project: dict, registry: dict) -> NormalizedPermissions:
    """Merge `permissions_global` and `project.permissions` into one resolved set.

    Precedence:
      - For each `(pattern, kind)` rule: project copy wins. Its `harnesses` affinity
        replaces global's. The global copy is dropped from that project's view.
      - For each `(event, matcher, command)` hook: project wins likewise.
      - Typed scalar fields (`sandbox_mode`, `approval_policy`, `project_trust`):
        project value wins; global is the fallback only when project is `None`.
      - `additional_dirs`: set-unioned (order-preserving), de-duplicated.
      - `extras`: project keys shadow global keys at the top level.

    Every rule and hook in the result carries an `origin` of `"global"` or
    `"project"`.
    """
    g = NormalizedPermissions.from_block(registry.get("permissions_global"))
    p = NormalizedPermissions.from_block(project.get("permissions"))

    def merge_rules(global_list: list[Rule], project_list: list[Rule]) -> list[Rule]:
        # Index project rules by (pattern, kind) for fast affinity-overlap check.
        # A global rule is only shadowed when a project rule with the same
        # (pattern, kind) has overlapping harness affinity — so a global rule
        # scoped to [codex] is NOT dropped by a project rule scoped to [claude-code].
        project_by_key: dict[tuple[str, str], list[Rule]] = {}
        for r in project_list:
            project_by_key.setdefault((r.pattern, r.kind), []).append(r)
        out: list[Rule] = []
        for r in global_list:
            overlapping = project_by_key.get((r.pattern, r.kind), [])
            if any(_harnesses_overlap(r.harnesses, pr.harnesses) for pr in overlapping):
                continue  # shadowed by an overlapping project rule
            out.append(
                Rule(
                    pattern=r.pattern,
                    kind=r.kind,
                    harnesses=list(r.harnesses) if r.harnesses is not None else None,
                    origin=Origin.GLOBAL.value,
                )
            )
        for r in project_list:
            out.append(
                Rule(
                    pattern=r.pattern,
                    kind=r.kind,
                    harnesses=list(r.harnesses) if r.harnesses is not None else None,
                    origin=Origin.PROJECT.value,
                )
            )
        return out

    def merge_hooks(global_list: list[Hook], project_list: list[Hook]) -> list[Hook]:
        project_keys = {(h.event, h.matcher, h.command) for h in project_list}
        out: list[Hook] = []
        for h in global_list:
            if (h.event, h.matcher, h.command) in project_keys:
                continue
            out.append(
                Hook(
                    event=h.event,
                    matcher=h.matcher,
                    command=h.command,
                    harnesses=list(h.harnesses) if h.harnesses is not None else None,
                    origin=Origin.GLOBAL.value,
                )
            )
        for h in project_list:
            out.append(
                Hook(
                    event=h.event,
                    matcher=h.matcher,
                    command=h.command,
                    harnesses=list(h.harnesses) if h.harnesses is not None else None,
                    origin=Origin.PROJECT.value,
                )
            )
        return out

    merged_additional: list[str] = []
    seen: set[str] = set()
    for d in list(g.additional_dirs) + list(p.additional_dirs):
        if d not in seen:
            seen.add(d)
            merged_additional.append(d)

    merged_extras: dict[str, Any] = dict(g.extras)
    merged_extras.update(p.extras)

    merged_allow = merge_rules(g.allow, p.allow)
    merged_deny = merge_rules(g.deny, p.deny)

    # Provenance: an allow whose pattern is also denied (deny wins at runtime) is
    # dead. Flag it so the UI can grey it out instead of showing an active allow.
    deny_patterns = {r.pattern for r in merged_deny}
    for r in merged_allow:
        if r.pattern in deny_patterns:
            r.shadowed_by_deny = True

    return NormalizedPermissions(
        allow=merged_allow,
        deny=merged_deny,
        ask=merge_rules(g.ask, p.ask),
        hooks=merge_hooks(g.hooks, p.hooks),
        sandbox_mode=p.sandbox_mode if p.sandbox_mode is not None else g.sandbox_mode,
        approval_policy=p.approval_policy
        if p.approval_policy is not None
        else g.approval_policy,
        project_trust=p.project_trust
        if p.project_trust is not None
        else g.project_trust,
        additional_dirs=merged_additional,
        extras=merged_extras,
        # Set-union so a project opt-out never discards a global opt-out.
        _unmanaged=sorted(set(g._unmanaged or []) | set(p._unmanaged or [])),
    )


def resolve_project_own(project: dict) -> "NormalizedPermissions":
    """Return the project's own permissions block with origin='project' on every rule/hook.

    Used for **native writes** to project files (scope-targeted model).
    Does not fold in global rules — the harness merges user+project at runtime.
    """
    p = NormalizedPermissions.from_block(project.get("permissions"))
    for r in p.allow + p.deny + p.ask:
        r.origin = Origin.PROJECT.value
    for h in p.hooks:
        h.origin = Origin.PROJECT.value
    return p


def resolve_project_local_own(project: dict) -> "NormalizedPermissions":
    """Return the project's PERSONAL (`permissions_local`) block, origin='project'.

    Personal rules are NOT committed for teammates — they target the harness's
    gitignored per-project file (Claude family → `.claude/settings.local.json`).
    Like `resolve_project_own`, this is the scope-targeted write source: it never
    folds in global or shared (`permissions`) rules. Same hybrid block shape as
    `permissions`.
    """
    p = NormalizedPermissions.from_block(project.get("permissions_local"))
    for r in p.allow + p.deny + p.ask:
        r.origin = Origin.PROJECT.value
    for h in p.hooks:
        h.origin = Origin.PROJECT.value
    return p


# ─────────────────────────────────────────────────────────────────────────────
# Registry migration
# ─────────────────────────────────────────────────────────────────────────────


def migrate_permissions_schema(registry: dict) -> bool:
    """Pure-add migration: ensures `permissions_global` and per-project
    `permissions` blocks exist. Idempotent.

    Returns True iff the registry was mutated.
    """
    mutated = False
    if "permissions_global" not in registry:
        registry["permissions_global"] = {}
        mutated = True
    projects = registry.get("projects") or {}
    for proj_cfg in projects.values():
        if not isinstance(proj_cfg, dict):
            continue
        if "permissions" not in proj_cfg:
            proj_cfg["permissions"] = {}
            mutated = True
    return mutated


# ─────────────────────────────────────────────────────────────────────────────
# Sidecar state
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class SidecarState:
    version: int
    harness: str
    scope: str
    file: str
    managed_keys: list[str]
    written_at: str

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "harness": self.harness,
            "scope": self.scope,
            "file": self.file,
            "managed_keys": list(self.managed_keys),
            "written_at": self.written_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SidecarState":
        return cls(
            version=int(data.get("version", 1)),
            harness=str(data["harness"]),
            scope=str(data["scope"]),
            file=str(data["file"]),
            managed_keys=list(data.get("managed_keys") or []),
            written_at=str(data.get("written_at", "")),
        )


def _state_root() -> Path:
    """`~/.skill-hub/state/` — resolved from hub.data_home() to honour SKILL_HUB_HOME."""
    import hub

    return hub.data_home() / "state"


def sidecar_path(harness_id: str, scope: Scope, kind: str = "") -> Path:
    """Path to a sidecar state file.

    `kind` distinguishes multiple sidecars for one `(harness, scope)` — the
    default (empty) is the primary config-file sidecar (`<scope>.managed.json`);
    a non-empty kind like `"rules"` yields `<scope>.<kind>.managed.json`, so the
    Codex TOML and Starlark-rules writes never clobber each other (D9).
    """
    suffix = f".{kind}" if kind else ""
    return _state_root() / harness_id / f"{scope.slug}{suffix}.managed.json"


def read_sidecar(harness_id: str, scope: Scope, kind: str = "") -> Optional[SidecarState]:
    path = sidecar_path(harness_id, scope, kind)
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return SidecarState.from_dict(json.load(f))
    except (OSError, json.JSONDecodeError, KeyError):
        return None


def write_sidecar(
    harness_id: str,
    scope: Scope,
    managed_keys: list[str],
    target_path: Path,
    kind: str = "",
) -> SidecarState:
    state = SidecarState(
        version=1,
        harness=harness_id,
        scope=scope.slug
        if isinstance(scope, (GlobalScope, ProjectScope))
        else str(scope),
        file=str(target_path),
        managed_keys=list(managed_keys),
        written_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    path = sidecar_path(harness_id, scope, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(path, state.to_dict())
    return state


def delete_sidecar(harness_id: str, scope: Scope, kind: str = "") -> bool:
    path = sidecar_path(harness_id, scope, kind)
    if not path.exists():
        return False
    path.unlink()
    return True


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
