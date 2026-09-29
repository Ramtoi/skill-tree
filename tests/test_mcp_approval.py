"""Tests for the Claude Code project approval writer and the Codex trust gate
(plans/C.md §5, cases 14-22).

Cases 14-18, 20-21 drive `mcp_delivery.write_claude_approval` directly (the
unit under test); cases 19 and 22 need the full `hub.cmd_sync` wiring (the
project delivery row + doctor finding), so they use the same registry/sync
helpers as `tests/test_mcp_delivery.py` (duplicated here — this file is meant
to stand alone).
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

import yaml


def _patch_detect_all(monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    patched = {
        h_id: dataclasses.replace(h, detect=(lambda: True))
        for h_id, h in _harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(_harnesses, "HARNESSES", patched)


def _patch_global_targets(monkeypatch, tmp_path):
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    claude_global = tmp_path / "global" / "claude.json"
    codex_global = tmp_path / "global" / "codex-config.toml"
    claude_global.parent.mkdir(parents=True, exist_ok=True)
    patched = {}
    for h_id, h in _harnesses.HARNESSES.items():
        kwargs = {"detect": (lambda: True)}
        if h_id == "claude-code":
            kwargs["global_mcp_config"] = claude_global
        elif h_id == "codex":
            kwargs["global_mcp_config"] = codex_global
        patched[h_id] = dataclasses.replace(h, **kwargs)
    monkeypatch.setattr(_harnesses, "HARNESSES", patched)
    return claude_global, codex_global


def _write_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _project_registry(
    proj_path: Path,
    *,
    harnesses_global: list,
    mcp_cfg: dict,
    project_name: str = "alpha",
    server_name: str = "demo-server",
) -> dict:
    return {
        "version": "1",
        "harnesses_global": harnesses_global,
        "skills": {
            server_name: {
                "version": "1.0.0",
                "description": "",
                "source": None,
                "type": "mcp-server",
                "scope": "project-specific",
                "upstream": None,
                "mcp": mcp_cfg,
            }
        },
        "projects": {
            project_name: {
                "path": str(proj_path),
                "enabled": [server_name],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }


def _sync_report(data_home: Path) -> dict:
    path = data_home / "state" / "sync-report.json"
    assert path.exists(), "sync report was not written"
    return json.loads(path.read_text())


def _run_sync(capsys) -> None:
    import hub

    # A corrupt settings.local.json (case 19) also breaks the HOOKS stream,
    # which targets the same personal project file — `cmd_sync` then
    # `sys.exit`s on the stream error. The sync report is still written (the
    # write happens in `cmd_sync`'s `finally`, unconditionally), so tests only
    # need the report, not a clean exit.
    try:
        hub.cmd_sync(argparse.Namespace())
    except SystemExit:
        pass
    capsys.readouterr()


def _settings_local(proj: Path) -> Path:
    return proj / ".claude" / "settings.local.json"


def _assert_reasons_known(rows) -> None:
    """S-3: a direct check that every row a real sync produced carries a
    reason word inside `mcp_delivery.DELIVERY_REASONS` — not a tautology
    against the constant itself."""
    from skill_hub.infrastructure.mcp import mcp_delivery

    for row in rows:
        if row["reason"] is not None:
            assert row["reason"] in mcp_delivery.DELIVERY_REASONS, row


# ─────────────────────────────────────────────────────────────────────────────
# 14-18, 20-21 — the writer, driven directly
# ─────────────────────────────────────────────────────────────────────────────


def test_approval_written_for_hub_owned_project_servers(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp import mcp_delivery

    proj = tmp_path / "proj"
    proj.mkdir()
    ok, err = mcp_delivery.write_claude_approval(proj, "alpha", {"a", "b"}, "claude-code")
    assert ok is True
    assert err is None
    data = json.loads(_settings_local(proj).read_text())
    assert sorted(data["enabledMcpjsonServers"]) == ["a", "b"]


def test_approval_preserves_user_added_names(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp import mcp_delivery

    proj = tmp_path / "proj"
    _settings_local(proj).parent.mkdir(parents=True)
    _settings_local(proj).write_text(json.dumps({"enabledMcpjsonServers": ["user1"]}))

    ok, err = mcp_delivery.write_claude_approval(proj, "alpha", {"a"}, "claude-code")
    assert ok is True
    data = json.loads(_settings_local(proj).read_text())
    assert sorted(data["enabledMcpjsonServers"]) == ["a", "user1"]


def test_approval_removes_a_name_hub_stopped_delivering(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp import mcp_delivery

    proj = tmp_path / "proj"
    proj.mkdir()
    mcp_delivery.write_claude_approval(proj, "alpha", {"a", "b"}, "claude-code")

    ok, err = mcp_delivery.write_claude_approval(proj, "alpha", {"a"}, "claude-code")
    assert ok is True
    data = json.loads(_settings_local(proj).read_text())
    assert data["enabledMcpjsonServers"] == ["a"]


def test_approval_missing_sidecar_adds_but_never_removes(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp import mcp_delivery

    proj = tmp_path / "proj"
    _settings_local(proj).parent.mkdir(parents=True)
    _settings_local(proj).write_text(json.dumps({"enabledMcpjsonServers": ["mystery"]}))

    # No sidecar has ever been written for this (harness, project) — hub has
    # no ownership knowledge yet. It must ADD but never remove.
    ok, err = mcp_delivery.write_claude_approval(proj, "alpha", {"a"}, "claude-code")
    assert ok is True
    data = json.loads(_settings_local(proj).read_text())
    assert sorted(data["enabledMcpjsonServers"]) == ["a", "mystery"]


def test_approval_preserves_unrelated_settings_keys(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp import mcp_delivery

    proj = tmp_path / "proj"
    _settings_local(proj).parent.mkdir(parents=True)
    seed = {
        "permissions": {"allow": ["Bash(npm:*)"]},
        "hooks": {"PostToolUse": []},
        "env": {"FOO": "bar"},
    }
    _settings_local(proj).write_text(json.dumps(seed, indent=2))

    ok, err = mcp_delivery.write_claude_approval(proj, "alpha", {"a"}, "claude-code")
    assert ok is True
    data = json.loads(_settings_local(proj).read_text())
    assert data["permissions"] == seed["permissions"]
    assert data["hooks"] == seed["hooks"]
    assert data["env"] == seed["env"]
    assert data["enabledMcpjsonServers"] == ["a"]


def test_approval_is_byte_stable_on_resync(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    first = _settings_local(proj).read_bytes()
    _run_sync(capsys)
    second = _settings_local(proj).read_bytes()
    assert first == second


def test_approval_never_written_at_global_scope(tmp_data_home, monkeypatch, capsys):
    _patch_global_targets(monkeypatch, tmp_data_home)
    mcp_src = tmp_data_home / "mcp-servers" / "demo-global"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")
    proj = tmp_data_home / "alpha"
    proj.mkdir()

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "demo-global": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "mcp": {"command": "python3", "args": ["{source}/server.py"], "env": {}},
            }
        },
        "projects": {
            "alpha": {
                "path": str(proj),
                "enabled": [],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    _write_registry(tmp_data_home, registry)

    _run_sync(capsys)
    assert not _settings_local(proj).exists()


# ─────────────────────────────────────────────────────────────────────────────
# 19 — an unparseable settings.local.json aborts and blocks
# ─────────────────────────────────────────────────────────────────────────────


def test_approval_unparseable_file_aborts_and_blocks(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    _settings_local(proj).parent.mkdir(parents=True)
    _settings_local(proj).write_text("{not valid json")
    reg = _project_registry(
        proj,
        harnesses_global=["claude-code"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    _run_sync(capsys)
    assert _settings_local(proj).read_text() == "{not valid json"

    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [r for r in rows if r["server"] == "demo-server" and r["harness"] == "claude-code"]
    assert any(
        r["state"] == "blocked" and r["reason"] == "claude_project_not_approved"
        for r in matches
    )

    from skill_hub.infrastructure.mcp import mcp_delivery

    findings = mcp_delivery.doctor_findings(rep, _read_registry(tmp_data_home), {})
    assert any(f.code == "MCP_PROJECT_SERVER_NOT_APPROVED" for f in findings)


# ─────────────────────────────────────────────────────────────────────────────
# 22 — Codex untrusted project blocks but the writer never grants trust
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_untrusted_project_blocks_but_never_grants_trust(tmp_data_home, monkeypatch, capsys):
    _patch_detect_all(monkeypatch)
    proj = tmp_data_home / "alpha"
    proj.mkdir()
    reg = _project_registry(
        proj,
        harnesses_global=["codex"],
        mcp_cfg={"command": "python3", "args": ["server.py"], "env": {}},
    )
    _write_registry(tmp_data_home, reg)

    from skill_hub.infrastructure.permissions import permission_adapter_codex

    calls = []
    original = permission_adapter_codex.CodexPermissionAdapter.discover_existing

    def _spy(self, scope, harness_id, *args, **kwargs):
        calls.append((scope, harness_id))
        return original(self, scope, harness_id, *args, **kwargs)

    monkeypatch.setattr(
        permission_adapter_codex.CodexPermissionAdapter, "discover_existing", _spy
    )

    _run_sync(capsys)

    assert calls, (
        "codex_project_trust_state must delegate to "
        "CodexPermissionAdapter.discover_existing (m11)"
    )

    rep = _sync_report(tmp_data_home)
    rows = rep["projects"]["alpha"]["mcp_delivery"]
    _assert_reasons_known(rows)
    matches = [r for r in rows if r["server"] == "demo-server" and r["harness"] == "codex"]
    assert any(
        r["state"] == "blocked" and r["reason"] == "codex_untrusted_project"
        for r in matches
    )

    codex_config = Path.home() / ".codex" / "config.toml"
    if codex_config.exists():
        import tomlkit

        data = tomlkit.parse(codex_config.read_text())
        projects = data.get("projects") or {}
        entry = projects.get(str(proj)) if hasattr(projects, "get") else None
        trust = entry.get("trust_level") if entry is not None and hasattr(entry, "get") else None
        assert trust != "trusted"
