"""Pinned Usage reader catalogs and source-bound reader selection.

The catalog is deliberately independent from the active harness catalog.  A
scan pass persists this value before it probes a source, so a resumed pass can
load the exact reader package and policy that started it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from skill_hub.domain.harnesses.harness_usage_api import ReaderRef, SourceProbe, SourceRecognition, source_generation
from skill_hub.domain.usage.usage_inspection_capture import (
    ReaderBinding,
    ReaderBindingPolicy,
    SourceChangedError,
)

CATALOG_SCHEMA_VERSION = 1
SELECTION_POLICY = "recognized_then_explicit_legacy"
_KNOWN_RECOGNITION_CONTRACTS = {"source_probe_v1", "source_probe_v1_allow_unversioned"}


class ReplanRequired(RuntimeError):
    """The pinned reader cannot safely capture the source."""

    kind = "replan_required"

    def __init__(
        self,
        reason: str,
        *,
        source_id: str | None = None,
        ref: ReaderRef | None = None,
        scan_id: str | None = None,
    ) -> None:
        self.reason = str(reason)
        self.source_id = source_id
        self.ref = ref
        self.scan_id = scan_id
        super().__init__(self.reason)

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"kind": self.kind, "reason": self.reason}
        if self.source_id is not None:
            value["source_id"] = self.source_id
        if self.scan_id is not None:
            value["scan_id"] = self.scan_id
        if self.ref is not None:
            value["reader"] = _ref_json(self.ref)
        return value


@dataclass(frozen=True)
class ReaderDescriptor:
    ref: ReaderRef
    policy: ReaderBindingPolicy
    harness: str
    supported_formats: tuple[str, ...] = ()
    supported_producer_versions: tuple[str, ...] = ()
    recognition_contract: str = "source_probe_v1"
    allows_unknown_legacy: bool = False
    active: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.ref, ReaderRef) or not isinstance(self.policy, ReaderBindingPolicy):
            raise TypeError("reader descriptor requires a ReaderRef and ReaderBindingPolicy")
        if self.policy.reader_id != self.ref.reader_id or self.policy.reader_revision != self.ref.revision:
            raise ValueError("reader descriptor ref and policy disagree")
        if self.policy.capture_contract_version != self.ref.contract_version:
            raise ValueError("reader descriptor contract mismatch")
        if not self.harness:
            raise ValueError("reader descriptor harness required")

    def canonical_json(self) -> str:
        return _json(
            {
                "active": bool(self.active),
                "allows_unknown_legacy": bool(self.allows_unknown_legacy),
                "harness": self.harness,
                "policy": json.loads(self.policy.canonical_json()),
                "recognition_contract": self.recognition_contract,
                "ref": _ref_json(self.ref),
                "supported_formats": sorted(set(self.supported_formats)),
                "supported_producer_versions": sorted(set(self.supported_producer_versions)),
            }
        )

    @property
    def key(self) -> tuple[str, int, int]:
        return (self.ref.reader_id, self.ref.revision, self.ref.contract_version)


@dataclass(frozen=True)
class ReaderCatalogSnapshot:
    schema_version: int
    digest: str
    available_readers: tuple[ReaderDescriptor, ...]
    selection_policy: str = SELECTION_POLICY

    def canonical_json(self) -> str:
        return _json(
            {
                "available_readers": [json.loads(item.canonical_json()) for item in self.available_readers],
                "schema_version": self.schema_version,
                "selection_policy": self.selection_policy,
            }
        )

    def descriptor(self, ref: ReaderRef) -> ReaderDescriptor | None:
        return next((item for item in self.available_readers if item.ref == ref), None)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _ref_json(ref: ReaderRef) -> dict[str, Any]:
    return {
        "contract_version": ref.contract_version,
        "reader_id": ref.reader_id,
        "revision": ref.revision,
    }


def _digest(canonical: str) -> str:
    return "catalog:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _make_snapshot(
    descriptors: Iterable[ReaderDescriptor],
    *,
    selection_policy: str = SELECTION_POLICY,
) -> ReaderCatalogSnapshot:
    if selection_policy != SELECTION_POLICY:
        raise ValueError("unsupported reader selection policy")
    ordered = tuple(sorted(descriptors, key=lambda item: (item.harness, item.key)))
    keys = [item.key for item in ordered]
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate reader refs")
    body = _json(
        {
            "available_readers": [json.loads(item.canonical_json()) for item in ordered],
            "schema_version": CATALOG_SCHEMA_VERSION,
            "selection_policy": selection_policy,
        }
    )
    return ReaderCatalogSnapshot(CATALOG_SCHEMA_VERSION, _digest(body), ordered, selection_policy)


def _descriptor_for_harness(harness: str) -> ReaderDescriptor:
    import importlib

    module_name = {
        "claude-code": "skill_hub.infrastructure.usage.usage_inspection_claude",
        "codex": "skill_hub.infrastructure.usage.usage_inspection_codex",
    }.get(harness)
    if module_name is None:
        raise ValueError(f"unsupported Usage harness: {harness}")
    module = importlib.import_module(module_name)
    ref = ReaderRef(
        str(module.READER_ID),
        int(module.READER_REVISION),
        int(getattr(module, "CAPTURE_CONTRACT_VERSION", 1)),
    )
    policy = ReaderBindingPolicy(
        capture_contract_version=ref.contract_version,
        host_contract_version=1,
        reader_id=ref.reader_id,
        reader_revision=ref.revision,
        normalization_version=int(getattr(module, "NORMALIZATION_VERSION", 1)),
        resume_version=1,
        capture_schema_version=1,
        parser_version=int(getattr(module, "CAPTURE_PARSER_VERSION", 1)),
    )
    formats = ("claude-jsonl",) if harness == "claude-code" else ("codex-rollout-jsonl",)
    # The two bundled readers are explicitly eligible to retain captures made
    # before recognition evidence existed.  New arbitrary JSON remains
    # inconclusive because the fallback below is only used for an existing
    # binding supplied by the host.
    return ReaderDescriptor(ref, policy, harness, formats, (), "source_probe_v1_allow_unversioned", True, True)


def _descriptor_from_reader(harness: str, ref: ReaderRef, reader: Any) -> ReaderDescriptor:
    policy = getattr(reader, "READER_POLICY", None)
    if not isinstance(policy, ReaderBindingPolicy):
        policy = ReaderBindingPolicy(
            capture_contract_version=ref.contract_version,
            host_contract_version=int(getattr(reader, "HOST_CONTRACT_VERSION", 1)),
            reader_id=ref.reader_id,
            reader_revision=ref.revision,
            normalization_version=int(getattr(reader, "NORMALIZATION_VERSION", 1)),
            resume_version=int(getattr(reader, "RESUME_VERSION", 1)),
            capture_schema_version=int(getattr(reader, "CAPTURE_SCHEMA_VERSION", 1)),
            adapter_digest=getattr(reader, "ADAPTER_DIGEST", None),
            parser_version=int(getattr(reader, "CAPTURE_PARSER_VERSION", 1)),
        )
    formats = tuple(str(item) for item in getattr(reader, "SUPPORTED_FORMATS", ()))
    if not formats:
        formats = ("claude-jsonl",) if harness == "claude-code" else ("codex-rollout-jsonl",)
    versions = tuple(str(item) for item in getattr(reader, "SUPPORTED_PRODUCER_VERSIONS", ()))
    contract = str(
        getattr(reader, "RECOGNITION_CONTRACT", "source_probe_v1_allow_unversioned")
    )
    return ReaderDescriptor(
        ref,
        policy,
        harness,
        formats,
        versions,
        contract,
        bool(getattr(reader, "ALLOWS_UNKNOWN_LEGACY", harness in {"claude-code", "codex"})),
        bool(getattr(reader, "ACTIVE", True)),
    )


def capture_reader_catalog(readers: Iterable[ReaderDescriptor] | None = None) -> ReaderCatalogSnapshot:
    """Capture all locally loadable descriptors, including inactive entries."""
    if readers is None:
        from skill_hub.infrastructure.harnesses.harness_bundled_usage import usage_reader_inventory

        readers = tuple(
            _descriptor_from_reader(harness, ref, reader)
            for harness, ref, reader in usage_reader_inventory()
        )
    return _make_snapshot(tuple(readers))


def _as_ref(raw: object) -> ReaderRef:
    if not isinstance(raw, dict):
        raise ValueError("invalid reader ref")
    return ReaderRef(
        str(raw["reader_id"]),
        int(raw["revision"]),
        int(raw.get("contract_version", 1)),
    )


def _as_policy(raw: object) -> ReaderBindingPolicy:
    if not isinstance(raw, dict):
        raise ValueError("invalid reader policy")
    return ReaderBindingPolicy(
        capture_contract_version=int(raw["capture_contract_version"]),
        host_contract_version=int(raw["host_contract_version"]),
        reader_id=str(raw["reader_id"]),
        reader_revision=int(raw["reader_revision"]),
        normalization_version=int(raw["normalization_version"]),
        resume_version=int(raw["resume_version"]),
        capture_schema_version=int(raw["capture_schema_version"]),
        adapter_digest=raw.get("adapter_digest"),
        parser_version=int(raw.get("parser_version", 1)),
    )


def restore_reader_catalog(value: str | dict[str, Any], digest: str) -> ReaderCatalogSnapshot:
    """Restore and validate a persisted canonical catalog."""
    try:
        raw = json.loads(value) if isinstance(value, str) else value
        schema_version = raw.get("schema_version") if isinstance(raw, dict) else None
        if not isinstance(raw, dict) or not isinstance(schema_version, int) or schema_version != CATALOG_SCHEMA_VERSION:
            raise ValueError("unsupported reader catalog schema")
        selection_policy = raw.get("selection_policy")
        if selection_policy != SELECTION_POLICY:
            raise ValueError("invalid reader selection policy")
        descriptors: list[ReaderDescriptor] = []
        for item in raw.get("available_readers", ()):
            if not isinstance(item, dict):
                raise ValueError("invalid reader descriptor")
            ref = _as_ref(item.get("ref"))
            policy = _as_policy(item.get("policy"))
            descriptor = ReaderDescriptor(
                ref,
                policy,
                str(item["harness"]),
                tuple(str(v) for v in item.get("supported_formats", ())),
                tuple(str(v) for v in item.get("supported_producer_versions", ())),
                str(item.get("recognition_contract", "source_probe_v1")),
                bool(item.get("allows_unknown_legacy", False)),
                bool(item.get("active", True)),
            )
            if any(not fmt or len(fmt) > 128 for fmt in descriptor.supported_formats):
                raise ValueError("unsupported reader format")
            if descriptor.recognition_contract not in _KNOWN_RECOGNITION_CONTRACTS:
                raise ValueError("unsupported reader recognition contract")
            descriptors.append(descriptor)
        snapshot = _make_snapshot(descriptors, selection_policy=selection_policy)
        if not isinstance(digest, str) or digest != snapshot.digest:
            raise ValueError("reader catalog digest mismatch")
        return snapshot
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ReplanRequired("reader_catalog_invalid") from exc


def _reader_for(descriptor: ReaderDescriptor) -> Any:
    from skill_hub.infrastructure.harnesses.harness_bundled_usage import load_usage_reader

    try:
        return load_usage_reader(descriptor.ref)
    except (TypeError, ValueError, ImportError) as exc:
        raise ReplanRequired("reader_unavailable", ref=descriptor.ref) from exc


def _recognition_matches(descriptor: ReaderDescriptor, recognition: SourceRecognition) -> bool:
    if recognition.completeness == "inconclusive" or recognition.reason in {"inconclusive", ""}:
        return False
    if recognition.native_format not in descriptor.supported_formats:
        return False
    if recognition.producer_version is None:
        if descriptor.recognition_contract != "source_probe_v1_allow_unversioned":
            return False
    elif (
        descriptor.supported_producer_versions
        and recognition.producer_version not in descriptor.supported_producer_versions
    ):
        return False
    return True


def resolve_source_reader(
    catalog: ReaderCatalogSnapshot,
    probe: SourceProbe,
    harness: str,
    existing_binding: ReaderBinding | dict[str, Any] | None = None,
) -> "ResolvedSourceReader":
    """Resolve one exact reader and policy from a bounded source probe."""
    candidates = [item for item in catalog.available_readers if item.harness == harness]
    if not candidates:
        raise ReplanRequired("reader_unavailable", source_id=probe.source_id)
    if isinstance(existing_binding, ResolvedSourceReader):
        descriptor = catalog.descriptor(existing_binding.ref)
        if descriptor is None or descriptor.policy.canonical_json() != existing_binding.policy.canonical_json():
            raise ReplanRequired("reader_policy_incompatible", source_id=probe.source_id, ref=existing_binding.ref)
        return existing_binding
    if isinstance(existing_binding, dict):
        try:
            existing_binding = ReaderBinding(
                _binding_policy_from_json(existing_binding["policy"]),
                _binding_evidence_from_json(existing_binding.get("source_evidence", {})),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ReplanRequired("reader_binding_invalid", source_id=probe.source_id) from exc
    if existing_binding is not None:
        if isinstance(existing_binding, ReaderBinding):
            ref = ReaderRef(
                existing_binding.policy.reader_id,
                existing_binding.policy.reader_revision,
                existing_binding.policy.capture_contract_version,
            )
            descriptor = catalog.descriptor(ref)
            if descriptor is None or descriptor.policy.canonical_json() != existing_binding.policy.canonical_json():
                raise ReplanRequired("reader_policy_incompatible", source_id=probe.source_id, ref=ref)
            candidates = [descriptor]
    matches: list[ResolvedSourceReader] = []
    observations: dict[ReaderRef, SourceRecognition] = {}
    for descriptor in candidates:
        try:
            recognition = _reader_for(descriptor).recognize_source(probe)
        except (ReplanRequired, OSError, SourceChangedError):
            raise
        except Exception:
            continue
        observations[descriptor.ref] = recognition
        if _recognition_matches(descriptor, recognition):
            matches.append(ResolvedSourceReader(descriptor.ref, descriptor.policy, recognition, catalog.digest))
    if matches:
        if len(matches) != 1:
            raise ReplanRequired("reader_ambiguous", source_id=probe.source_id)
        return matches[0]
    legacy = [item for item in candidates if item.allows_unknown_legacy and item.ref in observations]
    eligible_legacy = [
        item
        for item in legacy
        if observations[item.ref].reason == "legacy_eligible"
    ]
    if len(eligible_legacy) > 1:
        raise ReplanRequired("reader_ambiguous", source_id=probe.source_id)
    if (
        len(legacy) == 1
        and probe.records
        and probe.stop_reason not in {"source_changed", "deadline"}
    ):
        descriptor = legacy[0]
        recognition = observations[descriptor.ref]
        if existing_binding is not None or recognition.reason == "legacy_eligible":
            recognition = SourceRecognition(
                None, None, "unknown_legacy", None, "inconclusive", "legacy_binding"
            )
            return ResolvedSourceReader(descriptor.ref, descriptor.policy, recognition, catalog.digest)
    raise ReplanRequired("reader_unrecognized", source_id=probe.source_id)


def _binding_policy_from_json(value: object) -> ReaderBindingPolicy:
    if not isinstance(value, dict):
        raise ValueError("invalid binding policy")
    return _as_policy(value)


def _binding_evidence_from_json(value: object) -> Any:
    from skill_hub.domain.usage.usage_inspection_capture import ReaderBindingSourceEvidence

    if not isinstance(value, dict):
        raise ValueError("invalid binding evidence")
    return ReaderBindingSourceEvidence(
        str(value["producer"]), str(value["native_format"]), str(value["format_fingerprint"])
    )


@dataclass(frozen=True)
class ResolvedSourceReader:
    ref: ReaderRef
    policy: ReaderBindingPolicy
    recognition: SourceRecognition
    catalog_digest: str

    def binding(self) -> ReaderBinding | None:
        if not self.recognition.native_format or not self.recognition.format_fingerprint:
            return None
        return ReaderBinding(
            self.policy,
            __import__(
                "skill_hub.domain.usage.usage_inspection_capture", fromlist=["ReaderBindingSourceEvidence"]
            ).ReaderBindingSourceEvidence(
                self.recognition.producer or "unknown_legacy",
                self.recognition.native_format,
                self.recognition.format_fingerprint,
            ),
        )


__all__ = [
    "CATALOG_SCHEMA_VERSION",
    "SELECTION_POLICY",
    "ReaderCatalogSnapshot",
    "ReaderDescriptor",
    "ReplanRequired",
    "ResolvedSourceReader",
    "capture_reader_catalog",
    "resolve_source_reader",
    "restore_reader_catalog",
    "source_generation",
]
