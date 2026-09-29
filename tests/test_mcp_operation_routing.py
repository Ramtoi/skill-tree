from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

from skill_hub.application.harnesses.harness_operation_context import AdapterRoute, OperationAdapterContext
from skill_hub.application.harnesses.harness_runtime import RuntimeInventory
from skill_hub.domain.harnesses.harness_catalog import bundled_catalog


def _context(tmp_data_home: Path, home: Path, harness_ids: tuple[str, ...]):
    from skill_hub.application.harnesses.harness_layout_context import capture_layouts

    layouts = capture_layouts(harness_ids, home=home)
    context = OperationAdapterContext(
        context_id="routing-test",
        data_home=str(tmp_data_home),
        harness_ids=harness_ids,
        installed_harness_ids=harness_ids,
        catalog=bundled_catalog(),
        inventory=RuntimeInventory((), "routing-test"),
        inventory_cache_state="fresh",
        layouts=layouts,
    )
    routes = {
        (harness_id, "mcp"): AdapterRoute(
            harness_id=harness_id,
            feature="mcp",
            adapter_key=layouts[harness_id].mcp_adapter_key,
        )
        for harness_id in harness_ids
    }
    object.__setattr__(context, "routes", MappingProxyType(routes))
    return context


def test_empty_supplied_context_preserves_native_file_and_sidecars(
    tmp_path, tmp_data_home
) -> None:
    from skill_hub.application.sync import mcp_sync

    project = tmp_path / "project"
    project.mkdir()
    native = project / ".mcp.json"
    native.write_bytes(b'{"mcpServers":{"foreign":{"command":"keep"}}}\n')

    context = _context(tmp_data_home, tmp_path, ())
    registry = {
        "skills": {
            "server": {
                "type": "mcp-server",
                "scope": "portable",
                "mcp": {"command": "node"},
            }
        },
        "projects": {"demo": {"path": str(project), "harnesses": ["claude-code"]}},
        "harnesses_global": ["claude-code"],
    }

    mcp_sync.sync_mcp_for_project(
        project,
        ["server"],
        registry,
        project_name="demo",
        operation_context=context,
    )

    assert native.read_bytes() == b'{"mcpServers":{"foreign":{"command":"keep"}}}\n'
    assert not list(tmp_data_home.rglob("global-mcp.managed.json"))


def test_global_sync_uses_captured_target_after_declaration_changes(
    tmp_path, tmp_data_home, monkeypatch
) -> None:
    from skill_hub.application.sync import mcp_sync
    from skill_hub.infrastructure.harnesses import harnesses

    declaration = harnesses.HARNESSES["claude-code"]
    captured_target = tmp_path / "captured-claude.json"
    monkeypatch.setitem(
        harnesses.HARNESSES,
        "claude-code",
        replace(declaration, global_mcp_config=captured_target),
    )
    context = _context(tmp_data_home, tmp_path, ("claude-code",))
    captured = context.layout("claude-code")
    assert captured is not None and captured.global_mcp_config is not None

    changed = tmp_path / "changed-claude.json"
    monkeypatch.setitem(
        harnesses.HARNESSES,
        "claude-code",
        replace(declaration, global_mcp_config=changed),
    )
    registry = {
        "skills": {
            "server": {
                "type": "mcp-server",
                "scope": "global",
                "mcp": {"command": "node"},
            }
        },
        "projects": {},
        "harnesses_global": [],
    }
    report = {"global": {"mcp": {"writes": 0, "removed": 0, "delivery": []}}}

    mcp_sync._run_global_mcp_dispatch(
        registry,
        {"claude-code"},
        report=report,
        operation_context=context,
    )

    assert captured.global_mcp_config.exists()
    assert not changed.exists()


def test_global_claim_and_rollback_path_use_context_state_home(tmp_path, tmp_data_home, monkeypatch):
    from types import SimpleNamespace

    from skill_hub.entrypoints.cli import mcp
    from skill_hub.infrastructure.mcp import mcp_reconcile

    context = _context(tmp_path / "captured-hub", tmp_path, ("claude-code",))
    context = replace(context, layouts={"claude-code": replace(
        context.layout("claude-code"), global_mcp_config=tmp_path / "native.json"
    )})
    entry = SimpleNamespace(harness="claude-code")
    monkeypatch.setattr(mcp, "data_home", lambda: tmp_path / "wrong-hub")
    path = mcp._claim_sidecar_path_for(entry, "global", None, None, context)
    claimed = mcp._claim_one_native_entry("fixture-server", entry, "global", None, None, context)
    assert path == claimed == tmp_path / "captured-hub/state/claude-code/global-mcp.managed.json"
    assert mcp_reconcile.managed_names("global", operation_context=context) == {"fixture-server"}
    assert not (tmp_path / "wrong-hub").exists()


def test_mcp_show_reuses_supplied_context_without_detection(tmp_path, tmp_data_home, monkeypatch, capsys):
    import json
    from types import SimpleNamespace

    from skill_hub import hub_core
    from skill_hub.entrypoints.cli import mcp
    from skill_hub.infrastructure.harnesses import harnesses

    context = _context(tmp_data_home, tmp_path, ("claude-code",))
    monkeypatch.setattr(harnesses, "detect_installed", lambda: (_ for _ in ()).throw(AssertionError("redetected")))
    monkeypatch.setattr(hub_core, "load_registry", lambda: {"skills": {
        "fixture-server": {"type": "mcp-server", "scope": "global", "mcp": {"command": "node"}},
    }})
    mcp.cmd_mcp_show(SimpleNamespace(name="fixture-server", json=True, _operation_context=context))
    assert json.loads(capsys.readouterr().out)["ok"] is True
