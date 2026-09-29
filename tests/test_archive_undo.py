"""`hub archive` (batch) / `hub unarchive` — the sidecar-backed undo path.

Covers: the sidecar `<data_home>/state/archive/<name>.json` written BEFORE
deletion, a full round-trip (dir + registry entry + bundle order + project
`enabled` + invocation override), a dropped-upstream ("Forget") skill that has
nothing to move, and that a batch archive triggers exactly one `_auto_sync()`.

Mirrors `test_archive_references.py`'s subprocess-CLI style for the
round-trip tests; the auto-sync-count assertion runs `cmd_archive` in-process
(via `tmp_data_home`) so `monkeypatch.setattr(hub, "_auto_sync", ...)` takes
effect the same way `test_source_lifecycle.py`'s failure-mode test does.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


def _write_skill(root: Path, name: str, description: str = "d") -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\nBody.\n"
    )


def _run(data_home: Path, home: Path, args: list[str]):
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(data_home)
    env["HOME"] = str(home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _payload(result: subprocess.CompletedProcess) -> dict:
    text = result.stdout
    start = text.find("{")
    if start < 0:
        raise AssertionError(f"no JSON payload in stdout:\n{text}")
    obj, _end = json.JSONDecoder().raw_decode(text[start:])
    return obj


def _load(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _sidecar(data_home: Path, name: str) -> dict:
    return json.loads((data_home / "state" / "archive" / f"{name}.json").read_text())


@pytest.fixture
def world(tmp_data_home, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    project = tmp_path / "proj"
    project.mkdir()
    for n in ("demo", "other"):
        _write_skill(tmp_data_home / "skills" / n, n)
    registry = {
        "version": "1",
        "skills": {
            n: {
                "source": str(tmp_data_home / "skills" / n),
                "type": "claude-skill",
                "scope": "portable",
            }
            for n in ("demo", "other")
        },
        "bundles": {"pack": {"description": "", "skills": ["other", "demo"]}},
        "projects": {
            "proj": {
                "path": str(project),
                "bundles": ["pack"],
                "enabled": ["demo"],
                "harnesses": ["pi"],
                "invocation_overrides": {"demo": "user-only"},
            }
        },
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    return tmp_data_home, home, project


# ─── sidecar written before deletion ────────────────────────────────────────


def test_archive_writes_sidecar_before_deleting(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["archive", "demo", "--json"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    sidecar = _sidecar(data_home, "demo")
    assert sidecar["schema_version"] == 1
    assert sidecar["archived_at"]
    assert sidecar["entry"]["type"] == "claude-skill"
    assert sidecar["references"]["bundles"] == {"pack": 1}  # demo is 2nd in ["other","demo"]
    assert sidecar["references"]["projects"] == ["proj"]
    assert sidecar["references"]["invocation_overrides"] == {"proj": "user-only"}
    assert sidecar["moved_to"] is not None
    assert Path(sidecar["moved_to"]).name == "demo"
    assert "demo" not in _load(data_home)["skills"]


def test_json_payload_shape(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["archive", "demo", "other", "--json"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = _payload(proc)
    assert payload["ok"] is True
    names = {a["name"] for a in payload["archived"]}
    assert names == {"demo", "other"}
    for a in payload["archived"]:
        assert a["moved"] is True
        assert "references" in a
    assert payload["undo"] == ["unarchive", "demo", "other"]


# ─── full round-trip ────────────────────────────────────────────────────────


def test_unarchive_restores_entry_bundle_order_project_enable_and_override(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["archive", "demo", "--json"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    reg = _load(data_home)
    assert "demo" not in reg["skills"]
    assert reg["bundles"]["pack"]["skills"] == ["other"]
    assert reg["projects"]["proj"]["enabled"] == []
    assert reg["projects"]["proj"]["invocation_overrides"] == {}

    proc2 = _run(data_home, home, ["unarchive", "demo", "--json"])
    assert proc2.returncode == 0, proc2.stdout + proc2.stderr
    payload = _payload(proc2)
    assert payload["restored"] == ["demo"]
    assert payload["skipped"] == []

    reg2 = _load(data_home)
    assert "demo" in reg2["skills"]
    assert reg2["skills"]["demo"]["type"] == "claude-skill"
    # back at its original position (index 1 of ["other", "demo"])
    assert reg2["bundles"]["pack"]["skills"] == ["other", "demo"]
    assert reg2["projects"]["proj"]["enabled"] == ["demo"]
    assert reg2["projects"]["proj"]["invocation_overrides"] == {"demo": "user-only"}
    # the dir came back too
    assert (data_home / "skills" / "demo" / "SKILL.md").exists()
    # sidecar consumed
    assert not (data_home / "state" / "archive" / "demo.json").exists()


def test_unarchive_clamps_bundle_index_when_bundle_shrank(world):
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "--json"]).returncode == 0
    reg = _load(data_home)
    reg["bundles"]["pack"]["skills"] = []  # shrank below the recorded index
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    proc = _run(data_home, home, ["unarchive", "demo", "--json"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    reg2 = _load(data_home)
    assert reg2["bundles"]["pack"]["skills"] == ["demo"]  # clamped to end, not an IndexError


def test_unarchive_skips_a_holder_that_no_longer_exists(world):
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "--json"]).returncode == 0
    reg = _load(data_home)
    del reg["bundles"]["pack"]  # bundle removed meanwhile
    del reg["projects"]["proj"]  # project removed meanwhile
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    proc = _run(data_home, home, ["unarchive", "demo", "--json"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    reg2 = _load(data_home)
    assert "demo" in reg2["skills"]  # the entry itself still restores


# ─── skip semantics ─────────────────────────────────────────────────────────


def test_unarchive_reports_missing_sidecar_and_exits_1_when_nothing_restored(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["unarchive", "never-archived", "--json"])
    assert proc.returncode == 1
    payload = _payload(proc)
    assert payload["restored"] == []
    assert payload["skipped"] == [
        {"name": "never-archived", "reason": "no archive record found"}
    ]


def test_unarchive_skips_when_already_registered(world):
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "--json"]).returncode == 0
    # Something re-registers "demo" before undo runs.
    reg = _load(data_home)
    reg["skills"]["demo"] = {"source": "~/x", "type": "claude-skill", "scope": "portable"}
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    proc = _run(data_home, home, ["unarchive", "demo", "--json"])
    assert proc.returncode == 1
    payload = _payload(proc)
    assert payload["restored"] == []
    assert payload["skipped"][0]["name"] == "demo"
    assert "already registered" in payload["skipped"][0]["reason"]


def test_unarchive_skips_when_destination_already_exists(world):
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "--json"]).returncode == 0
    dest = data_home / "skills" / "demo"
    dest.mkdir(parents=True)
    (dest / "collide.txt").write_text("in the way")

    proc = _run(data_home, home, ["unarchive", "demo", "--json"])
    assert proc.returncode == 1
    payload = _payload(proc)
    assert payload["restored"] == []
    assert "already exists" in payload["skipped"][0]["reason"]


def test_unarchive_batch_partial_success_exits_0(world):
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "other", "--json"]).returncode == 0

    proc = _run(
        data_home, home, ["unarchive", "demo", "never-archived", "--json"]
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr  # at least one restored
    payload = _payload(proc)
    assert payload["restored"] == ["demo"]
    assert payload["skipped"] == [
        {"name": "never-archived", "reason": "no archive record found"}
    ]


# ─── "Forget" a dropped-upstream skill: nothing to move ────────────────────


def test_archiving_a_dropped_upstream_skill_moves_nothing(tmp_data_home, tmp_path):
    """A `source_missing` skill's `source:` points into a source checkout
    that no longer has the file — there is no dir under the data home to
    move, matching the spec's "Forget" vocabulary."""
    home = tmp_path / "home"
    home.mkdir()
    registry = {
        "version": "1",
        "skills": {
            "ghost": {
                "source": str(tmp_path / "gone" / "ghost"),  # never created
                "type": "claude-skill",
                "scope": "portable",
                "managed": "external",
                "origin": {"source": "org", "source_type": "git", "path": "skills/ghost", "ref": "deadbeef"},
                "source_missing": True,
            }
        },
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    proc = _run(tmp_data_home, home, ["archive", "ghost", "--json"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = _payload(proc)
    assert payload["archived"] == [{"name": "ghost", "moved": False, "references": {
        "bundles": {}, "projects": [], "invocation_overrides": {}, "companions": {},
        "companions_global": {}, "remotes": [], "cloud": [],
    }}]
    sidecar = _sidecar(tmp_data_home, "ghost")
    assert sidecar["moved_to"] is None
    assert "ghost" not in _load(tmp_data_home)["skills"]


# ─── one auto_sync per batch (in-process, monkeypatched) ───────────────────


def test_batch_archive_triggers_auto_sync_exactly_once(tmp_data_home, monkeypatch):
    import hub

    for n in ("a", "b"):
        _write_skill(tmp_data_home / "skills" / n, n)
    hub.save_registry(
        {
            "skills": {
                n: {"source": str(tmp_data_home / "skills" / n), "type": "claude-skill", "scope": "portable"}
                for n in ("a", "b")
            },
            "projects": {},
            "bundles": {},
        }
    )
    hub.load_registry()

    calls = {"n": 0}
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.__setitem__("n", calls["n"] + 1))

    hub.cmd_archive(Namespace(skills=["a", "b"], dry_run=False, json=False))

    assert calls["n"] == 1
    reg = hub.load_registry()
    assert "a" not in reg["skills"] and "b" not in reg["skills"]


def test_batch_unarchive_triggers_auto_sync_exactly_once(tmp_data_home, monkeypatch):
    import hub

    for n in ("a", "b"):
        _write_skill(tmp_data_home / "skills" / n, n)
    hub.save_registry(
        {
            "skills": {
                n: {"source": str(tmp_data_home / "skills" / n), "type": "claude-skill", "scope": "portable"}
                for n in ("a", "b")
            },
            "projects": {},
            "bundles": {},
        }
    )
    hub.load_registry()
    hub.cmd_archive(Namespace(skills=["a", "b"], dry_run=False, json=False))

    calls = {"n": 0}
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.__setitem__("n", calls["n"] + 1))
    hub.cmd_unarchive(Namespace(skills=["a", "b"], json=False))

    assert calls["n"] == 1
    reg = hub.load_registry()
    assert "a" in reg["skills"] and "b" in reg["skills"]


# ─── B2: refuse a name that already has a pending undo record ─────────────


def test_archive_refuses_a_name_with_a_pending_undo_record(world):
    """Re-archiving a name whose FIRST archive was never undone must refuse
    outright — not nest the second copy inside `_archive/<name>/` and clobber
    the first sidecar with `os.replace`."""
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "--json"]).returncode == 0
    first_sidecar = _sidecar(data_home, "demo")

    # "demo" gets re-created (a fresh registration under the same name) while
    # the first archive is still pending undo.
    _write_skill(data_home / "skills" / "demo2", "demo")
    reg = _load(data_home)
    reg["skills"]["demo"] = {
        "source": str(data_home / "skills" / "demo2"),
        "type": "claude-skill",
        "scope": "portable",
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    proc = _run(data_home, home, ["archive", "demo", "--json"])
    assert proc.returncode == 1
    assert "pending undo record" in (proc.stdout + proc.stderr)

    # No nesting: `_archive/demo` still holds exactly the FIRST archive's file.
    archive_dir = data_home / "skills" / "_archive" / "demo"
    assert (archive_dir / "SKILL.md").exists()
    assert not (archive_dir / "demo").exists()
    # The sidecar is untouched — still the first archive's record.
    assert _sidecar(data_home, "demo") == first_sidecar
    # The re-created dir was never touched.
    assert (data_home / "skills" / "demo2" / "SKILL.md").exists()
    # The re-registered entry is still in the registry (nothing rolled back
    # that didn't need to be — the refusal happens before any mutation).
    reg2 = _load(data_home)
    assert "demo" in reg2["skills"]


# ─── B3: path-traversal-shaped names ───────────────────────────────────────


def test_archive_rejects_a_path_traversal_name(world, tmp_path):
    """A registry hand-edited (or corrupted) to carry a non-slug KEY must
    never reach path construction — `validate_slug` runs before anything
    else, regardless of whether the name happens to be registered."""
    data_home, home, _ = world
    outside = tmp_path / "outside"
    outside.mkdir()
    reg = _load(data_home)
    reg["skills"]["../../../outside/evil"] = {
        "source": str(outside),
        "type": "claude-skill",
        "scope": "portable",
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    proc = _run(data_home, home, ["archive", "../../../outside/evil", "--json"])
    assert proc.returncode == 1
    assert "Invalid skill name" in (proc.stdout + proc.stderr)
    # nothing written outside the data home, and no sidecar for this name
    assert list(outside.iterdir()) == []  # untouched
    assert not (data_home / "state" / "archive").exists()


def test_unarchive_rejects_a_path_traversal_name(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["unarchive", "../../../etc/passwd", "--json"])
    assert proc.returncode == 1
    payload = _payload(proc)
    assert payload["restored"] == []
    assert payload["skipped"] == [
        {"name": "../../../etc/passwd", "reason": "invalid skill name"}
    ]


def test_unarchive_skips_a_sidecar_whose_moved_to_escapes_the_data_home(world, tmp_path):
    """A tampered/corrupt sidecar must never send a move outside the data
    home just because its JSON body says so."""
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "--json"]).returncode == 0

    # `tmp_data_home` (behind `world`) IS `tmp_path` itself (see
    # conftest.py), so a genuinely OUTSIDE path must be a sibling, not a
    # child, of `tmp_path`.
    outside_dir = tmp_path.parent / (tmp_path.name + "-escaped")
    outside_dir.mkdir()
    (outside_dir / "SKILL.md").write_text("---\nname: demo\ndescription: d\n---\n")
    sidecar_path = data_home / "state" / "archive" / "demo.json"
    data = json.loads(sidecar_path.read_text())
    data["moved_to"] = str(outside_dir)  # tampered: was the real _archive/demo
    sidecar_path.write_text(json.dumps(data))

    proc = _run(data_home, home, ["unarchive", "demo", "--json"])
    assert proc.returncode == 1
    payload = _payload(proc)
    assert payload["restored"] == []
    assert "outside the data home" in payload["skipped"][0]["reason"]
    # the escaped directory was never touched, and the real archived copy
    # (never named by the tampered pointer) was never moved either
    assert (outside_dir / "SKILL.md").exists()
    assert (data_home / "skills" / "_archive" / "demo" / "SKILL.md").exists()
    assert "demo" not in _load(data_home)["skills"]


def test_unarchive_skips_a_sidecar_whose_destination_escapes_the_data_home(world, tmp_path):
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo", "--json"]).returncode == 0

    sidecar_path = data_home / "state" / "archive" / "demo.json"
    data = json.loads(sidecar_path.read_text())
    outside_dest = tmp_path.parent / (tmp_path.name + "-escaped-dest")
    data["entry"]["source"] = str(outside_dest)  # tampered destination
    sidecar_path.write_text(json.dumps(data))

    proc = _run(data_home, home, ["unarchive", "demo", "--json"])
    assert proc.returncode == 1
    payload = _payload(proc)
    assert payload["restored"] == []
    assert "outside the data home" in payload["skipped"][0]["reason"]
    assert not outside_dest.exists()
    assert (data_home / "skills" / "_archive" / "demo" / "SKILL.md").exists()  # never moved


# ─── S2: mid-batch failure rolls back what THIS run already did ───────────


def test_mid_batch_archive_failure_rolls_back_the_first_names_move(tmp_data_home, monkeypatch):
    import hub
    import skill_hub.entrypoints.cli.archive

    for n in ("a", "b"):
        _write_skill(tmp_data_home / "skills" / n, n)
    hub.save_registry(
        {
            "skills": {
                n: {"source": str(tmp_data_home / "skills" / n), "type": "claude-skill", "scope": "portable"}
                for n in ("a", "b")
            },
            "projects": {},
            "bundles": {},
        }
    )
    hub.load_registry()
    before_sha = hub._registry_sha()

    real_write = skill_hub.entrypoints.cli.archive._write_archive_sidecar
    calls = {"n": 0}

    def _flaky_write(name, entry, references, moved_to):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk full")
        return real_write(name, entry, references, moved_to)

    monkeypatch.setattr(skill_hub.entrypoints.cli.archive, "_write_archive_sidecar", _flaky_write)

    with pytest.raises(SystemExit):
        hub.cmd_archive(Namespace(skills=["a", "b"], dry_run=False, json=False))

    # "a" (processed first, fully) is back where it started.
    assert (tmp_data_home / "skills" / "a" / "SKILL.md").exists()
    assert not (tmp_data_home / "skills" / "_archive" / "a").exists()
    assert not (tmp_data_home / "state" / "archive" / "a.json").exists()
    # "b" never got as far as writing anything (the flaky call raised INSIDE
    # its own sidecar write, before any move for "b").
    assert (tmp_data_home / "skills" / "b" / "SKILL.md").exists()
    assert not (tmp_data_home / "state" / "archive" / "b.json").exists()
    # Registry on disk is byte-identical: `save_registry` never ran.
    assert hub._registry_sha() == before_sha
    reg = hub.load_registry()
    assert "a" in reg["skills"] and "b" in reg["skills"]


# ─── NIT: dry-run JSON payload ──────────────────────────────────────────────


def test_archive_dry_run_json_emits_a_payload(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["archive", "demo", "other", "--dry-run", "--json"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = _payload(proc)
    assert payload == {
        "ok": True,
        "dry_run": True,
        "plan": [
            {
                "name": "demo",
                "would_move": True,
                "references": {
                    "bundles": {"pack": 1},
                    "projects": ["proj"],
                    "invocation_overrides": {"proj": "user-only"},
                    "companions": {},
                    "companions_global": {},
                    "remotes": [],
                    "cloud": [],
                },
            },
            {
                "name": "other",
                "would_move": True,
                "references": {
                    "bundles": {"pack": 0},
                    "projects": [],
                    "invocation_overrides": {},
                    "companions": {},
                    "companions_global": {},
                    "remotes": [],
                    "cloud": [],
                },
            },
        ],
    }
    # dry-run really did not mutate anything
    assert "demo" in _load(data_home)["skills"]
    assert "other" in _load(data_home)["skills"]


# ─── TA-1-e64c: argv-layer smoke case, so a removed/broken parser reds here ──


def test_archive_reached_through_hub_main_argv(world, monkeypatch, capsys):
    """`hub archive <name> --json` must be reachable through the real
    argparse dispatch table, not only through a hand-built Namespace."""
    import hub

    data_home, _home, _project = world
    monkeypatch.setattr(sys, "argv", ["hub", "archive", "demo", "--json"])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    out = capsys.readouterr().out
    obj, _end = json.JSONDecoder().raw_decode(out[out.find("{"):])
    assert code == 0
    assert obj["ok"] is True
