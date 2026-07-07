"""Remote connector framework package.

Exposes the `REMOTE_CONNECTORS` registry + `get_connector(key)`, parallel to
`mcp_adapters.ADAPTERS` / `mcp_adapters.get_adapter`. The registry is empty in
Wave 0 — connectors register themselves at import time in later waves via
`register_connector`.

Importing this package must NOT pull in optional deps (keyring, ruamel.yaml) or
make any connection — submodules import those lazily / under guards. Connector
*registration* is likewise NOT done at import time: it runs lazily+once via
`connectors.discovery.ensure_discovered()`, triggered on first registry use
(`get_connector` / `all_connectors`). See `discovery.py`.
"""

from __future__ import annotations

from .base import (
    Action,
    ApplyResult,
    Capability,
    DEFAULT_ALLOW,
    DesiredItem,
    DesiredState,
    DriftStatus,
    HealthResult,
    PlannedAction,
    RemoteArtifact,
    RemoteConnector,
    RemotePlan,
)

__all__ = [
    "Action",
    "ApplyResult",
    "Capability",
    "DEFAULT_ALLOW",
    "DesiredItem",
    "DesiredState",
    "DriftStatus",
    "HealthResult",
    "PlannedAction",
    "RemoteArtifact",
    "RemoteConnector",
    "RemotePlan",
    "REMOTE_CONNECTORS",
    "register_connector",
    "get_connector",
    "all_connectors",
    "ensure_discovered",
    "connector_source",
]


# ─────────────────────────────────────────────────────────────────────────────
# Registry — parallels mcp_adapters.ADAPTERS / get_adapter
# ─────────────────────────────────────────────────────────────────────────────


#: key → connector instance. Empty until connectors register (Wave 1+).
REMOTE_CONNECTORS: dict[str, RemoteConnector] = {}


def register_connector(connector: RemoteConnector) -> RemoteConnector:
    """Register a connector instance under its `key`. Returns it for chaining.

    Raises `ValueError` on a missing or duplicate key so a typo can't silently
    shadow another connector.
    """
    key = getattr(connector, "key", "") or ""
    if not key:
        raise ValueError("connector has no registry key")
    if key in REMOTE_CONNECTORS and REMOTE_CONNECTORS[key] is not connector:
        raise ValueError(f"connector key already registered: {key!r}")
    REMOTE_CONNECTORS[key] = connector
    return connector


def ensure_discovered() -> None:
    """Run connector discovery once (builtin/private/entry-point/drop-in).

    Lazy + memoized; never raises. Triggered on first registry use so importing
    this package stays side-effect-light (no hermes import, no optional deps).
    """
    from .discovery import ensure_discovered as _ensure

    _ensure()


def get_connector(key: str) -> RemoteConnector:
    """Resolve a connector by registry key.

    Mirrors `mcp_adapters.get_adapter`, but a remote connector is mandatory
    once referenced, so an unknown key is a hard error rather than `None`
    (spec: "Unknown connector key is rejected"). Triggers lazy discovery so
    drop-in / entry-point / private connectors resolve on first use.
    """
    ensure_discovered()
    try:
        return REMOTE_CONNECTORS[key]
    except KeyError:
        known = ", ".join(sorted(REMOTE_CONNECTORS)) or "(none)"
        raise KeyError(f"unknown remote connector {key!r}; known: {known}")


def all_connectors() -> dict[str, RemoteConnector]:
    """All registered connectors after discovery (key → instance snapshot)."""
    ensure_discovered()
    return dict(REMOTE_CONNECTORS)


def connector_source(key: str) -> str:
    """Discovery source of a key: builtin | private | entry-point | drop-in."""
    ensure_discovered()
    from .discovery import connector_source as _source

    return _source(key)
