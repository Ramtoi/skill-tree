"""The project-writer ownership suite (plans/A.md §5, tests 1-15).

Every test drives an adapter directly through `tmp_data_home` (so the sidecar
reads/writes land under an isolated data home, never the real `~/.skill-hub`)
and a project root under `tmp_path`. See plans/A.md §2 for the two-tier
"First run and migration" ownership rule these tests pin.
"""

from __future__ import annotations

import json

from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar, sidecar_path

# ─────────────────────────────────────────────────────────────────────────────
# 1-7 — ClaudeMcpAdapter (.mcp.json)
# ─────────────────────────────────────────────────────────────────────────────


def test_user_authored_same_name_survives_equip(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"context7": {"command": "user-owned"}}})
    )
    adapter = ClaudeMcpAdapter()
    result = adapter.write(
        proj,
        [McpServerSpec(name="context7", command="hub-owned")],
        harness_id="claude-code",
        project_name="demo",
    )

    data = json.loads((proj / ".mcp.json").read_text())
    assert data["mcpServers"]["context7"] == {"command": "user-owned"}
    assert result.preserved == frozenset({"context7"})
    assert result.changed is False

    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is None


def test_user_authored_same_name_survives_unequip(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"context7": {"command": "user-owned"}}})
    )
    adapter = ClaudeMcpAdapter()
    result = adapter.write(proj, [], harness_id="claude-code", project_name="demo")

    data = json.loads((proj / ".mcp.json").read_text())
    assert data["mcpServers"]["context7"] == {"command": "user-owned"}
    assert result.removed == frozenset()


def test_hub_written_name_is_removed_on_unequip(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )

    result = adapter.write(proj, [], harness_id="claude-code", project_name="demo")
    assert result.removed == frozenset({"fs-mcp"})

    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is None


def test_hand_edited_hub_owned_entry_survives_unequip_as_preserved(tmp_data_home, tmp_path):
    """W3 (review): the sidecar records the entry hub wrote (v2
    `managed_values`); a hub-owned name whose on-disk entry no longer matches
    that recorded value — the user hand-edited it — must be declined on
    unequip (classified `preserved`), never silently deleted."""
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3", args=[], env={})],
        harness_id="claude-code",
        project_name="demo",
    )

    # The user hand-edits the hub-delivered entry after the fact.
    data = json.loads((proj / ".mcp.json").read_text())
    data["mcpServers"]["fs-mcp"]["args"] = ["--user-added-flag"]
    (proj / ".mcp.json").write_text(json.dumps(data))

    result = adapter.write(proj, [], harness_id="claude-code", project_name="demo")
    assert result.removed == frozenset()
    assert result.preserved == frozenset({"fs-mcp"})
    on_disk = json.loads((proj / ".mcp.json").read_text())
    assert on_disk["mcpServers"]["fs-mcp"]["args"] == ["--user-added-flag"]


def test_missing_sidecar_never_removes(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )
    scope = ProjectScope(name="demo", path=str(proj))
    sidecar_path("claude-code", scope, kind="mcp").unlink()

    result = adapter.write(proj, [], harness_id="claude-code", project_name="demo")

    data = json.loads((proj / ".mcp.json").read_text())
    assert "fs-mcp" in data["mcpServers"]
    assert result.removed == frozenset()


def test_corrupt_sidecar_never_removes(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )
    scope = ProjectScope(name="demo", path=str(proj))
    sidecar_path("claude-code", scope, kind="mcp").write_text("not json")

    result = adapter.write(proj, [], harness_id="claude-code", project_name="demo")

    data = json.loads((proj / ".mcp.json").read_text())
    assert "fs-mcp" in data["mcpServers"]
    assert result.removed == frozenset()


def test_last_server_unequip_deletes_file_when_hub_owned_only(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )
    assert (proj / ".mcp.json").exists()

    adapter.write(proj, [], harness_id="claude-code", project_name="demo")

    assert not (proj / ".mcp.json").exists()
    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is None


def test_sidecar_path_shape(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )

    expected = tmp_data_home / "state" / "claude-code" / "project-demo.mcp.managed.json"
    assert expected.exists()


def test_claude_write_aborts_on_malformed_json_never_rewrites(tmp_data_home, tmp_path, capsys):
    """C1 (review): an unparseable .mcp.json must ABORT — like Codex and
    opencode already do — never get silently rebuilt from `data = {}`, which
    would destroy every user-authored server in the file."""
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    original = '{"mcpServers": {"user-thing": {"command": "keep-me"},}, "otherKey": 1}'
    (proj / ".mcp.json").write_text(original)

    adapter = ClaudeMcpAdapter()
    result = adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )

    assert result.aborted is True
    assert (proj / ".mcp.json").read_text() == original
    assert "cannot parse" in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────────────
# 8-9 — CodexMcpAdapter / OpenCodeMcpAdapter parity
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_project_ownership(tmp_data_home, tmp_path):
    import tomlkit

    from skill_hub.infrastructure.mcp.mcp_adapters import CodexMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = CodexMcpAdapter()

    # 1 — a user-authored entry survives a differing hub write.
    cfg_dir = proj / ".codex"
    cfg_dir.mkdir()
    (cfg_dir / "config.toml").write_text(
        '[mcp_servers.context7]\ncommand = "user-owned"\nargs = []\nenv = {}\n'
    )
    result = adapter.write(
        proj,
        [McpServerSpec(name="context7", command="hub-owned")],
        harness_id="codex",
        project_name="demo",
    )
    parsed = tomlkit.parse((cfg_dir / "config.toml").read_text())
    assert str(parsed["mcp_servers"]["context7"]["command"]) == "user-owned"
    assert result.preserved == frozenset({"context7"})

    # 3 — a hub-written name is removed on unequip.
    result = adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="codex",
        project_name="demo",
    )
    assert result.added == frozenset({"fs-mcp"})
    result = adapter.write(proj, [], harness_id="codex", project_name="demo")
    assert result.removed == frozenset({"fs-mcp"})
    parsed = tomlkit.parse((cfg_dir / "config.toml").read_text())
    assert "fs-mcp" not in (parsed.get("mcp_servers") or {})

    # 4 — a missing sidecar never removes.
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp2", command="python3")],
        harness_id="codex",
        project_name="demo",
    )
    scope = ProjectScope(name="demo", path=str(proj))
    sidecar_path("codex", scope, kind="mcp").unlink()
    result = adapter.write(proj, [], harness_id="codex", project_name="demo")
    parsed = tomlkit.parse((cfg_dir / "config.toml").read_text())
    assert "fs-mcp2" in parsed["mcp_servers"]
    assert result.removed == frozenset()


def test_opencode_project_ownership(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import McpServerSpec, OpenCodeMcpAdapter

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = OpenCodeMcpAdapter()

    # 1 — a user-authored entry survives a differing hub write.
    (proj / "opencode.json").write_text(
        json.dumps({"mcp": {"context7": {"type": "local", "command": ["user-owned"]}}})
    )
    result = adapter.write(
        proj,
        [McpServerSpec(name="context7", command="hub-owned")],
        harness_id="opencode",
        project_name="demo",
    )
    doc = json.loads((proj / "opencode.json").read_text())
    assert doc["mcp"]["context7"] == {"type": "local", "command": ["user-owned"]}
    assert result.preserved == frozenset({"context7"})

    # 3 — a hub-written name is removed on unequip.
    adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="opencode",
        project_name="demo",
    )
    result = adapter.write(proj, [], harness_id="opencode", project_name="demo")
    assert result.removed == frozenset({"fs-mcp"})
    doc = json.loads((proj / "opencode.json").read_text())
    assert "fs-mcp" not in doc.get("mcp", {})


# ─────────────────────────────────────────────────────────────────────────────
# 10-11 — the claude/pi shared sidecar + representative-harness migration
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_and_pi_share_one_sidecar(tmp_data_home, tmp_path, monkeypatch):
    """W2 (review): pin the dispatch-level dedup itself, not just a single
    hand-called `write()` — drive it through `sync_mcp_for_project` with both
    claude-code and pi effective, so a regression that called `write` once per
    harness id (leaving a stray claim under BOTH `state/claude-code/` and
    `state/pi/`) would actually fail this test."""
    import dataclasses

    from skill_hub.application.sync.mcp_sync import sync_mcp_for_project
    from skill_hub.infrastructure.harnesses import harnesses

    mcp_src = tmp_data_home / "mcp-servers" / "fs-mcp"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")

    proj = tmp_path / "proj"
    proj.mkdir()

    registry = {
        "harnesses_global": ["claude-code"],
        "skills": {
            "fs-mcp": {
                "type": "mcp-server",
                "scope": "project-specific",
                "source": str(mcp_src),
                "mcp": {"command": "python3", "args": ["{source}/server.py"], "env": {}},
            }
        },
        "projects": {
            "demo": {
                "path": str(proj),
                "enabled": ["fs-mcp"],
                "bundles": [],
                "harnesses": ["pi"],
            }
        },
    }
    patched = {
        h_id: dataclasses.replace(h, detect=(lambda: True))
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    results = sync_mcp_for_project(proj, ["fs-mcp"], registry, project_name="demo")

    assert len(results) == 1
    assert (proj / ".mcp.json").exists()
    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is not None
    assert read_sidecar("pi", scope, kind="mcp") is None


def test_sidecar_read_falls_back_to_pi_and_migrates(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()
    spec = McpServerSpec(name="fs-mcp", command="python3")

    # Written while claude-code is the representative.
    adapter.write(proj, [spec], harness_id="claude-code", project_name="demo")
    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is not None
    assert read_sidecar("pi", scope, kind="mcp") is None

    # Re-run with pi as the (now sole) representative: the reader falls back
    # to the claude-code claim, so the server is STILL recognized as owned —
    # not treated as an unclaimed native entry.
    result = adapter.write(proj, [spec], harness_id="pi", project_name="demo")
    assert result.managed == frozenset({"fs-mcp"})
    assert result.preserved == frozenset()

    # The claim now lives under pi; the stale claude-code sidecar is gone.
    assert read_sidecar("pi", scope, kind="mcp") is not None
    assert read_sidecar("claude-code", scope, kind="mcp") is None

    # And it is genuinely still owned: unequipping removes it.
    result = adapter.write(proj, [], harness_id="pi", project_name="demo")
    assert result.removed == frozenset({"fs-mcp"})


# ─────────────────────────────────────────────────────────────────────────────
# 12-15 — first-run adoption (grill F5)
# ─────────────────────────────────────────────────────────────────────────────


def test_first_run_adopts_identical_unclaimed_entries(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    spec = McpServerSpec(name="fs-mcp", command="python3", args=[], env={})
    (proj / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"fs-mcp": {"command": "python3", "args": [], "env": {}}}})
    )
    adapter = ClaudeMcpAdapter()
    result = adapter.write(proj, [spec], harness_id="claude-code", project_name="demo")

    assert result.adopted == frozenset({"fs-mcp"})
    assert result.preserved == frozenset()
    assert result.changed is False
    scope = ProjectScope(name="demo", path=str(proj))
    sc = read_sidecar("claude-code", scope, kind="mcp")
    assert sc is not None
    assert sc.managed_keys == ["fs-mcp"]

    # The upgrade path works end to end: the adopted name is now truly owned.
    result = adapter.write(proj, [], harness_id="claude-code", project_name="demo")
    assert result.removed == frozenset({"fs-mcp"})


def test_first_run_preserves_differing_unclaimed_entry(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    original = json.dumps(
        {"mcpServers": {"fs-mcp": {"command": "python3", "args": ["--different"], "env": {}}}}
    )
    (proj / ".mcp.json").write_text(original)
    adapter = ClaudeMcpAdapter()
    result = adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )

    assert result.preserved == frozenset({"fs-mcp"})
    assert result.adopted == frozenset()
    assert (proj / ".mcp.json").read_text() == original
    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is None


def test_adoption_is_first_run_only(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = ClaudeMcpAdapter()

    # Establish a sidecar (claiming "first-server") — no longer a first run.
    adapter.write(
        proj,
        [McpServerSpec(name="first-server", command="python3")],
        harness_id="claude-code",
        project_name="demo",
    )

    # Hand-add a second, unclaimed entry byte-identical to what hub would
    # write, then equip it too.
    data = json.loads((proj / ".mcp.json").read_text())
    data["mcpServers"]["second-server"] = {"command": "python3", "args": [], "env": {}}
    (proj / ".mcp.json").write_text(json.dumps(data))

    result = adapter.write(
        proj,
        [
            McpServerSpec(name="first-server", command="python3"),
            McpServerSpec(name="second-server", command="python3"),
        ],
        harness_id="claude-code",
        project_name="demo",
    )
    assert result.preserved == frozenset({"second-server"})
    assert result.adopted == frozenset()


def test_codex_first_run_adoption(tmp_data_home, tmp_path):
    import tomlkit

    from skill_hub.infrastructure.mcp.mcp_adapters import CodexMcpAdapter, McpServerSpec

    proj = tmp_path / "proj"
    proj.mkdir()
    cfg_dir = proj / ".codex"
    cfg_dir.mkdir()
    (cfg_dir / "config.toml").write_text(
        '[mcp_servers.fs-mcp]\ncommand = "python3"\nargs = []\nenv = {}\n'
    )
    adapter = CodexMcpAdapter()
    result = adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3", args=[], env={})],
        harness_id="codex",
        project_name="demo",
    )

    assert result.adopted == frozenset({"fs-mcp"})
    assert result.changed is False
    parsed = tomlkit.parse((cfg_dir / "config.toml").read_text())
    assert str(parsed["mcp_servers"]["fs-mcp"]["command"]) == "python3"
    scope = ProjectScope(name="demo", path=str(proj))
    sc = read_sidecar("codex", scope, kind="mcp")
    assert sc is not None
    assert sc.managed_keys == ["fs-mcp"]


def test_opencode_first_run_adoption(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.mcp.mcp_adapters import McpServerSpec, OpenCodeMcpAdapter

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "opencode.json").write_text(
        json.dumps({"mcp": {"fs-mcp": {"type": "local", "command": ["python3"], "enabled": True}}})
    )
    adapter = OpenCodeMcpAdapter()
    result = adapter.write(
        proj,
        [McpServerSpec(name="fs-mcp", command="python3", args=[], env={})],
        harness_id="opencode",
        project_name="demo",
    )

    assert result.adopted == frozenset({"fs-mcp"})
    assert result.changed is False
    scope = ProjectScope(name="demo", path=str(proj))
    sc = read_sidecar("opencode", scope, kind="mcp")
    assert sc is not None
    assert sc.managed_keys == ["fs-mcp"]
