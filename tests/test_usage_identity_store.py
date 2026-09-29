"""Focused host identity invariants for retained inspection data."""

import json
from pathlib import Path

from skill_hub.application.usage.usage_inspection import index_payload, merge_capture
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, db_path


def _capture(path: Path, root: str, child: str, tokens: int):
    path.write_text(json.dumps({
        "type": "assistant", "uuid": f"record-{root}", "isSidechain": True, "agentId": child,
        "message": {"id": f"message-{root}", "usage": {"input_tokens": tokens}, "content": [
            {"type": "tool_use", "id": f"call-{root}", "name": "Bash", "input": {"command": f"echo {root}"}}
        ]},
    }) + "\n")
    return capture_claude_source(path)


def test_same_native_child_id_is_root_scoped(tmp_data_home, tmp_path):
    assert db_path().is_relative_to(tmp_data_home)
    for root, tokens in (("root-one", 11), ("root-two", 29)):
        merge_capture(_capture(tmp_path / f"{root}.jsonl", root, "short-child", tokens))
    items = {item["session_id"]: item for item in index_payload()["sessions"]}
    assert items["root-one"]["agents"][0]["scopes"]["own"]["tokens"]["total"] == 11
    assert items["root-two"]["agents"][0]["scopes"]["own"]["tokens"]["total"] == 29
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT count(*) FROM run_members").fetchone()[0] == 2
        assert store.db.execute("SELECT count(DISTINCT logical_id) FROM run_members").fetchone()[0] == 2


def test_two_native_samples_with_equal_values_remain_distinct(tmp_data_home, tmp_path):
    path = tmp_path / "root.jsonl"
    records = [
        {"type": "assistant", "uuid": f"record-{i}", "isSidechain": True, "agentId": "short-child",
         "message": {"id": f"message-{i}", "usage": {"input_tokens": 10}, "content": []}}
        for i in (1, 2)
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")
    merge_capture(capture_claude_source(path))
    child = index_payload()["sessions"][0]["agents"][0]
    assert child["scopes"]["own"]["tokens"]["total"] == 20
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT count(*) FROM token_samples").fetchone()[0] == 2


def test_malformed_native_ref_is_rejected_without_writes(tmp_data_home):
    from dataclasses import replace

    from skill_hub.domain.usage.usage_inspection_capture import NativeRunRef

    batch = _capture(Path(tmp_data_home) / "invalid.jsonl", "invalid", "child", 1)
    run = replace(batch.runs[-1], native_ref=NativeRunRef("other-root", "child", "inline_sidechain"))
    invalid = replace(batch, runs=(*batch.runs[:-1], run))
    try:
        merge_capture(invalid)
    except Exception as exc:  # store contract rejects before durable writes
        assert getattr(exc, "reason", None) == "invalid_native_identity"
    else:
        raise AssertionError("malformed native identity was accepted")
