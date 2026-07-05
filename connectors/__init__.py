"""Remote connector framework package.

Exposes the `REMOTE_CONNECTORS` registry + `get_connector(key)`, parallel to
`mcp_adapters.ADAPTERS` / `mcp_adapters.get_adapter`. The registry is empty in
Wave 0 — connectors register themselves at import time in later waves via
`register_connector`.

Importing this package must NOT pull in optional deps (keyring, ruamel.yaml) or
make any connection — submodules import those lazily / under guards.
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


def get_connector(key: str) -> RemoteConnector:
    """Resolve a connector by registry key.

    Mirrors `mcp_adapters.get_adapter`, but a remote connector is mandatory
    once referenced, so an unknown key is a hard error rather than `None`
    (spec: "Unknown connector key is rejected").
    """
    try:
        return REMOTE_CONNECTORS[key]
    except KeyError:
        known = ", ".join(sorted(REMOTE_CONNECTORS)) or "(none)"
        raise KeyError(f"unknown remote connector {key!r}; known: {known}")


# ─────────────────────────────────────────────────────────────────────────────
# Built-in connectors register themselves at import time.
#
# `hermes` imports only guarded/lazy deps (its transport/keychain/yaml backends
# are all import-guarded), so importing it here keeps the package importable even
# when optional deps are absent. Custom/private connectors live in
# the excluded `connectors_private/` tree and register from there (Wave 4+).
# ─────────────────────────────────────────────────────────────────────────────

from .hermes import HermesConnector  # noqa: E402

register_connector(HermesConnector())


# Custom/private connectors live in the EXCLUDED `connectors_private/` tree and
# register themselves on import. The publishable build ships WITHOUT that dir, so
# the import is guarded — its absence (ImportError) is expected and tolerated.
try:  # pragma: no cover - exercised by the publishable-build vs dev-tree split
    import connectors_private  # noqa: F401,E402
except Exception:
    pass
