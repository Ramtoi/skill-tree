"""CLI acceptance tests for incremental Usage scan passes.

These tests drive ``hub.main`` through the public parser and use small Claude
JSONL sources under pytest's isolated home.  They pin pass identity,
continuation, and retry state at the JSON boundary; the parser failure seam is
used only to make one source deterministically incomplete.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

import pytest

import hub
from skill_hub import hub_core
from skill_hub.domain.harnesses.harness_usage_api import ReaderSource


@pytest.fixture(autouse=True)
def _registry(tmp_data_home):
    """Keep the legacy summary scanner inside the isolated data home."""
    (tmp_data_home / "registry.yaml").write_text(
        "version: '1'\nharnesses_global: []\nskills: {}\nprojects: {}\nbundles: {}\n"
    )


def _run(monkeypatch, capsys, *argv: str) -> dict:
    """Run the real argparse route and decode its JSON payload."""
    monkeypatch.setattr(sys, "argv", ["hub", *argv])
    hub.main()
    return json.loads(capsys.readouterr().out)


def _write_source(session_id: str, *, at: str = "2026-09-17T10:00:00.000Z") -> Path:
    """Write one valid, minimal Claude transcript source."""
    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects" / "-usage-cli-fixture"
    root.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "type": "user",
            "uuid": f"{session_id}-user",
            "timestamp": at,
            "sessionId": session_id,
            "cwd": "/workspace/usage-cli-fixture",
            "isSidechain": False,
            "message": {"role": "user", "content": "Continue this fixture."},
        },
        {
            "type": "assistant",
            "uuid": f"{session_id}-assistant",
            "timestamp": at,
            "sessionId": session_id,
            "cwd": "/workspace/usage-cli-fixture",
            "isSidechain": False,
            "message": {
                "id": f"message-{session_id}",
                "model": "fixture-model",
                "role": "assistant",
                "type": "message",
                "content": [{"type": "text", "text": "Captured."}],
                "usage": {
                    "input_tokens": 1,
                    "output_tokens": 1,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                },
            },
        },
    ]
    path = root / f"{session_id}.jsonl"
    path.write_text("".join(json.dumps(record) + "\n" for record in records))
    return path


def _seed_sources(*, count: int = 2) -> list[Path]:
    paths = []
    for index in range(count):
        session_id = f"{index + 1:08d}-1111-4111-8111-111111111111"
        paths.append(_write_source(session_id, at=f"2026-09-17T10:0{index}:00.000Z"))
    # Keep source order deterministic even on filesystems with coarse mtimes.
    for index, path in enumerate(paths):
        os.utime(path, ns=(10_000_000_000 + index, 20_000_000_000 + index))
    return paths


def _write_codex_source(session_id: str) -> Path:
    root = Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "09" / "17"
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"rollout-{session_id}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "session_meta",
                "timestamp": "2026-09-17T11:00:00.000Z",
                "payload": {"id": session_id, "cwd": "/workspace/usage-cli-fixture"},
            }
        )
        + "\n"
    )
    return path


def _inspection(payload: dict) -> dict:
    return payload["inspection"]


def test_scan_chunks_resume_same_pass_and_reaches_completion(tmp_data_home, monkeypatch, capsys):
    """A bounded chunk returns one pass ID that a later chunk can finish."""
    _seed_sources()

    first = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--max-sources",
        "1",
        "--order",
        "path",
        "--json",
    )
    first_i = _inspection(first)
    assert first["ok"] is True
    assert first_i["sources_total"] == 2
    assert first_i["sources_done"] == 1
    assert first_i["sources_pending"] == 1
    assert first_i["sources_incomplete"] == 0
    assert first_i["partial"] is True
    scan_id = first_i["scan_id"]

    second = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--max-sources",
        "1",
        "--order",
        "path",
        "--json",
    )
    second_i = _inspection(second)
    assert second["ok"] is True
    assert second_i["scan_id"] == scan_id
    assert second_i["sources_total"] == 2
    assert second_i["sources_done"] == 2
    assert second_i["sources_pending"] == 0
    assert second_i["sources_incomplete"] == 0
    assert second_i["partial"] is False


def test_newest_quota_is_global_across_claude_and_codex(tmp_data_home, monkeypatch, capsys):
    """A combined quota selects the newest source across both harnesses."""
    claude_id = "10000000-1111-4111-8111-111111111111"
    codex_id = "20000000-2222-4222-8222-222222222222"
    claude_path = _write_source(claude_id)
    codex_path = _write_codex_source(codex_id)
    os.utime(claude_path, ns=(10_000_000_000, 20_000_000_000))
    os.utime(codex_path, ns=(10_000_000_001, 30_000_000_000))

    payload = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--max-sources",
        "1",
        "--order",
        "newest",
        "--json",
    )
    inspection = _inspection(payload)
    assert payload["ok"] is True
    assert inspection["sources_total"] == 2
    assert inspection["sources_processed"] == 1
    assert inspection["sources_done"] == 1

    index = _run(monkeypatch, capsys, "usage", "inspect-index", "--json")
    assert [item["session_id"] for item in index["sessions"]] == [codex_id]


@pytest.mark.parametrize("already_captured_newest", [False, True])
def test_global_source_order_interleaves_harnesses(tmp_data_home, monkeypatch, capsys, already_captured_newest):
    newest_id = "10000000-1111-4111-8111-111111111111"
    middle_id = "20000000-2222-4222-8222-222222222222"
    oldest_id = "30000000-3333-4333-8333-333333333333"
    newest = _write_source(newest_id)
    middle = _write_codex_source(middle_id)
    oldest = _write_source(oldest_id)
    for path, stamp in ((newest, 30), (middle, 20), (oldest, 10)):
        os.utime(path, ns=(stamp * 10**9, stamp * 10**9))
    continuation = []
    if already_captured_newest:
        first = _run(monkeypatch, capsys, "usage", "scan-sessions", "--max-sources", "1", "--json")
        continuation = ["--scan-id", first["inspection"]["scan_id"]]
    result = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--max-sources",
        "1" if already_captured_newest else "2",
        "--order",
        "newest",
        *continuation,
        "--json",
    )
    assert result["inspection"]["sources_total"] == 3
    assert result["inspection"]["sources_done"] == 2
    assert result["inspection"]["sources_pending"] == 1
    index = _run(monkeypatch, capsys, "usage", "inspect-index", "--json")
    assert {item["session_id"] for item in index["sessions"]} == {newest_id, middle_id}


def test_failed_source_stays_incomplete_until_one_shot_retry_succeeds(tmp_data_home, monkeypatch, capsys):
    """A failed source remains unresolved; retry enables exactly one attempt."""
    paths = _seed_sources()
    from skill_hub.infrastructure.usage import usage_inspection_claude

    real_capture = usage_inspection_claude.capture_claude_source
    attempts = 0

    def fail_one(source, cursor, host, *, deadline=None):
        nonlocal attempts
        assert isinstance(source, ReaderSource)
        if Path(source.lexical_path) == paths[0]:
            attempts += 1
            raise TimeoutError("fixture source stalled")
        return real_capture(source, cursor, host, deadline=deadline)

    monkeypatch.setattr(usage_inspection_claude, "capture_claude_source", fail_one)
    first = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    first_i = _inspection(first)
    assert first["ok"] is False
    assert first_i["sources_total"] == 2
    assert first_i["sources_done"] == 1
    assert first_i["sources_pending"] == 0
    assert first_i["sources_incomplete"] == 1
    assert first_i["partial"] is True
    assert any(error["kind"] == "TimeoutError" for error in first_i["errors"])
    scan_id = first_i["scan_id"]

    # A continuation does not implicitly retry an incomplete source.
    second = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--json",
    )
    second_i = _inspection(second)
    assert second["ok"] is False
    assert second_i["scan_id"] == scan_id
    assert second_i["sources_incomplete"] == 1
    assert attempts == 1

    # Explicit retry clears the source error after its successful commit.
    monkeypatch.setattr(usage_inspection_claude, "capture_claude_source", real_capture)
    retried = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--retry-incomplete",
        "--json",
    )
    retried_i = _inspection(retried)
    assert retried["ok"] is True
    assert retried_i["scan_id"] == scan_id
    assert retried_i["sources_done"] == 2
    assert retried_i["sources_incomplete"] == 0
    assert retried_i["errors"] == []


def test_repeated_retry_failure_stays_stopped_until_another_explicit_retry(tmp_data_home, monkeypatch, capsys):
    """A second timeout is not retried again by ordinary continuation."""
    paths = _seed_sources(count=1)
    from skill_hub.infrastructure.usage import usage_inspection_claude

    attempts = 0

    def always_fail(source, cursor, host, *, deadline=None):
        nonlocal attempts
        assert isinstance(source, ReaderSource)
        if Path(source.lexical_path) == paths[0]:
            attempts += 1
            raise TimeoutError("fixture source stalled")
        raise AssertionError(f"unexpected source {source.lexical_path}")

    monkeypatch.setattr(usage_inspection_claude, "capture_claude_source", always_fail)
    first = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    scan_id = _inspection(first)["scan_id"]
    assert attempts == 1

    second = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--retry-incomplete",
        "--json",
    )
    assert second["ok"] is False
    assert _inspection(second)["sources_incomplete"] == 1
    assert attempts == 2

    continued = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--json",
    )
    assert continued["ok"] is False
    assert _inspection(continued)["sources_incomplete"] == 1
    assert attempts == 2


def test_retry_authorization_survives_a_quota_limited_chunk(tmp_data_home, monkeypatch, capsys):
    """Retry remains armed when its source must wait for a later chunk."""
    paths = _seed_sources()
    from skill_hub.infrastructure.usage import usage_inspection_claude

    real_capture = usage_inspection_claude.capture_claude_source
    attempts = 0
    allow_success = False

    def fail_until_explicit_retry(source, cursor, host, *, deadline=None):
        nonlocal attempts
        assert isinstance(source, ReaderSource)
        if Path(source.lexical_path) == paths[0]:
            attempts += 1
            if not allow_success:
                raise TimeoutError("fixture source stalled")
        return real_capture(source, cursor, host, deadline=deadline)

    monkeypatch.setattr(usage_inspection_claude, "capture_claude_source", fail_until_explicit_retry)
    first = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    scan_id = _inspection(first)["scan_id"]
    assert _inspection(first)["sources_incomplete"] == 1
    assert attempts == 1

    # Explicit retry arms the failed source, but this chunk has no quota.
    allow_success = True
    armed = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--retry-incomplete",
        "--max-sources",
        "0",
        "--json",
    )
    assert armed["ok"] is False
    assert _inspection(armed)["sources_incomplete"] == 0
    assert _inspection(armed)["sources_pending"] == 1
    assert _inspection(armed)["errors"]
    assert attempts == 1

    continued = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--max-sources",
        "1",
        "--json",
    )
    assert continued["ok"] is True
    assert _inspection(continued)["sources_done"] == 2
    assert _inspection(continued)["sources_incomplete"] == 0
    assert attempts == 2


def test_retry_requires_scan_id(tmp_data_home, monkeypatch, capsys):
    payload = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--retry-incomplete",
        "--json",
    )
    assert payload["ok"] is False
    assert "scan" in str(payload.get("error", "")).lower()


def test_unknown_scan_id_is_explicit_json_failure(tmp_data_home, monkeypatch, capsys):
    payload = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        "scan:does-not-exist",
        "--json",
    )
    assert payload["ok"] is False
    inspection = _inspection(payload)
    assert any(error["kind"] == "unknown_scan_id" for error in inspection["errors"])


def test_incompatible_reader_binding_is_explicit_json_failure(tmp_data_home, monkeypatch, capsys):
    _seed_sources(count=1)
    first = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    scan_id = _inspection(first)["scan_id"]
    db_path = hub_core.data_home() / "state" / "usage" / "inspection.sqlite3"
    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE scan_passes SET reader_bindings = ? WHERE scan_id = ?",
            (json.dumps({"claude-code": {"reader": "incompatible", "revision": 99}}), scan_id),
        )
        db.commit()

    payload = _run(
        monkeypatch,
        capsys,
        "usage",
        "scan-sessions",
        "--scan-id",
        scan_id,
        "--json",
    )
    assert payload["ok"] is False
    assert any(
        error["kind"] in {"incompatible_bindings", "incompatible_reader_bindings"}
        for error in _inspection(payload)["errors"]
    )


def test_replan_pass_error_is_json_soft_result_and_has_scan_identity(
    tmp_data_home, monkeypatch, capsys
):
    from skill_hub.application.usage import usage_inspection_scan

    monkeypatch.setattr(
        usage_inspection_scan,
        "capture_pass",
        lambda *args, **kwargs: {
            "scan_id": "scan:replan",
            "state": "replan_required",
            "partial": True,
            "errors": [{"kind": "replan_required", "reason": "reader_unavailable"}],
            "accounting": {},
            "summary": {},
            "sources_processed": 0,
            "bytes_read": 0,
        },
    )

    payload = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")

    assert payload["ok"] is False
    assert payload["state"] == "replan_required"
    assert payload["partial"] is True
    assert payload["scan_id"] == "scan:replan"
    assert payload["inspection"]["state"] == "replan_required"


def test_replan_pass_error_is_plain_cli_soft_result(monkeypatch, capsys):
    from skill_hub.application.usage import usage_inspection_scan

    monkeypatch.setattr(
        usage_inspection_scan,
        "capture_pass",
        lambda *args, **kwargs: {
            "scan_id": "scan:replan",
            "state": "replan_required",
            "partial": True,
            "errors": [{"kind": "replan_required", "reason": "reader_unavailable"}],
            "accounting": {},
            "summary": {},
            "sources_processed": 0,
            "bytes_read": 0,
        },
    )
    monkeypatch.setattr(sys, "argv", ["hub", "usage", "scan-sessions"])

    hub.main()

    output = capsys.readouterr().out
    assert "usage scan pass: replan_required (reader_unavailable)" in output
    assert "Start a new pass without --scan-id." in output


def test_source_reader_replan_keeps_reason_scan_identity_and_plain_guidance(
    tmp_data_home, monkeypatch, capsys
):
    from skill_hub.application.usage import usage_inspection_scan
    from skill_hub.domain.usage.usage_reader_resolution import ReplanRequired

    _seed_sources(count=1)

    def unavailable(*args, **kwargs):
        raise ReplanRequired("reader_unavailable")

    monkeypatch.setattr(usage_inspection_scan, "resolve_source_reader", unavailable)
    payload = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")

    assert payload["state"] == "replan_required"
    assert payload["partial"] is True
    error = next(item for item in payload["errors"] if item["kind"] == "replan_required")
    assert error["reason"] == "reader_unavailable"
    assert error["scan_id"] == payload["scan_id"] == payload["inspection"]["scan_id"]

    monkeypatch.setattr(sys, "argv", ["hub", "usage", "scan-sessions"])
    hub.main()
    output = capsys.readouterr().out
    assert "reader_unavailable" in output
    assert "Start a new pass without --scan-id." in output


def test_prune_cli_dry_run_is_read_only_and_write_persists_defaults(tmp_data_home, monkeypatch, capsys):
    from skill_hub.infrastructure.usage.usage_inspection_store import db_path, load_retention_config

    preview = _run(
        monkeypatch,
        capsys,
        "usage",
        "inspect",
        "prune",
        "--older-than",
        "14",
        "--max-store-bytes",
        "1048576",
        "--dry-run",
        "--vacuum",
        "--json",
    )
    assert preview["ok"] is True
    assert not db_path().exists()
    config = tmp_data_home / "state/usage/inspection-retention.json"
    assert not config.exists()
    written = _run(
        monkeypatch,
        capsys,
        "usage",
        "inspect",
        "prune",
        "--older-than",
        "14",
        "--max-store-bytes",
        "1048576",
        "--vacuum",
        "--json",
    )
    assert written["ok"] is True
    assert load_retention_config() == {"older_than_days": 14, "max_store_bytes": 1048576}
    before = (db_path().read_bytes(), config.read_bytes())
    preview = _run(monkeypatch, capsys, "usage", "inspect", "prune", "--dry-run", "--json")
    assert preview["ok"] is True
    assert (db_path().read_bytes(), config.read_bytes()) == before


def test_cancelled_cli_pass_resumes_committed_sources(tmp_data_home, monkeypatch, capsys):
    from skill_hub.application.usage import usage_inspection

    _seed_sources(count=3)
    capture = usage_inspection.capture_scan_source
    attempts = 0

    def interrupt_second(source, build, store=None, reader_policy=None, enrichment=None):
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise KeyboardInterrupt
        return capture(source, build, store, reader_policy, enrichment)

    with monkeypatch.context() as patch:
        patch.setattr(usage_inspection, "capture_scan_source", interrupt_second)
        interrupted = _inspection(_run(patch, capsys, "usage", "scan-sessions", "--json"))
    assert interrupted["state"] == "cancelled"
    assert (interrupted["sources_done"], interrupted["sources_pending"]) == (1, 2)
    resumed = _inspection(
        _run(
            monkeypatch,
            capsys,
            "usage",
            "scan-sessions",
            "--scan-id",
            interrupted["scan_id"],
            "--json",
        )
    )
    assert resumed["state"] == "complete"
    assert resumed["scan_id"] == interrupted["scan_id"]
    assert resumed["sources_processed"] == 2
    assert resumed["sources_skipped_unchanged"] == 1
    assert resumed["sources_done"] == 3
