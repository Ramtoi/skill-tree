"""Pure, fail-closed adapter selection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

from skill_hub.domain.harnesses.harness_adapter_api import (
    AdapterBinding,
    AdapterManifest,
    CatalogSnapshot,
    FeatureDecision,
    HarnessVariant,
    OperationResolution,
    RuntimeIdentity,
    Version,
)
from skill_hub.domain.harnesses.harness_catalog import CatalogError, catalog_content_digest, validate_catalog


@dataclass(frozen=True)
class ResolutionPolicy:
    """All caller choices required to resolve one operation."""

    requested_harness: str
    requested_features: Tuple[str, ...] = ()
    host_version: Optional[Version] = None
    sdk_version: Optional[Version] = None
    installation_pin: Optional[str] = None
    release_pin: Optional[str] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "requested_features", tuple(dict.fromkeys(self.requested_features)))
        object.__setattr__(self, "host_version", _as_version(self.host_version))
        object.__setattr__(self, "sdk_version", _as_version(self.sdk_version))


def _as_inventory(value: object) -> Tuple[RuntimeIdentity, ...]:
    if hasattr(value, "identities"):
        value = getattr(value, "identities")
    if isinstance(value, RuntimeIdentity):
        return (value,)
    try:
        return tuple(value)  # type: ignore[arg-type]
    except TypeError:
        return ()


def _as_version(value: object) -> Optional[Version]:
    if value is None or isinstance(value, Version):
        return value
    return Version.parse(value)


def _matches_dimension(value: str, allowed: Sequence[str]) -> bool:
    return not allowed or value.casefold() in {item.casefold() for item in allowed}


def _valid_identity(identity: object) -> bool:
    if not isinstance(identity, RuntimeIdentity):
        return False
    if not identity.harness_id or not identity.installation_id:
        return False
    if identity.environment == "desktop" and identity.executable_path:
        # An executable can be evidence for a desktop installation only if the
        # collector explicitly labelled it; the resolver never infers desktop.
        return False
    return True


def _pin_matches_release(manifest: AdapterManifest, pin: Optional[str]) -> bool:
    if pin is None:
        return True
    return pin in {manifest.release_id, manifest.digest}


def _variant_matches(
    manifest: AdapterManifest,
    variant: HarnessVariant,
    identity: RuntimeIdentity,
    policy: ResolutionPolicy,
) -> bool:
    runtime = identity.version
    host = policy.host_version
    sdk = policy.sdk_version
    return (
        variant.harness_id == identity.harness_id == policy.requested_harness
        and runtime is not None
        and variant.version_constraint is not None
        and variant.version_constraint.matches(runtime)
        and manifest.host_constraint.matches(host)
        and variant.host_constraint.matches(host)
        and manifest.sdk_constraint.matches(sdk)
        and variant.sdk_constraint.matches(sdk)
        and _matches_dimension(identity.os_name, variant.os_names)
        and _matches_dimension(identity.architecture, variant.architectures)
        and _matches_dimension(identity.environment, variant.environments)
    )


def _decision(feature: str, status: str, reason: str) -> FeatureDecision:
    return FeatureDecision(feature=feature, status=status, reason=reason)


def resolve_operation(
    inventory: object, catalog: CatalogSnapshot, policy: ResolutionPolicy
) -> OperationResolution:
    """Select compatible releases without reading any external state.

    Every requested feature receives a decision.  A decision without a binding
    is the only possible result for malformed, unknown, ambiguous, or pinned
    incompatible inputs.
    """
    if not isinstance(catalog, CatalogSnapshot):
        return OperationResolution(catalog_generation="invalid", decisions=tuple(
            _decision(feature, "blocked", "invalid_catalog") for feature in policy.requested_features
        ))
    active_release_ids = catalog.active_release_ids or ()
    try:
        validate_catalog(catalog.manifests, active_release_ids)
        if catalog.content_digest != catalog_content_digest(
            catalog.generation, catalog.manifests, active_release_ids
        ):
            raise ValueError("catalog content digest mismatch")
    except (CatalogError, TypeError, ValueError):
        return OperationResolution(
            catalog_generation=catalog.generation,
            decisions=tuple(
                _decision(feature, "blocked", "invalid_catalog")
                for feature in policy.requested_features
            ),
        )
    identities = _as_inventory(inventory)
    candidates = [item for item in identities if _valid_identity(item) and item.harness_id == policy.requested_harness]
    if not candidates:
        return OperationResolution(
            catalog_generation=catalog.generation,
            decisions=tuple(
                _decision(feature, "blocked", "missing_installation")
                for feature in policy.requested_features
            ),
        )
    malformed = [
        item for item in identities if item.harness_id == policy.requested_harness and not _valid_identity(item)
    ]
    if malformed:
        return OperationResolution(
            catalog_generation=catalog.generation,
            decisions=tuple(
                _decision(feature, "blocked", "malformed_installation")
                for feature in policy.requested_features
            ),
        )
    if policy.installation_pin is not None:
        pinned = [item for item in candidates if item.installation_id == policy.installation_pin]
        if not pinned:
            return OperationResolution(
                catalog_generation=catalog.generation,
                decisions=tuple(
                    _decision(feature, "blocked", "installation_pin_mismatch")
                    for feature in policy.requested_features
                ),
            )
        candidates = pinned
    if len(candidates) != 1:
        return OperationResolution(
            catalog_generation=catalog.generation,
            decisions=tuple(
                _decision(feature, "blocked", "ambiguous_installation")
                for feature in policy.requested_features
            ),
        )
    identity = candidates[0]
    if identity.version is None:
        reason = "unknown_version" if identity.raw_version else "unverified_version"
        return OperationResolution(
            catalog_generation=catalog.generation,
            decisions=tuple(_decision(feature, "blocked", reason) for feature in policy.requested_features),
        )
    active = catalog.active_manifests
    if policy.release_pin is not None:
        active = tuple(item for item in active if _pin_matches_release(item, policy.release_pin))
    compatible: list[tuple[AdapterManifest, HarnessVariant]] = []
    for manifest in active:
        for variant in manifest.variants:
            if _variant_matches(manifest, variant, identity, policy):
                compatible.append((manifest, variant))
    if not compatible:
        reason = "release_pin_mismatch" if policy.release_pin is not None else "incompatible_runtime"
        return OperationResolution(
            catalog_generation=catalog.generation,
            decisions=tuple(_decision(feature, "blocked", reason) for feature in policy.requested_features),
        )
    newest = max(manifest.release_version for manifest, _ in compatible)
    newest_matches = [(manifest, variant) for manifest, variant in compatible if manifest.release_version == newest]
    if len(newest_matches) != 1:
        return OperationResolution(
            catalog_generation=catalog.generation,
            decisions=tuple(
                _decision(feature, "blocked", "ambiguous_release")
                for feature in policy.requested_features
            ),
        )
    manifest, variant = newest_matches[0]
    decisions = []
    for feature in policy.requested_features:
        if feature not in variant.features:
            decisions.append(_decision(feature, "unsupported", "feature_not_declared"))
            continue
        declaration = variant.features[feature]
        if declaration is False or declaration == "unsupported":
            decisions.append(_decision(feature, "unsupported", "feature_declared_unsupported"))
            continue
        if declaration == "unverified":
            provenance = "unverified"
        elif declaration == "verified" and variant.validation_evidence.get(feature):
            provenance = "verified"
        else:
            decisions.append(_decision(feature, "blocked", "malformed_feature_declaration"))
            continue
        binding = AdapterBinding(
            package_id=manifest.package_id,
            release_version=manifest.release_version,
            release_digest=manifest.digest,
            harness_id=identity.harness_id,
            variant_id=variant.variant_id,
            installation_id=identity.installation_id,
            profile=variant.profile or identity.profile,
            runtime_version=identity.version,
            runtime_identity=identity,
            validation_provenance=provenance,
        )
        decisions.append(FeatureDecision(feature, "supported", "compatible", binding, provenance))
    return OperationResolution(catalog_generation=catalog.generation, decisions=tuple(decisions))
