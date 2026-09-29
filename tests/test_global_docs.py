"""Tests for `global_docs.py` — a harness's global instructions can follow
another harness's — and the `hub harness doc status|link|unlink` CLI.

SAFETY: every test here isolates HOME (and, for claude-code/codex,
`$SKILL_HUB_CLAUDE_HOME` / `$CODEX_HOME`) before touching a "global doc"
path. `tests/conftest.py`'s autouse `_fake_home` + `_isolate_harness_agent_state`
fixtures already null every harness's `global_doc` and point the two
overridable homes at a throwaway root for EVERY test in this repo; the
`global_docs_env` fixture below restores real (non-null) `global_doc` values
onto that SAME already-isolated `HARNESSES` dict, so `global_docs.doc_path()`
resolves under the isolated roots instead of the developer's real
`~/.claude` / `~/.codex`. See `test_hook_adapters.py` for the analogous
in-process pattern and `conftest.py` for what the safety net actually does.

In-process tests exercise the module directly (`global_docs.status/link/unlink`);
CLI tests spawn `hub.py` in a subprocess with HOME + SKILL_HUB_CLAUDE_HOME +
CODEX_HOME + SKILL_HUB_HOME all pointed at tmp dirs (belt-and-suspenders on
top of the module's own isolation, since a subprocess does not inherit
pytest's monkeypatch).
"""

from __future__ import annotations

import dataclasses
import json
import os
import subprocess
import sys
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


# ─────────────────────────────────────────────────────────────────────────────
# In-process fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def global_docs_env(monkeypatch):
    """Restore real `global_doc` paths onto the already-isolated `HARNESSES`.

    Returns the patched dict so a test can find, e.g., where `pi`'s doc
    resolves for cross-checking.
    """
    from skill_hub.infrastructure.harnesses import harnesses

    defaults = {
        "claude-code": PurePath("~/.claude/CLAUDE.md"),
        "codex": PurePath("~/.codex/AGENTS.md"),
        "pi": PurePath("~/.pi/agent/AGENTS.md"),
        "opencode": PurePath("~/.config/opencode/AGENTS.md"),
    }
    patched = dict(harnesses.HARNESSES)
    for h_id, doc in defaults.items():
        patched[h_id] = dataclasses.replace(patched[h_id], global_doc=doc)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    return patched


@pytest.fixture
def backups_root(tmp_data_home):
    return tmp_data_home / "_hub-backups"


# ─────────────────────────────────────────────────────────────────────────────
# doc_path — env-aware resolution
# ─────────────────────────────────────────────────────────────────────────────


def test_doc_path_claude_and_codex_honor_their_env_override(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_home = os.environ["SKILL_HUB_CLAUDE_HOME"]
    codex_home = os.environ["CODEX_HOME"]
    assert global_docs.doc_path("claude-code") == Path(claude_home) / "CLAUDE.md"
    assert global_docs.doc_path("codex") == Path(codex_home) / "AGENTS.md"


@pytest.mark.parametrize("template", [PurePosixPath, PureWindowsPath])
def test_doc_path_env_override_accepts_both_template_path_flavors(
    global_docs_env, monkeypatch, template
):
    """Harness templates resolve env homes regardless of host path spelling."""
    from skill_hub.infrastructure.filesystem import global_docs
    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(global_docs_env)
    patched["claude-code"] = dataclasses.replace(
        patched["claude-code"],
        global_doc=template("~/.claude/CLAUDE.md"),
    )
    patched["codex"] = dataclasses.replace(
        patched["codex"],
        global_doc=template("~/.codex/AGENTS.md"),
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    assert global_docs.doc_path("claude-code") == Path(
        os.environ["SKILL_HUB_CLAUDE_HOME"]
    ) / "CLAUDE.md"
    assert global_docs.doc_path("codex") == Path(os.environ["CODEX_HOME"]) / "AGENTS.md"


def test_doc_path_pi_and_opencode_follow_home(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    home = Path(os.environ["HOME"])
    assert global_docs.doc_path("pi") == home / ".pi" / "agent" / "AGENTS.md"
    assert global_docs.doc_path("opencode") == home / ".config" / "opencode" / "AGENTS.md"


def test_doc_path_unknown_harness_is_none(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    assert global_docs.doc_path("aider") is None


# ─────────────────────────────────────────────────────────────────────────────
# status() — every state
# ─────────────────────────────────────────────────────────────────────────────


def test_status_all_missing_by_default(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    rows = {r["harness"]: r for r in global_docs.status()}
    assert set(rows) == {"claude-code", "codex", "pi", "opencode"}
    for row in rows.values():
        assert row["state"] == "missing"
        assert row["follows"] is None
        assert row["followers"] == []
        assert row["bytes"] is None


def test_status_standalone_file(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    p = global_docs.doc_path("claude-code")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("hello\n", encoding="utf-8")

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["claude-code"]["state"] == "standalone"
    assert rows["claude-code"]["bytes"] == len(b"hello\n")


def test_status_source_and_follows(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("shared\n", encoding="utf-8")

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result["changed"] is True

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["state"] == "follows"
    assert rows["codex"]["follows"] == "claude-code"
    assert rows["claude-code"]["state"] == "source"
    assert rows["claude-code"]["followers"] == ["codex"]


def test_status_broken_link(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    # Relative symlink to a real harness's declared path, but that path has
    # no file on disk — a dangling follow.
    claude_p = global_docs.doc_path("claude-code")
    rel = os.path.relpath(claude_p, codex_p.parent)
    os.symlink(rel, codex_p)

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["state"] == "broken"
    assert rows["codex"]["follows"] == "claude-code"


def test_status_external_link_is_left_alone(global_docs_env, tmp_path):
    from skill_hub.infrastructure.filesystem import global_docs

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "somewhere-else.md"
    outside.write_text("not a harness doc\n", encoding="utf-8")
    os.symlink(outside, codex_p)

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["state"] == "external"
    assert rows["codex"]["follows"] is None


def test_status_unknown_harness_id_raises(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    with pytest.raises(ValueError):
        global_docs.status(["aider"])


# ─────────────────────────────────────────────────────────────────────────────
# link() — every rule
# ─────────────────────────────────────────────────────────────────────────────


def test_link_missing_follower_creates_relative_symlink(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("shared\n", encoding="utf-8")

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result == {"follower": "codex", "source": "claude-code", "changed": True, "backup": None}

    codex_p = global_docs.doc_path("codex")
    assert codex_p.is_symlink()
    target = os.readlink(codex_p)
    assert not os.path.isabs(target), "the symlink must be relative"
    assert codex_p.read_text(encoding="utf-8") == "shared\n"


def test_link_source_missing_errors(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result == {"error": "source_missing", "harness": "claude-code"}


def test_link_same_harness_errors(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("x\n", encoding="utf-8")

    result = global_docs.link("claude-code", "claude-code", backups_root=backups_root)
    assert result == {"error": "same_harness", "harness": "claude-code"}


def test_link_conflict_without_decision_returns_error(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("source text\n", encoding="utf-8")

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    codex_p.write_text("codex's own instructions\n", encoding="utf-8")

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result["error"] == "conflict"
    assert result["harness"] == "codex"
    assert result["existing_bytes"] == len(b"codex's own instructions\n")
    assert result["preview"] == "codex's own instructions\n"
    # Nothing was touched.
    assert codex_p.read_text(encoding="utf-8") == "codex's own instructions\n"
    assert not codex_p.is_symlink()


def test_link_replace_backs_up_then_links(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("source text\n", encoding="utf-8")

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    codex_p.write_text("codex's own instructions\n", encoding="utf-8")

    result = global_docs.link(
        "codex", "claude-code", on_conflict="replace", backups_root=backups_root
    )
    assert result["changed"] is True
    backup_path = Path(result["backup"])
    assert backup_path.exists()
    assert backup_path.read_text(encoding="utf-8") == "codex's own instructions\n"
    assert backup_path.parent == backups_root / "global-docs" / "codex"

    assert codex_p.is_symlink()
    assert codex_p.read_text(encoding="utf-8") == "source text\n"


def test_link_merge_appends_once_and_is_idempotent(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("source text\n", encoding="utf-8")

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    codex_p.write_text("codex's own bit\n", encoding="utf-8")

    result = global_docs.link(
        "codex", "claude-code", on_conflict="merge", backups_root=backups_root
    )
    assert result["changed"] is True
    merged = claude_p.read_text(encoding="utf-8")
    assert merged == "source text\n\n\ncodex's own bit\n"

    # Detach, restore the SAME text codex used to have, and merge again — the
    # source must not gain a second copy since the text is already present.
    undo = global_docs.unlink("codex", backups_root=backups_root)
    assert undo["changed"] is True
    assert codex_p.read_text(encoding="utf-8") == "source text\n\n\ncodex's own bit\n"

    codex_p.write_text("codex's own bit\n", encoding="utf-8")
    result2 = global_docs.link(
        "codex", "claude-code", on_conflict="merge", backups_root=backups_root
    )
    assert result2["changed"] is True
    assert claude_p.read_text(encoding="utf-8") == merged  # unchanged — no double append


def test_link_empty_follower_is_not_a_conflict(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("source text\n", encoding="utf-8")

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    codex_p.write_text("   \n", encoding="utf-8")  # whitespace-only

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result["changed"] is True
    assert "error" not in result
    assert codex_p.is_symlink()


def test_link_follows_same_source_is_a_noop(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("x\n", encoding="utf-8")
    global_docs.link("codex", "claude-code", backups_root=backups_root)

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result == {"follower": "codex", "source": "claude-code", "changed": False}


def test_link_follows_different_source_repoints(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("claude text\n", encoding="utf-8")

    pi_p = global_docs.doc_path("pi")
    pi_p.parent.mkdir(parents=True, exist_ok=True)
    pi_p.write_text("pi text\n", encoding="utf-8")

    global_docs.link("codex", "claude-code", backups_root=backups_root)
    result = global_docs.link("codex", "pi", backups_root=backups_root)
    assert result["changed"] is True

    codex_p = global_docs.doc_path("codex")
    assert codex_p.read_text(encoding="utf-8") == "pi text\n"
    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["follows"] == "pi"
    assert rows["claude-code"]["followers"] == []


def test_link_chain_resolution(global_docs_env, backups_root):
    """`source="codex"` where codex itself follows claude-code resolves to
    claude-code, and the result reports `resolved_source`."""
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("shared\n", encoding="utf-8")
    global_docs.link("codex", "claude-code", backups_root=backups_root)

    result = global_docs.link("pi", "codex", backups_root=backups_root)
    assert result["changed"] is True
    assert result["source"] == "claude-code"
    assert result["resolved_source"] == "claude-code"

    pi_p = global_docs.doc_path("pi")
    target = os.readlink(pi_p)
    # A chain is never created — pi's symlink resolves straight to claude-code,
    # never to codex's own symlink.
    resolved = Path(os.path.normpath(os.path.join(str(pi_p.parent), target)))
    assert resolved == claude_p


def test_link_has_followers_refuses(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("shared\n", encoding="utf-8")
    global_docs.link("codex", "claude-code", backups_root=backups_root)

    pi_p = global_docs.doc_path("pi")
    pi_p.parent.mkdir(parents=True, exist_ok=True)
    pi_p.write_text("pi text\n", encoding="utf-8")

    # claude-code is a `source` (codex follows it) — linking it away is refused.
    result = global_docs.link("claude-code", "pi", backups_root=backups_root)
    assert result == {
        "error": "has_followers",
        "harness": "claude-code",
        "followers": ["codex"],
    }


def test_link_external_follower_is_refused(global_docs_env, backups_root, tmp_path):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("shared\n", encoding="utf-8")

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside.md"
    outside.write_text("not ours\n", encoding="utf-8")
    os.symlink(outside, codex_p)

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result == {"error": "external_link", "harness": "codex"}
    # Untouched.
    assert os.readlink(codex_p) == str(outside)


def test_link_unknown_harness_errors(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    result = global_docs.link("aider", "claude-code", backups_root=backups_root)
    assert result == {"error": "unknown_harness", "harness": "aider"}


def test_link_invalid_on_conflict_value_errors(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    result = global_docs.link(
        "codex", "claude-code", on_conflict="bogus", backups_root=backups_root
    )
    assert result["error"] == "invalid_on_conflict"


# ─────────────────────────────────────────────────────────────────────────────
# unlink()
# ─────────────────────────────────────────────────────────────────────────────


def test_unlink_follows_writes_a_real_copy(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("shared text\n", encoding="utf-8")
    global_docs.link("codex", "claude-code", backups_root=backups_root)

    codex_p = global_docs.doc_path("codex")
    assert codex_p.is_symlink()
    expected = claude_p.read_bytes()

    result = global_docs.unlink("codex", backups_root=backups_root)
    assert result["changed"] is True
    assert result["bytes"] == len(expected)
    assert not codex_p.is_symlink()
    assert codex_p.read_bytes() == expected
    assert codex_p.read_text(encoding="utf-8") == "shared text\n"

    # And claude-code no longer has codex as a follower.
    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["claude-code"]["state"] == "standalone"
    assert rows["claude-code"]["followers"] == []


def test_unlink_broken_writes_an_empty_file(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    codex_p = global_docs.doc_path("codex")
    codex_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p = global_docs.doc_path("claude-code")
    rel = os.path.relpath(claude_p, codex_p.parent)
    os.symlink(rel, codex_p)  # dangling — claude-code has no file

    result = global_docs.unlink("codex", backups_root=backups_root)
    assert result["changed"] is True
    assert result["bytes"] == 0
    assert result["backup"] is not None  # the raw (dangling) link text got saved
    assert Path(result["backup"]).read_text(encoding="utf-8") == rel
    assert not codex_p.is_symlink()
    assert codex_p.read_text(encoding="utf-8") == ""


def test_unlink_not_a_follower_errors(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    claude_p = global_docs.doc_path("claude-code")
    claude_p.parent.mkdir(parents=True, exist_ok=True)
    claude_p.write_text("x\n", encoding="utf-8")

    result = global_docs.unlink("claude-code", backups_root=backups_root)
    assert result == {"error": "not_a_follower", "harness": "claude-code", "state": "standalone"}


def test_unlink_unknown_harness_errors(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    result = global_docs.unlink("aider", backups_root=backups_root)
    assert result == {"error": "unknown_harness", "harness": "aider"}


# ─────────────────────────────────────────────────────────────────────────────
# CLI — subprocess, `--json` shapes + exit codes
# ─────────────────────────────────────────────────────────────────────────────


def _cli(home: Path, data_home: Path, args: list):
    env = {
        **os.environ,
        "HOME": str(home),
        "USERPROFILE": str(home),
        "SKILL_HUB_HOME": str(data_home),
        "SKILL_HUB_CLAUDE_HOME": str(home / ".claude"),
        "CODEX_HOME": str(home / ".codex"),
    }
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


@pytest.fixture
def cli_home(tmp_path):
    home = tmp_path / "home"
    data_home = tmp_path / "data-home"
    home.mkdir(parents=True, exist_ok=True)
    data_home.mkdir(parents=True, exist_ok=True)
    return home, data_home


def test_cli_status_json_shape(cli_home):
    home, data_home = cli_home
    claude_doc = home / ".claude" / "CLAUDE.md"
    claude_doc.parent.mkdir(parents=True, exist_ok=True)
    claude_doc.write_text("shared\n", encoding="utf-8")

    proc = _cli(home, data_home, ["harness", "doc", "status", "--json"])
    assert proc.returncode == 0, proc.stderr
    rows = json.loads(proc.stdout)
    by_id = {r["harness"]: r for r in rows}
    assert set(by_id) == {"claude-code", "codex", "pi", "opencode"}
    assert by_id["claude-code"]["state"] == "standalone"
    assert by_id["codex"]["state"] == "missing"


def test_cli_link_success_json_exit_zero(cli_home):
    home, data_home = cli_home
    claude_doc = home / ".claude" / "CLAUDE.md"
    claude_doc.parent.mkdir(parents=True, exist_ok=True)
    claude_doc.write_text("shared\n", encoding="utf-8")

    proc = _cli(
        home,
        data_home,
        ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"],
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload == {
        "follower": "codex",
        "source": "claude-code",
        "changed": True,
        "backup": None,
    }
    assert (home / ".codex" / "AGENTS.md").is_symlink()


def test_cli_link_conflict_exits_two_with_payload(cli_home):
    home, data_home = cli_home
    claude_doc = home / ".claude" / "CLAUDE.md"
    claude_doc.parent.mkdir(parents=True, exist_ok=True)
    claude_doc.write_text("shared\n", encoding="utf-8")
    codex_doc = home / ".codex" / "AGENTS.md"
    codex_doc.parent.mkdir(parents=True, exist_ok=True)
    codex_doc.write_text("codex's own\n", encoding="utf-8")

    proc = _cli(
        home,
        data_home,
        ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"],
    )
    assert proc.returncode == 2, proc.stdout
    payload = json.loads(proc.stdout)
    assert payload["error"] == "conflict"
    assert payload["existing_bytes"] == len(b"codex's own\n")


def test_cli_link_other_error_exits_one_with_payload(cli_home):
    home, data_home = cli_home
    claude_doc = home / ".claude" / "CLAUDE.md"
    claude_doc.parent.mkdir(parents=True, exist_ok=True)
    claude_doc.write_text("shared\n", encoding="utf-8")

    proc = _cli(
        home,
        data_home,
        ["harness", "doc", "link", "claude-code", "--to", "claude-code", "--json"],
    )
    assert proc.returncode == 1, proc.stdout
    payload = json.loads(proc.stdout)
    assert payload == {"error": "same_harness", "harness": "claude-code"}


def test_cli_unlink_json(cli_home):
    home, data_home = cli_home
    claude_doc = home / ".claude" / "CLAUDE.md"
    claude_doc.parent.mkdir(parents=True, exist_ok=True)
    claude_doc.write_text("shared\n", encoding="utf-8")
    link_proc = _cli(
        home,
        data_home,
        ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"],
    )
    assert link_proc.returncode == 0, link_proc.stderr

    proc = _cli(home, data_home, ["harness", "doc", "unlink", "codex", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["changed"] is True
    assert payload["bytes"] == len(b"shared\n")
    assert not (home / ".codex" / "AGENTS.md").is_symlink()


# ═════════════════════════════════════════════════════════════════════════════
# Adversarial coverage (review pass over B1)
#
# Everything below attacks a path the first round did not: link shapes hub did
# not create itself (absolute links, chains, loops, directories), bytes that do
# not survive a decode, and dotfile dirs that refuse a write.
# ═════════════════════════════════════════════════════════════════════════════


def _write(p: Path, text: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


# ─────────────────────────────────────────────────────────────────────────────
# status() — links hub did not create
# ─────────────────────────────────────────────────────────────────────────────


def test_status_absolute_symlink_still_reads_as_follows(global_docs_env):
    """Hub always writes RELATIVE links, but a user (or an older hub) may have
    made an absolute one. It points at the same file, so it must classify the
    same — `os.path.join` already returns the absolute arm."""
    from skill_hub.infrastructure.filesystem import global_docs

    src = _write(global_docs.doc_path("claude-code"), "shared\n")
    dst = global_docs.doc_path("codex")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(str(src), dst)  # ABSOLUTE, not relative

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["state"] == "follows"
    assert rows["codex"]["follows"] == "claude-code"
    assert rows["claude-code"]["state"] == "source"
    assert rows["claude-code"]["followers"] == ["codex"]


def test_status_symlink_to_a_directory_is_external(global_docs_env, tmp_path):
    from skill_hub.infrastructure.filesystem import global_docs

    a_dir = tmp_path / "some-dir"
    a_dir.mkdir()
    dst = global_docs.doc_path("codex")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(str(a_dir), dst)

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["state"] == "external"
    assert rows["codex"]["follows"] is None


def test_status_sees_a_chain_it_would_never_create(global_docs_env):
    """`link()` never builds `a → b → c`, but a hand-made chain must still be
    readable rather than crash or lie: the middle link reports `follows` (what
    it is) AND its own follower list (what depends on it)."""
    from skill_hub.infrastructure.filesystem import global_docs

    claude = _write(global_docs.doc_path("claude-code"), "shared\n")
    codex = global_docs.doc_path("codex")
    codex.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(os.path.relpath(claude, codex.parent), codex)
    pi = global_docs.doc_path("pi")
    pi.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(os.path.relpath(codex, pi.parent), pi)

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["claude-code"]["state"] == "source"
    assert rows["claude-code"]["followers"] == ["codex"]
    assert (rows["codex"]["state"], rows["codex"]["follows"]) == ("follows", "claude-code")
    assert rows["codex"]["followers"] == ["pi"]
    assert (rows["pi"]["state"], rows["pi"]["follows"]) == ("follows", "codex")
    assert pi.read_text(encoding="utf-8") == "shared\n"


def test_status_dangling_link_whose_target_dir_does_not_exist_is_broken(global_docs_env):
    from skill_hub.infrastructure.filesystem import global_docs

    codex = global_docs.doc_path("codex")
    codex.parent.mkdir(parents=True, exist_ok=True)
    claude = global_docs.doc_path("claude-code")
    assert not claude.parent.exists(), "the whole target DIR is missing, not just the file"
    os.symlink(os.path.relpath(claude, codex.parent), codex)

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["state"] == "broken"
    assert rows["codex"]["follows"] == "claude-code"
    # A broken link contributes no follower to the harness it names.
    assert rows["claude-code"]["state"] == "missing"
    assert rows["claude-code"]["followers"] == []


def test_status_symlink_loop_terminates_and_reads_broken(global_docs_env, backups_root):
    """Two docs pointing at each other: `exists()` on either raises ELOOP
    internally and returns False, so both are `broken`. The point of the test
    is that nothing hangs and `unlink` can still rescue one side."""
    from skill_hub.infrastructure.filesystem import global_docs

    a = global_docs.doc_path("claude-code")
    b = global_docs.doc_path("codex")
    a.parent.mkdir(parents=True, exist_ok=True)
    b.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(os.path.relpath(b, a.parent), a)
    os.symlink(os.path.relpath(a, b.parent), b)

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["claude-code"]["state"] == "broken"
    assert rows["codex"]["state"] == "broken"

    assert global_docs.unlink("codex", backups_root=backups_root)["changed"] is True
    assert not b.is_symlink()
    assert b.read_bytes() == b""


def test_status_and_link_survive_a_home_with_spaces_and_unicode(
    global_docs_env, monkeypatch, tmp_path, backups_root
):
    from skill_hub.infrastructure.filesystem import global_docs

    weird = tmp_path / "a home wîth spaces ✨"
    weird.mkdir()
    monkeypatch.setenv("HOME", str(weird))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(weird / ".claude"))
    monkeypatch.setenv("CODEX_HOME", str(weird / ".codex"))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: weird))

    _write(global_docs.doc_path("claude-code"), "shared\n")
    assert global_docs.link("codex", "claude-code", backups_root=backups_root)["changed"] is True

    codex = global_docs.doc_path("codex")
    assert os.readlink(codex) == "../.claude/CLAUDE.md"
    assert codex.read_text(encoding="utf-8") == "shared\n"
    assert {r["harness"]: r["state"] for r in global_docs.status()}["codex"] == "follows"


def test_a_harness_with_no_global_doc_is_absent_everywhere(monkeypatch, backups_root):
    """`conftest`'s isolation nulls `global_doc` on every harness; this test
    re-enables ONE of them, so codex stands in for a (hypothetical) harness
    that has no user-global instruction file at all."""
    import dataclasses as dc

    from skill_hub.infrastructure.filesystem import global_docs
    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dc.replace(
        patched["claude-code"], global_doc=PurePath("~/.claude/CLAUDE.md")
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    assert global_docs.doc_path("codex") is None
    assert [r["harness"] for r in global_docs.status()] == ["claude-code"]
    with pytest.raises(ValueError, match="no user-global instruction file"):
        global_docs.status(["codex"])
    assert global_docs.link("codex", "claude-code", backups_root=backups_root) == {
        "error": "unknown_harness",
        "harness": "codex",
    }


# ─────────────────────────────────────────────────────────────────────────────
# link() — refusals that keep someone else's file safe
# ─────────────────────────────────────────────────────────────────────────────


def test_link_creates_the_followers_parent_dir(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    pi = global_docs.doc_path("pi")
    assert not pi.parent.exists()

    assert global_docs.link("pi", "claude-code", backups_root=backups_root)["changed"] is True
    assert pi.is_symlink()
    assert pi.read_text(encoding="utf-8") == "shared\n"


def test_link_leaves_a_dangling_external_link_completely_alone(
    global_docs_env, backups_root, tmp_path
):
    """A dead link to somewhere outside the harness set is `external`, NOT
    `broken`: hub cannot know it is dead on purpose (a target on an unmounted
    volume, a dotfile repo not yet cloned), so it refuses both verbs instead
    of quietly reclaiming the path."""
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    codex = global_docs.doc_path("codex")
    codex.parent.mkdir(parents=True, exist_ok=True)
    elsewhere = tmp_path / "dotfiles" / "AGENTS.md"
    os.symlink(str(elsewhere), codex)

    rows = {r["harness"]: r for r in global_docs.status()}
    assert rows["codex"]["state"] == "external"
    assert global_docs.link("codex", "claude-code", backups_root=backups_root) == {
        "error": "external_link",
        "harness": "codex",
    }
    assert global_docs.unlink("codex", backups_root=backups_root) == {
        "error": "not_a_follower",
        "harness": "codex",
        "state": "external",
    }
    assert codex.is_symlink() and os.readlink(codex) == str(elsewhere)


def test_link_to_a_source_that_is_an_external_link_is_refused(
    global_docs_env, backups_root, tmp_path
):
    from skill_hub.infrastructure.filesystem import global_docs

    ext = _write(tmp_path / "ext.md", "somewhere else\n")
    claude = global_docs.doc_path("claude-code")
    claude.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(str(ext), claude)

    assert global_docs.link("codex", "claude-code", backups_root=backups_root) == {
        "error": "external_link",
        "harness": "claude-code",
    }
    assert not global_docs.doc_path("codex").exists()


def test_link_refuses_to_build_a_cycle(global_docs_env, backups_root):
    """`link a --to b` where b already follows a would make a two-node loop.
    Chain resolution turns b into a, and the post-resolution self check stops
    it."""
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    global_docs.link("codex", "claude-code", backups_root=backups_root)

    assert global_docs.link("claude-code", "codex", backups_root=backups_root) == {
        "error": "same_harness",
        "harness": "claude-code",
    }
    assert global_docs.doc_path("claude-code").is_file()
    assert not global_docs.doc_path("claude-code").is_symlink()


def test_link_to_itself_says_so_even_with_no_file_yet(global_docs_env, backups_root):
    """`hub harness doc link x --to x` is a user typo, not a missing source —
    it must name the real problem whatever state x's doc is in."""
    from skill_hub.infrastructure.filesystem import global_docs

    assert global_docs.link("codex", "codex", backups_root=backups_root) == {
        "error": "same_harness",
        "harness": "codex",
    }
    _write(global_docs.doc_path("codex"), "mine\n")
    assert global_docs.link("codex", "codex", backups_root=backups_root) == {
        "error": "same_harness",
        "harness": "codex",
    }


def test_link_refuses_a_source_that_is_a_directory(global_docs_env, backups_root):
    """`status()` calls any existing non-symlink path `standalone`, and a
    DIRECTORY at the doc path satisfies that. Linking to one would produce a
    symlink to a directory; refuse instead."""
    from skill_hub.infrastructure.filesystem import global_docs

    global_docs.doc_path("claude-code").mkdir(parents=True)

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result["error"] == "source_not_a_file"
    assert result["harness"] == "claude-code"
    assert not global_docs.doc_path("codex").exists()


def test_link_reports_an_unwritable_follower_as_data_not_a_traceback(
    global_docs_env, backups_root
):
    """A read-only dotfile dir must come back as an `{"error": ...}` dict —
    an uncaught OSError would print a traceback on stderr and leave `--json`
    stdout empty, which the app parses as a crash."""
    from skill_hub.infrastructure.filesystem import global_docs

    if os.geteuid() == 0:
        pytest.skip("root ignores the write bit")

    _write(global_docs.doc_path("claude-code"), "shared\n")
    codex = _write(global_docs.doc_path("codex"), "mine\n")
    os.chmod(codex.parent, 0o500)
    try:
        result = global_docs.link(
            "codex", "claude-code", on_conflict="replace", backups_root=backups_root
        )
    finally:
        os.chmod(codex.parent, 0o700)

    assert result["error"] == "io_error"
    assert result["harness"] == "codex"
    assert "detail" in result
    assert codex.read_text(encoding="utf-8") == "mine\n", "the file must be intact"


def test_link_reports_a_directory_follower_as_data_not_a_traceback(
    global_docs_env, backups_root
):
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    global_docs.doc_path("codex").mkdir(parents=True)

    result = global_docs.link(
        "codex", "claude-code", on_conflict="replace", backups_root=backups_root
    )
    assert result["error"] == "io_error"
    assert global_docs.doc_path("codex").is_dir()


# ─────────────────────────────────────────────────────────────────────────────
# link() — merge, the only verb that rewrites somebody else's file
# ─────────────────────────────────────────────────────────────────────────────


def test_merge_appends_nothing_the_second_time_around(global_docs_env, backups_root):
    """The first merge folds codex's text into claude's. Detaching gives codex
    a copy of the merged file; merging THAT back must be a no-op, not a
    doubling — the containment check is what makes re-linking safe."""
    from skill_hub.infrastructure.filesystem import global_docs

    src = _write(global_docs.doc_path("claude-code"), "SOURCE")  # no trailing newline
    _write(global_docs.doc_path("codex"), "MINE\n")

    global_docs.link("codex", "claude-code", on_conflict="merge", backups_root=backups_root)
    assert src.read_text(encoding="utf-8") == "SOURCE\n\nMINE\n"

    global_docs.unlink("codex", backups_root=backups_root)
    global_docs.link("codex", "claude-code", on_conflict="merge", backups_root=backups_root)
    assert src.read_text(encoding="utf-8") == "SOURCE\n\nMINE\n"
    assert global_docs.doc_path("codex").is_symlink()


def test_merge_skips_a_whitespace_only_follower(global_docs_env, backups_root):
    """An empty-ish file is not a conflict and carries nothing worth merging,
    so the source must come out byte-identical."""
    from skill_hub.infrastructure.filesystem import global_docs

    src = _write(global_docs.doc_path("claude-code"), "SOURCE\n")
    _write(global_docs.doc_path("codex"), "   \n\n\t")

    result = global_docs.link(
        "codex", "claude-code", on_conflict="merge", backups_root=backups_root
    )
    assert result["changed"] is True
    assert src.read_text(encoding="utf-8") == "SOURCE\n"
    # Backed up anyway — cheap, and the user still gets their whitespace back.
    assert Path(result["backup"]).read_text(encoding="utf-8") == "   \n\n\t"


def test_merge_backs_up_the_source_before_rewriting_it(global_docs_env, backups_root):
    """`backup` in the result names the FOLLOWER's copy. The source is edited
    too, so it needs its own backup — under its own harness id."""
    from skill_hub.infrastructure.filesystem import global_docs

    src = _write(global_docs.doc_path("claude-code"), "SOURCE\n")
    _write(global_docs.doc_path("codex"), "MINE\n")

    result = global_docs.link(
        "codex", "claude-code", on_conflict="merge", backups_root=backups_root
    )
    follower_backup = Path(result["backup"])
    assert follower_backup.parent.name == "codex"
    assert follower_backup.read_text(encoding="utf-8") == "MINE\n"

    source_backups = sorted((backups_root / "global-docs" / "claude-code").glob("*.md"))
    assert len(source_backups) == 1, "the merge must snapshot the source it rewrites"
    assert source_backups[0].read_text(encoding="utf-8") == "SOURCE\n"
    # The separator is a literal "\n\n", so a source that already ended in a
    # newline gets three. Cosmetic, and exactly what the spec asks for.
    assert src.read_text(encoding="utf-8") == "SOURCE\n\n\nMINE\n"


def test_merge_preserves_non_utf8_bytes_on_both_sides(global_docs_env, backups_root):
    """Regression: merging via decoded text rewrote every undecodable byte as
    U+FFFD — corrupting a source file the user never asked us to re-encode."""
    from skill_hub.infrastructure.filesystem import global_docs

    src = global_docs.doc_path("claude-code")
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(b"caf\xe9 source")
    follower = global_docs.doc_path("codex")
    follower.parent.mkdir(parents=True, exist_ok=True)
    follower.write_bytes(b"na\xefve follower")

    global_docs.link("codex", "claude-code", on_conflict="merge", backups_root=backups_root)
    assert src.read_bytes() == b"caf\xe9 source\n\nna\xefve follower"


def test_conflict_preview_decodes_lossily_without_touching_the_file(
    global_docs_env, backups_root
):
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    follower = global_docs.doc_path("codex")
    follower.parent.mkdir(parents=True, exist_ok=True)
    follower.write_bytes(b"caf\xe9 mine")

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result["error"] == "conflict"
    assert result["existing_bytes"] == len(b"caf\xe9 mine")
    assert "�" in result["preview"], "the preview may be lossy…"
    assert follower.read_bytes() == b"caf\xe9 mine", "…the file may not"


def test_conflict_preview_is_capped(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    _write(global_docs.doc_path("codex"), "x" * 5000)

    result = global_docs.link("codex", "claude-code", backups_root=backups_root)
    assert result["error"] == "conflict"
    assert len(result["preview"]) == global_docs.PREVIEW_CHARS
    assert result["existing_bytes"] == 5000


def test_replace_backs_up_before_the_file_stops_being_a_file(global_docs_env, backups_root):
    """Ordering test: after `replace`, the follower's own path is a link, so
    the ONLY copy of its old text is the backup — which must therefore have
    been written first."""
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    follower = _write(global_docs.doc_path("codex"), "irreplaceable\n")

    result = global_docs.link(
        "codex", "claude-code", on_conflict="replace", backups_root=backups_root
    )
    assert follower.is_symlink()
    assert follower.read_text(encoding="utf-8") == "shared\n"
    backup = Path(result["backup"])
    assert backup.is_file()
    assert backup.read_text(encoding="utf-8") == "irreplaceable\n"


# ─────────────────────────────────────────────────────────────────────────────
# unlink() — the detached copy must be byte-identical
# ─────────────────────────────────────────────────────────────────────────────


def test_unlink_copies_bytes_not_decoded_text(global_docs_env, backups_root):
    """Regression: the copy went through `read_text(errors="replace")`, so a
    latin-1 byte came back as U+FFFD and the detached file no longer matched
    what the harness had been reading a second earlier."""
    from skill_hub.infrastructure.filesystem import global_docs

    raw = b"caf\xe9 \xff\xfe no trailing newline"
    src = global_docs.doc_path("claude-code")
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(raw)

    global_docs.link("codex", "claude-code", backups_root=backups_root)
    result = global_docs.unlink("codex", backups_root=backups_root)

    follower = global_docs.doc_path("codex")
    assert follower.read_bytes() == raw
    assert result["bytes"] == len(raw)
    assert src.read_bytes() == raw, "the source is untouched by a detach"


def test_unlink_preserves_a_missing_trailing_newline(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "no newline at the end")
    global_docs.link("codex", "claude-code", backups_root=backups_root)
    global_docs.unlink("codex", backups_root=backups_root)
    assert global_docs.doc_path("codex").read_bytes() == b"no newline at the end"


def test_unlink_on_a_missing_doc_is_a_clear_error(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    assert global_docs.unlink("codex", backups_root=backups_root) == {
        "error": "not_a_follower",
        "harness": "codex",
        "state": "missing",
    }
    assert not global_docs.doc_path("codex").exists(), "no empty file conjured"


def test_unlink_backup_records_where_the_link_pointed(global_docs_env, backups_root):
    from skill_hub.infrastructure.filesystem import global_docs

    _write(global_docs.doc_path("claude-code"), "shared\n")
    global_docs.link("codex", "claude-code", backups_root=backups_root)
    link_text = os.readlink(global_docs.doc_path("codex"))
    assert not os.path.isabs(link_text)

    result = global_docs.unlink("codex", backups_root=backups_root)
    assert Path(result["backup"]).read_text(encoding="utf-8") == link_text


# ─────────────────────────────────────────────────────────────────────────────
# backup.py alias
# ─────────────────────────────────────────────────────────────────────────────


def test_backup_alias_matches_the_module(global_docs_env):
    from skill_hub.application.backup import backup
    from skill_hub.infrastructure.filesystem import global_docs
    from skill_hub.infrastructure.harnesses import harnesses

    for h_id in ("claude-code", "codex", "pi", "opencode"):
        assert backup.harness_global_doc(harnesses.HARNESSES[h_id]) == global_docs.doc_path(h_id)


@pytest.mark.parametrize("order", [("global_docs", "backup"), ("backup", "global_docs")])
def test_no_import_cycle_between_backup_and_global_docs(order, tmp_path):
    """`backup` imports `global_docs` inside the function body, so neither
    order may deadlock or fail — checked in a FRESH interpreter, since an
    in-process import would already be cached by this test session."""
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "USERPROFILE": str(tmp_path),
        "PYTHONPATH": str(REPO_ROOT / "vendor"),
    }
    modules = {
        "backup": "skill_hub.application.backup.backup",
        "global_docs": "skill_hub.infrastructure.filesystem.global_docs",
    }
    code = (
        f"import {modules[order[0]]}; import {modules[order[1]]}; "
        "print(skill_hub.application.backup.backup.harness_global_doc.__module__)"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "skill_hub.application.backup.backup"


# ─────────────────────────────────────────────────────────────────────────────
# CLI — text rendering, stdout purity, exit codes
# ─────────────────────────────────────────────────────────────────────────────


def test_cli_json_stdout_holds_the_payload_and_nothing_else(cli_home):
    """The Dev-gotchas rule: no auto-sync chatter may follow the JSON, so the
    whole of stdout parses."""
    from skill_hub.infrastructure.filesystem import global_docs  # noqa: F401  (import guard: the CLI must find it too)

    home, data_home = cli_home
    _write(home / ".claude" / "CLAUDE.md", "shared\n")

    for args in (
        ["harness", "doc", "status", "--json"],
        ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"],
        ["harness", "doc", "unlink", "codex", "--json"],
    ):
        proc = _cli(home, data_home, args)
        assert proc.returncode == 0, proc.stderr
        json.loads(proc.stdout)  # the WHOLE of stdout, not a prefix
        assert proc.stdout.endswith("\n")
        assert proc.stderr == ""


def test_cli_status_text_names_every_relationship(cli_home):
    home, data_home = cli_home
    _write(home / ".claude" / "CLAUDE.md", "shared\n")
    broken = home / ".config" / "opencode" / "AGENTS.md"
    broken.parent.mkdir(parents=True, exist_ok=True)
    os.symlink("../../.pi/agent/AGENTS.md", broken)  # pi's doc is never created
    assert _cli(
        home, data_home, ["harness", "doc", "link", "codex", "--to", "claude-code"]
    ).returncode == 0

    proc = _cli(home, data_home, ["harness", "doc", "status"])
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout
    assert "claude-code" in out and "source" in out and "shared with codex" in out
    assert "follows claude-code" in out
    assert "broken (was pi)" in out
    assert "pi" in out and "missing" in out


def test_cli_text_mode_success_and_failure(cli_home):
    home, data_home = cli_home
    _write(home / ".claude" / "CLAUDE.md", "shared\n")

    ok = _cli(home, data_home, ["harness", "doc", "link", "codex", "--to", "claude-code"])
    assert ok.returncode == 0
    assert "codex now follows claude-code" in ok.stdout
    assert ok.stderr == ""

    again = _cli(home, data_home, ["harness", "doc", "link", "codex", "--to", "claude-code"])
    assert again.returncode == 0
    assert "already follows" in again.stdout

    detach = _cli(home, data_home, ["harness", "doc", "unlink", "codex"])
    assert detach.returncode == 0
    assert "is its own file now (7 bytes)" in detach.stdout

    twice = _cli(home, data_home, ["harness", "doc", "unlink", "codex"])
    assert twice.returncode == 1
    assert twice.stdout == "", "an error says nothing on stdout in text mode"
    assert "not_a_follower" in twice.stderr


def test_cli_link_conflict_then_replace_recovers(cli_home):
    """The documented recovery loop: exit 2 + payload, retry with a decision."""
    home, data_home = cli_home
    _write(home / ".claude" / "CLAUDE.md", "shared\n")
    codex_doc = _write(home / ".codex" / "AGENTS.md", "codex's own\n")

    first = _cli(
        home, data_home, ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"]
    )
    assert first.returncode == 2
    assert json.loads(first.stdout)["error"] == "conflict"

    second = _cli(
        home,
        data_home,
        ["harness", "doc", "link", "codex", "--to", "claude-code",
         "--on-conflict", "replace", "--json"],
    )
    assert second.returncode == 0
    payload = json.loads(second.stdout)
    assert payload["changed"] is True
    assert Path(payload["backup"]).read_text(encoding="utf-8") == "codex's own\n"
    assert codex_doc.is_symlink()


def test_cli_link_reports_the_chain_resolution_it_performed(cli_home):
    home, data_home = cli_home
    _write(home / ".claude" / "CLAUDE.md", "shared\n")
    assert _cli(
        home, data_home, ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"]
    ).returncode == 0

    proc = _cli(
        home, data_home, ["harness", "doc", "link", "pi", "--to", "codex", "--json"]
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["source"] == "claude-code"
    assert payload["resolved_source"] == "claude-code"
    # …and the new link points at the real file, not at codex's link.
    assert os.readlink(home / ".pi" / "agent" / "AGENTS.md").endswith(".claude/CLAUDE.md")


def test_cli_link_has_followers_is_refused(cli_home):
    home, data_home = cli_home
    _write(home / ".claude" / "CLAUDE.md", "claude text\n")
    _write(home / ".config" / "opencode" / "AGENTS.md", "opencode text\n")
    assert _cli(
        home, data_home, ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"]
    ).returncode == 0

    proc = _cli(
        home,
        data_home,
        ["harness", "doc", "link", "claude-code", "--to", "opencode",
         "--on-conflict", "replace", "--json"],
    )
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["error"] == "has_followers"
    assert payload["followers"] == ["codex"]
    assert (home / ".claude" / "CLAUDE.md").is_file()


def test_cli_doc_without_a_subcommand_prints_help(cli_home):
    home, data_home = cli_home
    proc = _cli(home, data_home, ["harness", "doc"])
    assert proc.returncode == 0
    assert "status" in proc.stdout and "link" in proc.stdout and "unlink" in proc.stdout


def test_cli_status_reports_a_missing_home_without_creating_anything(cli_home):
    """`status` is read-only: it must not mkdir a single dotfile dir."""
    home, data_home = cli_home
    proc = _cli(home, data_home, ["harness", "doc", "status", "--json"])
    assert proc.returncode == 0
    assert all(r["state"] == "missing" for r in json.loads(proc.stdout))
    for name in (".claude", ".codex", ".pi", ".config"):
        assert not (home / name).exists(), f"status created {name}"
