"""Tests for the canonical agent-docs root policy (agent_docs.py)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import agent_docs


# ─────────────────────────────────────────────────────────────────────────────
# Strategy resolution
# ─────────────────────────────────────────────────────────────────────────────


def test_strategy_default_is_symlink():
    assert agent_docs.resolve_strategy({}, {}) == "symlink"


def test_strategy_global_wins_over_default():
    reg = {"agent_docs": {"root_strategy": "import"}}
    assert agent_docs.resolve_strategy({}, reg) == "import"


def test_strategy_project_override_wins_over_global():
    reg = {"agent_docs": {"root_strategy": "import"}}
    proj = {"agent_docs": {"root_strategy": "symlink"}}
    assert agent_docs.resolve_strategy(proj, reg) == "symlink"


def test_strategy_invalid_values_fall_through():
    reg = {"agent_docs": {"root_strategy": "bogus"}}
    proj = {"agent_docs": {"root_strategy": "nonsense"}}
    assert agent_docs.resolve_strategy(proj, reg) == "symlink"


# ─────────────────────────────────────────────────────────────────────────────
# Canonical-root selection
# ─────────────────────────────────────────────────────────────────────────────


def _proj(path, harnesses):
    return {"path": str(path), "harnesses": list(harnesses)}


def test_canonical_claude_only():
    proj = _proj("/x", ["claude-code"])
    res = agent_docs.resolve_canonical_root(proj, {}, installed={"claude-code"})
    assert res == {"canonical": "CLAUDE.md", "derived": None}


def test_canonical_claude_plus_other():
    proj = _proj("/x", ["claude-code", "codex"])
    res = agent_docs.resolve_canonical_root(
        proj, {}, installed={"claude-code", "codex"}
    )
    assert res == {"canonical": "AGENTS.md", "derived": "CLAUDE.md"}


def test_canonical_non_claude_only():
    proj = _proj("/x", ["codex", "pi"])
    res = agent_docs.resolve_canonical_root(proj, {}, installed={"codex", "pi"})
    assert res == {"canonical": "AGENTS.md", "derived": None}


def test_canonical_no_installed_harness_is_inert():
    proj = _proj("/x", ["claude-code"])
    res = agent_docs.resolve_canonical_root(proj, {}, installed=set())
    assert res == {"canonical": None, "derived": None}


def test_unknown_harness_id_is_inert():
    # Unknown id is filtered by resolve_effective; nothing required from it.
    proj = _proj("/x", ["made-up"])
    res = agent_docs.resolve_canonical_root(proj, {}, installed={"made-up"})
    assert res == {"canonical": None, "derived": None}


# ─────────────────────────────────────────────────────────────────────────────
# On-disk classification
# ─────────────────────────────────────────────────────────────────────────────


def test_classify_absent(tmp_path):
    assert agent_docs.classify_claude(tmp_path) == "absent"


def test_classify_user_prose(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("# Project\nReal instructions.\n")
    assert agent_docs.classify_claude(tmp_path) == "user"


def test_classify_import_pointer(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("@AGENTS.md\n")
    assert agent_docs.classify_claude(tmp_path) == "derived-import"


def test_classify_symlink(tmp_path):
    (tmp_path / "AGENTS.md").write_text("shared\n")
    os.symlink("AGENTS.md", tmp_path / "CLAUDE.md")
    assert agent_docs.classify_claude(tmp_path) == "derived-symlink"


# ─────────────────────────────────────────────────────────────────────────────
# Detection (read-only)
# ─────────────────────────────────────────────────────────────────────────────


def test_detect_claude_only_is_ok(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("real\n")
    proj = _proj(tmp_path, ["claude-code"])
    st = agent_docs.detect_status(proj, {}, installed={"claude-code"})
    assert st["state"] == "ok"


def test_detect_promote_needed(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("real instructions\n")
    proj = _proj(tmp_path, ["claude-code", "codex"])
    st = agent_docs.detect_status(
        proj, {}, installed={"claude-code", "codex"}
    )
    assert st["state"] == "needs_canonicalization"


def test_detect_canonical_symlink_is_ok(tmp_path):
    (tmp_path / "AGENTS.md").write_text("shared\n")
    os.symlink("AGENTS.md", tmp_path / "CLAUDE.md")
    proj = _proj(tmp_path, ["claude-code", "codex"])
    st = agent_docs.detect_status(proj, {}, installed={"claude-code", "codex"})
    assert st["state"] == "ok"


def test_detect_divergent_conflict(tmp_path):
    (tmp_path / "AGENTS.md").write_text("agents content\n")
    (tmp_path / "CLAUDE.md").write_text("DIFFERENT claude content\n")
    proj = _proj(tmp_path, ["claude-code", "codex"])
    st = agent_docs.detect_status(proj, {}, installed={"claude-code", "codex"})
    assert st["state"] == "conflict"


# ─────────────────────────────────────────────────────────────────────────────
# Migration
# ─────────────────────────────────────────────────────────────────────────────


def _backups(tmp_path):
    return tmp_path / "_backups"


def test_migrate_dry_run_writes_nothing(tmp_path):
    proot = tmp_path / "proj"
    proot.mkdir()
    (proot / "CLAUDE.md").write_text("real\n")
    proj = _proj(proot, ["claude-code", "codex"])
    plan = agent_docs.plan_migration(proj, {}, installed={"claude-code", "codex"})
    assert plan["action"] == "promote"
    # Nothing changed.
    assert (proot / "CLAUDE.md").read_text() == "real\n"
    assert not (proot / "AGENTS.md").exists()


def test_migrate_promote_symlink(tmp_path):
    proot = tmp_path / "proj"
    proot.mkdir()
    (proot / "CLAUDE.md").write_text("real content\n")
    proj = _proj(proot, ["claude-code", "codex"])
    res = agent_docs.migrate(
        proj, {}, "proj", _backups(tmp_path), installed={"claude-code", "codex"}
    )
    assert res["applied"] is True
    assert (proot / "AGENTS.md").read_text() == "real content\n"
    assert (proot / "CLAUDE.md").is_symlink()
    assert os.readlink(proot / "CLAUDE.md") == "AGENTS.md"
    assert res["backups"]  # original CLAUDE.md backed up


def test_migrate_promote_import(tmp_path):
    proot = tmp_path / "proj"
    proot.mkdir()
    (proot / "CLAUDE.md").write_text("real content\n")
    reg = {"agent_docs": {"root_strategy": "import"}}
    proj = _proj(proot, ["claude-code", "codex"])
    agent_docs.migrate(
        proj, reg, "proj", _backups(tmp_path), installed={"claude-code", "codex"}
    )
    assert (proot / "AGENTS.md").read_text() == "real content\n"
    assert not (proot / "CLAUDE.md").is_symlink()
    assert (proot / "CLAUDE.md").read_text().strip() == "@AGENTS.md"


def test_migrate_idempotent(tmp_path):
    proot = tmp_path / "proj"
    proot.mkdir()
    (proot / "CLAUDE.md").write_text("real\n")
    proj = _proj(proot, ["claude-code", "codex"])
    inst = {"claude-code", "codex"}
    agent_docs.migrate(proj, {}, "proj", _backups(tmp_path), installed=inst)
    second = agent_docs.migrate(proj, {}, "proj", _backups(tmp_path), installed=inst)
    assert second["action"] == "noop"
    assert second["applied"] is False


def test_migrate_strategy_switch_rederives(tmp_path):
    proot = tmp_path / "proj"
    proot.mkdir()
    (proot / "CLAUDE.md").write_text("real\n")
    proj = _proj(proot, ["claude-code", "codex"])
    inst = {"claude-code", "codex"}
    # First derive as symlink.
    agent_docs.migrate(proj, {}, "proj", _backups(tmp_path), installed=inst)
    assert (proot / "CLAUDE.md").is_symlink()
    # Switch to import and re-migrate.
    reg = {"agent_docs": {"root_strategy": "import"}}
    res = agent_docs.migrate(proj, reg, "proj", _backups(tmp_path), installed=inst)
    assert res["applied"] is True
    assert not (proot / "CLAUDE.md").is_symlink()
    assert (proot / "CLAUDE.md").read_text().strip() == "@AGENTS.md"


def test_migrate_identical_collapse(tmp_path):
    proot = tmp_path / "proj"
    proot.mkdir()
    (proot / "AGENTS.md").write_text("same\n")
    (proot / "CLAUDE.md").write_text("same\n")
    proj = _proj(proot, ["claude-code", "codex"])
    res = agent_docs.migrate(
        proj, {}, "proj", _backups(tmp_path), installed={"claude-code", "codex"}
    )
    assert res["action"] == "collapse"
    assert (proot / "AGENTS.md").read_text() == "same\n"
    assert (proot / "CLAUDE.md").is_symlink()


def test_migrate_divergent_left_untouched(tmp_path):
    proot = tmp_path / "proj"
    proot.mkdir()
    (proot / "AGENTS.md").write_text("agents\n")
    (proot / "CLAUDE.md").write_text("DIFFERENT\n")
    proj = _proj(proot, ["claude-code", "codex"])
    res = agent_docs.migrate(
        proj, {}, "proj", _backups(tmp_path), installed={"claude-code", "codex"}
    )
    assert res["action"] == "conflict"
    assert res["applied"] is False
    # Both files untouched.
    assert (proot / "AGENTS.md").read_text() == "agents\n"
    assert (proot / "CLAUDE.md").read_text() == "DIFFERENT\n"
    assert not (proot / "CLAUDE.md").is_symlink()
