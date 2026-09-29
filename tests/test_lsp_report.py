"""Tests for the built-in ``lsp-report`` hook script (hooks-surface tasks 4.1).

The script lives at ``hooks/lsp-report/lsp_report.py`` (a hyphenated dir, not an
importable package), so it is loaded from its file path. It is stdlib-only.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPT = REPO_ROOT / "hooks" / "lsp-report" / "lsp_report.py"
_FIXTURES = REPO_ROOT / "tests" / "fixtures" / "hook_payloads"


def _load_script():
    spec = importlib.util.spec_from_file_location("lsp_report_script", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


lsp = _load_script()


def _fixture(name: str) -> dict:
    return json.loads((_FIXTURES / name).read_text())


class _FakeProc:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


# ─────────────────────────────────────────────────────────────────────────────
# Language detection
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path,expected",
    [
        ("foo.py", "python"),
        ("a/b/mod.ts", "typescript"),
        ("Component.tsx", "typescript"),
        ("main.rs", "rust"),
        ("server.go", "go"),
        ("README.md", None),
        ("noext", None),
        ("data.json", None),
    ],
)
def test_detect_language(path, expected):
    assert lsp.detect_language(path) == expected


def test_checker_dispatch_covers_every_detected_language():
    # Every language the extension map can produce has a checker registered.
    langs = set(lsp._EXT_LANG.values())
    assert langs <= set(lsp._CHECKERS)


# ─────────────────────────────────────────────────────────────────────────────
# Claude-family input resolver (real fixtures)
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_edit_fixture_resolves_file():
    payload = _fixture("claude_posttooluse_edit.json")
    files = lsp.resolve_edited_files(payload, payload["cwd"])
    assert files == ["/tmp/scratch/proj/foo.py"]


def test_claude_write_fixture_resolves_file():
    payload = _fixture("claude_posttooluse_write.json")
    files = lsp.resolve_edited_files(payload, payload["cwd"])
    assert files == ["/tmp/scratch/proj/bar.py"]


def test_claude_multiedit_shape_resolves_file_path(tmp_path):
    # No MultiEdit fixture exists; its tool_input carries file_path (per docs).
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "MultiEdit",
        "tool_input": {
            "file_path": str(tmp_path / "multi.py"),
            "edits": [{"old_string": "a", "new_string": "b"}],
        },
    }
    files = lsp.resolve_edited_files(payload, str(tmp_path))
    assert files == [str(tmp_path / "multi.py")]


def test_claude_defensive_fallback_scans_for_existing_path(tmp_path):
    real = tmp_path / "found.py"
    real.write_text("x = 1\n")
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"some_other_key": str(real)},  # no file_path
    }
    files = lsp.resolve_edited_files(payload, str(tmp_path))
    assert files == [str(real)]


# ─────────────────────────────────────────────────────────────────────────────
# Codex input resolver (real fixture + git fallback)
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_apply_patch_fixture_resolves_files():
    payload = _fixture("codex_posttooluse_apply_patch.json")
    files = lsp.resolve_edited_files(payload, payload["cwd"])
    assert files == ["edit_me.txt"]


def test_apply_patch_parses_all_directive_kinds():
    envelope = (
        "*** Begin Patch\n"
        "*** Update File: pkg/a.go\n"
        "@@\n-x\n+y\n"
        "*** Add File: pkg/new.py\n"
        "+print('hi')\n"
        "*** Delete File: pkg/old.rs\n"
        "*** End Patch\n"
    )
    assert lsp.parse_apply_patch(envelope) == [
        "pkg/a.go",
        "pkg/new.py",
        "pkg/old.rs",
    ]


def test_codex_git_fallback_when_envelope_unparseable(monkeypatch, tmp_path):
    def fake_run(cmd, **kwargs):
        assert cmd[:2] == ["git", "status"]
        return _FakeProc(0, stdout=" M src/a.py\n?? src/b.py\n")

    monkeypatch.setattr(lsp.subprocess, "run", fake_run)
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "apply_patch",
        "tool_input": {"command": "no patch directives here"},
    }
    files = lsp.resolve_edited_files(payload, str(tmp_path))
    assert files == ["src/a.py", "src/b.py"]


def test_git_fallback_handles_rename_destination(monkeypatch, tmp_path):
    def fake_run(cmd, **kwargs):
        return _FakeProc(0, stdout="R  old.py -> new.py\n")

    monkeypatch.setattr(lsp.subprocess, "run", fake_run)
    assert lsp._git_status_paths(str(tmp_path)) == ["new.py"]


# ─────────────────────────────────────────────────────────────────────────────
# Path filter
# ─────────────────────────────────────────────────────────────────────────────


def test_filter_paths_keeps_cwd_files_drops_outside_and_vendored(tmp_path):
    cwd = tmp_path / "proj"
    cwd.mkdir()
    inside = cwd / "src" / "a.py"
    vendored = cwd / "node_modules" / "pkg" / "b.py"
    outside = tmp_path / "elsewhere" / "c.py"
    target = cwd / "target" / "d.rs"
    raw = [str(inside), str(vendored), str(outside), str(target), "rel.py"]
    kept = lsp.filter_paths(raw, str(cwd))
    assert str(inside.resolve()) in kept
    assert str((cwd / "rel.py").resolve()) in kept  # cwd-relative accepted
    assert str(vendored.resolve()) not in kept
    assert str(outside.resolve()) not in kept
    assert str(target.resolve()) not in kept


def test_filter_paths_dedupes(tmp_path):
    cwd = tmp_path
    p = cwd / "a.py"
    kept = lsp.filter_paths([str(p), str(p), "a.py"], str(cwd))
    assert kept == [str(p.resolve())]


# ─────────────────────────────────────────────────────────────────────────────
# Missing checker → silent no-op
# ─────────────────────────────────────────────────────────────────────────────


def test_missing_checker_is_silent_noop(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(lsp.shutil, "which", lambda name: None)
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }
    config = {"languages": {"python": {"enabled": True, "mode": "blocking", "timeout": 5}}}
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    captured = capsys.readouterr()
    assert rc == 0
    assert captured.out == ""
    assert captured.err == ""


# ─────────────────────────────────────────────────────────────────────────────
# Timeout handling → honest report text
# ─────────────────────────────────────────────────────────────────────────────


def test_timeout_reported_honestly(monkeypatch, tmp_path):
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: "/bin/ruff" if name == "ruff" else None
    )

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 5))

    monkeypatch.setattr(lsp.subprocess, "run", fake_run)
    res = lsp._check_python([str(tmp_path / "x.py")], str(tmp_path), 7)
    assert "timed out after 7s" in res.text
    # Timeout must not be reported as a clean/blocking result.
    assert res.findings is False


# ─────────────────────────────────────────────────────────────────────────────
# Single-flight lock
# ─────────────────────────────────────────────────────────────────────────────


def test_single_flight_lock_second_holder_skips(tmp_path):
    with lsp.single_flight_lock(str(tmp_path), "/proj", "python") as first:
        assert first is True
        with lsp.single_flight_lock(str(tmp_path), "/proj", "python") as second:
            assert second is False
    # Released — a fresh acquisition of the same key now succeeds.
    with lsp.single_flight_lock(str(tmp_path), "/proj", "python") as third:
        assert third is True


def test_single_flight_lock_distinct_keys_dont_contend(tmp_path):
    with lsp.single_flight_lock(str(tmp_path), "/proj", "python") as a:
        with lsp.single_flight_lock(str(tmp_path), "/proj", "rust") as b:
            assert a is True and b is True


def test_run_notes_skip_on_lock_contention(monkeypatch, tmp_path):
    # Hold the python lock, then run() → its python pass must skip + note it.
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: "/bin/ruff" if name == "ruff" else None
    )
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }
    config = {"languages": {"python": {"enabled": True, "mode": "advisory", "timeout": 5}}}
    with lsp.single_flight_lock(str(tmp_path), str(tmp_path), "python") as held:
        assert held is True
        # Capture the advisory report via a monkeypatched deliver.
        seen = {}

        def fake_deliver(report, *, blocking):
            seen["report"] = report
            seen["blocking"] = blocking
            return 0

        monkeypatch.setattr(lsp, "deliver", fake_deliver)
        rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    assert rc == 0
    assert "skipped" in seen["report"]
    assert "python" in seen["report"]


# ─────────────────────────────────────────────────────────────────────────────
# Advisory vs blocking delivery
# ─────────────────────────────────────────────────────────────────────────────


def _python_findings(monkeypatch, stdout="F401 unused import\n"):
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: "/bin/ruff" if name == "ruff" else None
    )
    monkeypatch.setattr(
        lsp.subprocess, "run", lambda cmd, **kw: _FakeProc(1, stdout=stdout)
    )


def test_advisory_delivery_emits_additional_context(monkeypatch, tmp_path, capsys):
    _python_findings(monkeypatch)
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }
    config = {"languages": {"python": {"enabled": True, "mode": "advisory", "timeout": 5}}}
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    out = capsys.readouterr()
    assert rc == 0
    payload_out = json.loads(out.out)
    assert payload_out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
    ctx = payload_out["hookSpecificOutput"]["additionalContext"]
    assert "F401" in ctx
    assert out.err == ""


def test_advisory_report_capped_at_4kb_with_note(monkeypatch, tmp_path, capsys):
    _python_findings(monkeypatch, stdout="x" * 6000)
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }
    config = {"languages": {"python": {"enabled": True, "mode": "advisory", "timeout": 5}}}
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    out = capsys.readouterr()
    assert rc == 0
    ctx = json.loads(out.out)["hookSpecificOutput"]["additionalContext"]
    assert len(ctx) <= lsp.REPORT_CAP
    assert "truncated" in ctx


def test_blocking_delivery_exits_2_to_stderr_as_interrupt(monkeypatch, tmp_path, capsys):
    _python_findings(monkeypatch)
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }
    config = {"languages": {"python": {"enabled": True, "mode": "blocking", "timeout": 5}}}
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    out = capsys.readouterr()
    assert rc == 2
    assert out.out == ""
    assert "F401" in out.err
    # Honest phrasing: interrupt, not "prevented the edit".
    assert "interrupt" in out.err.lower()
    assert "already applied" in out.err.lower()


def test_clean_result_is_silent(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: "/bin/ruff" if name == "ruff" else None
    )
    monkeypatch.setattr(lsp.subprocess, "run", lambda cmd, **kw: _FakeProc(0))
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }
    config = {"languages": {"python": {"enabled": True, "mode": "advisory", "timeout": 5}}}
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    out = capsys.readouterr()
    assert rc == 0
    assert out.out == ""
    assert out.err == ""


def test_disabled_language_is_skipped(monkeypatch, tmp_path, capsys):
    _python_findings(monkeypatch)  # ruff WOULD find issues
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }
    config = {"languages": {"python": {"enabled": False, "mode": "blocking", "timeout": 5}}}
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    out = capsys.readouterr()
    assert rc == 0
    assert out.out == "" and out.err == ""


# ─────────────────────────────────────────────────────────────────────────────
# gopls check failure is silently swallowed
# ─────────────────────────────────────────────────────────────────────────────


def test_gopls_nonzero_is_swallowed(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: "/bin/gopls" if name == "gopls" else None
    )
    monkeypatch.setattr(
        lsp.subprocess, "run", lambda cmd, **kw: _FakeProc(1, stderr="gopls: boom")
    )
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "srv.go")},
    }
    # Even in blocking mode a flaky gopls must not surface or exit 2.
    config = {"languages": {"go": {"enabled": True, "mode": "blocking", "timeout": 5}}}
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    out = capsys.readouterr()
    assert rc == 0
    assert out.out == ""
    assert out.err == ""


def test_gopls_timeout_is_swallowed(monkeypatch, tmp_path):
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: "/bin/gopls" if name == "gopls" else None
    )

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 5)

    monkeypatch.setattr(lsp.subprocess, "run", fake_run)
    res = lsp._check_go([str(tmp_path / "s.go")], str(tmp_path), 5)
    assert res.findings is False and res.text == ""


# ─────────────────────────────────────────────────────────────────────────────
# typescript / rust checkers — the two opt-in, PROJECT-SCOPED languages
#
# Both run their checker ONCE from cwd (not per-file), so a single edited file
# can surface pre-existing project-wide errors — and in blocking mode that is an
# agent interrupt on every edit. Every other checker test covers python, whose
# per-file code shape is different.
# ─────────────────────────────────────────────────────────────────────────────


def _record_run(monkeypatch, binary, proc=None, raise_timeout=False):
    """Make only `binary` resolvable and record the argv/cwd the checker used."""
    calls: list[dict] = []
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: f"/bin/{name}" if name == binary else None
    )

    def fake_run(cmd, **kwargs):
        calls.append({"cmd": list(cmd), "cwd": kwargs.get("cwd"), "timeout": kwargs.get("timeout")})
        if raise_timeout:
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 0))
        return proc

    monkeypatch.setattr(lsp.subprocess, "run", fake_run)
    return calls


def test_typescript_runs_tsc_noemit_once_from_cwd_not_per_file(monkeypatch, tmp_path):
    calls = _record_run(monkeypatch, "tsc", _FakeProc(0))
    files = [str(tmp_path / "a.ts"), str(tmp_path / "b.ts"), str(tmp_path / "c.tsx")]
    res = lsp._check_typescript(files, str(tmp_path), 12)
    assert len(calls) == 1  # project-scoped: one invocation for three files
    assert calls[0]["cmd"] == ["tsc", "--noEmit"]
    assert calls[0]["cwd"] == str(tmp_path)
    assert calls[0]["timeout"] == 12
    assert res.language == "typescript"
    assert res.findings is False and res.text == ""


def test_typescript_nonzero_exit_produces_findings_that_can_block(monkeypatch, tmp_path):
    _record_run(
        monkeypatch, "tsc", _FakeProc(2, stdout="src/x.ts(3,1): error TS2304\n")
    )
    res = lsp._check_typescript([str(tmp_path / "x.ts")], str(tmp_path), 5)
    assert res.findings is True  # drives blocking mode
    assert "TS2304" in res.text


def test_typescript_nonzero_with_no_output_still_states_the_failure(monkeypatch, tmp_path):
    _record_run(monkeypatch, "tsc", _FakeProc(1))
    res = lsp._check_typescript([str(tmp_path / "x.ts")], str(tmp_path), 5)
    assert res.findings is True
    assert res.text == "tsc reported type errors"


def test_typescript_missing_binary_is_a_silent_noop(monkeypatch, tmp_path):
    monkeypatch.setattr(lsp.shutil, "which", lambda name: None)
    called = []
    monkeypatch.setattr(
        lsp.subprocess, "run", lambda cmd, **kw: called.append(cmd) or _FakeProc(1)
    )
    res = lsp._check_typescript([str(tmp_path / "x.ts")], str(tmp_path), 5)
    assert called == []  # never spawned
    assert res.findings is False and res.text == ""


def test_typescript_timeout_is_honest_and_never_blocks(monkeypatch, tmp_path):
    _record_run(monkeypatch, "tsc", raise_timeout=True)
    res = lsp._check_typescript([str(tmp_path / "x.ts")], str(tmp_path), 9)
    assert res.findings is False  # a timeout is NOT a finding (would block)
    assert "timed out after 9s" in res.text
    assert "result unknown" in res.text


def test_rust_runs_cargo_check_json_once_from_cwd(monkeypatch, tmp_path):
    calls = _record_run(monkeypatch, "cargo", _FakeProc(0))
    res = lsp._check_rust(
        [str(tmp_path / "a.rs"), str(tmp_path / "b.rs")], str(tmp_path), 20
    )
    assert len(calls) == 1
    assert calls[0]["cmd"] == ["cargo", "check", "--message-format=json"]
    assert calls[0]["cwd"] == str(tmp_path)
    assert res.language == "rust"
    assert res.findings is False and res.text == ""


def test_rust_nonzero_exit_produces_findings(monkeypatch, tmp_path):
    _record_run(
        monkeypatch, "cargo", _FakeProc(101, stdout='{"reason":"compiler-message"}\n')
    )
    res = lsp._check_rust([str(tmp_path / "a.rs")], str(tmp_path), 5)
    assert res.findings is True
    assert "compiler-message" in res.text


def test_rust_missing_binary_is_a_silent_noop(monkeypatch, tmp_path):
    monkeypatch.setattr(lsp.shutil, "which", lambda name: None)
    called = []
    monkeypatch.setattr(
        lsp.subprocess, "run", lambda cmd, **kw: called.append(cmd) or _FakeProc(1)
    )
    res = lsp._check_rust([str(tmp_path / "a.rs")], str(tmp_path), 5)
    assert called == []
    assert res.findings is False and res.text == ""


def test_rust_timeout_is_honest_and_never_blocks(monkeypatch, tmp_path):
    _record_run(monkeypatch, "cargo", raise_timeout=True)
    res = lsp._check_rust([str(tmp_path / "a.rs")], str(tmp_path), 15)
    assert res.findings is False
    assert "cargo check timed out after 15s" in res.text


def test_rust_raw_json_output_is_capped_at_the_report_cap(monkeypatch, tmp_path):
    """`--message-format=json` is dumped verbatim, so a big cargo run must still
    respect the ~4KB cap (truncation stated)."""
    _record_run(monkeypatch, "cargo", _FakeProc(101, stdout='{"x":"' + "y" * 9000 + '"}'))
    res = lsp._check_rust([str(tmp_path / "a.rs")], str(tmp_path), 5)
    report = lsp.build_report([res], blocking=False)
    assert len(report) <= lsp.REPORT_CAP
    assert "truncated" in report


def test_blocking_typescript_findings_exit_2_through_run(monkeypatch, tmp_path, capsys):
    """The blast radius: one edited .ts file in blocking mode ⇒ exit 2 (agent
    interrupt) carrying project-wide errors the user may not have touched."""
    _record_run(
        monkeypatch, "tsc", _FakeProc(2, stdout="src/untouched.ts(9,3): error TS2551\n")
    )
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "edited.ts")},
    }
    config = {
        "languages": {"typescript": {"enabled": True, "mode": "blocking", "timeout": 5}}
    }
    rc = lsp.run(payload, config, lock_dir=str(tmp_path))
    out = capsys.readouterr()
    assert rc == 2
    assert "untouched.ts" in out.err
    assert "already applied" in out.err.lower()


# ─────────────────────────────────────────────────────────────────────────────
# Process-level contract: parse_argv_config / load_config / main()
#
# `<interpreter> lsp_report.py --config <path>` with a JSON payload on stdin is
# the ONLY invocation shape production uses. Every other test in this file calls
# `run()` in-process with a hand-built config dict, bypassing all three.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "argv,expected",
    [
        (["--config", "/tmp/c.json"], "/tmp/c.json"),
        (["--config=/tmp/c.json"], "/tmp/c.json"),
        (["--config=/tmp/has=equals.json"], "/tmp/has=equals.json"),
        (["-x", "--config", "/a/b.json", "--other"], "/a/b.json"),
        ([], None),
        (["--config"], None),  # dangling flag → no value
        (["--configuration", "/x.json"], None),
    ],
)
def test_parse_argv_config(argv, expected):
    assert lsp.parse_argv_config(argv) == expected


def test_load_config_missing_path_fails_open_to_shipped_defaults():
    cfg = lsp.load_config(None)["languages"]
    assert cfg["python"]["enabled"] is True
    assert cfg["go"]["enabled"] is True
    assert cfg["typescript"]["enabled"] is False
    assert cfg["rust"]["enabled"] is False


def test_load_config_nonexistent_file_fails_open(tmp_path):
    # State dir wiped / data home moved: the baked --config no longer exists.
    cfg = lsp.load_config(str(tmp_path / "gone.json"))
    assert cfg["languages"]["python"]["enabled"] is True


def test_load_config_unparseable_json_fails_open(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    assert lsp.load_config(str(bad))["languages"]["python"]["enabled"] is True


def test_load_config_overlays_partial_config_over_defaults(tmp_path):
    path = tmp_path / "c.json"
    path.write_text(json.dumps({"languages": {"python": {"enabled": False}}}))
    langs = lsp.load_config(str(path))["languages"]
    # Overlay, not replace: mode/timeout survive from the defaults…
    assert langs["python"] == {"enabled": False, "mode": "advisory", "timeout": 30}
    # …and unmentioned languages keep theirs.
    assert langs["go"]["enabled"] is True


def test_load_config_ignores_non_dict_languages_block(tmp_path):
    path = tmp_path / "c.json"
    path.write_text(json.dumps({"languages": "nope"}))
    assert lsp.load_config(str(path))["languages"]["python"]["enabled"] is True


def _stdin(monkeypatch, text: str):
    monkeypatch.setattr(lsp.sys, "stdin", io.StringIO(text))


@pytest.mark.parametrize(
    "raw", ["", "not json at all", "{\"truncated\": ", "null", "[1, 2, 3]", '"a string"']
)
def test_main_guards_every_non_dict_stdin_payload(monkeypatch, capsys, raw):
    _stdin(monkeypatch, raw)
    assert lsp.main([]) == 0
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""


def test_main_reads_the_config_named_by_argv(monkeypatch, tmp_path, capsys):
    """A `parse_argv_config` regression silently reverts every project to the
    shipped defaults (python+go ON), re-enabling checkers a project disabled."""
    monkeypatch.setattr(
        lsp.shutil, "which", lambda name: "/bin/ruff" if name == "ruff" else None
    )
    monkeypatch.setattr(
        lsp.subprocess, "run", lambda cmd, **kw: _FakeProc(1, stdout="F401 unused\n")
    )
    config = tmp_path / "lsp-report.project-x.json"
    config.write_text(
        json.dumps({"languages": {"python": {"enabled": False, "mode": "blocking"}}})
    )
    _stdin(
        monkeypatch,
        json.dumps({
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(tmp_path / "x.py")},
        }),
    )
    # python disabled by the named config ⇒ silent, despite ruff "finding" things.
    assert lsp.main(["--config", str(config)]) == 0
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""


def test_main_records_the_config_path_for_the_lock_dir(monkeypatch, tmp_path):
    """`__config_path__` is what makes the single-flight lock live next to the
    per-scope config (so concurrent invocations for one project coordinate)."""
    config = tmp_path / "state" / "hooks" / "lsp-report.global.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"languages": {}}))
    seen: dict = {}
    monkeypatch.setattr(lsp, "run", lambda payload, cfg, **kw: seen.update(cfg) or 0)
    _stdin(monkeypatch, json.dumps({"cwd": str(tmp_path), "tool_name": "Edit"}))
    assert lsp.main(["--config", str(config)]) == 0
    assert seen["__config_path__"] == str(config)
    assert lsp._default_lock_dir(seen) == str(config.parent)


def test_main_without_config_flag_uses_defaults_and_home_lock_dir(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(lsp, "run", lambda payload, cfg, **kw: seen.update(cfg) or 0)
    _stdin(monkeypatch, json.dumps({"cwd": "/tmp", "tool_name": "Edit"}))
    assert lsp.main([]) == 0
    assert "__config_path__" not in seen
    assert seen["languages"]["python"]["enabled"] is True


# ── Real subprocess: exactly how a harness invokes the script ────────────────


def _fake_bin(tmp_path: Path, name: str, body: str) -> Path:
    """A fake checker binary on a throwaway PATH dir."""
    bin_dir = tmp_path / "fakebin"
    bin_dir.mkdir(exist_ok=True)
    script = bin_dir / name
    script.write_text(body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return bin_dir


def _spawn(args: list[str], payload, *, bin_dir: Path | None = None):
    env = dict(os.environ)
    if bin_dir is not None:
        env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    return subprocess.run(
        [sys.executable, str(_SCRIPT), *args],
        input=payload if isinstance(payload, str) else json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )


@pytest.mark.parametrize("raw", ["", "junk", '{"truncated":', "[]"])
def test_subprocess_never_tracebacks_on_bad_stdin(raw, tmp_path):
    proc = _spawn(["--config", str(tmp_path / "missing.json")], raw)
    assert proc.returncode == 0
    assert proc.stdout == ""
    assert "Traceback" not in proc.stderr


def test_subprocess_missing_config_file_is_fail_open_not_an_error(tmp_path):
    (tmp_path / "note.md").write_text("hi\n")
    proc = _spawn(
        ["--config", str(tmp_path / "nope.json")],
        {
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(tmp_path / "note.md")},
        },
    )
    assert proc.returncode == 0
    assert proc.stdout == "" and proc.stderr == ""


def test_subprocess_honours_the_named_config_advisory_then_disabled(tmp_path):
    """End-to-end through a real process: a fake `ruff` on PATH reports a finding,
    the `--config` file decides whether it is delivered at all."""
    bin_dir = _fake_bin(
        tmp_path,
        "ruff",
        "#!/bin/sh\necho 'x.py:1:1: F401 fake-finding'\nexit 1\n",
    )
    (tmp_path / "x.py").write_text("import os\n")
    payload = {
        "cwd": str(tmp_path),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "x.py")},
    }

    enabled = tmp_path / "on.json"
    enabled.write_text(
        json.dumps(
            {"languages": {"python": {"enabled": True, "mode": "advisory", "timeout": 30}}}
        )
    )
    proc = _spawn(["--config", str(enabled)], payload, bin_dir=bin_dir)
    assert proc.returncode == 0, proc.stderr
    ctx = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
    assert "F401 fake-finding" in ctx

    disabled = tmp_path / "off.json"
    disabled.write_text(json.dumps({"languages": {"python": {"enabled": False}}}))
    proc = _spawn(["--config", str(disabled)], payload, bin_dir=bin_dir)
    assert proc.returncode == 0
    assert proc.stdout == "" and proc.stderr == ""


def test_subprocess_blocking_mode_exits_2_with_the_report_on_stderr(tmp_path):
    bin_dir = _fake_bin(
        tmp_path, "ruff", "#!/bin/sh\necho 'x.py:1:1: F401 fake-finding'\nexit 1\n"
    )
    (tmp_path / "x.py").write_text("import os\n")
    config = tmp_path / "blocking.json"
    config.write_text(
        json.dumps(
            {"languages": {"python": {"enabled": True, "mode": "blocking", "timeout": 30}}}
        )
    )
    proc = _spawn(
        ["--config", str(config)],
        {
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(tmp_path / "x.py")},
        },
        bin_dir=bin_dir,
    )
    assert proc.returncode == 2
    assert proc.stdout == ""
    assert "F401 fake-finding" in proc.stderr
    assert "already applied" in proc.stderr.lower()


def test_subprocess_accepts_the_equals_form_of_config(tmp_path):
    bin_dir = _fake_bin(tmp_path, "ruff", "#!/bin/sh\necho 'E501 long'\nexit 1\n")
    (tmp_path / "x.py").write_text("import os\n")
    config = tmp_path / "eq.json"
    config.write_text(json.dumps({"languages": {"python": {"enabled": False}}}))
    proc = _spawn(
        [f"--config={config}"],
        {
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(tmp_path / "x.py")},
        },
        bin_dir=bin_dir,
    )
    # Disabled via the `=` form ⇒ silent. (If the form were mis-parsed the script
    # would fall back to defaults, where python is ENABLED, and report F-codes.)
    assert proc.returncode == 0
    assert proc.stdout == "" and proc.stderr == ""


def test_shipped_script_defaults_match_the_shipped_hook_yaml():
    """`_DEFAULT_LANGUAGES` is the script's fail-open fallback when the baked
    `--config` is missing; it must not drift from hook.yaml's `settings`."""
    import yaml

    shipped = yaml.safe_load(
        (REPO_ROOT / "hooks" / "lsp-report" / "hook.yaml").read_text()
    )
    assert lsp._DEFAULT_LANGUAGES == shipped["settings"]["languages"]
