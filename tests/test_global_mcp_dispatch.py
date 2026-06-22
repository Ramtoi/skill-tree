"""Tests for the global-MCP dispatch (tasks 5.1–5.6).

scope:global mcp-server registry entries are written to each installed
harness's USER-GLOBAL MCP config on `hub sync`:
  - claude-code → ~/.claude.json `mcpServers`
  - codex       → ~/.codex/config.toml `[mcp_servers.*]`
  - pi/opencode → skipped (no global MCP target)

Merge-preserving, backup-first, atomic, sidecar-tracked cleanup.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

import pytest
import yaml


# ─────────────────────────────────────────────────────────────────────────────
# ClaudeMcpAdapter.write_global
# ─────────────────────────────────────────────────────────────────────────────


def _claude_spec(name="skill-hub"):
    from mcp_adapters import McpServerSpec

    return McpServerSpec(
        name=name,
        command="python3",
        args=["/x/server.py"],
        env={"SKILL_HUB_ACTOR": "skill-hub-mcp"},
    )


# ─────────────────────────────────────────────────────────────────────────────
# _spec_from_skill — source is optional (regression: a sourceless mcp-server
# like the skill-hub control plane crashed sync via expand(None)).
# ─────────────────────────────────────────────────────────────────────────────


def test_spec_from_skill_sourceless_mcp_server_does_not_crash():
    import hub

    cfg = {
        "type": "mcp-server",
        "scope": "global",
        "source": None,  # control-plane server has no source dir
        "mcp": {
            "command": "python3",
            "args": ["/abs/skill_hub_mcp_server.py"],
            "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
        },
    }
    spec = hub._spec_from_skill("skill-hub", cfg)
    assert spec.command == "python3"
    assert spec.args == ["/abs/skill_hub_mcp_server.py"]
    assert spec.env == {"SKILL_HUB_ACTOR": "skill-hub-mcp"}


def test_spec_from_skill_substitutes_source_placeholder(tmp_path):
    import hub

    cfg = {
        "type": "mcp-server",
        "scope": "global",
        "source": str(tmp_path),
        "mcp": {"command": "python3", "args": ["{source}/server.py"]},
    }
    spec = hub._spec_from_skill("with-source", cfg)
    assert spec.args == [f"{tmp_path.resolve()}/server.py"]


def _seed_claude_json(path: Path) -> str:
    """Seed a ~/.claude.json-shaped file: 2 user http servers + a non-ASCII
    top-level value, serialized exactly like the live file (ensure_ascii=False,
    indent=2, NO trailing newline)."""
    data = {
        "numStartups": 42,
        "tipsHistory": {"café-tip": 1},  # non-ASCII key + value
        "mcpServers": {
            "Sanity": {"type": "http", "url": "https://sanity.example/mcp"},
            "agent-lense": {"type": "http", "url": "https://lense.example/mcp"},
        },
    }
    text = json.dumps(data, indent=2, ensure_ascii=False)  # no trailing newline
    path.write_text(text, encoding="utf-8")
    return text


def test_claude_write_global_merge_preserving(tmp_data_home):
    """skill-hub added; Sanity + agent-lense + non-ASCII top-level survive."""
    from mcp_adapters import ClaudeMcpAdapter

    target = tmp_data_home / ".claude.json"
    _seed_claude_json(target)

    adapter = ClaudeMcpAdapter()
    result = adapter.write_global(target, [_claude_spec()], prior_managed=None)

    assert result.changed is True
    assert "skill-hub" in result.added
    assert result.managed == {"skill-hub"}

    data = json.loads(target.read_text(encoding="utf-8"))
    assert "Sanity" in data["mcpServers"]
    assert "agent-lense" in data["mcpServers"]
    assert data["mcpServers"]["Sanity"] == {
        "type": "http",
        "url": "https://sanity.example/mcp",
    }
    assert data["mcpServers"]["skill-hub"] == {
        "command": "python3",
        "args": ["/x/server.py"],
        "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
    }
    # Non-ASCII preserved
    assert "café-tip" in data["tipsHistory"]
    # Top-level non-MCP key preserved
    assert data["numStartups"] == 42


def test_claude_write_global_idempotent_byte_identical(tmp_data_home):
    """A re-write of an already-present spec is BYTE-IDENTICAL, incl. non-ASCII
    bytes and the no-trailing-newline state."""
    from mcp_adapters import ClaudeMcpAdapter

    target = tmp_data_home / ".claude.json"
    _seed_claude_json(target)
    adapter = ClaudeMcpAdapter()

    r1 = adapter.write_global(target, [_claude_spec()], prior_managed=None)
    assert r1.changed is True
    first_bytes = target.read_bytes()
    assert not first_bytes.endswith(b"\n")  # no trailing newline preserved

    # Second write with same spec + sidecar-state {skill-hub}.
    r2 = adapter.write_global(target, [_claude_spec()], prior_managed={"skill-hub"})
    assert r2.changed is False
    assert target.read_bytes() == first_bytes  # byte-identical


def test_claude_write_global_preserves_trailing_newline_when_present(tmp_data_home):
    from mcp_adapters import ClaudeMcpAdapter

    target = tmp_data_home / ".claude.json"
    target.write_text(
        json.dumps({"mcpServers": {}}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    adapter = ClaudeMcpAdapter()
    adapter.write_global(target, [_claude_spec()], prior_managed=None)
    assert target.read_bytes().endswith(b"\n")


def test_claude_write_global_empty_spec_cleanup_keeps_other_servers(tmp_data_home):
    """write_global([], prior={skill-hub}) removes skill-hub, keeps user servers,
    leaves a valid file with mcpServers intact."""
    from mcp_adapters import ClaudeMcpAdapter

    target = tmp_data_home / ".claude.json"
    _seed_claude_json(target)
    adapter = ClaudeMcpAdapter()
    adapter.write_global(target, [_claude_spec()], prior_managed=None)

    result = adapter.write_global(target, [], prior_managed={"skill-hub"})
    assert result.changed is True
    assert result.removed == {"skill-hub"}
    assert result.managed == set()

    data = json.loads(target.read_text(encoding="utf-8"))
    assert "skill-hub" not in data["mcpServers"]
    assert "Sanity" in data["mcpServers"]
    assert "agent-lense" in data["mcpServers"]
    assert "mcpServers" in data  # not dropped


def test_claude_write_global_sidecar_missing_is_noop_cleanup(tmp_data_home):
    """prior_managed=None → cleanup is a no-op; user servers never removed even
    when they are not in specs."""
    from mcp_adapters import ClaudeMcpAdapter

    target = tmp_data_home / ".claude.json"
    _seed_claude_json(target)
    adapter = ClaudeMcpAdapter()
    # Write nothing, with no prior knowledge → must NOT remove Sanity/agent-lense.
    result = adapter.write_global(target, [], prior_managed=None)
    assert result.changed is False
    data = json.loads(target.read_text(encoding="utf-8"))
    assert "Sanity" in data["mcpServers"]
    assert "agent-lense" in data["mcpServers"]


def test_claude_write_global_unparseable_aborts(tmp_data_home, capsys):
    """Existing-but-unparseable target → abort, file untouched, aborted=True."""
    from mcp_adapters import ClaudeMcpAdapter

    target = tmp_data_home / ".claude.json"
    target.write_text("{ this is not json", encoding="utf-8")
    adapter = ClaudeMcpAdapter()
    result = adapter.write_global(target, [_claude_spec()], prior_managed={"skill-hub"})

    assert result.aborted is True
    assert target.read_text(encoding="utf-8") == "{ this is not json"
    err = capsys.readouterr().err
    assert "cannot parse" in err


def test_claude_write_global_backup_only_on_change(tmp_data_home):
    """Backup written when changed; no backup spam on an idempotent re-write."""
    from mcp_adapters import ClaudeMcpAdapter

    target = tmp_data_home / ".claude.json"
    _seed_claude_json(target)
    adapter = ClaudeMcpAdapter()
    backup_dir = tmp_data_home / "_hub-backups" / "mcp" / "claude-code" / "global"

    adapter.write_global(target, [_claude_spec()], prior_managed=None)
    assert backup_dir.exists()
    n_after_first = len(list(backup_dir.iterdir()))
    assert n_after_first == 1

    # Idempotent re-write → no new backup.
    adapter.write_global(target, [_claude_spec()], prior_managed={"skill-hub"})
    assert len(list(backup_dir.iterdir())) == n_after_first


# ─────────────────────────────────────────────────────────────────────────────
# CodexMcpAdapter.write_global
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_write_global_roundtrip_preserves_other_tables(tmp_data_home):
    import tomlkit

    from mcp_adapters import CodexMcpAdapter, McpServerSpec

    target = tmp_data_home / "config.toml"
    target.write_text(
        '# user config\n'
        'model = "gpt-5.4"\n'
        "startup_timeout_sec = 30\n"
        "\n"
        "[node_repl]\n"
        "enabled = true\n",
        encoding="utf-8",
    )
    adapter = CodexMcpAdapter()
    result = adapter.write_global(
        target,
        [McpServerSpec(name="skill-hub", command="python3", args=["/x.py"])],
        prior_managed=None,
    )
    assert result.changed is True
    assert "skill-hub" in result.added

    parsed = tomlkit.parse(target.read_text(encoding="utf-8"))
    assert str(parsed["model"]) == "gpt-5.4"
    assert int(parsed["startup_timeout_sec"]) == 30
    assert bool(parsed["node_repl"]["enabled"]) is True
    assert str(parsed["mcp_servers"]["skill-hub"]["command"]) == "python3"
    assert list(parsed["mcp_servers"]["skill-hub"]["args"]) == ["/x.py"]


def test_codex_write_global_idempotent_and_cleanup(tmp_data_home):
    import tomlkit

    from mcp_adapters import CodexMcpAdapter, McpServerSpec

    target = tmp_data_home / "config.toml"
    target.write_text("[node_repl]\nenabled = true\n", encoding="utf-8")
    adapter = CodexMcpAdapter()
    spec = McpServerSpec(name="skill-hub", command="python3", args=["/x.py"])

    adapter.write_global(target, [spec], prior_managed=None)
    first = target.read_bytes()
    # Re-write identical → no change.
    r2 = adapter.write_global(target, [spec], prior_managed={"skill-hub"})
    assert r2.changed is False
    assert target.read_bytes() == first

    # Empty spec + prior → removed, node_repl survives.
    r3 = adapter.write_global(target, [], prior_managed={"skill-hub"})
    assert r3.changed is True
    assert r3.removed == {"skill-hub"}
    parsed = tomlkit.parse(target.read_text(encoding="utf-8"))
    assert "skill-hub" not in (parsed.get("mcp_servers") or {})
    assert bool(parsed["node_repl"]["enabled"]) is True


def test_codex_write_global_unparseable_aborts(tmp_data_home, capsys):
    from mcp_adapters import CodexMcpAdapter, McpServerSpec

    target = tmp_data_home / "config.toml"
    target.write_text("not valid = toml\n[\n", encoding="utf-8")
    adapter = CodexMcpAdapter()
    result = adapter.write_global(
        target,
        [McpServerSpec(name="skill-hub", command="python3")],
        prior_managed={"skill-hub"},
    )
    assert result.aborted is True
    assert target.read_text(encoding="utf-8") == "not valid = toml\n[\n"
    assert "cannot parse" in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────────────
# Sync-pass integration (tasks 5.4b + 5.6)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def global_mcp_sync_env(tmp_data_home, monkeypatch):
    """A scope:global mcp-server registered; all harnesses installed; each
    harness's global_mcp_config monkeypatched to a tmp file."""
    import harnesses

    mcp_src = tmp_data_home / "mcp-servers" / "skill-hub"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")

    proj = tmp_data_home / "projects" / "alpha"
    proj.mkdir(parents=True)

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code", "codex", "pi", "opencode"],
        "skills": {
            "skill-hub": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "mcp": {
                    "runtime": "python",
                    "command": "python3",
                    "args": ["{source}/server.py"],
                    "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
                },
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
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    claude_global = tmp_data_home / "global" / "claude.json"
    codex_global = tmp_data_home / "global" / "codex-config.toml"
    claude_global.parent.mkdir(parents=True, exist_ok=True)

    patched = {}
    for h_id, h in harnesses.HARNESSES.items():
        kwargs = {"detect": (lambda: True)}
        if h_id == "claude-code":
            kwargs["global_mcp_config"] = Path(claude_global)
        elif h_id == "codex":
            kwargs["global_mcp_config"] = Path(codex_global)
        patched[h_id] = dataclasses.replace(h, **kwargs)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    return tmp_data_home, proj, claude_global, codex_global


def test_sync_pass_writes_claude_and_codex_skips_pi_opencode(global_mcp_sync_env, capsys):
    import hub

    data_home, proj, claude_global, codex_global = global_mcp_sync_env
    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out

    # Claude
    assert claude_global.exists()
    cdata = json.loads(claude_global.read_text(encoding="utf-8"))
    assert "skill-hub" in cdata["mcpServers"]
    entry = cdata["mcpServers"]["skill-hub"]
    assert entry["command"] == "python3"
    # {source} substituted to the mcp-server source dir.
    assert entry["args"][0].endswith("/server.py")
    assert str(data_home / "mcp-servers" / "skill-hub") in entry["args"][0]

    # Codex
    import tomlkit

    assert codex_global.exists()
    tdata = tomlkit.parse(codex_global.read_text(encoding="utf-8"))
    assert "skill-hub" in tdata["mcp_servers"]

    # pi + opencode skipped (logged)
    assert "Pi skipped" in out
    assert "opencode skipped" in out

    # Sidecars written for the two that got writes.
    assert (data_home / "state" / "claude-code" / "global-mcp.managed.json").exists()
    assert (data_home / "state" / "codex" / "global-mcp.managed.json").exists()
    # pi/opencode never got a sidecar.
    assert not (data_home / "state" / "pi" / "global-mcp.managed.json").exists()


def test_sync_pass_second_run_idempotent(global_mcp_sync_env, capsys):
    import hub

    data_home, proj, claude_global, codex_global = global_mcp_sync_env
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    claude_bytes = claude_global.read_bytes()
    codex_bytes = codex_global.read_bytes()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    assert claude_global.read_bytes() == claude_bytes
    assert codex_global.read_bytes() == codex_bytes


def test_sync_pass_affinity_codex_only(global_mcp_sync_env, capsys):
    """harnesses:[codex] → written to codex only, skipped for claude."""
    import hub

    data_home, proj, claude_global, codex_global = global_mcp_sync_env
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    reg["skills"]["skill-hub"]["harnesses"] = ["codex"]
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert codex_global.exists()
    import tomlkit

    tdata = tomlkit.parse(codex_global.read_text(encoding="utf-8"))
    assert "skill-hub" in tdata["mcp_servers"]

    # Claude target either absent or has no skill-hub entry.
    if claude_global.exists():
        cdata = json.loads(claude_global.read_text(encoding="utf-8"))
        assert "skill-hub" not in (cdata.get("mcpServers") or {})


def test_sync_pass_uninstall_removes_only_hub_entry(global_mcp_sync_env, capsys):
    """After a global write, dropping the registry entry removes skill-hub from
    claude but leaves a pre-seeded user server intact (sidecar-scoped cleanup)."""
    import hub

    data_home, proj, claude_global, codex_global = global_mcp_sync_env

    # Seed a user server BEFORE first sync so the merge preserves it.
    claude_global.write_text(
        json.dumps(
            {"mcpServers": {"Sanity": {"type": "http", "url": "https://s/mcp"}}},
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    cdata = json.loads(claude_global.read_text(encoding="utf-8"))
    assert "skill-hub" in cdata["mcpServers"]
    assert "Sanity" in cdata["mcpServers"]

    # Remove the registry entry → next sync removes only skill-hub.
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    del reg["skills"]["skill-hub"]
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    cdata = json.loads(claude_global.read_text(encoding="utf-8"))
    assert "skill-hub" not in cdata["mcpServers"]
    assert "Sanity" in cdata["mcpServers"]


def test_sync_pass_no_double_write_global_excluded_from_project(
    global_mcp_sync_env, capsys
):
    """A scope:global mcp-server also placed in a project's enabled set is NOT
    written to the project's .mcp.json (owned solely by the global pass)."""
    import hub

    data_home, proj, claude_global, codex_global = global_mcp_sync_env
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    reg["projects"]["alpha"]["enabled"] = ["skill-hub"]
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    # Global write happened.
    cdata = json.loads(claude_global.read_text(encoding="utf-8"))
    assert "skill-hub" in cdata["mcpServers"]
    # Per-project .mcp.json must NOT contain it (no double-write/shadowing).
    proj_mcp = proj / ".mcp.json"
    if proj_mcp.exists():
        pdata = json.loads(proj_mcp.read_text())
        assert "skill-hub" not in (pdata.get("mcpServers") or {})
