from __future__ import annotations

import shutil
from pathlib import Path

from skill_hub.infrastructure.harnesses import harness_native_executor as native_executor
from tests.harness_supervision_helpers import fixture_launch
from tests.test_harness_native_executor import _identity, _recipe


def _recipe_with_proof():
    return _recipe(
        code=(
            "from pathlib import Path; import os; "
            "Path(os.environ['SKILL_HUB_NATIVE_PROOF_PATH']).write_text('READY'); "
            "print('execution-evidence')"
        ),
        isolation={"roots": {}, "proof_token": "READY"},
    )


def test_transient_sandbox_cleanup_permission_error_retries(monkeypatch):
    recipe = _recipe_with_proof()
    created: list[Path] = []
    real_mkdtemp = native_executor.tempfile.mkdtemp
    real_remove = native_executor._remove_tree
    calls = 0

    def track_temp(*args, **kwargs):
        path = Path(real_mkdtemp(*args, **kwargs))
        created.append(path)
        return str(path)

    def fail_once(path: Path):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise PermissionError("transient sharing violation")
        shutil.rmtree(path)

    monkeypatch.setattr(native_executor.tempfile, "mkdtemp", track_temp)
    monkeypatch.setattr(native_executor, "_remove_tree", fail_once)
    result = native_executor.execute_native(
        native_executor.NativeRequest(recipe.recipe_id, True),
        {recipe.recipe_id: recipe},
        _identity(),
        supervisor=fixture_launch,
    )

    assert result.status == "pass"
    assert calls == 2
    assert result.proof["verdict"] == "pass"
    assert result.logs["stdout"].splitlines() == ["execution-evidence"]
    assert not created[0].exists()
    monkeypatch.setattr(native_executor, "_remove_tree", real_remove)


def test_persistent_sandbox_cleanup_permission_error_preserves_evidence(monkeypatch):
    recipe = _recipe_with_proof()
    created: list[Path] = []
    real_mkdtemp = native_executor.tempfile.mkdtemp
    real_remove = native_executor._remove_tree

    def track_temp(*args, **kwargs):
        path = Path(real_mkdtemp(*args, **kwargs))
        created.append(path)
        return str(path)

    def always_fail(path: Path):
        raise PermissionError("persistent sharing violation")

    monkeypatch.setattr(native_executor.tempfile, "mkdtemp", track_temp)
    monkeypatch.setattr(native_executor, "_remove_tree", always_fail)
    result = native_executor.execute_native(
        native_executor.NativeRequest(recipe.recipe_id, True),
        {recipe.recipe_id: recipe},
        _identity(),
        supervisor=fixture_launch,
    )

    assert result.status == "inconclusive"
    assert result.reason == "sandbox cleanup failed: PermissionError"
    assert result.evidence["provenance"] == "fixture"
    assert result.logs["stdout"].splitlines() == ["execution-evidence"]
    assert result.proof["verdict"] == "pass"
    assert created[0].exists()
    monkeypatch.setattr(native_executor, "_remove_tree", real_remove)
    real_remove(created[0])


def test_proof_artifact_rejects_oversize_file_with_bounded_read(tmp_path):
    recipe = _recipe(
        code=(
            "from pathlib import Path; import os; "
            "Path(os.environ['SKILL_HUB_NATIVE_PROOF_PATH']).write_bytes(b'x' * 10001)"
        ),
        isolation={"roots": {}},
    )
    result = native_executor.execute_native(
        native_executor.NativeRequest(recipe.recipe_id, True),
        {recipe.recipe_id: recipe},
        _identity(),
        lambda _: tmp_path,
        supervisor=fixture_launch,
    )

    assert result.status == "fail"
    assert result.reason == "proof artifact exceeded bound"
