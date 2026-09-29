"""Tests for `mcp_catalog.py` — the capability-catalogue payload: record
shape, JSON-Schema flattening, sanitising, and the on-disk store (plans/G.md
§5.6-5.10, §11.5).

Pure and synchronous — no fixture server needed. Table-driven cases come
from `tests/fixtures/mcp_catalog_corpus.json`, written from the plan's spec
text (§5.7, §5.10), never from running this module's own code.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "mcp_catalog_corpus.json"


def _corpus() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
# flatten_parameters — §5.7's table
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _corpus()["flatten_parameters_cases"], ids=lambda c: c["id"])
def test_flatten_parameters_corpus(case):
    from skill_hub.infrastructure.mcp import mcp_catalog

    params, unreadable, truncated = mcp_catalog.flatten_parameters(case["input_schema"])
    expect = case["expect"]
    assert params == expect["params"], case["id"]
    assert unreadable is expect["unreadable"], case["id"]
    assert truncated is expect["truncated"], case["id"]


def test_flatten_parameters_param_limit_truncates_at_100():
    """§5.7: more than `PARAM_LIMIT` (100) properties keeps only the first
    100, in declaration order, and sets `parameters_truncated: true`. The
    expected names are computed from the spec's OWN rule ("first 100"), not
    from running the function and capturing its output."""
    from skill_hub.infrastructure.mcp import mcp_catalog

    properties = {f"p{i}": {"type": "string"} for i in range(101)}
    input_schema = {"type": "object", "properties": properties}

    params, unreadable, truncated = mcp_catalog.flatten_parameters(input_schema)

    assert unreadable is False
    assert truncated is True
    assert len(params) == 100
    assert [p["name"] for p in params] == [f"p{i}" for i in range(100)]


# ─────────────────────────────────────────────────────────────────────────────
# sanitize_text — §5.10's control-character classes
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _corpus()["sanitize_text_cases"], ids=lambda c: c["id"])
def test_sanitize_text_corpus(case):
    from skill_hub.infrastructure.mcp import mcp_catalog

    assert mcp_catalog.sanitize_text(case["input"]) == case["expect"], case["id"]


def test_sanitize_text_bounds_to_text_limit():
    from skill_hub.infrastructure.mcp import mcp_catalog

    long_text = "x" * (mcp_catalog.TEXT_LIMIT + 500)
    result = mcp_catalog.sanitize_text(long_text)
    assert result is not None
    assert len(result) == mcp_catalog.TEXT_LIMIT


def test_sanitize_text_non_string_and_none():
    from skill_hub.infrastructure.mcp import mcp_catalog

    assert mcp_catalog.sanitize_text(None) is None
    assert mcp_catalog.sanitize_text(42) is None
    assert mcp_catalog.sanitize_text([]) is None


def test_sanitize_text_ansi_in_cli_table(capsys):
    """S-10: an ANSI-bearing description must not rewrite the CLI's human
    table — the ESC byte is stripped so the escape sequence can no longer
    move the cursor, even though the bracket/digit text after it remains."""
    from skill_hub.infrastructure.mcp import mcp_catalog

    desc = "\x1b[2J\x1b[H" + "wiped"
    cleaned = mcp_catalog.sanitize_text(desc)
    assert "\x1b" not in cleaned
    assert "wiped" in cleaned


# ─────────────────────────────────────────────────────────────────────────────
# catalog_path — §5.9's traversal surface
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _corpus()["catalog_path_cases"], ids=lambda c: c["id"])
def test_catalog_path_corpus(case, tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_catalog

    if case["expect"] == "refused":
        with pytest.raises(SystemExit):
            mcp_catalog.catalog_path(case["name"])
    else:
        path = mcp_catalog.catalog_path(case["name"])
        assert path.name == f"{case['name']}.json"
        assert path.parent == mcp_catalog.catalog_dir()


def test_catalog_path_validates_before_building_any_path(tmp_data_home, monkeypatch):
    """§5.9: `validate_slug` runs BEFORE `catalog_dir()` is even consulted —
    a traversal name must never reach `Path.__truediv__` at all."""
    from skill_hub.infrastructure.mcp import mcp_catalog

    def _boom():
        raise AssertionError("catalog_dir() must not be called for an invalid name")

    monkeypatch.setattr(mcp_catalog, "catalog_dir", _boom)
    with pytest.raises(SystemExit):
        mcp_catalog.catalog_path("../etc/passwd")


# ─────────────────────────────────────────────────────────────────────────────
# The store — read/write/delete roundtrip + corrupt-file handling
# ─────────────────────────────────────────────────────────────────────────────


def test_catalog_store_roundtrip(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_catalog

    record = {"schema_version": 1, "name": "demo", "tools": []}
    mcp_catalog.write_catalog("demo", record)

    assert mcp_catalog.read_catalog("demo") == record
    assert mcp_catalog.catalog_path("demo").exists()

    mcp_catalog.delete_catalog("demo")
    assert mcp_catalog.read_catalog("demo") is None


def test_catalog_delete_is_idempotent(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_catalog

    mcp_catalog.delete_catalog("never-existed")  # must not raise


def test_read_catalog_corrupt_json_reads_as_none(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_catalog

    path = mcp_catalog.catalog_path("demo")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")

    assert mcp_catalog.read_catalog("demo") is None


def test_read_catalog_binary_garbage_reads_as_none(tmp_data_home):
    """C-1 (mirrors the probe cache's own case): non-UTF-8 bytes raise
    `UnicodeDecodeError` at `read_text`, not `JSONDecodeError` — the
    contract must hold for this shape too."""
    from skill_hub.infrastructure.mcp import mcp_catalog

    path = mcp_catalog.catalog_path("demo")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfe not utf-8")

    assert mcp_catalog.read_catalog("demo") is None


def test_read_catalog_non_dict_json_reads_as_none(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_catalog

    path = mcp_catalog.catalog_path("demo")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[1, 2, 3]", encoding="utf-8")

    assert mcp_catalog.read_catalog("demo") is None


def test_read_catalog_missing_file_reads_as_none(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_catalog

    assert mcp_catalog.read_catalog("nope") is None


# ─────────────────────────────────────────────────────────────────────────────
# build_record / summarize — rev 3 §11.5 fields
# ─────────────────────────────────────────────────────────────────────────────


def test_build_record_annotations_null_vs_false():
    """§11.5: an annotation the server did not declare is `None`, distinct
    from an explicit `False` — pins the rev-3 corpus addition."""
    from skill_hub.infrastructure.mcp import mcp_catalog

    raw_tools = [
        {
            "name": "delete_thing",
            "annotations": {"readOnlyHint": True},  # only one of four declared
        }
    ]
    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        raw_tools=raw_tools,
        offered={"tools": True},
        truncated={},
        fetch_errors=[],
    )
    ann = record["tools"][0]["annotations"]
    assert ann["read_only"] is True
    assert ann["destructive"] is None
    assert ann["idempotent"] is None
    assert ann["open_world"] is None


def test_build_record_annotations_explicit_false_is_not_none():
    from skill_hub.infrastructure.mcp import mcp_catalog

    raw_tools = [
        {
            "name": "read_thing",
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": False,
            },
        }
    ]
    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        raw_tools=raw_tools,
        offered={"tools": True},
        truncated={},
        fetch_errors=[],
    )
    ann = record["tools"][0]["annotations"]
    assert ann == {
        "read_only": True,
        "destructive": False,
        "idempotent": False,
        "open_world": False,
    }


def test_build_record_output_schema_present_but_unreadable():
    """§11.5 rev-3 addition: an `outputSchema` that IS present (so
    `output_schema_present: true`) but whose `properties` is not a dict must
    read `output_schema_unreadable: true`, distinct from a tool that
    declares no `outputSchema` at all."""
    from skill_hub.infrastructure.mcp import mcp_catalog

    raw_tools = [
        {"name": "no_output", "inputSchema": {"type": "object", "properties": {}}},
        {
            "name": "bad_output",
            "inputSchema": {"type": "object", "properties": {}},
            "outputSchema": {"type": "object", "properties": "not a dict"},
        },
        {
            "name": "good_output",
            "inputSchema": {"type": "object", "properties": {}},
            "outputSchema": {"type": "object", "properties": {"ok": {"type": "boolean"}}},
        },
    ]
    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        raw_tools=raw_tools,
        offered={"tools": True},
        truncated={},
        fetch_errors=[],
    )
    no_output, bad_output, good_output = record["tools"]

    assert no_output["output_schema_present"] is False
    assert no_output["output_schema_unreadable"] is False
    assert no_output["output_parameters"] == []

    assert bad_output["output_schema_present"] is True
    assert bad_output["output_schema_unreadable"] is True
    assert bad_output["output_parameters"] == []

    assert good_output["output_schema_present"] is True
    assert good_output["output_schema_unreadable"] is False
    assert good_output["output_parameters"][0]["name"] == "ok"


def test_build_record_title_falls_through_when_absent():
    from skill_hub.infrastructure.mcp import mcp_catalog

    raw_tools = [{"name": "x"}]
    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        server_title=None,
        raw_tools=raw_tools,
        offered={"tools": True},
        truncated={},
        fetch_errors=[],
    )
    assert record["server_title"] is None
    assert record["tools"][0]["title"] is None


def test_build_record_redacts_resource_uri_secrets():
    """§5.11: every `uri`/`uri_template` runs through
    `mcp_spec.redact_url_secrets` — a server-returned resource URI carrying
    a token in its query string must not leak it into the stored record."""
    from skill_hub.infrastructure.mcp import mcp_catalog

    raw_resources = [{"uri": "https://api.example/x?token=verysecrettoken1234"}]
    record = mcp_catalog.build_record(
        name="demo",
        transport="http",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        raw_resources=raw_resources,
        offered={"resources": True},
        truncated={},
        fetch_errors=[],
    )
    assert "verysecrettoken1234" not in record["resources"][0]["uri"]


def test_malformed_resource_uri_redaction_is_total():
    from skill_hub.domain.mcp import mcp_spec

    value = "http://user:pass@example.test:notaport/x"
    assert mcp_spec.redact_url_secrets(value) == value


def test_build_record_capabilities_are_key_names_only():
    from skill_hub.infrastructure.mcp import mcp_catalog

    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        capabilities={"tools": {"listChanged": True}, "resources": {}},
        offered={},
        truncated={},
        fetch_errors=[],
    )
    assert record["capabilities"] == ["resources", "tools"]


def test_build_record_bytes_limit_truncates_and_flags(monkeypatch):
    from skill_hub.infrastructure.mcp import mcp_catalog

    monkeypatch.setattr(mcp_catalog, "BYTES_LIMIT", 400)
    raw_tools = [{"name": f"tool_{i}", "description": "x" * 50} for i in range(20)]
    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        raw_tools=raw_tools,
        offered={"tools": True},
        truncated={},
        fetch_errors=[],
    )
    assert record["bytes_truncated"] is True
    assert record["truncated"]["tools"] is True
    assert len(record["tools"]) < len(raw_tools)
    assert len(json.dumps(record).encode("utf-8")) <= 400


def test_build_record_sanitizes_capability_keys():
    from skill_hub.infrastructure.mcp import mcp_catalog

    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        capabilities={"\x1b[31mtools\x1b[0m\n\u202e": {}},
        offered={},
        truncated={},
        fetch_errors=[],
    )
    assert record["capabilities"] == ["[31mtools[0m "]


def test_summarize_unknown_kinds_from_fetch_errors():
    from skill_hub.infrastructure.mcp import mcp_catalog

    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        raw_tools=[{"name": "a"}],
        offered={"tools": True, "resources": False, "resource_templates": False, "prompts": False},
        truncated={},
        fetch_errors=[{"method": "resources/list", "error": "boom"}],
    )
    summary = mcp_catalog.summarize(record)
    assert summary["tools"] == 1
    assert summary["unknown"] == ["resources"]
    assert summary["errors"] == 1
    assert summary["offered"]["resources"] is False


def test_summarize_instructions_is_a_bool_not_the_text():
    from skill_hub.infrastructure.mcp import mcp_catalog

    record = mcp_catalog.build_record(
        name="demo",
        transport="stdio",
        protocol_version="2025-06-18",
        protocol_fallback=False,
        instructions="Use responsibly.",
        offered={},
        truncated={},
        fetch_errors=[],
    )
    summary = mcp_catalog.summarize(record)
    assert summary["instructions"] is True
    assert "Use responsibly" not in json.dumps(summary)
