"""Quoted credentials and repair of persisted, frozen usage records."""

import copy
import json
import stat
import sys

import pytest

from skill_hub.application.backup import backup
from skill_hub.domain.usage import usage_classify
from skill_hub.infrastructure.usage import usage_scan


def _credential():
    return "github" + "_pat_" + "A1b2C3d4" * 10


@pytest.mark.parametrize("wrapper", ['"{}"', "'{}'", "`{}`", "({})", '"value":"{}"', "prefix{}suffix"])
@pytest.mark.parametrize("credential", [
    _credential(), "ghp_" + "aB12" * 10, "sk-proj-" + "aB12" * 10,
    "AKIA" + "A1B2" * 4, "xoxb-" + "aB12-" * 8,
])
def test_embedded_credentials_do_not_survive_excerpt_redaction(tmp_data_home, wrapper, credential):
    raw = "Use " + wrapper.format(credential) + " please"
    redacted = usage_classify.redact_excerpt(raw)
    assert credential not in redacted
    assert "[redacted]" in redacted
    assert backup._scan_text_for_secrets("excerpt", redacted) == []
    assert usage_classify.redact_excerpt(redacted) == redacted


def test_redaction_precedes_truncation(tmp_data_home):
    raw = "x " * 90 + '"' + _credential() + '"'
    result = usage_classify.redact_excerpt(raw)
    assert "github_pat_" not in result
    assert "[redacted]" in result
    assert len(result) <= 200


def test_repair_keeps_excerpt_limit_when_mask_expands_short_token(tmp_data_home):
    record = {"intent_excerpt": 'Use "ghp_a" ' + "x " * 94}
    assert len(record["intent_excerpt"]) <= 200
    usage_scan._redact_stored_excerpts(record)
    assert "ghp_a" not in record["intent_excerpt"]
    assert len(record["intent_excerpt"]) <= 200


def _write_legacy_files():
    text = 'Use "' + _credential() + '" please'
    row = {
        "schema_version": 1, "harness": "claude-code", "session_id": "old-session",
        "project": "example", "started_at": "2026-08-01T00:00:00Z",
        "last_activity_at": "2026-08-01T01:00:00Z", "frozen": True,
        "intent_excerpt": text, "tokens": {"input": 47, "output": 83},
        "events": [{"excerpt": text, "token_delta": 130}],
    }
    cursor = {
        "schema_version": 1, "last_scan_at": "2026-08-04T00:00:00Z",
        "files": {
            "claude-code:old.jsonl": {
                "offset": 9023, "size": 9023, "mtime": 17, "frozen": True,
                "acc": {"events": [{"text": text}], "tokens": {"in": 47, "out": 83}},
            },
            "codex:old.jsonl": {
                "offset": 123, "size": 123, "frozen": True,
                "acc": {"intent_excerpt": text, "events": [{"excerpt": text}]},
            },
        },
    }
    path = usage_scan.sessions_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(row) + "\n")
    usage_scan.cursor_path().write_text(json.dumps(cursor))
    return row, cursor


def test_repair_preserves_frozen_analytics_and_offsets_and_is_idempotent(tmp_data_home):
    row, cursor = _write_legacy_files()
    result = usage_scan.repair_excerpts()
    assert result == {"ok": True, "redaction_version": 1, "fields_redacted": 5, "files_rewritten": 2}
    version = {"excerpt_redaction_version": usage_scan.EXCERPT_REDACTION_VERSION}
    expected_row = copy.deepcopy(row)
    expected_row.update(version)
    expected_row["intent_excerpt"] = 'Use "[redacted]" please'
    expected_row["events"][0]["excerpt"] = 'Use "[redacted]" please'
    expected_cursor = copy.deepcopy(cursor)
    expected_cursor.update(version)
    expected_cursor["files"]["claude-code:old.jsonl"]["acc"]["events"][0]["text"] = 'Use "[redacted]" please'
    codex = expected_cursor["files"]["codex:old.jsonl"]["acc"]
    codex["intent_excerpt"] = 'Use "[redacted]" please'
    codex["events"][0]["excerpt"] = 'Use "[redacted]" please'
    assert json.loads(usage_scan.sessions_path().read_text()) == expected_row
    assert json.loads(usage_scan.cursor_path().read_text()) == expected_cursor
    paths = [usage_scan.sessions_path(), usage_scan.cursor_path()]
    before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in paths]
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o600 for p in paths)
    assert usage_scan.repair_excerpts()["files_rewritten"] == 0
    assert before == [(p.read_bytes(), p.stat().st_mtime_ns) for p in paths]


def test_repair_captures_one_layout_and_preserves_redacted_bytes(tmp_data_home, tmp_path, monkeypatch):
    _write_legacy_files()
    from skill_hub.application.usage.usage_source_layout import UsageLayout

    layout = UsageLayout((("claude-code", tmp_path / "claude"), ("codex", tmp_path / "codex")))
    calls = []
    monkeypatch.setattr(usage_scan, "capture_usage_layout", lambda: calls.append(layout) or layout)

    before = usage_scan.sessions_path().read_bytes(), usage_scan.cursor_path().read_bytes()
    result = usage_scan.repair_excerpts()

    assert calls == [layout]
    assert result["fields_redacted"] == 5
    assert _credential().encode() not in usage_scan.sessions_path().read_bytes()
    assert _credential().encode() not in usage_scan.cursor_path().read_bytes()
    assert before != (usage_scan.sessions_path().read_bytes(), usage_scan.cursor_path().read_bytes())


@pytest.mark.parametrize("broken", ["sessions", "cursor"])
def test_repair_parses_both_files_before_writing_either(tmp_data_home, broken):
    _write_legacy_files()
    paths = [usage_scan.sessions_path(), usage_scan.cursor_path()]
    paths[0 if broken == "sessions" else 1].write_text('{"broken":')
    before = [p.read_bytes() for p in paths]
    with pytest.raises(ValueError):
        usage_scan.repair_excerpts()
    assert before == [p.read_bytes() for p in paths]


def test_regular_writers_scrub_even_with_current_version(tmp_data_home):
    row, cursor = _write_legacy_files()
    row["excerpt_redaction_version"] = usage_scan.EXCERPT_REDACTION_VERSION
    cursor["excerpt_redaction_version"] = usage_scan.EXCERPT_REDACTION_VERSION
    usage_scan._write_session_rows(usage_scan.sessions_path(), [row])
    usage_scan._write_cursor(cursor)
    assert _credential() not in usage_scan.sessions_path().read_text()
    assert _credential() not in usage_scan.cursor_path().read_text()


def test_normal_scan_repairs_frozen_records_without_transcript_reads(tmp_data_home):
    (tmp_data_home / "registry.yaml").write_text("version: 1\nskills: {}\nprojects: {}\nbundles: {}\n")
    row, cursor = _write_legacy_files()
    result = usage_scan.scan_sessions(harness="claude-code")
    assert result["bytes_read"] == 0
    assert result["rows_frozen"] == 1
    repaired_row = json.loads(usage_scan.sessions_path().read_text())
    repaired_cursor = json.loads(usage_scan.cursor_path().read_text())
    assert repaired_row["tokens"] == row["tokens"]
    assert repaired_cursor["files"]["claude-code:old.jsonl"]["offset"] == 9023
    assert _credential() not in usage_scan.sessions_path().read_text()
    assert _credential() not in usage_scan.cursor_path().read_text()


def test_repair_can_retry_after_second_file_write_fails(tmp_data_home, monkeypatch):
    _write_legacy_files()
    original_write = usage_scan._write_usage_text

    def fail_cursor(path, text):
        if path == usage_scan.cursor_path():
            raise OSError("simulated write failure")
        original_write(path, text)

    with monkeypatch.context() as patch:
        patch.setattr(usage_scan, "_write_usage_text", fail_cursor)
        with pytest.raises(OSError):
            usage_scan.repair_excerpts()
    assert _credential() not in usage_scan.sessions_path().read_text()
    assert _credential() in usage_scan.cursor_path().read_text()
    result = usage_scan.repair_excerpts()
    assert result["files_rewritten"] == 1
    assert result["fields_redacted"] == 3
    assert _credential() not in usage_scan.cursor_path().read_text()


def test_repair_unblocks_snapshot_without_allowlisting(tmp_data_home, tmp_path):
    _write_legacy_files()
    snapshot = tmp_path / "snapshot"
    kwargs = {"data_home": tmp_data_home, "home": tmp_path, "registry": {}}
    with pytest.raises(backup.SecretLeakError):
        backup.assemble_snapshot(snapshot, **kwargs)
    usage_scan.repair_excerpts()
    backup.assemble_snapshot(snapshot, **kwargs)
    assert backup.scan_for_secrets(snapshot) == []


def test_repair_cli_is_wired_and_reports_counts_only(tmp_data_home, monkeypatch, capsys):
    import hub

    _write_legacy_files()
    monkeypatch.setattr(sys, "argv", ["hub", "usage", "repair-excerpts", "--json"])
    hub.main()
    output = capsys.readouterr().out
    assert json.loads(output)["fields_redacted"] == 5
    assert _credential() not in output


def test_repair_cli_failure_does_not_print_corrupt_record(tmp_data_home, monkeypatch, capsys):
    import hub

    _write_legacy_files()
    usage_scan.sessions_path().write_text(_credential())
    monkeypatch.setattr(sys, "argv", ["hub", "usage", "repair-excerpts", "--json"])
    with pytest.raises(SystemExit) as exc:
        hub.main()
    assert exc.value.code == 1
    output = capsys.readouterr().out
    assert json.loads(output)["ok"] is False
    assert _credential() not in output
