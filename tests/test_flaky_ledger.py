"""Tests for `testing/scripts/flaky_report.py`.

Two groups, per the unit brief:

1. Unit tests of the pure parts with `tmp_path` fixtures: both parsers
   (including nested describes/suites and multiple shard inputs), the
   summary/warning renderer for ledgered vs. unledgered flakes, and one
   test per `validate_ledger` rule.
2. Real-tree checks: `testing/flaky.yaml` validates (schema, unique ids,
   date order, no open entry past its deadline, a quarantined entry has a
   reason and a matching code marker, no stray marker in the tree, and
   every open/quarantined title still exists in its file).
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOL = REPO_ROOT / "testing" / "scripts" / "flaky_report.py"

_spec = importlib.util.spec_from_file_location("flaky_report_tool", TOOL)
assert _spec and _spec.loader
fr = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = fr
_spec.loader.exec_module(fr)


# ------------------------------------------------------------ Playwright parsing


def _pw_report(suites: List[Dict[str, Any]], root_dir: str = "/repo/app/e2e") -> Dict[str, Any]:
    return {"config": {"rootDir": root_dir}, "suites": suites, "errors": [], "stats": {}}


def _pw_spec(title: str, status: str, retry: int = 0) -> Dict[str, Any]:
    results = [{"status": "failed" if status == "flaky" else status, "retry": r} for r in range(retry)]
    results.append({"status": "passed" if status == "flaky" else status, "retry": retry})
    return {"title": title, "specs": [{"title": title, "tests": [{"status": status, "results": results}]}]}


class TestParsePlaywright:
    def test_flaky_spec_at_file_top_level_is_reported(self, tmp_path: Path) -> None:
        report = _pw_report(
            [
                {
                    "title": "shell.journey.spec.ts",
                    "file": "shell.journey.spec.ts",
                    "specs": [
                        {
                            "title": "opens the shell",
                            "tests": [
                                {
                                    "status": "flaky",
                                    "results": [{"status": "failed", "retry": 0}, {"status": "passed", "retry": 1}],
                                }
                            ],
                        }
                    ],
                }
            ],
            root_dir=str(REPO_ROOT / "app" / "e2e"),
        )
        path = tmp_path / "results.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        flaky = fr.parse_playwright([path])
        assert flaky == [
            {"runner": "e2e", "file": "app/e2e/shell.journey.spec.ts", "title": "opens the shell", "retries": 1}
        ]

    def test_non_flaky_spec_is_ignored(self, tmp_path: Path) -> None:
        report = _pw_report(
            [
                {
                    "title": "shell.journey.spec.ts",
                    "file": "shell.journey.spec.ts",
                    "specs": [
                        {
                            "title": "opens the shell",
                            "tests": [{"status": "expected", "results": [{"status": "passed", "retry": 0}]}],
                        }
                    ],
                }
            ],
            root_dir=str(REPO_ROOT / "app" / "e2e"),
        )
        path = tmp_path / "results.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        assert fr.parse_playwright([path]) == []

    def test_nested_describe_titles_join_with_arrow(self, tmp_path: Path) -> None:
        report = _pw_report(
            [
                {
                    "title": "bundle-playbook.journey.spec.ts",
                    "file": "bundle-playbook.journey.spec.ts",
                    "specs": [],
                    "suites": [
                        {
                            "title": "bundle-playbook alignment @ 520px",
                            "specs": [
                                {
                                    "title": "skill hover stays aligned",
                                    "tests": [
                                        {
                                            "status": "flaky",
                                            "results": [
                                                {"status": "failed", "retry": 0},
                                                {"status": "passed", "retry": 1},
                                            ],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ],
            root_dir=str(REPO_ROOT / "app" / "e2e"),
        )
        path = tmp_path / "results.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        flaky = fr.parse_playwright([path])
        assert flaky[0]["title"] == "bundle-playbook alignment @ 520px > skill hover stays aligned"
        assert flaky[0]["file"] == "app/e2e/bundle-playbook.journey.spec.ts"

    def test_multiple_shard_inputs_are_combined(self, tmp_path: Path) -> None:
        root = str(REPO_ROOT / "app" / "e2e")
        one = tmp_path / "shard-1.json"
        two = tmp_path / "shard-2.json"
        one.write_text(
            json.dumps(
                _pw_report(
                    [
                        {
                            "title": "a.journey.spec.ts",
                            "file": "a.journey.spec.ts",
                            "specs": [
                                {
                                    "title": "t1",
                                    "tests": [
                                        {
                                            "status": "flaky",
                                            "results": [
                                                {"status": "failed", "retry": 0},
                                                {"status": "passed", "retry": 1},
                                            ],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                    root_dir=root,
                )
            ),
            encoding="utf-8",
        )
        two.write_text(
            json.dumps(
                _pw_report(
                    [
                        {
                            "title": "b.journey.spec.ts",
                            "file": "b.journey.spec.ts",
                            "specs": [
                                {
                                    "title": "t2",
                                    "tests": [
                                        {
                                            "status": "flaky",
                                            "results": [
                                                {"status": "failed", "retry": 0},
                                                {"status": "failed", "retry": 1},
                                                {"status": "passed", "retry": 2},
                                            ],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                    root_dir=root,
                )
            ),
            encoding="utf-8",
        )
        flaky = fr.parse_playwright([one, two])
        assert {(f["file"], f["title"], f["retries"]) for f in flaky} == {
            ("app/e2e/a.journey.spec.ts", "t1", 1),
            ("app/e2e/b.journey.spec.ts", "t2", 2),
        }


# ------------------------------------------------------------ vitest parsing


class TestParseVitest:
    def test_flaky_entries_pass_through(self, tmp_path: Path) -> None:
        path = tmp_path / "flaky.json"
        path.write_text(
            json.dumps(
                {
                    "runner": "vitest",
                    "flaky": [
                        {"file": "app/src/test/Shell.test.tsx", "title": "Shell > opens", "retries": 1},
                    ],
                }
            ),
            encoding="utf-8",
        )
        assert fr.parse_vitest([path]) == [
            {"runner": "vitest", "file": "app/src/test/Shell.test.tsx", "title": "Shell > opens", "retries": 1}
        ]

    def test_multiple_shard_inputs_are_combined(self, tmp_path: Path) -> None:
        one = tmp_path / "one.json"
        two = tmp_path / "two.json"
        one.write_text(json.dumps({"runner": "vitest", "flaky": [{"file": "a.test.ts", "title": "x", "retries": 1}]}))
        two.write_text(json.dumps({"runner": "vitest", "flaky": [{"file": "b.test.ts", "title": "y", "retries": 2}]}))
        flaky = fr.parse_vitest([one, two])
        assert {(f["file"], f["title"], f["retries"]) for f in flaky} == {("a.test.ts", "x", 1), ("b.test.ts", "y", 2)}

    def test_empty_flaky_list_is_empty(self, tmp_path: Path) -> None:
        path = tmp_path / "flaky.json"
        path.write_text(json.dumps({"runner": "vitest", "flaky": []}))
        assert fr.parse_vitest([path]) == []


# ------------------------------------------------------------ summary rendering


class TestRenderSummary:
    def test_ledgered_flake_produces_no_warning(self) -> None:
        entry = {"runner": "e2e", "file": "app/e2e/x.spec.ts", "title": "t", "retries": 1}
        entries_by_id = {fr.flaky_id(entry): {"id": fr.flaky_id(entry), "status": "open"}}
        summary, warnings, rows = fr.render_summary([entry], entries_by_id)
        assert warnings == []
        assert "None." in summary
        assert rows[0]["ledger_status"] == "open"

    def test_unledgered_flake_warns_and_lists_in_summary(self) -> None:
        entry = {"runner": "vitest", "file": "app/src/test/X.test.ts", "title": "t", "retries": 2}
        summary, warnings, rows = fr.render_summary([entry], {})
        fid = fr.flaky_id(entry)
        assert warnings == [f"::warning::Unledgered flaky test: {fid} (add it to testing/flaky.yaml)"]
        assert fid in summary
        assert rows[0]["ledger_status"] == "unledgered"

    def test_no_flakes_is_a_clean_summary_with_no_warnings(self) -> None:
        summary, warnings, rows = fr.render_summary([], {})
        assert warnings == []
        assert rows == []
        assert "None." in summary


# ------------------------------------------------------------ validate_ledger rules


def _base_entry(**overrides: Any) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "id": "e2e:app/e2e/x.journey.spec.ts::a title",
        "first_seen": "2026-09-01",
        "last_seen": "2026-09-01",
        "owner": "Ramtoi",
        "status": "open",
        "deadline": "2026-09-15",
    }
    entry.update(overrides)
    return entry


def _write_source(tmp_path: Path, rel_path: str, text: str) -> Path:
    path = tmp_path / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class TestValidateLedgerRules:
    def test_valid_ledger_has_no_problems(self, tmp_path: Path) -> None:
        _write_source(tmp_path, "app/e2e/x.journey.spec.ts", 'test("a title", async () => {});\n')
        ledger = {"schema_version": 1, "entries": [_base_entry()]}
        assert fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path) == []

    def test_wrong_schema_version_rejects(self, tmp_path: Path) -> None:
        ledger = {"schema_version": 2, "entries": []}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("schema_version" in p for p in problems)

    def test_duplicate_id_rejects(self, tmp_path: Path) -> None:
        _write_source(tmp_path, "app/e2e/x.journey.spec.ts", 'test("a title", async () => {});\n')
        ledger = {"schema_version": 1, "entries": [_base_entry(), _base_entry()]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("duplicate id" in p for p in problems)

    def test_unknown_status_rejects(self, tmp_path: Path) -> None:
        ledger = {"schema_version": 1, "entries": [_base_entry(status="bogus")]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("status" in p for p in problems)

    def test_last_seen_before_first_seen_rejects(self, tmp_path: Path) -> None:
        ledger = {"schema_version": 1, "entries": [_base_entry(last_seen="2026-08-01")]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("is before first_seen" in p for p in problems)

    def test_deadline_past_default_needs_extended_reason(self, tmp_path: Path) -> None:
        ledger = {
            "schema_version": 1,
            "default_deadline_days": 14,
            "entries": [_base_entry(deadline="2026-10-01")],
        }
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("extended_reason" in p for p in problems)

    def test_deadline_past_default_with_extended_reason_is_fine(self, tmp_path: Path) -> None:
        _write_source(tmp_path, "app/e2e/x.journey.spec.ts", 'test("a title", async () => {});\n')
        ledger = {
            "schema_version": 1,
            "default_deadline_days": 14,
            "entries": [_base_entry(deadline="2026-10-01", extended_reason="seeded when the ledger started")],
        }
        assert fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path) == []

    def test_open_entry_past_deadline_fails(self, tmp_path: Path) -> None:
        ledger = {"schema_version": 1, "entries": [_base_entry(deadline="2026-09-01")]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("past its deadline" in p for p in problems)

    def test_open_entry_before_deadline_is_fine(self, tmp_path: Path) -> None:
        _write_source(tmp_path, "app/e2e/x.journey.spec.ts", 'test("a title", async () => {});\n')
        ledger = {"schema_version": 1, "entries": [_base_entry(deadline="2026-09-14")]}
        assert fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path) == []

    def test_quarantined_needs_reason(self, tmp_path: Path) -> None:
        _write_source(
            tmp_path,
            "app/e2e/x.journey.spec.ts",
            "// flaky-quarantine: e2e:app/e2e/x.journey.spec.ts::a title\ntest.fixme(\"a title\", async () => {});\n",
        )
        entry = _base_entry(status="quarantined")
        entry.pop("reason", None)
        ledger = {"schema_version": 1, "entries": [entry]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("needs a reason" in p for p in problems)

    def test_quarantined_needs_matching_code_marker(self, tmp_path: Path) -> None:
        _write_source(tmp_path, "app/e2e/x.journey.spec.ts", 'test.fixme("a title", async () => {});\n')
        ledger = {"schema_version": 1, "entries": [_base_entry(status="quarantined", reason="known flaky")]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("no matching code marker" in p for p in problems)

    def test_quarantined_with_marker_and_reason_is_fine(self, tmp_path: Path) -> None:
        _write_source(
            tmp_path,
            "app/e2e/x.journey.spec.ts",
            "// flaky-quarantine: e2e:app/e2e/x.journey.spec.ts::a title\ntest.fixme(\"a title\", async () => {});\n",
        )
        ledger = {"schema_version": 1, "entries": [_base_entry(status="quarantined", reason="known flaky")]}
        assert fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path) == []

    def test_stray_marker_with_no_fixme_below_rejects(self, tmp_path: Path) -> None:
        _write_source(
            tmp_path,
            "app/e2e/x.journey.spec.ts",
            "// flaky-quarantine: e2e:app/e2e/x.journey.spec.ts::a title\ntest(\"a title\", async () => {});\n",
        )
        ledger = {"schema_version": 1, "entries": []}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("has no test.fixme(/it.skip(" in p for p in problems)

    def test_fixed_needs_fixed_on(self, tmp_path: Path) -> None:
        ledger = {"schema_version": 1, "entries": [_base_entry(status="fixed")]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("needs fixed_on" in p for p in problems)

    def test_fixed_with_fixed_on_is_fine_even_if_file_is_gone(self, tmp_path: Path) -> None:
        ledger = {"schema_version": 1, "entries": [_base_entry(status="fixed", fixed_on="2026-09-05")]}
        assert fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path) == []

    def test_open_title_missing_from_its_file_rejects(self, tmp_path: Path) -> None:
        _write_source(tmp_path, "app/e2e/x.journey.spec.ts", 'test("a different title", async () => {});\n')
        ledger = {"schema_version": 1, "entries": [_base_entry()]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("title not found" in p for p in problems)

    def test_open_file_missing_rejects(self, tmp_path: Path) -> None:
        ledger = {"schema_version": 1, "entries": [_base_entry()]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("does not exist" in p for p in problems)

    def test_unknown_key_rejects(self, tmp_path: Path) -> None:
        _write_source(tmp_path, "app/e2e/x.journey.spec.ts", 'test("a title", async () => {});\n')
        ledger = {"schema_version": 1, "entries": [_base_entry(unexpected="nope")]}
        problems = fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path)
        assert any("unknown key" in p for p in problems)

    def test_vitest_describe_title_matches_by_leaf(self, tmp_path: Path) -> None:
        _write_source(
            tmp_path,
            "app/src/test/X.test.tsx",
            'describe("X", () => { it("does the thing", () => {}); });\n',
        )
        entry = _base_entry(id="vitest:app/src/test/X.test.tsx::X > does the thing")
        ledger = {"schema_version": 1, "entries": [entry]}
        assert fr.validate_ledger(ledger, dt.date(2026, 9, 10), tmp_path) == []


# ------------------------------------------------------------ real tree (group 2)

LEDGER_PATH = REPO_ROOT / "testing" / "flaky.yaml"


@pytest.fixture(scope="module")
def real_ledger() -> Dict[str, Any]:
    return yaml.safe_load(LEDGER_PATH.read_text(encoding="utf-8"))


def test_real_ledger_file_exists_and_is_referenced_by_this_test() -> None:
    # tests/test_testing_skills.py:161's cross_readers check requires this
    # test's own text to contain the literal path "testing/flaky.yaml".
    assert LEDGER_PATH.exists()
    assert "testing/flaky.yaml" in Path(__file__).read_text(encoding="utf-8")


def test_real_ledger_schema_version(real_ledger: Dict[str, Any]) -> None:
    assert real_ledger["schema_version"] == fr.SCHEMA_VERSION


def test_real_ledger_ids_are_unique(real_ledger: Dict[str, Any]) -> None:
    ids = [entry["id"] for entry in real_ledger["entries"]]
    assert len(ids) == len(set(ids))


def test_real_ledger_dates_are_ordered(real_ledger: Dict[str, Any]) -> None:
    for entry in real_ledger["entries"]:
        first_seen = dt.date.fromisoformat(entry["first_seen"])
        last_seen = dt.date.fromisoformat(entry["last_seen"])
        assert last_seen >= first_seen, entry["id"]


def test_real_ledger_has_no_problems_today() -> None:
    problems = fr.validate_ledger(
        yaml.safe_load(LEDGER_PATH.read_text(encoding="utf-8")), dt.date.today(), REPO_ROOT
    )
    assert problems == [], problems


def test_real_ledger_quarantined_entries_have_reason_and_marker(real_ledger: Dict[str, Any]) -> None:
    markers = {mid for (_, _, mid) in fr.find_quarantine_markers(REPO_ROOT)}
    for entry in real_ledger["entries"]:
        if entry["status"] == "quarantined":
            assert entry.get("reason"), entry["id"]
            assert entry["id"] in markers, entry["id"]


def test_real_tree_has_no_stray_quarantine_markers() -> None:
    all_markers = fr.find_all_markers_raw(REPO_ROOT)
    paired = {mid for (_, _, mid) in fr.find_quarantine_markers(REPO_ROOT)}
    stray = [m for m in all_markers if m[2] not in paired]
    assert stray == [], stray


def test_real_ledger_open_and_quarantined_titles_exist_in_their_files(real_ledger: Dict[str, Any]) -> None:
    for entry in real_ledger["entries"]:
        if entry["status"] not in ("open", "quarantined"):
            continue
        runner, _, rest = entry["id"].partition(":")
        file, _, title = rest.partition("::")
        file_path = REPO_ROOT / file
        assert file_path.is_file(), entry["id"]
        assert fr._title_exists(file_path, title, runner), entry["id"]
