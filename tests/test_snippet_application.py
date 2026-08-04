"""Snippet application: marker engine, apply/update/remove, scan statuses.

Everything operates on plain dicts + tmp dirs at the snippets.py module level
— no registry file or subprocess needed.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import snippets
from snippets import Snippet, SnippetError


@pytest.fixture
def env(tmp_path):
    """A registered project + library + backups root."""
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "AGENTS.md").write_text("# Proj\n\nIntro.\n")
    registry = {"projects": {"demo": {"path": str(proj)}}}
    snip = Snippet(name="val", description="d", tags=[], version=2, body="## Validate\n\n1. Build.\n")
    other = Snippet(name="doc", version=1, body="## Docs\n\nWrite well.\n")
    library = {"val": snip, "doc": other}
    return {
        "proj": proj,
        "registry": registry,
        "library": library,
        "backups": tmp_path / "backups",
    }


def _apply(env, name="val", rel="AGENTS.md", **kw):
    return snippets.apply_snippet(
        env["registry"], env["library"], env["backups"], name, "demo", rel=rel, **kw
    )


def _remove(env, name="val", rel="AGENTS.md", **kw):
    return snippets.remove_snippet(
        env["registry"], env["library"], env["backups"], name, "demo", rel=rel, **kw
    )


def _update(env, name="val", rel="AGENTS.md", **kw):
    return snippets.update_snippet_in_file(
        env["registry"], env["library"], env["backups"], name, "demo", rel=rel, **kw
    )


def _scan(env):
    return snippets.scan_all(env["registry"], env["library"])


# ─── Apply format ────────────────────────────────────────────────────────────


def test_apply_appends_marker_block(env):
    _apply(env)
    text = (env["proj"] / "AGENTS.md").read_text()
    sha = snippets.snip_hash(env["library"]["val"].body)
    assert text == (
        "# Proj\n\nIntro.\n\n"
        f"<!-- skill-tree:snippet id=val v=2 sha={sha} -->\n"
        "## Validate\n\n1. Build.\n"
        "<!-- skill-tree:snippet:end id=val -->\n"
    )


def test_apply_to_empty_file_has_no_leading_blank(env):
    (env["proj"] / "AGENTS.md").write_text("")
    _apply(env)
    text = (env["proj"] / "AGENTS.md").read_text()
    assert text.startswith("<!-- skill-tree:snippet id=val")
    assert text.endswith("<!-- skill-tree:snippet:end id=val -->\n")


def test_duplicate_apply_rejected(env):
    _apply(env)
    before = (env["proj"] / "AGENTS.md").read_text()
    with pytest.raises(SnippetError, match="already applied"):
        _apply(env)
    assert (env["proj"] / "AGENTS.md").read_text() == before


# ─── Target validation ───────────────────────────────────────────────────────


def test_unknown_project_rejected(env):
    with pytest.raises(SnippetError, match="Unknown project"):
        snippets.apply_snippet(
            env["registry"], env["library"], env["backups"], "val", "ghost", rel="AGENTS.md"
        )


def test_path_escape_rejected(env):
    outside = env["proj"].parent / "AGENTS.md"
    outside.write_text("# outside\n")
    with pytest.raises(SnippetError):
        _apply(env, rel="../AGENTS.md")
    assert outside.read_text() == "# outside\n"


def test_non_agent_doc_basename_rejected(env):
    (env["proj"] / "README.md").write_text("x\n")
    with pytest.raises(SnippetError, match="not an agent doc"):
        _apply(env, rel="README.md")


def test_derived_pointer_claude_rejected(env):
    # import-style pointer
    (env["proj"] / "CLAUDE.md").write_text("@AGENTS.md\n")
    with pytest.raises(SnippetError, match="AGENTS.md"):
        _apply(env, rel="CLAUDE.md")
    # symlink pointer
    (env["proj"] / "CLAUDE.md").unlink()
    os.symlink("AGENTS.md", env["proj"] / "CLAUDE.md")
    with pytest.raises(SnippetError):
        _apply(env, rel="CLAUDE.md")


def test_absent_known_root_is_created(env):
    (env["proj"] / "AGENTS.md").unlink()
    res = _apply(env)
    assert res["created"] is True
    text = (env["proj"] / "AGENTS.md").read_text()
    assert text.startswith("<!-- skill-tree:snippet id=val")


def test_absent_nested_file_rejected(env):
    with pytest.raises(SnippetError, match="does not exist"):
        _apply(env, rel="sub/AGENTS.md")


def test_canonical_default_when_rel_omitted(env):
    res = snippets.apply_snippet(
        env["registry"], env["library"], env["backups"], "val", "demo", installed=set()
    )
    assert res["rel"] == "AGENTS.md"


# ─── Removal ─────────────────────────────────────────────────────────────────


def test_clean_round_trip_byte_identity(env):
    before = (env["proj"] / "AGENTS.md").read_text()
    _apply(env)
    _remove(env)
    assert (env["proj"] / "AGENTS.md").read_text() == before


def test_round_trip_on_created_empty_root(env):
    (env["proj"] / "AGENTS.md").write_text("")
    _apply(env)
    _remove(env)
    assert (env["proj"] / "AGENTS.md").read_text() == ""


def test_removal_survives_unrelated_edits(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    text = p.read_text()
    p.write_text("# New title above\n\n" + text + "\n## New section below\n\nTail.\n")
    _remove(env)
    out = p.read_text()
    assert "skill-tree:snippet" not in out
    assert "# New title above" in out
    assert "## New section below" in out
    assert "Tail." in out


def test_adjacent_blocks_round_trip_independently(env):
    _apply(env, name="val")
    _apply(env, name="doc")
    both = (env["proj"] / "AGENTS.md").read_text()
    _remove(env, name="val")
    only_doc = (env["proj"] / "AGENTS.md").read_text()
    # Equals what applying only doc would have produced.
    (env["proj"] / "AGENTS.md").write_text("# Proj\n\nIntro.\n")
    _apply(env, name="doc")
    assert (env["proj"] / "AGENTS.md").read_text() == only_doc
    assert "id=doc" in only_doc and "id=val" not in only_doc
    assert both != only_doc


def test_modified_block_requires_force(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text().replace("1. Build.", "1. Build twice."))
    with pytest.raises(SnippetError, match="--force"):
        _remove(env)
    assert "Build twice" in p.read_text()
    _remove(env, force=True)
    assert "skill-tree:snippet" not in p.read_text()


def test_damaged_markers_fail_closed(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text().replace("<!-- skill-tree:snippet:end id=val -->\n", ""))
    before = p.read_text()
    with pytest.raises(SnippetError, match="by hand"):
        _remove(env)
    assert p.read_text() == before
    # Scan reports the damage as a per-file warning, not a location.
    res = _scan(env)
    assert res["locations"] == []
    assert res["damaged"][0]["kind"] == "unpaired-start"
    assert res["damaged"][0]["name"] == "val"


def test_manual_cleanup_is_self_sufficient(env):
    _apply(env)
    # User deletes the whole block (and its separator) in an editor.
    (env["proj"] / "AGENTS.md").write_text("# Proj\n\nIntro.\n")
    res = _scan(env)
    assert res["locations"] == [] and res["damaged"] == []
    with pytest.raises(SnippetError, match="not applied"):
        _remove(env)


# ─── Statuses ────────────────────────────────────────────────────────────────


def test_status_outdated_after_library_edit(env):
    _apply(env)
    env["library"]["val"].body = "## Validate\n\n1. Build.\n2. Test.\n"
    env["library"]["val"].version = 3
    res = _scan(env)
    assert [l["status"] for l in res["locations"]] == ["outdated"]


def test_modified_wins_over_outdated(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text().replace("1. Build.", "1. Build twice."))
    env["library"]["val"].body = "## Validate\n\nnew library body\n"
    res = _scan(env)
    assert [l["status"] for l in res["locations"]] == ["modified"]


def test_orphaned_when_snippet_missing_from_library(env):
    _apply(env)
    del env["library"]["val"]
    res = _scan(env)
    assert [l["status"] for l in res["locations"]] == ["orphaned"]
    # Orphaned blocks are still removable (hash still guards modified).
    _remove(env)
    assert "skill-tree:snippet" not in (env["proj"] / "AGENTS.md").read_text()


def test_externally_arrived_block_is_discovered(env):
    # Simulate a block arriving via git: write markers directly.
    block = snippets.build_block(env["library"]["doc"])
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text() + "\n" + block + "\n")
    res = _scan(env)
    assert [(l["snippet"], l["status"]) for l in res["locations"]] == [("doc", "applied")]


# ─── Update ──────────────────────────────────────────────────────────────────


def test_update_replaces_in_place(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text() + "\n## Below\n\nTail.\n")
    env["library"]["val"].body = "## Validate\n\nrevised body\n"
    env["library"]["val"].version = 3
    _update(env)
    text = p.read_text()
    assert "revised body" in text and "1. Build." not in text
    assert "v=3" in text
    # Block stayed put: the user section is still below it.
    assert text.index("skill-tree:snippet") < text.index("## Below")
    assert [l["status"] for l in _scan(env)["locations"]] == ["applied"]


def test_update_modified_requires_force(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text().replace("1. Build.", "edited inside"))
    env["library"]["val"].body = "## Validate\n\nnew\n"
    with pytest.raises(SnippetError, match="--force"):
        _update(env)
    assert "edited inside" in p.read_text()
    _update(env, force=True)
    assert "edited inside" not in p.read_text()


def test_update_everywhere_skips_modified(env, tmp_path):
    # Three files: two intact, one modified.
    proj = env["proj"]
    (proj / "sub").mkdir()
    (proj / "sub" / "AGENTS.md").write_text("# Sub\n")
    (proj / "CLAUDE.md").write_text("# Claude root\n")  # real user CLAUDE.md
    _apply(env, rel="AGENTS.md")
    _apply(env, rel="sub/AGENTS.md")
    _apply(env, rel="CLAUDE.md")
    mod = proj / "sub" / "AGENTS.md"
    mod.write_text(mod.read_text().replace("1. Build.", "edited"))
    env["library"]["val"].body = "## Validate\n\nv3 body\n"
    env["library"]["val"].version = 3

    res = snippets.update_everywhere(
        env["registry"], env["library"], env["backups"], "val"
    )
    assert len(res["refreshed"]) == 2
    assert [s["rel"] for s in res["skipped"]] == ["sub/AGENTS.md"]
    assert "edited" in mod.read_text()
    statuses = {(l["rel"]): l["status"] for l in _scan(env)["locations"]}
    assert statuses == {
        "AGENTS.md": "applied",
        "CLAUDE.md": "applied",
        "sub/AGENTS.md": "modified",
    }


def test_update_orphaned_rejected(env):
    _apply(env)
    del env["library"]["val"]
    with pytest.raises(SnippetError, match="orphaned"):
        _update(env)


# ─── Backups + mirror ────────────────────────────────────────────────────────


def test_backup_written_before_each_mutation(env):
    _apply(env)
    env["library"]["val"].body = "## Validate\n\nnew\n"
    _update(env)
    _remove(env)
    backups = list((env["backups"] / "snippets" / "demo").iterdir())
    assert len(backups) == 3
    # Exactly one backup (the pre-apply snapshot) has no marker block yet.
    marker_free = [b for b in backups if "skill-tree:snippet" not in b.read_text()]
    assert len(marker_free) == 1


def test_mirror_bound_roots_stay_identical(env):
    proj = env["proj"]
    # Mirror binding on disk: both roots real and byte-identical.
    (proj / "CLAUDE.md").write_text((proj / "AGENTS.md").read_text())
    res = _apply(env, rel="AGENTS.md")
    assert [m["rel"] for m in res["mirrored"]] == ["CLAUDE.md"]
    assert (proj / "CLAUDE.md").read_text() == (proj / "AGENTS.md").read_text()
    res = _remove(env, rel="AGENTS.md")
    assert [m["rel"] for m in res["mirrored"]] == ["CLAUDE.md"]
    assert (proj / "CLAUDE.md").read_text() == (proj / "AGENTS.md").read_text()


def test_divergent_roots_are_not_mirrored(env):
    proj = env["proj"]
    (proj / "CLAUDE.md").write_text("# Different content\n")
    res = _apply(env, rel="AGENTS.md")
    assert res["mirrored"] == []
    assert (proj / "CLAUDE.md").read_text() == "# Different content\n"
