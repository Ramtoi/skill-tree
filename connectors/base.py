"""Remote connector contract — the `RemoteConnector` ABC + result/value types.

A *remote connector* pushes Hub-managed artifacts (skills, MCP server specs,
agent-docs) to a remote target (a box reached over SSH, an MCP control plane,
etc.) and reads them back for drift detection and import. It mirrors the
existing `McpAdapter` (`mcp_adapters.McpAdapter`) and `PermissionAdapter`
(`permission_adapters`) protocols, but every operation is **plan-then-apply** so
the dry-run diff gate and 3-way drift detection are first-class rather than
bolted on.

Layering (lower never imports higher; **no connector imports another** — D1/D7):

    base.py            ← this module: ABC + types, zero connector knowledge
    __init__.py        ← REMOTE_CONNECTORS registry, get_connector(key)
    drift.py           ← pure 3-way classification (connector-agnostic)
    sidecar.py         ← per-artifact ownership sidecar
    transport/         ← ssh / keychain / audit (generic mechanics)
    layouts/           ← agentskills.io SKILL.md + yaml mcp_servers helpers
    <connector>.py     ← e.g. hermes.py (knows ONLY its own remote)

This module performs no I/O and imports nothing from the rest of the package, so
it stays trivially importable even when optional deps (keyring, ruamel.yaml) are
absent.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────────
# Capabilities
# ─────────────────────────────────────────────────────────────────────────────


class Capability(str, Enum):
    """A surface a connector can manage on its remote.

    A connector advertises the subset it supports via `capabilities()`. The
    sync dispatch only resolves a `DesiredState` for advertised surfaces.
    """

    SKILLS = "skills"
    MCP = "mcp"
    AGENT_DOCS = "agent_docs"


# ─────────────────────────────────────────────────────────────────────────────
# Drift status — the 6-state truth table (see drift.py for the classifier)
# ─────────────────────────────────────────────────────────────────────────────


class DriftStatus(str, Enum):
    """3-way (base vs remote vs local) classification of one artifact.

    The remote ownership sidecar records, per artifact, `last_pushed_sha256` =
    the **base**. `drift.classify(base, remote, local)` derives one of these.
    See DECISIONS.md D8 / design.md §5.
    """

    IN_SYNC = "in-sync"             # remote == base, local == base → noop
    LOCAL_AHEAD = "local-ahead"     # remote == base, local changed → fast-forward push
    REMOTE_DRIFTED = "remote-drifted"  # local == base, remote changed → SKIP (offer pull)
    CONFLICT = "conflict"           # both changed, remote != local → SKIP (explicit resolve)
    ORPHANED = "orphaned"           # removed locally, still present on remote → remove
    MISSING = "missing"             # managed, gone from the remote → report


# ─────────────────────────────────────────────────────────────────────────────
# Actions — what apply() may do per artifact
# ─────────────────────────────────────────────────────────────────────────────


class Action(str, Enum):
    """Per-artifact action emitted by `plan()` and consumed by `apply()`.

    Only `CREATE`, `FAST_FORWARD`, and `REMOVE` are in the default `allow` set
    `apply()` accepts. The `SKIP_*` actions represent drift/conflict that sync
    NEVER auto-clobbers — they are surfaced and wait for an explicit resolve op.
    """

    NOOP = "noop"
    CREATE = "create"
    FAST_FORWARD = "fast_forward"
    REMOVE = "remove"
    SKIP_REMOTE_DRIFTED = "SKIP_remote_drifted"
    SKIP_CONFLICT = "SKIP_conflict"


#: The actions `apply()` will perform unless the caller widens `allow` explicitly.
DEFAULT_ALLOW: frozenset[Action] = frozenset(
    {Action.CREATE, Action.FAST_FORWARD, Action.REMOVE}
)


# ─────────────────────────────────────────────────────────────────────────────
# Value types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RemoteArtifact:
    """One artifact discovered on the remote.

    `managed` is True iff this name is recorded in the ownership sidecar (Hub
    owns it); unmanaged artifacts are import candidates (D9) and are never
    written or cleaned up by apply.
    """

    name: str
    kind: str                       # e.g. "skill" | "mcp" | "agent_doc"
    sha256: Optional[str] = None
    managed: bool = False
    ref: Optional[str] = None       # connector-internal locator (e.g. remote path)


@dataclass(frozen=True)
class DesiredItem:
    """One artifact Hub wants present on the remote, with its local content sha."""

    name: str
    kind: str
    sha256: str
    payload: Optional[bytes] = None  # local bytes; None when only the sha matters
    ref: Optional[str] = None


@dataclass(frozen=True)
class DesiredState:
    """The resolved set of artifacts Hub wants on a remote.

    Built from `resolve_remote_skills` + MCP specs + agent-docs. Connector-
    agnostic; the connector maps each item onto its own on-remote layout.
    """

    skills: tuple[DesiredItem, ...] = ()
    mcp: tuple[DesiredItem, ...] = ()
    agent_docs: tuple[DesiredItem, ...] = ()

    def items(self) -> tuple[DesiredItem, ...]:
        return self.skills + self.mcp + self.agent_docs


@dataclass(frozen=True)
class PlannedAction:
    """A single artifact's planned action + the drift that produced it."""

    name: str
    kind: str
    action: Action
    drift_status: Optional[DriftStatus] = None
    diff: Optional[str] = None       # unified diff for surfacing (never executed)


@dataclass(frozen=True)
class RemotePlan:
    """Output of `plan()` — an ordered, immutable list of per-artifact actions.

    Producing a plan performs NO remote mutation (spec: "Plan performs no remote
    writes").
    """

    target_id: str
    actions: tuple[PlannedAction, ...] = ()

    def appliable(self, allow: frozenset[Action] = DEFAULT_ALLOW) -> tuple[PlannedAction, ...]:
        """Actions `apply()` would execute given `allow` (excludes NOOP/SKIP_*)."""
        return tuple(a for a in self.actions if a.action in allow)


@dataclass(frozen=True)
class ApplyResult:
    """Outcome of `apply()` — counts + the names touched per action.

    `applied` maps each executed `Action` to the names it touched. `skipped`
    records names left untouched because their action was outside `allow`
    (drift/conflict). `errors` holds per-artifact failure messages.
    """

    created: tuple[str, ...] = ()
    fast_forwarded: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    skipped: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()

    @property
    def changed(self) -> bool:
        return bool(self.created or self.fast_forwarded or self.removed)


@dataclass(frozen=True)
class HealthResult:
    """Outcome of `health_check()` — reachable + auth + host-key pin match."""

    reachable: bool
    authenticated: bool = False
    host_key_match: bool = False
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.reachable and self.authenticated and self.host_key_match


# ─────────────────────────────────────────────────────────────────────────────
# The connector ABC
# ─────────────────────────────────────────────────────────────────────────────


class RemoteConnector(ABC):
    """Plan-then-apply contract every remote connector implements.

    Subclasses set the `key` and `publishable` class attributes and implement
    the abstract methods. `key` is the `REMOTE_CONNECTORS` registry key (e.g.
    ``"hermes"``); `publishable` is True when the connector may ship in the
    public mirror and False for custom/private connectors (the publish guard
    keys off the file-tree boundary, but the flag is a redundant in-code signal).
    """

    #: Registry key (e.g. "hermes"). Subclasses override.
    key: str = ""

    #: True → may ship publicly; False → custom/private. Subclasses override.
    publishable: bool = False

    #: True → the connector's transport runs privileged (root forced-command /
    #: raw root SSH). M1 keys a new remote's default sync_enabled=false off this
    #: OR `publishable == False`. Subclasses override (default non-root).
    root_transport: bool = False

    # --- presentation + transport metadata (catalog / onboarding) -----------
    #
    # Back-compat defaults: an existing connector defining only `key`/`publishable`
    # stays valid — it receives a derived label (`key` title-cased), an empty
    # description, and the `ssh` transport kind. Subclasses override as needed.

    #: Human-facing name for the connector cards / catalog. Empty → derived from
    #: `key` via `display_label`.
    label: str = ""

    #: One-line description for the connector cards / catalog.
    description: str = ""

    #: Onboarding transport shape — "ssh" (TOFU host-key flow) or "https"
    #: (endpoint + keychain token). Drives the add-remote wizard's step list.
    transport_kind: str = "ssh"

    @property
    def display_label(self) -> str:
        """The label shown to users — explicit `label`, else a derived one."""
        return self.label or self.key.replace("-", " ").title()

    # --- key-setup transport hook (de-special-cases core) -------------------

    def setup_key_transport(self, target):
        """Resolve a connector-specific key-setup/revoke transport plan, or None.

        Returns `None` by default → callers fall through to the generic
        user-key path (append the hub's own pubkey to the connector user's
        `~/.ssh/authorized_keys`). A connector that installs a dedicated /
        privileged key (e.g. a root forced-command key) overrides this to return
        a 4-tuple `(transport, authorized_keys_path, match_predicate, key_desc)`
        mirroring the generic path's contract — `transport` reaches the
        authorized_keys file, `authorized_keys_path` is its remote path,
        `match_predicate(line) -> bool` surgically selects ONLY this connector's
        installed line, and `key_desc` is a human description.
        """
        return None

    # --- capability + health ------------------------------------------------

    @abstractmethod
    def capabilities(self) -> set[Capability]:
        """Subset of `{SKILLS, MCP, AGENT_DOCS}` this connector supports."""

    @abstractmethod
    def health_check(self, target) -> HealthResult:
        """Is the remote reachable, authenticated, and host-key-pin matched?"""

    # --- read side (drift + import + agent-docs round-trip) -----------------

    @abstractmethod
    def list_remote_artifacts(self, target, kind: str) -> list[RemoteArtifact]:
        """List remote artifacts of `kind`, flagging which are sidecar-managed."""

    @abstractmethod
    def fetch_artifact(self, target, ref: str) -> bytes:
        """Fetch one remote artifact's bytes (for diff / pull / doc edit)."""

    # --- plan (NEVER mutates) ----------------------------------------------

    @abstractmethod
    def plan(self, target, desired: DesiredState) -> RemotePlan:
        """Classify each artifact's drift and emit a `RemotePlan`. No mutation."""

    # --- apply (mutates only sidecar-owned, allowed artifacts) --------------

    @abstractmethod
    def apply(
        self,
        target,
        plan: RemotePlan,
        *,
        allow: frozenset[Action] = DEFAULT_ALLOW,
    ) -> ApplyResult:
        """Execute the plan, touching only artifacts whose action is in `allow`."""

    # --- resolution primitive (explicit, never during auto-sync) -----------

    @abstractmethod
    def pull_artifact(self, target, ref: str) -> bytes:
        """Adopt a remote artifact back into Hub (drift pull / import)."""
