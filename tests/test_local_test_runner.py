from __future__ import annotations

import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOL = REPO_ROOT / "testing" / "scripts" / "local_test_runner.py"
_spec = importlib.util.spec_from_file_location("local_test_runner_tool", TOOL)
assert _spec and _spec.loader
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)


def command(*argv: str, kind: str = "test-static") -> dict:
    return {"id": kind, "runner": kind, "argv": list(argv), "cwd": None, "env": {}}


def selection(commands: list[dict], **overrides: object) -> dict:
    body = {
        "verdict": "ok",
        "static_commands": [],
        "commands": commands,
        "selections": {"python": [], "vitest": [], "e2e": [], "cargo": False, "integration": []},
        "broaden": {"python": None, "vitest": None, "e2e": None, "cargo": None},
        "uncertainty": [],
        "reasons": [],
        "integration_profile": "selected",
    }
    body.update(overrides)
    return body


def test_check_streams_full_logs_but_bounds_failure_detail(tmp_path):
    payload = "x" * 8_000
    result = runner.run_check(
        command(sys.executable, "-c", f"import sys; sys.stderr.write({payload!r}); raise SystemExit(7)"),
        tmp_path,
        5,
    )

    assert result["status"] == "failed"
    assert result["exit_code"] == 7
    assert len(result["details"]) == runner.DETAIL_LIMIT
    assert Path(result["stderr_path"]).read_text() == payload


def test_native_pytest_evidence_reports_zero_collection(tmp_path):
    script = (
        "from pathlib import Path; import sys; "
        "p=sys.argv[sys.argv.index('--junitxml')+1]; "
        "Path(p).write_text('<testsuite tests=\"0\"/>')"
    )
    result = runner.run_check(
        {"runner": "python", "argv": [sys.executable, "-c", script], "cwd": None, "env": {}},
        tmp_path,
        5,
    )

    assert result["status"] == "zero_collected"
    assert result["counts"]["collected"] == 0


def test_malformed_native_evidence_blocks_a_zero_exit(tmp_path):
    result = runner.run_check(
        {"runner": "python", "argv": [sys.executable, "-c", "pass"], "cwd": None, "env": {}},
        tmp_path,
        5,
    )

    assert result["status"] == "blocked"
    assert "native evidence" in result["reason"]


def test_unsupported_integration_evidence_is_non_passing(tmp_path):
    report = {
        "effective_evidence_verdict": "unsupported",
        "cases": [{"id": "native-only", "status": "unsupported"}],
    }
    script = (
        "import json,sys; from pathlib import Path; "
        "p=Path(sys.argv[sys.argv.index('--report-dir')+1])/'run-id'; "
        "p.mkdir(parents=True); "
        f"(p/'report.json').write_text(json.dumps({report!r}))"
    )
    result = runner.run_check(
        {
            "runner": "integration",
            "argv": [sys.executable, "-c", script, "--report-dir", "ignored"],
            "cwd": None,
            "env": {},
        },
        tmp_path,
        5,
    )

    assert result["status"] == "unsupported"
    assert result["counts"] == {
        "collected": 1,
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "blocked": 0,
        "unsupported": 1,
        "inconclusive": 0,
    }
    assert result["integration_cases"] == [
        {"id": "native-only", "status": "unsupported"}
    ]
    assert Path(result["evidence_path"]).parent.name == "run-id"


def test_nested_integration_report_preserves_observed_statuses_and_reasons(tmp_path):
    report = {
        "effective_evidence_verdict": "blocked",
        "cases": [
            {"id": "offline-pass", "status": "pass"},
            {"id": "memory", "status": "blocked", "reason": "memory supervision unavailable"},
            {"id": "native", "status": "unsupported", "reason": "native recipe unavailable"},
        ],
    }
    script = (
        "import json,sys; from pathlib import Path; "
        "p=Path(sys.argv[sys.argv.index('--report-dir')+1])/'real-run-id'; p.mkdir(parents=True); "
        f"(p/'report.json').write_text(json.dumps({report!r}))"
    )
    result = runner.run_check(
        {
            "runner": "integration",
            "argv": [sys.executable, "-c", script, "--report-dir", "ignored"],
            "cwd": None,
            "env": {},
        },
        tmp_path,
        5,
    )

    assert result["status"] == "blocked"
    assert result["counts"] == {
        "collected": 3,
        "passed": 1,
        "failed": 0,
        "skipped": 0,
        "blocked": 1,
        "unsupported": 1,
        "inconclusive": 0,
    }
    assert result["integration_cases"] == report["cases"]
    assert Path(result["evidence_path"]).parent.name == "real-run-id"


@pytest.mark.parametrize(
    ("verdict", "case_status", "expected_status"),
    [("blocked", "blocked", "blocked"), ("unsupported", "unsupported", "unsupported")],
)
def test_nonzero_integration_exit_preserves_nonpassing_native_verdict(
    tmp_path, verdict, case_status, expected_status
):
    report = {
        "effective_evidence_verdict": verdict,
        "cases": [{"id": "platform-case", "status": case_status, "reason": "platform evidence"}],
    }
    script = (
        "import json,sys; from pathlib import Path; "
        "p=Path(sys.argv[sys.argv.index('--report-dir')+1])/'run-id'; p.mkdir(parents=True); "
        f"(p/'report.json').write_text(json.dumps({report!r})); raise SystemExit(1)"
    )

    result = runner.run_check(
        {
            "runner": "integration",
            "argv": [sys.executable, "-c", script, "--report-dir", "ignored"],
            "cwd": None,
            "env": {},
        },
        tmp_path,
        5,
    )

    assert result["exit_code"] == 1
    assert result["status"] == expected_status
    assert result["counts"][case_status] == 1


def test_nonzero_integration_exit_cannot_be_overridden_by_passing_evidence(tmp_path):
    report = {
        "effective_evidence_verdict": "pass",
        "cases": [{"id": "offline-pass", "status": "pass"}],
    }
    script = (
        "import json,sys; from pathlib import Path; "
        "p=Path(sys.argv[sys.argv.index('--report-dir')+1])/'run-id'; p.mkdir(parents=True); "
        f"(p/'report.json').write_text(json.dumps({report!r})); raise SystemExit(1)"
    )

    result = runner.run_check(
        {
            "runner": "integration",
            "argv": [sys.executable, "-c", script, "--report-dir", "ignored"],
            "cwd": None,
            "env": {},
        },
        tmp_path,
        5,
    )

    assert result["exit_code"] == 1
    assert result["status"] == "failed"
    assert result["counts"]["passed"] == 1


def test_missing_executable_is_blocked(tmp_path):
    result = runner.run_check(command("definitely-no-such-executable-xyz"), tmp_path, 5)
    assert result["status"] == "blocked"
    assert result["exit_code"] is None


def test_timeout_kills_descendant_process_group(tmp_path):
    child_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
    parent_code = (
        "import signal,subprocess,sys,time; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"p=subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
        "print(p.pid, flush=True); time.sleep(60)"
    )
    result = runner.run_check(command(sys.executable, "-c", parent_code), tmp_path, 0.2)
    child_pid = int(Path(result["stdout_path"]).read_text().strip())

    assert result["status"] == "timed_out"
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        pytest.fail("descendant survived process-group cleanup")


def test_cooperative_timeout_reaps_leader_before_group_probe(tmp_path):
    result = runner.run_check(
        command(sys.executable, "-c", "import time; time.sleep(60)"),
        tmp_path,
        0.1,
    )

    assert result["status"] == "timed_out"
    assert result["cleanup_status"] == "confirmed"
    assert result["exit_code"] is not None


def test_cleanup_polls_exited_leader_before_group_probe(monkeypatch):
    class ExitedLeader:
        pid = 99123
        returncode = None
        polled = False

        def poll(self):
            self.polled = True
            self.returncode = 0
            return 0

    proc = ExitedLeader()
    signals = []

    def fake_killpg(_pid, sig):
        signals.append(sig)
        if sig == 0 and not proc.polled:
            raise PermissionError("unreaped leader")
        if sig == 0:
            raise ProcessLookupError

    monkeypatch.setattr(runner.os, "killpg", fake_killpg)

    assert runner._stop_group(proc) is None
    assert signals == [runner.signal.SIGTERM, 0]


def test_persistent_cleanup_denial_returns_bounded_error(monkeypatch):
    class LiveProcess:
        pid = 99124
        returncode = None

        def poll(self):
            return None

    signals = []

    def denied(_pid, sig):
        signals.append(sig)
        raise PermissionError("operation not permitted")

    monkeypatch.setattr(runner.os, "killpg", denied)
    monkeypatch.setattr(runner, "TERM_GRACE_SECONDS", 0.01)

    error = runner._stop_group(LiveProcess())

    assert error is not None
    assert "denied" in error
    assert runner.signal.SIGKILL in signals


def test_normal_leader_exit_cleans_only_its_surviving_descendants(tmp_path):
    child_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
    leader_code = (
        "import subprocess,sys; "
        f"p=subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
        "print(p.pid, flush=True)"
    )
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        result = runner.run_check(command(sys.executable, "-c", leader_code), tmp_path, 5)
        child_pid = int(Path(result["stdout_path"]).read_text().strip())

        assert result["status"] == "passed"
        assert result["process_group_cleanup"] is True
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            pytest.fail("descendant survived cleanup after its leader exited")
        assert unrelated.poll() is None
    finally:
        unrelated.terminate()
        unrelated.wait(timeout=5)


def test_cleanup_failure_makes_normal_exit_nonpassing_and_keeps_logs(tmp_path, monkeypatch):
    child_code = "import time; time.sleep(60)"
    leader_code = (
        "import subprocess,sys; "
        f"subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
        "print('leader exited', flush=True)"
    )
    real_stop = runner._stop_group

    def cleanup_then_deny(proc):
        assert real_stop(proc) is None
        return "SIGKILL denied: simulated EPERM"

    monkeypatch.setattr(runner, "_stop_group", cleanup_then_deny)

    result = runner.run_check(command(sys.executable, "-c", leader_code), tmp_path, 5)

    assert result["status"] == "blocked"
    assert result["cleanup_status"] == "unconfirmed"
    assert result["exit_code"] == 0
    assert "leader exited" in Path(result["stdout_path"]).read_text()


def test_interrupt_preserves_unconfirmed_cleanup_result(tmp_path, monkeypatch):
    class InterruptedProcess:
        pid = 99125
        returncode = None

        def wait(self, timeout):
            raise KeyboardInterrupt

        def poll(self):
            return None

    monkeypatch.setattr(runner.subprocess, "Popen", lambda *args, **kwargs: InterruptedProcess())
    monkeypatch.setattr(runner, "_stop_group", lambda proc: "SIGKILL denied: simulated EPERM")

    with pytest.raises(runner.RunInterrupted) as interrupted:
        runner.run_check(command(sys.executable, "-c", "pass"), tmp_path, 5)

    result = interrupted.value.result
    assert result["status"] == "cancelled"
    assert result["cleanup_status"] == "unconfirmed"
    assert result["exit_code"] is None
    assert Path(result["stdout_path"]).exists()


def test_interrupt_during_process_start_is_reported_as_cancelled(tmp_path, monkeypatch):
    def interrupt_start(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(runner.subprocess, "Popen", interrupt_start)

    with pytest.raises(runner.RunInterrupted) as interrupted:
        runner.run_check(command(sys.executable, "-c", "pass"), tmp_path, 5)

    result = interrupted.value.result
    assert result["status"] == "cancelled"
    assert result["reason"] == "interrupted"
    assert result["exit_code"] is None
    assert "cleanup_status" not in result


def test_execute_continues_after_an_ordinary_failure(tmp_path, monkeypatch):
    first = command(sys.executable, "-c", "raise SystemExit(3)", kind="first")
    second = command(sys.executable, "-c", "print('ran')", kind="second")
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selection([first, second]))
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)

    report, exit_code = runner.execute("HEAD", 5, tmp_path)

    assert exit_code == 1
    assert [item["status"] for item in report["checks"]] == ["failed", "passed"]
    assert Path(report["checks"][1]["stdout_path"]).read_text().strip() == "ran"


def test_unconfirmed_timeout_cleanup_preserves_report_and_skips_later_checks(
    tmp_path, monkeypatch
):
    later_marker = tmp_path / "later-ran"
    commands = [
        command(sys.executable, "-c", "import time; time.sleep(60)", kind="timeout"),
        command(
            sys.executable,
            "-c",
            f"from pathlib import Path; Path({str(later_marker)!r}).write_text('ran')",
            kind="later",
        ),
    ]
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selection(commands))
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)
    real_stop = runner._stop_group

    def cleanup_then_deny(proc):
        assert real_stop(proc) is None
        return "SIGKILL denied: simulated EPERM"

    monkeypatch.setattr(runner, "_stop_group", cleanup_then_deny)

    report, exit_code = runner.execute("HEAD", 0.1, tmp_path)

    assert exit_code == 1
    assert [check["status"] for check in report["checks"]] == ["timed_out", "skipped"]
    assert report["checks"][0]["cleanup_status"] == "unconfirmed"
    assert report["checks"][0]["exit_code"] is not None
    assert "process cleanup unconfirmed" in report["checks"][0]["reason"]
    assert report["checks"][1]["reason"] == "not started after unconfirmed process cleanup"
    assert not later_marker.exists()
    assert Path(report["private_evidence_path"]).exists()


def test_reused_log_base_allocates_fresh_runs_and_never_reuses_native_evidence(
    tmp_path, monkeypatch
):
    valid = (
        "from pathlib import Path; import sys; "
        "p=sys.argv[sys.argv.index('--junitxml')+1]; "
        "Path(p).write_text('<testsuite tests=\"1\"/>')"
    )
    selected = iter(
        [
            selection(
                [{"runner": "python", "argv": [sys.executable, "-c", valid], "cwd": None, "env": {}}]
            ),
            selection(
                [{"runner": "python", "argv": [sys.executable, "-c", "pass"], "cwd": None, "env": {}}]
            ),
        ]
    )
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: next(selected))
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)

    first, first_exit = runner.execute("HEAD", 5, tmp_path)
    second, second_exit = runner.execute("HEAD", 5, tmp_path)

    assert first_exit == 0
    assert first["checks"][0]["status"] == "passed"
    assert second_exit == 1
    assert second["checks"][0]["status"] == "blocked"
    assert first["log_dir"] != second["log_dir"]
    assert Path(first["checks"][0]["evidence_path"]).exists()


def test_interrupt_retains_partial_report_and_skips_unstarted(tmp_path, monkeypatch):
    commands = [command("one", kind="one"), command("two", kind="two")]
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selection(commands))
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)
    interrupted = {"id": "one", "runner": "one", "status": "cancelled"}
    monkeypatch.setattr(runner, "run_check", lambda *args: (_ for _ in ()).throw(runner.RunInterrupted(interrupted)))

    report, exit_code = runner.execute("HEAD", 5, tmp_path)

    assert exit_code == 130
    assert [item["status"] for item in report["checks"]] == ["cancelled", "skipped"]


def test_non_inert_empty_and_missing_offline_integration_are_blocked(tmp_path, monkeypatch):
    selected = selection([], verdict="needs_attention", reasons=["empty_selection"], integration_profile="offline")
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selected)
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)

    report, exit_code = runner.execute("HEAD", 5, tmp_path)

    assert exit_code == 1
    assert report["status"] == "failed"
    assert any(item["runner"] == "integration" and item["status"] == "blocked" for item in report["checks"])


def test_source_change_during_run_makes_success_stale(tmp_path, monkeypatch):
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selection([command(sys.executable, "-c", "pass")]))
    identities = iter(
        [
            {"head": "abc", "semantic_fingerprint": {"schema_version": 1, "fingerprint": "before"}},
            {"head": "abc", "semantic_fingerprint": {"schema_version": 1, "fingerprint": "after"}},
        ]
    )
    monkeypatch.setattr(runner, "_source_identity", lambda: next(identities))

    report, exit_code = runner.execute("HEAD", 5, tmp_path)

    assert exit_code == 1
    assert report["source"]["stale"] is True


def test_occupied_playwright_port_blocks_without_stopping_owner(tmp_path, monkeypatch):
    owner = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    owner.bind(("127.0.0.1", 0))
    owner.listen()
    port = owner.getsockname()[1]
    monkeypatch.setenv("ST_DEV_PORT", str(port))
    try:
        result = runner.run_check(
            {"runner": "e2e", "argv": [sys.executable, "-c", "pass"], "cwd": None, "env": {}},
            tmp_path,
            5,
        )
        assert result["status"] == "blocked"
        assert "occupied" in result["reason"]
        probe = socket.create_connection(("127.0.0.1", port), timeout=1)
        probe.close()
    finally:
        owner.close()


def test_success_report_is_compact_and_points_to_private_logs(tmp_path, monkeypatch, capsys):
    selected = selection([command(sys.executable, "-c", "print('large output stays private')")])
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selected)
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)

    exit_code = runner.main(["--base", "HEAD", "--log-dir", str(tmp_path)])
    body = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert body["status"] == "passed"
    assert "large output stays private" not in json.dumps(body)
    assert Path(body["checks"][0]["stdout_path"]).read_text().strip() == "large output stays private"


def test_cli_blocks_malformed_native_formats_and_emits_one_json(tmp_path, monkeypatch, capsys):
    pytest_script = (
        "from pathlib import Path; import sys; "
        "p=sys.argv[sys.argv.index('--junitxml')+1]; "
        "Path(p).write_text('<testsuite tests=\"-1\"/>')"
    )
    vitest_script = (
        "from pathlib import Path; import sys; "
        "p=next(x.split('=',1)[1] for x in sys.argv if x.startswith('--outputFile=')); "
        "Path(p).write_text('[]')"
    )
    playwright_script = (
        "from pathlib import Path; import os; "
        "Path(os.environ['PLAYWRIGHT_JSON_OUTPUT_NAME']).write_text('null')"
    )
    integration_script = (
        "from pathlib import Path; import sys; "
        "p=Path(sys.argv[sys.argv.index('--report-dir')+1])/'run-id'; p.mkdir(parents=True); "
        "(p/'report.json').write_text('{\"cases\":null,\"effective_evidence_verdict\":\"pass\"}')"
    )
    selected = selection(
        [
            {"runner": "python", "argv": [sys.executable, "-c", pytest_script], "cwd": None, "env": {}},
            {"runner": "vitest", "argv": [sys.executable, "-c", vitest_script], "cwd": None, "env": {}},
            {"runner": "e2e", "argv": [sys.executable, "-c", playwright_script], "cwd": None, "env": {}},
            {
                "runner": "integration",
                "argv": [sys.executable, "-c", integration_script, "--report-dir", "ignored"],
                "cwd": None,
                "env": {},
            },
        ]
    )
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selected)
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)
    monkeypatch.delenv("ST_DEV_PORT", raising=False)

    exit_code = runner.main(["--base", "HEAD", "--log-dir", str(tmp_path)])
    body = json.loads(capsys.readouterr().out)

    assert exit_code == 1
    assert [check["status"] for check in body["checks"]] == ["blocked"] * 4
    assert all("native evidence" in check["reason"] for check in body["checks"])


def test_public_report_bounds_selection_and_source_detail(tmp_path, monkeypatch, capsys):
    many = [
        {"reason": "uncertain-" + "x" * 500, "path": f"path/{index}.py"}
        for index in range(300)
    ]
    selected = selection([], uncertainty=many, reasons=["reason-" + "y" * 500] * 300)
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selected)
    identity = {
        "head": "abc",
        "semantic_fingerprint": {
            "schema_version": 1,
            "fingerprint": "same",
            "input_count": 900,
            "excluded_paths": [f"docs/{index}.md" for index in range(900)],
        },
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)

    exit_code = runner.main(["--base", "HEAD", "--log-dir", str(tmp_path)])
    output = capsys.readouterr().out
    body = json.loads(output)

    assert exit_code == 1
    assert len(output.encode()) < 16_000
    assert body["selection"]["uncertainty"]["omitted"] == 292
    assert body["selection"]["reasons"]["omitted"] == 292
    assert "excluded_paths" not in body["source"]["start"]
    private = Path(body["private_evidence_path"])
    assert private.exists()
    assert "docs/899.md" in private.read_text()


def test_execute_blocks_on_unmet_obligations(tmp_path, monkeypatch):
    selected = selection(
        [],
        verdict="needs_attention",
        reasons=["unmet_obligations"],
        obligations=[
            {
                "kind": "vitest_importer",
                "path": "app/src/screens/Widget.tsx",
                "status": "unmet",
                "evidence": [],
                "reason": "no vitest test file imports this new component directly",
            }
        ],
    )
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selected)
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)

    report, exit_code = runner.execute("HEAD", 5, tmp_path)

    assert exit_code == 1
    assert report["status"] == "failed"
    assert any(
        item["id"] == "obligations" and item["runner"] == "selection" and item["status"] == "blocked"
        for item in report["checks"]
    )
    assert report["selection"]["obligations"]["items"][0]["path"] == "app/src/screens/Widget.tsx"


def test_execute_passes_with_waived_obligations(tmp_path, monkeypatch):
    selected = selection(
        [command(sys.executable, "-c", "print('ran')")],
        obligations=[
            {
                "kind": "vitest_importer",
                "path": "app/src/screens/Widget.tsx",
                "status": "waived",
                "evidence": [],
                "reason": "tested only through ParentScreen",
            }
        ],
    )
    monkeypatch.setattr(runner.test_scope, "select", lambda *args: selected)
    identity = {
        "head": "abc",
        "semantic_fingerprint": {"schema_version": 1, "fingerprint": "same"},
    }
    monkeypatch.setattr(runner, "_source_identity", lambda: identity)

    report, exit_code = runner.execute("HEAD", 5, tmp_path)

    assert exit_code == 0
    assert report["status"] == "passed"
    assert not any(item["id"] == "obligations" for item in report["checks"])
