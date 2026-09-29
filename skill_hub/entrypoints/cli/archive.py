"""`hub archive` / `hub unarchive` — the sidecar-backed undo path.

Archiving a skill has to leave nothing dangling: it walks every registry site
that can hold a skill name (bundles, project `enabled`, invocation overrides,
remotes, cloud targets) and prunes it there too, while writing an undo
sidecar (`<data_home>/state/archive/<name>.json`) *before* moving anything on
disk, so a crash mid-batch never strands a moved directory with no record
pointing at it. `hub unarchive` reads that sidecar back and reverses both the
move and every reference-site removal.

The bundle-side twins (`_bundle_reference_sites`, `_prune_bundle_references`,
`_BUNDLE_REFERENCE_SITE_LABELS`) and the cloud-equip helpers
(`_cloud_targets_equipping`, `_prune_cloud_equip`) moved here as siblings of
the skill-side ones even though their callers (`hub bundle delete/rename` in
`hub.py` and `hub_cli/bundle.py`) stayed behind and reach them through
`hub.py`'s re-export. That gives each helper two live bindings: a test that
stubs `hub.<name>` reaches the stay-behind callers, a stub on
`skill_hub.entrypoints.cli.archive.<name>` reaches archive/unarchive.

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`). Monolith symbols still
defined in `hub.py` (`hub_skills_dir`, `remove_symlink`, `skill_source`,
`_auto_sync`, `_warn_links_left_in_place`) are reached via a function-local
`import hub` + `hub.<name>()`, per the contract's monkeypatch guarantee.
Registry I/O goes through the `hub_core.` module attribute so a test's
`monkeypatch.setattr(hub, "save_registry", ...)` is still observed.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.hub_core import (
    GREEN,
    RED,
    SLUG_RE,
    YELLOW,
    _now_iso,
    c,
    data_home,
    expand,
    registry_mutation,
    validate_slug,
)
from skill_hub.infrastructure.mcp import mcp_probe

NAME = "archive"

p_archive = None


def register(sub) -> None:
    global p_archive

    # archive
    p_archive = sub.add_parser(
        "archive", help="Archive one or more skills (removes from registry, moves files)"
    )
    p_archive.add_argument(
        "skills", nargs="+", help="Skill name(s) to archive"
    )
    p_archive.add_argument(
        "--dry-run", action="store_true", help="Print the plan without applying"
    )
    p_archive.add_argument("--json", action="store_true", help="Emit JSON")


def dispatch(args) -> None:
    cmd_archive(args)


# ─────────────────────────────────────────────────────────────────────────────
# hub archive
# ─────────────────────────────────────────────────────────────────────────────


def _cloud_targets_equipping(registry: dict, field_name: str, name: str) -> list[str]:
    """Cloud target ids whose `bundles`/`enabled` list holds `name` (dry-run)."""
    cloud_block = registry.get("cloud")
    if not isinstance(cloud_block, dict):
        return []
    return sorted(
        target_id
        for target_id, entry in cloud_block.items()
        if isinstance(entry, dict)
        and isinstance(entry.get(field_name), list)
        and name in entry[field_name]
    )


def _prune_cloud_equip(registry: dict, field_name: str, name: str) -> list[str]:
    """Drop `name` from every cloud target's `bundles`/`enabled` list, in place.

    Deleting a skill or a bundle already prunes it from every project; the
    `cloud:` block is the same equip model and was simply missed, so an archived
    skill stayed equipped on claude.ai forever — reported as `unsupported`
    ("not in the registry any more") on every status, unremovable from the UI.
    Returns the target ids that changed, for the caller's output.
    """
    cloud_block = registry.get("cloud")
    if not isinstance(cloud_block, dict):
        return []
    touched: list[str] = []
    for target_id, entry in cloud_block.items():
        if not isinstance(entry, dict):
            continue
        current = entry.get(field_name)
        if isinstance(current, list) and name in current:
            entry[field_name] = [x for x in current if x != name]
            touched.append(target_id)
    return sorted(touched)


def _skill_reference_sites(registry: dict, name: str) -> dict[str, list[str]]:
    """Every registry list/map that can hold a skill NAME, grouped by site.

    The sites are the equip model's four holders plus the per-project override
    map plus the ships_with ownership ledger: `bundles.<b>.skills`,
    `projects.<p>.enabled`, `projects.<p>.invocation_overrides`,
    `projects.<p>.companions` (D4 — keyed by skill name), `companions_global`
    (A17's global-scope twin, keyed by skill name directly — no per-project
    breakdown, so a hit is reported under the single sentinel key
    `ships_with.GLOBAL_SCOPE`), `remotes.<r>.enabled`, `cloud.<c>.enabled`.
    Archive/rename must visit ALL of them — a skill left behind in a bundle
    (especially a `scope: global` one) fails validation on every sync as
    `unknown skill` with no UI path to remove it, and a skill left behind in
    a companions ledger (project OR global) orphans its hooks/agents/rules
    with nothing left to blame them on.
    """
    from skill_hub.domain.skills import ships_with

    out: dict[str, list[str]] = {}

    def _scan(site: str, block, field: str, is_map: bool = False):
        if not isinstance(block, dict):
            return
        hits = []
        for key, entry in block.items():
            if not isinstance(entry, dict):
                continue
            holder = entry.get(field)
            if is_map:
                if isinstance(holder, dict) and name in holder:
                    hits.append(key)
            elif isinstance(holder, list) and name in holder:
                hits.append(key)
        if hits:
            out[site] = sorted(hits)

    _scan("bundles", registry.get("bundles"), "skills")
    _scan("projects", registry.get("projects"), "enabled")
    _scan("invocation_overrides", registry.get("projects"), "invocation_overrides", is_map=True)
    _scan("companions", registry.get("projects"), "companions", is_map=True)
    comp_global = registry.get("companions_global")
    if isinstance(comp_global, dict) and name in comp_global:
        out["companions_global"] = [ships_with.GLOBAL_SCOPE]
    _scan("remotes", registry.get("remotes"), "enabled")
    _scan("cloud", registry.get("cloud"), "enabled")
    return out


def _prune_skill_references(
    registry: dict, name: str, replacement: Optional[str] = None
) -> dict[str, list[str]]:
    """Drop (or, with `replacement`, rename) every reference to skill `name`
    across the sites listed by `_skill_reference_sites`, in place.

    Invocation overrides are always DROPPED on rename as well: an override is
    keyed by the skill and re-keying it silently would carry a per-project
    policy onto what the user may consider a different skill.

    The companions ledger (D4) is handled differently depending on which
    caller this is: on ARCHIVE (`replacement is None`) the skill is going
    away entirely, so its companions are fully DEPROVISIONED first (hooks
    detached/deleted, permission rules removed, agents refcounted) via
    `skill_hub.entrypoints.cli.skill._remove_companions` — a plain dict-key drop would strand
    hooks/agents with no ledger to reclaim them. On RENAME the ledger entry
    is simply RE-KEYED (`old_name` -> `replacement`); the hook `command`
    path re-bake (the skill dir may have moved) is the rename caller's own
    job, since only it knows the moved path.
    Returns the touched keys per site, for the caller's output.
    """
    sites = _skill_reference_sites(registry, name)

    def _rewrite(lst: list) -> list:
        if replacement is None:
            return [x for x in lst if x != name]
        return [replacement if x == name else x for x in lst]

    for b in sites.get("bundles", []):
        bundle = registry["bundles"][b]
        bundle["skills"] = _rewrite(bundle["skills"])
        playbook = bundle.get("playbook")
        if isinstance(playbook, list):
            for section in playbook:
                if not isinstance(section, dict) or not isinstance(
                    section.get("skills"), list
                ):
                    continue
                section["skills"] = _rewrite(section["skills"])
    for p in sites.get("projects", []):
        registry["projects"][p]["enabled"] = _rewrite(registry["projects"][p]["enabled"])
    for p in sites.get("invocation_overrides", []):
        del registry["projects"][p]["invocation_overrides"][name]
    for p in sites.get("companions", []):
        comp = registry["projects"][p].get("companions") or {}
        if replacement is None:
            import skill_hub.entrypoints.cli.skill as _skill_cli

            _skill_cli._remove_companions(registry, name, p)
        elif name in comp:
            comp[replacement] = comp.pop(name)
    if sites.get("companions_global"):
        # R6 (A17) — the global-scope twin of the per-project loop above:
        # `project=None` routes `_remove_companions` at the same
        # `companions_global`/`hooks_global`/`permissions_global` teardown
        # `hub disable <skill> --global` uses.
        if replacement is None:
            import skill_hub.entrypoints.cli.skill as _skill_cli

            _skill_cli._remove_companions(registry, name, None)
        else:
            comp_g = registry.get("companions_global") or {}
            if name in comp_g:
                comp_g[replacement] = comp_g.pop(name)
    for r in sites.get("remotes", []):
        registry["remotes"][r]["enabled"] = _rewrite(registry["remotes"][r]["enabled"])
    for t in sites.get("cloud", []):
        registry["cloud"][t]["enabled"] = _rewrite(registry["cloud"][t]["enabled"])
    return sites


_REFERENCE_SITE_LABELS = {
    "bundles": "bundles",
    "projects": "projects",
    "invocation_overrides": "invocation overrides",
    "companions": "companion ledgers",
    "companions_global": "global companion ledger",
    "remotes": "remotes",
    "cloud": "cloud targets",
}


def _bundle_reference_sites(registry: dict, name: str) -> dict[str, list[str]]:
    """Every registry list that can hold a bundle NAME, grouped by site.

    A bundle is equipped the same way a skill is: `projects.<p>.bundles`,
    `remotes.<r>.bundles`, `cloud.<c>.bundles`. Unlike skills there is no
    invocation-override map keyed by bundle name. `hub bundle rename` must
    visit all three sites so a renamed bundle keeps its equip state instead
    of quietly becoming an "unknown bundle" reference.
    """
    out: dict[str, list[str]] = {}

    def _scan(site: str, block):
        if not isinstance(block, dict):
            return
        hits = []
        for key, entry in block.items():
            if not isinstance(entry, dict):
                continue
            holder = entry.get("bundles")
            if isinstance(holder, list) and name in holder:
                hits.append(key)
        if hits:
            out[site] = sorted(hits)

    _scan("projects", registry.get("projects"))
    _scan("remotes", registry.get("remotes"))
    _scan("cloud", registry.get("cloud"))
    return out


def _prune_bundle_references(
    registry: dict, name: str, replacement: Optional[str] = None
) -> dict[str, list[str]]:
    """Drop (or, with `replacement`, rename) every reference to bundle `name`
    across the sites listed by `_bundle_reference_sites`, in place.

    Only lists of strings are rewritten — a hand-edited non-list `bundles:`
    value is left untouched rather than crashed on (mirrors the tolerance
    `_bundle_reference_sites` already applies when scanning).
    Returns the touched keys per site, for the caller's output.
    """
    sites = _bundle_reference_sites(registry, name)

    def _rewrite(lst: list) -> list:
        if replacement is None:
            return [x for x in lst if x != name]
        return [replacement if x == name else x for x in lst]

    for p in sites.get("projects", []):
        registry["projects"][p]["bundles"] = _rewrite(registry["projects"][p]["bundles"])
    for r in sites.get("remotes", []):
        registry["remotes"][r]["bundles"] = _rewrite(registry["remotes"][r]["bundles"])
    for t in sites.get("cloud", []):
        registry["cloud"][t]["bundles"] = _rewrite(registry["cloud"][t]["bundles"])
    return sites


_BUNDLE_REFERENCE_SITE_LABELS = {
    "projects": "projects",
    "remotes": "remotes",
    "cloud": "cloud targets",
}


def _archive_sidecar_dir() -> Path:
    return data_home() / "state" / "archive"


def _archive_sidecar_path(name: str) -> Path:
    return _archive_sidecar_dir() / f"{name}.json"


def _path_within_data_home(path: Path) -> bool:
    """True iff `path` resolves inside `data_home()`.

    Used to confine two things that ultimately come from user-editable text:
    a skill NAME used to build `_archive_sidecar_path` (defense in depth —
    `validate_slug` already rejects anything with a `/` before this is ever
    called), and — the real attack surface — a `moved_to` / restore
    destination read back out of an archive sidecar's JSON body. That JSON is
    hub-written, but a corrupted or hand-edited file is not a hypothetical:
    `hub unarchive` must never `shutil.move` from or to a path outside the
    data home just because some JSON file said so.
    """
    try:
        return path.resolve().is_relative_to(data_home().resolve())
    except (OSError, RuntimeError):
        return False


def _capture_skill_references(registry: dict, name: str) -> dict:
    """Every reference site holding `name`, in the shape the archive sidecar
    (and `hub unarchive`) needs to restore it exactly.

    Derived from `_skill_reference_sites` — the same site enumeration
    `_prune_skill_references` deletes from — rather than re-scanning the
    registry independently, so a future sixth holder added there is captured
    automatically instead of silently only being pruned. The extra structure
    a plain list can't carry — a bundle's list INDEX (so re-insertion lands
    back in the same spot) and an invocation override's MODE value — is
    layered on top for the two sites that need it.

    W-2: `companions` (D4 ledger entries, project AND global) is captured
    for the RECORD — `hub unarchive` reports what was lost, it does not
    re-provision it. A ledger entry names hooks/agents that were just
    deprovisioned (files deleted, definitions dropped where unclaimed
    elsewhere); resurrecting it verbatim would silently point at nothing.
    `_restore_skill_references` returns the project names left with
    un-restored companions instead (`companions_global` is reported the
    same way, under the `ships_with.GLOBAL_SCOPE` sentinel).
    """
    import copy

    from skill_hub.domain.skills import ships_with

    sites = _skill_reference_sites(registry, name)
    playbook_refs: dict = {}
    out: dict = {
        "bundles": {},
        "projects": list(sites.get("projects", [])),
        "invocation_overrides": {},
        "companions": {},
        "companions_global": {},
        "remotes": list(sites.get("remotes", [])),
        "cloud": list(sites.get("cloud", [])),
    }
    bundles_block = registry.get("bundles") if isinstance(registry, dict) else None
    for bname in sites.get("bundles", []):
        bcfg = bundles_block.get(bname) if isinstance(bundles_block, dict) else None
        skills_list = (bcfg or {}).get("skills") or []
        if name in skills_list:
            out["bundles"][bname] = skills_list.index(name)
        playbook = bcfg.get("playbook") if isinstance(bcfg, dict) else None
        if isinstance(playbook, list):
            for section_index, section in enumerate(playbook):
                if not isinstance(section, dict) or name not in (
                    section.get("skills") or []
                ):
                    continue
                playbook_refs.setdefault(bname, []).append(
                    {
                        "section_id": section.get("id"),
                        "section": section_index,
                        "index": section["skills"].index(name),
                    }
                )
    if playbook_refs:
        out["playbook"] = playbook_refs
    projects_block = registry.get("projects") if isinstance(registry, dict) else None
    for pname in sites.get("invocation_overrides", []):
        pcfg = projects_block.get(pname) if isinstance(projects_block, dict) else None
        overrides = (pcfg or {}).get("invocation_overrides") or {}
        if name in overrides:
            out["invocation_overrides"][pname] = overrides[name]
    for pname in sites.get("companions", []):
        pcfg = projects_block.get(pname) if isinstance(projects_block, dict) else None
        if isinstance(pcfg, dict):
            entry = ships_with.ledger_entry(pcfg, name)
            if entry:
                out["companions"][pname] = copy.deepcopy(entry)
    if sites.get("companions_global"):
        entry = ships_with.global_ledger(registry).get(name)
        if entry:
            out["companions_global"][ships_with.GLOBAL_SCOPE] = copy.deepcopy(entry)
    return out


def _write_archive_sidecar(name: str, entry: dict, references: dict, moved_to: Optional[str]) -> None:
    """Atomic write of `<data_home>/state/archive/<name>.json` — the undo
    record `hub unarchive` reads back. Written BEFORE the directory is moved
    (see `cmd_archive`), so a crash between the two never leaves a moved
    directory with no undo record pointing at it."""
    payload = {
        "schema_version": 1,
        "archived_at": _now_iso(),
        "entry": entry,
        "references": references,
        "moved_to": moved_to,
    }
    path = _archive_sidecar_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp, path)


def _restore_skill_references(registry: dict, name: str, refs: dict) -> list[str]:
    """The inverse of `_capture_skill_references`. Skips a holder that no
    longer exists (a bundle/project/remote/cloud target renamed or removed
    since the skill was archived) rather than failing the whole restore.

    W-2: `companions` (project AND global) is deliberately NOT round-tripped
    here — an archived skill's shipped hooks/agents/rules were fully
    deprovisioned (files deleted, hook definitions dropped where nothing
    else claimed them), and silently re-writing the old ledger entry would
    name resources that no longer exist. Returns the project names (plus
    `ships_with.GLOBAL_SCOPE` when a global entry was captured) that had a
    captured companions ledger, so the caller can tell the user plainly
    that those need a fresh `hub enable --with-companions` instead of
    pretending they came back.
    """
    bundles_block = registry.get("bundles") if isinstance(registry, dict) else None
    for bname, idx in (refs.get("bundles") or {}).items():
        bcfg = bundles_block.get(bname) if isinstance(bundles_block, dict) else None
        if not isinstance(bcfg, dict):
            continue
        skills_list = bcfg.setdefault("skills", [])
        if name in skills_list:
            continue
        try:
            insert_at = min(max(int(idx), 0), len(skills_list))
        except (TypeError, ValueError):
            # A tampered/corrupt sidecar's index is not worth failing the
            # whole restore over — appending is always a valid position.
            insert_at = len(skills_list)
        skills_list.insert(insert_at, name)
        playbook_refs = (refs.get("playbook") or {}).get(bname) or []
        playbook = bcfg.get("playbook")
        if isinstance(playbook, list):
            for ref in playbook_refs:
                try:
                    section = next(
                        (
                            candidate
                            for candidate in playbook
                            if isinstance(candidate, dict)
                            and candidate.get("id") == ref.get("section_id")
                        ),
                        None,
                    )
                    if section is None and "section_id" not in ref:
                        section = playbook[
                            min(max(int(ref["section"]), 0), len(playbook) - 1)
                        ]
                    if section is None:
                        section = next(
                            (
                                candidate
                                for candidate in playbook
                                if isinstance(candidate, dict)
                                and candidate.get("id") == "unsectioned"
                            ),
                            None,
                        )
                    if section is None:
                        section = {"id": "unsectioned", "title": "", "skills": []}
                        playbook.append(section)
                    section_skills = section.setdefault("skills", [])
                    if name not in section_skills:
                        section_skills.insert(
                            min(max(int(ref["index"]), 0), len(section_skills)), name
                        )
                except (KeyError, TypeError, ValueError, IndexError, AttributeError):
                    continue
    projects_block = registry.get("projects") if isinstance(registry, dict) else None
    for pname in refs.get("projects") or []:
        pcfg = projects_block.get(pname) if isinstance(projects_block, dict) else None
        if not isinstance(pcfg, dict):
            continue
        enabled = pcfg.setdefault("enabled", [])
        if name not in enabled:
            enabled.append(name)
    for pname, mode in (refs.get("invocation_overrides") or {}).items():
        pcfg = projects_block.get(pname) if isinstance(projects_block, dict) else None
        if not isinstance(pcfg, dict):
            continue
        overrides = pcfg.setdefault("invocation_overrides", {})
        overrides[name] = mode
    remotes_block = registry.get("remotes") if isinstance(registry, dict) else None
    for rname in refs.get("remotes") or []:
        rcfg = remotes_block.get(rname) if isinstance(remotes_block, dict) else None
        if not isinstance(rcfg, dict):
            continue
        enabled = rcfg.setdefault("enabled", [])
        if name not in enabled:
            enabled.append(name)
    cloud_block = registry.get("cloud") if isinstance(registry, dict) else None
    for cname in refs.get("cloud") or []:
        ccfg = cloud_block.get(cname) if isinstance(cloud_block, dict) else None
        if not isinstance(ccfg, dict):
            continue
        enabled = ccfg.setdefault("enabled", [])
        if name not in enabled:
            enabled.append(name)
    unrestored = set((refs.get("companions") or {}).keys())
    if refs.get("companions_global"):
        from skill_hub.domain.skills import ships_with

        unrestored.add(ships_with.GLOBAL_SCOPE)
    return sorted(unrestored)


@registry_mutation("archive")
def cmd_archive(args):
    import copy

    import hub

    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    projects = registry.get("projects", {})
    names = args.skills
    json_mode = bool(getattr(args, "json", False))

    # Path safety FIRST, before any registry lookup or path is built: a
    # corrupt/hand-edited registry could carry a traversal string as a skill
    # KEY, and every path this command builds below is `<...>/ name`.
    for n in names:
        validate_slug(n, "skill name")

    missing = [n for n in names if n not in skills]
    if missing:
        print(f"Unknown skill(s): {', '.join(missing)}.")
        sys.exit(1)

    # A built-in (Starter Pack) skill is registered again by the next sync, so
    # an archive would not stick. Refuse the whole batch, like `hub hook
    # delete` refuses a built-in hook: unequipping is the honest answer.
    builtin = [
        n
        for n in names
        if isinstance(skills[n], dict)
        and hub.infer_skill_ownership(n, skills[n])["managed"] == "starter"
    ]
    if builtin:
        print(
            f"{c('error', RED)}: built-in skill(s) shipped with the app cannot be "
            f"archived: {', '.join(builtin)}. Unequip instead: "
            f"`hub disable <skill> --project <p>`, or narrow the scope with "
            f"`hub set-meta <skill> --scope portable`."
        )
        sys.exit(1)

    # Refuse the WHOLE batch, before any change, when a name already has a
    # pending undo record: `shutil.move` into an existing `_archive/<name>`
    # dir moves INSIDE it (nesting, not replacing) and a second sidecar write
    # would clobber the first — silently corrupting an undo that is still
    # live. There is nothing to merge here; the user must resolve it first.
    pending = [
        n
        for n in names
        if (hub.hub_skills_dir() / "_archive" / n).exists() or _archive_sidecar_path(n).exists()
    ]
    if pending:
        print(
            f"{c('error', RED)}: already archived (pending undo record) for: "
            f"{', '.join(pending)}. Run `hub unarchive <name>` first, or "
            f"remove skills/_archive/<name> and state/archive/<name>.json by hand."
        )
        sys.exit(1)

    if getattr(args, "dry_run", False):
        plan = []
        for name in names:
            cfg = skills[name]
            src = hub.skill_source(cfg)
            would_move = src.exists() and not src.is_symlink() and src.is_relative_to(data_home())
            sites = _skill_reference_sites(registry, name)
            if not json_mode:
                print(f"{c('DRY-RUN', YELLOW)} archive '{name}' (no changes made):")
                if would_move:
                    print(f"  would move {src} → skills/_archive/{name}/")
                if sites.get("projects"):
                    print(f"  would unenable from: {', '.join(sites['projects'])}")
                for site in ("bundles", "invocation_overrides", "remotes"):
                    if sites.get(site):
                        print(
                            f"  would remove from {_REFERENCE_SITE_LABELS[site]}: "
                            f"{', '.join(sites[site])}"
                        )
                if sites.get("cloud"):
                    print(f"  would unequip from cloud targets: {', '.join(sites['cloud'])}")
                # W-2: the real run fully deprovisions every ships_with
                # companion this skill's ledger entries claim, on every
                # project — say so here too, straight off the ledger.
                if sites.get("companions"):
                    from skill_hub.domain.skills import ships_with as _sw

                    for pname in sites["companions"]:
                        pcfg = (registry.get("projects") or {}).get(pname) or {}
                        entry = _sw.ledger_entry(pcfg, name)
                        for kind in ("hooks", "agents", "permissions"):
                            for item in entry.get(kind) or []:
                                label = item if isinstance(item, str) else item.get("pattern")
                                print(
                                    f"  would deprovision companion ({pname}) "
                                    f"{kind[:-1]}: {label}"
                                )
                if sites.get("companions_global"):
                    from skill_hub.domain.skills import ships_with as _sw

                    g_entry = _sw.global_ledger(registry).get(name) or {}
                    for kind in ("hooks", "agents", "permissions"):
                        for item in g_entry.get(kind) or []:
                            label = item if isinstance(item, str) else item.get("pattern")
                            print(f"  would deprovision global companion {kind[:-1]}: {label}")
                print(f"  would remove registry skill '{name}' and its symlinks")
            plan.append(
                {
                    "name": name,
                    "would_move": would_move,
                    "references": _capture_skill_references(registry, name),
                }
            )
        payload = {"ok": True, "dry_run": True, "plan": plan}
        if json_mode:
            print(json.dumps(payload, indent=2))
        return

    archived_results: list[dict] = []
    # Tracked so a mid-batch failure can be undone: the point of a "batch" is
    # that it is all-or-nothing, and `save_registry` only happens once, after
    # the loop — but a `shutil.move` is a real filesystem side effect that
    # happens DURING the loop and needs its own rollback on the way out.
    done_moves: list[tuple[Path, Path]] = []  # (moved_to, original_src)
    done_sidecars: list[str] = []

    def _rollback(failed_name: str, exc: Exception) -> None:
        for dest, src in reversed(done_moves):
            try:
                if dest.exists() and not src.exists():
                    shutil.move(str(dest), str(src))
            except OSError:
                pass
        for nm in done_sidecars:
            try:
                _archive_sidecar_path(nm).unlink(missing_ok=True)
            except OSError:
                pass
        print(
            f"{c('error', RED)}: archiving '{failed_name}' failed ({exc}); "
            f"rolled back {len(done_moves)} move(s) and {len(done_sidecars)} "
            f"undo record(s) written this run. Nothing was saved."
        )
        sys.exit(1)

    # Human progress chatter is suppressed under --json (redirected to
    # stderr, same pattern used elsewhere in this file) so the JSON payload
    # printed after this loop is always the first thing on stdout.
    with contextlib.redirect_stdout(sys.stderr) if json_mode else contextlib.nullcontext():
        for name in names:
            try:
                cfg = skills[name]
                src = hub.skill_source(cfg)
                archive_dir = hub.hub_skills_dir() / "_archive"
                archive_dest = archive_dir / name

                references = _capture_skill_references(registry, name)
                entry_snapshot = copy.deepcopy(cfg)
                will_move = (
                    src.exists() and not src.is_symlink() and src.is_relative_to(data_home())
                )
                moved_to = str(archive_dest) if will_move else None

                # Sidecar written BEFORE the move: a failed move is then
                # already documented rather than stranding an undocumented
                # directory in `_archive/`.
                _write_archive_sidecar(name, entry_snapshot, references, moved_to)
                done_sidecars.append(name)

                moved = False
                if will_move:
                    archive_dir.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src), str(archive_dest))
                    moved = True
                    done_moves.append((archive_dest, src))
                    print(f"  {c('→', YELLOW)} moved to skills/_archive/{name}/")

                del skills[name]

                if cfg.get("type") == "mcp-server":
                    # plans/G.md §5.13: every removal path deletes the
                    # capability catalogue AND the probe-cache row together,
                    # so a summary can never outlive the server it described.
                    mcp_probe.forget_server(name)

                sites = _prune_skill_references(registry, name)
                for site, keys in sites.items():
                    for key in keys:
                        print(f"  {c('✗', RED)} removed from {_REFERENCE_SITE_LABELS[site]}: {key}")

                results = [hub.remove_symlink(hub_core.CLAUDE_SKILLS_DIR / name)]
                for proj_cfg in projects.values():
                    proj_path = expand(proj_cfg["path"])
                    results.append(hub.remove_symlink(proj_path / ".claude" / "skills" / name))
                    results.append(hub.remove_symlink(proj_path / ".agents" / "skills" / name))

                print(f"{c('✓', GREEN)} archived '{name}'")
                hub._warn_links_left_in_place(results)

                archived_results.append({"name": name, "moved": moved, "references": references})
            except Exception as exc:  # noqa: BLE001 — batch must roll back, not half-apply
                _rollback(name, exc)

    hub_core.save_registry(registry)

    payload = {
        "ok": True,
        "archived": archived_results,
        "undo": ["unarchive", *names],
    }
    if json_mode:
        print(json.dumps(payload, indent=2))

    # A bundle/remote membership change is a sync-visible mutation like any
    # other: reconcile now so the next `hub sync` starts clean instead of
    # every project surfacing `unknown skill`.
    hub._auto_sync()


@registry_mutation("unarchive")
def cmd_unarchive(args):
    """`hub unarchive NAME [NAME…]` — undo `hub archive`: round-trip the dir
    (when one was moved), the registry entry, and every reference site from
    the sidecar `hub archive` wrote. Skips (reported, never fatal) a name
    whose slug is invalid, sidecar is missing/corrupt, is already registered,
    or whose archived dir/destination collides or escapes the data home;
    exits 1 only when NOTHING was restored."""
    import hub

    registry = hub_core.load_registry()
    skills_block = registry.setdefault("skills", {})

    restored: list[str] = []
    skipped: list[dict] = []
    companions_not_restored: dict[str, list[str]] = {}
    for name in getattr(args, "skills", None) or []:
        # Reject BEFORE any path is built or touched — a name that isn't a
        # legal slug is refused outright rather than fed into
        # `_archive_sidecar_path` and checked for existence on disk, which a
        # `../../../etc/passwd`-shaped name could otherwise resolve outside
        # the data home entirely.
        if not SLUG_RE.match(name):
            skipped.append({"name": name, "reason": "invalid skill name"})
            continue

        sidecar_path = _archive_sidecar_path(name)
        if not _path_within_data_home(sidecar_path):
            skipped.append({"name": name, "reason": "archive record path is outside the data home"})
            continue
        if not sidecar_path.is_file():
            skipped.append({"name": name, "reason": "no archive record found"})
            continue
        try:
            data = json.loads(sidecar_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            skipped.append({"name": name, "reason": f"corrupt archive record: {exc}"})
            continue
        if name in skills_block:
            skipped.append({"name": name, "reason": "a skill with this name is already registered"})
            continue
        entry = data.get("entry")
        if not isinstance(entry, dict):
            skipped.append({"name": name, "reason": "corrupt archive record: missing entry"})
            continue

        moved_to = data.get("moved_to")
        if moved_to:
            moved_path = Path(moved_to)
            # The sidecar is hub-written, but its JSON body is still
            # untrusted input by the time it is read back — a corrupted or
            # hand-edited file must never send a `shutil.move` outside the
            # data home just because it says so.
            if not _path_within_data_home(moved_path):
                skipped.append({"name": name, "reason": "archive record points outside the data home"})
                continue
            if not moved_path.exists():
                skipped.append({"name": name, "reason": "archived files are missing on disk"})
                continue
            raw_source = entry.get("source") if isinstance(entry, dict) else None
            if not isinstance(raw_source, str) or not raw_source.strip():
                skipped.append({"name": name, "reason": "corrupt archive record: missing source path"})
                continue
            dest = expand(raw_source)
            if not _path_within_data_home(dest):
                skipped.append({"name": name, "reason": "restore destination is outside the data home"})
                continue
            if dest.exists():
                skipped.append({"name": name, "reason": f"destination already exists: {dest}"})
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(moved_path), str(dest))

        skills_block[name] = entry
        unrestored_projects = _restore_skill_references(
            registry, name, data.get("references") or {}
        )
        if unrestored_projects:
            companions_not_restored[name] = unrestored_projects
        sidecar_path.unlink(missing_ok=True)
        restored.append(name)
        if not getattr(args, "json", False):
            print(f"{c('✓', GREEN)} restored '{name}'")

    if restored:
        hub_core.save_registry(registry)

    payload = {
        "ok": True,
        "restored": restored,
        "skipped": skipped,
        "companions_not_restored": companions_not_restored,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        for s in skipped:
            print(f"  {c('!', YELLOW)} skipped '{s['name']}': {s['reason']}")
        # W-2: consistent with what archive actually did — companions are
        # fully deprovisioned on archive, never silently re-provisioned here.
        for name, proj_names in companions_not_restored.items():
            print(
                f"  {c('!', YELLOW)} '{name}': ships_with companions on "
                f"{', '.join(proj_names)} were NOT restored — re-run "
                f"`hub enable {name} --project <p> --with-companions`"
            )

    if restored:
        hub._auto_sync()

    if not restored:
        sys.exit(1)
