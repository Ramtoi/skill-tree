"""Python side of the shared Usage identity corpus contract."""

import json
from pathlib import Path

from skill_hub.domain.usage import usage_identity

CORPUS = json.loads((Path(__file__).parent / "fixtures" / "usage_identity.json").read_text())


def test_canonical_harness_matches_corpus():
    for case in CORPUS["aliases"]:
        assert usage_identity.canonical_harness(case["input"]) == case["expect"]


def test_session_key_matches_corpus():
    for case in CORPUS["keys"]:
        assert usage_identity.session_key(case["harness"], case["raw_id"]) == case["expect"]


def test_same_uuid_is_qualified_by_harness():
    raw = "019fd809-2012-7ef2-8cfb-91696cccd6f4"
    assert usage_identity.session_key("claude-code", raw) != usage_identity.session_key("codex", raw)


def test_identity_corpus_matches_frontend():
    source = Path(__file__).parent / "fixtures/usage_identity.json"
    target = source.parents[2] / "app/src/test/fixtures/usage_identity.json"
    assert source.read_bytes() == target.read_bytes()
