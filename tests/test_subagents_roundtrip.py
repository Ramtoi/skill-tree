"""Real-shape round-trip fixtures for subagents.py (claude-subagents-manager, task 1.11).

These are SYNTHETIC fixture .md files (NOT copies of the user's real personal agents
— this repo has a public mirror) that reproduce the tricky real-world frontmatter
shapes Claude Code agent files exhibit:

  (a) unquoted-colon-desc.md   — unquoted `description:` with embedded `: ` mid-sentence
                                  (breaks strict PyYAML → must hit the lenient fallback)
  (b) quoted-multiline-desc.md — long double-quoted description with embedded \\n escapes,
                                  `tools` as a CSV string, `model`, `color`
  (c) advanced-fields.md       — permissionMode/hooks/mcpServers/memory/maxTurns advanced
                                  keys (preservation + key order)
  (d) minimal.md               — only name + description + a one-line body
  (e) denylist-skills.md       — disallowedTools denylist mode + a skills: list

For each fixture: parse_agent → serialize_agent → parse_agent again, asserting
frontmatter dict equality, key-order preservation, and body equality. Also asserts
validate_agent marks each fixture valid (skill warnings are non-blocking).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import subagents

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "subagents"

FIXTURE_FILES = [
    "unquoted-colon-desc.md",
    "quoted-multiline-desc.md",
    "advanced-fields.md",
    "minimal.md",
    "denylist-skills.md",
]


@pytest.mark.parametrize("filename", FIXTURE_FILES)
def test_fixture_roundtrip(filename):
    """parse → serialize → parse preserves frontmatter dict, key order, and body."""
    text = (FIXTURES / filename).read_text()

    doc1 = subagents.parse_agent(text)
    serialized = subagents.serialize_agent(doc1["frontmatter"], doc1["body"])
    doc2 = subagents.parse_agent(serialized)

    # frontmatter dict equality
    assert doc2["frontmatter"] == doc1["frontmatter"], f"{filename}: frontmatter drifted"
    # key order preserved across the round-trip
    assert list(doc2["frontmatter"].keys()) == list(doc1["frontmatter"].keys()), \
        f"{filename}: key order drifted"
    # body equality
    assert doc2["body"] == doc1["body"], f"{filename}: body drifted"


@pytest.mark.parametrize("filename", FIXTURE_FILES)
def test_fixture_roundtrip_idempotent_second_pass(filename):
    """A second serialize→parse is a fixed point (no further drift)."""
    text = (FIXTURES / filename).read_text()
    doc1 = subagents.parse_agent(text)
    s1 = subagents.serialize_agent(doc1["frontmatter"], doc1["body"])
    p1 = subagents.parse_agent(s1)
    s2 = subagents.serialize_agent(p1["frontmatter"], p1["body"])
    assert s2 == s1, f"{filename}: serialize is not idempotent"


@pytest.mark.parametrize("filename", FIXTURE_FILES)
def test_fixture_validates_clean(filename):
    """Each fixture is well-formed → validate_agent marks it valid (warnings ok).

    Attached-skill resolution failures are *warnings*, never blocking, so the
    denylist-skills fixture (whose skills are not present in the empty test scope)
    is still valid:true.
    """
    text = (FIXTURES / filename).read_text()
    fm = subagents.parse_agent(text)["frontmatter"]
    res = subagents.validate_agent(fm, "user", None, None)
    assert res["valid"] is True, f"{filename}: unexpected errors {res['warnings']}"


def test_unquoted_colon_hits_lenient_fallback():
    """The unquoted `: ` description specifically must round-trip via the lenient path."""
    fm = subagents.parse_agent((FIXTURES / "unquoted-colon-desc.md").read_text())["frontmatter"]
    assert fm["name"] == "git-committer"
    assert fm["model"] == "haiku"
    # the embedded colons survived intact
    assert "Context:" in fm["description"]
    assert "you need to commit" in fm["description"]


def test_advanced_fields_preserved_and_ordered():
    """The advanced fixture preserves nested structures + advanced-after-safe order."""
    fm = subagents.parse_agent((FIXTURES / "advanced-fields.md").read_text())["frontmatter"]
    assert fm["permissionMode"] == "default"
    assert fm["mcpServers"] == {"skill-hub": {"command": "hub", "args": ["mcp"]}}
    assert fm["hooks"]["PreToolUse"][0]["matcher"] == "Bash"
    assert fm["memory"] == {"enabled": True, "scope": "project"}
    assert fm["maxTurns"] == 40
    keys = list(fm.keys())
    # safe keys come before any advanced key
    assert keys.index("color") < keys.index("permissionMode")
    # advanced keys keep their authored order
    assert keys.index("permissionMode") < keys.index("mcpServers") < keys.index("hooks") \
        < keys.index("memory") < keys.index("maxTurns")


def test_denylist_mode_derived():
    """The denylist fixture derives tools_mode=denylist with the skills list intact."""
    fm = subagents.parse_agent((FIXTURES / "denylist-skills.md").read_text())["frontmatter"]
    derived = subagents.derive_tools(fm)
    assert derived["tools_mode"] == "denylist"
    assert "Write" in derived["disallowed_tools"]
    assert subagents._as_tool_list(fm.get("skills")) == ["code-review", "security-review"]
