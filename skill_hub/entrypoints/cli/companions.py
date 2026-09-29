"""`hub skill companions` — the read-only I5 status read, the whole-block
`set`/`add`/`remove` editor (I6, D10), the drift `resolve` verb (I9, A20),
and the sync-time reconcile pass wiring (A16). A helper of the `skill`
subcommand family — `hub_cli/skill.py::register`/`dispatch` delegate the
`companions` subparser here (`register_companions`/`dispatch_companions`);
this module needs no `NAME`/top-level `register`/`dispatch` of its own.

Design: `plans/1.md` (ships-with-2, milestone 5, wave 2), on top of
`ships_with.py` + `ships_with_reconcile.py` (wave 1). Owns:

  * `cmd_skill_companions` — I5: extends wave 1's plan/ledger read with a
    per-harness `state`/`reason`/`route` and a top-level `summary`/
    `project_context`.
  * `cmd_companions_set` / `_add` / `_remove` — I6/D10: one whole-block-
    replace transaction (validate → stage `from:` agent copies → rewrite the
    SKILL.md frontmatter → re-mirror → ONE reconcile pass → print the I6
    result first, THEN the auto-sync tail). `add`/`remove` are thin aliases
    that read the current block, splice one item, and run the same body.
  * `cmd_companions_resolve` — I9/A20: `keep-mine` re-records the on-disk
    hashes as the new baseline; `keep-skill` deletes the rendered twins,
    re-renders, re-links and re-records — backup-first, never through
    `subagent_links.save_linked` (it refuses on drift and co-writes the
    twin, which is exactly the collision this verb exists to resolve).
  * `CliOps` — the real `ships_with_reconcile.Ops` implementation over the
    `skill_hub.entrypoints.cli.hook` / `skill_hub.entrypoints.cli.permissions` slices + `subagents`.
  * `run_reconcile_pass` — plans + applies one reconcile pass and folds the
    per-scope I7 record into a `hub sync` report (`hub.py`'s wiring call) or
    returns it standalone (the `set` transaction's own pass).

Carved out as a NEW helper module (S5-style contract, see `hub_cli/__init__.py`
and `hub_cli/skill.py`'s own header) — `import hub` appears only inside
functions that need a leftover `hub.py` symbol (`hub.new_project_report`,
`hub._auto_sync_tail`), always referenced as `hub.<name>` so a test's
`monkeypatch.setattr(hub, ...)` keeps firing.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from skill_hub import hub_core
from skill_hub.entrypoints.cli.hook import _hook_attach, _hook_detach, _hook_update
from skill_hub.hub_core import BOLD, GREEN, c, fail, registry_mutation

# ─────────────────────────────────────────────────────────────────────────────
# Argparse — S1: two optional positionals (`target`, `name`); `target` is
# EITHER the skill name (a plain status read) OR a verb, disambiguated by
# whether `name` (the second positional) is present. A skill literally named
# one of the five verbs with no second positional is refused, never guessed.
# ─────────────────────────────────────────────────────────────────────────────

_VERBS = ("set", "add", "remove", "resolve", "new-hook", "agent", "save-agent")

p_skill_companions = None


def _companions_context(registry: dict) -> Any:
    """Build one cache-only context for companions and nested native work."""
    from skill_hub.application.harnesses.harness_operation_context import KNOWN_HARNESSES, build_operation_context
    from skill_hub.infrastructure.harnesses import harnesses

    installed = sorted(harnesses.detect_installed())
    return build_operation_context(
        data_home=hub_core.data_home(), harness_ids=KNOWN_HARNESSES,
        requested_features=("companions", "subagents", "hooks", "permissions"),
        force_refresh=False, installed_harness_ids=installed,
    )


def _operation_context_for_args(args: Any, registry: dict) -> Any:
    """Reuse host-supplied context; only top-level direct calls construct one."""
    context = getattr(args, "_operation_context", None)
    return context if context is not None else _companions_context(registry)


def _agent_source_details(
    skill_name: str, agent_name: str, registry: dict
) -> tuple[Optional[dict], Optional[str]]:
    """Resolve one declared skill-owned agent without following user files."""
    from skill_hub.domain.skills import skill_meta
    from skill_hub.infrastructure.registry import sources

    skills = registry.get("skills") or {}
    skill_cfg = skills.get(skill_name)
    if not isinstance(skill_cfg, dict):
        return None, f"unknown skill '{skill_name}'"
    if skill_cfg.get("type") != "claude-skill":
        return None, f"skill '{skill_name}' has no canonical agent source"
    if not isinstance(agent_name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", agent_name):
        return None, "agent name must be a lowercase slug"
    try:
        skill_dir = skill_meta.skill_source(skill_cfg)
    except (OSError, SystemExit, ValueError) as exc:
        return None, f"cannot resolve skill source: {exc}"
    skill_md = skill_dir / "SKILL.md"
    try:
        meta = skill_meta.parse_skill_frontmatter(skill_md) or {}
    except (OSError, ValueError):
        meta = {}
    raw_block = meta.get("ships_with") if isinstance(meta, dict) else None
    declared = raw_block.get("agents") if isinstance(raw_block, dict) else None
    if not isinstance(declared, list) or agent_name not in declared:
        return None, f"agent '{agent_name}' is not declared by skill '{skill_name}'"
    skill_root = skill_dir.resolve(strict=False)
    root = (skill_dir / "agents").resolve(strict=False)
    source = (root / f"{agent_name}.md").resolve(strict=False)
    try:
        root.relative_to(skill_root)
        source.relative_to(root)
        source.relative_to(skill_root)
    except ValueError:
        return None, "agent source is outside the skill agents directory"
    ownership = sources.infer_skill_ownership(skill_name, skill_cfg)
    origin = skill_cfg.get("origin")
    if isinstance(origin, dict) and origin.get("source"):
        ownership = {
            "source_id": str(origin.get("source")),
            "managed": "external",
            "warning": None,
        }
    elif isinstance(origin, str) and origin.startswith("remote:"):
        ownership = {"source_id": origin[7:] or "?", "managed": "external", "warning": None}
    editable = ownership.get("managed") == "local"
    return {
        "skill": skill_name,
        "agent": agent_name,
        "skill_cfg": skill_cfg,
        "skill_dir": skill_dir,
        "path": source,
        "editable": editable,
        "ownership": ownership,
    }, None


def _agent_defaults(frontmatter: dict) -> dict:
    from skill_hub.domain.skills import ships_with

    tier = str(frontmatter.get("tier") or "worker").strip()
    if tier not in ships_with.TIERS:
        tier = "worker"
    raw = frontmatter.get("harnesses")
    raw = raw if isinstance(raw, dict) else {}
    result: dict = {}
    for hid in ("claude-code", "codex"):
        values = ships_with.TIER_MODELS[tier].get(hid, {})
        override = raw.get(hid)
        override = override if isinstance(override, dict) else {}
        item = {
            "model": override["model"]
            if isinstance(override.get("model"), str)
            else values.get("model", "")
        }
        if hid == "codex":
            item["model_reasoning_effort"] = (
                override["model_reasoning_effort"]
                if isinstance(override.get("model_reasoning_effort"), str)
                else values.get("model_reasoning_effort", "")
            )
        result[hid] = item
    return {"tier": tier, "harnesses": result}


def _agent_read_payload(skill_name: str, agent_name: str, registry: dict) -> dict:
    from skill_hub.infrastructure.harnesses import subagents

    details, error = _agent_source_details(skill_name, agent_name, registry)
    if error:
        return {"ok": False, "error": error}
    assert details is not None
    source = details["path"]
    try:
        raw = source.read_bytes()
        doc = subagents.parse_agent(raw.decode("utf-8"))
    except FileNotFoundError:
        return {"ok": False, "error": f"canonical agent source is missing: {source}"}
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        return {"ok": False, "error": f"cannot read canonical agent source: {exc}"}
    fm = doc["frontmatter"]
    defaults = _agent_defaults(fm)
    return {
        "ok": True,
        "skill": skill_name,
        "name": agent_name,
        "description": "" if fm.get("description") is None else str(fm.get("description")),
        "body": doc["body"],
        "tier": defaults["tier"],
        "hash": hashlib.sha256(raw).hexdigest(),
        "editable": bool(details["editable"]),
        "harnesses": defaults["harnesses"],
    }


def cmd_companions_agent(args) -> None:
    """Read the declared canonical agent source for the app editor."""
    registry = hub_core.load_registry()
    payload = _agent_read_payload(args.name, args.agent, registry)
    print(json.dumps(payload, separators=(",", ":")))


def _reconcile_saved_agent(
    skill_name: str, agent_name: str, source_hash: str, registry: dict, *, context: Any = None
) -> dict:
    """Refresh only clean, already-owned native projections.

    Missing, independently edited, and pre-existing claimed files are left
    untouched. This deliberately does not call the broad reconcile pass.
    """
    from skill_hub.application.skills import ships_with_reconcile as swr
    from skill_hub.domain.skills import ships_with
    from skill_hub.infrastructure.harnesses import subagent_links, subagents

    result: dict = {
        "ok": True, "updated": [], "skipped": [], "pending": [], "drift": [], "errors": []
    }
    claims: list[dict[str, Any]] = []
    targets: dict[tuple[str, str], dict[str, Any]] = {}
    for scope, container in ships_with.ledger_scopes(registry):
        entry = (container or {}).get(skill_name)
        if not isinstance(entry, dict) or agent_name not in (entry.get("agents") or []):
            continue
        state = ships_with.agent_state(entry, agent_name)
        files = state.get("files") if isinstance(state, dict) else None
        files = files if isinstance(files, dict) else {}
        claim: dict[str, Any] = {
            "scope": scope, "state": state, "files": files, "targets": [], "failed": False
        }
        claims.append(claim)
        owned = [
            hid for hid, info in files.items() if isinstance(info, dict) and info.get("written")
        ]
        if not owned:
            result["skipped"].append({"scope": scope, "reason": "no-owned-targets"})
            result["pending"].append({"scope": scope, "agent": agent_name})
            state["source_sha256"] = source_hash
            continue
        for hid in owned:
            try:
                path = subagents._find_agent_file(
                    agent_name, "user", None, registry, hid, context=context
                )
            except (OSError, TypeError, ValueError) as exc:
                result["skipped"].append({"scope": scope, "harness": hid, "reason": str(exc)})
                claim["failed"] = True
                continue
            if path is None:
                result["skipped"].append(
                    {"scope": scope, "harness": hid, "reason": "missing-target"}
                )
                result["pending"].append({"scope": scope, "harness": hid, "agent": agent_name})
                claim["failed"] = True
                continue
            key = (str(path.resolve(strict=False)), hid)
            target: dict[str, Any] = targets.setdefault(
                key, {"path": path, "hid": hid, "claims": [], "clean": True}
            )
            target["claims"].append((claim, hid))
            claim["targets"].append(target)

    for target in targets.values():
        expected = {
            (claim["files"].get(hid) or {}).get("sha256", "")
            for claim, hid in target["claims"]
        }
        if len(expected) != 1 or swr.agent_file_sha256(target["path"]) not in expected:
            target["clean"] = False
            for claim, hid in target["claims"]:
                claim["failed"] = True
                result["skipped"].append(
                    {"scope": claim["scope"], "harness": hid, "reason": "drift"}
                )
                result["drift"].append(
                    {"scope": claim["scope"], "harness": hid, "agent": agent_name}
                )

    # A linked save writes every twin. If one member is not a clean target,
    # suppress the whole linked group so an independent edit survives.
    link = subagent_links.find_link(agent_name, scope="user", context=context)
    if link is not None:
        linked = set(link.get("harnesses") or [])
        if any(not any(t["hid"] == hid and t["clean"] for t in targets.values()) for hid in linked):
            for target in targets.values():
                if target["hid"] in linked:
                    target["clean"] = False

    for target in targets.values():
        if not target["clean"]:
            continue
        hid = target["hid"]
        try:
            payload = ships_with.render_agent_payload(
                skill_name, agent_name, hid, registry, rerender=True
            )
            saved = subagents.save_agent(payload, registry, context=context)
            if not saved.get("ok"):
                raise ValueError(str(saved))
            for claim, claim_hid in target["claims"]:
                result["updated"].append({"scope": claim["scope"], "harness": claim_hid})
            target["written"] = True
        except (OSError, ValueError, RuntimeError) as exc:
            for claim, _claim_hid in target["claims"]:
                claim["failed"] = True
                result["errors"].append(
                    {"scope": claim["scope"], "harness": hid, "error": str(exc)}
                )

    for target in targets.values():
        if not target.get("written"):
            continue
        actual = swr.agent_file_sha256(target["path"])
        for claim, claim_hid in target["claims"]:
            claim["files"][claim_hid]["sha256"] = actual

    for claim in claims:
        if not claim["failed"]:
            claim["state"]["source_sha256"] = source_hash
    result["ok"] = not result["errors"]
    return result


def _merge_agent_harnesses(frontmatter: dict, value: Any) -> tuple[Optional[dict], Optional[str]]:
    if not isinstance(value, dict):
        return None, "harnesses must be an object"
    current = frontmatter.get("harnesses")
    merged = dict(current) if isinstance(current, dict) else {}
    defaults = _agent_defaults(frontmatter)["harnesses"]
    for hid, item in value.items():
        if hid not in ("claude-code", "codex"):
            continue
        if not isinstance(item, dict):
            return None, f"harnesses.{hid} must be an object"
        target = dict(merged.get(hid) or {}) if isinstance(merged.get(hid), dict) else {}
        for field in ("model", "model_reasoning_effort"):
            if field in item:
                if not isinstance(item[field], str):
                    return None, f"harnesses.{hid}.{field} must be a string"
                if hid == "claude-code" and field == "model_reasoning_effort":
                    continue
                if hid == "codex" or field == "model":
                    # The UI sends effective values for every harness. Keep a
                    # legacy source's omitted defaults omitted; only a changed
                    # value or an existing explicit field becomes source data.
                    if field not in target and item[field] == defaults[hid].get(field):
                        continue
                    target[field] = item[field]
        if target or hid in merged:
            merged[hid] = target
    return merged, None


@registry_mutation("companions-save-agent")
def cmd_companions_save_agent(args) -> None:
    """Save canonical source text, then refresh only clean owned projections."""
    registry = hub_core.load_registry()
    try:
        body = json.loads(args.json_body)
    except (TypeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": f"invalid JSON: {exc}"}, separators=(",", ":")))
        return
    if not isinstance(body, dict):
        print(json.dumps(
            {"ok": False, "error": "JSON body must be an object"}, separators=(",", ":")
        ))
        return
    expected_hash = body.get("expected_hash")
    if not isinstance(expected_hash, str):
        print(json.dumps(
            {"ok": False, "error": "expected_hash is required"}, separators=(",", ":")
        ))
        return
    details, error = _agent_source_details(args.name, args.agent, registry)
    if error:
        print(json.dumps({"ok": False, "error": error}, separators=(",", ":")))
        return
    assert details is not None
    if not details["editable"]:
        ownership = details.get("ownership") or {}
        reason = ownership.get("managed") or "read-only source"
        print(json.dumps(
            {"ok": False, "error": f"canonical agent source is read-only ({reason})"},
            separators=(",", ":"),
        ))
        return
    description = body.get("description")
    source_body = body.get("body")
    if not isinstance(description, str) or not isinstance(source_body, str):
        print(json.dumps(
            {"ok": False, "error": "description and body are required strings"},
            separators=(",", ":"),
        ))
        return
    from skill_hub.infrastructure.harnesses import subagents

    source = details["path"]
    try:
        raw = source.read_bytes()
        current_hash = hashlib.sha256(raw).hexdigest()
    except FileNotFoundError:
        print(json.dumps(
            {"ok": False, "error": f"canonical agent source is missing: {source}"},
            separators=(",", ":"),
        ))
        return
    except OSError as exc:
        print(json.dumps(
            {"ok": False, "error": f"cannot read canonical agent source: {exc}"},
            separators=(",", ":"),
        ))
        return
    if current_hash != expected_hash:
        print(json.dumps(
            {"ok": False, "error": "canonical agent changed since it was opened", "conflict": True},
            separators=(",", ":"),
        ))
        return
    try:
        doc = subagents.parse_agent(raw.decode("utf-8"))
        fm = doc["frontmatter"]
        harnesses, harness_error = _merge_agent_harnesses(fm, body.get("harnesses"))
        if harness_error:
            raise ValueError(harness_error)
        fm["description"] = description
        if harnesses or "harnesses" in fm:
            fm["harnesses"] = harnesses
        content = subagents.serialize_agent(fm, subagents.normalize_body(source_body))
        subagents._backup_settings(source)
        subagents._atomic_write(source, content)
        source_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        print(json.dumps(
            {"ok": False, "error": f"could not save canonical agent: {exc}"},
            separators=(",", ":"),
        ))
        return

    context = None
    try:
        context = _operation_context_for_args(args, registry)
        reconcile = _reconcile_saved_agent(
            args.name, args.agent, source_hash, registry, context=context
        )
    except (SystemExit, Exception) as exc:
        reconcile = {
            "ok": False,
            "updated": [],
            "skipped": [],
            "pending": [],
            "drift": [],
            "errors": [str(exc)],
        }
    updated = reconcile.get("updated")
    skipped = reconcile.get("skipped")
    if updated or (isinstance(skipped, list) and skipped):
        try:
            hub_core.save_registry(registry)
        except OSError as exc:
            reconcile.setdefault("errors", []).append({"scope": "registry", "error": str(exc)})
            reconcile["ok"] = False
    result = _agent_read_payload(args.name, args.agent, registry)
    if result.get("ok"):
        result["source_saved"] = True
        result["reconcile"] = reconcile
    else:
        result = {
            "ok": True,
            "source_saved": True,
            "reconcile": reconcile,
            "error": result.get("error"),
        }
    print(json.dumps(result, separators=(",", ":")))


def register_companions(skill_sub) -> None:
    global p_skill_companions

    p_skill_companions = skill_sub.add_parser(
        "companions",
        help="Show, edit, or resolve a skill's ships_with companions",
    )
    p_skill_companions.add_argument(
        "target",
        nargs="?",
        help="Skill name (status read), or a verb (set|add|remove|resolve|new-hook|agent|save-agent) "
        "when a second positional names the skill",
    )
    p_skill_companions.add_argument(
        "name", nargs="?", help="Skill name — only paired with a verb as the first positional"
    )
    p_skill_companions.add_argument(
        "--project", "-p", help="Project name (status: adds 'provisioned'/'state'; resolve: the scope)"
    )
    p_skill_companions.add_argument(
        "--global", dest="global_", action="store_true",
        help="resolve: resolve against the companions_global ledger instead of --project",
    )
    p_skill_companions.add_argument("--json", action="store_true", help="Emit JSON")
    p_skill_companions.add_argument(
        "--json-stdin", action="store_true", help="set: read the I6 body as JSON from stdin"
    )
    p_skill_companions.add_argument(
        "--json-body", help="set: the I6 body as a JSON string (A15 — what the app uses)"
    )
    p_skill_companions.add_argument(
        "--kind", choices=["agent", "hook", "permission"], help="add/remove: which list to splice"
    )
    p_skill_companions.add_argument(
        "--item",
        help="add/remove: the agent/hook name or the permission pattern to splice; "
        "new-hook: the new hook's name",
    )
    p_skill_companions.add_argument(
        "--rule-kind", choices=["allow", "deny", "ask"],
        help="add/remove --kind permission: which bucket --item belongs to",
    )
    p_skill_companions.add_argument("--agent", help="resolve: the agent name")
    p_skill_companions.add_argument(
        "--op", choices=["keep-mine", "keep-skill"], help="resolve: which side of the drift to keep"
    )
    p_skill_companions.add_argument(
        "--event", help="new-hook: the hook's event (tool_catalog.CANONICAL_EVENTS)"
    )
    p_skill_companions.add_argument(
        "--tools", help="new-hook: comma-separated tool list (omitted = all tools)"
    )
    p_skill_companions.add_argument(
        "--activation", choices=["while-running", "always"], default="while-running",
        help="new-hook: while-running (default) | always",
    )
    p_skill_companions.add_argument(
        "--command",
        dest="hook_command",  # NOT `command`: that dest is the top-level subcommand
        help="new-hook: script path relative to the skill dir "
        "(default: derived from --item, e.g. scripts/<slug>.sh)",
    )
    p_skill_companions.add_argument(
        "--no-scaffold", action="store_true",
        help="new-hook: declare the hook only — create no script file",
    )


def dispatch_companions(args) -> None:
    target = getattr(args, "target", None)
    name = getattr(args, "name", None)
    if name is not None:
        if target not in _VERBS:
            fail(f"unknown companions verb '{target}' (expected one of {', '.join(_VERBS)})")
        args.name = name
        if target == "set":
            cmd_companions_set(args)
        elif target == "add":
            cmd_companions_add(args)
        elif target == "remove":
            cmd_companions_remove(args)
        elif target == "new-hook":
            cmd_companions_new_hook(args)
        elif target == "agent":
            cmd_companions_agent(args)
        elif target == "save-agent":
            cmd_companions_save_agent(args)
        else:
            cmd_companions_resolve(args)
        return

    skill_name = target
    if skill_name is None:
        p_skill_companions.print_help()
        return
    if skill_name in _VERBS:
        fail(
            f"ambiguous: '{skill_name}' is both a verb and a skill name — pass a "
            f"second positional naming the skill, e.g. `hub skill companions "
            f"{skill_name} <skill>`"
        )
    args.name = skill_name
    cmd_skill_companions(args)


# ─────────────────────────────────────────────────────────────────────────────
# I5 — `hub skill companions <skill> [--project <p>] --json` (read-only)
# ─────────────────────────────────────────────────────────────────────────────


def _reconcile_findings_for(registry: dict, skill_name: str, scope: str,
                            *, operation_context: Any = None) -> dict:
    """The subset of a fresh `plan_reconcile` this skill's row needs: which of
    ITS OWN declared items are pending/drifted/missing-ref/about-to-be-
    resynced in THIS scope. Read-only, never mutates anything."""
    from skill_hub.application.skills import ships_with_reconcile as swr

    plan = swr.plan_reconcile(registry, skills=[skill_name], context=operation_context)
    report = plan["global"] if scope == "global" else (plan["projects"].get(scope) or {})
    outdated_agents: set = set()
    outdated_hooks: set = set()
    for op in plan.get("ops") or []:
        if op.get("scope") != scope or op.get("skill") != skill_name:
            continue
        if op["kind"] == swr.OP_AGENT_RERENDER:
            outdated_agents.add(op["name"])
        elif op["kind"] == swr.OP_HOOK_REDEFINE:
            outdated_hooks.add(op["name"])
    return {
        "pending": set(report.get("pending") or []),
        "drift_agents": {d["agent"] for d in report.get("drift") or [] if d.get("skill") == skill_name},
        "missing_ref_names": {
            m["name"] for m in report.get("missing_refs") or [] if m.get("skill") == skill_name
        },
        "outdated_agents": outdated_agents,
        "outdated_hooks": outdated_hooks,
    }


_NO_FINDINGS = {
    "pending": set(), "drift_agents": set(), "missing_ref_names": set(),
    "outdated_agents": set(), "outdated_hooks": set(),
}


def _item_state(item: dict, *, project_context: bool, findings: dict) -> tuple[str, Optional[str]]:
    """D7's per-harness state for one `plan_provision` item. Priority:
    unsupported/missing always win (they describe the harness, not the
    ledger); otherwise a project-less read only ever says present/absent
    (I5's own rule); with a project (or a `scope: global` skill's own
    ledger, A17) drift/outdated beat plain provisioned, and anything declared
    but not yet in the ledger is pending."""
    kind, name = item["kind"], item["name"]
    if kind == "hook" and name in findings["missing_ref_names"]:
        return "missing", item.get("reason")
    if item["verdict"] == "unsupported":
        return "unsupported", item.get("reason")
    if not project_context:
        # D17 — a project-less read otherwise ALWAYS says absent (no ledger
        # is consulted here), even when the skill is provisioned elsewhere.
        # `it["provisioned_on"]` (pre-set by the caller from EVERY companions
        # ledger) tells the truth instead — except for an AGENT (W1), where
        # disk truth stays authoritative: the ledger can go stale without hub
        # ever knowing (a rendered agent file deleted from the Harnesses
        # screen never clears the ledger), and only `already_present` proves
        # the file the route would link to is still there.
        if item.get("provisioned_on") and (kind != "agent" or item["verdict"] == "already_present"):
            return "provisioned", "from " + ", ".join(item["provisioned_on"])
        return ("present", None) if item["verdict"] == "already_present" else ("absent", None)
    if kind == "agent":
        if name in findings["drift_agents"]:
            return "drift", None
        if name in findings["outdated_agents"]:
            return "outdated", None
        if item.get("provisioned"):
            return "provisioned", None
    elif kind == "hook":
        if name in findings["outdated_hooks"]:
            return "outdated", None
        if item.get("provisioned"):
            return "provisioned", None
    elif kind in ("permission", "trust"):
        if item.get("provisioned"):
            return "provisioned", None
    if name in findings["pending"] or item["verdict"] == "will_write":
        return "pending", None
    if item["verdict"] == "already_present":
        return "provisioned", None
    return "pending", None


def _companion_route(item: dict, project: Optional[str]) -> Optional[str]:
    """A21: advisory (plan 2 may re-derive an agent/hook route; a rule's
    route is authoritative). W4: a project-less permission whose
    `provisioned_on` (pre-set by the caller before this is called) names
    exactly ONE project routes to THAT project's Permissions tab — the
    project-less read's plain `/permissions` fallback resolves nothing there,
    since the rule lives in a project's own block, never the global one.
    With zero or 2+ claiming projects there is no single project to send the
    click to, so the global fallback stays."""
    from skill_hub.domain.skills import ships_with

    kind = item["kind"]
    if kind == "agent":
        return f"/harness/{item['harness']}?agent={item['name']}"
    if kind == "hook":
        return f"/hook/{item['name']}"
    if kind == "permission":
        focus = f"{item.get('rule_kind')}:{quote(item['name'], safe='')}"
        target_project = project
        if not target_project:
            claiming_projects = [
                s for s in (item.get("provisioned_on") or []) if s != ships_with.GLOBAL_SCOPE
            ]
            if len(claiming_projects) == 1:
                target_project = claiming_projects[0]
        if target_project:
            return f"/project/{target_project}?tab=permissions&focus={focus}"
        return f"/permissions?focus={focus}"
    return None


def _group_key(item: dict) -> tuple:
    if item["kind"] == "permission":
        return (item["kind"], item["name"], item.get("rule_kind"))
    return (item["kind"], item["name"])


_STATE_PRIORITY = ("drift", "missing", "pending", "outdated", "provisioned")


def _summarize(groups: dict[tuple, list[str]]) -> dict:
    summary = {"provisioned": 0, "pending": 0, "drift": 0, "missing": 0}
    for states in groups.values():
        reduced = next((s for s in _STATE_PRIORITY if s in states), None)
        if reduced in summary:
            summary[reduced] += 1
        elif reduced == "outdated":
            summary["pending"] += 1
    return summary


def cmd_skill_companions(args):
    """`hub skill companions <skill> [--project <p>] [--json]` (A5, I5) —
    read-only status: the declared mirror plus the provisioning plan, each
    item gaining `provisioned`/`provisioned_on`/`state`/`reason`/`route`;
    top-level `summary` + `project_context` + `provisioned_on` (D17/W2 — every
    scope whose companions ledger claims this skill, ALWAYS present and
    ALWAYS every claiming scope, even under `--project P` — never narrowed
    to just that one project)."""
    from skill_hub.domain.skills import ships_with

    registry = hub_core.load_registry()
    operation_context = _operation_context_for_args(args, registry)
    skills = registry.get("skills", {})
    skill_name = args.name
    if skill_name not in skills:
        fail(f"Unknown skill '{skill_name}'.")

    project = getattr(args, "project", None)
    if project and project not in (registry.get("projects") or {}):
        fail(f"Unknown project '{project}'.")

    skill_cfg = skills[skill_name]
    skill_scope = skill_cfg.get("scope") or "portable"
    is_global_request = not project and skill_scope == "global"
    project_context = bool(project) or is_global_request

    plan = ships_with.plan_provision(
        skill_name, project, registry, operation_context=operation_context)
    declared = ships_with.declared(skill_cfg)
    items = plan["items"]

    # D17 — which scopes' companions ledger claims this skill at all
    # (`ledger_scopes` covers `companions_global` plus every project's
    # `companions`), and a per-item claim map off those SAME entries — hooks/
    # agents by name, permissions by `(pattern, kind)` — so a project-less
    # read can say WHERE a companion is actually provisioned instead of
    # always reporting `absent` (F1). W2: this walks EVERY scope regardless
    # of `--project` — a `--project A` read still lists `["A", "B"]` when
    # both hold the skill, because "where is this provisioned" is a fact
    # about the skill, not about the one scope the caller happened to name.
    provisioned_on = sorted(
        scope for scope, led in ships_with.ledger_scopes(registry) if skill_name in led
    )
    claim_hooks: dict[str, list[str]] = {}
    claim_agents: dict[str, list[str]] = {}
    claim_perms: dict[tuple, list[str]] = {}
    for scope, led in ships_with.ledger_scopes(registry):
        scope_entry = led.get(skill_name)
        if not scope_entry:
            continue
        for hook_name in scope_entry.get("hooks") or []:
            claim_hooks.setdefault(hook_name, []).append(scope)
        for agent_name in scope_entry.get("agents") or []:
            claim_agents.setdefault(agent_name, []).append(scope)
        for perm in scope_entry.get("permissions") or []:
            key = (perm.get("pattern"), perm.get("kind"))
            claim_perms.setdefault(key, []).append(scope)

    findings = _NO_FINDINGS
    if project_context:
        if project:
            entry = ships_with.ledger_entry(registry["projects"][project], skill_name)
            scope_key = project
        else:
            entry = ships_with.global_ledger(registry).get(skill_name) or {}
            scope_key = ships_with.GLOBAL_SCOPE
        ledger_hooks = set(entry.get("hooks") or [])
        ledger_agents = set(entry.get("agents") or [])
        ledger_perms = {(p.get("pattern"), p.get("kind")) for p in entry.get("permissions") or []}
        findings = _reconcile_findings_for(
            registry, skill_name, scope_key, operation_context=operation_context)

    summary_groups: dict[tuple, list[str]] = {}
    for it in items:
        if it["kind"] == "hook":
            it["provisioned_on"] = claim_hooks.get(it["name"], [])
        elif it["kind"] == "agent":
            it["provisioned_on"] = claim_agents.get(it["name"], [])
        elif it["kind"] == "permission":
            it["provisioned_on"] = claim_perms.get((it["name"], it.get("rule_kind")), [])
        else:
            it["provisioned_on"] = []
        if project_context:
            if it["kind"] == "hook":
                it["provisioned"] = it["name"] in ledger_hooks
            elif it["kind"] == "agent":
                it["provisioned"] = it["name"] in ledger_agents
            elif it["kind"] == "permission":
                it["provisioned"] = (it["name"], it.get("rule_kind")) in ledger_perms
            else:
                it["provisioned"] = False
        state, extra_reason = _item_state(it, project_context=project_context, findings=findings)
        it["state"] = state
        # D17: a ledger claim ("from <scope, …>") outranks the plan's advisory
        # note (e.g. "codex binary not found …") — where a companion IS
        # provisioned matters more than a caveat about writing it, and the
        # override keeps the reason deterministic across machines (CI has no
        # codex on PATH; a dev box does).
        if extra_reason is not None and (not it.get("reason") or it.get("provisioned_on")):
            it["reason"] = extra_reason
        it["route"] = _companion_route(it, project)
        # R23 — the Codex trust row is a PREREQUISITE for the rules it gates,
        # not a companion of its own; counting it inflates `summary.pending`
        # by one until trust is granted, even though there is exactly one
        # fewer real companion left to provision than the header would say.
        if it["kind"] != "trust":
            summary_groups.setdefault(_group_key(it), []).append(state)

    payload = {
        "skill": skill_name,
        "project": project,
        "declared": declared,
        "items": items,
        "summary": _summarize(summary_groups),
        "project_context": project_context,
        "provisioned_on": provisioned_on,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return

    if not items:
        print(f"'{skill_name}' declares no ships_with companions.")
        return
    print(
        f"\n{c(skill_name, BOLD)} ships_with companions"
        + (f" on '{project}'" if project else "") + ":"
    )
    for it in items:
        prov = f" ({it['state']})"
        print(f"  [{it['kind']}] {it['name']} · {it['harness']} · {it['verdict']}{prov}")


# ─────────────────────────────────────────────────────────────────────────────
# I6/D10 — `hub skill companions set/add/remove <skill>`
# ─────────────────────────────────────────────────────────────────────────────

_FIELD_RE = re.compile(r"^ships_with\.?([\w.\[\]-]*):")


def _field_from_warning(message: str) -> str:
    m = _FIELD_RE.match(message)
    if m and m.group(1):
        return m.group(1)
    return "ships_with"


def _set_fail(error: str, field: Optional[str] = None) -> None:
    payload: dict = {"ok": False, "error": error}
    if field is not None:
        payload["field"] = field
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(1)


def _read_set_body(args) -> Any:
    json_stdin = bool(getattr(args, "json_stdin", False))
    json_body = getattr(args, "json_body", None)
    if bool(json_stdin) == bool(json_body):
        _set_fail("pass exactly one of --json-stdin or --json-body", field="body")
    raw = sys.stdin.read() if json_stdin else json_body
    try:
        body = json.loads(raw)
    except (TypeError, ValueError) as exc:
        _set_fail(f"invalid JSON: {exc}", field="body")
    if not isinstance(body, dict):
        _set_fail("body must be a JSON object", field="body")
    return body


def _stage_agent_copy(skill_dir: Path, agent_name: str, source_file: Path) -> Path:
    """D9 — COPY an existing per-harness agent definition into
    `<skill>/agents/<name>.md`, projected onto the harness-agnostic I4 shape
    (`name`/`description`/`tier: worker`/`tools`). The user's ORIGINAL file is
    untouched; it stays a live, independently-editable definition."""
    from skill_hub.infrastructure.harnesses import subagents

    doc = subagents.parse_agent(source_file.read_text())
    fm = doc["frontmatter"]
    desc = fm.get("description")
    out_fm: dict = {"name": agent_name, "description": "" if desc is None else str(desc), "tier": "worker"}
    tools = fm.get("tools")
    if tools:
        out_fm["tools"] = list(tools) if isinstance(tools, list) else [str(tools)]
    text = subagents.serialize_agent(out_fm, doc["body"])
    agents_dir = skill_dir / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    dest = agents_dir / f"{agent_name}.md"
    dest.write_text(text)
    return dest


def _stage_hook_script(skill_dir: Path, hook: dict) -> Optional[Path]:
    """The hook-script twin of `_stage_agent_copy` (wave 4c unit 1): write
    `<skill_dir>/<hook['command']>` from `ships_with.hook_script_template`,
    chmod 0o755, and return the path — or `None`, staging nothing, when the
    target already exists (R3 — hub never overwrites a script) or when the
    target does not validate (defensive: `_apply_set_body` already validates
    before calling this)."""
    from skill_hub.domain.skills import ships_with

    cleaned, _reason = ships_with.validate_scaffold_target(skill_dir, hook.get("command"))
    if cleaned is None:
        return None
    target = skill_dir / cleaned
    if target.is_file():
        return None
    scaffold = hook.get("scaffold") or {}
    template = "python3" if target.suffix == ".py" else "bash"
    if isinstance(scaffold, dict) and scaffold.get("template"):
        template = scaffold["template"]
    body = ships_with.hook_script_template(
        hook.get("name") or "", hook.get("event") or "", template=template
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body)
    target.chmod(0o755)
    return target


def _remote_quarantine_id(skill_cfg: dict) -> Optional[str]:
    """The remote id when this skill was imported from a remote, else None.

    Mirrors `hub._provision_skill`'s guard (`hub_cli/subagent.py`). Case table:
    `tests/fixtures/remote_quarantine_corpus.json` — the SAME fixture wave 4c's
    TS twin must read, so the two can never drift.
    """
    origin = skill_cfg.get("origin")
    if isinstance(origin, str) and origin.startswith("remote:"):
        return origin[len("remote:"):] or "?"
    return None


def _hook_name_taken(registry: dict, skill_name: str) -> set[str]:
    """§6.3a `HOOK_NAME_TAKEN`: `inline(S) ∪ refs(S) ∪` every resolvable
    hooks-library definition name (`hooks_model.all_definitions`, built-ins
    included, registry shadowing). `declared_from_frontmatter` already
    normalizes a ref entry to `{"ref": r, "name": r}`, so reading `name` off
    every declared hook entry covers inline names AND ref names in one pass.

    Applied WHOLE by `cmd_companions_new_hook` (the verb only ever creates —
    no carve-out). `_apply_set_body`'s inline arm does NOT call this: it
    applies `library − inline(S)` instead, so a re-save of an already-
    provisioned skill (whose inline hook is itself in `registry["hooks"]`,
    `_hook_new`, `hub_cli/skill.py`) is never refused (grill #13, plans/3.md
    §3.1a)."""
    from skill_hub.domain.hooks import hooks_model
    from skill_hub.domain.skills import ships_with

    declared = ships_with.declared_from_frontmatter(skill_name, registry) or {}
    names: set[str] = {h.get("name") for h in declared.get("hooks") or [] if h.get("name")}
    names |= set(hooks_model.all_definitions(registry).keys())
    return names


def _refuse_if_unmanageable(skill_name: str, skill_cfg: dict) -> None:
    from skill_hub.infrastructure.registry import sources

    remote_id = _remote_quarantine_id(skill_cfg)
    if remote_id is not None:
        _set_fail(
            f"'{skill_name}' is quarantined (imported from remote '{remote_id}'). "
            f"Remote-origin skills are held project-specific by design and cannot "
            f"ship companions — no override.",
            field="skill",
        )
    ownership = sources.infer_skill_ownership(skill_name, skill_cfg)
    if ownership["managed"] == "external":
        _set_fail(
            f"'{skill_name}' is owned by external source '{ownership['source_id']}' — "
            f"the hub does not edit upstream checkouts. Set a per-project override "
            f"instead: hub project invocation <project> --skill {skill_name} --mode <mode>",
            field="skill",
        )


def _apply_set_body(registry: dict, skill_name: str, skill_cfg: dict, body: dict,
                    *, operation_context: Any = None) -> None:
    """The shared core of `set`/`add`/`remove` (D10 steps 2-6): stage `from:`
    agent copies, validate, rewrite the frontmatter, re-mirror, reconcile,
    save — ONE transaction, print the I6 first line, then the auto-sync
    tail."""
    import hub
    from skill_hub.domain.skills import ships_with
    if operation_context is None:
        operation_context = _companions_context(registry)
    from skill_hub.domain.skills import skill_meta
    from skill_hub.infrastructure.harnesses import subagents

    skill_dir = skill_meta.skill_source(skill_cfg)
    skill_md = skill_dir / "SKILL.md"
    try:
        original_text = skill_md.read_text()
    except OSError as exc:
        _set_fail(f"cannot read SKILL.md: {exc}", field="skill")

    # A4 — read the PRIOR declaration from the frontmatter (never the
    # registry mirror, which may not exist yet on a never-synced skill) so a
    # removed agent is detected correctly even on the very first `set`.
    prior_agents = set((ships_with.declared_from_frontmatter(skill_name, registry) or {}).get("agents") or [])

    agent_entries = body.get("agents")
    if agent_entries is None:
        agent_entries = []
    if not isinstance(agent_entries, list):
        _set_fail("'agents' must be a list", field="agents")

    staged_files: list[Path] = []
    # Wave 4c unit 1 — directories `_stage_hook_script` created (a `scripts/`
    # dir that did not already exist) so a failure after staging removes them
    # too, never leaving hub-created empty dirs behind (R3).
    staged_dirs: list[Path] = []

    def _rollback_staged() -> None:
        for f in staged_files:
            try:
                f.unlink()
            except OSError:
                pass
        # R3 (opus review 6-review-4c.md finding 3) — `staged_dirs` is already
        # DEEPEST first (the `while not p.exists()` walk below appends a
        # nested dir before its parent), so removing them in that same order
        # rmdirs the leaf before the now-empty parent. `reversed()` used to
        # rmdir the outermost dir FIRST, which fails (it still holds the
        # not-yet-removed nested dir) and stranded an empty hub-created dir.
        for d in staged_dirs:
            try:
                d.rmdir()
            except OSError:
                pass

    agent_names: list[str] = []
    for a in agent_entries:
        if not isinstance(a, dict) or not isinstance(a.get("name"), str) or not a["name"].strip():
            _rollback_staged()
            _set_fail("each agents[] entry needs a 'name' string", field="agents")
        name = a["name"].strip()
        agent_names.append(name)
        agent_file = skill_dir / "agents" / f"{name}.md"
        if agent_file.is_file():
            continue
        from_spec = a.get("from")
        if not from_spec:
            _rollback_staged()
            _set_fail(
                f"agent '{name}' has no file at {agent_file} and no 'from' to copy it",
                field=f"agents[{name}]",
            )
        if not isinstance(from_spec, dict) or not isinstance(from_spec.get("harness"), str):
            _rollback_staged()
            _set_fail(f"agents[{name}].from must be {{'harness': <id>}}", field=f"agents[{name}].from")
        hid = from_spec["harness"]
        found = subagents._find_agent_file(name, "user", None, registry, hid,
                                           context=operation_context)
        if found is None:
            _rollback_staged()
            _set_fail(f"no existing '{hid}' agent named '{name}' to copy from", field=f"agents[{name}].from")
            return
        try:
            staged_files.append(_stage_agent_copy(skill_dir, name, found))
        except OSError as exc:
            _rollback_staged()
            _set_fail(f"could not stage agent '{name}': {exc}", field=f"agents[{name}]")

    # Wave 4c unit 1 — the widened hook arm (plans/3.md §3.1/§3.2/§3.1a):
    # refuse a NEW inline hook whose name collides with a hooks-library
    # definition (grill #13, carved out for a name this skill ALREADY
    # declares inline — a provisioned inline hook is itself in
    # `registry["hooks"]`, so re-saving must not be refused), then stage the
    # scaffolded script (if any) for entries that carry a `scaffold` key,
    # stripping it before `normalize_block` sees the entry.
    hook_entries = body.get("hooks")
    if hook_entries is None:
        hook_entries = []
    if not isinstance(hook_entries, list):
        _rollback_staged()
        _set_fail("'hooks' must be a list", field="hooks")

    from skill_hub.domain.hooks import hooks_model

    all_hook_defs = hooks_model.all_definitions(registry)
    prior_declared = ships_with.declared_from_frontmatter(skill_name, registry) or {}
    prior_inline_names = {
        h.get("name") for h in prior_declared.get("hooks") or [] if "ref" not in h and h.get("name")
    }

    scaffolded: list[str] = []
    missing_commands: list[str] = []
    scaffold_requested_names: set = set()
    cleaned_hooks: list[dict] = []
    for h in hook_entries:
        if not isinstance(h, dict):
            _rollback_staged()
            _set_fail("each hooks[] entry must be a mapping", field="hooks")
        if "ref" in h:
            # Suggestion 14 (opus review 6-review-4c.md) — a `{ref}` entry
            # points at a hooks-library definition, which already owns its
            # own script (if any); a `scaffold` request on it can never be
            # honored and was previously dropped on the floor with no
            # signal. Refuse it the same fail-closed way every other
            # malformed hooks[] entry here is refused.
            if h.get("scaffold"):
                _rollback_staged()
                _set_fail(
                    f"hooks[{h.get('name') or h.get('ref')}]: a {{ref}} entry cannot carry "
                    "'scaffold' — only a new inline hook can be scaffolded",
                    field=f"hooks[{h.get('name') or h.get('ref') or '?'}]",
                )
            cleaned_hooks.append(h)
            continue

        hook_name = h.get("name")
        field_name = hook_name if isinstance(hook_name, str) and hook_name else "?"
        if (
            isinstance(hook_name, str)
            and hook_name in all_hook_defs
            and hook_name not in prior_inline_names
        ):
            _rollback_staged()
            _set_fail(
                f"'{hook_name}' is already a hooks-library definition — reference "
                f"it instead: hub skill companions add --kind hook --item {hook_name}",
                field=f"hooks[{field_name}]",
            )

        scaffold = h.get("scaffold")
        entry = {k: v for k, v in h.items() if k != "scaffold"}
        if scaffold:
            if not isinstance(scaffold, dict):
                _rollback_staged()
                _set_fail(
                    f"hooks[{field_name}].scaffold must be a mapping",
                    field=f"hooks[{field_name}].command",
                )
            cleaned, reason = ships_with.validate_scaffold_target(skill_dir, h.get("command"))
            if cleaned is None:
                _rollback_staged()
                _set_fail(
                    f"hooks[{field_name}]: cannot scaffold — {reason}",
                    field=f"hooks[{field_name}].command",
                )
            derived_template = "python3" if Path(cleaned).suffix == ".py" else "bash"
            requested_template = scaffold.get("template")
            if requested_template and requested_template != derived_template:
                _rollback_staged()
                _set_fail(
                    f"hooks[{field_name}].scaffold.template '{requested_template}' does "
                    f"not match the target's suffix (expected '{derived_template}')",
                    field=f"hooks[{field_name}].command",
                )
            target = skill_dir / cleaned
            missing_dirs: list[Path] = []
            p = target.parent
            while not p.exists():
                missing_dirs.append(p)
                p = p.parent
            try:
                staged_path = _stage_hook_script(skill_dir, {**entry, "command": cleaned})
            except OSError as exc:
                _rollback_staged()
                _set_fail(f"could not scaffold hook '{field_name}': {exc}", field=f"hooks[{field_name}]")
            if staged_path is not None:
                staged_files.append(staged_path)
                staged_dirs.extend(missing_dirs)
                scaffolded.append(str(staged_path))
            if isinstance(hook_name, str):
                scaffold_requested_names.add(hook_name)
        cleaned_hooks.append(entry)

    for h in cleaned_hooks:
        if "ref" in h:
            continue
        hook_name = h.get("name")
        command = h.get("command")
        if hook_name in scaffold_requested_names:
            continue
        if not isinstance(command, str) or not command:
            continue
        if not (skill_dir / command).is_file():
            missing_commands.append(command)

    warnings: list[str] = []
    candidate = {"agents": agent_names or None, "hooks": cleaned_hooks or None, "permissions": body.get("permissions")}
    block = ships_with.normalize_block(candidate, skill_dir, warn=warnings.append)
    if warnings:
        _rollback_staged()
        msg = warnings[-1]
        _set_fail(msg, field=_field_from_warning(msg))

    new_text = skill_meta.render_frontmatter_block(original_text, "ships_with", block)
    if new_text is None:
        _rollback_staged()
        _set_fail("could not rewrite SKILL.md frontmatter — file left unchanged", field="ships_with")
    try:
        skill_md.write_text(new_text)
    except OSError as exc:
        try:
            skill_md.write_text(original_text)
        except OSError:
            pass
        _rollback_staged()
        _set_fail(f"could not write SKILL.md: {exc}", field="skill")

    # W3 — a removed agent's file STAYS on disk (never deleted here); the
    # result names it so the caller can show the user where it went.
    kept_files: list[str] = []
    for removed in sorted(prior_agents - set(agent_names)):
        f = skill_dir / "agents" / f"{removed}.md"
        if f.is_file():
            kept_files.append(str(f))

    # R26 — everything past this point runs AFTER the frontmatter write
    # already landed on disk; a failure here (re-mirror, reconcile, or the
    # registry save itself) must not leave SKILL.md rewritten with nothing
    # saved and no JSON line printed. Restore the original bytes + unstage
    # any copied agent files, the same rollback the earlier validation
    # failures use, before reporting the error.
    try:
        skill_meta.sync_skill_frontmatter_metadata(registry)
        reconcile = run_reconcile_pass(
            registry, skills=[skill_name], operation_context=operation_context)
        hub_core.save_registry(registry)
    except (SystemExit, Exception) as exc:
        try:
            skill_md.write_text(original_text)
        except OSError:
            pass
        _rollback_staged()
        _set_fail(f"companions set failed after the frontmatter write — SKILL.md restored: {exc}", field="ships_with")

    payload = {
        "ok": True,
        "skill": skill_name,
        "block": ships_with.declared(registry["skills"][skill_name]),
        "reconcile": reconcile,
        "kept_files": kept_files,
        "scaffolded": scaffolded,
        "missing_commands": missing_commands,
    }
    print(json.dumps(payload, separators=(",", ":")))
    hub._auto_sync_tail()


@registry_mutation("companions-set")
def cmd_companions_set(args):
    """`hub skill companions set <skill> {--json-stdin|--json-body <json>}`
    (D10/I6/A15)."""
    registry = hub_core.load_registry()
    operation_context = _operation_context_for_args(args, registry)
    skills = registry.get("skills") or {}
    skill_name = args.name
    skill_cfg = skills.get(skill_name)
    if not isinstance(skill_cfg, dict):
        _set_fail(f"unknown skill '{skill_name}'", field="skill")
    _refuse_if_unmanageable(skill_name, skill_cfg)
    body = _read_set_body(args)
    _apply_set_body(registry, skill_name, skill_cfg, body,
                    operation_context=operation_context)


def _current_body(skill_name: str, registry: dict) -> dict:
    """The current declared block, in `set`-body shape — `agents` widened to
    `{"name": ...}` (no `from`: the file already exists), hooks/permissions
    passed through as-is (a ref is already `{"ref": r, "name": r}`, which
    `normalize_block` tolerates on a re-set)."""
    from skill_hub.domain.skills import ships_with

    current = ships_with.declared_from_frontmatter(skill_name, registry) or {}
    return {
        "agents": [{"name": n} for n in current.get("agents") or []],
        "hooks": [dict(h) for h in current.get("hooks") or []],
        "permissions": {
            k: list((current.get("permissions") or {}).get(k) or []) for k in ("allow", "deny", "ask")
        },
    }


def _splice_and_set(args, *, add: bool) -> None:
    from skill_hub.domain.skills import ships_with

    registry = hub_core.load_registry()
    operation_context = _operation_context_for_args(args, registry)
    skills = registry.get("skills") or {}
    skill_name = args.name
    skill_cfg = skills.get(skill_name)
    if not isinstance(skill_cfg, dict):
        _set_fail(f"unknown skill '{skill_name}'", field="skill")
    _refuse_if_unmanageable(skill_name, skill_cfg)

    kind = getattr(args, "kind", None)
    item = getattr(args, "item", None)
    if kind not in ("agent", "hook", "permission"):
        _set_fail("--kind must be one of agent|hook|permission", field="kind")
    if not item:
        _set_fail("--item is required", field="item")
    rule_kind = getattr(args, "rule_kind", None)
    if kind == "permission" and rule_kind not in ships_with.PERMISSION_KINDS:
        _set_fail("--rule-kind is required for --kind permission (allow|deny|ask)", field="rule_kind")

    body = _current_body(skill_name, registry)
    if kind == "agent":
        names = {a["name"] for a in body["agents"]}
        if add:
            if item not in names:
                body["agents"].append({"name": item})
        else:
            body["agents"] = [a for a in body["agents"] if a["name"] != item]
    elif kind == "hook":
        names = {h.get("name") or h.get("ref") for h in body["hooks"]}
        if add:
            if item not in names:
                body["hooks"].append({"ref": item})
        else:
            body["hooks"] = [h for h in body["hooks"] if (h.get("name") or h.get("ref")) != item]
    else:
        bucket = body["permissions"][rule_kind]
        if add:
            if item not in bucket:
                bucket.append(item)
        else:
            body["permissions"][rule_kind] = [p for p in bucket if p != item]

    _apply_set_body(registry, skill_name, skill_cfg, body,
                    operation_context=operation_context)


@registry_mutation("companions-add")
def cmd_companions_add(args):
    """`hub skill companions add <skill> --kind <k> --item <n> [--rule-kind
    <k>]` — a thin read-splice-write alias over `set` (D10)."""
    _splice_and_set(args, add=True)


@registry_mutation("companions-remove")
def cmd_companions_remove(args):
    """`hub skill companions remove <skill> --kind <k> --item <n> [--rule-kind
    <k>]` — a thin read-splice-write alias over `set` (D10)."""
    _splice_and_set(args, add=False)


# ─────────────────────────────────────────────────────────────────────────────
# §6.1 — `hub skill companions new-hook <skill> --item <n> --event <E> ...`
# (wave 4c unit 1: cli-hook-scaffold) — declare a brand-NEW inline hook and,
# unless --no-scaffold, scaffold its script, in one `set` transaction.
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("companions-new-hook")
def cmd_companions_new_hook(args):
    """`hub skill companions new-hook <skill> --item <name> --event <EVENT>
    [--tools a,b] [--activation while-running|always] [--command
    scripts/<slug>.sh] [--no-scaffold] [--json]` (§6.1). Same exit/JSON
    contract as `set` — this is a thin builder over `_apply_set_body`."""
    from skill_hub.domain.diagnostics import tool_catalog

    registry = hub_core.load_registry()
    operation_context = _operation_context_for_args(args, registry)
    skills = registry.get("skills") or {}
    skill_name = args.name
    skill_cfg = skills.get(skill_name)
    if not isinstance(skill_cfg, dict):
        _set_fail(f"unknown skill '{skill_name}'", field="skill")
    _refuse_if_unmanageable(skill_name, skill_cfg)

    name = getattr(args, "item", None)
    if not name or not str(name).strip():
        _set_fail("--item is required (the new hook's name)", field="hooks")
    name = str(name).strip()

    # §6.3a — the FULL HOOK_NAME_TAKEN set, no carve-out: this verb only ever
    # creates, so a name already declared (inline or ref) or already a
    # hooks-library definition (registry or built-in) is refused outright,
    # before any file is written.
    taken = _hook_name_taken(registry, skill_name)
    if name in taken:
        _set_fail(
            f"'{name}' is already declared, or is already a hooks-library "
            f"definition — reference it instead: hub skill companions add "
            f"--kind hook --item {name}",
            field=f"hooks[{name}]",
        )

    event = getattr(args, "event", None)
    if event not in tool_catalog.CANONICAL_EVENTS:
        _set_fail(f"unknown event '{event}'", field=f"hooks[{name}].event")

    from skill_hub.domain.skills import ships_with

    command = getattr(args, "hook_command", None)
    if not command:
        command = ships_with.default_hook_script_rel(name)
        if not command:
            _set_fail(
                f"could not derive a script path for '{name}' — pass --command",
                field=f"hooks[{name}].command",
            )

    activation = getattr(args, "activation", None) or "while-running"
    if activation not in ships_with.ACTIVATIONS:
        _set_fail(
            f"--activation must be one of {ships_with.ACTIVATIONS}",
            field=f"hooks[{name}].activation",
        )

    tools_raw = getattr(args, "tools", None)
    tools = [t.strip() for t in tools_raw.split(",") if t.strip()] if tools_raw else None

    hook_entry: dict = {"name": name, "event": event, "command": command, "activation": activation}
    if tools:
        hook_entry["tools"] = tools
    if not getattr(args, "no_scaffold", False):
        hook_entry["scaffold"] = {"template": "python3" if str(command).endswith(".py") else "bash"}

    body = _current_body(skill_name, registry)
    body["hooks"].append(hook_entry)
    _apply_set_body(registry, skill_name, skill_cfg, body,
                    operation_context=operation_context)


# ─────────────────────────────────────────────────────────────────────────────
# I9/A20 — `hub skill companions resolve <skill> --agent <n> --op ...`
# ─────────────────────────────────────────────────────────────────────────────


@registry_mutation("companions-resolve")
def cmd_companions_resolve(args):
    """`hub skill companions resolve <skill> --agent <n> --op
    keep-mine|keep-skill [--project <p> | --global]` (A20/C6). `keep-mine`
    re-records the on-disk hashes as the new baseline; `keep-skill` deletes
    the rendered twins (`link_action="both"`), re-renders through wave 1's
    `render_agent_payload`, re-links, and re-records — backup-first, every
    written harness at once. Never goes through `subagent_links.save_linked`
    (it refuses on drift and co-writes the surviving twin — precisely the
    collision this verb exists to resolve)."""
    from skill_hub.application.skills import ships_with_reconcile as swr
    from skill_hub.domain.skills import ships_with, skill_meta
    from skill_hub.infrastructure.harnesses import subagent_links, subagents

    registry = hub_core.load_registry()
    operation_context = _operation_context_for_args(args, registry)
    skill_name = args.name
    agent_name = getattr(args, "agent", None)
    op = getattr(args, "op", None)
    if not agent_name:
        fail("--agent is required")
    if op not in ("keep-mine", "keep-skill"):
        fail("--op must be keep-mine or keep-skill")

    project = getattr(args, "project", None)
    is_global = bool(getattr(args, "global_", False))
    if bool(project) == bool(is_global):
        fail("pass exactly one of --project <p> or --global")

    skill_cfg = (registry.get("skills") or {}).get(skill_name)
    if not isinstance(skill_cfg, dict):
        fail(f"unknown skill '{skill_name}'")

    if is_global:
        container = registry.setdefault("companions_global", {})
    else:
        projects = registry.get("projects") or {}
        if project not in projects:
            fail(f"unknown project '{project}'")
        container = projects[project].setdefault("companions", {})

    entry = container.get(skill_name)
    if not isinstance(entry, dict):
        fail(f"no companions ledger entry for '{skill_name}'")
    a_state = ships_with.agent_state(entry, agent_name)
    files = dict(a_state.get("files") or {})
    written_harnesses = sorted(hid for hid, f in files.items() if f.get("written"))
    if not written_harnesses:
        fail(f"'{agent_name}' has no hub-written files to resolve")

    skill_dir = skill_meta.skill_source(skill_cfg)
    origin = a_state.get("origin", "skill")

    if op == "keep-mine":
        new_files = dict(files)
        for hid in written_harnesses:
            found = subagents._find_agent_file(agent_name, "user", None, registry, hid,
                                               context=operation_context)
            if found is not None:
                new_files[hid] = {"sha256": swr.agent_file_sha256(found), "written": True}
        source_sha = swr.agent_file_sha256(skill_dir / "agents" / f"{agent_name}.md")
        entry.setdefault("agent_state", {})[agent_name] = {
            "origin": origin, "source_sha256": source_sha, "files": new_files,
        }
    else:
        # A25 (review R5) — `link_action="both"` deletes every harness the
        # LINK SIDECAR tracks, not every harness THIS ledger wrote; only safe
        # when every linked harness is also one of `written_harnesses` (else
        # it would delete a twin hub never provisioned, with no restore).
        link = subagent_links.find_link(agent_name, "user", context=operation_context)
        link_harnesses = set((link or {}).get("harnesses") or [])
        if link_harnesses and link_harnesses.issubset(set(written_harnesses)):
            subagents.delete_agent(
                agent_name, "user", None, registry,
                harness_id=written_harnesses[0], link_action="both",
                context=operation_context,
            )
        else:
            for hid in written_harnesses:
                subagents.delete_agent(
                agent_name, "user", None, registry, harness_id=hid, link_action="this",
                context=operation_context,
                )
        new_files = {}
        for hid in written_harnesses:
            payload = ships_with.render_agent_payload(skill_name, agent_name, hid, registry, rerender=False)
            res = subagents.save_agent(payload, registry, context=operation_context)
            if not res.get("ok"):
                fail(f"failed re-rendering '{agent_name}' for '{hid}': {res.get('errors')}")
            new_files[hid] = {"sha256": swr.agent_file_sha256(Path(res["file"])), "written": True}
        if len(written_harnesses) >= 2 and subagent_links.find_link(
                agent_name, scope="user", context=operation_context) is None:
            present = all(
                subagents._find_agent_file(agent_name, "user", None, registry, hid,
                                           context=operation_context) is not None
                for hid in written_harnesses
            )
            if present:
                subagent_links.link_agents(
                    agent_name, written_harnesses, scope="user", registry=registry,
                    context=operation_context)
        source_sha = swr.agent_file_sha256(skill_dir / "agents" / f"{agent_name}.md")
        entry.setdefault("agent_state", {})[agent_name] = {
            "origin": origin, "source_sha256": source_sha, "files": new_files,
        }

    hub_core.save_registry(registry)
    payload = {"ok": True, "agent": agent_name, "op": op, "harnesses": written_harnesses}
    if getattr(args, "json", False):
        print(json.dumps(payload, separators=(",", ":")))
    else:
        print(f"{c('✓', GREEN)} resolved '{agent_name}' ({op}) — harnesses: {', '.join(written_harnesses)}")


# ─────────────────────────────────────────────────────────────────────────────
# CliOps — the real ships_with_reconcile.Ops implementation
# ─────────────────────────────────────────────────────────────────────────────


class CliOps:
    """The real `ships_with_reconcile.Ops` implementation, over
    `skill_hub.entrypoints.cli.hook` / `skill_hub.entrypoints.cli.permissions` / `subagents`. `ships_with_reconcile`
    never imports these itself (leaf posture, W14) — this is the one wiring
    point."""

    def __init__(self, operation_context: Any = None) -> None:
        self.operation_context = operation_context

    def hook_update(self, registry: dict, name: str, **fields: Any) -> None:
        ctx = fields.pop("operation_context", None) or self.operation_context
        if ctx is not None:
            fields["operation_context"] = ctx
        _hook_update(registry, name, **fields)

    def hook_attach(
        self, registry: dict, name: str, *, scope_global: bool, proj_name: Optional[str],
        operation_context: Any = None
    ) -> bool:
        ctx = operation_context or self.operation_context
        if ctx is None:
            return _hook_attach(registry, name, scope_global=scope_global, proj_name=proj_name)
        return _hook_attach(registry, name, scope_global=scope_global, proj_name=proj_name,
                            operation_context=ctx)

    def hook_detach(
        self, registry: dict, name: str, *, scope_global: bool, proj_name: Optional[str],
        operation_context: Any = None
    ) -> bool:
        ctx = operation_context or self.operation_context
        if ctx is None:
            return _hook_detach(registry, name, scope_global=scope_global, proj_name=proj_name)
        return _hook_detach(registry, name, scope_global=scope_global, proj_name=proj_name,
                            operation_context=ctx)

    def perm_block(self, registry: dict, scope: str, project: Optional[str],
                   *, operation_context: Any = None) -> dict:
        # R25 — `skill_hub.entrypoints.cli.permissions` itself imports a slice (`skill_hub.entrypoints.cli.hook`),
        # so this module keeps that import function-scoped rather than at
        # module scope (the `hub_cli/__init__.py` contract's slice→slice rule
        # is "only while the imported slice imports no slice itself").
        from skill_hub.entrypoints.cli.permissions import _get_perm_block

        return _get_perm_block(registry, scope, project)

    def delete_agent(
        self, name: str, harness: str, registry: dict, *, link_action: str = "this",
        operation_context: Any = None
    ) -> dict:
        from skill_hub.infrastructure.harnesses import subagents

        return subagents.delete_agent(
            name, "user", None, registry, harness_id=harness, link_action=link_action,
            context=operation_context or self.operation_context
        )

    def rerender_agent(self, skill: str, agent: str, registry: dict, scope: str,
                       *, operation_context: Any = None) -> dict:
        from skill_hub.domain.skills import ships_with
        from skill_hub.infrastructure.harnesses import subagents

        project = None if scope == ships_with.GLOBAL_SCOPE else scope
        entry = ships_with.ledger_container(registry, project).get(skill) or {}
        a_state = ships_with.agent_state(entry, agent)
        for hid, f in (a_state.get("files") or {}).items():
            if not f.get("written"):
                continue
            payload = ships_with.render_agent_payload(skill, agent, hid, registry, rerender=True)
            subagents.save_agent(payload, registry, context=operation_context or self.operation_context)
        return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# A16 — the sync-time reconcile pass wiring (`hub.py`'s `_cmd_sync_body`)
# ─────────────────────────────────────────────────────────────────────────────


def _empty_scope_report() -> dict:
    return {
        "pending": [], "stale_removed": [], "reattached": [], "drift": [],
        "missing_refs": [], "backfilled": [], "kept": [], "errors": [], "skipped": None,
    }


def _skipped_report(scope_report: Optional[dict], label: str) -> dict:
    src = scope_report or {}
    return {
        "pending": list(src.get("pending") or []),
        "stale_removed": [],
        "reattached": [],
        "drift": list(src.get("drift") or []),
        "missing_refs": list(src.get("missing_refs") or []),
        "backfilled": [],
        "kept": [],
        "errors": [],
        "skipped": label,
    }


def run_reconcile_pass(
    registry: dict,
    *,
    report: Optional[dict] = None,
    skip_hooks: bool = False,
    skip_permissions: bool = False,
    skills: Optional[list[str]] = None,
    operation_context: Any = None,
) -> dict:
    """Plan + apply one `ships_with` reconcile pass (D11). W8 — under EITHER
    `--skip-hooks` or `--skip-permissions` this still PLANS (pending/drift/
    missing_refs are read-only and always reported) but applies NO ops
    (nothing detached, nothing re-attached, nothing deleted) and records
    `skipped: "hooks"|"permissions"`.

    When `report` (a `hub sync` accumulator) is given, folds each scope's I7
    record into `report["global"]["companions"]` / `report["projects"][<p>]
    ["companions"]` (A16) — EVERY registered project gets one, via
    `setdefault(hub.new_project_report())`, even one `plan_reconcile` never
    walked (nothing declared there)."""
    from skill_hub.application.skills import ships_with_reconcile as swr

    plan = swr.plan_reconcile(registry, skills=skills, context=operation_context)
    if skip_hooks or skip_permissions:
        label = "hooks" if skip_hooks else "permissions"
        result = {
            "global": _skipped_report(plan.get("global"), label),
            "projects": {
                p: _skipped_report(r, label) for p, r in (plan.get("projects") or {}).items()
            },
        }
    else:
        result = swr.apply_reconcile(registry, plan, CliOps(operation_context),
                                     context=operation_context)

    if report is not None:
        import hub

        report["global"]["companions"] = result["global"]
        for p in (registry.get("projects") or {}).keys():
            rec = result["projects"].get(p) or _empty_scope_report()
            proj_report = report["projects"].setdefault(p, hub.new_project_report())
            proj_report["companions"] = rec
    return result
