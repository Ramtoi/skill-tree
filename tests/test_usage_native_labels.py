from __future__ import annotations

import json

from skill_hub.application.usage.usage_inspection import index_payload, merge_capture
from skill_hub.infrastructure.usage.usage_inspection_claude import _safe_native_label, capture_claude_source


def test_native_label_rejects_embedded_local_path_markers_and_preserves_safe_labels():
    assert _safe_native_label("feature/foo", 120) == "feature/foo"
    assert _safe_native_label("réparer/échec", 120) == "réparer/échec"
    assert _safe_native_label("feature /workspace/private", 120) is None
    assert _safe_native_label("feature ~/private", 120) is None
    assert _safe_native_label("feature C:\\Users\\private", 120) is None


def test_capture_does_not_persist_invalid_branch_label_in_resume_or_index(tmp_data_home, tmp_path):
    path = tmp_path / "native-label.jsonl"
    raw = "feature /workspace/private"
    path.write_text(json.dumps({"type": "user", "gitBranch": raw}) + "\n")
    batch = capture_claude_source(path)
    assert batch.runs[0].native_branch is None
    assert raw not in batch.source.resume_state
    merge_capture(batch)
    native = index_payload()["sessions"][0]["native"]["own"]
    assert native["branch"] is None
    assert raw not in json.dumps(index_payload())


def test_capture_accepts_valid_unicode_branch_and_rejects_invalid_pr_link(tmp_path):
    path = tmp_path / "valid-label.jsonl"
    path.write_text("\n".join([
        json.dumps({"type": "user", "gitBranch": "réparer/échec"}),
        json.dumps({"type": "pr-link", "prNumber": True, "prUrl": "https://github.com/acme/repo/pull/1"}),
        json.dumps({"type": "pr-link", "prNumber": 2, "prUrl": "https://github.com/acme/repo/pull/2 with-secret"}),
    ]) + "\n")
    batch = capture_claude_source(path)
    assert batch.runs[0].native_branch == "réparer/échec"
    assert batch.prs == ()
