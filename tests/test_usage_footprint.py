"""Tests for `usage_footprint.py` — static composition, findings, and the
composed `hub usage project` / `hub usage findings` payloads
(usage-loadout-analytics design D5/D7/D9/D12).

`usage_scan.py` (unit A) is written in parallel with this unit. The
`project_payload`/`findings_payload` tests below never import the real
module: `_install_fake_usage_scan` installs a `types.ModuleType` stub into
the canonical package namespace before each such test runs, giving full control
over every reader `project_payload` calls (`now`, `last_scan_at`,
`SCANNED_HARNESSES`, `read_session_rows`, `window_rows`, `utilization_rows`,
`outcome_metrics`) and decoupling this file's gate from unit A's own timing
and correctness — see the wave-1-B report's Deviations section.
"""

import dataclasses
import sys
import types
from datetime import datetime, timezone
from pathlib import PurePath

from skill_hub.application.usage import usage_footprint
from skill_hub.infrastructure import usage as usage_package
from skill_hub.infrastructure.filesystem import global_docs
from skill_hub.infrastructure.harnesses import harnesses, subagents
from skill_hub.infrastructure.mcp import mcp_probe

# ─────────────────────────────────────────────────────────────────────────────
# compose()
# ─────────────────────────────────────────────────────────────────────────────


def test_compose_groups_the_payload_per_harness():
    registry = {"projects": {"proj": {"path": "/tmp/does-not-exist"}}, "skills": {}}

    result = usage_footprint.compose(
        "proj", registry, resolve_skills=lambda p, r: [], harness_ids={"claude-code"}
    )

    assert result["project"] == "proj"
    assert set(result["harnesses"]) == {"claude-code"}


def test_compose_returns_a_block_for_every_requested_harness_including_a_scanner_less_one():
    """design D5, G9: the static composition is harness-agnostic — a
    scanner-less harness (codex, in wave 1) still gets a full block."""
    registry = {"projects": {"proj": {"path": "/tmp/does-not-exist"}}, "skills": {}}

    result = usage_footprint.compose(
        "proj", registry, resolve_skills=lambda p, r: [], harness_ids={"claude-code", "codex"}
    )

    assert set(result["harnesses"]) == {"claude-code", "codex"}
    for block in result["harnesses"].values():
        assert {"parts", "unknown", "bytes_total", "approx_tokens"} <= set(block)
        assert [p["part"] for p in block["parts"]] == ["skills", "agent_docs", "mcp_schemas"]


def test_skills_part_lists_available_skills_with_harness_relative_paths():
    registry = {
        "projects": {"proj": {"path": "/tmp/does-not-exist"}},
        "skills": {
            "proof-it": {"description": "Proof workflow"},
            "codex-only": {"description": "Codex helper", "harnesses": ["codex"]},
            "global-helper": {"description": "Always on", "scope": "global"},
        },
    }
    resolve_skills = lambda proj_cfg, reg: ["proof-it", "codex-only"]  # noqa: E731

    result = usage_footprint.compose(
        "proj", registry, resolve_skills=resolve_skills, harness_ids={"claude-code"}
    )

    block = result["harnesses"]["claude-code"]
    skills_part = next(p for p in block["parts"] if p["part"] == "skills")
    assert skills_part["label"] == "Skill descriptions (2)"
    assert "proof-it: Proof workflow (.claude/skills/proof-it)" in skills_part["text"]
    assert "global-helper: Always on (~/.claude/skills/global-helper)" in skills_part["text"]
    # `codex-only`'s harness affinity excludes it from a claude-code composition.
    assert "codex-only" not in skills_part["text"]
    assert skills_part["bytes"] == len(skills_part["text"].encode("utf-8"))


def test_agent_docs_part_follows_imports_and_ends_with_the_global_doc(monkeypatch, tmp_path):
    """design D5/D10: the doc chain is the root doc, its imports followed
    transitively, then the harness's own user-global doc — seeded at
    `global_docs.doc_path("claude-code")`, never under the fake
    `HOME/.claude` (`tests/conftest.py`'s `_isolate_harness_agent_state`
    points `SKILL_HUB_CLAUDE_HOME` elsewhere and nulls every harness's
    `global_doc`, so this test restores claude-code's before seeding it)."""
    # R12: `_agent_docs_part` now routes the root filename through
    # `agent_docs.resolve_canonical_root`, which calls `resolve_effective`
    # itself — pin it to match the single-harness `harness_ids` below, since
    # the real `detect_installed()` would see no harness under the isolated
    # fake home.
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})

    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        patched["claude-code"], global_doc=PurePath("~/.claude/CLAUDE.md")
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    global_doc_path = global_docs.doc_path("claude-code")
    assert global_doc_path is not None
    assert global_doc_path == subagents.claude_home() / "CLAUDE.md"
    global_doc_path.parent.mkdir(parents=True, exist_ok=True)
    global_doc_path.write_text("GLOBAL DOC CONTENT\n", encoding="utf-8")

    project_dir = tmp_path / "proj"
    (project_dir / "docs").mkdir(parents=True)
    (project_dir / "CLAUDE.md").write_text("# Root\n- see @docs/a.md\n", encoding="utf-8")
    (project_dir / "docs" / "a.md").write_text(
        "IMPORT A CONTENT\n- also @b.md\n", encoding="utf-8"
    )
    (project_dir / "docs" / "b.md").write_text("IMPORT B CONTENT\n", encoding="utf-8")

    registry = {"projects": {"proj": {"path": str(project_dir)}}, "skills": {}}
    result = usage_footprint.compose(
        "proj", registry, resolve_skills=lambda p, r: [], harness_ids={"claude-code"}
    )

    docs_part = next(
        p for p in result["harnesses"]["claude-code"]["parts"] if p["part"] == "agent_docs"
    )
    text = docs_part["text"]
    assert text.index("# Root") < text.index("IMPORT A CONTENT")
    assert text.index("IMPORT A CONTENT") < text.index("IMPORT B CONTENT")
    assert text.index("IMPORT B CONTENT") < text.index("GLOBAL DOC CONTENT")
    assert docs_part["label"] == "CLAUDE.md + 2 imports"


def test_mcp_schemas_part_delivery_rule_and_never_probed_unknown(tmp_data_home, monkeypatch):
    """design D5, G2: a `scope: global` server reaches only a harness with a
    `global_mcp_config` (claude-code has one, pi does not); every other
    equipped server reaches every harness its own affinity allows. A server
    with no cache row, or no `tool_schemas` in its row, lands in `unknown`
    and contributes nothing to the text.

    `tests/conftest.py`'s `_isolate_global_mcp` autouse fixture nulls every
    harness's `global_mcp_config` by default (so no test can write a real
    `~/.claude.json`); this test restores claude-code's before composing,
    since the delivery rule under test IS that field.
    """
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        patched["claude-code"], global_mcp_config=PurePath("~/.claude.json")
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    mcp_probe.write_probe_cache(
        "known-server",
        {"tool_schemas": [{"name": "toolA", "description": "d", "inputSchema": {"type": "object"}}]},
    )
    mcp_probe.write_probe_cache(
        "shared-mcp",
        {"tool_schemas": [{"name": "toolB", "description": None, "inputSchema": None}]},
    )

    registry = {
        "projects": {"proj": {"path": "/tmp/does-not-exist"}},
        "skills": {
            "known-server": {"type": "mcp-server", "description": "known"},
            "unknown-server": {"type": "mcp-server", "description": "unknown"},
            "shared-mcp": {"type": "mcp-server", "scope": "global", "description": "shared"},
        },
    }
    resolve_skills = lambda p, r: ["known-server", "unknown-server"]  # noqa: E731

    result = usage_footprint.compose(
        "proj", registry, resolve_skills=resolve_skills, harness_ids={"claude-code", "pi"}
    )

    claude = result["harnesses"]["claude-code"]
    claude_mcp = next(p for p in claude["parts"] if p["part"] == "mcp_schemas")
    assert claude_mcp["label"] == "MCP tool schemas (2 servers)"
    assert "toolA" in claude_mcp["text"]
    assert "toolB" in claude_mcp["text"]
    assert claude["unknown"] == [
        {
            "part": "mcp_schemas",
            "label": "unknown-server",
            "reason": "never_probed",
            "hint": "hub mcp check unknown-server",
        }
    ]

    pi_block = result["harnesses"]["pi"]
    pi_mcp = next(p for p in pi_block["parts"] if p["part"] == "mcp_schemas")
    # pi has no `global_mcp_config`, so `shared-mcp` never reaches it.
    assert pi_mcp["label"] == "MCP tool schemas (1 server)"
    assert "toolA" in pi_mcp["text"]
    assert "toolB" not in pi_mcp["text"]
    assert pi_block["unknown"] == claude["unknown"]


# ─────────────────────────────────────────────────────────────────────────────
# detect_findings()
# ─────────────────────────────────────────────────────────────────────────────


def test_idle_finding_fires_at_the_session_floor_and_not_below():
    utilization = [
        {"key": "a", "count": 0, "sessions_with_skill": 5, "idle": True},
        {"key": "b", "count": 3, "sessions_with_skill": 5, "idle": False},
    ]

    below = usage_footprint.detect_findings(
        project="proj", utilization=utilization, outcomes={}, footprint={}, sessions_in_window=4
    )
    assert below == []

    at_floor = usage_footprint.detect_findings(
        project="proj", utilization=utilization, outcomes={}, footprint={}, sessions_in_window=5
    )
    idle = [f for f in at_floor if f["kind"] == "idle"]
    assert len(idle) == 1
    assert idle[0]["numbers"]["skills"] == ["a"]
    assert idle[0]["review"] == {"area": "loadout", "project": "proj", "highlight": ["a"]}


def test_idle_finding_never_fires_for_a_script_invoked_skill():
    """A skill invoked only by script still has `count > 0` (D2's utilization
    schema sums you+model+script into `count`), so it is never idle."""
    utilization = [{"key": "a", "count": 2, "you": 0, "model": 0, "script": 2}]
    findings = usage_footprint.detect_findings(
        project="proj", utilization=utilization, outcomes={}, footprint={}, sessions_in_window=10
    )
    assert [f for f in findings if f["kind"] == "idle"] == []


def test_footprint_part_share_finding_fires_at_threshold_and_not_below():
    footprint_below = {
        "claude-code": {"bytes_total": 1000, "parts": [{"part": "agent_docs", "label": "l", "bytes": 249}]}
    }
    below = usage_footprint.detect_findings(
        project="proj", utilization=[], outcomes={}, footprint=footprint_below, sessions_in_window=0
    )
    assert [f for f in below if f["kind"] == "footprint"] == []

    footprint_at = {
        "claude-code": {"bytes_total": 1000, "parts": [{"part": "agent_docs", "label": "l", "bytes": 250}]}
    }
    at = usage_footprint.detect_findings(
        project="proj", utilization=[], outcomes={}, footprint=footprint_at, sessions_in_window=0
    )
    part_findings = [f for f in at if f["kind"] == "footprint"]
    assert len(part_findings) == 1
    assert part_findings[0]["numbers"]["part"] == "agent_docs"
    assert part_findings[0]["review"]["area"] == "agent_docs"


def test_footprint_skill_share_finding_fires_at_threshold_and_not_below():
    footprint = {"claude-code": {"bytes_total": 1000, "parts": []}}

    below = usage_footprint.detect_findings(
        project="proj",
        utilization=[{"key": "a", "footprint_bytes": 49, "harnesses": ["claude-code"]}],
        outcomes={},
        footprint=footprint,
        sessions_in_window=0,
    )
    assert [f for f in below if f["kind"] == "footprint"] == []

    at = usage_footprint.detect_findings(
        project="proj",
        utilization=[{"key": "a", "footprint_bytes": 50, "harnesses": ["claude-code"]}],
        outcomes={},
        footprint=footprint,
        sessions_in_window=0,
    )
    skill_findings = [f for f in at if f["kind"] == "footprint"]
    assert len(skill_findings) == 1
    assert skill_findings[0]["numbers"]["skill"] == "a"
    assert skill_findings[0]["review"] == {"area": "loadout", "project": "proj", "highlight": ["a"]}


def test_footprint_skill_share_denominator_sums_bytes_total_across_scanned_harnesses():
    """R20: `footprint_bytes` is already summed across every scanned harness
    (`_enrich_utilization_with_footprint`), so the share denominator must sum
    the SAME harnesses' `bytes_total` too — dividing by one harness's
    `bytes_total` at a time (and firing once per harness) inflated the share
    and double-counted the finding the moment two harnesses were scanned."""
    footprint = {
        "claude-code": {"bytes_total": 1000, "parts": []},
        "codex": {"bytes_total": 1000, "parts": []},
    }
    utilization = [{"key": "a", "footprint_bytes": 100, "harnesses": ["claude-code", "codex"]}]

    findings = usage_footprint.detect_findings(
        project="proj",
        utilization=utilization,
        outcomes={},
        footprint=footprint,
        sessions_in_window=0,
    )

    skill_findings = [f for f in findings if f["kind"] == "footprint"]
    assert len(skill_findings) == 1  # not two — one per skill, not one per harness
    assert skill_findings[0]["numbers"]["share"] == 0.05  # 100 / (1000 + 1000), not 100 / 1000
    assert skill_findings[0]["numbers"]["harnesses"] == ["claude-code", "codex"]
    assert skill_findings[0]["numbers"]["bytes_total"] == 2000


def test_verification_finding_needs_the_three_session_floor_and_an_unverified_edit():
    below_floor = usage_footprint.detect_findings(
        project="proj",
        utilization=[],
        outcomes={"editing_sessions": 2, "unverified_editing_sessions": 1},
        footprint={},
        sessions_in_window=0,
    )
    assert [f for f in below_floor if f["kind"] == "verification"] == []

    at_floor = usage_footprint.detect_findings(
        project="proj",
        utilization=[],
        outcomes={"editing_sessions": 3, "unverified_editing_sessions": 1},
        footprint={},
        sessions_in_window=0,
    )
    verification = [f for f in at_floor if f["kind"] == "verification"]
    assert len(verification) == 1
    assert verification[0]["numbers"]["min_sessions"] == 3
    assert verification[0]["review"]["area"] == "agent_docs"
    assert verification[0]["review"]["also"] == ["loadout"]

    no_unverified = usage_footprint.detect_findings(
        project="proj",
        utilization=[],
        outcomes={"editing_sessions": 5, "unverified_editing_sessions": 0},
        footprint={},
        sessions_in_window=0,
    )
    assert [f for f in no_unverified if f["kind"] == "verification"] == []


def test_idle_finding_includes_bytes_per_skill_from_utilization():
    findings = usage_footprint.detect_findings(
        project="proj",
        utilization=[{"key": "a", "count": 0, "idle": True, "footprint_bytes": 123}],
        outcomes={},
        footprint={},
        sessions_in_window=5,
    )
    assert findings[0]["numbers"]["bytes_per_skill"] == {"a": 123}


# ─────────────────────────────────────────────────────────────────────────────
# project_payload() / findings_payload() — against a fake `usage_scan`
# ─────────────────────────────────────────────────────────────────────────────


def _install_fake_usage_scan(monkeypatch, **overrides):
    fake = types.ModuleType("skill_hub.infrastructure.usage.usage_scan")
    fake.SCANNED_HARNESSES = overrides.get("scanned_harnesses", ("claude-code",))
    fake.now = overrides.get("now", lambda: datetime(2026, 9, 7, tzinfo=timezone.utc))
    fake.last_scan_at = overrides.get("last_scan_at", lambda: "2026-09-07T00:00:00Z")
    fake.read_session_rows = overrides.get("read_session_rows", lambda path=None: ([], []))
    fake.window_rows = overrides.get(
        "window_rows", lambda all_rows, project, window_days, now: []
    )
    fake.utilization_rows = overrides.get(
        "utilization_rows", lambda rows, registry, equipped, window_days, now, loadout_rows=None: []
    )
    fake.outcome_metrics = overrides.get("outcome_metrics", lambda rows, all_rows: {})
    monkeypatch.setitem(sys.modules, "skill_hub.infrastructure.usage.usage_scan", fake)
    monkeypatch.setattr(usage_package, "usage_scan", fake, raising=False)
    return fake


def test_project_payload_utilization_rows_carry_footprint_enrichment(monkeypatch):
    """Fix round: `usage_scan.utilization_rows` cannot know a skill's
    footprint bytes — `project_payload` enriches every row with
    `footprint_bytes` (summed over the scanned harnesses' `skills` line for
    that skill) and `harnesses` (the sorted effective harnesses whose
    composition includes it) before it ever reaches `detect_findings` or the
    returned payload."""
    registry = {
        "projects": {"proj": {"path": "/tmp/does-not-exist"}},
        "skills": {"solo-skill": {"description": "A single skill."}},
    }
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})

    def utilization_rows(rows, reg, equipped, window_days, now, loadout_rows=None):
        return [{"key": name, "count": 3} for name in equipped]

    _install_fake_usage_scan(monkeypatch, utilization_rows=utilization_rows)
    resolve_skills = lambda proj_cfg, reg: ["solo-skill"]  # noqa: E731

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=resolve_skills, window_days=30
    )

    row = next(r for r in payload["utilization"] if r["key"] == "solo-skill")
    assert row["count"] == 3  # the original field survives the enrichment
    assert row["harnesses"] == ["claude-code"]
    expected_line = usage_footprint._format_skill_line(
        "solo-skill", {"description": "A single skill."}, ".claude/skills/solo-skill"
    )
    assert row["footprint_bytes"] == len(expected_line.encode("utf-8"))
    assert row["footprint_bytes"] > 0


def test_project_payload_utilization_row_for_an_undelivered_skill_is_empty(monkeypatch):
    """A skill equipped on the project but excluded from every effective
    harness's composition (here, by harness affinity) gets `harnesses: []`
    and `footprint_bytes: 0` — never a crash or a missing key."""
    registry = {
        "projects": {"proj": {"path": "/tmp/does-not-exist"}},
        "skills": {
            "codex-only-skill": {"description": "Only for codex", "harnesses": ["codex"]}
        },
    }
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})

    def utilization_rows(rows, reg, equipped, window_days, now, loadout_rows=None):
        return [{"key": name, "count": 2} for name in equipped]

    _install_fake_usage_scan(monkeypatch, utilization_rows=utilization_rows)
    resolve_skills = lambda proj_cfg, reg: ["codex-only-skill"]  # noqa: E731

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=resolve_skills, window_days=30
    )

    row = next(r for r in payload["utilization"] if r["key"] == "codex-only-skill")
    assert row["harnesses"] == []
    assert row["footprint_bytes"] == 0


def test_project_payload_per_skill_footprint_finding_fires_through_the_real_payload(monkeypatch):
    """Integration proof: with the enrichment wired in, a skill whose own
    description line dominates a harness's `skills` part produces the
    per-skill footprint finding end to end through `project_payload` (not
    just against a literal `detect_findings` call)."""
    registry = {
        "projects": {"proj": {"path": "/tmp/does-not-exist"}},
        "skills": {
            "small-skill": {"description": "x"},
            "big-skill": {"description": "y" * 400},
        },
    }
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})

    def utilization_rows(rows, reg, equipped, window_days, now, loadout_rows=None):
        return [{"key": name, "count": 1} for name in equipped]

    _install_fake_usage_scan(monkeypatch, utilization_rows=utilization_rows)
    resolve_skills = lambda proj_cfg, reg: ["small-skill", "big-skill"]  # noqa: E731

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=resolve_skills, window_days=30
    )

    skill_findings = [
        f
        for f in payload["findings"]
        if f["kind"] == "footprint" and f["numbers"].get("skill") == "big-skill"
    ]
    assert len(skill_findings) == 1
    assert skill_findings[0]["numbers"]["share"] >= usage_footprint.FOOTPRINT_SKILL_SHARE


def test_project_payload_codex_only_project_matches_the_d7_shape(monkeypatch):
    registry = {
        "projects": {"proj": {"path": "/tmp/does-not-exist", "harnesses": ["codex"]}},
        "skills": {},
    }
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"codex"})
    _install_fake_usage_scan(monkeypatch, scanned_harnesses=("codex",))

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=lambda p, r: [], window_days=30
    )

    assert payload["ok"] is True
    assert payload["harnesses"] == ["codex"]
    assert payload["footprint"]["codex"]["observed"] is None
    assert payload["utilization"] == []
    assert payload["sessions"] == []
    assert payload["findings"] == []
    assert payload["not_analysed"] == []


def test_project_payload_empty_window_returns_observed_null(monkeypatch):
    registry = {"projects": {"proj": {"path": "/tmp/does-not-exist"}}, "skills": {}}
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})
    _install_fake_usage_scan(monkeypatch)  # default window_rows() -> []

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=lambda p, r: [], window_days=30
    )

    assert payload["footprint"]["claude-code"]["observed"] is None


def test_project_payload_computes_the_observed_footprint_as_a_median(monkeypatch):
    registry = {"projects": {"proj": {"path": "/tmp/does-not-exist"}}, "skills": {}}
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})
    rows = [
        {"harness": "claude-code", "first_turn_input_total": 100},
        {"harness": "claude-code", "first_turn_input_total": 300},
        {"harness": "claude-code", "first_turn_input_total": 200},
    ]
    _install_fake_usage_scan(
        monkeypatch,
        window_rows=lambda all_rows, project, window_days, now: rows,
        read_session_rows=lambda path=None: (rows, []),
    )

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=lambda p, r: [], window_days=30
    )

    assert payload["footprint"]["claude-code"]["observed"] == 200


def test_project_payload_sessions_project_nullable_last_activity_at(tmp_data_home, monkeypatch):
    """Session rows expose the ledger activity timestamp when available."""
    registry = {"projects": {"proj": {"path": "/tmp/does-not-exist"}}, "skills": {}}
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})
    rows = [
        {
            "harness": "claude-code",
            "session_id": "active",
            "parent_session_id": "parent",
            "started_at": "2026-09-07T10:00:00Z",
            "last_activity_at": "2026-09-07T10:05:00Z",
        },
        {
            "harness": "claude-code",
            "session_id": "undated",
            "started_at": "2026-09-07T11:00:00Z",
            "last_activity_at": None,
        },
    ]
    _install_fake_usage_scan(
        monkeypatch,
        read_session_rows=lambda path=None: (rows, []),
        window_rows=lambda all_rows, project, window_days, now: rows,
    )

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=lambda p, r: [], window_days=30
    )

    sessions = {row["session_id"]: row for row in payload["sessions"]}
    assert sessions["active"]["parent_session_id"] == "parent"
    assert sessions["active"]["last_activity_at"] == "2026-09-07T10:05:00Z"
    assert sessions["undated"]["last_activity_at"] is None


def test_project_payload_findings_window_is_fixed_regardless_of_the_requested_window(monkeypatch):
    """design D9: findings are always evaluated at 30 days, independent of
    `--window`."""
    registry = {"projects": {"proj": {"path": "/tmp/does-not-exist"}}, "skills": {}}
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})
    seen_window_days = []

    def window_rows(all_rows, project, window_days, now):
        seen_window_days.append(window_days)
        return []

    _install_fake_usage_scan(monkeypatch, window_rows=window_rows)

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=lambda p, r: [], window_days=90
    )

    assert payload["window"] == 90
    assert payload["findings_window"] == 30
    assert sorted(seen_window_days) == [30, 90]


def test_project_payload_passes_outcomes_through_unmodified(monkeypatch):
    """`usage_scan.outcome_metrics` owns the ratio/omission logic (a
    non-git project still reports `files_read_median` while omitting the
    ratio); `project_payload` only passes the dict through."""
    registry = {"projects": {"proj": {"path": "/tmp/does-not-exist"}}, "skills": {}}
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})
    fixed_outcomes = {"files_read_median": 74, "tracked_files": None}
    _install_fake_usage_scan(monkeypatch, outcome_metrics=lambda rows, all_rows: fixed_outcomes)

    payload = usage_footprint.project_payload(
        "proj", registry, resolve_skills=lambda p, r: [], window_days=30
    )

    assert payload["outcomes"] == fixed_outcomes


def test_findings_payload_aggregates_across_projects_and_narrows_by_project(monkeypatch):
    registry = {
        "projects": {"proj-a": {"path": "/tmp/a"}, "proj-b": {"path": "/tmp/b"}},
        "skills": {},
    }
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})

    def utilization_rows(rows, reg, equipped, window_days, now, loadout_rows=None):
            return [{"key": "idle-skill", "count": 0, "sessions_with_skill": 5, "idle": True}]

    _install_fake_usage_scan(
        monkeypatch,
        window_rows=lambda all_rows, project, window_days, now: [{}] * 5,
        utilization_rows=utilization_rows,
    )
    # No equipped skills, so `compose`'s own parts stay empty (0 bytes) and
    # no footprint finding can piggyback on the idle utilization row above.
    resolve_skills = lambda proj_cfg, reg: []  # noqa: E731

    all_findings = usage_footprint.findings_payload(registry, resolve_skills=resolve_skills)
    assert all_findings["window"] == 30
    assert all_findings["findings_window"] == 30
    assert len(all_findings["findings"]) == 2
    assert {f["project"] for f in all_findings["findings"]} == {"proj-a", "proj-b"}
    assert all_findings["analysed_sessions"] == []

    narrowed = usage_footprint.findings_payload(
        registry, resolve_skills=resolve_skills, project="proj-a"
    )
    assert [f["project"] for f in narrowed["findings"]] == ["proj-a"]


def test_findings_payload_analysed_sessions_includes_unregistered_rows(monkeypatch):
    registry = {"projects": {"proj-a": {"path": "/tmp/a"}}, "skills": {}}
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code"})
    rows = [
        {"harness": "claude-code", "session_id": "a", "project": "proj-a"},
        {"harness": "codex", "session_id": "b", "project": "unregistered"},
    ]
    _install_fake_usage_scan(monkeypatch, read_session_rows=lambda path=None: (rows, []))
    result = usage_footprint.findings_payload(registry, resolve_skills=lambda p, r: [])
    assert result["analysed_sessions"] == ["claude-code:a", "codex:b"]
    result = usage_footprint.findings_payload(
        registry, resolve_skills=lambda p, r: [], project="proj-a"
    )
    assert result["analysed_sessions"] == ["claude-code:a"]


def test_findings_payload_an_unknown_project_reports_not_found(monkeypatch):
    """R9: an explicit, unknown `project` must not read as "clean" — it is
    the one read of the five that could otherwise be confused with an
    all-clear (`ok: true, findings: []`). It carries the same top-level
    key set as a normal read, `ok: false` and `reason: "not_found"`."""
    registry = {"projects": {"proj-a": {"path": "/tmp/a"}}, "skills": {}}
    _install_fake_usage_scan(monkeypatch)

    payload = usage_footprint.findings_payload(
        registry, resolve_skills=lambda p, r: [], project="does-not-exist"
    )

    assert payload == {
        "ok": False,
        "reason": "not_found",
        "window": 30,
        "findings_window": 30,
        "last_scan_at": "2026-09-07T00:00:00Z",
        "findings": [],
    }


def test_agent_docs_part_resolves_through_canonical_root_for_multi_harness_projects(
    monkeypatch, tmp_path
):
    """R12: `_agent_docs_part` routes the root filename through
    `agent_docs.resolve_canonical_root` (design D5) instead of guessing a
    bare per-harness filename. A multi-harness project has a real
    `AGENTS.md` and a derived `CLAUDE.md` symlink pointing at it (the
    `root_strategy: symlink` shape `hub agent-docs fix` produces); both
    harnesses' compositions read the shared content exactly once each —
    never twice within either harness's own chain."""
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"claude-code", "pi"})

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "AGENTS.md").write_text("SHARED ROOT CONTENT\n", encoding="utf-8")
    (project_dir / "CLAUDE.md").symlink_to(project_dir / "AGENTS.md")

    registry = {"projects": {"proj": {"path": str(project_dir)}}, "skills": {}}
    result = usage_footprint.compose(
        "proj", registry, resolve_skills=lambda p, r: [], harness_ids={"claude-code", "pi"}
    )

    claude_docs = next(
        p for p in result["harnesses"]["claude-code"]["parts"] if p["part"] == "agent_docs"
    )
    pi_docs = next(p for p in result["harnesses"]["pi"]["parts"] if p["part"] == "agent_docs")

    assert claude_docs["text"].count("SHARED ROOT CONTENT") == 1
    assert pi_docs["text"].count("SHARED ROOT CONTENT") == 1
    assert claude_docs["label"] == "CLAUDE.md + 0 imports"
    assert pi_docs["label"] == "AGENTS.md + 0 imports"


def test_f6_orphan_codex_children_are_excluded_from_project_and_baseline_aggregates(monkeypatch):
    registry = {"projects": {"proj": {"path": "/tmp/proj"}}, "skills": {}}
    parent = {"harness": "codex", "session_id": "p", "project": "proj", "parent_session_id": None,
              "tokens": {"total": 10}, "activity": {}, "skills": []}
    child = {"harness": "codex", "session_id": "c", "project": "proj", "parent_session_id": "missing",
             "tokens": {"total": 90}, "activity": {}, "skills": []}

    def run(rows):
        def utilization(selected, *args):
            return [{"key": "x", "count": sum(r["tokens"]["total"] for r in selected)}]

        def outcomes(selected, all_rows):
            return {"sessions": len(selected), "median_all_projects": {"activity": {}}}

        _install_fake_usage_scan(
            monkeypatch,
            read_session_rows=lambda path=None: (rows, []),
            window_rows=lambda all_rows, project, window_days, now: rows,
            utilization_rows=utilization,
            outcome_metrics=outcomes,
        )
        return usage_footprint.project_payload("proj", registry, resolve_skills=lambda p, r: [], window_days=30)

    orphan = run([child])
    linked = run([parent, child])
    assert orphan["utilization"] == [] or orphan["utilization"][0]["count"] == 0
    assert linked["utilization"][0]["count"] == 10
    assert orphan["outcomes"]["sessions"] == 0
    assert linked["outcomes"]["sessions"] == 1


def test_agent_docs_part_a_pi_only_project_resolves_to_agents_md(monkeypatch, tmp_path):
    """R12: a project effective on a single non-claude harness has a
    canonical root of `AGENTS.md` with no derived twin (`derived: None`);
    `_resolve_harness_root_name` must match pi's `root_doc` against
    `resolve_canonical_root`'s `canonical`, not `derived`."""
    monkeypatch.setattr(harnesses, "resolve_effective", lambda *a, **k: {"pi"})

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "AGENTS.md").write_text("PI ROOT CONTENT\n", encoding="utf-8")

    registry = {"projects": {"proj": {"path": str(project_dir)}}, "skills": {}}
    result = usage_footprint.compose(
        "proj", registry, resolve_skills=lambda p, r: [], harness_ids={"pi"}
    )

    pi_docs = next(p for p in result["harnesses"]["pi"]["parts"] if p["part"] == "agent_docs")
    assert "PI ROOT CONTENT" in pi_docs["text"]
    assert pi_docs["label"] == "AGENTS.md + 0 imports"
