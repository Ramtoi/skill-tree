"""Pinned Usage catalog and source-reader selection contracts."""

from __future__ import annotations

import hashlib
import json

import pytest

from skill_hub.domain.harnesses.harness_usage_api import ReaderRef, SourceProbe, SourceRecognition
from skill_hub.domain.usage.usage_inspection_capture import ReaderBindingPolicy
from skill_hub.domain.usage.usage_reader_resolution import (
    ReaderDescriptor,
    ReplanRequired,
    capture_reader_catalog,
    resolve_source_reader,
    restore_reader_catalog,
)
from skill_hub.infrastructure.harnesses.harness_bundled_usage import register_usage_reader, unregister_usage_reader


class _FixtureReader:
    READER_ID = "fixture_usage_reader"
    READER_REVISION = 1
    CAPTURE_CONTRACT_VERSION = 1
    NORMALIZATION_VERSION = 1
    SUPPORTED_FORMATS = ("fixture-jsonl",)
    RECOGNITION_CONTRACT = "source_probe_v1_allow_unversioned"
    ALLOWS_UNKNOWN_LEGACY = True

    def recognize_source(self, probe):
        if not any("fixture" in record for record in probe.records):
            return SourceRecognition(None, None, None, None, "complete", "inconclusive")
        return SourceRecognition(
            "fixture", None, "fixture-jsonl", "f" * 64, "complete", "recognized"
        )


class _LegacyFixtureReader(_FixtureReader):
    READER_ID = "legacy_fixture_reader"

    def recognize_source(self, probe):
        reason = "legacy_eligible" if any(record.get("legacy") for record in probe.records) else "inconclusive"
        return SourceRecognition(None, None, None, None, "complete", reason)


class _SecondLegacyFixtureReader(_LegacyFixtureReader):
    READER_ID = "second_legacy_fixture_reader"


def _policy(ref: ReaderRef) -> ReaderBindingPolicy:
    return ReaderBindingPolicy(
        ref.contract_version,
        1,
        ref.reader_id,
        ref.revision,
        1,
        1,
        1,
    )


def _probe() -> SourceProbe:
    return SourceProbe("fixture-source", None, b'{"fixture":true}\n', ({"fixture": True},), 17, 17, 1, "eof")


def test_catalog_round_trip_has_canonical_digest_and_exact_policy():
    ref = ReaderRef("fixture_usage_reader", 1, 1)
    descriptor = ReaderDescriptor(
        ref,
        _policy(ref),
        "fixture",
        ("fixture-jsonl",),
        (),
        "source_probe_v1_allow_unversioned",
        True,
        False,
    )
    catalog = capture_reader_catalog((descriptor,))
    restored = restore_reader_catalog(catalog.canonical_json(), catalog.digest)

    assert restored == catalog
    assert json.loads(restored.canonical_json())["available_readers"][0]["active"] is False


def test_unrecognized_json_is_inconclusive_without_existing_legacy_binding():
    ref = ReaderRef("fixture_usage_reader", 1, 1)
    descriptor = ReaderDescriptor(ref, _policy(ref), "fixture", ("fixture-jsonl",), (), allows_unknown_legacy=True)
    ref = register_usage_reader("fixture", _FixtureReader())
    try:
        catalog = capture_reader_catalog((descriptor,))
        with pytest.raises(ReplanRequired, match="reader_unrecognized"):
            resolve_source_reader(
                catalog,
                SourceProbe("fixture-source", None, b"{}\n", ({},), 3, 3, 1, "eof"),
                "fixture",
            )
    finally:
        unregister_usage_reader(ref)


def test_registered_retained_reader_is_resolved_by_exact_ref():
    reader = _FixtureReader()
    ref = register_usage_reader("fixture", reader)
    try:
        catalog = capture_reader_catalog()
        resolved = resolve_source_reader(catalog, _probe(), "fixture")
        assert resolved.ref == ref
        assert resolved.policy.reader_id == ref.reader_id
        assert resolved.catalog_digest == catalog.digest
    finally:
        unregister_usage_reader(ref)


def test_unknown_selection_policy_is_rejected_even_with_matching_digest():
    catalog = capture_reader_catalog(())
    raw = json.loads(catalog.canonical_json())
    raw["selection_policy"] = "future_policy"
    canonical = json.dumps(raw, sort_keys=True, separators=(",", ":"))
    digest = "catalog:" + hashlib.sha256(canonical.encode()).hexdigest()

    with pytest.raises(ReplanRequired, match="reader_catalog_invalid"):
        restore_reader_catalog(canonical, digest)


def test_unique_explicit_legacy_reader_accepts_evidence_but_ambiguity_fails_closed():
    first = _LegacyFixtureReader()
    second = _SecondLegacyFixtureReader()
    first_ref = register_usage_reader("fixture", first)
    second_ref = register_usage_reader("fixture", second)
    probe = SourceProbe(
        "legacy-source", None, b'{"legacy":true}\n', ({"legacy": True},), 16, 16, 1, "eof"
    )
    try:
        all_readers = capture_reader_catalog().available_readers
        first_descriptor = next(item for item in all_readers if item.ref == first_ref)
        second_descriptor = next(item for item in all_readers if item.ref == second_ref)
        unique = capture_reader_catalog((first_descriptor,))
        assert resolve_source_reader(unique, probe, "fixture").ref == first_ref

        ambiguous = capture_reader_catalog((first_descriptor, second_descriptor))
        with pytest.raises(ReplanRequired, match="reader_ambiguous"):
            resolve_source_reader(ambiguous, probe, "fixture")
    finally:
        unregister_usage_reader(second_ref)
        unregister_usage_reader(first_ref)
