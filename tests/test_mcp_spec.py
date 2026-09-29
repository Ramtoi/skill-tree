"""skill_hub/domain/mcp/mcp_spec.py — the schema axis (plans/B.md wave B, unit B1, §5 cases 1-12).

`mcp_spec` is a stdlib-only leaf: none of these tests need `tmp_data_home` or
any harness fixture, they just exercise pure functions.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from skill_hub.domain.mcp import mcp_spec

CORPUS_PATH = Path(__file__).parent / "fixtures" / "mcp_secret_corpus.json"


def _corpus() -> dict:
    return json.loads(CORPUS_PATH.read_text(encoding="utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
# 1. transport reading
# ─────────────────────────────────────────────────────────────────────────────


def test_absent_transport_reads_as_stdio():
    cfg = {"mcp": {"command": "python3", "args": ["/x.py"], "env": {"A": "1"}}}
    spec = mcp_spec.spec_from_registry("n", cfg)
    assert spec.transport == "stdio"
    assert spec.command == "python3"
    assert spec.args == ["/x.py"]
    assert spec.env == {"A": "1"}


def test_absent_command_defaults_to_python3_and_warns():
    cfg = {"mcp": {"args": ["/x.py"]}}
    spec = mcp_spec.spec_from_registry("n", cfg)
    assert spec.command == "python3"

    errors, warnings = mcp_spec.validate_mcp_entry("n", cfg)
    assert errors == []
    assert any("defaulting to python3" in w for w in warnings)

    from skill_hub.domain.skills import skill_meta

    registry = {"skills": {"n": {"type": "mcp-server", "mcp": {"args": ["/x.py"]}}}}
    # Must not raise/exit — a stdio block with no command is legal.
    skill_meta.validate_registry_skills(registry)


def test_streamable_http_alias_maps_to_http():
    cfg = {"mcp": {"transport": "streamable-http", "url": "https://h/mcp"}}
    spec = mcp_spec.spec_from_registry("n", cfg)
    assert spec.transport == "http"


def test_ws_is_refused():
    with pytest.raises(mcp_spec.UnsupportedNativeEntry) as excinfo:
        mcp_spec.parse_native({"type": "ws", "url": "wss://h/mcp"})
    assert excinfo.value.reason == "ws_transport"


def test_parse_native_refuses_oauth_block():
    """review W7 — an OAuth-shaped key must refuse, never register an
    unauthenticated server."""
    with pytest.raises(mcp_spec.UnsupportedNativeEntry) as excinfo:
        mcp_spec.parse_native(
            {"command": "npx", "args": ["x"], "oauth": {"client_id": "abc"}}
        )
    assert excinfo.value.reason == "oauth_block"


def test_parse_native_refuses_headers_helper():
    """review W7 — `headers` must be a flat str->str map; anything else
    (a list, a nested object, a non-string value) is a shape hub cannot
    represent, not a header hub can silently drop."""
    with pytest.raises(mcp_spec.UnsupportedNativeEntry) as excinfo:
        mcp_spec.parse_native(
            {"type": "http", "url": "https://h/mcp", "headers": {"X": {"helper": "dynamic"}}}
        )
    assert excinfo.value.reason == "headers_helper"

    with pytest.raises(mcp_spec.UnsupportedNativeEntry) as excinfo:
        mcp_spec.parse_native({"type": "http", "url": "https://h/mcp", "headers": ["not", "a", "map"]})
    assert excinfo.value.reason == "headers_helper"


def test_ref_names_grammar():
    assert mcp_spec.ref_names("Bearer ${A}") == ["A"]
    assert mcp_spec.ref_names("${A}-${B}") == ["A", "B"]
    assert mcp_spec.ref_names("${A:-x}") == ["A"]
    assert mcp_spec.ref_names("$A") == []
    assert mcp_spec.ref_names("${1BAD}") == []


def test_looks_like_secret_from_corpus():
    corpus = _corpus()
    for case in corpus["cases"]:
        result = mcp_spec.looks_like_secret(case["key"], case["value"])
        assert result == case["secret"], case.get("note", case)


def test_secret_keys_in_spec_scans_url_query():
    spec = mcp_spec.McpServerSpec(
        name="n",
        transport="http",
        url="https://h/mcp?key=sk-live-abcdefgh12345678&mode=fast",
    )
    keys = mcp_spec.secret_keys_in_spec(spec)
    assert "url.query:key" in keys
    assert not any(k.endswith("mode") for k in keys)


def test_suggest_ref_keeps_the_auth_scheme():
    corpus = _corpus()
    for case in corpus["suggest"]:
        new_value, var_name = mcp_spec.suggest_ref(case["server"], case["key"], case["value"])
        assert new_value == case["expect_value"]
        assert var_name == case["expect_var"]


def test_validate_errors():
    cases = [
        ({"transport": "bogus"}, "unknown"),
        ({"transport": "http"}, "requires 'url'"),
        ({"transport": "sse"}, "requires 'url'"),
        ({"url": "https://h/mcp"}, "not valid on a stdio"),
        ({"headers": {"X": "1"}}, "not valid on a stdio"),
    ]
    for mcp_block, expect_substr in cases:
        errors, _warnings = mcp_spec.validate_mcp_entry("n", {"mcp": mcp_block})
        assert errors, mcp_block
        assert any(expect_substr in e for e in errors), (mcp_block, errors)

    # Nothing else errors: a well-formed stdio and http block are both clean.
    errors, _ = mcp_spec.validate_mcp_entry(
        "n", {"mcp": {"command": "python3", "args": ["/x.py"]}}
    )
    assert errors == []
    errors, _ = mcp_spec.validate_mcp_entry(
        "n", {"mcp": {"transport": "http", "url": "https://h/mcp"}}
    )
    assert errors == []


def test_validate_warns_on_ref_in_a_key():
    cfg = {"mcp": {"transport": "http", "url": "https://h/mcp", "headers": {"${K}": "v"}}}
    _errors, warnings = mcp_spec.validate_mcp_entry("n", cfg)
    assert any("reference in a key" in w for w in warnings)


def test_validate_warns_on_default_ref_form():
    cfg = {
        "mcp": {
            "transport": "http",
            "url": "https://h/mcp",
            "headers": {"Authorization": "Bearer ${TOKEN:-fallback}"},
        }
    }
    _errors, warnings = mcp_spec.validate_mcp_entry("n", cfg)
    assert any(":-default" in w for w in warnings)


def test_spec_to_registry_block_roundtrips():
    prior = {
        "runtime": "python",
        "command": "python3",
        "args": ["{source}/server.py"],
        "env": {"X": "1"},
    }
    spec = mcp_spec.spec_from_registry("n", {"mcp": prior})
    block = mcp_spec.spec_to_registry_block(spec, prior=prior)

    assert block["runtime"] == "python"
    assert block["command"] == "python3"
    assert block["args"] == ["{source}/server.py"]
    assert block["env"] == {"X": "1"}
    assert "transport" not in block  # stdio is the default, omitted

    spec2 = mcp_spec.spec_from_registry("n", {"mcp": block})
    assert spec2 == spec


def test_spec_from_registry_with_source_none():
    cfg = {
        "type": "mcp-server",
        "scope": "global",
        "source": None,
        "mcp": {
            "command": "python3",
            "args": ["/abs/skill_hub_mcp_server.py"],
            "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
        },
    }
    spec = mcp_spec.spec_from_registry("skill-hub", cfg, source=None)
    assert spec.args == ["/abs/skill_hub_mcp_server.py"]
    assert spec.command == "python3"
    assert spec.env == {"SKILL_HUB_ACTOR": "skill-hub-mcp"}


def test_inline_fallback_patterns_match_corpus_fixture():
    """The packaged-build fallback (no `tests/` dir) must never drift from
    the fixture (Risks table row in plans/B.md)."""
    assert mcp_spec._FALLBACK_PATTERNS == _corpus()["patterns"]


# ─────────────────────────────────────────────────────────────────────────────
# W4 — every `<raw>`/`<key>`/`<scheme>` detail is bounded and never a repr of
# an arbitrary native value.
# ─────────────────────────────────────────────────────────────────────────────


def test_dict_valued_type_never_leaks_its_contents_into_the_reason():
    """The review's own repro: `{"type": {"authorization": "Bearer sk-plant"}}`
    used to render as `unknown_transport:{'authorization': 'Bearer sk-plant'}`
    via `!r` — a credential-bearing native VALUE travelling straight into
    `reason`. A non-string `type` is now a categorical `malformed_field:type`
    regardless of what it contains."""
    token = "sk-plantedtoken1234567890abcdef"
    result = mcp_spec.normalize_native(
        {"type": {"authorization": f"Bearer {token}"}, "url": "https://h/mcp"}, name="srv"
    )
    assert result.spec is None
    assert result.reason == "malformed_field:type"
    assert token not in (result.reason or "")


def test_a_300_char_unknown_key_yields_a_bounded_warning():
    """`dropped_field:<key>` must stay short even when the native key is
    enormous — `_bounded_detail`'s ~40-char cap keeps the whole warning word
    at or under 60 chars (`dropped_field:` is 14 chars)."""
    long_key = "x" * 300
    result = mcp_spec.normalize_native({"command": "npx", long_key: 1}, name="srv")
    assert result.spec is not None
    warning = next(w for w in result.warnings if w.startswith("dropped_field:"))
    assert len(warning) <= 60, warning
    assert warning.endswith("…")


def test_bounded_detail_never_repr_s_a_non_string_value():
    assert mcp_spec._bounded_detail(123) == "int"
    assert mcp_spec._bounded_detail({"a": "b"}) == "dict"
    assert mcp_spec._bounded_detail(None) == "NoneType"


def test_bounded_detail_caps_length_with_an_ellipsis():
    long = "a" * 100
    bounded = mcp_spec._bounded_detail(long, limit=40)
    assert len(bounded) == 40
    assert bounded.endswith("…")


def test_bounded_detail_replaces_control_characters():
    bounded = mcp_spec._bounded_detail("a\x00b")
    assert "\x00" not in bounded
    assert bounded == "a�b"
