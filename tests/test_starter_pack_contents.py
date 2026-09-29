"""Lint the Starter Pack that ships inside the app (`skills/` in the repo).

Every dir here becomes a `managed: starter` registry entry on a user's machine
through `starter_skills.reconcile_starter_skills`, so a malformed SKILL.md is a
user-visible defect, not a dev-only one. `scripts/ci-changed-areas.sh` routes a
`skills/` change to the Python job so this file runs on CI for it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from skill_hub.application.skills import starter_skills
from skill_hub.domain.skills.skill_meta import parse_skill_frontmatter

REPO_ROOT = Path(__file__).resolve().parent.parent
PACK = REPO_ROOT / "skills"

DESCRIPTION_MAX = 200  # the hub's rule, and claude.ai's upload limit
BODY_MAX_LINES = 500  # the Agent Skills spec guidance
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MACHINE_PATH_RE = re.compile(r"/Users/|/home/[a-z]|[A-Za-z]:\\")
# A relative markdown link target: `](references/x.md)`; skips URLs and anchors.
LOCAL_LINK_RE = re.compile(r"\]\((?!https?://|#|mailto:)([^)\s]+)\)")


def _pack_dirs() -> list[Path]:
    return sorted(
        p for p in PACK.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))
    )


def test_pack_has_the_two_shipped_skills():
    assert {p.name for p in _pack_dirs()} >= {"skt-mcp", "skill-authoring"}


@pytest.mark.parametrize("skill_dir", _pack_dirs(), ids=lambda p: p.name)
def test_pack_skill_is_well_formed(skill_dir: Path):
    skill_md = skill_dir / "SKILL.md"
    assert skill_md.is_file(), f"{skill_dir.name}: SKILL.md missing"
    meta = parse_skill_frontmatter(skill_md)
    assert meta, f"{skill_dir.name}: frontmatter does not parse"

    name = str(meta.get("name") or "").strip()
    assert name == skill_dir.name, f"frontmatter name {name!r} != dir {skill_dir.name!r}"
    assert NAME_RE.match(name), f"{name!r} is not a slug"

    description = " ".join(str(meta.get("description") or "").split())
    assert description, f"{name}: description missing"
    assert len(description) <= DESCRIPTION_MAX, (
        f"{name}: description is {len(description)} chars (max {DESCRIPTION_MAX})"
    )

    text = skill_md.read_text()
    assert len(text.splitlines()) <= BODY_MAX_LINES, f"{name}: SKILL.md over {BODY_MAX_LINES} lines"

    for path in sorted(skill_dir.rglob("*.md")):
        body = path.read_text()
        rel = path.relative_to(PACK)
        assert not MACHINE_PATH_RE.search(body), f"{rel}: machine-specific path"
        for target in LOCAL_LINK_RE.findall(body):
            assert (path.parent / target).exists(), f"{rel}: link target missing: {target}"
        assert not path.is_symlink(), f"{rel}: symlink inside a pack skill"


def test_every_pack_dir_is_discoverable():
    warnings: list[str] = []
    found = starter_skills.discover_starter_skills(PACK, warn=warnings.append)
    assert warnings == []
    assert [s["name"] for s in found] == [p.name for p in _pack_dirs()]


def test_pack_is_bundled_into_the_app():
    conf = json.loads((REPO_ROOT / "app" / "src-tauri" / "tauri.conf.json").read_text())
    assert conf["bundle"]["resources"].get("../../skills") == "hub/skills"


def test_smoke_test_proves_the_pack_ships():
    smoke = (REPO_ROOT / "scripts" / "smoke-test-bundle.sh").read_text()
    assert "hub/skills/skill-authoring/SKILL.md" in smoke
