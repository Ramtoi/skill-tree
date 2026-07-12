"""Tests for the MCP adapter abstraction + dispatch (tasks 4.6–4.13)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest
import yaml


# ─────────────────────────────────────────────────────────────────────────────
# 4.6 — ClaudeMcpAdapter round-trip parity
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_adapter_writes_mcp_json_with_expected_shape(tmp_path):
    from mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    adapter = ClaudeMcpAdapter()
    proj = tmp_path / "proj"
    proj.mkdir()
    specs = [
        McpServerSpec(name="code-reviewer", command="python3", args=["/x/server.py"], env={}),
    ]
    adapter.write(proj, specs)

    data = json.loads((proj / ".mcp.json").read_text())
    assert data["mcpServers"]["code-reviewer"] == {
        "command": "python3",
        "args": ["/x/server.py"],
        "env": {},
    }


def test_claude_adapter_preserves_user_managed_servers(tmp_path):
    """Unrelated entries already in .mcp.json must survive a hub write."""
    from mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    adapter = ClaudeMcpAdapter()
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "user-server": {"command": "node", "args": [], "env": {}}
                }
            }
        )
    )
    adapter.write(proj, [McpServerSpec(name="hub-server", command="python3")])

    data = json.loads((proj / ".mcp.json").read_text())
    assert "user-server" in data["mcpServers"]
    assert "hub-server" in data["mcpServers"]


def test_claude_adapter_remove_drops_named_entries_and_deletes_when_empty(tmp_path):
    from mcp_adapters import ClaudeMcpAdapter

    adapter = ClaudeMcpAdapter()
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"a": {"command": "x", "args": [], "env": {}}}})
    )
    adapter.remove(proj, {"a"})
    assert not (proj / ".mcp.json").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 4.7 — CodexMcpAdapter writes TOML; unrelated content preserved
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_adapter_writes_mcp_servers_table(tmp_path):
    import tomlkit

    from mcp_adapters import CodexMcpAdapter, McpServerSpec

    adapter = CodexMcpAdapter()
    proj = tmp_path / "proj"
    proj.mkdir()
    adapter.write(proj, [McpServerSpec(name="grep-tool", command="python3", args=["/y.py"])])

    text = (proj / ".codex" / "config.toml").read_text()
    parsed = tomlkit.parse(text)
    assert parsed["mcp_servers"]["grep-tool"]["command"] == "python3"
    assert list(parsed["mcp_servers"]["grep-tool"]["args"]) == ["/y.py"]


def test_codex_adapter_preserves_unrelated_toml_content(tmp_path):
    import tomlkit

    from mcp_adapters import CodexMcpAdapter, McpServerSpec

    adapter = CodexMcpAdapter()
    proj = tmp_path / "proj"
    cfg_dir = proj / ".codex"
    cfg_dir.mkdir(parents=True)
    initial = (
        'model = "gpt-5.4"\n'
        "\n"
        '[projects."/path/to/proj"]\n'
        'trust_level = "trusted"\n'
        "\n"
        "[plugins.my_plugin]\n"
        "enabled = true\n"
    )
    (cfg_dir / "config.toml").write_text(initial)

    adapter.write(proj, [McpServerSpec(name="grep-tool", command="python3")])

    parsed = tomlkit.parse((cfg_dir / "config.toml").read_text())
    assert str(parsed["model"]) == "gpt-5.4"
    assert str(parsed["projects"]["/path/to/proj"]["trust_level"]) == "trusted"
    assert bool(parsed["plugins"]["my_plugin"]["enabled"]) is True
    assert "grep-tool" in parsed["mcp_servers"]


# ─────────────────────────────────────────────────────────────────────────────
# 4.8 — Removing all MCP servers removes only [mcp_servers.*]
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_adapter_remove_keeps_file_with_unrelated_content(tmp_path):
    import tomlkit

    from mcp_adapters import CodexMcpAdapter, McpServerSpec

    adapter = CodexMcpAdapter()
    proj = tmp_path / "proj"
    proj.mkdir()
    cfg_dir = proj / ".codex"
    cfg_dir.mkdir()
    (cfg_dir / "config.toml").write_text(
        'model = "gpt-5.4"\n\n[mcp_servers.x]\ncommand = "y"\nargs = []\nenv = {}\n'
    )

    adapter.remove(proj, {"x"})
    text = (cfg_dir / "config.toml").read_text()
    parsed = tomlkit.parse(text)
    assert str(parsed["model"]) == "gpt-5.4"
    assert "x" not in (parsed.get("mcp_servers") or {})


# ─────────────────────────────────────────────────────────────────────────────
# 4.9/4.10/4.11/4.12/4.13 — Dispatch through sync_mcp_for_project
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def mcp_dispatch_env(tmp_data_home, monkeypatch):
    """Project with one MCP-server skill enabled; all harnesses installed."""
    import dataclasses

    import harnesses
    import hub

    mcp_src = tmp_data_home / "mcp-servers" / "code-reviewer"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")

    proj = tmp_data_home / "projects" / "alpha"
    proj.mkdir(parents=True)

    registry = {
        "version": "1",
        "harnesses_global": [],
        "skills": {
            "code-reviewer": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                # project-specific so the per-project MCP pass owns it; scope:global
                # mcp-servers are dispatched only by the global-MCP pass.
                "scope": "project-specific",
                "upstream": None,
                "mcp": {
                    "runtime": "python",
                    "command": "python3",
                    "args": ["{source}/server.py"],
                    "env": {},
                },
            }
        },
        "projects": {
            "alpha": {
                "path": str(proj),
                "enabled": ["code-reviewer"],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    # All harnesses look installed
    patched = {
        h_id: dataclasses.replace(h, detect=(lambda: True))
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    return tmp_data_home, proj


def _set_harnesses(data_home: Path, project: list[str], global_: list[str]):
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    reg["projects"]["alpha"]["harnesses"] = project
    reg["harnesses_global"] = global_
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


def test_dispatch_claude_plus_pi_writes_mcp_json_once_no_pi_file(mcp_dispatch_env, capsys):
    """effective = {claude-code, pi} → one .mcp.json; never .pi/mcp.json."""
    import hub

    data_home, proj = mcp_dispatch_env
    _set_harnesses(data_home, ["pi"], ["claude-code"])

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (proj / ".mcp.json").exists()
    assert not (proj / ".pi" / "mcp.json").exists()


def test_dispatch_pi_only_still_writes_mcp_json(mcp_dispatch_env, capsys):
    """Pi reads .mcp.json as its primary MCP config; alone, it still gets written."""
    import hub

    data_home, proj = mcp_dispatch_env
    _set_harnesses(data_home, ["pi"], [])

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (proj / ".mcp.json").exists()
    data = json.loads((proj / ".mcp.json").read_text())
    assert "code-reviewer" in data["mcpServers"]


def test_dispatch_never_touches_pi_mcp_json(mcp_dispatch_env, capsys):
    """If user pre-creates .pi/mcp.json, sync must NOT modify it."""
    import hub

    data_home, proj = mcp_dispatch_env
    (proj / ".pi").mkdir(parents=True)
    pi_override = proj / ".pi" / "mcp.json"
    original_text = '{"mcpServers": {"user": {"command": "node"}}}'
    pi_override.write_text(original_text)

    _set_harnesses(data_home, ["pi"], [])
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert pi_override.read_text() == original_text


def test_dispatch_emits_pi_override_warning_once_per_sync(mcp_dispatch_env, capsys):
    import hub

    data_home, proj = mcp_dispatch_env
    (proj / ".pi").mkdir(parents=True)
    (proj / ".pi" / "mcp.json").write_text("{}")

    _set_harnesses(data_home, ["pi"], [])
    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out

    assert "overrides .mcp.json" in out
    # Exactly one occurrence per project per sync
    assert out.count("overrides .mcp.json") == 1


def test_dispatch_malformed_codex_toml_skips_and_continues(mcp_dispatch_env, capsys):
    import hub

    data_home, proj = mcp_dispatch_env
    cfg_dir = proj / ".codex"
    cfg_dir.mkdir()
    bad = cfg_dir / "config.toml"
    bad.write_text("this is = not valid toml\n[\n")

    _set_harnesses(data_home, ["codex"], [])
    hub.cmd_sync(argparse.Namespace())
    err = capsys.readouterr().err

    # The malformed file is preserved verbatim
    assert bad.read_text() == "this is = not valid toml\n[\n"
    # WARN logged
    assert "cannot parse" in err and "config.toml" in err


def test_dispatch_affinity_filters_mcp_writes(mcp_dispatch_env, capsys):
    """skill with harnesses:[claude-code] and effective={claude-code, codex}
    writes to .mcp.json but NOT to .codex/config.toml."""
    import hub

    data_home, proj = mcp_dispatch_env
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    reg["skills"]["code-reviewer"]["harnesses"] = ["claude-code"]
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    _set_harnesses(data_home, ["codex"], ["claude-code"])
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (proj / ".mcp.json").exists()
    codex_cfg = proj / ".codex" / "config.toml"
    # Either the file doesn't exist, or it exists without the mcp_servers section
    if codex_cfg.exists():
        import tomlkit
        parsed = tomlkit.parse(codex_cfg.read_text())
        assert "code-reviewer" not in (parsed.get("mcp_servers") or {})
