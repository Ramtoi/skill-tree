from __future__ import annotations

import json
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

from skill_hub.application.harnesses.harness_operation_context import (
    AdapterRoute,
    OperationAdapterContext,
    serialize_operation_context,
)
from skill_hub.application.harnesses.harness_runtime import RuntimeInventory
from skill_hub.domain.harnesses.harness_adapter_api import (
    AdapterManifest,
    HarnessVariant,
    McpNativeResult,
    OperationResolution,
    RuntimeIdentity,
    Version,
    VersionConstraint,
)
from skill_hub.domain.harnesses.harness_catalog import (
    build_catalog_snapshot,
    bundled_catalog,
    bundled_mcp_codec,
    compare_bundled_mcp,
)
from skill_hub.domain.harnesses.harness_resolution import ResolutionPolicy, resolve_operation
from skill_hub.domain.mcp.mcp_spec import McpServerSpec
from skill_hub.infrastructure.harnesses.harness_bundled_mcp import bundled_codec
from skill_hub.infrastructure.mcp.mcp_delivery import rows_from_global_result, rows_from_project_result


def _fixture_catalog(harness_id="opencode"):
    manifest = AdapterManifest(
        package_id="fixture-bundle",
        release_version=Version(1, 0, 0),
        digest="fixture-release-digest",
        variants=(
            HarnessVariant(
                harness_id=harness_id,
                variant_id="mcp",
                version_constraint=VersionConstraint.exact_version("1.18.31"),
                features={"mcp": "verified"},
                validation_evidence={"mcp": "fixture evidence"},
            ),
        ),
    )
    return build_catalog_snapshot((manifest,))


def _fixture_identity(harness_id="opencode"):
    return RuntimeIdentity(
        harness_id=harness_id,
        installation_id="fixture",
        version=Version(1, 18, 31),
        raw_version="1.18.31",
        os_name="macos",
        architecture="arm64",
    )


def _decision(catalog, harness_id="opencode"):
    identity = _fixture_identity(harness_id)
    return resolve_operation(
        (identity,),
        catalog,
        ResolutionPolicy(requested_harness=harness_id, requested_features=("mcp",),
                         host_version=Version(1, 0, 0), sdk_version=Version(1, 0, 0)),
    ).decision("mcp")


def _fixture_context(harness_id="opencode", adapter_key="opencode") -> tuple[OperationAdapterContext, McpServerSpec]:
    from skill_hub.application.harnesses.harness_layout_context import capture_layouts

    catalog = _fixture_catalog(harness_id)
    decision = _decision(catalog, harness_id)
    assert decision is not None
    layouts = capture_layouts((harness_id,), home=Path.home())
    context = OperationAdapterContext(
        context_id="fixture-context",
        data_home="/tmp/fixture-hub",
        harness_ids=(harness_id,),
        catalog=catalog,
        inventory=RuntimeInventory(
            (_fixture_identity(harness_id),),
            "fixture",
            observed_at="2026-09-16T00:00:00+00:00",
        ),
        inventory_cache_state="fresh",
        resolutions={harness_id: OperationResolution(catalog.generation, (decision,))},
        trusted_mcp_records={
            adapter_key: ("fixture-bundle", Version(1, 0, 0), "fixture-release-digest", "mcp")
        },
        mcp_codecs={adapter_key: bundled_codec(adapter_key)},
        layouts=layouts,
    )
    object.__setattr__(
        context,
        "routes",
        MappingProxyType(
            {
                (harness_id, "mcp"): AdapterRoute(
                    harness_id=harness_id,
                    feature="mcp",
                    adapter_key=layouts[harness_id].mcp_adapter_key,
                )
            }
        ),
    )
    return context, McpServerSpec(name="fixture", command="node", args=["server.js"])


def test_bundled_catalog_has_no_mcp_binding() -> None:
    catalog = bundled_catalog()
    decision = _decision_for_bundled(catalog)
    assert decision is not None and decision.status == "unsupported"
    assert bundled_mcp_codec(catalog, decision, "opencode") is None


def _decision_for_bundled(catalog):
    identity = RuntimeIdentity(
        harness_id="opencode",
        installation_id="fixture",
        version=Version(1, 18, 31),
        raw_version="1.18.31",
        os_name="macos",
        architecture="arm64",
    )
    return resolve_operation(
        (identity,), catalog,
        ResolutionPolicy(requested_harness="opencode", requested_features=("mcp",),
                         host_version=Version(1, 0, 0), sdk_version=Version(1, 0, 0)),
    ).decision("mcp")


def test_factory_requires_exact_trusted_identity_and_returns_known_codec() -> None:
    catalog = _fixture_catalog()
    decision = _decision(catalog)
    assert decision is not None and decision.status == "supported"
    binding = decision.binding
    assert binding is not None
    trusted = {"opencode": ("fixture-bundle", Version(1, 0, 0), "fixture-release-digest", "mcp")}
    codec = bundled_codec("opencode")
    assert (
        bundled_mcp_codec(
            catalog, decision, "opencode", trusted_records=trusted,
            codec_table={"opencode": codec},
        )
        is codec
    )
    mismatched = {"opencode": ("other", *trusted["opencode"][1:])}
    assert bundled_mcp_codec(
        catalog, decision, "opencode", trusted_records=mismatched,
        codec_table={"opencode": codec},
    ) is None


def test_factory_rejects_forged_catalog_digest() -> None:
    catalog = _fixture_catalog()
    decision = _decision(catalog)
    forged = type(catalog)(
        generation=catalog.generation,
        manifests=catalog.manifests,
        active_release_ids=catalog.active_release_ids,
        content_digest="sha256:forged",
    )
    assert bundled_mcp_codec(forged, decision, "opencode", trusted_records={}, codec_table={}) is None


def test_shadow_compare_reports_equal_or_bounded_structural_difference() -> None:
    catalog = _fixture_catalog()
    decision = _decision(catalog)
    spec = McpServerSpec(name="fixture", command="node", args=["server.js"])
    trusted = {"opencode": ("fixture-bundle", Version(1, 0, 0), "fixture-release-digest", "mcp")}
    equal = compare_bundled_mcp(
        catalog,
        decision,
        "opencode",
        spec,
        trusted_records=trusted,
        codec_table={"opencode": bundled_codec("opencode")},
    )
    assert equal == {"status": "equal", "differences": []}

    class DifferentCodec:
        def encode(self, request):
            return McpNativeResult({"command": ["redacted-difference"]})

    different = compare_bundled_mcp(
        catalog,
        decision,
        "opencode",
        spec,
        trusted_records=trusted,
        codec_table={"opencode": DifferentCodec()},
    )
    assert different["status"] == "different"
    assert different["differences"]
    assert "redacted-difference" not in str(different)


def test_delivery_rows_share_one_context_snapshot() -> None:
    context, spec = _fixture_context()
    result = SimpleNamespace(
        target=Path("/tmp/native.json"),
        aborted=False,
        managed={"fixture"},
        added={"fixture"},
        updated=set(),
        adopted=set(),
        preserved=set(),
        skips={},
    )
    project_rows = rows_from_project_result(
        result,
        harness_ids=["opencode"],
        adapter="opencode",
        scope_label="project:fixture",
        operation_context=context,
        specs={"fixture": spec},
    )
    global_rows = rows_from_global_result(
        result,
        harness_id="opencode",
        adapter="opencode",
        target=Path("/tmp/native.json"),
        operation_context=context,
        specs={"fixture": spec},
    )
    assert project_rows[0]["operation_context_id"] == global_rows[0]["operation_context_id"]
    assert project_rows[0]["compatibility"]["mode"] == "shadow"
    assert project_rows[0]["compatibility"]["comparison"]["status"] == "equal"
    assert serialize_operation_context(context)["context_id"] == "fixture-context"


def test_project_and_global_dispatch_attach_same_context_without_changing_write_result(
    tmp_path, monkeypatch
) -> None:
    import hub
    from skill_hub.application.sync import mcp_sync
    from skill_hub.infrastructure.harnesses import harnesses
    from skill_hub.infrastructure.mcp import mcp_adapters

    context, _spec = _fixture_context()
    registry = {
        "skills": {
            "fixture": {
                "type": "mcp-server",
                "scope": "global",
                "mcp": {"command": "node", "args": ["server.js"]},
            }
        },
        "projects": {"demo": {"path": str(tmp_path)}},
        "harnesses_global": ["opencode"],
    }
    result = mcp_adapters.McpProjectWriteResult(
        managed=frozenset({"fixture"}),
        added=frozenset({"fixture"}),
        changed=True,
        target=tmp_path / "opencode.json",
    )

    class Adapter:
        def write(self, *args, **kwargs):
            return result

    monkeypatch.setattr(
        harnesses,
        "detect_installed",
        lambda: (_ for _ in ()).throw(AssertionError("redetect during operation")),
    )
    monkeypatch.setattr(hub, "_skill_affinity", lambda cfg: None)
    monkeypatch.setattr(
        mcp_adapters,
        "select_mcp_adapter",
        lambda context, harness_id: Adapter(),
    )
    project_report = {"projects": {"demo": {"mcp_delivery": []}}}
    mcp_sync.sync_mcp_for_project(
        tmp_path, ["fixture"], registry, project_name="demo",
        report=project_report, operation_context=context,
    )
    project_row = project_report["projects"]["demo"]["mcp_delivery"][0]
    assert project_row["operation_context_id"] == context.context_id
    assert project_row["compatibility"]["comparison"]["status"] == "equal"

    global_report = {"global": {"mcp": {"writes": 0, "removed": 0, "delivery": []}}}
    mcp_sync._run_global_mcp_dispatch(
        registry, {"opencode"}, report=global_report, operation_context=context,
    )
    global_row = global_report["global"]["mcp"]["delivery"][0]
    assert global_row["operation_context_id"] == context.context_id
    assert result.added == frozenset({"fixture"})


def test_reconcile_discovery_exposes_operation_context(tmp_data_home, monkeypatch, capsys) -> None:
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setattr(mcp_cli.hub_core, "load_registry", lambda: {"projects": {}, "skills": {}})
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"opencode"})
    monkeypatch.setattr(mcp_cli.mcp_reconcile, "discover_native", lambda *args: [])
    monkeypatch.setattr(mcp_cli.mcp_reconcile, "classify", lambda *args: [])
    monkeypatch.setattr(mcp_cli, "_mcp_kept_names", lambda scope: set())
    monkeypatch.setattr(mcp_cli, "_mcp_kept_display_names", lambda scope: [])
    args = SimpleNamespace(global_=True, project=None, harness=None, apply=False, json=True)

    mcp_cli._cmd_mcp_reconcile_impl(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["mcp_operation_context"]["context_id"]
    assert payload["mcp_operation_context"]["mode"] == "shadow"


def test_global_shadow_difference_keeps_legacy_write_and_foreign_entry(tmp_path, tmp_data_home, monkeypatch):
    from dataclasses import replace

    from skill_hub.application.sync import mcp_sync
    from skill_hub.infrastructure.harnesses import harnesses

    native = tmp_path / "claude.json"
    native.write_text(json.dumps({"mcpServers": {"foreign": {"command": "untouched"}}}))
    monkeypatch.setitem(harnesses.HARNESSES, "claude-code", replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=native,
    ))
    context, _ = _fixture_context("claude-code", "claude")

    class DifferentCodec:
        def encode(self, request):
            return McpNativeResult({"command": "candidate-only"})

    context = replace(context, mcp_codecs={"claude": DifferentCodec()})
    registry = {"skills": {"fixture": {
        "type": "mcp-server", "scope": "global", "mcp": {"command": "node"},
    }}, "projects": {}, "sources": {}}
    report = {"global": {"mcp": {"writes": 0, "removed": 0, "delivery": []}}}
    mcp_sync._run_global_mcp_dispatch(
        registry, {"claude-code"}, report=report, operation_context=context,
    )
    row = report["global"]["mcp"]["delivery"][0]
    assert row["operation_context_id"] == context.context_id
    assert row["compatibility"]["comparison"]["status"] == "different"
    persisted = json.loads(native.read_text())["mcpServers"]
    assert persisted["fixture"]["command"] == "node"
    assert persisted["foreign"] == {"command": "untouched"}


def test_reconcile_apply_returns_comparisons_from_same_context(tmp_path, tmp_data_home, monkeypatch):
    from dataclasses import replace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.harnesses import harnesses
    from skill_hub.infrastructure.mcp import mcp_reconcile

    native = tmp_path / "claude.json"
    native.write_text(json.dumps({"mcpServers": {"fixture": {"command": "node", "args": [], "env": {}}}}))
    monkeypatch.setitem(harnesses.HARNESSES, "claude-code", replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=native,
    ))
    context, _ = _fixture_context("claude-code", "claude")
    registry = {"skills": {}, "projects": {}, "bundles": {}, "harnesses_global": []}
    discovered = mcp_reconcile.discover_native("global", None, registry, {"claude-code"})
    candidates = mcp_reconcile.classify(discovered, registry, set())
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "global", None, None, candidates, discovered,
        [{"name": "fixture", "action": "import"}], {"claude-code"}, context,
    )
    assert summary["synced"] is True
    assert summary["mcp_delivery"]
    assert {row["operation_context_id"] for row in summary["mcp_delivery"]} == {context.context_id}
    assert summary["mcp_delivery"][0]["compatibility"]["comparison"]["status"] == "equal"


def test_sdk_constraint_is_independent_of_host_release():
    from dataclasses import replace

    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION

    catalog = _fixture_catalog()
    manifest = replace(catalog.manifests[0],
                       host_constraint=VersionConstraint.exact_version("9.0.0"),
                       sdk_constraint=VersionConstraint.exact_version(str(SDK_VERSION)))
    catalog = build_catalog_snapshot((manifest,))
    identity = RuntimeIdentity("opencode", "fixture", version=Version(1, 18, 31))
    correct = resolve_operation((identity,), catalog, ResolutionPolicy(
        requested_harness="opencode", requested_features=("mcp",),
        host_version=Version(9, 0, 0), sdk_version=SDK_VERSION,
    ))
    wrong = resolve_operation((identity,), catalog, ResolutionPolicy(
        requested_harness="opencode", requested_features=("mcp",),
        host_version=Version(9, 0, 0), sdk_version=Version(9, 0, 0),
    ))
    assert correct.decision("mcp").supported
    assert wrong.decision("mcp").status == "blocked"


def test_factory_rejects_wrong_harness_and_forged_runtime_identity():
    from dataclasses import replace

    catalog = _fixture_catalog()
    decision = _decision(catalog)
    trust = {"codex": ("fixture-bundle", Version(1, 0, 0), "fixture-release-digest", "mcp")}
    assert bundled_mcp_codec(catalog, decision, "codex", trusted_records=trust,
                             codec_table={"codex": bundled_codec("codex")}) is None
    forged = replace(decision, binding=replace(decision.binding, installation_id="other"))
    trust = {"opencode": trust["codex"]}
    assert bundled_mcp_codec(catalog, forged, "opencode", trusted_records=trust,
                             codec_table={"opencode": bundled_codec("opencode")}) is None


def test_shadow_difference_paths_hide_keys_and_bound_depth():
    from skill_hub.domain.harnesses.harness_catalog import _bounded_difference_paths, _difference_paths

    secret = "credential-accidentally-used-as-key"
    paths = _bounded_difference_paths(_difference_paths({"headers": {secret: "left"}}, {"headers": {secret: "right"}}))
    assert paths and secret not in str(paths)
    left, right = {"v": 1}, {"v": 2}
    for _ in range(25):
        left, right = {"nested": left}, {"nested": right}
    paths = _bounded_difference_paths(_difference_paths(left, right))
    assert paths == ["native.<inconclusive>"]
    assert sum(len(path.encode("utf-8")) for path in paths) <= 512


def test_context_compare_requires_one_fresh_matching_inventory_identity():
    from dataclasses import replace

    context, spec = _fixture_context()
    assert context.compare_mcp("opencode", "opencode", spec)["status"] == "equal"

    class TrackingCodec:
        called = False

        def encode(self, request):
            self.called = True
            return bundled_codec("opencode").encode(request)

    tracker = TrackingCodec()
    mismatch = replace(
        context,
        inventory=RuntimeInventory(
            (replace(_fixture_identity("opencode"), installation_id="other"),),
            "fixture",
        ),
        mcp_codecs={"opencode": tracker},
    )
    assert mismatch.compare_mcp("opencode", "opencode", spec)["status"] == "unavailable"
    assert tracker.called is False

    for inventory, state in (
        (RuntimeInventory((), "fixture"), "fresh"),
        (RuntimeInventory((_fixture_identity("opencode"), _fixture_identity("opencode")), "fixture"), "fresh"),
        (RuntimeInventory((replace(_fixture_identity("opencode"), installation_id="other"),), "fixture"), "fresh"),
    ):
        unavailable = replace(context, inventory=inventory, inventory_cache_state=state)
        assert unavailable.compare_mcp("opencode", "opencode", spec)["status"] == "unavailable"

    stale = replace(context, inventory_cache_state="stale")
    assert stale.compare_mcp("opencode", "opencode", spec)["status"] == "unavailable"


def test_difference_budget_is_inconclusive_before_large_mapping_union():
    from skill_hub.domain.harnesses.harness_catalog import _difference_paths

    left = {f"key-{index}": index for index in range(1000)}
    right = {f"key-{index}": index + 1 for index in range(1000)}
    assert _difference_paths(left, right) == ["native.<inconclusive>"]


def test_compare_reports_budget_exhaustion_as_unavailable():
    from dataclasses import replace

    context, spec = _fixture_context()

    class WideCodec:
        def encode(self, request):
            return McpNativeResult({f"key-{index}": index for index in range(1000)})

    bounded = replace(context, mcp_codecs={"opencode": WideCodec()})
    assert bounded.compare_mcp("opencode", "opencode", spec) == {
        "status": "unavailable",
        "reason": "difference_budget",
    }


def test_equal_deep_difference_is_inconclusive_at_depth_limit():
    from skill_hub.domain.harnesses.harness_catalog import _difference_paths

    left = right = {"leaf": 1}
    for _ in range(20):
        left = {"nested": left}
        right = {"nested": right}
    assert _difference_paths(left, right) == ["native.<inconclusive>"]


def test_explicit_empty_installed_snapshot_is_not_requested_participants():
    from dataclasses import replace

    context, _ = _fixture_context()
    empty = replace(context, installed_harness_ids=())
    assert empty.harness_ids == ("opencode",)
    assert empty.installed_harness_ids == ()
