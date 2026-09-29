"""Contracts for the dependency-light Usage reader SDK boundary."""

from __future__ import annotations

import ast
import json
import multiprocessing as mp
import pickle
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath

import pytest

import skill_hub.domain.usage.usage_classify as usage_classify
from skill_hub.domain.harnesses.harness_usage_api import (
    ReaderHostCompatibilityError,
    SourceCursor,
    SourceFingerprint,
    capture_operation_summary,
    require_operation_summary_host_v1,
    source_generation,
)
from skill_hub.domain.usage.usage_inspection_capture import (
    CaptureBatch,
    RootResolution,
    SourceInput,
)
from skill_hub.infrastructure.usage.usage_capture_summary import operation_summary, with_operation_summary_v1
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_reader_context import SourceBoundCaptureHost

REPO_ROOT = Path(__file__).resolve().parent.parent


def _round_trip_worker(payload: bytes, output: mp.Queue[bytes]) -> None:
    output.put(pickle.dumps(pickle.loads(payload), protocol=pickle.HIGHEST_PROTOCOL))


SDK_MODULES = (
    "skill_hub.domain.harnesses.harness_usage_api",
    "skill_hub.domain.usage.usage_inspection_capture",
    "skill_hub.infrastructure.usage.usage_jsonl",
)


def test_sdk_modules_import_from_three_file_closure(tmp_path: Path) -> None:
    for name in SDK_MODULES:
        relative = Path(*name.split(".")).with_suffix(".py")
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO_ROOT / relative, target)
        for parent in relative.parents:
            if parent != Path("."):
                shutil.copyfile(REPO_ROOT / parent / "__init__.py", tmp_path / parent / "__init__.py")
    code = """
import importlib
import os
import sys
for name in MODULES:
    module = importlib.import_module(name)
    assert module.__file__.startswith(os.getcwd()), module.__file__
from skill_hub.domain.harnesses.harness_usage_api import capture_records, SourceFingerprint
assert capture_records(object(), b'{"ok": true}\\n', SourceFingerprint(None, None, 0, 0, "", ""), 0) == ({"ok": True},)
for name in ('hub', 'skill_hub.hub_core', 'skill_hub.domain.usage.usage_classify',
             'skill_hub.infrastructure.usage.usage_capture_summary',
             'skill_hub.infrastructure.usage.usage_reader_context'):
    assert name not in sys.modules, name
""".replace("MODULES", repr(SDK_MODULES))
    subprocess.run([sys.executable, "-S", "-c", code], cwd=tmp_path,
                   env={"PYTHONPATH": str(tmp_path)}, check=True)


def test_sdk_static_import_closure() -> None:
    allowed_local = set(SDK_MODULES[1:])
    stdlib = {"collections", "dataclasses", "hashlib", "json", "pathlib", "re", "time", "typing", "__future__"}
    for name in SDK_MODULES:
        filename = Path(*name.split(".")).with_suffix(".py")
        tree = ast.parse((REPO_ROOT / filename).read_text(), str(filename))
        imported = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0
        }
        imported.update(alias.name for node in ast.walk(tree)
                        if isinstance(node, ast.Import) for alias in node.names)
        assert not {name for name in imported
                    if name not in allowed_local and name.split(".", 1)[0] not in stdlib}


def test_spawn_round_trip_preserves_record_module_identity() -> None:
    fingerprint = SourceFingerprint(None, None, 0, 0, "", "")
    source = SourceInput(
        "source:test", "claude-code", "session", "generation:test", 0, 0, 0, fingerprint, "active"
    )
    batch = CaptureBatch(1, "", RootResolution("claude-code", "session", "session", None, "root"), source)
    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    process = ctx.Process(target=_round_trip_worker, args=(pickle.dumps(batch), queue))
    process.start()
    encoded = queue.get(timeout=10)
    process.join(timeout=10)
    assert process.exitcode == 0
    restored = pickle.loads(encoded)
    assert isinstance(restored, CaptureBatch)
    assert type(restored).__module__ == "skill_hub.domain.usage.usage_inspection_capture"
    assert type(restored.source).__module__ == "skill_hub.domain.usage.usage_inspection_capture"
    assert type(restored.source.fingerprint).__module__ == "skill_hub.domain.usage.usage_inspection_capture"
    assert SourceCursor.__module__ == "skill_hub.domain.usage.usage_inspection_capture"


def test_missing_summary_capability_fails_before_other_host_operations() -> None:
    events: list[str] = []

    class Host:
        operation_summary_v1 = None

        def fingerprint(self):
            events.append("fingerprint")
            raise AssertionError("fingerprint must not be called")

    with pytest.raises(ReaderHostCompatibilityError):
        capture_operation_summary(Host(), "Read", "{}")
    assert events == []


def test_summary_capability_exceptions_propagate() -> None:
    class Host:
        def operation_summary_v1(self, *_args, **_kwargs):
            raise RuntimeError("summary host failed")

    with pytest.raises(RuntimeError, match="summary host failed"):
        capture_operation_summary(Host(), "Read", "{}")


def test_compatibility_wrapper_delegates_optional_extensions_without_inventing_decode() -> None:
    class LegacyHost:
        def fingerprint(self):
            return "fingerprint"

    adapted = with_operation_summary_v1(LegacyHost())
    assert adapted.fingerprint() == "fingerprint"
    assert capture_operation_summary(adapted, "Read", "{}") == "{}"
    assert not hasattr(adapted, "decoded_records")
    assert require_operation_summary_host_v1(adapted) is adapted


class _LegacyHost:
    def __init__(self, inner: SourceBoundCaptureHost) -> None:
        self._inner = inner

    def fingerprint(self):
        return self._inner.fingerprint()

    def append_proven(self, cursor):
        return self._inner.append_proven(cursor)

    def read_complete_suffix(self, cursor, deadline=None):
        return self._inner.read_complete_suffix(cursor, deadline)

    def snapshot_matches(self, fingerprint):
        return self._inner.snapshot_matches(fingerprint)

    def hashes_for_commit(self, offset, prefix_sha256=""):
        return self._inner.hashes_for_commit(offset, prefix_sha256)


class _LegacyHostWithDecoder(_LegacyHost):
    def __init__(self, inner: SourceBoundCaptureHost) -> None:
        super().__init__(inner)
        self.decode_calls = 0

    def decoded_records(self, raw, fingerprint, offset_start, *, deadline=None):
        self.decode_calls += 1
        return self._inner.decoded_records(raw, fingerprint, offset_start, deadline=deadline)


@pytest.mark.parametrize("with_decoder", [False, True])
def test_old_host_root_adapter_preserves_optional_decoder_contract(
    tmp_path: Path, with_decoder: bool
) -> None:
    path = tmp_path / "session.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({
                    "type": "user", "uuid": "u", "sessionId": "session",
                    "message": {"role": "user", "content": "hello"},
                }),
                json.dumps({
                    "type": "assistant", "uuid": "a", "sessionId": "session",
                    "message": {"role": "assistant", "content": [
                        {"type": "tool_use", "id": "call-1", "name": "Bash", "input": {"command": "printf retained"}},
                    ]},
                }),
            ]
        )
        + "\n"
    )
    inner = SourceBoundCaptureHost(path, source_session_id="session")
    host = _LegacyHostWithDecoder(inner) if with_decoder else _LegacyHost(inner)
    batch = capture_claude_source(path, host=host)
    assert batch.messages
    assert len(batch.tool_calls) == 1
    assert batch.tool_calls[0].operation_summary == '{"command":"printf retained"}'
    if with_decoder:
        assert host.decode_calls == 1
    else:
        assert not hasattr(host, "decoded_records")


def test_source_generation_accepts_lexical_string_and_append_callback() -> None:
    fingerprint = SourceFingerprint(None, None, 4, 7, "prefix", "boundary")
    cursor = SourceCursor("source", "generation", 1, 4, fingerprint)
    calls: list[str] = []

    def append_check() -> bool:
        calls.append("checked")
        return True

    assert source_generation("opaque/source.jsonl", cursor, fingerprint, append_check) == "generation"
    assert calls == ["checked"]


def test_operation_summary_tracks_home_patterns_and_limits_per_call(monkeypatch: pytest.MonkeyPatch) -> None:
    token = "ghp_" + "aB12" * 10
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: PurePosixPath("/Users/first")))
    first = operation_summary("Bash", json.dumps({"command": f"cat /Users/first/repo/{token}"}), limit=80)
    assert first is not None and "~" in first and "/Users/first" not in first
    assert token not in first and "[redacted]" in first

    monkeypatch.setattr(Path, "home", classmethod(lambda cls: PurePosixPath("/Users/second")))
    second = operation_summary("Bash", json.dumps({"command": "/Users/second/repo/next.py"}))
    assert second == '{"command": "~/next.py"}'
    assert operation_summary("Bash", json.dumps({"command": "/Users/second/repo/next.py"}), limit=12) == second[:12]

    monkeypatch.setattr(Path, "home", classmethod(lambda cls: PureWindowsPath(r"C:\Users\Ada")))
    windows = operation_summary("Bash", json.dumps({"command": r"C:\Users\Ada\repo\script.py"}))
    assert windows is not None and "~" in windows and "Ada" not in windows and "script.py" in windows

    edit = operation_summary(
        "Edit",
        json.dumps({"file_path": r"C:\Users\Ada\repo\file.py", "old_string": token}),
    )
    assert edit is not None and "file.py" in edit and token not in edit


def test_summary_uses_current_host_secret_patterns_before_truncation(monkeypatch: pytest.MonkeyPatch) -> None:
    original = usage_classify.mcp_spec.looks_like_secret
    monkeypatch.setattr(
        usage_classify.mcp_spec,
        "looks_like_secret",
        lambda key, value: value == "fixture-secret-value" or original(key, value),
    )
    # A JSON string lets the custom token reach the host's token policy verbatim.
    value = json.dumps("prefix fixture-secret-value suffix")
    assert operation_summary("Bash", value) == "prefix [redacted] suffix"
    assert operation_summary("Bash", value, limit=11) == "prefix [red"
    monkeypatch.setattr(usage_classify.mcp_spec, "looks_like_secret", lambda key, value: False)
    assert operation_summary("Bash", value) == "prefix fixture-secret-value suffix"
