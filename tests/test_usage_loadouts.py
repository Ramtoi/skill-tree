"""Tests for `usage_loadouts.py` — the loadout history ledger.

Covers plan `tasks.md` wave-1 task 1.27: `loadout_hash` depends on the two
sorted lists only, an earlier row is byte-identical after a later append,
`run_loadout_pass` appends only on a change, affinity narrows a per-harness
row, and `loadout_at`/`first_loadout_for_pair` resolve the right row.

Every test uses `tmp_data_home` (isolates `SKILL_HUB_HOME`) plus the autouse
`_fake_home` fixture in `conftest.py` (fakes `$HOME`) — no test may read or
write the real `~/.claude` or `~/.skill-hub`.
"""

from __future__ import annotations

import json

from skill_hub.infrastructure.usage import usage_loadouts as ul

# ─────────────────────────────────────────────────────────────────────────────
# loadout_hash
# ─────────────────────────────────────────────────────────────────────────────


def test_loadout_hash_depends_on_sorted_lists_only():
    h1 = ul.loadout_hash(["b", "a"], ["m2", "m1"])
    h2 = ul.loadout_hash(["a", "b"], ["m1", "m2"])
    assert h1 == h2
    assert len(h1) == 64

    h3 = ul.loadout_hash(["a"], ["m1", "m2"])
    assert h3 != h1


# ─────────────────────────────────────────────────────────────────────────────
# loadout_at / first_loadout_for_pair
# ─────────────────────────────────────────────────────────────────────────────


def _rows():
    return [
        {
            "project": "p",
            "harness": "claude-code",
            "at": "2026-01-01T00:00:00Z",
            "skills": ["a"],
            "mcp": [],
            "hash": "h1",
        },
        {
            "project": "p",
            "harness": "claude-code",
            "at": "2026-02-01T00:00:00Z",
            "skills": ["a", "b"],
            "mcp": [],
            "hash": "h2",
        },
        {
            "project": "p",
            "harness": "codex",
            "at": "2026-01-15T00:00:00Z",
            "skills": ["a"],
            "mcp": [],
            "hash": "h3",
        },
    ]


def test_loadout_at_returns_the_latest_row_at_or_before_the_timestamp():
    rows = _rows()
    assert ul.loadout_at(rows, "p", "claude-code", "2026-01-15T00:00:00Z")["hash"] == "h1"
    assert ul.loadout_at(rows, "p", "claude-code", "2026-03-01T00:00:00Z")["hash"] == "h2"
    assert ul.loadout_at(rows, "p", "claude-code", "2025-12-01T00:00:00Z") is None
    assert ul.loadout_at(rows, "p", "codex", "2026-01-20T00:00:00Z")["hash"] == "h3"


def test_first_loadout_for_pair():
    rows = _rows()
    assert ul.first_loadout_for_pair(rows, "p", "claude-code")["hash"] == "h1"
    assert ul.first_loadout_for_pair(rows, "p", "unknown-harness") is None


# ─────────────────────────────────────────────────────────────────────────────
# read_loadout_rows / append-only durability
# ─────────────────────────────────────────────────────────────────────────────


def test_append_is_atomic_and_earlier_rows_stay_byte_identical(tmp_data_home):
    registry = _registry_one_project()
    installed = {"claude-code"}

    def resolve_skills(_proj, _reg):
        return ["skill-a"]

    result1 = ul.run_loadout_pass(
        registry, resolve_skills=resolve_skills, installed=installed, affinity=lambda _cfg: None
    )
    assert result1["appended"] == 1

    path = ul.loadouts_path()
    text_after_first = path.read_text()

    # A second project's skill set differs, forcing a second append.
    def resolve_skills_2(_proj, _reg):
        return ["skill-a", "skill-b"]

    result2 = ul.run_loadout_pass(
        registry, resolve_skills=resolve_skills_2, installed=installed, affinity=lambda _cfg: None
    )
    assert result2["appended"] == 1

    text_after_second = path.read_text()
    assert text_after_second.startswith(text_after_first)
    assert text_after_second != text_after_first

    rows, warnings = ul.read_loadout_rows()
    assert warnings == []
    assert len(rows) == 2
    assert rows[0]["skills"] == ["skill-a"]
    assert rows[1]["skills"] == ["skill-a", "skill-b"]


def test_read_loadout_rows_drops_a_malformed_line_and_warns(tmp_data_home):
    path = ul.loadouts_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    good = {
        "schema_version": 1,
        "at": "2026-01-01T00:00:00Z",
        "project": "p",
        "harness": "claude-code",
        "skills": ["a"],
        "mcp": [],
        "hash": ul.loadout_hash(["a"], []),
    }
    path.write_text(json.dumps(good, sort_keys=True) + "\n" + "{not json\n")
    rows, warnings = ul.read_loadout_rows()
    assert len(rows) == 1
    assert len(warnings) == 1


def test_read_loadout_rows_missing_file_is_empty(tmp_data_home):
    rows, warnings = ul.read_loadout_rows()
    assert rows == []
    assert warnings == []


# ─────────────────────────────────────────────────────────────────────────────
# run_loadout_pass
# ─────────────────────────────────────────────────────────────────────────────


def _registry_one_project():
    return {
        "harnesses_global": [],
        "projects": {
            "proj1": {"path": "/tmp/proj1", "harnesses": ["claude-code"]},
        },
        "skills": {
            "skill-a": {"type": "skill"},
            "skill-b": {"type": "skill"},
            "mcp-x": {"type": "mcp-server"},
        },
    }


def test_run_loadout_pass_appends_only_on_a_hash_change(tmp_data_home):
    registry = _registry_one_project()
    installed = {"claude-code"}

    def resolve_skills(_proj, _reg):
        return ["skill-a", "mcp-x"]

    report: dict = {}
    result1 = ul.run_loadout_pass(
        registry, resolve_skills=resolve_skills, installed=installed, affinity=lambda _cfg: None, report=report
    )
    assert result1["appended"] == 1
    assert result1["pairs"] == 1
    assert result1["errors"] == []
    assert report["global"]["loadouts"] == result1

    # Same registry, same resolved skills — a second pass appends nothing.
    result2 = ul.run_loadout_pass(
        registry, resolve_skills=resolve_skills, installed=installed, affinity=lambda _cfg: None
    )
    assert result2["appended"] == 0
    assert result2["pairs"] == 1

    rows, _warnings = ul.read_loadout_rows()
    assert len(rows) == 1
    assert rows[0]["skills"] == ["skill-a"]
    assert rows[0]["mcp"] == ["mcp-x"]

    # An equip (resolved set changes) appends exactly one more row.
    def resolve_skills_more(_proj, _reg):
        return ["skill-a", "skill-b", "mcp-x"]

    result3 = ul.run_loadout_pass(
        registry, resolve_skills=resolve_skills_more, installed=installed, affinity=lambda _cfg: None
    )
    assert result3["appended"] == 1
    rows, _warnings = ul.read_loadout_rows()
    assert len(rows) == 2
    assert rows[-1]["skills"] == ["skill-a", "skill-b"]


def test_run_loadout_pass_stamps_at_from_the_fixed_clock_seam(tmp_data_home, monkeypatch):
    """`SKILL_HUB_NOW` fixes `clock_now()`, so two calls — even one appending
    a row and the next appending a DIFFERENT row (a changed registry) — are
    byte-comparable across a two-machine backup/restore round trip: neither
    row's `at` depends on how much wall-clock time actually elapsed between
    the two calls."""
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-07T12:00:00Z")
    registry = _registry_one_project()
    installed = {"claude-code"}

    result1 = ul.run_loadout_pass(
        registry,
        resolve_skills=lambda _proj, _reg: ["skill-a"],
        installed=installed,
        affinity=lambda _cfg: None,
    )
    assert result1["appended"] == 1

    result2 = ul.run_loadout_pass(
        registry,
        resolve_skills=lambda _proj, _reg: ["skill-a", "skill-b"],
        installed=installed,
        affinity=lambda _cfg: None,
    )
    assert result2["appended"] == 1

    rows, _warnings = ul.read_loadout_rows()
    assert len(rows) == 2
    assert rows[0]["at"] == rows[1]["at"] == "2026-09-07T12:00:00Z"


def test_run_loadout_pass_affinity_narrows_a_per_harness_row(tmp_data_home):
    registry = {
        "harnesses_global": [],
        "projects": {
            "proj1": {"path": "/tmp/proj1", "harnesses": ["claude-code", "codex"]},
        },
        "skills": {
            "skill-a": {"type": "skill"},
            "skill-b": {"type": "skill", "harnesses": ["claude-code"]},
        },
    }
    installed = {"claude-code", "codex"}

    def resolve_skills(_proj, _reg):
        return ["skill-a", "skill-b"]

    def affinity(cfg):
        h = cfg.get("harnesses")
        return set(h) if h else None

    result = ul.run_loadout_pass(
        registry, resolve_skills=resolve_skills, installed=installed, affinity=affinity
    )
    assert result["appended"] == 2
    assert result["pairs"] == 2

    rows, _warnings = ul.read_loadout_rows()
    by_harness = {r["harness"]: r for r in rows}
    assert by_harness["claude-code"]["skills"] == ["skill-a", "skill-b"]
    assert by_harness["codex"]["skills"] == ["skill-a"]


def test_run_loadout_pass_records_errors_without_str_exc_and_never_raises(tmp_data_home):
    registry = _registry_one_project()
    installed = {"claude-code"}

    def bad_resolve_skills(_proj, _reg):
        raise RuntimeError("boom with a /Users/dev/secret/path inside")

    result = ul.run_loadout_pass(
        registry, resolve_skills=bad_resolve_skills, installed=installed, affinity=lambda _cfg: None
    )
    assert result["appended"] == 0
    assert len(result["errors"]) == 1
    error = result["errors"][0]
    assert set(error.keys()) == {"file", "kind"}
    assert error["kind"] == "RuntimeError"
    # Never str(exc): the error text (which would carry a path) must not leak.
    for value in error.values():
        assert value is None or "secret" not in str(value)


def test_run_loadout_pass_never_raises_on_a_bad_project_entry(tmp_data_home):
    registry = {
        "harnesses_global": [],
        "projects": {"broken": "not-a-dict", "proj1": {"path": "/tmp/proj1", "harnesses": ["claude-code"]}},
        "skills": {"skill-a": {"type": "skill"}},
    }
    installed = {"claude-code"}
    result = ul.run_loadout_pass(
        registry,
        resolve_skills=lambda _proj, _reg: ["skill-a"],
        installed=installed,
        affinity=lambda _cfg: None,
    )
    assert result["pairs"] == 1
    assert result["appended"] == 1
    assert result["errors"] == []
