from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from skill_hub.infrastructure.harnesses import harness_validation as integration_validation
from tests.harness_supervision_helpers import fixture_supervision  # noqa: F401


def _catalog(tmp_path: Path, selector: str, *, gap=None, timeout=10, case_id="offline-positive"):
    path = tmp_path / "catalog.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "cases": [
                    {
                        "id": case_id,
                        "description": "a deterministic contract",
                        "harnesses": ["pi"],
                        "feature": "contract",
                        "layer": "offline",
                        "profiles": ["quick", "offline"],
                        "platforms": ["macos", "linux", "windows"],
                        "selectors": [selector],
                        "timeout_seconds": timeout,
                        "gap": gap,
                    }
                ],
            }
        )
    )
    return path


def _write_catalog(tmp_path: Path, cases):
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"schema_version": 1, "cases": cases}))
    return path


def _case(case_id, selector, *, layer="offline", gap=None, timeout=10, platforms=None):
    return {
        "id": case_id,
        "description": case_id,
        "harnesses": ["pi"],
        "feature": "contract",
        "layer": layer,
        "profiles": ["quick", "offline"],
        "platforms": platforms or ["macos", "linux", "windows"],
        "selectors": [selector],
        "timeout_seconds": timeout,
        "gap": gap,
    }


def test_source_digest_covers_nested_package_modules(tmp_path):
    module = tmp_path / "skill_hub" / "domain" / "nested.py"
    module.parent.mkdir(parents=True)
    module.write_text("VALUE = 1\n")

    first = integration_validation._source_digest(tmp_path)
    module.write_text("VALUE = 2\n")
    second = integration_validation._source_digest(tmp_path)

    assert first is not None
    assert second is not None
    assert first != second


def test_run_writes_json_and_markdown_evidence(tmp_path, capsys):
    test_file = tmp_path / "contract_test.py"
    test_file.write_text("def test_contract():\n    assert True\n")
    catalog = _catalog(tmp_path, "contract_test.py::test_contract")
    report_dir = tmp_path / "reports"

    result = integration_validation.main(
        [
            "run",
            "--catalog",
            str(catalog),
            "--repo-root",
            str(tmp_path),
            "--report-dir",
            str(report_dir),
            "--case",
            "offline-positive",
        ]
    )

    assert result == 0
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert report["status"] == "complete"
    assert report["cases"][0]["status"] == "pass"
    assert report["cases"][0]["pytest"]["passed"] == 1
    assert (run_path / "report.md").exists()


def test_failures_and_gaps_are_retained_as_separate_outcomes(tmp_path, capsys):
    test_file = tmp_path / "contracts.py"
    test_file.write_text(
        "def test_fail():\n    assert False\n\n"
        "def test_pass():\n    assert True\n"
    )
    catalog = _write_catalog(
        tmp_path,
        [
            _case("known-failure", "contracts.py::test_fail"),
            _case("known-pass", "contracts.py::test_pass"),
            _case("native-gap", "contracts.py::test_pass", layer="native", gap="requires a native harness"),
        ],
    )
    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert [case["status"] for case in report["cases"]] == ["fail", "pass", "unsupported"]
    assert report["coverage_gaps"] == [{"id": "native-gap", "reason": "requires a native harness"}]
    assert report["summary"]["fail"] == 1
    assert report["summary"]["pass"] == 1


def test_environment_is_sanitized_and_logs_are_bounded(tmp_path, monkeypatch, capsys):
    test_file = tmp_path / "environment_contract.py"
    test_file.write_text(
        "import os\n"
        "from pathlib import Path\n"
        "import subprocess\n"
        "def test_environment():\n"
        "    assert os.environ.get('RUN_LIVE_CODEX') is None\n"
        "    assert os.environ.get('SKILL_HUB_DIR') is None\n"
        "    assert os.environ.get('CODEX_HOME') not in (None, '/real/home/.codex')\n"
        "    assert os.environ['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] == '1'\n"
        "    assert os.environ['PYTHONIOENCODING'] == 'utf-8'\n"
        "    assert os.environ['PYTHONUTF8'] == '1'\n"
        "    try:\n"
        "        subprocess.run(['/usr/bin/codex', '--version'])\n"
        "    except RuntimeError as error:\n"
        "        assert 'blocked harness' in str(error)\n"
        "    else:\n"
        "        raise AssertionError('real harness guard did not run')\n"
        "    try:\n"
        "        subprocess.run(['codex.exe', '--version'])\n"
        "    except RuntimeError as error:\n"
        "        assert 'blocked harness' in str(error)\n"
        "    else:\n"
        "        raise AssertionError('Windows harness guard did not run')\n"
        "    root_codex = Path.cwd() / 'codex'\n"
        "    root_codex.write_text('#!/bin/sh\\nexit 0\\n')\n"
        "    root_codex.chmod(0o700)\n"
        "    try:\n"
        "        subprocess.run([str(root_codex), '--version'])\n"
        "    except RuntimeError as error:\n"
        "        assert 'blocked harness' in str(error)\n"
        "    else:\n"
        "        raise AssertionError('repo-root harness guard did not run')\n"
        "    finally:\n"
        "        root_codex.unlink()\n"
        "    print('secret-token=super-secret ' + ('x' * 30000))\n"
    )
    monkeypatch.setenv("RUN_LIVE_CODEX", "1")
    monkeypatch.setenv("DEMO_API_TOKEN", "super-secret")
    monkeypatch.setenv("SKILL_HUB_DIR", "/real/home/skill-hub")
    monkeypatch.setenv("CODEX_HOME", "/real/home/.codex")
    catalog = _catalog(tmp_path, "environment_contract.py::test_environment")
    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert result == 1, report["cases"][0]
    log = report["cases"][0]["logs"]["stdout"]
    assert report["cases"][0]["status"] == "fail"
    assert len(log.encode()) <= integration_validation.MAX_LOG_BYTES + len("\n<output truncated>")
    assert "super-secret" not in log
    assert "bound" in report["cases"][0]["reason"]


def test_skipped_and_zero_test_cases_cannot_pass(tmp_path, capsys):
    test_file = tmp_path / "outcomes.py"
    test_file.write_text("import pytest\n@pytest.mark.skip(reason='fixture gap')\ndef test_skip():\n    pass\n")
    catalog = _write_catalog(
        tmp_path,
        [_case("skip", "outcomes.py::test_skip"), _case("empty", "outcomes.py::does_not_exist")],
    )
    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    statuses = [case["status"] for case in json.loads((run_path / "report.json").read_text())["cases"]]
    assert statuses == ["skipped", "blocked"]


def test_unsafe_selector_and_empty_filter_are_rejected(tmp_path, capsys):
    test_file = tmp_path / "ok.py"
    test_file.write_text("def test_ok():\n    pass\n")
    unsafe = _catalog(tmp_path, "../ok.py::test_ok")
    assert integration_validation.main(
        ["list", "--catalog", str(unsafe), "--repo-root", str(tmp_path)]
    ) == 2
    assert "unsafe selector" in capsys.readouterr().err
    safe = _catalog(tmp_path, "ok.py::test_ok")
    assert integration_validation.main(
        ["list", "--catalog", str(safe), "--repo-root", str(tmp_path), "--case", "missing"]
    ) == 2
    assert "unknown case" in capsys.readouterr().err


def test_selection_error_is_persisted_as_a_failing_report(tmp_path, capsys):
    report_dir = tmp_path / "reports"
    result = integration_validation.main(
        [
            "run",
            "--catalog",
            str(tmp_path / "missing.json"),
            "--repo-root",
            str(tmp_path),
            "--report-dir",
            str(report_dir),
        ]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert report["cases"] == []
    assert report["selection_error"]
    assert report["evidence_verdict"] == "fail"
    assert report["metadata"]["corpus_sha256"] is None


def test_invalid_profile_is_persisted_as_a_selection_error(tmp_path, capsys):
    report_dir = tmp_path / "reports"
    (tmp_path / "contract.py").write_text("def test_contract(): pass\n")
    catalog = _catalog(tmp_path, "contract.py::test_contract")
    result = integration_validation.main(
        [
            "run",
            "--profile",
            "invalid",
            "--catalog",
            str(catalog),
            "--repo-root",
            str(tmp_path),
            "--report-dir",
            str(report_dir),
        ]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert "unknown profile" in report["selection_error"]
    replayed = integration_validation.read_report(run_path)
    assert replayed["profile"] == "invalid"
    assert replayed["evidence_verdict"] == "fail"
    assert integration_validation.compare_reports(replayed, replayed)["evidence_verdict"] == "fail"


def test_native_unknown_recipe_allocates_durable_blocked_report(tmp_path, capsys):
    report_dir = tmp_path / "native-reports"
    result = integration_validation.main(
        [
            "native",
            "--recipe",
            "missing-recipe",
            "--report-dir",
            str(report_dir),
            "--json",
        ]
    )
    assert result == 1
    report = json.loads(capsys.readouterr().out)
    assert report["profile"] == "native"
    assert report["cases"][0]["status"] == "blocked"
    assert report["cases"][0]["reason"] == "unknown native recipe"
    assert report["evidence_verdict"] == "blocked"


def test_fixture_native_transport_remains_a_native_gap(tmp_path, capsys, monkeypatch):
    from skill_hub.infrastructure.harnesses import harness_native_executor
    from tests.harness_supervision_helpers import fixture_launch

    real_execute = harness_native_executor.execute_native
    monkeypatch.setattr(harness_native_executor, "execute_native",
                        lambda *a, **kw: real_execute(*a, **kw, supervisor=fixture_launch))
    from tests.test_harness_native_executor import _identity, _recipe

    recipe = _recipe(
        code=(
            "from pathlib import Path; import os; "
            "Path(os.environ['SKILL_HUB_NATIVE_PROOF_PATH']).write_text('READY')"
        ),
        isolation={"roots": {}, "proof_token": "READY"},
    )
    args = SimpleNamespace(
        recipe="fixture-recipe",
        authorize_native=True,
        report_dir=tmp_path / "native-reports",
        json=True,
    )
    result = integration_validation._native_run(
        args,
        recipes={"fixture-recipe": recipe},
        runtime_identity=_identity(),
        sandbox_factory=lambda _: tmp_path,
    )
    assert result == 1
    report = json.loads(capsys.readouterr().out)
    case = report["cases"][0]
    assert case["status"] == "pass"
    assert case["execution_kind"] == "fixture"
    assert case["native_proof"]["provenance"] == "fixture"
    assert report["evidence_verdict"] == "blocked"


def test_native_missing_authorization_is_durable_without_spawn(tmp_path, capsys):
    from tests.test_harness_native_executor import _identity, _recipe

    recipe = _recipe(code="raise SystemExit('must not run')")
    args = SimpleNamespace(
        recipe="fixture-recipe",
        authorize_native=False,
        report_dir=tmp_path / "native-reports",
        json=True,
    )
    result = integration_validation._native_run(
        args,
        recipes={"fixture-recipe": recipe},
        runtime_identity=_identity(),
        sandbox_factory=lambda _: tmp_path,
    )
    assert result == 1
    report = json.loads(capsys.readouterr().out)
    assert report["cases"][0]["status"] == "blocked"
    assert "authorization" in report["cases"][0]["reason"]
    assert report["cases"][0]["execution_kind"] == "fixture"


def test_native_missing_catalog_is_durable_selection_error(tmp_path, capsys):
    result = integration_validation.main(
        [
            "native",
            "--recipe",
            "missing-recipe",
            "--repo-root",
            str(tmp_path),
            "--catalog",
            str(tmp_path / "missing-catalog.json"),
            "--report-dir",
            str(tmp_path / "native-reports"),
            "--json",
        ]
    )
    assert result == 1
    report = json.loads(capsys.readouterr().out)
    assert report["metadata"]["corpus_sha256"] is None
    assert report["selection_error"].startswith("native catalog unavailable:")
    assert report["cases"][0]["status"] == "blocked"


def test_native_keyboard_interrupt_persists_interrupted_report(tmp_path, monkeypatch, capsys):
    from skill_hub.infrastructure.harnesses import harness_native_executor
    from tests.test_harness_native_executor import _recipe

    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(harness_native_executor, "execute_native", interrupt)
    args = SimpleNamespace(
        recipe="fixture-recipe",
        authorize_native=True,
        report_dir=tmp_path / "native-reports",
        json=True,
    )
    result = integration_validation._native_run(
        args,
        recipes={"fixture-recipe": _recipe(code="print('must not run')")},
        runtime_identity=object(),
        sandbox_factory=lambda _: tmp_path,
    )
    assert result == 1
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "interrupted"
    assert report["cases"][0]["status"] == "inconclusive"
    assert "interrupted" in report["cases"][0]["reason"]


def _typed_native_context(tmp_path):
    from skill_hub.application.harnesses.harness_operation_context import OperationAdapterContext
    from skill_hub.application.harnesses.harness_runtime import RuntimeInventory, executable_fingerprint
    from skill_hub.domain.harnesses.harness_adapter_api import (
        AdapterBinding,
        FeatureDecision,
        OperationResolution,
        RuntimeIdentity,
        Version,
    )
    from skill_hub.domain.harnesses.harness_catalog import bundled_catalog
    from skill_hub.infrastructure.harnesses.harness_native_executor import NativeBinding
    from tests.test_harness_native_executor import _recipe

    executable = tmp_path / "opencode-1.18.31-fixture"
    executable.write_bytes(b"fixture executable for exact digest")
    fingerprint = executable_fingerprint(str(executable))
    assert fingerprint is not None
    full_digest = "sha256:" + hashlib.sha256(executable.read_bytes()).hexdigest()
    runtime = RuntimeIdentity(
        harness_id="fixture-harness",
        installation_id="fixture-installation",
        executable_path=str(executable),
        raw_version="1.18.31",
        version=Version(1, 18, 31),
        os_name="darwin",
        architecture="arm64",
        executable_fingerprint=fingerprint,
        evidence="probe",
    )
    adapter_binding = AdapterBinding(
        package_id="fixture-package",
        release_version=Version(1, 0, 0),
        release_digest="sha256:" + "a" * 64,
        harness_id="fixture-harness",
        variant_id="default",
        installation_id="fixture-installation",
        profile="load",
        runtime_version=Version(1, 18, 31),
        runtime_identity=runtime,
        validation_provenance="verified",
    )
    recipe = dataclasses.replace(
        _recipe(code="print('fixture')"),
        binding=NativeBinding(
            package_id="fixture-package",
            release_version="1.0.0",
            release_digest="sha256:" + "a" * 64,
            harness_id="fixture-harness",
            variant_id="default",
            profile="load",
            runtime_version="1.18.31",
            installation_id="fixture-installation",
        ),
        platform="darwin",
        arch="arm64",
        executable_sha256=full_digest,
    )

    context = OperationAdapterContext(
        context_id="fixture-context",
        data_home=str(tmp_path),
        harness_ids=("fixture-harness",),
        catalog=bundled_catalog(),
        inventory=RuntimeInventory((runtime,), "fixture-request", observed_at="2026-09-16T00:00:00+00:00"),
        inventory_cache_state="fresh",
        resolutions={
            "fixture-harness": OperationResolution(
                "fixture-catalog",
                (FeatureDecision("permission", "supported", "compatible", adapter_binding, "verified"),),
            )
        },
    )
    return recipe, context, full_digest


def test_native_context_conversion_uses_typed_binding_and_exact_fixture_digest(tmp_path):
    recipe, context, full_digest = _typed_native_context(tmp_path)
    converted = integration_validation._native_identity_from_context(recipe, context, "permission")
    assert converted is not None
    assert converted.executable_sha256 == full_digest
    mismatched = dataclasses.replace(
        recipe,
        binding=dataclasses.replace(recipe.binding, release_version="9.9.9"),
    )
    assert integration_validation._native_identity_from_context(mismatched, context, "permission") is None


def test_native_verdict_requires_recipe_identity_and_matching_case_id():
    case = _passing_evidence_case(
        case_id="native-case",
        layer="native",
        required_evidence=["native"],
        execution_kind="native",
        native_proof={
            "verdict": "pass",
            "provenance": "native",
            "evidence_digest": "sha256:" + "a" * 64,
        },
    )
    verdict, missing = integration_validation._evidence_verdict(_evidence_report(case))
    assert verdict == "blocked"
    assert any("native recipe identity" in item for item in missing)
    from tests.test_harness_native_executor import _recipe

    case["native_recipe"] = integration_validation._native_recipe_payload(_recipe(code="print('fixture')"))
    with pytest.raises(ValueError, match="matching native_recipe case_id"):
        integration_validation.validate_report(_evidence_report(case))


def test_duplicate_report_case_ids_are_rejected(tmp_path):
    report = {
        "schema_version": 1,
        "run_id": "run-1",
        "status": "complete",
        "profile": "offline",
        "metadata": {"corpus_sha256": "a" * 64},
        "cases": [
            {"id": "same", "status": "pass", "reason": "ok", "elapsed_seconds": 0.1},
            {"id": "same", "status": "pass", "reason": "ok", "elapsed_seconds": 0.1},
        ],
        "coverage_gaps": [],
        "summary": {status: (2 if status == "pass" else 0) for status in integration_validation.STATUSES},
    }
    with pytest.raises(ValueError, match="duplicate report case id"):
        integration_validation.validate_report(report)


def test_failure_fingerprint_ignores_paths_and_exit_codes():
    case = {"id": "case", "revision": "r1", "layer": "offline"}
    left = {
        "status": "fail",
        "reason": "pytest reported a failure (exit 1) at /tmp/first/log",
        "pytest": {"failed": 1},
        "environment_family": "linux:x:python3.11",
    }
    right = {
        "status": "fail",
        "reason": "pytest reported a failure (exit 2) at /private/other/log",
        "pytest": {"failed": 1},
        "environment_family": "linux:x:python3.11",
    }
    left_fingerprint = integration_validation._failure_identity(case, left)["failure_fingerprint"]
    right_fingerprint = integration_validation._failure_identity(case, right)["failure_fingerprint"]
    assert left_fingerprint == right_fingerprint


def test_failure_fingerprint_distinguishes_junit_test_names():
    case = {"id": "case", "revision": "r1", "layer": "offline"}
    left = {
        "status": "fail",
        "reason": "pytest reported a failure (exit 1)",
        "failure_tests": ["module:test_one:AssertionError"],
        "environment_family": "linux:x:python3.11",
    }
    right = {
        "status": "fail",
        "reason": "pytest reported a failure (exit 1)",
        "failure_tests": ["module:test_two:AssertionError"],
        "environment_family": "linux:x:python3.11",
    }
    left_identity = integration_validation._failure_identity(case, left)
    right_identity = integration_validation._failure_identity(case, right)
    assert left_identity["failure_fingerprint"] != right_identity["failure_fingerprint"]
    assert left_identity["failure_signature_strength"] == "strong"


def test_recipe_metadata_requires_bounded_descriptive_authorization(tmp_path):
    case = _case("recipe", "ok.py::test_ok")
    case["recipe"] = {"executor": "live", "authorization": {"wall_time_seconds": 1}}
    _write_catalog(tmp_path, [case])
    (tmp_path / "ok.py").write_text("def test_ok(): pass\n")
    with pytest.raises(integration_validation.CatalogError, match="recipe missing"):
        integration_validation.load_catalog(tmp_path / "catalog.json", tmp_path)


def test_timeout_waits_for_output_readers_before_classifying(tmp_path, capsys, monkeypatch):
    real_popen = integration_validation.subprocess.Popen

    class DelayedEof:
        def __init__(self, stream):
            self.stream = stream

        def read(self, size):
            chunk = self.stream.read(size)
            if not chunk:
                time.sleep(0.15)
            return chunk

        def close(self):
            self.stream.close()

    def delayed_popen(*args, **kwargs):
        process = real_popen(*args, **kwargs)
        if process.stdout is not None and process.stderr is not None and not kwargs.get("text"):
            process.stdout = DelayedEof(process.stdout)
            process.stderr = DelayedEof(process.stderr)
        return process

    monkeypatch.setattr(integration_validation.subprocess, "Popen", delayed_popen)
    (tmp_path / "slow.py").write_text("import time\ndef test_slow(): time.sleep(30)\n")
    catalog = _write_catalog(tmp_path, [_case("slow", "slow.py::test_slow", timeout=0.1)])
    assert integration_validation.main([
        "run", "--catalog", str(catalog), "--repo-root", str(tmp_path),
        "--report-dir", str(tmp_path / "reports"),
    ]) == 1
    report = json.loads((Path(capsys.readouterr().out.strip()) / "report.json").read_text())
    assert report["cases"][0]["status"] == "blocked"
    assert report["cases"][0]["reason"] == "pytest timed out"


def test_timeout_is_blocked_and_gap_only_selection_is_nonpassing(tmp_path, capsys):
    slow = tmp_path / "slow.py"
    slow.write_text("import time\ndef test_slow():\n    time.sleep(30)\n")
    catalog = _write_catalog(tmp_path, [_case("slow", "slow.py::test_slow", timeout=0.1)])
    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert report["cases"][0]["status"] == "blocked"
    assert "timed out" in report["cases"][0]["reason"]

    gap_catalog = _write_catalog(
        tmp_path,
        [_case("native-only", "slow.py::test_slow", layer="native", gap="requires a native runtime")],
    )
    result = integration_validation.main(
        ["run", "--catalog", str(gap_catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 1
    gap_path = Path(capsys.readouterr().out.strip())
    gap_report = json.loads((gap_path / "report.json").read_text())
    assert gap_report["cases"][0]["status"] == "unsupported"
    assert gap_report["summary"]["pass"] == 0


def _evidence_report(*cases, status="complete", provenance=None):
    rows = list(cases)
    summary = {item: sum(row.get("status") == item for row in rows) for item in integration_validation.STATUSES}
    return {
        "schema_version": 1,
        "run_id": "run-evidence",
        "status": status,
        "profile": "offline",
        "metadata": {"corpus_sha256": "a" * 64, "provenance": provenance or {"status": "not_collected"}},
        "cases": rows,
        "coverage_gaps": [],
        "summary": summary,
    }


def _passing_evidence_case(case_id="case", **overrides):
    row = {
        "id": case_id,
        "status": "pass",
        "reason": "ok",
        "elapsed_seconds": 0.1,
        "revision": "r1",
        "layer": "offline",
        "environment_family": "linux:x:python3.11",
        "required_evidence": ["offline_pytest"],
        "pytest": {"collected": 1, "passed": 1},
    }
    row.update(overrides)
    return row


def test_strict_verdict_blocks_unsupported_without_a_coverage_gap():
    report = _evidence_report(_passing_evidence_case(status="unsupported"))
    verdict, missing = integration_validation._evidence_verdict(report)
    assert verdict == "blocked"
    assert any("unsupported" in item for item in missing)


def test_strict_verdict_blocks_running_report_even_when_all_cases_pass():
    report = _evidence_report(_passing_evidence_case(), status="running")
    verdict, missing = integration_validation._evidence_verdict(report)
    assert verdict == "blocked"
    assert "report is not complete" in missing


def test_offline_pass_cannot_satisfy_native_requirement():
    report = _evidence_report(_passing_evidence_case(required_evidence=["native_runtime"]))
    verdict, missing = integration_validation._evidence_verdict(report)
    assert verdict == "blocked"
    assert any("offline runner" in item for item in missing)


def test_unknown_evidence_requirement_blocks_strict_verdict():
    report = _evidence_report(_passing_evidence_case(required_evidence=["future-proof"]
    ))
    verdict, missing = integration_validation._evidence_verdict(report)
    assert verdict == "blocked"
    assert any("unknown evidence requirement" in item for item in missing)


def test_malformed_adapter_catalog_digest_blocks_strict_verdict():
    report = _evidence_report(
        _passing_evidence_case(),
        provenance={
            "status": "cache",
            "runtime": {},
            "adapter": {},
            "catalog": {"digest": "not-a-digest"},
            "selected_decisions": [],
        },
    )
    verdict, missing = integration_validation._evidence_verdict(report)
    assert verdict == "blocked"
    assert any("catalog digest" in item for item in missing)


def test_compare_omitted_and_incomparable_cases_never_pass():
    prior_case = _passing_evidence_case()
    current = _evidence_report(_passing_evidence_case(case_id="other"))
    prior = _evidence_report(prior_case)
    comparison = integration_validation.compare_reports(current, prior)
    assert comparison["omitted"] == ["case"]
    assert comparison["evidence_verdict"] == "blocked"

    incomparable_case = _passing_evidence_case()
    incomparable_case.pop("environment_family")
    incomparable = _evidence_report(incomparable_case)
    comparison = integration_validation.compare_reports(incomparable, prior)
    assert comparison["incomparable"] == [{"id": "case", "reason": "missing revision/layer/environment identity"}]
    assert comparison["evidence_verdict"] == "blocked"


def test_read_report_recomputes_missing_verdict_and_rejects_stale_verdict(tmp_path):
    path = tmp_path / "report.json"
    report = _evidence_report(_passing_evidence_case())
    path.write_text(json.dumps(report))
    loaded = integration_validation.read_report(path)
    assert loaded["evidence_verdict"] == "pass"
    assert loaded["missing_requirements"] == []
    report["evidence_verdict"] = "pass"
    report["cases"][0]["status"] = "unsupported"
    report["summary"]["pass"] = 0
    report["summary"]["unsupported"] = 1
    path.write_text(json.dumps(report))
    with pytest.raises(ValueError, match="evidence_verdict is stale"):
        integration_validation.read_report(path)


def test_read_report_keeps_verdict_snapshot_when_catalog_changes(tmp_path, monkeypatch):
    from skill_hub.domain.harnesses import harness_catalog

    catalog_digest = harness_catalog.bundled_catalog().content_digest
    report = _evidence_report(
        _passing_evidence_case(),
        provenance={
            "status": "cache",
            "runtime": {"status": "fresh", "fingerprint": "fixture", "identities": []},
            "adapter": {"sdk_version": "1.0.0", "host_version": "1.0.0"},
            "catalog": {"generation": "old-catalog", "digest": catalog_digest},
            "selected_decisions": [],
        },
    )
    report["evidence_verdict"] = "pass"
    report["missing_requirements"] = []
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report))

    monkeypatch.setattr(
        harness_catalog,
        "bundled_catalog",
        lambda: SimpleNamespace(content_digest="sha256:" + "f" * 64),
    )

    loaded = integration_validation.read_report(path)
    assert loaded["evidence_verdict"] == "pass"


def test_pass_verdict_requires_consistent_success_counts():
    case = _passing_evidence_case(
        pytest={"collected": 1, "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "xfailed": 0}
    )
    verdict, missing = integration_validation._evidence_verdict(_evidence_report(case))
    assert verdict == "blocked"
    assert any("pytest" in item for item in missing)


def test_cache_provenance_requires_structured_fields():
    report = _evidence_report(_passing_evidence_case(), provenance={"status": "cache"})
    verdict, missing = integration_validation._evidence_verdict(report)
    assert verdict == "blocked"
    assert any("provenance" in item for item in missing)


def test_empty_comparison_identity_is_incomparable():
    prior = _evidence_report(_passing_evidence_case(revision="", layer="", environment_family=""))
    current = _evidence_report(_passing_evidence_case(revision="", layer="", environment_family=""))
    comparison = integration_validation.compare_reports(current, prior)
    assert comparison["incomparable"] == [
        {"id": "case", "reason": "missing revision/layer/environment identity"}
    ]


def test_unsupported_matching_failure_is_reported_as_repeated():
    prior = _evidence_report(_passing_evidence_case(status="unsupported"))
    current = _evidence_report(_passing_evidence_case(status="unsupported"))
    prior["cases"][0]["failure_fingerprint"] = "a" * 64
    current["cases"][0]["failure_fingerprint"] = "a" * 64
    prior["cases"][0]["failure_signature_strength"] = "strong"
    current["cases"][0]["failure_signature_strength"] = "strong"
    comparison = integration_validation.compare_reports(current, prior)
    assert comparison["repeated_failures"] == [{"id": "case", "fingerprint": "a" * 64}]


def test_spawn_error_is_blocked(tmp_path, monkeypatch, capsys):
    test_file = tmp_path / "contract.py"
    test_file.write_text("def test_ok():\n    pass\n")
    catalog = _catalog(tmp_path, "contract.py::test_ok")

    def refuse_spawn(*args, **kwargs):
        raise OSError("pytest executable unavailable")

    monkeypatch.setattr(integration_validation.subprocess, "Popen", refuse_spawn)
    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    case = json.loads((run_path / "report.json").read_text())["cases"][0]
    assert case["status"] == "blocked"
    assert "could not start pytest" in case["reason"]


def test_interruption_persists_earlier_failure_and_pending_case(tmp_path, monkeypatch, capsys):
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    first.write_text("def test_first():\n    pass\n")
    second.write_text("def test_second():\n    pass\n")
    catalog = _write_catalog(
        tmp_path,
        [_case("first", "first.py::test_first"), _case("second", "second.py::test_second")],
    )
    calls = []

    def interrupt_after_failure(case, root, run_path, catalog_path, profile):
        calls.append(case["id"])
        if len(calls) == 1:
            return {
                "id": case["id"],
                "status": "fail",
                "reason": "fixture failure",
                "elapsed_seconds": 0.01,
                "selectors": list(case["selectors"]),
                "pytest": {"collected": 1, "passed": 0, "failed": 1, "errors": 0, "skipped": 0, "xfailed": 0},
                "logs": {"stdout": "", "stderr": ""},
                "reproduction_argv": [],
                "evidence": {},
            }
        raise KeyboardInterrupt

    monkeypatch.setattr(integration_validation, "_run_case", interrupt_after_failure)
    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert report["status"] == "interrupted"
    assert report["cases"][0]["status"] == "fail"
    assert report["cases"][1]["status"] == "inconclusive"
    assert "interrupted" in report["cases"][1]["reason"]


def test_guard_blocks_windows_executable_suffix_without_running_a_cli(tmp_path):
    guard = tmp_path / "sitecustomize.py"
    guard.write_text(integration_validation._PROCESS_GUARD)
    probe = tmp_path / "probe.py"
    probe.write_text(
        "import subprocess\n"
        "try:\n"
        "    subprocess.run(['C:/Program Files/Codex/codex.exe', '--version'])\n"
        "except RuntimeError as error:\n"
        "    assert 'blocked harness' in str(error)\n"
        "else:\n"
        "    raise AssertionError('Windows executable suffix bypassed guard')\n"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(tmp_path)
    env["INTEGRATION_VALIDATION_ALLOWED_EXEC_ROOTS"] = str(tmp_path / "sandbox")
    result = subprocess.run([sys.executable, str(probe)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object lifecycle regression")
def test_windows_job_kills_child_after_successful_case(tmp_path, capsys):
    sentinel = tmp_path / "child-survived.txt"
    child_code = (
        "import pathlib, time; time.sleep(1.0); "
        "pathlib.Path(" + repr(str(sentinel)) + ").write_text('survived')"
    )
    test_file = tmp_path / "child_contract.py"
    test_file.write_text(
        "import subprocess, sys, time\n"
        "def test_child_process():\n"
        "    subprocess.Popen([sys.executable, '-c', "
        + repr(child_code)
        + "])\n"
        "    time.sleep(0.1)\n"
    )
    catalog = _catalog(tmp_path, "child_contract.py::test_child_process")
    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )
    assert result == 0
    capsys.readouterr()
    time.sleep(1.2)
    assert not sentinel.exists()


def test_evidence_temp_cleanup_retries_transient_sharing_denial(tmp_path, monkeypatch):
    target = tmp_path / "stderr.tmp"
    target.write_text("fixture")
    original_unlink = Path.unlink
    attempts = 0

    def transient_denial(path, *args, **kwargs):
        nonlocal attempts
        if path == target and attempts < 2:
            attempts += 1
            raise PermissionError("fixture sharing violation")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", transient_denial)
    assert integration_validation._unlink_bounded(target, timeout=0.3)
    assert attempts == 2
    assert not target.exists()


def test_evidence_temp_cleanup_denial_keeps_durable_inconclusive_report(
    tmp_path, monkeypatch, capsys
):
    test_file = tmp_path / "contract_test.py"
    test_file.write_text("def test_contract():\n    assert True\n")
    catalog = _catalog(tmp_path, "contract_test.py::test_contract")
    monkeypatch.setattr(integration_validation, "_unlink_bounded", lambda *args, **kwargs: False)

    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )

    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report_path = run_path / "report.json"
    report = json.loads(report_path.read_text())
    assert report["status"] == "complete"
    assert report["cases"][0]["status"] == "inconclusive"
    assert "cleanup" in report["cases"][0]["reason"]
    assert report["cases"][0]["evidence"]["stderr"]
    assert report_path.exists()


def test_windows_job_close_retries_and_retains_failed_handle():
    class Kernel:
        def __init__(self, outcomes):
            self.outcomes = iter(outcomes)
            self.calls = 0

        def CloseHandle(self, handle):
            self.calls += 1
            return next(self.outcomes)

    transient = Kernel([False, True])
    job = __import__("skill_hub.infrastructure.harnesses.harness_execution_supervisor", fromlist=["*"])._WindowsJob(
        "fixture-handle", transient
    )
    assert job.close() is True
    assert transient.calls == 2
    assert not job.handle

    persistent = Kernel([False] * 8)
    job = __import__("skill_hub.infrastructure.harnesses.harness_execution_supervisor", fromlist=["*"])._WindowsJob(
        "fixture-handle", persistent
    )
    assert job.close() is False
    assert job.handle == "fixture-handle"
    assert persistent.calls == 3
    assert job.close() is False
    assert persistent.calls == 6


def test_windows_job_close_failure_keeps_durable_inconclusive_report(tmp_path, monkeypatch, capsys):
    class FailedJob:
        def close(self):
            return False

    test_file = tmp_path / "contract_test.py"
    test_file.write_text("def test_contract():\n    assert True\n")
    catalog = _catalog(tmp_path, "contract_test.py::test_contract")
    from tests.harness_supervision_helpers import fixture_launch

    def bad_cleanup(*args, **kwargs):
        child = fixture_launch(*args, **kwargs)
        original_close = child.close

        def close():
            original_close()
            return False

        child.close = close
        return child

    monkeypatch.setattr(integration_validation, "_launch", bad_cleanup)

    result = integration_validation.main(
        ["run", "--catalog", str(catalog), "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    )

    assert result == 1
    run_path = Path(capsys.readouterr().out.strip())
    report = json.loads((run_path / "report.json").read_text())
    assert report["cases"][0]["status"] == "inconclusive"
    assert "cleanup" in report["cases"][0]["reason"]
    assert (run_path / "report.json").exists()


def test_failure_identity_excludes_parameter_values(tmp_path):
    junit = tmp_path / "result.xml"
    junit.write_text('<testsuite><testcase classname="suite" name="test_login[private-api-key]">'
                     '<failure type="AssertionError">secret content</failure></testcase></testsuite>')

    identities = integration_validation._pytest_failure_tests(junit)

    assert identities == ["suite:test_login:AssertionError"]
    assert "private-api-key" not in str(identities)
    assert "secret content" not in str(identities)


@pytest.mark.parametrize("required_evidence", ["native", "native_runtime"])
def test_native_dispatch_records_the_context_used_for_execution(
    tmp_path, monkeypatch, capsys, required_evidence
):
    from skill_hub.application.harnesses import harness_operation_context
    from skill_hub.infrastructure.harnesses import harness_native_executor

    recipe, context, _ = _typed_native_context(tmp_path)
    captured = []
    selected = []
    monkeypatch.setattr(harness_native_executor, "NATIVE_RECIPES", {recipe.recipe_id: recipe})
    monkeypatch.setattr(integration_validation, "_native_catalog", lambda args: ({"cases": [{
        "id": recipe.case_id, "feature": "permission", "layer": "native", "revision": "1",
        "required_evidence": [required_evidence],
    }]}, "a" * 64, None))

    def select(*args, **kwargs):
        selected.append(kwargs)
        return context

    def execute(request, recipes, identity, sandbox_factory):
        captured.append(identity)
        return harness_native_executor.NativeResult(
            status="blocked", reason="fixture does not execute a native runtime", elapsed_seconds=0.0,
        )

    monkeypatch.setattr(harness_operation_context, "build_operation_context", select)
    monkeypatch.setattr(harness_native_executor, "execute_native", execute)
    args = SimpleNamespace(recipe=recipe.recipe_id, authorize_native=True,
                           report_dir=tmp_path / "reports", json=True)
    assert integration_validation._native_run(args) == 1
    report = json.loads(capsys.readouterr().out)
    assert len(selected) == 1
    assert selected[0]["requested_features"] == ("permission",)
    assert captured[0].installation_id == context.inventory.identities[0].installation_id
    provenance = report["metadata"]["provenance"]
    assert provenance["operation_context_id"] == context.context_id
    assert provenance["runtime"]["fingerprint"] == context.inventory.request_fingerprint
    assert "operation_context" not in provenance
    assert str(tmp_path) not in json.dumps(provenance)


def test_native_context_interrupt_persists_readable_report(tmp_path, monkeypatch, capsys):
    from skill_hub.application.harnesses import harness_operation_context
    from skill_hub.infrastructure.harnesses import harness_native_executor

    recipe, _, _ = _typed_native_context(tmp_path)
    monkeypatch.setattr(harness_native_executor, "NATIVE_RECIPES", {recipe.recipe_id: recipe})
    monkeypatch.setattr(integration_validation, "_native_catalog", lambda args: ({"cases": [{
        "id": recipe.case_id, "feature": "permission", "layer": "native", "revision": "1",
        "required_evidence": ["native"],
    }]}, "a" * 64, None))

    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(harness_operation_context, "build_operation_context", interrupt)
    args = SimpleNamespace(
        recipe=recipe.recipe_id,
        authorize_native=True,
        report_dir=tmp_path / "reports",
        json=True,
    )
    assert integration_validation._native_run(args) == 1
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "interrupted"
    assert report["cases"][0]["status"] == "inconclusive"
    run_path = next((tmp_path / "reports").iterdir())
    loaded = integration_validation.read_report(run_path)
    assert loaded["status"] == "interrupted"


def test_offline_environment_preserves_architecture_without_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("PROCESSOR_ARCHITECTURE", "AMD64")
    monkeypatch.setenv("PROCESSOR_ARCHITEW6432", "ARM64")
    monkeypatch.setenv("DEMO_API_TOKEN", "fixture-private-token")
    env, secrets = integration_validation._sanitized_env(tmp_path / "sandbox", tmp_path)
    assert env["PROCESSOR_ARCHITECTURE"] == "AMD64"
    assert env["PROCESSOR_ARCHITEW6432"] == "ARM64"
    assert "DEMO_API_TOKEN" not in env
    assert "fixture-private-token" in secrets


# ─── TA-1-314c: the non-darwin positive boundary ────────────────────────────
#
# `test_offline_command_retains_blocked_memory_report` in
# test_harness_execution_integration.py is the macOS-only negative: it proves
# `_execute_case` reports `blocked` when the OS cannot enforce the memory
# ceiling. Every test in *this* file runs under the autouse `fixture_supervision`
# patch, so nothing here reached the production `_launch`/default-lock-path
# wiring either. This twin opts out with the new `real_execution_supervisor`
# marker and asserts the positive on the platforms that can enforce the
# ceiling: a real target starts, passes, and the marker file it wrote exists.


@pytest.mark.skipif(sys.platform == "darwin", reason="macOS cannot enforce the memory ceiling")
@pytest.mark.real_execution_supervisor
def test_offline_command_passes_with_real_launch_on_enforcing_platforms(tmp_path, capsys):
    marker = tmp_path / "target-started"
    (tmp_path / "test_fixture.py").write_text(
        f"from pathlib import Path\ndef test_x():\n    Path({str(marker)!r}).touch()\n"
    )
    catalog = _catalog(tmp_path, "test_fixture.py", case_id="enforcement-positive")
    assert integration_validation.main(
        ["run", "--profile", "quick", "--catalog", str(catalog),
         "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")]
    ) == 0
    report = json.loads((Path(capsys.readouterr().out.strip()) / "report.json").read_text())
    assert report["cases"][0]["status"] == "pass"
    assert marker.exists()
