"""Tests for the claude-code `effort` safe field (delegation tiers work):
`validate_agent` enum enforcement, and its round-trip through
`split_safe_advanced` / `build_frontmatter`.

The Claude home isolation and validate_agent contract are owned by
test_subagents.py; this file only covers the new `effort` field so it does
not need to touch that file.
"""

from __future__ import annotations

from skill_hub.infrastructure.harnesses import subagents


def _v(fm, **kw):
    return subagents.validate_agent(fm, kw.pop("scope", "user"),
                                    kw.pop("project", None), kw.pop("registry", None), **kw)


def test_validate_effort_enum():
    assert _v({"name": "a", "description": "d", "effort": "low"})["valid"]
    assert _v({"name": "a", "description": "d", "effort": "medium"})["valid"]
    assert _v({"name": "a", "description": "d", "effort": "high"})["valid"]
    assert _v({"name": "a", "description": "d", "effort": "xhigh"})["valid"]
    assert _v({"name": "a", "description": "d", "effort": "max"})["valid"]
    assert _v({"name": "a", "description": "d", "effort": ""})["valid"]


def test_validate_effort_bad_value_is_error():
    result = _v({"name": "a", "description": "d", "effort": "ultra"})
    assert not result["valid"]
    assert any(w["field"] == "effort" and w["level"] == "error" for w in result["warnings"])


def test_split_and_build_frontmatter_round_trip_effort():
    fm = {"name": "a", "description": "d", "model": "sonnet", "effort": "medium"}
    safe, advanced_yaml = subagents.split_safe_advanced(fm)
    assert safe["effort"] == "medium"

    built_fm, warnings = subagents.build_frontmatter(safe, advanced_yaml)
    assert built_fm["effort"] == "medium"
    assert warnings == []


def test_build_frontmatter_omits_empty_effort():
    safe = {"name": "a", "description": "d", "model": "sonnet", "effort": ""}
    built_fm, _ = subagents.build_frontmatter(safe, "")
    assert "effort" not in built_fm
