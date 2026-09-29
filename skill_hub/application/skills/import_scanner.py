"""Import scanner: bootstrap state, registry-optional reads, SKILL.md parsing,
the user-global import candidate scan and `apply_import`.

Cut verbatim out of hub.py (wave 23d of AUDIT.md). A leaf: at module scope it
imports hub_core, skill_meta, sync_links and yaml only, never hub or skill_hub.entrypoints.cli.
hub.py re-imports every name so `hub.<name>` keeps resolving — the twelve
`monkeypatch.setattr(hub, "scan_import_candidates", …)` stubs in
tests/test_bootstrap.py keep landing because their callers live in
hub_cli/bootstrap.py and read `hub.scan_import_candidates`.

`IMPORT_SCAN_ROOTS`, `registry_file`, `legacy_data_home_candidates` and
`collapse_home` are read as `hub_core.<name>` at call time: tests rebind
`IMPORT_SCAN_ROOTS` through `hub.` (tests/test_cleanup_ownership.py) and the
`_HubFacade` forwards that write to hub_core — a by-value copy would freeze it.

Stub visibility: a call from one function here to another resolves through
this module, so `monkeypatch.setattr(hub, "<name>", …)` no longer reaches it
(`bootstrap_state` → `_read_registry_optional` → `_empty_registry`;
`scan_import_candidates` / `apply_import` → `_read_registry_optional` /
`_parse_skill_md`). No test stubs those today; one that needs to patches
`import_scanner.<name>`.
"""

import os
import shutil
from pathlib import Path
from typing import Optional

# isort: off
# `hub_core` must import BEFORE `yaml`: it prepends the vendored `vendor/` dir
# to sys.path (same reason as skill_meta.py).
from skill_hub import hub_core
from skill_hub.hub_core import SLUG_RE, _sha256_file, expand
from skill_hub.domain.skills.skill_meta import hub_skills_dir
from skill_hub.infrastructure.filesystem.sync_links import is_hub_owned_link

import yaml
# isort: on


# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap, migration, import
# ─────────────────────────────────────────────────────────────────────────────


def _empty_registry() -> dict:
    return {"version": "1", "skills": {}, "projects": {}, "bundles": {}}


def _read_registry_optional() -> dict:
    reg_file = hub_core.registry_file()
    if not reg_file.exists():
        return _empty_registry()
    with open(reg_file) as f:
        data = yaml.safe_load(f) or {}
    return data


def bootstrap_state(registry: Optional[dict] = None) -> dict:
    """Return current bootstrap status without side effects."""
    reg = registry if registry is not None else _read_registry_optional()
    info = reg.get("bootstrap") or {}
    completed_at = info.get("completed_at")
    return {
        "needs_bootstrap": not completed_at,
        "completed_at": completed_at,
        "version": info.get("version", 1),
        "legacy_detected": [str(p) for p in hub_core.legacy_data_home_candidates()],
    }


def _parse_skill_md(skill_md: Path) -> Optional[dict]:
    """Return {name, description, version} or None."""
    if not skill_md.exists():
        return None
    try:
        text = skill_md.read_text()
    except OSError:
        return None
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(meta, dict):
        return None
    name = meta.get("name")
    if not name:
        return None
    return {
        "name": str(name).strip(),
        "description": str(meta.get("description") or "").strip(),
        "version": str(meta.get("version") or "1.0.0").strip(),
    }


def scan_import_candidates(registry: Optional[dict] = None) -> list[dict]:
    """Enumerate global skill dirs; classify each candidate.

    Categories:
      NEW                 — valid slug, not in registry, no symlink to hub
      CONFLICT            — name collides with existing, SKILL.md SHA differs
      SILENT_SKIP         — name collides, SHA matches (already imported equivalent)
      ALREADY_MANAGED     — a link this install owns (`is_hub_owned_link`)
      INVALID_NAME        — name fails slug pattern
      BROKEN              — dangling symlink
    """
    reg = registry if registry is not None else _read_registry_optional()
    existing = reg.get("skills") or {}

    candidates: list[dict] = []
    for origin, root in hub_core.IMPORT_SCAN_ROOTS:
        if not root.exists():
            continue
        for entry in sorted(root.iterdir()):
            if entry.name.startswith("."):
                continue

            is_symlink = entry.is_symlink()
            link_target_str: Optional[str] = None
            if is_symlink:
                try:
                    link_target_str = os.readlink(entry)
                    if not os.path.isabs(link_target_str):
                        link_target_str = str(
                            (entry.parent / link_target_str).resolve()
                        )
                except OSError:
                    link_target_str = None

            # Dangling symlink check
            target_exists = entry.exists()  # follows symlink
            broken = is_symlink and not target_exists

            # Hub-managed check: the SHARED ownership rule, not a
            # `<data>/skills/` prefix. A renamed skill's global link points at
            # `state/skill_variants/<key>@renamed`, an invocation override at
            # `<key>@<mode>`, an external skill at `sources/<id>/worktree/…` —
            # all hub's own. Classifying those as importable candidates offered
            # a "replace" that repointed the registry AT THE VARIANT, which the
            # next sync's orphan sweep then deleted (destroying the source).
            hub_managed = is_hub_owned_link(entry)

            skill_md = entry / "SKILL.md"
            meta = _parse_skill_md(skill_md)

            base = {
                "origin": origin,
                "path": str(entry),
                "name": meta.get("name") if meta else None,
                "version": meta.get("version") if meta else None,
                "description": meta.get("description") if meta else None,
                "broken": broken,
            }

            if hub_managed:
                base["category"] = "ALREADY_MANAGED"
                candidates.append(base)
                continue

            if meta is None:
                # Skip silently — no SKILL.md / no frontmatter / no name
                continue

            if not SLUG_RE.match(meta["name"]):
                base["category"] = "INVALID_NAME"
                base["reason"] = "must match ^[a-z0-9-]+$"
                candidates.append(base)
                continue

            if meta["name"] in existing:
                cand_hash = _sha256_file(skill_md)
                existing_src = expand(existing[meta["name"]]["source"])
                existing_hash = _sha256_file(existing_src / "SKILL.md")
                if cand_hash and existing_hash and cand_hash == existing_hash:
                    base["category"] = "SILENT_SKIP"
                else:
                    base["category"] = "CONFLICT"
                    base["candidate_sha"] = (cand_hash or "")[:12]
                    base["existing_sha"] = (existing_hash or "")[:12]
                    base["existing_source"] = str(existing_src)
                candidates.append(base)
                continue

            base["category"] = "BROKEN" if broken else "NEW"
            candidates.append(base)

    # Dedupe by name across origins. Order priority follows IMPORT_SCAN_ROOTS
    # iteration order: earlier origins win. So `~/.agents/skills/` (codex
    # documented current) precedes `~/.codex/skills/` (legacy-codex); when both
    # carry the same skill name, the legacy candidate is dropped.
    deduped: list[dict] = []
    seen_names: set[str] = set()
    for cand in candidates:
        name = cand.get("name")
        if not name:
            deduped.append(cand)
            continue
        if name in seen_names:
            continue
        seen_names.add(name)
        deduped.append(cand)
    return deduped


def apply_import(
    registry: dict,
    selections: list[dict],
    conflict_actions: Optional[dict] = None,
    adopt_set: Optional[set] = None,
) -> dict:
    """Mutate registry in-place with the user's selections.

    selections: list of candidate dicts (each must have name, path, origin, category).
    conflict_actions: {name: "skip"|"replace"|"suffix"} for CONFLICT candidates.
    adopt_set: set of names to adopt (copy into data home).
    """
    conflict_actions = conflict_actions or {}
    adopt_set = adopt_set or set()
    skills = registry.setdefault("skills", {})
    result = {
        "registered": [],
        "replaced": [],
        "suffixed": [],
        "skipped": [],
        "adopted": [],
    }

    for cand in selections:
        category = cand.get("category")
        name = cand.get("name")
        if not name or category in ("ALREADY_MANAGED", "SILENT_SKIP", "INVALID_NAME"):
            result["skipped"].append({"name": name, "reason": category})
            continue

        # Determine source path (in-place vs adopted)
        source_path = Path(cand["path"])
        if name in adopt_set:
            dest = hub_skills_dir() / name
            if dest.exists():
                result["skipped"].append({"name": name, "reason": "adopt_collision"})
                # Fall back to register-in-place
            else:
                shutil.copytree(source_path, dest, symlinks=True, dirs_exist_ok=False)
                source_path = dest
                result["adopted"].append(name)

        source_str = hub_core.collapse_home(source_path)
        new_entry = {
            "version": cand.get("version") or "1.0.0",
            "description": cand.get("description") or "",
            "source": source_str,
            "type": "claude-skill",
            "scope": "global",
            "upstream": None,
        }

        if category == "CONFLICT":
            action = conflict_actions.get(name, "skip")
            if action == "skip":
                result["skipped"].append({"name": name, "reason": "conflict_skip"})
                continue
            elif action == "replace":
                if name in skills:
                    skills[name]["source"] = source_str
                    result["replaced"].append(name)
                else:
                    skills[name] = new_entry
                    result["registered"].append(name)
                continue
            elif action == "suffix":
                suffixed = f"{name}-{cand['origin']}"
                if suffixed in skills:
                    result["skipped"].append(
                        {"name": suffixed, "reason": "suffix_collision"}
                    )
                    continue
                new_entry_copy = dict(new_entry)
                skills[suffixed] = new_entry_copy
                result["suffixed"].append(suffixed)
                continue
            else:
                result["skipped"].append(
                    {"name": name, "reason": f"unknown_action:{action}"}
                )
                continue

        # NEW or BROKEN
        if name in skills:
            # Race: another selection already handled it
            result["skipped"].append({"name": name, "reason": "already_present"})
            continue
        skills[name] = new_entry
        result["registered"].append(name)

    return result
