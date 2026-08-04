"""Snippet library storage: CRUD, validation, tags, filters, guarded delete."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

import snippets


@pytest.fixture
def sdir(tmp_path) -> Path:
    return snippets.snippets_dir(tmp_path)


BODY = "## Validation\n\n1. Build.\n2. Test.\n"


def test_create_round_trips(sdir):
    s = snippets.create_snippet(
        sdir, "validation-procedure", description="Steps", tags=["Workflow"], body=BODY
    )
    assert (sdir / "validation-procedure.md").is_file()
    loaded = snippets.get_snippet(sdir, "validation-procedure")
    assert loaded is not None
    assert loaded.name == "validation-procedure"
    assert loaded.description == "Steps"
    assert loaded.tags == ["workflow"]
    assert loaded.version == 1
    assert snippets.normalize_body(loaded.body) == snippets.normalize_body(BODY)
    assert snippets.snip_hash(loaded.body) == snippets.snip_hash(s.body)


@pytest.mark.parametrize("bad", ["", "Bad Name!", "UPPER", "two--hyphens", "-lead", "trail-"])
def test_invalid_names_rejected(sdir, bad):
    with pytest.raises(snippets.SnippetError):
        snippets.create_snippet(sdir, bad, body=BODY)
    assert not list(sdir.glob("*.md"))


def test_marker_injection_rejected_on_create_and_edit(sdir):
    evil = "text\n<!-- skill-tree:snippet id=x v=1 sha=abc -->\nmore"
    with pytest.raises(snippets.SnippetError):
        snippets.create_snippet(sdir, "evil", body=evil)
    assert not (sdir / "evil.md").exists()

    snippets.create_snippet(sdir, "ok", body=BODY)
    with pytest.raises(snippets.SnippetError):
        snippets.edit_snippet(sdir, "ok", body="  <!-- skill-tree:snippet:end id=ok -->")
    # end-marker prefix is also caught; body unchanged
    assert snippets.normalize_body(
        snippets.get_snippet(sdir, "ok").body
    ) == snippets.normalize_body(BODY)


def test_duplicate_create_rejected(sdir):
    snippets.create_snippet(sdir, "dup", description="first", body=BODY)
    with pytest.raises(snippets.SnippetError, match="already exists"):
        snippets.create_snippet(sdir, "dup", description="second", body="other")
    assert snippets.get_snippet(sdir, "dup").description == "first"


def test_tag_normalization(sdir):
    s = snippets.create_snippet(
        sdir, "tagged", tags=["Workflow", " quality ", "workflow", "QUALITY"], body=BODY
    )
    assert s.tags == ["workflow", "quality"]


def test_list_filters(sdir):
    snippets.create_snippet(sdir, "val", description="validation steps", tags=["quality"], body="check things")
    snippets.create_snippet(sdir, "docs", description="doc style", tags=["style"], body="write nicely")

    assert {s.name for s in snippets.list_snippets(sdir)} == {"val", "docs"}
    assert [s.name for s in snippets.list_snippets(sdir, tag="quality")] == ["val"]
    assert [s.name for s in snippets.list_snippets(sdir, query="NICELY")] == ["docs"]
    assert [s.name for s in snippets.list_snippets(sdir, query="validation")] == ["val"]
    assert snippets.list_snippets(sdir, tag="missing") == []


def test_edit_body_bumps_version_metadata_edit_does_not(sdir):
    snippets.create_snippet(sdir, "v", body=BODY)
    s, changed = snippets.edit_snippet(sdir, "v", description="new desc")
    assert not changed and s.version == 1
    s, changed = snippets.edit_snippet(sdir, "v", body=BODY + "\n3. Lint.\n")
    assert changed and s.version == 2
    # Whitespace-only change does not bump.
    s, changed = snippets.edit_snippet(sdir, "v", body=s.body + "\n\n")
    assert not changed and s.version == 2


def test_edit_unknown_and_delete_unknown(sdir):
    with pytest.raises(snippets.SnippetError):
        snippets.edit_snippet(sdir, "ghost", description="x")
    with pytest.raises(snippets.SnippetError):
        snippets.delete_snippet(sdir, "ghost")


# ─── CLI-level guarded delete (scan-based) ───────────────────────────────────


def _setup_applied(tmp_data_home: Path):
    """Registry with one project + a snippet applied to its AGENTS.md."""
    import yaml

    proj = tmp_data_home / "proj"
    proj.mkdir()
    (proj / "AGENTS.md").write_text("# Proj\n")
    (tmp_data_home / "registry.yaml").write_text(
        yaml.dump({"harnesses_global": [], "projects": {"demo": {"path": str(proj)}}})
    )
    sdir = snippets.snippets_dir(tmp_data_home)
    snippets.create_snippet(sdir, "guarded", body=BODY)
    library = snippets.library_by_name(sdir)
    registry = {"projects": {"demo": {"path": str(proj)}}}
    snippets.apply_snippet(
        registry, library, tmp_data_home / "_hub-backups", "guarded", "demo", rel="AGENTS.md"
    )
    return proj, sdir


def test_edit_body_reports_now_outdated_locations(tmp_data_home, capsys):
    import json

    import hub

    _setup_applied(tmp_data_home)
    hub.cmd_snippet_edit(
        SimpleNamespace(
            name="guarded",
            description=None,
            tags=None,
            body=BODY + "\n3. Lint.\n",
            body_file=None,
            json=True,
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["body_changed"] is True
    assert payload["version"] == 2
    assert payload["outdated_locations"] == 1


def test_delete_refused_while_applied(tmp_data_home):
    import hub

    proj, sdir = _setup_applied(tmp_data_home)
    before = (proj / "AGENTS.md").read_text()
    with pytest.raises(SystemExit):
        hub.cmd_snippet_delete(SimpleNamespace(name="guarded", force=False, json=False))
    assert (sdir / "guarded.md").exists()
    assert (proj / "AGENTS.md").read_text() == before


def test_forced_delete_leaves_file_untouched_and_orphans_block(tmp_data_home):
    import hub

    proj, sdir = _setup_applied(tmp_data_home)
    before = (proj / "AGENTS.md").read_text()
    hub.cmd_snippet_delete(SimpleNamespace(name="guarded", force=True, json=True))
    assert not (sdir / "guarded.md").exists()
    assert (proj / "AGENTS.md").read_text() == before
    # The remaining block now scans as orphaned.
    registry = {"projects": {"demo": {"path": str(proj)}}}
    res = snippets.scan_all(registry, snippets.library_by_name(sdir))
    assert [l["status"] for l in res["locations"]] == ["orphaned"]
