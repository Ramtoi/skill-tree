"""Persistent, bounded inspection passes over a combined source inventory."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import multiprocessing as mp
import os
import pickle
import signal
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, replace
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any, Callable, Iterator

import skill_hub.application.usage.usage_inspection as usage_inspection
import skill_hub.application.usage.usage_summary_export as usage_summary_export
import skill_hub.hub_core as hub_core
import skill_hub.infrastructure.harnesses.harness_execution_supervisor as harness_execution_supervisor
from skill_hub.application.usage.usage_capture_enrichment import CaptureEnrichmentContext
from skill_hub.application.usage.usage_source_layout import UsageLayout, iter_source_candidates
from skill_hub.domain.harnesses.harness_usage_api import (
    ReaderRef,
    ReaderSource,
    SourceProbe,
    SourceRecognition,
    source_generation,
)
from skill_hub.domain.usage.usage_inspection_capture import (
    CaptureSource,
    ReaderBinding,
    ReaderBindingPolicy,
    SourceChangedError,
    SourceCursor,
    load_resume_state,
)
from skill_hub.domain.usage.usage_reader_resolution import (
    CATALOG_SCHEMA_VERSION,
    ReaderCatalogSnapshot,
    ReplanRequired,
    ResolvedSourceReader,
    capture_reader_catalog,
    resolve_source_reader,
    restore_reader_catalog,
)
from skill_hub.infrastructure.harnesses.harness_bundled_usage import load_usage_reader
from skill_hub.infrastructure.usage.usage_capture_io import append_proven
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, load_retention_config
from skill_hub.infrastructure.usage.usage_reader_context import SourceBoundCaptureHost, probe_source

DEFAULT_SOURCE_BUDGET = 60.0


@dataclass(frozen=True)
class Source:
    path: Path
    harness: str
    source_id: str
    mtime_ns: int
    size: int


def _reader(harness: str) -> Any:
    module = _reader_module(harness)
    return load_usage_reader(
        ReaderRef(
            str(module.READER_ID),
            int(module.READER_REVISION),
            int(getattr(module, "CAPTURE_CONTRACT_VERSION", 1)),
        )
    )


def _reader_module(harness: str) -> Any:
    import importlib

    return importlib.import_module(
        "skill_hub.infrastructure.usage.usage_inspection_claude"
        if harness == "claude-code"
        else "skill_hub.infrastructure.usage.usage_inspection_codex"
    )


def _signal_guard_available() -> bool:
    """Return whether the host can use the POSIX alarm fast path."""
    return (
        threading.current_thread() is threading.main_thread()
        and hasattr(signal, "SIGALRM")
        and hasattr(signal, "setitimer")
    )


def _portable_parse_worker(
    harness: str,
    path: str,
    cursor: SourceCursor,
    deadline: float,
    result_path: str,
    reader_ref: ReaderRef,
    probe_seed: SourceProbe | None = None,
) -> None:
    """Spawn entry point: parse only, then write one private result record."""
    try:
        reader = load_usage_reader(reader_ref)
        session_hint = Path(path).stem if harness == "claude-code" else ""
        source = ReaderSource(cursor.source_id, harness, session_hint, path)
        host = SourceBoundCaptureHost(
            path, source_id=cursor.source_id,
            source_session_id=source.source_session_id, deadline=deadline
        )
        if probe_seed is not None:
            if not host.install_probe_seed(probe_seed):
                raise SourceChangedError("source changed after reader selection")
        result = reader.capture(source, cursor, host, deadline=deadline)
        payload: tuple[str, Any] = ("result", result)
    except BaseException as exc:  # Serialize the type; exceptions are not portable.
        payload = ("error", (type(exc).__name__, str(exc), getattr(exc, "kind", None)))
    Path(result_path).write_bytes(pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL))


def _portable_resolve_worker(
    source: Source,
    cursor: SourceCursor,
    deadline: float,
    result_path: str,
    catalog_json: str,
    catalog_digest: str,
    saved_bindings: dict[str, dict[str, Any]],
) -> None:
    """Spawn entry point for bounded probing, recognition, and policy checks."""
    try:
        catalog = restore_reader_catalog(catalog_json, catalog_digest)
        host = SourceBoundCaptureHost(
            source.path,
            source_id=source.source_id,
            source_session_id=source.path.stem if source.harness == "claude-code" else "",
            deadline=deadline,
        )
        probe = probe_source(host, deadline=deadline)
        if probe.stop_reason == "deadline":
            raise TimeoutError("source budget exceeded")
        if probe.snapshot is None or probe.stop_reason == "source_changed":
            raise SourceChangedError("source changed during reader probe")
        generation_id = source_generation(
            source.path,
            cursor,
            probe.snapshot,
            lambda: append_proven(source.path, cursor),
        )
        saved = saved_bindings.get(generation_id)
        resolved = (
            _resolved_from_saved_row(catalog, saved, source.source_id)
            if saved is not None
            else resolve_source_reader(catalog, probe, source.harness)
        )
        _validate_runtime_reader(resolved, source.source_id)
        payload: tuple[str, Any] = ("result", (resolved, probe, generation_id))
    except BaseException as exc:
        payload = ("error", (type(exc).__name__, str(exc), getattr(exc, "kind", None)))
    Path(result_path).write_bytes(pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL))


def _portable_worker_entry(
    target: Any,
    args: tuple[Any, ...],
    control: Any,
    isolation: Any | None = None,
    deadline: float | None = None,
) -> None:
    """Establish isolation, await permission, run, then await cleanup."""
    if isolation is None:
        isolation = os.setsid if os.name == "posix" else _portable_noop
    try:
        isolation()
    except BaseException as exc:
        try:
            control.send(("isolation_failed", (type(exc).__name__, str(exc))))
        except (BrokenPipeError, EOFError, OSError):
            pass
        return
    group_id = os.getpgrp() if os.name == "posix" else None
    try:
        control.send(("ready", group_id))
        if deadline is not None and time.monotonic() >= deadline:
            return
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not control.poll(remaining):
                return
        if control.recv() != "run":
            return
        if deadline is not None and time.monotonic() >= deadline:
            return
        try:
            target(*args)
        except BaseException as exc:
            control.send(("target_failed", (type(exc).__name__, str(exc))))
            if control.recv() == "release":
                return
            return
        control.send(("done", None))
        if control.recv() != "release":
            return
    except (BrokenPipeError, EOFError, OSError):
        return


def _portable_noop() -> None:
    return None


def _worker_process_group(worker: BaseProcess) -> int | None:
    if os.name != "posix" or worker.pid is None:
        return None
    try:
        group_id = os.getpgid(worker.pid)
        # Never signal the test/application process group if the worker has
        # not reached the setsid call yet.
        return group_id if group_id == worker.pid else None
    except ProcessLookupError:
        return None


def _stop_portable_worker(worker: BaseProcess, group_id: int | None = None, process_tree: Any | None = None) -> None:
    """Stop a timed-out/cancelled worker and always reap its process."""
    if group_id is None:
        group_id = _worker_process_group(worker)
    cleanup_failed = False
    if os.name == "nt" and process_tree is not None:
        if not process_tree.terminate_and_close():
            cleanup_failed = True
    elif group_id is not None:
        try:
            # The handshake keeps an owned leader alive until cleanup. Kill
            # the group before TERM can leave only zombies, which macOS
            # rejects with EPERM even though no executable process remains.
            os.killpg(group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            cleanup_failed = True
    if worker.is_alive():
        worker.join(0.25)
    if worker.is_alive():
        worker.terminate()
        worker.join(0.25)
    if worker.is_alive() and hasattr(worker, "kill"):
        worker.kill()
    worker.join(1.0)
    if worker.is_alive():
        raise RuntimeError("portable_parser_cleanup_failed")
    if cleanup_failed:
        raise RuntimeError("portable_parser_cleanup_failed")


def _portable_call(
    seconds: float,
    *,
    worker_target: Any,
    worker_args: Callable[[float, str], tuple[Any, ...]],
    worker_isolation: Any | None = None,
) -> Any:
    """Run one source operation in an isolated, deadline-bound worker."""
    deadline = time.monotonic() + seconds
    context = mp.get_context("spawn")
    with tempfile.TemporaryDirectory(prefix="hub-usage-parse-") as temp_dir:
        result_path = Path(temp_dir) / "result.pickle"
        parent_control, child_control = context.Pipe()
        target_args = worker_args(deadline, str(result_path))
        worker = context.Process(
            target=_portable_worker_entry,
            args=(
                worker_target,
                target_args,
                child_control,
                worker_isolation,
                deadline,
            ),
        )
        worker.start()
        child_control.close()
        group_id: int | None = None
        process_tree: Any | None = None
        cleaned = False

        def cleanup() -> None:
            nonlocal cleaned
            if cleaned:
                return
            cleaned = True
            _stop_portable_worker(worker, group_id, process_tree)

        def send(command: str) -> None:
            try:
                parent_control.send(command)
            except (BrokenPipeError, EOFError, OSError):
                pass

        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    cleanup()
                    raise TimeoutError("source budget exceeded")
                if parent_control.poll(min(remaining, 0.05)):
                    try:
                        tag, payload = parent_control.recv()
                    except EOFError:
                        cleanup()
                        raise RuntimeError("portable_parser_no_result")
                    if tag == "isolation_failed":
                        cleanup()
                        raise RuntimeError("portable_parser_isolation_failed")
                    if tag != "ready":
                        cleanup()
                        raise RuntimeError("portable_parser_startup_failed")
                    candidate_group_id = payload if os.name == "posix" else None
                    if os.name == "posix" and candidate_group_id != worker.pid:
                        cleanup()
                        raise RuntimeError("portable_parser_isolation_failed")
                    group_id = candidate_group_id
                    if os.name == "nt":
                        try:
                            if worker.pid is None:
                                raise RuntimeError("worker has no process id")
                            process_tree = harness_execution_supervisor.windows_process_tree_for_pid(worker.pid)
                        except Exception as exc:
                            cleanup()
                            raise RuntimeError("portable_parser_isolation_failed") from exc
                    if time.monotonic() >= deadline:
                        cleanup()
                        raise TimeoutError("source budget exceeded")
                    send("run")
                    break
                if not worker.is_alive():
                    cleanup()
                    raise RuntimeError("portable_parser_isolation_failed")
            done = False
            while not done:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    cleanup()
                    raise TimeoutError("source budget exceeded")
                if parent_control.poll(min(remaining, 0.05)):
                    try:
                        tag, _payload = parent_control.recv()
                    except EOFError:
                        cleanup()
                        raise RuntimeError("portable_parser_no_result")
                    if tag == "done":
                        done = True
                    elif tag == "target_failed":
                        cleanup()
                        raise RuntimeError("portable_parser_worker_failed")
                    else:
                        cleanup()
                        raise RuntimeError("portable_parser_no_result")
                elif not worker.is_alive():
                    cleanup()
                    raise RuntimeError("portable_parser_no_result")
            cleanup()
            if not result_path.is_file():
                raise RuntimeError("portable_parser_no_result")
            try:
                tag, payload = pickle.loads(result_path.read_bytes())
            except (EOFError, OSError, pickle.PickleError, ValueError, TypeError) as exc:
                raise RuntimeError("portable_parser_no_result") from exc
            if tag == "result":
                return payload
            if tag != "error":
                raise RuntimeError("portable_parser_no_result")
            if not isinstance(payload, tuple) or len(payload) not in {2, 3}:
                raise RuntimeError("portable_parser_no_result")
            name, message = payload[:2]
            kind = payload[2] if len(payload) == 3 else None
            error_types = {
                "FileNotFoundError": FileNotFoundError,
                "TimeoutError": TimeoutError,
                "KeyboardInterrupt": KeyboardInterrupt,
                "PermissionError": PermissionError,
                "ReplanRequired": ReplanRequired,
                "SourceChangedError": SourceChangedError,
                "ValueError": ValueError,
                "OSError": OSError,
            }
            error_type = error_types.get(str(name), RuntimeError)
            error = error_type(str(message))
            if isinstance(kind, str) and kind:
                setattr(error, "kind", kind)
            raise error
        except BaseException:
            if not cleaned:
                cleanup()
            raise
        finally:
            parent_control.close()
            if not worker.is_alive():
                try:
                    worker.close()
                except ValueError:
                    # A failed cleanup remains the primary error when the
                    # process is still transitioning out of the tree.
                    pass


def _portable_parse(
    harness: str,
    path: Path,
    cursor: SourceCursor,
    seconds: float,
    *,
    worker_target: Any = _portable_parse_worker,
    worker_isolation: Any | None = None,
    reader_ref: ReaderRef,
    probe_seed: SourceProbe | None = None,
) -> Any:
    """Parse in a bounded spawn worker when signal alarms are unavailable."""

    def args(deadline: float, result_path: str) -> tuple[Any, ...]:
        value: tuple[Any, ...] = (
            harness,
            str(path),
            cursor,
            deadline,
            result_path,
            reader_ref,
        )
        if probe_seed is not None:
            value += (probe_seed,)
        return value

    return _portable_call(
        seconds,
        worker_target=worker_target,
        worker_args=args,
        worker_isolation=worker_isolation,
    )


def _portable_resolve_generation(
    store: InspectionStore,
    scan_id: str,
    catalog: ReaderCatalogSnapshot,
    source: Source,
    cursor: SourceCursor,
    seconds: float,
) -> tuple[ResolvedSourceReader, SourceProbe, str]:
    rows = store.db.execute(
        "SELECT generation_id,schema_version,reader_ref_json,policy_json,"
        "recognition_json,catalog_digest FROM scan_pass_reader_bindings "
        "WHERE scan_id=? AND source_id=?",
        (scan_id, source.source_id),
    ).fetchall()
    saved = {str(row["generation_id"]): dict(row) for row in rows}

    def args(deadline: float, result_path: str) -> tuple[Any, ...]:
        return (
            source,
            cursor,
            deadline,
            result_path,
            catalog.canonical_json(),
            catalog.digest,
            saved,
        )

    resolved, probe, generation_id = _portable_call(
        seconds,
        worker_target=_portable_resolve_worker,
        worker_args=args,
    )
    if generation_id not in saved:
        _save_resolved_binding(
            store, scan_id, source.source_id, generation_id, resolved
        )
    return resolved, probe, generation_id


def _binding(harness: str) -> dict:
    reader = _reader(harness)
    return {
        "reader": reader.READER_ID,
        "revision": reader.READER_REVISION,
        "normalization": reader.NORMALIZATION_VERSION,
        "parser": getattr(reader, "CAPTURE_PARSER_VERSION", 1),
    }


def _reader_policy(harness: str) -> ReaderBindingPolicy:
    reader = _reader(harness)
    return ReaderBindingPolicy(
        capture_contract_version=1,
        host_contract_version=1,
        reader_id=reader.READER_ID,
        reader_revision=reader.READER_REVISION,
        normalization_version=reader.NORMALIZATION_VERSION,
        resume_version=1,
        capture_schema_version=1,
        parser_version=getattr(reader, "CAPTURE_PARSER_VERSION", 1),
    )


def _loaded_reader_policy(ref: ReaderRef, reader: Any) -> ReaderBindingPolicy:
    policy = getattr(reader, "READER_POLICY", None)
    if isinstance(policy, ReaderBindingPolicy):
        return policy
    return ReaderBindingPolicy(
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


def _resolved_from_saved_row(catalog: ReaderCatalogSnapshot, row: Any, source_id: str) -> ResolvedSourceReader:
    try:
        if int(row["schema_version"]) != CATALOG_SCHEMA_VERSION:
            raise ValueError("reader binding schema mismatch")
        ref_data = json.loads(str(row["reader_ref_json"]))
        policy_data = json.loads(str(row["policy_json"]))
        recognition_data = json.loads(str(row["recognition_json"]))
        ref = ReaderRef(str(ref_data["reader_id"]), int(ref_data["revision"]), int(ref_data.get("contract_version", 1)))
        descriptor = catalog.descriptor(ref)
        if descriptor is None or descriptor.policy.canonical_json() != str(row["policy_json"]):
            raise ValueError("reader descriptor unavailable")
        # Validate package availability even when the saved recognition is
        # inconclusive.  A missing inactive reader must surface before source
        # discovery can hide it.
        from skill_hub.infrastructure.harnesses.harness_bundled_usage import load_usage_reader
        try:
            runtime_reader = load_usage_reader(ref)
        except (TypeError, ValueError, ImportError) as exc:
            raise ReplanRequired("reader_unavailable", source_id=source_id, ref=ref) from exc
        if _loaded_reader_policy(ref, runtime_reader).canonical_json() != descriptor.policy.canonical_json():
            raise ReplanRequired("reader_policy_incompatible", source_id=source_id, ref=ref)
        if str(row["catalog_digest"]) != catalog.digest:
            raise ValueError("reader catalog changed")
        recognition = SourceRecognition(
            recognition_data.get("producer"), recognition_data.get("producer_version"),
            recognition_data.get("native_format"), recognition_data.get("format_fingerprint"),
            str(recognition_data.get("completeness", "inconclusive")), str(recognition_data.get("reason", "")),
        )
        if (
            set(recognition_data) != {
                "completeness", "format_fingerprint", "native_format",
                "producer", "producer_version", "reason",
            }
            or recognition.completeness not in {"complete", "partial", "inconclusive"}
            or (recognition.native_format is not None and not isinstance(recognition.native_format, str))
            or (recognition.format_fingerprint is not None and not isinstance(recognition.format_fingerprint, str))
            or (
                recognition.completeness == "inconclusive"
                and recognition.native_format != "unknown_legacy"
                and recognition.reason != "legacy_binding"
            )
        ):
            raise ValueError("reader recognition invalid")
        if recognition.completeness != "inconclusive":
            if recognition.native_format not in descriptor.supported_formats:
                raise ValueError("reader recognition format changed")
            if (
                recognition.producer_version is None
                and descriptor.recognition_contract != "source_probe_v1_allow_unversioned"
            ):
                raise ValueError("reader recognition version missing")
            if (
                recognition.producer_version is not None
                and descriptor.supported_producer_versions
                and recognition.producer_version not in descriptor.supported_producer_versions
            ):
                raise ValueError("reader producer version changed")
        # Parsing policy_data above is intentional: malformed persisted policy
        # must fail closed even if the descriptor happens to be loadable.
        if not isinstance(policy_data, dict) or json.loads(descriptor.policy.canonical_json()) != policy_data:
            raise ValueError("reader policy changed")
        return ResolvedSourceReader(ref, descriptor.policy, recognition, catalog.digest)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ReplanRequired("reader_binding_invalid", source_id=source_id) from exc


def _save_resolved_binding(
    store: InspectionStore,
    scan_id: str,
    source_id: str,
    generation_id: str,
    resolved: ResolvedSourceReader,
) -> None:
    reader_ref_json = json.dumps(
        {
            "reader_id": resolved.ref.reader_id,
            "revision": resolved.ref.revision,
            "contract_version": resolved.ref.contract_version,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    recognition_json = json.dumps(
        {
            "producer": resolved.recognition.producer,
            "producer_version": resolved.recognition.producer_version,
            "native_format": resolved.recognition.native_format,
            "format_fingerprint": resolved.recognition.format_fingerprint,
            "completeness": resolved.recognition.completeness,
            "reason": resolved.recognition.reason,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    store.save_reader_binding(
        scan_id,
        source_id,
        generation_id,
        CATALOG_SCHEMA_VERSION,
        reader_ref_json,
        resolved.policy.canonical_json(),
        recognition_json,
        resolved.catalog_digest,
    )


def _resolve_generation_reader(
    store: InspectionStore,
    scan_id: str,
    catalog: ReaderCatalogSnapshot,
    source: Source,
    cursor: SourceCursor,
    deadline: float | None,
) -> tuple[ResolvedSourceReader, SourceProbe, str]:
    """Probe current bytes and bind their exact generation to the pass catalog."""
    host = SourceBoundCaptureHost(
        source.path,
        source_id=source.source_id,
        source_session_id=source.path.stem if source.harness == "claude-code" else "",
        deadline=deadline,
    )
    probe = probe_source(host, deadline=deadline)
    if probe.stop_reason == "deadline":
        raise TimeoutError("source budget exceeded")
    if probe.snapshot is None or probe.stop_reason == "source_changed":
        raise SourceChangedError("source changed during reader probe")
    generation_id = source_generation(
        source.path,
        cursor,
        probe.snapshot,
        lambda: append_proven(source.path, cursor),
    )
    saved = store.saved_reader_binding(scan_id, source.source_id, generation_id)
    resolved = (
        _resolved_from_saved_row(catalog, saved, source.source_id)
        if saved is not None
        else resolve_source_reader(catalog, probe, source.harness)
    )
    _validate_runtime_reader(resolved, source.source_id)
    if saved is None:
        _save_resolved_binding(store, scan_id, source.source_id, generation_id, resolved)
    return resolved, probe, generation_id


def _validate_runtime_reader(resolved: ResolvedSourceReader, source_id: str) -> None:
    """Require the loadable package to implement the catalog's exact policy."""
    try:
        runtime_reader = load_usage_reader(resolved.ref)
    except (TypeError, ValueError, ImportError) as exc:
        raise ReplanRequired(
            "reader_unavailable", source_id=source_id, ref=resolved.ref
        ) from exc
    if _loaded_reader_policy(resolved.ref, runtime_reader) != resolved.policy:
        raise ReplanRequired(
            "reader_policy_incompatible", source_id=source_id, ref=resolved.ref
        )


def _bind_capture_batch(
    batch: Any,
    resolved: ResolvedSourceReader,
    generation_id: str,
    source_id: str,
) -> Any:
    """Reject a capture that does not describe the reader selected for its bytes."""
    source = batch.source
    policy = resolved.policy
    if (
        source.source_id != source_id
        or source.generation_id != generation_id
        or source.reader_id != resolved.ref.reader_id
        or source.reader_revision != resolved.ref.revision
        or source.normalization_version != policy.normalization_version
        or source.resume_version != policy.resume_version
        or source.parser_version != policy.parser_version
        or batch.schema_version != policy.capture_schema_version
        or source.reader_source_evidence is None
    ):
        raise ReplanRequired("reader_batch_mismatch", source_id=source_id, ref=resolved.ref)
    expected_binding = resolved.binding()
    if (
        expected_binding is not None
        and source.reader_source_evidence != expected_binding.source_evidence
    ):
        raise ReplanRequired("reader_batch_mismatch", source_id=source_id, ref=resolved.ref)
    binding = ReaderBinding(policy, source.reader_source_evidence)
    return replace(batch, source=replace(source, reader_binding=binding))


def _discover(roots: dict[str, Path], layout: UsageLayout | None = None) -> list[Source]:
    return _discover_with_accounting(roots, layout=layout)


def _discover_with_accounting(
    roots: dict[str, Path], accounting: dict[str, dict[str, Any]] | None = None,
    *, layout: UsageLayout | None = None,
) -> list[Source]:
    """Discover valid sources and account for files rejected at the boundary.

    The old Claude scanner reported non-session JSONL files as skipped.  The
    canonical source inventory must keep that fact at discovery time because
    those files never become ``Source`` objects and cannot be reconstructed
    from the post-capture store state.
    """
    sources = []
    for harness, supplied_root in roots.items():
        root = layout.root(harness) if layout is not None else supplied_root
        if root is None:
            continue
        for path, accepted in iter_source_candidates(harness, root):
            if not accepted:
                if accounting is not None and harness == "claude-code":
                    accounting[harness]["skipped"] += 1
                continue
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue  # A removed source is handled by the complete inventory below.
            sources.append(
                Source(
                    path,
                    harness,
                    f"{harness}:{hashlib.sha256(str(path).encode()).hexdigest()}",
                    stat.st_mtime_ns,
                    stat.st_size,
                )
            )
    return sources


@contextmanager
def _source_guard(seconds: float) -> Iterator[float]:
    """Interrupt blocking source work in the CLI host, restoring prior alarms."""
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("inspection source guard requires the host main thread")
    started = time.monotonic()
    deadline = started + seconds

    def timeout(_signum: int, _frame: Any) -> None:
        raise TimeoutError("source budget exceeded")

    previous_handler = signal.signal(signal.SIGALRM, timeout)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, max(seconds, 0.001))
    try:
        yield deadline
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        remaining, interval = previous_timer
        if remaining:
            remaining = max(0.001, remaining - (time.monotonic() - started))
        signal.setitimer(signal.ITIMER_REAL, remaining, interval)


def _current(
    store: InspectionStore, source: Source, cursor: SourceCursor, binding: dict, policy: ReaderBindingPolicy,
) -> bool:
    row = store.db.execute(
        "SELECT status,parser_version FROM sources WHERE source_id=? AND generation_id=?",
        (source.source_id, cursor.generation_id),
    ).fetchone()
    return bool(
        row
        and row[0] == "active"
        and row[1] == binding["parser"]
        and usage_inspection.source_policy_matches(store, cursor, policy)
        and cursor.fingerprint.size == source.size
        and cursor.fingerprint.mtime_ns == source.mtime_ns
        and load_resume_state(
            cursor,
            reader_id=binding["reader"],
            reader_revision=binding["revision"],
            normalization_version=binding["normalization"],
        )
        is not None
    )


def _error(source: Source, kind: str, cursor: SourceCursor) -> dict:
    return {
        "file": source.path.name,
        "kind": kind,
        "source_id": source.source_id,
        "last_successful_cursor": {
            "generation_id": cursor.generation_id,
            "offset": cursor.offset,
            "revision": cursor.revision,
        },
    }


def _remember(
    store: InspectionStore,
    scan_id: str,
    source: Source,
    state: str,
    error: dict | None,
    attempted_at: str | None = None,
) -> None:
    store.db.execute(
        "INSERT INTO scan_pass_sources(scan_id,source_id,state,reason,attempted_at) VALUES (?,?,?,?,?) "
        "ON CONFLICT(scan_id,source_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,"
        "attempted_at=COALESCE(excluded.attempted_at,scan_pass_sources.attempted_at)",
        (scan_id, source.source_id, state, json.dumps(error) if error else None, attempted_at),
    )


def _saved_error(reason: str | None, source: Source, cursor: SourceCursor) -> dict | None:
    if not reason:
        return None
    try:
        parsed = json.loads(reason)
    except ValueError:
        return _error(source, reason, cursor)
    return parsed if isinstance(parsed, dict) else _error(source, str(parsed), cursor)


def _accounting_entry() -> dict[str, Any]:
    return {
        "sources_total": 0,
        "sources_done": 0,
        "sources_incomplete": 0,
        "new": 0,
        "appended": 0,
        "replaced": 0,
        "unchanged": 0,
        "reparsed": 0,
        "frozen_growth": 0,
        "skipped": 0,
        "processed": 0,
        "bytes_read": 0,
        "errors": 0,
        "error_details": [],
        "pending": 0,
        "stopped_on": None,
    }


def _source_change(
    store: InspectionStore,
    source: Source,
    cursor: SourceCursor,
    binding: dict[str, Any],
    policy: ReaderBindingPolicy,
) -> tuple[str, bool]:
    """Classify physical source change and whether capture needs a reparse."""
    if not cursor.generation_id:
        return "new", False
    policy_matches = usage_inspection.source_policy_matches(store, cursor, policy)
    resume_available = load_resume_state(
        cursor,
        reader_id=binding["reader"],
        reader_revision=binding["revision"],
        normalization_version=binding["normalization"],
    ) is not None
    reparsed = (
        not policy_matches
        or not resume_available
        or cursor.reader_id != binding["reader"]
        or cursor.reader_revision != binding["revision"]
        or cursor.normalization_version != binding["normalization"]
    )
    if source.size > cursor.fingerprint.size and append_proven(source.path, cursor):
        return "appended", reparsed
    if source.size == cursor.fingerprint.size and source.mtime_ns == cursor.fingerprint.mtime_ns:
        return "unchanged", reparsed
    return "replaced", reparsed


def _prior_summary_was_frozen(store: InspectionStore, source: Source, cursor: SourceCursor) -> bool:
    """Read the prior canonical root summary without deriving a new status."""
    source_ids = {source.path.stem}
    row = store.db.execute(
        "SELECT source_session_id FROM sources WHERE source_id=? ORDER BY revision DESC LIMIT 1",
        (source.source_id,),
    ).fetchone()
    if row is not None and isinstance(row[0], str):
        source_ids.add(str(row[0]))
    for session in store.db.execute(
        "SELECT root_session_id FROM sessions WHERE harness=? AND session_id IN ({})".format(
            ",".join("?" for _ in source_ids)
        ),
        (source.harness, *source_ids),
    ).fetchall():
        if isinstance(session[0], str):
            source_ids.add(str(session[0]))
    for item in store.db.execute(
        "SELECT payload_json FROM canonical_session_summaries WHERE harness=? AND session_id IN ({})".format(
            ",".join("?" for _ in source_ids)
        ),
        (source.harness, *source_ids),
    ).fetchall():
        try:
            payload = json.loads(str(item[0]))
        except (TypeError, ValueError):
            continue
        if payload.get("session_id") in source_ids and payload.get("frozen") is True:
            return True
    return False


def capture_pass(
    roots: dict[str, Path],
    *,
    layout: UsageLayout | None = None,
    max_sources: int | None = None,
    order: str = "newest",
    budget_seconds: float | None = None,
    scan_id: str | None = None,
    retry_incomplete: bool = False,
    now: dt.datetime | None = None,
) -> dict:
    """Capture one chunk; all counts describe the current combined inventory."""
    result: dict[str, Any] = dict.fromkeys(
        (
            "captured",
            "updated",
            "resumed",
            "retained",
            "incomplete",
            "bytes_read",
            "sources_total",
            "sources_done",
            "sources_pending",
            "sources_incomplete",
            "sources_skipped_unchanged",
            "sources_processed",
            "store_opens",
        ),
        0,
    )
    result.update(scan_id=scan_id, errors=[], partial=False, accounting={})
    seconds = DEFAULT_SOURCE_BUDGET if budget_seconds is None else budget_seconds
    if (
        (max_sources is not None and max_sources < 0)
        or not math.isfinite(seconds)
        or seconds < 0
        or order not in {"newest", "path"}
    ):
        result["errors"] = [{"kind": "invalid_scan_options"}]
        return result
    if retry_incomplete and not scan_id:
        result["errors"] = [{"kind": "retry_requires_scan_id"}]
        return result
    effective_now = now or dt.datetime.now(dt.timezone.utc)
    if effective_now.tzinfo is None:
        effective_now = effective_now.replace(tzinfo=dt.timezone.utc)
    stamp = effective_now.isoformat()
    bindings = {harness: _binding(harness) for harness in sorted(roots)}
    reader_policies = {harness: _reader_policy(harness) for harness in sorted(roots)}
    policy_bindings = {
        harness: {"digest": policy.digest(), "policy": json.loads(policy.canonical_json())}
        for harness, policy in reader_policies.items()
    }
    accounting = {harness: _accounting_entry() for harness in sorted(roots)}
    result["accounting"] = accounting
    registry = hub_core.load_registry() if hub_core.registry_file().exists() else {}
    enrichment = CaptureEnrichmentContext.from_registry(registry)
    capture_context_digest = enrichment.digest()
    requested = scan_id is not None
    scan_id = scan_id or "scan:" + uuid.uuid4().hex
    result["scan_id"] = scan_id
    try:
        with usage_inspection._store() as store:
            result["store_opens"] = 1
            previous = store.db.execute(
                "SELECT harnesses,reader_bindings,reader_policy_bindings,capture_context_digest,"
                "reader_catalog_json,reader_catalog_digest "
                "FROM scan_passes WHERE scan_id=?",
                (scan_id,),
            ).fetchone()
            if requested and previous is None:
                result["errors"] = [{"kind": "unknown_scan_id", "scan_id": scan_id}]
                return result
            if previous is not None:
                try:
                    stored_policies = json.loads(previous[2])
                    if not isinstance(stored_policies, dict):
                        raise ReplanRequired("reader_policy_incompatible", scan_id=scan_id)
                    if previous[4] and previous[5]:
                        catalog = restore_reader_catalog(str(previous[4]), str(previous[5]))
                    else:
                        # Passes from schema 6 had no separate catalog.  Their
                        # exact saved reader refs are the restricted catalog.
                        descriptors = []
                        legacy_bindings = json.loads(previous[1])
                        if not isinstance(legacy_bindings, dict):
                            raise ValueError("invalid legacy reader bindings")
                        available = capture_reader_catalog().available_readers
                        for harness, item in legacy_bindings.items():
                            if not isinstance(item, dict):
                                raise ValueError("invalid legacy reader binding")
                            ref = ReaderRef(str(item["reader"]), int(item["revision"]), 1)
                            descriptor = next(
                                (
                                    candidate for candidate in available
                                    if candidate.ref == ref and candidate.harness == harness
                                ),
                                None,
                            )
                            if descriptor is None:
                                raise ReplanRequired("reader_unavailable", ref=ref)
                            stored = stored_policies.get(harness, {})
                            policy_raw = stored.get("policy") if isinstance(stored, dict) else None
                            if isinstance(policy_raw, dict):
                                try:
                                    policy = ReaderBindingPolicy(**policy_raw)
                                except (TypeError, ValueError) as exc:
                                    raise ReplanRequired(
                                        "reader_policy_incompatible", ref=ref
                                    ) from exc
                                if policy.canonical_json() != descriptor.policy.canonical_json():
                                    raise ReplanRequired("reader_policy_incompatible", ref=ref)
                            else:
                                if (
                                    int(item.get("normalization", -1))
                                    != descriptor.policy.normalization_version
                                    or int(item.get("parser", -1)) != descriptor.policy.parser_version
                                ):
                                    raise ReplanRequired("reader_policy_incompatible", ref=ref)
                                policy = descriptor.policy
                            descriptors.append(replace(descriptor, policy=policy))
                        catalog = capture_reader_catalog(descriptors)
                    pass_bindings = json.loads(previous[1])
                    binding_refs_ok = all(
                        isinstance(item, dict)
                        and any(
                            descriptor.ref.reader_id == item.get("reader")
                            and descriptor.ref.revision == int(item.get("revision", -1))
                            and descriptor.policy.normalization_version
                            == int(item.get("normalization", descriptor.policy.normalization_version))
                            and descriptor.policy.parser_version
                            == int(item.get("parser", descriptor.policy.parser_version))
                            for descriptor in catalog.available_readers
                        )
                        for item in pass_bindings.values()
                    ) if isinstance(pass_bindings, dict) else False
                    compatible = (
                        json.loads(previous[0]) == sorted(roots)
                        and binding_refs_ok
                        # Passes created before immutable policy storage have
                        # no fixed policy. Their existing reader binding is the
                        # compatibility contract, so keep them resumable.
                        and isinstance(stored_policies, dict)
                        and (not previous[3] or str(previous[3]) == capture_context_digest)
                    )
                except ReplanRequired as exc:
                    if exc.scan_id is None:
                        exc = ReplanRequired(
                            exc.reason, source_id=exc.source_id, ref=exc.ref, scan_id=scan_id
                        )
                    result["errors"] = [exc.as_dict()]
                    result["partial"] = True
                    result["state"] = "replan_required"
                    store.db.execute(
                        "UPDATE scan_passes SET state=?,updated_at=?,errors=? WHERE scan_id=?",
                        ("replan_required", stamp, json.dumps(result["errors"]), scan_id),
                    )
                    return result
                except (ValueError, TypeError):
                    compatible = False
                if not compatible:
                    result["errors"] = [{"kind": "incompatible_reader_bindings", "scan_id": scan_id}]
                    return result
            else:
                # Keep the latest completed ID until another pass starts. Never
                # retire unfinished passes or their resumable source state.
                store.db.execute(
                    "DELETE FROM metadata WHERE key IN "
                    "(SELECT 'retention:' || scan_id FROM scan_passes WHERE state='complete')"
                )
                store.db.execute("DELETE FROM scan_passes WHERE state='complete'")
                store.db.execute(
                    "INSERT INTO scan_passes"
                    "(scan_id,started_at,updated_at,state,harnesses,reader_bindings,"
                    "reader_policy_bindings,capture_context_digest,reader_catalog_json,"
                    "reader_catalog_digest,errors) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        scan_id, stamp, stamp, "running", json.dumps(sorted(roots)), json.dumps(bindings),
                        json.dumps(policy_bindings, sort_keys=True, separators=(",", ":")),
                        capture_context_digest, "", "", "[]",
                    ),
                )
                catalog = capture_reader_catalog()
                store.save_reader_catalog(scan_id, catalog.canonical_json(), catalog.digest)
            if previous is not None and (not previous[4] or not previous[5]):
                store.save_reader_catalog(scan_id, catalog.canonical_json(), catalog.digest)
            # Validate every saved binding before discovery and quota handling.
            # A disappeared reader must leave the pass resumable and visible as
            # a replan request rather than silently falling back to today's one.
            try:
                for saved in store.db.execute(
                    "SELECT schema_version,reader_ref_json,policy_json,recognition_json,catalog_digest,source_id "
                    "FROM scan_pass_reader_bindings WHERE scan_id=?", (scan_id,)
                ).fetchall():
                    _resolved_from_saved_row(catalog, saved, str(saved["source_id"]))
            except ReplanRequired as exc:
                if exc.scan_id is None:
                    exc = ReplanRequired(
                        exc.reason, source_id=exc.source_id, ref=exc.ref, scan_id=scan_id
                    )
                result["errors"] = [exc.as_dict()]
                result["partial"] = True
                result["state"] = "replan_required"
                store.db.execute(
                    "UPDATE scan_passes SET state=?,updated_at=?,errors=? WHERE scan_id=?",
                    ("replan_required", stamp, json.dumps(result["errors"]), scan_id),
                )
                return result
            summary_context = None
            sources = _discover_with_accounting(roots, accounting, layout=layout)
            if order == "newest":
                sources.sort(key=lambda source: (-source.mtime_ns, str(source.path)))
            else:
                sources.sort(key=lambda source: str(source.path))
            result["sources_total"] = len(sources)
            for harness in accounting:
                accounting[harness]["sources_total"] = sum(
                    source.harness == harness for source in sources
                )
            states: dict[str, str] = {}
            unresolved: dict[str, dict] = {}
            cursors: dict[str, SourceCursor] = {}
            source_changes: dict[str, tuple[str, bool, bool]] = {}
            resolved_sources: dict[str, ResolvedSourceReader] = {}
            preflight_observations: dict[
                str, tuple[ResolvedSourceReader, SourceProbe, str, SourceCursor]
            ] = {}
            probe_elapsed: dict[str, float] = {}
            for source in sources:
                cursor = store.source_cursor(source.source_id)
                cursors[source.source_id] = cursor
                probe_started = time.monotonic()
                try:
                    if seconds <= 0:
                        raise TimeoutError("source budget exceeded")
                    probe_allowance = seconds
                    if _signal_guard_available():
                        with _source_guard(probe_allowance) as probe_deadline:
                            resolved, probe, generation_id = _resolve_generation_reader(
                                store, scan_id, catalog, source, cursor, probe_deadline
                            )
                    else:
                        resolved, probe, generation_id = _portable_resolve_generation(
                            store,
                            scan_id,
                            catalog,
                            source,
                            cursor,
                            probe_allowance,
                        )
                    resolved_sources[source.source_id] = resolved
                    preflight_observations[source.source_id] = (
                        resolved,
                        probe,
                        generation_id,
                        cursor,
                    )
                except ReplanRequired as exc:
                    if exc.source_id is None:
                        exc = ReplanRequired(
                            exc.reason, source_id=source.source_id, ref=exc.ref, scan_id=scan_id
                        )
                    elif exc.scan_id is None:
                        exc = ReplanRequired(
                            exc.reason, source_id=exc.source_id, ref=exc.ref, scan_id=scan_id
                        )
                    states[source.source_id] = "replan_required"
                    unresolved[source.source_id] = {**exc.as_dict(), "file": source.path.name}
                    _remember(store, scan_id, source, "replan_required", unresolved[source.source_id], stamp)
                    source_changes[source.source_id] = ("replan_required", False, False)
                    continue
                except (OSError, TimeoutError, SourceChangedError) as exc:
                    transient_error = _error(source, type(exc).__name__, cursor)
                    states[source.source_id] = "incomplete"
                    unresolved[source.source_id] = transient_error
                    source_changes[source.source_id] = ("unchanged", False, False)
                    _remember(store, scan_id, source, "incomplete", transient_error, stamp)
                    continue
                finally:
                    probe_elapsed[source.source_id] = time.monotonic() - probe_started
                policy = resolved_sources[source.source_id].policy
                binding = {
                    "reader": resolved_sources[source.source_id].ref.reader_id,
                    "revision": resolved_sources[source.source_id].ref.revision,
                    "normalization": policy.normalization_version,
                    "parser": policy.parser_version,
                }
                change, reparsed = _source_change(store, source, cursor, binding, policy)
                was_frozen = _prior_summary_was_frozen(store, source, cursor)
                source_changes[source.source_id] = (change, reparsed, was_frozen)
                row = store.db.execute(
                    "SELECT state,reason FROM scan_pass_sources WHERE scan_id=? AND source_id=?",
                    (scan_id, source.source_id),
                ).fetchone()
                state = str(row[0]) if row else "pending"
                error = _saved_error(row[1], source, cursor) if row else None
                tail_changed = (
                    error is not None
                    and error.get("kind") == "partial_source"
                    and (cursor.fingerprint.size != source.size or cursor.fingerprint.mtime_ns != source.mtime_ns)
                )
                if state == "incomplete" and (retry_incomplete or tail_changed):
                    state = "retry_pending"
                if state not in {"incomplete", "retry_pending"}:
                    if _current(store, source, cursor, binding, policy):
                        state = "done"
                        result["sources_skipped_unchanged"] += 1
                        result["captured"] += 1
                        accounting[source.harness]["unchanged"] += 1
                        accounting[source.harness]["skipped"] += 1
                    else:
                        state = "pending"
                states[source.source_id] = state
                if error:
                    unresolved[source.source_id] = error
                _remember(store, scan_id, source, state, error)
            if any(state == "replan_required" for state in states.values()):
                result["errors"] = list(unresolved.values())
                result["partial"] = True
                result["state"] = "replan_required"
                result["sources_done"] = sum(state == "done" for state in states.values())
                result["sources_incomplete"] = sum(state == "incomplete" for state in states.values())
                result["sources_pending"] = sum(state in {"pending", "retry_pending"} for state in states.values())
                store.db.execute(
                    "UPDATE scan_passes SET state=?,updated_at=?,errors=? WHERE scan_id=?",
                    ("replan_required", stamp, json.dumps(result["errors"]), scan_id),
                )
                return result
            summary_context = usage_summary_export.prepare_context(store, scan_id, registry, effective_now)
            # Missing sources are unavailable, not indefinitely failed work.
            for harness in roots:
                seen = {source.source_id for source in sources if source.harness == harness}
                result["retained"] += store.mark_missing_sources(harness, seen)
            known_ids = {source.source_id for source in sources}
            for row in store.db.execute(
                "SELECT source_id FROM scan_pass_sources WHERE scan_id=?", (scan_id,)
            ).fetchall():
                if row[0] not in known_ids:
                    store.db.execute("DELETE FROM scan_pass_sources WHERE scan_id=? AND source_id=?", (scan_id, row[0]))
            cancelled = False
            replan_encountered = False
            for source in sources:
                if states[source.source_id] not in {"pending", "retry_pending"}:
                    continue
                if max_sources is not None and result["sources_processed"] >= max_sources:
                    break
                cursor = cursors[source.source_id]
                result["sources_processed"] += 1
                accounting[source.harness]["processed"] += 1
                change, reparsed, was_frozen = source_changes[source.source_id]
                if change != "unchanged":
                    accounting[source.harness][change] += 1
                accounting[source.harness]["reparsed"] += int(reparsed)
                if change == "appended" and was_frozen:
                    accounting[source.harness]["frozen_growth"] += 1
                merged: Any = None
                try:
                    remaining_budget = max(0.0, seconds - probe_elapsed[source.source_id])
                    preflight = preflight_observations[source.source_id]
                    attempt = 0

                    def capture_cursor(
                        current: SourceCursor, selected: ResolvedSourceReader
                    ) -> SourceCursor:
                        capture_cursor = current
                        if not usage_inspection.source_policy_matches(
                            store, current, selected.policy
                        ):
                            capture_cursor = replace(
                                current, offset=0, resume_state="", resume_version=0
                            )
                        return capture_cursor

                    if _signal_guard_available():
                        with _source_guard(remaining_budget) as deadline:

                            def build(current: SourceCursor):
                                nonlocal attempt
                                attempt += 1
                                reused = attempt == 1 and current == preflight[3]
                                if reused:
                                    selected, probe, generation_id, _ = preflight
                                else:
                                    selected, probe, generation_id = _resolve_generation_reader(
                                        store, scan_id, catalog, source, current, deadline
                                    )
                                reader_source = ReaderSource(
                                    source.source_id,
                                    source.harness,
                                    source.path.stem if source.harness == "claude-code" else "",
                                    str(source.path),
                                )
                                host = SourceBoundCaptureHost(
                                    source.path, source_id=source.source_id,
                                    source_session_id=reader_source.source_session_id or None,
                                    deadline=deadline,
                                )
                                if not host.install_probe_seed(probe):
                                    selected, probe, generation_id = _resolve_generation_reader(
                                        store, scan_id, catalog, source, current, deadline
                                    )
                                    host = SourceBoundCaptureHost(
                                        source.path,
                                        source_id=source.source_id,
                                        source_session_id=reader_source.source_session_id or None,
                                        deadline=deadline,
                                    )
                                    if not host.install_probe_seed(probe):
                                        raise SourceChangedError(
                                            "source changed after reader selection"
                                        )
                                selected_cursor = capture_cursor(current, selected)
                                batch = load_usage_reader(selected.ref).capture(
                                    reader_source, selected_cursor, host, deadline=deadline
                                )
                                return _bind_capture_batch(
                                    batch, selected, generation_id, source.source_id
                                )

                            merged = usage_inspection.capture_scan_source(
                                CaptureSource(source.source_id, source.harness, source.path.stem), build, store,
                                None,
                                enrichment,
                            )
                    else:
                        deadline = time.monotonic() + remaining_budget

                        def build_portable(current: SourceCursor):
                            nonlocal attempt
                            attempt += 1
                            reused = attempt == 1 and current == preflight[3]
                            remaining = max(0.0, deadline - time.monotonic())
                            if reused:
                                selected, probe, generation_id, _ = preflight
                            else:
                                selected, probe, generation_id = _portable_resolve_generation(
                                    store, scan_id, catalog, source, current, remaining
                                )

                            def parse_selected() -> Any:
                                return _portable_parse(
                                    source.harness,
                                    source.path,
                                    capture_cursor(current, selected),
                                    max(0.0, deadline - time.monotonic()),
                                    reader_ref=selected.ref,
                                    **(
                                        {"probe_seed": probe}
                                        if "probe_seed"
                                        in __import__("inspect").signature(_portable_parse).parameters
                                        else {}
                                    ),
                                )

                            try:
                                batch = parse_selected()
                            except SourceChangedError:
                                if not reused:
                                    raise
                                selected, probe, generation_id = _portable_resolve_generation(
                                    store,
                                    scan_id,
                                    catalog,
                                    source,
                                    current,
                                    max(0.0, deadline - time.monotonic()),
                                )
                                batch = parse_selected()
                            return _bind_capture_batch(
                                batch, selected, generation_id, source.source_id
                            )

                        merged = usage_inspection.capture_scan_source(
                            CaptureSource(source.source_id, source.harness, source.path.stem), build_portable, store,
                            None,
                            enrichment,
                        )
                    result["bytes_read"] += merged.bytes_read
                    accounting[source.harness]["bytes_read"] += merged.bytes_read
                    if merged.outcome in {"captured", "unchanged"}:
                        states[source.source_id] = "done"
                        unresolved.pop(source.source_id, None)
                        result["captured"] += 1
                        result["updated"] += int(merged.committed_cursor.revision > 1 and merged.outcome == "captured")
                        result["resumed"] += int(cursor.offset > 0 and merged.outcome == "captured")
                        _remember(store, scan_id, source, "done", None, stamp)
                        continue
                    kind = "retry_exhausted" if merged.outcome == "retry_required" else "partial_source"
                except KeyboardInterrupt:
                    cancelled = True
                    break
                except ReplanRequired as exc:
                    exc = ReplanRequired(
                        exc.reason,
                        source_id=exc.source_id or source.source_id,
                        ref=exc.ref,
                        scan_id=exc.scan_id or scan_id,
                    )
                    error = {**exc.as_dict(), "file": source.path.name}
                    states[source.source_id] = "replan_required"
                    unresolved[source.source_id] = error
                    _remember(store, scan_id, source, "replan_required", error, stamp)
                    replan_encountered = True
                    continue
                except Exception as exc:  # One failed source must not block healthy sources.
                    kind = str(getattr(exc, "kind", "")) or type(exc).__name__
                error_cursor = (
                    merged.committed_cursor
                    if merged is not None and merged.outcome == "incomplete"
                    else cursor
                )
                error = _error(source, kind, error_cursor)
                states[source.source_id] = "incomplete"
                unresolved[source.source_id] = error
                _remember(store, scan_id, source, "incomplete", error, stamp)
            result["sources_done"] = sum(state == "done" for state in states.values())
            result["sources_incomplete"] = sum(state == "incomplete" for state in states.values())
            result["sources_pending"] = len(states) - result["sources_done"] - result["sources_incomplete"]
            result["incomplete"] = result["sources_incomplete"]
            for source in sources:
                harness = source.harness
                state = states[source.source_id]
                accounting[harness]["sources_done"] += int(state == "done")
                accounting[harness]["sources_incomplete"] += int(state == "incomplete")
                accounting[harness]["pending"] += int(state == "pending")
                error = unresolved.get(source.source_id)
                if error is not None:
                    accounting[harness]["errors"] += 1
                    accounting[harness]["error_details"].append(error)
                    if accounting[harness]["stopped_on"] is None:
                        accounting[harness]["stopped_on"] = source.path.name
            result["errors"] = list(unresolved.values())
            result["partial"] = bool(result["sources_pending"] or result["sources_incomplete"])
            if replan_encountered:
                result["state"] = "replan_required"
                result["partial"] = True
                store.db.execute(
                    "UPDATE scan_passes SET state=?,updated_at=?,errors=? WHERE scan_id=?",
                    ("replan_required", stamp, json.dumps(result["errors"]), scan_id),
                )
                return result
            # Run housekeeping after draining eligible work, once per pass. The
            # indexed store operation bounds retention work independently.
            marker = "retention:" + scan_id
            if (
                not cancelled
                and result["sources_pending"] == 0
                and store.db.execute("SELECT 1 FROM metadata WHERE key=?", (marker,)).fetchone() is None
            ):
                settings = load_retention_config()
                with hub_core.data_home_lock():
                    result["retention"] = store.prune_bodies(
                        now=effective_now,
                        older_than_days=settings["older_than_days"],
                        max_store_bytes=settings["max_store_bytes"],
                    )
                    if result["retention"].get("ok"):
                        store.db.execute("INSERT INTO metadata(key,value) VALUES (?,?)", (marker, stamp))
                    else:
                        result["errors"].append({"kind": "retention_failed"})
            result["summary"] = usage_summary_export.refresh_and_export(
                store, context=summary_context,
                incomplete_sources={
                    source_id for source_id, source_state in states.items() if source_state == "incomplete"
                },
                pending_sources=bool(result["sources_pending"]),
            )
            store.db.execute(
                "INSERT INTO metadata(key,value) VALUES ('summary_last_scan_at',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (summary_context["now"],)
            )
            state = (
                "cancelled"
                if cancelled
                else "complete"
                if not result["partial"] and not result["errors"]
                else "stopped"
                if not result["sources_pending"]
                else "running"
            )
            result["state"] = state
            store.db.execute(
                "UPDATE scan_passes SET state=?,updated_at=?,errors=? WHERE scan_id=?",
                (state, stamp, json.dumps(result["errors"]), scan_id),
            )
    except ReplanRequired as exc:
        if exc.scan_id is None:
            exc = ReplanRequired(
                exc.reason, source_id=exc.source_id, ref=exc.ref, scan_id=scan_id
            )
        result["errors"].append(exc.as_dict())
        result["partial"] = True
        result["state"] = "replan_required"
    except Exception as exc:
        result["errors"].append({"kind": type(exc).__name__, "message": str(exc)})
    return result
