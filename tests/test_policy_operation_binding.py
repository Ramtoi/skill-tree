from dataclasses import replace
from pathlib import Path

import pytest

from skill_hub.application.harnesses import harness_operation_context as contexts
from skill_hub.domain.permissions.permissions import GlobalScope


def _context(tmp_data_home, monkeypatch, harness_id="codex"):
    monkeypatch.setattr(contexts, "read_inventory_cache", lambda *args: None)
    return contexts.build_operation_context(tmp_data_home, (harness_id,), requested_features=("permissions", "hooks"))


@pytest.mark.parametrize("feature", ["permissions", "hooks"])
@pytest.mark.parametrize("damage", ["no_layout", "verified", "wrong_key"])
def test_incomplete_or_unbound_route_never_returns_a_legacy_writer(tmp_data_home, monkeypatch, feature, damage):
    from skill_hub.infrastructure.hooks import hook_adapters
    from skill_hub.infrastructure.permissions import permission_adapters

    context = _context(tmp_data_home, monkeypatch)
    if damage == "no_layout":
        context = replace(context, layouts={})
    else:
        route = context.route("codex", feature)
        changes = {"mode": "verified", "status": "verified"} if damage == "verified" else {"adapter_key": "other"}
        context = replace(context, routes={("codex", feature): replace(route, **changes)})
    factory = (
        permission_adapters.select_permission_adapter if feature == "permissions" else hook_adapters.select_hook_adapter
    )
    assert factory(context, "codex").adapter is None


def test_opencode_permission_writer_uses_captured_global_path(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.infrastructure.permissions import permission_adapters

    context = _context(tmp_data_home, monkeypatch, "opencode")
    path = tmp_path / "chosen" / "opencode.json"
    context = replace(
        context,
        layouts={
            "opencode": replace(context.layout("opencode"), permission_global_config=path),
        },
    )
    adapter = permission_adapters.select_permission_adapter(context, "opencode").adapter
    assert adapter is not None
    assert adapter.target_files(GlobalScope(), "opencode") == path


def test_missing_inventory_drops_old_hook_capabilities(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.harnesses import harness_probe

    monkeypatch.setattr(
        harness_probe,
        "load_cached",
        lambda *args: {
            "harnesses": {
                "codex": {"verdict": "supported", "reason": "old", "request_fingerprint": "old"},
            }
        },
    )
    context = _context(tmp_data_home, monkeypatch)
    assert not context.hook_observations
    assert context.route("codex", "hooks").capability is None


def test_permission_dispatch_keeps_supplied_empty_context(tmp_data_home, monkeypatch):
    from types import SimpleNamespace

    from skill_hub.entrypoints.cli import permissions

    context = replace(_context(tmp_data_home, monkeypatch), routes={})
    monkeypatch.setattr(
        contexts, "build_operation_context", lambda *args, **kwargs: pytest.fail("replaced supplied context")
    )
    seen = []
    monkeypatch.setattr(permissions, "cmd_permissions_list", lambda args: seen.append(args._operation_context))
    permissions.dispatch(SimpleNamespace(permissions_cmd="list", _operation_context=context))
    assert seen == [context]


def test_permissions_add_direct_facade_captures_once_and_refuses_unavailable_context(
    tmp_data_home, monkeypatch
):
    from types import SimpleNamespace

    import yaml

    from skill_hub.entrypoints.cli import permissions

    registry_path = tmp_data_home / "registry.yaml"
    registry_path.write_text(
        yaml.safe_dump(
            {"harnesses_global": [], "projects": {}, "skills": {}},
            sort_keys=False,
        )
    )
    context = replace(_context(tmp_data_home, monkeypatch), routes={})
    args = SimpleNamespace(
        global_=True,
        project=None,
        kind="allow",
        pattern="Read",
        harnesses=None,
        personal=False,
        _operation_context=context,
    )
    calls = []
    original = permissions._ensure_operation_context
    monkeypatch.setattr(
        permissions,
        "_ensure_operation_context",
        lambda value: calls.append(value) or original(value),
    )
    before = registry_path.read_bytes()
    with pytest.raises(SystemExit):
        permissions.cmd_permissions_add(args)
    assert calls == [args]
    assert args._operation_context is context
    assert registry_path.read_bytes() == before
    assert not (tmp_data_home / "state" / "audit.jsonl").exists()


def test_permissions_add_direct_facade_captures_missing_context_once(
    tmp_data_home, monkeypatch
):
    from types import SimpleNamespace

    import yaml

    from skill_hub.entrypoints.cli import permissions

    registry_path = tmp_data_home / "registry.yaml"
    registry_path.write_text(
        yaml.safe_dump(
            {"harnesses_global": [], "projects": {}, "skills": {}},
            sort_keys=False,
        )
    )
    unavailable = replace(_context(tmp_data_home, monkeypatch), routes={})
    monkeypatch.setattr(
        contexts,
        "build_operation_context",
        lambda *args, **kwargs: unavailable,
    )
    args = SimpleNamespace(
        global_=True,
        project=None,
        kind="allow",
        pattern="Read",
        harnesses=None,
        personal=False,
    )
    calls = []
    original = permissions._ensure_operation_context
    monkeypatch.setattr(
        permissions,
        "_ensure_operation_context",
        lambda value: calls.append(value) or original(value),
    )
    before = registry_path.read_bytes()
    with pytest.raises(SystemExit):
        permissions.cmd_permissions_add(args)
    assert calls == [args]
    assert args._operation_context is unavailable
    assert registry_path.read_bytes() == before
    assert not (tmp_data_home / "state" / "audit.jsonl").exists()


def test_permission_validation_uses_codex_route_and_rejects_codex_only_aggregate(
    tmp_data_home, monkeypatch
):
    from skill_hub.domain.permissions.permissions import Rule
    from skill_hub.infrastructure.permissions import permission_adapters

    context = _context(tmp_data_home, monkeypatch, "codex")
    unsupported = permission_adapters.validate_rule_for_harness(
        Rule(pattern="Read", kind="allow"),
        "codex",
        operation_context=context,
    )
    unbounded = permission_adapters.validate_rule_for_harness(
        Rule(pattern="Bash(*)", kind="allow"),
        "codex",
        operation_context=context,
    )
    bounded = permission_adapters.validate_rule_for_harness(
        Rule(pattern="Bash(git status:*)", kind="allow"),
        "codex",
        operation_context=context,
    )
    aggregate = permission_adapters.validate_rule_across_adapters(
        Rule(pattern="Read", kind="allow"), operation_context=context
    )
    assert unsupported.ok is False
    assert unbounded.ok is False
    assert bounded.ok is True
    assert aggregate.ok is False


def test_permission_aggregate_rejects_a_mismatched_captured_route(tmp_data_home, monkeypatch):
    from dataclasses import replace

    from skill_hub.domain.permissions.permissions import Rule
    from skill_hub.infrastructure.permissions import permission_adapters

    context = _context(tmp_data_home, monkeypatch, "claude-code")
    route = context.route("claude-code", "permissions")
    context = replace(
        context,
        routes={
            ("claude-code", "permissions"): replace(route, adapter_key="wrong")
        },
    )
    result = permission_adapters.validate_rule_across_adapters(
        Rule(pattern="Bash(npm:*)", kind="allow"), operation_context=context
    )
    assert result.ok is False
    assert result.error == "permission route unavailable"


def test_hook_refresh_uses_captured_config_root(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.application.harnesses.harness_layout_context import capture_layouts
    from skill_hub.application.harnesses.harness_runtime import RuntimeInventory
    from skill_hub.domain.harnesses.harness_adapter_api import RuntimeIdentity, Version
    from skill_hub.infrastructure.harnesses import harness_probe

    captured = tmp_path / "captured-codex"
    layouts = capture_layouts(("codex",), home_overrides={"codex": captured})
    inventory = RuntimeInventory(
        (
            RuntimeIdentity(
                harness_id="codex",
                installation_id="one",
                version=Version(1, 0, 0),
                executable_path=str(tmp_path / "fixture"),
            ),
        ),
        "fingerprint",
        observed_at="2026-09-16T00:00:00+00:00",
    )
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "changed-home"))
    calls = []
    monkeypatch.setattr(
        harness_probe,
        "probe_harness",
        lambda harness_id, **kwargs: (
            calls.append(kwargs) or harness_probe.HookCapability(harness_id, harness_probe.SUPPORTED, "fixture")
        ),
    )
    harness_probe.refresh_operation_capabilities(
        {"codex"}, data_home=tmp_data_home, inventory=inventory, layouts=layouts
    )
    assert calls[0]["codex_home"] == captured
    assert Path(calls[0]["codex_binary"]) == tmp_path / "fixture"


def test_capability_cache_is_read_once_for_both_features(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.harnesses import harness_probe

    reads = []
    monkeypatch.setattr(harness_probe, "load_cached", lambda *args: reads.append(args) or {})
    monkeypatch.setattr(contexts, "read_inventory_cache", lambda *args: None)
    contexts.build_operation_context(
        tmp_data_home, ("codex",), requested_features=("invocation", "hooks")
    )
    assert len(reads) == 1


def test_hook_observation_from_previous_inventory_refresh_is_discarded(tmp_data_home, monkeypatch):
    from skill_hub.application.harnesses.harness_runtime import RuntimeInventory
    from skill_hub.domain.harnesses.harness_adapter_api import RuntimeIdentity, Version
    from skill_hub.infrastructure.harnesses import harness_probe

    inventory = RuntimeInventory(
        (RuntimeIdentity("codex", "one", version=Version(1, 0, 0)),),
        "unchanged-request",
        observed_at="2026-09-16T10:00:00+00:00",
    )
    monkeypatch.setattr(contexts, "read_inventory_cache", lambda *args: inventory)
    monkeypatch.setattr(harness_probe, "load_cached", lambda *args: {
        "harnesses": {"codex": {
            "request_fingerprint": inventory.request_fingerprint,
            "installation_id": "one", "runtime_version": "1.0.0",
            "observed_at": "2026-09-16T09:00:01+00:00",
            "inventory_observed_at": "2026-09-16T09:00:00+00:00",
            "verdict": "supported",
        }},
    })
    context = contexts.build_operation_context(tmp_data_home, ("codex",), requested_features=("hooks",))
    assert not context.hook_observations


def test_codex_requirements_read_uses_captured_config_root(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.domain.permissions.permissions import ProjectScope
    from skill_hub.infrastructure.permissions import permission_adapters

    context = _context(tmp_data_home, monkeypatch)
    root = tmp_path / "captured-codex"
    root.mkdir()
    (root / "requirements.toml").write_text('allowed_permission_profiles = ["managed"]\n')
    context = replace(context, layouts={"codex": replace(
        context.layout("codex"), config_dir=root, permission_global_config=root / "config.toml",
    )})
    adapter = permission_adapters.select_permission_adapter(context, "codex").adapter
    seen = []
    monkeypatch.setattr(adapter, "_directory_context", lambda project, user, managed: (
        seen.append(managed) or ("legacy", None)
    ))
    adapter.plan_directories(ProjectScope("fixture", str(tmp_path / "project")), [], "codex")
    assert seen == [{"allowed_permission_profiles": ["managed"]}]
