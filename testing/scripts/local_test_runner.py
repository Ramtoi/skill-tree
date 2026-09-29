#!/usr/bin/env python3
"""Run the checks selected for the current checkout and emit compact JSON."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import test_scope  # type: ignore[import-not-found]  # noqa: E402

REPORT_SCHEMA = 1
DETAIL_LIMIT = 800
EVIDENCE_LIMIT = 16 * 1024 * 1024
PUBLIC_ITEM_LIMIT = 8
PUBLIC_CHECK_LIMIT = 16
PUBLIC_STRING_LIMIT = 240
TERM_GRACE_SECONDS = 2.0


class RunnerError(Exception):
    pass


class RunInterrupted(Exception):
    def __init__(self, result: Dict[str, Any]):
        super().__init__("interrupted")
        self.result = result


def _positive_timeout(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("timeout must be a positive finite number") from exc
    if parsed <= 0 or not math.isfinite(parsed):
        raise argparse.ArgumentTypeError("timeout must be a positive finite number")
    return parsed


def _log_root(path: Optional[Path]) -> Path:
    root = path.expanduser().resolve() if path is not None else Path(tempfile.gettempdir())
    checkout = REPO_ROOT.resolve()
    try:
        root.relative_to(checkout)
    except ValueError:
        pass
    else:
        raise RunnerError("--log-dir must be outside the checkout")
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="skill-tree-local-tests-", dir=root)).resolve()


def _source_identity() -> Dict[str, Any]:
    return {
        "head": test_scope.rev_parse(REPO_ROOT, "HEAD"),
        "semantic_fingerprint": test_scope.semantic_fingerprint(REPO_ROOT, worktree=True),
    }


def _counts(collected: int, passed: int, failed: int, skipped: int) -> Dict[str, int]:
    return {"collected": collected, "passed": passed, "failed": failed, "skipped": skipped}


def _require_bounded_evidence(path: Path) -> None:
    if path.stat().st_size > EVIDENCE_LIMIT:
        raise ValueError(f"native evidence exceeds {EVIDENCE_LIMIT} bytes")


def _read_json_evidence(path: Path) -> Any:
    _require_bounded_evidence(path)
    return json.loads(path.read_text(encoding="utf-8"))


def _json_object(path: Path) -> Dict[str, Any]:
    body = _read_json_evidence(path)
    if not isinstance(body, dict):
        raise TypeError("native JSON evidence root must be an object")
    return body


def _nonnegative_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TypeError(f"{field} must be a non-negative integer")
    return value


def _pytest_counts(path: Path) -> Dict[str, int]:
    _require_bounded_evidence(path)
    root = ET.parse(path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
    total = sum(_nonnegative_int(int(s.attrib.get("tests", "0")), "tests") for s in suites)
    failed = sum(
        _nonnegative_int(int(s.attrib.get("failures", "0")), "failures")
        + _nonnegative_int(int(s.attrib.get("errors", "0")), "errors")
        for s in suites
    )
    skipped = sum(_nonnegative_int(int(s.attrib.get("skipped", "0")), "skipped") for s in suites)
    if failed + skipped > total:
        raise ValueError("pytest evidence counts exceed collected tests")
    return _counts(total, max(0, total - failed - skipped), failed, skipped)


def _vitest_counts(path: Path) -> Dict[str, int]:
    body = _json_object(path)
    total = _nonnegative_int(body["numTotalTests"], "numTotalTests")
    passed = _nonnegative_int(body["numPassedTests"], "numPassedTests")
    failed = _nonnegative_int(body["numFailedTests"], "numFailedTests")
    pending = _nonnegative_int(body.get("numPendingTests", 0), "numPendingTests")
    todo = _nonnegative_int(body.get("numTodoTests", 0), "numTodoTests")
    skipped = pending + todo
    if passed + failed + skipped > total:
        raise ValueError("Vitest evidence counts exceed total tests")
    return _counts(total, passed, failed, skipped)


def _playwright_counts(path: Path) -> Dict[str, int]:
    body = _json_object(path)
    tests: List[Mapping[str, Any]] = []
    suites = body.get("suites")
    if not isinstance(suites, list):
        raise TypeError("Playwright suites must be a list")
    pending_suites = list(suites)
    while pending_suites:
        suite = pending_suites.pop()
        if not isinstance(suite, dict):
            raise TypeError("Playwright suite must be an object")
        specs = suite.get("specs", [])
        children = suite.get("suites", [])
        if not isinstance(specs, list) or not isinstance(children, list):
            raise TypeError("Playwright suite specs and suites must be lists")
        pending_suites.extend(children)
        for spec in specs:
            if not isinstance(spec, dict) or not isinstance(spec.get("tests", []), list):
                raise TypeError("Playwright spec must contain a tests list")
            for test in spec.get("tests", []):
                if not isinstance(test, dict):
                    raise TypeError("Playwright test must be an object")
                tests.append(test)
    def final_status(test: Mapping[str, Any]) -> str:
        results = test.get("results") or []
        if not isinstance(results, list) or any(not isinstance(item, dict) for item in results):
            raise TypeError("Playwright test results must be a list of objects")
        if results:
            status = results[-1].get("status")
        else:
            status = test.get("status")
        if not isinstance(status, str):
            raise TypeError("Playwright test status must be a string")
        return status

    statuses = [final_status(test) for test in tests]
    skipped = sum(1 for status in statuses if status == "skipped")
    passed = sum(1 for status in statuses if status == "passed")
    failed = len(tests) - skipped - passed
    return _counts(len(tests), passed, failed, skipped)


def _cargo_counts(path: Path) -> Optional[Dict[str, int]]:
    pattern = re.compile(
        rb"test result: (?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored"
    )
    matches: List[Tuple[bytes, bytes, bytes]] = []
    with path.open("rb") as stream:
        carry = b""
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            data = carry + chunk
            lines = data.split(b"\n")
            carry = lines.pop()[-512:]
            for line in lines:
                match = pattern.search(line)
                if match:
                    matches.append((match.group(1), match.group(2), match.group(3)))
        match = pattern.search(carry)
        if match:
            matches.append((match.group(1), match.group(2), match.group(3)))
    if not matches:
        return None
    passed = sum(int(item[0]) for item in matches)
    failed = sum(int(item[1]) for item in matches)
    skipped = sum(int(item[2]) for item in matches)
    return _counts(passed + failed + skipped, passed, failed, skipped)


def _integration_counts(
    path: Path,
) -> Tuple[Dict[str, int], str, Optional[str], List[Dict[str, str]]]:
    body = _json_object(path)
    cases = body["cases"]
    if not isinstance(cases, list):
        raise TypeError("integration cases must be a list")
    statuses: List[str] = []
    case_details: List[Dict[str, str]] = []
    allowed_case_statuses = {"pass", "fail", "blocked", "unsupported", "skipped", "inconclusive"}
    for case in cases:
        if not isinstance(case, dict):
            raise TypeError("integration case must be an object")
        status = case.get("status")
        case_id = case.get("id")
        reason = case.get("reason")
        if not isinstance(status, str) or status not in allowed_case_statuses:
            raise TypeError("integration case status is invalid")
        if not isinstance(case_id, str) or (reason is not None and not isinstance(reason, str)):
            raise TypeError("integration case id/reason is invalid")
        statuses.append(status)
        detail = {"id": case_id, "status": status}
        if reason:
            detail["reason"] = reason
        case_details.append(detail)
    by_status = Counter(statuses)
    counts = {
        "collected": len(cases),
        "passed": by_status["pass"],
        "failed": by_status["fail"],
        "skipped": by_status["skipped"],
        "blocked": by_status["blocked"],
        "unsupported": by_status["unsupported"],
        "inconclusive": by_status["inconclusive"],
    }
    verdict = body.get("effective_evidence_verdict", body.get("evidence_verdict"))
    if not isinstance(verdict, str) or verdict not in {
        "pass",
        "fail",
        "blocked",
        "unsupported",
        "inconclusive",
    }:
        raise TypeError("integration evidence verdict is invalid")
    status = {"pass": "passed", "blocked": "blocked", "unsupported": "unsupported"}.get(
        verdict, "failed"
    )
    reason = None
    if status != "passed":
        summary = ", ".join(f"{count} {name}" for name, count in sorted(by_status.items()))
        reason = f"integration evidence verdict: {verdict}; {summary}"
    return counts, status, reason, case_details


def _integration_report(report_root: Path) -> Path:
    reports = sorted(path for path in report_root.rglob("report.json") if path.is_file())
    if len(reports) != 1:
        raise ValueError(f"expected exactly one integration report, found {len(reports)}")
    return reports[0]


def _probe_group(proc: subprocess.Popen[bytes]) -> Tuple[bool, Optional[str]]:
    """Reap the leader before probing its process group.

    macOS can return EPERM for ``killpg(..., 0)`` while an exited leader is
    still unreaped. Polling first turns that transient state into ESRCH.
    """
    for attempt in range(2):
        proc.poll()
        try:
            os.killpg(proc.pid, 0)
        except ProcessLookupError:
            return False, None
        except PermissionError as exc:
            if attempt == 0:
                continue
            return True, f"process group probe denied: {exc}"
        except OSError as exc:
            return True, f"process group probe failed: {exc}"
        return True, None
    return True, "process group state could not be confirmed"


def _stop_group(proc: subprocess.Popen[bytes]) -> Optional[str]:
    pgid = proc.pid
    signal_error: Optional[str] = None
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError as exc:
        signal_error = f"SIGTERM denied: {exc}"
    except OSError as exc:
        signal_error = f"SIGTERM failed: {exc}"
    deadline = time.monotonic() + TERM_GRACE_SECONDS
    while time.monotonic() < deadline:
        alive, probe_error = _probe_group(proc)
        if not alive:
            return None
        if probe_error:
            signal_error = probe_error
        time.sleep(0.05)
    alive, probe_error = _probe_group(proc)
    if not alive:
        return None
    if probe_error:
        signal_error = probe_error
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError as exc:
        signal_error = f"SIGKILL denied: {exc}"
    except OSError as exc:
        signal_error = f"SIGKILL failed: {exc}"
    deadline = time.monotonic() + TERM_GRACE_SECONDS
    while time.monotonic() < deadline:
        alive, probe_error = _probe_group(proc)
        if not alive:
            return None
        if probe_error:
            signal_error = probe_error
        time.sleep(0.05)
    alive, probe_error = _probe_group(proc)
    if not alive:
        return None
    return probe_error or signal_error or "process group remained alive after SIGKILL"


def _record_cleanup(base: Dict[str, Any], proc: subprocess.Popen[bytes]) -> bool:
    error = _stop_group(proc)
    base["process_group_cleanup"] = True
    base["cleanup_status"] = "unconfirmed" if error else "confirmed"
    base["exit_code"] = proc.returncode
    if error:
        base["cleanup_reason"] = error
        existing = str(base.get("reason", "")).strip()
        base["reason"] = f"{existing}; process cleanup unconfirmed: {error}".lstrip("; ")
        return False
    return True


def _port_available(port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def _free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
    finally:
        probe.close()


def _excerpt(path: Path) -> str:
    if not path.exists():
        return ""
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - DETAIL_LIMIT))
        data = stream.read(DETAIL_LIMIT)
    return data.decode("utf-8", errors="replace")


def _prepare_command(
    command: Mapping[str, Any], evidence_dir: Path
) -> Tuple[List[str], Dict[str, str], Optional[Path]]:
    runner = str(command["runner"])
    argv = [str(item) for item in command["argv"]]
    env = {str(key): str(value) for key, value in (command.get("env") or {}).items()}
    evidence: Optional[Path] = None
    if runner == "python":
        evidence = evidence_dir / "pytest.xml"
        argv.extend(["--junitxml", str(evidence)])
    elif runner == "vitest":
        evidence = evidence_dir / "vitest.json"
        argv.extend(["--reporter=json", f"--outputFile={evidence}"])
    elif runner == "e2e":
        evidence = evidence_dir / "playwright.json"
        argv.append("--reporter=json")
        env["PLAYWRIGHT_JSON_OUTPUT_NAME"] = str(evidence)
        env["CI"] = "true"
        supplied = os.environ.get("ST_DEV_PORT")
        if supplied:
            try:
                port = int(supplied)
            except ValueError as exc:
                raise RunnerError("ST_DEV_PORT must be an integer from 1 to 65535") from exc
            if not 1 <= port <= 65535:
                raise RunnerError("ST_DEV_PORT must be an integer from 1 to 65535")
            if not _port_available(port):
                raise RunnerError(f"ST_DEV_PORT {port} is already occupied")
        else:
            port = _free_port()
        env["ST_DEV_PORT"] = str(port)
    elif runner == "integration":
        isolated = evidence_dir / "integration"
        home = isolated / "home"
        reports = isolated / "reports"
        home.mkdir(parents=True)
        reports.mkdir()
        for key in ("HOME", "SKILL_HUB_HOME", "PYTHONUSERBASE"):
            env[key] = str(home)
        evidence = reports
        if "--report-dir" not in argv:
            raise RunnerError("integration command has no --report-dir")
        report_index = argv.index("--report-dir") + 1
        if report_index >= len(argv):
            raise RunnerError("integration command has no report directory")
        argv[report_index] = str(reports)
    return argv, env, evidence


def run_check(command: Mapping[str, Any], log_root: Path, timeout: float) -> Dict[str, Any]:
    check_id = str(command.get("id") or command["runner"])
    runner = str(command["runner"])
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", check_id)
    check_dir = Path(tempfile.mkdtemp(prefix=f"{safe_id}-", dir=log_root)).resolve()
    stdout_path = check_dir / "stdout.log"
    stderr_path = check_dir / "stderr.log"
    evidence_dir = check_dir / "evidence"
    evidence_dir.mkdir()
    started = time.monotonic()
    base: Dict[str, Any] = {
        "id": check_id,
        "runner": runner,
        "status": "blocked",
        "exit_code": None,
        "duration_seconds": 0.0,
        "counts": None,
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
        "evidence_path": None,
    }
    try:
        argv, command_env, evidence = _prepare_command(command, evidence_dir)
    except RunnerError as exc:
        base["reason"] = str(exc)
        return base
    base["evidence_path"] = str(evidence.resolve()) if evidence is not None else None
    cwd = REPO_ROOT / str(command["cwd"]) if command.get("cwd") else REPO_ROOT
    env = os.environ.copy()
    env.update(command_env)
    executable = shutil.which(argv[0], path=env.get("PATH"))
    if executable is None:
        base["reason"] = f"missing executable: {argv[0]}"
        return base
    argv[0] = executable
    proc: Optional[subprocess.Popen[bytes]] = None
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        try:
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                env=env,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            assert proc is not None
            base.update(status="timed_out", reason=f"exceeded {timeout:g} seconds")
            _record_cleanup(base, proc)
        except KeyboardInterrupt:
            base.update(status="cancelled", reason="interrupted")
            if proc is not None:
                _record_cleanup(base, proc)
            base["duration_seconds"] = round(time.monotonic() - started, 3)
            raise RunInterrupted(base)
        except OSError as exc:
            base["reason"] = f"could not start: {exc}"
        else:
            base["exit_code"] = proc.returncode
            group_alive, _probe_error = _probe_group(proc)
            if group_alive:
                cleanup_confirmed = _record_cleanup(base, proc)
                if not cleanup_confirmed:
                    base["status"] = "blocked"
                else:
                    base["status"] = "passed" if proc.returncode == 0 else "failed"
            else:
                base["status"] = "passed" if proc.returncode == 0 else "failed"
    base["duration_seconds"] = round(time.monotonic() - started, 3)
    if base["status"] in ("timed_out", "blocked"):
        base["details"] = (_excerpt(stderr_path) or _excerpt(stdout_path))[-DETAIL_LIMIT:]
        return base

    try:
        if runner == "python":
            assert evidence is not None
            base["counts"] = _pytest_counts(evidence)
        elif runner == "vitest":
            assert evidence is not None
            base["counts"] = _vitest_counts(evidence)
        elif runner == "e2e":
            assert evidence is not None
            base["counts"] = _playwright_counts(evidence)
        elif runner == "cargo":
            base["counts"] = _cargo_counts(stdout_path)
            if base["exit_code"] == 0 and base["counts"] is None:
                base["status"] = "blocked"
                base["reason"] = "missing cargo test summary"
        elif runner == "integration":
            assert evidence is not None
            report_path = _integration_report(evidence)
            base["evidence_path"] = str(report_path.resolve())
            integration_counts, evidence_status, reason, case_details = _integration_counts(
                report_path
            )
            base["counts"] = integration_counts
            base["integration_cases"] = case_details
            if evidence_status != "passed" or base["exit_code"] == 0:
                base["status"] = evidence_status
            if reason:
                base["reason"] = reason
    except (
        AssertionError,
        AttributeError,
        ET.ParseError,
        OSError,
        RecursionError,
        TypeError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
    ) as exc:
        if base["exit_code"] == 0:
            base["status"] = "blocked"
        base["reason"] = f"missing or invalid native evidence: {exc}"

    observed_counts = base.get("counts")
    if (
        base["status"] == "passed"
        and isinstance(observed_counts, dict)
        and observed_counts.get("collected") == 0
    ):
        base["status"] = "zero_collected"
        base["reason"] = "native evidence reports zero collected tests"
    if base["status"] != "passed":
        detail = _excerpt(stderr_path) or _excerpt(stdout_path)
        if detail:
            base["details"] = detail[-DETAIL_LIMIT:]
    return base


def _uncertainty_covered(selection: Mapping[str, Any], commands: Sequence[Mapping[str, Any]]) -> bool:
    executed = {str(command["runner"]) for command in commands}
    broaden = selection.get("broaden") or {}
    for item in selection.get("uncertainty") or []:
        reason = str(item.get("reason", ""))
        path = str(item.get("path", ""))
        affected: Tuple[str, ...]
        if reason == "base_unresolvable":
            affected = ("python", "vitest", "e2e", "cargo")
        elif path.endswith(".py"):
            affected = ("python",)
        elif path.endswith((".ts", ".tsx")):
            affected = ("vitest", "e2e") if path.startswith("app/src/") else ("vitest",)
        else:
            return False
        if any(not broaden.get(runner) or runner not in executed for runner in affected):
            return False
    return True


def _nonrun_check(check_id: str, runner: str, status: str, reason: str) -> Dict[str, Any]:
    return {
        "id": check_id,
        "runner": runner,
        "status": status,
        "exit_code": None,
        "duration_seconds": 0.0,
        "counts": None,
        "stdout_path": None,
        "stderr_path": None,
        "evidence_path": None,
        "reason": reason,
    }


def _truncate(value: Any, limit: int = PUBLIC_STRING_LIMIT) -> str:
    text = str(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _bounded_strings(values: Any) -> Dict[str, Any]:
    items = values if isinstance(values, list) else []
    return {
        "items": [_truncate(item) for item in items[:PUBLIC_ITEM_LIMIT]],
        "omitted": max(0, len(items) - PUBLIC_ITEM_LIMIT),
    }


def _bounded_uncertainty(values: Any) -> Dict[str, Any]:
    items = values if isinstance(values, list) else []
    public: List[Dict[str, str]] = []
    for item in items[:PUBLIC_ITEM_LIMIT]:
        if not isinstance(item, dict):
            public.append({"reason": _truncate(item)})
            continue
        public.append(
            {
                str(key): _truncate(value)
                for key, value in item.items()
                if key in {"reason", "path", "detail", "candidate"}
            }
        )
    return {"items": public, "omitted": max(0, len(items) - PUBLIC_ITEM_LIMIT)}


def _bounded_obligations(values: Any) -> Dict[str, Any]:
    items = values if isinstance(values, list) else []
    public: List[Dict[str, Any]] = []
    for item in items[:PUBLIC_ITEM_LIMIT]:
        if not isinstance(item, dict):
            continue
        row: Dict[str, Any] = {
            str(key): _truncate(item[key])
            for key in ("kind", "path", "subcommand", "status", "reason")
            if key in item
        }
        evidence = item.get("evidence")
        if isinstance(evidence, list):
            row["evidence"] = [_truncate(e) for e in evidence[:PUBLIC_ITEM_LIMIT]]
        public.append(row)
    return {"items": public, "omitted": max(0, len(items) - PUBLIC_ITEM_LIMIT)}


def _public_source(identity: Mapping[str, Any]) -> Dict[str, Any]:
    semantic = identity.get("semantic_fingerprint")
    semantic = semantic if isinstance(semantic, dict) else {}
    return {
        "head": identity.get("head"),
        "fingerprint": semantic.get("fingerprint"),
        "fingerprint_schema": semantic.get("schema_version"),
        "input_count": semantic.get("input_count"),
    }


def _public_check(check: Mapping[str, Any]) -> Dict[str, Any]:
    keys = (
        "id",
        "runner",
        "status",
        "exit_code",
        "duration_seconds",
        "counts",
        "stdout_path",
        "stderr_path",
        "evidence_path",
        "process_group_cleanup",
        "cleanup_status",
    )
    public = {key: check.get(key) for key in keys if key in check}
    for key in ("reason", "details", "cleanup_reason"):
        if key in check:
            public[key] = _truncate(check[key], DETAIL_LIMIT if key == "details" else PUBLIC_STRING_LIMIT)
    cases = check.get("integration_cases")
    if isinstance(cases, list):
        public["integration_cases"] = {
            "items": [
                {str(key): _truncate(value) for key, value in case.items()}
                for case in cases[:PUBLIC_ITEM_LIMIT]
                if isinstance(case, dict)
            ],
            "omitted": max(0, len(cases) - PUBLIC_ITEM_LIMIT),
        }
    return public


def execute(base: str, timeout: float, log_dir: Optional[Path]) -> Tuple[Dict[str, Any], int]:
    started = time.monotonic()
    logs = _log_root(log_dir)
    source_before = _source_identity()
    selection = test_scope.select(REPO_ROOT, base, None, True)
    planned: List[Dict[str, Any]] = [
        *selection.get("static_commands", []), *selection.get("commands", [])
    ]
    checks: List[Dict[str, Any]] = []
    synthetic: List[Dict[str, Any]] = []
    if selection.get("integration_profile") == "offline" and not any(
        command.get("runner") == "integration" for command in planned
    ):
        synthetic.append(
            _nonrun_check(
                "integration",
                "integration",
                "blocked",
                "offline integration obligation has no executable command",
            )
        )
    if selection.get("uncertainty") and not _uncertainty_covered(selection, planned):
        synthetic.append(
            _nonrun_check(
                "selection-uncertainty",
                "selection",
                "blocked",
                "selection uncertainty is not covered by an executed broadened runner",
            )
        )
    unmet_obligations = [
        item
        for item in (selection.get("obligations") or [])
        if isinstance(item, dict) and item.get("status") == "unmet"
    ]
    if unmet_obligations:
        summary = "; ".join(
            f"{item.get('kind')} {item.get('path')}"
            + (f" ({item['subcommand']})" if item.get("subcommand") else "")
            for item in unmet_obligations
        )
        synthetic.append(
            _nonrun_check(
                "obligations",
                "selection",
                "blocked",
                f"unmet test obligations: {summary}",
            )
        )
    interrupted = False
    try:
        for index, command in enumerate(planned):
            result = run_check(command, logs, timeout)
            checks.append(result)
            if result.get("cleanup_status") == "unconfirmed":
                for remaining in planned[index + 1 :]:
                    checks.append(
                        _nonrun_check(
                            str(remaining.get("id") or remaining["runner"]),
                            str(remaining["runner"]),
                            "skipped",
                            "not started after unconfirmed process cleanup",
                        )
                    )
                break
    except RunInterrupted as exc:
        interrupted = True
        checks.append(exc.result)
        completed = len(checks)
        for command in planned[completed:]:
            checks.append(
                _nonrun_check(
                    str(command.get("id") or command["runner"]),
                    str(command["runner"]),
                    "skipped",
                    "not started after interrupt",
                )
            )
    checks.extend(synthetic)
    if not planned and not synthetic:
        empty_status = "skipped" if selection.get("verdict") == "ok" else "blocked"
        checks.append(
            _nonrun_check(
                "selection",
                "selection",
                empty_status,
                (
                    "no applicable checks"
                    if empty_status == "skipped"
                    else "non-inert change produced an empty plan"
                ),
            )
        )

    source_after = _source_identity()
    stale = not test_scope._same_semantic_identity(
        source_before["semantic_fingerprint"], source_after["semantic_fingerprint"]
    )
    statuses = [check["status"] for check in checks]
    passed = all(status in ("passed", "skipped") for status in statuses) and not stale
    if interrupted:
        aggregate = "cancelled"
        exit_code = 130
    elif passed:
        aggregate = "skipped" if statuses and all(status == "skipped" for status in statuses) else "passed"
        exit_code = 0
    else:
        aggregate = "failed"
        exit_code = 1
    source = {
        "start": _public_source(source_before),
        "end": _public_source(source_after),
        "stale": stale,
    }
    if stale:
        source["reason"] = "relevant source changed during execution"
    private_evidence = logs / "execution-evidence.json"
    private_evidence.write_text(
        json.dumps(
            {
                "schema": REPORT_SCHEMA,
                "source": {"start": source_before, "end": source_after, "stale": stale},
                "selection": selection,
                "checks": checks,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    public_checks = [_public_check(check) for check in checks[:PUBLIC_CHECK_LIMIT]]
    broaden = selection.get("broaden")
    public_broaden = (
        {str(key): None if value is None else _truncate(value) for key, value in broaden.items()}
        if isinstance(broaden, dict)
        else {}
    )
    report = {
        "schema": REPORT_SCHEMA,
        "source": source,
        "base": base,
        "selection": {
            "verdict": selection.get("verdict"),
            "counts": {
                key: len(value) if isinstance(value, list) else int(bool(value))
                for key, value in (selection.get("selections") or {}).items()
            },
            "broaden": public_broaden,
            "uncertainty": _bounded_uncertainty(selection.get("uncertainty")),
            "obligations": _bounded_obligations(selection.get("obligations")),
            "reasons": _bounded_strings(selection.get("reasons")),
        },
        "execution_mode": {
            "sequential": True,
            "playwright_ci_preview": any(c.get("runner") == "e2e" for c in planned),
            "dev_only_tests_skipped": any(c.get("runner") == "e2e" for c in planned),
        },
        "status": aggregate,
        "duration_seconds": round(time.monotonic() - started, 3),
        "checks": public_checks,
        "checks_omitted": max(0, len(checks) - PUBLIC_CHECK_LIMIT),
        "log_dir": str(logs),
        "private_evidence_path": str(private_evidence.resolve()),
    }
    return report, exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="local_test_runner.py")
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--worktree", action="store_true", help="explicitly select the current working tree")
    parser.add_argument("--timeout", type=_positive_timeout, default=1800.0)
    parser.add_argument("--log-dir", type=Path)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report, exit_code = execute(args.base, args.timeout, args.log_dir)
    except (
        AttributeError,
        KeyError,
        OSError,
        RunnerError,
        TypeError,
        ValueError,
        test_scope.ToolError,
    ) as exc:
        report = {
            "schema": REPORT_SCHEMA,
            "status": "blocked",
            "error": _truncate(exc),
            "checks": [],
        }
        exit_code = 1
    json.dump(report, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
