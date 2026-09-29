"""Tests for `testing/scripts/verify_breaks.py` (PLAN.md section 6, unit A3).

Two groups, per the unit brief:

1. Unit tests of the pure parts (manifest load/validate, patch apply/revert
   on a string, title resolution, JSON result parsing) with `tmp_path`, plus
   orchestration-ordering tests (apply, run, revert, sandbox cleanup) driven
   by a fake `Runner` — no real subprocess, no `app/node_modules` needed.
2. The CI rule from PLAN.md section 7: every `docs/changes/
   DESIGN-journey-consolidation/breaks/*.yaml` manifest validates and resolves against the current tree,
   and every journey title a commit range removed from `app/e2e/*.spec.ts`
   has a manifest row.
"""

from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOL = REPO_ROOT / "testing" / "scripts" / "verify_breaks.py"

_spec = importlib.util.spec_from_file_location("verify_breaks_tool", TOOL)
assert _spec and _spec.loader
vb = importlib.util.module_from_spec(_spec)
# `verify_breaks.py`'s dataclasses need their defining module registered in
# `sys.modules` before `exec_module` (dataclasses resolves annotations
# through `sys.modules[cls.__module__]`); a spec-loaded module skips that
# unless we do it ourselves.
sys.modules[_spec.name] = vb
_spec.loader.exec_module(vb)


# ------------------------------------------------------------ manifest fixtures


def _row(**overrides: Any) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "removed": {"file": "app/e2e/shell.journey.spec.ts", "title": "opens the shell"},
        "remaining": [{"file": "app/src/test/Shell.test.tsx", "title": "opens the shell"}],
        "patch": [
            {
                "file": "app/src/components/Shell.tsx",
                "find": "const OPEN = true",
                "replace": "const OPEN = false",
            }
        ],
        "reason": "the shell no longer opens",
    }
    row.update(overrides)
    return row


def _manifest(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"area": "shell", "base": "34ff20f6", "rows": rows}


def _write_manifest(tmp_path: Path, data: Dict[str, Any]) -> Path:
    import yaml

    path = tmp_path / "manifest.yaml"
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


# ------------------------------------------------------------------- group 1


class TestManifestLoadAndValidate:
    def test_valid_manifest_loads_and_validates(self, tmp_path: Path) -> None:
        path = _write_manifest(tmp_path, _manifest([_row()]))
        data = vb.load_manifest(path)
        assert vb.validate_manifest(data) == []

    def test_missing_top_level_field_rejects(self) -> None:
        data = {"area": "shell", "rows": [_row()]}
        problems = vb.validate_manifest(data)
        assert any("missing field 'base'" in p for p in problems)

    def test_rows_must_be_non_empty(self) -> None:
        problems = vb.validate_manifest(_manifest([]))
        assert any("rows" in p for p in problems)

    @pytest.mark.parametrize("missing_key", ["removed", "remaining", "patch", "reason"])
    def test_row_missing_a_required_key_rejects_with_row_index(self, missing_key: str) -> None:
        row = _row()
        del row[missing_key]
        problems = vb.validate_manifest(_manifest([row]))
        assert any(p.startswith("row 0:") and missing_key in p for p in problems), problems

    def test_remaining_must_be_non_empty_list(self) -> None:
        problems = vb.validate_manifest(_manifest([_row(remaining=[])]))
        assert any(p.startswith("row 0:") and "remaining" in p for p in problems)

    def test_patch_must_be_non_empty_list(self) -> None:
        problems = vb.validate_manifest(_manifest([_row(patch=[])]))
        assert any(p.startswith("row 0:") and "patch" in p for p in problems)

    def test_patch_file_outside_app_src_rejects(self) -> None:
        row = _row(patch=[{"file": "scripts/foo.py", "find": "a", "replace": "b"}])
        problems = vb.validate_manifest(_manifest([row]))
        assert any(p.startswith("row 0:") and "app/src/" in p for p in problems)

    def test_patch_file_under_app_src_test_rejects(self) -> None:
        row = _row(patch=[{"file": "app/src/test/Shell.test.tsx", "find": "a", "replace": "b"}])
        problems = vb.validate_manifest(_manifest([row]))
        assert any(p.startswith("row 0:") for p in problems)

    def test_patch_file_under_app_e2e_rejects(self) -> None:
        row = _row(patch=[{"file": "app/e2e/shell.journey.spec.ts", "find": "a", "replace": "b"}])
        problems = vb.validate_manifest(_manifest([row]))
        assert any(p.startswith("row 0:") for p in problems)

    def test_find_equal_to_replace_rejects(self) -> None:
        row = _row(patch=[{"file": "app/src/components/Shell.tsx", "find": "same", "replace": "same"}])
        problems = vb.validate_manifest(_manifest([row]))
        assert any("find and replace must differ" in p for p in problems)

    def test_over_budget_patch_rejects(self) -> None:
        row = _row(
            patch=[
                {
                    "file": "app/src/components/Shell.tsx",
                    "find": "a\nb\nc\nd\ne",
                    "replace": "v\nw\nx\ny\nz",
                },
                {
                    "file": "app/src/components/Shell.tsx",
                    "find": "f",
                    "replace": "g",
                },
            ]
        )
        problems = vb.validate_manifest(_manifest([row]))
        assert any("5-line budget" in p for p in problems)

    def test_exactly_five_lines_is_within_budget(self) -> None:
        row = _row(
            patch=[
                {
                    "file": "app/src/components/Shell.tsx",
                    "find": "a\nb\nc\nd",
                    "replace": "w\nx\ny\nz",
                },
                {
                    "file": "app/src/components/Shell.tsx",
                    "find": "e",
                    "replace": "f",
                },
            ]
        )
        problems = vb.validate_manifest(_manifest([row]))
        assert not any("5-line budget" in p for p in problems)

    def test_second_row_defect_is_reported_with_row_index_1(self) -> None:
        good = _row()
        bad = _row()
        del bad["reason"]
        problems = vb.validate_manifest(_manifest([good, bad]))
        assert not any(p.startswith("row 0:") for p in problems)
        assert any(p.startswith("row 1:") and "reason" in p for p in problems)


class TestDroppedRowShape:
    """A row may replace `remaining`/`patch` with `dropped_reason`: the
    behavior cannot be tested on the preview build (plan section 11 — e.g.
    back-button's viewport journey needs dev-server-only module URLs).
    Exactly one of the two shapes is required."""

    def _dropped_row(self, **overrides: Any) -> Dict[str, Any]:
        row: Dict[str, Any] = {
            "removed": {
                "file": "app/e2e/back-button.journey.spec.ts",
                "title": "a long destination stays readable inside a short viewport",
            },
            "dropped_reason": "needs dev-server-only module URLs; not testable on the preview build",
            "reason": "no build this check can run against covers that behavior",
        }
        row.update(overrides)
        return row

    def test_dropped_shape_is_accepted(self) -> None:
        problems = vb.validate_manifest(_manifest([self._dropped_row()]))
        assert problems == []

    def test_row_with_both_shapes_is_rejected(self) -> None:
        both = self._dropped_row(
            remaining=[{"file": "app/src/test/Foo.test.tsx", "title": "t"}],
            patch=[{"file": "app/src/components/Foo.tsx", "find": "a", "replace": "b"}],
        )
        problems = vb.validate_manifest(_manifest([both]))
        assert any(
            p.startswith("row 0:") and "dropped_reason" in p and "remaining" in p for p in problems
        ), problems

    def test_row_with_neither_shape_is_rejected(self) -> None:
        neither = self._dropped_row()
        del neither["dropped_reason"]
        problems = vb.validate_manifest(_manifest([neither]))
        assert any(p.startswith("row 0:") and "dropped_reason" in p for p in problems), problems

    def test_empty_dropped_reason_is_rejected(self) -> None:
        row = self._dropped_row(dropped_reason="   ")
        problems = vb.validate_manifest(_manifest([row]))
        assert any(p.startswith("row 0:") and "dropped_reason" in p and "non-empty" in p for p in problems), problems

    def test_check_manifest_still_requires_removed_title_absent_at_head(self, tmp_path: Path) -> None:
        e2e_dir = tmp_path / "app" / "e2e"
        e2e_dir.mkdir(parents=True)
        spec = e2e_dir / "back-button.journey.spec.ts"
        row = self._dropped_row()
        spec.write_text(
            f'test("{row["removed"]["title"]}", async ({{ page }}) => {{}});\n', encoding="utf-8"
        )
        problems, _warnings = vb.check_manifest(tmp_path, _manifest([row]))
        assert any("removed title still present" in p for p in problems)

        spec.write_text("// removed\n", encoding="utf-8")
        problems, _warnings = vb.check_manifest(tmp_path, _manifest([row]))
        assert problems == []

    def test_run_all_reports_a_dropped_row_as_passed_without_running_anything(self, tmp_path: Path) -> None:
        import yaml

        manifest = tmp_path / "shell.yaml"
        row = self._dropped_row()
        manifest.write_text(yaml.safe_dump(_manifest([row]), sort_keys=False), encoding="utf-8")

        def fail_if_called(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError("a dropped row must not run any test or touch a sandbox")

        argv = [str(manifest), "--repo", str(tmp_path), "--sandbox-root", str(tmp_path / "sb")]
        args = vb.build_parser().parse_args(argv)
        original_run_row_direction = vb.run_row_direction
        vb.run_row_direction = fail_if_called  # type: ignore[assignment]
        try:
            assert vb.run_all(args, runner=FakeRunner()) == 0
        finally:
            vb.run_row_direction = original_run_row_direction  # type: ignore[assignment]


class TestCheckManifestTemplateResolution:
    """check_manifest must not use template matching to decide a removed
    title is "still present" (a loose match would wrongly reject a
    legitimate dropped-width row), but a `remaining` title that only
    resolves through a template is accepted with a `template-resolved`
    warning, since its actual value cannot be checked statically."""

    TEMPLATE_FILE = "app/e2e/widths.journey.spec.ts"
    TEMPLATE_SOURCE = "for (const w of [1440, 1920]) { test(`opens at ${w}px`, async () => {}); }\n"

    def _write_template_spec(self, tmp_path: Path) -> None:
        spec_dir = tmp_path / "app" / "e2e"
        spec_dir.mkdir(parents=True)
        (spec_dir / "widths.journey.spec.ts").write_text(self.TEMPLATE_SOURCE, encoding="utf-8")

    def test_a_dropped_width_row_passes_check_manifest(self, tmp_path: Path) -> None:
        """768 is not in the loop's width list, but the template call itself
        is still there — a literal-only absence check correctly treats
        "opens at 768px" as absent (it was never a literal title), instead
        of a template match wrongly calling it "still present"."""
        self._write_template_spec(tmp_path)
        row = _row(
            removed={"file": self.TEMPLATE_FILE, "title": "opens at 768px"},
            dropped_reason="768px was dropped from the width loop; not covered by any remaining test",
        )
        del row["remaining"]
        del row["patch"]
        problems, warnings = vb.check_manifest(tmp_path, _manifest([row]))
        assert problems == []

    def test_a_remaining_title_for_a_missing_width_is_template_resolved(self, tmp_path: Path) -> None:
        """1920 *is* in the loop, but check_manifest cannot tell that
        statically from the template alone — it must accept the title
        (no problem) while flagging it as template-resolved so a human (or
        the run step) knows its value was not checked here."""
        self._write_template_spec(tmp_path)
        row = _row(remaining=[{"file": self.TEMPLATE_FILE, "title": "opens at 1920px"}])
        problems, warnings = vb.check_manifest(tmp_path, _manifest([row]))
        assert problems == []
        assert any("template-resolved" in w and "opens at 1920px" in w for w in warnings), warnings

    def test_a_remaining_title_that_fits_no_template_is_still_a_problem(self, tmp_path: Path) -> None:
        self._write_template_spec(tmp_path)
        row = _row(remaining=[{"file": self.TEMPLATE_FILE, "title": "closes at 1920px"}])
        problems, warnings = vb.check_manifest(tmp_path, _manifest([row]))
        assert any("remaining title not found" in p for p in problems)
        assert warnings == []


class TestPatchLineBudget:
    def test_three_by_three_counts_as_three_not_six(self) -> None:
        entries = [{"find": "a\nb\nc", "replace": "x\ny\nz"}]
        assert vb.patch_line_budget(entries) == 3

    def test_multiple_entries_sum(self) -> None:
        entries = [{"find": "a", "replace": "b"}, {"find": "c\nd", "replace": "e\nf"}]
        assert vb.patch_line_budget(entries) == 1 + 2

    def test_asymmetric_entry_takes_the_larger_side(self) -> None:
        entries = [{"find": "a", "replace": "x\ny"}]
        assert vb.patch_line_budget(entries) == 2


class TestApplyAndRevertPatch:
    def test_apply_patch_replaces_the_single_match(self) -> None:
        text = "line one\nOPEN = true\nline three\n"
        patched = vb.apply_patch(text, "OPEN = true", "OPEN = false")
        assert patched == "line one\nOPEN = false\nline three\n"

    def test_apply_patch_raises_on_zero_matches(self) -> None:
        with pytest.raises(vb.PatchError):
            vb.apply_patch("no match here", "MISSING", "X")

    def test_apply_patch_raises_on_multiple_matches(self) -> None:
        with pytest.raises(vb.PatchError):
            vb.apply_patch("dup dup", "dup", "single")

    def test_revert_patch_restores_the_original_text(self) -> None:
        original = "const OPEN = true\nrest of file\n"
        patched = vb.apply_patch(original, "const OPEN = true", "const OPEN = false")
        reverted = vb.revert_patch(patched, "const OPEN = true", "const OPEN = false")
        assert reverted == original

    def test_apply_row_patch_is_all_or_nothing_across_files(self, tmp_path: Path) -> None:
        """Two patch entries touching two different files: the first entry
        matches and would apply cleanly, but the second does not match
        anything. `apply_row_patch` must not have written the first file's
        change to disk — the whole row fails atomically, or a `PatchError`
        from entry 2 would otherwise leave entry 1's file silently patched
        and never reverted (the review's original finding 3)."""
        (tmp_path / "app" / "src" / "components").mkdir(parents=True)
        first = tmp_path / "app" / "src" / "components" / "First.tsx"
        second = tmp_path / "app" / "src" / "components" / "Second.tsx"
        first_original = "const FIRST = true\n"
        second_original = "const SECOND = true\n"
        first.write_bytes(first_original.encode("utf-8"))
        second.write_bytes(second_original.encode("utf-8"))

        patch = [
            {"file": "app/src/components/First.tsx", "find": "const FIRST = true", "replace": "const FIRST = false"},
            {"file": "app/src/components/Second.tsx", "find": "NOT PRESENT AT ALL", "replace": "x"},
        ]
        with pytest.raises(vb.PatchError):
            vb.apply_row_patch(tmp_path, patch)

        assert first.read_bytes() == first_original.encode("utf-8")
        assert second.read_bytes() == second_original.encode("utf-8")


class TestTitleResolution:
    def test_finds_double_quoted_test_title(self) -> None:
        text = 'test("a long destination stays readable", async ({ page }) => {})'
        assert vb.resolve_title(text, "a long destination stays readable")

    def test_finds_template_literal_test_title_without_interpolation(self) -> None:
        text = "test(`a fixed literal title`, async ({ page }) => {})"
        assert vb.resolve_title(text, "a fixed literal title")

    def test_finds_it_title(self) -> None:
        text = 'it("returns keyboard focus", async () => {})'
        assert vb.resolve_title(text, "returns keyboard focus")

    def test_does_not_find_missing_title(self) -> None:
        text = 'test("something else", async () => {})'
        assert not vb.resolve_title(text, "not present")

    def test_it_each_table_is_out_of_scope(self) -> None:
        text = (
            'it.each(["payload", "rejection"])("retries a failed connection (%s)", '
            "async (failureKind) => {})"
        )
        assert not vb.resolve_title(text, "retries a failed connection (%s)")
        assert not vb.resolve_title(text, "retries a failed connection (payload)")

    def test_extract_titles_skips_an_interpolated_template_literal(self) -> None:
        """`extract_titles` (the literal-only view) cannot resolve an
        interpolated template to one string; `resolve_title` handles that
        case separately, below."""
        text = "test(`opens at ${width}px`, async ({ page }) => {})"
        assert "opens at 1440px" not in vb.extract_titles(text)

    def test_resolve_title_matches_a_literal_that_fits_the_template(self) -> None:
        """A manifest row names the *resolved* title Playwright/vitest
        actually runs at (e.g. from a `widths.forEach` loop), not the
        unresolved source template — `resolve_title` must accept it with
        each `${...}` placeholder treated as `.+`."""
        text = "test(`opens at ${width}px`, async ({ page }) => {})"
        assert vb.resolve_title(text, "opens at 1440px")
        assert vb.resolve_title(text, "opens at 520px")

    def test_resolve_title_rejects_a_literal_that_does_not_fit_the_template(self) -> None:
        """The literal text outside the placeholder must still match —
        `.+` only stands in for `${width}`, not for the whole title."""
        text = "test(`opens at ${width}px`, async ({ page }) => {})"
        assert not vb.resolve_title(text, "closes at 1440px")
        assert not vb.resolve_title(text, "opens at 1440em")

    def test_does_not_match_wait_or_dot_each(self) -> None:
        text = 'await wait("not a title call"); test.each([1])("templated %s", () => {})'
        assert vb.extract_titles(text) == set()


class TestTemplateTitlesAndWidthArrays:
    """The primitives the CI diff rule (group 2) uses to catch a removed
    templated title (finding 4a) and to raise a soft signal for a shrinking
    width table it cannot see mechanically (finding 4c)."""

    def test_extract_template_titles_keeps_the_raw_placeholder(self) -> None:
        text = "test(`opens at ${width}px`, async ({ page }) => {})"
        assert vb.extract_template_titles(text) == {"opens at ${width}px"}

    def test_extract_template_titles_ignores_a_plain_literal(self) -> None:
        text = 'test("a plain title", async () => {})'
        assert vb.extract_template_titles(text) == set()

    def test_template_title_matches_row_title_positive_and_negative(self) -> None:
        template = "opens at ${width}px"
        assert vb.template_title_matches_row_title(template, "opens at 1440px")
        assert not vb.template_title_matches_row_title(template, "closes at 1440px")

    def test_detect_shrinking_width_arrays_reports_a_warning(self) -> None:
        base_text = "const WIDTHS = [1440, 768, 520];"
        head_text = "const WIDTHS = [1440, 520];"
        warnings = vb.detect_shrinking_width_arrays(base_text, head_text)
        assert warnings
        assert "1440, 768, 520" in warnings[0] or "[1440, 768, 520]" in warnings[0]

    def test_detect_shrinking_width_arrays_is_silent_when_unchanged(self) -> None:
        text = "const WIDTHS = [1440, 768, 520];"
        assert vb.detect_shrinking_width_arrays(text, text) == []

    def test_detect_shrinking_width_arrays_is_silent_when_no_subset_relationship(self) -> None:
        """A different, unrelated array (no head array is a subset of the
        base one) is not a "shrink" — it is a soft signal only for the
        narrowing case the review asked about, not every array edit."""
        base_text = "const WIDTHS = [1440, 768];"
        head_text = "const OTHER = [12, 24];"
        assert vb.detect_shrinking_width_arrays(base_text, head_text) == []


class TestJsonResultParsing:
    def test_vitest_zero_tests(self) -> None:
        summary = vb.parse_vitest_json({"testResults": []}, "some title")
        assert summary.total == 0
        assert summary.all_failed is False
        assert summary.none_failed is False

    def test_vitest_all_failed(self) -> None:
        data = {
            "testResults": [
                {
                    "assertionResults": [
                        {"fullName": "Shell > opens the shell", "status": "failed"},
                    ]
                }
            ]
        }
        summary = vb.parse_vitest_json(data, "opens the shell")
        assert summary.total == 1
        assert summary.all_failed

    def test_vitest_one_pass(self) -> None:
        data = {
            "testResults": [
                {
                    "assertionResults": [
                        {"fullName": "Shell > opens the shell", "status": "passed"},
                    ]
                }
            ]
        }
        summary = vb.parse_vitest_json(data, "opens the shell")
        assert summary.total == 1
        assert summary.none_failed
        assert not summary.all_failed

    def test_vitest_substring_match_requires_full_name_to_end_with_title(self) -> None:
        data = {
            "testResults": [
                {
                    "assertionResults": [
                        {"fullName": "Shell > opens the shell wide", "status": "passed"},
                        {"fullName": "Shell > opens the shell", "status": "failed"},
                    ]
                }
            ]
        }
        summary = vb.parse_vitest_json(data, "opens the shell")
        assert summary.total == 1
        assert summary.items[0]["status"] == "failed"

    def test_vitest_a_different_test_that_merely_ends_with_the_same_words_does_not_count(self) -> None:
        """"reopens the shell" ends with "opens the shell" as a raw string
        suffix, but not past a real word boundary — a bare `endswith(title)`
        would wrongly count it as the requested test."""
        data = {
            "testResults": [
                {
                    "assertionResults": [
                        {"fullName": "Shell > reopens the shell", "status": "passed"},
                    ]
                }
            ]
        }
        summary = vb.parse_vitest_json(data, "opens the shell")
        assert summary.total == 0

    def test_vitest_grep_pattern_also_rejects_the_reopens_case(self) -> None:
        pattern = vb.vitest_grep_pattern("opens the shell")
        assert not re.search(pattern, "Shell > reopens the shell")
        assert re.search(pattern, "Shell > opens the shell")

    def test_playwright_zero_tests(self) -> None:
        summary = vb.parse_playwright_json({"suites": []}, "a journey")
        assert summary.total == 0

    def test_playwright_all_failed(self) -> None:
        data = {
            "suites": [
                {
                    "specs": [{"title": "a journey", "tests": [{"results": [{"status": "failed"}]}]}],
                    "suites": [],
                }
            ]
        }
        summary = vb.parse_playwright_json(data, "a journey")
        assert summary.total == 1
        assert summary.all_failed

    def test_playwright_one_pass_nested_suite(self) -> None:
        data = {
            "suites": [
                {
                    "specs": [],
                    "suites": [
                        {
                            "specs": [
                                {"title": "a journey", "tests": [{"results": [{"status": "passed"}]}]}
                            ],
                            "suites": [],
                        }
                    ],
                }
            ]
        }
        summary = vb.parse_playwright_json(data, "a journey")
        assert summary.total == 1
        assert summary.none_failed

    def test_playwright_filters_out_specs_whose_title_does_not_exactly_match(self) -> None:
        """A coincidental `-g` match (the anchored pattern matched the joined
        project/file/describe/title string for a *different* spec) must not
        be counted — only a spec whose own title equals the requested title
        exactly."""
        data = {
            "suites": [
                {
                    "specs": [
                        {"title": "opens the shell wide", "tests": [{"results": [{"status": "failed"}]}]},
                    ],
                    "suites": [],
                }
            ]
        }
        summary = vb.parse_playwright_json(data, "the shell wide")
        assert summary.total == 0


# --------------------------------------------------------- orchestration (fakes)


class FakeCompleted:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeRunner:
    """Records every call; `run` is answered by `handlers`, keyed by the
    command's first token (`git`, `cp`, `npx`)."""

    def __init__(self, handlers: Optional[Dict[str, Any]] = None) -> None:
        self.calls: List[str] = []
        self.handlers = handlers or {}

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Optional[Path] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> FakeCompleted:
        self.calls.append(" ".join(argv))
        handler = self.handlers.get(argv[0])
        if handler is not None:
            return handler(argv, cwd, env)
        return FakeCompleted(0)

    def popen(self, argv: Sequence[str], *, cwd: Optional[Path] = None, env: Optional[Dict[str, str]] = None):
        self.calls.append(" ".join(argv))
        raise AssertionError("popen was not expected in this test")


class TestRunRowDirectionOrdering:
    def _tree(self, tmp_path: Path) -> Path:
        tree = tmp_path / "tree"
        (tree / "app" / "src" / "components").mkdir(parents=True)
        (tree / "app" / "src" / "test").mkdir(parents=True)
        (tree / "app" / "src" / "components" / "Shell.tsx").write_text(
            "const OPEN = true\n", encoding="utf-8"
        )
        (tree / "app" / "src" / "test" / "Shell.test.tsx").write_text(
            'it("opens the shell", () => {})\n', encoding="utf-8"
        )
        return tree

    def test_apply_then_run_then_revert(self, tmp_path: Path) -> None:
        tree = self._tree(tmp_path)
        row = _row()
        order: List[str] = []
        original_apply = vb.apply_row_patch
        original_revert = vb.revert_row_patch

        def tracking_apply(t: Path, patch: Any) -> Dict[str, str]:
            order.append("apply")
            return original_apply(t, patch)

        def tracking_revert(t: Path, originals: Dict[str, str]) -> None:
            order.append("revert")
            original_revert(t, originals)

        def fake_run_single_test(runner: Any, cwd: Any, env: Any, file: str, title: str, log_dir: Path) -> Any:
            order.append("run")
            target = tree / "app" / "src" / "components" / "Shell.tsx"
            assert target.read_text(encoding="utf-8") == "const OPEN = false\n"
            summary = vb.RunSummary(total=1, failed=1, items=[{"status": "failed"}])
            return vb.TestOutcome(file, title, "vitest", summary, log_dir / "log.json")

        monkeypatch_targets = {
            "apply_row_patch": (vb.apply_row_patch, tracking_apply),
            "revert_row_patch": (vb.revert_row_patch, tracking_revert),
            "run_single_test": (vb.run_single_test, fake_run_single_test),
        }
        for name, (_, fake) in monkeypatch_targets.items():
            setattr(vb, name, fake)
        try:
            outcomes = vb.run_row_direction(FakeRunner(), tree, {}, row, "head", tmp_path / "logs", control=False)
        finally:
            for name, (original, _) in monkeypatch_targets.items():
                setattr(vb, name, original)

        assert order == ["apply", "run", "revert"]
        assert len(outcomes) == 1
        assert outcomes[0].patched.failed_as_expected
        assert outcomes[0].control is None
        assert outcomes[0].control_ok  # vacuously true: no control was requested
        assert outcomes[0].ok
        # The revert put the file back exactly as it started.
        assert (
            tree / "app" / "src" / "components" / "Shell.tsx"
        ).read_text(encoding="utf-8") == "const OPEN = true\n"

    def test_revert_runs_even_when_the_test_raises(self, tmp_path: Path) -> None:
        tree = self._tree(tmp_path)
        row = _row()
        order: List[str] = []
        original_revert = vb.revert_row_patch
        original_run_single_test = vb.run_single_test

        def tracking_revert(t: Path, originals: Dict[str, str]) -> None:
            order.append("revert")
            original_revert(t, originals)

        def raising_run_single_test(*args: Any, **kwargs: Any) -> Any:
            order.append("run")
            raise RuntimeError("boom")

        vb.revert_row_patch = tracking_revert  # type: ignore[assignment]
        vb.run_single_test = raising_run_single_test  # type: ignore[assignment]
        try:
            with pytest.raises(RuntimeError):
                vb.run_row_direction(FakeRunner(), tree, {}, row, "head", tmp_path / "logs", control=False)
        finally:
            vb.revert_row_patch = original_revert  # type: ignore[assignment]
            vb.run_single_test = original_run_single_test  # type: ignore[assignment]

        assert order == ["run", "revert"]
        assert (
            tree / "app" / "src" / "components" / "Shell.tsx"
        ).read_text(encoding="utf-8") == "const OPEN = true\n"

    def test_control_runs_before_apply_then_run_then_revert(self, tmp_path: Path) -> None:
        """Default `control=True`: the unpatched control run happens before
        the patch is even applied, proving the target test passes on its
        own before the patch is asked to break it."""
        tree = self._tree(tmp_path)
        row = _row()
        order: List[str] = []
        original_apply = vb.apply_row_patch
        original_revert = vb.revert_row_patch
        original_run_single_test = vb.run_single_test
        target = tree / "app" / "src" / "components" / "Shell.tsx"
        calls = {"n": 0}

        def tracking_apply(t: Path, patch: Any) -> Dict[str, str]:
            order.append("apply")
            return original_apply(t, patch)

        def tracking_revert(t: Path, originals: Dict[str, str]) -> None:
            order.append("revert")
            original_revert(t, originals)

        def fake_run_single_test(runner: Any, cwd: Any, env: Any, file: str, title: str, log_dir: Path) -> Any:
            calls["n"] += 1
            if calls["n"] == 1:
                order.append("control")
                assert target.read_text(encoding="utf-8") == "const OPEN = true\n"
                summary = vb.RunSummary(total=1, failed=0, items=[{"status": "passed"}])
            else:
                order.append("run")
                assert target.read_text(encoding="utf-8") == "const OPEN = false\n"
                summary = vb.RunSummary(total=1, failed=1, items=[{"status": "failed"}])
            return vb.TestOutcome(file, title, "vitest", summary, log_dir / "log.json")

        vb.apply_row_patch = tracking_apply  # type: ignore[assignment]
        vb.revert_row_patch = tracking_revert  # type: ignore[assignment]
        vb.run_single_test = fake_run_single_test  # type: ignore[assignment]
        try:
            outcomes = vb.run_row_direction(FakeRunner(), tree, {}, row, "head", tmp_path / "logs", control=True)
        finally:
            vb.apply_row_patch = original_apply  # type: ignore[assignment]
            vb.revert_row_patch = original_revert  # type: ignore[assignment]
            vb.run_single_test = original_run_single_test  # type: ignore[assignment]

        assert order == ["control", "apply", "run", "revert"]
        assert len(outcomes) == 1
        assert outcomes[0].control_ok
        assert outcomes[0].patched.failed_as_expected
        assert outcomes[0].ok

    def test_a_failing_control_marks_the_row_not_ok_even_though_the_patch_worked(self, tmp_path: Path) -> None:
        """A control run that does not pass cleanly (already failing, or 0
        tests found) means the patched failure proves nothing — `ok` must be
        False even though the patched run failed as expected."""
        tree = self._tree(tmp_path)
        row = _row()
        calls = {"n": 0}
        original_run_single_test = vb.run_single_test

        def fake_run_single_test(runner: Any, cwd: Any, env: Any, file: str, title: str, log_dir: Path) -> Any:
            calls["n"] += 1
            if calls["n"] == 1:
                # The control run itself found no tests: a broken sandbox.
                summary = vb.RunSummary(total=0, failed=0, items=[])
                return vb.TestOutcome(file, title, "vitest", summary, log_dir / "log.json", error="no tests found")
            summary = vb.RunSummary(total=1, failed=1, items=[{"status": "failed"}])
            return vb.TestOutcome(file, title, "vitest", summary, log_dir / "log.json")

        vb.run_single_test = fake_run_single_test  # type: ignore[assignment]
        try:
            outcomes = vb.run_row_direction(FakeRunner(), tree, {}, row, "head", tmp_path / "logs", control=True)
        finally:
            vb.run_single_test = original_run_single_test  # type: ignore[assignment]

        assert not outcomes[0].control_ok
        assert outcomes[0].patched.failed_as_expected
        assert not outcomes[0].ok

    def test_no_control_flag_skips_the_control_run_entirely(self, tmp_path: Path) -> None:
        tree = self._tree(tmp_path)
        row = _row()
        call_count = {"n": 0}
        original_run_single_test = vb.run_single_test

        def counting_run_single_test(runner: Any, cwd: Any, env: Any, file: str, title: str, log_dir: Path) -> Any:
            call_count["n"] += 1
            summary = vb.RunSummary(total=1, failed=1, items=[{"status": "failed"}])
            return vb.TestOutcome(file, title, "vitest", summary, log_dir / "log.json")

        vb.run_single_test = counting_run_single_test  # type: ignore[assignment]
        try:
            outcomes = vb.run_row_direction(FakeRunner(), tree, {}, row, "head", tmp_path / "logs", control=False)
        finally:
            vb.run_single_test = original_run_single_test  # type: ignore[assignment]

        assert call_count["n"] == 1  # only the patched run, no control run
        assert outcomes[0].control is None


class TestSandboxOrdering:
    def test_create_sandboxes_adds_base_then_head_with_no_node_modules(self, tmp_path: Path) -> None:
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        root = tmp_path / "sandbox-root"
        runner = FakeRunner()
        sandboxes = vb.create_sandboxes(runner, repo_root, root, "deadbeef", "cafef00d")
        assert sandboxes.base_dir == root / "base"
        assert sandboxes.head_dir == root / "head"
        worktree_calls = [c for c in runner.calls if c.startswith("git worktree add")]
        assert worktree_calls == [
            f"git worktree add --detach {root / 'base'} deadbeef",
            f"git worktree add --detach {root / 'head'} cafef00d",
        ]
        # No app/node_modules under repo_root, so no `cp -al` call.
        assert not any(c.startswith("cp ") for c in runner.calls)

    def test_create_sandboxes_hardlinks_node_modules_with_cp_al(self, tmp_path: Path) -> None:
        repo_root = tmp_path / "repo"
        (repo_root / "app" / "node_modules").mkdir(parents=True)
        root = tmp_path / "sandbox-root"
        runner = FakeRunner()
        vb.create_sandboxes(runner, repo_root, root, "deadbeef", "cafef00d")
        cp_calls = [c for c in runner.calls if c.startswith("cp ")]
        assert len(cp_calls) == 2
        for call in cp_calls:
            assert call.startswith("cp -al ")

    def test_remove_sandboxes_removes_both_worktrees_unless_kept(self, tmp_path: Path) -> None:
        repo_root = tmp_path / "repo"
        root = tmp_path / "sandbox-root"
        sandboxes = vb.Sandboxes(root=root, base_dir=root / "base", head_dir=root / "head")

        runner = FakeRunner()
        vb.remove_sandboxes(runner, repo_root, sandboxes, keep=False)
        assert runner.calls == [
            f"git worktree remove --force {root / 'base'}",
            f"git worktree remove --force {root / 'head'}",
        ]

        kept_runner = FakeRunner()
        vb.remove_sandboxes(kept_runner, repo_root, sandboxes, keep=True)
        assert kept_runner.calls == []

    def test_create_then_remove_ordering_via_a_full_cycle(self, tmp_path: Path) -> None:
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        root = tmp_path / "sandbox-root"
        runner = FakeRunner()
        sandboxes = vb.create_sandboxes(runner, repo_root, root, "deadbeef", "cafef00d")
        vb.remove_sandboxes(runner, repo_root, sandboxes, keep=False)
        adds = [i for i, c in enumerate(runner.calls) if c.startswith("git worktree add")]
        removes = [i for i, c in enumerate(runner.calls) if c.startswith("git worktree remove")]
        assert adds and removes
        assert max(adds) < min(removes), "every add must precede every remove"


    def test_create_sandboxes_removes_the_base_tree_when_head_add_fails(self, tmp_path: Path) -> None:
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        root = tmp_path / "sandbox-root"

        def git(argv: Sequence[str], cwd: Any, env: Any) -> FakeCompleted:
            if argv[1:3] == ["worktree", "add"] and argv[-1] == "cafef00d":
                return FakeCompleted(128, stderr="fatal: boom")
            return FakeCompleted(0)

        runner = FakeRunner({"git": git})
        with pytest.raises(vb.BreakCheckError):
            vb.create_sandboxes(runner, repo_root, root, "deadbeef", "cafef00d")
        assert f"git worktree remove --force {root / 'base'}" in runner.calls
        add_base = runner.calls.index(f"git worktree add --detach {root / 'base'} deadbeef")
        remove_base = runner.calls.index(f"git worktree remove --force {root / 'base'}")
        assert add_base < remove_base

    def test_create_sandboxes_removes_both_trees_when_cp_fails(self, tmp_path: Path) -> None:
        repo_root = tmp_path / "repo"
        (repo_root / "app" / "node_modules").mkdir(parents=True)
        root = tmp_path / "sandbox-root"
        runner = FakeRunner({"cp": lambda argv, cwd, env: FakeCompleted(1, stderr="cp: nope")})
        with pytest.raises(vb.BreakCheckError):
            vb.create_sandboxes(runner, repo_root, root, "deadbeef", "cafef00d")
        assert f"git worktree remove --force {root / 'base'}" in runner.calls
        assert f"git worktree remove --force {root / 'head'}" in runner.calls

    def test_clear_stale_sandboxes_removes_leftovers_and_prunes(self, tmp_path: Path) -> None:
        repo_root = tmp_path / "repo"
        root = tmp_path / "sandbox-root"
        for name in ("base", "head"):
            (root / name / "app").mkdir(parents=True)
        runner = FakeRunner()
        vb.clear_stale_sandboxes(runner, repo_root, root)
        assert runner.calls == [
            f"git worktree remove --force {root / 'base'}",
            f"git worktree remove --force {root / 'head'}",
            "git worktree prune",
        ]
        assert not (root / "base").exists() and not (root / "head").exists()


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def test_a_kept_sandbox_does_not_block_the_next_run(tmp_path: Path, monkeypatch: Any) -> None:
    """A real git repo: a previous `--keep` run leaves `base`/`head`
    registered; the next run clears them under the lock and adds fresh
    trees instead of failing on "already exists"."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c")
    sha = _git(repo, "rev-parse", "HEAD")
    root = tmp_path / "sandbox-root"
    runner = vb.Runner()
    vb.create_sandboxes(runner, repo, root, sha, sha)  # the kept pair
    assert "sandbox-root/base" in _git(repo, "worktree", "list")
    vb.clear_stale_sandboxes(runner, repo, root)
    sandboxes = vb.create_sandboxes(runner, repo, root, sha, sha)
    assert (sandboxes.base_dir / ".git").exists() and (sandboxes.head_dir / ".git").exists()
    vb.remove_sandboxes(runner, repo, sandboxes, keep=False)
    _git(repo, "worktree", "prune")
    assert _git(repo, "worktree", "list").count("\n") == 0


def test_run_single_test_never_reads_a_stale_vitest_json(tmp_path: Path) -> None:
    """A JSON file from an earlier run at the same log path must not be
    read as this run's result when vitest writes nothing."""
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    file, title = "app/src/test/Shell.test.tsx", "opens the shell"
    stale = log_dir / f"{vb._safe_name(file)}__{vb._safe_name(title)}.json"
    stale.write_text(
        '{"testResults": [{"assertionResults": [{"title": "opens the shell", "status": "failed"}]}]}',
        encoding="utf-8",
    )
    runner = FakeRunner({"npx": lambda argv, cwd, env: FakeCompleted(1, stderr="crashed")})
    outcome = vb.run_single_test(runner, tmp_path, {}, file, title, log_dir)
    assert outcome.error == "vitest produced no JSON output file"
    assert not outcome.failed_as_expected


class TestRunSingleTestKindRouting:
    def test_playwright_file_routes_to_playwright(self) -> None:
        assert vb.test_kind_for_file("app/e2e/shell.journey.spec.ts") == "playwright"

    def test_vitest_file_routes_to_vitest(self) -> None:
        assert vb.test_kind_for_file("app/src/test/Shell.test.tsx") == "vitest"

    def test_unrecognized_file_raises(self) -> None:
        with pytest.raises(vb.BreakCheckError):
            vb.test_kind_for_file("app/src/Shell.tsx")

    def test_playwright_argv_uses_the_grep_pattern(self) -> None:
        title = "a (tricky) title"
        argv = vb.playwright_argv("app/e2e/shell.journey.spec.ts", title)
        assert argv[:3] == ["npx", "playwright", "test"]
        g_index = argv.index("-g")
        assert argv[g_index + 1] == vb.playwright_grep_pattern(title)

    def test_grep_pattern_matches_the_joined_project_file_describe_title_string(self) -> None:
        """Playwright's `-g` matches against
        `[projectName, file, ...describeTitles, testTitle].join(" ")`, never
        the bare test title — a plain `^<title>$` anchor could never match."""
        title = "test-title"
        joined = "chromium e2e/x.spec.ts describe-title test-title"
        pattern = vb.playwright_grep_pattern(title)
        assert re.search(pattern, joined)

    def test_grep_pattern_does_not_match_a_title_that_is_only_a_prefix(self) -> None:
        joined = "chromium e2e/x.spec.ts describe-title test-title"
        pattern = vb.playwright_grep_pattern("describe-title test")
        assert not re.search(pattern, joined)

    def test_grep_pattern_does_not_match_a_title_that_is_only_a_suffix_substring(self) -> None:
        """`title` is a suffix substring of the joined string's last word,
        but not itself preceded by a word boundary — `test-title` must not
        satisfy a search for `title` alone."""
        joined = "chromium e2e/x.spec.ts describe-title test-title"
        pattern = vb.playwright_grep_pattern("title")
        assert not re.search(pattern, joined)

    def test_vitest_argv_uses_dash_t_and_json_reporter(self) -> None:
        output = Path("/tmp/out.json")
        argv = vb.vitest_argv("app/src/test/Shell.test.tsx", "opens the shell", output)
        assert argv[:3] == ["npx", "vitest", "run"]
        assert "-t" in argv
        assert argv[argv.index("-t") + 1] == vb.vitest_grep_pattern("opens the shell")
        assert "--outputFile" in argv

    def test_vitest_grep_pattern_escapes_regex_metacharacters_and_anchors_the_end(self) -> None:
        title = "reflects STALE (registry changed) when ≥ 1 project's fingerprint drifted (B1-02)"
        pattern = vb.vitest_grep_pattern(title)
        assert pattern.endswith("$")
        # The escaped pattern, compiled as a real regex, must match the
        # title itself (anchored at the end) — that is the point of
        # escaping `(`, `)` and other metacharacters instead of passing the
        # raw title straight into `new RegExp(...)`.
        assert re.search(pattern, title)
        assert re.search(pattern, "prefix text then " + title)
        # A title containing `?`/`+` — unescaped, `?` and `+` are quantifiers
        # that would either fail to compile against a preceding literal or
        # silently change what matches.
        query_title = "only runs the poll when ?pruned=1 is set"
        query_pattern = vb.vitest_grep_pattern(query_title)
        assert re.search(query_pattern, query_title)
        assert not re.search(query_pattern, "only runs the poll when pruned=1 is set")


# --------------------------------------------------------------------- group 2


def _resolve_breaks_base() -> Optional[str]:
    env_base = os.environ.get("SKILL_TREE_BREAKS_BASE")
    if env_base:
        return env_base
    has_origin_main = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "--verify", "--quiet", "origin/main"],
        capture_output=True,
        text=True,
    )
    if has_origin_main.returncode != 0:
        return None
    merge_base = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "merge-base", "HEAD", "origin/main"],
        capture_output=True,
        text=True,
    )
    if merge_base.returncode != 0:
        return None
    return merge_base.stdout.strip()


def _breaks_manifests() -> List[Path]:
    # The plan folder must exist: if it moves again, an empty list here
    # would silently turn both group-2 checks into no-ops. Only the
    # `breaks/` subfolder may be absent (PR A ships no manifests).
    if not vb.PLAN_DIR.parent.is_dir():
        # docs/changes/ is export-ignored as a whole: private evidence not shipped.
        pytest.skip("docs/changes is private evidence not shipped in the public snapshot")
    assert vb.PLAN_DIR.is_dir(), f"plan folder {vb.PLAN_DIR} is missing; update vb.PLAN_DIR"
    if not vb.BREAKS_DIR.is_dir():
        return []
    return sorted(vb.BREAKS_DIR.glob("*.yaml"))


def test_template_removal_satisfied_by_a_row_in_the_same_file() -> None:
    by_file = {"app/e2e/widths.journey.spec.ts": {"opens at 1440px"}}
    assert _template_removal_satisfied(
        "opens at ${width}px", ("app/e2e/widths.journey.spec.ts",), by_file
    )


def test_template_removal_not_satisfied_by_a_row_in_another_file() -> None:
    """The literal text of the template matches, but the manifest row names
    a *different* spec file — that must not satisfy a removed template in
    this file, or an unrelated coincidence would silently hide a real gap."""
    by_file = {"app/e2e/other.journey.spec.ts": {"opens at 1440px"}}
    assert not _template_removal_satisfied(
        "opens at ${width}px", ("app/e2e/widths.journey.spec.ts",), by_file
    )


def test_template_removal_satisfied_across_a_rename_pair() -> None:
    """`files` carries both the report path (post-rename) and the base
    path, so a manifest row keyed to either satisfies the removal."""
    by_file = {"app/e2e/old-name.journey.spec.ts": {"opens at 1440px"}}
    assert _template_removal_satisfied(
        "opens at ${width}px",
        ("app/e2e/new-name.journey.spec.ts", "app/e2e/old-name.journey.spec.ts"),
        by_file,
    )


def test_every_breaks_manifest_validates_and_resolves_in_the_current_tree() -> None:
    """Every manifest under `vb.BREAKS_DIR` validates, and every remaining
    test it names resolves in the current tree. With no manifests the loop
    runs zero times, but it never skips."""
    for path in _breaks_manifests():
        data = vb.load_manifest(path)
        problems, warnings = vb.check_manifest(REPO_ROOT, data)
        for warning in warnings:
            print(f"[verify_breaks] {path}: {warning}")
        assert not problems, f"{path}: {problems}"


def _changed_e2e_file_pairs(base: str) -> List[Tuple[str, Optional[str]]]:
    """`(path_at_base, path_at_head_or_None)` for every `app/e2e/*.spec.ts`
    difference between `base` and HEAD, including renames (`-M`).

    A bare `--name-only` diff shows only the *new* path for a rename, so
    `git show base:<newpath>` fails and a renamed spec's removed titles are
    silently skipped — this maps each pair explicitly instead. `None` as
    the head path means the file is gone (deleted, or renamed away with no
    match found): every title at base counts as removed.
    """
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "diff", "-M", "--name-status", f"{base}..HEAD", "--", "app/e2e/*.spec.ts"],
        capture_output=True,
        text=True,
        check=True,
    )
    pairs: List[Tuple[str, Optional[str]]] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0]
        if status.startswith(("R", "C")) and len(parts) == 3:
            pairs.append((parts[1], parts[2]))
        elif status == "D":
            pairs.append((parts[1], None))
        else:  # "A" (no base content; `git show` below is skipped for it) or "M"
            pairs.append((parts[1], parts[1]))
    return pairs


def _template_removal_satisfied(
    template: str,
    files: Sequence[str],
    template_row_titles_by_file: Dict[str, Set[str]],
) -> bool:
    """True when some manifest row's resolved literal title fits `template`
    *and* that row's `removed.file` is one of `files` (the removed
    template's own file, or its rename source) — a manifest row for the
    same-looking template in an unrelated file must not satisfy this. A
    file with no rows at all has no candidates, so this is False, never a
    vacuous True."""
    candidates: Set[str] = set()
    for f in files:
        candidates |= template_row_titles_by_file.get(f, set())
    return any(vb.template_title_matches_row_title(template, t) for t in candidates)


def head_literal_titles(repo_root: Path) -> Set[str]:
    """Every literal journey title in the working tree's app/e2e specs."""
    titles: Set[str] = set()
    for spec in sorted((repo_root / "app" / "e2e").glob("*.spec.ts")):
        titles |= vb.extract_titles(spec.read_text(encoding="utf-8"))
    return titles


def test_head_literal_titles_sees_a_test_moved_into_another_spec(tmp_path: Path) -> None:
    e2e = tmp_path / "app" / "e2e"
    e2e.mkdir(parents=True)
    (e2e / "merged.journey.spec.ts").write_text('test("moved title", async () => {});\n', encoding="utf-8")
    assert "moved title" in head_literal_titles(tmp_path)
    assert "gone title" not in head_literal_titles(tmp_path)


def test_every_removed_journey_title_has_a_manifest_row() -> None:
    """Three ways a journey title can be "removed" between `base` and HEAD,
    each needing a manifest row:

    1. A literal `test(`/`it(` title present at base, absent at head
       (`extract_titles`) — including across a rename (`_changed_e2e_file_pairs`).
    2. A template literal title (`` `…${width}…` ``) whose whole `test(`/
       `it(` call disappeared — matched against a manifest row *in the same
       file* (`_template_removal_satisfied`; see its docstring for why the
       file scope matters) whose resolved literal fits the template. This
       cannot see a width *dropped from* an unchanged loop (a shrinking
       array literal changes no title at all); `detect_shrinking_width_arrays`
       below only prints a soft warning for that case — the B1 process must
       add that manifest row by hand.
    """
    base = _resolve_breaks_base()
    if not base:
        pytest.skip(
            "no SKILL_TREE_BREAKS_BASE and origin/main does not resolve in this checkout "
            "(a shallow CI checkout of the merge sha alone has no origin/main to diff against)"
        )

    manifest_rows = set()
    template_row_titles_by_file: Dict[str, Set[str]] = {}
    for path in _breaks_manifests():
        data = vb.load_manifest(path)
        for row in data["rows"]:
            removed = row["removed"]
            manifest_rows.add((removed["file"], removed["title"]))
            template_row_titles_by_file.setdefault(removed["file"], set()).add(removed["title"])

    # A test that leaves one spec for another (a merge of two specs into
    # one) is moved, not removed from app/e2e/: plan section 7 counts only
    # removed titles. So a base title that still exists, literally, in any
    # spec at head needs no manifest row.
    head_titles_anywhere = head_literal_titles(REPO_ROOT)

    missing: List[Tuple[str, str]] = []
    warnings: List[str] = []
    for base_rel, head_rel in _changed_e2e_file_pairs(base):
        base_show = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "show", f"{base}:{base_rel}"],
            capture_output=True,
            text=True,
        )
        if base_show.returncode != 0:
            continue  # the file did not exist at base: nothing was removed from it
        base_text = base_show.stdout
        if head_rel is None:
            head_text = ""
        else:
            head_path = REPO_ROOT / head_rel
            head_text = head_path.read_text(encoding="utf-8") if head_path.exists() else ""
        report_path = head_rel or base_rel

        base_titles = vb.extract_titles(base_text)
        head_titles = vb.extract_titles(head_text)
        for title in base_titles - head_titles:
            if title in head_titles_anywhere:
                continue  # moved to another spec
            if (report_path, title) not in manifest_rows and (base_rel, title) not in manifest_rows:
                missing.append((report_path, title))

        base_templates = vb.extract_template_titles(base_text)
        head_templates = vb.extract_template_titles(head_text)
        for template in base_templates - head_templates:
            if not _template_removal_satisfied(template, (report_path, base_rel), template_row_titles_by_file):
                missing.append((report_path, template))

        warnings.extend(f"{report_path}: {w}" for w in vb.detect_shrinking_width_arrays(base_text, head_text))

    for warning in warnings:
        # A soft signal only (finding 4c) — printed for a human to notice,
        # never asserted on: dropping a width from an unchanged loop
        # changes no test title, so it cannot be a hard failure here.
        print(f"[verify_breaks CI rule] possible missed width row: {warning}")

    assert not missing, f"removed journey titles with no manifest row: {missing}"


def test_main_returns_2_when_a_row_patch_find_does_not_match(tmp_path: Path, monkeypatch: Any) -> None:
    """`main()` catches `BreakCheckError` and exits 2 with a message —
    `PatchError` (raised when a patch's `find` does not match) is now a
    subclass of it (finding 3), so a bad manifest row must reach that exit
    path, not an unhandled traceback."""
    import yaml

    manifest = tmp_path / "shell.yaml"
    row = {
        "removed": {"file": "app/src/test/Foo.test.tsx", "title": "t1"},
        "remaining": [{"file": "app/src/test/Foo.test.tsx", "title": "t1"}],
        "patch": [
            {"file": "app/src/components/Foo.tsx", "find": "NOT PRESENT AT ALL", "replace": "x"},
        ],
        "reason": "r",
    }
    manifest.write_text(yaml.safe_dump(_manifest([row]), sort_keys=False), encoding="utf-8")

    base_dir = tmp_path / "sandboxes" / "base"
    head_dir = tmp_path / "sandboxes" / "head"
    for d in (base_dir, head_dir):
        (d / "app" / "src" / "components").mkdir(parents=True)
        (d / "app" / "src" / "components" / "Foo.tsx").write_text("const X = 1\n", encoding="utf-8")

    sandboxes = vb.Sandboxes(root=tmp_path / "sandboxes", base_dir=base_dir, head_dir=head_dir)
    monkeypatch.setattr(vb, "create_sandboxes", lambda *a, **k: sandboxes)
    monkeypatch.setattr(vb, "remove_sandboxes", lambda *a, **k: None)
    monkeypatch.setattr(vb, "acquire_sandbox_lock", lambda root: None)
    monkeypatch.setattr(vb, "_resolve_git_sha", lambda runner, repo, ref: ref)

    argv = [
        str(manifest),
        "--repo",
        str(tmp_path),
        "--sandbox-root",
        str(tmp_path / "sandboxes"),
        "--direction",
        "base",
        "--no-control",
    ]
    assert vb.main(argv) == 2


def test_run_all_starts_one_dev_server_for_each_sandbox_tree(tmp_path: Path, monkeypatch: Any) -> None:
    """The base tree and the head tree hold different source, so each
    Playwright direction needs its own server, and the Playwright env must
    carry that server's port."""
    manifest = tmp_path / "shell.yaml"
    manifest.write_text(
        "area: shell\nbase: abc123\nrows:\n"
        "  - removed: {file: app/e2e/a.journey.spec.ts, title: t1}\n"
        "    remaining: [{file: app/e2e/b.journey.spec.ts, title: t2}]\n"
        "    patch: [{file: app/src/x.tsx, find: a, replace: b}]\n"
        "    reason: r\n",
        encoding="utf-8",
    )
    started: List[Any] = []
    seen_ports: List[Any] = []

    def fake_start(runner: Any, cwd: Path, env: Dict[str, str], port: int, **_: Any) -> vb.DevServer:
        started.append((cwd, port))
        return vb.DevServer(process=None, port=port)  # type: ignore[arg-type]

    def fake_direction(
        runner: Any, tree: Path, env: Dict[str, str], row: Any, direction: str, log_dir: Path, **_: Any
    ) -> List[Any]:
        seen_ports.append((direction, env.get("ST_DEV_PORT")))
        summary = vb.RunSummary(total=1, failed=1)
        patched = vb.TestOutcome("f", "t", "playwright", summary, log_dir / "x.json")
        return [vb.RowOutcome(file="f", title="t", control=None, patched=patched)]

    monkeypatch.setattr(vb, "start_dev_server", fake_start)
    monkeypatch.setattr(vb, "stop_dev_server", lambda server: None)
    sandboxes = vb.Sandboxes(tmp_path, tmp_path / "base", tmp_path / "head")
    monkeypatch.setattr(vb, "create_sandboxes", lambda *a, **k: sandboxes)
    monkeypatch.setattr(vb, "remove_sandboxes", lambda *a, **k: None)
    monkeypatch.setattr(vb, "acquire_sandbox_lock", lambda root: None)
    monkeypatch.setattr(vb, "_resolve_git_sha", lambda runner, repo, ref: ref)
    monkeypatch.setattr(vb, "run_row_direction", fake_direction)
    # A running server keeps its port bound, so a real probe skips it; the
    # fake mirrors that by handing out a new port on every call.
    monkeypatch.setattr(vb, "free_port", lambda start=1500: start + 1 + len(started))
    argv = [str(manifest), "--repo", str(tmp_path), "--sandbox-root", str(tmp_path / "sb")]
    args = vb.build_parser().parse_args(argv)
    assert vb.run_all(args, runner=FakeRunner()) == 0
    assert [cwd.parent.name for cwd, _ in started] == ["base", "head"]
    assert len({port for _, port in started}) == 2
    assert [d for d, _ in seen_ports] == ["base", "head"]
    assert [p for _, p in seen_ports] == [str(started[0][1]), str(started[1][1])]


def test_tests_run_from_the_sandbox_app_directory(tmp_path: Path, monkeypatch: Any) -> None:
    """vitest and Playwright read their config (the `@/` alias, the preview
    web server) from `app/`; run from the tree root they find no tests."""
    tree = tmp_path / "tree"
    (tree / "app" / "src").mkdir(parents=True)
    (tree / "app" / "src" / "x.tsx").write_text("const a = 1;\n", encoding="utf-8")
    seen: List[Path] = []

    def fake_run_single_test(runner: Any, cwd: Path, env: Any, file: str, title: str, log_dir: Path) -> Any:
        seen.append(cwd)
        return vb.TestOutcome(file, title, "vitest", vb.RunSummary(total=1, failed=1), log_dir / "x.json")

    monkeypatch.setattr(vb, "run_single_test", fake_run_single_test)
    row = {
        "removed": {"file": "app/src/test/X.test.tsx", "title": "t"},
        "remaining": [{"file": "app/src/test/Y.test.tsx", "title": "u"}],
        "patch": [{"file": "app/src/x.tsx", "find": "a = 1", "replace": "a = 2"}],
        "reason": "r",
    }
    vb.run_row_direction(FakeRunner(), tree, {}, row, "head", tmp_path / "logs", control=False)
    assert seen and all(cwd == tree / "app" for cwd in seen)


def test_remove_sandboxes_deletes_leftover_directories(tmp_path: Path) -> None:
    base, head = tmp_path / "base", tmp_path / "head"
    for d in (base, head):
        (d / "app" / "test-results").mkdir(parents=True)
    vb.remove_sandboxes(FakeRunner(), tmp_path, vb.Sandboxes(tmp_path, base, head), keep=False)
    assert not base.exists() and not head.exists()


def test_stop_dev_server_signals_the_whole_process_group(tmp_path: Path) -> None:
    """`npm run dev` forks `vite`; stopping only npm left vite running and
    writing into the sandbox after cleanup. The server now runs in its own
    session, and stopping it takes the whole group down."""
    script = tmp_path / "parent.sh"
    child_pid = tmp_path / "child.pid"
    script.write_text(f"#!/bin/sh\nsleep 300 &\necho $! > {child_pid}\nwait\n", encoding="utf-8")
    script.chmod(0o755)
    env = {"PATH": os.environ.get("PATH", ""), "TMPDIR": str(tmp_path / "tmp")}
    process = vb.Runner().popen([str(script)], cwd=tmp_path, env=env)
    for _ in range(100):
        if child_pid.exists() and child_pid.read_text().strip():
            break
        time.sleep(0.05)
    pid = int(child_pid.read_text().strip())
    vb.stop_dev_server(vb.DevServer(process=process, port=0))
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(pid, 9)
        raise AssertionError("the grandchild survived stop_dev_server")


def test_start_dev_server_timeout_stops_the_whole_process_group(tmp_path: Path) -> None:
    """A server that never answers: the timeout path must take down the
    whole group, as `stop_dev_server` does, or `vite` outlives it."""
    script = tmp_path / "parent.sh"
    child_pid = tmp_path / "child.pid"
    script.write_text(f"#!/bin/sh\nsleep 300 &\necho $! > {child_pid}\nwait\n", encoding="utf-8")
    script.chmod(0o755)

    class ScriptRunner(FakeRunner):
        def popen(self, argv: Sequence[str], *, cwd: Optional[Path] = None, env: Optional[Dict[str, str]] = None):
            self.calls.append(" ".join(argv))
            return vb.Runner().popen([str(script)], cwd=cwd, env=env)

    env = {"PATH": os.environ.get("PATH", ""), "TMPDIR": str(tmp_path / "tmp")}
    port = vb.free_port(20000)
    with pytest.raises(vb.BreakCheckError, match="did not answer"):
        vb.start_dev_server(ScriptRunner(), tmp_path, env, port, timeout=1.0, poll_interval=0.05)
    assert child_pid.exists(), "the fake server never started its child"
    pid = int(child_pid.read_text().strip())
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(pid, 9)
        raise AssertionError("the grandchild survived the start_dev_server timeout")
