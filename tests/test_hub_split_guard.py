"""Structural gates for the `hub.py` split (S5).

`hub.py` was a 19.6k-line monolith. The split moves leaf primitives into
`skill_hub/` and the per-subcommand CLI blocks into `skill_hub/entrypoints/cli/`.
Five things
can silently rot while that happens, and each has a gate here:

1. the monolith creeps back up — a line ceiling that ratchets down per slice;
2. a new shipped package is omitted from `bundle.resources`, so the
   installed `.app` dies with `ModuleNotFoundError` (this has happened before);
3. the `hub` → `hub_core` facade half-wires, so `hub._DATA_HOME_CACHE = None`
   in a fixture no longer reaches the definition site — a test would then
   resolve the REAL `~/.skill-hub` and a sweep could unlink live symlinks;
4. a leaf package module keeps `import hub`, re-creating the dependency knot the split
   exists to undo;
5. a CLI slice drops the `hub.` prefix on a symbol that still lives
   in the monolith — invisible until the code path actually runs.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

# Ratchet: 19_200 after slice A, 17_900 after B, 16_900 after C, 16_400 after D,
# 15_300 after the remote-CLI slice (wave 1), 14_700 after the remote-CLI
# credential-lifecycle slice (wave 2: keyscan/setup-key/setup-helper/
# signing-key/revoke-key/repin move to hub_cli/remote.py), 14_200 after the
# remote-CLI docs/health/doctor slice (wave 3: cmd_remote_pin/probe/
# rotate_token/list_docs/fetch_doc/push_doc/health/doctor + the
# _read_default_ssh_pubkey/_resolve_remote_for_doc helpers move to
# hub_cli/remote.py — the last `hub remote` verbs left in the monolith).
# 13_100 after wave 4 (permissions slice 1) merged on top of waves 1-3.
# 12_400 after wave 5 (permissions slice 2) merged on top of main.
# 11_600 after wave 6 (permissions slice 3) merged on top of main.
# 10_900 after wave 7 (project) merged on top of main.
# 10_200 after wave 8 (harness + agent-docs) merged on top of main.
# 9_700 after wave 9 (subagent) merged on top of main.
# 9_200 after wave 10 (snippet) merged on top of main.
# 8_700 after wave 11 (backup) merged on top of main.
# 8_300 after wave 12 (restore) merged on top of main.
# 7_600 after wave 13 (bootstrap) merged on top of main.
# 7_100 after wave 14 (bundle verbs) merged on top of main.
# 6_900 after wave 16a (update) merged on top of main.
# 6_300 after wave 15 (skill verbs) merged on top of main.
# 5_700 after wave 16b (archive) merged on top of main.
# 5_500 after wave 16c (app + mcp-control) merged on top of main.
# 5_000 after wave 17 (skill_meta) merged on top of main.
# 4_500 after wave 18a (sources) merged on top of main.
# 4_150 after wave 23a (sync_links) merged on top of main.
# 3_950 after wave 23b (mcp_sync) merged on top of main.
# 3_650 after wave 23c (remote_dispatch) merged on top of main.
# 3_400 after wave 23d (import_scanner) merged on top of main.
# 2_900 after wave 23e (permissions_stream) merged on top of main.
# 2_350 after wave 23f (hooks_stream) merged on top of main.
# 1_850 after wave 23g (skill_variants) merged on top of 23f.
# 1_100 after wave 23h (sync_engine) merged on top of 23g.
MAX_HUB_LINES = 1_080

# `skill_hub/entrypoints/cli/*.py` modules that self-register a CLI slice moved
# out of hub.py. Keep names stable because they are also the parser's module
# names and the mutation map's labels.
HUB_CLI_MODULES = [
    "agent_docs",
    "app",
    "archive",
    "backup",
    "bootstrap",
    "bundle",
    "cloud",
    "companions",
    "harness",
    "hook",
    "integration",
    "mcp",
    "mcp_control",
    "permissions",
    "project",
    "receive",
    "recovery",
    "remote",
    "restore",
    "skill",
    "snippet",
    "source",
    "subagent",
    "update",
    "usage",
]

# Repo-root directories that are not part of the shipped Python surface.
_NON_MODULE_DIRS = {
    "tests",
    "app",
    "website",
    "vendor",
    "python-runtime",
    "scripts",
    "openspec",
    "docs",
    "skills",
    "snippets",
}

# Every package module is a leaf: it must reach hub's primitives through
# `skill_hub.hub_core`, never through the monolith (S5 §3.4). This is derived
# from a recursive glob, not a hand-maintained list, so a new nested module is
# covered for free. CLI slices have a separate guard because their function-
# local `import hub` calls are part of their facade contract.
def _leaf_candidates() -> list[str]:
    package_root = REPO_ROOT / "skill_hub"
    cli_root = package_root / "entrypoints" / "cli"
    return [
        p.relative_to(REPO_ROOT).as_posix()
        for p in sorted(package_root.rglob("*.py"))
        if p.name != "__init__.py"
        and p != package_root / "hub_core.py"
        and cli_root not in p.parents
    ]


# Package modules that legitimately still import `hub` for a monolith symbol
# `skill_hub.hub_core` does not (yet) carry. Each entry needs a one-line reason. An
# entry that stops importing `hub`, or whose file disappears, is stale and
# must be removed — see test_hub_importer_allowlist_is_not_stale below.
ALLOWED_HUB_IMPORTERS = {
    "skill_hub/infrastructure/filesystem/cloud_targets.py": "reads hub._DATA_HOME_CACHE-adjacent cloud target state",
    "skill_hub/application/sync/hooks_stream.py": "calls hub-level hook dispatch helpers not yet split out",
    "skill_hub/application/sync/mcp_sync.py": "drives hub's MCP sync entry points during reconcile",
    "skill_hub/application/sync/permissions_stream.py": "streams through hub's permission dispatch helpers",
    "skill_hub/entrypoints/mcp/skill_hub_mcp_server.py": "the MCP server facade re-exports hub subcommands",
    "skill_hub/domain/skills/skill_refs.py": "resolves skill references via hub's project/registry helpers",
    "skill_hub/application/skills/skill_variants.py": "needs hub's variant-authoring helpers not yet split out",
    "skill_hub/application/sync/sync_engine.py": "orchestrates hub's sync subcommands directly",
    "skill_hub/application/usage/usage_history.py": "reads hub's legacy usage-history helpers not yet split out",
    "skill_hub/infrastructure/connectors/transport/audit.py": "uses hub's data-home facade for connector audit state",
    "skill_hub/infrastructure/connectors/transport/ssh.py": "uses hub's data-home facade for SSH transport state",
}


_IMPORTS_HUB_RE = re.compile(r"^[ \t]*(?:import hub\b(?!_)|from hub import\b)", re.M)


def test_hub_py_line_ceiling():
    """The monolith may not grow back. Lower the constant with each slice."""
    lines = len((REPO_ROOT / "hub.py").read_text().splitlines())
    assert lines <= MAX_HUB_LINES, (
        f"hub.py is {lines} lines, ceiling is {MAX_HUB_LINES}. "
        "Move code out (or lower the ceiling only when a slice lands)."
    )


def test_every_python_module_is_bundled():
    """Every shipped module needs a `bundle.resources` entry.

    A missing entry is invisible in dev (the repo checkout has the file) and
    fatal in the installed app: `hub.py` imports it and the subprocess dies with
    `ModuleNotFoundError`.
    """
    conf = json.loads(
        (REPO_ROOT / "app" / "src-tauri" / "tauri.conf.json").read_text()
    )
    resources = conf["bundle"]["resources"]
    assert isinstance(resources, dict), "bundle.resources must be the map form"

    missing = []
    for entry in sorted(REPO_ROOT.iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.is_file() and entry.suffix == ".py":
            key = f"../../{entry.name}"
            if key not in resources:
                missing.append(key)
        elif entry.is_dir() and entry.name not in _NON_MODULE_DIRS:
            if (entry / "__init__.py").is_file():
                key = f"../../{entry.name}"
                if key not in resources:
                    missing.append(key)

    assert not missing, (
        "these modules/packages are not in app/src-tauri/tauri.conf.json "
        f"bundle.resources: {missing}"
    )


def test_core_state_is_live_through_the_facade():
    """`hub.<name>` and `hub_core.<name>` must be ONE binding, both directions.

    `from hub_core import *` only copies bindings. Tests rebind through the
    facade (`hub._DATA_HOME_CACHE = None` in `tests/conftest.py`, ~30 distinct
    `monkeypatch.setattr(hub, …)` targets) and read the mutable counters live
    (`hub._LOCK_DEPTH` in `tests/test_agent_tooling_layer0.py`). Without the
    facade a rebind would leave `hub_core`'s own global untouched and
    `data_home()` would keep resolving the developer's real home.
    """
    import hub
    import skill_hub.hub_core as hub_core

    # The mutable-state names must NEVER be copied into hub.__dict__: a module
    # __getattr__ only fires on a MISS, so a copied binding would shadow it and
    # freeze _LOCK_DEPTH at whatever it was at import time.
    leaked = set(vars(hub)) & set(hub_core._MUTABLE_STATE)
    assert not leaked, f"hub.__dict__ shadows core mutable state: {sorted(leaked)}"

    hub_core._LOCK_DEPTH = 7
    assert hub._LOCK_DEPTH == 7
    hub._LOCK_DEPTH = 0
    assert hub_core._LOCK_DEPTH == 0

    hub._DATA_HOME_CACHE = None
    assert hub_core._DATA_HOME_CACHE is None

    sentinel = Path("/nope")
    old = hub.code_home
    hub.code_home = lambda: sentinel
    try:
        # The rebind must reach the DEFINITION site, not just hub's copy.
        assert hub_core.code_home() is sentinel
    finally:
        hub.code_home = old
    assert hub_core.code_home() is not sentinel
    assert hub.code_home is hub_core.code_home


@pytest.mark.parametrize("rel", _leaf_candidates())
def test_leaf_siblings_do_not_import_hub(rel):
    """A leaf may only need `data_home`/`code_home`/`fail`/… — that is `hub_core`.

    Exhaustive over every root module and connectors/ submodule (derived from
    the glob), not an additive list a new module could join by omission. The
    nine modules in `ALLOWED_HUB_IMPORTERS` are the only exceptions.
    """
    if rel in ALLOWED_HUB_IMPORTERS:
        pytest.skip(f"{rel} is an allowed hub importer: {ALLOWED_HUB_IMPORTERS[rel]}")
    src = (REPO_ROOT / rel).read_text()
    hit = _IMPORTS_HUB_RE.search(src)
    assert hit is None, (
        f"{rel} still imports the monolith at "
        f"line {src[: hit.start()].count(chr(10)) + 1}: {hit.group(0).strip()!r}. "
        "Import `hub_core` instead, or add it to ALLOWED_HUB_IMPORTERS with a reason."
    )


def test_hub_importer_allowlist_is_not_stale():
    """Guard the guard, the way the spawn allowlist is guarded: an entry that
    no longer imports `hub`, or whose file no longer exists, must be removed —
    otherwise the exception list silently widens past what is actually true."""
    candidates = set(_leaf_candidates())
    for rel, reason in ALLOWED_HUB_IMPORTERS.items():
        assert reason, f"{rel} has no reason"
        path = REPO_ROOT / rel
        assert rel in candidates, f"{rel} is not a scanned leaf candidate"
        assert path.is_file(), f"{rel} is allowlisted but missing — remove the entry"
        src = path.read_text()
        assert _IMPORTS_HUB_RE.search(src) is not None, (
            f"{rel} no longer imports hub — remove it from ALLOWED_HUB_IMPORTERS"
        )


def test_hub_core_is_a_leaf():
    """`hub_core` may not import any first-party module at module scope.

    That is what makes it importable from every sibling without a cycle.
    """
    tree = ast.parse((REPO_ROOT / "skill_hub" / "hub_core.py").read_text())
    first_party = {p.stem for p in REPO_ROOT.glob("*.py")} | {"skill_hub", "connectors"}
    offenders = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            offenders += [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            offenders.append(node.module.split(".")[0])
    bad = sorted(set(offenders) & first_party)
    assert not bad, f"hub_core.py imports first-party modules at module scope: {bad}"


def _top_level_bound_names(tree: ast.Module) -> set[str]:
    """Names a module binds at module scope: def/class names + assign targets."""
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names:
                names.add((a.asname or a.name).split(".")[0])
    return names


def _all_load_names(tree: ast.AST) -> set[str]:
    return {
        n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)
    }


_MODULE_SCOPE_HUB_IMPORT_RE = re.compile(r"^(?:import hub$|from hub import\b)", re.M)


@pytest.mark.parametrize("modname", HUB_CLI_MODULES)
def test_cli_modules_reference_monolith_through_hub(modname):
    """A CLI slice may use a leftover `hub.py` symbol only via `hub.<name>`.

    A moved function that drops the `hub.` prefix on a symbol that still lives in
    the monolith fails silently — Python only raises `NameError` the first time
    that code path actually runs. This statically catches the missed prefix: any
    bare (unprefixed) reference to a name hub.py defines at module scope, that
    isn't also supplied by `hub_core.__all__` or defined locally in the CLI
    module itself, is a bug.
    """
    import skill_hub.hub_core as hub_core

    cli_path = REPO_ROOT / "skill_hub" / "entrypoints" / "cli" / f"{modname}.py"
    cli_src = cli_path.read_text()

    assert _MODULE_SCOPE_HUB_IMPORT_RE.search(cli_src) is None, (
        f"skill_hub/entrypoints/cli/{modname}.py imports the monolith at module scope — this "
        "deadlocks the import cycle (hub.py imports skill_hub.entrypoints.cli.* at the bottom "
        "of its own body). `import hub` must appear only inside functions."
    )

    hub_tree = ast.parse((REPO_ROOT / "hub.py").read_text())
    hub_top_names = _top_level_bound_names(hub_tree)

    cli_tree = ast.parse(cli_src)
    cli_own_names = _top_level_bound_names(cli_tree)

    remainder = hub_top_names - set(hub_core.__all__) - cli_own_names
    bare_refs = _all_load_names(cli_tree) & remainder
    # `hub` itself (the module name bound by the local `import hub` statements)
    # is expected and fine — it is the prefix, not a bare reference to it.
    bare_refs.discard("hub")

    assert not bare_refs, (
        f"skill_hub/entrypoints/cli/{modname}.py references these hub.py-only names without a "
        f"`hub.` prefix: {sorted(bare_refs)}. Add `import hub` to the function "
        "and prefix the symbol, or import it from hub_core if it belongs there."
    )


def test_hub_cli_module_list_is_complete():
    """Guard the guard the other direction (review W1): a new self-registering
    slice (a CLI package module with a module-level `NAME = ...`) must be
    added to `HUB_CLI_MODULES`, or `test_cli_modules_reference_monolith_through_hub`
    silently never runs against it — exactly what happened to `hub_cli/mcp.py`
    between its own tests going green and this guard being widened."""
    hub_cli_dir = REPO_ROOT / "skill_hub" / "entrypoints" / "cli"
    found = set()
    for path in sorted(hub_cli_dir.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text())
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "NAME" for t in node.targets
            ):
                found.add(path.stem)
                break

    missing = sorted(found - set(HUB_CLI_MODULES))
    assert not missing, (
        f"hub_cli modules with a NAME are missing from HUB_CLI_MODULES: {missing}"
    )
