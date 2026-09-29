from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from skill_hub import hub_core
from skill_hub.application.usage import usage_inspection_scan


def _registry() -> None:
    (hub_core.data_home() / "registry.yaml").write_text(
        "version: '1'\nharnesses_global: []\nprojects: {}\nskills: {}\n"
    )


def _claude_source(path: Path, session_id: str, *, timestamp: str = "2026-09-01T00:00:00Z") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "type": "user",
            "uuid": f"{session_id}-user",
            "timestamp": timestamp,
            "sessionId": session_id,
            "cwd": "/workspace",
            "message": {"role": "user", "content": "hello"},
        },
        {
            "type": "assistant",
            "uuid": f"{session_id}-assistant",
            "timestamp": timestamp,
            "sessionId": session_id,
            "cwd": "/workspace",
            "message": {
                "id": f"message-{session_id}",
                "model": "fixture-model",
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        },
    ]
    path.write_text("".join(json.dumps(record) + "\n" for record in records))


def test_capture_pass_reports_per_harness_accounting_across_chunks(tmp_data_home):
    _registry()
    root = Path.home() / ".claude" / "projects" / "-usage-stats"
    paths = []
    for index in range(2):
        session_id = f"{index + 1:08d}-1111-4111-8111-111111111111"
        path = root / f"{session_id}.jsonl"
        _claude_source(path, session_id)
        paths.append(path)
    (root / "not-a-session.jsonl").write_text("garbage\n")

    first = usage_inspection_scan.capture_pass(
        {"claude-code": root}, max_sources=1, order="path"
    )
    stats = first["accounting"]["claude-code"]
    assert stats["sources_total"] == 2
    assert stats["new"] == 1
    assert stats["processed"] == 1
    assert stats["pending"] == 1
    assert stats["skipped"] == 1
    assert stats["bytes_read"] == paths[0].stat().st_size
    assert stats["errors"] == 0

    resumed = usage_inspection_scan.capture_pass(
        {"claude-code": root}, scan_id=first["scan_id"], max_sources=1, order="path"
    )
    stats = resumed["accounting"]["claude-code"]
    assert stats["sources_total"] == 2
    assert stats["new"] == 1
    assert stats["unchanged"] == 1
    assert stats["processed"] == 1
    assert stats["skipped"] == 2
    assert stats["pending"] == 0
    assert stats["bytes_read"] == paths[1].stat().st_size

    unchanged = usage_inspection_scan.capture_pass({"claude-code": root}, order="path")
    stats = unchanged["accounting"]["claude-code"]
    assert stats["new"] == 0
    assert stats["unchanged"] == 2
    assert stats["processed"] == 0
    assert stats["skipped"] == 3
    assert stats["bytes_read"] == 0


def test_capture_pass_counts_growth_of_a_frozen_source(tmp_data_home):
    _registry()
    session_id = "aaaaaaaa-2222-4222-8222-222222222222"
    root = Path.home() / ".claude" / "projects" / "-usage-stats"
    path = root / f"{session_id}.jsonl"
    _claude_source(path, session_id)
    now = datetime(2026, 9, 10, tzinfo=timezone.utc)

    first = usage_inspection_scan.capture_pass({"claude-code": root}, now=now)
    assert first["accounting"]["claude-code"]["new"] == 1

    with path.open("a") as stream:
        stream.write(
            json.dumps(
                {
                    "type": "user",
                    "uuid": f"{session_id}-follow-up",
                    "timestamp": "2026-09-02T00:00:00Z",
                    "sessionId": session_id,
                    "message": {"role": "user", "content": "follow-up"},
                }
            )
            + "\n"
        )

    second = usage_inspection_scan.capture_pass({"claude-code": root}, now=now)
    stats = second["accounting"]["claude-code"]
    assert stats["appended"] == 1
    assert stats["processed"] == 1
    assert stats["frozen_growth"] == 1
    assert stats["skipped"] == 0
    assert stats["bytes_read"] > 0


def test_discovery_keeps_rejected_accounting_when_accepted_file_vanishes(tmp_path, monkeypatch):
    session = "cccccccc-4444-4444-8444-444444444444"
    vanished = tmp_path / f"{session}.jsonl"
    rejected = tmp_path / "sessions-index.jsonl"
    original_stat = Path.stat

    def stat(path, *args, **kwargs):
        if path == vanished:
            raise FileNotFoundError(path)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)
    accounting = {"claude-code": {"skipped": 0}}
    monkeypatch.setattr(
        usage_inspection_scan,
        "iter_source_candidates",
        lambda _harness, _root: iter(((vanished, True), (rejected, False))),
    )

    sources = usage_inspection_scan._discover_with_accounting(
        {"claude-code": tmp_path}, accounting
    )

    assert sources == []
    assert accounting["claude-code"]["skipped"] == 1


def test_codex_identity_error_is_reported_without_publishing(tmp_data_home):
    _registry()
    session_id = "bbbbbbbb-3333-4333-8333-333333333333"
    root = Path.home() / ".codex" / "sessions" / "2026" / "09" / "17"
    path = root / f"rollout-2026-09-17T08-10-00-{session_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "type": "session_meta",
                "payload": {"id": "wrong", "cwd": "/workspace"},
            }
        )
        + "\n"
    )

    result = usage_inspection_scan.capture_pass({"codex": root})
    stats = result["accounting"]["codex"]
    assert stats["errors"] == 1
    assert stats["stopped_on"] == path.name
    assert result["errors"][0]["kind"] == "identity_mismatch"
    with usage_inspection_scan.usage_inspection._store() as store:
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0
