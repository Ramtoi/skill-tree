from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from skill_hub.infrastructure.harnesses import harness_validation as validation


def _stamp(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat()


def test_native_unknown_recipe_records_host_source_and_reproduction_metadata(tmp_path, capsys):
    result = validation.main(
        [
            "native",
            "--recipe",
            "missing-recipe",
            "--report-dir",
            str(tmp_path / "reports"),
            "--json",
        ]
    )
    assert result == 1
    report = json.loads(capsys.readouterr().out)
    metadata = report["metadata"]
    assert isinstance(metadata["git_revision"], (str, type(None)))
    assert isinstance(metadata["git_dirty"], (bool, type(None)))
    assert isinstance(metadata["source_digest"], str)
    assert metadata["source_digest"].startswith("sha256:")
    argv = metadata["reproduction_argv"]
    assert argv[argv.index("--recipe") + 1] == "missing-recipe"
    assert "--report-dir" in argv and "--catalog" in argv
    assert all("secret" not in value.lower() for value in argv)


def test_freshness_boundaries_are_explicit():
    base = {"profile": "native", "metadata": {}}
    fresh = {**base, "metadata": {"freshness": {"observed_at": _stamp(timedelta(hours=-23))}}}
    expired = {**base, "metadata": {"freshness": {"observed_at": _stamp(timedelta(hours=-25))}}}
    future = {**base, "metadata": {"freshness": {"observed_at": _stamp(timedelta(minutes=1))}}}
    assert validation._freshness(fresh)["status"] == "fresh"
    assert validation._freshness(expired)["status"] == "stale"
    assert validation._freshness(future)["status"] == "stale"
    assert validation._freshness(base)["status"] == "stale"


def test_stale_effective_verdict_does_not_rewrite_captured_outcome():
    report = {"profile": "native", "metadata": {"freshness": {"observed_at": _stamp(timedelta(days=-2))}}}
    verdict, missing = validation._effective_evidence(report, "pass", [])
    assert verdict == "blocked"
    assert "freshness window expired" in missing[-1]


def test_quick_freshness_expires_and_legacy_report_stays_readable():
    from tests.test_integration_validation import _evidence_report, _passing_evidence_case

    report = _evidence_report(_passing_evidence_case())
    report["profile"] = "quick"
    report["finished_at"] = _stamp(timedelta(days=-8))
    report["evidence_verdict"] = "pass"
    row = validation.validate_report(report)
    assert row["evidence_verdict"] == "pass"
    assert row["effective_evidence_verdict"] == "blocked"
    assert row["freshness"]["status"] == "stale"
    assert validation.compare_reports(row, row)["evidence_verdict"] == "blocked"


def test_fresh_native_evidence_without_host_identity_cannot_certify():
    report = {"profile": "native", "metadata": {
        "freshness": {"observed_at": _stamp(timedelta(hours=-1))}
    }, "cases": []}
    verdict, missing = validation._effective_evidence(report, "pass", [])
    assert verdict == "blocked"
    assert any("host" in item for item in missing)
