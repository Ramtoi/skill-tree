"""Overflow is a failed check, even when the selected test itself passes."""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from skill_hub.infrastructure.harnesses import harness_validation as runner
from tests.harness_supervision_helpers import fixture_supervision  # noqa: F401


@pytest.mark.parametrize("channel", ["stdout", "stderr", "junit"])
def test_output_overflow_is_bounded_and_nonpassing(tmp_path, capsys, channel):
    if channel == "junit":
        body = "def test_large(record_property):\n    record_property('large', 'x' * 1048576)\n"
    else:
        fd = 1 if channel == "stdout" else 2
        body = f"import os\ndef test_large():\n    os.write({fd}, b'x' * 1048576)\n"
    (tmp_path / "test_large.py").write_text(body)
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"schema_version": 1, "cases": [{
        "id": "large", "description": "output bound", "harnesses": ["pi"],
        "feature": "contract", "layer": "offline", "profiles": ["offline"],
        "platforms": ["macos", "linux", "windows"], "selectors": ["test_large.py"],
        "timeout_seconds": 10, "gap": None,
    }]}))
    code = runner.main(["run", "--profile", "offline", "--catalog", str(catalog),
                        "--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "reports")])
    captured = capsys.readouterr()
    assert captured.out.strip(), (code, captured.err)
    run_path = Path(captured.out.strip())
    row = json.loads((run_path / "report.json").read_text())["cases"][0]
    assert code != 0
    assert row["status"] != "pass"
    assert "bound" in row["reason"].lower()
    assert len(row["logs"]["stdout"].encode()) < 20000
    assert len(row["logs"]["stderr"].encode()) < 20000
    for item in (run_path / "evidence").rglob("*"):
        if item.is_file():
            assert item.stat().st_size < 100000


def test_oversized_junit_is_not_parsed(tmp_path):
    junit = tmp_path / "large.xml"
    junit.write_text('<testsuite><testcase name="large">' + ' ' * 1048576 + '</testcase></testsuite>')
    assert runner._pytest_counts(junit)["collected"] == 0


def test_retained_junit_redacts_xml_values_without_breaking_xml(tmp_path):
    secret = "token-secret"
    root = tmp_path / "repo"
    sandbox = tmp_path / "sandbox"
    root.mkdir()
    sandbox.mkdir()
    junit = tmp_path / "pytest.xml"
    junit.write_text(
        '<testsuite name="token-secret"><testcase name="token-secret" '
        'file="{}/private"><failure message="token-secret">token-secret</failure>'
        "</testcase>token-secret</testsuite>".format(root)
    )

    retained = runner._retained_junit_xml(junit, root, sandbox, [secret])

    parsed = ET.fromstring(retained)
    assert secret not in retained
    assert str(root) not in retained
    assert parsed.attrib["name"] == "<redacted>"
    testcase = parsed.find("testcase")
    assert testcase is not None and testcase.attrib["name"] == "<redacted>"
    assert testcase.attrib["file"] == "<private-path>/private"
    failure = testcase.find("failure")
    assert failure is not None and failure.attrib["message"] == "<redacted>"
    assert failure.text == "<redacted>"
    assert testcase.tail == "<redacted>"


@pytest.mark.parametrize(
    "payload",
    [
        b"<testsuite><testcase>",
        b'<!DOCTYPE testsuite [<!ENTITY boom "expanded">]><testsuite>&boom;</testsuite>',
        b"<testsuite>" + b"x" * (runner.MAX_JUNIT_BYTES + 1) + b"</testsuite>",
    ],
    ids=("malformed", "entity", "oversized"),
)
def test_unsafe_retained_junit_is_bounded_parseable_unavailable(tmp_path, payload):
    junit = tmp_path / "pytest.xml"
    junit.write_bytes(payload)

    retained = runner._retained_junit_xml(junit, tmp_path, tmp_path / "sandbox", [])

    parsed = ET.fromstring(retained)
    assert len(retained.encode("utf-8")) <= runner.MAX_JUNIT_BYTES
    assert parsed.attrib["name"] == "unavailable-evidence"
    assert "unavailable-evidence" in (parsed.findtext("system-out") or "")
    assert parsed.find("testcase") is None


def test_retained_junit_rejects_serialized_expansion_and_missing_input(tmp_path):
    expanding = tmp_path / "expanding.xml"
    expanding.write_text("<testsuite>" + "x" * 6_000 + "</testsuite>")

    expanded = runner._retained_junit_xml(expanding, tmp_path, tmp_path / "sandbox", ["x"])
    missing = runner._retained_junit_xml(tmp_path / "missing.xml", tmp_path, tmp_path / "sandbox", [])

    for retained, reason in ((expanded, "serialized-too-large"), (missing, "unreadable")):
        parsed = ET.fromstring(retained)
        assert len(retained.encode("utf-8")) <= runner.MAX_JUNIT_BYTES
        assert parsed.attrib["name"] == "unavailable-evidence"
        assert reason in (parsed.findtext("system-out") or "")


def test_retained_junit_rejects_utf16_entity_before_expansion(tmp_path):
    junit = tmp_path / "utf16.xml"
    junit.write_bytes(
        '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE testsuite '
        '[<!ENTITY bomb "expanded">]><testsuite><testcase name="safe"/>&bomb;</testsuite>'.encode("utf-16")
    )

    retained = runner._retained_junit_xml(junit, tmp_path, tmp_path / "sandbox", [])

    parsed = ET.fromstring(retained)
    assert parsed.attrib["name"] == "unavailable-evidence"
    assert "unsafe-encoding" in (parsed.findtext("system-out") or "")
    assert runner._pytest_counts(junit)["collected"] == 0


def test_retained_junit_rejects_unknown_identifiers(tmp_path):
    junit = tmp_path / "unsafe-identifiers.xml"
    junit.write_text('<testsuite token-secret="value"><token-secret/></testsuite>')

    retained = runner._retained_junit_xml(junit, tmp_path, tmp_path / "sandbox", ["token-secret"])

    parsed = ET.fromstring(retained)
    assert parsed.attrib["name"] == "unavailable-evidence"
    assert "unsafe-identifiers" in (parsed.findtext("system-out") or "")
    assert "token-secret" not in retained


def test_retained_pytest_junit_keeps_failure_nodes_and_counts(tmp_path):
    junit = tmp_path / "pytest.xml"
    junit.write_text(
        '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite '
        'name="pytest" tests="1" failures="1" errors="0" skipped="0">'
        '<testcase classname="tests.example" name="test_fails" time="0.1">'
        '<failure type="AssertionError" message="expected false">assert False</failure>'
        "</testcase></testsuite></testsuites>"
    )

    retained_path = tmp_path / "retained.xml"
    retained_path.write_text(runner._retained_junit_xml(junit, tmp_path, tmp_path / "sandbox", []))

    parsed = ET.parse(retained_path)
    assert parsed.find(".//failure") is not None
    assert runner._pytest_counts(retained_path) == {
        "collected": 1, "passed": 0, "failed": 1, "errors": 0, "skipped": 0, "xfailed": 0,
    }
