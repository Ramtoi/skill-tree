"""Golden baseline capture for the merged Usage wave 2 tree."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

import hub
from skill_hub import hub_core

CLOCK = "2026-09-17T12:00:00Z"
BASELINE_SCHEMA = 1
FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "usage" / "wave3_golden"
INPUT_ROOT = FIXTURE_ROOT / "input"
EXPECTED_ROOT = FIXTURE_ROOT / "expected"
PROJECT_PATH_MARKER = "/tmp/skill-hub-wave3-fixture/alpha"
OMITTED_FIELDS = frozenset({"frozen", "last_scan_at"})
ACCEPTED_ADDITIONS = ("summary_provenance", "capture_coverage")
SUMMARY_PROVENANCE_VALUES = frozenset({"canonical", "legacy_import"})
CAPTURE_COVERAGE_VALUES = frozenset({"complete", "partial", "unavailable"})
EXTERNAL_COMPACT_RECORD = (
    Path(__file__).parents[1]
    / "docs/changes/DESIGN-usage-wave-2"
    / "ccusage-subagent-probe"
    / "compact-records"
    / "with-child.stdout.json"
)

CLAUDE_ROOT_ID = "aaaaaaaa-1111-4111-8111-111111111111"
CODEX_ROOT_ID = "cccccccc-3333-4333-8333-333333333333"
CODEX_CHILD_ID = "dddddddd-4444-4444-8444-444444444444"
CODEX_TOKEN_ONLY_ID = "eeeeeeee-5555-4555-8555-555555555555"
LEGACY_ID = "ffffffff-6666-4666-8666-666666666666"
SESSION_READS = (
    (CLAUDE_ROOT_ID, "claude-code"),
    (LEGACY_ID, "claude-code"),
    (CODEX_ROOT_ID, "codex"),
    (CODEX_CHILD_ID, "codex"),
    (CODEX_TOKEN_ONLY_ID, "codex"),
)
OWNED_HELPER = "tests/test_usage_wave3_golden_baseline.py"
OWNED_FIXTURE_PREFIX = "tests/fixtures/usage/wave3_golden/"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _owned(path: str) -> bool:
    return path == OWNED_HELPER or path.startswith(OWNED_FIXTURE_PREFIX)


def _run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], commands: list[list[str]], *argv: str
) -> str:
    commands.append(["hub", *argv])
    monkeypatch.setattr(sys, "argv", ["hub", *argv])
    hub.main()
    return capsys.readouterr().out


def _seed_inputs(tmp_data_home: Path) -> dict[str, Any]:
    """Install only checked-in synthetic bytes into the disposable home."""
    # Preserve installed-harness footprint evidence separately from transcript roots.
    (Path.home() / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    claude_root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    codex_root = Path(os.environ["CODEX_HOME"]) / "sessions"
    shutil.copytree(INPUT_ROOT / "claude" / "projects", claude_root)
    shutil.copytree(INPUT_ROOT / "codex" / "sessions", codex_root)
    project_path = tmp_data_home / "fixture-project-alpha"
    project_path.mkdir()
    assert project_path.parent == tmp_data_home
    (project_path / "tracked-baseline.txt").write_text("fixture\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=project_path, check=True)
    subprocess.run(["git", "add", "tracked-baseline.txt"], cwd=project_path, check=True)
    for source_root in (claude_root, codex_root):
        for source in source_root.rglob("*.jsonl"):
            contents = source.read_text(encoding="utf-8")
            # Prompt lengths are part of the golden payload. Keep prompt text
            # at its recorded value while cwd/files use this disposable home.
            # The recorded path is inert text, never an I/O destination.
            manifest_path = EXPECTED_ROOT / "manifest.json"
            if manifest_path.exists():
                recorded_path = json.loads(manifest_path.read_text(encoding="utf-8"))[
                    "project_path_substitution"
                ]["expanded_path"]
                records = [json.loads(line) for line in contents.splitlines()]
                for record in records:
                    payload = record.get("payload")
                    if isinstance(payload, dict) and payload.get("type") == "user_message":
                        text = payload.get("message")
                        if isinstance(text, str):
                            payload["message"] = text.replace(PROJECT_PATH_MARKER, recorded_path)
                contents = "".join(json.dumps(record) + "\n" for record in records)
            source.write_text(
                contents.replace(PROJECT_PATH_MARKER, json.dumps(str(project_path))[1:-1]),
                encoding="utf-8",
            )
            assert PROJECT_PATH_MARKER not in source.read_text(encoding="utf-8")
    registry = yaml.safe_load((INPUT_ROOT / "registry-template.yaml").read_text(encoding="utf-8"))
    assert isinstance(registry, dict)
    registry["projects"]["alpha"]["path"] = str(project_path)
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False), encoding="utf-8")
    ledger = tmp_data_home / "state" / "usage"
    ledger.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(INPUT_ROOT / "loadouts.jsonl", ledger / "loadouts.jsonl")
    shutil.copyfile(INPUT_ROOT / "legacy" / "claude-code-legacy-only.json", ledger / "sessions.jsonl")
    expanded_sources = {}
    for prefix, root in ((".claude/projects", claude_root), (".codex/sessions", codex_root)):
        expanded_sources.update(
            {
                f"{prefix}/{path.relative_to(root).as_posix()}": _sha256(path)
                for path in sorted(root.rglob("*.jsonl"))
            }
        )
    return {"project_path": str(project_path), "expanded_source_hashes": expanded_sources}


def _without_allowed_omissions(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _without_allowed_omissions(item) for key, item in value.items() if key not in OMITTED_FIELDS}
    if isinstance(value, list):
        return [_without_allowed_omissions(item) for item in value]
    return value


def _canonical_payload(text: str) -> str:
    return json.dumps(_without_allowed_omissions(json.loads(text)), indent=2, sort_keys=True) + "\n"


def _canonical_ledger(path: Path) -> str:
    rows = [
        _without_allowed_omissions(json.loads(line)) for line in path.read_text(encoding="utf-8").splitlines() if line
    ]
    rows.sort(key=lambda row: (row.get("harness", ""), row.get("session_id", "")))
    return "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)


def _assert_structural(expected: Any, actual: Any, path: str = "$") -> None:
    """Keep the original baseline exact except for two settled additions."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        extra = set(actual) - set(expected)
        unexpected = extra - set(ACCEPTED_ADDITIONS)
        assert not unexpected, f"unexpected fields at {path}: {sorted(unexpected)}"
        for key in set(actual) & set(ACCEPTED_ADDITIONS):
            value = actual[key]
            allowed = SUMMARY_PROVENANCE_VALUES if key == "summary_provenance" else CAPTURE_COVERAGE_VALUES
            assert value in allowed, f"invalid {key} at {path}: {value!r}"
        missing = set(expected) - set(actual)
        assert not missing, f"missing fields at {path}: {sorted(missing)}"
        for key in sorted(expected):
            _assert_structural(expected[key], actual[key], f"{path}.{key}")
        return
    if isinstance(expected, list) and isinstance(actual, list):
        assert len(actual) == len(expected), f"list length changed at {path}"
        for index, (expected_item, actual_item) in enumerate(zip(expected, actual)):
            _assert_structural(expected_item, actual_item, f"{path}[{index}]")
        return
    assert type(actual) is type(expected), (
        f"value type changed at {path}: expected {type(expected).__name__}, got {type(actual).__name__}"
    )
    assert actual == expected, f"value changed at {path}: expected {expected!r}, got {actual!r}"


def _comparable_value(name: str, text: str) -> Any:
    if name == "session_rows":
        return [json.loads(line) for line in text.splitlines() if line]
    value = json.loads(text)
    # The golden was captured on macOS. These fixture-owned relative paths
    # use native separators on Windows; all other footprint text stays exact.
    for block in value.get("footprint", {}).values():
        for part in block.get("parts", []):
            if part.get("part") == "skills":
                for skill in ("brainstorm", "verify-it"):
                    part["text"] = part["text"].replace(
                        f"(.claude\\skills\\{skill})", f"(.claude/skills/{skill})"
                    )
    return value


def _capture_outputs(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> tuple[dict[str, str], dict[str, str], dict[str, Any], list[list[str]]]:
    commands: list[list[str]] = []
    scan = json.loads(
        _run(
            monkeypatch,
            capsys,
            commands,
            "usage",
            "scan-sessions",
            "--order",
            "path",
            "--budget-seconds",
            "60",
            "--json",
        )
    )
    raw_public: dict[str, str] = {}

    def public_command(name: str, *argv: str) -> str:
        text = _run(monkeypatch, capsys, commands, *argv)
        raw_public[name] = text
        return _canonical_payload(text)

    public = {
        "project_alpha_window_30": public_command(
            "project_alpha_window_30", "usage", "project", "alpha", "--window", "30", "--json"
        ),
        "timeline_global": public_command("timeline_global", "usage", "timeline", "--json"),
        "timeline_alpha": public_command("timeline_alpha", "usage", "timeline", "--project", "alpha", "--json"),
        "findings_global": public_command("findings_global", "usage", "findings", "--json"),
        "findings_alpha": public_command("findings_alpha", "usage", "findings", "--project", "alpha", "--json"),
    }
    sessions: dict[tuple[str, str], dict[str, Any]] = {}
    overviews: dict[tuple[str, str], dict[str, Any]] = {}
    for session_id, harness in SESSION_READS:
        name = f"session_{harness}_{session_id}"
        session_text = _run(
            monkeypatch, capsys, commands, "usage", "session", session_id, "--harness", harness, "--json"
        )
        raw_public[name] = session_text
        public[name] = _canonical_payload(session_text)
        sessions[(harness, session_id)] = json.loads(session_text)
        overview_text = _run(
            monkeypatch,
            capsys,
            commands,
            "usage",
            "inspect",
            session_id,
            "--harness",
            harness,
            "--view",
            "overview",
            "--json",
        )
        overviews[(harness, session_id)] = json.loads(overview_text)
    index = json.loads(_run(monkeypatch, capsys, commands, "usage", "inspect-index", "--json"))
    ledger_path = hub_core.data_home() / "state" / "usage" / "sessions.jsonl"
    first_export = ledger_path.read_bytes()
    repeat_scan = json.loads(
        _run(
            monkeypatch,
            capsys,
            commands,
            "usage",
            "scan-sessions",
            "--order",
            "path",
            "--budget-seconds",
            "60",
            "--json",
        )
    )
    assert ledger_path.read_bytes() == first_export, "unchanged scan rewrote the exported session rows"
    public["session_rows"] = _canonical_ledger(ledger_path)
    return (
        public,
        raw_public,
        {"scan": scan, "repeat_scan": repeat_scan, "index": index, "sessions": sessions, "overviews": overviews},
        commands,
    )


def _row_by_id(ledger_text: str, harness: str, session_id: str) -> dict[str, Any]:
    for line in ledger_text.splitlines():
        row = json.loads(line)
        if row.get("harness") == harness and row.get("session_id") == session_id:
            return row
    raise AssertionError(f"missing ledger row for {harness}/{session_id}")


def _assert_fixture_health(public: dict[str, str], health: dict[str, Any]) -> None:
    scan = health["scan"]
    inspection = scan["inspection"]
    assert scan["ok"] is True and not scan["errors"]
    assert inspection["state"] == "complete" and inspection["partial"] is False and not inspection["errors"]
    assert inspection["sources_total"] == inspection["sources_done"] == 5
    assert health["repeat_scan"]["ok"] is True
    root = _row_by_id(public["session_rows"], "claude-code", CLAUDE_ROOT_ID)
    assert root["project"] == "alpha" and root["tokens"]["total"] == 110 and root["tokens"]["subagent_total"] == 710
    assert _row_by_id(public["session_rows"], "codex", CODEX_TOKEN_ONLY_ID)["first_turn_input_total"] == 33
    provider = json.loads((INPUT_ROOT / "provider-evidence" / "ccusage-20.0.17-with-child.json").read_text())
    assert provider["session"][0]["totalTokens"] == 820
    legacy = health["sessions"][("claude-code", LEGACY_ID)]
    assert legacy["ok"] is True and legacy["project"] == "alpha" and legacy["transcript_present"] is False
    for line in public["session_rows"].splitlines():
        assert "state_hash" not in json.loads(line)
    for session_id, harness in SESSION_READS:
        assert health["sessions"][(harness, session_id)]["project"] == "alpha"


def _changed_paths(*args: str) -> list[str]:
    return subprocess.check_output(["git", *args], text=True).splitlines()


def _capture_guard(expected_sha: str) -> None:
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if head != expected_sha:
        raise AssertionError(f"USAGE_WAVE3_CAPTURE_SHA={expected_sha}, but HEAD is {head}")
    for label, args in (("staged", ("diff", "--cached", "--name-only")), ("unstaged", ("diff", "--name-only"))):
        outside = [path for path in _changed_paths(*args) if not _owned(path)]
        if outside:
            raise AssertionError(f"capture refuses {label} changes outside owned paths: {outside}")
    outside = [path for path in _changed_paths("ls-files", "--others", "--exclude-standard") if not _owned(path)]
    if outside:
        raise AssertionError(f"capture refuses untracked files outside owned paths: {outside}")


def _input_hashes() -> dict[str, str]:
    return {
        path.relative_to(INPUT_ROOT).as_posix(): _sha256(path)
        for path in sorted(INPUT_ROOT.rglob("*"))
        if path.is_file()
    }


def _capture_manifest(
    outputs: dict[str, str],
    raw_public: dict[str, str],
    health: dict[str, Any],
    seeded: dict[str, Any],
    commands: list[list[str]],
    producer_sha: str,
) -> dict[str, object]:
    expected = {name: hashlib.sha256(value.encode("utf-8")).hexdigest() for name, value in sorted(outputs.items())}
    return {
        "baseline_schema": BASELINE_SCHEMA,
        "producer_commit": producer_sha,
        "producer_tree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip(),
        "arguments": commands,
        "clock": CLOCK,
        "timezone": "UTC",
        "comparator_omissions": sorted(OMITTED_FIELDS),
        "accepted_additive_fields": list(ACCEPTED_ADDITIONS),
        "state_hash": "absent",
        "equal_timestamp_event_order": "original golden remains exact; source-ordinal delta is pending wave 3 schema",
        "source_registry_loadout_hashes": _input_hashes(),
        "expanded_source_hashes": seeded["expanded_source_hashes"],
        "project_path_substitution": {"template": PROJECT_PATH_MARKER, "expanded_path": seeded["project_path"]},
        "expected_hashes": expected,
        "raw_public_hashes": {
            name: hashlib.sha256(text.encode("utf-8")).hexdigest() for name, text in sorted(raw_public.items())
        },
        "health_evidence_hashes": {
            name: hashlib.sha256(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()
            for name, value in sorted(_health_evidence(health).items())
        },
        "external_compact_record": {
            "path": "docs/changes/DESIGN-usage-wave-2/ccusage-subagent-probe/compact-records/with-child.stdout.json",
            "digest": _sha256(EXTERNAL_COMPACT_RECORD),
            "fixture": "input/provider-evidence/ccusage-20.0.17-with-child.json",
            "fixture_digest": _sha256(INPUT_ROOT / "provider-evidence" / "ccusage-20.0.17-with-child.json"),
        },
    }


def _health_evidence(health: dict[str, Any]) -> dict[str, Any]:
    evidence = {"scan": health["scan"], "repeat_scan": health["repeat_scan"], "inspect_index": health["index"]}
    evidence.update(
        {f"overview_{harness}_{session_id}": value for (harness, session_id), value in health["overviews"].items()}
    )
    return evidence


def _write_capture(
    outputs: dict[str, str],
    raw_public: dict[str, str],
    health: dict[str, Any],
    seeded: dict[str, Any],
    commands: list[list[str]],
    producer_sha: str,
) -> None:
    EXPECTED_ROOT.mkdir(parents=True, exist_ok=True)
    for name, text in outputs.items():
        (EXPECTED_ROOT / f"{name}.json").write_text(text, encoding="utf-8")
    for directory, values in (("raw-public", raw_public), ("health", _health_evidence(health))):
        target = EXPECTED_ROOT / directory
        target.mkdir(exist_ok=True)
        for name, value in values.items():
            text = value if isinstance(value, str) else json.dumps(value, indent=2, sort_keys=True) + "\n"
            (target / f"{name}.json").write_text(text, encoding="utf-8")
    (EXPECTED_ROOT / "manifest.json").write_text(
        json.dumps(
            _capture_manifest(outputs, raw_public, health, seeded, commands, producer_sha), indent=2, sort_keys=True
        )
        + "\n",
        encoding="utf-8",
    )


def test_wave3_golden_baseline(tmp_data_home, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", CLOCK)
    requested_sha = os.environ.get("USAGE_WAVE3_CAPTURE_SHA")
    if requested_sha:
        if not EXTERNAL_COMPACT_RECORD.is_file():
            # Recapture records the digest of a probe under docs/changes/,
            # which is export-ignored: private evidence not shipped.
            pytest.skip("external compact record under docs/changes is private evidence not shipped")
        _capture_guard(requested_sha)
    elif not (EXPECTED_ROOT / "manifest.json").exists():
        pytest.skip("wave 3 inputs are ready; expected outputs await the merged wave 2 SHA")
    seeded = _seed_inputs(tmp_data_home)
    outputs, raw_public, health, commands = _capture_outputs(monkeypatch, capsys)
    _assert_fixture_health(outputs, health)
    if requested_sha:
        _write_capture(outputs, raw_public, health, seeded, commands, requested_sha)
        return
    manifest = json.loads((EXPECTED_ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["clock"] == CLOCK and manifest["baseline_schema"] == BASELINE_SCHEMA
    assert manifest["source_registry_loadout_hashes"] == _input_hashes()
    assert manifest["producer_commit"] == "43f47363cdc9a7f27503a297c2b373e1a9226c03"
    assert manifest["producer_tree"] == "b460540091a870e240e5b4ed74ba578ac94e7520"
    # A shallow CI checkout may not contain the producer object. The pinned
    # identifiers above remain mandatory even when Git cannot resolve it.
    producer = subprocess.run(
        ["git", "rev-parse", "--verify", manifest["producer_commit"] + "^{tree}"],
        text=True,
        capture_output=True,
        check=False,
    )
    if producer.returncode == 0:
        assert producer.stdout.strip() == manifest["producer_tree"]
    assert set(manifest["raw_public_hashes"]) == set(raw_public)
    assert set(manifest["health_evidence_hashes"]) == set(_health_evidence(health))
    for name, digest in manifest["raw_public_hashes"].items():
        assert _sha256(EXPECTED_ROOT / "raw-public" / f"{name}.json") == digest
    for name, digest in manifest["health_evidence_hashes"].items():
        recorded = json.loads((EXPECTED_ROOT / "health" / f"{name}.json").read_text(encoding="utf-8"))
        assert hashlib.sha256(json.dumps(recorded, sort_keys=True).encode("utf-8")).hexdigest() == digest
    for name, actual in outputs.items():
        expected = (EXPECTED_ROOT / f"{name}.json").read_text(encoding="utf-8")
        assert manifest["expected_hashes"][name] == hashlib.sha256(expected.encode("utf-8")).hexdigest()
        _assert_structural(_comparable_value(name, expected), _comparable_value(name, actual), name)
