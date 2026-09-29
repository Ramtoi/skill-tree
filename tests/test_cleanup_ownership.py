"""Ownership guard on every symlink sweep (`is_hub_owned_link`).

Harness skills dirs are SHARED: `~/.claude/skills`, `~/.agents/skills` and
`~/.pi/agent/skills` are one set of directories for every hub install on the
machine. The stale-link sweeps used to unlink anything they did not expect,
without looking at where the link pointed — so a sync run under a scratch
`SKILL_HUB_HOME` (a test, a script, a reviewer's repro) deleted the REAL
install's global skill links. That has happened three times.

The rule, generalized from the narrower one `clean_project_artifacts` used
(`<data>/skills/` + `<data>/mcp-servers/` only, which missed variants and source
checkouts): unlink a symlink only when its target lives in one of THIS user's
hub-managed subtrees — `is_hub_owned_link`. Everything else — another data home,
a hand-made link, a real directory — is left as it is. All four sweeps
(global skills, project skills, `remove_symlink`, `clean_project_artifacts`) now
share the one gate.
"""

from __future__ import annotations

import argparse
import dataclasses
import os
from pathlib import Path

import pytest
import yaml


def _write_skill(root: Path, name: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d\n---\n\n# {name}\n")
    return root


def _write_registry(data_home: Path, skills: dict, projects: dict) -> None:
    (data_home / "registry.yaml").write_text(
        yaml.safe_dump(
            {
                "version": "1",
                "harnesses_global": ["claude-code"],
                "skills": skills,
                "projects": projects,
                "bundles": {},
            },
            sort_keys=False,
        )
    )


def _skill_cfg(src: Path, scope: str = "portable") -> dict:
    return {
        "version": "1.0.0",
        "description": "",
        "source": str(src),
        "type": "claude-skill",
        "scope": scope,
        "upstream": None,
    }


@pytest.fixture
def claude_only_env(tmp_data_home, monkeypatch):
    """Claude Code installed; its GLOBAL skills dir redirected inside tmp."""
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


def _sync():
    import hub

    hub.cmd_sync(argparse.Namespace(skip_permissions=True, skip_remotes=True))


def _other_home(tmp_path_factory) -> Path:
    """A stand-in for the user's REAL data home, OUTSIDE the scratch one.

    Deliberately built through `tmp_path_factory` so it is a SIBLING of the
    scratch data home (`tmp_data_home` is `tmp_path` itself): nesting it inside
    would make it part of this install and defeat the whole test.
    """
    other = tmp_path_factory.mktemp("real-skill-hub")
    _write_skill(other / "skills" / "brainstorm", "brainstorm")
    return other


# ─────────────────────────────────────────────────────────────────────────────
# is_hub_owned_link (unit)
# ─────────────────────────────────────────────────────────────────────────────


def test_is_hub_owned_link_classifies_by_target(tmp_data_home, tmp_path, tmp_path_factory):
    import hub

    other = _other_home(tmp_path_factory)
    links = tmp_path / "links"
    links.mkdir()

    mine = links / "mine"
    mine.symlink_to(_write_skill(tmp_data_home / "skills" / "mine", "mine"))
    theirs = links / "theirs"
    theirs.symlink_to(other / "skills" / "brainstorm")
    starter = links / "starter"
    starter.symlink_to(hub.code_home() / "skills")
    relative = links / "relative"
    relative.symlink_to(os.path.relpath(tmp_data_home / "skills" / "mine", links))
    real = links / "real"
    real.mkdir()

    assert hub.is_hub_owned_link(mine) is True
    assert hub.is_hub_owned_link(relative) is True  # resolved against its parent
    assert hub.is_hub_owned_link(starter) is True  # code home ships starter assets
    assert hub.is_hub_owned_link(theirs) is False  # another install's data home
    assert hub.is_hub_owned_link(real) is False  # not a symlink at all
    assert hub.is_hub_owned_link(links / "missing") is False


@pytest.mark.parametrize(
    ("extended", "ordinary"),
    [
        (r"\\?\C:\hub\skills\one", r"C:\hub\skills\one"),
        (r"\\?\UNC\server\share\hub\skills\one", r"\\server\share\hub\skills\one"),
        (r"\\?\unc\server\share\hub\skills\one", r"\\server\share\hub\skills\one"),
        (r"\\?\Volume{1234}\hub\skills\one", r"\\?\Volume{1234}\hub\skills\one"),
        (r"\\?\GLOBALROOT\Device\HarddiskVolume1\one", r"\\?\GLOBALROOT\Device\HarddiskVolume1\one"),
    ],
)
def test_windows_extended_prefix_normalization(monkeypatch, extended, ordinary):
    """Only recognized DOS/UNC extended prefixes are reduced for comparison."""
    from skill_hub.infrastructure.filesystem import sync_links

    assert str(sync_links._without_windows_extended_prefix(Path(extended))) == ordinary


@pytest.mark.skipif(os.name != "nt", reason="Windows path resolution regression")
def test_windows_extended_target_preserves_foreign_home_boundary(
    tmp_data_home, tmp_path, tmp_path_factory
):
    """Windows extended target spelling is owned only under this data home."""
    import hub

    links = tmp_path / "links"
    links.mkdir()
    mine = links / "mine"
    mine.symlink_to(_write_skill(tmp_data_home / "skills" / "mine", "mine"))
    foreign = links / "foreign"
    foreign_home = _other_home(tmp_path_factory)
    foreign.symlink_to(foreign_home / "skills" / "brainstorm")

    assert os.readlink(mine).startswith("\\\\?\\")
    assert os.readlink(foreign).startswith("\\\\?\\")
    assert hub.is_hub_owned_link(mine) is True
    assert hub.is_hub_owned_link(foreign) is False
    assert hub.remove_symlink(mine) is True
    assert not mine.is_symlink()
    assert hub.remove_symlink(foreign) is False
    assert foreign.is_symlink()


def test_link_target_abs_is_literal(tmp_data_home, tmp_path):
    """Literal target, not the resolved chain: a link INTO another home stays
    attributed to that home even when the chain ends somewhere else."""
    import hub

    real = tmp_path / "real-target"
    real.mkdir()
    hop = tmp_path / "hop"
    hop.symlink_to(real)
    link = tmp_path / "link"
    link.symlink_to(hop)

    assert hub.link_target_abs(link) == str(hop)


# ─────────────────────────────────────────────────────────────────────────────
# Global skills dir sweep
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def global_dir_with_three_entries(claude_only_env, tmp_path_factory):
    """(a) another install's link, (b) our own stale link, (c) a real dir."""
    from skill_hub.infrastructure.harnesses import harnesses

    data_home = claude_only_env
    other = _other_home(tmp_path_factory)

    global_dir = Path(str(harnesses.HARNESSES["claude-code"].global_skills_dir))
    global_dir.mkdir(parents=True)

    foreign = global_dir / "brainstorm"
    foreign.symlink_to(other / "skills" / "brainstorm")

    ours = global_dir / "leftover"
    ours.symlink_to(_write_skill(data_home / "skills" / "leftover", "leftover"))

    hand_written = global_dir / "handmade"
    _write_skill(hand_written, "handmade")

    _write_registry(data_home, {}, {})
    return data_home, global_dir, foreign, ours, hand_written, other


def test_global_sweep_leaves_another_installs_link_alone(
    global_dir_with_three_entries, capsys
):
    data_home, global_dir, foreign, ours, hand_written, other = (
        global_dir_with_three_entries
    )

    _sync()
    out = capsys.readouterr().out

    # (a) the other install's link survives, still pointing where it did.
    assert foreign.is_symlink()
    assert os.readlink(foreign) == str(other / "skills" / "brainstorm")
    assert "skipped unowned" in out and "brainstorm" in out

    # (b) our own stale link is still removed.
    assert not ours.exists() and not ours.is_symlink()
    assert "removed stale" in out

    # (c) a real directory keeps the old behavior: moved aside, never deleted.
    assert not hand_written.exists()
    moved = global_dir.parent / "_hub-backups" / global_dir.name / "handmade"
    assert (moved / "SKILL.md").is_file()


def test_global_sweep_still_removes_variant_and_source_links(claude_only_env, capsys):
    """Ownership is the whole data home, not just `skills/`: generated variants
    and source checkouts must stay collectable."""
    import hub
    from skill_hub.infrastructure.harnesses import harnesses

    data_home = claude_only_env
    global_dir = Path(str(harnesses.HARNESSES["claude-code"].global_skills_dir))
    global_dir.mkdir(parents=True)

    variant = data_home / "state" / "skill_variants" / "x@renamed"
    _write_skill(variant, "x")
    checkout = data_home / "sources" / "pstack" / "worktree" / "y"
    _write_skill(checkout, "y")
    (global_dir / "x").symlink_to(variant)
    (global_dir / "y").symlink_to(checkout)

    _write_registry(data_home, {}, {})
    _sync()
    capsys.readouterr()

    assert not (global_dir / "x").is_symlink()
    assert not (global_dir / "y").is_symlink()
    assert hub.is_hub_owned_link  # (guard is the reason both were removable)


# ─────────────────────────────────────────────────────────────────────────────
# Per-project sweep + remove_symlink
# ─────────────────────────────────────────────────────────────────────────────


def test_project_sweep_leaves_another_installs_link_alone(
    claude_only_env, tmp_path_factory, capsys
):
    data_home = claude_only_env
    other = _other_home(tmp_path_factory)

    proj = data_home / "projects" / "p1"
    skills_dir = proj / ".claude" / "skills"
    skills_dir.mkdir(parents=True)

    foreign = skills_dir / "brainstorm"
    foreign.symlink_to(other / "skills" / "brainstorm")
    ours = skills_dir / "leftover"
    ours.symlink_to(_write_skill(data_home / "skills" / "leftover", "leftover"))

    _write_registry(
        data_home,
        {"leftover": _skill_cfg(data_home / "skills" / "leftover")},
        {"p1": {"path": str(proj), "enabled": [], "bundles": [], "harnesses": []}},
    )

    _sync()
    out = capsys.readouterr().out

    assert foreign.is_symlink()
    assert os.readlink(foreign) == str(other / "skills" / "brainstorm")
    assert "skipped unowned" in out
    assert not ours.is_symlink()  # unequipped + ours → removed as before


def test_remove_symlink_refuses_another_installs_link(
    tmp_data_home, tmp_path, tmp_path_factory, capsys
):
    import hub

    other = _other_home(tmp_path_factory)
    links = tmp_path / "links"
    links.mkdir()
    foreign = links / "brainstorm"
    foreign.symlink_to(other / "skills" / "brainstorm")
    ours = links / "mine"
    ours.symlink_to(_write_skill(tmp_data_home / "skills" / "mine", "mine"))

    foreign_result = hub.remove_symlink(foreign)
    ours_result = hub.remove_symlink(ours)

    assert foreign.is_symlink()
    assert not ours.is_symlink()
    out = capsys.readouterr().out
    assert "left in place" in out
    assert foreign_result is False  # left in place is reported as a partial result
    assert ours_result is True  # a clean removal
    assert f"removed {ours}" in out


def test_remove_symlink_is_a_clean_noop_on_a_non_symlink_path(tmp_path, capsys):
    import hub

    missing = tmp_path / "missing"
    real_dir = tmp_path / "real"
    real_dir.mkdir()

    assert hub.remove_symlink(missing) is True
    assert hub.remove_symlink(real_dir) is True
    assert capsys.readouterr().out == ""


# ─────────────────────────────────────────────────────────────────────────────
# clean_project_artifacts — the same rule, so the lifecycle verbs
# (`hub project remove` / `edit-path`) collect every kind of hub link
# ─────────────────────────────────────────────────────────────────────────────


def test_clean_project_artifacts_collects_variant_and_checkout_links(
    tmp_data_home, tmp_path_factory
):
    """Before the shared gate, `clean_project_artifacts` accepted only
    `<data>/skills/` + `<data>/mcp-servers/` targets — so a renamed skill's link
    (into `state/skill_variants/`), an invocation-override link and a source
    checkout link were all left behind, dangling once the next sync collected
    the variant."""
    import hub

    other = _other_home(tmp_path_factory)
    proj = tmp_data_home / "projects" / "p1"
    skills_dir = proj / ".claude" / "skills"
    skills_dir.mkdir(parents=True)

    library = _write_skill(tmp_data_home / "skills" / "plain", "plain")
    variant = _write_skill(
        tmp_data_home / "state" / "skill_variants" / "qa-2@renamed", "qa-2"
    )
    inv_variant = _write_skill(
        tmp_data_home / "state" / "skill_variants" / "plain@user-only", "plain"
    )
    checkout = _write_skill(
        tmp_data_home / "sources" / "pstack" / "worktree" / "ext", "ext"
    )

    (skills_dir / "plain").symlink_to(library)
    (skills_dir / "qa-2").symlink_to(variant)
    (skills_dir / "plain-ov").symlink_to(inv_variant)
    (skills_dir / "ext").symlink_to(checkout)
    (skills_dir / "brainstorm").symlink_to(other / "skills" / "brainstorm")
    user_link = skills_dir / "user-own"
    user_target = tmp_data_home / "external" / "user-skill"
    user_target.mkdir(parents=True)
    user_link.symlink_to(user_target)

    plan = hub.clean_project_artifacts(proj, {"skills": {}}, dry_run=False)

    removed = {Path(p).name for p in plan["removed_symlinks"]}
    assert removed == {"plain", "qa-2", "plain-ov", "ext"}
    # Another install's link and a user's own link both survive…
    assert (skills_dir / "brainstorm").is_symlink()
    assert user_link.is_symlink()
    # …and the foreign one is reported, not silently ignored.
    assert any("another install owns it" in w for w in plan["warnings"])


def test_project_remove_cleans_a_renamed_skills_link(claude_only_env, capsys):
    """End-to-end: `hub project remove` leaves no dangling variant link."""
    import argparse

    import hub

    data_home = claude_only_env
    upstream = _write_skill(
        data_home / "sources" / "pstack" / "worktree" / "qa", "qa"
    )
    proj = data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        data_home,
        {
            "qa-2": {
                **_skill_cfg(upstream),
                "managed": "external",
                "origin": {"source": "pstack", "path": "qa", "ref": "main"},
            }
        },
        {"p1": {"path": str(proj), "enabled": ["qa-2"], "bundles": [], "harnesses": []}},
    )
    _sync()
    link = proj / ".claude" / "skills" / "qa-2"
    assert link.is_symlink()

    hub.cmd_project_remove(argparse.Namespace(name="p1", dry_run=False, json=False))
    capsys.readouterr()

    assert not link.is_symlink()
    assert not link.exists()


# ─────────────────────────────────────────────────────────────────────────────
# Import scanner — a variant-linked global skill is ALREADY_MANAGED, not a
# CONFLICT whose "replace" would repoint the registry at the variant dir
# ─────────────────────────────────────────────────────────────────────────────


def test_import_scanner_treats_variant_links_as_already_managed(
    tmp_data_home, monkeypatch, tmp_path_factory
):
    import hub

    other = _other_home(tmp_path_factory)
    scan_root = tmp_data_home / "fake-claude" / "skills"
    scan_root.mkdir(parents=True)
    monkeypatch.setattr(hub, "IMPORT_SCAN_ROOTS", [("claude", scan_root)])

    variant = _write_skill(
        tmp_data_home / "state" / "skill_variants" / "qa-2@renamed", "qa-2"
    )
    checkout = _write_skill(
        tmp_data_home / "sources" / "pstack" / "worktree" / "ext", "ext"
    )
    (scan_root / "qa-2").symlink_to(variant)
    (scan_root / "ext").symlink_to(checkout)
    (scan_root / "brainstorm").symlink_to(other / "skills" / "brainstorm")

    registry = {"skills": {"qa-2": _skill_cfg(variant), "ext": _skill_cfg(checkout)}}
    by_name = {
        c["path"].rsplit("/", 1)[-1]: c
        for c in hub.scan_import_candidates(registry=registry)
    }

    assert by_name["qa-2"]["category"] == "ALREADY_MANAGED"
    assert by_name["ext"]["category"] == "ALREADY_MANAGED"
    # A link into ANOTHER install stays an ordinary candidate (not ours to claim).
    assert by_name["brainstorm"]["category"] != "ALREADY_MANAGED"


# ─────────────────────────────────────────────────────────────────────────────
# _warn_links_left_in_place
# ─────────────────────────────────────────────────────────────────────────────


def test_warn_links_left_in_place_reports_count_and_marker(capsys):
    import hub
    from skill_hub import hub_core

    hub._warn_links_left_in_place([True, False, True, False, False])

    out = capsys.readouterr().out
    expected = (
        f"  {hub_core.c('!', hub_core.YELLOW)} 3 link(s) left in place: they "
        f"point into another Skill Hub data home, so this install must not "
        f"remove them\n"
    )
    assert out == expected


def test_warn_links_left_in_place_stays_silent_when_all_succeeded(capsys):
    import hub

    hub._warn_links_left_in_place([True, True, True])

    assert capsys.readouterr().out == ""


# ─────────────────────────────────────────────────────────────────────────────
# backup_path_for — collision suffixes
# ─────────────────────────────────────────────────────────────────────────────


def test_backup_path_for_returns_next_free_suffix(tmp_data_home):
    import hub

    link = tmp_data_home / "skills" / "mine"
    backup_root = tmp_data_home / "_hub-backups" / "skills"
    backup_root.mkdir(parents=True)
    (backup_root / "mine").mkdir()  # the plain name is already taken

    result = hub.backup_path_for(link)

    assert result == backup_root / "mine.1"
    assert not result.exists()


def test_backup_path_for_skips_an_occupied_second_suffix(tmp_data_home):
    import hub

    link = tmp_data_home / "skills" / "mine"
    backup_root = tmp_data_home / "_hub-backups" / "skills"
    backup_root.mkdir(parents=True)
    (backup_root / "mine").mkdir()
    (backup_root / "mine.1").mkdir()  # the first spare name is ALSO taken

    result = hub.backup_path_for(link)

    assert result == backup_root / "mine.2"
    assert not result.exists()


def test_backup_path_for_reuses_an_existing_backup_root(tmp_data_home):
    """Two entries out of the same skills dir back up into the same
    `_hub-backups/<dir>` root — the second call must not choke on the root the
    first call already created."""
    import hub

    link_a = tmp_data_home / "skills" / "one"
    link_b = tmp_data_home / "skills" / "two"

    result_a = hub.backup_path_for(link_a)
    result_b = hub.backup_path_for(link_b)

    assert result_a == tmp_data_home / "_hub-backups" / "skills" / "one"
    assert result_b == tmp_data_home / "_hub-backups" / "skills" / "two"


# ─────────────────────────────────────────────────────────────────────────────
# ensure_symlink — the real-file backup branch
# ─────────────────────────────────────────────────────────────────────────────


def test_ensure_symlink_backs_up_a_real_file_already_at_the_link_path(tmp_data_home, capsys):
    """A real file (not a symlink) already sits at the link path. `ensure_symlink`
    must move it aside — via `backup_path_for(link)`, with its bytes intact —
    report the move on one exact stdout line, and still end with `link` a
    symlink pointing at `target`."""
    import hub
    from skill_hub import hub_core

    link = tmp_data_home / "skills" / "mine"
    link.parent.mkdir(parents=True)
    link.write_text("original content")
    target = tmp_data_home / "library" / "mine"
    target.parent.mkdir(parents=True)
    target.write_text("library content")

    backup = tmp_data_home / "_hub-backups" / "skills" / "mine"

    result = hub.ensure_symlink(link, target)

    assert result is True
    assert link.is_symlink()
    assert link.resolve() == target.resolve()
    assert not backup.is_symlink()
    assert backup.read_text() == "original content"
    out = capsys.readouterr().out
    expected_backup_line = (
        f"  {hub_core.c('→', hub_core.YELLOW)} backed up {link.name} to {backup}\n"
    )
    expected_create_line = f"  {hub_core.c('✓', hub_core.GREEN)} {link} → {target}\n"
    assert out == expected_backup_line + expected_create_line


# ─────────────────────────────────────────────────────────────────────────────
# hub_owned_link_roots — the SKILL_HUB_DIR limb
# ─────────────────────────────────────────────────────────────────────────────


def test_hub_owned_link_roots_includes_skill_hub_dir_when_set(
    tmp_data_home, tmp_path, tmp_path_factory, monkeypatch
):
    import hub

    legacy_home = tmp_path_factory.mktemp("legacy-skill-hub-dir")
    skill = _write_skill(legacy_home / "skills" / "old", "old")
    monkeypatch.setenv("SKILL_HUB_DIR", str(legacy_home))

    link = tmp_path / "link"
    link.symlink_to(skill)

    assert hub.is_hub_owned_link(link) is True


def test_hub_owned_link_roots_matches_expected_subtrees(
    tmp_data_home, tmp_path, tmp_path_factory, monkeypatch
):
    """`hub_owned_link_roots` must return exactly the fixed subtrees
    (`sync_links.HUB_LINKED_SUBTREES`) under the homes hub actually owns —
    this install's data home, the legacy data home, the code home, and, once
    `$SKILL_HUB_DIR` is set, that legacy dir too — as absolute paths. A
    symlink into some unrelated directory must stay unowned in both cases."""
    import hub
    from skill_hub import hub_core
    from skill_hub.infrastructure.filesystem import sync_links

    unrelated = tmp_path_factory.mktemp("unrelated")
    unrelated_link = tmp_path / "unrelated-link"
    unrelated_link.symlink_to(unrelated / "somewhere")

    def expected_roots(*homes: Path) -> set[Path]:
        return {
            home / sub for home in homes for sub in sync_links.HUB_LINKED_SUBTREES
        }

    # SKILL_HUB_DIR unset: only this install's data/code/legacy homes count.
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    base_homes = (tmp_data_home, hub.LEGACY_DATA_HOMES[0], hub_core.code_home())

    roots = hub.hub_owned_link_roots()

    assert all(root.is_absolute() for root in roots)
    assert set(roots) == expected_roots(*base_homes)
    assert hub.is_hub_owned_link(unrelated_link) is False

    # SKILL_HUB_DIR set: its subtrees join the owned set, nothing else changes.
    legacy_home = tmp_path_factory.mktemp("legacy-skill-hub-dir")
    monkeypatch.setenv("SKILL_HUB_DIR", str(legacy_home))

    roots_with_dir = hub.hub_owned_link_roots()

    assert all(root.is_absolute() for root in roots_with_dir)
    assert set(roots_with_dir) == expected_roots(*base_homes, legacy_home)
    assert hub.is_hub_owned_link(unrelated_link) is False


# ─────────────────────────────────────────────────────────────────────────────
# is_hub_owned_link — an unreadable target
# ─────────────────────────────────────────────────────────────────────────────


def test_is_hub_owned_link_treats_an_unreadable_target_as_not_owned(
    tmp_path, monkeypatch
):
    import hub
    from skill_hub.infrastructure.filesystem import sync_links

    link = tmp_path / "broken"
    link.symlink_to(tmp_path / "nowhere")  # a symlink is enough; target unread

    monkeypatch.setattr(sync_links, "link_target_abs", lambda _link: None)

    assert hub.is_hub_owned_link(link) is False


# ─────────────────────────────────────────────────────────────────────────────
# remove_unmanaged_entries
# ─────────────────────────────────────────────────────────────────────────────


def test_remove_unmanaged_entries_reports_zero_when_nothing_changes(tmp_data_home):
    import hub

    skills_dir = tmp_data_home / "empty-skills"
    skills_dir.mkdir(parents=True)

    removed, skipped_unowned = hub.remove_unmanaged_entries(
        skills_dir, expected_names=set(), label="skill"
    )

    assert (removed, skipped_unowned) == (0, 0)


def test_remove_unmanaged_entries_leaves_a_symlinked_skills_dir_untouched(
    tmp_data_home,
):
    import hub

    real_dir = tmp_data_home / "real-skills"
    real_dir.mkdir(parents=True)
    stale = _write_skill(tmp_data_home / "skills" / "stale", "stale")
    (real_dir / "stale").symlink_to(stale)

    skills_dir = tmp_data_home / "skills-link"
    skills_dir.symlink_to(real_dir)

    removed, skipped_unowned = hub.remove_unmanaged_entries(
        skills_dir, expected_names=set(), label="skill"
    )

    assert (removed, skipped_unowned) == (0, 0)
    assert (real_dir / "stale").is_symlink()


def test_remove_unmanaged_entries_treats_expected_names_as_continue_not_break(
    tmp_data_home,
):
    """An expected (still-linked) entry must skip past itself, not end the
    whole sweep — seed several of them around the one stale entry so the
    result does not depend on filesystem iteration order."""
    import hub

    skills_dir = tmp_data_home / "mixed-skills"
    skills_dir.mkdir(parents=True)

    expected_names = set()
    for i in range(6):
        name = f"kept-{i}"
        target = _write_skill(tmp_data_home / "skills" / name, name)
        (skills_dir / name).symlink_to(target)
        expected_names.add(name)

    stale = _write_skill(tmp_data_home / "skills" / "stale", "stale")
    (skills_dir / "stale").symlink_to(stale)

    removed, skipped_unowned = hub.remove_unmanaged_entries(
        skills_dir, expected_names=expected_names, label="skill"
    )

    assert (removed, skipped_unowned) == (1, 0)
    assert not (skills_dir / "stale").exists()
    for name in expected_names:
        assert (skills_dir / name).is_symlink()


def test_remove_unmanaged_entries_counts_and_reports_each_kind(
    tmp_data_home, tmp_path_factory, capsys
):
    """Two stale hub-owned links, two links owned by another install, two
    unmanaged real directories, and an `_hub-backups` dir that must never be
    swept — one sweep, every counter and notice checked at once."""
    import hub

    other = _other_home(tmp_path_factory)
    skills_dir = tmp_data_home / "shared-skills"
    skills_dir.mkdir(parents=True)

    stale_names = ["stale-one", "stale-two"]
    for name in stale_names:
        target = _write_skill(tmp_data_home / "skills" / name, name)
        (skills_dir / name).symlink_to(target)

    foreign_names = ["foreign-one", "foreign-two"]
    for name in foreign_names:
        target = _write_skill(other / "skills" / name, name)
        (skills_dir / name).symlink_to(target)

    handmade_names = ["handmade-one", "handmade-two"]
    handmade_dirs = [_write_skill(skills_dir / name, name) for name in handmade_names]

    (skills_dir / "_hub-backups").mkdir()

    removed, skipped_unowned = hub.remove_unmanaged_entries(
        skills_dir, expected_names=set(), label="skill"
    )

    assert (removed, skipped_unowned) == (4, 2)
    for name in stale_names:
        assert not (skills_dir / name).exists()
    for name in foreign_names:
        assert (skills_dir / name).is_symlink()

    backup_root = skills_dir.parent / "_hub-backups" / skills_dir.name
    for handmade, name in zip(handmade_dirs, handmade_names):
        assert not handmade.exists()
        assert (backup_root / name / "SKILL.md").is_file()
    assert (skills_dir / "_hub-backups").is_dir()  # never swept, never moved

    out = capsys.readouterr().out
    assert out.count("removed stale") == 2
    assert out.count("skipped unowned") == 2
    for name in handmade_names:
        assert f"moved unmanaged skill: {name} → {backup_root / name}" in out
