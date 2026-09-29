"""Shared pytest fixtures for hub.py tests.

The hub module caches `data_home()` in a module-global. Tests that mutate
env vars MUST reset `hub._DATA_HOME_CACHE = None` before calling the resolver,
which is what `tmp_data_home` does for you.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Ensure repo root is importable.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


# Every module-level constant in `hub.py` that is derived from `Path.home()` at
# IMPORT time, mapped to its path relative to the home dir. A later
# `monkeypatch.setenv("HOME", …)` cannot redirect these — they were frozen when
# the module was first imported — and `cmd_archive`/`cmd_rename` call
# `remove_symlink(CLAUDE_SKILLS_DIR / name)`, which is how a previous incident
# wiped the developer's real `~/.claude/skills` links. Keep in sync with
# `tests/test_home_isolation.py`, which asserts this list is complete.
_HOME_DERIVED_HUB_DIRS = {
    "DEFAULT_DATA_HOME": (".skill-hub",),
    "CLAUDE_SKILLS_DIR": (".claude", "skills"),
    "CODEX_SKILLS_DIR": (".codex", "skills"),
    "AGENTS_SKILLS_DIR": (".agents", "skills"),
    "PI_AGENT_DIR": (".pi", "agent"),
    "PI_MCP_GLOBAL": (".pi", "agent", "mcp.json"),
    "PI_SETTINGS": (".pi", "agent", "settings.json"),
}


@pytest.fixture(autouse=True)
def _fake_home(tmp_path_factory, monkeypatch):
    """Safety net: NO test may see the developer's real home directory.

    Defined FIRST in this file, and taken as an explicit dependency by the other
    autouse nets below, so it is always the first thing applied to a test.

    Three seams, all required:

    * `$HOME` (+ `$USERPROFILE`) — what `os.path.expanduser` and
      `Path(...).expanduser()` read.
    * `Path.home` — patched on the class so subclasses (`PosixPath`) follow.
    * `hub`'s import-time constants — see `_HOME_DERIVED_HUB_DIRS`. Patching the
      env var alone leaves these pointing at the real `~`, which is the exact
      shape of the incident that unlinked real `~/.claude/skills` entries.

    Also zeroes `hub._LOCK_DEPTH`: it is a module global that no fixture used to
    reset, and a value leaked from an earlier test defeats `data_home_lock()`'s
    re-entrancy guard (the PR #32 self-deadlock).

    Tests that fake `$HOME` themselves keep working — monkeypatch stacks, and
    their setenv/setattr simply runs after ours.
    """
    import hub

    fake_home = tmp_path_factory.mktemp("fake-home")

    # A collection-time resolver or an earlier fixture may have cached the
    # real data home. Redirect explicit overrides and reset that cache before
    # any fixture can discover connectors or open a store.
    for name in ("SKILL_HUB_HOME", "SKILL_HUB_DIR", "SKILL_HUB_CODE"):
        monkeypatch.delenv(name, raising=False)
    hub._DATA_HOME_CACHE = None
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))  # Windows equivalent
    # Resolve through the env var on every call, NOT a captured constant: on
    # POSIX `Path.home()` already reads `$HOME`, and several tests re-fake HOME
    # for themselves mid-test. A frozen return value would silently stop
    # following them (it broke `test_restore.py`'s two-machine round trip).
    monkeypatch.setattr(
        Path,
        "home",
        classmethod(
            lambda cls: Path(
                os.environ.get("HOME") or os.environ.get("USERPROFILE") or fake_home
            )
        ),
    )

    for attr, tail in _HOME_DERIVED_HUB_DIRS.items():
        monkeypatch.setattr(hub, attr, fake_home.joinpath(*tail))
    monkeypatch.setattr(hub, "LEGACY_DATA_HOMES", [fake_home / "Dev" / ".skill-hub"])
    monkeypatch.setattr(
        hub,
        "IMPORT_SCAN_ROOTS",
        [
            ("claude", fake_home / ".claude" / "skills"),
            ("agents", fake_home / ".agents" / "skills"),
            ("legacy-codex", fake_home / ".codex" / "skills"),
            ("pi", fake_home / ".pi" / "agent" / "skills"),
        ],
    )

    # The Starter Pack: every `hub sync` registers the built-in skills it
    # discovers, and `code_home()` resolves to THIS repo inside pytest (also in
    # the subprocess-style tests, which pop `SKILL_HUB_CODE` on purpose). Point
    # discovery at an empty dir so no fixture registry gains the real pack;
    # `os.environ` is inherited by subprocesses, so the seam reaches them too.
    # `tests/test_starter_skills.py` re-points it at a seeded pack per test.
    starter_root = fake_home / "starter-skills"
    starter_root.mkdir(exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_STARTER_ROOT", str(starter_root))

    # Not monkeypatch.setattr: we want a clean 0 at SETUP, not a restore of
    # whatever the previous test leaked.
    hub._LOCK_DEPTH = 0

    yield fake_home


@pytest.fixture(autouse=True)
def _no_login_shell(_fake_home, monkeypatch):
    """Safety net (C-3): NO test may spawn the developer's real login shell.

    `mcp_probe.resolved_env()` runs `[$SHELL, "-lic", "env -0"]` on a cache
    miss; `_fake_home` redirects `$HOME` (so a real zsh reads a temp dir's
    absent rc instead of the user's), but the real `/bin/zsh` binary and the
    system-level `/etc/zshrc` would still run — that was only an accidental
    shield, not a designed one. This seeds the once-per-process snapshot
    cache directly, so a call to `resolved_env()` never shells out at all.

    Declared here (conftest.py), it runs BEFORE any autouse fixture local to
    a test module — `tests/test_mcp_probe.py`'s own `_stub_login_shell`
    fixture applies its `monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE",
    None)` afterward, in the same test's setup, and that later call wins
    (monkeypatch stacks in application order) — so that file's own tests
    still exercise the real snapshot function against their own `$SHELL`
    stubs exactly as before.
    """
    from skill_hub.infrastructure.mcp import mcp_probe

    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", ({}, False))


@pytest.fixture(autouse=True)
def _guard_runtime_probe(_fake_home, tmp_path_factory, monkeypatch):
    """Keep runtime inventory probes inside pytest's disposable tree.

    The inventory coordinator is allowed to use real subprocess cleanup in its
    dedicated lifecycle tests, but a source checkout test must never discover
    and launch an installed Claude/Codex/Pi/OpenCode binary through the host
    PATH or fallback directories. Fixture executables under pytest's base temp
    root remain valid evidence for those tests.
    """
    from skill_hub.application.harnesses import harness_runtime

    base = Path(tmp_path_factory.getbasetemp()).resolve()
    python = Path(sys.executable).resolve()
    original = harness_runtime._default_runner

    def guarded_runner(argv, timeout_seconds, max_output_bytes):
        executable = Path()
        try:
            executable = Path(os.fspath(argv[0])).resolve()
            executable.relative_to(base)
            allowed = True
        except (IndexError, OSError, ValueError, TypeError):
            allowed = False
        if not allowed and executable != python:
            return harness_runtime.RunnerResult(
                None, error="test isolation blocked runtime executable"
            )
        return original(argv, timeout_seconds, max_output_bytes)

    monkeypatch.setattr(harness_runtime, "_default_runner", guarded_runner)


@pytest.fixture
def tmp_data_home(tmp_path, monkeypatch):
    """Isolated data home per test.

    Sets `SKILL_HUB_HOME` to a tmp dir, unsets `SKILL_HUB_DIR` and
    `SKILL_HUB_CODE`, and resets `hub._DATA_HOME_CACHE` so the next
    `data_home()` resolves to the tmp path.
    """
    import hub

    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path))
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    monkeypatch.delenv("SKILL_HUB_CODE", raising=False)
    hub._DATA_HOME_CACHE = None
    # Also reset the one-shot warning state so per-test ordering doesn't matter.
    hub._DEPRECATION_WARNED = False
    hub._LEGACY_FALLBACK_WARNED = False
    hub._SOURCE_ENABLED_WARNED.clear()
    yield tmp_path
    hub._DATA_HOME_CACHE = None


@pytest.fixture(autouse=True)
def _isolate_global_mcp(_fake_home, monkeypatch):
    """Safety net: NO test may write a real user-global MCP config.

    `Harness.global_mcp_config` points at real absolute paths (~/.claude.json,
    ~/.codex/config.toml) that the `tmp_data_home` fixture does NOT isolate. Any
    test that runs `cmd_sync`'s global-MCP pass against the real `HARNESSES` would
    otherwise write to the user's actual config. We null out `global_mcp_config`
    on every harness by default; tests that exercise global dispatch re-patch
    `HARNESSES` with tmp paths themselves (their setattr runs after this one).
    """
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    patched = {
        h_id: dataclasses.replace(h, global_mcp_config=None)
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)


@pytest.fixture(autouse=True)
def _isolate_harness_agent_state(_fake_home, request, tmp_path_factory, monkeypatch):
    """Safety net: NO test may read or write a real harness sub-agent / global doc.

    Two seams, both required:

    * `$SKILL_HUB_CLAUDE_HOME` + `$CODEX_HOME` — the resolvers in `subagents.py` /
      `subagent_codex.py` honour these, and they are what the gather code
      actually calls. Monkeypatching `Harness.agents_dir` alone would NOT help:
      that field is an inert default the resolver never reads, so the real
      resolver would happily walk the developer's own `~/.claude/agents`.
    * `Harness.global_doc` — hardcodes `~` and honours no env var at all, so the
      only way to neutralize it is to null the field. Tests that need a real
      global doc re-patch `HARNESSES` themselves (their setattr runs after ours).

    Opt out with `@pytest.mark.real_harness_paths` — used only by the tests that
    assert the harness registry's declared literals.
    """
    if request.node.get_closest_marker("real_harness_paths"):
        return

    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    root = tmp_path_factory.mktemp("harness-isolation")
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(root / "claude"))
    monkeypatch.setenv("CODEX_HOME", str(root / "codex"))
    patched = {
        h_id: dataclasses.replace(h, global_doc=None)
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)


@pytest.fixture(autouse=True)
def _connectors_discovered(_fake_home):
    """Guarantee builtin/private connectors are registered before each test.

    Connector registration is now lazy (`skill_hub.infrastructure.connectors.discovery.ensure_discovered`,
    triggered on first `get_connector`/registry read) instead of at package
    import. Many suites read `REMOTE_CONNECTORS["hermes"]` (etc.) directly without
    going through `get_connector`; this autouse fixture runs the (memoized)
    discovery once so those direct reads keep working — restoring the exact
    pre-lazy state without changing any test's intent.
    """
    import hub
    import skill_hub.infrastructure.connectors.discovery
    from skill_hub import hub_core

    skill_hub.infrastructure.connectors.discovery._reset_for_tests()
    skill_hub.infrastructure.connectors.ensure_discovered()
    # Discovery resolves the data home and fills the cache. Tests that model
    # a pre-fixture state expect the cache empty at their start, as
    # `_fake_home` left it, so hand it back the same way.
    hub_core._DATA_HOME_CACHE = None
    hub._DATA_HOME_CACHE = None
    yield


@pytest.fixture
def clean_env(monkeypatch):
    """Unset all SKILL_HUB_* env vars + reset cache for the test."""
    import hub

    monkeypatch.delenv("SKILL_HUB_HOME", raising=False)
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    monkeypatch.delenv("SKILL_HUB_CODE", raising=False)
    hub._DATA_HOME_CACHE = None
    hub._DEPRECATION_WARNED = False
    hub._LEGACY_FALLBACK_WARNED = False
    hub._SOURCE_ENABLED_WARNED.clear()
    yield
    hub._DATA_HOME_CACHE = None


def write_skill_md(target: Path, name: str, description: str = "test skill") -> Path:
    """Helper: write a minimal SKILL.md and return its parent dir."""
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: |\n  {description}\n---\n"
    )
    return target
