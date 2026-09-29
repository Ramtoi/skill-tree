"""Tests for the skill cross-reference resolver (`skill_refs.py`).

The corpus half (`test_corpus_cases` + its guard rows) pins the matching rule
against the shared fixture at `tests/fixtures/skill_refs_corpus.json`, the
same file the TypeScript twin (`app/src/lib/skillRefs.ts`, PR2) loads — the
first Python+TS fixture pin, in the convention of
`tests/test_agent_docs_canonical.py`. The rest cover `build_graph` and
`missing_refs_for`, which need a real registry shape but no I/O beyond a
handful of temp SKILL.md files.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import hub  # noqa: E402
from skill_hub.domain.skills import skill_refs  # noqa: E402

CORPUS = Path(__file__).parent / "fixtures" / "skill_refs_corpus.json"

REQUIRED_CASE_NAMES = {
    "backtick-hit",
    "slash-hit",
    "both-forms-same-name",
    "self-reference-excluded",
    "frontmatter-only-mention",
    "unterminated-fence-counts-frontmatter",
    "empty-frontmatter-is-body",
    "path-like-reference-excluded",
    "slash-dot-extension-excluded",
    "slash-trailing-slash-excluded",
    "dot-slash-path-excluded",
    "dotdot-path-excluded",
    "tilde-path-excluded",
    "md-link-target-excluded",
    "parenthesised-prose-included",
    "slash-sentence-end-included",
    "fenced-code-block-included",
    "inline-code-command-span",
    "backtick-with-leading-slash",
    "ignore-list-drops-target",
    "unknown-name-ignored",
    "crlf-text",
    "bom-prefix",
    "non-skill-backtick",
    "case-sensitive-no-hit",
    "stray-backtick-shifts-pairing",
    "markup-prefix-allowed",
    "exotic-whitespace-span-is-single-token",
    "ascii-space-span-is-multi-word",
}


def _load_cases() -> list[dict[str, Any]]:
    return json.loads(CORPUS.read_text(encoding="utf-8"))["cases"]


def _write_skill(root: Path, name: str, body: str) -> str:
    """Materialize a minimal SKILL.md at `root` and return `str(root)` for a
    registry entry's `source:`."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: a test skill.\n---\n\n{body}",
        encoding="utf-8",
    )
    return str(root)


# ─────────────────────────────────────────────────────────────────────────────
# Corpus
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_corpus_cases(case: dict[str, Any]) -> None:
    hits = skill_refs.find_refs(case["text"], case["names"], case["self"], case["ignore"])
    assert hits == case["expect"]
    counts = skill_refs.count_refs(case["text"], case["names"], case["self"], case["ignore"])
    assert counts == case["counts"]


def test_corpus_is_bmp_only() -> None:
    for case in _load_cases():
        for ch in case["text"]:
            assert ord(ch) <= 0xFFFF, f"{case['name']!r} has a non-BMP character"


def test_corpus_has_every_required_case() -> None:
    names = {case["name"] for case in _load_cases()}
    assert REQUIRED_CASE_NAMES <= names


def test_corpus_declares_preview_hits() -> None:
    for case in _load_cases():
        preview_hits = case["preview_hits"]
        assert isinstance(preview_hits, int) and not isinstance(preview_hits, bool)
        assert 0 <= preview_hits <= len(case["expect"])


# ─────────────────────────────────────────────────────────────────────────────
# split_frontmatter
# ─────────────────────────────────────────────────────────────────────────────


def test_split_frontmatter_matches_rust_shape() -> None:
    # Well-formed fence: the closer's opening eol is not part of the
    # frontmatter slice (the Rust port takes `after_open[..idx]`, and `idx`
    # is the START of the closer, which itself starts with the eol).
    assert skill_refs.split_frontmatter("---\nname: x\n---\nbody\n") == (
        "name: x",
        "body\n",
    )
    # Two leading BOMs, CRLF throughout.
    assert skill_refs.split_frontmatter(
        "﻿﻿---\r\nname: x\r\n---\r\nbody\r\n"
    ) == ("name: x", "body\r\n")
    # Unterminated fence: no closer at all -> whole text is body.
    assert skill_refs.split_frontmatter("---\nname: x\n") == (
        None,
        "---\nname: x\n",
    )
    # Every leading repetition of the eol is stripped from the body, not
    # just one.
    assert skill_refs.split_frontmatter("---\nx\n---\n\n\nbody") == ("x", "body")
    # Empty frontmatter: no closer found inside `after_open` either, so the
    # whole file is body (both ports agree, grill m4).
    assert skill_refs.split_frontmatter("---\n---\nbody") == (
        None,
        "---\n---\nbody",
    )


# ─────────────────────────────────────────────────────────────────────────────
# build_graph
# ─────────────────────────────────────────────────────────────────────────────


def test_build_graph_counts_and_order(tmp_path: Path) -> None:
    source_a = _write_skill(
        tmp_path / "a",
        "a",
        "See `b` and `b` again, plus /b in prose.",
    )
    source_b = _write_skill(tmp_path / "b", "b", "Nothing to see here.")
    registry = {
        "skills": {
            "a": {"type": "claude-skill", "scope": "portable", "source": source_a},
            "b": {"type": "claude-skill", "scope": "portable", "source": source_b},
        }
    }
    graph = skill_refs.build_graph(registry)
    assert graph == {"edges": [{"from": "a", "to": "b", "count": 3}]}


def test_build_graph_reads_references_after_search_corpus_limit(tmp_path: Path) -> None:
    source_a = _write_skill(
        tmp_path / "a", "a", "x" * (512 * 1024 + 17) + " See `b`."
    )
    source_b = _write_skill(tmp_path / "b", "b", "Nothing to see here.")
    registry = {
        "skills": {
            "a": {"type": "claude-skill", "scope": "portable", "source": source_a},
            "b": {"type": "claude-skill", "scope": "portable", "source": source_b},
        }
    }
    assert skill_refs.build_graph(registry) == {
        "edges": [{"from": "a", "to": "b", "count": 1}]
    }


def test_build_graph_skips_mcp_sources_keeps_mcp_targets(tmp_path: Path) -> None:
    source_a = _write_skill(tmp_path / "a", "a", "Talk to `srv` for details.")
    registry = {
        "skills": {
            "a": {"type": "claude-skill", "scope": "portable", "source": source_a},
            "srv": {"type": "mcp-server", "scope": "portable"},
        }
    }
    graph = skill_refs.build_graph(registry)
    # `srv` is reachable as a target but contributes no outgoing edge itself.
    assert graph == {"edges": [{"from": "a", "to": "srv", "count": 1}]}


def test_build_graph_applies_refs_ignore(tmp_path: Path) -> None:
    source_a = _write_skill(tmp_path / "a", "a", "See `b` and `c` both.")
    source_b = _write_skill(tmp_path / "b", "b", "Nothing.")
    source_c = _write_skill(tmp_path / "c", "c", "Nothing.")
    registry = {
        "skills": {
            "a": {
                "type": "claude-skill",
                "scope": "portable",
                "source": source_a,
                "refs_ignore": ["b"],
            },
            "b": {"type": "claude-skill", "scope": "portable", "source": source_b},
            "c": {"type": "claude-skill", "scope": "portable", "source": source_c},
        }
    }
    graph = skill_refs.build_graph(registry)
    assert graph == {"edges": [{"from": "a", "to": "c", "count": 1}]}


def test_build_graph_tolerates_unreadable_skill(tmp_path: Path) -> None:
    registry = {
        "skills": {
            "a": {
                "type": "claude-skill",
                "scope": "portable",
                "source": str(tmp_path / "does-not-exist"),
            },
        }
    }
    graph = skill_refs.build_graph(registry)
    assert graph == {"edges": []}


def test_build_graph_uses_rename_patch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The on-disk body names nothing; the patched text names `b`.
    source_a = _write_skill(tmp_path / "a", "upstream-a", "Nothing here.")
    source_b = _write_skill(tmp_path / "b", "b", "Nothing.")

    def fake_rename_patch(name: str, cfg: dict[str, Any]) -> str | None:
        if name == "a":
            return "Patched body naming `b`.\n"
        return None

    monkeypatch.setattr(hub, "skill_rename_patch", fake_rename_patch)

    registry = {
        "skills": {
            "a": {"type": "claude-skill", "scope": "portable", "source": source_a},
            "b": {"type": "claude-skill", "scope": "portable", "source": source_b},
        }
    }
    graph = skill_refs.build_graph(registry)
    assert graph == {"edges": [{"from": "a", "to": "b", "count": 1}]}


# ─────────────────────────────────────────────────────────────────────────────
# missing_refs_for
# ─────────────────────────────────────────────────────────────────────────────


def test_missing_refs_rule() -> None:
    registry = {
        "skills": {
            "a": {"type": "claude-skill", "scope": "portable"},
            "b": {"type": "claude-skill", "scope": "portable"},
            "c": {"type": "claude-skill", "scope": "portable"},
            "d": {"type": "claude-skill", "scope": "portable"},
            "g": {"type": "claude-skill", "scope": "global"},
            "y": {"type": "claude-skill", "scope": "portable"},
            "z": {"type": "claude-skill", "scope": "portable"},
        }
    }
    graph = {
        "edges": [
            {"from": "a", "to": "b", "count": 1},  # not active, not global -> reported
            {"from": "a", "to": "d", "count": 1},  # not active, not global -> reported
            {"from": "a", "to": "c", "count": 1},  # active -> not reported
            {"from": "a", "to": "g", "count": 1},  # scope: global target -> not reported
            {"from": "a", "to": "unknown-skill", "count": 1},  # unregistered -> not reported
            {"from": "z", "to": "y", "count": 1},  # not active, not global -> reported
        ]
    }
    result = skill_refs.missing_refs_for(["a", "c", "z"], registry, graph)
    assert result == [
        {"skill": "a", "refs": ["b", "d"]},
        {"skill": "z", "refs": ["y"]},
    ]


def test_missing_refs_counts_global_sources() -> None:
    registry = {
        "skills": {
            "g": {"type": "claude-skill", "scope": "global"},
            "p": {"type": "claude-skill", "scope": "portable"},
        }
    }
    graph = {"edges": [{"from": "g", "to": "p", "count": 2}]}
    result = skill_refs.missing_refs_for([], registry, graph, global_sources=["g"])
    assert result == [{"skill": "g", "refs": ["p"]}]


def test_missing_refs_ignores_global_sources_when_not_passed() -> None:
    registry = {
        "skills": {
            "g": {"type": "claude-skill", "scope": "global"},
            "p": {"type": "claude-skill", "scope": "portable"},
        }
    }
    graph = {"edges": [{"from": "g", "to": "p", "count": 2}]}
    result = skill_refs.missing_refs_for([], registry, graph)
    assert result == []
