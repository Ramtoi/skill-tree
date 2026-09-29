"""Guard: every test runs against a FAKE `$HOME`, never the developer's own.

Why this file exists
--------------------
`hub.py` resolves a handful of user-global directories from `Path.home()` at
**import** time (`CLAUDE_SKILLS_DIR`, `AGENTS_SKILLS_DIR`, `PI_AGENT_DIR`, …),
and code paths such as `cmd_archive` / `cmd_rename` call
`remove_symlink(CLAUDE_SKILLS_DIR / name)`. A test that merely does
`monkeypatch.setenv("HOME", tmp)` therefore does **not** redirect those
constants — they were frozen at import — so a stray sweep can unlink the real
`~/.claude/skills` links. That has already happened on this machine.

Only ~18 of the 83 test modules faked `$HOME` at all, and each did it by hand.
The autouse `_fake_home` fixture in `tests/conftest.py` makes it universal and
also re-points the import-time constants. These tests pin that contract.

`REAL_HOME` is captured at **module import** (collection time), which happens
before any function-scoped fixture can run — so it always holds the developer's
actual home. Assertions require a separate fake home and exact paths within it.
The temporary directory may itself be beneath the runner's home.
"""

from __future__ import annotations

import os
from pathlib import Path

REAL_HOME = os.environ.get("HOME")


def _fake_home() -> Path:
    return Path(os.environ["HOME"])


def test_home_is_faked():
    """`$HOME` and `Path.home()` agree, and neither is the real home."""
    assert REAL_HOME, "HOME must be set in the environment running pytest"

    env_home = Path(os.environ["HOME"])
    assert env_home != Path(REAL_HOME), (
        f"$HOME still points at the real home ({REAL_HOME}); "
        "the autouse _fake_home fixture is missing or not applied"
    )
    assert Path.home() == env_home, (
        f"Path.home() ({Path.home()}) disagrees with $HOME ({env_home}); "
        "patching the env var alone is not enough — Path.home must be patched too"
    )
    assert env_home.is_dir(), "the fake home must exist on disk"


def test_hub_import_time_dirs_follow_home():
    """Every home-derived constant frozen at import time must be re-pointed.

    The list is exhaustive as of this commit: it is every module-level
    assignment in the repo (outside `tests/`) whose value derives from
    `Path.home()`. Add to BOTH this list and the fixture if a new one appears.
    """
    import hub

    home = _fake_home()
    real = Path(REAL_HOME)
    assert home != real, "the fake home must differ from the original home"

    expected = {
        "DEFAULT_DATA_HOME": home / ".skill-hub",
        "CLAUDE_SKILLS_DIR": home / ".claude" / "skills",
        "CODEX_SKILLS_DIR": home / ".codex" / "skills",
        "AGENTS_SKILLS_DIR": home / ".agents" / "skills",
        "PI_AGENT_DIR": home / ".pi" / "agent",
        "PI_MCP_GLOBAL": home / ".pi" / "agent" / "mcp.json",
        "PI_SETTINGS": home / ".pi" / "agent" / "settings.json",
    }
    for name, want in expected.items():
        got = getattr(hub, name)
        assert got == want, f"hub.{name} is {got}, expected {want}"

    assert hub.LEGACY_DATA_HOMES == [home / "Dev" / ".skill-hub"], (
        f"hub.LEGACY_DATA_HOMES is {hub.LEGACY_DATA_HOMES}"
    )
    assert hub.IMPORT_SCAN_ROOTS == [
        ("claude", home / ".claude" / "skills"),
        ("agents", home / ".agents" / "skills"),
        ("legacy-codex", home / ".codex" / "skills"),
        ("pi", home / ".pi" / "agent" / "skills"),
    ], f"hub.IMPORT_SCAN_ROOTS is {hub.IMPORT_SCAN_ROOTS}"


# ---------------------------------------------------------------------------
# The pair below deliberately relies on IN-FILE ORDER: pytest runs tests in the
# order they are defined within a module, so `_a` always runs before `_b`. `_a`
# dirties the re-entrancy counter and `_b` proves the autouse fixture reset it.
# Do not reorder or rename these two.
# ---------------------------------------------------------------------------


def test_lock_depth_reset_a():
    """Leak a non-zero lock depth for the next test to catch."""
    import hub

    hub._LOCK_DEPTH = 3
    assert hub._LOCK_DEPTH == 3


def test_lock_depth_reset_b():
    """PR #32 was a self-deadlock on this counter; it must not leak between tests."""
    import hub

    assert hub._LOCK_DEPTH == 0, (
        "hub._LOCK_DEPTH leaked from the previous test — the autouse fixture "
        "must reset it (a stale depth defeats data_home_lock()'s re-entrancy guard)"
    )


def test_core_data_home_cache_cannot_escape_fake_home():
    """Check the resolver without opening or creating any store."""
    from skill_hub import hub_core

    home = _fake_home()
    cached = hub_core._DATA_HOME_CACHE
    assert cached is None or cached == home or home in cached.parents
    assert hub_core.DEFAULT_DATA_HOME == home / ".skill-hub"
    assert hub_core._resolve_data_home_path() == home / ".skill-hub"


# Keep this pair ordered. It models a stale pre-fixture cache without opening it.
def test_data_home_cache_reset_a():
    from skill_hub import hub_core

    assert REAL_HOME is not None
    hub_core._DATA_HOME_CACHE = Path(REAL_HOME) / ".skill-hub"


def test_data_home_cache_reset_b():
    from skill_hub import hub_core

    assert hub_core._DATA_HOME_CACHE is None
    assert hub_core._resolve_data_home_path() == _fake_home() / ".skill-hub"
