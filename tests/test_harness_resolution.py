from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from skill_hub.domain.harnesses.harness_adapter_api import (
    AdapterManifest,
    CatalogSnapshot,
    HarnessVariant,
    RuntimeIdentity,
    Version,
    VersionConstraint,
)
from skill_hub.domain.harnesses.harness_catalog import CatalogError, build_catalog_snapshot, catalog_content_digest
from skill_hub.domain.harnesses.harness_resolution import ResolutionPolicy, resolve_operation


def _manifest(
    release: str = "1.0.0",
    *,
    runtime: VersionConstraint | None = None,
    features: dict[str, str] | None = None,
    digest: str | None = None,
    staged: bool = False,
    os_names: tuple[str, ...] = (),
    architectures: tuple[str, ...] = (),
    environments: tuple[str, ...] = (),
) -> AdapterManifest:
    return AdapterManifest(
        package_id="bundle",
        release_version=Version.parse(release),
        digest=digest or "sha256:" + (release.replace(".", "") * 22)[:64],
        staged=staged,
        variants=(
            HarnessVariant(
                harness_id="opencode",
                version_constraint=runtime or VersionConstraint.half_open("1.0.0", "2.0.0"),
                features=features or {"invocation": "unverified"},
                os_names=os_names,
                architectures=architectures,
                environments=environments,
            ),
        ),
    )


def _identity(version: str = "1.18.31", *, installation: str = "one", **kwargs: object) -> RuntimeIdentity:
    parsed = Version.parse(version) if version else None
    return RuntimeIdentity(
        harness_id="opencode",
        installation_id=installation,
        raw_version=version,
        version=parsed,
        os_name="darwin",
        architecture="arm64",
        **kwargs,
    )


def _policy(*features: str, **kwargs: object) -> ResolutionPolicy:
    return ResolutionPolicy(
        requested_harness="opencode",
        requested_features=features,
        host_version=Version(1, 0, 0),
        sdk_version=Version(1, 0, 0),
        **kwargs,
    )


def test_exact_declared_feature_binds_release_and_keeps_evidence_separate() -> None:
    catalog = build_catalog_snapshot((_manifest(runtime=VersionConstraint.exact_version("1.18.31")),))
    result = resolve_operation((_identity(),), catalog, _policy("invocation", "mcp"))

    invocation = result.decision("invocation")
    assert invocation is not None and invocation.status == "supported"
    assert invocation.binding is not None
    assert invocation.binding.release_digest.startswith("sha256:")
    assert invocation.validation_provenance == "unverified"
    assert result.decision("mcp").status == "unsupported"  # type: ignore[union-attr]


def test_explicitly_unsupported_feature_has_no_binding_and_true_needs_evidence() -> None:
    unsupported = build_catalog_snapshot((_manifest(features={"hooks": False}),))
    decision = resolve_operation((_identity(),), unsupported, _policy("hooks")).decision("hooks")
    assert decision is not None and decision.status == "unsupported" and decision.binding is None
    with pytest.raises(CatalogError, match="invalid feature declaration"):
        build_catalog_snapshot((_manifest(features={"hooks": True}),))


@pytest.mark.parametrize(
    ("identity", "reason"),
    [
        (_identity("custom-build"), "unknown_version"),
        (_identity("1.18.31-beta"), "incompatible_runtime"),
        (_identity("0.9.0"), "incompatible_runtime"),
    ],
)
def test_unknown_prerelease_and_out_of_range_are_blocked(identity: RuntimeIdentity, reason: str) -> None:
    catalog = build_catalog_snapshot((_manifest(),))
    decision = resolve_operation((identity,), catalog, _policy("invocation")).decision("invocation")
    assert decision is not None and decision.status == "blocked" and decision.reason == reason


def test_pins_host_sdk_os_arch_and_environment_fail_closed() -> None:
    catalog = build_catalog_snapshot(
        (_manifest(os_names=("linux",), architectures=("x86_64",), environments=("cli",)),)
    )
    identity = _identity(installation="other")
    assert resolve_operation((identity,), catalog, _policy("invocation", installation_pin="missing")).decision(
        "invocation"
    ).reason == "installation_pin_mismatch"  # type: ignore[union-attr]
    policy = _policy("invocation", release_pin="bundle@9.0.0")
    assert resolve_operation((identity,), catalog, policy).decision("invocation").reason == "release_pin_mismatch"  # type: ignore[union-attr]
    assert resolve_operation(
        (_identity(installation="other"),), catalog, _policy("invocation")
    ).decision("invocation").reason == "incompatible_runtime"  # type: ignore[union-attr]


def test_release_pin_is_exact_and_cannot_widen_to_a_newer_release() -> None:
    catalog = build_catalog_snapshot(
        (
            _manifest("1.0.0"),
            _manifest("1.1.0", runtime=VersionConstraint.half_open("1.0.0", "2.0.0")),
        )
    )
    result = resolve_operation((_identity(),), catalog, _policy("invocation", release_pin="bundle@1.0.0"))
    assert result.decision("invocation").binding.release_version == Version(1, 0, 0)  # type: ignore[union-attr]
    blocked = resolve_operation((_identity(),), catalog, _policy("invocation", release_pin="bundle"))
    assert blocked.decision("invocation").reason == "release_pin_mismatch"  # type: ignore[union-attr]


def test_multiple_installations_need_a_selection_and_equal_releases_are_ambiguous() -> None:
    catalog = build_catalog_snapshot((_manifest(),))
    result = resolve_operation(
        (_identity(installation="a"), _identity(installation="b")), catalog, _policy("invocation")
    )
    assert result.decision("invocation").reason == "ambiguous_installation"  # type: ignore[union-attr]

    equal = build_catalog_snapshot(
        (
            _manifest(digest="sha256:" + "1" * 64),
            AdapterManifest(
                package_id="other",
                release_version=Version(1, 0, 0),
                digest="sha256:" + "2" * 64,
                variants=(
                    HarnessVariant(
                        harness_id="opencode",
                        variant_id="alt",
                        version_constraint=VersionConstraint.half_open("1.0.0", "2.0.0"),
                        features={"invocation": "unverified"},
                    ),
                ),
            ),
        )
    )
    assert (
        resolve_operation((_identity(),), equal, _policy("invocation")).decision("invocation").reason
        == "ambiguous_release"
    )  # type: ignore[union-attr]


def test_catalog_rejects_overlap_and_excludes_staged_release() -> None:
    with pytest.raises(CatalogError, match="indistinguishable"):
        build_catalog_snapshot(
            (
                _manifest("1.0.0"),
                AdapterManifest(
                    package_id="other",
                    release_version=Version(1, 0, 0),
                    digest="sha256:" + "9" * 64,
                    variants=_manifest().variants,
                ),
            )
        )
    staged = build_catalog_snapshot((_manifest("1.0.0", staged=True),))
    decision = resolve_operation((_identity(),), staged, _policy("invocation")).decision("invocation")
    assert decision is not None and decision.status == "blocked"


def test_snapshot_and_digest_do_not_change_after_input_mutation() -> None:
    features = {"invocation": "unverified"}
    manifest = _manifest(features=features)
    source = [manifest]
    catalog = build_catalog_snapshot(source)
    digest = catalog.content_digest
    features["mcp"] = "verified"
    source.clear()
    assert catalog.content_digest == digest
    assert "mcp" not in catalog.manifests[0].variants[0].features
    with pytest.raises(FrozenInstanceError):
        catalog.generation = "changed"  # type: ignore[misc]
    assert catalog_content_digest("bundled-1", catalog.manifests, catalog.active_release_ids) == digest


def test_resolver_rejects_forged_or_unvalidated_direct_catalog_snapshots() -> None:
    forged = CatalogSnapshot(generation="forged", manifests=(_manifest(),), content_digest="")
    decision = resolve_operation((_identity(),), forged, _policy("invocation")).decision("invocation")
    assert decision is not None and decision.status == "blocked" and decision.reason == "invalid_catalog"
    malformed = AdapterManifest(
        package_id="malformed",
        release_version=Version(1, 0, 0),
        digest="sha256:" + "4" * 64,
        variants=(HarnessVariant(harness_id="opencode", features={"invocation": "verified"}),),
    )
    malformed_digest = catalog_content_digest("malformed", (malformed,), (malformed.release_id,))
    direct = CatalogSnapshot(
        generation="malformed",
        manifests=(malformed,),
        active_release_ids=(malformed.release_id,),
        content_digest=malformed_digest,
    )
    decision = resolve_operation((_identity(),), direct, _policy("invocation")).decision("invocation")
    assert decision is not None and decision.status == "blocked" and decision.reason == "invalid_catalog"
