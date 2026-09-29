"""Built-in skills: the Starter Pack shipped under ``code_home()/skills/``.

A leaf: at module scope it imports ``hub_core``, ``skill_meta`` and ``sources``
only, never ``hub`` or ``hub_cli`` (``tests/test_hub_split_guard.py::LEAF_SIBLINGS``).

Every ``hub sync`` runs ``reconcile_starter_skills`` before it validates the
registry. The pass registers each bundled skill under its frontmatter ``name``
as a ``managed: starter`` entry, mirrors the pack's ``description`` and
``version`` into an entry it owns, and re-points an entry whose recorded
``source`` no longer exists on disk (the app moved or was upgraded). It never
touches an entry the user already owns under the same name, and it never
removes anything: a built-in that a later app version drops keeps its entry and
surfaces as ``source missing`` like any other skill.

Registered entries start as ``scope: portable``: a built-in is offered, not
imposed. It reaches a session only after the user equips it on a project or
widens its scope. ``hub archive`` refuses a built-in for the same reason
``hub hook delete`` refuses a built-in hook: the next sync would register it
again, so the honest answer is "unequip it" rather than a delete that does
not stick.

Discovery honours ``SKILL_HUB_STARTER_ROOT``: when set, the pack is read from
that directory instead of ``code_home()/skills``. The test suite points it at
an empty directory so a sync inside a fixture never imports the repo's real
pack; a developer can point it at a scratch pack for the same reason.
Ownership inference (``sources.infer_skill_ownership``) is not affected: the
entries this module writes carry an explicit ``managed: starter``.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable, Optional

from skill_hub import hub_core
from skill_hub.domain.skills.skill_meta import parse_skill_frontmatter
from skill_hub.infrastructure.registry import sources

STARTER_ROOT_ENV = "SKILL_HUB_STARTER_ROOT"

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

WarnFn = Callable[[str], None]


def starter_skills_root() -> Path:
    """Where the Starter Pack is read from.

    ``SKILL_HUB_STARTER_ROOT`` wins when set (tests, scratch packs); otherwise
    the code home's ``skills/`` directory, the same root
    ``sources.infer_skill_ownership`` treats as starter-owned.
    """
    env = os.environ.get(STARTER_ROOT_ENV, "").strip()
    if env:
        return Path(env).expanduser().absolute()
    return sources._starter_skills_root()


def discover_starter_skills(root: Path, *, warn: Optional[WarnFn] = None) -> list[dict]:
    """List the bundled skills under ``root`` that can be registered.

    A skill dir qualifies when it holds a ``SKILL.md`` whose frontmatter names
    it, the name is a slug, and the name equals the directory name (the Agent
    Skills spec requires the match, and it keeps registry key, symlink name and
    frontmatter name identical). Anything else is skipped with one warning.
    Dot- and underscore-prefixed dirs are ignored silently.
    """

    def _warn(message: str) -> None:
        if warn is not None:
            warn(message)

    if not root.is_dir():
        return []
    found: list[dict] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith((".", "_")):
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.is_file():
            _warn(f"built-in skill dir '{entry.name}' has no SKILL.md; skipped")
            continue
        meta = parse_skill_frontmatter(skill_md)
        if not meta:
            _warn(f"built-in skill '{entry.name}': SKILL.md has no readable frontmatter; skipped")
            continue
        raw_name = meta.get("name")
        name = str(raw_name).strip() if raw_name is not None else ""
        if not name or not _NAME_RE.match(name):
            _warn(f"built-in skill '{entry.name}': frontmatter name {name!r} is not a slug; skipped")
            continue
        if name != entry.name:
            _warn(
                f"built-in skill '{entry.name}': frontmatter name '{name}' must equal "
                "the directory name; skipped"
            )
            continue
        raw_desc = meta.get("description")
        description = " ".join(str(raw_desc).split()) if raw_desc is not None else ""
        raw_version = meta.get("version")
        version = str(raw_version).strip() if raw_version is not None else "1.0.0"
        found.append(
            {
                "name": name,
                "path": entry,
                "description": description,
                "version": version or "1.0.0",
            }
        )
    return found


def starter_entry(skill: dict) -> dict:
    """The registry entry a freshly discovered built-in is registered as."""
    return {
        "version": skill["version"],
        "description": skill["description"],
        "source": hub_core.collapse_home(Path(skill["path"])),
        "type": "claude-skill",
        "scope": "portable",
        "upstream": None,
        "managed": "starter",
    }


def is_starter_skill(name: str, cfg: dict) -> bool:
    """True when the registry entry is a built-in (explicit or inferred)."""
    return sources.infer_skill_ownership(name, cfg)["managed"] == "starter"


def reconcile_starter_skills(
    registry: dict,
    *,
    root: Optional[Path] = None,
    warn: Optional[WarnFn] = None,
) -> dict:
    """Bring ``registry["skills"]`` in line with the Starter Pack on disk.

    Mutates ``registry`` in place and returns
    ``{"changed": bool, "registered": [...], "updated": [...],
    "repointed": [...], "skipped": [(name, reason), ...]}``.

    * a pack skill with no entry is **registered** (``starter_entry``);
    * an entry this pass owns (``managed: starter``, or inferred starter) gets
      its ``description``/``version`` mirrored from the pack (**updated**) and
      its ``source`` **repointed** only when the recorded path no longer
      exists, never while another copy still resolves (a dev checkout and an
      installed app can both hold the pack);
    * an entry the user owns under the same name is **skipped**: a local skill
      always shadows a built-in.
    """
    if root is None:
        root = starter_skills_root()
    skills = registry.get("skills")
    if not isinstance(skills, dict):
        skills = {}
        registry["skills"] = skills

    result: dict = {
        "changed": False,
        "registered": [],
        "updated": [],
        "repointed": [],
        "skipped": [],
    }
    for skill in discover_starter_skills(root, warn=warn):
        name = skill["name"]
        new_source = hub_core.collapse_home(Path(skill["path"]))
        cfg = skills.get(name)
        if cfg is None:
            skills[name] = starter_entry(skill)
            result["registered"].append(name)
            result["changed"] = True
            continue
        if not isinstance(cfg, dict) or not is_starter_skill(name, cfg):
            result["skipped"].append((name, "a local skill with this name shadows the built-in"))
            continue
        recorded = cfg.get("source")
        recorded_path = (
            Path(str(recorded)).expanduser() if isinstance(recorded, str) and recorded else None
        )
        if recorded_path is None or (
            not recorded_path.exists() and recorded_path != Path(new_source).expanduser()
        ):
            cfg["source"] = new_source
            result["repointed"].append(name)
            result["changed"] = True
        mirrored = False
        if cfg.get("description") != skill["description"]:
            cfg["description"] = skill["description"]
            mirrored = True
        if cfg.get("version") != skill["version"]:
            cfg["version"] = skill["version"]
            mirrored = True
        if cfg.get("managed") != "starter":
            cfg["managed"] = "starter"
            mirrored = True
        if mirrored:
            result["updated"].append(name)
            result["changed"] = True
    return result
