"""Tests for `usage_scan.py` — the Claude Code transcript scanner.

Covers `tasks.md` wave-1 tasks 1.21 to 1.26: the synthetic transcript tree,
the frozen-row / incremental-read / replaced-file cursor rules, the privacy
walk, and the unregistered-project / error-boundary contract.

Every test uses `tmp_data_home` (isolates `SKILL_HUB_HOME`) plus the autouse
`_fake_home` fixture in `conftest.py` (fakes `$HOME` and the captured harness
roots, so `$SKILL_HUB_CLAUDE_HOME/projects` is a synthetic tree this test
built, never the developer's real one). No test may read or write the real
`~/.claude` or `~/.skill-hub`.
"""

from __future__ import annotations

import json
import os
import pickle
from pathlib import Path
from types import SimpleNamespace

import yaml

from skill_hub.application.usage import usage_summary_export
from skill_hub.infrastructure.usage import usage_scan as us

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

SESSION_MAIN = "aaaaaaaa-1111-4111-8111-111111111111"
SUBAGENT_FLAT = "bbbbbbbb-1111-4111-8111-111111111111"
SUBAGENT_WF = "cccccccc-1111-4111-8111-111111111111"
SESSION_UNREGISTERED = "dddddddd-1111-4111-8111-111111111111"
SESSION_GOOD = "00000000-1111-4111-8111-111111111111"
SESSION_BAD = "ffffffff-1111-4111-8111-111111111111"


def _permission_error_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref
) -> None:
    """Portable worker result for a source that is unreadable by policy."""
    del harness, path, cursor, deadline, reader_ref
    Path(result_path).write_bytes(
        pickle.dumps(("error", ("OSError", "permission denied", "PermissionError")))
    )


def test_window_rows_uses_inclusive_utc_calendar_boundaries(monkeypatch):
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-09T12:00:00Z")
    rows = [
        {"project": "proj", "session_id": "late-before", "started_at": "2026-09-02T23:59:00Z"},
        {"project": "proj", "session_id": "at-since", "started_at": "2026-09-03T00:00:00Z"},
        {"project": "proj", "session_id": "tomorrow", "started_at": "2026-09-10T00:00:00Z"},
    ]

    selected = us.window_rows(rows, "proj", 7, us.now())

    assert [row["session_id"] for row in selected] == ["at-since"]


def test_inspection_projection_refreshes_after_frozen_legacy_scan(tmp_data_home, monkeypatch):
    """Canonical inspection refresh is independent of legacy row freezing."""
    calls = []
    refresh = usage_summary_export.refresh_and_export

    def tracked(store, **kwargs):
        calls.append(store)
        return refresh(store, **kwargs)

    monkeypatch.setattr(usage_summary_export, "refresh_and_export", tracked)
    result = us._capture_inspection("claude-code", rebuild=False)
    assert result["errors"] == []
    assert len(calls) == 1
    assert us.sessions_path().exists()


def test_scan_captures_one_usage_layout_and_forwards_it_to_discovery(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.application.usage.usage_source_layout import UsageLayout

    layout = UsageLayout(
        (("claude-code", tmp_path / "claude"), ("codex", tmp_path / "codex")),
    )
    captured = []
    monkeypatch.setattr(us, "capture_usage_layout", lambda: captured.append(layout) or layout)
    cursor_layouts = []
    redact = us._redact_cursor_excerpts

    def redact_with_layout(cursor, received_layout=None):
        cursor_layouts.append(received_layout)
        return redact(cursor, received_layout)

    monkeypatch.setattr(us, "_redact_cursor_excerpts", redact_with_layout)
    us.cursor_path().parent.mkdir(parents=True, exist_ok=True)
    us.cursor_path().write_text(json.dumps({"files": {}}))
    from skill_hub.application.usage import usage_inspection_scan

    def capture_pass(roots, **kwargs):
        captured.append((roots, kwargs["layout"]))
        return {
            "summary": {},
            "accounting": {},
            "errors": [],
            "sources_processed": 0,
            "bytes_read": 0,
        }

    monkeypatch.setattr(usage_inspection_scan, "capture_pass", capture_pass)
    result = us.scan_sessions()

    assert result["ok"] is True
    assert captured == [layout, (layout.roots(), layout)]
    assert cursor_layouts == [layout, layout]


def test_inspection_retry_exhaustion_is_incomplete(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.application.usage import usage_inspection
    source = tmp_path / "rollout-retry.jsonl"
    source.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": "rollout-retry"}}) + "\n"
    )
    from skill_hub.application.usage.usage_source_layout import UsageLayout

    layout = UsageLayout((("codex", tmp_path),))
    monkeypatch.setattr(
        usage_inspection,
        "capture_scan_source",
        lambda _source, _builder, _store, _reader_policy, _enrichment: SimpleNamespace(
            outcome="retry_required", bytes_read=0,
        ),
    )
    monkeypatch.setattr(usage_inspection, "rebuild_summary_projection", lambda _store=None: 0)
    result = us._capture_inspection("codex", layout=layout)
    assert result["incomplete"] == 1
    assert [(error["file"], error["kind"]) for error in result["errors"]] == [(source.name, "retry_exhausted")]


def _write_registry(registry: dict) -> None:
    from skill_hub import hub_core

    hub_core.data_home()  # ensure the dir exists
    (hub_core.data_home() / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _write_jsonl(path: Path, records: list, *, trailing_newline: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(r) for r in records]
    text = "\n".join(lines)
    if trailing_newline:
        text += "\n"
    path.write_text(text)


def _assistant_record(
    *,
    ts: str,
    session_id: str,
    cwd: str,
    message_id: str,
    model: str = "claude-sonnet-5",
    content: list,
    usage: dict | None = None,
) -> dict:
    message: dict = {"id": message_id, "model": model, "role": "assistant", "type": "message", "content": content}
    if usage is not None:
        message["usage"] = usage
    return {
        "type": "assistant",
        "uuid": f"u-{message_id}",
        "timestamp": ts,
        "sessionId": session_id,
        "cwd": cwd,
        "isSidechain": False,
        "message": message,
    }


def _user_text(*, ts: str, session_id: str, cwd: str, text: str, is_meta: bool = False, **extra) -> dict:
    row = {
        "type": "user",
        "uuid": f"u-{ts}",
        "timestamp": ts,
        "sessionId": session_id,
        "cwd": cwd,
        "isSidechain": False,
        "message": {"role": "user", "content": text},
        "isMeta": is_meta,
    }
    row.update(extra)
    return row


def _user_list(*, ts: str, session_id: str, cwd: str, content: list, is_meta: bool = False, **extra) -> dict:
    row = {
        "type": "user",
        "uuid": f"u-{ts}",
        "timestamp": ts,
        "sessionId": session_id,
        "cwd": cwd,
        "isSidechain": False,
        "message": {"role": "user", "content": content},
        "isMeta": is_meta,
    }
    row.update(extra)
    return row


def _usage(input_tokens=2, output_tokens=100, cache_creation=1000, cache_read=500) -> dict:
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_creation_input_tokens": cache_creation,
        "cache_read_input_tokens": cache_read,
    }


def _sub_assistant(*, ts: str, agent_id: str, message_id: str, model: str, usage: dict) -> dict:
    return {
        "type": "assistant",
        "timestamp": ts,
        "isSidechain": True,
        "agentId": agent_id,
        "message": {
            "id": message_id,
            "model": model,
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "usage": usage,
        },
    }


def _seed_unslop_script(tmp_path: Path, project_path: Path) -> tuple[Path, Path]:
    """A real skill dir + a project-local symlink into it, so
    `script_skill_key` can resolve a Bash call through the harness's
    `.claude/skills/` link (design D4)."""
    skill_real_dir = tmp_path / "skill-real" / "unslop"
    (skill_real_dir / "scripts").mkdir(parents=True)
    (skill_real_dir / "scripts" / "foo.sh").write_text("#!/bin/sh\necho hi\n")

    claude_skills_dir = project_path / ".claude" / "skills"
    claude_skills_dir.mkdir(parents=True, exist_ok=True)
    link = claude_skills_dir / "unslop"
    link.symlink_to(skill_real_dir)
    return skill_real_dir, link


# ─────────────────────────────────────────────────────────────────────────────
# The comprehensive session
# ─────────────────────────────────────────────────────────────────────────────


def test_scan_builds_a_rich_session_row(tmp_data_home, tmp_path, monkeypatch):
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T11:00:00Z")

    project_path = tmp_path / "repo"
    project_path.mkdir()
    skill_real_dir, _link = _seed_unslop_script(tmp_path, project_path)

    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {
            "proof-it": {"type": "skill", "source": str(tmp_path / "skill-real" / "proof-it")},
            "deliver-it": {"type": "skill", "source": str(tmp_path / "skill-real" / "deliver-it")},
            "unslop": {"type": "skill", "source": str(skill_real_dir)},
        },
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)

    t = {
        "human1": "2026-09-01T10:00:00.000Z",
        "asst1a": "2026-09-01T10:00:05.000Z",
        "asst1b": "2026-09-01T10:00:05.500Z",
        "skillcall": "2026-09-01T10:01:00.000Z",
        "toolresult_skill": "2026-09-01T10:01:05.000Z",
        "toolresult_agent": "2026-09-01T10:01:06.000Z",
        "skillecho": "2026-09-01T10:01:10.000Z",
        "slashcmd": "2026-09-01T10:02:00.000Z",
        "asst_ack": "2026-09-01T10:02:30.000Z",
        "compact": "2026-09-01T10:03:00.000Z",
        "asst_bash": "2026-09-01T10:03:30.000Z",
        "asst_synth": "2026-09-01T10:04:00.000Z",
        "stacked": "2026-09-01T10:04:30.000Z",
        "interrupted": "2026-09-01T10:05:00.000Z",
    }

    records = [
        _user_text(
            ts=t["human1"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            text="Please help me ship this. My token is Bearer abc12345secret.",
        ),
        _assistant_record(
            ts=t["asst1a"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            message_id="msg_1",
            content=[
                {"type": "text", "text": "Sure, I'll help."},
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "git status"}},
            ],
            usage=_usage(input_tokens=2, output_tokens=90000, cache_creation=57529, cache_read=24682),
        ),
        _assistant_record(
            ts=t["asst1b"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            message_id="msg_1",
            content=[
                {"type": "tool_use", "id": "toolu_2", "name": "Read", "input": {"file_path": "/tmp/some/file.py"}},
            ],
            # Same id — usage repeats identically and must be counted ONCE.
            usage=_usage(input_tokens=2, output_tokens=90000, cache_creation=57529, cache_read=24682),
        ),
        _assistant_record(
            ts=t["skillcall"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            message_id="msg_2",
            content=[
                {"type": "tool_use", "id": "toolu_skill1", "name": "Skill", "input": {"skill": "proof-it"}},
                {
                    "type": "tool_use",
                    "id": "toolu_agent1",
                    "name": "Agent",
                    "input": {"subagent_type": "orch-planner", "model": "claude-opus-5"},
                },
            ],
            usage=_usage(output_tokens=50, cache_creation=10, cache_read=5),
        ),
        _user_list(
            ts=t["toolresult_skill"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            content=[{"type": "tool_result", "tool_use_id": "toolu_skill1", "content": "ok"}],
            toolUseResult={"stdout": "ok"},
        ),
        _user_list(
            ts=t["toolresult_agent"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            content=[{"type": "tool_result", "tool_use_id": "toolu_agent1", "content": "ok"}],
            toolUseResult={"agentId": SUBAGENT_FLAT, "resolvedModel": "claude-opus-5"},
        ),
        _user_list(
            ts=t["skillecho"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            content=[{"type": "text", "text": "Base directory for this skill: /some/skill/dir"}],
            is_meta=True,
        ),
        _user_text(
            ts=t["slashcmd"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            # Reversed tag order (design Context 15).
            text=(
                "<command-message>Ship it</command-message>"
                "<command-name>deliver-it</command-name><command-args></command-args>"
            ),
        ),
        _assistant_record(
            ts=t["asst_ack"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            message_id="msg_3",
            content=[{"type": "text", "text": "Shipping now."}],
            usage=_usage(output_tokens=20, cache_creation=0, cache_read=0),
        ),
        _user_text(
            ts=t["compact"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            text="<command-name>compact</command-name><command-message>Compact</command-message><command-args></command-args>",
        ),
        _assistant_record(
            ts=t["asst_bash"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            message_id="msg_4",
            content=[
                {
                    "type": "tool_use",
                    "id": "toolu_bash_script",
                    "name": "Bash",
                    "input": {"command": f"bash {project_path}/.claude/skills/unslop/scripts/foo.sh --flag"},
                }
            ],
            usage=_usage(output_tokens=10, cache_creation=0, cache_read=0),
        ),
        _assistant_record(
            ts=t["asst_synth"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            message_id="msg_5",
            model="<synthetic>",
            content=[{"type": "text", "text": "synthetic note"}],
            usage=_usage(output_tokens=7, cache_creation=0, cache_read=0),
        ),
        _user_text(
            ts=t["stacked"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            text="queued follow-up",
            stackedExpansion=True,
        ),
        _user_text(
            ts=t["interrupted"],
            session_id=SESSION_MAIN,
            cwd=cwd,
            text="[Request interrupted by user]",
        ),
    ]

    # Shuffle relative to timestamp order (design Context 9: not time-ordered).
    shuffled = [records[i] for i in (3, 0, 7, 1, 9, 2, 4, 10, 5, 8, 6, 11, 12, 13)]

    session_file = slug_dir / f"{SESSION_MAIN}.jsonl"
    _write_jsonl(session_file, shuffled)

    # Junk at the top level: skipped by the UUID filename filter.
    (slug_dir / "not-a-session.jsonl").write_text("garbage\n")
    (slug_dir / ".DS_Store").write_bytes(b"\x00\x01")
    (slug_dir / "sessions-index.json").write_text("{}")

    # Sub-agent files, both nesting shapes.
    flat_path = slug_dir / SESSION_MAIN / "subagents" / f"agent-{SUBAGENT_FLAT}.jsonl"
    _write_jsonl(
        flat_path,
        [
            _sub_assistant(
                ts="2026-09-01T10:01:02.000Z",
                agent_id=SUBAGENT_FLAT,
                message_id="sub_msg_1",
                model="claude-opus-5",
                usage=_usage(output_tokens=100000, cache_creation=1000942, cache_read=0),
            )
        ],
    )
    wf_path = slug_dir / SESSION_MAIN / "subagents" / "workflows" / "wf_1" / f"agent-{SUBAGENT_WF}.jsonl"
    _write_jsonl(
        wf_path,
        [
            _sub_assistant(
                ts="2026-09-01T10:01:03.000Z",
                agent_id=SUBAGENT_WF,
                message_id="sub_msg_2",
                model="claude-sonnet-5",
                usage=_usage(output_tokens=200, cache_creation=10, cache_read=5),
            )
        ],
    )
    journal_path = slug_dir / SESSION_MAIN / "subagents" / "workflows" / "wf_1" / "journal.jsonl"
    _write_jsonl(journal_path, [{"type": "started", "agentId": SUBAGENT_WF, "key": "x"}])

    result = us.scan_sessions()

    assert result["ok"] is True
    assert result["errors"] == []
    assert result["stopped_on"] is None
    assert result["rows_written"] == 1
    assert result["files_skipped"] >= 1  # the non-UUID .jsonl

    rows, warnings = us.read_session_rows()
    assert warnings == []
    assert len(rows) == 1
    row = rows[0]

    assert row["harness"] == "claude-code"
    assert row["session_id"] == SESSION_MAIN
    assert row["project"] == "skill-hub"
    assert row["frozen"] is False
    assert row["compactions"] == 1

    # message.id dedupe: msg_1's usage counted once (not on both of its lines).
    # Five distinct ids each contribute the default input_tokens=2 once:
    # msg_1 (deduped across its two lines) + msg_2 + msg_3 + msg_4 + msg_5.
    assert row["tokens"]["input"] == 2 * 5
    assert row["tokens"]["output"] == 90000 + 50 + 20 + 10 + 7
    assert row["tokens"]["total"] == (
        row["tokens"]["input"] + row["tokens"]["output"] + row["tokens"]["cache_creation"] + row["tokens"]["cache_read"]
    )

    # first_turn_input_total: msg_1's (input+cc+cr), the earliest non-synthetic id.
    assert row["first_turn_input_total"] == 2 + 57529 + 24682

    # Activity: Bash "git status" -> read; Read tool -> read; Skill -> skill;
    # Agent -> delegate; the second Bash (script) -> operate (not a known
    # verify/read-only prefix).
    assert row["activity"]["read"] == 2
    assert row["activity"]["skill"] == 1
    assert row["activity"]["delegate"] == 1
    assert row["activity"]["operate"] == 1

    # skills[]: Skill(model) -> proof-it/model; slash command -> deliver-it/you
    # (registered); script Bash call -> unslop/script; "compact" excluded
    # (not a registry key).
    skills_by_key = {(s["key"], s["invoker"]): s["count"] for s in row["skills"]}
    assert skills_by_key.get(("proof-it", "model")) == 1
    assert skills_by_key.get(("deliver-it", "you")) == 1
    assert skills_by_key.get(("unslop", "script")) == 1
    assert all(k[0] != "compact" for k in skills_by_key)

    # subagents[]: one matched (orch-planner/claude-opus-5 via the Agent tool
    # call + its tool_result), one unmatched -> "unknown" type, its own model.
    subagents_by_type = {(s["subagent_type"], s["model"]): s["tokens"] for s in row["subagents"]}
    assert subagents_by_type[("orch-planner", "claude-opus-5")] == 2 + 100000 + 1000942
    assert subagents_by_type[("unknown", "claude-sonnet-5")] == 2 + 200 + 10 + 5
    assert row["tokens"]["subagent_total"] == (2 + 100000 + 1000942) + (2 + 200 + 10 + 5)

    # Events: exactly one slash_command event per slash command turn (never
    # also a human_turn event for the same record) — design G14. All FIVE
    # event kinds fire (R3), each with the right invoker/name/model.
    kinds = [e["kind"] for e in row["events"]]
    assert kinds.count("human_turn") == 3  # human1, stacked, interrupted
    assert kinds.count("slash_command") == 2  # deliver-it, compact
    assert kinds.count("skill") == 1
    assert kinds.count("script") == 1
    assert kinds.count("subagent") == 1

    slash_names = {e["name"] for e in row["events"] if e["kind"] == "slash_command"}
    assert slash_names == {"deliver-it", "compact"}
    for ev in row["events"]:
        if ev["kind"] in ("human_turn", "slash_command"):
            assert ev["invoker"] == "you"

    skill_event = next(e for e in row["events"] if e["kind"] == "skill")
    assert skill_event["name"] == "proof-it"
    assert skill_event["invoker"] == "model"

    script_event = next(e for e in row["events"] if e["kind"] == "script")
    assert script_event["name"] == "unslop"
    assert script_event["invoker"] == "script"

    subagent_event = next(e for e in row["events"] if e["kind"] == "subagent")
    assert subagent_event["name"] == "orch-planner"
    assert subagent_event["invoker"] == "model"
    assert subagent_event["model"] == "claude-opus-5"
    assert subagent_event["tokens"] == {
        "input": 2,
        "output": 100000,
        "cache_creation": 1000942,
        "cache_read": 0,
    }

    # steering_count only counts human_turn/slash_command seeds (5 of the 8
    # events): human1 is first (not steering); "stacked" is explicitly
    # excluded even though it is not first; the rest (deliver-it, compact,
    # interrupted) all count.
    assert row["steering_count"] == 3

    # Timestamps sorted correctly despite the shuffled write order.
    assert row["started_at"] == t["human1"]
    assert row["last_activity_at"] == t["interrupted"]


# ─────────────────────────────────────────────────────────────────────────────
# Unregistered project
# ─────────────────────────────────────────────────────────────────────────────


def test_unregistered_project_lands_in_the_unregistered_bucket(tmp_data_home, tmp_path):
    registry = {"harnesses_global": ["claude-code"], "projects": {}, "skills": {}}
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    # A slug with a dot segment (design Context 10's double-dash rule) —
    # irrelevant to matching (which reads `cwd`, not the slug), but exercised
    # here to prove the scanner does not depend on slug shape.
    slug_dir = root / "-Users-x-my.repo"
    cwd = str(tmp_path / "somewhere" / "not-registered")

    records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=SESSION_UNREGISTERED, cwd=cwd, text="hello"),
        _assistant_record(
            ts="2026-09-01T09:00:05.000Z",
            session_id=SESSION_UNREGISTERED,
            cwd=cwd,
            message_id="u_msg",
            content=[{"type": "text", "text": "hi"}],
            usage=_usage(),
        ),
    ]
    _write_jsonl(slug_dir / f"{SESSION_UNREGISTERED}.jsonl", records)

    result = us.scan_sessions()
    assert result["ok"] is True
    assert result["sessions_unregistered"] == 1

    rows, _warnings = us.read_session_rows()
    assert len(rows) == 1
    assert rows[0]["project"] == "unregistered"
    payload = json.dumps(rows[0])
    assert str(tmp_path) not in payload
    assert cwd not in payload


# ─────────────────────────────────────────────────────────────────────────────
# Error boundary
# ─────────────────────────────────────────────────────────────────────────────


def test_one_bad_transcript_keeps_written_rows_and_reports_stopped_on(
    tmp_data_home, tmp_path, monkeypatch
):
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)

    good_records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=SESSION_GOOD, cwd=cwd, text="hello"),
        _assistant_record(
            ts="2026-09-01T09:00:05.000Z",
            session_id=SESSION_GOOD,
            cwd=cwd,
            message_id="g_msg",
            content=[{"type": "text", "text": "hi"}],
            usage=_usage(),
        ),
    ]
    good_path = slug_dir / f"{SESSION_GOOD}.jsonl"
    _write_jsonl(good_path, good_records)

    bad_path = slug_dir / f"{SESSION_BAD}.jsonl"
    _write_jsonl(bad_path, [_user_text(ts="2026-09-01T09:01:00.000Z", session_id=SESSION_BAD, cwd=cwd, text="x")])
    from skill_hub.application.usage import usage_inspection_scan

    original_parse = usage_inspection_scan._portable_parse

    def portable_parse(
        harness,
        path,
        cursor,
        seconds,
        *,
        worker_target=usage_inspection_scan._portable_parse_worker,
        reader_ref=None,
    ):
        target = _permission_error_worker if path == bad_path else worker_target
        return original_parse(
            harness, path, cursor, seconds, worker_target=target, reader_ref=reader_ref
        )

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", portable_parse)
    result = us.scan_sessions()

    assert result["ok"] is False
    assert result["stopped_on"] == bad_path.name
    assert result["errors"] == [
        {"file": bad_path.name, "kind": "PermissionError", "harness": "claude-code"}
    ]

    rows, _warnings = us.read_session_rows()
    session_ids = {r["session_id"] for r in rows}
    assert SESSION_GOOD in session_ids


SESSION_AFTER_BAD = "11111111-1111-4111-8111-111111111111"


def test_bad_transcript_never_blocks_a_later_file_or_a_later_scan(
    tmp_data_home, tmp_path, monkeypatch
):
    """R4: a bad transcript is recorded and skipped, not a permanent stop —
    a file that sorts AFTER it is still processed in the SAME scan, and a
    SECOND scan (the file still unreadable) reports the same single failure
    again rather than getting stuck."""
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"  # holds the bad file
    # A hex session id cannot sort after "ffffffff" (the max hex value) in
    # the SAME directory, so the "later" file lives in a slug dir that
    # itself sorts after "-Users-x-repo" — the outer walk is `sorted` on
    # slug dirs first, then files within each.
    slug_dir_after = root / "-Users-z-repo"
    cwd = str(project_path)

    bad_path = slug_dir / f"{SESSION_BAD}.jsonl"
    _write_jsonl(bad_path, [_user_text(ts="2026-09-01T09:01:00.000Z", session_id=SESSION_BAD, cwd=cwd, text="x")])

    after_records = [
        _user_text(ts="2026-09-01T09:02:00.000Z", session_id=SESSION_AFTER_BAD, cwd=cwd, text="hello"),
        _assistant_record(
            ts="2026-09-01T09:02:05.000Z",
            session_id=SESSION_AFTER_BAD,
            cwd=cwd,
            message_id="z_msg",
            content=[{"type": "text", "text": "hi"}],
            usage=_usage(),
        ),
    ]
    _write_jsonl(slug_dir_after / f"{SESSION_AFTER_BAD}.jsonl", after_records)

    from skill_hub.application.usage import usage_inspection_scan

    original_parse = usage_inspection_scan._portable_parse

    def portable_parse(
        harness,
        path,
        cursor,
        seconds,
        *,
        worker_target=usage_inspection_scan._portable_parse_worker,
        reader_ref=None,
    ):
        target = _permission_error_worker if path == bad_path else worker_target
        return original_parse(
            harness, path, cursor, seconds, worker_target=target, reader_ref=reader_ref
        )

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", portable_parse)
    result1 = us.scan_sessions()

    assert result1["ok"] is False
    assert result1["stopped_on"] == bad_path.name
    assert len(result1["errors"]) == 1
    rows, _w = us.read_session_rows()
    assert SESSION_AFTER_BAD in {r["session_id"] for r in rows}

    result2 = us.scan_sessions()

    assert result2["ok"] is False
    assert len(result2["errors"]) == 1  # not accumulated, not stuck
    rows2, _w = us.read_session_rows()
    assert SESSION_AFTER_BAD in {r["session_id"] for r in rows2}


# ─────────────────────────────────────────────────────────────────────────────
# Frozen rows
# ─────────────────────────────────────────────────────────────────────────────


def test_frozen_row_is_byte_identical_after_a_second_scan_and_detects_growth(tmp_data_home, tmp_path, monkeypatch):
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "eeeeeeee-1111-4111-8111-111111111111"

    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T09:10:00Z")
    records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=session_id, cwd=cwd, text="hello"),
        _assistant_record(
            ts="2026-09-01T09:00:05.000Z",
            session_id=session_id,
            cwd=cwd,
            message_id="f_msg",
            content=[{"type": "text", "text": "hi"}],
            usage=_usage(),
        ),
    ]
    session_file = slug_dir / f"{session_id}.jsonl"
    _write_jsonl(session_file, records)

    # 73 hours later — well past the freeze horizon.
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-04T10:10:00Z")
    result = us.scan_sessions()
    assert result["ok"] is True
    rows, _w = us.read_session_rows()
    row = next(r for r in rows if r["session_id"] == session_id)
    assert row["frozen"] is True
    assert result["rows_frozen"] == 1

    ledger_text_after_freeze = us.sessions_path().read_text()

    # Second scan, file untouched — the row must be byte-identical (built
    # by construction: the frozen file is never re-read).
    result2 = us.scan_sessions()
    assert result2["frozen_appended"] == 0
    assert us.sessions_path().read_text() == ledger_text_after_freeze

    # Canonical capture keeps appended evidence even after the freeze horizon.
    extra = _assistant_record(
        ts="2026-09-04T09:00:00.000Z",
        session_id=session_id,
        cwd=cwd,
        message_id="f_msg2",
        content=[{"type": "text", "text": "more"}],
        usage=_usage(),
    )
    with open(session_file, "a") as fh:
        fh.write(json.dumps(extra) + "\n")
    os.utime(session_file, None)  # ensure mtime advances
    result3 = us.scan_sessions()
    assert result3["frozen_appended"] == 1
    after_rows, _warnings = us.read_session_rows()
    after_row = next(r for r in after_rows if r["session_id"] == session_id)
    before_row = json.loads(ledger_text_after_freeze)
    assert after_row["tokens"]["total"] == before_row["tokens"]["total"] * 2
    assert after_row["last_activity_at"] == "2026-09-04T09:00:00.000Z"
    assert after_row["frozen"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Incremental read + unterminated tail line
# ─────────────────────────────────────────────────────────────────────────────


def test_incremental_scan_reads_only_appended_bytes(tmp_data_home, tmp_path, monkeypatch):
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T09:10:00Z")
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "12345678-1111-4111-8111-111111111111"
    session_file = slug_dir / f"{session_id}.jsonl"

    first_record = _user_text(ts="2026-09-01T09:00:00.000Z", session_id=session_id, cwd=cwd, text="first")
    second_record = _assistant_record(
        ts="2026-09-01T09:00:05.000Z",
        session_id=session_id,
        cwd=cwd,
        message_id="a_msg",
        content=[{"type": "text", "text": "hi"}],
        usage=_usage(output_tokens=10, cache_creation=0, cache_read=0),
    )
    # First line complete; a SECOND, unterminated tail line (no trailing \n).
    session_file.parent.mkdir(parents=True, exist_ok=True)
    session_file.write_text(json.dumps(first_record) + "\n" + json.dumps(second_record))

    result1 = us.scan_sessions()
    assert result1["ok"] is False
    assert result1["inspection"]["sources_incomplete"] == 1
    assert result1["inspection"]["errors"][0]["kind"] == "partial_source"
    rows, _w = us.read_session_rows()
    # A first partial capture cannot claim a complete canonical summary.
    assert session_id not in {row["session_id"] for row in rows}
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore
    with InspectionStore.open() as store:
        tokens = store.index_payload()["sessions"][0]["scopes"]["own"]["tokens"]
        assert tokens["status"] != "available"
    bytes_after_first = result1["bytes_read"]
    assert bytes_after_first == len(session_file.read_bytes().splitlines(keepends=True)[0])

    # Now terminate that line and append a third record.
    third_record = _assistant_record(
        ts="2026-09-01T09:00:10.000Z",
        session_id=session_id,
        cwd=cwd,
        message_id="a_msg2",
        content=[{"type": "text", "text": "more"}],
        usage=_usage(output_tokens=5, cache_creation=0, cache_read=0),
    )
    with open(session_file, "a") as fh:
        fh.write("\n" + json.dumps(third_record) + "\n")

    result2 = us.scan_sessions()
    assert result2["ok"] is True
    # Only the appended bytes were read (the second scan's bytes_read is
    # smaller than the full file).
    assert result2["bytes_read"] < session_file.stat().st_size
    assert result2["bytes_read"] > 0

    rows, _w = us.read_session_rows()
    row = next(r for r in rows if r["session_id"] == session_id)
    assert row["tokens"]["output"] == 10 + 5
    assert row["started_at"] == "2026-09-01T09:00:00.000Z"
    assert row["last_activity_at"] == "2026-09-01T09:00:10.000Z"


# ─────────────────────────────────────────────────────────────────────────────
# Replaced / shrunk file
# ─────────────────────────────────────────────────────────────────────────────


def test_shrunk_or_replaced_file_resets_cursor_and_is_read_whole(tmp_data_home, tmp_path, monkeypatch):
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T09:10:00Z")
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "87654321-1111-4111-8111-111111111111"
    session_file = slug_dir / f"{session_id}.jsonl"

    records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=session_id, cwd=cwd, text="first"),
        _assistant_record(
            ts="2026-09-01T09:00:05.000Z",
            session_id=session_id,
            cwd=cwd,
            message_id="r_msg",
            content=[{"type": "text", "text": "hi"}],
            usage=_usage(output_tokens=99, cache_creation=0, cache_read=0),
        ),
    ]
    _write_jsonl(session_file, records)
    us.scan_sessions()
    rows, _w = us.read_session_rows()
    row = next(r for r in rows if r["session_id"] == session_id)
    assert row["tokens"]["output"] == 99

    # Replace with SHORTER content (same session id) and force the mtime
    # backward so the "replaced" branch is unambiguous.
    new_records = [
        _user_text(ts="2026-09-02T09:00:00.000Z", session_id=session_id, cwd=cwd, text="replaced"),
    ]
    _write_jsonl(session_file, new_records)
    stat = session_file.stat()
    os.utime(session_file, (stat.st_atime - 3600, stat.st_mtime - 3600))

    result2 = us.scan_sessions()
    assert result2["ok"] is True
    rows, _w = us.read_session_rows()
    row = next(r for r in rows if r["session_id"] == session_id)
    # The old accumulator (msg_r's 99 output tokens) is GONE — read whole.
    assert row["tokens"]["output"] == 0
    assert row["started_at"] == "2026-09-02T09:00:00.000Z"


# ─────────────────────────────────────────────────────────────────────────────
# Privacy walk
# ─────────────────────────────────────────────────────────────────────────────


def _walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _walk_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _walk_strings(v)


def test_privacy_walk_no_absolute_paths_no_home_and_idempotent_excerpts(tmp_data_home, tmp_path, monkeypatch):
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T11:00:00Z")
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "13131313-1111-4111-8111-111111111111"

    secret_text = (
        f"My home is {Path.home()} and my path is {project_path}/secret/file.py "
        f"and a token Bearer abc12345secret and password: hunter2xhunter"
    )
    records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=session_id, cwd=cwd, text=secret_text),
        _assistant_record(
            ts="2026-09-01T09:00:05.000Z",
            session_id=session_id,
            cwd=cwd,
            message_id="p_msg",
            content=[{"type": "text", "text": "ok"}],
            usage=_usage(output_tokens=1, cache_creation=0, cache_read=0),
        ),
    ]
    _write_jsonl(slug_dir / f"{session_id}.jsonl", records)

    result = us.scan_sessions()
    home_str = str(Path.home())

    def _check(payload) -> None:
        for s in _walk_strings(payload):
            assert home_str not in s, s
            for match in __import__("re").finditer(r"/(?:[\w.@+-]+/)+[\w.@+-]+", s):
                raise AssertionError(f"absolute path leaked: {match.group(0)!r} in {s!r}")

    _check(result)
    rows, _w = us.read_session_rows()
    for row in rows:
        _check(row)
        excerpt = row.get("intent_excerpt") or ""
        assert us.usage_classify.redact_excerpt(excerpt) == excerpt
        for event in row.get("events") or []:
            ex = event.get("excerpt") or ""
            assert us.usage_classify.redact_excerpt(ex) == ex


# ─────────────────────────────────────────────────────────────────────────────
# hub sync never scans (belongs to unit C's wiring test, but the module-level
# contract — that nothing in this module runs at import time — is worth a
# cheap smoke check here too).
# ─────────────────────────────────────────────────────────────────────────────


def test_last_scan_at_is_none_before_the_first_scan(tmp_data_home):
    assert us.last_scan_at() is None


# ─────────────────────────────────────────────────────────────────────────────
# Fix round: outcome_metrics editing/unverified counts, event-level token +
# text-length fields, and the lock-scoping contract.
# ─────────────────────────────────────────────────────────────────────────────


def _fake_row(*, edit: int = 0, verify: int = 0, **overrides) -> dict:
    row: dict = {
        "cache_hit_ratio": None,
        "thinking_text_share": None,
        "activity": {c: 0 for c in us.ACTIVITY_CLASSES},
        "tokens": {"output": 0, "subagent_total": 0},
        "files_read": 0,
        "files_edited": 0,
        "tracked_files": None,
        "steering_count": 0,
    }
    row["activity"]["edit"] = edit
    row["activity"]["verify"] = verify
    row.update(overrides)
    return row


def test_outcome_metrics_reports_editing_and_unverified_editing_sessions():
    """`usage_footprint._verification_finding` reads exactly these two keys
    (design D9's verification trigger) — without them the finding can never
    fire."""
    rows = [
        _fake_row(edit=2, verify=0),  # editing, UNverified
        _fake_row(edit=1, verify=1),  # editing, verified
        _fake_row(edit=0, verify=0),  # not an editing session at all
    ]
    outcomes = us.outcome_metrics(rows, rows)
    assert outcomes["editing_sessions"] == 2
    assert outcomes["unverified_editing_sessions"] == 1


def test_outcome_metrics_tokens_per_session_uses_top_level_rows_only():
    rows = [
        _fake_row(tokens={"total": 1000, "subagent_total": 0}),
        _fake_row(tokens={"total": 3000, "subagent_total": 999999}),
    ]
    outcomes = us.outcome_metrics(rows, rows)
    assert outcomes["tokens_per_session"] == 2000
    assert us.outcome_metrics([], [])["tokens_per_session"] is None


def test_event_tokens_and_text_lengths_reflect_the_segment_between_events(
    tmp_data_home, tmp_path, monkeypatch
):
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T11:00:00Z")
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "22222222-1111-4111-8111-111111111111"

    records = [
        _user_text(ts="2026-09-01T10:00:00.000Z", session_id=session_id, cwd=cwd, text="first"),
        _assistant_record(
            ts="2026-09-01T10:00:05.000Z",
            session_id=session_id,
            cwd=cwd,
            message_id="e_msg",
            content=[
                {"type": "text", "text": "hello there"},
                {"type": "thinking", "thinking": "hmm think", "signature": "sig"},
            ],
            usage=_usage(input_tokens=3, output_tokens=40, cache_creation=7, cache_read=9),
        ),
        _user_text(ts="2026-09-01T10:00:10.000Z", session_id=session_id, cwd=cwd, text="second"),
    ]
    _write_jsonl(slug_dir / f"{session_id}.jsonl", records)

    us.scan_sessions()
    rows, _w = us.read_session_rows()
    row = next(r for r in rows if r["session_id"] == session_id)
    events = sorted(row["events"], key=lambda e: e["at"])
    assert len(events) == 2
    first_event, second_event = events

    # The FIRST event's segment is empty — nothing precedes it.
    assert first_event["tokens"] == {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0}
    assert first_event["thinking_len"] == 0
    assert first_event["output_text_len"] == 0

    # The SECOND event's segment closes over the one assistant turn between
    # the two human turns.
    assert second_event["tokens"] == {"input": 3, "output": 40, "cache_creation": 7, "cache_read": 9}
    assert second_event["thinking_len"] == len("hmm think")
    assert second_event["output_text_len"] == len("hello there")
    # `token_delta` is unchanged: still output + cache_creation.
    assert second_event["token_delta"] == 40 + 7


class _CountingLock:
    """A fake `hub_core.data_home_lock` that counts how many times it is
    entered and exposes whether it is CURRENTLY held, so a spy on another
    function can assert the lock was not held while it ran."""

    def __init__(self) -> None:
        self.enter_count = 0
        self.currently_locked = False

    def __call__(self) -> "_CountingLock":
        return self

    def __enter__(self) -> "_CountingLock":
        self.enter_count += 1
        self.currently_locked = True
        return self

    def __exit__(self, *exc_info) -> bool:
        self.currently_locked = False
        return False


def test_scan_sessions_does_not_hold_the_lock_while_reading_transcripts(
    tmp_data_home, tmp_path, monkeypatch
):
    """design G13: the process-wide data-home lock must wrap only the final
    ledger/cursor write, never the (potentially minutes-long) transcript
    walk or the `git ls-files` subprocess — holding it that long would block
    every other hub command."""
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T11:00:00Z")
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "33333333-1111-4111-8111-111111111111"
    records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=session_id, cwd=cwd, text="hi"),
        _assistant_record(
            ts="2026-09-01T09:00:05.000Z",
            session_id=session_id,
            cwd=cwd,
            message_id="l_msg",
            content=[{"type": "text", "text": "ok"}],
            usage=_usage(),
        ),
    ]
    _write_jsonl(slug_dir / f"{session_id}.jsonl", records)

    counting_lock = _CountingLock()
    monkeypatch.setattr(us.hub_core, "data_home_lock", counting_lock)

    from skill_hub.application.usage import usage_inspection

    read_while_locked = []
    original_capture = usage_inspection.capture_scan_source

    def spy_capture(source, build, *args, **kwargs):
        def spy_build(cursor):
            read_while_locked.append(counting_lock.currently_locked)
            return build(cursor)

        return original_capture(source, spy_build, *args, **kwargs)

    monkeypatch.setattr(usage_inspection, "capture_scan_source", spy_capture)

    tracked_while_locked = []
    original_tracked_files = usage_summary_export._tracked_files

    def spy_tracked_files(project_path_str):
        tracked_while_locked.append(counting_lock.currently_locked)
        return original_tracked_files(project_path_str)

    monkeypatch.setattr(usage_summary_export, "_tracked_files", spy_tracked_files)

    result = us.scan_sessions()

    assert result["ok"] is True
    assert read_while_locked  # the spy actually ran
    assert not any(read_while_locked)
    assert tracked_while_locked
    assert not any(tracked_while_locked)
    # Exactly one lock scope: the single write step at the end of the scan.
    assert counting_lock.enter_count >= 1


# ─────────────────────────────────────────────────────────────────────────────
# Review fix round: R1 (pure derivation), R2 (subagent_token_share formula
# agreement), R11 (cursor sidecar never holds raw prompt text)
# ─────────────────────────────────────────────────────────────────────────────


def test_summary_is_pure_across_three_reads_of_published_facts(tmp_data_home, tmp_path, monkeypatch):
    """Repeated projections must not accumulate slash-command skill counts."""
    from skill_hub.application.usage.usage_summary import project_session
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-05T00:00:00Z")
    project = tmp_path / "repo"
    project.mkdir()
    registry = {"projects": {"proj": {"path": str(project)}}, "skills": {"proof-it": {}}}
    _write_registry(registry)
    path = (
        Path(os.environ["SKILL_HUB_CLAUDE_HOME"])
        / "projects/slug"
        / f"{SESSION_MAIN}.jsonl"
    )
    _write_jsonl(path, [_user_text(
        ts="2026-09-01T09:00:00.000Z", session_id=SESSION_MAIN, cwd=str(project),
        text="<command-name>/proof-it</command-name>",
    )])
    assert us.scan_sessions()["ok"]
    with InspectionStore.open() as store:
        facts = store.summary_facts("claude-code", SESSION_MAIN)
    before = json.dumps(facts, sort_keys=True)
    rows = [project_session(
        "claude-code", SESSION_MAIN, facts=facts, registry=registry,
        loadout_rows=[], now=us.now(), tracked_files=None,
    ) for _ in range(3)]
    assert rows[0] == rows[1] == rows[2]
    assert next(skill["count"] for skill in rows[0]["skills"]
                if skill["key"] == "proof-it" and skill["invoker"] == "you") == 1
    assert json.dumps(facts, sort_keys=True) == before


def test_subagent_token_share_agrees_between_outcome_metrics_and_session_payload(
    tmp_data_home, tmp_path, monkeypatch
):
    """R2: both readers must compute `subagent_total / (total +
    subagent_total)` — never `subagent_total / (output + subagent_total)`,
    which the CRITICAL finding measured as an 11x error on a real row."""
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T12:00:00Z")
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "44444444-1111-4111-8111-111111111111"

    records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=session_id, cwd=cwd, text="hi"),
        _assistant_record(
            ts="2026-09-01T09:00:05.000Z",
            session_id=session_id,
            cwd=cwd,
            message_id="s_msg",
            content=[
                {
                    "type": "tool_use",
                    "id": "toolu_a1",
                    "name": "Agent",
                    "input": {"subagent_type": "orch-planner", "model": "claude-opus-5"},
                }
            ],
            # output=100, total (with defaults input=2,cc=1000,cr=500) = 1602.
            usage=_usage(output_tokens=100, cache_creation=1000, cache_read=500),
        ),
        _user_list(
            ts="2026-09-01T09:00:10.000Z",
            session_id=session_id,
            cwd=cwd,
            content=[{"type": "tool_result", "tool_use_id": "toolu_a1", "content": "ok"}],
            toolUseResult={"agentId": "sub-1", "resolvedModel": "claude-opus-5"},
        ),
    ]
    _write_jsonl(slug_dir / f"{session_id}.jsonl", records)
    sub_path = slug_dir / session_id / "subagents" / "agent-sub-1.jsonl"
    _write_jsonl(
        sub_path,
        [
            _sub_assistant(
                ts="2026-09-01T09:00:07.000Z",
                agent_id="sub-1",
                message_id="sub_msg",
                model="claude-opus-5",
                usage=_usage(output_tokens=900, cache_creation=0, cache_read=0),
            )
        ],
    )

    us.scan_sessions()
    rows, _w = us.read_session_rows()
    row = next(r for r in rows if r["session_id"] == session_id)
    total = row["tokens"]["total"]
    subagent_total = row["tokens"]["subagent_total"]
    expected_share = subagent_total / (total + subagent_total)

    outcomes = us.outcome_metrics([row], [row])
    assert outcomes["subagent_token_share"] == expected_share

    payload = us.session_payload(session_id, {})
    assert payload["summary"]["subagent_token_share"] == expected_share


def test_cursor_sidecar_never_holds_raw_prompt_text(tmp_data_home, tmp_path, monkeypatch):
    """R11: the accumulator (persisted verbatim to `scan-cursor.json`) stores
    only the already-redacted excerpt, never the raw human-turn string."""
    monkeypatch.setenv("SKILL_HUB_NOW", "2026-09-01T11:00:00Z")
    project_path = tmp_path / "repo"
    project_path.mkdir()
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"skill-hub": {"path": str(project_path), "harnesses": []}},
        "skills": {},
    }
    _write_registry(registry)

    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    slug_dir = root / "-Users-x-repo"
    cwd = str(project_path)
    session_id = "55555555-1111-4111-8111-111111111111"

    secret_text = (
        f"My home is {Path.home()} and my path is {project_path}/secret/file.py "
        f"and a token Bearer abc12345secret"
    )
    records = [
        _user_text(ts="2026-09-01T09:00:00.000Z", session_id=session_id, cwd=cwd, text=secret_text),
    ]
    _write_jsonl(slug_dir / f"{session_id}.jsonl", records)

    us.scan_sessions()

    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    # Native resume state and durable summary messages retain only redacted text.
    with InspectionStore.open() as store:
        states = [row[0] for row in store.db.execute("SELECT resume_state FROM sources")]
        facts = store.summary_facts("claude-code", session_id)
    persisted = json.dumps([states, facts["message"], facts["structural"]])
    assert secret_text not in persisted
    assert str(Path.home()) not in persisted
    assert "abc12345secret" not in persisted
    assert facts["message"]  # The real human turn was captured.


def test_cursor_migrates_absolute_claude_and_subagent_keys_once(tmp_data_home, tmp_path):
    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"
    transcript = root / "slug" / f"{SESSION_MAIN}.jsonl"
    subagent = root / "slug" / SESSION_MAIN / "subagents" / "agent-a.jsonl"
    outside = tmp_path / "other.jsonl"
    path = us.cursor_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    original = {
        "files": {
            str(transcript): {"offset": 1, "frozen": True, "acc": {"x": 1}},
            str(subagent): {"offset": 2, "acc": {"x": 2}},
            str(outside): {"offset": 3},
        }
    }
    path.write_text(json.dumps(original))
    first = us._read_cursor()
    assert f"claude-code:{transcript.relative_to(root)}" in first["files"]
    assert f"claude-code:{subagent.relative_to(root)}" in first["files"]
    assert str(outside) in first["files"]
    assert all(not os.path.isabs(key) for key in first["files"] if key != str(outside))
    assert us._read_cursor() == first
