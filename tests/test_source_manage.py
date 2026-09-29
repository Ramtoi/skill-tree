"""Tests for `hub source edit|disable|enable` and disabled-source sync semantics.

Disabling a source is a reversible switch on the source entry ONLY: its skills
stay in `skills:`, in every bundle, and in every project's `enabled:` list — what
changes is that each sync pass treats them as inactive, so the symlinks and MCP
entries they produced are cleaned up like any other orphan. Re-enabling brings
them all back, because nothing was ever unequipped.

Driven in-process (`cmd_*` with an `argparse.Namespace`) against an isolated data
home + fake HOME + patched `detect_installed`, mirroring test_sync_report.py.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from pathlib import Path

import pytest
import yaml

# ─── fixtures / helpers ────────────────────────────────────────────────────


def _skill_dir(root: Path, name: str) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: t\n---\n")
    return d


def _write_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text()) or {}


def _ns(**kwargs) -> argparse.Namespace:
    return argparse.Namespace(**kwargs)


def _payload(capsys) -> dict:
    """First JSON object printed (sync chatter may follow it on stdout)."""
    out = capsys.readouterr().out
    start = out.index("{")
    return json.loads(out[start : out.rindex("}", start) + 1])


@pytest.fixture
def src_env(tmp_data_home, tmp_path, monkeypatch):
    """One git source owning two skills — one equipped directly, one via a bundle
    — plus an untouched local skill, all on a single claude-code project."""
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})

    cache = tmp_data_home / "sources" / "org" / "worktree" / "skills"
    ext_direct = _skill_dir(cache, "ext-direct")
    ext_bundled = _skill_dir(cache, "ext-bundled")
    local_skill = _skill_dir(tmp_data_home / "skills", "local-skill")

    proj_path = tmp_path / "alpha"
    proj_path.mkdir()

    def _ext(name: str, src: Path) -> dict:
        return {
            "version": "1.0.0",
            "description": "",
            "source": str(src),
            "type": "claude-skill",
            "scope": "portable",
            "upstream": None,
            "managed": "external",
            "origin": {"source": "org", "path": f"skills/{name}"},
        }

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "ext-direct": _ext("ext-direct", ext_direct),
            "ext-bundled": _ext("ext-bundled", ext_bundled),
            "local-skill": {
                "version": "1.0.0",
                "description": "",
                "source": str(local_skill),
                "type": "claude-skill",
                "scope": "portable",
                "upstream": None,
            },
        },
        "bundles": {"b1": {"description": "", "skills": ["ext-bundled"]}},
        "projects": {
            "alpha": {
                "path": str(proj_path),
                "enabled": ["ext-direct", "local-skill"],
                "bundles": ["b1"],
                "harnesses": [],
            }
        },
        "sources": {
            "org": {
                "type": "git",
                "url": "file:///tmp/org.git",
                "name": "Org",
                "cache": str(cache.parent),
            }
        },
    }
    _write_registry(tmp_data_home, registry)
    return tmp_data_home, proj_path


def _links(proj_path: Path) -> set[str]:
    d = proj_path / ".claude" / "skills"
    return {p.name for p in d.iterdir()} if d.exists() else set()


# ─── hub source edit ───────────────────────────────────────────────────────


def test_source_edit_renames_and_persists(src_env, capsys):
    import hub

    data_home, _ = src_env
    hub.cmd_source_edit(_ns(id="org", name="Org Skills", json=True))

    payload = _payload(capsys)
    assert payload["errors"] == []
    assert payload["source"]["name"] == "Org Skills"
    assert payload["source"]["id"] == "org"
    assert _read_registry(data_home)["sources"]["org"]["name"] == "Org Skills"

    # `source list` reflects the new label.
    hub.cmd_source_list(_ns(json=True))
    listed = json.loads(capsys.readouterr().out)["sources"]
    assert [s for s in listed if s["id"] == "org"][0]["name"] == "Org Skills"


def test_source_edit_unknown_id_errors(src_env, capsys):
    import hub

    with pytest.raises(SystemExit) as exc:
        hub.cmd_source_edit(_ns(id="nope", name="X", json=True))
    assert exc.value.code == 1
    assert "not found" in _payload(capsys)["errors"][0]


@pytest.mark.parametrize("builtin", ["local", "starter"])
def test_source_edit_builtin_rejected(src_env, capsys, builtin):
    import hub

    with pytest.raises(SystemExit) as exc:
        hub.cmd_source_edit(_ns(id=builtin, name="X", json=True))
    assert exc.value.code == 1
    assert "built-in" in _payload(capsys)["errors"][0]


def test_source_edit_empty_name_rejected(src_env, capsys):
    import hub

    data_home, _ = src_env
    with pytest.raises(SystemExit) as exc:
        hub.cmd_source_edit(_ns(id="org", name="   ", json=True))
    assert exc.value.code == 1
    assert "empty" in _payload(capsys)["errors"][0]
    assert _read_registry(data_home)["sources"]["org"]["name"] == "Org"


# ─── hub source disable / enable ───────────────────────────────────────────


def test_source_disable_persists_flag_and_reports_impact(src_env, capsys):
    import hub

    data_home, _ = src_env
    hub.cmd_source_disable(_ns(id="org", json=True))

    payload = _payload(capsys)
    assert payload["enabled"] is False
    assert payload["changed"] is True
    assert payload["source"]["enabled"] is False
    assert sorted(payload["impact"]["skills"]) == ["ext-bundled", "ext-direct"]
    assert payload["impact"]["bundles"] == ["b1"]
    assert payload["impact"]["projects"] == ["alpha"]
    assert _read_registry(data_home)["sources"]["org"]["enabled"] is False


def test_source_enable_clears_the_flag(src_env, capsys):
    import hub

    data_home, _ = src_env
    hub.cmd_source_disable(_ns(id="org", json=True))
    capsys.readouterr()
    hub.cmd_source_enable(_ns(id="org", json=True))

    payload = _payload(capsys)
    assert payload["enabled"] is True
    assert payload["changed"] is True
    assert payload["source"]["enabled"] is True
    # Absent key ⇒ enabled: the flag is removed rather than set to true.
    assert "enabled" not in _read_registry(data_home)["sources"]["org"]


def test_disable_is_idempotent_and_a_no_op_skips_sync(src_env, capsys, monkeypatch):
    import hub

    calls = []
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.append(1))

    hub.cmd_source_disable(_ns(id="org", json=True))
    assert _payload(capsys)["changed"] is True
    assert len(calls) == 1

    hub.cmd_source_disable(_ns(id="org", json=True))
    payload = _payload(capsys)
    assert payload["changed"] is False
    assert payload["enabled"] is False
    assert len(calls) == 1  # unchanged state ⇒ no sync


def test_enable_on_an_enabled_source_is_a_no_op(src_env, capsys, monkeypatch):
    import hub

    calls = []
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.append(1))

    hub.cmd_source_enable(_ns(id="org", json=True))
    payload = _payload(capsys)
    assert payload["changed"] is False
    assert payload["enabled"] is True
    assert calls == []


@pytest.mark.parametrize("builtin", ["local", "starter"])
def test_source_disable_builtin_rejected(src_env, capsys, builtin):
    import hub

    with pytest.raises(SystemExit) as exc:
        hub.cmd_source_disable(_ns(id=builtin, json=True))
    assert exc.value.code == 1
    assert "built-in" in _payload(capsys)["errors"][0]


def test_source_disable_unknown_id_errors(src_env, capsys):
    import hub

    with pytest.raises(SystemExit) as exc:
        hub.cmd_source_enable(_ns(id="nope", json=True))
    assert exc.value.code == 1
    assert "not found" in _payload(capsys)["errors"][0]


# ─── views carry `enabled` ─────────────────────────────────────────────────


def test_list_and_status_expose_enabled(src_env, capsys):
    import hub

    hub.cmd_source_disable(_ns(id="org", json=True))
    capsys.readouterr()

    hub.cmd_source_list(_ns(json=True))
    by_id = {s["id"]: s for s in json.loads(capsys.readouterr().out)["sources"]}
    assert by_id["org"]["enabled"] is False
    # Built-ins are always on.
    assert by_id["local"]["enabled"] is True
    assert by_id["starter"]["enabled"] is True

    hub.cmd_source_status(_ns(id="org", json=True))
    status = json.loads(capsys.readouterr().out)
    assert status["source"]["enabled"] is False
    # The skills are still registered against the source.
    assert len(status["skills"]) == 2


# ─── sync semantics ────────────────────────────────────────────────────────


def test_disable_unlinks_skills_and_enable_restores_them(src_env, capsys):
    """The critical one: disable → links gone, registry untouched; enable → back."""
    import hub

    data_home, proj_path = src_env

    hub.cmd_sync(_ns())
    capsys.readouterr()
    assert _links(proj_path) == {"ext-direct", "ext-bundled", "local-skill"}

    before = _read_registry(data_home)
    hub.cmd_source_disable(_ns(id="org", json=True))
    capsys.readouterr()

    # Only the source's own skills stop being synced.
    assert _links(proj_path) == {"local-skill"}

    after = _read_registry(data_home)
    assert after["skills"] == before["skills"]
    assert after["bundles"] == before["bundles"]
    assert after["projects"] == before["projects"]
    assert after["sources"]["org"]["enabled"] is False

    hub.cmd_source_enable(_ns(id="org", json=True))
    capsys.readouterr()
    assert _links(proj_path) == {"ext-direct", "ext-bundled", "local-skill"}
    assert _read_registry(data_home)["skills"] == before["skills"]


def test_sync_logs_the_disabled_source_skip(src_env, capsys):
    import hub

    data_home, _ = src_env
    reg = _read_registry(data_home)
    reg["sources"]["org"]["enabled"] = False
    _write_registry(data_home, reg)

    hub.cmd_sync(_ns())
    out = capsys.readouterr().out
    assert "source disabled: ext-direct (org)" in out
    assert "source disabled: ext-bundled (org)" in out


def _add_project_mcps(data_home: Path, *, with_local: bool) -> None:
    """Register a source-owned project mcp-server (optionally beside a local one)."""
    cache = data_home / "sources" / "org" / "worktree" / "skills"

    def _mcp(src: Path, origin: dict | None) -> dict:
        cfg = {
            "version": "1.0.0",
            "description": "",
            "source": str(src),
            "type": "mcp-server",
            "scope": "portable",
            "upstream": None,
            "mcp": {"runtime": "python", "command": "python3", "args": ["{source}/s.py"]},
        }
        if origin is not None:
            cfg["managed"] = "external"
            cfg["origin"] = origin
        return cfg

    reg = _read_registry(data_home)
    reg["skills"]["ext-mcp"] = _mcp(
        _skill_dir(cache, "ext-mcp"), {"source": "org", "path": "skills/ext-mcp"}
    )
    reg["projects"]["alpha"]["enabled"].append("ext-mcp")
    if with_local:
        reg["skills"]["local-mcp"] = _mcp(
            _skill_dir(data_home / "skills", "local-mcp"), None
        )
        reg["projects"]["alpha"]["enabled"].append("local-mcp")
    _write_registry(data_home, reg)


def _mcp_servers(proj_path: Path) -> dict:
    path = proj_path / ".mcp.json"
    return json.loads(path.read_text()).get("mcpServers", {}) if path.exists() else {}


@pytest.mark.parametrize("with_local", [True, False])
def test_project_mcp_entry_removed_on_disable_and_restored_on_enable(
    src_env, capsys, with_local
):
    """A project mcp-server owned by the source leaves `.mcp.json` while disabled.

    Parametrized over whether a second (local) mcp-server survives: when the
    disabled source owned the project's ONLY mcp-servers, `sync_mcp_for_project`
    is never called, so the excision has to be its own step. Note the sibling
    limitation this does NOT cover: `ClaudeMcpAdapter.write` never prunes on a
    plain unequip (pre-existing, out of scope) — only the disabled-source path
    calls `remove()`.
    """
    import hub

    data_home, proj_path = src_env
    _add_project_mcps(data_home, with_local=with_local)

    hub.cmd_sync(_ns())
    capsys.readouterr()
    assert "ext-mcp" in _mcp_servers(proj_path)

    hub.cmd_source_disable(_ns(id="org", json=True))
    assert "removed MCP(claude) entries: ext-mcp" in capsys.readouterr().out
    servers = _mcp_servers(proj_path)
    assert "ext-mcp" not in servers
    if with_local:
        assert "local-mcp" in servers  # only the source's own entry left

    hub.cmd_source_enable(_ns(id="org", json=True))
    capsys.readouterr()
    assert "ext-mcp" in _mcp_servers(proj_path)


def test_global_mcp_dispatch_skips_a_disabled_source(tmp_data_home, monkeypatch, capsys):
    """A scope:global mcp-server owned by a disabled source is not written to the
    harness's user-global config (and a previously written one is cleaned up)."""
    import hub
    from skill_hub.infrastructure.harnesses import harnesses

    mcp_src = _skill_dir(tmp_data_home / "sources" / "org" / "worktree", "ext-global")
    global_cfg = tmp_data_home / "global" / "claude.json"
    global_cfg.parent.mkdir(parents=True, exist_ok=True)

    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=Path(global_cfg)
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    registry = {
        "version": "1",
        "skills": {
            "ext-global": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "managed": "external",
                "origin": {"source": "org", "path": "ext-global"},
                "mcp": {"runtime": "python", "command": "python3", "args": ["{source}/s.py"]},
            }
        },
        "sources": {"org": {"type": "git", "url": "file:///tmp/org.git"}},
    }

    hub._run_global_mcp_dispatch(registry, {"claude-code"})
    capsys.readouterr()
    assert "ext-global" in json.loads(global_cfg.read_text())["mcpServers"]

    registry["sources"]["org"]["enabled"] = False
    hub._run_global_mcp_dispatch(registry, {"claude-code"})
    out = capsys.readouterr().out
    assert "source disabled: ext-global (org)" in out
    assert "ext-global" not in json.loads(global_cfg.read_text()).get("mcpServers", {})


def test_global_mcp_pass_names_the_disabled_source_in_its_summary(
    tmp_data_home, monkeypatch, capsys
):
    """The "nothing registered" line must not swallow "all of them are off"."""
    import hub
    from skill_hub.infrastructure.harnesses import harnesses

    mcp_src = _skill_dir(tmp_data_home / "sources" / "org" / "worktree", "ext-global")
    global_cfg = tmp_data_home / "global" / "claude.json"
    global_cfg.parent.mkdir(parents=True, exist_ok=True)
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=Path(global_cfg)
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    registry = {
        "version": "1",
        "skills": {
            "ext-global": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                "scope": "global",
                "managed": "external",
                "origin": {"source": "org", "path": "ext-global"},
                "mcp": {"runtime": "python", "command": "python3", "args": ["{source}/s.py"]},
            }
        },
        "sources": {"org": {"type": "git", "url": "file:///tmp/org.git", "enabled": False}},
    }

    hub._run_global_mcp_dispatch(registry, {"claude-code"})
    out = capsys.readouterr().out
    assert "belongs to a disabled source" in out
    assert "no scope:global MCP servers registered" not in out


def test_variant_dirs_are_not_demanded_for_a_disabled_source(src_env):
    """An invocation override on an inactive skill stops demanding its variant."""
    import hub

    data_home, _ = src_env
    reg = _read_registry(data_home)
    reg["projects"]["alpha"]["invocation_overrides"] = {"ext-direct": "user-only"}

    demanded = hub._demanded_variant_names(reg)
    assert demanded == {hub._variant_dir_name("ext-direct", "user-only")}

    reg["sources"]["org"]["enabled"] = False
    assert hub._demanded_variant_names(reg) == set()


def test_malformed_enabled_value_warns_once_and_stays_enabled(tmp_data_home, capsys):
    import hub

    registry = {"sources": {"org": {"type": "git", "url": "u", "enabled": "yes"}}}

    assert hub.disabled_source_ids(registry) == set()  # fail-open
    assert "enabled must be true or false" in capsys.readouterr().err

    # One-shot per source id, so an N-project sync logs it once.
    assert hub.disabled_source_ids(registry) == set()
    assert "enabled must be true or false" not in capsys.readouterr().err


def test_remote_desired_state_excludes_a_disabled_source(tmp_data_home):
    import hub

    src = _skill_dir(tmp_data_home / "sources" / "org" / "worktree", "ext-remote")
    local = _skill_dir(tmp_data_home / "skills", "local-skill")
    registry = {
        "version": "1",
        "skills": {
            "ext-remote": {
                "version": "1.0.0",
                "description": "",
                "source": str(src),
                "type": "claude-skill",
                "scope": "portable",
                "managed": "external",
                "origin": {"source": "org", "path": "ext-remote"},
            },
            "local-skill": {
                "version": "1.0.0",
                "description": "",
                "source": str(local),
                "type": "claude-skill",
                "scope": "portable",
            },
        },
        "bundles": {},
        "sources": {"org": {"type": "git", "url": "file:///tmp/org.git"}},
    }
    remote_cfg = {"enabled": ["ext-remote", "local-skill"]}

    names = {i.name for i in hub.build_remote_desired_state(remote_cfg, registry).skills}
    assert names == {"ext-remote", "local-skill"}

    registry["sources"]["org"]["enabled"] = False
    names = {i.name for i in hub.build_remote_desired_state(remote_cfg, registry).skills}
    assert names == {"local-skill"}


# ─── validator ─────────────────────────────────────────────────────────────


def test_validate_sources_accepts_bool_enabled_and_rejects_other_types():
    import hub

    ok = {"sources": {"org": {"type": "git", "url": "u", "enabled": False}}}
    assert hub.validate_sources_registry(ok) == []

    absent = {"sources": {"org": {"type": "git", "url": "u"}}}
    assert hub.validate_sources_registry(absent) == []

    bad = {"sources": {"org": {"type": "git", "url": "u", "enabled": "yes"}}}
    errors = hub.validate_sources_registry(bad)
    assert len(errors) == 1
    assert "enabled must be true or false" in errors[0]


# ─── TA-1-5b1e: `hub source duplicate` has no test of any kind ─────────────
#
# Every case below drives the command through `hub.main()` with a real
# sys.argv, per the finding's repair, so an argparse defect (a renamed dest,
# a dropped guard) is visible the way a hand-built Namespace cannot show it.


def _main(monkeypatch, capsys, *args):
    import hub

    monkeypatch.setattr(sys, "argv", ["hub", "source", "duplicate", *args, "--json"])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    return code, capsys.readouterr().out


def test_source_duplicate_happy_path_with_as(src_env, monkeypatch, capsys):
    data_home, _ = src_env
    code, out = _main(monkeypatch, capsys, "ext-direct", "--as", "ext-direct-copy")
    assert code == 0, out
    payload = json.loads(out[out.index("{") : out.rindex("}") + 1])
    assert payload["ok"] is True
    assert payload["duplicated_as"] == "ext-direct-copy"

    reg = _read_registry(data_home)
    entry = reg["skills"]["ext-direct-copy"]
    assert entry["managed"] == "local"
    assert entry.get("upstream") is None
    assert (data_home / "skills" / "ext-direct-copy" / "SKILL.md").exists()
    # The original external entry is left intact.
    assert reg["skills"]["ext-direct"]["managed"] == "external"


def test_source_duplicate_default_slug(src_env, monkeypatch, capsys):
    data_home, _ = src_env
    code, out = _main(monkeypatch, capsys, "ext-direct")
    assert code == 0, out
    payload = json.loads(out[out.index("{") : out.rindex("}") + 1])
    assert payload["duplicated_as"] == "ext-direct-local"
    assert "ext-direct-local" in _read_registry(data_home)["skills"]


def test_source_duplicate_as_collision_refused(src_env, monkeypatch, capsys):
    data_home, _ = src_env
    code, out = _main(monkeypatch, capsys, "ext-direct", "--as", "local-skill")
    assert code == 1
    assert "already exists" in out
    assert "local-skill" not in out or _read_registry(data_home)["skills"]["local-skill"].get(
        "source"
    ) is not None


def test_source_duplicate_managed_local_subject_refused(src_env, monkeypatch, capsys):
    data_home, _ = src_env
    code, out = _main(monkeypatch, capsys, "local-skill")
    assert code == 1
    assert "already managed" in out
    # No new entry appeared.
    assert set(_read_registry(data_home)["skills"]) == {"ext-direct", "ext-bundled", "local-skill"}


def test_source_duplicate_unknown_name_refused(src_env, monkeypatch, capsys):
    code, out = _main(monkeypatch, capsys, "ghost")
    assert code == 1
    assert "not found" in out
