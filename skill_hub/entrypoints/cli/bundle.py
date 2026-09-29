"""`hub bundle` — manage skill bundles (list/apply/remove/new/update/rename/delete).

Registry I/O goes through the `hub_core.` module attribute (`hub_core.load_registry()`
/ `hub_core.save_registry()`), never a copied name — a test's
`monkeypatch.setattr(hub, "save_registry", ...)` forwards onto `hub_core.save_registry`
(see `hub.py`'s `_HubFacade.__setattr__`), and only a call through the module
attribute observes that forward; a name copied in at import time
(`from skill_hub.hub_core import save_registry`) would keep the stale pre-patch binding.

It follows the `hub_cli` contract for monolith symbols: `import hub` as the first
statement of a function and `hub.<name>` for anything still defined there
(`_auto_sync`, `_auto_sync_tail`, `_cloud_targets_equipping`, `_prune_cloud_equip`,
`_missing_refs_hint_for`, `_print_missing_refs_hint`, `builtin_source_entries`,
`reconcile_bundle_membership`).

Carved out of `hub.py` (S5 slice D) — see `hub_cli/__init__.py` for the module
contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import json
import sys

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    SLUG_RE,
    VALID_BUNDLE_SCOPES,
    YELLOW,
    bundle_scope,
    c,
    data_home_lock,
    fail,
    parse_bundle_scope,
    parse_csv,
    registry_mutation,
    validate_slug,
)

NAME = "bundle"

p_bundle = None


def register(sub) -> None:
    global p_bundle

    # bundle
    p_bundle = sub.add_parser("bundle", help="Manage skill bundles")
    bundle_sub = p_bundle.add_subparsers(dest="bundle_cmd")
    bundle_sub.add_parser("list", help="List all bundles")
    p_ba = bundle_sub.add_parser("apply", help="Assign a bundle to a project")
    p_ba.add_argument("bundle_name", help="Bundle name")
    p_ba.add_argument("--project", "-p", required=True, help="Project name")
    p_br = bundle_sub.add_parser(
        "remove", help="Remove a bundle assignment from a project"
    )
    p_br.add_argument("bundle_name", help="Bundle name")
    p_br.add_argument("--project", "-p", required=True, help="Project name")
    p_bn = bundle_sub.add_parser("new", help="Create a new bundle")
    p_bn.add_argument("bundle_name", help="Bundle name")
    p_bn.add_argument("--skills", required=True, help="Comma-separated skill names")
    p_bn.add_argument("--description", help="Bundle description")
    p_bn.add_argument("--icon", help="Bundle icon")
    p_bn.add_argument(
        "--scope", choices=sorted(VALID_BUNDLE_SCOPES), help="Bundle scope"
    )
    p_bn.add_argument(
        "--source",
        help="Follow a configured source: syncing it manages this bundle's skills",
    )
    p_bn.add_argument(
        "--playbook",
        help="Playbook sections as a JSON array (use [] to clear)",
    )
    p_bn.add_argument("--json", action="store_true", help="Emit JSON")
    p_bu = bundle_sub.add_parser("update", help="Update an existing bundle")
    p_bu.add_argument("bundle_name", help="Bundle name")
    p_bu.add_argument("--skills", help="Comma-separated skill names")
    p_bu.add_argument("--description", help="Bundle description")
    p_bu.add_argument("--icon", help="Bundle icon")
    p_bu.add_argument(
        "--scope", choices=sorted(VALID_BUNDLE_SCOPES), help="Bundle scope"
    )
    p_bu.add_argument(
        "--source",
        help="Link this bundle to a configured source and reconcile its skills now",
    )
    p_bu.add_argument(
        "--detach-source",
        action="store_true",
        help="Stop following the source; keep the current skills",
    )
    p_bu.add_argument(
        "--playbook",
        help="Playbook sections as a JSON array (use [] to clear)",
    )
    p_bu.add_argument("--json", action="store_true", help="Emit JSON")
    p_brn = bundle_sub.add_parser(
        "rename",
        help="Rename a bundle (membership and every project/remote/cloud reference follow)",
    )
    p_brn.add_argument("old_name", help="Current bundle name")
    p_brn.add_argument("new_name", help="New bundle name")
    p_brn.add_argument("--json", action="store_true", help="Emit JSON")
    p_bd = bundle_sub.add_parser(
        "delete", help="Delete a bundle (unassigns from all projects)"
    )
    p_bd.add_argument("bundle_name", help="Bundle name")
    p_bd.add_argument(
        "--dry-run", action="store_true", help="Print the plan without applying"
    )
    p_bd.add_argument("--json", action="store_true", help="Emit JSON")


def dispatch(args) -> None:
    cmd_bundle(args)


# ─────────────────────────────────────────────────────────────────────────────
# hub bundle
# ─────────────────────────────────────────────────────────────────────────────


def cmd_bundle(args):
    sub = getattr(args, "bundle_cmd", None)
    dispatch = {
        "list": cmd_bundle_list,
        "apply": cmd_bundle_apply,
        "remove": cmd_bundle_remove,
        "new": cmd_bundle_new,
        "update": cmd_bundle_update,
        "rename": cmd_bundle_rename,
        "delete": cmd_bundle_delete,
    }
    if sub in dispatch:
        dispatch[sub](args)
    else:
        print(
            "Usage: hub bundle {list|apply <name> --project <p>|remove <name> --project <p>|new <name> --skills s1,s2|rename <old> <new>|delete <name>}"  # noqa: E501
        )


def cmd_bundle_list(_args):
    registry = hub_core.load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    if not bundles:
        print(
            "No bundles defined. Create one with: hub bundle new <name> --skills skill1,skill2"
        )
        return

    # Build bundle → assigned projects map
    bundle_projects: dict[str, list[str]] = {name: [] for name in bundles}
    for proj_name, proj_cfg in projects.items():
        for b in proj_cfg.get("bundles", []):
            if b in bundle_projects:
                bundle_projects[b].append(proj_name)

    print(f"\n{c('Bundles:', BOLD)}")
    for name, cfg in bundles.items():
        bundle_skills = cfg.get("skills", [])
        icon = cfg.get("icon", "📦")
        desc = cfg.get("description", "")
        scope = bundle_scope(cfg)
        assigned = bundle_projects.get(name, [])
        assigned_str = (
            f"  {c('→', CYAN)} applies to all projects"
            if scope == "global"
            else (
                f"  {c('→', CYAN)} {', '.join(assigned)}"
                if assigned
                else f"  {c('(unassigned)', DIM)}"
            )
        )
        print(
            f"\n  {icon} {c(name, BOLD, CYAN)} [{scope}] — {desc} ({len(bundle_skills)} skills){assigned_str}"
        )
        for s in bundle_skills:
            print(f"    · {s}")
    print()


@registry_mutation("bundle-apply")
def cmd_bundle_apply(args):
    import hub

    registry = hub_core.load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    bundle_name = args.bundle_name

    if bundle_name not in bundles:
        print(f"Unknown bundle '{bundle_name}'. Run 'hub bundle list'.")
        sys.exit(1)

    if bundle_scope(bundles[bundle_name]) == "global":
        fail(
            f"Bundle '{bundle_name}' has scope 'global' and already applies everywhere. Manage its scope with 'hub bundle update {bundle_name} --scope project-specific'."  # noqa: E501
        )

    proj_name = getattr(args, "project", None)
    if not proj_name:
        print("Specify a project: hub bundle apply <bundle> --project <name>")
        sys.exit(1)

    if proj_name not in projects:
        print(f"Unknown project '{proj_name}'.")
        sys.exit(1)

    assigned = projects[proj_name].setdefault("bundles", [])
    if bundle_name in assigned:
        print(f"Bundle '{bundle_name}' already assigned to '{proj_name}'.")
        return

    assigned.append(bundle_name)
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} assigned bundle '{bundle_name}' to '{proj_name}'.")

    proj_cfg = projects[proj_name]
    skills = registry.get("skills", {})
    for member in bundles[bundle_name].get("skills") or []:
        member_cfg = skills.get(member)
        if not isinstance(member_cfg, dict):
            continue
        missing = hub._missing_refs_hint_for(member, member_cfg, proj_cfg, registry)
        if missing:
            hub._print_missing_refs_hint(member, proj_name, missing)

    hub._auto_sync_tail()


@registry_mutation("bundle-remove")
def cmd_bundle_remove(args):
    import hub

    registry = hub_core.load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    bundle_name = args.bundle_name

    if bundle_name not in bundles:
        print(f"Unknown bundle '{bundle_name}'. Run 'hub bundle list'.")
        sys.exit(1)

    if bundle_scope(bundles[bundle_name]) == "global":
        fail(
            f"Bundle '{bundle_name}' has scope 'global' and is not stored in project assignments. Manage its scope with 'hub bundle update {bundle_name} --scope project-specific'."  # noqa: E501
        )

    proj_name = getattr(args, "project", None)
    if not proj_name:
        print("Specify a project: hub bundle remove <bundle> --project <name>")
        sys.exit(1)

    if proj_name not in projects:
        print(f"Unknown project '{proj_name}'.")
        sys.exit(1)

    assigned = projects[proj_name].get("bundles", [])
    if bundle_name not in assigned:
        print(f"Bundle '{bundle_name}' is not assigned to '{proj_name}'.")
        return

    assigned.remove(bundle_name)
    projects[proj_name]["bundles"] = assigned
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} removed bundle '{bundle_name}' from '{proj_name}'.")

    hub._auto_sync()


def _bundle_view(name: str, cfg: dict) -> dict:
    """The `--json` projection of one bundle (see docs: source-linked bundles)."""
    view = {
        "name": name,
        "skills": list(cfg.get("skills") or []),
        "description": cfg.get("description"),
        "icon": cfg.get("icon"),
        "scope": bundle_scope(cfg),
        "source": cfg.get("source"),
    }
    # Preserve the legacy payload shape for bundles that predate playbooks;
    # an explicitly stored empty array still represents an intentional clear.
    if "playbook" in cfg:
        view["playbook"] = list(cfg.get("playbook") or [])
    return view


def _validate_playbook(args, value, members: list[str]) -> list[dict]:
    """Validate and copy a presentation-only bundle playbook."""
    if not isinstance(value, list):
        _bundle_fail(args, "--playbook must be a JSON array")
    seen_ids: set[str] = set()
    assigned: set[str] = set()
    normalized: list[dict] = []
    for section in value:
        if not isinstance(section, dict):
            _bundle_fail(args, "each playbook section must be an object")
        section_id = section.get("id")
        title = section.get("title")
        skills = section.get("skills")
        if not isinstance(section_id, str) or not section_id or len(section_id) > 100:
            _bundle_fail(
                args,
                "playbook section id must be a non-empty string of at most 100 characters",
            )
        if section_id in seen_ids:
            _bundle_fail(args, f"duplicate playbook section id '{section_id}'")
        seen_ids.add(section_id)
        if section_id == "unsectioned":
            if title != "":
                _bundle_fail(args, "playbook section 'unsectioned' must have an empty title")
        elif not isinstance(title, str) or not title.strip() or len(title) > 200:
            _bundle_fail(
                args,
                "named playbook section title must be a non-empty string of at most 200 characters",
            )
        if not isinstance(skills, list) or any(
            not isinstance(skill, str) or not skill for skill in skills
        ):
            _bundle_fail(args, "playbook section skills must be an array of non-empty strings")
        for skill in skills:
            if skill not in members:
                _bundle_fail(args, f"playbook skill '{skill}' is not a bundle member")
            if skill in assigned:
                _bundle_fail(args, f"playbook skill '{skill}' is assigned more than once")
            assigned.add(skill)
        item = {"id": section_id, "title": title, "skills": list(skills)}
        if "guidance" in section:
            guidance = section["guidance"]
            if guidance is not None and (not isinstance(guidance, str) or len(guidance) > 2000):
                _bundle_fail(args, "playbook guidance must be a string of at most 2000 characters")
            if guidance is not None:
                item["guidance"] = guidance
        normalized.append(item)
    return normalized


def _normalize_playbook_membership(playbook, members: list[str]) -> list[dict]:
    """Drop stale/duplicate refs after a bundle membership write."""
    if not isinstance(playbook, list):
        return []
    member_set = set(members)
    seen: set[str] = set()
    result: list[dict] = []
    loose: dict | None = None
    for raw in playbook:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            continue
        section = dict(raw)
        skills = []
        for skill in section.get("skills") or []:
            if isinstance(skill, str) and skill in member_set and skill not in seen:
                skills.append(skill)
                seen.add(skill)
        section["skills"] = skills
        if section["id"] == "unsectioned":
            section["title"] = ""
            loose = section
        else:
            result.append(section)
    if loose is None:
        loose = {"id": "unsectioned", "title": "", "skills": []}
    loose["skills"].extend(skill for skill in members if skill not in seen)
    result.append(loose)
    return result


def _bundle_fail(args, message: str, *, key: str = "bundle"):
    """Payload-first failure for `--json`; the plain-text error otherwise."""
    if getattr(args, "json", False):
        print(json.dumps({key: None, "errors": [message]}))
        sys.stdout.flush()
        sys.exit(1)
    fail(message)


def _bundle_validate_slug(args, name: str):
    if not SLUG_RE.match(name or ""):
        _bundle_fail(
            args,
            f"Invalid bundle name '{name}'. Use lowercase letters, numbers, and hyphens only.",
        )


def _bundle_validate_source(args, registry: dict, source_id: str):
    """A bundle may only follow a configured, non-builtin source."""
    import hub

    if source_id in hub.builtin_source_entries():
        _bundle_fail(
            args,
            f"source '{source_id}' is built-in; only a configured source can be followed",
        )
    sources = registry.get("sources") if isinstance(registry, dict) else None
    if not isinstance(sources, dict) or source_id not in sources:
        _bundle_fail(args, f"unknown source '{source_id}'")


def _bundle_link_warnings(
    registry: dict, name: str, source_id: str, requested: list
) -> list:
    """Warnings raised by linking `name` to `source_id`, AFTER reconciling.

    Two things a caller must not learn about only later, from a silent sync:
      * skills it explicitly asked for were dropped (the source doesn't own them);
      * the bundle is `scope: global`, so every future source sync silently
        changes what EVERY project gets.
    """
    bundles = registry.get("bundles") or {}
    bcfg = bundles.get(name) or {}
    final = list(bcfg.get("skills") or [])
    out: list = []
    dropped = [s for s in requested if s not in final]
    if dropped:
        # Only the DESTRUCTIVE half is a warning: skills gained from the source
        # are the point of linking and are already visible in the payload.
        out.append(
            f"bundle '{name}' follows source '{source_id}', so its skill list was "
            f"reconciled: dropped {dropped} (not owned by '{source_id}')"
        )
    if bundle_scope(bcfg) == "global":
        out.append(
            f"bundle '{name}' is scope 'global' AND follows source '{source_id}': "
            f"every source sync will add/remove skills for EVERY project"
        )
    return out


def _emit_bundle_warnings(args, warnings: list):
    """Print warnings without polluting the payload-first stdout contract."""
    for line in warnings:
        if getattr(args, "json", False):
            print(f"warning: {line}", file=sys.stderr)
        else:
            print(f"  {c('!', YELLOW)} {line}")


@registry_mutation("bundle-new")
def cmd_bundle_new(args):
    import hub

    registry = hub_core.load_registry()
    bundles = registry.setdefault("bundles", {})
    skills = registry.get("skills", {})
    name = args.bundle_name
    _bundle_validate_slug(args, name)

    if name in bundles:
        _bundle_fail(args, f"Bundle '{name}' already exists.")

    skill_list = parse_csv(args.skills)
    unknown = [s for s in skill_list if s not in skills]
    if unknown:
        _bundle_fail(args, f"Unknown skills for bundle '{name}': {', '.join(unknown)}")

    source_id = getattr(args, "source", None)
    if source_id:
        _bundle_validate_source(args, registry, source_id)

    scope = parse_bundle_scope(getattr(args, "scope", None))
    playbook_json = getattr(args, "playbook", None)
    playbook = None
    if playbook_json is not None:
        try:
            playbook = json.loads(playbook_json)
        except (TypeError, json.JSONDecodeError) as exc:
            _bundle_fail(args, f"invalid --playbook JSON: {exc}")
        playbook = _validate_playbook(args, playbook, skill_list)
    bundles[name] = {
        "description": getattr(args, "description", None) or f"Bundle: {name}",
        "icon": getattr(args, "icon", None) or "📦",
        "scope": scope,
        "skills": skill_list,
    }
    if playbook is not None:
        bundles[name]["playbook"] = playbook
    warnings: list = []
    if source_id:
        bundles[name]["source"] = source_id
        # Gate at creation, not at the first sync: a followed bundle IS its
        # source's skill list, so reconcile now and TELL the caller what moved
        # instead of silently rewriting their explicit choice later.
        hub.reconcile_bundle_membership(registry, name, source_id)
        warnings = _bundle_link_warnings(registry, name, source_id, skill_list)
    hub_core.save_registry(registry)

    final_skills = list(bundles[name].get("skills") or [])

    # Payload FIRST — the auto-sync tail writes chatter to the same stdout.
    if getattr(args, "json", False):
        print(
            json.dumps(
                {
                    "bundle": _bundle_view(name, bundles[name]),
                    "created": True,
                    "errors": [],
                    "warnings": warnings,
                }
            )
        )
        sys.stdout.flush()
    else:
        print(
            f"{c('✓', GREEN)} created bundle '{name}' with {len(final_skills)} skills [{scope}]"
        )
        if source_id:
            print(f"  ⇄ follows source '{source_id}'")
    _emit_bundle_warnings(args, warnings)

    hub._auto_sync()


@registry_mutation("bundle-update")
def cmd_bundle_update(args):
    import hub

    registry = hub_core.load_registry()
    bundles = registry.get("bundles", {})
    skills = registry.get("skills", {})
    name = args.bundle_name

    if name not in bundles:
        _bundle_fail(args, f"Unknown bundle '{name}'.")

    bundle = bundles[name]
    before = json.loads(json.dumps(bundle, default=str))
    was_linked = bundle.get("source")
    source_id = getattr(args, "source", None)
    detach = bool(getattr(args, "detach_source", False))
    playbook_json = getattr(args, "playbook", None)

    if source_id and detach:
        _bundle_fail(args, "--source and --detach-source are mutually exclusive")
    if args.skills is not None and source_id:
        _bundle_fail(
            args,
            "--skills cannot be combined with --source; the source manages the "
            "bundle's skill list",
        )
    if args.skills is not None and bundle.get("source") and not detach:
        _bundle_fail(
            args,
            f"bundle '{name}' follows source '{bundle['source']}' — its skill list "
            "is managed; use --detach-source first",
        )
    if source_id:
        _bundle_validate_source(args, registry, source_id)

    playbook = None
    if playbook_json is not None:
        try:
            playbook = json.loads(playbook_json)
        except (TypeError, json.JSONDecodeError) as exc:
            _bundle_fail(args, f"invalid --playbook JSON: {exc}")

    if detach:
        bundle.pop("source", None)
    if args.skills is not None:
        skill_list = parse_csv(args.skills)
        unknown = [s for s in skill_list if s not in skills]
        if unknown:
            _bundle_fail(
                args, f"Unknown skills for bundle '{name}': {', '.join(unknown)}"
            )
        bundle["skills"] = skill_list
        if playbook_json is None and "playbook" in bundle:
            bundle["playbook"] = _normalize_playbook_membership(bundle["playbook"], skill_list)
    if args.description is not None:
        bundle["description"] = args.description
    if args.icon is not None:
        bundle["icon"] = args.icon or "📦"
    if args.scope is not None:
        bundle["scope"] = parse_bundle_scope(args.scope)
    if playbook_json is not None:
        bundle["playbook"] = _validate_playbook(
            args, playbook, list(bundle.get("skills") or [])
        )

    bundles[name] = bundle
    registry["bundles"] = bundles

    # Linking takes effect immediately: the bundle becomes exactly what the
    # source owns (retained order preserved, new arrivals appended sorted).
    reconciled = None
    warnings: list = []
    if source_id:
        requested = list(bundle.get("skills") or [])
        bundle["source"] = source_id
        reconciled = hub.reconcile_bundle_membership(registry, name, source_id)
        warnings = _bundle_link_warnings(registry, name, source_id, requested)

    hub_core.save_registry(registry)
    changed = json.loads(json.dumps(bundle, default=str)) != before

    if getattr(args, "json", False):
        print(
            json.dumps(
                {
                    "bundle": _bundle_view(name, bundle),
                    "changed": changed,
                    "errors": [],
                    "warnings": warnings,
                }
            )
        )
        sys.stdout.flush()
    else:
        print(f"{c('✓', GREEN)} updated bundle '{name}'.")
        if source_id:
            print(f"  ⇄ follows source '{source_id}'")
            if reconciled:
                print(
                    f"  ⇄ membership: +{reconciled['added']} -{reconciled['removed']}"
                )
        if detach:
            if was_linked:
                print(
                    f"  ⇄ detached from source '{was_linked}'; membership is now manual"
                )
            else:
                print(f"  ⇄ bundle '{name}' was not linked to a source; nothing to detach")
    _emit_bundle_warnings(args, warnings)

    layout_only = (
        playbook_json is not None
        and args.skills is None
        and source_id is None
        and not detach
        and args.description is None
        and args.icon is None
        and args.scope is None
    )
    if not layout_only:
        hub._auto_sync()


@registry_mutation("bundle-rename")
def cmd_bundle_rename(args):
    import hub

    """Rename a bundle. The `bundles:` block and its position are unchanged
    apart from the key; every `projects.<n>.bundles` / `remotes.<r>.bundles`
    / `cloud.<c>.bundles` reference follows. A linked (source-following)
    bundle renames the same way — membership is untouched."""
    registry = hub_core.load_registry()
    bundles = registry.get("bundles", {})
    old_name = args.old_name
    new_name = args.new_name

    if old_name not in bundles:
        fail(f"Unknown bundle '{old_name}'.")
    validate_slug(new_name, label="bundle name")
    if new_name == old_name:
        print(f"Bundle '{old_name}' already has that name.")
        return
    if new_name in bundles:
        fail(f"Bundle '{new_name}' already exists.")

    with data_home_lock():
        registry["bundles"] = {
            (new_name if k == old_name else k): v for k, v in bundles.items()
        }
        sites = hub._prune_bundle_references(registry, old_name, replacement=new_name)
        hub_core.save_registry(registry)

    # Payload FIRST — the auto-sync tail writes chatter to the same stdout.
    payload = {
        "renamed": {"from": old_name, "to": new_name},
        "projects": sites.get("projects", []),
        "remotes": sites.get("remotes", []),
        "cloud": sites.get("cloud", []),
    }
    if getattr(args, "json", False):
        print(json.dumps(payload))
        sys.stdout.flush()
    else:
        for site in ("projects", "remotes", "cloud"):
            for key in sites.get(site, []):
                print(
                    f"  {c('→', CYAN)} updated {hub._BUNDLE_REFERENCE_SITE_LABELS[site]} "
                    f"{key}: {old_name} → {new_name}"
                )
        print(f"{c('✓', GREEN)} renamed bundle '{old_name}' → '{new_name}'")

    hub._auto_sync()


@registry_mutation("bundle-delete")
def cmd_bundle_delete(args):
    import hub

    registry = hub_core.load_registry()
    bundles = registry.get("bundles", {})
    projects = registry.get("projects", {})
    name = args.bundle_name

    if name not in bundles:
        _bundle_fail(args, f"Unknown bundle '{name}'.", key="deleted")

    if getattr(args, "dry_run", False):
        would_affect = [p for p, pc in projects.items() if name in (pc.get("bundles") or [])]
        if getattr(args, "json", False):
            print(
                json.dumps(
                    {
                        "deleted": None,
                        "dry_run": True,
                        "would_unassign": would_affect,
                        "errors": [],
                    }
                )
            )
            return
        print(f"{c('DRY-RUN', YELLOW)} delete bundle '{name}' (no changes made):")
        if would_affect:
            print(f"  would unassign from: {', '.join(would_affect)}")
        clouds = hub._cloud_targets_equipping(registry, "bundles", name)
        if clouds:
            print(f"  would unequip from cloud targets: {', '.join(clouds)}")
        print(f"  would remove bundle '{name}' from registry")
        return

    # Remove from all project bundle assignments
    affected = []
    for proj_name, proj_cfg in projects.items():
        assigned = proj_cfg.get("bundles", [])
        if name in assigned:
            assigned.remove(name)
            proj_cfg["bundles"] = assigned
            affected.append(proj_name)

    # …and from every cloud target's, which equips by the same model.
    cloud_affected = hub._prune_cloud_equip(registry, "bundles", name)

    del bundles[name]
    registry["bundles"] = bundles
    hub_core.save_registry(registry)

    if getattr(args, "json", False):
        # Payload first (single line, flushed); everything after is chatter.
        print(json.dumps({"deleted": name, "errors": []}))
        sys.stdout.flush()
        if cloud_affected:
            print(
                f"  {c('✗', RED)} unequipped from cloud targets: "
                f"{', '.join(cloud_affected)}"
            )
        if affected:
            hub._auto_sync()
        return

    if cloud_affected:
        print(
            f"  {c('✗', RED)} unequipped from cloud targets: "
            f"{', '.join(cloud_affected)}"
        )

    if affected:
        print(
            f"{c('✓', GREEN)} deleted bundle '{name}' (unassigned from: {', '.join(affected)})"
        )

        hub._auto_sync()
    else:
        print(f"{c('✓', GREEN)} deleted bundle '{name}'")
