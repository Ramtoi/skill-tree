"""The small, immutable catalog used by the first resolver wave."""

from __future__ import annotations

import hashlib
import json
import re
from types import MappingProxyType
from typing import Iterable, Mapping, Optional, Sequence, Tuple

from skill_hub.domain.harnesses.harness_adapter_api import (
    AdapterManifest,
    CatalogSnapshot,
    FeatureDecision,
    HarnessVariant,
    McpNativeCodec,
    Version,
    VersionConstraint,
)


class CatalogError(ValueError):
    """The catalog is malformed or contains an unsafe ambiguity."""


def _constraint_payload(constraint: Optional[VersionConstraint]) -> dict:
    if constraint is None:
        return {"kind": "missing", "exact": None, "lower": None, "upper": None}
    return {
        "kind": constraint.kind,
        "exact": str(constraint.exact) if constraint.exact else None,
        "lower": str(constraint.lower) if constraint.lower else None,
        "upper": str(constraint.upper) if constraint.upper else None,
    }


def _variant_payload(variant: HarnessVariant) -> dict:
    return {
        "harness_id": variant.harness_id,
        "variant_id": variant.variant_id,
        "version": _constraint_payload(variant.version_constraint),
        "host": _constraint_payload(variant.host_constraint),
        "sdk": _constraint_payload(variant.sdk_constraint),
        "os": list(variant.os_names),
        "arch": list(variant.architectures),
        "environment": list(variant.environments),
        "features": dict(sorted(variant.features.items())),
        "validation_evidence": dict(sorted(variant.validation_evidence.items())),
        "profile": variant.profile,
        "metadata": dict(variant.metadata),
    }


def manifest_payload(manifest: AdapterManifest) -> dict:
    """Return all selection-relevant manifest data in canonical JSON shape."""
    return {
        "package_id": manifest.package_id,
        "release_version": str(manifest.release_version),
        "digest": manifest.digest,
        "host": _constraint_payload(manifest.host_constraint),
        "sdk": _constraint_payload(manifest.sdk_constraint),
        "active": manifest.active,
        "staged": manifest.staged,
        "variants": [_variant_payload(item) for item in manifest.variants],
        "metadata": dict(manifest.metadata),
    }


def catalog_content_digest(
    generation: str, manifests: Sequence[AdapterManifest], active_release_ids: Sequence[str]
) -> str:
    """Hash every field that can affect selection, with stable ordering."""
    payload = {
        "generation": generation,
        "active_release_ids": sorted(active_release_ids),
        "manifests": [manifest_payload(item) for item in sorted(manifests, key=lambda m: m.release_id)],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def manifest_content_digest(manifest: AdapterManifest) -> str:
    """Digest canonical manifest bytes without a self-referential digest."""
    payload = manifest_payload(manifest)
    payload["digest"] = None
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _validate_digest(digest: str) -> None:
    if not digest or digest.strip() != digest:
        raise CatalogError("manifest digest must be a non-empty stable identifier")
    if digest.startswith("sha256:") and not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise CatalogError("invalid sha256 manifest digest")


def validate_catalog(
    manifests: Iterable[AdapterManifest], active_release_ids: Optional[Sequence[str]] = None
) -> Tuple[AdapterManifest, ...]:
    """Validate release identities, ranges, features, and variant ambiguity."""
    rows = tuple(manifests)
    identities = set()
    digests = set()
    for manifest in rows:
        _validate_digest(manifest.digest)
        if not manifest.release_version.is_stable:
            raise CatalogError("adapter release versions must be stable")
        identity = (manifest.package_id, manifest.release_version)
        if identity in identities:
            raise CatalogError(f"duplicate release identity: {manifest.release_id}")
        identities.add(identity)
        if manifest.digest in digests:
            raise CatalogError(f"duplicate release digest: {manifest.digest}")
        digests.add(manifest.digest)
        seen_variants = set()
        for variant in manifest.variants:
            if not variant.harness_id or not variant.variant_id:
                raise CatalogError("variant identity is required")
            variant_identity = (variant.harness_id, variant.variant_id)
            if variant_identity in seen_variants:
                raise CatalogError(f"duplicate variant identity: {manifest.release_id}/{variant.variant_id}")
            seen_variants.add(variant_identity)
            if variant.version_constraint is None or variant.version_constraint.kind == "any":
                raise CatalogError("runtime constraint required for every variant")
            if any(not name for name in variant.features):
                raise CatalogError("feature names must be non-empty")
            for feature, state in variant.features.items():
                if state is False:
                    continue
                if not isinstance(state, str) or state not in {"unsupported", "unverified", "verified"}:
                    raise CatalogError(f"invalid feature declaration: {feature}")
                if state == "verified" and not variant.validation_evidence.get(feature):
                    raise CatalogError(f"verified feature lacks evidence: {feature}")

    active = tuple(active_release_ids) if active_release_ids is not None else tuple(
        item.release_id for item in rows if item.active and not item.staged
    )
    known = {item.release_id: item for item in rows}
    if len(set(active)) != len(active):
        raise CatalogError("duplicate active release identity")
    for release_id in active:
        item = known.get(release_id)
        if item is None:
            raise CatalogError(f"active release is missing: {release_id}")
        if not item.active or item.staged:
            raise CatalogError(f"inactive or staged release is selected: {release_id}")

    # Two variants with the same public identity and overlapping constraints
    # cannot be resolved by order.  Distinct variant IDs are an intentional
    # choice and therefore remain valid.
    active_rows = [item for item in rows if item.release_id in active]
    for index, left_manifest in enumerate(active_rows):
        for right_manifest in active_rows[index + 1 :]:
            for left in left_manifest.variants:
                for right in right_manifest.variants:
                    # Different release versions are intentionally ordered by
                    # the resolver; only equal-version overlap is ambiguous.
                    if left_manifest.release_version != right_manifest.release_version:
                        continue
                    if left.harness_id != right.harness_id or left.variant_id != right.variant_id:
                        continue
                    if left.version_constraint is None or right.version_constraint is None:
                        continue
                    if not left.version_constraint.overlaps(right.version_constraint):
                        continue
                    if not left.host_constraint.overlaps(right.host_constraint):
                        continue
                    if not left.sdk_constraint.overlaps(right.sdk_constraint):
                        continue
                    if left.os_names != right.os_names or left.architectures != right.architectures:
                        continue
                    if left.environments != right.environments or dict(left.features) != dict(right.features):
                        continue
                    raise CatalogError(f"indistinguishable variant overlap: {left.harness_id}/{left.variant_id}")
    return rows


def build_catalog_snapshot(
    manifests: Iterable[AdapterManifest],
    *,
    generation: str = "bundled-1",
    active_release_ids: Optional[Sequence[str]] = None,
) -> CatalogSnapshot:
    rows = validate_catalog(manifests, active_release_ids)
    active = tuple(active_release_ids) if active_release_ids is not None else tuple(
        item.release_id for item in rows if item.active and not item.staged
    )
    return CatalogSnapshot(
        generation=generation,
        manifests=rows,
        active_release_ids=active,
        content_digest=catalog_content_digest(generation, rows, active),
    )


def bundled_catalog() -> CatalogSnapshot:
    """Return the baseline catalog; undeclared features stay unsupported."""
    manifest = AdapterManifest(
        package_id="bundled",
        release_version=Version(1, 0, 0),
        digest="pending",
        variants=(
            HarnessVariant(
                harness_id="opencode",
                variant_id="cli",
                version_constraint=VersionConstraint.exact_version(Version(1, 18, 31)),
                features={"invocation": "verified"},
                validation_evidence={"invocation": "exact opencode 1.18.31 invocation evidence"},
                profile="opencode-v1.18.31",
            ),
        ),
    )
    manifest = AdapterManifest(
        package_id=manifest.package_id,
        release_version=manifest.release_version,
        digest=manifest_content_digest(manifest),
        variants=manifest.variants,
        host_constraint=manifest.host_constraint,
        sdk_constraint=manifest.sdk_constraint,
        active=manifest.active,
        staged=manifest.staged,
        metadata=manifest.metadata,
    )
    return build_catalog_snapshot((manifest,), generation="bundled-1")


catalog_snapshot = bundled_catalog

# This release has no verified MCP profile.  Keep the production lookup
# explicit and immutable; fixture callers may supply a synthetic table to
# exercise the exact identity contract without importing arbitrary modules.
BUNDLED_MCP_TRUSTED_RECORDS: Mapping[str, tuple[str, Version, str, str]] = MappingProxyType({})
BUNDLED_MCP_CODECS: Mapping[str, McpNativeCodec] = MappingProxyType({})


def bundled_mcp_codec(
    catalog: CatalogSnapshot,
    decision: FeatureDecision,
    adapter_key: str,
    *,
    trusted_records: Optional[Mapping[str, tuple[str, Version, str, str]]] = None,
    codec_table: Optional[Mapping[str, McpNativeCodec]] = None,
) -> Optional[McpNativeCodec]:
    """Return an explicitly trusted bundled MCP codec, or no comparison.

    trusted_records and codec_table are deliberately injectable for offline
    fixture tests. Production supplies no MCP record until a bundled release
    has verified MCP evidence; no manifest module name is imported.
    """
    if not isinstance(catalog, CatalogSnapshot) or not isinstance(decision, FeatureDecision):
        return None
    binding = decision.binding
    if decision.feature != "mcp" or not decision.supported or binding is None:
        return None
    trusted_records = BUNDLED_MCP_TRUSTED_RECORDS if trusted_records is None else trusted_records
    codec_table = BUNDLED_MCP_CODECS if codec_table is None else codec_table
    try:
        active_release_ids = catalog.active_release_ids or ()
        validate_catalog(catalog.manifests, active_release_ids)
        expected_digest = catalog_content_digest(
            catalog.generation, catalog.manifests, active_release_ids
        )
    except (CatalogError, TypeError, ValueError):
        return None
    if catalog.content_digest != expected_digest:
        return None
    manifest = next(
        (
            item
            for item in catalog.active_manifests
            if item.package_id == binding.package_id
            and item.release_version == binding.release_version
            and item.digest == binding.release_digest
        ),
        None,
    )
    variant = next(
        (
            item
            for item in manifest.variants
            if item.harness_id == binding.harness_id
            and item.variant_id == binding.variant_id
        ),
        None,
    ) if manifest is not None else None
    if (
        variant is None
        or variant.features.get(decision.feature) != "verified"
        or not variant.validation_evidence.get(decision.feature)
        or decision.validation_provenance != "verified"
    ):
        return None
    allowed_harnesses = {
        "claude": {"claude-code", "pi"}, "codex": {"codex"}, "opencode": {"opencode"},
    }
    identity = binding.runtime_identity
    if (
        binding.harness_id not in allowed_harnesses.get(adapter_key, set())
        or binding.harness_id != identity.harness_id
        or binding.installation_id != identity.installation_id
        or binding.runtime_version != identity.version
        or binding.profile != (variant.profile or identity.profile)
        or variant.version_constraint is None
        or not variant.version_constraint.matches(binding.runtime_version)
    ):
        return None
    trusted = trusted_records.get(adapter_key)
    if trusted is None:
        return None
    package_id, release_version, release_digest, variant_id = trusted
    if (
        binding.package_id != package_id
        or binding.release_version != release_version
        or binding.release_digest != release_digest
        or binding.variant_id != variant_id
    ):
        return None
    return codec_table.get(adapter_key)


mcp_codec_for_binding = bundled_mcp_codec


_NATIVE_KEYS = frozenset({
    "args", "bearer_token_env_var", "command", "cwd", "enabled", "env",
    "env_http_headers", "env_vars", "environment", "headers", "http_headers",
    "startup_timeout_sec", "timeout", "tool_timeout_sec", "type", "url",
})
_MAX_DIFFERENCE_DEPTH = 8
_MAX_DIFFERENCE_BYTES = 512
_MAX_DIFFERENCE_NODES = 256
_MAX_DIFFERENCE_WIDTH = 128
_DIFFERENCE_INCONCLUSIVE = "native.<inconclusive>"


class _DifferenceBudget:
    def __init__(self) -> None:
        self.nodes = 0

    def consume(self) -> bool:
        self.nodes += 1
        return self.nodes <= _MAX_DIFFERENCE_NODES


def _safe_key(key: object) -> str:
    text = str(key)
    if text in _NATIVE_KEYS:
        return text
    digest = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:12]
    return f"<key:{digest}>"


def _difference_paths(
    left: object,
    right: object,
    prefix: str = "native",
    limit: int = 16,
    depth: int = 0,
    _budget: Optional[_DifferenceBudget] = None,
) -> list[str]:
    """Return bounded structural paths without exposing native values."""
    if depth >= _MAX_DIFFERENCE_DEPTH:
        return [_DIFFERENCE_INCONCLUSIVE]
    containers = isinstance(left, Mapping) and isinstance(right, Mapping) or (
        isinstance(left, (list, tuple)) and isinstance(right, (list, tuple))
    )
    if not containers:
        return [] if left == right else [prefix]
    budget = _budget or _DifferenceBudget()
    if not budget.consume():
        return [_DIFFERENCE_INCONCLUSIVE]
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        if len(left) > _MAX_DIFFERENCE_WIDTH or len(right) > _MAX_DIFFERENCE_WIDTH:
            return [_DIFFERENCE_INCONCLUSIVE]
        paths: list[str] = []
        keys: list[object] = []
        seen: set[object] = set()
        for mapping in (left, right):
            for key in mapping:
                if key not in seen:
                    seen.add(key)
                    keys.append(key)
                    if len(keys) > _MAX_DIFFERENCE_WIDTH:
                        return [_DIFFERENCE_INCONCLUSIVE]
        keys.sort(key=str)
        for key in keys:
            child = f"{prefix}.{_safe_key(key)}"
            if key not in left or key not in right:
                paths.append(child)
            else:
                child_paths = _difference_paths(
                    left[key], right[key], child, limit - len(paths), depth + 1, budget
                )
                if _DIFFERENCE_INCONCLUSIVE in child_paths:
                    return [_DIFFERENCE_INCONCLUSIVE]
                paths.extend(child_paths)
            if len(paths) >= limit:
                break
        return paths[:limit]
    if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
        if len(left) > _MAX_DIFFERENCE_WIDTH or len(right) > _MAX_DIFFERENCE_WIDTH:
            return [_DIFFERENCE_INCONCLUSIVE]
        paths = []
        for index in range(max(len(left), len(right))):
            child = f"{prefix}[{index}]"
            if index >= len(left) or index >= len(right):
                paths.append(child)
            else:
                child_paths = _difference_paths(
                    left[index], right[index], child, limit - len(paths), depth + 1, budget
                )
                if _DIFFERENCE_INCONCLUSIVE in child_paths:
                    return [_DIFFERENCE_INCONCLUSIVE]
                paths.extend(child_paths)
            if len(paths) >= limit:
                break
        return paths[:limit]
    return [prefix]


def _bounded_difference_paths(paths: list[str]) -> list[str]:
    bounded: list[str] = []
    size = 0
    for path in paths:
        next_size = size + len(path.encode("utf-8"))
        if next_size > _MAX_DIFFERENCE_BYTES:
            break
        bounded.append(path)
        size = next_size
    return bounded


def compare_bundled_mcp(
    catalog: CatalogSnapshot,
    decision: FeatureDecision,
    adapter_key: str,
    spec: object,
    *,
    trusted_records: Optional[Mapping[str, tuple[str, Version, str, str]]] = None,
    codec_table: Optional[Mapping[str, McpNativeCodec]] = None,
) -> dict[str, object]:
    """Compare a trusted codec with the legacy native encoder structurally.

    The result contains only bounded field paths, never native values or
    secrets.  Legacy output remains authoritative; this helper is read-only.
    """
    codec = bundled_mcp_codec(
        catalog, decision, adapter_key,
        trusted_records=trusted_records, codec_table=codec_table,
    )
    if codec is None:
        return {"status": "unavailable", "reason": "no_verified_mcp_codec"}
    try:
        from skill_hub.domain.harnesses.harness_adapter_api import McpNativeRequest, thaw_mcp_value
        from skill_hub.domain.mcp import mcp_spec

        if not isinstance(spec, mcp_spec.McpServerSpec):
            return {"status": "unavailable", "reason": "invalid_spec"}
        expected_native, expected_skips = mcp_spec.to_native(spec, adapter_key)
        request = McpNativeRequest(
            name=spec.name,
            command=spec.command,
            args=tuple(spec.args),
            env=dict(spec.env),
            cwd=spec.cwd,
            transport=spec.transport,
            url=spec.url,
            headers=dict(spec.headers),
            timeout_ms=spec.timeout_ms,
            allow_literal_secrets=spec.allow_literal_secrets,
        )
        result = codec.encode(request)
        actual_native = thaw_mcp_value(result.native_entry)
        differences = _bounded_difference_paths(_difference_paths(expected_native, actual_native))
        if _DIFFERENCE_INCONCLUSIVE in differences:
            return {"status": "unavailable", "reason": "difference_budget"}
        if tuple(expected_skips) != tuple(result.skip_reasons):
            differences = _bounded_difference_paths([*differences, "skip_reasons"])
        return {"status": "equal" if not differences else "different", "differences": differences}
    except Exception:
        return {"status": "unavailable", "reason": "codec_error"}


compare_mcp_codec = compare_bundled_mcp
