"""Canonical-status model + fix engine tests (agent_docs.py).

The classification half runs the shared corpus at
``tests/fixtures/agent_docs_corpus.json`` — the same layouts the Rust scanner
asserts in ``app/src-tauri/src/commands/agent_docs.rs`` — so the two
implementations of the status table cannot drift apart.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import agent_docs

CORPUS = Path(__file__).parent / "fixtures" / "agent_docs_corpus.json"


def _build_case(tmp_path: Path, case: dict) -> Path:
    """Materialize one corpus case. ``__outside__/...`` targets land in a
    sibling dir outside the project root."""
    root = tmp_path / "proj"
    root.mkdir()
    outside = tmp_path / "outside"
    for f in case["files"]:
        p = root / f["path"]
        p.parent.mkdir(parents=True, exist_ok=True)
        if f["kind"] == "file":
            p.write_text(f["content"], encoding="utf-8")
        else:
            target = f["target"]
            if target.startswith("__outside__/"):
                ext = outside / target[len("__outside__/") :]
                ext.parent.mkdir(parents=True, exist_ok=True)
                ext.write_text("# outside\n", encoding="utf-8")
                target = str(ext)
            os.symlink(target, p)
    return root


def _load_cases():
    return json.loads(CORPUS.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_corpus_verdicts(tmp_path, case):
    root = _build_case(tmp_path, case)
    for rel, expected in case["expect"].items():
        d = root / rel if rel else root
        cls = agent_docs.classify_directory(
            d,
            root,
            is_root=(rel == ""),
            requires_claude=case["requires_claude"],
            requires_agent=case["requires_agent"],
            strategy=case["strategy"],
        )
        assert cls["verdict"] == expected["verdict"], (
            f"{case['name']}:{rel or 'root'} verdict {cls['verdict']} != {expected['verdict']}"
        )
        assert sorted(cls["flags"]) == sorted(expected["flags"]), (
            f"{case['name']}:{rel or 'root'} flags {cls['flags']} != {expected['flags']}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Fix plan / apply
# ─────────────────────────────────────────────────────────────────────────────

MULTI = {"claude-code", "codex"}


def _proj(path, harnesses=("claude-code", "codex")):
    return {"path": str(path), "harnesses": list(harnesses)}


def _screenshot_layout(tmp_path: Path) -> Path:
    """The real-world bug shape: real CLAUDE.md + AGENT.md→CLAUDE.md legacy
    links at root and in nested dirs, no AGENTS.md anywhere."""
    root = tmp_path / "proj"
    for rel in ("", "agents", "cli"):
        d = root / rel if rel else root
        d.mkdir(parents=True, exist_ok=True)
        (d / "CLAUDE.md").write_text(f"# {rel or 'root'}\n", encoding="utf-8")
        os.symlink("CLAUDE.md", d / "AGENT.md")
    return root


def test_fix_plan_screenshot_case(tmp_path):
    root = _screenshot_layout(tmp_path)
    plan = agent_docs.plan_fix(_proj(root), {}, installed=MULTI)
    by_action = {}
    for s in plan["steps"]:
        by_action.setdefault(s["action"], []).append(s)
    # Root promote is required; nested promotes are opt-in.
    promotes = by_action["promote"]
    root_promote = [s for s in promotes if s["dir"] == ""]
    assert len(root_promote) == 1 and not root_promote[0]["optional"]
    nested_promotes = [s for s in promotes if s["dir"]]
    assert {s["dir"] for s in nested_promotes} == {"agents", "cli"}
    assert all(s["optional"] and not s["selected"] for s in nested_promotes)
    # All three legacy links are removed, none flagged.
    assert {s["dir"] for s in by_action["remove_legacy_link"]} == {"", "agents", "cli"}
    assert plan["flagged"] == []
    # Every step carries fingerprints for its paths.
    assert all(s["preconditions"] for s in plan["steps"])


def test_fix_apply_screenshot_case_no_chains(tmp_path):
    root = _screenshot_layout(tmp_path)
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    # Root: canonical layout, no AGENT.md, no chain.
    assert (root / "AGENTS.md").read_text() == "# root\n"
    assert os.readlink(root / "CLAUDE.md") == "AGENTS.md"
    assert not (root / "AGENT.md").exists() and not (root / "AGENT.md").is_symlink()
    # Nested promotes were NOT selected → nested CLAUDE.md untouched, but the
    # nested legacy links are gone.
    assert (root / "agents" / "CLAUDE.md").read_text() == "# agents\n"
    assert not (root / "agents" / "AGENT.md").is_symlink()
    assert res["backups"]
    # Now fully idempotent: a fresh plan has no steps.
    plan2 = agent_docs.plan_fix(proj, {}, installed=MULTI)
    required = [s for s in plan2["steps"] if not s["optional"]]
    assert required == []


def test_fix_apply_with_selected_nested_promote(tmp_path):
    root = _screenshot_layout(tmp_path)
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    for s in plan["steps"]:
        if s["action"] == "promote" and s["dir"] == "cli":
            s["selected"] = True
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    assert (root / "cli" / "AGENTS.md").read_text() == "# cli\n"
    assert os.readlink(root / "cli" / "CLAUDE.md") == "AGENTS.md"
    # Unselected nested dir untouched (legacy link removed only).
    assert not (root / "agents" / "AGENTS.md").exists()


def test_fix_apply_aborts_when_disk_changed(tmp_path):
    root = _screenshot_layout(tmp_path)
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    # External edit between preview and apply.
    (root / "CLAUDE.md").write_text("# changed externally\n", encoding="utf-8")
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is False
    assert res["error"] == "disk_changed"
    assert res["mismatches"]
    # NOTHING executed — legacy links still present everywhere.
    assert (root / "AGENT.md").is_symlink()
    assert (root / "agents" / "AGENT.md").is_symlink()
    assert not (root / "AGENTS.md").exists()


def test_fix_flags_user_authored_legacy_file_next_to_canonical_pair(tmp_path):
    # A sibling instruction file exists → rename is unsafe, flag only.
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# a\n", encoding="utf-8")
    os.symlink("AGENTS.md", root / "CLAUDE.md")
    (root / "AGENT.md").write_text("# unique prose\n", encoding="utf-8")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    assert [f["path"] for f in plan["flagged"]] == ["AGENT.md"]
    assert all(s["action"] != "remove_legacy_link" for s in plan["steps"])
    assert all(s["action"] != "rename_legacy_file" for s in plan["steps"])
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    assert (root / "AGENT.md").read_text() == "# unique prose\n"


def test_fix_offers_optin_rename_for_lone_legacy_file(tmp_path):
    # The directory's ONLY instruction file is a real AGENT.md → opt-in rename.
    root = tmp_path / "proj"
    tools = root / "tools"
    tools.mkdir(parents=True)
    (root / "AGENTS.md").write_text("# root\n", encoding="utf-8")
    os.symlink("AGENTS.md", root / "CLAUDE.md")
    (tools / "AGENT.md").write_text("# Tool Registries\nbody\n", encoding="utf-8")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    renames = [s for s in plan["steps"] if s["action"] == "rename_legacy_file"]
    assert len(renames) == 1
    assert renames[0]["dir"] == "tools"
    assert renames[0]["optional"] and not renames[0]["selected"]
    assert plan["flagged"] == []
    # Unselected → apply leaves the file untouched.
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    assert (tools / "AGENT.md").read_text() == "# Tool Registries\nbody\n"
    assert not (tools / "AGENTS.md").exists()
    # Selected → backup + rename, content verbatim, dir becomes canonical.
    plan2 = agent_docs.plan_fix(proj, {}, installed=MULTI)
    for s in plan2["steps"]:
        if s["action"] == "rename_legacy_file":
            s["selected"] = True
    res2 = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan2, installed=MULTI)
    assert res2["applied"] is True
    assert res2["backups"]
    assert (tools / "AGENTS.md").read_text() == "# Tool Registries\nbody\n"
    assert not (tools / "AGENT.md").exists()
    cls = agent_docs.classify_directory(
        tools, root, is_root=False, requires_claude=True, requires_agent=True,
        strategy="symlink",
    )
    assert cls["verdict"] == "canonical"
    assert cls["flags"] == []


def test_fix_rename_covers_old_companion_shape(tmp_path):
    # The May-28 companion shape: real AGENT.md + CLAUDE.md → AGENT.md link.
    # Rename must re-point the link, leaving a fully canonical nested set.
    root = tmp_path / "proj"
    tools = root / "tools"
    tools.mkdir(parents=True)
    (root / "AGENTS.md").write_text("# root\n", encoding="utf-8")
    os.symlink("AGENTS.md", root / "CLAUDE.md")
    (tools / "AGENT.md").write_text("# Tools\nbody\n", encoding="utf-8")
    os.symlink("AGENT.md", tools / "CLAUDE.md")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    renames = [s for s in plan["steps"] if s["action"] == "rename_legacy_file"]
    assert len(renames) == 1 and renames[0]["dir"] == "tools"
    assert "re-derive tools/CLAUDE.md" in renames[0]["details"]
    for s in plan["steps"]:
        if s["action"] == "rename_legacy_file":
            s["selected"] = True
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    assert (tools / "AGENTS.md").read_text() == "# Tools\nbody\n"
    assert os.readlink(tools / "CLAUDE.md") == "AGENTS.md"
    assert not (tools / "AGENT.md").exists()
    cls = agent_docs.classify_directory(
        tools, root, is_root=False, requires_claude=True, requires_agent=True,
        strategy="symlink",
    )
    assert cls["verdict"] == "canonical" and cls["flags"] == []


def test_fix_rename_aborts_if_legacy_file_changed_since_plan(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENT.md").write_text("# v1\n", encoding="utf-8")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    for s in plan["steps"]:
        s["selected"] = True
    (root / "AGENT.md").write_text("# v2 changed externally\n", encoding="utf-8")
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is False
    assert res["error"] == "disk_changed"
    assert (root / "AGENT.md").read_text() == "# v2 changed externally\n"


def test_fix_removes_broken_legacy_link(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# a\n", encoding="utf-8")
    os.symlink("AGENTS.md", root / "CLAUDE.md")
    os.symlink("missing.md", root / "AGENT.md")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    assert [s["action"] for s in plan["steps"]] == ["remove_legacy_link"]
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    assert not (root / "AGENT.md").is_symlink()


def test_fix_rederive_on_strategy_switch(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# a\n", encoding="utf-8")
    os.symlink("AGENTS.md", root / "CLAUDE.md")
    proj = _proj(root)
    reg = {"agent_docs": {"root_strategy": "import"}}
    plan = agent_docs.plan_fix(proj, reg, installed=MULTI)
    assert [s["action"] for s in plan["steps"]] == ["rederive"]
    res = agent_docs.apply_fix(proj, reg, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    assert not (root / "CLAUDE.md").is_symlink()
    assert (root / "CLAUDE.md").read_text().strip() == "@AGENTS.md"


def test_fix_collapse_replaced_derived(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# same\n", encoding="utf-8")
    (root / "CLAUDE.md").write_text("# same\n", encoding="utf-8")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    assert [s["action"] for s in plan["steps"]] == ["collapse"]
    agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert os.readlink(root / "CLAUDE.md") == "AGENTS.md"


def test_fix_conflict_is_attention_not_step(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# a\n", encoding="utf-8")
    (root / "CLAUDE.md").write_text("# different\n", encoding="utf-8")
    plan = agent_docs.plan_fix(_proj(root), {}, installed=MULTI)
    assert plan["steps"] == []
    assert plan["attention"][0]["verdict"] == "conflict"


def test_fix_reverse_link_promote_swaps(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "CLAUDE.md").write_text("# real\n", encoding="utf-8")
    os.symlink("CLAUDE.md", root / "AGENTS.md")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    assert [s["action"] for s in plan["steps"]] == ["promote"]
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    assert not (root / "AGENTS.md").is_symlink()
    assert (root / "AGENTS.md").read_text() == "# real\n"
    assert os.readlink(root / "CLAUDE.md") == "AGENTS.md"


def test_fix_never_touches_external_links(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    ext = tmp_path / "outside" / "CLAUDE.md"
    ext.parent.mkdir()
    ext.write_text("# dotfiles\n", encoding="utf-8")
    (root / "AGENTS.md").write_text("# a\n", encoding="utf-8")
    os.symlink(str(ext), root / "CLAUDE.md")
    plan = agent_docs.plan_fix(_proj(root), {}, installed=MULTI)
    assert plan["steps"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Opt-in git commit
# ─────────────────────────────────────────────────────────────────────────────

import subprocess


def _git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True
    )


def _init_repo(root):
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "T")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "initial")


def test_commit_stages_only_touched_paths(tmp_path):
    root = _screenshot_layout(tmp_path)
    (root / "unrelated.txt").write_text("keep me dirty\n", encoding="utf-8")
    _init_repo(root)
    (root / "unrelated.txt").write_text("dirty edit\n", encoding="utf-8")

    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] and res["touched"]
    msg = agent_docs.build_commit_message(res["executed"])
    commit = agent_docs.commit_layout_change(root, res["touched"], msg)
    assert commit["committed"] is True and commit["sha"]
    # The commit contains only instruction files, never the unrelated edit.
    shown = _git(root, "show", "--name-only", "--pretty=format:", "HEAD").stdout.split()
    assert "unrelated.txt" not in shown
    assert "AGENTS.md" in shown and "AGENT.md" in shown
    # The unrelated edit is still dirty and unstaged.
    status = _git(root, "status", "--porcelain", "unrelated.txt").stdout
    assert status.startswith(" M")
    # Prepared message: Skill Tree label, plain-language explanation, steps.
    log = _git(root, "log", "-1", "--pretty=%B").stdout
    assert log.startswith("skill-tree(agent-docs): canonicalize agent instruction files")
    assert "Skill Tree restructured this project's agent instruction files" in log
    assert "no\ninstruction prose was authored" in log.replace("\r", "") or \
        "no instruction prose was authored" in log.replace("\n", " ")
    assert "rename CLAUDE.md → AGENTS.md" in log
    assert "Generated by Skill Tree" in log


def test_commit_skips_outside_a_repo(tmp_path):
    root = _screenshot_layout(tmp_path)
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    commit = agent_docs.commit_layout_change(
        root, res["touched"], agent_docs.build_commit_message(res["executed"])
    )
    assert commit["committed"] is False
    assert commit["reason"] == "not_a_repo"
    # The fix itself stands.
    assert (root / "AGENTS.md").exists()


def test_commit_reports_no_changes_when_paths_ignored(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".gitignore").write_text("AGENTS.md\nCLAUDE.md\n", encoding="utf-8")
    _init_repo(root)
    (root / "CLAUDE.md").write_text("# c\n", encoding="utf-8")
    proj = _proj(root)
    plan = agent_docs.plan_fix(proj, {}, installed=MULTI)
    res = agent_docs.apply_fix(proj, {}, "proj", tmp_path / "_b", plan, installed=MULTI)
    assert res["applied"] is True
    commit = agent_docs.commit_layout_change(
        root, res["touched"], agent_docs.build_commit_message(res["executed"])
    )
    assert commit["committed"] is False
    assert commit["reason"] == "no_changes"


def test_resolve_returns_touched_for_commit(tmp_path):
    root = _conflict_root(tmp_path)
    _init_repo(root)
    res = agent_docs.resolve_root(
        _proj(root), {}, "proj", tmp_path / "_b", op="keep_claude", installed=MULTI
    )
    assert res["applied"] is True
    assert sorted(res["touched"]) == ["AGENTS.md", "CLAUDE.md"]
    commit = agent_docs.commit_layout_change(
        root, res["touched"], agent_docs.build_commit_message([], op="keep_claude")
    )
    assert commit["committed"] is True
    log = _git(root, "log", "-1", "--pretty=%B").stdout
    assert "keep claude" in log


# ─────────────────────────────────────────────────────────────────────────────
# Resolutions
# ─────────────────────────────────────────────────────────────────────────────


def _conflict_root(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# agents version\n", encoding="utf-8")
    (root / "CLAUDE.md").write_text("# claude version\n", encoding="utf-8")
    return root


def test_resolve_keep_agents(tmp_path):
    root = _conflict_root(tmp_path)
    res = agent_docs.resolve_root(
        _proj(root), {}, "proj", tmp_path / "_b", op="keep_agents", installed=MULTI
    )
    assert res["applied"] is True
    assert (root / "AGENTS.md").read_text() == "# agents version\n"
    assert os.readlink(root / "CLAUDE.md") == "AGENTS.md"
    assert res["backups"]


def test_resolve_keep_claude(tmp_path):
    root = _conflict_root(tmp_path)
    res = agent_docs.resolve_root(
        _proj(root), {}, "proj", tmp_path / "_b", op="keep_claude", installed=MULTI
    )
    assert res["applied"] is True
    assert (root / "AGENTS.md").read_text() == "# claude version\n"
    assert os.readlink(root / "CLAUDE.md") == "AGENTS.md"


def test_resolve_absorb_appendix_loss_free(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# agents\nbody\n", encoding="utf-8")
    (root / "CLAUDE.md").write_text(
        "@AGENTS.md\n\n- remember: run tests first\n", encoding="utf-8"
    )
    reg = {"agent_docs": {"root_strategy": "import"}}
    res = agent_docs.resolve_root(
        _proj(root), reg, "proj", tmp_path / "_b", op="absorb_appendix", installed=MULTI
    )
    assert res["applied"] is True
    agents = (root / "AGENTS.md").read_text()
    assert agents.startswith("# agents\nbody\n")
    assert agents.endswith("- remember: run tests first\n")
    assert (root / "CLAUDE.md").read_text().strip() == "@AGENTS.md"


def test_resolve_rejects_wrong_state(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# a\n", encoding="utf-8")
    os.symlink("AGENTS.md", root / "CLAUDE.md")
    res = agent_docs.resolve_root(
        _proj(root), {}, "proj", tmp_path / "_b", op="keep_agents", installed=MULTI
    )
    assert res["applied"] is False


# ─────────────────────────────────────────────────────────────────────────────
# detect_status integration with the new model
# ─────────────────────────────────────────────────────────────────────────────


def test_detect_status_legacy_needs_cleanup(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "AGENTS.md").write_text("# a\n", encoding="utf-8")
    os.symlink("AGENTS.md", root / "CLAUDE.md")
    os.symlink("CLAUDE.md", root / "AGENT.md")
    st = agent_docs.detect_status(_proj(root), {}, installed=MULTI)
    assert st["state"] == "needs_canonicalization"
    assert st["verdict"] == "canonical"
    assert "legacy" in st["flags"]


def test_detect_status_counts_nested_deviations(tmp_path):
    root = _screenshot_layout(tmp_path)
    st = agent_docs.detect_status(_proj(root), {}, installed=MULTI)
    assert st["state"] == "needs_canonicalization"
    assert st["nested_deviations"] == 2  # agents/ and cli/


def test_detect_status_claude_only_stays_ok(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "CLAUDE.md").write_text("# c\n", encoding="utf-8")
    st = agent_docs.detect_status(
        _proj(root, ["claude-code"]), {}, installed={"claude-code"}
    )
    assert st["state"] == "ok"
    assert st["verdict"] == "canonical"
