"""Tests for `ships_with_reconcile.py` — the sync-time reconcile pass for
`ships_with` companions (wave 1 of the `ships-with-2` orchestration
workspace, plan 1).

Every test sandboxes through `tests/conftest.py`'s autouse `_fake_home` (never
the real `~/.claude`/`~/.codex`); tests that touch agent files also take
`tmp_data_home` for an isolated backup dir.
"""

from __future__ import annotations

import copy
import re
from pathlib import Path

import yaml

import skill_hub.entrypoints.cli.hook as hook_cli
import skill_hub.entrypoints.cli.permissions as perm_cli
from skill_hub import hub_core
from skill_hub.application.skills import ships_with_reconcile as swr
from skill_hub.domain.skills import ships_with, skill_meta
from skill_hub.infrastructure.harnesses import subagents

AGENT_MD = """\
---
name: {name}
description: test agent.
tier: worker
tools: [Read]
---
Agent body v1.
"""


def _skill_md_text(name: str, ships_with_yaml: str) -> str:
    return (
        "---\n"
        f"name: {name}\n"
        "description: test skill.\n"
        f"{ships_with_yaml}"
        "---\n"
        "Body.\n"
    )


def _write_skill(
    tmp_path: Path,
    *,
    name: str = "orchestrate-advanced",
    ships_with_yaml: str = "",
    agents: tuple = (),
) -> Path:
    d = tmp_path / name
    (d / "scripts").mkdir(parents=True, exist_ok=True)
    (d / "scripts" / "guard.sh").write_text("#!/bin/sh\nexit 0\n")
    if agents:
        (d / "agents").mkdir(exist_ok=True)
        for a in agents:
            (d / "agents" / f"{a}.md").write_text(AGENT_MD.format(name=a))
    (d / "SKILL.md").write_text(_skill_md_text(name, ships_with_yaml))
    return d


def _base_registry(
    skill_dir: Path,
    tmp_path: Path,
    *,
    skill_name: str = "orchestrate-advanced",
    scope: str = None,
    companions: dict = None,
    harnesses_global=("claude-code",),
    extra_skills: dict = None,
) -> dict:
    proj_path = tmp_path / "proj"
    proj_path.mkdir(exist_ok=True)
    skills_entry: dict = {"type": "claude-skill", "source": str(skill_dir)}
    if scope:
        skills_entry["scope"] = scope
    proj_cfg: dict = {"path": str(proj_path), "harnesses": [], "enabled": [skill_name], "bundles": []}
    if companions is not None:
        proj_cfg["companions"] = {skill_name: companions}
    skills_cfg = {skill_name: skills_entry}
    if extra_skills:
        skills_cfg.update(extra_skills)
    return {
        "skills": skills_cfg,
        "projects": {"notes-vault": proj_cfg},
        "harnesses_global": list(harnesses_global),
    }


class FakeOps:
    """`Ops` implementation for tests: `hook_attach`/`hook_detach`/`perm_block`
    delegate to the REAL `hub_cli` helpers (genuine registry mutation);
    `delete_agent`/`rerender_agent` delegate to the REAL `subagents`/
    `ships_with` machinery (genuine file writes + backups). `raise_for` lets
    one test inject a deliberate failure on a named call (W6 isolation)."""

    def __init__(self, *, raise_for: dict = None):
        self.raise_for = raise_for or {}
        self.operation_context = None
        self._context_set = False
        self.hook_update_calls: list = []
        self.hook_attach_calls: list = []
        self.hook_detach_calls: list = []
        self.delete_agent_calls: list = []
        self.rerender_agent_calls: list = []

    def _maybe_raise(self, method: str, name: str) -> None:
        exc = self.raise_for.get((method, name))
        if exc is not None:
            raise exc

    def _check_context(self, operation_context):
        if not self._context_set:
            self.operation_context = operation_context
            self._context_set = True
        assert operation_context is self.operation_context

    def hook_update(self, registry, name, *, operation_context=None, **fields):
        self._check_context(operation_context)
        self._maybe_raise("hook_update", name)
        self.hook_update_calls.append((name, dict(fields)))
        hooks_map = registry.setdefault("hooks", {})
        block: dict = {"event": fields["event"], "command": fields["command"]}
        if fields.get("tools"):
            block["tools"] = list(fields["tools"])
        if fields.get("harnesses"):
            block["harnesses"] = list(fields["harnesses"])
        hooks_map[name] = block

    def hook_attach(self, registry, name, *, scope_global, proj_name, operation_context=None):
        self._check_context(operation_context)
        self._maybe_raise("hook_attach", name)
        self.hook_attach_calls.append((name, scope_global, proj_name))
        return hook_cli._hook_attach(
            registry, name, scope_global=scope_global, proj_name=proj_name,
            operation_context=operation_context,
        )

    def hook_detach(self, registry, name, *, scope_global, proj_name, operation_context=None):
        self._check_context(operation_context)
        self._maybe_raise("hook_detach", name)
        self.hook_detach_calls.append((name, scope_global, proj_name))
        return hook_cli._hook_detach(
            registry, name, scope_global=scope_global, proj_name=proj_name,
            operation_context=operation_context,
        )

    def perm_block(self, registry, scope, project, *, operation_context=None):
        self._check_context(operation_context)
        return perm_cli._get_perm_block(registry, scope, project)

    def delete_agent(self, name, harness, registry, *, link_action="this", operation_context=None):
        self._check_context(operation_context)
        self._maybe_raise("delete_agent", name)
        self.delete_agent_calls.append((name, harness, link_action))
        return subagents.delete_agent(
            name, "user", None, registry, harness_id=harness, link_action=link_action,
            context=operation_context,
        )

    def rerender_agent(self, skill, agent, registry, scope, *, operation_context=None):
        self._check_context(operation_context)
        self._maybe_raise("rerender_agent", agent)
        self.rerender_agent_calls.append((skill, agent, scope))
        project = None if scope == ships_with.GLOBAL_SCOPE else scope
        entry = ships_with.ledger_container(registry, project).get(skill) or {}
        a_state = ships_with.agent_state(entry, agent)
        for hid, f in (a_state.get("files") or {}).items():
            if not f.get("written"):
                continue
            payload = ships_with.render_agent_payload(skill, agent, hid, registry, rerender=True)
        subagents.save_agent(payload, registry, context=operation_context)
        return {"ok": True}


def _write_agent_file(registry, name, harness, tmp_data_home) -> Path:
    adir = subagents.agents_dir("user", None, registry, harness)
    adir.mkdir(parents=True, exist_ok=True)
    f = adir / f"{name}.md"
    f.write_text(AGENT_MD.format(name=name))
    return f


# ─────────────────────────────────────────────────────────────────────────────
# 1. A18: ref hooks normalize, backfill-attach, never call a hook writer;
#    an inline + a ref sharing a name fails the block
# ─────────────────────────────────────────────────────────────────────────────


def test_ref_hook_normalizes_attaches_and_rejects_a_duplicate_name(tmp_path):
    skill_dir = _write_skill(
        tmp_path, ships_with_yaml="ships_with:\n  hooks:\n    - ref: lib-hook\n"
    )
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={"hooks": ["lib-hook"], "agents": [], "permissions": []},
    )
    registry["hooks"] = {"lib-hook": {"event": "PreToolUse", "command": "/abs/guard.sh"}}

    plan = swr.plan_reconcile(registry)
    ops = FakeOps()
    result = swr.apply_reconcile(registry, plan, ops)

    report = result["projects"]["notes-vault"]
    assert "lib-hook" in report["backfilled"]
    entry = registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]
    assert entry["hook_state"]["lib-hook"] == {"origin": "ref", "attached": True}
    assert entry["schema"] == 2
    assert ops.hook_update_calls == []  # a ref never creates/edits a definition

    # An inline hook and a ref sharing a name fails the whole block.
    dup_yaml = (
        "ships_with:\n"
        "  hooks:\n"
        "    - name: dup\n"
        "      event: PreToolUse\n"
        "      command: scripts/guard.sh\n"
        "      activation: always\n"
        "    - ref: dup\n"
    )
    warnings: list = []
    raw = yaml.safe_load(dup_yaml)["ships_with"]
    assert ships_with.normalize_block(raw, skill_dir, warn=warnings.append) is None
    assert warnings


# ─────────────────────────────────────────────────────────────────────────────
# 3. A missing ref reports a finding, never writes
# ─────────────────────────────────────────────────────────────────────────────


def test_missing_ref_reports_finding_and_writes_nothing(tmp_path):
    skill_dir = _write_skill(
        tmp_path, ships_with_yaml="ships_with:\n  hooks:\n    - ref: lib-hook\n"
    )
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={"hooks": [], "agents": [], "permissions": [], "schema": 2},
    )
    before = copy.deepcopy(registry)

    plan = swr.plan_reconcile(registry)
    report = plan["projects"]["notes-vault"]
    assert report["missing_refs"] == [
        {"skill": "orchestrate-advanced", "name": "lib-hook", "ref": "lib-hook"}
    ]
    assert plan["ops"] == []
    assert registry == before  # plan_reconcile never mutates

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert registry == before  # nothing to apply
    assert result["projects"]["notes-vault"]["missing_refs"] == report["missing_refs"]


# ─────────────────────────────────────────────────────────────────────────────
# 4. A changed inline hook definition is redefined + re-attached; a re-baked
#    absolute command alone is NOT a hash change
# ─────────────────────────────────────────────────────────────────────────────


def test_changed_inline_hook_definition_is_reattached(tmp_path):
    yaml_v1 = (
        "ships_with:\n"
        "  hooks:\n"
        "    - name: guard\n"
        "      event: PreToolUse\n"
        "      command: scripts/guard.sh\n"
        "      activation: always\n"
        "      tools: [Edit]\n"
    )
    skill_dir = _write_skill(tmp_path, ships_with_yaml=yaml_v1)
    old_decl = {
        "name": "guard",
        "event": "PreToolUse",
        "command": "scripts/guard.sh",
        "activation": "always",
        "tools": ["Edit"],
    }
    old_hash = swr.hook_def_sha256(old_decl)
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": ["guard"],
            "agents": [],
            "permissions": [],
            "schema": 2,
            "hook_state": {"guard": {"origin": "inline", "def_sha256": old_hash, "attached": True}},
        },
    )

    # Change the declared hook (tools grows) -> the hash changes.
    yaml_v2 = yaml_v1.replace("tools: [Edit]", "tools: [Edit, Write]")
    (skill_dir / "SKILL.md").write_text(_skill_md_text("orchestrate-advanced", yaml_v2))

    plan = swr.plan_reconcile(registry)
    assert any(op["kind"] == swr.OP_HOOK_REDEFINE for op in plan["ops"])

    ops = FakeOps()
    result = swr.apply_reconcile(registry, plan, ops)
    assert "guard" in result["projects"]["notes-vault"]["reattached"]
    assert len(ops.hook_update_calls) == 1
    assert ops.hook_attach_calls == [("guard", False, "notes-vault")]

    entry = registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]
    new_hash = entry["hook_state"]["guard"]["def_sha256"]
    assert new_hash != old_hash

    # A re-baked ABSOLUTE command (moving the skill dir) alone is not a change:
    # the hash is computed over the declared (always-relative) command.
    same_decl = {
        "name": "guard",
        "event": "PreToolUse",
        "command": "scripts/guard.sh",
        "activation": "always",
        "tools": ["Edit", "Write"],
    }
    assert swr.hook_def_sha256(same_decl) == new_hash


# ─────────────────────────────────────────────────────────────────────────────
# 5. C2 — a stale hook this ledger never attached is left alone
# ─────────────────────────────────────────────────────────────────────────────


def test_stale_hook_not_attached_by_us_is_left_alone(tmp_path):
    # Declares NOTHING now (the hook was dropped from the skill's block).
    skill_dir = _write_skill(tmp_path, ships_with_yaml="ships_with:\n  agents: []\n")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": ["lsp-report"],
            "agents": [],
            "permissions": [],
            "schema": 2,
            "hook_state": {"lsp-report": {"origin": "inline", "attached": False}},
        },
    )
    # The user attached it BY HAND, independent of this ledger.
    registry["projects"]["notes-vault"]["hooks"] = ["lsp-report"]
    registry["projects"]["notes-vault"]["hook_settings"] = {"lsp-report": {"x": 1}}

    plan = swr.plan_reconcile(registry)
    assert any(op["kind"] == swr.OP_HOOK_STALE and op["name"] == "lsp-report" for op in plan["ops"])

    ops = FakeOps()
    result = swr.apply_reconcile(registry, plan, ops)
    assert "lsp-report" in result["projects"]["notes-vault"]["kept"]
    assert ops.hook_detach_calls == []
    assert registry["projects"]["notes-vault"]["hooks"] == ["lsp-report"]
    assert registry["projects"]["notes-vault"]["hook_settings"] == {"lsp-report": {"x": 1}}


# ─────────────────────────────────────────────────────────────────────────────
# 6. C2 — a stale rule added by hand is kept, bucket unchanged
# ─────────────────────────────────────────────────────────────────────────────


def test_stale_rule_added_by_hand_is_kept(tmp_path):
    skill_dir = _write_skill(tmp_path, ships_with_yaml="ships_with:\n  agents: []\n")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": [],
            "agents": [],
            "permissions": [{"pattern": "Bash(git push:*)", "kind": "deny", "added": False}],
            "schema": 2,
        },
    )
    registry["projects"]["notes-vault"]["permissions"] = {
        "deny": [{"pattern": "Bash(git push:*)", "kind": "deny"}]
    }
    before_bucket = copy.deepcopy(registry["projects"]["notes-vault"]["permissions"])

    plan = swr.plan_reconcile(registry)
    assert any(op["kind"] == swr.OP_RULE_STALE for op in plan["ops"])

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert "Bash(git push:*)" in result["projects"]["notes-vault"]["kept"]
    assert registry["projects"]["notes-vault"]["permissions"] == before_bucket


# ─────────────────────────────────────────────────────────────────────────────
# 7. The true-flag path: stale hook + agent are deprovisioned with backup
# ─────────────────────────────────────────────────────────────────────────────


def test_stale_hook_and_agent_are_deprovisioned_with_backup(tmp_path, tmp_data_home):
    skill_dir = _write_skill(tmp_path, ships_with_yaml="ships_with:\n  agents: []\n")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": ["guard"],
            "agents": ["orch-implementer"],
            "permissions": [],
            "schema": 2,
            "hook_state": {"guard": {"origin": "inline", "attached": True, "def_sha256": "x"}},
            "agent_state": {
                "orch-implementer": {
                    "origin": "skill",
                    "source_sha256": "irrelevant",
                    "files": {},
                }
            },
        },
    )
    registry["hooks"] = {"guard": {"event": "PreToolUse", "command": "/abs/guard.sh"}}
    registry["projects"]["notes-vault"]["hooks"] = ["guard"]
    registry["projects"]["notes-vault"]["hook_settings"] = {"guard": {"a": 1}}
    agent_file = _write_agent_file(registry, "orch-implementer", "claude-code", tmp_data_home)
    registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]["agent_state"][
        "orch-implementer"
    ]["files"] = {"claude-code": {"sha256": swr.agent_file_sha256(agent_file), "written": True}}

    plan = swr.plan_reconcile(registry)
    kinds = {op["kind"] for op in plan["ops"]}
    assert swr.OP_HOOK_STALE in kinds
    assert swr.OP_AGENT_STALE in kinds

    ops = FakeOps()
    result = swr.apply_reconcile(registry, plan, ops)
    report = result["projects"]["notes-vault"]
    assert "guard" in report["stale_removed"]
    assert "orch-implementer" in report["stale_removed"]

    assert not agent_file.exists()
    assert "guard" not in registry["projects"]["notes-vault"]["hooks"]
    assert "guard" not in registry["projects"]["notes-vault"].get("hook_settings", {})
    assert "guard" not in (registry.get("hooks") or {})
    # R10: every claim list drained to empty -> the whole ledger entry drops.
    assert "orchestrate-advanced" not in registry["projects"]["notes-vault"].get("companions", {})

    backup_dir = hub_core.data_home() / "_hub-backups" / "subagents"
    assert backup_dir.exists() and any(backup_dir.iterdir())


# ─────────────────────────────────────────────────────────────────────────────
# 8. C3 — an agent claimed by the GLOBAL ledger survives a project's stale pass
# ─────────────────────────────────────────────────────────────────────────────


def test_agent_claimed_by_the_global_ledger_survives_a_project_stale(tmp_path, tmp_data_home):
    skill_dir = _write_skill(tmp_path, ships_with_yaml="ships_with:\n  agents: []\n")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": [],
            "agents": ["orch-implementer"],
            "permissions": [],
            "schema": 2,
            "agent_state": {
                "orch-implementer": {"origin": "skill", "source_sha256": "x", "files": {}}
            },
        },
    )
    agent_file = _write_agent_file(registry, "orch-implementer", "claude-code", tmp_data_home)
    registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]["agent_state"][
        "orch-implementer"
    ]["files"] = {"claude-code": {"sha256": swr.agent_file_sha256(agent_file), "written": True}}
    # A DIFFERENT skill's GLOBAL ledger claims the same agent name.
    registry["companions_global"] = {
        "other-skill": {"agents": ["orch-implementer"], "hooks": [], "permissions": [], "schema": 2}
    }

    plan = swr.plan_reconcile(registry)
    assert any(op["kind"] == swr.OP_AGENT_STALE for op in plan["ops"])

    ops = FakeOps()
    result = swr.apply_reconcile(registry, plan, ops)
    assert "orch-implementer" in result["projects"]["notes-vault"]["kept"]
    assert agent_file.exists()
    assert ops.delete_agent_calls == []


# ─────────────────────────────────────────────────────────────────────────────
# 9. declared - ledger is only ever REPORTED, never written
# ─────────────────────────────────────────────────────────────────────────────


def test_pending_is_never_written_by_sync(tmp_path):
    skill_dir = _write_skill(
        tmp_path,
        ships_with_yaml=(
            "ships_with:\n"
            "  hooks:\n"
            "    - name: guard\n"
            "      event: PreToolUse\n"
            "      command: scripts/guard.sh\n"
            "      activation: always\n"
            "  permissions:\n"
            "    deny: [\"Bash(git push --force:*)\"]\n"
        ),
    )
    registry = _base_registry(
        skill_dir, tmp_path, companions={"hooks": [], "agents": [], "permissions": [], "schema": 2}
    )
    before = copy.deepcopy(registry)

    plan = swr.plan_reconcile(registry)
    report = plan["projects"]["notes-vault"]
    assert "guard" in report["pending"]
    assert "Bash(git push --force:*)" in report["pending"]
    assert plan["ops"] == []

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert registry == before
    assert result["projects"]["notes-vault"]["pending"] == report["pending"]


# ─────────────────────────────────────────────────────────────────────────────
# 10. An agent drift is detected and NEVER clobbered
# ─────────────────────────────────────────────────────────────────────────────


def test_agent_drift_detected_and_never_clobbered(tmp_path, tmp_data_home):
    skill_dir = _write_skill(
        tmp_path, ships_with_yaml="ships_with:\n  agents: [orch-implementer]\n", agents=("orch-implementer",)
    )
    source_sha = swr.agent_file_sha256(skill_dir / "agents" / "orch-implementer.md")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": [],
            "agents": ["orch-implementer"],
            "permissions": [],
            "schema": 2,
            "agent_state": {
                "orch-implementer": {"origin": "skill", "source_sha256": source_sha, "files": {}}
            },
        },
    )
    agent_file = _write_agent_file(registry, "orch-implementer", "claude-code", tmp_data_home)
    recorded_sha = swr.agent_file_sha256(agent_file)
    # Hand-edit the WRITTEN copy after hub wrote it.
    agent_file.write_text(agent_file.read_text() + "\nhand-edited line.\n")
    registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]["agent_state"][
        "orch-implementer"
    ]["files"] = {"claude-code": {"sha256": recorded_sha, "written": True}}
    before_bytes = agent_file.read_text()

    plan = swr.plan_reconcile(registry)
    report = plan["projects"]["notes-vault"]
    assert report["drift"] == [
        {"skill": "orchestrate-advanced", "agent": "orch-implementer", "harnesses": ["claude-code"]}
    ]
    assert not any(op["kind"] == swr.OP_AGENT_RERENDER for op in plan["ops"])

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert agent_file.read_text() == before_bytes  # never clobbered
    assert result["projects"]["notes-vault"]["drift"] == report["drift"]


# ─────────────────────────────────────────────────────────────────────────────
# 11. An outdated agent (source changed, files match) is re-rendered in place
# ─────────────────────────────────────────────────────────────────────────────


def test_outdated_agent_is_rerendered_in_place(tmp_path, tmp_data_home):
    skill_dir = _write_skill(
        tmp_path, ships_with_yaml="ships_with:\n  agents: [orch-implementer]\n", agents=("orch-implementer",)
    )
    old_source_sha = swr.agent_file_sha256(skill_dir / "agents" / "orch-implementer.md")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": [],
            "agents": ["orch-implementer"],
            "permissions": [],
            "schema": 2,
            "agent_state": {
                "orch-implementer": {"origin": "skill", "source_sha256": old_source_sha, "files": {}}
            },
        },
    )
    agent_file = _write_agent_file(registry, "orch-implementer", "claude-code", tmp_data_home)
    recorded_sha = swr.agent_file_sha256(agent_file)
    registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]["agent_state"][
        "orch-implementer"
    ]["files"] = {"claude-code": {"sha256": recorded_sha, "written": True}}

    # The SOURCE changed (the skill's own copy) — the written file has not.
    (skill_dir / "agents" / "orch-implementer.md").write_text(
        AGENT_MD.format(name="orch-implementer") + "\nAn updated instruction.\n"
    )

    backup_root = hub_core.data_home() / "_hub-backups" / "subagents"
    before_backups = set(backup_root.iterdir()) if backup_root.exists() else set()

    plan = swr.plan_reconcile(registry)
    assert any(op["kind"] == swr.OP_AGENT_RERENDER for op in plan["ops"])

    ops = FakeOps()
    result = swr.apply_reconcile(registry, plan, ops)
    assert "orch-implementer" in result["projects"]["notes-vault"]["reattached"]
    assert ops.rerender_agent_calls == [("orchestrate-advanced", "orch-implementer", "notes-vault")]

    after_backups = set(backup_root.iterdir()) if backup_root.exists() else set()
    assert after_backups - before_backups  # a backup was written

    entry = registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]
    new_source_sha = entry["agent_state"]["orch-implementer"]["source_sha256"]
    assert new_source_sha != old_source_sha
    new_file_sha = entry["agent_state"]["orch-implementer"]["files"]["claude-code"]["sha256"]
    assert new_file_sha == swr.agent_file_sha256(agent_file)


# ─────────────────────────────────────────────────────────────────────────────
# 11b. `agent_file_sha256` against a literal, hand-computed digest (TA-1-0d59)
#
# The relational assertions above (line 616, and the two at the top of
# section 13 below) compare a recorded digest against
# `swr.agent_file_sha256(...)` called again on the same file — sound for the
# obligation they check (the recorded hash matches what reconcile just wrote),
# but self-referential about the hash function itself: if `agent_file_sha256`
# changed algorithm entirely, both sides would move together and stay green.
# This case pins one fixed file's digest against a value computed independently
# offline (`python3 -c "import hashlib; print(hashlib.sha256(open(<path>,
# 'rb').read()).hexdigest())"`), never by calling the function under test.
# ─────────────────────────────────────────────────────────────────────────────


def test_agent_file_sha256_matches_a_literal_precomputed_digest(tmp_path):
    fixed_bytes = (
        b"---\n"
        b"name: orch-implementer\n"
        b"description: fixed literal digest fixture, do not edit\n"
        b"---\n"
        b"Body line one.\n"
        b"Body line two.\n"
    )
    agent_file = tmp_path / "literal-digest-fixture.md"
    agent_file.write_bytes(fixed_bytes)

    # Computed offline, independent of `agent_file_sha256`/`hub_core._sha256_file`:
    #   hashlib.sha256(fixed_bytes).hexdigest()
    expected = "d8a63886412f2a4d1b68938df9c82e3caa3ec26dc53911dc5f3977364349daab"
    assert swr.agent_file_sha256(agent_file) == expected


# ─────────────────────────────────────────────────────────────────────────────
# 12. An already_present (copied, `written: false`) agent is never checked
# ─────────────────────────────────────────────────────────────────────────────


def test_already_present_agent_is_never_drift_checked_or_deleted(tmp_path):
    skill_dir = _write_skill(
        tmp_path, ships_with_yaml="ships_with:\n  agents: [orch-implementer]\n", agents=("orch-implementer",)
    )
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": [],
            "agents": ["orch-implementer"],
            "permissions": [],
            "schema": 2,
            "agent_state": {
                "orch-implementer": {
                    "origin": "skill",
                    "source_sha256": "does-not-matter",
                    "files": {"claude-code": {"sha256": "does-not-matter-either", "written": False}},
                }
            },
        },
    )

    plan = swr.plan_reconcile(registry)
    assert plan["ops"] == []
    report = plan["projects"]["notes-vault"]
    assert report["drift"] == []
    assert report["stale_removed"] == []
    assert report["pending"] == []

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert result["projects"]["notes-vault"] == report


# ─────────────────────────────────────────────────────────────────────────────
# 13. W2 — v1 ledger backfill defaults
# ─────────────────────────────────────────────────────────────────────────────


def test_v1_ledger_backfill_defaults(tmp_path, tmp_data_home):
    skill_dir = _write_skill(
        tmp_path,
        ships_with_yaml=(
            "ships_with:\n"
            "  agents: [orch-implementer]\n"
            "  hooks:\n"
            "    - name: guard\n"
            "      event: PreToolUse\n"
            "      command: scripts/guard.sh\n"
            "      activation: always\n"
            "  permissions:\n"
            "    deny: [\"Bash(git push --force:*)\"]\n"
        ),
        agents=("orch-implementer",),
    )
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            # v1 shape: no `schema`, no `hook_state`/`agent_state`, and the
            # permission entry has no `added` flag.
            "hooks": ["guard"],
            "agents": ["orch-implementer"],
            "permissions": [{"pattern": "Bash(git push --force:*)", "kind": "deny"}],
        },
    )
    registry["projects"]["notes-vault"]["hooks"] = ["guard"]
    agent_file = _write_agent_file(registry, "orch-implementer", "claude-code", tmp_data_home)

    plan = swr.plan_reconcile(registry)
    kinds = {op["kind"] for op in plan["ops"]}
    assert swr.OP_HOOK_HASH in kinds
    assert swr.OP_AGENT_HASH in kinds
    assert swr.OP_SCHEMA_BUMP in kinds

    ops = FakeOps()
    result = swr.apply_reconcile(registry, plan, ops)
    report = result["projects"]["notes-vault"]
    assert "guard" in report["backfilled"]
    assert "orch-implementer" in report["backfilled"]
    assert report["drift"] == []  # a fresh backfill is never drift

    entry = registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]
    assert entry["schema"] == 2
    assert entry["hook_state"]["guard"]["attached"] is True
    assert entry["hook_state"]["guard"]["origin"] == "inline"
    assert entry["hook_state"]["guard"]["def_sha256"]
    a_state = entry["agent_state"]["orch-implementer"]
    assert a_state["source_sha256"] == swr.agent_file_sha256(
        skill_dir / "agents" / "orch-implementer.md"
    )
    assert a_state["files"]["claude-code"] == {
        "sha256": swr.agent_file_sha256(agent_file),
        "written": True,
    }
    assert entry["permissions"][0]["added"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 14. An inactive skill's ledger is left byte-untouched
# ─────────────────────────────────────────────────────────────────────────────


def test_inactive_skill_ledger_is_untouched_by_reconcile(tmp_path):
    skill_dir = _write_skill(
        tmp_path, ships_with_yaml="ships_with:\n  agents: []\n"
    )
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={"hooks": ["guard"], "agents": [], "permissions": [], "schema": 2},
    )
    # The skill is no longer active on this project.
    registry["projects"]["notes-vault"]["enabled"] = []
    before = copy.deepcopy(registry)

    plan = swr.plan_reconcile(registry)
    assert plan["projects"] == {}
    assert plan["ops"] == []

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert registry == before
    assert result["projects"] == {}

    # It shows up as an orphan through the existing (wave 1) accessor.
    orphaned = ships_with.orphans(registry)
    assert any(o["skill"] == "orchestrate-advanced" and o["reason"] == "skill_not_active" for o in orphaned)


# ─────────────────────────────────────────────────────────────────────────────
# Retry (iteration 1) — a ledgered skill with NO `source:` never raises
# SystemExit; the failure is recorded and hooks/rules still reconcile
# ─────────────────────────────────────────────────────────────────────────────


def test_ledgered_skill_with_no_source_records_error_never_raises(tmp_path):
    registry = {
        "skills": {"orchestrate-advanced": {"type": "claude-skill"}},  # no `source:` at all
        "projects": {
            "notes-vault": {
                "path": str(tmp_path / "proj"),
                "harnesses": [],
                "enabled": ["orchestrate-advanced"],
                "bundles": [],
                "hooks": ["stale-hook"],
                "companions": {
                    "orchestrate-advanced": {
                        # v2 ledger: this skill was ONCE declared+provisioned,
                        # but its registry entry now has no source at all —
                        # e.g. a hand-edited/corrupted registry.
                        "hooks": ["stale-hook"],
                        "agents": ["orch-implementer"],
                        "permissions": [],
                        "schema": 2,
                        "hook_state": {
                            "stale-hook": {"origin": "inline", "attached": True, "def_sha256": "x"}
                        },
                        "agent_state": {
                            "orch-implementer": {
                                "origin": "skill",
                                "source_sha256": "x",
                                "files": {"claude-code": {"sha256": "y", "written": True}},
                            }
                        },
                    }
                },
            }
        },
        "harnesses_global": ["claude-code"],
    }
    (tmp_path / "proj").mkdir()

    # plan_reconcile / classify must return normally — no SystemExit escapes.
    plan = swr.plan_reconcile(registry)
    report = plan["projects"]["notes-vault"]
    assert report["errors"] == [
        {
            "op": "resolve_source",
            "skill": "orchestrate-advanced",
            "error": "skill 'orchestrate-advanced' has no source: path",
        }
    ]
    # The unresolvable skill's agent ops are skipped this pass...
    assert not any(op["skill"] == "orchestrate-advanced" and op["name"] == "orch-implementer" for op in plan["ops"])
    # ...but its hooks/rules still reconcile (the stale hook, unaffected by
    # the broken source, is still detected).
    assert any(
        op["kind"] == swr.OP_HOOK_STALE and op["name"] == "stale-hook" for op in plan["ops"]
    )

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert result["projects"]["notes-vault"]["errors"] == report["errors"]
    assert "stale-hook" in result["projects"]["notes-vault"]["stale_removed"]

    # `classify` (the doctor's read-only entry point) also returns normally.
    classified = swr.classify(registry)
    assert classified == {"missing_refs": [], "agent_drift": []}


# ─────────────────────────────────────────────────────────────────────────────
# Retry (milestone 6 review) — R27: I7's `pending` is companion names only,
# never a bare skill name
# ─────────────────────────────────────────────────────────────────────────────


def test_pending_with_no_ledger_entry_names_companions_not_the_skill(tmp_path):
    skill_dir = _write_skill(
        tmp_path,
        ships_with_yaml=(
            "ships_with:\n"
            "  agents: [orch-implementer]\n"
            "  hooks:\n"
            "    - name: guard\n"
            "      event: PreToolUse\n"
            "      command: scripts/guard.sh\n"
            "      activation: always\n"
            "  permissions:\n"
            "    deny: [\"Bash(git push --force:*)\"]\n"
        ),
        agents=("orch-implementer",),
    )
    registry = _base_registry(skill_dir, tmp_path)  # no companions ledger AT ALL

    plan = swr.plan_reconcile(registry)
    report = plan["projects"]["notes-vault"]
    assert "orchestrate-advanced" not in report["pending"]  # the bare skill name never appears
    assert set(report["pending"]) == {"guard", "orch-implementer", "Bash(git push --force:*)"}
    assert plan["ops"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Retry (milestone 6 review) — R24: `classify` reuses an already-computed
# plan instead of re-planning
# ─────────────────────────────────────────────────────────────────────────────


def test_classify_reuses_a_precomputed_plan(tmp_path, monkeypatch):
    skill_dir = _write_skill(
        tmp_path, ships_with_yaml="ships_with:\n  hooks:\n    - ref: missing-hook\n"
    )
    registry = _base_registry(
        skill_dir, tmp_path, companions={"hooks": [], "agents": [], "permissions": [], "schema": 2}
    )
    plan = swr.plan_reconcile(registry)

    call_count = {"n": 0}
    real_plan_reconcile = swr.plan_reconcile

    def _counting_plan_reconcile(*args, **kwargs):
        call_count["n"] += 1
        return real_plan_reconcile(*args, **kwargs)

    monkeypatch.setattr(swr, "plan_reconcile", _counting_plan_reconcile)

    classified = swr.classify(registry, plan=plan)
    assert call_count["n"] == 0  # reused the plan — never re-planned
    assert classified["missing_refs"] == [
        {"scope": "notes-vault", "skill": "orchestrate-advanced", "name": "missing-hook", "ref": "missing-hook"}
    ]

    # The no-arg form still plans for itself (a standalone/CLI call).
    swr.classify(registry)
    assert call_count["n"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Retry (milestone 6 review) — R10: an emptied ledger entry is dropped
# ─────────────────────────────────────────────────────────────────────────────


def test_emptied_ledger_entry_is_dropped(tmp_path):
    skill_dir = _write_skill(tmp_path, ships_with_yaml="ships_with:\n  agents: []\n")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": [],
            "agents": [],
            "permissions": [{"pattern": "Bash(git push:*)", "kind": "deny", "added": True}],
            "schema": 2,
        },
    )
    registry["projects"]["notes-vault"]["permissions"] = {
        "deny": [{"pattern": "Bash(git push:*)", "kind": "deny"}]
    }

    plan = swr.plan_reconcile(registry)
    assert any(op["kind"] == swr.OP_RULE_STALE for op in plan["ops"])

    swr.apply_reconcile(registry, plan, FakeOps())
    assert "orchestrate-advanced" not in registry["projects"]["notes-vault"].get("companions", {})


# ─────────────────────────────────────────────────────────────────────────────
# Retry (milestone 6 review) — A25: `link_action="both"` only when every
# linked harness is one hub itself wrote; else delete written files only
# ─────────────────────────────────────────────────────────────────────────────


def test_agent_stale_link_action_gated_by_written_harnesses(tmp_path, tmp_data_home):
    from skill_hub.infrastructure.harnesses import subagent_links

    skill_dir = _write_skill(tmp_path, ships_with_yaml="ships_with:\n  agents: []\n")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": [],
            "agents": ["orch-implementer"],
            "permissions": [],
            "schema": 2,
            "agent_state": {
                "orch-implementer": {"origin": "skill", "source_sha256": "x", "files": {}}
            },
        },
    )
    claude_file = _write_agent_file(registry, "orch-implementer", "claude-code", tmp_data_home)
    codex_file = _write_agent_file(registry, "orch-implementer", "codex", tmp_data_home)
    registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]["agent_state"][
        "orch-implementer"
    ]["files"] = {
        "claude-code": {"sha256": swr.agent_file_sha256(claude_file), "written": True},
    }  # ONLY claude-code is written by THIS ledger — codex's twin was linked in later by hand.
    # Seed the link sidecar directly (real codex agent files are `.toml`,
    # not `.md` — irrelevant to what A25 itself gates on: the RECORDED link
    # harness set vs. the ledger's `written` set).
    subagent_links.write_links(
        [{"name": "orch-implementer", "scope": "user", "harnesses": ["claude-code", "codex"]}]
    )

    plan = swr.plan_reconcile(registry)
    assert any(op["kind"] == swr.OP_AGENT_STALE for op in plan["ops"])

    ops = FakeOps()
    swr.apply_reconcile(registry, plan, ops)

    assert not claude_file.exists()  # the WRITTEN twin is gone
    assert codex_file.exists()  # the un-written twin survives — A25
    assert ("orch-implementer", "claude-code", "this") in ops.delete_agent_calls
    assert not any(call[2] == "both" for call in ops.delete_agent_calls)


# ─────────────────────────────────────────────────────────────────────────────
# 15. A17 — a scope: global skill reconciles against companions_global
# ─────────────────────────────────────────────────────────────────────────────


def test_global_scope_skill_uses_companions_global_ledger(tmp_path, tmp_data_home):
    skill_dir = _write_skill(
        tmp_path,
        name="global-guard",
        ships_with_yaml=(
            "ships_with:\n"
            "  agents: [orch-implementer]\n"
            "  hooks:\n"
            "    - name: guard\n"
            "      event: PreToolUse\n"
            "      command: scripts/guard.sh\n"
            "      activation: always\n"
            "  permissions:\n"
            "    deny: [\"Bash(git push --force:*)\"]\n"
        ),
        agents=("orch-implementer",),
    )
    registry = {
        "skills": {
            "global-guard": {"type": "claude-skill", "source": str(skill_dir), "scope": "global"}
        },
        "projects": {},
        "harnesses_global": ["claude-code"],
        "companions_global": {
            "global-guard": {
                "hooks": ["guard"],
                "agents": ["orch-implementer"],
                "permissions": [{"pattern": "Bash(git push --force:*)", "kind": "deny"}],
            }
        },
    }
    registry["hooks_global"] = ["guard"]
    agent_file = _write_agent_file(registry, "orch-implementer", "claude-code", tmp_data_home)

    plan = swr.plan_reconcile(registry)
    assert plan["projects"] == {}
    kinds = {op["kind"] for op in plan["ops"]}
    assert swr.OP_HOOK_HASH in kinds
    assert swr.OP_AGENT_HASH in kinds
    assert all(op["scope"] == ships_with.GLOBAL_SCOPE for op in plan["ops"])

    result = swr.apply_reconcile(registry, plan, FakeOps())
    assert "guard" in result["global"]["backfilled"]
    assert "orch-implementer" in result["global"]["backfilled"]
    entry = registry["companions_global"]["global-guard"]
    assert entry["schema"] == 2
    assert entry["permissions"][0]["added"] is True

    # A17: plan_provision(project=None) on this scope:global skill emits REAL
    # user-scope targets, real hooks_global/permissions_global already-present
    # detection, and no trust row.
    plan_prov = ships_with.plan_provision("global-guard", None, registry, installed={"claude-code"})
    hook_items = [it for it in plan_prov["items"] if it["kind"] == "hook"]
    assert hook_items and hook_items[0]["target"] is not None
    assert hook_items[0]["verdict"] == "already_present"  # already in hooks_global
    perm_items = [it for it in plan_prov["items"] if it["kind"] == "permission"]
    assert perm_items and perm_items[0]["target"] is not None
    assert not any(it["kind"] == "trust" for it in plan_prov["items"])


# ─────────────────────────────────────────────────────────────────────────────
# 16. W6 — one failing op isolates into errors; the rest still apply;
#    no SystemExit escapes
# ─────────────────────────────────────────────────────────────────────────────


def test_one_failing_op_isolates_into_errors_and_the_rest_apply(tmp_path):
    skill_dir = _write_skill(tmp_path, ships_with_yaml="ships_with:\n  agents: []\n")
    registry = _base_registry(
        skill_dir,
        tmp_path,
        companions={
            "hooks": ["boom-hook", "ok-hook"],
            "agents": [],
            "permissions": [],
            "schema": 2,
            "hook_state": {
                "boom-hook": {"origin": "inline", "attached": True, "def_sha256": "x"},
                "ok-hook": {"origin": "inline", "attached": True, "def_sha256": "y"},
            },
        },
    )
    registry["projects"]["notes-vault"]["hooks"] = ["boom-hook", "ok-hook"]

    plan = {
        "projects": {},
        "global": {},
        "ops": [
            {
                "kind": swr.OP_HOOK_STALE,
                "scope": "notes-vault",
                "skill": "orchestrate-advanced",
                "name": "boom-hook",
                "attached": True,
                "origin": "inline",
            },
            {
                "kind": swr.OP_HOOK_STALE,
                "scope": "notes-vault",
                "skill": "orchestrate-advanced",
                "name": "ok-hook",
                "attached": True,
                "origin": "inline",
            },
        ],
    }
    ops = FakeOps(raise_for={("hook_detach", "boom-hook"): SystemExit(1)})

    result = swr.apply_reconcile(registry, plan, ops)  # must not raise/exit

    report = result["projects"]["notes-vault"]
    assert len(report["errors"]) == 1
    assert "boom-hook" in report["errors"][0]
    assert "ok-hook" in report["stale_removed"]
    assert "boom-hook" in registry["projects"]["notes-vault"]["hooks"]  # untouched — op failed
    assert "ok-hook" not in registry["projects"]["notes-vault"]["hooks"]  # the other op succeeded
    entry = registry["projects"]["notes-vault"]["companions"]["orchestrate-advanced"]
    assert entry["hooks"] == ["boom-hook"]  # only the SUCCESSFUL op's name was dropped


# ─────────────────────────────────────────────────────────────────────────────
# Bonus (not in plan 1's numbered test list, but real code paths this wave
# touches): `skill_meta.render_frontmatter_block` and `plan_provision`'s ref
# hook resolution.
# ─────────────────────────────────────────────────────────────────────────────


def test_render_frontmatter_block_replaces_a_compound_key_and_supports_removal():
    text = (
        "---\n"
        "name: skill\n"
        "description: |\n"
        "  A skill about ships_with: nothing in particular.\n"
        "ships_with:\n"
        "  agents: [a]\n"
        "harnesses: [claude-code]\n"
        "---\n"
        "Body.\n"
    )
    new_block = {"agents": ["a", "b"]}
    rendered = skill_meta.render_frontmatter_block(text, "ships_with", new_block)
    assert rendered is not None
    meta = yaml.safe_load(rendered.split("---", 2)[1])
    assert meta["ships_with"] == new_block
    assert meta["harnesses"] == ["claude-code"]
    assert "ships_with: nothing in particular" in meta["description"]

    removed = skill_meta.render_frontmatter_block(rendered, "ships_with", None)
    assert removed is not None
    meta2 = yaml.safe_load(removed.split("---", 2)[1])
    assert "ships_with" not in meta2
    assert meta2["harnesses"] == ["claude-code"]

    # Inserting a brand-new key when it was never present.
    inserted = skill_meta.render_frontmatter_block(removed, "ships_with", new_block)
    assert inserted is not None
    meta3 = yaml.safe_load(inserted.split("---", 2)[1])
    assert meta3["ships_with"] == new_block


_FENCED_FRONTMATTER_RE = re.compile(r"^---\n.*?\n---\n", re.S)


def test_render_frontmatter_block_keeps_the_closing_fence_when_the_key_is_last():
    """R1 (CRITICAL, milestone 6 review): `ships_with:` as the LAST
    frontmatter key — the canonical layout, incl.
    `tests/fixtures/ships_with/orchestrate-advanced/SKILL.md` (`description:`
    then `ships_with:`, nothing after it) — used to glue the closing `---`
    onto the last rendered content line with no newline between them, so no
    fenced-frontmatter parser could read the file again."""
    text = (
        "---\n"
        "name: orchestrate-advanced\n"
        "description: Deep orchestrator.\n"
        "ships_with:\n"
        "  agents: [orch-implementer]\n"
        "  permissions:\n"
        '    deny: ["Bash(git push --force:*)"]\n'
        '    ask: ["Bash(gh pr merge:*)"]\n'
        "---\n"
        "Body.\n"
    )
    new_block = {
        "agents": ["orch-implementer"],
        "hooks": [{"ref": "lib-hook", "name": "lib-hook"}],
        "permissions": {
            "deny": ["Bash(git push --force:*)"],
            "allow": ["Bash(ls:*)"],
        },
    }
    new_text = skill_meta.render_frontmatter_block(text, "ships_with", new_block)
    assert new_text is not None

    # The exact shape the review's fixed oracle requires: a real, newline-
    # terminated closing fence, not merely "the naive split produces 3 parts".
    assert _FENCED_FRONTMATTER_RE.match(new_text) is not None
    assert new_text.endswith("---\nBody.\n")
    assert "---Body" not in new_text  # the literal corruption R1 produced

    meta = skill_meta.parse_frontmatter_text(new_text)
    assert meta is not None
    assert meta["ships_with"] == new_block
    assert meta["name"] == "orchestrate-advanced"


def test_plan_provision_resolves_and_reports_missing_ref_hooks(tmp_path):
    skill_dir = _write_skill(
        tmp_path,
        ships_with_yaml=(
            "ships_with:\n"
            "  hooks:\n"
            "    - ref: known-hook\n"
            "    - ref: missing-hook\n"
        ),
    )
    registry = _base_registry(skill_dir, tmp_path)
    registry["hooks"] = {"known-hook": {"event": "PreToolUse", "command": "/abs/x.sh"}}

    plan = ships_with.plan_provision(
        "orchestrate-advanced",
        "notes-vault",
        registry,
        installed={"claude-code"},
        capabilities={"claude-code": {"verdict": "supported", "reason": ""}},
    )
    known_items = [it for it in plan["items"] if it["name"] == "known-hook"]
    missing_items = [it for it in plan["items"] if it["name"] == "missing-hook"]
    assert known_items and known_items[0]["verdict"] in ("will_write", "already_present")
    assert missing_items and missing_items[0]["verdict"] == "unsupported"
    assert "missing-hook" in missing_items[0]["reason"]
