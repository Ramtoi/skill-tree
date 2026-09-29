"""`hub cloud` — manual-upload targets (claude.ai, ChatGPT web).

There is no API on the far side: the sanctioned path is a ZIP the user uploads
in the target's own settings UI. So these commands do exactly two things —
build a byte-reproducible ZIP, and remember the fingerprint of what we handed
over so `status` can say what has drifted since. All the model logic lives in
`cloud_targets.py`; these handlers are marshalling + output only.

Carved out of `hub.py` (S5 slice B) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.hub_core import (
    BLUE,
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    YELLOW,
    c,
    data_home_lock,
    fail,
    registry_file,
    registry_mutation,
)

NAME = "cloud"

p_cloud = None


def register(sub) -> None:
    global p_cloud

    # cloud — manual-upload targets (claude.ai, ChatGPT web). No API exists on
    # the far side, so the CLI's whole job is: build the ZIP, remember the hash.
    p_cloud = sub.add_parser(
        "cloud", help="Export skills to manual-upload cloud targets (claude.ai, ChatGPT)"
    )
    cloud_sub = p_cloud.add_subparsers(dest="cloud_cmd")

    p_cloud_targets = cloud_sub.add_parser(
        "targets", help="List cloud targets + equipped count + drift rollup"
    )
    p_cloud_targets.add_argument("--json", action="store_true", help="Emit JSON")

    p_cloud_equip = cloud_sub.add_parser(
        "equip",
        help="Add/remove a bundle or skill on a cloud target (registry-only)",
    )
    p_cloud_equip.add_argument("target", help="Cloud target id (claude-ai|chatgpt-web)")
    p_cloud_equip.add_argument(
        "--kind", required=True, choices=["bundle", "skill"],
        help="Whether <name> is a bundle or an individual skill",
    )
    p_cloud_equip.add_argument("--name", required=True, help="Bundle or skill name")
    p_cloud_equip.add_argument(
        "--state", required=True, choices=["on", "off"],
        help="on = equip; off = unequip",
    )
    p_cloud_equip.add_argument("--json", action="store_true", help="Emit JSON")

    p_cloud_status = cloud_sub.add_parser(
        "status", help="Per-skill export status (new|up_to_date|changed) + lints"
    )
    p_cloud_status.add_argument("target", help="Cloud target id")
    p_cloud_status.add_argument("--json", action="store_true", help="Emit JSON")

    p_cloud_export = cloud_sub.add_parser(
        "export", help="Build upload-ready ZIPs for a cloud target's equipped skills"
    )
    p_cloud_export.add_argument("target", help="Cloud target id")
    p_cloud_export.add_argument("--skill", help="Export just this one equipped skill")
    p_cloud_export.add_argument(
        "--out", help="Output dir (default: <data_home>/exports/<target>/)"
    )
    p_cloud_export.add_argument("--json", action="store_true", help="Emit JSON")



def dispatch(args) -> None:
    cc = getattr(args, "cloud_cmd", None)
    if cc == "targets":
        cmd_cloud_targets(args)
    elif cc == "equip":
        cmd_cloud_equip(args)
    elif cc == "status":
        cmd_cloud_status(args)
    elif cc == "export":
        cmd_cloud_export(args)
    else:
        p_cloud.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# hub cloud — manual-upload targets (claude.ai, ChatGPT web)
#
# There is no API on the far side: the sanctioned path is a ZIP the user uploads
# in the target's own settings UI. So these commands do exactly two things — build
# a byte-reproducible ZIP, and remember the fingerprint of what we handed over so
# `status` can say what has drifted since. All the model logic lives in
# `cloud_targets.py`; these handlers are marshalling + output only.
# ─────────────────────────────────────────────────────────────────────────────


def _cloud_target_or_fail(target_id: str):
    from skill_hub.infrastructure.filesystem import cloud_targets

    target = cloud_targets.get_target(target_id)
    if target is None:
        known = ", ".join(sorted(cloud_targets.CLOUD_TARGETS))
        fail(f"Unknown cloud target '{target_id}'. Known targets: {known}.")
    return target


def _resolve_or_none(path: Path) -> Optional[Path]:
    """`path.resolve()`, or None when the filesystem refuses to answer.

    Used to decide containment before an `unlink()`; a resolve that raises must
    read as "not contained" (skip the delete), never as "contained".
    """
    try:
        return Path(path).resolve()
    except OSError:
        return None


def _cloud_status_colour(status: str) -> str:
    from skill_hub.infrastructure.filesystem import cloud_targets

    return {
        cloud_targets.STATUS_NEW: BLUE,
        cloud_targets.STATUS_CHANGED: YELLOW,
        cloud_targets.STATUS_UP_TO_DATE: GREEN,
        cloud_targets.STATUS_MISSING: RED,
    }.get(status, DIM)


def cmd_cloud_targets(args):
    """`hub cloud targets` — the catalog + per-target equipped/drift rollup.

    Read-only. The catalog is fixed in code (it describes somebody else's
    product), so this always lists every target even with an empty registry.
    """
    import hub
    from skill_hub.infrastructure.filesystem import cloud_targets

    registry = hub._read_registry_optional()
    rows = []
    for target_id, target in cloud_targets.CLOUD_TARGETS.items():
        status = cloud_targets.compute_status(target_id, registry)
        row = target.to_dict()
        row["equipped"] = status["summary"]["equipped"]
        # `missing` rides along with the rest: leaving it out let a card read
        # "equipped 1" next to an empty drift cluster ("Nothing equipped yet")
        # whenever the one equipped skill's source dir had gone.
        row["drift"] = {
            "new": status["summary"][cloud_targets.STATUS_NEW],
            "changed": status["summary"][cloud_targets.STATUS_CHANGED],
            "up_to_date": status["summary"][cloud_targets.STATUS_UP_TO_DATE],
            "missing": status["summary"][cloud_targets.STATUS_MISSING],
            "orphaned": status["summary"]["orphaned"],
        }
        row["last_exported"] = status["last_exported"]
        rows.append(row)

    if getattr(args, "json", False):
        print(json.dumps(rows, indent=2))
        return

    print(f"\n{c('Cloud targets', BOLD, CYAN)}\n")
    print(c(f"{'TARGET':<14}{'EQUIPPED':<10}{'DRIFT':<34}UPLOAD", BOLD))
    for row in rows:
        d = row["drift"]
        parts = [
            (f"{d['new']} new", BLUE),
            (f"{d['changed']} changed", YELLOW),
            (f"{d['up_to_date']} up-to-date", GREEN),
        ]
        # Only when it happened: a permanent "0 missing" column would spend the
        # glance's whole budget on the rarest state.
        if d["missing"]:
            parts.append((f"{d['missing']} missing", RED))
        drift = "  ".join(c(text, colour) for text, colour in parts)
        # Colour codes inflate len(), so pad the visible text separately.
        visible = "  ".join(text for text, _ in parts)
        pad = " " * max(1, 34 - len(visible))
        print(f"{row['id']:<14}{row['equipped']:<10}{drift}{pad}{row['upload_url']}")
    print(f"\n{c('Skills reach these only by manual ZIP upload — no API exists.', DIM)}")
    print(f"{c('Next:', BOLD)} hub cloud status <target> · hub cloud export <target>\n")


@registry_mutation("cloud-equip")
def cmd_cloud_equip(args):
    """`hub cloud equip <target> --kind {bundle|skill} --name N --state {on|off}`.

    Registry-only, mirroring `cmd_remote_equip`: validates the target id and that
    <name> exists, then toggles it in the target's `bundles`/`enabled` array.
    Nothing on disk changes and nothing is uploaded, so there is deliberately NO
    auto-sync — the next `hub cloud export` is what produces the ZIPs.

    Existence is checked for `--state on` only. Removing a name the registry no
    longer knows is exactly the case a user needs most (the skill was archived
    while still equipped here), and refusing it would leave the entry
    unremovable except by hand-editing the registry.
    """
    _cloud_target_or_fail(args.target)
    kind = args.kind
    name = args.name
    on = args.state == "on"

    registry = hub_core.load_registry()
    if kind == "bundle":
        if on and name not in (registry.get("bundles") or {}):
            fail(f"Unknown bundle '{name}'.")
        field_name = "bundles"
    elif kind == "skill":
        if on and name not in (registry.get("skills") or {}):
            fail(f"Unknown skill '{name}'.")
        field_name = "enabled"
    else:
        fail(f"Unknown kind '{kind}' (expected bundle|skill).")

    # A malformed `cloud:` block is a hand-edit hub must not silently discard:
    # replacing it here would delete every other target's equip list without a
    # word. Refuse and name the file instead.
    cloud_block = registry.get("cloud")
    if cloud_block is None:
        cloud_block = {}
    if not isinstance(cloud_block, dict):
        fail(
            f"`cloud:` in {registry_file()} is a {type(cloud_block).__name__}, "
            f"not a mapping of target ids — repair it before equipping."
        )
    entry = cloud_block.get(args.target)
    if entry is None:
        entry = {"bundles": [], "enabled": []}
    if not isinstance(entry, dict):
        fail(
            f"`cloud.{args.target}` in {registry_file()} is a "
            f"{type(entry).__name__}, not a mapping — repair it before equipping."
        )
    raw_field = entry.get(field_name)
    if raw_field is not None and not isinstance(raw_field, list):
        fail(
            f"`cloud.{args.target}.{field_name}` in {registry_file()} is a "
            f"{type(raw_field).__name__}, not a list — repair it before equipping."
        )
    current = [x for x in (raw_field or []) if isinstance(x, str)]
    if on:
        if name not in current:
            current.append(name)
    else:
        current = [x for x in current if x != name]
    entry[field_name] = current
    entry.setdefault("bundles", [])
    entry.setdefault("enabled", [])
    cloud_block[args.target] = entry
    registry["cloud"] = cloud_block
    hub_core.save_registry(registry)

    result = {
        "ok": True,
        "target": args.target,
        "bundles": list(entry.get("bundles") or []),
        "enabled": list(entry.get("enabled") or []),
    }
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    else:
        state_str = c("on", GREEN) if on else c("off", DIM)
        print(f"  {c('✓', GREEN)} {args.target}: {kind} {c(name, BOLD)} {state_str}")
    return result


def cmd_cloud_status(args):
    """`hub cloud status <target>` — per-skill new/up_to_date/changed + lints.

    Read-only: classifies drift from the source tree's content fingerprint, so it
    never writes a ZIP and never touches the sidecar.
    """
    import hub
    from skill_hub.infrastructure.filesystem import cloud_targets

    _cloud_target_or_fail(args.target)
    payload = cloud_targets.compute_status(args.target, hub._read_registry_optional())

    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return

    print(f"\n{c(payload['label'], BOLD, CYAN)}  {c(payload['target'], DIM)}\n")
    for warning in payload.get("warnings") or []:
        print(f"  {c('!', YELLOW)} {warning}")
    if not payload["skills"] and not payload["orphaned"] and not payload["unsupported"]:
        print(
            c("  nothing equipped — try: ", DIM)
            + f"hub cloud equip {payload['target']} --kind skill --name <skill> --state on"
        )
        print()
        return

    if payload["skills"]:
        print(c(f"  {'SKILL':<30}{'STATUS':<14}LAST EXPORT", BOLD))
        for row in payload["skills"]:
            colour = _cloud_status_colour(row["status"])
            when = row["exported_at"] or c("never", DIM)
            print(f"  {row['skill']:<30}{c(row['status'], colour):<23}{when}")
            for warning in row["lint"]:
                print(f"    {c('lint', YELLOW)} {warning}")
    if payload["orphaned"]:
        print(f"\n  {c('Orphaned (exported before, no longer equipped)', BOLD)}")
        for row in payload["orphaned"]:
            print(f"    {c('·', DIM)} {row['skill']}  {c(row['zip_name'], DIM)}")
    if payload["unsupported"]:
        print(f"\n  {c('Not exportable', BOLD)}")
        for row in payload["unsupported"]:
            print(f"    {c('·', DIM)} {row['skill']} — {row['reason']}")
    print()


def cmd_cloud_export(args):
    """`hub cloud export <target> [--skill N] [--out DIR]` — build the ZIPs.

    Builds one deterministic `<skill>.zip` per equipped exportable skill, records
    each content fingerprint in the target's sidecar, and prunes sidecar entries
    for skills that are no longer equipped. Stale `<skill>.zip` files are deleted
    ONLY in the default export dir and ONLY when the sidecar says we wrote them —
    hub never removes a file in a user-chosen `--out` dir, or one it does not own.

    Two phases. The ZIPs are built OUTSIDE the data-home lock — each archive is
    written to a sibling temp and `os.replace`d, so it needs no cross-process
    mutex, and holding the one global lock for a multi-second compress would
    stall every unrelated hub command (and every app click) for its duration.
    The lock covers only the sidecar read-modify-write plus the prune, which is
    the part that must be atomic.

    A skill that cannot be read is isolated: it lands in `errors` and the run
    continues, so one unreadable folder cannot throw away the ZIPs already built
    or the sidecar entries that record them. A non-empty `errors` makes the
    command exit non-zero (same convention as `hub sync` / doctor).

    The registry is only read, never mutated.
    """
    import hub
    from skill_hub.infrastructure.filesystem import cloud_targets

    target = _cloud_target_or_fail(args.target)
    json_mode = bool(getattr(args, "json", False))
    registry = hub._read_registry_optional()
    exportable, unsupported = cloud_targets.partition_equipped(args.target, registry)
    skills_cfg = registry.get("skills") or {}

    only = getattr(args, "skill", None)
    if only:
        if only not in exportable:
            reasons = {row["skill"]: row["reason"] for row in unsupported}
            if only in reasons:
                fail(f"'{only}' is not exportable to {args.target}: {reasons[only]}")
            fail(
                f"'{only}' is not equipped on cloud target '{args.target}'. "
                f"Equip it first: hub cloud equip {args.target} --kind skill "
                f"--name {only} --state on"
            )
        selected = [only]
    else:
        selected = list(exportable)

    out_dir_arg = getattr(args, "out", None)
    is_default_dir = out_dir_arg is None
    out_dir = (
        cloud_targets.default_export_dir(args.target)
        if is_default_dir
        else Path(out_dir_arg).expanduser()
    )

    # ── Phase 1: build the archives (no lock) ────────────────────────────────
    errors = []
    built_rows = []
    for name in selected:
        root = hub.skill_source(skills_cfg[name])
        if not Path(root).is_dir():
            errors.append(f"{name}: source directory not found: {root}")
            continue
        renamed = hub.skill_rename_patch(name, skills_cfg[name])
        try:
            zip_name = cloud_targets.zip_name_for(name)
            built = cloud_targets.build_skill_zip(
                name, Path(root), out_dir / zip_name, renamed
            )
            lint = cloud_targets.lint_skill(name, Path(root), renamed)
        except (OSError, ValueError) as exc:
            # An unreadable file, a full disk, a name that cannot safely become
            # a filename: one skill's problem, not the run's.
            errors.append(f"{name}: {exc}")
            continue
        built_rows.append((name, zip_name, built, lint))

    # ── Phase 2: record what we built + prune dead state (locked) ────────────
    results = []
    pruned = []
    with data_home_lock():
        sidecar = cloud_targets.read_sidecar(args.target)
        recorded = dict(sidecar["skills"])
        now = _dt.datetime.now().isoformat(timespec="seconds")

        for name, zip_name, built, lint in built_rows:
            prior = (recorded.get(name) or {}).get("sha256")
            if not prior:
                status_before = cloud_targets.STATUS_NEW
            elif prior == built["sha256"]:
                status_before = cloud_targets.STATUS_UP_TO_DATE
            else:
                status_before = cloud_targets.STATUS_CHANGED
            recorded[name] = {
                "sha256": built["sha256"],
                "exported_at": now,
                "zip_name": zip_name,
            }
            results.append(
                {
                    "skill": name,
                    "zip_path": built["zip_path"],
                    "sha256": built["sha256"],
                    "files": built["files"],
                    "status_before": status_before,
                    "lint": lint,
                }
            )

        # Prune: a sidecar entry whose skill is no longer equipped is dead state.
        # Its zip is removed only when WE wrote it into the default export dir.
        #
        # Two containment rules, because both inputs are hand-editable text: the
        # sidecar's `zip_name` is honoured by BASENAME only, and the resolved
        # candidate must still sit inside the export dir. Nothing outside it is
        # ever a delete candidate, however the name was spelled.
        equipped = set(exportable)
        out_root = _resolve_or_none(out_dir)
        for name in sorted(recorded):
            if name in equipped:
                continue
            entry = recorded.pop(name)
            removed_zip = None
            zip_name = cloud_targets.recorded_zip_name(name, entry)
            if is_default_dir and zip_name and out_root is not None:
                candidate = out_dir / zip_name
                resolved = _resolve_or_none(candidate)
                contained = resolved is not None and out_root in resolved.parents
                if contained and candidate.is_file() and not candidate.is_symlink():
                    try:
                        candidate.unlink()
                        removed_zip = str(candidate)
                    except OSError:
                        removed_zip = None
            pruned.append({"skill": name, "removed_zip": removed_zip})

        sidecar["skills"] = recorded
        cloud_targets.write_sidecar(args.target, sidecar)

    payload = {
        "target": args.target,
        "label": target.label,
        "upload_url": target.upload_url,
        "upload_path": target.upload_path,
        "out_dir": str(out_dir),
        "results": results,
        "pruned": pruned,
        "unsupported": unsupported,
        "errors": errors,
        "notes": list(target.notes),
    }

    if json_mode:
        print(json.dumps(payload, indent=2))
        if errors:
            sys.exit(1)
        return payload

    if not results and not pruned and not errors:
        print(
            c("nothing to export — ", DIM)
            + f"hub cloud equip {args.target} --kind skill --name <skill> --state on"
        )
        return payload
    print(f"\n{c('Exported to ' + target.label, BOLD, CYAN)}\n")
    for row in results:
        print(
            f"  {c('✓', GREEN)} {row['skill']:<28}"
            f"{c(row['status_before'], _cloud_status_colour(row['status_before']))}"
            f"  {c(str(row['files']) + ' file(s)', DIM)}"
        )
        for warning in row["lint"]:
            print(f"    {c('lint', YELLOW)} {warning}")
    for row in pruned:
        suffix = " (zip removed)" if row["removed_zip"] else ""
        print(f"  {c('−', DIM)} {row['skill']} no longer equipped{suffix}")
    for row in unsupported:
        print(f"  {c('!', YELLOW)} skipped {row['skill']} — {row['reason']}")
    for err in errors:
        print(f"  {c('✗', RED)} {err}", file=sys.stderr)
    print(f"\n{c('ZIPs:', BOLD)} {out_dir}")
    print(f"{c('Upload at:', BOLD)} {target.upload_url}  {c(target.upload_path, DIM)}")
    for note in target.notes:
        print(f"  {c('·', DIM)} {note}")
    print()
    # A run that could not export something it was asked to export did not
    # succeed, whatever else it managed — same exit convention as sync/doctor.
    if errors:
        sys.exit(1)
    return payload


