"""ships_with_reconcile — the sync-time reconcile pass for `ships_with`
companions (plan 1, wave 2, milestone 5's `ships-with-2` orchestration
workspace).

A leaf: at module scope it imports `hub_core`, `skill_meta`, `ships_with`,
`hooks_model`, `subagents` and stdlib only — never `hub` or `hub_cli`, and
never a literal home-directory path (no `Path.home` call, no `expanduser`
call, no hand-written tilde-slash path string) — this module is the ONE sync
pass that can DELETE a user-scope file (a stale hook definition, a stale
agent), so every path it touches must be resolved through the
registry/`skill_meta`/`subagents` machinery those siblings already sandbox,
never hand-rolled here.

Design: `plans/0-direction.md` (ships-with-2) D7-D11, I5-I9, A15-A22, on top
of wave 1's D1-D6 + A1-A14 (`../ships-with/plans/0-direction.md`). This module
owns:

  * `hook_def_sha256` / `agent_file_sha256` — the two hash functions the
    reconcile plan compares against the ledger's recorded baselines.
  * `plan_reconcile` — a READ-ONLY walk of every (scope, skill) pair whose
    `ships_with` block is declared and active, comparing the CURRENT
    frontmatter declaration against the CURRENT per-scope ledger. Never
    mutates `registry` or any file. Returns the read-only findings (pending /
    missing_refs / drift — D11) plus a flat list of `ops` for `apply_reconcile`
    to execute.
  * `apply_reconcile` — executes `plan["ops"]`, one at a time, each wrapped in
    its own error boundary (W6): a failing op is isolated into that scope's
    `errors[]` and every other op still runs; the ledger records only ops
    that SUCCEEDED. Every filesystem/registry write goes through the injected
    `Ops` implementation (real writers live in `hub_cli/companions.CliOps`,
    wave 2) — this module never calls a hook/permission/agent WRITER
    directly, only the ledger bookkeeping around each op.
  * `classify` — a read-only reshaping of `plan_reconcile`'s missing-ref and
    agent-drift findings for the doctor (wave 3's `risks.py` consumes it).

**Never auto-provisions.** `declared - ledger` is always reported as
`pending` and NEVER written — the same two-phase-consent posture as
`hub enable --with-companions` (D2). This module only (a) records
hash/attach baselines for what the ledger ALREADY claims, and (b) tears down
what the ledger claims but the skill no longer declares — both backup-first,
both ledger-scoped, both gated on the C2 `attached`/`added`/`written` flags
so hub only ever removes what hub itself put there.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional, Protocol

from skill_hub import hub_core
from skill_hub.domain.hooks import hooks_model
from skill_hub.domain.skills import ships_with, skill_meta
from skill_hub.infrastructure.harnesses import subagents

# ─────────────────────────────────────────────────────────────────────────────
# Op kinds (internal vocabulary — never surfaced outside this module + its CLI
# caller)
# ─────────────────────────────────────────────────────────────────────────────

OP_HOOK_HASH = "HOOK_HASH"
OP_HOOK_REDEFINE = "HOOK_REDEFINE"
OP_HOOK_STALE = "HOOK_STALE"
OP_RULE_STALE = "RULE_STALE"
OP_AGENT_STALE = "AGENT_STALE"
OP_AGENT_HASH = "AGENT_HASH"
OP_AGENT_RERENDER = "AGENT_RERENDER"
OP_SCHEMA_BUMP = "SCHEMA_BUMP"


# ─────────────────────────────────────────────────────────────────────────────
# Hashing
# ─────────────────────────────────────────────────────────────────────────────


def hook_def_sha256(decl: dict) -> str:
    """sha256 over the DECLARED inline hook's definition fields, sorted-key
    JSON — the RELATIVE `command` (as `ships_with.normalize_block` stores it),
    so re-baking an absolute path elsewhere (a `hub rename`) is not itself a
    definition change. Never called for a `{ref}` entry — a reference carries
    no hash of its own (the library owns its definition's hash story)."""
    payload = {
        "event": decl.get("event") or "",
        "command": decl.get("command") or "",
        "tools": list(decl.get("tools") or []),
        "matcher": decl.get("matcher") or "",
        "timeout": decl.get("timeout"),
        "harnesses": (
            list(decl["harnesses"]) if decl.get("harnesses") is not None else None
        ),
    }
    blob = json.dumps(payload, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def agent_file_sha256(path: Path) -> str:
    """sha256 of an agent file's bytes, or `""` when it cannot be read (a
    missing/unreadable file never matches a real recorded hash, so it always
    reads as "differs")."""
    return hub_core._sha256_file(path) or ""


# ─────────────────────────────────────────────────────────────────────────────
# Ops protocol — injected by the CLI caller (`hub_cli/companions.CliOps`,
# wave 2) over the hook/permissions/sub-agent slices. This module never
# imports `hub_cli` — it only calls these methods on whatever is passed in.
# ─────────────────────────────────────────────────────────────────────────────


class Ops(Protocol):
    def hook_update(self, registry: dict, name: str, **fields: Any) -> None: ...

    def hook_attach(
        self, registry: dict, name: str, *, scope_global: bool, proj_name: Optional[str],
        operation_context: Any = None
    ) -> bool: ...

    def hook_detach(
        self, registry: dict, name: str, *, scope_global: bool, proj_name: Optional[str],
        operation_context: Any = None
    ) -> bool: ...

    def perm_block(self, registry: dict, scope: str, project: Optional[str],
                   *, operation_context: Any = None) -> dict: ...

    def delete_agent(
        self, name: str, harness: str, registry: dict, *, link_action: str = "this",
        operation_context: Any = None
    ) -> dict: ...

    def rerender_agent(self, skill: str, agent: str, registry: dict, scope: str,
                       *, operation_context: Any = None) -> dict: ...


# ─────────────────────────────────────────────────────────────────────────────
# Small internal helpers
# ─────────────────────────────────────────────────────────────────────────────


def _new_scope_report() -> dict:
    return {
        "pending": [],
        "stale_removed": [],
        "reattached": [],
        "drift": [],
        "missing_refs": [],
        "backfilled": [],
        "kept": [],
        "errors": [],
        "skipped": None,
    }


def _active_skills_for_scope(scope: str, registry: dict) -> list[str]:
    """Every skill currently active in `scope` — `ships_with.GLOBAL_SCOPE`
    means every `scope: global` registry skill; any other value is a project
    name, resolved the same way `hub.resolve_project_skills` would (bundles ∪
    enabled)."""
    skills_cfg = registry.get("skills") or {}
    if scope == ships_with.GLOBAL_SCOPE:
        return [
            name
            for name, cfg in skills_cfg.items()
            if isinstance(cfg, dict) and cfg.get("scope") == "global"
        ]
    proj_cfg = (registry.get("projects") or {}).get(scope)
    if not isinstance(proj_cfg, dict):
        return []
    return ships_with._resolve_project_skills(proj_cfg, registry)


def _agent_capable_harnesses(*, context: Any = None) -> list[str]:
    if context is not None:
        from skill_hub.infrastructure.harnesses import subagent_links
        return subagent_links.agent_capable_harness_ids(context)
    from skill_hub.infrastructure.harnesses import harnesses
    return [hid for hid, h in harnesses.HARNESSES.items() if h.agents_dir is not None]


def _context_route_available(context: Any, feature: str = "companions") -> bool:
    """Treat an empty captured route as unavailable, never as host legacy data."""
    route_for = getattr(context, "route", None)
    if not callable(route_for):
        return False
    ids = tuple(getattr(context, "harness_ids", ()))
    for hid in ids:
        try:
            route = route_for(hid, feature)
        except (OSError, TypeError, ValueError, KeyError):
            continue
        if (getattr(route, "status", "unavailable") == "shadow"
                and getattr(route, "mode", "unavailable") == "legacy_shadow"):
            return True
    return False


def _written_harnesses(name: str, led: dict, is_backfill: bool, registry: dict, *, context: Any = None) -> list[str]:
    """Which harnesses this LEDGER considers itself to have written `name`'s
    agent file to. Backfilling a v1 entry trusts whatever currently exists on
    disk (A19: "backfill of v1 entries sets both true"); a v2 entry trusts
    only what `agent_state[name].files[<h>].written` already recorded."""
    capable = _agent_capable_harnesses(context=context)
    if is_backfill:
        return [
            hid
            for hid in capable
            if subagents._find_agent_file(name, "user", None, registry, hid, context=context) is not None
        ]
    files = ships_with.agent_state(led, name).get("files") or {}
    return [hid for hid in capable if (files.get(hid) or {}).get("written")]


def _entry_ref(registry: dict, scope: str, skill: str) -> dict:
    """The LIVE (mutable-in-place) ledger entry dict for `(scope, skill)`.
    Raises `ValueError` when the scope or the entry itself is missing — the
    caller (`apply_reconcile`) catches this per-op, isolating it into
    `errors[]` rather than letting it escape (W6)."""
    if scope == ships_with.GLOBAL_SCOPE:
        comp = registry.get("companions_global")
    else:
        proj_cfg = (registry.get("projects") or {}).get(scope)
        if not isinstance(proj_cfg, dict):
            raise ValueError(f"unknown project '{scope}'")
        comp = proj_cfg.get("companions")
    entry = (comp or {}).get(skill)
    if not isinstance(entry, dict):
        raise ValueError(f"no companions ledger entry for ({scope!r}, {skill!r})")
    return entry


def _remove_ledger_names(
    registry: dict,
    scope: str,
    skill: str,
    *,
    hooks: Optional[list[str]] = None,
    permissions: Optional[list[tuple[Optional[str], Optional[str]]]] = None,
    agents: Optional[list[str]] = None,
) -> None:
    """Drop the given names from the (scope, skill) ledger's claim lists AND
    their v2 state sub-dicts — used once an op has (or need not have)
    actually touched the underlying artifact, so this ledger stops tracking a
    name it no longer needs to reconcile every future sync."""
    entry = _entry_ref(registry, scope, skill)
    if hooks:
        entry["hooks"] = [n for n in (entry.get("hooks") or []) if n not in hooks]
        hs = entry.get("hook_state")
        if isinstance(hs, dict):
            for n in hooks:
                hs.pop(n, None)
    if permissions:
        drop_keys = set(permissions)
        entry["permissions"] = [
            p
            for p in (entry.get("permissions") or [])
            if (p.get("pattern"), p.get("kind")) not in drop_keys
        ]
    if agents:
        entry["agents"] = [n for n in (entry.get("agents") or []) if n not in agents]
        astate = entry.get("agent_state")
        if isinstance(astate, dict):
            for n in agents:
                astate.pop(n, None)


def _hook_claimed_elsewhere(registry: dict, scope: str, skill: str, name: str) -> bool:
    """C3 — is `name` still claimed by ANY OTHER (scope, skill) ledger entry?"""
    for s, container in ships_with.ledger_scopes(registry):
        for sk, entry in container.items():
            if (s, sk) == (scope, skill):
                continue
            if name in ((entry or {}).get("hooks") or []):
                return True
    return False


def _perm_scope_kind(project: Optional[str]) -> str:
    return "global" if project is None else "project"


# ─────────────────────────────────────────────────────────────────────────────
# plan_reconcile — read-only
# ─────────────────────────────────────────────────────────────────────────────


def plan_reconcile(registry: dict, *, skills: Optional[list[str]] = None,
                   context: Any = None) -> dict:
    """Read-only: compare every ACTIVE skill's CURRENT `ships_with`
    declaration (frontmatter, A4) against its scope's CURRENT ledger entry.
    Never mutates `registry` or touches a file. `skills`, when given, narrows
    the walk to those skill names only (the `hub skill companions set` path,
    which reconciles just the one skill it edited).

    Returns `{"projects": {<project>: <I7 report>}, "global": <I7 report>,
    "ops": [...]}`. A project/global key is present only when at least one
    active declared skill was actually walked for it (an empty registry, or
    one with no `ships_with` skills anywhere, yields `{"projects": {},
    "global": <empty I7 report>, "ops": []}`)."""
    all_hook_defs = hooks_model.all_definitions(registry)
    skills_cfg = registry.get("skills") or {}

    global_report: Optional[dict] = None
    project_reports: dict[str, dict] = {}
    ops: list[dict] = []

    def _report_for(scope: str) -> dict:
        nonlocal global_report
        if scope == ships_with.GLOBAL_SCOPE:
            if global_report is None:
                global_report = _new_scope_report()
            return global_report
        return project_reports.setdefault(scope, _new_scope_report())

    for scope, container in ships_with.ledger_scopes(registry):
        active = _active_skills_for_scope(scope, registry)
        for skill_name in active:
            if skills is not None and skill_name not in skills:
                continue
            # A fully-emptied `ships_with:` block (every field removed) still
            # normalizes to `None` — but a NON-empty ledger entry means this
            # skill WAS declared once and reconcile must still walk every
            # ledgered item down to zero (each now reads as undeclared), not
            # skip the skill outright. Only a skill neither declared NOR
            # ledgered has nothing to reconcile.
            decl = ships_with.declared_from_frontmatter(skill_name, registry) or {}
            led = container.get(skill_name) or {}
            if not decl and not led:
                continue

            report = _report_for(scope)
            if context is not None and not _context_route_available(context):
                report["skipped"] = "companions route unavailable"
                continue
            if not led:
                # R27: I7's `pending` is ONE vocabulary — companion names,
                # never a bare skill name (the app groups pending entries by
                # their OWNING skill itself, from the declared rows it
                # already holds; a skill-name entry would collide with a
                # companion literally named after its own skill and gives
                # the app nothing to group with anyway). No ledger entry at
                # all means every declared companion is pending.
                for h in decl.get("hooks") or []:
                    report["pending"].append(h["name"])
                for kind in ships_with.PERMISSION_KINDS:
                    for pattern in (decl.get("permissions") or {}).get(kind) or []:
                        report["pending"].append(pattern)
                for agent_name in decl.get("agents") or []:
                    report["pending"].append(agent_name)
                continue

            is_backfill = led.get("schema") != 2
            skill_cfg = skills_cfg.get(skill_name) or {}

            # ── hooks ──
            declared_hook_names: set[str] = set()
            for h in decl.get("hooks") or []:
                name = h["name"]
                declared_hook_names.add(name)
                is_ref = "ref" in h
                if is_ref:
                    if h["ref"] not in all_hook_defs:
                        report["missing_refs"].append(
                            {"skill": skill_name, "name": name, "ref": h["ref"]}
                        )
                        continue
                    origin = "ref"
                    def_sha: Optional[str] = None
                else:
                    origin = "inline"
                    def_sha = hook_def_sha256(h)

                if name not in (led.get("hooks") or []):
                    report["pending"].append(name)
                    continue
                if is_backfill:
                    ops.append(
                        {
                            "kind": OP_HOOK_HASH,
                            "scope": scope,
                            "skill": skill_name,
                            "name": name,
                            "origin": origin,
                            "def_sha256": def_sha,
                        }
                    )
                    continue
                if origin == "inline":
                    recorded = ships_with.hook_state(led, name)
                    if recorded.get("def_sha256") != def_sha:
                        ops.append(
                            {
                                "kind": OP_HOOK_REDEFINE,
                                "scope": scope,
                                "skill": skill_name,
                                "name": name,
                                "decl": h,
                                "def_sha256": def_sha,
                            }
                        )
                # a matching, non-backfill ref/inline hook: steady state.

            for name in led.get("hooks") or []:
                if name in declared_hook_names:
                    continue
                hs = ships_with.hook_state(led, name)
                attached = True if is_backfill else bool(hs.get("attached"))
                # A distinct name from the `origin` used above (that one is
                # always a literal "ref"/"inline" str; this one may fall back
                # to whatever a v2 ledger recorded, or `None` if it never
                # recorded one) — reusing the name would widen its inferred
                # type for the whole function.
                stale_hook_origin: Optional[str] = "inline" if is_backfill else hs.get("origin")
                ops.append(
                    {
                        "kind": OP_HOOK_STALE,
                        "scope": scope,
                        "skill": skill_name,
                        "name": name,
                        "attached": attached,
                        "origin": stale_hook_origin,
                    }
                )

            # ── permissions ──
            declared_perm_keys = {
                (pattern, kind)
                for kind in ships_with.PERMISSION_KINDS
                for pattern in (decl.get("permissions") or {}).get(kind) or []
            }
            for perm in led.get("permissions") or []:
                key = (perm.get("pattern"), perm.get("kind"))
                if key in declared_perm_keys:
                    continue
                added = True if is_backfill else bool(perm.get("added"))
                ops.append(
                    {
                        "kind": OP_RULE_STALE,
                        "scope": scope,
                        "skill": skill_name,
                        "pattern": perm.get("pattern"),
                        "rule_kind": perm.get("kind"),
                        "added": added,
                    }
                )
            ledger_perm_keys = {
                (p.get("pattern"), p.get("kind")) for p in led.get("permissions") or []
            }
            for kind in ships_with.PERMISSION_KINDS:
                for pattern in (decl.get("permissions") or {}).get(kind) or []:
                    if (pattern, kind) not in ledger_perm_keys:
                        report["pending"].append(pattern)

            # ── agents ──
            #
            # `skill_meta.skill_source` raises SystemExit (via `hub_core.fail`)
            # when the registry entry carries no usable `source:` path.
            # Resolved LAZILY — only when this skill has an agent in play at
            # all (hooks/rules above never dereference the skill dir) — and
            # guarded: a malformed entry must never abort the whole reconcile
            # pass (W6). Note a DECLARED agent name can only exist here when
            # `declared_from_frontmatter` already resolved this same
            # `source:` field successfully, so a real failure is only
            # reachable when `declared_agent_names` is empty but the ledger
            # still claims agents (the pure-stale case) — exactly the "one
            # malformed entry" the doctor must survive. On failure, ALL of
            # this skill's agent ops (including the stale ones) are skipped
            # this pass and recorded as one `resolve_source` error; hooks and
            # rules above are already reconciled and unaffected.
            declared_agent_names = set(decl.get("agents") or [])
            ledger_agent_names = set(led.get("agents") or [])
            skill_dir: Optional[Path] = None
            if declared_agent_names or ledger_agent_names:
                raw_source = skill_cfg.get("source")
                if not isinstance(raw_source, str) or not raw_source.strip():
                    report["errors"].append(
                        {
                            "op": "resolve_source",
                            "skill": skill_name,
                            "error": f"skill '{skill_name}' has no source: path",
                        }
                    )
                else:
                    try:
                        skill_dir = skill_meta.skill_source(skill_cfg)
                    except SystemExit as exc:
                        report["errors"].append(
                            {
                                "op": "resolve_source",
                                "skill": skill_name,
                                "error": f"skill '{skill_name}': could not resolve source (exit {exc.code})",
                            }
                        )
                    except Exception as exc:  # defensive — never let this abort the pass
                        report["errors"].append(
                            {"op": "resolve_source", "skill": skill_name, "error": str(exc)}
                        )

            if skill_dir is not None:
                for name in led.get("agents") or []:
                    if name not in declared_agent_names:
                        ops.append(
                            {
                                "kind": OP_AGENT_STALE,
                                "scope": scope,
                                "skill": skill_name,
                                "name": name,
                                "harnesses": _written_harnesses(name, led, is_backfill, registry, context=context),
                            }
                        )
                        continue
                    if is_backfill:
                        ops.append(
                            {"kind": OP_AGENT_HASH, "scope": scope, "skill": skill_name, "name": name}
                        )
                        continue
                    a_state = ships_with.agent_state(led, name)
                    written = {
                        hid: f
                        for hid, f in (a_state.get("files") or {}).items()
                        if f.get("written")
                    }
                    if not written:
                        # D9 copy path (`already_present`) — this ledger never
                        # wrote it, so it is never drift-checked or deleted.
                        continue
                    agent_file = skill_dir / "agents" / f"{name}.md"
                    src_sha = agent_file_sha256(agent_file)
                    current = {
                        hid: agent_file_sha256(_agent_file_path(name, hid, registry, context=context))
                        for hid in written
                    }
                    any_differs = any(
                        current[hid] != f.get("sha256") for hid, f in written.items()
                    )
                    if any_differs:
                        diff_harnesses = sorted(
                            hid for hid, f in written.items() if current[hid] != f.get("sha256")
                        )
                        report["drift"].append(
                            {"skill": skill_name, "agent": name, "harnesses": diff_harnesses}
                        )
                    elif src_sha != a_state.get("source_sha256"):
                        ops.append(
                            {
                                "kind": OP_AGENT_RERENDER,
                                "scope": scope,
                                "skill": skill_name,
                                "name": name,
                            }
                        )
                    # else: source unchanged, every written copy matches — steady state.

                for name in declared_agent_names:
                    if name not in ledger_agent_names:
                        report["pending"].append(name)

            if is_backfill:
                ops.append({"kind": OP_SCHEMA_BUMP, "scope": scope, "skill": skill_name})

    return {
        "projects": project_reports,
        "global": global_report if global_report is not None else _new_scope_report(),
        "ops": ops,
    }


def _agent_file_path(name: str, harness_id: str, registry: dict, *, context: Any = None) -> Path:
    found = subagents._find_agent_file(name, "user", None, registry, harness_id, context=context)
    return found if found is not None else Path(f"/nonexistent/{name}-{harness_id}.md")


# ─────────────────────────────────────────────────────────────────────────────
# apply_reconcile
# ─────────────────────────────────────────────────────────────────────────────


def _clone_report(report: dict) -> dict:
    out = _new_scope_report()
    for key in out:
        if key == "skipped":
            out[key] = report.get(key)
        else:
            out[key] = list(report.get(key) or [])
    return out


def apply_reconcile(registry: dict, plan: dict, ops: "Ops", *, context: Any = None) -> dict:
    """Execute `plan["ops"]` against `registry` (in-memory mutations) plus
    whatever filesystem writes `ops` makes. Never raises and never exits
    (W6): every op runs inside its own error boundary — including a bare
    `SystemExit` (a `fail()` call several layers down an `Ops` method, e.g.
    an unknown project) — and a failing op is isolated into that scope's
    `errors[]` while every other op still applies; the ledger is mutated
    only for ops that SUCCEEDED. Does NOT call `save_registry` — that is the
    caller's job (both `hub skill companions set` and the sync pass save
    once, after this returns).

    Returns the final `{"projects": {...}, "global": {...}}` (the `ops` key
    is plan-only, not part of the I7 result)."""
    result: dict = {
        "global": _clone_report(plan.get("global") or {}),
        "projects": {p: _clone_report(r) for p, r in (plan.get("projects") or {}).items()},
    }

    def _report_for(scope: str) -> dict:
        if scope == ships_with.GLOBAL_SCOPE:
            return result["global"]
        return result["projects"].setdefault(scope, _new_scope_report())

    skills_cfg = registry.get("skills") or {}
    touched: set[tuple[str, str]] = set()

    for op in plan.get("ops") or []:
        scope = op["scope"]
        skill = op["skill"]
        report = _report_for(scope)
        if skill not in _active_skills_for_scope(scope, registry):
            # The skill went inactive between plan and apply (a bundle was
            # toggled mid-sync) — never pull a guardrail sync never granted.
            continue
        touched.add((scope, skill))
        try:
            _apply_one(registry, op, ops, report, skills_cfg, context=context)
        except BaseException as exc:  # noqa: BLE001 — W6: never let ANYTHING escape
            if isinstance(exc, (KeyboardInterrupt, GeneratorExit)):
                raise
            label = op.get("name") or op.get("pattern") or "?"
            report["errors"].append(f"{op['kind']} {label}: {exc}")

    # R10: a ledger entry every claim list has drained down to empty is no
    # longer provisioning anything — drop it rather than let it survive as a
    # live-looking entry (`project_context: true` off a ledger with nothing
    # in it) that every future sync keeps walking for no reason.
    for scope, skill in touched:
        try:
            entry = _entry_ref(registry, scope, skill)
        except ValueError:
            continue
        if entry.get("hooks") or entry.get("permissions") or entry.get("agents"):
            continue
        if scope == ships_with.GLOBAL_SCOPE:
            ships_with.drop_global_ledger_entry(registry, skill)
        else:
            proj_cfg = (registry.get("projects") or {}).get(scope)
            if isinstance(proj_cfg, dict):
                ships_with.drop_ledger_entry(proj_cfg, skill)

    return result


def _apply_one(registry: dict, op: dict, ops: "Ops", report: dict, skills_cfg: dict,
               *, context: Any = None) -> None:
    kind: str = op["kind"]
    scope: str = op["scope"]
    skill: str = op["skill"]
    project: Optional[str] = None if scope == ships_with.GLOBAL_SCOPE else scope
    # Every op kind that actually USES `name` below always carries one (built
    # that way in `plan_reconcile`); RULE_STALE/SCHEMA_BUMP never read it.
    # The `or ""` only narrows the static type to `str` for mypy — it is
    # never observed at runtime.
    name: str = op.get("name") or ""

    if kind == OP_HOOK_HASH:
        entry = _entry_ref(registry, scope, skill)
        hs = entry.setdefault("hook_state", {})
        rec: dict = {"origin": op["origin"], "attached": True}
        if op["origin"] == "inline":
            rec["def_sha256"] = op["def_sha256"]
        hs[name] = rec
        report["backfilled"].append(name)
        return

    if kind == OP_HOOK_REDEFINE:
        decl = op["decl"]
        skill_cfg = skills_cfg.get(skill) or {}
        skill_dir = skill_meta.skill_source(skill_cfg)
        command = str((skill_dir / decl["command"]).resolve(strict=False))
        ops.hook_update(
            registry,
            name,
            event=decl["event"],
            command=command,
            tools=list(decl.get("tools") or []) or None,
            matcher=None,
            timeout=None,
            harnesses=list(decl["harnesses"]) if decl.get("harnesses") else None,
            operation_context=context,
        )
        ops.hook_attach(
            registry, name, scope_global=(scope == ships_with.GLOBAL_SCOPE), proj_name=project,
            operation_context=context,
        )
        entry = _entry_ref(registry, scope, skill)
        hs = entry.setdefault("hook_state", {})
        hs[name] = {"origin": "inline", "def_sha256": op["def_sha256"], "attached": True}
        report["reattached"].append(name)
        return

    if kind == OP_HOOK_STALE:
        if not op["attached"]:
            report["kept"].append(name)
            _remove_ledger_names(registry, scope, skill, hooks=[name])
            return
        ops.hook_detach(
            registry, name, scope_global=(scope == ships_with.GLOBAL_SCOPE), proj_name=project,
            operation_context=context,
        )
        if project is not None:
            proj_cfg = (registry.get("projects") or {}).get(project) or {}
            hook_settings = proj_cfg.get("hook_settings")
            if isinstance(hook_settings, dict) and name in hook_settings:
                del hook_settings[name]
                if not hook_settings:
                    proj_cfg.pop("hook_settings", None)
        if op.get("origin") == "inline":
            still_global = name in (registry.get("hooks_global") or [])
            still_project_attach = any(
                name in (pc.get("hooks") or [])
                for pn, pc in (registry.get("projects") or {}).items()
                if pn != project
            )
            still_ledger = _hook_claimed_elsewhere(registry, scope, skill, name)
            if not (still_global or still_project_attach or still_ledger):
                hooks_map = registry.get("hooks")
                if isinstance(hooks_map, dict) and name in hooks_map:
                    del hooks_map[name]
                    if not hooks_map:
                        registry.pop("hooks", None)
        _remove_ledger_names(registry, scope, skill, hooks=[name])
        report["stale_removed"].append(name)
        return

    if kind == OP_RULE_STALE:
        pattern, rule_kind = op["pattern"], op["rule_kind"]
        if not op["added"]:
            report["kept"].append(pattern)
            _remove_ledger_names(registry, scope, skill, permissions=[(pattern, rule_kind)])
            return
        perm_block = ops.perm_block(registry, _perm_scope_kind(project), project,
                                    operation_context=context)
        bucket = list(perm_block.get(rule_kind) or [])
        matched = [
            b for b in bucket if (b.get("pattern") if isinstance(b, dict) else str(b)) == pattern
        ]
        if matched:
            perm_block[rule_kind] = [b for b in bucket if b not in matched]
            report["stale_removed"].append(pattern)
        else:
            report["kept"].append(pattern)  # hand-removed already — nothing to do
        _remove_ledger_names(registry, scope, skill, permissions=[(pattern, rule_kind)])
        return

    if kind == OP_AGENT_STALE:
        if ships_with.agent_refcount(name, registry, exclude=(scope, skill)) > 0:
            report["kept"].append(name)
            _remove_ledger_names(registry, scope, skill, agents=[name])
            return
        written = [
            hid
            for hid in op.get("harnesses") or []
            if subagents._find_agent_file(name, "user", None, registry, hid, context=context) is not None
        ]
        # A25 (review R5): `link_action="both"` deletes EVERY harness the
        # link SIDECAR tracks, not every harness THIS LEDGER wrote — using it
        # when the sidecar names a harness this ledger never wrote (e.g. the
        # user linked a twin in later via `hub subagent link --copy-from`)
        # deletes a file hub never provisioned, with no restore. Only safe
        # when every linked harness is also one of ours (`written`); else
        # delete exactly the written files, one harness at a time.
        from skill_hub.infrastructure.harnesses import subagent_links

        link = subagent_links.find_link(name, "user", context=context)
        link_harnesses = set((link or {}).get("harnesses") or [])
        use_both = bool(link_harnesses) and link_harnesses.issubset(set(written))
        if use_both:
            anchor = written[0]
            ops.delete_agent(name, anchor, registry, link_action="both", operation_context=context)
        else:
            for hid in written:
                ops.delete_agent(name, hid, registry, link_action="this", operation_context=context)
        _remove_ledger_names(registry, scope, skill, agents=[name])
        report["stale_removed"].append(name)
        return

    if kind == OP_AGENT_HASH:
        entry = _entry_ref(registry, scope, skill)
        skill_cfg = skills_cfg.get(skill) or {}
        skill_dir = skill_meta.skill_source(skill_cfg)
        agent_file = skill_dir / "agents" / f"{name}.md"
        source_sha = agent_file_sha256(agent_file)
        files: dict = {}
        for hid in _agent_capable_harnesses(context=context):
            found = subagents._find_agent_file(name, "user", None, registry, hid, context=context)
            if found is not None:
                files[hid] = {"sha256": agent_file_sha256(found), "written": True}
        astate = entry.setdefault("agent_state", {})
        astate[name] = {"origin": "skill", "source_sha256": source_sha, "files": files}
        report["backfilled"].append(name)
        return

    if kind == OP_AGENT_RERENDER:
        ops.rerender_agent(skill, name, registry, scope, operation_context=context)
        entry = _entry_ref(registry, scope, skill)
        skill_cfg = skills_cfg.get(skill) or {}
        skill_dir = skill_meta.skill_source(skill_cfg)
        agent_file = skill_dir / "agents" / f"{name}.md"
        source_sha = agent_file_sha256(agent_file)
        a_state = ships_with.agent_state(entry, name)
        files = dict(a_state.get("files") or {})
        for hid in list(files):
            if not files[hid].get("written"):
                continue
            found = subagents._find_agent_file(name, "user", None, registry, hid, context=context)
            if found is not None:
                files[hid] = {"sha256": agent_file_sha256(found), "written": True}
        astate = entry.setdefault("agent_state", {})
        astate[name] = {"origin": a_state.get("origin", "skill"), "source_sha256": source_sha, "files": files}
        report["reattached"].append(name)
        return

    if kind == OP_SCHEMA_BUMP:
        entry = _entry_ref(registry, scope, skill)
        entry["schema"] = 2
        for p in entry.get("permissions") or []:
            if isinstance(p, dict) and "added" not in p:
                p["added"] = True
        return

    raise ValueError(f"unknown reconcile op kind '{kind}'")


# ─────────────────────────────────────────────────────────────────────────────
# classify — read-only doctor input (wave 3's risks.py consumes this)
# ─────────────────────────────────────────────────────────────────────────────


def classify(registry: dict, *, plan: Optional[dict] = None) -> dict:
    """Read-only reshape of `plan_reconcile`'s two doctor-relevant findings,
    flattened across every scope: `{"missing_refs": [{"scope", "skill",
    "name", "ref"}], "agent_drift": [{"scope", "skill", "agent",
    "harnesses"}]}`. Never mutates anything.

    R24 — `plan_reconcile` re-parses every active skill's SKILL.md and
    re-hashes every agent file; running it twice per `hub sync` (once for
    the reconcile pass, once here for the doctor) doubles that cost for
    nothing, since both walks see the SAME registry snapshot. Pass the
    ALREADY-COMPUTED `plan` from that one sync-time `plan_reconcile` call
    (`run_reconcile_pass`'s job) to reuse it here instead of re-planning;
    omit it only for a standalone `classify` call (the CLI/doctor entry
    point outside a sync, or a test)."""
    if plan is None:
        plan = plan_reconcile(registry)
    missing_refs: list[dict] = []
    agent_drift: list[dict] = []

    def _collect(scope_label: str, report: dict) -> None:
        for item in report.get("missing_refs") or []:
            missing_refs.append({"scope": scope_label, **item})
        for item in report.get("drift") or []:
            agent_drift.append({"scope": scope_label, **item})

    _collect(ships_with.GLOBAL_SCOPE, plan.get("global") or {})
    for proj_name, report in (plan.get("projects") or {}).items():
        _collect(proj_name, report)

    return {"missing_refs": missing_refs, "agent_drift": agent_drift}
