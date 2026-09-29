"""Host-owned cached compatibility context for one sync operation."""

from __future__ import annotations

import os
import platform
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping, Optional, Sequence

from skill_hub.application.harnesses.harness_layout_context import OperationLayout, capture_layouts
from skill_hub.application.harnesses.harness_runtime import (
    HARNESS_EXECUTABLES,
    KNOWN_FALLBACK_DIRS,
    InventoryRequest,
    RuntimeInventory,
    read_inventory_cache,
)
from skill_hub.domain.harnesses.harness_adapter_api import (
    CatalogSnapshot,
    InvocationNativeCodec,
    McpNativeCodec,
    OperationResolution,
    RuntimeIdentity,
    Version,
)
from skill_hub.domain.harnesses.harness_catalog import (
    BUNDLED_MCP_CODECS,
    BUNDLED_MCP_TRUSTED_RECORDS,
    bundled_catalog,
    compare_bundled_mcp,
)
from skill_hub.domain.harnesses.harness_resolution import ResolutionPolicy, resolve_operation
from skill_hub.infrastructure.harnesses.harness_bundled_invocation import (
    resolve_capability as _BUNDLED_INVOCATION_RESOLVER,
)
from skill_hub.infrastructure.harnesses.opencode_invocation import NativePaths, capture_native_paths

KNOWN_HARNESSES = tuple(sorted(HARNESS_EXECUTABLES))
WORKFLOW_FEATURES = (
    "skills", "mcp", "invocation", "permissions", "hooks", "agent_docs",
    "subagents", "companions", "backup", "restore",
)

# This is the release record compiled into the host. A catalog entry is input
# to resolution, but cannot by itself authorize a native callable.
BUNDLED_INVOCATION_TRUSTED_RECORD = (
    "bundled",
    Version(1, 0, 0),
    "sha256:77aae7540e1066fc757234fd949b78e95dc2557d405658ecaf3d2a7275f8a096",
    "cli",
    "opencode",
    "opencode-v1.18.31",
    Version(1, 18, 31),
)


def _freeze_observation(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({str(key): _freeze_observation(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_observation(item) for item in value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise ValueError("capability observations must contain JSON values")


def observation_payload(value: Any) -> Any:
    """Return JSON values from a fixed observation without reading caches."""
    if isinstance(value, Mapping):
        return {str(key): observation_payload(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [observation_payload(item) for item in value]
    return value


def _safe_hook_observation(value: Any) -> dict[str, Any]:
    """Expose verdict metadata without binary paths or probe output."""
    if not isinstance(value, Mapping):
        return {}
    extra = value.get("extra")
    safe_extra = {
        key: extra[key]
        for key in ("lsp_state", "shim", "probe_failed")
        if isinstance(extra, Mapping) and key in extra
    }
    return {
        "verdict": str(value.get("verdict") or "unknown"),
        "reason": str(value.get("reason") or ""),
        "extra": safe_extra,
    }


def _user_home() -> Path:
    keys = ("USERPROFILE", "HOME") if platform.system() == "Windows" else ("HOME", "USERPROFILE")
    raw = next((os.environ[key] for key in keys if os.environ.get(key)), None)
    return Path(raw).expanduser() if raw else Path.home()


def _expanded_fallbacks(home: Path) -> tuple[str, ...]:
    return tuple(str(home / raw[2:]) if raw.startswith("~/") else raw for raw in KNOWN_FALLBACK_DIRS)


def host_inventory_request(harnesses: Sequence[str]) -> InventoryRequest:
    """Build the shared host inventory request without probing."""
    selected = tuple(sorted(set(harnesses)))
    user_home = _user_home()
    homes = {
        "claude-code": str(Path(os.environ.get("SKILL_HUB_CLAUDE_HOME") or user_home / ".claude").expanduser()),
        "codex": str(Path(os.environ.get("CODEX_HOME") or user_home / ".codex").expanduser()),
    }
    markers = {
        "claude-code": (str(Path(homes["claude-code"]) / "projects"),),
        "codex": (str(Path(homes["codex"]) / "config.toml"),),
        "pi": (str(user_home / ".pi" / "agent"),),
        "opencode": (str(user_home / ".local" / "share" / "opencode" / "auth.json"),),
    }
    configs = {
        "claude-code": (str(Path(homes["claude-code"]) / "settings.json"),),
        "codex": (str(Path(homes["codex"]) / "config.toml"),),
        "pi": (str(user_home / ".pi" / "agent" / "settings.json"),),
        "opencode": (str(user_home / ".config" / "opencode" / "opencode.json"),),
    }
    return InventoryRequest(
        harnesses=selected,
        path=os.environ.get("PATH", ""),
        fallback_dirs=_expanded_fallbacks(user_home),
        # Keep all known home overrides in the request, matching the
        # integration CLI contract; marker/config evidence remains selected.
        home_overrides=homes,
        marker_dirs={key: markers[key] for key in selected if key in markers},
        config_paths={key: configs[key] for key in selected if key in configs},
        os_name=platform.system(),
        os_version=platform.release(),
        architecture=platform.machine(),
    )


def runtime_inventory_cache_path(data_home: Path) -> Path:
    return Path(data_home) / "state" / "runtime-inventory.json"


def _decision_payload(decision: Any) -> dict[str, Any]:
    binding = decision.binding
    return {
        "feature": decision.feature,
        "status": decision.status,
        "reason": decision.reason,
        "validation_provenance": decision.validation_provenance,
        "binding": {
            "package_id": binding.package_id,
            "release_version": str(binding.release_version),
            "release_digest": binding.release_digest,
            "harness_id": binding.harness_id,
            "variant_id": binding.variant_id,
            "installation_id": binding.installation_id,
            "profile": binding.profile,
        }
        if binding is not None
        else None,
    }


@dataclass(frozen=True)
class AdapterRoute:
    """Immutable routing decision captured at operation start."""

    harness_id: str
    feature: str
    adapter_key: Optional[str] = None
    mechanism: Optional[str] = None
    decision: Optional[Any] = None
    capability: Optional[Any] = None
    status: str = "shadow"
    reason: str = "legacy_shadow"
    mode: str = "legacy_shadow"
    enforced: bool = False

    def __post_init__(self) -> None:
        if self.status not in {"shadow", "verified", "unavailable"}:
            raise ValueError("unknown adapter route status")
        if self.mode not in {"legacy_shadow", "verified", "unavailable"}:
            raise ValueError("unknown adapter route mode")
        if self.enforced and self.status != "verified":
            raise ValueError("only verified routes may be enforced")
        if self.capability is not None and isinstance(self.capability, Mapping):
            object.__setattr__(self, "capability", _freeze_observation(self.capability))


@dataclass(frozen=True)
class OperationAdapterContext:
    """One immutable, cached-only compatibility snapshot for an operation."""

    context_id: str
    data_home: str
    harness_ids: tuple[str, ...]
    catalog: CatalogSnapshot
    inventory: RuntimeInventory
    inventory_cache_state: str
    requested_features: tuple[str, ...] = ("mcp", "invocation")
    opencode_paths: Optional[NativePaths] = None
    invocation_observations: Mapping[str, Mapping[str, Any]] = field(
        default_factory=lambda: MappingProxyType({})
    )
    invocation_policy: Mapping[str, Mapping[str, Any]] = field(
        default_factory=lambda: MappingProxyType({})
    )
    invocation_resolver: Optional[InvocationNativeCodec] = _BUNDLED_INVOCATION_RESOLVER
    resolutions: Mapping[str, OperationResolution] = field(
        default_factory=lambda: MappingProxyType({})
    )
    trusted_mcp_records: Mapping[str, tuple[str, Version, str, str]] = field(
        default_factory=lambda: BUNDLED_MCP_TRUSTED_RECORDS
    )
    mcp_codecs: Mapping[str, McpNativeCodec] = field(
        default_factory=lambda: BUNDLED_MCP_CODECS
    )
    mode: str = "shadow"
    enforced: bool = False
    installed_harness_ids: Optional[tuple[str, ...]] = None
    layouts: Mapping[str, OperationLayout] = field(
        default_factory=lambda: MappingProxyType({})
    )
    hook_observations: Mapping[str, Mapping[str, Any]] = field(
        default_factory=lambda: MappingProxyType({})
    )
    routes: Mapping[tuple[str, str], AdapterRoute] = field(
        default_factory=lambda: MappingProxyType({})
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "harness_ids", tuple(sorted(set(self.harness_ids))))
        installed = self.harness_ids if self.installed_harness_ids is None else self.installed_harness_ids
        object.__setattr__(self, "installed_harness_ids", tuple(sorted(set(installed))))
        object.__setattr__(self, "requested_features", tuple(dict.fromkeys(self.requested_features)))
        observations = {
            str(harness_id): _freeze_observation(observation)
            for harness_id, observation in self.invocation_observations.items()
        }
        object.__setattr__(self, "invocation_observations", MappingProxyType(observations))
        policies = {
            str(harness_id): _freeze_observation(policy)
            for harness_id, policy in self.invocation_policy.items()
        }
        object.__setattr__(self, "invocation_policy", MappingProxyType(policies))
        object.__setattr__(self, "resolutions", MappingProxyType(dict(self.resolutions)))
        object.__setattr__(self, "trusted_mcp_records", MappingProxyType(dict(self.trusted_mcp_records)))
        object.__setattr__(self, "mcp_codecs", MappingProxyType(dict(self.mcp_codecs)))
        object.__setattr__(self, "layouts", MappingProxyType(dict(self.layouts)))
        hook_observations = {
            str(harness_id): _freeze_observation(observation)
            for harness_id, observation in self.hook_observations.items()
        }
        object.__setattr__(self, "hook_observations", MappingProxyType(hook_observations))
        object.__setattr__(self, "routes", MappingProxyType(dict(self.routes)))
        if self.mode != "shadow" or self.enforced:
            raise ValueError("MCP operation context is shadow-only")

    def decision(self, harness_id: str, feature: str = "mcp") -> Any:
        resolution = self.resolutions.get(harness_id)
        return resolution.decision(feature) if resolution is not None else None

    def route(self, harness_id: str, feature: str) -> AdapterRoute:
        route = self.routes.get((harness_id, feature))
        if route is not None:
            return route
        return AdapterRoute(
            harness_id=harness_id,
            feature=feature,
            status="unavailable",
            reason="route_not_captured",
            mode="unavailable",
        )

    def layout(self, harness_id: str) -> Optional[OperationLayout]:
        """Return the layout captured for this harness at context creation."""
        return self.layouts.get(harness_id)

    def effective_harness_ids(self, project: Mapping[str, Any], registry: Mapping[str, Any]) -> set[str]:
        """Resolve host enablement against this operation's captured participants."""
        configured = set(registry.get("harnesses_global") or ()) | set(project.get("harnesses") or ())
        return configured & set(self.installed_harness_ids or ()) & set(self.layouts)

    def invocation_profile(self, harness_id: str) -> str:
        observation = self.invocation_observations.get(harness_id, {})
        return str(observation.get("profile") or "unknown")

    def trusted_invocation_profile(self, harness_id: str) -> Optional[str]:
        """Return a callable profile only when cache and catalog identities agree."""
        if self.inventory_cache_state != "fresh":
            return None
        decision = self.decision(harness_id, "invocation")
        binding = (
            decision.binding
            if decision is not None
            and decision.status == "supported"
            and decision.validation_provenance == "verified"
            else None
        )
        if binding is None:
            return None
        (
            package_id,
            release_version,
            release_digest,
            variant_id,
            expected_harness,
            expected_profile,
            runtime_version,
        ) = BUNDLED_INVOCATION_TRUSTED_RECORD
        if (
            harness_id != expected_harness
            or binding.harness_id != expected_harness
            or binding.package_id != package_id
            or binding.release_version != release_version
            or binding.release_digest != release_digest
            or binding.variant_id != variant_id
            or binding.profile != expected_profile
            or binding.runtime_version != runtime_version
        ):
            return None
        observation = self.invocation_observations.get(harness_id, {})
        if observation.get("request_fingerprint") != self.inventory.request_fingerprint:
            return None
        if observation.get("installation_id") != binding.installation_id:
            return None
        if observation.get("runtime_version") != str(binding.runtime_version):
            return None
        if observation.get("profile") != binding.profile:
            return None
        manifest = next(
            (
                item
                for item in self.catalog.manifests
                if item.package_id == binding.package_id
                and item.release_version == binding.release_version
                and item.digest == binding.release_digest
            ),
            None,
        )
        if manifest is None:
            return None
        variant = next(
            (
                item
                for item in manifest.variants
                if item.harness_id == binding.harness_id
                and item.variant_id == binding.variant_id
                and item.profile == binding.profile
                and item.features.get("invocation") == "verified"
            ),
            None,
        )
        if (
            variant is None
            or variant.version_constraint is None
            or not variant.version_constraint.matches(binding.runtime_version)
        ):
            return None
        identities = [
            item
            for item in self.inventory.identities
            if item.harness_id == harness_id and item.installation_id == binding.installation_id
        ]
        if (
            len(identities) != 1
            or identities[0] != binding.runtime_identity
            or identities[0].version != binding.runtime_version
        ):
            return None
        return binding.profile

    def trusted_invocation_resolver(self, harness_id: str) -> Optional[InvocationNativeCodec]:
        """Return the bundled invocation resolver after identity validation.

        The resolver is a codec, not a capability decision.  Keeping its
        selection behind the same package/release/installation checks prevents
        a compatible-looking catalog decision from authorizing an arbitrary
        host implementation.
        """
        if self.trusted_invocation_profile(harness_id) is None:
            return None
        decision = self.decision(harness_id, "invocation")
        binding = decision.binding if decision is not None else None
        if binding is None:
            return None
        return self.invocation_resolver

    def compare_mcp(self, harness_id: str, adapter_key: str, spec: object) -> dict[str, object]:
        decision = self.decision(harness_id)
        if decision is None:
            return {"status": "unavailable", "reason": "no_resolution"}
        if self.inventory_cache_state != "fresh" or decision.binding is None:
            return {"status": "unavailable", "reason": "inventory_binding_unavailable"}
        matches = [item for item in self.inventory.identities if item == decision.binding.runtime_identity]
        if len(matches) != 1:
            return {"status": "unavailable", "reason": "inventory_binding_unavailable"}
        return compare_bundled_mcp(
            self.catalog,
            decision,
            adapter_key,
            spec,
            trusted_records=self.trusted_mcp_records,
            codec_table=self.mcp_codecs,
        )

    def row_metadata(self, harness_id: str) -> dict[str, Any]:
        decision = self.decision(harness_id)
        comparison_reason = (
            "no_verified_mcp_codec"
            if decision is None or decision.binding is None
            else "no_bundled_mcp_record"
        )
        return {
            "operation_context_id": self.context_id,
            "compatibility": {
                "mode": self.mode,
                "enforced": self.enforced,
                "status": decision.status if decision is not None else "unavailable",
                "reason": decision.reason if decision is not None else "no_resolution",
                "catalog_generation": self.catalog.generation,
                "catalog_digest": self.catalog.content_digest,
                "inventory_cache_state": self.inventory_cache_state,
                "comparison": {
                    "status": "unavailable",
                    "reason": comparison_reason,
                },
            },
        }


def build_mcp_operation_context(
    data_home: Path,
    harness_ids: Sequence[str],
    catalog: Optional[CatalogSnapshot] = None,
    request: Optional[InventoryRequest] = None,
    host_version: Optional[Version] = None,
    sdk_version: Optional[Version] = None,
    trusted_mcp_records: Optional[Mapping[str, tuple[str, Version, str, str]]] = None,
    mcp_codecs: Optional[Mapping[str, McpNativeCodec]] = None,
) -> OperationAdapterContext:
    """Compatibility wrapper for a cache-only MCP operation."""
    return build_operation_context(
        data_home,
        harness_ids,
        requested_features=("mcp",),
        catalog=catalog,
        request=request,
        host_version=host_version,
        sdk_version=sdk_version,
        trusted_mcp_records=trusted_mcp_records,
        mcp_codecs=mcp_codecs,
        needs_selection=False,
        installed_harness_ids=harness_ids,
    )


def _cached_invocation_observations(
    data_home: Path, inventory: Optional[RuntimeInventory] = None,
    capability_cache: Optional[Mapping[str, Any]] = None,
) -> dict[str, dict[str, Any]]:
    try:
        from skill_hub.infrastructure.harnesses import harness_probe

        value = (
            harness_probe.cached_invocations(data_home)
            if capability_cache is None else capability_cache.get("invocation", {})
        )
    except (ImportError, OSError, TypeError, ValueError):
        value = {}
    if not isinstance(value, dict):
        return {}
    if inventory is None:
        return {
            str(harness_id): {
                **(dict(row) if isinstance(row, Mapping) else {}),
                "profile": "unknown",
                "reason_code": "selection-unavailable",
                "reason": "Invocation evidence cannot be bound without a fresh inventory.",
            }
            for harness_id, row in value.items()
        }
    identities: dict[str, list[RuntimeIdentity]] = {item.harness_id: [] for item in inventory.identities}
    for item in inventory.identities:
        identities.setdefault(item.harness_id, []).append(item)
    validated: dict[str, dict[str, Any]] = {}
    for harness_id, raw in value.items():
        row = dict(raw) if isinstance(raw, Mapping) else {}
        matches = identities.get(harness_id, [])
        identity = matches[0] if len(matches) == 1 else None
        valid = (
            identity is not None
            and row.get("request_fingerprint") == inventory.request_fingerprint
            and row.get("installation_id") == identity.installation_id
            and row.get("runtime_version") == (str(identity.version) if identity.version else None)
        )
        if not valid:
            row.update(
                profile="unknown",
                reason_code="selection-unavailable",
                reason="Invocation evidence is legacy, malformed, or does not match the current installation.",
            )
        validated[harness_id] = row
    return validated


def _bind_invocation_observations(
    observations: Mapping[str, Mapping[str, Any]], inventory: RuntimeInventory
) -> dict[str, dict[str, Any]]:
    """Attach the immutable inventory identity to freshly derived rows."""
    bound: dict[str, dict[str, Any]] = {}
    for harness_id, raw in observations.items():
        row = dict(raw)
        matches = [item for item in inventory.identities if item.harness_id == harness_id]
        identity = matches[0] if len(matches) == 1 else None
        if identity is not None:
            row.setdefault("request_fingerprint", inventory.request_fingerprint)
            row.setdefault("installation_id", identity.installation_id)
            row.setdefault(
                "runtime_version",
                str(identity.version) if identity.version is not None else None,
            )
        bound[str(harness_id)] = row
    return bound


def build_operation_context(
    data_home: Path,
    harness_ids: Sequence[str],
    *,
    requested_features: Sequence[str] = ("mcp", "invocation"),
    catalog: Optional[CatalogSnapshot] = None,
    request: Optional[InventoryRequest] = None,
    host_version: Optional[Version] = None,
    sdk_version: Optional[Version] = None,
    needs_selection: bool = False,
    force_refresh: bool = False,
    installed_harness_ids: Optional[Sequence[str]] = None,
    trusted_mcp_records: Optional[Mapping[str, tuple[str, Version, str, str]]] = None,
    mcp_codecs: Optional[Mapping[str, McpNativeCodec]] = None,
) -> OperationAdapterContext:
    """Build one shared context, optionally coordinating fresh selection.

    The normal path is cache-only.  A sync that needs a verified invocation
    binding may opt into one inventory collection; invocation observations are
    then derived from those identities, so OpenCode is never version-probed
    twice in one operation.
    """
    selected = tuple(sorted(set(harness_ids)))
    canonical_request = host_inventory_request(KNOWN_HARNESSES)
    requested_request = request or host_inventory_request(selected)
    cache_path = runtime_inventory_cache_path(data_home)
    if force_refresh:
        cached = None
    elif requested_request == canonical_request:
        cached = read_inventory_cache(cache_path, canonical_request)
    else:
        cached = read_inventory_cache(cache_path, canonical_request, (requested_request,))
    layouts = capture_layouts(
        selected, home=_user_home(), home_overrides=requested_request.home_overrides,
    )
    try:
        from skill_hub.infrastructure.harnesses import harness_probe

        capability_cache = {} if force_refresh else (harness_probe.load_cached(data_home) or {})
    except (ImportError, OSError, TypeError, ValueError):
        capability_cache = {}
    if not isinstance(capability_cache, Mapping):
        capability_cache = {}
    observations = _cached_invocation_observations(data_home, cached, capability_cache)
    raw_caps = capability_cache.get("harnesses", {})
    hook_observations = {
        str(harness_id): dict(value)
        for harness_id, value in raw_caps.items() if isinstance(value, Mapping)
    } if isinstance(raw_caps, Mapping) else {}
    inventory = cached
    if needs_selection and inventory is None:
        from skill_hub.application.harnesses import harness_runtime

        try:
            # The shared cache must also serve all-harness read projections.
            # Keep explicit custom collection inputs, but ordinary subset
            # operations collect the canonical inventory once.
            collection_request = requested_request if request is not None else canonical_request
            inventory = harness_runtime.inventory(collection_request)
            harness_runtime.write_inventory_cache(inventory, cache_path)
        except (OSError, TypeError, ValueError):
            inventory = None
    if needs_selection and inventory is not None:
        if "hooks" in requested_features:
            from skill_hub.infrastructure.harnesses import harness_probe

            try:
                refreshed = harness_probe.refresh_operation_capabilities(
                    set(selected), data_home=data_home, inventory=inventory, layouts=layouts
                )
                if isinstance(refreshed, Mapping):
                    raw_invocation = refreshed.get("invocation")
                    if isinstance(raw_invocation, Mapping):
                        observations = _bind_invocation_observations(raw_invocation, inventory)
                    raw_hooks = refreshed.get("harnesses")
                    if isinstance(raw_hooks, Mapping):
                        hook_observations = {
                            str(harness_id): dict(value)
                            for harness_id, value in raw_hooks.items()
                            if isinstance(value, Mapping)
                        }
            except (OSError, TypeError, ValueError):
                hook_observations = {}
        opencode_identity = next(
            (
                identity
                for identity in inventory.identities
                if identity.harness_id == "opencode" and identity.version is not None
            ),
            None,
        )
        cached_opencode = observations.get("opencode", {})
        needs_invocation = "invocation" in requested_features and any(
            harness_id not in observations
            or (
                harness_id == "opencode"
                and (
                    cached_opencode.get("profile") != "opencode-v1.18.31"
                    or cached_opencode.get("version")
                    != (str(opencode_identity.version) if opencode_identity is not None else None)
                )
            )
            for harness_id in selected
        )
        if needs_invocation and "hooks" not in requested_features:
            from skill_hub.infrastructure.harnesses import harness_probe

            try:
                observations = harness_probe.refresh_invocations(
                    set(selected), data_home=data_home, inventory=inventory
                )
                if isinstance(observations, Mapping):
                    observations = _bind_invocation_observations(observations, inventory)
                else:
                    observations = {}
            except (OSError, TypeError, ValueError):
                observations = {}
    if inventory is None:
        state = "missing" if not cache_path.exists() else "stale"
        inventory = RuntimeInventory((), "")
    else:
        state = "fresh"
    if inventory.request_fingerprint:
        identities_by_harness: dict[str, list[RuntimeIdentity]] = {}
        for identity in inventory.identities:
            identities_by_harness.setdefault(identity.harness_id, []).append(identity)
        hook_observations = {
            harness_id: observation
            for harness_id, observation in hook_observations.items()
            if observation.get("request_fingerprint") == inventory.request_fingerprint
            and len(identities_by_harness.get(harness_id, ())) == 1
            and observation.get("installation_id")
            == identities_by_harness[harness_id][0].installation_id
            and observation.get("runtime_version")
            == str(identities_by_harness[harness_id][0].version)
            and observation.get("observed_at")
            and observation.get("inventory_observed_at") == inventory.observed_at
        }
    else:
        hook_observations = {}
    snapshot = catalog if catalog is not None else bundled_catalog()
    resolutions = {
        harness_id: resolve_operation(
            inventory,
            snapshot,
            ResolutionPolicy(
                requested_harness=harness_id,
                requested_features=tuple(requested_features),
                host_version=host_version,
                sdk_version=sdk_version,
            ),
        )
        for harness_id in selected
    }
    context = OperationAdapterContext(
        context_id=uuid.uuid4().hex,
        data_home=str(data_home),
        harness_ids=selected,
        installed_harness_ids=(
            selected if installed_harness_ids is None else tuple(installed_harness_ids)
        ),
        requested_features=tuple(requested_features),
        catalog=snapshot,
        inventory=inventory,
        inventory_cache_state=state,
        invocation_observations=observations,
        hook_observations=hook_observations,
        opencode_paths=capture_native_paths(home=_user_home(), data_home=Path(data_home)),
        layouts=layouts,
        resolutions=resolutions,
        trusted_mcp_records=BUNDLED_MCP_TRUSTED_RECORDS if trusted_mcp_records is None else trusted_mcp_records,
        mcp_codecs=BUNDLED_MCP_CODECS if mcp_codecs is None else mcp_codecs,
    )
    policies = {
        harness_id: {
            "mode": "enforced" if context.trusted_invocation_profile(harness_id) else "shadow",
            "enforced": context.trusted_invocation_profile(harness_id) is not None,
        }
        for harness_id in selected
    }
    object.__setattr__(context, "invocation_policy", MappingProxyType({
        harness_id: _freeze_observation(policy)
        for harness_id, policy in policies.items()
    }))
    routes: dict[tuple[str, str], AdapterRoute] = {}
    for harness_id in selected:
        layout = layouts.get(harness_id)
        decision_map = {
            feature: context.decision(harness_id, feature)
            for feature in context.requested_features
        }
        for feature, decision in decision_map.items():
            capability = hook_observations.get(harness_id) if feature == "hooks" else None
            if layout is None:
                routes[(harness_id, feature)] = AdapterRoute(
                    harness_id=harness_id,
                    feature=feature,
                    decision=decision,
                    capability=capability,
                    status="unavailable",
                    reason="unknown_harness",
                    mode="unavailable",
                )
                continue
            status = "shadow"
            reason = "legacy_shadow"
            mode = "legacy_shadow"
            if feature == "invocation" and context.trusted_invocation_profile(harness_id):
                status, reason, mode = "verified", "verified_binding", "verified"
            routes[(harness_id, feature)] = AdapterRoute(
                harness_id=harness_id,
                feature=feature,
                adapter_key=(
                    layout.permission_adapter_key
                    if feature == "permissions"
                    else layout.hook_mechanism
                    if feature == "hooks"
                    else layout.mcp_adapter_key if feature == "mcp"
                    else layout.agent_format if feature in {"subagents", "companions"}
                    else None
                ),
                mechanism=layout.hook_mechanism if feature == "hooks" else None,
                decision=decision,
                capability=capability,
                status=status,
                reason=reason,
                mode=mode,
                enforced=status == "verified",
            )
    object.__setattr__(context, "routes", MappingProxyType(routes))
    return context


def serialize_operation_context(context: OperationAdapterContext) -> dict[str, Any]:
    return {
        "context_id": context.context_id,
        "harness_ids": list(context.harness_ids),
        "installed_harness_ids": list(context.installed_harness_ids or ()),
        "requested_features": list(context.requested_features),
        "catalog_generation": context.catalog.generation,
        "catalog_digest": context.catalog.content_digest,
        "inventory_cache_state": context.inventory_cache_state,
        "request_fingerprint": context.inventory.request_fingerprint,
        "observed_at": context.inventory.observed_at,
        "mode": context.mode,
        "enforced": context.enforced,
        "routes": {
            f"{harness_id}:{feature}": {
                "status": route.status,
                "reason": route.reason,
                "mode": route.mode,
                "enforced": route.enforced,
                "adapter_key": route.adapter_key,
                "capability": _safe_hook_observation(route.capability),
            }
            for (harness_id, feature), route in context.routes.items()
        },
        "hook_observations": {
            harness_id: _safe_hook_observation(observation)
            for harness_id, observation in context.hook_observations.items()
        },
        "invocation_policy": {
            harness_id: dict(policy)
            for harness_id, policy in context.invocation_policy.items()
        },
        "invocation_observations": {
            harness_id: observation_payload(observation)
            for harness_id, observation in context.invocation_observations.items()
        },
        "decisions": {
            harness_id: [
                _decision_payload(decision)
                for decision in resolution.decisions
            ]
            for harness_id, resolution in context.resolutions.items()
        },
    }


context_payload = serialize_operation_context
