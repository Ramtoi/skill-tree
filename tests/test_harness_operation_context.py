from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from skill_hub.application.harnesses import harness_operation_context as context_module
from skill_hub.application.harnesses.harness_runtime import RuntimeInventory
from skill_hub.domain.harnesses.harness_adapter_api import (
    SDK_VERSION,
    AdapterManifest,
    HarnessVariant,
    RuntimeIdentity,
    Version,
    VersionConstraint,
)
from skill_hub.domain.harnesses.harness_catalog import build_catalog_snapshot, manifest_content_digest
from skill_hub.domain.permissions.permissions import GlobalScope


def _inventory() -> RuntimeInventory:
    identity = RuntimeIdentity(
        harness_id="opencode",
        installation_id="fixture",
        raw_version="1.18.31",
        version=Version(1, 18, 31),
        os_name="darwin",
        architecture="arm64",
        evidence="fixture",
    )
    return RuntimeInventory((identity,), "fixture-fingerprint", observed_at="2026-09-16T00:00:00+00:00")


def test_context_reads_cache_once_and_serializes_fixed_snapshot(tmp_path, monkeypatch) -> None:
    calls: list[tuple[Path, object]] = []
    inventory = _inventory()

    def read_once(path, request, *fallback_requests):
        calls.append((path, request))
        return inventory

    monkeypatch.setattr(context_module, "read_inventory_cache", read_once)
    context = context_module.build_mcp_operation_context(tmp_path, ("opencode",))

    assert len(calls) == 1
    assert context.inventory is inventory
    assert context.inventory_cache_state == "fresh"
    payload = context_module.serialize_operation_context(context)
    assert payload["request_fingerprint"] == "fixture-fingerprint"
    assert payload["observed_at"] == inventory.observed_at
    assert payload["mode"] == "shadow"
    assert payload["enforced"] is False
    assert context.row_metadata("opencode")["operation_context_id"] == context.context_id

    later = RuntimeInventory((), "later")
    assert context.inventory is inventory
    assert context.inventory is not later


def test_missing_and_stale_cache_are_explicitly_unavailable(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(context_module, "read_inventory_cache", lambda *args: None)
    missing = context_module.build_mcp_operation_context(tmp_path, ("opencode",))
    assert missing.inventory_cache_state == "missing"
    assert missing.decision("opencode").reason == "missing_installation"

    cache_path = context_module.runtime_inventory_cache_path(tmp_path)
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text("{}")
    stale = context_module.build_mcp_operation_context(tmp_path, ("opencode",))
    assert stale.inventory_cache_state == "stale"
    assert stale.decision("opencode").reason == "missing_installation"


def test_subset_resolution_reads_full_cli_cache_request(tmp_path, monkeypatch) -> None:
    captured: list[object] = []
    monkeypatch.setattr(
        context_module,
        "read_inventory_cache",
        lambda path, inventory_request, *fallback_requests: captured.append(inventory_request) or _inventory(),
    )

    context = context_module.build_mcp_operation_context(tmp_path, ("opencode",))

    assert context.harness_ids == ("opencode",)
    assert captured[0].harnesses == ("claude-code", "codex", "opencode", "pi")


def test_subset_cache_is_one_read_fallback_without_probe(tmp_path, monkeypatch) -> None:
    calls: list[tuple[object, tuple[object, ...]]] = []

    def read_cache(path, request, fallback_requests=()):
        calls.append((request, fallback_requests))
        return _inventory()

    monkeypatch.setattr(context_module, "read_inventory_cache", read_cache)
    subset = context_module.host_inventory_request(("codex",))
    context_module.build_mcp_operation_context(
        tmp_path, ("codex",), request=subset
    )

    assert len(calls) == 1
    assert calls[0][0].harnesses == ("claude-code", "codex", "opencode", "pi")
    assert calls[0][1][0].harnesses == ("codex",)


def test_shared_request_uses_absolute_home_derived_roots(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.delenv("SKILL_HUB_CLAUDE_HOME", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    request = context_module.host_inventory_request(("claude-code", "codex"))

    assert request.home_overrides["claude-code"] == str(tmp_path / ".claude")
    assert request.home_overrides["codex"] == str(tmp_path / ".codex")
    assert request.marker_dirs["claude-code"] == (str(tmp_path / ".claude" / "projects"),)
    assert request.config_paths["codex"] == (str(tmp_path / ".codex" / "config.toml"),)


def test_targeted_cli_refresh_is_reused_without_probing(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.harnesses import harness_runtime

    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(context_module, "KNOWN_FALLBACK_DIRS", ())
    original_inventory = harness_runtime.inventory
    calls = []

    def isolated_inventory(request):
        calls.append(request.harnesses)
        return original_inventory(request, runner=lambda *args: (_ for _ in ()).throw(AssertionError("probe")))

    monkeypatch.setattr(harness_runtime, "inventory", isolated_inventory)
    monkeypatch.setattr("sys.argv", ["hub", "integration", "inventory", "--refresh", "--harness", "codex", "--json"])
    hub.main()
    capsys.readouterr()
    assert calls == [("codex",)]
    context = context_module.build_mcp_operation_context(tmp_data_home, ("codex",))
    assert context.inventory_cache_state == "fresh"
    assert calls == [("codex",)]


def test_selection_context_collects_inventory_once_and_derives_invocation(tmp_path, monkeypatch) -> None:
    from skill_hub.application.harnesses import harness_runtime
    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION
    from skill_hub.infrastructure.harnesses import harness_probe

    inventory = _inventory()
    collection_calls = []
    writes = []
    derived = {
        "opencode": {
            "profile": "opencode-v1.18.31",
            "request_fingerprint": inventory.request_fingerprint,
            "installation_id": "fixture",
            "runtime_version": "1.18.31",
            "reason_code": None,
            "reason": "derived from one inventory identity",
        }
    }
    monkeypatch.setattr(context_module, "read_inventory_cache", lambda *args: None)
    monkeypatch.setattr(
        harness_runtime,
        "inventory",
        lambda request: collection_calls.append(request) or inventory,
    )
    monkeypatch.setattr(
        harness_runtime,
        "write_inventory_cache",
        lambda value, path: writes.append((value, path)),
    )
    monkeypatch.setattr(harness_probe, "cached_invocations", lambda data_home=None: {})
    refresh_calls = []

    def derive(installed, data_home=None, inventory=None):
        refresh_calls.append((installed, inventory))
        return derived

    monkeypatch.setattr(harness_probe, "refresh_invocations", derive)
    context = context_module.build_operation_context(
        tmp_path,
        ("opencode",),
        requested_features=("invocation",),
        host_version=Version(1, 0, 0),
        sdk_version=SDK_VERSION,
        needs_selection=True,
    )

    assert len(collection_calls) == 1
    assert writes == [(inventory, context_module.runtime_inventory_cache_path(tmp_path))]
    assert refresh_calls == [({"opencode"}, inventory)]
    assert context.invocation_profile("opencode") == "opencode-v1.18.31"
    assert context.decision("opencode", "invocation").supported
    assert context.trusted_invocation_profile("opencode") == "opencode-v1.18.31"
    stale = replace(context, inventory_cache_state="stale")
    assert stale.trusted_invocation_profile("opencode") is None
    assert stale.trusted_invocation_resolver("opencode") is None


def test_invocation_observation_reuses_identity_version_without_a_second_probe(monkeypatch) -> None:
    from skill_hub.infrastructure.harnesses import harness_probe

    monkeypatch.setattr(
        harness_probe.subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("duplicate version probe")),
    )
    observations = harness_probe.invocation_observations(_inventory(), {"opencode"})
    assert observations["opencode"]["profile"] == "opencode-v1.18.31"
    assert observations["opencode"]["version"] == "1.18.31"


def test_bundled_invocation_catalog_pins_exact_profile() -> None:
    from skill_hub.domain.harnesses.harness_catalog import bundled_catalog

    variant = bundled_catalog().manifests[0].variants[0]
    assert variant.profile == "opencode-v1.18.31"
    assert variant.features["invocation"] == "verified"


def test_catalog_profile_substitution_cannot_authorize_bundled_invocation(
    tmp_path, monkeypatch
) -> None:
    from skill_hub.application.harnesses import harness_runtime
    from skill_hub.infrastructure.harnesses import harness_probe

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
                validation_evidence={"invocation": "fixture"},
                profile="future-opencode",
            ),
        ),
    )
    manifest = AdapterManifest(
        package_id=manifest.package_id,
        release_version=manifest.release_version,
        digest=manifest_content_digest(manifest),
        variants=manifest.variants,
    )
    catalog = build_catalog_snapshot((manifest,))
    inventory = _inventory()
    monkeypatch.setattr(context_module, "read_inventory_cache", lambda *args: None)
    monkeypatch.setattr(harness_runtime, "inventory", lambda request: inventory)
    monkeypatch.setattr(harness_runtime, "write_inventory_cache", lambda *args: None)
    monkeypatch.setattr(harness_probe, "cached_invocations", lambda *args: {})
    monkeypatch.setattr(
        harness_probe,
        "refresh_invocations",
        lambda installed, **kwargs: {
            "opencode": {
                "profile": "future-opencode",
                "request_fingerprint": inventory.request_fingerprint,
                "installation_id": "fixture",
                "runtime_version": "1.18.31",
            }
        },
    )

    context = context_module.build_operation_context(
        tmp_path,
        ("opencode",),
        requested_features=("invocation",),
        catalog=catalog,
        host_version=Version(1, 0, 0),
        sdk_version=SDK_VERSION,
        needs_selection=True,
    )

    assert context.decision("opencode", "invocation").supported
    assert context.trusted_invocation_profile("opencode") is None
    assert context.trusted_invocation_resolver("opencode") is None


def test_supplied_empty_context_does_not_reread_mutable_invocation_cache(monkeypatch) -> None:
    from skill_hub.application.skills import skill_variants

    monkeypatch.setattr(
        skill_variants,
        "_cached_invocation_profiles",
        lambda: (_ for _ in ()).throw(AssertionError("cache reread")),
    )
    assert skill_variants._profile_for("opencode", {}) == "unknown"


def test_operation_context_freezes_nested_invocation_observations() -> None:
    from skill_hub.application.harnesses.harness_operation_context import OperationAdapterContext
    from skill_hub.domain.harnesses.harness_catalog import bundled_catalog

    observations = {"opencode": {"profile": "unknown", "details": {"version": "1.18.31"}}}
    context = OperationAdapterContext(
        context_id="nested-freeze",
        data_home="/tmp/fixture-hub",
        harness_ids=("opencode",),
        catalog=bundled_catalog(),
        inventory=RuntimeInventory((), "fixture"),
        inventory_cache_state="fresh",
        invocation_observations=observations,
    )

    observations["opencode"]["details"]["version"] = "changed"
    assert context.invocation_observations["opencode"]["details"]["version"] == "1.18.31"
    with pytest.raises(TypeError):
        context.invocation_observations["opencode"]["details"]["version"] = "changed"


def test_operation_context_captures_layout_and_feature_local_shadow_routes(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(context_module, "read_inventory_cache", lambda *args: None)
    context = context_module.build_operation_context(
        tmp_path,
        ("claude-code", "opencode"),
        requested_features=("permissions", "hooks"),
        installed_harness_ids=("claude-code",),
    )

    assert context.layout("claude-code") is not None
    permission_route = context.route("claude-code", "permissions")
    hook_route = context.route("claude-code", "hooks")
    assert permission_route.mode == "legacy_shadow"
    assert permission_route.status == "shadow"
    assert permission_route.enforced is False
    assert hook_route.mode == "legacy_shadow"
    assert context.route("missing", "hooks").status == "unavailable"


def test_route_factory_uses_captured_permission_paths_after_environment_changes(tmp_path, monkeypatch) -> None:
    from skill_hub.infrastructure.permissions import permission_adapters

    home = tmp_path / "captured-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(home / ".claude"))
    monkeypatch.setattr(context_module, "read_inventory_cache", lambda *args: None)
    context = context_module.build_operation_context(
        tmp_path / "data",
        ("claude-code",),
        requested_features=("permissions",),
    )
    monkeypatch.setenv("HOME", str(tmp_path / "later-home"))
    adapter = permission_adapters.select_permission_adapter(context, "claude-code").adapter
    assert adapter is not None
    assert adapter.target_files(GlobalScope(), "claude-code") == home / ".claude" / "settings.json"


def test_route_factory_uses_captured_hook_paths_after_environment_changes(
    tmp_path, monkeypatch
) -> None:
    from skill_hub.infrastructure.hooks import hook_adapters

    home = tmp_path / "captured-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(home / ".claude"))
    monkeypatch.setattr(context_module, "read_inventory_cache", lambda *args: None)
    context = context_module.build_operation_context(
        tmp_path / "data",
        ("claude-code",),
        requested_features=("hooks",),
    )
    monkeypatch.setenv("HOME", str(tmp_path / "later-home"))
    adapter = hook_adapters.select_hook_adapter(context, "claude-code").adapter
    assert adapter is not None
    assert adapter._target(GlobalScope(), "claude-code") == home / ".claude" / "settings.json"


def test_empty_supplied_context_cannot_select_or_write_native_adapters() -> None:
    from skill_hub.domain.harnesses.harness_adapter_api import OperationResolution
    from skill_hub.domain.harnesses.harness_catalog import bundled_catalog
    from skill_hub.infrastructure.permissions.permission_adapters import select_permission_adapter

    context = context_module.OperationAdapterContext(
        context_id="empty",
        data_home="fixture-hub",
        harness_ids=("claude-code",),
        catalog=bundled_catalog(),
        inventory=RuntimeInventory((), ""),
        inventory_cache_state="missing",
        resolutions={"claude-code": OperationResolution("empty", ())},
    )
    selection = select_permission_adapter(context, "claude-code")
    assert selection.adapter is None
    assert selection.route.status == "unavailable"


def test_operation_capability_refresh_binds_probe_to_inventory_identity(tmp_path, monkeypatch) -> None:
    from skill_hub.infrastructure.harnesses import harness_probe

    calls = []

    def probe(harness_id, **kwargs):
        calls.append((harness_id, kwargs.get("codex_binary")))
        return harness_probe.HookCapability(harness_id, harness_probe.SUPPORTED, "fixture")

    monkeypatch.setattr(harness_probe, "probe_harness", probe)
    result = harness_probe.refresh_operation_capabilities(
        {"opencode"}, data_home=tmp_path, inventory=_inventory()
    )
    assert calls == [("opencode", None)]
    assert result["harnesses"]["opencode"]["verdict"] == harness_probe.SUPPORTED


def test_selection_context_collects_inventory_and_hook_capability_once(tmp_path, monkeypatch) -> None:
    from skill_hub.application.harnesses import harness_runtime
    from skill_hub.infrastructure.harnesses import harness_probe

    inventory = _inventory()
    collection_calls = []
    refresh_calls = []
    monkeypatch.setattr(context_module, "read_inventory_cache", lambda *args: None)
    monkeypatch.setattr(
        harness_runtime,
        "inventory",
        lambda request: collection_calls.append(request) or inventory,
    )
    monkeypatch.setattr(harness_runtime, "write_inventory_cache", lambda *args: None)
    monkeypatch.setattr(harness_probe, "load_cached", lambda *args: {})

    def refresh(installed, *, data_home=None, inventory=None, layouts=None):
        refresh_calls.append((set(installed), inventory))
        return {
            "invocation": harness_probe.invocation_observations(inventory, installed),
            "harnesses": {
                "opencode": {
                    "verdict": harness_probe.SUPPORTED,
                    "reason": "fixture",
                    "extra": {},
                    "request_fingerprint": inventory.request_fingerprint,
                    "observed_at": inventory.observed_at,
                    "inventory_observed_at": inventory.observed_at,
                    "installation_id": "fixture",
                    "runtime_version": "1.18.31",
                }
            },
        }

    monkeypatch.setattr(harness_probe, "refresh_operation_capabilities", refresh)
    context = context_module.build_operation_context(
        tmp_path,
        ("opencode",),
        requested_features=("invocation", "hooks"),
        needs_selection=True,
    )
    assert len(collection_calls) == 1
    assert len(refresh_calls) == 1
    assert refresh_calls[0][1] is inventory
    assert context.hook_observations["opencode"]["verdict"] == harness_probe.SUPPORTED


def test_subset_sync_cache_is_reusable_by_all_harness_reads(tmp_data_home, monkeypatch):
    from skill_hub.application.harnesses import harness_runtime
    from skill_hub.infrastructure.harnesses import harness_probe

    calls = []
    capability_cache = {}
    monkeypatch.setattr(harness_runtime, "_candidate_fingerprints", lambda request: set())
    monkeypatch.setattr(harness_probe, "load_cached", lambda *a: capability_cache)

    def collect(request):
        calls.append(request)
        identity = RuntimeIdentity(
            harness_id="codex", installation_id="fixture-codex", raw_version="1.0.0",
            version=Version(1, 0, 0), evidence="fixture",
            config_fingerprint=harness_runtime._config_fingerprint(request, "codex"),
        )
        return RuntimeInventory((identity,), harness_runtime._request_fingerprint(request))

    def derive(selected, *, data_home, inventory):
        assert selected == {"codex"}
        observation = {"profile": "codex-policy", "installation_id": "fixture-codex",
                       "runtime_version": "1.0.0", "request_fingerprint": inventory.request_fingerprint}
        capability_cache["invocation"] = {"codex": observation}
        return capability_cache["invocation"]

    monkeypatch.setattr(harness_runtime, "inventory", collect)
    monkeypatch.setattr(harness_probe, "refresh_invocations", derive)
    written = context_module.build_operation_context(
        tmp_data_home, ("codex",), requested_features=("invocation",), needs_selection=True)
    read = context_module.build_operation_context(
        tmp_data_home, context_module.KNOWN_HARNESSES, requested_features=("invocation",))
    assert len(calls) == 1
    assert calls[0].harnesses == context_module.KNOWN_HARNESSES
    assert written.harness_ids == ("codex",)
    assert read.inventory_cache_state == "fresh"
    assert read.invocation_profile("codex") == "codex-policy"
    assert read.inventory.request_fingerprint == written.inventory.request_fingerprint
