#!/usr/bin/env python3
"""The flaky-ledger reporter and gate.

Two subcommands:

- ``report``: parse Playwright and vitest JSON output, cross-check the
  flaky tests it finds against ``testing/flaky.yaml``, print a
  ``::warning`` line and a job-summary section for every unledgered flake,
  and write a JSON artifact. Always exits 0 — an unledgered flake is a
  warning, never a failure (decision 4).
- ``check``: validate the ledger itself against the current tree and
  today's date; exit 1 when a rule is violated (decision 5 and friends).

Test id shape (decision 3): ``<runner>:<repo-relative file>::<describe
titles and test title joined by " > ">``, ``runner`` in ``{e2e, vitest}``.
For Playwright, a spec's ``suites`` nest one level per ``test.describe`` (a
file with no ``describe`` has no title segment beyond the test's own
title); for vitest, ``TestCase.fullName`` already joins parent describe
titles with ``" > "`` (vitest/dist's `SuiteImplementation`/`TestCase`
`get fullName()`), which is exactly this id's second half.

Quarantine marker (decision 2): a line ``// flaky-quarantine: <id>``
directly above ``test.fixme("title"`` (Playwright) or ``it.skip("title"``
(vitest).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]

# PyYAML lives in vendor/ next to hub.py (hub.py:21-23 does the same, and
# testing/scripts/test_scope.py:40-47 mirrors it), never in user
# site-packages: a sandboxed subprocess with a faked $HOME must still find it.
_VENDOR_DIR = REPO_ROOT / "vendor"
if _VENDOR_DIR.is_dir() and str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

import yaml  # type: ignore[import-untyped]  # noqa: E402

SCHEMA_VERSION = 1
DEFAULT_DEADLINE_DAYS = 14
VALID_STATUSES = {"open", "quarantined", "fixed"}
LEDGER_KEYS = {
    "id",
    "first_seen",
    "last_seen",
    "runs",
    "owner",
    "status",
    "deadline",
    "reason",
    "extended_reason",
    "fix",
    "fixed_on",
}


class FlakyLedgerError(RuntimeError):
    pass


# ───────────────────────────────────────────── Playwright parsing


def _playwright_repo_relative(root_dir: str, file: str) -> str:
    absolute = (Path(root_dir) / file).resolve()
    try:
        return absolute.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return absolute.as_posix()


def _walk_playwright_suites(
    suite: Mapping[str, Any], titles: Tuple[str, ...], file: str
) -> Iterable[Tuple[str, Tuple[str, ...], Mapping[str, Any]]]:
    for spec in suite.get("specs", []) or []:
        yield file, titles, spec
    for child in suite.get("suites", []) or []:
        # A file-level suite's own `title` equals the spec file name, not a
        # `test.describe` title; only nested suites (below the file) add a
        # describe segment to the id.
        yield from _walk_playwright_suites(child, titles + (child["title"],), file)


def parse_playwright(report_paths: Sequence[Path]) -> List[Dict[str, Any]]:
    """Return one entry per flaky spec across one or more sharded reports."""
    flaky: List[Dict[str, Any]] = []
    for report_path in report_paths:
        data = json.loads(report_path.read_text(encoding="utf-8"))
        root_dir = data.get("config", {}).get("rootDir", "")
        for suite in data.get("suites", []) or []:
            file = _playwright_repo_relative(root_dir, suite.get("file") or suite["title"])
            for _, titles, spec in _walk_playwright_suites(suite, (), file):
                for test in spec.get("tests", []) or []:
                    if test.get("status") != "flaky":
                        continue
                    retries = max((r.get("retry", 0) for r in test.get("results", []) or []), default=0)
                    title = " > ".join((*titles, spec["title"]))
                    flaky.append({"runner": "e2e", "file": file, "title": title, "retries": retries})
    return flaky


# ───────────────────────────────────────────── vitest parsing


def parse_vitest(report_paths: Sequence[Path]) -> List[Dict[str, Any]]:
    """Vitest shard reports come from `app/src/test/flakyReporter.ts`
    (schema: {"runner": "vitest", "flaky": [{"file", "title", "retries"}]})."""
    flaky: List[Dict[str, Any]] = []
    for report_path in report_paths:
        data = json.loads(report_path.read_text(encoding="utf-8"))
        for entry in data.get("flaky", []) or []:
            flaky.append(
                {
                    "runner": "vitest",
                    "file": entry["file"],
                    "title": entry["title"],
                    "retries": int(entry.get("retries") or 0),
                }
            )
    return flaky


def flaky_id(entry: Mapping[str, Any]) -> str:
    return f"{entry['runner']}:{entry['file']}::{entry['title']}"


# ───────────────────────────────────────────── ledger


def load_ledger(path: Path) -> Dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise FlakyLedgerError(f"{path} must contain a YAML mapping")
    return data


def ledger_entry_by_id(ledger: Mapping[str, Any]) -> Dict[str, Mapping[str, Any]]:
    return {entry["id"]: entry for entry in ledger.get("entries") or []}


_MARKER_RE = re.compile(r"^\s*//\s*flaky-quarantine:\s*(\S.*?)\s*$")
_PW_FIXME_RE = re.compile(r'test\.fixme\(\s*"')
_VITEST_SKIP_RE = re.compile(r'it\.skip\(\s*"')


def find_quarantine_markers(repo: Path = REPO_ROOT) -> List[Tuple[str, int, str]]:
    """Every `// flaky-quarantine: <id>` line found under app/e2e and
    app/src, paired with the line number and whether the following
    non-blank line is a `test.fixme(`/`it.skip(` call. Returns
    (relative_path, line_number, id) only for markers directly above such a
    call; a stray marker (nothing recognized right below it) is reported
    separately by callers that also want the raw scan."""
    markers: List[Tuple[str, int, str]] = []
    for base in (repo / "app" / "e2e", repo / "app" / "src"):
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.ts")) + sorted(base.rglob("*.tsx")):
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
            for i, line in enumerate(lines):
                match = _MARKER_RE.match(line)
                if not match:
                    continue
                next_line = lines[i + 1] if i + 1 < len(lines) else ""
                if _PW_FIXME_RE.search(next_line) or _VITEST_SKIP_RE.search(next_line):
                    rel = path.relative_to(repo).as_posix()
                    markers.append((rel, i + 1, match.group(1)))
    return markers


def find_all_markers_raw(repo: Path = REPO_ROOT) -> List[Tuple[str, int, str]]:
    """Every `// flaky-quarantine: <id>` line, regardless of what follows —
    used to detect a stray marker (no `test.fixme`/`it.skip` immediately
    below it)."""
    markers: List[Tuple[str, int, str]] = []
    for base in (repo / "app" / "e2e", repo / "app" / "src"):
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.ts")) + sorted(base.rglob("*.tsx")):
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
            for i, line in enumerate(lines):
                match = _MARKER_RE.match(line)
                if match:
                    rel = path.relative_to(repo).as_posix()
                    markers.append((rel, i + 1, match.group(1)))
    return markers


def _parse_date(value: str) -> dt.date:
    return dt.date.fromisoformat(value)


def validate_ledger(ledger: Mapping[str, Any], today: dt.date, repo: Path = REPO_ROOT) -> List[str]:
    """Every problem found, as human-readable strings. Empty means clean.
    A `check` caller exits 1 when this is non-empty; `report` never calls
    this to decide its own exit code (decision 4/5 are separate gates)."""
    problems: List[str] = []

    if ledger.get("schema_version") != SCHEMA_VERSION:
        problems.append(f"schema_version must be {SCHEMA_VERSION}, got {ledger.get('schema_version')!r}")

    entries = ledger.get("entries") or []
    seen_ids: Set[str] = set()
    quarantine_markers = {(m[2]) for m in find_quarantine_markers(repo)}
    stray_markers = find_all_markers_raw(repo)
    marked_but_not_paired = {mid for (_, _, mid) in stray_markers} - quarantine_markers
    for mid in sorted(marked_but_not_paired):
        problems.append(f"quarantine marker for {mid!r} has no test.fixme(/it.skip( on the next line")

    for entry in entries:
        entry_id = entry.get("id")
        if not entry_id:
            problems.append(f"entry missing id: {entry!r}")
            continue
        if entry_id in seen_ids:
            problems.append(f"duplicate id: {entry_id}")
        seen_ids.add(entry_id)

        for key in entry:
            if key not in LEDGER_KEYS:
                problems.append(f"{entry_id}: unknown key {key!r}")

        status = entry.get("status")
        if status not in VALID_STATUSES:
            problems.append(f"{entry_id}: status must be one of {sorted(VALID_STATUSES)}, got {status!r}")

        first_seen = entry.get("first_seen")
        last_seen = entry.get("last_seen")
        try:
            first_seen_date = _parse_date(first_seen) if first_seen else None
        except ValueError:
            problems.append(f"{entry_id}: first_seen {first_seen!r} is not YYYY-MM-DD")
            first_seen_date = None
        try:
            last_seen_date = _parse_date(last_seen) if last_seen else None
        except ValueError:
            problems.append(f"{entry_id}: last_seen {last_seen!r} is not YYYY-MM-DD")
            last_seen_date = None
        if first_seen_date and last_seen_date and last_seen_date < first_seen_date:
            problems.append(f"{entry_id}: last_seen {last_seen} is before first_seen {first_seen}")

        default_deadline_days = ledger.get("default_deadline_days", DEFAULT_DEADLINE_DAYS)
        deadline = entry.get("deadline")
        deadline_date: Optional[dt.date] = None
        if deadline:
            try:
                deadline_date = _parse_date(deadline)
            except ValueError:
                problems.append(f"{entry_id}: deadline {deadline!r} is not YYYY-MM-DD")
        if first_seen_date and deadline_date:
            default_deadline = first_seen_date + dt.timedelta(days=default_deadline_days)
            if deadline_date > default_deadline and not entry.get("extended_reason"):
                problems.append(
                    f"{entry_id}: deadline {deadline} exceeds first_seen+{default_deadline_days}d "
                    f"({default_deadline.isoformat()}) without extended_reason"
                )

        if status == "open" and deadline_date and deadline_date < today:
            problems.append(f"{entry_id}: open entry is past its deadline {deadline} (today {today})")

        if status == "quarantined":
            if not entry.get("reason"):
                problems.append(f"{entry_id}: quarantined entry needs a reason")
            if entry_id not in quarantine_markers:
                problems.append(f"{entry_id}: quarantined entry has no matching code marker")

        if status == "fixed" and not entry.get("fixed_on"):
            problems.append(f"{entry_id}: fixed entry needs fixed_on")

        if status in ("open", "quarantined"):
            runner, _, rest = entry_id.partition(":")
            file, _, title = rest.partition("::")
            file_path = repo / file
            if not file_path.is_file():
                problems.append(f"{entry_id}: file {file} does not exist")
            elif not _title_exists(file_path, title, runner):
                problems.append(f"{entry_id}: title not found in {file}")

    return problems


def _title_exists(file_path: Path, title: str, runner: str) -> bool:
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    # The id's last segment is the test's own title; a describe/suite
    # prefix (joined with " > ") is not itself a literal source string for
    # Playwright (nested `test.describe` calls), so check the leaf title's
    # text is present verbatim as either a `test(`/`it(` string.
    leaf = title.rsplit(" > ", 1)[-1]
    escaped = re.escape(leaf)
    if re.search(rf'(test|it)\.?\w*\(\s*[`"\']{escaped}[`"\']', text):
        return True
    return leaf in text


# ───────────────────────────────────────────── report rendering


def render_summary(
    flaky: Sequence[Mapping[str, Any]], entries_by_id: Mapping[str, Mapping[str, Any]]
) -> Tuple[str, List[str], List[Dict[str, Any]]]:
    """Returns (job-summary markdown, list of ::warning lines, artifact flaky[] rows)."""
    unledgered: List[Mapping[str, Any]] = []
    rows: List[Dict[str, Any]] = []
    for entry in flaky:
        fid = flaky_id(entry)
        ledgered = entries_by_id.get(fid)
        rows.append({**entry, "id": fid, "ledger_status": (ledgered or {}).get("status", "unledgered")})
        if ledgered is None:
            unledgered.append(entry)

    lines = ["## Unledgered flaky tests", ""]
    warnings: List[str] = []
    if not unledgered:
        lines.append("None. Every flaky test this run found already has an entry in `testing/flaky.yaml`.")
    else:
        lines.append("| id | retries |")
        lines.append("|---|---|")
        for entry in unledgered:
            fid = flaky_id(entry)
            lines.append(f"| `{fid}` | {entry['retries']} |")
            warnings.append(f"::warning::Unledgered flaky test: {fid} (add it to testing/flaky.yaml)")
    return "\n".join(lines) + "\n", warnings, rows


def _append_actions_summary(markdown: str) -> None:
    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    if destination:
        with Path(destination).open("a", encoding="utf-8") as summary:
            summary.write(markdown.rstrip() + "\n")


# ───────────────────────────────────────────── CLI


def cmd_report(args: argparse.Namespace) -> int:
    paths = sorted({p for pattern in args.input for p in Path().glob(pattern)})
    if args.runner == "e2e":
        flaky = parse_playwright(paths)
    else:
        flaky = parse_vitest(paths)

    ledger = load_ledger(args.ledger) if args.ledger.exists() else {"entries": []}
    entries_by_id = ledger_entry_by_id(ledger)

    summary, warnings, rows = render_summary(flaky, entries_by_id)
    _append_actions_summary(summary)
    for warning in warnings:
        print(warning)

    artifact = {
        "schema_version": SCHEMA_VERSION,
        "run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", ""),
        "runner": args.runner,
        "flaky": rows,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    ledger = load_ledger(args.ledger)
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    problems = validate_ledger(ledger, today, args.repo)
    if problems:
        for problem in problems:
            print(f"flaky_report: {problem}", file=sys.stderr)
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    report = sub.add_parser("report")
    report.add_argument("--runner", choices=["e2e", "vitest"], required=True)
    report.add_argument("--input", action="append", required=True, help="glob for report file(s) (repeatable)")
    report.add_argument("--ledger", type=Path, default=REPO_ROOT / "testing" / "flaky.yaml")
    report.add_argument("--output", type=Path)
    report.set_defaults(func=cmd_report)

    check = sub.add_parser("check")
    check.add_argument("--ledger", type=Path, default=REPO_ROOT / "testing" / "flaky.yaml")
    check.add_argument("--repo", type=Path, default=REPO_ROOT)
    check.add_argument("--today", help="YYYY-MM-DD override for tests")
    check.set_defaults(func=cmd_check)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (FlakyLedgerError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"flaky_report: {exc}", file=sys.stderr)
        return 2 if args.command == "check" else 0


if __name__ == "__main__":
    raise SystemExit(main())
