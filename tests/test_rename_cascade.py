"""Tests for the rename cascade: `skill_refs.rewrite_refs` and
`rename_cascade.py`'s `collect_cascade_targets`/`plan_cascade`/`apply_cascade`,
plus the CLI contract `hub rename <old> <new> --rewrite-refs
[--rewrite-agent-docs] [--json]` wires them into.

Test numbers (T1-T28) match plans/3.md §Test tasks -> Python.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from skill_hub.application.skills import rename_cascade
from skill_hub.domain.skills import skill_refs
from skill_hub.infrastructure.filesystem import snippets as snippets_mod

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS = Path(__file__).parent / "fixtures" / "skill_refs_corpus.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_skill_md(dirpath: Path, name: str, body: str = "") -> None:
    dirpath.mkdir(parents=True, exist_ok=True)
    (dirpath / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d\n---\n\n{body}\n")


def _skill_cfg(source: Path, **extra) -> dict:
    cfg = {
        "source": str(source),
        "type": "claude-skill",
        "scope": "portable",
        "version": "1.0.0",
        "description": "",
    }
    cfg.update(extra)
    return cfg


def _run(data_home: Path, home_dir: Path, args: list[str]):
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(data_home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    env["HOME"] = str(home_dir)
    env["USERPROFILE"] = str(home_dir)
    env.pop("CODEX_HOME", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _seed_registry(data_home: Path, skills: dict, projects: dict | None = None) -> None:
    registry = {"version": "1", "skills": skills, "projects": projects or {}}
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _load_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _extract_stdout_json(stdout: str) -> dict:
    """The payload is printed before the sync tail's own chatter (T22b)."""
    start = stdout.index("{")
    end = stdout.rindex("}") + 1
    return json.loads(stdout[start:end])


# ---------------------------------------------------------------------------
# skill_refs.rewrite_refs — T1-T11
# ---------------------------------------------------------------------------


def test_t1_backtick_form():
    text, count = skill_refs.rewrite_refs("See `old` here.", "old", "new")
    assert text == "See `new` here."
    assert count == 1


def test_t2_slash_form():
    text, count = skill_refs.rewrite_refs("See /old here.", "old", "new")
    assert text == "See /new here."
    assert count == 1


def test_t3_enclosing_span_form():
    text, count = skill_refs.rewrite_refs("See `/old` here.", "old", "new")
    assert text == "See `/new` here."
    assert count == 1


def test_t4_both_forms_in_one_body():
    text, count = skill_refs.rewrite_refs("See `old` and also /old in prose.", "old", "new")
    assert text == "See `new` and also /new in prose."
    assert count == 2


def test_t5_the_two_corrupting_spans():
    text1, c1 = skill_refs.rewrite_refs("`old-/old`", "old", "new")
    assert text1 == "`old-/new`", "prefix must stay untouched"
    assert c1 == 1

    text2, c2 = skill_refs.rewrite_refs("`/old,/old`", "old", "new")
    assert text2 == "`/new,/new`"
    assert c2 == 2, "dedupe (one span) + all-occurrence substitution (two matches)"


def test_t6_adjacent_hits_across_spans():
    text, count = skill_refs.rewrite_refs("/old /old and `old`/old", "old", "new")
    assert text == "/new /new and `new`/new"
    assert count == 4


def test_t7_wellformed_frontmatter_untouched():
    text = "---\nname: old\ndescription: uses old\n---\n\nBody mentions /old.\n"
    new_text, count = skill_refs.rewrite_refs(text, "old", "new")
    assert new_text.startswith("---\nname: old\ndescription: uses old\n---\n")
    assert count == 1
    assert "/new" in new_text
    assert "/old" not in new_text


def test_t8_inside_fenced_code_block():
    text = "```\nuse /old here\n```\n"
    new_text, count = skill_refs.rewrite_refs(text, "old", "new")
    assert new_text == "```\nuse /new here\n```\n"
    assert count == 1


def test_t9_prefix_name_safety():
    text = "See /review-checklist and `review-checklist`."
    new_text, count = skill_refs.rewrite_refs(text, "review", "review-notes")
    assert count == 0
    assert new_text == text


def test_t10_crlf_body_round_trips():
    text = "Line one.\r\nSee /old here.\r\nLine three.\r\n"
    new_text, count = skill_refs.rewrite_refs(text, "old", "new")
    assert count == 1
    assert new_text == "Line one.\r\nSee /new here.\r\nLine three.\r\n"
    assert "\r\n" in new_text
    assert new_text.count("\r\n") == text.count("\r\n")


def test_t11_corpus_round_trip():
    """The corpus is read, never edited (shared with the TS twin)."""
    cases = json.loads(CORPUS.read_text())["cases"]
    assert cases, "corpus must not be empty"
    for case in cases:
        text = case["text"]
        for name in case["names"]:
            expected = len(skill_refs.find_refs(text, [name]))
            rewritten, count = skill_refs.rewrite_refs(text, name, "zz-renamed")
            assert count == expected, case["name"]
            got = skill_refs.count_refs(rewritten, ["zz-renamed"]).get("zz-renamed", 0)
            assert got == expected, case["name"]


# ---------------------------------------------------------------------------
# rename_cascade — T12-T20 (module-level, tmp_data_home)
# ---------------------------------------------------------------------------


def test_t12_self_exclusion_both_keys(tmp_data_home):
    data_home = tmp_data_home
    _write_skill_md(data_home / "skills" / "old", "old", body="mentions itself: `old` and /old.")
    _write_skill_md(data_home / "skills" / "other", "other", body="See `old`.")

    registry_before = {
        "skills": {
            "old": _skill_cfg(data_home / "skills" / "old"),
            "other": _skill_cfg(data_home / "skills" / "other"),
        },
        "projects": {},
    }
    plan = rename_cascade.plan_cascade(registry_before, "old", "new")
    names = {r["name"] for r in plan["referrers"]["skills"]}
    assert names == {"other"}, "self must never be a referrer"

    registry_after = {
        "skills": {
            "new": _skill_cfg(data_home / "skills" / "old"),
            "other": _skill_cfg(data_home / "skills" / "other"),
        },
        "projects": {},
    }
    result = rename_cascade.apply_cascade(
        registry_after, "old", "new", include_agent_docs=False, backups_root=data_home / "_hub-backups"
    )
    names = {r["name"] for r in result["rewritten"]}
    assert names == {"other"}
    assert (data_home / "skills" / "other" / "SKILL.md").read_text().count("`new`") == 1


def test_t13_source_managed_skip(tmp_data_home, tmp_path):
    data_home = tmp_data_home
    external = tmp_path / "external-checkout" / "unslop"
    _write_skill_md(external, "unslop", body="mentions `old` twice: `old` again.")

    registry = {
        "skills": {
            "old": _skill_cfg(data_home / "skills" / "old"),
            "unslop": _skill_cfg(external, managed="external"),
        },
        "projects": {},
    }
    _write_skill_md(data_home / "skills" / "old", "old")

    plan = rename_cascade.plan_cascade(registry, "old", "new")
    assert plan["referrers"]["skills"] == []
    assert plan["skipped"] == [{"kind": "skill", "name": "unslop", "reason": "source-managed", "count": 2}]

    before = (external / "SKILL.md").read_text()
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=False, backups_root=data_home / "_hub-backups"
    )
    assert result["rewritten"] == []
    assert result["skipped"] == [{"kind": "skill", "name": "unslop", "reason": "source-managed", "count": 2}]
    assert (external / "SKILL.md").read_text() == before, "source-managed file must be byte-identical"


def test_t13b_starter_skills_are_skipped(tmp_data_home, tmp_path, monkeypatch):
    # A fake code home: the real one is this checkout, and a test must never
    # write into it.
    monkeypatch.setattr(rename_cascade.hub_core, "code_home", lambda: tmp_path / "code")
    starter = rename_cascade.hub_core.code_home() / "skills" / "inferred-starter"
    explicit = tmp_path / "explicit-starter"
    _write_skill_md(starter, "inferred-starter", body="See /old.")
    _write_skill_md(explicit, "explicit-starter", body="See /old.")
    before_inferred = (starter / "SKILL.md").read_bytes()
    before_explicit = (explicit / "SKILL.md").read_bytes()

    registry = {
        "skills": {
            "inferred-starter": _skill_cfg(starter),
            "explicit-starter": _skill_cfg(explicit, managed="starter"),
        },
        "projects": {},
    }
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=False, backups_root=tmp_data_home / "_hub-backups"
    )

    assert result["rewritten"] == []
    assert result["skipped"] == [
        {"kind": "skill", "name": "explicit-starter", "reason": "source-managed", "count": 1},
        {"kind": "skill", "name": "inferred-starter", "reason": "source-managed", "count": 1},
    ]
    assert (starter / "SKILL.md").read_bytes() == before_inferred
    assert (explicit / "SKILL.md").read_bytes() == before_explicit


def test_t13c_stale_file_is_not_written(tmp_data_home, monkeypatch):
    skill_dir = tmp_data_home / "skills" / "referrer"
    _write_skill_md(skill_dir, "referrer", body="See /old.")
    target = skill_dir / "SKILL.md"
    before = target.read_bytes()
    registry = {"skills": {"referrer": _skill_cfg(skill_dir)}, "projects": {}}
    original_backup = rename_cascade._backup

    def mutate_before_backup(path, *args):
        if path == target:
            target.write_text("---\nname: referrer\ndescription: changed\n---\n\nSee /other.\n")
        return original_backup(path, *args)

    monkeypatch.setattr(rename_cascade, "_backup", mutate_before_backup)
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=False, backups_root=tmp_data_home / "_hub-backups"
    )

    assert target.read_text().endswith("See /other.\n")
    assert target.read_bytes() != before
    assert result["rewritten"] == []
    assert result["errors"] == [
        {
            "kind": "skill",
            "name": "referrer",
            "error": "stale-content: the file changed after the scan and no longer mentions old",
        }
    ]


def test_t13d_stale_file_is_rescanned_and_all_mentions_rewritten(tmp_data_home, monkeypatch):
    skill_dir = tmp_data_home / "skills" / "referrer"
    _write_skill_md(skill_dir, "referrer", body="See /old.")
    target = skill_dir / "SKILL.md"
    registry = {"skills": {"referrer": _skill_cfg(skill_dir)}, "projects": {}}
    original_backup = rename_cascade._backup

    def add_mention_before_backup(path, *args):
        if path == target:
            target.write_text(target.read_text() + "Also /old.\n")
        return original_backup(path, *args)

    monkeypatch.setattr(rename_cascade, "_backup", add_mention_before_backup)
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=False, backups_root=tmp_data_home / "_hub-backups"
    )

    assert result["errors"] == []
    assert len(result["rewritten"]) == 1
    assert result["rewritten"][0]["kind"] == "skill"
    assert result["rewritten"][0]["name"] == "referrer"
    assert result["rewritten"][0]["count"] == 2
    assert target.read_text().count("/new") == 2


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
@pytest.mark.parametrize("prefix", ["", "\ufeff"])
def test_t7b_unparseable_frontmatter_is_skipped(tmp_data_home, newline, prefix):
    skill_dir = tmp_data_home / "skills" / "broken"
    skill_dir.mkdir(parents=True)
    content = f"{prefix}---{newline}name: broken{newline}description: /old{newline}body{newline}"
    target = skill_dir / "SKILL.md"
    target.write_bytes(content.encode())
    before = target.read_bytes()
    registry = {"skills": {"broken": _skill_cfg(skill_dir)}, "projects": {}}

    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=False, backups_root=tmp_data_home / "_hub-backups"
    )

    assert result["rewritten"] == []
    assert result["skipped"] == [
        {"kind": "skill", "name": "broken", "reason": "unparseable-frontmatter", "count": 0}
    ]
    assert target.read_bytes() == before


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_t7c_unparseable_bom_frontmatter_agent_doc_is_skipped(tmp_data_home, newline):
    project_dir = tmp_data_home / "_ext" / "proj"
    project_dir.mkdir(parents=True)
    target = project_dir / "AGENTS.md"
    content = f"\ufeff---{newline}name: project{newline}description: /old{newline}body{newline}"
    target.write_bytes(content.encode())
    before = target.read_bytes()
    registry = {"skills": {}, "projects": {"proj": {"path": str(project_dir)}}}

    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=True, backups_root=tmp_data_home / "_hub-backups"
    )

    assert result["rewritten"] == []
    assert result["skipped"] == [
        {"kind": "agent_doc", "name": "proj/AGENTS.md", "reason": "unparseable-frontmatter", "count": 0}
    ]
    assert target.read_bytes() == before


def test_t14_mcp_server_files_no_row(tmp_data_home):
    data_home = tmp_data_home
    _write_skill_md(data_home / "skills" / "old", "old")
    mcp_dir = data_home / "mcp-servers" / "some-mcp"
    mcp_dir.mkdir(parents=True)
    (mcp_dir / "README.md").write_text("Uses /old somewhere.\n")

    registry = {
        "skills": {
            "old": _skill_cfg(data_home / "skills" / "old"),
            "some-mcp": {"source": str(mcp_dir), "type": "mcp-server", "scope": "portable"},
        },
        "projects": {},
    }
    result = rename_cascade.collect_cascade_targets(
        registry, "old", "new", exclude_keys={"old", "new"}, include_agent_docs=False
    )
    names = {t["name"] for t in result["targets"]} | {s["name"] for s in result["skipped"]}
    assert "some-mcp" not in names
    assert not any("README" in n for n in names)


def test_t14b_plan_equals_run(tmp_data_home):
    data_home = tmp_data_home
    _write_skill_md(data_home / "skills" / "old", "old")
    _write_skill_md(data_home / "skills" / "referrer", "referrer", body="See `old` and /old.")

    external = data_home / "_ext" / "external" / "vendored"
    _write_skill_md(external, "vendored", body="`old`")

    sdir = snippets_mod.snippets_dir(data_home)
    snippets_mod.create_snippet(sdir, "snip1", body="Uses /old.")

    project_dir = data_home / "_ext" / "proj1"
    project_dir.mkdir(parents=True)
    (project_dir / "AGENTS.md").write_text("Notes about /old.\n")

    quarantined_dir = data_home / "_ext" / "proj2"
    quarantined_dir.mkdir(parents=True)
    (quarantined_dir / "AGENTS.md").write_text("Also /old.\n")

    registry = {
        "skills": {
            "old": _skill_cfg(data_home / "skills" / "old"),
            "referrer": _skill_cfg(data_home / "skills" / "referrer"),
            "vendored": _skill_cfg(external, managed="external"),
        },
        "projects": {
            "proj1": {"path": str(project_dir)},
            "proj2": {"path": str(quarantined_dir), "path_unresolved": True},
        },
    }

    plan = rename_cascade.plan_cascade(registry, "old", "new")
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=True, backups_root=data_home / "_hub-backups"
    )

    plan_totals = plan["totals"]
    run_library_refs = sum(
        r["count"] for r in result["rewritten"] if r["kind"] in ("skill", "snippet")
    )
    run_agent_doc_refs = sum(r["count"] for r in result["rewritten"] if r["kind"] == "agent_doc")
    run_skipped = sum(s["count"] for s in result["skipped"])

    assert plan_totals["library_refs"] == run_library_refs
    assert plan_totals["agent_doc_refs"] == run_agent_doc_refs
    assert plan_totals["skipped"] == run_skipped
    assert plan_totals["refs"] == run_library_refs + run_agent_doc_refs


def test_t15_plan_shape(tmp_data_home):
    data_home = tmp_data_home
    _write_skill_md(data_home / "skills" / "old", "old")
    _write_skill_md(data_home / "skills" / "referrer", "referrer", body="See `old`.")
    registry = {
        "skills": {
            "old": _skill_cfg(data_home / "skills" / "old"),
            "referrer": _skill_cfg(data_home / "skills" / "referrer"),
        },
        "projects": {},
    }
    plan = rename_cascade.plan_cascade(registry, "old", "new")
    for key in ("dry_run", "old", "new", "referrers", "skipped", "totals"):
        assert key in plan
    for key in ("skills", "snippets", "agent_docs"):
        assert key in plan["referrers"]
    total_keys = (
        "skills", "snippets", "agent_docs", "projects",
        "library_refs", "agent_doc_refs", "refs", "skipped", "files",
    )
    for key in total_keys:
        assert key in plan["totals"]
    assert [r["name"] for r in plan["referrers"]["skills"]] == sorted(r["name"] for r in plan["referrers"]["skills"])
    assert plan["totals"]["refs"] == plan["totals"]["library_refs"] + plan["totals"]["agent_doc_refs"]


def test_t16_snippet_rewrite_bumps_version(tmp_data_home):
    data_home = tmp_data_home
    sdir = snippets_mod.snippets_dir(data_home)
    snippets_mod.create_snippet(sdir, "android-conventions", body="Uses /old for the thing.")
    registry = {"skills": {}, "projects": {}}
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=False, backups_root=data_home / "_hub-backups"
    )
    rows = [r for r in result["rewritten"] if r["kind"] == "snippet"]
    assert len(rows) == 1
    assert rows[0]["version"] == 2
    assert "android-conventions" in result["snippets_outdated"]
    snippet = snippets_mod.get_snippet(sdir, "android-conventions")
    assert "/new" in snippet.body


def test_t17_snippet_owned_span_protected(tmp_data_home):
    data_home = tmp_data_home
    sdir = snippets_mod.snippets_dir(data_home)
    snip = snippets_mod.create_snippet(sdir, "conv", body="Mentions /old inside the block.")
    block = snippets_mod.build_block(snip)

    project_dir = data_home / "_ext" / "proj"
    project_dir.mkdir(parents=True)
    doc = project_dir / "AGENTS.md"
    doc.write_text(f"# Notes\n\n{block}\n")
    before = doc.read_text()

    registry = {"skills": {}, "projects": {"proj": {"path": str(project_dir)}}}

    plan = rename_cascade.plan_cascade(registry, "old", "new")
    assert plan["referrers"]["agent_docs"] == []
    assert plan["skipped"] == [{"kind": "agent_doc", "name": "proj/AGENTS.md", "reason": "snippet-owned", "count": 1}]

    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=True, backups_root=data_home / "_hub-backups"
    )
    # The library snippet itself is a legitimate referrer and IS rewritten
    # (that's what makes the applied block read `outdated`); only the
    # embedded copy inside the agent doc is protected.
    doc_rows = [r for r in result["rewritten"] if r["kind"] == "agent_doc"]
    assert doc_rows == []
    assert {r["kind"] for r in result["rewritten"]} == {"snippet"}
    assert result["skipped"] == [{"kind": "agent_doc", "name": "proj/AGENTS.md", "reason": "snippet-owned", "count": 1}]
    assert doc.read_text() == before


def test_t18_agent_docs_are_opt_in(tmp_data_home):
    data_home = tmp_data_home
    project_dir = data_home / "_ext" / "proj"
    project_dir.mkdir(parents=True)
    doc = project_dir / "AGENTS.md"
    doc.write_text("Uses /old here.\n")
    before = doc.read_text()

    registry = {"skills": {}, "projects": {"proj": {"path": str(project_dir)}}}
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=False, backups_root=data_home / "_hub-backups"
    )
    assert result["rewritten"] == []
    assert doc.read_text() == before


def test_t19_agent_docs_opt_in_writes_and_backs_up(tmp_data_home):
    data_home = tmp_data_home
    project_dir = data_home / "_ext" / "proj"
    project_dir.mkdir(parents=True)
    doc = project_dir / "AGENTS.md"
    doc.write_text("Uses /old here.\n")
    before = doc.read_text()

    registry = {"skills": {}, "projects": {"proj": {"path": str(project_dir)}}}
    backups_root = data_home / "_hub-backups"
    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=True, backups_root=backups_root
    )
    rows = [r for r in result["rewritten"] if r["kind"] == "agent_doc"]
    assert len(rows) == 1
    assert doc.read_text() == "Uses /new here.\n"
    backup_path = Path(rows[0]["backup"])
    assert backup_path.is_file()
    assert backup_path.read_text() == before


def test_t20_per_file_isolation(tmp_data_home):
    if os.geteuid() == 0:
        pytest.skip("root ignores the write bit")

    data_home = tmp_data_home
    proj_ok = data_home / "_ext" / "proj-ok"
    proj_ok.mkdir(parents=True)
    (proj_ok / "AGENTS.md").write_text("Uses /old here.\n")

    proj_blocked = data_home / "_ext" / "proj-blocked"
    proj_blocked.mkdir(parents=True)
    (proj_blocked / "AGENTS.md").write_text("Also /old here.\n")

    registry = {
        "skills": {},
        "projects": {
            "proj-ok": {"path": str(proj_ok)},
            "proj-blocked": {"path": str(proj_blocked)},
        },
    }
    os.chmod(proj_blocked, 0o500)
    try:
        result = rename_cascade.apply_cascade(
            registry, "old", "new", include_agent_docs=True, backups_root=data_home / "_hub-backups"
        )
    finally:
        os.chmod(proj_blocked, 0o700)

    assert len(result["rewritten"]) == 1
    assert result["rewritten"][0]["name"] == "proj-ok/AGENTS.md"
    assert len(result["errors"]) == 1
    assert result["errors"][0]["name"] == "proj-blocked/AGENTS.md"
    assert result["renamed"] is True
    assert (proj_ok / "AGENTS.md").read_text() == "Uses /new here.\n"


def test_t25_sibling_md_rewritten_symlink_not_followed(tmp_data_home):
    data_home = tmp_data_home
    skill_dir = data_home / "skills" / "orchestrate"
    _write_skill_md(skill_dir, "orchestrate")
    refs_dir = skill_dir / "references"
    refs_dir.mkdir()
    (refs_dir / "waves.md").write_text("See /old for context.\n")

    outside = data_home / "_ext" / "outside.md"
    outside.parent.mkdir(parents=True, exist_ok=True)
    outside.write_text("mentions /old too\n")
    symlinked = refs_dir / "linked.md"
    try:
        symlinked.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unsupported in this environment")

    registry = {"skills": {"orchestrate": _skill_cfg(skill_dir)}, "projects": {}}
    result = rename_cascade.collect_cascade_targets(
        registry, "old", "new", exclude_keys={"old", "new"}, include_agent_docs=False
    )
    names = {t["name"] for t in result["targets"]}
    assert "orchestrate/references/waves.md" in names
    assert "orchestrate/references/linked.md" not in names


def test_t26_quarantined_project_skipped(tmp_data_home):
    data_home = tmp_data_home
    project_dir = data_home / "_ext" / "proj"
    project_dir.mkdir(parents=True)
    (project_dir / "AGENTS.md").write_text("Uses /old here.\n")
    before = (project_dir / "AGENTS.md").read_text()

    registry = {
        "skills": {},
        "projects": {"proj": {"path": str(project_dir), "path_unresolved": True}},
    }
    plan = rename_cascade.plan_cascade(registry, "old", "new")
    assert plan["referrers"]["agent_docs"] == []
    assert {"kind": "agent_doc", "name": "proj", "reason": "project-quarantined", "count": 0} in plan["skipped"]

    result = rename_cascade.apply_cascade(
        registry, "old", "new", include_agent_docs=True, backups_root=data_home / "_hub-backups"
    )
    assert result["rewritten"] == []
    assert (project_dir / "AGENTS.md").read_text() == before


# ---------------------------------------------------------------------------
# CLI contract — T21-T24, T28 (subprocess), T27 (in-process monkeypatch)
# ---------------------------------------------------------------------------


@pytest.fixture
def cli_world(tmp_data_home, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    _write_skill_md(tmp_data_home / "skills" / "a", "a")
    _write_skill_md(tmp_data_home / "skills" / "referrer", "referrer", body="See `a`.")
    _seed_registry(
        tmp_data_home,
        {
            "a": _skill_cfg(tmp_data_home / "skills" / "a"),
            "referrer": _skill_cfg(tmp_data_home / "skills" / "referrer"),
        },
    )
    return tmp_data_home, home


def test_t21_cli_dry_run_json_changes_nothing(cli_world):
    data_home, home = cli_world
    before = (data_home / "skills" / "referrer" / "SKILL.md").read_text()
    proc = _run(data_home, home, ["rename", "a", "b", "--dry-run", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["dry_run"] is True
    assert payload["old"] == "a"
    assert payload["new"] == "b"
    assert "a" in _load_registry(data_home)["skills"]
    assert (data_home / "skills" / "referrer" / "SKILL.md").read_text() == before


def test_t21b_dry_run_takes_no_lock_writes_no_audit_row(cli_world):
    data_home, home = cli_world
    audit_path = data_home / "state" / "audit.jsonl"
    before = audit_path.read_text() if audit_path.exists() else ""
    proc = _run(data_home, home, ["rename", "a", "b", "--dry-run"])
    assert proc.returncode == 0, proc.stderr
    after = audit_path.read_text() if audit_path.exists() else ""
    assert before == after


def test_t22_and_t22b_exit_code_and_stdout_parses(cli_world):
    if os.geteuid() == 0:
        pytest.skip("root ignores the write bit")

    data_home, home = cli_world
    project_dir = home.parent / "quarantine-target"
    project_dir.mkdir()
    (project_dir / "AGENTS.md").write_text("Uses /a here.\n")
    reg = _load_registry(data_home)
    reg["projects"] = {"blocked": {"path": str(project_dir)}}
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    os.chmod(project_dir, 0o500)
    try:
        proc = _run(data_home, home, ["rename", "a", "b", "--rewrite-refs", "--rewrite-agent-docs", "--json"])
    finally:
        os.chmod(project_dir, 0o700)

    assert proc.returncode == 2, proc.stdout + proc.stderr
    payload = _extract_stdout_json(proc.stdout)
    assert payload["renamed"] is True
    assert payload["errors"], "the blocked agent doc must land in errors[]"
    audit = (data_home / "state" / "audit.jsonl").read_text()
    assert '"verb": "rename"' in audit


def test_t23_flag_guard(cli_world):
    data_home, home = cli_world
    proc = _run(data_home, home, ["rename", "a", "b", "--rewrite-agent-docs"])
    assert proc.returncode == 2
    assert "--rewrite-refs" in (proc.stdout + proc.stderr)
    assert "a" in _load_registry(data_home)["skills"], "no mutation on the guard failure"


def test_t24_refs_ignore_follows_a_rename_with_no_rewrite_refs_flag(cli_world):
    data_home, home = cli_world
    reg = _load_registry(data_home)
    reg["skills"]["referrer"]["refs_ignore"] = ["a"]
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    proc = _run(data_home, home, ["rename", "a", "b"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    reg_after = _load_registry(data_home)
    assert reg_after["skills"]["referrer"]["refs_ignore"] == ["b"]


def test_t28_no_flag_rename_is_unchanged(cli_world):
    """Regression pin: a rename with none of the new flags produces the same
    registry and the same stdout lines as before this wave."""
    data_home, home = cli_world
    proc = _run(data_home, home, ["rename", "a", "b"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "renamed 'a' → 'b'" in proc.stdout
    reg = _load_registry(data_home)
    assert "b" in reg["skills"]
    assert "a" not in reg["skills"]


def test_t27_cascade_exception_isolated(tmp_data_home, capsys, monkeypatch):
    import argparse

    import hub

    data_home = tmp_data_home
    _write_skill_md(data_home / "skills" / "a", "a")
    _seed_registry(data_home, {"a": _skill_cfg(data_home / "skills" / "a")})

    def _boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(rename_cascade, "apply_cascade", _boom)

    args = argparse.Namespace(
        old_name="a",
        new_name="b",
        dry_run=False,
        json=True,
        rewrite_refs=True,
        rewrite_agent_docs=False,
    )
    with pytest.raises(SystemExit) as exc_info:
        hub.cmd_rename(args)
    assert exc_info.value.code == 2

    reg = _load_registry(data_home)
    assert "b" in reg["skills"], "the rename itself must still be done"
    audit = (data_home / "state" / "audit.jsonl").read_text()
    assert '"verb": "rename"' in audit

    payload = _extract_stdout_json(capsys.readouterr().out)
    assert payload["renamed"] is True
    assert payload["errors"] == [{"kind": "cascade", "name": "*", "error": "RuntimeError('kaboom')"}]
