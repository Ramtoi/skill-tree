"""The app parity fixture must come from actual native capture."""
import json
from pathlib import Path

from skill_hub.application.usage.usage_inspection import index_payload, merge_capture
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source


def test_native_display_fixture_matches_capture(tmp_data_home, tmp_path):
    fixture_path = Path(__file__).parent / "fixtures/usage_native_parity.json"
    fixture = json.loads(fixture_path.read_text())
    app_fixture = fixture_path.parents[2] / "app/src/test/fixtures/usage_native_parity.json"
    assert fixture_path.read_bytes() == app_fixture.read_bytes()
    source = tmp_path / (fixture["session_id"] + ".jsonl")
    source.write_text("".join(json.dumps(row) + "\n" for row in fixture["records"]))
    assert merge_capture(capture_claude_source(source)).outcome == "captured"
    item = index_payload()["sessions"][0]
    assert item["native"]["own"] == fixture["native"]["own"]
    assert item["latest_pr"] == fixture["latest_pr"]
