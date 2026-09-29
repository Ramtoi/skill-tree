"""The E3 rev 2 adversarial-input corpus (`plans/E3.edge-cases.md` §3, 65
ids) driven through the real readers (`plans/E3.md` §5 test 1) — the same
one-source-two-runtimes pattern as `mcp_secret_corpus.json`.

Every `claude_*`/`codex_*`/`opencode_*` case drives `mcp_reconcile.classify`
through the matching `_discover_*` function; every `paste`/`paste_wrapper`
case drives `skill_hub.entrypoints.cli.mcp._parse_add_stdin` for real (stdin monkeypatched,
`--json` refusals captured and parsed). `app/src/test/mcpImportCorpus.test.ts`
(E3b) drives the `paste*` half again from the TS side; a completeness test
that every case id appears in both suites is E3b's (this file only pins the
Python-side count).
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

import skill_hub.entrypoints.cli.mcp as mcp_cli
from skill_hub.domain.mcp import mcp_spec
from skill_hub.infrastructure.mcp import mcp_reconcile

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "mcp_import_corpus.json"
VOCAB_PATH = Path(__file__).parent / "fixtures" / "mcp_vocabulary.json"


@pytest.fixture(autouse=True)
def _mark_global_capable(monkeypatch):
    """`tests/conftest.py::_isolate_global_mcp` (autouse) nulls every
    harness's `global_mcp_config` by default, so a `claude_user`/`codex_global`
    corpus row would otherwise misclassify `unsupported/no_global_target`
    regardless of its actual shape — restore both to a fake path (never a
    real dotfile; `discover_native` never opens these for THIS fixture,
    which drives the `_discover_*` functions directly, not via a real
    `~/.claude.json`/`~/.codex/config.toml` read)."""
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(harnesses.HARNESSES)
    for h_id in ("claude-code", "codex"):
        if h_id in patched:
            patched[h_id] = dataclasses.replace(patched[h_id], global_mcp_config=Path("/fake/global"))
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

CLASSIFY_SOURCES = {
    "claude_user",
    "claude_local",
    "claude_project",
    "codex_global",
    "codex_project",
    "opencode_project",
}
PASTE_SOURCES = {"paste", "paste_wrapper"}


def _load_corpus() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _corpus_cases() -> list[dict]:
    return _load_corpus()["cases"]


def _discover_one(source: str, name: str, native: object, file: str):
    if source in ("claude_user", "claude_local", "claude_project"):
        scope_label = {"claude_user": "user", "claude_local": "local", "claude_project": "project"}[source]
        return mcp_reconcile._discover_claude_like(name, "claude-code", scope_label, Path(file), None, native)
    if source in ("codex_global", "codex_project"):
        scope_label = "global" if source == "codex_global" else "project"
        return mcp_reconcile._discover_codex_entry(name, scope_label, Path(file), None, native)
    if source == "opencode_project":
        return mcp_reconcile._discover_opencode_entry(name, "project", Path(file), None, native)
    raise AssertionError(f"unexpected classify source: {source!r}")


def _run_classify_case(case: dict) -> dict:
    registry = case.get("registry") or {"skills": {}, "projects": {}}
    entries = [_discover_one(case["source"], case["name"], case["native"], "/fake/f")]
    for i, extra in enumerate(case.get("extra_entries") or []):
        entries.append(_discover_one(extra["source"], extra["name"], extra["native"], f"/fake/f{i + 2}"))
    candidates = mcp_reconcile.classify(entries, registry, set())
    pick = case.get("pick_name")
    if pick is not None:
        return next(c for c in candidates if c["name"] == pick)
    assert len(candidates) == 1, (case["id"], [c["name"] for c in candidates])
    return candidates[0]


def _paste_stdin_text(case: dict) -> str:
    text = case.get("raw_stdin")
    if text is None:
        text = json.dumps(case["native"])
    if case.get("bom"):
        text = "﻿" + text
    return text


def _run_paste_case(case: dict, monkeypatch, capsys) -> dict:
    monkeypatch.setattr("sys.stdin", io.StringIO(_paste_stdin_text(case)))
    mcp_cli._json_mode = True
    try:
        try:
            name, spec, warnings = mcp_cli._parse_add_stdin(case.get("name"))
        except SystemExit as e:
            assert e.code == 2, case["id"]
            out = json.loads(capsys.readouterr().out)
            return {
                "status": "unsupported",
                "import_name": out.get("name"),
                "reason": out.get("reason"),
                "warnings": [],
                "spec": None,
            }
        block = mcp_spec.spec_to_registry_block(spec)
        return {"status": "ok", "import_name": name, "reason": None, "warnings": warnings, "spec": block}
    finally:
        mcp_cli._json_mode = False


def _run_case(case: dict, monkeypatch, capsys) -> dict:
    if case["source"] in CLASSIFY_SOURCES:
        c = _run_classify_case(case)
        return {
            "status": c["status"],
            "import_name": c["import_name"],
            "reason": c["reason"],
            "warnings": c["warnings"],
            "spec": c["spec"],
        }
    if case["source"] in PASTE_SOURCES:
        return _run_paste_case(case, monkeypatch, capsys)
    raise AssertionError(f"unknown corpus source {case['source']!r} in case {case['id']}")


@pytest.mark.parametrize("case", _corpus_cases(), ids=lambda c: c["id"])
def test_corpus_case(case, monkeypatch, capsys):
    """`plans/E3.md` §5 test 1 — every one of the catalogue's ids through its
    reader (65 from the original catalogue list + N12b, split out of N12 once
    the coordinator caught that N12's literal name is a NUL byte, not an
    ordinary space — see the N12/N12b `note` fields); the catalogue's "the
    one assertion that fails today" column IS the assertion list, expressed
    here as status/reason/warnings/spec/import_name."""
    got = _run_case(case, monkeypatch, capsys)
    expect = case["expect"]
    assert got["status"] == expect["status"], case["id"]
    assert got["import_name"] == expect["import_name"], case["id"]
    assert got["reason"] == expect["reason"], case["id"]
    assert got["warnings"] == expect["warnings"], case["id"]
    assert got["spec"] == expect["spec"], case["id"]


def test_corpus_has_all_expected_ids():
    """67 = the catalogue's 65 ids, with N12 split into N12 (the real NUL
    -byte case) + N12b (the ordinary-space case E3a originally pinned under
    the N12 id by misreading the catalogue's `\\u0000` escape as a space),
    plus F5W (C1: a non-catalogue case that produces `unclaimed_native_entry`
    — see `test_vocabulary_fixture_has_no_dead_warning_words`)."""
    cases = _corpus_cases()
    assert len(cases) == 67
    ids = [c["id"] for c in cases]
    assert len(set(ids)) == 67, "duplicate corpus ids"


# ─────────────────────────────────────────────────────────────────────────────
# §5 test 2 — three doors agree: for every paste* row that carries a plain
# `native` dict (not `raw_stdin`, not a wrapper), `_parse_add_stdin` and the
# `claude_user` reconcile-import twin of the SAME native object produce the
# same `import_name` and the same `reason` word, or the same `ok` spec.
# ─────────────────────────────────────────────────────────────────────────────


def _paste_cases_with_a_plain_native() -> list[dict]:
    """Every `paste*` case whose `native` is a single bare server object a
    `claude_user` twin can also parse — excludes `raw_stdin`-only cases
    (S07/S09, no clean dict to hand `_discover_claude_like`) and wrapper
    -structural cases (S03/S04, whose `native` IS an `mcpServers` wrapper —
    `classify` has no concept of "wrapper", only single server entries, so
    there is no meaningful twin to compare against)."""
    return [
        c
        for c in _corpus_cases()
        if c["source"] in PASTE_SOURCES
        and c.get("raw_stdin") is None
        and isinstance(c.get("native"), dict)
        and "mcpServers" not in c["native"]
    ]


@pytest.mark.parametrize("case", _paste_cases_with_a_plain_native(), ids=lambda c: c["id"])
def test_three_doors_agree(case, monkeypatch, capsys):
    paste_result = _run_paste_case(case, monkeypatch, capsys)
    twin_name = case.get("name") or "srv"
    twin = _run_classify_case(
        {
            "id": case["id"],
            "source": "claude_user",
            "name": twin_name,
            "native": case["native"],
        }
    )
    if paste_result["status"] == "ok":
        assert twin["status"] in ("new", "already_managed")
        if twin["status"] == "new":
            assert twin["spec"] == paste_result["spec"]
    else:
        assert paste_result["import_name"] == twin["import_name"], case["id"]
        assert paste_result["reason"] == twin["reason"], case["id"]

    # N8/C1: the paste door's warning set must equal the classify twin's —
    # the whole guard C1 asked for (a normaliser warning reaching one door
    # but not the other). `renamed_from:*` is classify-only bookkeeping (the
    # candidate's own native key vs. its slug) with no paste-door analogue,
    # so it is excluded from the comparison rather than widening it away.
    twin_warnings = sorted(w for w in twin["warnings"] if not w.startswith("renamed_from:"))
    assert sorted(paste_result["warnings"]) == twin_warnings, case["id"]


# ─────────────────────────────────────────────────────────────────────────────
# §5 test 14 — completeness pins (Python side): `mcp_vocabulary.json` lists
# every word `UNSUPPORTED_REASONS` / the warning set / the failure codes
# contain; `mcp_spec`'s slug pattern equals `hub_core.SLUG_RE.pattern`.
# ─────────────────────────────────────────────────────────────────────────────


def test_slug_pattern_matches_hub_core():
    from skill_hub import hub_core

    assert mcp_spec._SLUG_RE.pattern == hub_core.SLUG_RE.pattern


def test_vocabulary_fixture_covers_unsupported_reasons():
    vocab = json.loads(VOCAB_PATH.read_text(encoding="utf-8"))
    assert set(mcp_reconcile.UNSUPPORTED_REASONS) <= set(vocab["unsupported_reasons"])


def test_vocabulary_fixture_covers_failure_codes():
    vocab = json.loads(VOCAB_PATH.read_text(encoding="utf-8"))
    assert set(mcp_cli.MCP_FAILURE_CODES) <= set(vocab["failure_codes"])


def test_vocabulary_fixture_covers_warning_words_seen_in_the_corpus():
    """Every bare warning word the corpus itself produces must be a member
    of the pinned vocabulary — a new word landing without a fixture entry
    fails here first."""
    vocab = json.loads(VOCAB_PATH.read_text(encoding="utf-8"))
    known = set(vocab["warning_words"])
    seen: set[str] = set()
    for case in _corpus_cases():
        for w in case["expect"]["warnings"]:
            seen.add(w.split(":", 1)[0])
    assert seen <= known, seen - known


def test_vocabulary_fixture_has_no_dead_warning_words():
    """C1: the OTHER direction — every warning word `mcp_vocabulary.json`
    lists must be produced by at least one corpus case, or it is dead copy
    E3b would write and never render (C1's own root cause: 12 of 16 words
    were dead until the union fix in `_classify_one`)."""
    vocab = json.loads(VOCAB_PATH.read_text(encoding="utf-8"))
    known = set(vocab["warning_words"])
    seen: set[str] = set()
    for case in _corpus_cases():
        for w in case["expect"]["warnings"]:
            seen.add(w.split(":", 1)[0])
    assert known <= seen, f"dead warning words (never produced by any corpus case): {known - seen}"
