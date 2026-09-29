"""`hub_cli/mcp.py::_reconcile_apply_mcp` / `cmd_mcp_reconcile` — the
transaction (plans/D.md §5, cases 24-38).

`_reconcile_apply_mcp` runs a SCOPE-LIMITED mcp sync (`mcp_sync.sync_mcp_for_project`
/ `mcp_sync._run_global_mcp_dispatch`) after an import/remove, never the
whole-registry `hub._auto_sync()` (C2/D2). In the fake-home test environment
(no real harness marker dirs), `sync_mcp_for_project` recomputes its OWN
effective-harness set via `harnesses.resolve_effective(...)` (ignoring the
`installed` this file passes in) and finds it empty, so that call is a
harmless no-op unless a test sets up real marker dirs — the tests that need
to prove a native entry becomes hub-owned (25, 33) still do so by driving the
relevant adapter directly afterward, exactly as
`tests/test_mcp_project_ownership.py` does. `no_auto_sync` is kept as a
defense-in-depth safety net (nothing should call the full `hub._auto_sync`
from this path any more) but its counter is no longer asserted on.
"""

from __future__ import annotations

import json

import pytest


def _registry(**overrides) -> dict:
    base = {"skills": {}, "projects": {}, "bundles": {}, "harnesses_global": []}
    base.update(overrides)
    return base


def _proj_cfg(path) -> dict:
    return {"path": str(path), "enabled": [], "bundles": [], "harnesses": []}


def _write_json(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def _write_text(path, text) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _mark_claude_global_capable(monkeypatch, path) -> None:
    """See `tests/test_mcp_reconcile.py::_mark_claude_global_capable` — same
    reasoning, duplicated (not imported) to keep the two test files
    independent."""
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=path
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)


def _discover_and_classify(registry, scope_kind, proj_cfg, installed, *, proj_name=None, proj_root=None):
    from skill_hub.infrastructure.mcp import mcp_reconcile

    discovered = mcp_reconcile.discover_native(scope_kind, proj_cfg, registry, installed)
    managed = mcp_reconcile.managed_names(scope_kind, proj_name, proj_root)
    candidates = mcp_reconcile.classify(discovered, registry, managed)
    return discovered, candidates


@pytest.fixture(autouse=True)
def no_auto_sync(monkeypatch):
    """No in-process test may run a real sync pass — mirrors
    `tests/test_hub_mcp_cli.py::no_auto_sync`."""
    import hub

    calls = {"n": 0}
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.__setitem__("n", calls["n"] + 1))
    return calls


# ─────────────────────────────────────────────────────────────────────────────
# 24 — import registers a folder + registry entry and equips
# ─────────────────────────────────────────────────────────────────────────────


def test_import_registers_folder_entry_and_equips(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node", "args": ["x.js"]}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    decisions = [{"name": "foo", "action": "import"}]
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered, decisions, {"claude-code"}
    )

    assert summary["imported"] == ["foo"]
    dest = tmp_data_home / "mcp-servers" / "foo" / "SKILL.md"
    assert dest.exists()
    assert registry["skills"]["foo"]["mcp"]["command"] == "node"
    assert registry["skills"]["foo"]["mcp"]["args"] == ["x.js"]
    assert "foo" in registry["projects"]["demo"]["enabled"]
    # C2: an import runs the scope-limited sync (never `hub._auto_sync`).
    assert summary["synced"] is True


def test_import_registers_at_global_scope(tmp_data_home, _fake_home, no_auto_sync, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _mark_claude_global_capable(monkeypatch, _fake_home / ".claude.json")
    registry = _registry()
    _write_json(_fake_home / ".claude.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(registry, "global", None, {"claude-code"})
    decisions = [{"name": "foo", "action": "import"}]
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "global", None, None, candidates, discovered, decisions, {"claude-code"}
    )
    assert summary["imported"] == ["foo"]
    assert registry["skills"]["foo"]["scope"] == "global"
    assert summary["synced"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 25 — import makes the native entry hub-owned
# ─────────────────────────────────────────────────────────────────────────────


def test_import_makes_the_native_entry_hub_owned(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar
    from skill_hub.infrastructure.mcp import mcp_adapters

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    # The full canonical shape (args/env explicit) — required for the
    # adapter's no-sidecar "adopted" tier to recognize an exact match
    # (tests/test_mcp_project_ownership.py::test_first_run_adopts_identical_unclaimed_entries).
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node", "args": [], "env": {}}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    decisions = [{"name": "foo", "action": "import"}]
    mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered, decisions, {"claude-code"}
    )

    # Simulate "the following auto-sync": the adapter writes the ALREADY
    # on-disk entry (unchanged) and claims it since it now matches what the
    # registry says to write.
    spec = mcp_spec.spec_from_registry("foo", registry["skills"]["foo"])
    adapter = mcp_adapters.get_adapter("claude")
    adapter.write(proj, [spec], harness_id="claude-code", project_name="demo")

    scope = ProjectScope(name="demo", path=str(proj))
    sc = read_sidecar("claude-code", scope, kind="mcp")
    assert sc is not None
    assert "foo" in sc.managed_keys

    discovered2, candidates2 = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates2 if c["name"] == "foo")
    assert cand["status"] == "already_managed"


def test_import_claim_only_removes_a_claude_local_copy_instead_of_claiming_it(
    tmp_path, tmp_data_home, _fake_home, no_auto_sync
):
    """W10: an `already_managed`-but-not-yet-sidecar-claimed candidate
    (`import-claim-only`) must apply the SAME 2.3 scope rule every other
    import does — a Claude-LOCAL native copy (`~/.claude.json` →
    `projects.<abs>.mcpServers`, a file no per-project adapter writes) is
    REMOVED, never claimed into a project sidecar pointed at a file the sync
    tail can never rewrite.

    W11 (follow-up to W10): the source that IS writable at this scope
    (`.mcp.json`, a byte-identical match — that's what `already_managed`
    means) must be explicitly CLAIMED, not skipped — claiming a same-file
    match is the whole point of `import-claim-only` (N15); leaving it to the
    ordinary no-sidecar auto-adopt only works when no sidecar file exists yet
    (see the sidecar-present twin below)."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar

    proj = tmp_path / "proj"
    proj.mkdir()
    block = {"command": "node", "args": [], "env": {}}
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": block}},
    )
    registry["projects"]["demo"]["enabled"] = ["foo"]
    mcp_json = proj / ".mcp.json"
    _write_json(mcp_json, {"mcpServers": {"foo": block}})
    claude_json = _fake_home / ".claude.json"
    _write_json(claude_json, {"projects": {str(proj): {"mcpServers": {"foo": block}}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "already_managed"
    assert {s["scope"] for s in cand["sources"]} == {"project", "local"}

    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is None  # unclaimed — import-claim-only fires

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "import"}], {"claude-code"},
    )
    assert summary["removed_native"] == [{"harness": "claude-code", "scope": "local", "file": str(claude_json)}]
    assert summary["claimed"] == [{"harness": "claude-code", "scope": "project", "file": str(mcp_json)}]

    remaining = json.loads(claude_json.read_text())
    assert "foo" not in remaining.get("projects", {}).get(str(proj), {}).get("mcpServers", {})
    # The project-scope match is claimed, into the RIGHT file — never the
    # Claude-local file no adapter writes.
    sc = read_sidecar("claude-code", scope, kind="mcp")
    assert sc is not None
    assert "foo" in sc.managed_keys
    assert sc.file == str(mcp_json)


def test_import_claim_only_claims_a_same_file_match_even_when_a_sidecar_already_lists_others(
    tmp_path, tmp_data_home, _fake_home, no_auto_sync
):
    """W11: `import-claim-only` fires only for an `already_managed` candidate
    (registered AND the native block equals the registry block) whose name
    the sidecar does not yet list. When the block ALREADY matches, the
    ordinary "skip a matching source, the no-sidecar auto-adopt will pick it
    up next sync" rule claims NOTHING for it — but that fallback only ever
    fires when NO sidecar file exists yet. A project whose sidecar already
    exists (and simply omits this name — a second server, adopted
    separately) must still see the name claimed by this call, or the
    candidate reappears on every `hub mcp reconcile` forever (the exact N15
    failure `import-claim-only` exists to close)."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar, write_sidecar
    from skill_hub.infrastructure.mcp import mcp_reconcile

    proj = tmp_path / "proj"
    proj.mkdir()
    block = {"command": "node", "args": [], "env": {}}
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={
            "foo": {"type": "mcp-server", "scope": "portable", "mcp": block},
            "bar": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "other", "args": [], "env": {}}},
        },
    )
    registry["projects"]["demo"]["enabled"] = ["foo"]
    mcp_json = proj / ".mcp.json"
    _write_json(mcp_json, {"mcpServers": {"foo": block}})

    # A sidecar for this (harness, project) already exists — and lists only
    # `bar`, the OTHER registered server, not `foo`.
    scope = ProjectScope(name="demo", path=str(proj))
    write_sidecar("claude-code", scope, ["bar"], mcp_json, kind="mcp")

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "already_managed"
    managed = mcp_reconcile.managed_names("project", "demo", proj)
    assert "foo" not in managed  # -> pass 1 picks `import-claim-only`

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "import"}], {"claude-code"},
    )
    assert summary["claimed"] == [{"harness": "claude-code", "scope": "project", "file": str(mcp_json)}]

    sc = read_sidecar("claude-code", scope, kind="mcp")
    assert sc is not None
    assert set(sc.managed_keys) == {"bar", "foo"}


def test_import_claim_only_claims_nothing_at_global_scope(
    tmp_data_home, _fake_home, no_auto_sync, monkeypatch
):
    """W10 (2.3): the global-scope twin — `import-claim-only` must claim and
    remove nothing at global scope, same as every other import."""
    import dataclasses

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.harnesses import harnesses

    claude_json = _fake_home / ".claude.json"
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=claude_json
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    block = {"command": "node", "args": [], "env": {}}
    registry = _registry(skills={"foo": {"type": "mcp-server", "scope": "global", "mcp": block}})
    claude_json.parent.mkdir(parents=True, exist_ok=True)
    _write_json(claude_json, {"mcpServers": {"foo": block}})

    discovered, candidates = _discover_and_classify(registry, "global", None, {"claude-code"})
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "already_managed"

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "global", None, None, candidates, discovered,
        [{"name": "foo", "action": "import"}], {"claude-code"},
    )
    assert summary["removed_native"] == []
    assert summary["claimed"] == []


# ─────────────────────────────────────────────────────────────────────────────
# 26 — F5: import of an unclaimed conflict claims ownership
# ─────────────────────────────────────────────────────────────────────────────


def test_import_of_an_unclaimed_conflict_claims_ownership(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "nodeA"}}},
    )
    registry["projects"]["demo"]["enabled"] = ["foo"]
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "nodeB"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "conflict"
    assert any(o["harness"] == "registry" for o in cand["options"])

    decisions = [{"name": "foo", "action": "import", "harness": "registry"}]
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered, decisions, {"claude-code"}
    )
    assert summary["imported"] == ["foo"]
    # Registry's own definition is untouched.
    assert registry["skills"]["foo"]["mcp"]["command"] == "nodeA"
    # No new mcp-servers/foo/ folder was created (it was never re-registered).
    assert not (tmp_data_home / "mcp-servers" / "foo").exists()

    scope = ProjectScope(name="demo", path=str(proj))
    sc = read_sidecar("claude-code", scope, kind="mcp")
    assert sc is not None
    assert "foo" in sc.managed_keys

    discovered2, candidates2 = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand2 = next(c for c in candidates2 if c["name"] == "foo")
    assert cand2["status"] == "already_managed"


# ─────────────────────────────────────────────────────────────────────────────
# 27 — a conflict import requires a harness
# ─────────────────────────────────────────────────────────────────────────────


def test_import_of_a_conflict_requires_harness(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node", "args": ["a.js"]}}})
    _write_text(proj / ".codex" / "config.toml", '[mcp_servers.foo]\ncommand = "node"\nargs = ["b.js"]\n')

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code", "codex"},
        proj_name="demo", proj_root=proj,
    )

    with pytest.raises(SystemExit) as excinfo:
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "foo", "action": "import"}], {"claude-code", "codex"},
        )
    assert excinfo.value.code == 2  # W5
    assert "foo" not in registry.get("skills", {})

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "import", "harness": "codex"}], {"claude-code", "codex"},
    )
    assert summary["imported"] == ["foo"]
    assert registry["skills"]["foo"]["mcp"]["args"] == ["b.js"]


# ─────────────────────────────────────────────────────────────────────────────
# 28/29/30 — F4 literal secret handling at the import door
# ─────────────────────────────────────────────────────────────────────────────


def _literal_registry_and_files(tmp_path, token="sk-supersecrettoken1234567890"):
    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(
        proj / ".mcp.json",
        {
            "mcpServers": {
                "ctx7": {
                    "type": "http",
                    "url": "https://ctx7.example",
                    "headers": {"Authorization": f"Bearer {token}"},
                }
            }
        },
    )
    return proj, registry, token


def test_import_of_a_literal_candidate_is_refused_by_default(tmp_path, tmp_data_home, no_auto_sync, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj, registry, token = _literal_registry_and_files(tmp_path)
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )

    with pytest.raises(SystemExit) as excinfo:
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "ctx7", "action": "import"}], {"claude-code"},
        )
    assert excinfo.value.code == 2
    out = capsys.readouterr().out
    assert "Authorization" in out
    assert token not in out
    # W6: this door's two hatches, named — not `--allow-literal` (a flag this
    # command does not have; that message is reused wave-B/`hub mcp add` text).
    assert "allow_literal" in out
    assert "replace_with_ref" in out
    assert "--allow-literal" not in out
    assert "ctx7" not in registry.get("skills", {})


def test_import_with_replace_with_ref_rewrites_the_credential(tmp_path, tmp_data_home, no_auto_sync, capsys):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj, registry, token = _literal_registry_and_files(tmp_path)
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "ctx7", "action": "import", "replace_with_ref": True}], {"claude-code"},
    )
    assert summary["imported"] == ["ctx7"]
    auth = registry["skills"]["ctx7"]["mcp"]["headers"]["Authorization"]
    assert auth.startswith("Bearer ${")
    assert token not in json.dumps(registry)
    # W7: the response names the suggested variable so the caller can tell
    # the user what to export.
    assert summary["suggested_refs"] == [
        {"name": "ctx7", "key": "Authorization", "var": "CTX7_TOKEN"}
    ]
    assert token not in json.dumps(summary)


def test_import_with_allow_literal_sets_the_flag(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj, registry, token = _literal_registry_and_files(tmp_path)
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "ctx7", "action": "import", "allow_literal": True}], {"claude-code"},
    )
    assert summary["imported"] == ["ctx7"]
    entry = registry["skills"]["ctx7"]
    assert entry["mcp"]["allow_literal_secrets"] is True
    assert entry["mcp"]["headers"]["Authorization"] == f"Bearer {token}"


# ─────────────────────────────────────────────────────────────────────────────
# 31 — unknown decision action is fail-closed
# ─────────────────────────────────────────────────────────────────────────────


def test_unknown_decision_name_is_fail_closed(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    before = json.dumps(registry, sort_keys=True)

    with pytest.raises(SystemExit) as excinfo:
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "foo", "action": "bogus"}], {"claude-code"},
        )
    assert excinfo.value.code == 2
    assert json.dumps(registry, sort_keys=True) == before


def test_unknown_candidate_name_is_fail_closed(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "nonexistent", "action": "import"}], {"claude-code"},
        )
    assert excinfo.value.code == 2


def test_import_onto_a_non_mcp_skill_name_fails_closed(tmp_path, tmp_data_home, no_auto_sync):
    """W3: a name already registered under a NON-mcp-server type (an
    ordinary skill sharing the name with a discovered native server) must
    never be silently patched into holding an `mcp:` block — fail closed,
    exit 2, naming the collision.

    E3 rev 2 (catalogue N14) moves this check INTO `classify` itself — the
    candidate is `unsupported/name_taken:foo` before any decision is even
    made, so the band never renders an Adopt button for it; the apply-time
    refusal below (via the existing `status == "unsupported"` branch) stays
    a second, still-load-bearing line of defense for a caller that ignores
    the status and tries anyway."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "skill", "scope": "portable", "description": "an ordinary skill"}},
    )
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "unsupported"
    assert cand["reason"] == "name_taken:foo"

    before = json.dumps(registry, sort_keys=True)
    with pytest.raises(SystemExit) as excinfo:
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "foo", "action": "import"}], {"claude-code"},
        )
    assert excinfo.value.code == 2
    assert json.dumps(registry, sort_keys=True) == before
    assert registry["skills"]["foo"]["type"] == "skill"
    assert "mcp" not in registry["skills"]["foo"]


def test_as_override_onto_an_existing_mcp_server_is_refused_name_taken(tmp_path, tmp_data_home, no_auto_sync):
    """C2 — `as` must not bypass the §2.2 `name_taken` rule when the target
    is an existing, UNRELATED registered MCP server: pass 1 used to refuse
    only a non-mcp-server collision, so an `as` onto another server's slug
    took the `claim_only` branch in pass 2 and silently overwrote it. Fixed
    by requiring the resolved import name to be this candidate's OWN slug
    before `claim_only` is ever considered."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        skills={
            "context7": {
                "type": "mcp-server",
                "scope": "portable",
                "mcp": {"transport": "http", "url": "https://context7.example/mcp"},
            }
        },
        projects={"demo": _proj_cfg(proj)},
    )
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    before = json.dumps(registry, sort_keys=True)

    with pytest.raises(SystemExit) as excinfo:
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "foo", "action": "import", "as": "context7"}], {"claude-code"},
        )
    assert excinfo.value.code == 2
    assert json.dumps(registry, sort_keys=True) == before
    assert registry["skills"]["context7"]["mcp"]["url"] == "https://context7.example/mcp"


def test_folder_collision_via_as_is_name_taken_not_a_bare_exit(tmp_path, tmp_data_home, no_auto_sync):
    """W2 — an `as` target with a leftover `mcp-servers/<slug>/` folder but
    no registry entry must refuse `name_taken` in pass 1, not reach
    `_register_mcp_skill`'s bare-text `dest.exists()` `fail()` mid
    -transaction."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.skills import skill_meta

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})
    (skill_meta.hub_mcp_servers_dir() / "context7").mkdir(parents=True)

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    before = json.dumps(registry, sort_keys=True)

    mcp_cli._json_mode = True
    try:
        with pytest.raises(SystemExit) as excinfo:
            mcp_cli._reconcile_apply_mcp(
                registry, "project", "demo", proj, candidates, discovered,
                [{"name": "foo", "action": "import", "as": "context7"}], {"claude-code"},
            )
    finally:
        mcp_cli._json_mode = False
    assert excinfo.value.code == 2
    assert json.dumps(registry, sort_keys=True) == before


# ─────────────────────────────────────────────────────────────────────────────
# C1 — `remove` is backup-first + atomic + trailing-newline preserving, one
# test per harness/scope (Claude project, Claude local, Codex, opencode)
# ─────────────────────────────────────────────────────────────────────────────


def _backup_files(tmp_data_home, harness_id, ext):
    from skill_hub import hub_core

    root = hub_core.data_home() / "_hub-backups" / "permissions" / harness_id
    return list(root.rglob(f"*.{ext}")) if root.is_dir() else []


def test_remove_claude_project_scope_is_backup_first_and_atomic(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "node"}}},
    )
    mcp_json = proj / ".mcp.json"
    original = json.dumps({"mcpServers": {"foo": {"command": "node"}}, "other": 1}, indent=2)
    mcp_json.write_text(original)  # no trailing newline, deliberately

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "stale"

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "remove"}], {"claude-code"},
    )
    assert summary["removed"] == ["foo"]
    assert summary["errors"] == []

    data = json.loads(mcp_json.read_text())
    assert "foo" not in data.get("mcpServers", {})
    assert data["other"] == 1
    assert not mcp_json.read_text().endswith("\n")  # trailing-newline state preserved

    backups = _backup_files(tmp_data_home, "claude-code", "json")
    assert len(backups) == 1
    assert json.loads(backups[0].read_text()) == json.loads(original)


def test_remove_on_a_stale_candidate_with_a_non_slug_native_key_actually_deletes_it(
    tmp_path, tmp_data_home, no_auto_sync
):
    """W3: `classify` groups by the case-folded SLUG, so a stale candidate's
    resolved `name` ('sanity') can differ from the file's own native key
    ('Sanity'). `_mcp_remove_native_entry` used to delete by the resolved
    name — a silent no-op — while still reporting `removed: ['sanity']`."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"sanity": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "npx"}}},
    )
    mcp_json = proj / ".mcp.json"
    _write_json(mcp_json, {"mcpServers": {"Sanity": {"command": "npx"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "sanity")
    assert cand["status"] == "stale"
    assert [s["name"] for s in cand["sources"]] == ["Sanity"]

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "sanity", "action": "remove"}], {"claude-code"},
    )
    assert summary["removed"] == ["sanity"]
    assert summary["errors"] == []
    still = json.loads(mcp_json.read_text())["mcpServers"]
    assert "Sanity" not in still


def test_remove_on_a_stale_candidate_that_truly_misses_reports_an_error_not_a_removal(
    tmp_path, tmp_data_home, no_auto_sync
):
    """W3/W6: when a source's own native key genuinely is not found (the
    file changed underneath hub between discovery and apply), the miss lands
    in `errors[]` and `removed` never claims it."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "node"}}},
    )
    mcp_json = proj / ".mcp.json"
    _write_json(mcp_json, {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "stale"

    # The file changed out from under hub between discovery and apply.
    _write_json(mcp_json, {"mcpServers": {}})

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "remove"}], {"claude-code"},
    )
    assert summary["removed"] == []
    assert summary["errors"], "a genuine miss must be reported, not silently dropped"


def test_remove_claude_local_scope_is_backup_first_and_atomic(
    tmp_path, tmp_data_home, _fake_home, no_auto_sync
):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "node"}}},
    )
    claude_json = _fake_home / ".claude.json"
    original = (
        json.dumps({"projects": {str(proj): {"mcpServers": {"foo": {"command": "node"}}}}}, indent=2)
        + "\n"
    )  # WITH a trailing newline this time
    claude_json.write_text(original)

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "stale"
    assert cand["sources"][0]["scope"] == "local"

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "remove"}], {"claude-code"},
    )
    assert summary["removed"] == ["foo"]
    assert summary["errors"] == []

    data = json.loads(claude_json.read_text())
    assert "foo" not in data["projects"][str(proj)]["mcpServers"]
    assert claude_json.read_text().endswith("\n")

    backups = _backup_files(tmp_data_home, "claude-code", "json")
    assert len(backups) == 1


def test_remove_codex_is_backup_first_and_atomic(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"bar": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "python3"}}},
    )
    codex_toml = proj / ".codex" / "config.toml"
    codex_toml.parent.mkdir(parents=True)
    original = '[mcp_servers.bar]\ncommand = "python3"\n'
    codex_toml.write_text(original)

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"codex"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "bar")
    assert cand["status"] == "stale"

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "bar", "action": "remove"}], {"codex"},
    )
    assert summary["removed"] == ["bar"]
    assert summary["errors"] == []

    import tomlkit

    doc = tomlkit.parse(codex_toml.read_text())
    assert "bar" not in (doc.get("mcp_servers") or {})
    assert codex_toml.read_text().endswith("\n")

    backups = _backup_files(tmp_data_home, "codex", "toml")
    assert len(backups) == 1


def test_remove_opencode_is_backup_first_and_atomic(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"baz": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "ruby"}}},
    )
    opencode_json = proj / "opencode.json"
    original = json.dumps(
        {"mcp": {"baz": {"type": "local", "command": ["ruby"], "enabled": True}}}, indent=2
    )
    opencode_json.write_text(original)  # no trailing newline

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"opencode"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "baz")
    assert cand["status"] == "stale"

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "baz", "action": "remove"}], {"opencode"},
    )
    assert summary["removed"] == ["baz"]
    assert summary["errors"] == []

    data = json.loads(opencode_json.read_text())
    assert "baz" not in data.get("mcp", {})
    assert not opencode_json.read_text().endswith("\n")

    backups = _backup_files(tmp_data_home, "opencode", "json")
    assert len(backups) == 1


# ─────────────────────────────────────────────────────────────────────────────
# C2 — the two residues the review reproduced now show clean state
# ─────────────────────────────────────────────────────────────────────────────


def test_rollback_restores_an_f5_registry_claim_sidecar(tmp_path, tmp_data_home, monkeypatch):
    """C2 residue (a): an F5 `harness: "registry"` claim writes a sidecar
    MID-transaction; if the sync tail then fails, that sidecar claim must be
    undone too — otherwise the "rolled back" registry would disagree with a
    native entry hub still believes it owns, and the next real sync would
    silently overwrite the user's restored (different) entry."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.application.sync import mcp_sync
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "nodeA"}}},
    )
    registry["projects"]["demo"]["enabled"] = ["foo"]
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "nodeB"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "conflict"

    def _boom(*a, **k):
        raise RuntimeError("simulated sync failure")

    monkeypatch.setattr(mcp_sync, "sync_mcp_for_project", _boom)

    with pytest.raises(RuntimeError):
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "foo", "action": "import", "harness": "registry"}], {"claude-code"},
        )

    scope = ProjectScope(name="demo", path=str(proj))
    assert read_sidecar("claude-code", scope, kind="mcp") is None
    assert registry["skills"]["foo"]["mcp"]["command"] == "nodeA"


def test_rollback_restores_an_f5_registry_claim_sidecar_at_global_scope(
    tmp_data_home, _fake_home, monkeypatch
):
    """C3 — the GLOBAL-scope twin of the test above. The rollback snapshot
    used to widen only for `scope_kind == "project"`, so a global F5 claim's
    `state/<h>/global-mcp.managed.json` sidecar survived a rolled-back
    transaction — a later ordinary `hub sync` would then read that sidecar
    as `prior_managed` and DELETE the user's own restored global entry
    (`mcp_adapters.py` deletes every `prior_managed` name not represented).
    Regression for the D-review C2 shape reopened at global scope."""
    import dataclasses

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.application.sync import mcp_sync
    from skill_hub.infrastructure.harnesses import harnesses

    claude_json = _fake_home / ".claude.json"
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        harnesses.HARNESSES["claude-code"], global_mcp_config=claude_json
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    registry = _registry(skills={"foo": {"type": "mcp-server", "scope": "global", "mcp": {"command": "nodeA"}}})
    claude_json.parent.mkdir(parents=True, exist_ok=True)
    _write_json(claude_json, {"mcpServers": {"foo": {"command": "nodeB"}}})

    discovered, candidates = _discover_and_classify(registry, "global", None, {"claude-code"})
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "conflict"
    assert any(o["harness"] == "registry" for o in cand["options"]), cand["options"]

    sidecar = tmp_data_home / "state" / "claude-code" / "global-mcp.managed.json"
    assert not sidecar.exists()

    def _boom(*a, **k):
        raise RuntimeError("simulated sync failure")

    monkeypatch.setattr(mcp_sync, "_run_global_mcp_dispatch", _boom)

    with pytest.raises(RuntimeError):
        mcp_cli._reconcile_apply_mcp(
            registry, "global", None, None, candidates, discovered,
            [{"name": "foo", "action": "import", "harness": "registry"}], {"claude-code"},
        )

    assert not sidecar.exists(), "global F5 claim sidecar survived the rollback"
    assert registry["skills"]["foo"]["mcp"]["command"] == "nodeA"
    assert json.loads(claude_json.read_text())["mcpServers"]["foo"]["command"] == "nodeB"


def test_rollback_restores_a_removed_stale_entry_when_a_later_import_fails(
    tmp_path, tmp_data_home, monkeypatch
):
    """C2 residue (b): a batch of `[remove <stale>, import <succeeds-then-
    sync-fails>]` must restore the removed entry too — the rollback snapshot
    must include every `sources[].file` named by ANY resolved decision, not
    only `_scope_mcp_native_files`'s fixed file list."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.application.sync import mcp_sync

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "node"}}},
    )
    mcp_json = proj / ".mcp.json"
    _write_json(mcp_json, {"mcpServers": {"foo": {"command": "node"}}})
    before_bytes = mcp_json.read_bytes()

    codex_toml = proj / ".codex" / "config.toml"
    codex_toml.parent.mkdir(parents=True)
    codex_toml.write_text('[mcp_servers.bar]\ncommand = "python3"\nargs = []\nenv = {}\n')

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code", "codex"},
        proj_name="demo", proj_root=proj,
    )
    foo = next(c for c in candidates if c["name"] == "foo")
    assert foo["status"] == "stale"
    bar = next(c for c in candidates if c["name"] == "bar")
    assert bar["status"] == "new"

    def _boom(*a, **k):
        raise RuntimeError("simulated sync failure")

    monkeypatch.setattr(mcp_sync, "sync_mcp_for_project", _boom)

    with pytest.raises(RuntimeError):
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "foo", "action": "remove"}, {"name": "bar", "action": "import"}],
            {"claude-code", "codex"},
        )

    assert mcp_json.read_bytes() == before_bytes
    assert "bar" not in registry.get("skills", {})
    assert not (tmp_data_home / "mcp-servers" / "bar").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 32 — rollback on failure
# ─────────────────────────────────────────────────────────────────────────────


def test_apply_rolls_back_registry_and_native_files_on_failure(tmp_path, tmp_data_home, monkeypatch):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.application.sync import mcp_sync

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    mcp_json = proj / ".mcp.json"
    _write_json(mcp_json, {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )

    before_bytes = mcp_json.read_bytes()
    before_registry = json.dumps(registry, sort_keys=True)

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated sync failure")

    # C2/D2: the transaction's sync tail is the SCOPE-LIMITED
    # `mcp_sync.sync_mcp_for_project`, never `hub._auto_sync`.
    monkeypatch.setattr(mcp_sync, "sync_mcp_for_project", _boom)

    with pytest.raises(RuntimeError):
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered,
            [{"name": "foo", "action": "import"}], {"claude-code"},
        )

    assert json.dumps(registry, sort_keys=True) == before_registry
    assert mcp_json.read_bytes() == before_bytes
    assert not (tmp_data_home / "mcp-servers" / "foo").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 33 — M7b: apply is idempotent per harness
# ─────────────────────────────────────────────────────────────────────────────


def test_apply_is_idempotent_per_harness(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_adapters

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    # Full canonical shapes — required for each adapter's no-sidecar "adopted"
    # tier to recognize an exact match (tests/test_mcp_project_ownership.py).
    _write_json(proj / ".mcp.json", {"mcpServers": {"s-claude": {"command": "node", "args": [], "env": {}}}})
    _write_text(
        proj / ".codex" / "config.toml",
        '[mcp_servers.s-codex]\ncommand = "python3"\nargs = []\nenv = {}\n',
    )
    _write_json(
        proj / "opencode.json",
        {"mcp": {"s-opencode": {"type": "local", "command": ["ruby"], "enabled": True}}},
    )

    installed = {"claude-code", "codex", "opencode"}
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], installed, proj_name="demo", proj_root=proj
    )
    decisions = [
        {"name": "s-claude", "action": "import"},
        {"name": "s-codex", "action": "import"},
        {"name": "s-opencode", "action": "import"},
    ]
    mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered, decisions, installed
    )

    adapter_map = {"s-claude": "claude", "s-codex": "codex", "s-opencode": "opencode"}
    for name, key in adapter_map.items():
        spec = mcp_spec.spec_from_registry(name, registry["skills"][name])
        adapter = mcp_adapters.get_adapter(key)
        adapter.write(proj, [spec], harness_id=("claude-code" if key == "claude" else key), project_name="demo")

    discovered2, candidates2 = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], installed, proj_name="demo", proj_root=proj
    )
    statuses = {c["name"]: c["status"] for c in candidates2 if c["name"] in adapter_map}
    assert statuses == {"s-claude": "already_managed", "s-codex": "already_managed", "s-opencode": "already_managed"}

    # A second identical apply is a pure no-op (already_managed → import-noop).
    summary2 = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates2, discovered2, decisions, installed
    )
    assert summary2["imported"] == []
    assert sorted(summary2["skipped"]) == sorted(adapter_map)


# ─────────────────────────────────────────────────────────────────────────────
# 34/35/36 — m3: the kept store
# ─────────────────────────────────────────────────────────────────────────────


def test_keep_writes_the_permissions_shaped_store(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    by_name = {c["name"]: c for c in candidates}
    scope = mcp_cli._mcp_scope("project", "demo", proj)
    kept_now, unkept_now = mcp_cli._record_mcp_kept_decisions(
        scope, [{"name": "foo", "action": "keep"}], by_name
    )
    assert kept_now == ["foo"]
    assert unkept_now == []

    path = hub_core.data_home() / "state" / "reconcile" / "project-demo.mcp.kept.json"
    assert path.exists()
    body = json.loads(path.read_text())
    assert body["schema_version"] == 1
    assert body["kept"] == [{"name": "foo", "source_file": str(proj / ".mcp.json")}]


def test_unkeep_lifts_a_keep(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    by_name = {c["name"]: c for c in candidates}
    scope = mcp_cli._mcp_scope("project", "demo", proj)
    mcp_cli._record_mcp_kept_decisions(scope, [{"name": "foo", "action": "keep"}], by_name)
    assert mcp_cli._mcp_kept_names(scope) == {"foo"}

    kept_now, unkept_now = mcp_cli._record_mcp_kept_decisions(
        scope, [{"name": "foo", "action": "unkeep"}], by_name
    )
    assert unkept_now == ["foo"]
    assert mcp_cli._mcp_kept_names(scope) == set()

    _, candidates2 = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    assert any(c["name"] == "foo" for c in candidates2)


def test_kept_store_entry_with_a_stale_raw_case_still_suppresses_the_slug_row(
    tmp_path, tmp_data_home, no_auto_sync
):
    """W9: `classify` groups by the CASE-FOLDED SLUG, so a candidate's `name`
    is always a slug (`sanity`) — but an entry parked in the kept store
    BEFORE that change (or by hand) can still hold the raw pre-slugify
    string (`Sanity`). It must still suppress the `sanity` row."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"Sanity": {"command": "npx"}}})

    scope = mcp_cli._mcp_scope("project", "demo", proj)
    path = hub_core.data_home() / "state" / "reconcile" / "project-demo.mcp.kept.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema_version": 1, "kept": [{"name": "Sanity", "source_file": None}]}))

    assert "sanity" in mcp_cli._mcp_kept_names(scope)

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    assert any(c["name"] == "sanity" for c in candidates)
    kept_names = mcp_cli._mcp_kept_names(scope)
    visible = [c for c in candidates if c["name"] not in kept_names]
    assert not any(c["name"] == "sanity" for c in visible)


def test_unkeep_reaches_a_stale_raw_case_entry_by_its_slug(tmp_path, tmp_data_home, no_auto_sync):
    """W9: `unkeep` on the current slug ('sanity') must lift a kept entry
    stored under the raw pre-slugify name ('Sanity')."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core

    proj = tmp_path / "proj"
    proj.mkdir()
    scope = mcp_cli._mcp_scope("project", "demo", proj)
    path = hub_core.data_home() / "state" / "reconcile" / "project-demo.mcp.kept.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema_version": 1, "kept": [{"name": "Sanity", "source_file": None}]}))
    assert mcp_cli._mcp_kept_names(scope) == {"Sanity", "sanity"}

    kept_now, unkept_now = mcp_cli._record_mcp_kept_decisions(
        scope, [{"name": "sanity", "action": "unkeep"}], {}
    )
    assert unkept_now == ["sanity"]
    assert mcp_cli._mcp_kept_names(scope) == set()
    assert json.loads(path.read_text())["kept"] == []


def test_skip_writes_nothing_and_the_candidate_returns(tmp_path, tmp_data_home, no_auto_sync):
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    before = json.dumps(registry, sort_keys=True)
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "skip"}], {"claude-code"},
    )
    assert summary["skipped"] == ["foo"]
    assert summary["imported"] == []
    assert json.dumps(registry, sort_keys=True) == before

    _, candidates2 = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    assert any(c["name"] == "foo" for c in candidates2)


def test_skip_only_batch_writes_no_registry_file_and_reports_unsynced(tmp_path, tmp_data_home, no_auto_sync):
    """W9: a batch of only skip/keep/unkeep decisions must not call
    `save_registry` or run any sync at all. Case 36's own comparison was of
    the in-memory dict (which `skip` never mutates regardless), so it could
    not tell a skipped `save_registry` from a called one — this compares the
    ON-DISK `registry.yaml` bytes instead."""
    import yaml

    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})
    registry_path = tmp_data_home / "registry.yaml"
    registry_path.write_text(yaml.safe_dump(registry, sort_keys=False))
    before_bytes = registry_path.read_bytes()

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "skip"}], {"claude-code"},
    )
    assert summary["synced"] is False
    assert registry_path.read_bytes() == before_bytes


# ─────────────────────────────────────────────────────────────────────────────
# 37/38 — the CLI wiring: JSON payload shape + the lock/audit contract
# ─────────────────────────────────────────────────────────────────────────────


def _seed_cli_registry(tmp_data_home, registry):
    import yaml

    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def test_apply_json_payload_shape(tmp_path, tmp_data_home, _fake_home, no_auto_sync, capsys):
    import argparse
    import io
    import sys as _sys

    import skill_hub.entrypoints.cli.mcp as mcp_cli

    (_fake_home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})
    _seed_cli_registry(tmp_data_home, registry)

    _sys.stdin = io.StringIO(json.dumps({"decisions": [{"name": "foo", "action": "import"}]}))
    args = argparse.Namespace(
        global_=False, project="demo", harness=None, json=True, apply=True, decisions_stdin=True
    )
    mcp_cli.cmd_mcp_reconcile(args)
    out = json.loads(capsys.readouterr().out)

    assert out["ok"] is True
    assert out["imported"] == ["foo"]
    assert out["kept"] == []
    assert out["unkept"] == []
    assert out["skipped"] == []
    assert out["conflicts_resolved"] == 0
    assert out["synced"] is True
    assert out["errors"] == []


def test_apply_takes_the_data_home_lock_and_audits(tmp_path, tmp_data_home, _fake_home, no_auto_sync, capsys):
    import argparse
    import io
    import sys as _sys

    import skill_hub.entrypoints.cli.mcp as mcp_cli

    (_fake_home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})
    _seed_cli_registry(tmp_data_home, registry)

    audit_path = tmp_data_home / "state" / "audit.jsonl"

    # Discovery-only run: no audit record.
    args_discovery = argparse.Namespace(
        global_=False, project="demo", harness=None, json=True, apply=False, decisions_stdin=False
    )
    mcp_cli.cmd_mcp_reconcile(args_discovery)
    capsys.readouterr()
    assert not audit_path.exists() or "mcp-reconcile-apply" not in audit_path.read_text()

    _sys.stdin = io.StringIO(json.dumps({"decisions": [{"name": "foo", "action": "import"}]}))
    args_apply = argparse.Namespace(
        global_=False, project="demo", harness=None, json=True, apply=True, decisions_stdin=True
    )
    mcp_cli.cmd_mcp_reconcile(args_apply)
    capsys.readouterr()

    assert audit_path.exists()
    lines = [json.loads(line) for line in audit_path.read_text().splitlines() if line.strip()]
    matches = [rec for rec in lines if rec.get("verb") == "mcp-reconcile-apply"]
    assert len(matches) == 1
    assert matches[0]["target"]["imported"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# E3 rev 2 (`plans/E3.md` §5, cases 3-12) — slugify-on-import, the 2.2/2.3
# scope rule, `as`, `--json` failure codes.
# ─────────────────────────────────────────────────────────────────────────────


def test_command_and_url_decision_is_invalid_spec_transport_conflict(tmp_path, tmp_data_home, no_auto_sync, capsys):
    """§5 case 3 — the sync-bricking regression: a `command`+`url` decision
    now refuses at classify time (`unsupported/transport_conflict`) and the
    apply's own `unsupported` refusal is `_die`-wrapped as JSON."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"bad": {"command": "npx", "url": "https://h/mcp"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "bad")
    assert cand["status"] == "unsupported"
    assert cand["reason"] == "transport_conflict"

    before = json.dumps(registry, sort_keys=True)
    mcp_cli._json_mode = True
    try:
        with pytest.raises(SystemExit) as excinfo:
            mcp_cli._reconcile_apply_mcp(
                registry, "project", "demo", proj, candidates, discovered,
                [{"name": "bad", "action": "import"}], {"claude-code"},
            )
    finally:
        mcp_cli._json_mode = False
    assert excinfo.value.code == 2
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert out["code"] == "invalid_spec"
    assert out["reason"] == "transport_conflict"
    assert json.dumps(registry, sort_keys=True) == before


def test_import_of_sanity_renames_and_removes_native_at_global_scope(
    tmp_data_home, _fake_home, no_auto_sync, monkeypatch
):
    """§5 case 4 — `Sanity` registers as `sanity`, its native entry is
    removed (backup-first), `renamed`/`removed_native` name it, `claimed`
    stays empty, and a second discovery shows no more `Sanity`/native-name
    row at all (only `sanity`, `already_managed`)."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _mark_claude_global_capable(monkeypatch, _fake_home / ".claude.json")
    registry = _registry()
    claude_json = _fake_home / ".claude.json"
    _write_json(claude_json, {"mcpServers": {"Sanity": {"command": "npx"}}})

    discovered, candidates = _discover_and_classify(registry, "global", None, {"claude-code"})
    cand = next(c for c in candidates if c["name"] == "sanity")
    assert cand["import_name"] == "sanity"
    assert cand["sources"][0]["name"] == "Sanity"

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "global", None, None, candidates, discovered,
        [{"name": "sanity", "action": "import"}], {"claude-code"},
    )
    assert summary["imported"] == ["sanity"]
    assert summary["renamed"] == [{"from": "Sanity", "to": "sanity"}]
    assert summary["removed_native"] == [{"harness": "claude-code", "scope": "user", "file": str(claude_json)}]
    assert summary["claimed"] == []
    assert (tmp_data_home / "mcp-servers" / "sanity" / "SKILL.md").exists()

    data = json.loads(claude_json.read_text())
    assert "Sanity" not in (data.get("mcpServers") or {})

    discovered2, candidates2 = _discover_and_classify(registry, "global", None, {"claude-code"})
    assert all(src.get("name") != "Sanity" for c in candidates2 for src in c.get("sources", []))
    cand2 = next(c for c in candidates2 if c["name"] == "sanity")
    assert cand2["status"] == "already_managed"


def test_import_of_sanity_at_project_scope_gets_a_delivery_row(
    tmp_path, tmp_data_home, _fake_home, no_auto_sync, monkeypatch
):
    """§5 case 4 (project-scope variant) — the scope-limited sync tail's
    delivery row for the renamed server is `written` (or, absent Claude
    project approval, `blocked/claude_project_not_approved`) — never silently
    missing.

    W8: the ORIGINAL version of this test built a `_spy` wrapper around
    `mcp_sync.sync_mcp_for_project` but never installed it via
    `monkeypatch.setattr` — `captured_report` was therefore always empty and
    the `if proj_report:` guard always false, so the delivery-row assertion
    never ran. Fixed by actually wiring the spy AND seeding a real Claude
    Code marker dir (`~/.claude/projects`, via `_fake_home`) plus
    `harnesses_global`, so `resolve_effective` (which `sync_mcp_for_project`
    calls with no `installed` override) sees claude-code as installed and a
    report is genuinely produced — the same seeding
    `tests/test_hooks_stream.py`/the module's own docstring describe."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    (_fake_home / ".claude" / "projects").mkdir(parents=True)

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(
        projects={"demo": _proj_cfg(proj)},
        harnesses_global=["claude-code"],
    )
    _write_json(proj / ".mcp.json", {"mcpServers": {"Sanity": {"command": "npx"}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "sanity")
    assert cand is not None

    from skill_hub.application.sync import mcp_sync as mcp_sync_mod

    orig_sync = mcp_sync_mod.sync_mcp_for_project
    captured_report: dict = {}

    def _spy(*args, **kwargs):
        result = orig_sync(*args, **kwargs)
        captured_report.update(kwargs.get("report") or (args[4] if len(args) > 4 else {}))
        return result

    monkeypatch.setattr(mcp_sync_mod, "sync_mcp_for_project", _spy)

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "sanity", "action": "import"}], {"claude-code"},
    )
    assert summary["renamed"] == [{"from": "Sanity", "to": "sanity"}]
    assert summary["synced"] is True

    proj_report = captured_report.get("projects", {}).get("demo")
    assert proj_report is not None, "the spy never ran — sync_mcp_for_project was not actually called"
    rows = proj_report.get("mcp_delivery") or []
    sanity_rows = [row for row in rows if row.get("server") == "sanity"]
    assert sanity_rows, f"no delivery row for 'sanity' in {rows!r}"
    for row in sanity_rows:
        assert row["state"] in ("written", "blocked")
        if row["state"] == "blocked":
            assert row["reason"] == "claude_project_not_approved"


def test_as_override_with_replace_with_ref_derives_var_from_resolved_name(tmp_path, tmp_data_home, no_auto_sync):
    """§5 case 5 — `as` overrides the registry key; the suggested `${VAR}`
    is derived from the RESOLVED name, and the stored block references that
    same var (grill finding 11)."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj, registry, token = _literal_registry_and_files(tmp_path)
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "ctx7", "action": "import", "as": "sanity-api", "replace_with_ref": True}], {"claude-code"},
    )
    assert summary["imported"] == ["sanity-api"]
    assert summary["suggested_refs"] == [{"name": "sanity-api", "key": "Authorization", "var": "SANITY_API_TOKEN"}]
    auth = registry["skills"]["sanity-api"]["mcp"]["headers"]["Authorization"]
    assert auth == "Bearer ${SANITY_API_TOKEN}"
    assert token not in json.dumps(registry)


def test_as_override_invalid_name_is_json_invalid_name(tmp_path, tmp_data_home, no_auto_sync, capsys):
    """§5 case 5 — `as: "Bad Name"` exits 2 with `code: invalid_name`."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    mcp_cli._json_mode = True
    try:
        with pytest.raises(SystemExit) as excinfo:
            mcp_cli._reconcile_apply_mcp(
                registry, "project", "demo", proj, candidates, discovered,
                [{"name": "foo", "action": "import", "as": "Bad Name"}], {"claude-code"},
            )
    finally:
        mcp_cli._json_mode = False
    assert excinfo.value.code == 2
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert out["code"] == "invalid_name"


def test_project_conflict_claims_the_codex_loser_and_a_second_sync_is_stable(tmp_path, tmp_data_home, no_auto_sync):
    """§5 case 6 — Claude's project copy wins; Codex's project copy (a file
    ITS OWN adapter writes at this scope) is CLAIMED, not removed; a driven
    `sync_mcp_for_project` rewrites it to the chosen spec, and a second
    identical sync leaves it byte-stable."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.mcp import mcp_spec as mcp_spec_mod
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar
    from skill_hub.infrastructure.mcp import mcp_adapters

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "nodeA"}}})
    codex_config = proj / ".codex" / "config.toml"
    _write_text(codex_config, '[mcp_servers.foo]\ncommand = "nodeB"\n')

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code", "codex"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "conflict"

    decisions = [{"name": "foo", "action": "import", "harness": "claude-code"}]
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered, decisions, {"claude-code", "codex"}
    )
    assert summary["imported"] == ["foo"]
    assert summary["claimed"] == [{"harness": "codex", "scope": "project", "file": str(codex_config)}]
    assert summary["removed_native"] == []
    assert registry["skills"]["foo"]["mcp"]["command"] == "nodeA"

    scope = ProjectScope(name="demo", path=str(proj))
    sc = read_sidecar("codex", scope, kind="mcp")
    assert sc is not None
    assert "foo" in sc.managed_keys

    spec = mcp_spec_mod.spec_from_registry("foo", registry["skills"]["foo"])
    adapter = mcp_adapters.get_adapter("codex")
    adapter.write(proj, [spec], harness_id="codex", project_name="demo")
    text = codex_config.read_text()
    assert "nodeA" in text
    assert "nodeB" not in text

    adapter.write(proj, [spec], harness_id="codex", project_name="demo")
    assert codex_config.read_text() == text


def test_project_import_from_claude_local_only_removes_it(tmp_path, tmp_data_home, _fake_home, no_auto_sync):
    """§5 case 7 — a project-scope import whose ONLY discovered copy is
    Claude LOCAL is removed (no adapter writes that file at project scope);
    a driven Claude adapter write shows `.mcp.json` gets the right bytes."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.mcp import mcp_spec as mcp_spec_mod
    from skill_hub.infrastructure.mcp import mcp_adapters

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    claude_json = _fake_home / ".claude.json"
    _write_json(claude_json, {"projects": {str(proj): {"mcpServers": {"foo": {"command": "node"}}}}})

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "new"
    assert cand["sources"][0]["scope"] == "local"

    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered,
        [{"name": "foo", "action": "import"}], {"claude-code"},
    )
    assert summary["removed_native"] == [{"harness": "claude-code", "scope": "local", "file": str(claude_json)}]
    assert summary["claimed"] == []
    data = json.loads(claude_json.read_text())
    assert "foo" not in (data.get("projects", {}).get(str(proj), {}).get("mcpServers") or {})

    spec = mcp_spec_mod.spec_from_registry("foo", registry["skills"]["foo"])
    adapter = mcp_adapters.get_adapter("claude")
    adapter.write(proj, [spec], harness_id="claude-code", project_name="demo")
    written = json.loads((proj / ".mcp.json").read_text())
    assert written["mcpServers"]["foo"]["command"] == "node"


def test_global_conflict_import_claims_and_removes_nothing(tmp_data_home, _fake_home, no_auto_sync, monkeypatch):
    """§5 case 8 — at GLOBAL scope, `claimed`/`removed_native` both stay
    empty (the global writers overwrite by name and the tail sync replaces
    the sidecar with what it wrote); after the tail sync both native copies
    equal the chosen spec, and a following `classify` says `already_managed`
    for both."""
    import dataclasses

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.harnesses import harnesses

    claude_json = _fake_home / ".claude.json"
    codex_toml = _fake_home / ".codex" / "config.toml"
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(harnesses.HARNESSES["claude-code"], global_mcp_config=claude_json)
    patched["codex"] = dataclasses.replace(harnesses.HARNESSES["codex"], global_mcp_config=codex_toml)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    registry = _registry()
    _write_json(claude_json, {"mcpServers": {"foo": {"command": "nodeA"}}})
    _write_text(codex_toml, '[mcp_servers.foo]\ncommand = "nodeB"\n')

    discovered, candidates = _discover_and_classify(registry, "global", None, {"claude-code", "codex"})
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "conflict"

    decisions = [{"name": "foo", "action": "import", "harness": "claude-code"}]
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "global", None, None, candidates, discovered, decisions, {"claude-code", "codex"}
    )
    assert summary["claimed"] == []
    assert summary["removed_native"] == []
    assert summary["synced"] is True

    claude_data = json.loads(claude_json.read_text())
    assert claude_data["mcpServers"]["foo"]["command"] == "nodeA"
    codex_text = codex_toml.read_text()
    assert "nodeA" in codex_text

    discovered2, candidates2 = _discover_and_classify(registry, "global", None, {"claude-code", "codex"})
    cand2 = next(c for c in candidates2 if c["name"] == "foo")
    assert cand2["status"] == "already_managed"


def test_rollback_restores_a_claimed_sidecar_when_a_later_import_fails(
    tmp_path, tmp_data_home, no_auto_sync, monkeypatch
):
    """§5 case 9 — the D-review C2 shape: a raise inside the SYNC TAIL
    (after the claim's sidecar write, which happens earlier in the same
    per-decision loop) must leave the SIDECAR file byte-identical to its
    pre-apply bytes — the widened snapshot (grill finding 3) must have
    captured it even though this decision's action was `import`, not the
    old `registry_claim`-only condition."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.application.sync import mcp_sync
    from skill_hub.domain.permissions.permissions import ProjectScope, sidecar_path

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "nodeA"}}})
    _write_text(proj / ".codex" / "config.toml", '[mcp_servers.foo]\ncommand = "nodeB"\n')

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code", "codex"}, proj_name="demo", proj_root=proj
    )
    decisions = [{"name": "foo", "action": "import", "harness": "claude-code"}]

    scope = ProjectScope(name="demo", path=str(proj))
    sidecar = sidecar_path("codex", scope, kind="mcp")
    before = sidecar.read_bytes() if sidecar.exists() else None

    def _boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(mcp_sync, "sync_mcp_for_project", _boom)

    with pytest.raises(RuntimeError):
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", proj, candidates, discovered, decisions, {"claude-code", "codex"}
        )

    after = sidecar.read_bytes() if sidecar.exists() else None
    assert after == before


def test_renamed_conflict_import_removes_both_native_entries(tmp_path, tmp_data_home, no_auto_sync):
    """§5 case 10 — a renamed CONFLICT import: `claimed == []`, both native
    entries gone, `renamed` is set, and a following discovery leaves the
    newly-written entries alone."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    claude_mcp_json = proj / ".mcp.json"
    codex_toml = proj / ".codex" / "config.toml"
    _write_json(claude_mcp_json, {"mcpServers": {"Sanity": {"command": "nodeA"}}})
    _write_text(codex_toml, '[mcp_servers.sanity]\ncommand = "nodeB"\n')

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code", "codex"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "sanity")
    assert cand["status"] == "conflict"

    decisions = [{"name": "sanity", "action": "import", "harness": "claude-code"}]
    summary = mcp_cli._reconcile_apply_mcp(
        registry, "project", "demo", proj, candidates, discovered, decisions, {"claude-code", "codex"}
    )
    assert summary["claimed"] == []
    assert summary["renamed"] == [{"from": "Sanity", "to": "sanity"}]
    assert {(r["harness"], r["file"]) for r in summary["removed_native"]} == {
        ("claude-code", str(claude_mcp_json)),
        ("codex", str(codex_toml)),
    }
    claude_data = json.loads(claude_mcp_json.read_text())
    assert "Sanity" not in (claude_data.get("mcpServers") or {})
    codex_text = codex_toml.read_text()
    assert "sanity" not in codex_text  # the OLD lowercase codex key is also gone

    discovered2, candidates2 = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code", "codex"}, proj_name="demo", proj_root=proj
    )
    assert all(src.get("name") != "Sanity" for c in candidates2 for src in c.get("sources", []))


def test_json_failures_are_structured_and_never_leak_a_planted_token(tmp_path, tmp_data_home, no_auto_sync, capsys):
    """§5 case 11 — literal-without-hatch, `name_taken`, `name_collision_in_batch`,
    `unknown_candidate` all exit 2 with `{"ok": false, "code", ...}`; a
    planted token-looking value never reaches stdout in any of them."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli

    token = "sk-plantedtoken1234567890abcdef"

    def _die_json(decisions, registry, candidates, discovered, scope_kind="project", proj_name="demo", proj_root=None):
        mcp_cli._json_mode = True
        try:
            with pytest.raises(SystemExit) as excinfo:
                mcp_cli._reconcile_apply_mcp(
                    registry, scope_kind, proj_name, proj_root, candidates, discovered, decisions, {"claude-code"}
                )
        finally:
            mcp_cli._json_mode = False
        out = capsys.readouterr().out
        assert excinfo.value.code == 2
        payload = json.loads(out)
        assert payload["ok"] is False
        assert token not in out
        return payload

    # literal_secret
    proj, registry, real_token = _literal_registry_and_files(tmp_path, token=token)
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    payload = _die_json([{"name": "ctx7", "action": "import"}], registry, candidates, discovered, proj_root=proj)
    assert payload["code"] == "literal_secret"

    # name_taken: existing NON-mcp skill under the resolved name
    proj2 = tmp_path / "proj2"
    proj2.mkdir()
    registry2 = _registry(
        projects={"demo2": _proj_cfg(proj2)},
        skills={"foo": {"type": "skill", "scope": "portable", "description": token}},
    )
    _write_json(proj2 / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})
    discovered2, candidates2 = _discover_and_classify(
        registry2, "project", registry2["projects"]["demo2"], {"claude-code"}, proj_name="demo2", proj_root=proj2
    )
    cand2 = next(c for c in candidates2 if c["name"] == "foo")
    assert cand2["status"] == "unsupported"
    assert cand2["reason"] == "name_taken:foo"
    payload2 = _die_json(
        [{"name": "foo", "action": "import"}], registry2, candidates2, discovered2,
        proj_name="demo2", proj_root=proj2,
    )
    assert payload2["code"] == "name_taken"  # C2/W5: a name_taken reason gets its own code
    assert payload2["reason"] == "name_taken:foo"

    # name_collision_in_batch: two decisions both resolve to "shared" via "as"
    proj3 = tmp_path / "proj3"
    proj3.mkdir()
    registry3 = _registry(projects={"demo3": _proj_cfg(proj3)})
    _write_json(proj3 / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}, "bar": {"command": "python3"}}})
    discovered3, candidates3 = _discover_and_classify(
        registry3, "project", registry3["projects"]["demo3"], {"claude-code"}, proj_name="demo3", proj_root=proj3
    )
    payload3 = _die_json(
        [
            {"name": "foo", "action": "import", "as": "shared"},
            {"name": "bar", "action": "import", "as": "shared"},
        ],
        registry3, candidates3, discovered3, proj_name="demo3", proj_root=proj3,
    )
    assert payload3["code"] == "name_collision_in_batch"

    # unknown_candidate: a decision naming a name absent from `candidates`
    payload4 = _die_json(
        [{"name": "does-not-exist", "action": "import"}], registry3, candidates3, discovered3,
        proj_name="demo3", proj_root=proj3,
    )
    assert payload4["code"] == "unknown_candidate"


def test_nul_named_candidate_never_leaks_a_raw_nul_into_the_die_payload(
    tmp_path, tmp_data_home, no_auto_sync, capsys
):
    """W12: `_reconcile_apply_mcp`'s classify-time `unsupported` refusal is
    the one door a NUL-bearing (or otherwise unprintable/oversized) native
    key actually arrives through — `import_name` is `None` for such a key,
    so `cand["name"]` (== `display_name`) stays the RAW native key all the
    way to the `_die` that reports it. A NUL byte must never reach `error`
    or `name` in the JSON payload, and the reported `code` must still be
    `invalid_name` (W5)."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_reconcile

    nul_name = "a" + chr(0) + "b"
    proj = tmp_path / "proj"
    proj.mkdir()
    _write_json(proj / ".mcp.json", {"mcpServers": {nul_name: {"command": "npx"}}})
    registry = _registry(projects={"demo": _proj_cfg(proj)})

    discovered = mcp_reconcile.discover_native(
        "project", registry["projects"]["demo"], registry, {"claude-code"}
    )
    candidates = mcp_reconcile.classify(discovered, registry, set())
    cand = next(c for c in candidates if c["status"] == "unsupported")
    assert cand["reason"] == "invalid_name"
    assert cand["name"] == nul_name  # the raw native key — never slugified

    mcp_cli._json_mode = True
    try:
        with pytest.raises(SystemExit) as excinfo:
            mcp_cli._reconcile_apply_mcp(
                registry, "project", "demo", proj, candidates, discovered,
                [{"name": nul_name, "action": "import"}], {"claude-code"},
            )
    finally:
        mcp_cli._json_mode = False
    assert excinfo.value.code == 2
    out = capsys.readouterr().out
    payload = json.loads(out)  # must not raise — the NUL must not break JSON either
    assert payload["code"] == "invalid_name"
    assert chr(0) not in out
    assert chr(0) not in payload["error"]
    assert chr(0) not in (payload.get("name") or "")
    assert len(payload.get("name") or "") <= 40


def test_folder_collision_is_name_taken_not_a_bare_exit(tmp_path, tmp_data_home, no_auto_sync, capsys):
    """§5 case 11 (folder collision) — a leftover `mcp-servers/<slug>/` dir
    with no registry entry is `name_taken`, decided in `classify`, never
    `_register_mcp_skill`'s bare `fail()` text."""
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.domain.skills import skill_meta

    proj = tmp_path / "proj"
    proj.mkdir()
    registry = _registry(projects={"demo": _proj_cfg(proj)})
    _write_json(proj / ".mcp.json", {"mcpServers": {"foo": {"command": "node"}}})
    (skill_meta.hub_mcp_servers_dir() / "foo").mkdir(parents=True)

    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code"}, proj_name="demo", proj_root=proj
    )
    cand = next(c for c in candidates if c["name"] == "foo")
    assert cand["status"] == "unsupported"
    assert cand["reason"] == "name_taken:foo"

    mcp_cli._json_mode = True
    try:
        with pytest.raises(SystemExit) as excinfo:
            mcp_cli._reconcile_apply_mcp(
                registry, "project", "demo", proj, candidates, discovered,
                [{"name": "foo", "action": "import"}], {"claude-code"},
            )
    finally:
        mcp_cli._json_mode = False
    assert excinfo.value.code == 2
    out = json.loads(capsys.readouterr().out)
    assert out["code"] == "name_taken"
    assert out["reason"] == "name_taken:foo"
    assert "already has a folder" not in out["error"]
