from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from skill_hub.infrastructure.harnesses import harness_validation
from tests.harness_supervision_helpers import fixture_supervision  # noqa: F401

pytestmark = pytest.mark.usefixtures("tmp_data_home")


def _catalog(root: Path, selector: str, *, case_id: str = "case", layer: str = "offline", gap=None) -> Path:
    path = root / "catalog.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "cases": [
                    {
                        "id": case_id,
                        "description": "CLI contract",
                        "harnesses": ["pi"],
                        "feature": "cli",
                        "layer": layer,
                        "profiles": ["quick", "offline"],
                        "platforms": ["macos", "linux", "windows"],
                        "selectors": [selector],
                        "timeout_seconds": 10,
                        "gap": gap,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def _run_hub(monkeypatch, argv: list[str]) -> int:
    import hub

    monkeypatch.setattr(sys, "argv", ["hub", *argv])
    return hub.main()


def test_source_checkout_wrapper_delegates_to_root_runner():
    from scripts import integration_validation
    from skill_hub.infrastructure.harnesses import harness_validation

    assert integration_validation.main is harness_validation.main


def test_integration_list_uses_selected_checkout_and_json(tmp_path, monkeypatch, capsys):
    (tmp_path / "contract.py").write_text("def test_contract(): pass\n", encoding="utf-8")
    catalog = _catalog(tmp_path, "contract.py::test_contract")

    result = _run_hub(
        monkeypatch,
        ["integration", "list", "--json", "--repo-root", str(tmp_path), "--catalog", str(catalog)],
    )

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert [case["id"] for case in payload] == ["case"]


def test_integration_list_missing_checkout_is_structured_json_error(tmp_path, monkeypatch, capsys):
    result = _run_hub(
        monkeypatch,
        ["integration", "list", "--json", "--repo-root", str(tmp_path)],
    )

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "error"
    assert payload["errors"]


def test_integration_list_unknown_harness_is_json_read_error(tmp_path, monkeypatch, capsys):
    result = _run_hub(
        monkeypatch,
        ["integration", "list", "--json", "--repo-root", str(tmp_path), "--harness", "unknown"],
    )

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "error"


@pytest.mark.parametrize("json_out", [False, True])
def test_integration_report_rejects_malformed_nested_case(tmp_path, monkeypatch, capsys, json_out):
    report = tmp_path / "report.json"
    report.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": "run-1",
                "status": "complete",
                "profile": "offline",
                "metadata": {"corpus_sha256": "a" * 64},
                "cases": [{}],
                "summary": dict.fromkeys(("pass", "fail", "blocked", "unsupported", "inconclusive", "skipped"), 0),
                "coverage_gaps": [],
            }
        ),
        encoding="utf-8",
    )
    argv = ["integration", "report", str(report)] + (["--json"] if json_out else [])

    result = _run_hub(monkeypatch, argv)

    assert result == (0 if json_out else 2)
    output = capsys.readouterr().out
    if json_out:
        assert json.loads(output)["status"] == "error"
    else:
        assert "cannot read report" in output


def test_integration_validate_preserves_failure_status_and_report(tmp_path, monkeypatch, capsys):
    (tmp_path / "contract.py").write_text("def test_contract(): assert False\n", encoding="utf-8")
    catalog = _catalog(tmp_path, "contract.py::test_contract")
    report_dir = tmp_path / "reports"

    result = _run_hub(
        monkeypatch,
        [
            "integration",
            "validate",
            "--json",
            "--repo-root",
            str(tmp_path),
            "--catalog",
            str(catalog),
            "--report-dir",
            str(report_dir),
        ],
    )

    assert result == 1
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "complete"
    assert report["cases"][0]["status"] == "fail"


def test_integration_validate_persists_selection_error(tmp_path, monkeypatch, capsys):
    result = _run_hub(
        monkeypatch,
        [
            "integration",
            "validate",
            "--json",
            "--repo-root",
            str(tmp_path),
            "--catalog",
            str(tmp_path / "missing.json"),
            "--report-dir",
            str(tmp_path / "reports"),
        ],
    )
    assert result == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["selection_error"]
    assert payload["evidence_verdict"] == "fail"


def test_integration_validate_unknown_harness_persists_selection_error(tmp_path, monkeypatch, capsys):
    report_dir = tmp_path / "reports"
    (tmp_path / "contract.py").write_text("def test_contract(): pass\n", encoding="utf-8")
    catalog = _catalog(tmp_path, "contract.py::test_contract")
    result = _run_hub(
        monkeypatch,
        [
            "integration",
            "validate",
            "--json",
            "--repo-root",
            str(tmp_path),
            "--catalog",
            str(catalog),
            "--report-dir",
            str(report_dir),
            "--harness",
            "unknown",
        ],
    )
    assert result == 1
    payload = json.loads(capsys.readouterr().out)
    assert "unknown harness" in payload["selection_error"]
    assert payload["evidence_verdict"] == "fail"


def test_integration_native_unknown_recipe_writes_report(tmp_path, monkeypatch, capsys):
    report_dir = tmp_path / "native-reports"
    result = _run_hub(
        monkeypatch,
        [
            "integration",
            "native",
            "--recipe",
            "missing-recipe",
            "--report-dir",
            str(report_dir),
            "--json",
        ],
    )
    assert result == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["profile"] == "native"
    assert payload["cases"][0]["status"] == "blocked"
    assert payload["cases"][0]["reason"] == "unknown native recipe"


def test_integration_report_compare_is_read_only_and_strict(tmp_path, monkeypatch, capsys):
    def write(path: Path, run_id: str, status: str, fingerprint: str) -> None:
        payload = {
            "schema_version": 1,
            "status": "complete",
            "run_id": run_id,
            "profile": "offline",
            "metadata": {"corpus_sha256": "a" * 64},
            "cases": [
                {
                    "id": "case",
                    "status": status,
                    "reason": "assertion",
                    "elapsed_seconds": 0.1,
                    "revision": "r1",
                    "layer": "offline",
                    "environment_family": "linux:x:python3.11",
                    "failure_fingerprint": fingerprint,
                }
            ],
            "coverage_gaps": [],
            "summary": {item: (1 if item == status else 0) for item in harness_validation.STATUSES},
        }
        path.write_text(json.dumps(payload), encoding="utf-8")

    prior = tmp_path / "prior.json"
    current = tmp_path / "current.json"
    write(prior, "prior", "pass", "a" * 64)
    write(current, "current", "fail", "b" * 64)
    result = _run_hub(
        monkeypatch,
        ["integration", "report", str(current), "--compare", str(prior), "--json"],
    )
    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["regressions"][0]["id"] == "case"
    assert payload["evidence_verdict"] == "fail"


def test_integration_report_reads_without_rerunning(tmp_path, monkeypatch, capsys):
    report_dir = tmp_path / "run"
    report_dir.mkdir()
    report = {
        "schema_version": 1,
        "status": "complete",
        "run_id": "run-1",
        "profile": "offline",
        "metadata": {"corpus_sha256": "a" * 64, "git_revision": "rev", "git_dirty": False},
        "cases": [],
        "summary": dict.fromkeys(("pass", "fail", "blocked", "unsupported", "inconclusive", "skipped"), 0),
        "coverage_gaps": [],
    }
    (report_dir / "report.json").write_text(json.dumps(report), encoding="utf-8")

    result = _run_hub(
        monkeypatch,
        ["integration", "report", str(report_dir), "--json"],
    )

    assert result == 0
    assert json.loads(capsys.readouterr().out)["run_id"] == "run-1"


def test_integration_inventory_cache_read_never_refreshes(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path / "hub"))
    from skill_hub.application.harnesses import harness_runtime

    monkeypatch.setattr(harness_runtime, "inventory", lambda _request: pytest.fail("refresh was invoked"))
    result = _run_hub(monkeypatch, ["integration", "inventory", "--json"])

    assert result == 0
    assert json.loads(capsys.readouterr().out)["status"] == "missing"


def test_integration_inventory_stale_cache_keeps_identity_evidence(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path / "hub"))
    cache_path = tmp_path / "hub" / "state" / "runtime-inventory.json"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text(
        json.dumps({
            "schema_version": 999, "observed_at": "old",
            "identities": [{"harness_id": "pi", "installation_id": "fixture-pi"}],
        }),
        encoding="utf-8",
    )

    result = _run_hub(monkeypatch, ["integration", "inventory", "--json"])

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "stale"
    assert payload["identities"] == [{"harness_id": "pi", "installation_id": "fixture-pi"}]


def test_integration_inventory_scalar_cache_row_is_explicit_error(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path / "hub"))
    cache_path = tmp_path / "hub" / "state" / "runtime-inventory.json"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text(json.dumps({"schema_version": 1, "identities": [42]}), encoding="utf-8")

    result = _run_hub(monkeypatch, ["integration", "inventory", "--json"])

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "stale"
    assert payload["identities"] == []
    assert any("malformed identity" in error for error in payload["errors"])


def test_integration_inventory_refresh_collects_once_and_persists_observation(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path / "hub"))
    from skill_hub.application.harnesses import harness_runtime

    observed = harness_runtime.RuntimeInventory((), "fingerprint", observed_at="2026-01-01T00:00:00+00:00")
    calls = []
    writes = []
    monkeypatch.setattr(harness_runtime, "inventory", lambda request: calls.append(request) or observed)
    monkeypatch.setattr(harness_runtime, "write_inventory_cache", lambda value, path: writes.append((value, path)))

    result = _run_hub(monkeypatch, ["integration", "inventory", "--refresh", "--json"])

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert len(calls) == 1
    assert all(not fallback.startswith("~") for fallback in calls[0].fallback_dirs)
    assert calls[0].home_overrides["codex"] != calls[0].fallback_dirs[0]
    assert calls[0].config_paths["codex"] == (
        str(Path(calls[0].home_overrides["codex"]) / "config.toml"),
    )
    assert calls[0].marker_dirs["claude-code"] == (
        str(Path(calls[0].home_overrides["claude-code"]) / "projects"),
    )
    from skill_hub.entrypoints.cli.integration import _user_home

    assert calls[0].marker_dirs["pi"] == (str(_user_home() / ".pi" / "agent"),)
    assert calls[0].config_paths["opencode"] == (str(_user_home() / ".config" / "opencode" / "opencode.json"),)
    assert writes == [(observed, tmp_path / "hub" / "state" / "runtime-inventory.json")]
    assert payload["observed_at"] == observed.observed_at


def test_integration_inventory_refresh_writer_error_is_structured(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path / "hub"))
    from skill_hub.application.harnesses import harness_runtime

    observed = harness_runtime.RuntimeInventory((), "fingerprint", observed_at="2026-01-01T00:00:00+00:00")
    monkeypatch.setattr(harness_runtime, "inventory", lambda _request: observed)
    monkeypatch.setattr(
        harness_runtime,
        "write_inventory_cache",
        lambda _value, _path: (_ for _ in ()).throw(OSError("cache is read-only")),
    )

    result = _run_hub(monkeypatch, ["integration", "inventory", "--refresh", "--json"])

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "error"
    assert "cache is read-only" in payload["errors"][0]


@pytest.mark.parametrize("field,value", [
    ("status", "pass"),
    ("profile", "anything"),
    ("metadata", {"corpus_sha256": "not-a-digest"}),
    ("summary", {"pass": 99}),
])
def test_integration_report_rejects_false_run_claims(tmp_path, monkeypatch, capsys, field, value):
    from skill_hub.infrastructure.harnesses import harness_validation

    report = {
        "schema_version": 1, "run_id": "run-1", "status": "complete", "profile": "offline",
        "metadata": {"corpus_sha256": "a" * 64},
        "cases": [{"id": "broken", "status": "fail", "reason": "assertion failed", "elapsed_seconds": 0.1}],
        "coverage_gaps": [],
        "summary": {status: int(status == "fail") for status in harness_validation.STATUSES},
    }
    report[field] = value
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    assert _run_hub(monkeypatch, ["integration", "report", str(path), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "error"


def test_validation_provenance_keeps_multiple_installations_ambiguous(monkeypatch):
    from types import SimpleNamespace

    from skill_hub.application.harnesses import harness_runtime
    from skill_hub.domain.harnesses.harness_adapter_api import RuntimeIdentity, Version
    from skill_hub.entrypoints.cli import integration

    identities = tuple(RuntimeIdentity(
        "opencode", name, version=Version(1, 18, 31), os_name="macos", architecture="arm64"
    ) for name in ("one", "two"))
    snapshot = harness_runtime.RuntimeInventory(identities, "fixture-fingerprint")
    monkeypatch.setattr(harness_runtime, "read_inventory_cache", lambda *args: snapshot)
    monkeypatch.setattr(harness_runtime, "inventory", lambda *args: pytest.fail("provenance must not probe"))

    provenance = integration._provenance_data(SimpleNamespace(harness=["opencode"], feature=["invocation"]))

    assert len(provenance["selected_decisions"]) == 1
    decision = provenance["selected_decisions"][0]
    assert decision["harness_id"] == "opencode"
    assert decision["reason"] == "ambiguous_installation"
    assert decision["binding"] is None
