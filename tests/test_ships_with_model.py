"""Tests for ships_with.py — the `ships_with:` frontmatter model leaf (W1 of
the ships-with orchestration workspace, milestone 5, plan 1).

Fixture: an inline minimal skill mirroring plan 3's verbatim `ships_with`
block (plans/0-direction.md D1 + A8) — two agents, one hook whose command is
a script inside the skill dir, and a `deny`/`ask` permission pair. The real
`orchestrate-advanced` fixture (tests/fixtures/ships_with/orchestrate-advanced/)
is authored by a parallel unit; this file never reads it.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from skill_hub import hub_core
from skill_hub.domain.skills import ships_with, skill_meta
from skill_hub.infrastructure.harnesses import harness_probe

CODEX_PROJECT_HOOK_REASON = (
    "Codex receives only globally-attached hooks in v1; "
    "project-attached hooks are not written to config.toml"
)

AGENT_IMPLEMENTER_MD = """\
---
name: orch-implementer
description: Implements one chunk of the plan.
tier: worker
tools: [Read, Edit, Write, Bash, Grep, Glob]
---
You implement one chunk at a time.
"""

AGENT_REVIEWER_MD = """\
---
name: orch-reviewer
description: Reviews one chunk of the plan.
tier: planner
tools: [Read, Grep, Glob]
---
You review one chunk at a time.
"""

SHIPS_WITH_BLOCK = """\
ships_with:
  agents: [orch-implementer, orch-reviewer]
  hooks:
    - name: orch-scope-guard
      event: PreToolUse
      tools: [Edit, Write, MultiEdit]
      command: scripts/scope-guard.sh
      activation: while-running
      harnesses: [claude-code, codex]
  permissions:
    deny: ["Bash(git push --force:*)"]
    ask: ["Bash(gh pr merge:*)"]
"""


def _skill_md(ships_with_yaml: str = SHIPS_WITH_BLOCK) -> str:
    return (
        "---\n"
        "name: orchestrate-advanced\n"
        "description: Deep orchestrator with a chunk contract and two runners.\n"
        f"{ships_with_yaml}"
        "---\n"
        "Body.\n"
    )


@pytest.fixture
def skill_dir(tmp_path) -> Path:
    d = tmp_path / "orchestrate-advanced"
    (d / "agents").mkdir(parents=True)
    (d / "scripts").mkdir(parents=True)
    (d / "agents" / "orch-implementer.md").write_text(AGENT_IMPLEMENTER_MD)
    (d / "agents" / "orch-reviewer.md").write_text(AGENT_REVIEWER_MD)
    (d / "scripts" / "scope-guard.sh").write_text("#!/bin/sh\nexit 0\n")
    (d / "SKILL.md").write_text(_skill_md())
    return d


@pytest.fixture
def registry(skill_dir, tmp_path) -> dict:
    project_path = tmp_path / "proj"
    project_path.mkdir()
    return {
        "skills": {
            "orchestrate-advanced": {"type": "claude-skill", "source": str(skill_dir)}
        },
        "projects": {
            "notes-vault": {
                "path": str(project_path),
                "harnesses": [],
                "enabled": [],
            }
        },
        "harnesses_global": ["claude-code", "codex", "pi", "opencode"],
    }


D1_SHAPE = {
    "agents": ["orch-implementer", "orch-reviewer"],
    "hooks": [
        {
            "name": "orch-scope-guard",
            "event": "PreToolUse",
            "command": "scripts/scope-guard.sh",
            "activation": "while-running",
            "tools": ["Edit", "Write", "MultiEdit"],
            "harnesses": ["claude-code", "codex"],
        }
    ],
    "permissions": {
        "deny": ["Bash(git push --force:*)"],
        "ask": ["Bash(gh pr merge:*)"],
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# 1. Mirror: D1 shape verbatim, idempotent, removal deletes the key (A6)
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_mirrors_ships_with_in_d1_shape(registry, skill_dir):
    changed = skill_meta.sync_skill_frontmatter_metadata(registry)
    assert changed is True
    cfg = registry["skills"]["orchestrate-advanced"]
    assert cfg["ships_with"] == D1_SHAPE
    # permissions are bare pattern strings, not {pattern, kind} dicts.
    assert cfg["ships_with"]["permissions"]["deny"] == ["Bash(git push --force:*)"]

    # Idempotent: a second sync with nothing changed reports no mutation.
    changed_again = skill_meta.sync_skill_frontmatter_metadata(registry)
    assert changed_again is False
    assert registry["skills"]["orchestrate-advanced"]["ships_with"] == D1_SHAPE

    # Removing the frontmatter block deletes the registry mirror.
    (skill_dir / "SKILL.md").write_text(_skill_md(""))
    changed_removed = skill_meta.sync_skill_frontmatter_metadata(registry)
    assert changed_removed is True
    assert "ships_with" not in registry["skills"]["orchestrate-advanced"]


# ─────────────────────────────────────────────────────────────────────────────
# 2. Hook command escape rejection
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_command_outside_skill_dir_is_rejected(tmp_path):
    skill_dir = tmp_path / "skill"
    skill_dir.mkdir()
    warnings: list[str] = []

    def _raw(command: str) -> dict:
        return {
            "hooks": [
                {
                    "name": "guard",
                    "event": "PreToolUse",
                    "command": command,
                    "activation": "always",
                }
            ]
        }

    # `..` traversal.
    assert ships_with.normalize_block(_raw("../escape.sh"), skill_dir, warn=warnings.append) is None
    assert warnings

    # Absolute path.
    warnings.clear()
    assert ships_with.normalize_block(_raw("/etc/passwd"), skill_dir, warn=warnings.append) is None
    assert warnings

    # Escaping symlink: a dir inside the skill that resolves outside it.
    warnings.clear()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "evil.sh").write_text("#!/bin/sh\necho hi\n")
    (skill_dir / "escape_link").symlink_to(outside, target_is_directory=True)
    result = ships_with.normalize_block(_raw("escape_link/evil.sh"), skill_dir, warn=warnings.append)
    assert result is None
    assert warnings


# ─────────────────────────────────────────────────────────────────────────────
# 3. Invalid event / activation / missing agent file
# ─────────────────────────────────────────────────────────────────────────────


def test_invalid_event_activation_and_missing_agent_file_rejected(tmp_path):
    skill_dir = tmp_path / "skill"
    (skill_dir / "scripts").mkdir(parents=True)
    (skill_dir / "scripts" / "guard.sh").write_text("#!/bin/sh\nexit 0\n")

    def _hook(**overrides) -> dict:
        base = {
            "name": "guard",
            "event": "PreToolUse",
            "command": "scripts/guard.sh",
            "activation": "always",
        }
        base.update(overrides)
        return {"hooks": [base]}

    warnings: list[str] = []
    assert ships_with.normalize_block(_hook(event="NotARealEvent"), skill_dir, warn=warnings.append) is None
    assert warnings

    # `project` was the pre-A1 activation vocabulary — now invalid.
    warnings.clear()
    assert ships_with.normalize_block(_hook(activation="project"), skill_dir, warn=warnings.append) is None
    assert warnings

    warnings.clear()
    assert ships_with.normalize_block(
        {"agents": ["no-such-agent"]}, skill_dir, warn=warnings.append
    ) is None
    assert warnings


# ─────────────────────────────────────────────────────────────────────────────
# 4. render_agent_payload — tier→model per harness (A10)
# ─────────────────────────────────────────────────────────────────────────────


def test_render_agent_payload_maps_tier_per_harness(registry):
    # orch-implementer is tier=worker.
    claude_payload = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-implementer", "claude-code", registry
    )
    assert claude_payload["original_name"] is None
    assert claude_payload["scope"] == "user"
    assert claude_payload["safe"]["model"] == "sonnet"
    assert claude_payload["safe"]["effort"] == "medium"
    assert claude_payload["safe"]["tools"] == ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]
    assert claude_payload["warnings"] == []

    codex_payload = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-implementer", "codex", registry
    )
    assert codex_payload["original_name"] is None
    assert codex_payload["safe"]["model"] == "gpt-6-luna"
    assert codex_payload["safe"]["model_reasoning_effort"] == "high"  # worker tier
    assert "tools" not in codex_payload["safe"]
    assert any(w["field"] == "tools" for w in codex_payload["warnings"])

    # orch-reviewer is tier=planner — codex gets the planner-tier model.
    reviewer_codex = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-reviewer", "codex", registry
    )
    assert reviewer_codex["safe"]["model"] == "gpt-6-sol"
    assert reviewer_codex["safe"]["model_reasoning_effort"] == "medium"

    reviewer_claude = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-reviewer", "claude-code", registry
    )
    assert reviewer_claude["safe"]["model"] == "opus"
    assert reviewer_claude["safe"]["effort"] == "medium"


def test_render_agent_payload_utility_and_deep_tiers_both_harnesses(registry, skill_dir):
    (skill_dir / "agents" / "orch-utility.md").write_text(
        "---\nname: orch-utility\ndescription: A cheap scan.\ntier: utility\n---\nScan only.\n"
    )
    (skill_dir / "agents" / "orch-deep.md").write_text(
        "---\nname: orch-deep\ndescription: A hard review.\ntier: deep\n---\nReview deeply.\n"
    )

    utility_claude = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-utility", "claude-code", registry
    )
    assert utility_claude["safe"]["model"] == "haiku"
    assert utility_claude["safe"]["effort"] == "medium"

    utility_codex = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-utility", "codex", registry
    )
    assert utility_codex["safe"]["model"] == "gpt-6-luna"
    assert utility_codex["safe"]["model_reasoning_effort"] == "low"

    deep_claude = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-deep", "claude-code", registry
    )
    assert deep_claude["safe"]["model"] == "fable"
    assert deep_claude["safe"]["effort"] == "high"

    deep_codex = ships_with.render_agent_payload(
        "orchestrate-advanced", "orch-deep", "codex", registry
    )
    assert deep_codex["safe"]["model"] == "gpt-6-astra"
    assert deep_codex["safe"]["model_reasoning_effort"] == "medium"


# ─────────────────────────────────────────────────────────────────────────────
# 5. plan_provision — Codex project-scope hook is unsupported (A3/C2)
# ─────────────────────────────────────────────────────────────────────────────


def test_plan_codex_project_hook_is_unsupported(registry):
    result = ships_with.plan_provision(
        "orchestrate-advanced",
        "notes-vault",
        registry,
        installed={"codex"},
        capabilities={"codex": {"verdict": "supported", "reason": ""}},
    )
    hook_items = [i for i in result["items"] if i["kind"] == "hook" and i["harness"] == "codex"]
    assert len(hook_items) == 1
    item = hook_items[0]
    assert item["verdict"] == "unsupported"
    assert item["reason"] == CODEX_PROJECT_HOOK_REASON
    assert item["target"] == "<repo>"


# ─────────────────────────────────────────────────────────────────────────────
# 6. plan_provision — pi/opencode agent rows never call agents_dir (A3)
# ─────────────────────────────────────────────────────────────────────────────


def test_plan_agent_row_for_pi_and_opencode_never_raises(registry, monkeypatch):
    from skill_hub.infrastructure.harnesses import subagents

    def _boom(*_a, **_k):
        raise AssertionError("agents_dir must never be called for pi/opencode")

    monkeypatch.setattr(subagents, "agents_dir", _boom)
    monkeypatch.setattr(subagents, "_find_agent_file", _boom)

    result = ships_with.plan_provision(
        "orchestrate-advanced",
        "notes-vault",
        registry,
        installed={"pi", "opencode"},
        capabilities={
            "pi": {"verdict": "unsupported", "reason": "pi unsupported in v1"},
            "opencode": {"verdict": "unsupported", "reason": "opencode unsupported in v1"},
        },
    )
    agent_items = [i for i in result["items"] if i["kind"] == "agent"]
    assert agent_items
    for item in agent_items:
        assert item["harness"] in ("pi", "opencode")
        assert item["verdict"] == "unsupported"
        assert item["reason"] == "no sub-agent definitions"
        assert item["target"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 7. plan_provision — trust row present only when untrusted (A2/C7)
# ─────────────────────────────────────────────────────────────────────────────


def test_plan_emits_trust_row_only_when_untrusted(registry, _fake_home):
    result = ships_with.plan_provision(
        "orchestrate-advanced",
        "notes-vault",
        registry,
        installed={"codex"},
        capabilities={"codex": {"verdict": "supported", "reason": ""}},
    )
    trust_items = [i for i in result["items"] if i["kind"] == "trust"]
    assert len(trust_items) == 1
    assert trust_items[0]["harness"] == "codex"
    assert trust_items[0]["verdict"] == "will_write"
    # At least one codex permission row is will_write (the deny rule).
    codex_perm_items = [
        i for i in result["items"] if i["kind"] == "permission" and i["harness"] == "codex"
    ]
    assert any(i["verdict"] == "will_write" for i in codex_perm_items)

    # Mark the project trusted directly in Codex's (fake) config.toml.
    resolved_path = str(hub_core.expand(registry["projects"]["notes-vault"]["path"]))
    codex_home = Path(os.environ["HOME"]) / ".codex"
    codex_home.mkdir(parents=True, exist_ok=True)
    (codex_home / "config.toml").write_text(
        f'[projects."{resolved_path}"]\ntrust_level = "trusted"\n'
    )

    result2 = ships_with.plan_provision(
        "orchestrate-advanced",
        "notes-vault",
        registry,
        installed={"codex"},
        capabilities={"codex": {"verdict": "supported", "reason": ""}},
    )
    trust_items2 = [i for i in result2["items"] if i["kind"] == "trust"]
    assert trust_items2 == []


def test_plan_does_not_request_codex_trust_for_unrepresentable_rules(
    registry, skill_dir, tmp_data_home, monkeypatch
):
    from types import SimpleNamespace

    from skill_hub.entrypoints.cli import skill as skill_cli
    from skill_hub.infrastructure.harnesses import harnesses

    skill_dir.joinpath("SKILL.md").write_text(
        _skill_md(
            "ships_with:\n"
            "  permissions:\n"
            "    allow: [Read, 'Bash(*)']\n"
        )
    )
    registry["harnesses_global"] = ["codex"]
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"codex"})
    args = SimpleNamespace()
    operation_context = skill_cli._skill_operation_context(args)
    assert args._operation_context is operation_context
    assert operation_context.installed_harness_ids == ("codex",)
    result = ships_with.plan_provision(
        "orchestrate-advanced",
        "notes-vault",
        registry,
        operation_context=operation_context,
    )
    permission_items = [
        item for item in result["items"] if item["kind"] == "permission"
    ]
    assert permission_items
    assert all(item["verdict"] == "unsupported" for item in permission_items)
    assert [item for item in result["items"] if item["kind"] == "trust"] == []


# ─────────────────────────────────────────────────────────────────────────────
# 8. plan_provision — capability cache used, probe only on a miss (S5)
# ─────────────────────────────────────────────────────────────────────────────


def test_plan_uses_capability_cache_and_probes_only_on_miss(registry, tmp_data_home, monkeypatch):
    cache_results = {
        hid: harness_probe.HookCapability(harness_id=hid, verdict="supported", reason="ok")
        for hid in ("claude-code", "codex")
    }
    harness_probe.save_cache(cache_results, tmp_data_home)

    def _boom(*_a, **_k):
        raise AssertionError("probe_harness must not be called on a cache hit")

    monkeypatch.setattr(harness_probe, "probe_harness", _boom)

    result = ships_with.plan_provision(
        "orchestrate-advanced",
        "notes-vault",
        registry,
        installed={"claude-code", "codex"},
        # capabilities left as default → must read the on-disk cache.
    )
    assert result["items"]
    hook_items = [i for i in result["items"] if i["kind"] == "hook"]
    assert any(i["harness"] == "claude-code" for i in hook_items)


# ─────────────────────────────────────────────────────────────────────────────
# 9 (review milestone 6, W-3). plan_provision — hook verdict intersects the
# harness EVENT CATALOGUE, not just the probe verdict (A3)
# ─────────────────────────────────────────────────────────────────────────────


def test_plan_hook_event_unsupported_by_harness_is_unsupported(tmp_path):
    skill_dir = tmp_path / "skill"
    (skill_dir / "scripts").mkdir(parents=True)
    (skill_dir / "scripts" / "guard.sh").write_text("#!/bin/sh\nexit 0\n")
    skill_md = (
        "---\n"
        "name: skill\n"
        "description: x\n"
        "ships_with:\n"
        "  hooks:\n"
        "    - name: session-end-guard\n"
        "      event: SessionEnd\n"
        "      command: scripts/guard.sh\n"
        "      activation: always\n"
        "      harnesses: [codex]\n"
        "---\n"
        "Body.\n"
    )
    (skill_dir / "SKILL.md").write_text(skill_md)

    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    registry = {
        "skills": {"skill": {"type": "claude-skill", "source": str(skill_dir)}},
        "projects": {"p": {"path": str(proj_path), "harnesses": [], "enabled": []}},
        "harnesses_global": ["codex"],
    }

    result = ships_with.plan_provision(
        "skill",
        None,  # project=None: isolates the event-catalogue check from the
               # separate "codex project-scope hook" unsupported branch (A3).
        registry,
        installed={"codex"},
        # The (fake) probe says "supported" — codex's event catalogue having
        # no SessionEnd (tool_catalog._CODEX_EVENTS) must win regardless.
        capabilities={"codex": {"verdict": "supported", "reason": ""}},
    )
    hook_items = [i for i in result["items"] if i["kind"] == "hook"]
    assert len(hook_items) == 1
    assert hook_items[0]["verdict"] == "unsupported"
    assert "SessionEnd" in hook_items[0]["reason"]


# ─────────────────────────────────────────────────────────────────────────────
# 10 (review milestone 6, W-4). A project-less plan never names a GLOBAL
# file as a hook/permission write target
# ─────────────────────────────────────────────────────────────────────────────


def test_plan_without_project_never_names_a_global_target(registry):
    result = ships_with.plan_provision(
        "orchestrate-advanced",
        None,
        registry,
        installed={"claude-code", "codex"},
        capabilities={
            "claude-code": {"verdict": "supported", "reason": ""},
            "codex": {"verdict": "supported", "reason": ""},
        },
    )
    assert result["items"]
    for item in result["items"]:
        if item["kind"] in ("hook", "permission"):
            assert item["target"] is None, item
        elif item["kind"] == "agent":
            assert item["target"]  # agents are always user-scope — a real path
