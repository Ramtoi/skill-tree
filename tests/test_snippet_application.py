"""Snippet application: marker engine, apply/update/remove, scan statuses.

Everything operates on plain dicts + tmp dirs at the snippets.py module level
— no registry file or subprocess needed.
"""

from __future__ import annotations

import io
import json
import os
import sys
from types import SimpleNamespace

import pytest

from skill_hub.infrastructure.filesystem import snippets
from skill_hub.infrastructure.filesystem.snippets import Snippet, SnippetError


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
    assert res["damaged"][0]["kind"] == "incomplete-block"
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


def test_update_reconciles_to_trailing_region(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text() + "\n## Below\n\nTail.\n")
    env["library"]["val"].body = "## Validate\n\nrevised body\n"
    env["library"]["val"].version = 3
    _update(env)
    text = p.read_text()
    assert "revised body" in text and "1. Build." not in text
    assert "v=3" in text
    # User-authored prose stays above the stable trailing snippet region.
    assert text.index("## Below") < text.index("skill-tree:snippet")
    assert [l["status"] for l in _scan(env)["locations"]] == ["applied"]


def test_reconcile_moves_scattered_blocks_without_changing_them(env):
    val = snippets.build_block(env["library"]["val"])
    doc = snippets.build_block(env["library"]["doc"])
    source = f"# Prose\n\n{val}\n\n## User section\n\n{doc}\n"

    result = snippets.reconcile_snippet_region(source)

    assert result["changed"] is True
    assert result["placement"] == "canonical"
    assert result["content"].index("## User section") < result["content"].index("id=val")
    assert result["content"].index("id=val") < result["content"].index("id=doc")
    assert snippets.reconcile_snippet_region(result["content"])["changed"] is False


def test_marker_token_in_ordinary_prose_does_not_block_reconcile(env):
    block = snippets.build_block(env["library"]["val"])
    source = (
        "# Prose\n\n"
        "Edit the block through (`skill-tree:snippet id=delivery-contract`).\n\n"
        f"{block}\n"
    )

    result = snippets.reconcile_snippet_region(source)

    assert result["diagnostics"] == []
    assert "skill-tree:snippet id=delivery-contract" in result["content"]


def test_reconcile_refuses_ambiguous_marker_ownership(env):
    p = env["proj"] / "AGENTS.md"
    p.write_text("# Prose\n<!-- skill-tree:snippet id=val v=2 sha=deadbeef --> trailing\n")

    with pytest.raises(SnippetError, match="blocked"):
        snippets.reconcile_snippet_region(p.read_text())

    assert p.read_text().startswith("# Prose")


def test_reconcile_content_reports_marker_lines_as_structured_error(
    env, monkeypatch, capsys
):
    import skill_hub.entrypoints.cli.snippet as snippet_cli

    source = "# Prose\n<!-- skill-tree:snippet id=val v=2 sha=deadbeef --> trailing\n"
    monkeypatch.setattr(
        snippet_cli,
        "_snippet_ctx",
        lambda: (snippets, env["registry"], env["proj"] / "snippets"),
    )
    monkeypatch.setattr(snippet_cli, "_snippet_installed", lambda: set())
    monkeypatch.setattr(sys, "stdin", io.StringIO(source))

    with pytest.raises(SystemExit) as exc:
        snippet_cli.cmd_snippet_reconcile_content(
            SimpleNamespace(
                path=str(env["proj"]),
                file="AGENTS.md",
                expected_hash=None,
                overwrite=True,
                json=True,
            )
        )

    assert exc.value.code == 1
    assert json.loads(capsys.readouterr().out) == {
        "kind": "snippet_markers",
        "rel": "AGENTS.md",
        "diagnostics": [
            {"kind": "malformed-token", "name": None, "line": 2}
        ],
    }


def test_reconcile_content_reports_conflict_with_agent_doc_error_kind(
    env, monkeypatch, capsys
):
    import skill_hub.entrypoints.cli.snippet as snippet_cli

    monkeypatch.setattr(
        snippet_cli,
        "_snippet_ctx",
        lambda: (snippets, env["registry"], env["proj"] / "snippets"),
    )
    monkeypatch.setattr(snippet_cli, "_snippet_installed", lambda: set())
    monkeypatch.setattr(sys, "stdin", io.StringIO("# New draft\n"))

    with pytest.raises(SystemExit) as exc:
        snippet_cli.cmd_snippet_reconcile_content(
            SimpleNamespace(
                path=str(env["proj"]),
                file="AGENTS.md",
                expected_hash="stale-hash",
                overwrite=False,
                json=True,
            )
        )

    assert exc.value.code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["kind"] == "conflict"
    assert payload["rel"] == "AGENTS.md"
    assert payload["current_hash"]


def test_explicit_reconcile_previews_then_applies(env):
    _apply(env)
    p = env["proj"] / "AGENTS.md"
    p.write_text(p.read_text() + "\n## Later prose\n")

    preview = snippets.reconcile_snippet_file(
        env["registry"], env["library"], env["backups"], "demo", "AGENTS.md"
    )
    assert preview["changed"] is True and preview["applied"] is False
    assert p.read_text().endswith("## Later prose\n")

    applied = snippets.reconcile_snippet_file(
        env["registry"], env["library"], env["backups"], "demo", "AGENTS.md", apply=True
    )
    assert applied["applied"] is True
    assert p.read_text().index("## Later prose") < p.read_text().index("skill-tree:snippet")
    assert _scan(env)["locations"][0]["placement"] == "canonical"


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


# ─── Rename ──────────────────────────────────────────────────────────────────
#
# `rename_snippet` needs a real on-disk snippet library file (it renames it)
# and real project files (it rewrites their marker text), unlike `env` above
# whose `library` dict has no backing file — hence a dedicated fixture.


@pytest.fixture
def renv(tmp_path):
    sdir = snippets.snippets_dir(tmp_path / "lib")
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "AGENTS.md").write_text("# Proj\n\nIntro.\n")
    snippets.create_snippet(sdir, "val", description="d", tags=[], body="## Validate\n\n1. Build.\n")
    registry = {"projects": {"demo": {"path": str(proj)}}}
    return {"sdir": sdir, "proj": proj, "registry": registry, "backups": tmp_path / "backups"}


def _rename(renv, old="val", new="val2"):
    return snippets.rename_snippet(renv["registry"], renv["sdir"], renv["backups"], old, new)


def test_rename_applied_block_gets_new_marker_id(renv):
    sdir = renv["sdir"]
    library = snippets.library_by_name(sdir)
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")
    sha = snippets.snip_hash(library["val"].body)

    res = _rename(renv)

    assert res["errors"] == []
    assert [r["rel"] for r in res["renamed"]] == ["AGENTS.md"]
    text = (renv["proj"] / "AGENTS.md").read_text()
    assert text == (
        "# Proj\n\nIntro.\n\n"
        f"<!-- skill-tree:snippet id=val2 v=1 sha={sha} -->\n"
        "## Validate\n\n1. Build.\n"
        "<!-- skill-tree:snippet:end id=val2 -->\n"
    )
    assert snippets.get_snippet(sdir, "val") is None
    library_after = snippets.library_by_name(sdir)
    locs = snippets.applied_locations(renv["registry"], library_after, "val2")
    assert [l["status"] for l in locs] == ["applied"]


def test_rename_preserves_infile_v_and_sha_when_outdated(renv):
    """The library may have moved on (edited, version bumped) since apply —
    the in-file v=/sha= are the block's OWN values and must survive the
    rename byte-for-byte so `outdated` stays `outdated` under the new name."""
    sdir = renv["sdir"]
    library = snippets.library_by_name(sdir)
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")
    old_sha = snippets.snip_hash(library["val"].body)
    snippets.edit_snippet(sdir, "val", body="## Validate\n\n1. Build.\n2. Test.\n")

    _rename(renv)

    text = (renv["proj"] / "AGENTS.md").read_text()
    assert f"id=val2 v=1 sha={old_sha} -->" in text
    library_after = snippets.library_by_name(sdir)
    locs = snippets.applied_locations(renv["registry"], library_after, "val2")
    assert [l["status"] for l in locs] == ["outdated"]


def test_rename_preserves_modified_body_byte_for_byte(renv):
    sdir = renv["sdir"]
    library = snippets.library_by_name(sdir)
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")
    p = renv["proj"] / "AGENTS.md"
    edited = p.read_text().replace("1. Build.", "1. Build twice.")
    p.write_text(edited)

    _rename(renv)

    text = p.read_text()
    assert "1. Build twice." in text
    # Only the marker id changed — the edited body is untouched.
    assert text == edited.replace("id=val ", "id=val2 ")
    library_after = snippets.library_by_name(sdir)
    locs = snippets.applied_locations(renv["registry"], library_after, "val2")
    assert [l["status"] for l in locs] == ["modified"]


def test_rename_mirror_pair_rewritten_once_no_duplicate(renv):
    proj = renv["proj"]
    library = snippets.library_by_name(renv["sdir"])
    (proj / "CLAUDE.md").write_text((proj / "AGENTS.md").read_text())
    apply_res = snippets.apply_snippet(
        renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md"
    )
    assert [m["rel"] for m in apply_res["mirrored"]] == ["CLAUDE.md"]

    res = _rename(renv)

    assert res["errors"] == []
    # scan_all lists AGENTS.md and CLAUDE.md as two separate applied
    # locations, but `_sync_mirror` rewrites the CLAUDE.md partner as a side
    # effect of rewriting AGENTS.md — its own location entry then finds no
    # `val`-named block left (already renamed) and lands in `skipped`, not
    # `renamed` or `errors`: nothing failed there, there was simply nothing
    # left to do. Exactly ONE `renamed` entry, one `skipped` entry (M3).
    assert len(res["renamed"]) == 1
    assert res["renamed"][0]["rel"] == "AGENTS.md"
    assert [m["rel"] for m in res["renamed"][0]["mirrored"]] == ["CLAUDE.md"]
    assert len(res["skipped"]) == 1
    skip = res["skipped"][0]
    assert skip["project"] == "demo" and skip["rel"] == "CLAUDE.md"
    assert "no block named" in skip["reason"]
    agents_text = (proj / "AGENTS.md").read_text()
    claude_text = (proj / "CLAUDE.md").read_text()
    assert agents_text == claude_text
    assert "id=val2" in agents_text and "id=val -->" not in agents_text


def test_rename_per_file_error_isolation(renv, tmp_path):
    library = snippets.library_by_name(renv["sdir"])
    proj2 = tmp_path / "proj2"
    proj2.mkdir()
    (proj2 / "AGENTS.md").write_text("# Proj2\n\nIntro.\n")
    renv["registry"]["projects"]["demo2"] = {"path": str(proj2)}

    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo2", rel="AGENTS.md")
    # Damage demo2's file: an unpaired marker-looking token line.
    p2 = proj2 / "AGENTS.md"
    p2.write_text(p2.read_text() + "<!-- skill-tree:snippet id=x -->\n")
    before2 = p2.read_text()

    res = _rename(renv)

    assert len(res["errors"]) == 1
    assert res["errors"][0]["project"] == "demo2"
    assert res["errors"][0]["rel"] == "AGENTS.md"
    assert [r["project"] for r in res["renamed"]] == ["demo"]
    # The library rename landed regardless of the per-file failure.
    assert snippets.get_snippet(renv["sdir"], "val") is None
    assert snippets.get_snippet(renv["sdir"], "val2") is not None
    # demo's file was rewritten; demo2's damaged file is untouched.
    assert "id=val2" in (renv["proj"] / "AGENTS.md").read_text()
    assert p2.read_text() == before2


def test_rename_preserves_crlf_line_endings(renv, monkeypatch):
    """`rename_snippet` splices only the marker lines and must not run the
    body through a newline-normalizing helper (that would corrupt a CRLF
    body). `Path.read_text()` always normalizes CRLF to LF on read (Python's
    universal-newline text mode) — the same call every other snippet mutator
    here uses — so a real disk round trip can never hand this function a
    literal "\\r\\n". We patch the read for this project's file only so the
    test can actually exercise the CRLF-preserving branch of the splice."""
    import pathlib

    proj = renv["proj"]
    target_path = proj / "AGENTS.md"
    library = snippets.library_by_name(renv["sdir"])
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")
    crlf_bytes = target_path.read_bytes().replace(b"\n", b"\r\n")
    target_path.write_bytes(crlf_bytes)

    real_read_text = pathlib.Path.read_text

    def _no_translate_read_text(self, *args, **kwargs):
        if self == target_path:
            return self.read_bytes().decode(kwargs.get("encoding") or "utf-8")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "read_text", _no_translate_read_text)

    _rename(renv)

    raw = target_path.read_bytes()
    assert b"\r\n" in raw
    # Every line ending is "\r\n" — no stray bare "\n" crept in.
    assert raw.replace(b"\r\n", b"").count(b"\n") == 0
    assert b"id=val2" in raw and b"id=val -->" not in raw
    library_after = snippets.library_by_name(renv["sdir"])
    locs = snippets.applied_locations(renv["registry"], library_after, "val2")
    assert [l["status"] for l in locs] == ["applied"]


# ─── Rename — duplicate-id pre-flight (C1) ──────────────────────────────────


def test_rename_preflight_aborts_on_duplicate_marker_id(renv):
    """A target that already carries an orphaned block literally named `new`
    (e.g. left behind by `hub snippet delete new --force`) must abort the
    WHOLE rename before anything moves — writing the splice would otherwise
    leave that file with two blocks named `new`, which blocks every later
    write to it (including a future undo)."""
    sdir = renv["sdir"]
    proj = renv["proj"]
    library = snippets.library_by_name(sdir)
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")
    ghost = Snippet(name="val2", body="## Ghost\n\nLeftover orphaned body.\n")
    p = proj / "AGENTS.md"
    p.write_text(snippets.append_block(p.read_text(), snippets.build_block(ghost)))
    before = p.read_text()

    with pytest.raises(snippets.SnippetError, match='already exists in demo/AGENTS.md'):
        _rename(renv)

    # No partial state: library file untouched, target file untouched.
    assert p.read_text() == before
    assert snippets.get_snippet(sdir, "val") is not None
    assert snippets.get_snippet(sdir, "val2") is None


def test_rename_write_time_toctou_guard_catches_a_late_duplicate(renv, monkeypatch):
    """Belt-and-suspenders (C1b): even if a duplicate marker id appears in
    the window between the pre-flight scan and the actual write — a real
    race in production, simulated here via a monkeypatch that only reveals
    the conflict on the SECOND read of the file — `_require_safe` on the
    PROPOSED content still catches it, landing that location in `errors`
    instead of writing a silently-blocked duplicate-id file."""
    import pathlib

    sdir = renv["sdir"]
    proj = renv["proj"]
    library = snippets.library_by_name(sdir)
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")

    p = proj / "AGENTS.md"
    clean = p.read_text()
    ghost = Snippet(name="val2", body="## Ghost\n\nLeftover orphaned body.\n")
    poisoned = snippets.append_block(clean, snippets.build_block(ghost))

    real_read_text = pathlib.Path.read_text
    calls = {"n": 0}

    def flaky_read_text(self, *args, **kwargs):
        if self == p:
            calls["n"] += 1
            # Reads #1-#2 are `applied_locations`'s own scan (building `locs`)
            # and the C1(a) pre-flight scan — both must see CLEAN content, so
            # the pre-flight legitimately finds no conflict (matching a real
            # race where the ghost block arrives AFTER the pre-flight already
            # passed). Every read after that — the per-location write loop's
            # own re-read — sees the poisoned content.
            return poisoned if calls["n"] > 2 else clean
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "read_text", flaky_read_text)

    res = _rename(renv)

    assert res["renamed"] == []
    assert len(res["errors"]) == 1
    assert res["errors"][0]["project"] == "demo"
    # The library rename still landed (per the never-unwinds-on-partial-
    # failure contract) — only the per-file WRITE was aborted.
    assert snippets.get_snippet(sdir, "val") is None
    assert snippets.get_snippet(sdir, "val2") is not None
    # And the target file itself was never touched — read the real bytes
    # directly (`read_text` is still monkeypatched at this point in the test).
    assert p.read_bytes().decode("utf-8") == clean


def test_reverse_rename_recovers_a_partially_failed_forward_rename(renv, tmp_path):
    """A forward rename that fails on one file (per-file isolation) leaves
    that file's block orphaned — still under `old`, while the library now
    answers to `new`. Reversing the rename (`new` -> `old`) restores the
    library's old name WITHOUT ever touching the still-`old`-named file (it
    never matched `new`'s applied-locations at all) — so that block reads as
    `applied` again purely because the library caught back up to it. This is
    the scan-based status system's own honesty working in reverse, not
    special-cased recovery logic."""
    library = snippets.library_by_name(renv["sdir"])
    proj2 = tmp_path / "proj2"
    proj2.mkdir()
    (proj2 / "AGENTS.md").write_text("# Proj2\n\nIntro.\n")
    renv["registry"]["projects"]["demo2"] = {"path": str(proj2)}

    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo", rel="AGENTS.md")
    snippets.apply_snippet(renv["registry"], library, renv["backups"], "val", "demo2", rel="AGENTS.md")
    p2 = proj2 / "AGENTS.md"
    p2.write_text(p2.read_text() + "<!-- skill-tree:snippet id=x -->\n")  # damage demo2

    forward = _rename(renv)  # val -> val2
    assert len(forward["errors"]) == 1 and forward["errors"][0]["project"] == "demo2"
    library_mid = snippets.library_by_name(renv["sdir"])
    mid_statuses = {
        l["project"]: l["status"]
        for l in snippets.scan_all(renv["registry"], library_mid)["locations"]
    }
    assert mid_statuses == {"demo": "applied", "demo2": "orphaned"}

    reverse = snippets.rename_snippet(renv["registry"], renv["sdir"], renv["backups"], "val2", "val")
    assert reverse["errors"] == []
    # demo2's block is still named `val`, never `val2` — the reverse rename's
    # own applied-locations scan never finds it, so it is never touched.
    assert [r["project"] for r in reverse["renamed"]] == ["demo"]

    library_after = snippets.library_by_name(renv["sdir"])
    final_statuses = {
        l["project"]: l["status"]
        for l in snippets.scan_all(renv["registry"], library_after)["locations"]
    }
    assert final_statuses == {"demo": "applied", "demo2": "applied"}
