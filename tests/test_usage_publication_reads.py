"""Bounded immutable publication reads."""

from __future__ import annotations

import json
import sqlite3

from skill_hub.application.usage import usage_publication_reads as reads
from skill_hub.infrastructure.usage import usage_source_versions as versions


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    versions.install_schema(db)
    reads.install_schema(db)
    return db


def _publication(
    db: sqlite3.Connection,
    source_id: str,
    publication_id: str,
    *,
    harness: str = "codex",
    root: str = "root",
    session: str | None = None,
    run: str | None = None,
    logical: str | None = None,
    parent: str | None = None,
    origin: str = "source",
    state: str = "complete",
    head: bool = True,
) -> None:
    session = session or source_id
    db.execute(
        "INSERT INTO source_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
        (publication_id, source_id, "epoch:shared", "binding:" + "a" * 64, "replacement", None, None, state, None, 9),
    )
    scope = {"record_type": "source_scope", "harness": harness, "root_session_id": root, "source_session_id": session}
    db.execute(
        "INSERT INTO version_facts VALUES (?,?,?,?,?,?,?)",
        (publication_id, "structural", f"scope:{source_id}", 1, json.dumps(scope), publication_id, "[]"),
    )
    if run is not None:
        metadata = {
            "run_id": run,
            "logical_run_id": logical or run,
            "parent_logical_run_id": parent,
            "origin": origin,
            "harness": harness,
            "root_session_id": root,
            "source_session_id": session,
            "native_facts": {},
        }
        db.execute(
            "INSERT INTO version_facts VALUES (?,?,?,?,?,?,?)",
            (publication_id, "run", run, 2, json.dumps(metadata), publication_id, "[]"),
        )
    if head:
        db.execute("INSERT INTO source_heads VALUES (?,?)", (source_id, publication_id))
    reads.index_publication(db, publication_id)


def test_readset_decodes_only_selected_source_history(monkeypatch) -> None:
    db = _db()
    _publication(db, "selected", "pub:selected", root="wanted", run="run:selected")
    for number in range(100):
        _publication(db, f"other:{number}", f"pub:{number}", root=f"other:{number}", run=f"run:{number}")
    original = reads.json.loads
    calls = 0

    def counted(value):
        nonlocal calls
        calls += 1
        return original(value)

    monkeypatch.setattr(reads.json, "loads", counted)
    result = reads.CurrentReadSet(db, harness="codex", session_id="wanted")
    assert [item["run_id"] for item in result.members()] == ["run:selected"]
    assert result.facts("token") == []
    assert calls <= 2  # selected metadata only; unrelated histories never decode.


def test_same_epoch_sources_remain_source_scoped() -> None:
    db = _db()
    _publication(db, "source:left", "pub:left", root="root", session="left", run="run:left")
    _publication(db, "source:right", "pub:right", root="root", session="right", run="run:right")
    result = reads.CurrentReadSet(db, harness="codex", session_id="root")
    assert {item["_source_id"] for item in result.members()} == {"source:left", "source:right"}


def test_initial_staged_dedicated_source_outranks_inline_and_reparent_scope_closes() -> None:
    db = _db()
    _publication(
        db,
        "inline",
        "pub:inline",
        root="root",
        session="root",
        run="inline-run",
        logical="logical",
        origin="inline_sidechain",
    )
    _publication(
        db,
        "dedicated",
        "pub:dedicated",
        root="root",
        session="child",
        run="dedicated-run",
        logical="logical",
        origin="source",
        state="staged",
        head=False,
    )
    _publication(
        db, "grandchild", "pub:grandchild", root="child", session="grandchild", run="grandchild-run", parent="logical"
    )
    result = reads.CurrentReadSet(db, harness="codex", session_id="root")
    members = {item["logical_run_id"]: item for item in result.members()}
    assert members["logical"]["run_id"] == "dedicated-run"
    assert members["logical"]["_published"] is False
    # A later source that only names the captured parent remains in the root family.
    assert any(item["run_id"] == "grandchild-run" for item in result.members())


def test_staged_reparent_history_does_not_expand_a_completed_family() -> None:
    db = _db()
    _publication(db, "root", "pub:root", root="root", run="root-run", logical="root-logical")
    _publication(
        db,
        "root",
        "pub:root-staged",
        root="other-root",
        run="staged-run",
        logical="staged-logical",
        state="staged",
        head=False,
    )
    _publication(
        db,
        "later-child",
        "pub:later-child",
        root="other-root",
        run="later-run",
        parent="staged-logical",
    )
    result = reads.CurrentReadSet(db, harness="codex", session_id="root")
    assert [item["run_id"] for item in result.members()] == ["root-run"]


def test_run_scoped_physical_inline_lookup_includes_dedicated_peer() -> None:
    db = _db()
    _publication(
        db,
        "inline",
        "pub:inline",
        root="root",
        run="inline-run",
        logical="shared-logical",
        origin="inline_sidechain",
    )
    _publication(
        db,
        "dedicated",
        "pub:dedicated",
        root="root",
        run="dedicated-run",
        logical="shared-logical",
        origin="source",
    )
    result = reads.CurrentReadSet(db, harness="codex", run_ids={"inline-run"})
    members = result.members()
    assert [item["run_id"] for item in members] == ["dedicated-run"]


def test_missing_run_scope_decodes_no_published_history(monkeypatch) -> None:
    db = _db()
    _publication(db, "selected", "pub:selected", root="root", run="selected-run")
    for number in range(20):
        _publication(db, f"other:{number}", f"pub:{number}", run=f"other-run:{number}")
    original = reads.json.loads
    calls = 0

    def counted(value):
        nonlocal calls
        calls += 1
        return original(value)

    monkeypatch.setattr(reads.json, "loads", counted)
    result = reads.CurrentReadSet(db, harness="codex", run_ids={"missing-run"})
    assert result.members() == []
    assert result.facts("call") == []
    assert calls == 0


def test_append_without_scope_or_run_keeps_inherited_locator_and_facts() -> None:
    db = _db()
    _publication(db, "source", "pub:base", root="root", run="run:base")
    db.execute(
        "INSERT INTO source_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            "pub:append",
            "source",
            "epoch:shared",
            "binding:" + "a" * 64,
            "append",
            "pub:base",
            "pub:base",
            "complete",
            None,
            10,
        ),
    )
    db.execute(
        "INSERT INTO version_facts VALUES (?,?,?,?,?,?,?)",
        (
            "pub:append",
            "token",
            "token:new",
            10,
            json.dumps({"run_id": "run:base", "sample_id": "token:new"}),
            "pub:append",
            "[]",
        ),
    )
    db.execute("UPDATE source_heads SET publication_id='pub:append' WHERE source_id='source'")
    reads.index_publication(db, "pub:append")
    result = reads.CurrentReadSet(db, harness="codex", run_ids={"run:base"})
    assert [item["run_id"] for item in result.members()] == ["run:base"]
    assert [item["sample_id"] for item in result.facts("token")] == ["token:new"]


def test_checkpoint_index_matches_resolved_append_locator() -> None:
    db = _db()
    _publication(db, "source", "pub:base", root="root", run="run:base")
    db.execute(
        "INSERT INTO source_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            "pub:checkpoint",
            "source",
            "epoch:shared",
            "binding:" + "a" * 64,
            "checkpoint",
            "pub:base",
            "pub:base",
            "complete",
            None,
            9,
        ),
    )
    db.execute("UPDATE source_heads SET publication_id='pub:checkpoint' WHERE source_id='source'")
    reads.index_publication(db, "pub:checkpoint")
    rows = db.execute(
        "SELECT kind,physical_id FROM publication_fact_index WHERE publication_id='pub:checkpoint' ORDER BY kind"
    ).fetchall()
    assert [tuple(row) for row in rows] == [("run", "run:base"), ("scope", "scope:source")]


def test_current_scopes_skips_non_scope_structural_seeds() -> None:
    db = _db()
    _publication(db, "source", "pub:base", root="root", run="run:base")
    db.execute(
        "INSERT INTO version_facts VALUES (?,?,?,?,?,?,?)",
        ("pub:base", "structural", "seed:one", 3, json.dumps({"event_id": "seed:one"}), "pub:base", "[]"),
    )
    assert [scope["source_session_id"] for scope in reads.current_scopes(db)] == ["source"]


def test_scopes_include_selected_initial_stage_without_inline_mirror_tokens() -> None:
    db = _db()
    _publication(db, "root", "pub:root", root="root", session="root", run="root-run")
    _publication(
        db,
        "inline",
        "pub:inline",
        root="root",
        session="root",
        run="inline-run",
        logical="agent-logical",
        origin="inline_sidechain",
    )
    db.execute(
        "INSERT INTO version_facts VALUES (?,?,?,?,?,?,?)",
        (
            "pub:inline",
            "token",
            "inline-token",
            3,
            json.dumps({"run_id": "inline-run", "sample_id": "inline-token"}),
            "pub:inline",
            "[]",
        ),
    )
    _publication(
        db,
        "dedicated",
        "pub:dedicated",
        root="root",
        session="child",
        run="dedicated-run",
        logical="agent-logical",
        origin="source",
        state="staged",
        head=False,
    )
    result = reads.CurrentReadSet(db, harness="codex", session_id="root")
    scopes = {scope["source_session_id"]: scope for scope in result.scopes()}
    assert set(scopes) == {"root", "child"}
    assert scopes["root"]["_published"] is True
    assert scopes["child"]["_published"] is False
    assert result.facts("token") == []
