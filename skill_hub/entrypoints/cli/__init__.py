"""Self-registering CLI slices carved out of hub.py's banner sections.

CONTRACT — each module exposes:
    NAME: str                     # top-level subcommand word ("hook")
    def register(sub) -> None     # add_parser/add_argument, VERBATIM order (keeps `hub --help` stable)
    def dispatch(args) -> None    # run the sub-subcommand, or print_help()

HARD RULE — a module here may NOT `import hub` at module scope (hub.py imports
this package at the bottom of its own body to re-export `cmd_*`; a module-scope
`import hub` would deadlock that cycle). Import `hub_core` at module scope for
`registry_mutation`, colours, `fail`; put `import hub` as the
FIRST statement of every function that needs a monolith symbol and reference it
as `hub.<name>` so monkeypatching `hub.X` keeps working.

Registry I/O goes through the module attribute — `hub_core.load_registry()` /
`hub_core.save_registry()`, never a `from skill_hub.hub_core import save_registry` copy —
so a test's `monkeypatch.setattr(hub, "save_registry", …)` (forwarded to
`hub_core` by the facade) still stops a moved handler from writing to disk.
The same applies to every `hub_core` name a test patches on `hub`
(`code_home`, `audit_log_path`, `MIN_PYTHON`, `DEFAULT_DATA_HOME`,
`LEGACY_DATA_HOMES`, `IMPORT_SCAN_ROOTS`): reach them as `hub_core.<name>`.
A `from skill_hub.hub_core import` copy is fine for the colours, `fail`, `c`,
`data_home` (its cache `_DATA_HOME_CACHE` is facade-live) and the validators.

When a test stubs a private helper on `hub` and BOTH the caller and the helper
move into a slice, the stub stops firing (the bare call resolves in the slice's
own globals). Repoint such stubs to `skill_hub.entrypoints.cli.<slice>` in the same PR — see the
`_sync_scope_native` and `_reseed_known_hosts_after_repin` cases.

A slice may import another slice at module scope (`skill_hub.entrypoints.cli.permissions` imports
the `_hook_*` helpers from `skill_hub.entrypoints.cli.hook`) only while the imported slice imports
no slice itself; a slice→slice cycle deadlocks the same way `import hub` does.

The seven home-derived directory constants (`CLAUDE_SKILLS_DIR`,
`CODEX_SKILLS_DIR`, `AGENTS_SKILLS_DIR`, `PI_AGENT_DIR`, `PI_MCP_GLOBAL`,
`PI_SETTINGS`, `DEFAULT_DATA_HOME`) are reached as `hub_core.<NAME>`, never
copied: tests/conftest.py rebinds them per test to a fake `$HOME`, and a copy
frozen at import time points a sweep at the developer's real `~/.claude/skills`.

The package is empty until slice B; it exists from slice A so the single
`bundle.resources` entry (`../../hub_cli`) and the bundle smoke test can be
wired once, for every slice.
"""
