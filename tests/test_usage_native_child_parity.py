"""Capture-backed parity for inline child native scopes."""
import json
from pathlib import Path

from skill_hub.application.usage.usage_inspection import index_payload, merge_capture
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source


def test_inline_child_scopes_and_pr_come_from_capture(tmp_data_home, tmp_path):
    fixture_path = Path(__file__).parent / "fixtures/usage_native_child_parity.json"
    fixture = json.loads(fixture_path.read_text())
    app_fixture = fixture_path.parents[2] / "app/src/test/fixtures/usage_native_child_parity.json"
    assert fixture_path.read_bytes() == app_fixture.read_bytes()

    source = tmp_path / "root-session.jsonl"
    source.write_text("".join(json.dumps(row) + "\n" for row in fixture["records"]))
    assert merge_capture(capture_claude_source(source)).outcome == "captured"

    item = index_payload()["sessions"][0]
    expected = fixture["expected"]
    for scope_name in ("root", "children", "subtree"):
        scope = item["native"]["own" if scope_name == "root" else scope_name]
        tokens = item["scopes"]["own" if scope_name == "root" else scope_name]["tokens"]
        assert scope == expected[scope_name]["native"]
        assert scope["lines_added"] == expected[scope_name]["lines_added"]
        assert scope["tool_calls"] == expected[scope_name]["tool_calls"]
        assert tokens["total"] == expected[scope_name]["tokens_total"]

    child = next(agent for agent in item["agents"] if agent["session_id"] == "shortagent")
    assert child["native"]["own"] == expected["child"]["native"]
    assert child["native"]["own"]["lines_added"] == expected["child"]["lines_added"]
    assert child["native"]["own"]["tool_calls"] == expected["child"]["tool_calls"]
    assert child["scopes"]["own"]["tokens"]["total"] == expected["child"]["tokens_total"]
    assert child["latest_pr"]["number"] == expected["child"]["pr_number"]
    assert item["latest_pr"]["number"] == expected["child"]["pr_number"]
