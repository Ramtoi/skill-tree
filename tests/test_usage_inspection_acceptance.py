"""Acceptance journeys for the public Usage inspection read contract."""

from __future__ import annotations

import base64
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import yaml

from skill_hub import hub_core
from skill_hub.application.usage import usage_inspection
from skill_hub.infrastructure.usage import usage_scan, usage_source_versions
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

ROOT = "11111111-1111-4111-8111-111111111111"
CHILD = "22222222-2222-4222-8222-222222222222"
GRANDCHILD = "33333333-3333-4333-8333-333333333333"
SECOND_ROOT = "44444444-4444-4444-8444-444444444444"


def _project(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    project.mkdir()
    (hub_core.data_home() / "registry.yaml").write_text(
        yaml.safe_dump({"projects": {"synthetic": {"path": str(project)}}, "skills": {}})
    )
    return project


def _write(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n")


def _path(session_id: str) -> Path:
    filename = f"rollout-2026-01-01T00-00-00-{session_id}.jsonl"
    return Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "01" / "01" / filename


def _scan() -> dict:
    return usage_scan.scan_sessions(
        harness="codex",
        now=datetime(2026, 1, 10, tzinfo=timezone.utc),
    )


def _meta(session_id: str, project: Path, *, parent: str | None = None) -> dict:
    payload: dict = {"id": session_id, "cwd": str(project)}
    if parent is not None:
        payload["source"] = {
            "subagent": {"thread_spawn": {"parent_thread_id": parent, "thread_id": session_id}}
        }
    return {"timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": payload}


def _token(
    session_id: str,
    response_id: str,
    *,
    input_tokens: int,
    output_tokens: int,
    cached_input_tokens: int,
    total_tokens: int,
    at: str,
) -> dict:
    return {
        "timestamp": at,
        "type": "event_msg",
        "payload": {
            "id": f"token-{response_id}",
            "type": "token_count",
            "thread_id": session_id,
            "info": {
                "total_token_usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cached_input_tokens": cached_input_tokens,
                    "cache_write_input_tokens": 0,
                    "total_tokens": total_tokens,
                }
            },
        },
    }


def _call(at: str, native_id: str, command: str, output: str) -> list[dict]:
    return [
        {
            "timestamp": at,
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "call_id": native_id,
                "name": "shell",
                "arguments": json.dumps({"command": command}),
            },
        },
        {
            "timestamp": at,
            "type": "response_item",
            "payload": {"type": "function_call_output", "call_id": native_id, "output": output},
        },
    ]


def _pr(at: str, number: int) -> list[dict]:
    """Emit PR evidence in the Codex function call/output envelope."""
    call_id = f"pr-{number}-{at.replace(':', '').replace('-', '')}"
    return _call(
        at,
        call_id,
        "gh pr create --repo example/skill-hub",
        f"https://github.com/example/skill-hub/pull/{number}",
    )


def _scope_total(scope: dict) -> int:
    return int(scope["tokens"]["total"])


def _tools_page(session_id: str, *, run_id: str | None = None, after: str | None = None) -> dict:
    payload = usage_inspection.inspection_payload(
        "codex", session_id, "tools", run_id=run_id, after=after
    )
    assert payload["ok"] is True
    assert payload["tool_calls"]["status"] in {"complete", "partial"}
    return payload


def test_codex_grandchild_append_updates_root_hierarchy(tmp_data_home, tmp_path):
    project = _project(tmp_path)
    _write(
        _path(ROOT),
        [
            _meta(ROOT, project),
            _token(
                ROOT,
                "root-1",
                input_tokens=1000,
                output_tokens=100,
                cached_input_tokens=800,
                total_tokens=1100,
                at="2026-01-01T00:00:01Z",
            ),
        ],
    )
    _write(
        _path(CHILD),
        [
            _meta(CHILD, project, parent=ROOT),
            _token(
                CHILD,
                "child-1",
                input_tokens=200,
                output_tokens=20,
                cached_input_tokens=150,
                total_tokens=220,
                at="2026-01-01T00:00:02Z",
            ),
        ],
    )
    grandchild_path = _path(GRANDCHILD)
    _write(
        grandchild_path,
        [
            _meta(GRANDCHILD, project, parent=CHILD),
            *_call(
                "2026-01-01T00:00:03Z",
                "grandchild-call",
                "printf grandchild",
                "grandchild output",
            ),
            _token(
                GRANDCHILD,
                "grandchild-1",
                input_tokens=100,
                output_tokens=10,
                cached_input_tokens=80,
                total_tokens=110,
                at="2026-01-01T00:00:04Z",
            ),
        ],
    )
    _scan()
    initial = usage_inspection.inspection_payload("codex", ROOT, "overview")
    assert initial["ok"] is True
    runs = initial["runs"]
    assert len(runs) == 3
    main = next(run for run in runs if run["parent_id"] is None)
    child = next(run for run in runs if run["parent_id"] == main["id"])
    grandchild = next(run for run in runs if run["parent_id"] == child["id"])
    assert _scope_total(initial["session"]["summary"]["own"]) == 1100
    assert _scope_total(initial["session"]["summary"]["subtree"]) == 1430

    grandchild_path.write_text(
        grandchild_path.read_text()
        + json.dumps(
            _token(
                GRANDCHILD,
                "grandchild-2",
                input_tokens=300,
                output_tokens=30,
                cached_input_tokens=240,
                total_tokens=330,
                at="2026-01-05T00:00:04Z",
            )
        )
        + "\n"
    )
    _scan()
    updated = usage_inspection.inspection_payload("codex", ROOT, "overview")
    updated_grandchild = next(run for run in updated["runs"] if run["id"] == grandchild["id"])
    assert _scope_total(updated_grandchild["scopes"]["own"]) == 330
    assert _scope_total(updated["session"]["summary"]["subtree"]) == 1650


def test_source_replacement_retains_prior_timeline_and_pr(tmp_data_home, tmp_path):
    project = _project(tmp_path)
    path = _path(ROOT)
    _write(
        path,
        [
            _meta(ROOT, project),
            {
                "timestamp": "2026-01-01T00:00:01Z",
                "type": "event_msg",
                "payload": {"id": "start-1", "type": "task_started"},
            },
            *_pr("2026-01-01T00:00:02Z", 17),
        ],
    )
    _scan()
    before = usage_inspection.inspection_payload("codex", ROOT, "overview")
    old_event_ids = {event["id"] for event in before["timeline"]["events"]}
    old_prs = {(pr["repository_id"], pr["number"]) for pr in before["prs"]}
    assert old_event_ids
    assert old_prs == {("github.com/example/skill-hub", 17)}
    with InspectionStore.open() as store:
        source_id, old_head = store.db.execute(
            "SELECT source_id,publication_id FROM source_heads"
        ).fetchone()

    _write(
        path,
        [
            _meta(ROOT, project),
            {
                "timestamp": "2026-01-06T00:00:01Z",
                "type": "event_msg",
                "payload": {"id": "complete-1", "type": "task_complete"},
            },
        ],
    )
    _scan()
    after = usage_inspection.inspection_payload("codex", ROOT, "overview")
    # Wave3 current views contain the complete replacement. Prior evidence
    # stays addressable by immutable publication, outside current totals.
    assert old_event_ids.isdisjoint(event["id"] for event in after["timeline"]["events"])
    assert after["prs"] == []
    with InspectionStore.open() as store:
        historical = usage_source_versions.resolve_facts(store.db, source_id, publication_id=old_head)
    assert old_event_ids <= {fact.physical_id for fact in historical if fact.kind == "event"}
    assert old_prs == {
        (fact.metadata["repository_id"], fact.metadata["number"])
        for fact in historical if fact.kind == "pr"
    }
    assert any(event["kind"] == "task_complete" for event in after["timeline"]["events"])

    path.write_text(
        path.read_text()
        + "\n".join(
            json.dumps(record, ensure_ascii=False)
            for record in _call(
                "2026-01-07T00:00:01Z",
                "replacement-call",
                "printf replacement",
                "replacement output",
            )
        )
        + "\n"
    )
    resumed = _scan()
    assert resumed["inspection"]["errors"] == []
    appended = usage_inspection.inspection_payload("codex", ROOT, "tools")
    replacement = next(
        item
        for item in appended["items"]
        if item["operation"]["summary"] == '{"command":"printf replacement"}'
    )
    body_id = replacement["result_parts"][0]["body_id"]
    body = usage_inspection.read_body_for_session("codex", ROOT, body_id)
    assert body["ok"] is True
    assert base64.b64decode(body["chunks"][0]["base64"]) == b"replacement output"


def test_recorded_revision_base_patch_survives_source_removal(tmp_data_home, tmp_path):
    repo = _project(tmp_path)

    def git(*args: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    git("init", "-q")
    git("config", "user.email", "acceptance@example.com")
    git("config", "user.name", "Acceptance Test")
    (repo / "demo.txt").write_text("base\n")
    git("add", "demo.txt")
    git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD")
    (repo / "demo.txt").write_text("head\n")
    git("commit", "-qam", "head")
    revision = git("rev-parse", "HEAD")

    metadata = _meta(ROOT, repo)
    metadata["payload"].update({"repository": str(repo), "revision": revision, "base": base})
    path = _path(ROOT)
    _write(path, [metadata])
    scanned = _scan()
    assert scanned["inspection"]["errors"] == []

    before = usage_inspection.inspection_payload("codex", ROOT, "overview")
    changes = [change for change in before["changes"] if change["kind"] == "worktree_patch"]
    assert len(changes) == 1
    change = changes[0]
    assert change["repository_id"] == str(repo)
    assert change["revision_id"] == revision
    assert change["base_id"] == base
    assert change["attribution"] == "captured"
    patch_body_id = change["patch"]["body_id"]

    path.unlink()
    rescanned = _scan()
    assert rescanned["inspection"]["errors"] == []
    after = usage_inspection.inspection_payload("codex", ROOT, "changes")
    retained = next(item for item in after["changes"] if item["id"] == change["id"])
    assert retained["revision_id"] == revision
    assert retained["base_id"] == base
    body = usage_inspection.read_body_for_session("codex", ROOT, patch_body_id)
    assert body["ok"] is True
    assert b"+head" in base64.b64decode(body["chunks"][0]["base64"])


def test_same_repo_pr_is_visible_for_two_sessions_and_child(tmp_data_home, tmp_path):
    project = _project(tmp_path)
    child = "55555555-5555-4555-8555-555555555555"
    _write(_path(ROOT), [_meta(ROOT, project), *_pr("2026-01-01T00:00:01Z", 17)])
    _write(
        _path(SECOND_ROOT),
        [_meta(SECOND_ROOT, project), *_pr("2026-01-01T00:00:02Z", 17)],
    )
    _write(
        _path(child),
        [_meta(child, project, parent=ROOT), *_pr("2026-01-01T00:00:03Z", 18)],
    )
    _scan()

    root_prs = usage_inspection.inspection_payload("codex", ROOT, "overview")["prs"]
    second_prs = usage_inspection.inspection_payload("codex", SECOND_ROOT, "overview")["prs"]
    assert {pr["number"] for pr in root_prs} >= {17, 18}
    assert {pr["number"] for pr in second_prs} == {17}
    child_overview = usage_inspection.inspection_payload("codex", child, "overview")
    assert {pr["number"] for pr in child_overview["prs"]} >= {17, 18}
    assert all(
        pr["repository_id"] == "github.com/example/skill-hub"
        for pr in root_prs + second_prs
    )


def test_tools_pages_continue_and_selected_run_filters(tmp_data_home, tmp_path):
    project = _project(tmp_path)
    parent_calls: list[dict] = []
    for index in range(130):
        parent_calls.extend(
            _call(
                f"2026-01-01T00:01:{index % 60:02d}Z",
                f"parent-{index:03d}",
                f"printf {index}",
                f"parent output {index}",
            )
        )
    child = "66666666-6666-4666-8666-666666666666"
    _write(_path(ROOT), [_meta(ROOT, project), *parent_calls])
    _write(
        _path(child),
        [
            _meta(child, project, parent=ROOT),
            *_call("2026-01-01T02:00:00Z", "child-0", "printf child", "child output"),
            *_call(
                "2026-01-01T02:00:01Z",
                "child-1",
                "printf child two",
                "child output two",
            ),
        ],
    )
    _scan()

    overview = usage_inspection.inspection_payload("codex", ROOT, "overview")
    child_run = next(run for run in overview["runs"] if run["parent_id"] is not None)
    first = _tools_page(ROOT)
    assert first["tool_calls"]["next_after"] is not None
    all_items = list(first["tool_calls"]["items"])
    cursor = first["tool_calls"]["next_after"]
    while cursor is not None:
        page = _tools_page(ROOT, after=cursor)
        all_items.extend(page["tool_calls"]["items"])
        cursor = page["tool_calls"]["next_after"]
    assert len(all_items) == 132
    assert len({item["id"] for item in all_items}) == 132

    selected = _tools_page(ROOT, run_id=child_run["id"])
    assert selected["tool_calls"]["total"] == 2
    assert len(selected["tool_calls"]["items"]) == 2
    assert {item["run_id"] for item in selected["tool_calls"]["items"]} == {child_run["id"]}
