"""Rename variants for source-managed skills registered under a suffixed key.

`hub source add git --decisions-stdin` can resolve a name conflict with the
`suffix` decision: the incoming skill is registered as `qa-2` while its files
stay in the source's git worktree, where SKILL.md still says `name: qa`. Hub
never rewrites an external checkout, so key ≠ frontmatter-name is PERMANENT for
those entries — and a harness identifies a skill by its frontmatter name, so
linking the worktree dir straight through would advertise a second skill called
`qa`.

The fix mirrors the invocation-override precedent: sync links such a skill
through a generated variant dir (`state/skill_variants/<key>@renamed/`) whose
SKILL.md declares the registry key, and every consumer that reads skill CONTENT
substitutes the same patched bytes.

Covers: the renderer, the validator's warn-vs-fail split, sync mechanics
(variant creation, coexistence with the same-named skill, regeneration, orphan
cleanup, idempotency, composition with an invocation override), global-scope
links, the zip/pack exports, and the remote desired state.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import zipfile
from pathlib import Path

import pytest
import yaml

BODY = "\n# QA\n\nReview the thing.\n"


# ─────────────────────────────────────────────────────────────────────────────
# Fixture: the live shape — a source worktree skill named `qa`, registered as
# `qa-2` because a hub-owned `qa` already existed.
# ─────────────────────────────────────────────────────────────────────────────


def _write_skill(root: Path, name: str, body: str = BODY) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: quality pass\n---{body}"
    )
    (root / "helper.txt").write_text("resource\n")
    refs = root / "references"
    refs.mkdir(exist_ok=True)
    (refs / "notes.md").write_text("nested reference\n")
    return root


def _skill_cfg(src: Path, **extra) -> dict:
    cfg = {
        "version": "1.0.0",
        "description": "quality pass",
        "source": str(src),
        "type": "claude-skill",
        "scope": "portable",
        "upstream": None,
    }
    cfg.update(extra)
    return cfg


def _external_cfg(src: Path, source_id: str = "pstack", path: str = "qa") -> dict:
    return _skill_cfg(
        src, managed="external", origin={"source": source_id, "path": path, "ref": "main"}
    )


def _write_registry(data_home: Path, skills: dict, projects: dict, **extra) -> None:
    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": skills,
        "projects": projects,
        "bundles": {},
        "sources": {
            "pstack": {
                "type": "git",
                "url": "https://example.invalid/pstack.git",
                "path": str(data_home / "sources" / "pstack" / "worktree"),
            }
        },
    }
    registry.update(extra)
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _project_cfg(path: Path, enabled: list[str], **extra) -> dict:
    cfg = {"path": str(path), "enabled": enabled, "bundles": [], "harnesses": []}
    cfg.update(extra)
    return cfg


@pytest.fixture
def claude_only_env(tmp_data_home, monkeypatch):
    """Claude Code detected as installed; its global skills dir inside tmp."""
    from skill_hub.infrastructure.harnesses import harnesses

    fake_global = tmp_data_home / "fake-globals"
    fake_global.mkdir()
    patched = {}
    for h_id, h in harnesses.HARNESSES.items():
        patched[h_id] = dataclasses.replace(
            h,
            detect=(lambda h_id=h_id: h_id == "claude-code"),
            global_skills_dir=h.global_skills_dir.__class__(
                str(fake_global / h_id / "skills")
            ),
        )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    return tmp_data_home


@pytest.fixture
def suffix_env(claude_only_env):
    """The reproduction: `qa` (hub-owned) + `qa-2` (source worktree, name: qa)."""
    data_home = claude_only_env
    upstream = _write_skill(
        data_home / "sources" / "pstack" / "worktree" / "qa", "qa"
    )
    owned = _write_skill(data_home / "skills" / "qa", "qa")
    proj = data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        data_home,
        {"qa": _skill_cfg(owned), "qa-2": _external_cfg(upstream)},
        {"p1": _project_cfg(proj, ["qa", "qa-2"])},
    )
    return data_home, upstream, owned, proj


def _sync():
    import hub

    hub.cmd_sync(argparse.Namespace(skip_permissions=True, skip_remotes=True))


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _write_registry_dict(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _variant(data_home: Path, name: str, mode: str = "renamed") -> Path:
    return data_home / "state" / "skill_variants" / f"{name}@{mode}"


# ─────────────────────────────────────────────────────────────────────────────
# render_name_frontmatter (unit)
# ─────────────────────────────────────────────────────────────────────────────


def test_render_name_rewrites_only_the_name_key():
    import hub

    text = (
        "---\nname: qa\ndescription: about the qa name in prose\n"
        "harnesses: [claude-code]\n---\n\n# qa\n\nname: not-frontmatter\n"
    )
    out = hub.render_name_frontmatter(text, "qa-2")

    assert out is not None
    assert hub.parse_frontmatter_text(out)["name"] == "qa-2"
    assert "description: about the qa name in prose" in out
    assert "harnesses: [claude-code]" in out
    assert out.endswith("\n# qa\n\nname: not-frontmatter\n")


@pytest.mark.parametrize("line", ["name: qa", 'name: "qa"', "name: 'qa'", "name:   qa"])
def test_render_name_handles_quoted_and_padded_names(line):
    import hub

    out = hub.render_name_frontmatter(f"---\n{line}\ndescription: d\n---\nbody\n", "qa-2")

    assert out is not None
    assert hub.parse_frontmatter_text(out)["name"] == "qa-2"


def test_render_name_marker_is_added_once_and_is_idempotent():
    import hub

    first = hub.render_name_frontmatter(
        "---\nname: qa\ndescription: d\n---\nbody\n", "qa-2", generated_marker=True
    )
    assert first.count(hub.RENAME_MARKER_COMMENT) == 1

    second = hub.render_name_frontmatter(first, "qa-2", generated_marker=True)
    assert second == first


def test_render_name_refuses_unrenderable_input():
    import hub

    # No frontmatter at all.
    assert hub.render_name_frontmatter("# just prose\n", "qa-2") is None
    # Frontmatter without a `name:` key — nothing to rewrite.
    assert hub.render_name_frontmatter("---\ndescription: d\n---\nb\n", "qa-2") is None
    # A registry key that is not a bare slug can't be emitted unquoted.
    assert hub.render_name_frontmatter("---\nname: qa\n---\nb\n", "qa 2") is None


# ─────────────────────────────────────────────────────────────────────────────
# skill_rename_patch (unit)
# ─────────────────────────────────────────────────────────────────────────────


def test_rename_patch_only_applies_to_source_managed_mismatches(suffix_env):
    import hub

    data_home, upstream, owned, _ = suffix_env
    skills = _read_registry(data_home)["skills"]

    patched = hub.skill_rename_patch("qa-2", skills["qa-2"])
    assert patched is not None
    assert hub.parse_frontmatter_text(patched)["name"] == "qa-2"

    # Names agree → no patch.
    assert hub.skill_rename_patch("qa", skills["qa"]) is None
    # Hub-owned skill with a mismatch → no patch (hub owns the file; that is a
    # hard error in the validator, not something to paper over).
    assert hub.skill_rename_patch("renamed-owned", skills["qa"]) is None
    # Missing source dir → no patch, no crash.
    assert hub.skill_rename_patch("ghost", _external_cfg(data_home / "nope")) is None


# ─────────────────────────────────────────────────────────────────────────────
# validate_registry_skills
# ─────────────────────────────────────────────────────────────────────────────


def test_validator_warns_instead_of_failing_for_source_managed_rename(
    suffix_env, capsys
):
    import hub

    data_home, *_ = suffix_env

    hub.validate_registry_skills(hub.load_registry())  # must not SystemExit

    out = capsys.readouterr().out
    assert "qa-2" in out and "renamed variant" in out


def test_validator_still_fails_for_a_hub_owned_mismatch(claude_only_env, capsys):
    import hub

    data_home = claude_only_env
    owned = _write_skill(data_home / "skills" / "widget", "not-widget")
    _write_registry(data_home, {"widget": _skill_cfg(owned)}, {})

    with pytest.raises(SystemExit) as exc:
        hub.validate_registry_skills(hub.load_registry())

    assert exc.value.code == 1
    assert "must match registry key" in capsys.readouterr().err


def test_validator_falls_back_to_the_hard_error_when_rename_is_impossible(
    claude_only_env, capsys
):
    """A source-managed skill whose key cannot be written as frontmatter."""
    import hub

    data_home = claude_only_env
    upstream = _write_skill(data_home / "sources" / "pstack" / "worktree" / "qa", "qa")
    _write_registry(data_home, {"qa 2": _external_cfg(upstream)}, {})

    with pytest.raises(SystemExit):
        hub.validate_registry_skills(hub.load_registry())

    assert "must match registry key" in capsys.readouterr().err


def test_validator_still_fails_on_a_real_duplicate_effective_name(
    claude_only_env, capsys
):
    """The duplicate guard survives: two hub-owned skills claiming one name."""
    import hub

    data_home = claude_only_env
    a = _write_skill(data_home / "skills" / "a", "a")
    b = _write_skill(data_home / "skills" / "b", "a")
    _write_registry(data_home, {"a": _skill_cfg(a), "b": _skill_cfg(b)}, {})

    with pytest.raises(SystemExit):
        hub.validate_registry_skills(hub.load_registry())

    assert "duplicate skill name 'a'" in capsys.readouterr().err


def test_rename_clears_the_false_duplicate_with_the_same_named_skill(
    suffix_env, capsys
):
    """`qa` (hub) + `qa-2` (upstream name `qa`) are NOT a duplicate: the renamed
    variant makes the effective names `qa` and `qa-2`."""
    import hub

    hub.validate_registry_skills(hub.load_registry())

    err = capsys.readouterr().err
    assert "duplicate skill name" not in err


# ─────────────────────────────────────────────────────────────────────────────
# Sync mechanics
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_links_renamed_skill_to_a_patched_variant(suffix_env, capsys):
    import hub

    data_home, upstream, owned, proj = suffix_env

    _sync()
    capsys.readouterr()

    skills_dir = proj / ".claude" / "skills"
    variant = _variant(data_home, "qa-2")

    # The renamed skill links to the variant; the same-named hub skill links
    # straight to its library dir. Both coexist, with distinct runtime names.
    assert Path(os.readlink(skills_dir / "qa-2")).resolve() == variant.resolve()
    assert Path(os.readlink(skills_dir / "qa")).resolve() == owned.resolve()

    assert hub.parse_skill_frontmatter_name(variant / "SKILL.md") == "qa-2"
    assert hub.parse_skill_frontmatter_name(skills_dir / "qa" / "SKILL.md") == "qa"
    assert hub.RENAME_MARKER_COMMENT in (variant / "SKILL.md").read_text()
    assert (variant / "SKILL.md").read_text().endswith(BODY)

    # Ownership: every readlink target stays under data_home.
    for link in (skills_dir / "qa-2", skills_dir / "qa"):
        assert str(Path(os.readlink(link)).resolve()).startswith(str(data_home))

    # The upstream checkout is untouched.
    assert hub.parse_skill_frontmatter_name(upstream / "SKILL.md") == "qa"

    # Non-SKILL.md entries are symlinks back into the checkout.
    assert (variant / "helper.txt").is_symlink()
    assert (variant / "references").is_symlink()
    assert (variant / "references" / "notes.md").read_text() == "nested reference\n"


def test_sync_exits_clean_on_the_suffix_fixture(suffix_env, capsys):
    """The regression: the first full sync after a suffix import used to die in
    `validate_registry_skills` and sync NOTHING."""
    _sync()
    capsys.readouterr()

    data_home, _, _, proj = suffix_env
    report = json.loads((data_home / "state" / "sync-report.json").read_text())
    assert report["projects"]["p1"]["ok"] is True
    assert report["projects"]["p1"]["errors"] == []


def test_second_sync_is_write_free(suffix_env, capsys):
    data_home, *_ = suffix_env

    _sync()
    variant_md = _variant(data_home, "qa-2") / "SKILL.md"
    first = variant_md.read_text()

    _sync()
    capsys.readouterr()

    report = json.loads((data_home / "state" / "sync-report.json").read_text())
    assert report["projects"]["p1"]["writes"] == 0
    assert variant_md.read_text() == first


def test_upstream_edits_regenerate_the_variant(suffix_env, capsys):
    data_home, upstream, _, _ = suffix_env
    _sync()

    text = (upstream / "SKILL.md").read_text()
    (upstream / "SKILL.md").write_text(text.replace("Review the thing.", "Review MORE."))
    (upstream / "extra.md").write_text("more\n")
    _sync()
    capsys.readouterr()

    variant = _variant(data_home, "qa-2")
    patched = (variant / "SKILL.md").read_text()
    assert "Review MORE." in patched
    assert "name: qa-2" in patched
    assert (variant / "extra.md").is_symlink()


def test_variant_is_collected_when_the_skill_is_unregistered(suffix_env, capsys):
    data_home, _, _, proj = suffix_env
    _sync()
    variant = _variant(data_home, "qa-2")
    assert variant.is_dir()

    reg = _read_registry(data_home)
    del reg["skills"]["qa-2"]
    reg["projects"]["p1"]["enabled"] = ["qa"]
    _write_registry_dict(data_home, reg)
    _sync()
    capsys.readouterr()

    assert not variant.exists()
    assert not (proj / ".claude" / "skills" / "qa-2").exists()


def test_variant_is_collected_when_upstream_name_catches_up(suffix_env, capsys):
    data_home, upstream, _, _ = suffix_env
    _sync()
    variant = _variant(data_home, "qa-2")
    assert variant.is_dir()

    text = (upstream / "SKILL.md").read_text()
    (upstream / "SKILL.md").write_text(text.replace("name: qa\n", "name: qa-2\n"))
    _sync()
    capsys.readouterr()

    assert not variant.exists()


def test_global_scope_renamed_skill_links_to_the_variant(claude_only_env, capsys):
    import hub
    from skill_hub.infrastructure.harnesses import harnesses

    data_home = claude_only_env
    upstream = _write_skill(data_home / "sources" / "pstack" / "worktree" / "qa", "qa")
    cfg = _external_cfg(upstream)
    cfg["scope"] = "global"
    _write_registry(data_home, {"qa-2": cfg}, {})

    _sync()
    capsys.readouterr()

    global_dir = Path(str(harnesses.HARNESSES["claude-code"].global_skills_dir))
    link = global_dir / "qa-2"
    assert Path(os.readlink(link)).resolve() == _variant(data_home, "qa-2").resolve()
    assert hub.parse_skill_frontmatter_name(link / "SKILL.md") == "qa-2"


def test_invocation_override_composes_on_top_of_a_rename(suffix_env, capsys):
    import hub

    data_home, _, _, proj = suffix_env
    reg = _read_registry(data_home)
    reg["projects"]["p1"]["invocation_overrides"] = {"qa-2": "user-only"}
    _write_registry_dict(data_home, reg)

    _sync()
    capsys.readouterr()

    link = proj / ".claude" / "skills" / "qa-2"
    inv_variant = _variant(data_home, "qa-2", "user-only")
    assert Path(os.readlink(link)).resolve() == inv_variant.resolve()

    patched = (inv_variant / "SKILL.md").read_text()
    assert hub.parse_frontmatter_text(patched)["name"] == "qa-2"
    assert "disable-model-invocation: true" in patched


# ─────────────────────────────────────────────────────────────────────────────
# Content consumers: zip / pack export, remote push
# ─────────────────────────────────────────────────────────────────────────────


def test_zip_export_carries_the_registry_key(suffix_env, tmp_path, capsys):
    import hub

    hub.cmd_skill_export(
        argparse.Namespace(
            name="qa-2", out=str(tmp_path / "qa-2.zip"), json=False, format="zip"
        )
    )
    capsys.readouterr()

    with zipfile.ZipFile(tmp_path / "qa-2.zip") as zf:
        names = set(zf.namelist())
        skill_md = zf.read("qa-2/SKILL.md").decode()

    assert hub.parse_frontmatter_text(skill_md)["name"] == "qa-2"
    # The rename must not cost the skill its other files (a variant dir walked
    # naively would drop everything under a symlinked subdir).
    assert "qa-2/helper.txt" in names
    assert "qa-2/references/notes.md" in names


def test_pack_export_carries_the_registry_key(suffix_env, tmp_path, capsys):
    import hub

    hub.cmd_skill_export(
        argparse.Namespace(
            name="qa-2", out=str(tmp_path / "qa-2.skillpack"), json=False, format="pack"
        )
    )
    capsys.readouterr()

    pack = json.loads((tmp_path / "qa-2.skillpack").read_text())
    files = {f["path"]: f for f in pack["files"]}
    assert pack["skill"]["name"] == "qa-2"
    assert hub.parse_frontmatter_text(files["SKILL.md"]["content"])["name"] == "qa-2"
    assert "references/notes.md" in files


def test_cloud_fingerprint_tracks_the_effective_content(suffix_env):
    import hub
    from skill_hub.infrastructure.filesystem import cloud_targets

    data_home, upstream, _, _ = suffix_env
    cfg = _read_registry(data_home)["skills"]["qa-2"]
    patched = hub.skill_rename_patch("qa-2", cfg)

    effective = cloud_targets.content_fingerprint("qa-2", upstream, patched)
    raw = cloud_targets.content_fingerprint("qa-2", upstream)
    assert effective != raw  # the patched SKILL.md is what ships

    entries = dict(cloud_targets.collect_zip_entries(upstream, patched))
    assert hub.parse_frontmatter_text(entries["SKILL.md"].decode())["name"] == "qa-2"


def test_remote_desired_state_pushes_the_patched_skill_md(suffix_env):
    import hub

    data_home, *_ = suffix_env
    registry = hub.load_registry()
    desired = hub.build_remote_desired_state({"bundles": [], "enabled": ["qa-2"]}, registry)

    from skill_hub.infrastructure.connectors.layouts import agentskills

    item = next(i for i in desired.skills if i.name == "qa-2")

    upstream = data_home / "sources" / "pstack" / "worktree" / "qa"
    raw = agentskills.read_skill_dir(upstream)
    assert item.sha256 != agentskills.tree_sha256(raw)  # not the upstream bytes

    patched_tree = agentskills.read_skill_dir(upstream)
    patched_tree.files["SKILL.md"] = hub.skill_rename_patch(
        "qa-2", registry["skills"]["qa-2"]
    ).encode("utf-8")
    assert item.sha256 == agentskills.tree_sha256(patched_tree)


# ─────────────────────────────────────────────────────────────────────────────
# Cost + lifecycle of the variant itself
# ─────────────────────────────────────────────────────────────────────────────


def test_variant_is_reconciled_once_per_sync_run(claude_only_env, monkeypatch, capsys):
    """The variant dir is SHARED, so reconciling it per (project, skill) pair
    re-read and re-walked the same tree N times. One run = one reconcile."""
    from skill_hub.application.skills import skill_variants

    data_home = claude_only_env
    upstream = _write_skill(
        data_home / "sources" / "pstack" / "worktree" / "qa", "qa"
    )
    projects = {}
    for i in range(4):
        proj = data_home / "projects" / f"p{i}"
        proj.mkdir(parents=True)
        projects[f"p{i}"] = _project_cfg(proj, ["qa-2"])
    _write_registry(data_home, {"qa-2": _external_cfg(upstream)}, projects)

    calls: list[str] = []
    real = skill_variants._write_skill_variant

    def counted(skill_name, src, mode, patched, **kwargs):
        calls.append(f"{skill_name}@{mode}")
        return real(skill_name, src, mode, patched, **kwargs)

    monkeypatch.setattr(skill_variants, "_write_skill_variant", counted)
    _sync()
    capsys.readouterr()

    assert calls == ["qa-2@renamed"]
    # …and every project still got the patched link.
    for i in range(4):
        link = data_home / "projects" / f"p{i}" / ".claude" / "skills" / "qa-2"
        assert Path(os.readlink(link)).resolve() == _variant(data_home, "qa-2").resolve()


def test_disabled_source_variant_is_collected(claude_only_env, capsys):
    """A disabled source's skills are inactive everywhere, so their rename
    variants are orphans — the same rule the invocation variants follow."""
    data_home = claude_only_env
    upstream = _write_skill(
        data_home / "sources" / "pstack" / "worktree" / "qa", "qa"
    )
    proj = data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        data_home,
        {"qa-2": _external_cfg(upstream)},
        {"p1": _project_cfg(proj, ["qa-2"])},
    )
    _sync()
    variant = _variant(data_home, "qa-2")
    assert variant.is_dir()

    reg = _read_registry(data_home)
    reg["sources"]["pstack"]["enabled"] = False
    _write_registry_dict(data_home, reg)
    _sync()
    capsys.readouterr()

    assert not variant.exists()
    assert not (proj / ".claude" / "skills" / "qa-2").is_symlink()
