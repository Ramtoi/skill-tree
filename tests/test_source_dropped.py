"""Tests for `hub source dropped` and `hub source recover` — the read-only
classification of upstream-dropped skills (renamed / deleted / unknown) and
the "Keep as local" recovery path.

Reuses the local-git-repo fixture helpers from `test_source_lifecycle.py`
rather than re-deriving them (`_make_local_repo`, `_commit_changes`,
`_add_git_source`, `_run_hub_cli`, `_payload`).
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git not on PATH"
)

from test_source_lifecycle import (  # noqa: E402
    _add_git_source,
    _commit_changes,
    _load_registry,
    _make_local_repo,
    _payload,
    _run_hub_cli,
    _seed_code_home,
    _seed_registry,
    _skill_md,
)


def _big_skill_md(name: str, description: str) -> str:
    """A realistically-sized SKILL.md — big enough that a name-only rename
    scores well above git's default rename-detection similarity floor.
    A tiny fixture file (a handful of lines) makes even a single changed line
    read as a large percentage of the file, which is not how real skills look
    and would make the rename-vs-deleted threshold assertions flaky/wrong."""
    body = "\n".join(f"Paragraph {i} stays completely unchanged across the rename." for i in range(1, 40))
    return f"---\nname: {name}\ndescription: {description}\nversion: 1.0.0\n---\n# {name}\n\n{body}\n"


def _dropped(tmp_data_home, code_root, *extra):
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "dropped", *extra, "--json"]
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _by_name(payload: dict, name: str) -> dict:
    return next(s for s in payload["skills"] if s["name"] == name)


def _populate_dropped_world(tmp_data_home: Path, monkeypatch, tmp_path: Path):
    """Builds the source with one renamed skill, one deleted skill, one
    survivor. Shared by the function-scoped mutator fixture and the
    module-scoped read-only fixture below — one definition of the world."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/engineering/diagnose/SKILL.md": _big_skill_md("diagnose", "diagnose bugs"),
            "skills/engineering/zoom-out/SKILL.md": _skill_md("zoom-out", "zoom out"),
            "skills/engineering/keep/SKILL.md": _skill_md("keep", "survives"),
        },
    )
    _add_git_source(tmp_data_home, code_root, repo)

    # Upstream renames diagnose -> diagnosing-bugs, deletes zoom-out.
    (repo / "skills/engineering/diagnosing-bugs").mkdir(parents=True)
    (repo / "skills/engineering/diagnose/SKILL.md").rename(
        repo / "skills/engineering/diagnosing-bugs/SKILL.md"
    )
    text = (repo / "skills/engineering/diagnosing-bugs/SKILL.md").read_text()
    (repo / "skills/engineering/diagnosing-bugs/SKILL.md").write_text(
        text.replace("name: diagnose", "name: diagnosing-bugs")
    )
    _commit_changes(
        repo,
        {"skills/engineering/zoom-out/SKILL.md": None},
        "rename diagnose, drop zoom-out",
    )
    # `git mv`-equivalent above uses Path.rename, which git only notices via
    # `git add -A` in `_commit_changes` — confirm the rename is picked up by
    # letting the commit include everything.
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]
    )
    assert result.returncode == 0, result.stderr

    return tmp_data_home, code_root, repo


@pytest.fixture
def dropped_world(tmp_data_home, monkeypatch, tmp_path):
    """A source with one renamed skill, one deleted skill, one survivor.

    Function-scoped: use this for a test that mutates the registry, the
    filesystem, or runs `source recover`. A test that only reads the
    `source dropped` payload belongs on `dropped_world_ro` instead (TA-1-c071)."""
    return _populate_dropped_world(tmp_data_home, monkeypatch, tmp_path)


def _hash_tree(root: Path) -> str:
    """Order-independent content hash of a directory tree, used to prove a
    shared read-only fixture was not silently mutated by a test."""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        digest.update(str(path.relative_to(root)).encode())
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


@pytest.fixture(scope="module")
def _dropped_world_ro_state(tmp_path_factory):
    """Builds `dropped_world` ONCE per module for tests that only read the
    `source dropped` payload — 7 of the 17 tests using this fixture rebuilt a
    git repo and ran `hub.py` twice each for no reason (TA-1-c071). The
    teardown hash proves no read-only test quietly became a mutator; if one
    does, this fails loudly instead of poisoning a sibling test's assertions.
    """
    mp = pytest.MonkeyPatch()
    root = tmp_path_factory.mktemp("dropped-world-ro")
    data_home = root / "data-home"
    data_home.mkdir()

    import hub

    mp.setenv("SKILL_HUB_HOME", str(data_home))
    mp.delenv("SKILL_HUB_DIR", raising=False)
    mp.delenv("SKILL_HUB_CODE", raising=False)
    hub._DATA_HOME_CACHE = None

    result = _populate_dropped_world(data_home, mp, root)
    before = _hash_tree(data_home)
    yield result
    after = _hash_tree(data_home)
    hub._DATA_HOME_CACHE = None
    mp.undo()
    assert after == before, (
        "dropped_world_ro was mutated by a test in this module — move that "
        "test onto the function-scoped `dropped_world` fixture instead."
    )


@pytest.fixture
def dropped_world_ro(_dropped_world_ro_state):
    return _dropped_world_ro_state


def test_renamed_reports_successor_and_registered_as(dropped_world_ro):
    tmp_data_home, code_root, _ = dropped_world_ro
    payload = _dropped(tmp_data_home, code_root)
    diagnose = _by_name(payload, "diagnose")
    assert diagnose["reason"] == "renamed"
    assert diagnose["source"] == "org-skills"
    assert diagnose["successor"]["path"] == "skills/engineering/diagnosing-bugs"
    assert diagnose["successor"]["name"] == "diagnosing-bugs"
    assert diagnose["successor"]["registered_as"] == "diagnosing-bugs"
    assert diagnose["successor"]["similarity"] >= 70
    assert diagnose["possible_successor"] is None
    assert diagnose["recoverable"] is True
    assert diagnose["skill_md"] is None


def test_deleted_has_no_successor(dropped_world_ro):
    tmp_data_home, code_root, _ = dropped_world_ro
    payload = _dropped(tmp_data_home, code_root)
    zoom_out = _by_name(payload, "zoom-out")
    assert zoom_out["reason"] == "deleted"
    assert zoom_out["successor"] is None
    assert zoom_out["recoverable"] is True


def test_survivor_is_not_listed(dropped_world_ro):
    tmp_data_home, code_root, _ = dropped_world_ro
    payload = _dropped(tmp_data_home, code_root)
    names = {s["name"] for s in payload["skills"]}
    assert "keep" not in names
    assert names == {"diagnose", "zoom-out"}


def test_unknown_when_checkout_missing(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    shutil.rmtree(tmp_data_home / "sources" / "org-skills")
    payload = _dropped(tmp_data_home, code_root)
    for s in payload["skills"]:
        assert s["reason"] == "unknown"
        assert s["recoverable"] is False
        assert s["last_seen_at"] is None


def test_unknown_when_ref_absent(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    reg = _load_registry(tmp_data_home)
    del reg["skills"]["zoom-out"]["origin"]["ref"]
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    payload = _dropped(tmp_data_home, code_root)
    zoom_out = _by_name(payload, "zoom-out")
    assert zoom_out["reason"] == "unknown"
    assert zoom_out["recoverable"] is False
    # the healthy sibling is unaffected
    diagnose = _by_name(payload, "diagnose")
    assert diagnose["reason"] == "renamed"


def test_never_raises_on_a_broken_entry_mixed_with_a_good_one(dropped_world):
    """One skill's origin points at a source id that no longer exists in the
    registry (hand-edited/partial state) — must degrade to "unknown" for that
    one skill without blowing up the whole command."""
    tmp_data_home, code_root, _ = dropped_world
    reg = _load_registry(tmp_data_home)
    reg["skills"]["zoom-out"]["origin"]["source"] = "ghost-source"
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    payload = _dropped(tmp_data_home, code_root)
    assert payload["ok"] is True
    zoom_out = _by_name(payload, "zoom-out")
    assert zoom_out["reason"] == "unknown"
    diagnose = _by_name(payload, "diagnose")
    assert diagnose["reason"] == "renamed"


def test_skill_filter_narrows_to_one(dropped_world_ro):
    tmp_data_home, code_root, _ = dropped_world_ro
    payload = _dropped(tmp_data_home, code_root, "--skill", "zoom-out")
    assert [s["name"] for s in payload["skills"]] == ["zoom-out"]


def test_source_filter_narrows_to_one_source(dropped_world_ro):
    tmp_data_home, code_root, _ = dropped_world_ro
    payload = _dropped(tmp_data_home, code_root, "org-skills")
    assert {s["name"] for s in payload["skills"]} == {"diagnose", "zoom-out"}
    payload_other = _dropped(tmp_data_home, code_root, "no-such-source")
    assert payload_other["skills"] == []


def test_content_flag_includes_skill_md_body(dropped_world_ro):
    tmp_data_home, code_root, _ = dropped_world_ro
    payload = _dropped(tmp_data_home, code_root, "--skill", "zoom-out", "--content")
    zoom_out = _by_name(payload, "zoom-out")
    assert zoom_out["skill_md"] is not None
    assert "name: zoom-out" in zoom_out["skill_md"]
    # Without --content it stays null.
    payload2 = _dropped(tmp_data_home, code_root, "--skill", "zoom-out")
    assert _by_name(payload2, "zoom-out")["skill_md"] is None


def test_equipped_reflects_bundles_projects_remotes_cloud(dropped_world, tmp_path):
    tmp_data_home, code_root, _ = dropped_world
    reg = _load_registry(tmp_data_home)
    reg["bundles"] = {"pack": {"description": "", "skills": ["zoom-out"]}}
    proj_dir = tmp_path / "proj"
    proj_dir.mkdir()
    reg["projects"] = {
        "demo": {
            "path": str(proj_dir),
            "bundles": [],
            "enabled": ["zoom-out"],
            "harnesses": ["pi"],
            "invocation_overrides": {"zoom-out": "user-only"},
        }
    }
    reg["remotes"] = {
        "box": {
            "connector": "hermes",
            "transport": {"ssh_host": "x@y"},
            "sync_enabled": False,
            "bundles": [],
            "enabled": ["zoom-out"],
        }
    }
    reg["cloud"] = {"claude-ai": {"bundles": [], "enabled": ["zoom-out"]}}
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    payload = _dropped(tmp_data_home, code_root, "--skill", "zoom-out")
    equipped = _by_name(payload, "zoom-out")["equipped"]
    assert equipped["bundles"] == ["pack"]
    assert equipped["projects"] == ["demo"]  # deduped: enabled + override, same project
    assert equipped["remotes"] == ["box"]
    assert equipped["cloud"] == ["claude-ai"]


def test_dropped_never_mutates_registry(dropped_world_ro):
    tmp_data_home, code_root, _ = dropped_world_ro
    before = (tmp_data_home / "registry.yaml").read_text()
    _dropped(tmp_data_home, code_root)
    _dropped(tmp_data_home, code_root, "--content")
    after = (tmp_data_home / "registry.yaml").read_text()
    assert before == after


# ─── `hub source recover` ───────────────────────────────────────────────────


def test_recover_restores_a_renamed_skill_as_local(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "recover", "diagnose", "--json"]
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["ok"] is True
    assert payload["name"] == "diagnose"
    assert payload["source"] == "org-skills"

    reg = _load_registry(tmp_data_home)
    entry = reg["skills"]["diagnose"]
    assert entry["managed"] == "local"
    assert "origin" not in entry
    assert entry.get("source_missing") is not True
    dest = Path(entry["source"])
    assert dest == tmp_data_home / "skills" / "diagnose"
    assert (dest / "SKILL.md").exists()
    assert "name: diagnose" in (dest / "SKILL.md").read_text()


def test_recover_deleted_skill_restores_last_known_content(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "recover", "zoom-out", "--json"]
    )
    assert result.returncode == 0, result.stderr
    dest = tmp_data_home / "skills" / "zoom-out"
    assert (dest / "SKILL.md").exists()
    assert "zoom out" in (dest / "SKILL.md").read_text()


def test_recover_fails_on_unknown_skill(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "recover", "does-not-exist", "--json"]
    )
    assert result.returncode == 1


def test_recover_fails_when_not_source_missing(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "recover", "keep", "--json"]
    )
    assert result.returncode == 1
    assert "not dropped upstream" in (result.stdout + result.stderr)


def test_recover_fails_when_not_recoverable(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    reg = _load_registry(tmp_data_home)
    reg["skills"]["zoom-out"]["origin"]["ref"] = "abcdef0123456789abcdef0123456789abcdef01"
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "recover", "zoom-out", "--json"]
    )
    assert result.returncode == 1
    assert "not recoverable" in (result.stdout + result.stderr)
    # nothing changed
    reg2 = _load_registry(tmp_data_home)
    assert reg2["skills"]["zoom-out"].get("source_missing") is True
    assert not (tmp_data_home / "skills" / "zoom-out").exists()


def test_recover_fails_when_destination_already_exists(dropped_world):
    tmp_data_home, code_root, _ = dropped_world
    dest = tmp_data_home / "skills" / "zoom-out"
    dest.mkdir(parents=True)
    (dest / "placeholder.txt").write_text("already here")
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "recover", "zoom-out", "--json"]
    )
    assert result.returncode == 1
    assert "already exists" in (result.stdout + result.stderr)
    reg = _load_registry(tmp_data_home)
    assert reg["skills"]["zoom-out"].get("source_missing") is True
    assert (dest / "placeholder.txt").exists()  # untouched


# ─── B1 regression: distinct-ref grouping, not "oldest ref in the source" ──


def test_skill_added_after_an_earlier_drop_and_later_renamed_is_still_renamed(
    tmp_data_home, monkeypatch, tmp_path
):
    """Four commits, two drop events, one source:

    1. `a` exists.                                        (sync #1 registers a)
    2. `a` is deleted; `c` is ADDED for the first time.    (sync #2: a → source_missing, c registered)
    3. `c` is renamed to `c-renamed` (high similarity).    (sync #3: c → source_missing)

    `a`'s last-seen ref is commit 1; `c`'s last-seen ref is commit 2 — a LATER
    ref, since `c` did not exist at commit 1 at all. Grouping the source's
    dropped skills by "the oldest ref among them" (picking commit 1 as the
    lone diff base) never puts `c/SKILL.md` on the left side of that diff — it
    did not exist yet — so the real rename at commit 3 is invisible from
    commit 1's perspective and `c` reads as "deleted". Grouping by each
    skill's OWN ref instead (commit 2 for `c`) sees the rename correctly.
    """
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {"skills/a/SKILL.md": _skill_md("a", "a")},
    )
    _add_git_source(tmp_data_home, code_root, repo)  # sync #1: registers a @ commit 1

    # commit 2: drop `a`, add `c` for the first time.
    _commit_changes(
        repo,
        {
            "skills/a/SKILL.md": None,
            "skills/c/SKILL.md": _big_skill_md("c", "c"),
        },
        "drop a, add c",
    )
    r2 = _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert r2.returncode == 0, r2.stderr
    p2 = _payload(r2)
    assert "a" in p2["removed_upstream"]
    assert "c" in p2["added"]

    # commit 3: rename c -> c-renamed (name-only edit; body is long enough
    # that the similarity score comfortably clears the rename threshold).
    text = (repo / "skills/c/SKILL.md").read_text()
    (repo / "skills/c-renamed").mkdir()
    (repo / "skills/c-renamed/SKILL.md").write_text(text.replace("name: c", "name: c-renamed"))
    _commit_changes(repo, {"skills/c/SKILL.md": None}, "rename c -> c-renamed")
    r3 = _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert r3.returncode == 0, r3.stderr
    p3 = _payload(r3)
    assert "c" in p3["removed_upstream"]

    payload = _dropped(tmp_data_home, code_root)
    a = _by_name(payload, "a")
    c = _by_name(payload, "c")
    assert a["reason"] == "deleted"
    assert c["reason"] == "renamed"
    assert c["successor"]["name"] == "c-renamed"
    assert c["successor"]["similarity"] >= 70


# ─── S1: similarity threshold on a git rename pairing ──────────────────────


def test_low_similarity_pairing_reports_deleted_with_possible_successor(
    tmp_data_home, monkeypatch, tmp_path
):
    """git's `-M50%` detection is used to FIND candidate pairings, but a weak
    one (two files that are only coincidentally similar) must not be reported
    as a confirmed rename — it lands under `possible_successor` instead, with
    `reason` staying "deleted"."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)

    def _lines_md(name: str, changed_prefix_count: int) -> str:
        lines = [f"line {i}\n" for i in range(1, 101)]
        for i in range(changed_prefix_count):
            lines[i] = f"CHANGED {i}\n"
        return f"---\nname: {name}\ndescription: d\n---\n" + "".join(lines)

    repo = _make_local_repo(tmp_path / "remote", {"skills/weak/SKILL.md": _lines_md("weak", 0)})
    _add_git_source(tmp_data_home, code_root, repo)

    # ~25% of lines changed lands in git's detected-but-weak band (observed
    # ~R068 for this exact shape) — comfortably below the 70 threshold but
    # still above -M50%'s detection floor, so it IS paired, just not trusted.
    (repo / "skills/unrelated").mkdir()
    (repo / "skills/unrelated/SKILL.md").write_text(_lines_md("unrelated", 25))
    _commit_changes(repo, {"skills/weak/SKILL.md": None}, "swap weak for something merely similar")

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr

    payload = _dropped(tmp_data_home, code_root)
    weak = _by_name(payload, "weak")
    assert weak["reason"] == "deleted"
    assert weak["successor"] is None
    assert weak["possible_successor"] is not None
    assert weak["possible_successor"]["name"] == "unrelated"
    assert 50 <= weak["possible_successor"]["similarity"] < 70


def test_rename_chain_a_to_b_to_c_resolves_to_the_final_hop(tmp_data_home, monkeypatch, tmp_path):
    """A skill renamed twice (`a` → `b` → `c`, across two separate commits)
    must resolve to `c` — the LAST path in the chain — while keeping the
    FIRST hop's similarity score (a later hop's score, against an
    already-renamed file, says nothing about how confident the ORIGINAL
    rename was)."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(tmp_path / "remote", {"skills/a/SKILL.md": _big_skill_md("a", "a")})
    _add_git_source(tmp_data_home, code_root, repo)  # a @ commit 1

    # commit 2: a -> b (name-only edit; high similarity).
    text_a = (repo / "skills/a/SKILL.md").read_text()
    (repo / "skills/b").mkdir()
    (repo / "skills/b/SKILL.md").write_text(text_a.replace("name: a", "name: b"))
    _commit_changes(repo, {"skills/a/SKILL.md": None}, "rename a -> b")

    # commit 3: b -> c (name-only edit; high similarity).
    text_b = (repo / "skills/b/SKILL.md").read_text()
    (repo / "skills/c").mkdir()
    (repo / "skills/c/SKILL.md").write_text(text_b.replace("name: b", "name: c"))
    _commit_changes(repo, {"skills/b/SKILL.md": None}, "rename b -> c")

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert "a" in payload["removed_upstream"]

    dropped_payload = _dropped(tmp_data_home, code_root)
    a = _by_name(dropped_payload, "a")
    assert a["reason"] == "renamed"
    assert a["successor"]["path"] == "skills/c"
    assert a["successor"]["name"] == "c"
    assert a["successor"]["similarity"] >= 70



# ─── S3: hardened extraction (symlink member + repo-root skill) ───────────


def test_recover_handles_a_benign_symlink_member_safely(tmp_data_home, monkeypatch, tmp_path):
    """A relative symlink inside the recovered tree (pointing at a sibling
    file in the SAME skill dir) must survive `hub._safe_extract` — the
    hardened extraction must not treat every symlink as unsafe, only ones
    that escape the destination."""
    import subprocess

    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/linky/SKILL.md": _skill_md("linky", "has a symlink"),
            "skills/linky/real.txt": "actual content",
        },
    )
    # A relative symlink inside the skill dir, pointing at its own sibling.
    (repo / "skills/linky/alias.txt").symlink_to("real.txt")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "user.email=test@local", "-c", "user.name=test", "commit", "-q", "-m", "add symlink"],
        cwd=repo,
        check=True,
    )
    _add_git_source(tmp_data_home, code_root, repo)
    _commit_changes(
        repo,
        {"skills/linky/SKILL.md": None, "skills/linky/real.txt": None, "skills/linky/alias.txt": None},
        "drop linky",
    )
    assert _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]).returncode == 0

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "recover", "linky", "--json"])
    assert result.returncode == 0, result.stderr
    dest = tmp_data_home / "skills" / "linky"
    assert (dest / "real.txt").read_text() == "actual content"
    assert (dest / "alias.txt").is_symlink()
    assert (dest / "alias.txt").resolve() == (dest / "real.txt").resolve()


def test_recover_a_repo_root_skill_does_not_yank_the_tmp_root(tmp_data_home, monkeypatch, tmp_path):
    """`origin.path == ""` (the whole repo IS the skill) used to make
    `extracted == tmp_path` — the bare TemporaryDirectory root — so recovering
    it moved the tempdir's own root out from under the `with` block."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(tmp_path / "remote", {"SKILL.md": _skill_md("rootskill", "lives at repo root")})
    _add_git_source(tmp_data_home, code_root, repo)
    _commit_changes(repo, {"SKILL.md": None}, "drop rootskill")
    assert _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]).returncode == 0

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "recover", "rootskill", "--json"])
    assert result.returncode == 0, result.stderr
    dest = tmp_data_home / "skills" / "rootskill"
    assert (dest / "SKILL.md").exists()
