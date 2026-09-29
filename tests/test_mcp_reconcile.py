"""`mcp_reconcile.py` — discovery + classification (plans/D.md §5, cases 1-23).

Sandboxing: `tmp_data_home` + the autouse `_fake_home`/`_isolate_global_mcp`
fixtures from `tests/conftest.py`. No test reads or writes the real
`~/.claude.json`, `~/.codex/config.toml`, or
`~/.config/opencode/opencode.json` — `_fake_home` always points `$HOME` (and
therefore every `~/...` literal `mcp_reconcile.py` resolves) at a per-test tmp
directory.
"""

from __future__ import annotations

import dataclasses
import json

import pytest


def _registry(**overrides) -> dict:
    base = {"skills": {}, "projects": {}, "bundles": {}, "harnesses_global": []}
    base.update(overrides)
    return base


def _write_json(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def _write_text(path, text) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _proj_cfg(path) -> dict:
    return {"path": str(path), "enabled": [], "bundles": [], "harnesses": []}


def _mark_claude_global_capable(monkeypatch, path) -> None:
    """`tests/conftest.py::_isolate_global_mcp` (autouse) nulls every
    harness's `global_mcp_config` by default. `mcp_reconcile`'s readers
    already resolve through the fake home regardless (`_claude_json_path`'s
    own fallback), but W1's `_no_global_writer` check now ALSO gates on
    `Harness.global_mcp_config` being set (the real capability signal) — so a
    test asserting a claude-family GLOBAL-scope candidate is importable, not
    `unsupported/no_global_target`, must restore it, pointed at the same
    fake-home path the reader would use anyway."""
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=path
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)


# ─────────────────────────────────────────────────────────────────────────────
# 1 — Claude user-scope discovery
# ─────────────────────────────────────────────────────────────────────────────


def test_discovers_claude_user_scope_servers(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(
        _fake_home / ".claude.json",
        {"mcpServers": {"foo": {"command": "node", "args": ["x.js"]}}},
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    assert len(discovered) == 1
    d = discovered[0]
    assert d.name == "foo"
    assert d.harness == "claude-code"
    assert d.scope == "user"
    assert d.spec is not None
    assert d.spec.command == "node"
    assert d.spec.args == ["x.js"]


# ─────────────────────────────────────────────────────────────────────────────
# 2/3 — Claude local scope (M7a)
# ─────────────────────────────────────────────────────────────────────────────


def test_discovers_claude_local_scope_for_a_registered_project(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "registered"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})

    _write_json(
        _fake_home / ".claude.json",
        {"projects": {str(proj): {"mcpServers": {"foo": {"command": "node"}}}}},
    )

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code"}
    )
    assert len(discovered) == 1
    d = discovered[0]
    assert d.name == "foo"
    assert d.scope == "local"
    assert d.project == "demo"
    assert d.file.endswith(".claude.json")
    assert d.spec is not None


def test_claude_local_scope_for_an_unregistered_project_is_unsupported(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    unregistered = tmp_path / "unregistered"
    unregistered.mkdir()
    registry = _registry()  # no projects registered at all

    _write_json(
        _fake_home / ".claude.json",
        {"projects": {str(unregistered): {"mcpServers": {"foo": {"command": "node"}}}}},
    )

    discovered = mcp_reconcile.discover_native("global", None, registry, {"claude-code"})
    assert len(discovered) == 1
    d = discovered[0]
    assert d.name == "foo"
    assert d.reason is not None
    assert d.reason.startswith("local_scope_unregistered_project:")
    assert str(unregistered) in d.reason


# ─────────────────────────────────────────────────────────────────────────────
# 4 — Codex global tables
# ─────────────────────────────────────────────────────────────────────────────


def test_discovers_codex_global_tables(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_text(
        _fake_home / ".codex" / "config.toml",
        '[mcp_servers.bar]\ncommand = "python3"\nargs = ["server.py"]\n',
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"codex"})
    assert len(discovered) == 1
    d = discovered[0]
    assert d.name == "bar"
    assert d.harness == "codex"
    assert d.scope == "global"
    assert d.spec is not None
    assert d.spec.command == "python3"
    assert d.spec.args == ["server.py"]


# ─────────────────────────────────────────────────────────────────────────────
# 5 — opencode project mcp object
# ─────────────────────────────────────────────────────────────────────────────


def test_discovers_opencode_project_mcp_object(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(
        proj / "opencode.json",
        {"mcp": {"baz": {"type": "local", "command": ["node", "index.js"], "enabled": True}}},
    )
    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"opencode"}
    )
    assert len(discovered) == 1
    d = discovered[0]
    assert d.name == "baz"
    assert d.harness == "opencode"
    assert d.spec is not None
    assert d.spec.command == "node"
    assert d.spec.args == ["index.js"]


# ─────────────────────────────────────────────────────────────────────────────
# 6 — opencode + pi global entries: unsupported/no_global_target (M7b)
# ─────────────────────────────────────────────────────────────────────────────


def test_opencode_global_entries_are_unsupported_no_global_target(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(
        _fake_home / ".config" / "opencode" / "opencode.json",
        {"mcp": {"qux": {"type": "remote", "url": "https://example.test/mcp"}}},
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"opencode"})
    assert len(discovered) == 1
    d = discovered[0]
    assert d.spec is None
    assert d.reason == "no_global_target"

    candidates = mcp_reconcile.classify(discovered, _registry(), set())
    assert candidates[0]["status"] == "unsupported"
    assert candidates[0]["reason"] == "no_global_target"


def test_opencode_global_unreadable_file_is_reported_not_silently_dropped(tmp_data_home, _fake_home):
    """N3: `_read_opencode_global` used to stay silent on a parse failure —
    the only one of the four global-scope readers that did. (The classified
    CANDIDATE still reads `no_global_target` — opencode's global scope is
    permanently un-importable regardless of shape, `_no_global_writer` is
    checked before the "not supported" branch — but the raw discovery row,
    which the band's per-source detail reads, must carry the real reason.)"""
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_text(_fake_home / ".config" / "opencode" / "opencode.json", "{ not valid json")
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"opencode"})
    assert len(discovered) == 1
    d = discovered[0]
    assert d.reason == "unreadable_file"
    assert d.name == "unreadable:opencode.json"


def test_pi_global_entry_is_unsupported_no_global_target_defensive(tmp_data_home, _fake_home):
    """S6: a reader-level test (not a hand-built `DiscoveredMcp`) — with only
    "pi" installed (no claude-code), `~/.claude.json`'s top-level `mcpServers`
    resolves to harness="pi" (the claude-family fallback), and W1's fix means
    `_no_global_writer` now correctly forces it `unsupported/no_global_target`
    — pi's `Harness.global_mcp_config` is permanently `None`, so importing it
    could never be redelivered or claimed (M7(b))."""
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(
        _fake_home / ".claude.json",
        {"mcpServers": {"hypothetical": {"command": "node"}}},
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"pi"})
    assert len(discovered) == 1
    assert discovered[0].harness == "pi"
    assert discovered[0].scope == "user"
    assert discovered[0].spec is not None  # it DID parse to a real spec

    candidates = mcp_reconcile.classify(discovered, _registry(), set())
    assert len(candidates) == 1
    assert candidates[0]["status"] == "unsupported"
    assert candidates[0]["reason"] == "no_global_target"


# ─────────────────────────────────────────────────────────────────────────────
# 7 — project scope from all three files
# ─────────────────────────────────────────────────────────────────────────────


def test_discovers_project_scope_from_all_three_files(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})

    _write_json(proj / ".mcp.json", {"mcpServers": {"a": {"command": "node"}}})
    _write_text(
        proj / ".codex" / "config.toml", '[mcp_servers.b]\ncommand = "python3"\n'
    )
    _write_json(
        proj / "opencode.json",
        {"mcp": {"c": {"type": "local", "command": ["ruby", "s.rb"], "enabled": True}}},
    )

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code", "codex", "opencode"}
    )
    names = {d.name for d in discovered}
    assert names == {"a", "b", "c"}
    harnesses_by_name = {d.name: d.harness for d in discovered}
    assert harnesses_by_name["a"] == "claude-code"
    assert harnesses_by_name["b"] == "codex"
    assert harnesses_by_name["c"] == "opencode"


# ─────────────────────────────────────────────────────────────────────────────
# 8 — already_managed excluded (global scope)
# ─────────────────────────────────────────────────────────────────────────────


def test_already_managed_excluded(tmp_data_home, _fake_home):
    from skill_hub import hub_core
    from skill_hub.infrastructure.mcp import mcp_reconcile

    registry = _registry(
        skills={
            "skill-hub": {
                "type": "mcp-server",
                "scope": "global",
                "mcp": {"command": "python3", "args": ["/x/server.py"]},
            }
        }
    )
    _write_json(
        _fake_home / ".claude.json",
        {"mcpServers": {"skill-hub": {"command": "python3", "args": ["/x/server.py"]}}},
    )
    sidecar = hub_core.data_home() / "state" / "claude-code" / "global-mcp.managed.json"
    _write_json(sidecar, ["skill-hub"])

    discovered = mcp_reconcile.discover_native("global", None, registry, {"claude-code"})
    managed = mcp_reconcile.managed_names("global")
    assert managed == {"skill-hub"}
    candidates = mcp_reconcile.classify(discovered, registry, managed)
    assert len(candidates) == 1
    assert candidates[0]["status"] == "already_managed"


# ─────────────────────────────────────────────────────────────────────────────
# 9 — already_managed at project scope reads BOTH sidecar ids (A/m1)
# ─────────────────────────────────────────────────────────────────────────────


def test_already_managed_at_project_scope_reads_both_sidecar_ids(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.domain.permissions.permissions import ProjectScope, write_sidecar
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "node"}}},
    )
    registry["projects"]["demo"]["enabled"] = ["foo"]

    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    scope = ProjectScope(name="demo", path=str(proj))
    write_sidecar("pi", scope, ["foo"], proj / ".mcp.json", kind="mcp")

    # Only pi is effective (claude-code not installed) — the representative
    # rule must still find the claim under "pi".
    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"pi"}
    )
    managed = mcp_reconcile.managed_names("project", "demo", proj)
    assert managed == {"foo"}
    candidates = mcp_reconcile.classify(discovered, registry, managed)
    assert len(candidates) == 1
    assert candidates[0]["status"] == "already_managed"


# ─────────────────────────────────────────────────────────────────────────────
# 10/11 — cross-harness identical vs divergent specs
# ─────────────────────────────────────────────────────────────────────────────


def test_identical_spec_across_harnesses_collapses_to_one_candidate(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})

    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node", "args": ["x.js"]}}})
    _write_text(
        proj / ".codex" / "config.toml",
        '[mcp_servers.foo]\ncommand = "node"\nargs = ["x.js"]\n',
    )

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code", "codex"}
    )
    candidates = mcp_reconcile.classify(discovered, registry, set())
    assert len(candidates) == 1
    cand = candidates[0]
    assert cand["status"] == "new"
    assert len(cand["sources"]) == 2
    assert cand["spec"]["command"] == "node"


def test_divergent_spec_is_a_conflict_with_options(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})

    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node", "args": ["a.js"]}}})
    _write_text(
        proj / ".codex" / "config.toml",
        '[mcp_servers.foo]\ncommand = "node"\nargs = ["b.js"]\n',
    )

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code", "codex"}
    )
    candidates = mcp_reconcile.classify(discovered, registry, set())
    assert len(candidates) == 1
    cand = candidates[0]
    assert cand["status"] == "conflict"
    assert cand["spec"] is None
    assert {o["harness"] for o in cand["options"]} == {"claude-code", "codex"}


def test_claude_local_vs_project_conflict_yields_two_distinguishable_options(
    tmp_path, tmp_data_home, _fake_home
):
    """W4: both entries share `harness == "claude-code"` — only `scope`
    (+ `file`) tells them apart, so an option row must carry both."""
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})

    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node", "args": ["project.js"]}}})
    _write_json(
        _fake_home / ".claude.json",
        {"projects": {str(proj): {"mcpServers": {"foo": {"command": "node", "args": ["local.js"]}}}}},
    )

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code"}
    )
    candidates = mcp_reconcile.classify(discovered, registry, set())
    assert len(candidates) == 1
    cand = candidates[0]
    assert cand["status"] == "conflict"
    assert len(cand["options"]) == 2
    assert all(o["harness"] == "claude-code" for o in cand["options"])
    scopes = {o["scope"] for o in cand["options"]}
    assert scopes == {"project", "local"}
    by_scope = {o["scope"]: o for o in cand["options"]}
    assert by_scope["project"]["spec"]["args"] == ["project.js"]
    assert by_scope["local"]["spec"]["args"] == ["local.js"]
    # each option is independently addressable — a real file path, no two
    # options collapse to the same (harness, scope, file) triple.
    assert len({(o["harness"], o["scope"], o["file"]) for o in cand["options"]}) == 2


# ─────────────────────────────────────────────────────────────────────────────
# 12/13 — registered-but-unclaimed conflict (F5)
# ─────────────────────────────────────────────────────────────────────────────


def test_registry_name_with_different_spec_is_a_conflict(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "nodeA"}}},
    )
    registry["projects"]["demo"]["enabled"] = ["foo"]

    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "nodeB"}}})

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code"}
    )
    candidates = mcp_reconcile.classify(discovered, registry, set())
    assert len(candidates) == 1
    assert candidates[0]["status"] == "conflict"


def test_unclaimed_native_entry_is_a_conflict_with_the_registry_option(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "nodeA"}}},
    )
    registry["projects"]["demo"]["enabled"] = ["foo"]

    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "nodeB"}}})

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code"}
    )
    managed = mcp_reconcile.managed_names("project", "demo", proj)  # no sidecar written — unclaimed
    assert managed == set()
    candidates = mcp_reconcile.classify(discovered, registry, managed)
    assert len(candidates) == 1
    cand = candidates[0]
    assert cand["status"] == "conflict"
    assert "unclaimed_native_entry" in cand["warnings"]
    registry_options = [o for o in cand["options"] if o["harness"] == "registry"]
    assert len(registry_options) == 1
    assert registry_options[0]["spec"]["command"] == "nodeA"
    native_options = [o for o in cand["options"] if o["harness"] == "claude-code"]
    assert native_options[0]["spec"]["command"] == "nodeB"


# ─────────────────────────────────────────────────────────────────────────────
# 14/15/16/17 — unsupported shapes
# ─────────────────────────────────────────────────────────────────────────────


def test_ws_entry_is_unsupported(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(
        _fake_home / ".claude.json",
        {"mcpServers": {"foo": {"type": "ws", "url": "wss://example.test"}}},
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    assert discovered[0].reason == "ws_transport"


def test_oauth_block_is_unsupported_claude(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(
        _fake_home / ".claude.json",
        {
            "mcpServers": {
                "foo": {"type": "http", "url": "https://example.test", "oauth": {"client_id": "abc"}}
            }
        },
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    assert discovered[0].reason == "oauth_block"


def test_oauth_block_is_unsupported_codex(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_text(
        _fake_home / ".codex" / "config.toml",
        '[mcp_servers.foo]\ncommand = "node"\nauth = "oauth"\n',
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"codex"})
    assert discovered[0].reason == "oauth_block"


def test_oauth_block_is_unsupported_opencode(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(
        proj / "opencode.json",
        {"mcp": {"foo": {"type": "local", "command": ["node"], "oauth": {"x": 1}}}},
    )
    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"opencode"}
    )
    assert discovered[0].reason == "oauth_block"


def test_headers_helper_is_unsupported(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(
        _fake_home / ".claude.json",
        {
            "mcpServers": {
                "foo": {"type": "http", "url": "https://example.test", "headersHelper": "./helper.sh"}
            }
        },
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    assert discovered[0].reason == "headers_helper"


def test_unknown_shape_is_unsupported_not_a_crash(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(
        _fake_home / ".claude.json",
        {
            "mcpServers": {
                "a_string": "just a string",
                "a_list": [1, 2, 3],
                "neither": {"foo": "bar"},
            }
        },
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    assert len(discovered) == 3
    for d in discovered:
        assert d.reason == "unknown_shape"
        assert d.spec is None


# ─────────────────────────────────────────────────────────────────────────────
# 18 — F4 literal secret warning names the key only
# ─────────────────────────────────────────────────────────────────────────────


def test_literal_secret_warning_names_the_key_only(tmp_data_home, _fake_home, monkeypatch):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _mark_claude_global_capable(monkeypatch, _fake_home / ".claude.json")
    token = "sk-supersecrettoken1234567890"
    _write_json(
        _fake_home / ".claude.json",
        {
            "mcpServers": {
                "foo": {
                    "type": "http",
                    "url": "https://example.test",
                    "headers": {"Authorization": f"Bearer {token}"},
                }
            }
        },
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    candidates = mcp_reconcile.classify(discovered, _registry(), set())
    assert len(candidates) == 1
    cand = candidates[0]
    assert cand["warnings"] == ["literal_secret:Authorization"]
    serialized = json.dumps(cand)
    assert token not in serialized


def test_literal_secret_in_url_query_is_redacted(tmp_data_home, _fake_home, monkeypatch):
    """C3: `secret_keys_in_spec` emits `url.query:<param>` for a flagged query
    string parameter — the URL itself must be rewritten too, not just the
    (nonexistent) header/env container."""
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _mark_claude_global_capable(monkeypatch, _fake_home / ".claude.json")
    token = "sk-supersecrettoken1234567890"
    _write_json(
        _fake_home / ".claude.json",
        {"mcpServers": {"foo": {"type": "http", "url": f"https://example.test/mcp?api_key={token}"}}},
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    candidates = mcp_reconcile.classify(discovered, _registry(), set())
    assert len(candidates) == 1
    cand = candidates[0]
    assert cand["warnings"] == ["literal_secret:url.query:api_key"]
    assert token not in cand["spec"]["url"]
    serialized = json.dumps(cand)
    assert token not in serialized


def test_unsupported_row_redacts_a_literal_header_too(tmp_data_home, _fake_home, monkeypatch):
    """C3: an `unsupported` row (spec is None) must not ship a raw native
    block whole — a `ws` entry's literal `Authorization` header is scanned
    blindly via `mcp_spec.looks_like_secret` since there is no spec to build
    `secret_keys_in_spec` from."""
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _mark_claude_global_capable(monkeypatch, _fake_home / ".claude.json")
    token = "sk-supersecrettoken1234567890"
    _write_json(
        _fake_home / ".claude.json",
        {
            "mcpServers": {
                "foo": {
                    "type": "ws",
                    "url": "wss://example.test",
                    "headers": {"Authorization": f"Bearer {token}"},
                }
            }
        },
    )
    discovered = mcp_reconcile.discover_native("global", None, _registry(), {"claude-code"})
    candidates = mcp_reconcile.classify(discovered, _registry(), set())
    assert len(candidates) == 1
    cand = candidates[0]
    assert cand["status"] == "unsupported"
    assert cand["reason"] == "ws_transport"
    serialized = json.dumps(cand)
    assert token not in serialized


# ─────────────────────────────────────────────────────────────────────────────
# 19 — unparseable native file is reported, not fatal
# ─────────────────────────────────────────────────────────────────────────────


def test_unparseable_native_file_is_reported_not_fatal(tmp_data_home, _fake_home, capsys):
    """E3 rev 2 (catalogue S14): an unparseable `~/.claude.json` is not just
    silently skipped — it becomes one `unreadable_file` CANDIDATE named
    after the file (N1: asserted on the CLASSIFIED row, never the raw
    `DiscoveredMcp` — a bare `.claude.json` name would be slug-mangled by
    `classify` into `claude-json`, indistinguishable from a real server
    registered under that name; `_unreadable_row` now names it
    `unreadable:<basename>` precisely so the mangled slug stays
    self-describing). Both `_read_claude_user` and
    `_read_claude_local_unregistered` read the same file and now BOTH
    surface it (N3) — `classify` merges the two `DiscoveredMcp` rows (same
    file, same slug) into ONE candidate with two `sources[]` entries, so
    the band still sees only one row, never a double report."""
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_text(_fake_home / ".claude.json", "{ not valid json")
    _write_text(_fake_home / ".codex" / "config.toml", '[mcp_servers.ok]\ncommand = "node"\n')

    registry = _registry()
    discovered = mcp_reconcile.discover_native("global", None, registry, {"claude-code", "codex"})
    candidates = mcp_reconcile.classify(discovered, registry, set())
    by_name = {c["name"]: c for c in candidates}
    assert set(by_name) == {"ok", "unreadable-claude-json"}

    cand = by_name["unreadable-claude-json"]
    assert cand["status"] == "unsupported"
    assert cand["reason"] == "unreadable_file"
    claude_json = str(_fake_home / ".claude.json")
    assert {s["file"] for s in cand["sources"]} == {claude_json}
    assert {s["name"] for s in cand["sources"]} == {"unreadable:.claude.json"}
    assert len(cand["sources"]) == 2  # _read_claude_user + _read_claude_local_unregistered
    err = capsys.readouterr().err
    assert "cannot parse" in err


def test_codex_file_with_tomlkit_missing_is_reported_not_silently_dropped(
    tmp_data_home, _fake_home, monkeypatch
):
    """N2: §2.1 names "a codex file with tomlkit missing" as an
    `unreadable_file` case — `_load_toml_or_unreadable` used to return an
    empty row list for it, indistinguishable from the file not existing."""
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses
    from skill_hub.infrastructure.mcp import mcp_reconcile

    codex_toml = _fake_home / ".codex" / "config.toml"
    _write_text(codex_toml, '[mcp_servers.ok]\ncommand = "node"\n')
    monkeypatch.setattr(mcp_reconcile, "_tomlkit_missing", lambda: True)
    # `_isolate_global_mcp` (autouse) nulls every harness's
    # `global_mcp_config` — restore codex's so the row does not misclassify
    # as `no_global_target` (checked before `unreadable_file` in `classify`,
    # same reason `test_mcp_import_corpus.py`'s own fixture restores it).
    patched = dict(harnesses.HARNESSES)
    patched["codex"] = dataclasses.replace(harnesses.HARNESSES["codex"], global_mcp_config=codex_toml)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    registry = _registry()
    discovered = mcp_reconcile.discover_native("global", None, registry, {"codex"})
    assert len(discovered) == 1
    row = discovered[0]
    assert row.reason == "unreadable_file"
    assert row.name == "unreadable:config.toml"
    assert row.file == str(codex_toml)

    candidates = mcp_reconcile.classify(discovered, registry, set())
    cand = next(c for c in candidates if c["reason"] == "unreadable_file")
    assert cand["status"] == "unsupported"
    assert {s["file"] for s in cand["sources"]} == {str(codex_toml)}


def test_claude_local_unreadable_at_project_scope_is_reported(tmp_path, tmp_data_home, _fake_home):
    """N3: at PROJECT scope, `_read_claude_local_for_project` is the ONLY
    reader of `~/.claude.json` in that discovery pass (`_read_claude_user`
    only runs at global scope) — it used to stay silent on a parse failure,
    hiding every project-local server behind a broken `~/.claude.json` with
    no `unreadable_file` row at all."""
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": {"path": str(proj), "enabled": [], "bundles": [], "harnesses": []}})
    _write_text(_fake_home / ".claude.json", "{ not valid json")

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code"}
    )
    assert len(discovered) == 1
    row = discovered[0]
    assert row.reason == "unreadable_file"
    assert row.scope == "local"
    assert row.name == "unreadable:.claude.json"

    candidates = mcp_reconcile.classify(discovered, registry, set())
    cand = next(c for c in candidates if c["reason"] == "unreadable_file")
    assert cand["status"] == "unsupported"


# ─────────────────────────────────────────────────────────────────────────────
# 20 — harness filter narrows discovery
# ─────────────────────────────────────────────────────────────────────────────


def test_harness_filter_narrows_discovery(tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    _write_json(_fake_home / ".claude.json", {"mcpServers": {"foo": {"command": "node"}}})
    _write_text(_fake_home / ".codex" / "config.toml", '[mcp_servers.bar]\ncommand = "python3"\n')

    discovered = mcp_reconcile.discover_native(
        "global", None, _registry(), {"claude-code", "codex"}, harness_filter="codex"
    )
    assert {d.name for d in discovered} == {"bar"}


# ─────────────────────────────────────────────────────────────────────────────
# 21 — kept decisions suppress a candidate and are listed (m3)
# ─────────────────────────────────────────────────────────────────────────────


def test_harness_not_installed_says_so(tmp_data_home, _fake_home, capsys):
    """catalogue G02 (E3.md §2.9): `--harness pi` when pi is not installed
    must say so, instead of silently discovering nothing."""
    import argparse

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core

    (hub_core.data_home()).mkdir(parents=True, exist_ok=True)
    (hub_core.data_home() / "registry.yaml").write_text(
        "skills: {}\nprojects: {}\nbundles: {}\nharnesses_global: [claude-code]\n"
    )
    args = argparse.Namespace(
        global_=True, project=None, harness="pi", json=False, apply=False, decisions_stdin=False
    )
    with pytest.raises(SystemExit):
        mcp_cli.cmd_mcp_reconcile(args)
    out = capsys.readouterr().out
    assert "pi" in out
    assert "not installed" in out


def test_kept_decisions_suppress_a_candidate_and_are_listed(
    tmp_data_home, _fake_home, capsys, monkeypatch
):
    import argparse

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core
    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setitem(
        harnesses.HARNESSES,
        "claude-code",
        dataclasses.replace(
            harnesses.HARNESSES["claude-code"],
            global_mcp_config=_fake_home / ".claude.json",
        ),
    )

    _write_json(_fake_home / ".claude.json", {"mcpServers": {"foo": {"command": "node"}}})
    (_fake_home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    (hub_core.data_home()).mkdir(parents=True, exist_ok=True)
    (hub_core.data_home() / "registry.yaml").write_text(
        "skills: {}\nprojects: {}\nbundles: {}\nharnesses_global: [claude-code]\n"
    )

    import io
    import sys as _sys

    decisions = {"decisions": [{"name": "foo", "action": "keep"}]}
    _sys.stdin = io.StringIO(json.dumps(decisions))
    args = argparse.Namespace(
        global_=True, project=None, harness=None, json=True, apply=True, decisions_stdin=True
    )
    mcp_cli.cmd_mcp_reconcile(args)
    capsys.readouterr()  # discard apply output

    args2 = argparse.Namespace(
        global_=True, project=None, harness=None, json=True, apply=False, decisions_stdin=False
    )
    mcp_cli.cmd_mcp_reconcile(args2)
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["kept"] == ["foo"]
    assert all(c["name"] != "foo" for c in payload["candidates"])

    args3 = argparse.Namespace(
        global_=True, project=None, harness=None, json=False, apply=False, decisions_stdin=False
    )
    mcp_cli.cmd_mcp_reconcile(args3)
    table = capsys.readouterr().out
    assert "foo" in table  # appears in the "kept (suppressed)" line


def test_kept_list_reports_one_parked_decision_once_under_its_slug(tmp_data_home):
    """N9: `_mcp_kept_names` (W9) widens a stored entry to raw ∪ slug so a
    stale-cased entry still suppresses its row — but that widened set is for
    MEMBERSHIP TESTS ONLY. The discovery payload's `kept` list must report
    each parked decision exactly once, under its canonical (slugified) name,
    not under both spellings."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.permissions import permissions

    scope = permissions.GlobalScope()
    mcp_cli._save_mcp_kept(scope, [{"name": "Sanity"}])

    names = mcp_cli._mcp_kept_names(scope)
    assert names == {"Sanity", "sanity"}  # membership set: unchanged (W9)

    display = mcp_cli._mcp_kept_display_names(scope)
    assert display == ["sanity"]  # reported list: one entry, one spelling


# ─────────────────────────────────────────────────────────────────────────────
# 22 — completeness over the reason vocabulary
# ─────────────────────────────────────────────────────────────────────────────


def test_every_unsupported_reason_is_in_the_interfaces_vocabulary():
    from skill_hub.infrastructure.mcp import mcp_reconcile

    assert mcp_reconcile.UNSUPPORTED_REASONS == frozenset(
        {
            "ws_transport",
            "oauth_block",
            "headers_helper",
            "unknown_shape",
            "local_scope_unregistered_project",
            "no_global_target",
            # E3 rev 2 (plans/E3.md §2.1/§2.2)
            "invalid_name",
            "name_taken",
            "unknown_transport",
            "transport_conflict",
            "no_endpoint",
            "malformed_url",
            "unsupported_url_scheme",
            "malformed_field",
            "duplicate_header",
            "disabled_upstream",
            "unreadable_file",
        }
    )


@pytest.mark.parametrize(
    "reason",
    ["ws_transport", "oauth_block", "headers_helper", "unknown_shape", "no_global_target"],
)
def test_bare_reason_words_are_in_vocabulary(reason):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    assert reason in mcp_reconcile.UNSUPPORTED_REASONS


def test_detailed_reason_bare_word_is_in_vocabulary():
    from skill_hub.infrastructure.mcp import mcp_reconcile

    reason = "local_scope_unregistered_project:/some/path"
    bare = reason.split(":", 1)[0]
    assert bare in mcp_reconcile.UNSUPPORTED_REASONS


# ─────────────────────────────────────────────────────────────────────────────
# 23 — discovery writes nothing
# ─────────────────────────────────────────────────────────────────────────────


def test_discovery_writes_nothing(tmp_path, tmp_data_home, _fake_home):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})

    claude_json = _fake_home / ".claude.json"
    codex_toml = proj / ".codex" / "config.toml"
    mcp_json = proj / ".mcp.json"
    opencode_json = proj / "opencode.json"

    _write_json(claude_json, {"mcpServers": {"foo": {"command": "node"}}})
    _write_text(codex_toml, '[mcp_servers.bar]\ncommand = "python3"\n')
    _write_json(mcp_json, {"mcpServers": {"baz": {"command": "ruby"}}})
    _write_json(opencode_json, {"mcp": {"qux": {"type": "local", "command": ["go"], "enabled": True}}})

    before = {p: p.read_bytes() for p in (claude_json, codex_toml, mcp_json, opencode_json)}
    registry_before = json.dumps(registry, sort_keys=True)

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code", "codex", "opencode"}
    )
    mcp_reconcile.classify(discovered, registry, set())

    for p, data in before.items():
        assert p.read_bytes() == data
    assert json.dumps(registry, sort_keys=True) == registry_before
