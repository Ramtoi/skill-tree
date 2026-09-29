"""Built-in skills (the Starter Pack): discovery, registry reconcile, the sync
pass, and the archive refusal.

Hermetic: `tmp_data_home` isolates the registry; the conftest points
`SKILL_HUB_STARTER_ROOT` at an empty dir, and each test here re-points it (or
`SKILL_HUB_CODE`) at a pack it seeds itself.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pytest
import yaml

import hub
from skill_hub import hub_core
from skill_hub.application.skills import starter_skills


def _write_pack_skill(
    root: Path,
    dirname: str,
    *,
    name: str | None = None,
    description: str = "Does X for Y. Use on 'do x'.",
    version: str | None = None,
) -> Path:
    d = root / dirname
    d.mkdir(parents=True)
    fm_name = dirname if name is None else name
    lines = [f"name: {fm_name}", f"description: {description}"]
    if version is not None:
        lines.append(f"version: {version}")
    (d / "SKILL.md").write_text("---\n" + "\n".join(lines) + "\n---\n\n# Body\n")
    return d


@pytest.fixture
def pack(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "pack"
    root.mkdir()
    monkeypatch.setenv(starter_skills.STARTER_ROOT_ENV, str(root))
    return root


# ─── root resolution ────────────────────────────────────────────────────────


def test_conftest_seam_points_discovery_at_an_empty_dir():
    root = starter_skills.starter_skills_root()
    assert root == Path(os.environ[starter_skills.STARTER_ROOT_ENV])
    assert root.is_dir()
    assert starter_skills.discover_starter_skills(root) == []


def test_root_falls_back_to_code_home_skills(monkeypatch):
    monkeypatch.delenv(starter_skills.STARTER_ROOT_ENV, raising=False)
    assert starter_skills.starter_skills_root() == hub_core.code_home() / "skills"


# ─── discovery ──────────────────────────────────────────────────────────────


def test_discover_accepts_a_skill_named_like_its_dir(pack):
    _write_pack_skill(pack, "alpha", description="Line one\n  line two")
    found = starter_skills.discover_starter_skills(pack)
    assert [s["name"] for s in found] == ["alpha"]
    assert found[0]["path"] == pack / "alpha"
    assert found[0]["description"] == "Line one line two"
    assert found[0]["version"] == "1.0.0"


def test_discover_skips_everything_that_does_not_qualify(pack):
    (pack / "no-skill-md").mkdir()
    _write_pack_skill(pack, "renamed", name="other")
    _write_pack_skill(pack, "Bad_Slug", name="Bad_Slug")
    (pack / "_archive").mkdir()
    (pack / ".hidden").mkdir()
    (pack / "unparseable").mkdir()
    (pack / "unparseable" / "SKILL.md").write_text("no frontmatter here\n")
    _write_pack_skill(pack, "good")

    warnings: list[str] = []
    found = starter_skills.discover_starter_skills(pack, warn=warnings.append)

    assert [s["name"] for s in found] == ["good"]
    joined = "\n".join(warnings)
    assert "no-skill-md" in joined
    assert "renamed" in joined and "must equal the directory name" in joined
    assert "Bad_Slug" in joined
    assert "unparseable" in joined
    assert "_archive" not in joined and ".hidden" not in joined


def test_discover_missing_root_is_empty(tmp_path):
    assert starter_skills.discover_starter_skills(tmp_path / "nope") == []


# ─── reconcile ──────────────────────────────────────────────────────────────


def test_reconcile_registers_a_new_builtin_and_is_idempotent(pack):
    d = _write_pack_skill(pack, "alpha", version="2.3.0")
    registry: dict = {"skills": {}}

    result = starter_skills.reconcile_starter_skills(registry)

    assert result["changed"] is True
    assert result["registered"] == ["alpha"]
    assert registry["skills"]["alpha"] == {
        "version": "2.3.0",
        "description": "Does X for Y. Use on 'do x'.",
        "source": hub_core.collapse_home(d),
        "type": "claude-skill",
        "scope": "portable",
        "upstream": None,
        "managed": "starter",
    }

    again = starter_skills.reconcile_starter_skills(registry)
    assert again["changed"] is False
    assert again["registered"] == again["updated"] == again["repointed"] == []


def test_reconcile_creates_the_skills_block_when_absent(pack):
    _write_pack_skill(pack, "alpha")
    registry: dict = {}
    starter_skills.reconcile_starter_skills(registry)
    assert "alpha" in registry["skills"]


def test_reconcile_never_touches_a_user_skill_of_the_same_name(pack, tmp_data_home):
    _write_pack_skill(pack, "alpha")
    mine = tmp_data_home / "skills" / "alpha"
    mine.mkdir(parents=True)
    user_entry = {
        "version": "9.9.9",
        "description": "mine",
        "source": str(mine),
        "type": "claude-skill",
        "scope": "global",
        "upstream": None,
    }
    registry = {"skills": {"alpha": dict(user_entry)}}

    result = starter_skills.reconcile_starter_skills(registry)

    assert result["changed"] is False
    assert result["skipped"] == [("alpha", "a local skill with this name shadows the built-in")]
    assert registry["skills"]["alpha"] == user_entry


def test_reconcile_repoints_a_vanished_source_but_not_a_live_one(pack, tmp_path):
    d = _write_pack_skill(pack, "alpha")
    gone = tmp_path / "old-app" / "skills" / "alpha"
    registry = {
        "skills": {
            "alpha": {
                "version": "1.0.0",
                "description": "Does X for Y. Use on 'do x'.",
                "source": str(gone),
                "type": "claude-skill",
                "scope": "global",  # a user-chosen scope survives the re-point
                "upstream": None,
                "managed": "starter",
            }
        }
    }

    result = starter_skills.reconcile_starter_skills(registry)
    assert result["repointed"] == ["alpha"]
    assert registry["skills"]["alpha"]["source"] == hub_core.collapse_home(d)
    assert registry["skills"]["alpha"]["scope"] == "global"

    # A second copy that still exists (dev checkout beside an installed app)
    # is left alone: no flip-flop between two live roots.
    other = tmp_path / "other-app" / "skills" / "alpha"
    other.mkdir(parents=True)
    registry["skills"]["alpha"]["source"] = str(other)
    result = starter_skills.reconcile_starter_skills(registry)
    assert result["repointed"] == []
    assert registry["skills"]["alpha"]["source"] == str(other)


def test_reconcile_mirrors_description_version_and_managed(pack):
    d = _write_pack_skill(pack, "alpha", description="New words.", version="1.1.0")
    # Legacy shape: no `managed`, inferred starter only through its code-home
    # path. Make the path count as starter by pointing SKILL_HUB_CODE at it.
    registry = {
        "skills": {
            "alpha": {
                "version": "1.0.0",
                "description": "Old words.",
                "source": str(d),
                "type": "claude-skill",
                "scope": "portable",
                "upstream": None,
                "managed": "starter",
            }
        }
    }
    result = starter_skills.reconcile_starter_skills(registry)
    assert result["updated"] == ["alpha"]
    assert result["repointed"] == []
    cfg = registry["skills"]["alpha"]
    assert (cfg["description"], cfg["version"], cfg["managed"]) == ("New words.", "1.1.0", "starter")


# ─── the sync pass ──────────────────────────────────────────────────────────


class _Counter:
    def __init__(self, ret=0):
        self.calls = 0
        self.ret = ret

    def __call__(self, *a, **k):
        self.calls += 1
        return self.ret


def _quiet_streams(monkeypatch) -> None:
    monkeypatch.setattr(hub, "_run_remote_dispatch", _Counter())
    monkeypatch.setattr(hub, "_run_permissions_stream", _Counter())
    monkeypatch.setattr(hub, "_run_hooks_stream", _Counter())


def _seed_code_home_pack(tmp_data_home: Path, monkeypatch) -> Path:
    """A code home beside the data home whose skills/ IS the pack, so the
    registered source sits under code_home() and ownership inference agrees."""
    code_root = tmp_data_home.parent / f"{tmp_data_home.name}-code"
    code_root.mkdir(exist_ok=True)
    (code_root / "hub.py").write_text("# placeholder\n")
    (code_root / "skills").mkdir(exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_CODE", str(code_root))
    monkeypatch.delenv(starter_skills.STARTER_ROOT_ENV, raising=False)
    return code_root / "skills"


def _write_registry(data_home: Path, *, harnesses: list[str]) -> Path:
    proj = data_home / "projects" / "alpha-proj"
    proj.mkdir(parents=True, exist_ok=True)
    registry = {
        "version": "1",
        "harnesses_global": harnesses,
        "skills": {},
        "projects": {
            "alpha-proj": {"path": str(proj), "enabled": [], "bundles": [], "harnesses": []}
        },
        "bundles": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    return proj


def _load(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def test_sync_registers_the_pack_and_reports_it(tmp_data_home, monkeypatch, capsys):
    pack = _seed_code_home_pack(tmp_data_home, monkeypatch)
    _write_pack_skill(pack, "alpha")
    _write_registry(tmp_data_home, harnesses=[])
    _quiet_streams(monkeypatch)

    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out

    reg = _load(tmp_data_home)
    assert reg["skills"]["alpha"]["managed"] == "starter"
    assert reg["skills"]["alpha"]["scope"] == "portable"
    assert "registered built-in alpha" in out
    # Not equipped anywhere: nothing is linked, the built-in is only offered.
    assert reg["projects"]["alpha-proj"]["enabled"] == []

    # A second sync is quiet about it.
    hub.cmd_sync(argparse.Namespace())
    assert "registered built-in" not in capsys.readouterr().out


def test_sync_with_an_empty_pack_registers_nothing(tmp_data_home, monkeypatch, capsys):
    _write_registry(tmp_data_home, harnesses=[])
    _quiet_streams(monkeypatch)
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    assert _load(tmp_data_home)["skills"] == {}


def test_equipped_builtin_links_into_the_code_home(tmp_data_home, monkeypatch, capsys):
    pack = _seed_code_home_pack(tmp_data_home, monkeypatch)
    _write_pack_skill(pack, "alpha")
    # Mark claude-code as installed inside the fake home.
    (Path(os.environ["HOME"]) / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    proj = _write_registry(tmp_data_home, harnesses=["claude-code"])
    _quiet_streams(monkeypatch)

    hub.cmd_sync(argparse.Namespace())
    hub.cmd_enable(argparse.Namespace(skill="alpha", project="alpha-proj"))
    capsys.readouterr()

    link = proj / ".claude" / "skills" / "alpha"
    assert link.is_symlink()
    assert Path(os.readlink(link)).resolve() == (pack / "alpha").resolve()
    assert "alpha" in _load(tmp_data_home)["projects"]["alpha-proj"]["enabled"]


# ─── archive refusal ────────────────────────────────────────────────────────


def test_archive_refuses_a_builtin(tmp_data_home, monkeypatch, capsys):
    pack = _seed_code_home_pack(tmp_data_home, monkeypatch)
    d = _write_pack_skill(pack, "alpha")
    _write_registry(tmp_data_home, harnesses=[])
    reg = _load(tmp_data_home)
    reg["skills"]["alpha"] = starter_skills.starter_entry(
        {"name": "alpha", "path": d, "description": "d", "version": "1.0.0"}
    )
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    monkeypatch.setattr(hub, "_auto_sync", _Counter())

    with pytest.raises(SystemExit) as exc:
        hub.cmd_archive(argparse.Namespace(skills=["alpha"], json=False, dry_run=False))
    out = capsys.readouterr().out

    assert exc.value.code == 1
    assert "built-in" in out and "alpha" in out
    assert "alpha" in _load(tmp_data_home)["skills"]
    assert not (tmp_data_home / "state" / "archive" / "alpha.json").exists()
