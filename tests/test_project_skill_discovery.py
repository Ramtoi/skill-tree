"""Discovery + import of hand-authored project-local skills.

Regression cradle for the `goal-workflow` blind spot: a skill created directly
inside a project's `.claude/skills/` was invisible to the hub — not in the
registry, never scanned (the import scanner only walks USER-GLOBAL dirs), and
ignored by `hub sync` (push-only; cleanup only unlinks hub-owned symlinks). It
therefore never showed up in the Skill Tree app even after syncing.

Covers `scan_project_skill_candidates` (read-only detection used by the sync
rollup) and `cmd_project_import_skill` (explicit adoption).
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml


def _write_skill(target: Path, name: str, body: str = "test skill") -> Path:
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: |\n  {body}\n---\n"
    )
    return target


def _registry_with_project(proj_path: Path, **proj) -> dict:
    base = {"path": str(proj_path), "enabled": [], "bundles": []}
    base.update(proj)
    return {"skills": {}, "bundles": {}, "projects": {"demo": base}}


# ── detection ────────────────────────────────────────────────────────────────


def test_discovers_handauthored_project_skill(tmp_path):
    """The goal-workflow scenario: a real-dir SKILL.md unknown to the hub → NEW."""
    import hub

    proj = tmp_path / "repo"
    _write_skill(proj / ".claude" / "skills" / "goal-workflow", "goal-workflow")
    cands = hub.scan_project_skill_candidates(_registry_with_project(proj))

    assert len(cands) == 1
    assert cands[0]["name"] == "goal-workflow"
    assert cands[0]["category"] == "NEW"
    assert cands[0]["project"] == "demo"
    assert cands[0]["rel"] == str(Path(".claude/skills/goal-workflow"))


def test_symlinked_skill_not_flagged(tmp_path):
    """Hub-managed (symlinked) skills are not discoveries."""
    import hub

    real = tmp_path / "store" / "managed"
    _write_skill(real, "managed")
    skills_dir = tmp_path / "repo" / ".claude" / "skills"
    skills_dir.mkdir(parents=True)
    (skills_dir / "managed").symlink_to(real)

    assert hub.scan_project_skill_candidates(_registry_with_project(tmp_path / "repo")) == []


def test_registry_skill_not_flagged(tmp_path):
    """A real dir whose name is already a registry skill is not a discovery."""
    import hub

    proj = tmp_path / "repo"
    _write_skill(proj / ".claude" / "skills" / "known", "known")
    reg = _registry_with_project(proj)
    reg["skills"]["known"] = {"source": "~/whatever", "type": "claude-skill"}

    assert hub.scan_project_skill_candidates(reg) == []


def test_active_skill_not_flagged(tmp_path):
    """A skill already enabled on the project is not a discovery."""
    import hub

    proj = tmp_path / "repo"
    _write_skill(proj / ".claude" / "skills" / "enabled-one", "enabled-one")
    reg = _registry_with_project(proj, enabled=["enabled-one"])

    assert hub.scan_project_skill_candidates(reg) == []


def test_dir_without_skill_md_ignored(tmp_path):
    """A plain directory with no parseable SKILL.md is silently skipped."""
    import hub

    proj = tmp_path / "repo"
    d = proj / ".claude" / "skills" / "not-a-skill"
    d.mkdir(parents=True)
    (d / "README.md").write_text("nope")

    assert hub.scan_project_skill_candidates(_registry_with_project(proj)) == []


def test_invalid_slug_flagged_distinctly(tmp_path):
    """A SKILL.md whose name fails the slug pattern is INVALID_NAME, not NEW."""
    import hub

    proj = tmp_path / "repo"
    _write_skill(proj / ".claude" / "skills" / "weird", "Bad_Name")
    cands = hub.scan_project_skill_candidates(_registry_with_project(proj))

    assert len(cands) == 1
    assert cands[0]["category"] == "INVALID_NAME"
    assert cands[0]["name"] == "Bad_Name"


# ── import ───────────────────────────────────────────────────────────────────


def test_import_adopts_registers_and_enables(tmp_data_home):
    import hub

    proj = tmp_data_home / "demo-repo"
    _write_skill(
        proj / ".claude" / "skills" / "goal-workflow", "goal-workflow", "the goal skill"
    )
    hub.save_registry(
        {
            "skills": {},
            "bundles": {},
            "projects": {"demo": {"path": str(proj), "enabled": [], "bundles": []}},
        }
    )

    hub.cmd_project_import_skill(SimpleNamespace(project="demo", name="goal-workflow"))

    out = hub.load_registry()
    assert "goal-workflow" in out["skills"]
    assert out["skills"]["goal-workflow"]["scope"] == "project-specific"
    assert out["skills"]["goal-workflow"]["description"] == "the goal skill"
    assert "goal-workflow" in out["projects"]["demo"]["enabled"]
    # adopted into the data home …
    assert (hub.hub_skills_dir() / "goal-workflow" / "SKILL.md").exists()
    # … and the original real dir removed (sync re-creates it as a symlink)
    assert not (proj / ".claude" / "skills" / "goal-workflow").exists()
    # and it is no longer reported as a discovery
    assert hub.scan_project_skill_candidates(out) == []


def test_import_refuses_existing_registry_skill(tmp_data_home):
    """Importing a name that is already a registry skill must refuse (no clobber)."""
    import hub

    proj = tmp_data_home / "demo-repo"
    _write_skill(proj / ".claude" / "skills" / "dup", "dup")
    hub.save_registry(
        {
            "skills": {"dup": {"source": "~/x", "type": "claude-skill"}},
            "bundles": {},
            "projects": {"demo": {"path": str(proj), "enabled": [], "bundles": []}},
        }
    )

    with pytest.raises(SystemExit):
        hub.cmd_project_import_skill(SimpleNamespace(project="demo", name="dup"))
    assert (proj / ".claude" / "skills" / "dup" / "SKILL.md").exists()


def test_import_refuses_when_dest_exists(tmp_data_home):
    """A pre-existing data-home dir with the same name blocks import (original safe)."""
    import hub

    proj = tmp_data_home / "demo-repo"
    _write_skill(proj / ".claude" / "skills" / "goal-workflow", "goal-workflow")
    _write_skill(hub.hub_skills_dir() / "goal-workflow", "goal-workflow", "pre-existing")
    hub.save_registry(
        {
            "skills": {},
            "bundles": {},
            "projects": {"demo": {"path": str(proj), "enabled": [], "bundles": []}},
        }
    )

    with pytest.raises(SystemExit):
        hub.cmd_project_import_skill(
            SimpleNamespace(project="demo", name="goal-workflow")
        )
    assert (proj / ".claude" / "skills" / "goal-workflow" / "SKILL.md").exists()


def test_import_unknown_project_and_skill(tmp_data_home):
    import hub

    proj = tmp_data_home / "demo-repo"
    proj.mkdir(parents=True)
    hub.save_registry(
        {
            "skills": {},
            "bundles": {},
            "projects": {"demo": {"path": str(proj), "enabled": [], "bundles": []}},
        }
    )

    with pytest.raises(SystemExit):
        hub.cmd_project_import_skill(SimpleNamespace(project="nope", name="x"))
    with pytest.raises(SystemExit):
        hub.cmd_project_import_skill(SimpleNamespace(project="demo", name="ghost"))


# ── scan-skills CLI (the sanctioned discovery surface) ───────────────────────


def _seed_registry(data_home: Path, proj_path: Path, name: str = "demo") -> None:
    """Write a registry.yaml into the isolated data home with one project."""
    reg = {
        "skills": {},
        "bundles": {},
        "projects": {name: {"path": str(proj_path), "enabled": [], "bundles": []}},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg))


def test_scan_skills_cli_json_lists_new_candidate(tmp_data_home, tmp_path, capsys):
    import hub

    proj = tmp_path / "repo"
    _write_skill(proj / ".claude" / "skills" / "goal-workflow", "goal-workflow")
    _seed_registry(tmp_data_home, proj)

    hub.cmd_project_scan_skills(SimpleNamespace(project=None, json=True))
    out = json.loads(capsys.readouterr().out)
    assert [c["name"] for c in out] == ["goal-workflow"]
    assert out[0]["category"] == "NEW"
    # Read-only: nothing registered.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["skills"] == {}


def test_scan_skills_cli_reports_invalid_name(tmp_data_home, tmp_path, capsys):
    import hub

    proj = tmp_path / "repo"
    _write_skill(proj / ".claude" / "skills" / "Bad_Name", "Bad_Name")
    _seed_registry(tmp_data_home, proj)

    hub.cmd_project_scan_skills(SimpleNamespace(project="demo", json=True))
    out = json.loads(capsys.readouterr().out)
    assert out[0]["category"] == "INVALID_NAME"
    assert "reason" in out[0]


def test_scan_skills_cli_empty_is_zero_exit(tmp_data_home, tmp_path, capsys):
    import hub

    proj = tmp_path / "repo"
    (proj / ".claude" / "skills").mkdir(parents=True)
    _seed_registry(tmp_data_home, proj)

    hub.cmd_project_scan_skills(SimpleNamespace(project="demo", json=True))
    assert json.loads(capsys.readouterr().out) == []


def test_scan_skills_cli_project_filter(tmp_data_home, tmp_path, capsys):
    import hub

    a = tmp_path / "a"
    b = tmp_path / "b"
    _write_skill(a / ".claude" / "skills" / "skill-a", "skill-a")
    _write_skill(b / ".claude" / "skills" / "skill-b", "skill-b")
    reg = {
        "skills": {},
        "bundles": {},
        "projects": {
            "proj-a": {"path": str(a), "enabled": [], "bundles": []},
            "proj-b": {"path": str(b), "enabled": [], "bundles": []},
        },
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg))

    hub.cmd_project_scan_skills(SimpleNamespace(project="proj-a", json=True))
    out = json.loads(capsys.readouterr().out)
    assert [c["name"] for c in out] == ["skill-a"]


def test_scan_skills_cli_unknown_project_exits_nonzero(tmp_data_home, tmp_path):
    import hub

    _seed_registry(tmp_data_home, tmp_path / "repo")
    with pytest.raises(SystemExit) as ei:
        hub.cmd_project_scan_skills(SimpleNamespace(project="nope", json=True))
    assert ei.value.code == 1
