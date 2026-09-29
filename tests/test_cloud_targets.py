"""Tests for cloud upload targets — `cloud_targets.py` + the `hub cloud` CLI.

Covers the three things that make the feature trustworthy:

  * the ZIP is **byte-reproducible** and in claude.ai's required layout (one
    top-level dir named after the skill), because a wobbling archive would make
    the drift fingerprint meaningless;
  * the status grammar (`new` → `up_to_date` → `changed`, plus `orphaned`) is
    driven by the content fingerprint, not by wall-clock or file mtimes;
  * pruning only ever deletes files hub itself recorded writing.

CLI tests spawn `hub.py` in a subprocess against an isolated `SKILL_HUB_HOME`
(the `test_remote_equip.py` pattern); pure-model tests call the module in-process
via the `tmp_data_home` fixture.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _write_skill(
    root: Path,
    name: str,
    description: str = "A skill used by the cloud-target tests.",
    body: str = "Body.\n",
) -> Path:
    """Create a minimal skill dir at `root` and return it."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}"
    )
    return root


def _seed_registry(data_home: Path, extra_skills: dict | None = None) -> dict:
    """Write a registry with one real skill dir (`demo`) plus any extras."""
    _write_skill(data_home / "skills" / "demo", "demo")
    (data_home / "skills" / "demo" / "references").mkdir(exist_ok=True)
    (data_home / "skills" / "demo" / "references" / "notes.md").write_text("notes\n")
    skills = {
        "demo": {
            "source": str(data_home / "skills" / "demo"),
            "type": "claude-skill",
            "scope": "portable",
        }
    }
    skills.update(extra_skills or {})
    registry = {
        "version": "1",
        "skills": skills,
        "bundles": {"pack": {"description": "", "skills": ["demo"]}},
        "projects": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    return registry


def _run(data_home: Path, args: list[str], cwd: Path | None = None):
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(data_home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(cwd or REPO_ROOT),
    )


def _status(data_home: Path, target: str = "claude-ai") -> dict:
    proc = _run(data_home, ["cloud", "status", target, "--json"])
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _by_name(rows: list[dict], key: str = "skill") -> dict:
    return {row[key]: row for row in rows}


# ─────────────────────────────────────────────────────────────────────────────
# 1. Deterministic ZIP builder
# ─────────────────────────────────────────────────────────────────────────────


def test_zip_is_byte_identical_across_rebuilds(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = _write_skill(tmp_path / "src", "demo")
    (src / "references").mkdir()
    (src / "references" / "a.md").write_text("alpha\n")
    (src / "bin.dat").write_bytes(b"\x00\x01\xff\xfe")

    first = tmp_path / "one" / "demo.zip"
    second = tmp_path / "two" / "demo.zip"
    m1 = cloud_targets.build_skill_zip("demo", src, first)
    m2 = cloud_targets.build_skill_zip("demo", src, second)

    assert first.read_bytes() == second.read_bytes()
    assert m1["sha256"] == m2["sha256"]
    # Nothing in the archive encodes when it was built.
    with zipfile.ZipFile(first) as zf:
        assert {i.date_time for i in zf.infolist()} == {cloud_targets.ZIP_EPOCH}
        assert {i.create_system for i in zf.infolist()} == {3}


def test_zip_rebuild_over_the_same_path_is_stable(tmp_path):
    """Re-exporting in place is a byte-for-byte no-op (no temp file left)."""
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = _write_skill(tmp_path / "src", "demo")
    out = tmp_path / "out" / "demo.zip"
    cloud_targets.build_skill_zip("demo", src, out)
    before = out.read_bytes()
    cloud_targets.build_skill_zip("demo", src, out)
    assert out.read_bytes() == before
    assert list(out.parent.iterdir()) == [out]


def test_fingerprint_and_bytes_change_when_content_changes(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = _write_skill(tmp_path / "src", "demo")
    out = tmp_path / "demo.zip"
    before = cloud_targets.build_skill_zip("demo", src, out)
    before_bytes = out.read_bytes()

    (src / "references").mkdir()
    (src / "references" / "new.md").write_text("added\n")
    after = cloud_targets.build_skill_zip("demo", src, out)

    assert after["sha256"] != before["sha256"]
    assert out.read_bytes() != before_bytes


def test_fingerprint_changes_when_only_the_skill_name_changes(tmp_path):
    """The top-level dir name is part of the archive, so it is part of the hash."""
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = _write_skill(tmp_path / "src", "demo")
    assert cloud_targets.content_fingerprint(
        "demo", src
    ) != cloud_targets.content_fingerprint("demo-renamed", src)


def test_zip_layout_is_one_top_level_dir_named_after_the_skill(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = _write_skill(tmp_path / "src", "demo")
    (src / "references").mkdir()
    (src / "references" / "a.md").write_text("alpha\n")
    out = tmp_path / "demo.zip"
    cloud_targets.build_skill_zip("demo", src, out)

    with zipfile.ZipFile(out) as zf:
        names = sorted(zf.namelist())
    assert names == ["demo/SKILL.md", "demo/references/a.md"]
    # claude.ai requires the skill folder as the ZIP root — exactly one of them.
    assert {n.split("/", 1)[0] for n in names} == {"demo"}


def test_zip_excludes_os_and_build_junk(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = _write_skill(tmp_path / "src", "demo")
    (src / ".DS_Store").write_bytes(b"junk")
    (src / "__pycache__").mkdir()
    (src / "__pycache__" / "mod.cpython-311.pyc").write_bytes(b"junk")
    (src / "stray.pyc").write_bytes(b"junk")
    (src / ".hub-bak-2026").mkdir()
    (src / ".hub-bak-2026" / "old.md").write_text("old\n")
    (src / "keep.md").write_text("keep\n")
    out = tmp_path / "demo.zip"
    cloud_targets.build_skill_zip("demo", src, out)

    with zipfile.ZipFile(out) as zf:
        names = sorted(zf.namelist())
    assert names == ["demo/SKILL.md", "demo/keep.md"]


def test_zip_skips_symlinks_resolving_outside_the_skill(tmp_path, capsys):
    from skill_hub.infrastructure.filesystem import cloud_targets

    secret = tmp_path / "secret.txt"
    secret.write_text("do not ship me\n")
    src = _write_skill(tmp_path / "src", "demo")
    (src / "leak.txt").symlink_to(secret)
    # An INSIDE link is still exported by content (parity with .skillpack).
    (src / "inside.md").symlink_to(src / "SKILL.md")

    out = tmp_path / "demo.zip"
    cloud_targets.build_skill_zip("demo", src, out)
    with zipfile.ZipFile(out) as zf:
        names = sorted(zf.namelist())
        assert "demo/leak.txt" not in names
        assert "demo/inside.md" in names
        assert b"do not ship me" not in zf.read("demo/inside.md")
    assert "leak.txt" in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────────────
# 2. Catalog + resolver
# ─────────────────────────────────────────────────────────────────────────────


def test_catalog_has_both_targets_with_real_upload_urls():
    from skill_hub.infrastructure.filesystem import cloud_targets

    assert set(cloud_targets.CLOUD_TARGETS) == {"claude-ai", "chatgpt-web"}
    claude = cloud_targets.CLOUD_TARGETS["claude-ai"]
    assert claude.upload_url == "https://claude.ai/customize/skills"
    assert claude.supports == ("skill",)
    assert any("mobile" in note.lower() for note in claude.notes)
    assert any("MCP" in note for note in claude.notes)
    chatgpt = cloud_targets.CLOUD_TARGETS["chatgpt-web"]
    assert chatgpt.upload_url == "https://chatgpt.com"
    assert "Skills" in chatgpt.upload_path
    assert any("mobile" in note.lower() for note in chatgpt.notes)


def test_load_cloud_drops_unknown_target_ids():
    from skill_hub.infrastructure.filesystem import cloud_targets

    parsed = cloud_targets.load_cloud(
        {"cloud": {"claude-ai": {"enabled": ["demo"]}, "made-up": {"enabled": ["x"]}}}
    )
    assert set(parsed) == {"claude-ai"}
    assert parsed["claude-ai"].enabled == ("demo",)


def test_load_cloud_tolerates_absent_and_malformed_block():
    from skill_hub.infrastructure.filesystem import cloud_targets

    assert cloud_targets.load_cloud({}) == {}
    assert cloud_targets.load_cloud({"cloud": None}) == {}
    assert cloud_targets.load_cloud({"cloud": "nope"}) == {}


def test_resolver_unions_bundles_and_enabled_like_a_project(tmp_data_home):
    from skill_hub.infrastructure.filesystem import cloud_targets

    _seed_registry(tmp_data_home)
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    registry["skills"]["extra"] = {
        "source": str(tmp_data_home / "skills" / "extra"),
        "type": "claude-skill",
        "scope": "portable",
    }
    resolved = cloud_targets.resolve_cloud_skills(
        {"bundles": ["pack"], "enabled": ["extra", "demo"]}, registry
    )
    # bundle skills first, then `enabled`, deduplicated, order preserved.
    assert resolved == ["demo", "extra"]


# ─────────────────────────────────────────────────────────────────────────────
# 3. Equip round-trip + validation
# ─────────────────────────────────────────────────────────────────────────────


def test_equip_skill_on_off_round_trip(tmp_data_home):
    _seed_registry(tmp_data_home)
    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", "demo",
         "--state", "on", "--json"],
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["enabled"] == ["demo"]
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert registry["cloud"]["claude-ai"]["enabled"] == ["demo"]
    assert registry["cloud"]["claude-ai"]["bundles"] == []

    # Idempotent on.
    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", "demo",
         "--state", "on", "--json"],
    )
    assert json.loads(proc.stdout)["enabled"] == ["demo"]

    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", "demo",
         "--state", "off", "--json"],
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["enabled"] == []
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert registry["cloud"]["claude-ai"]["enabled"] == []


def test_equip_bundle_reaches_its_skills(tmp_data_home):
    _seed_registry(tmp_data_home)
    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "bundle", "--name", "pack",
         "--state", "on", "--json"],
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["bundles"] == ["pack"]
    payload = _status(tmp_data_home)
    assert _by_name(payload["skills"])["demo"]["status"] == "new"


@pytest.mark.parametrize(
    "args, expect",
    [
        (["cloud", "equip", "nope", "--kind", "skill", "--name", "demo",
          "--state", "on"], "Unknown cloud target"),
        (["cloud", "equip", "claude-ai", "--kind", "skill", "--name", "ghost",
          "--state", "on"], "Unknown skill"),
        (["cloud", "equip", "claude-ai", "--kind", "bundle", "--name", "ghost",
          "--state", "on"], "Unknown bundle"),
    ],
)
def test_equip_validation_errors(tmp_data_home, args, expect):
    _seed_registry(tmp_data_home)
    proc = _run(tmp_data_home, args)
    assert proc.returncode != 0
    assert expect in (proc.stdout + proc.stderr)
    # A rejected equip never creates the registry block.
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert not (registry.get("cloud") or {}).get("claude-ai", {}).get("enabled")


def test_status_rejects_unknown_target(tmp_data_home):
    _seed_registry(tmp_data_home)
    proc = _run(tmp_data_home, ["cloud", "status", "nope", "--json"])
    assert proc.returncode != 0
    assert "Unknown cloud target" in (proc.stdout + proc.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Status grammar
# ─────────────────────────────────────────────────────────────────────────────


def _equip_demo(tmp_data_home, state="on"):
    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", "demo",
         "--state", state, "--json"],
    )
    assert proc.returncode == 0, proc.stderr


def test_status_grammar_new_export_up_to_date_edit_changed(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)

    payload = _status(tmp_data_home)
    assert _by_name(payload["skills"])["demo"]["status"] == "new"
    assert payload["summary"]["new"] == 1
    assert _by_name(payload["skills"])["demo"]["exported_at"] is None

    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 0, proc.stderr

    payload = _status(tmp_data_home)
    row = _by_name(payload["skills"])["demo"]
    assert row["status"] == "up_to_date"
    assert row["exported_at"]
    assert row["sha256"] == row["exported_sha256"]
    assert payload["summary"]["up_to_date"] == 1

    (tmp_data_home / "skills" / "demo" / "references" / "notes.md").write_text("EDIT\n")
    payload = _status(tmp_data_home)
    row = _by_name(payload["skills"])["demo"]
    assert row["status"] == "changed"
    assert row["sha256"] != row["exported_sha256"]
    assert payload["summary"]["changed"] == 1


def test_status_reports_orphaned_after_unequip(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    _equip_demo(tmp_data_home, "off")

    payload = _status(tmp_data_home)
    assert payload["skills"] == []
    assert _by_name(payload["orphaned"])["demo"]["zip_name"] == "demo.zip"
    assert payload["summary"]["orphaned"] == 1


def test_status_flags_missing_source_dir(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    import shutil

    shutil.rmtree(tmp_data_home / "skills" / "demo")
    payload = _status(tmp_data_home)
    row = _by_name(payload["skills"])["demo"]
    assert row["status"] == "missing"
    assert payload["summary"]["missing"] == 1


def test_targets_rollup_reflects_status(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    proc = _run(tmp_data_home, ["cloud", "targets", "--json"])
    assert proc.returncode == 0, proc.stderr
    rows = _by_name(json.loads(proc.stdout), key="id")
    assert rows["claude-ai"]["equipped"] == 1
    assert rows["claude-ai"]["drift"] == {
        "new": 1, "changed": 0, "up_to_date": 0, "missing": 0, "orphaned": 0
    }
    # Never exported → the card's "last exported" meta row must say so.
    assert rows["claude-ai"]["last_exported"] is None
    assert rows["chatgpt-web"]["equipped"] == 0


def test_targets_works_with_no_registry_at_all(tmp_data_home):
    """The catalog is code, not config — it lists even on a virgin data home."""
    proc = _run(tmp_data_home, ["cloud", "targets", "--json"])
    assert proc.returncode == 0, proc.stderr
    assert {r["id"] for r in json.loads(proc.stdout)} == {"claude-ai", "chatgpt-web"}


# ─────────────────────────────────────────────────────────────────────────────
# 5. mcp-server refusal
# ─────────────────────────────────────────────────────────────────────────────


def test_mcp_server_is_unsupported_not_exported(tmp_data_home):
    mcp_dir = tmp_data_home / "mcp-servers" / "srv"
    mcp_dir.mkdir(parents=True)
    (mcp_dir / "server.py").write_text("print('hi')\n")
    _seed_registry(
        tmp_data_home,
        extra_skills={
            "srv": {
                "source": str(mcp_dir),
                "type": "mcp-server",
                "scope": "portable",
                "mcp": {"command": "python3", "args": [], "env": {"TOKEN": "s3cret"}},
            }
        },
    )
    for name in ("demo", "srv"):
        proc = _run(
            tmp_data_home,
            ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", name,
             "--state", "on", "--json"],
        )
        assert proc.returncode == 0, proc.stderr

    payload = _status(tmp_data_home)
    assert [r["skill"] for r in payload["skills"]] == ["demo"]
    unsupported = _by_name(payload["unsupported"])
    assert "srv" in unsupported
    assert "MCP server" in unsupported["srv"]["reason"]

    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    exported = json.loads(proc.stdout)
    assert [r["skill"] for r in exported["results"]] == ["demo"]
    assert not (tmp_data_home / "exports" / "claude-ai" / "srv.zip").exists()

    # ...and the single-skill escape hatch refuses it too, with the reason.
    proc = _run(
        tmp_data_home, ["cloud", "export", "claude-ai", "--skill", "srv"]
    )
    assert proc.returncode != 0
    assert "MCP server" in (proc.stdout + proc.stderr)


def test_status_flags_a_skill_dropped_from_the_registry(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    del registry["skills"]["demo"]
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    payload = _status(tmp_data_home)
    assert payload["skills"] == []
    assert "not in the registry" in _by_name(payload["unsupported"])["demo"]["reason"]


# ─────────────────────────────────────────────────────────────────────────────
# 6. Lints — warn, never block
# ─────────────────────────────────────────────────────────────────────────────


def test_lint_flags_over_long_name(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    long_name = "n" * 65
    src = _write_skill(tmp_path / "src", long_name)
    warnings = cloud_targets.lint_skill(long_name, src)
    assert any("65 chars" in w and "name" in w for w in warnings)


def test_lint_flags_over_long_description(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = _write_skill(tmp_path / "src", "demo", description="d" * 201)
    warnings = cloud_targets.lint_skill("demo", src)
    assert any("201 chars" in w and "description" in w for w in warnings)


def test_lint_flags_missing_description(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    src = tmp_path / "src"
    src.mkdir()
    (src / "SKILL.md").write_text("---\nname: demo\n---\n\nBody.\n")
    warnings = cloud_targets.lint_skill("demo", src)
    assert any("description" in w and "missing" in w for w in warnings)


def test_lint_is_clean_at_the_caps(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    name = "n" * 64
    src = _write_skill(tmp_path / "src", name, description="d" * 200)
    assert cloud_targets.lint_skill(name, src) == []


def test_lint_flags_missing_or_unparseable_skill_md(tmp_path):
    from skill_hub.infrastructure.filesystem import cloud_targets

    empty = tmp_path / "empty"
    empty.mkdir()
    assert any("SKILL.md not found" in w for w in cloud_targets.lint_skill("x", empty))

    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "SKILL.md").write_text("no frontmatter here\n")
    assert any("frontmatter" in w for w in cloud_targets.lint_skill("x", bad))


def test_lint_warnings_ride_along_but_never_block_export(tmp_data_home):
    _write_skill(tmp_data_home / "skills" / "demo", "demo", description="d" * 201)
    (tmp_data_home / "registry.yaml").write_text(
        yaml.safe_dump(
            {
                "version": "1",
                "skills": {
                    "demo": {
                        "source": str(tmp_data_home / "skills" / "demo"),
                        "type": "claude-skill",
                        "scope": "portable",
                    }
                },
                "bundles": {},
                "projects": {},
            },
            sort_keys=False,
        )
    )
    _equip_demo(tmp_data_home)
    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert len(payload["results"]) == 1
    assert any("description" in w for w in payload["results"][0]["lint"])
    assert (tmp_data_home / "exports" / "claude-ai" / "demo.zip").is_file()


# ─────────────────────────────────────────────────────────────────────────────
# 7. Export: JSON shape, sidecar, pruning
# ─────────────────────────────────────────────────────────────────────────────


def test_export_json_shape_and_sidecar(tmp_data_home):
    from skill_hub.infrastructure.filesystem import cloud_targets

    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)

    assert payload["target"] == "claude-ai"
    assert payload["upload_url"] == "https://claude.ai/customize/skills"
    assert payload["notes"]
    assert payload["errors"] == []
    row = payload["results"][0]
    assert set(row) >= {"skill", "zip_path", "sha256", "status_before", "lint"}
    assert row["skill"] == "demo"
    assert row["status_before"] == "new"
    assert Path(row["zip_path"]).is_file()
    assert Path(row["zip_path"]).parent == tmp_data_home / "exports" / "claude-ai"

    sidecar = json.loads((tmp_data_home / "state" / "cloud" / "claude-ai.json").read_text())
    assert sidecar["schema_version"] == 1
    assert sidecar["skills"]["demo"]["sha256"] == row["sha256"]
    assert sidecar["skills"]["demo"]["zip_name"] == "demo.zip"
    assert sidecar["skills"]["demo"]["exported_at"]
    # Atomic write leaves no temp file behind.
    assert [p.name for p in (tmp_data_home / "state" / "cloud").iterdir()] == [
        "claude-ai.json"
    ]
    # The recorded hash is the content fingerprint, not the archive's digest.
    assert row["sha256"] == cloud_targets.content_fingerprint(
        "demo", tmp_data_home / "skills" / "demo"
    )


def test_export_status_before_reflects_prior_state(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)

    def export():
        proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
        assert proc.returncode == 0, proc.stderr
        return json.loads(proc.stdout)["results"][0]["status_before"]

    assert export() == "new"
    assert export() == "up_to_date"
    (tmp_data_home / "skills" / "demo" / "references" / "notes.md").write_text("EDIT\n")
    assert export() == "changed"


def test_export_single_skill_only(tmp_data_home):
    _write_skill(tmp_data_home / "skills" / "other", "other")
    _seed_registry(
        tmp_data_home,
        extra_skills={
            "other": {
                "source": str(tmp_data_home / "skills" / "other"),
                "type": "claude-skill",
                "scope": "portable",
            }
        },
    )
    for name in ("demo", "other"):
        _run(
            tmp_data_home,
            ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", name,
             "--state", "on", "--json"],
        )
    proc = _run(
        tmp_data_home, ["cloud", "export", "claude-ai", "--skill", "demo", "--json"]
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert [r["skill"] for r in payload["results"]] == ["demo"]
    out_dir = tmp_data_home / "exports" / "claude-ai"
    assert sorted(p.name for p in out_dir.iterdir()) == ["demo.zip"]


def test_export_refuses_a_skill_that_is_not_equipped(tmp_data_home):
    _seed_registry(tmp_data_home)
    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--skill", "demo"])
    assert proc.returncode != 0
    assert "not equipped" in (proc.stdout + proc.stderr)


def test_export_prunes_orphaned_sidecar_entries_and_their_zips(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    out_dir = tmp_data_home / "exports" / "claude-ai"
    assert (out_dir / "demo.zip").is_file()

    # Files hub does NOT own must survive the prune.
    (out_dir / "hand-made.zip").write_bytes(b"mine")
    (out_dir / "README.txt").write_text("mine\n")

    _equip_demo(tmp_data_home, "off")
    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["results"] == []
    assert payload["pruned"] == [
        {"skill": "demo", "removed_zip": str(out_dir / "demo.zip")}
    ]

    assert not (out_dir / "demo.zip").exists()
    assert (out_dir / "hand-made.zip").is_file()
    assert (out_dir / "README.txt").is_file()
    sidecar = json.loads((tmp_data_home / "state" / "cloud" / "claude-ai.json").read_text())
    assert sidecar["skills"] == {}


def test_export_to_custom_out_dir_prunes_state_but_deletes_nothing(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    custom = tmp_data_home / "elsewhere"
    proc = _run(
        tmp_data_home, ["cloud", "export", "claude-ai", "--out", str(custom), "--json"]
    )
    assert proc.returncode == 0, proc.stderr
    assert (custom / "demo.zip").is_file()
    assert not (tmp_data_home / "exports").exists()

    _equip_demo(tmp_data_home, "off")
    proc = _run(
        tmp_data_home, ["cloud", "export", "claude-ai", "--out", str(custom), "--json"]
    )
    payload = json.loads(proc.stdout)
    assert payload["pruned"] == [{"skill": "demo", "removed_zip": None}]
    # Hub never deletes inside a user-chosen dir.
    assert (custom / "demo.zip").is_file()


def test_corrupt_sidecar_is_tolerated_and_reported(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    sidecar_file = tmp_data_home / "state" / "cloud" / "claude-ai.json"
    sidecar_file.write_text("{not json at all")

    payload = _status(tmp_data_home)
    assert _by_name(payload["skills"])["demo"]["status"] == "new"
    assert any("unreadable" in w for w in payload.get("warnings") or [])

    # A re-export repairs the file rather than crashing.
    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 0, proc.stderr
    assert json.loads(sidecar_file.read_text())["skills"]["demo"]["sha256"]


def test_sidecar_read_tolerates_wrong_shape(tmp_data_home):
    from skill_hub.infrastructure.filesystem import cloud_targets

    path = cloud_targets.sidecar_path("claude-ai")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema_version": 1, "skills": ["not", "a", "dict"]}))
    data = cloud_targets.read_sidecar("claude-ai")
    assert data["skills"] == {}
    assert data["_corrupt"] == str(path)


def test_sidecar_write_is_atomic_and_leaves_no_temp(tmp_data_home):
    from skill_hub.infrastructure.filesystem import cloud_targets

    cloud_targets.write_sidecar(
        "claude-ai", {"skills": {"demo": {"sha256": "abc", "zip_name": "demo.zip"}}}
    )
    path = cloud_targets.sidecar_path("claude-ai")
    assert [p.name for p in path.parent.iterdir()] == ["claude-ai.json"]
    assert json.loads(path.read_text()) == {
        "schema_version": 1,
        "skills": {"demo": {"sha256": "abc", "zip_name": "demo.zip"}},
    }
    assert cloud_targets.read_sidecar("claude-ai")["skills"]["demo"]["sha256"] == "abc"


def test_export_human_output_ends_with_the_upload_next_step(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai"])
    assert proc.returncode == 0, proc.stderr
    assert "https://claude.ai/customize/skills" in proc.stdout
    assert str(tmp_data_home / "exports" / "claude-ai") in proc.stdout
    assert "mobile" in proc.stdout.lower()


# ─────────────────────────────────────────────────────────────────────────────
# 8. `hub harness list` — ChatGPT desktop annotation
# ─────────────────────────────────────────────────────────────────────────────


def _harness_rows(capsys) -> dict:
    import hub

    hub.cmd_harness_list(argparse.Namespace(json=True, probe=False))
    return _by_name(json.loads(capsys.readouterr().out), key="id")


def test_harness_list_annotates_codex_when_chatgpt_desktop_present(
    tmp_data_home, monkeypatch, capsys
):
    from skill_hub.infrastructure.filesystem import cloud_targets
    from skill_hub.infrastructure.harnesses import harnesses

    _seed_registry(tmp_data_home)
    # Hermetic: CI has no codex install, dev Macs do — pin both probes.
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"codex"})
    monkeypatch.setattr(cloud_targets, "chatgpt_desktop_installed", lambda: True)
    rows = _harness_rows(capsys)
    assert rows["codex"]["also_serves"] == ["ChatGPT desktop app"]
    # Only codex writes ~/.agents/skills on ChatGPT desktop's behalf.
    assert "also_serves" not in rows["claude-code"]


def test_harness_list_omits_annotation_when_chatgpt_desktop_absent(
    tmp_data_home, monkeypatch, capsys
):
    from skill_hub.infrastructure.filesystem import cloud_targets

    _seed_registry(tmp_data_home)
    monkeypatch.setattr(cloud_targets, "chatgpt_desktop_installed", lambda: False)
    rows = _harness_rows(capsys)
    assert "also_serves" not in rows["codex"]


def test_harness_list_table_mentions_chatgpt_desktop(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.infrastructure.filesystem import cloud_targets
    from skill_hub.infrastructure.harnesses import harnesses

    _seed_registry(tmp_data_home)
    # Hermetic: CI has no codex install, dev Macs do — pin both probes.
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"codex"})
    monkeypatch.setattr(cloud_targets, "chatgpt_desktop_installed", lambda: True)
    hub.cmd_harness_list(argparse.Namespace(json=False, probe=False))
    assert "also serves ChatGPT desktop app" in capsys.readouterr().out


def test_chatgpt_desktop_probe_is_a_single_path_check(tmp_path, monkeypatch):
    from skill_hub.infrastructure.filesystem import cloud_targets

    monkeypatch.setattr(cloud_targets, "CHATGPT_DESKTOP_APP", tmp_path / "Nope.app")
    assert cloud_targets.chatgpt_desktop_installed() is False
    (tmp_path / "Nope.app").mkdir()
    assert cloud_targets.chatgpt_desktop_installed() is True


# ─────────────────────────────────────────────────────────────────────────────
# 9. `hub skill export --format`
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_export_format_zip(tmp_data_home, tmp_path):
    _seed_registry(tmp_data_home)
    out = tmp_path / "custom" / "demo.zip"
    proc = _run(
        tmp_data_home,
        ["skill", "export", "demo", "--format", "zip", "--out", str(out), "--json"],
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload == {
        "exported": "demo",
        "out": str(out),
        "files": 2,
        "format": "zip",
        "sha256": payload["sha256"],
    }
    with zipfile.ZipFile(out) as zf:
        assert sorted(zf.namelist()) == ["demo/SKILL.md", "demo/references/notes.md"]


def test_skill_export_zip_default_path_is_cwd(tmp_data_home, tmp_path):
    _seed_registry(tmp_data_home)
    proc = _run(
        tmp_data_home, ["skill", "export", "demo", "--format", "zip", "--json"],
        cwd=tmp_path,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["out"] == "demo.zip"
    assert (tmp_path / "demo.zip").is_file()


def test_skill_export_default_format_is_pack_and_unchanged(tmp_data_home, tmp_path):
    _seed_registry(tmp_data_home)
    proc = _run(tmp_data_home, ["skill", "export", "demo", "--json"], cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["format"] == "pack"
    assert payload["out"] == "demo.skillpack"
    pack = json.loads((tmp_path / "demo.skillpack").read_text())
    assert pack["format"] == "skill-tree-pack"
    assert pack["format_version"] == 1
    assert [f["path"] for f in pack["files"]] == ["SKILL.md", "references/notes.md"]


def test_skill_export_zip_refuses_mcp_server(tmp_data_home, tmp_path):
    mcp_dir = tmp_data_home / "mcp-servers" / "srv"
    mcp_dir.mkdir(parents=True)
    (mcp_dir / "server.py").write_text("print('hi')\n")
    _seed_registry(
        tmp_data_home,
        extra_skills={
            "srv": {"source": str(mcp_dir), "type": "mcp-server", "scope": "portable"}
        },
    )
    proc = _run(
        tmp_data_home,
        ["skill", "export", "srv", "--format", "zip", "--json"],
        cwd=tmp_path,
    )
    assert proc.returncode != 0
    assert "MCP server" in json.loads(proc.stdout)["error"]
    assert not (tmp_path / "srv.zip").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 10. Hardening — malformed registries, unsafe names, partial failure
#
# Everything below is a regression pin for an adversarial-review finding: each
# case used to end in a traceback, a delete outside the export dir, or a silent
# half-run reported as a success.
# ─────────────────────────────────────────────────────────────────────────────


def _write_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _load_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


@pytest.mark.parametrize(
    "cloud_block",
    [
        "nope",                                   # the whole block is a string
        ["claude-ai"],                            # …a list
        {"claude-ai": "nope"},                    # one target is a string
        {"claude-ai": {"enabled": "demo"}},       # a name list is a string
        {"claude-ai": {"enabled": [None, 3, {}]}},  # non-string names
        {"claude-ai": {"bundles": {"pack": True}}},  # a name list is a mapping
    ],
)
def test_read_commands_survive_a_malformed_cloud_block(tmp_data_home, cloud_block):
    """A hand-edited `cloud:` must degrade to "nothing equipped", never crash.

    `partition_equipped` used to read the raw registry dict, so the sanitizing
    `load_cloud` was dead code and every shape here raised an AttributeError out
    of `hub cloud status` / `targets` / `export` — and out of the app's Cloud
    band, which rendered the traceback.
    """
    registry = _seed_registry(tmp_data_home)
    registry["cloud"] = cloud_block
    _write_registry(tmp_data_home, registry)

    for args in (
        ["cloud", "targets", "--json"],
        ["cloud", "status", "claude-ai", "--json"],
        ["cloud", "export", "claude-ai", "--json"],
    ):
        proc = _run(tmp_data_home, args)
        assert proc.returncode == 0, f"{args}: {proc.stdout}{proc.stderr}"
        assert "Traceback" not in proc.stderr
        json.loads(proc.stdout)  # still a well-formed payload

    assert _status(tmp_data_home)["summary"]["equipped"] == 0


@pytest.mark.parametrize(
    "cloud_block, expect",
    [
        ("nope", "not a mapping of target ids"),
        ({"claude-ai": "nope"}, "not a mapping"),
        ({"claude-ai": {"enabled": "demo"}}, "not a list"),
    ],
)
def test_equip_refuses_to_overwrite_a_malformed_cloud_block(
    tmp_data_home, cloud_block, expect
):
    """Equip must NOT silently replace a malformed block — that would delete
    every other target's equip list without a word."""
    registry = _seed_registry(tmp_data_home)
    registry["cloud"] = cloud_block
    _write_registry(tmp_data_home, registry)

    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", "demo",
         "--state", "on"],
    )
    assert proc.returncode != 0
    assert expect in (proc.stdout + proc.stderr)
    assert "Traceback" not in proc.stderr
    # The user's bytes are still there to repair.
    assert _load_registry(tmp_data_home)["cloud"] == cloud_block


def test_zip_name_for_refuses_a_path_shaped_name():
    from skill_hub.infrastructure.filesystem import cloud_targets

    assert cloud_targets.zip_name_for("demo") == "demo.zip"
    for bad in ("../../pwned", "a/b", "..", "", "Demo", "demo.zip"):
        with pytest.raises(ValueError):
            cloud_targets.zip_name_for(bad)


def test_recorded_zip_name_keeps_only_the_basename():
    from skill_hub.infrastructure.filesystem import cloud_targets

    assert (
        cloud_targets.recorded_zip_name("demo", {"zip_name": "../../evil.zip"})
        == "evil.zip"
    )
    assert cloud_targets.recorded_zip_name("demo", {}) == "demo.zip"
    assert cloud_targets.recorded_zip_name("demo", {"zip_name": ".."}) == "demo.zip"
    # Nothing safe can be derived → no filename, and therefore no delete.
    assert cloud_targets.recorded_zip_name("../../pwned", {}) is None


def test_export_refuses_a_path_shaped_registry_name(tmp_data_home):
    """`skills: {"../../pwned": …}` must not write a zip outside the export dir."""
    skill_dir = _write_skill(tmp_data_home / "skills" / "pwned", "pwned")
    registry = _seed_registry(tmp_data_home)
    registry["skills"]["../../pwned"] = {
        "source": str(skill_dir),
        "type": "claude-skill",
        "scope": "portable",
    }
    registry["cloud"] = {"claude-ai": {"bundles": [], "enabled": ["../../pwned"]}}
    _write_registry(tmp_data_home, registry)

    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["results"] == []
    assert any("unsafe skill name" in e for e in payload["errors"])
    assert not (tmp_data_home.parent.parent / "pwned.zip").exists()
    assert not (tmp_data_home / "pwned.zip").exists()


def test_skill_export_zip_refuses_a_path_shaped_name(tmp_data_home, tmp_path):
    skill_dir = _write_skill(tmp_data_home / "skills" / "pwned", "pwned")
    registry = _seed_registry(tmp_data_home)
    registry["skills"]["../../pwned"] = {
        "source": str(skill_dir),
        "type": "claude-skill",
        "scope": "portable",
    }
    _write_registry(tmp_data_home, registry)

    proc = _run(
        tmp_data_home,
        ["skill", "export", "../../pwned", "--format", "zip", "--json"],
        cwd=tmp_path,
    )
    assert proc.returncode != 0
    assert "unsafe skill name" in json.loads(proc.stdout)["error"]
    assert not (tmp_path.parent.parent / "pwned.zip").exists()


def test_prune_never_unlinks_outside_the_export_dir(tmp_data_home):
    """A doctored sidecar `zip_name` must not steer the prune's unlink()."""
    from skill_hub.infrastructure.filesystem import cloud_targets

    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])

    bait = tmp_data_home / "evil.zip"
    bait.write_bytes(b"not yours")
    sidecar = cloud_targets.sidecar_path("claude-ai")
    data = json.loads(sidecar.read_text())
    data["skills"]["gone"] = {
        "sha256": "x",
        "exported_at": "2026-01-01T00:00:00",
        "zip_name": "../evil.zip",
    }
    sidecar.write_text(json.dumps(data))

    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 0, proc.stderr
    pruned = _by_name(json.loads(proc.stdout)["pruned"])
    assert pruned["gone"]["removed_zip"] is None
    assert bait.is_file(), "prune escaped the export dir"


def _seed_two_skills(tmp_data_home) -> dict:
    """`demo` + `other`, both equipped on claude-ai."""
    other = _write_skill(tmp_data_home / "skills" / "other", "other")
    registry = _seed_registry(
        tmp_data_home,
        extra_skills={
            "other": {
                "source": str(other),
                "type": "claude-skill",
                "scope": "portable",
            }
        },
    )
    registry["cloud"] = {"claude-ai": {"bundles": [], "enabled": ["demo", "other"]}}
    _write_registry(tmp_data_home, registry)
    return registry


def test_export_isolates_a_failing_skill_and_still_records_the_rest(
    tmp_data_home, monkeypatch, capsys
):
    """One PermissionError used to abort the run mid-loop: the sidecar was never
    written, so the ZIPs already on disk re-reported as `new` forever."""
    import hub
    from skill_hub.infrastructure.filesystem import cloud_targets

    _seed_two_skills(tmp_data_home)
    real_build = cloud_targets.build_skill_zip

    def flaky(name, root, out_path, skill_md_override=None):
        if name == "other":
            raise PermissionError(13, "Permission denied", str(root))
        return real_build(name, root, out_path, skill_md_override)

    monkeypatch.setattr(cloud_targets, "build_skill_zip", flaky)
    args = argparse.Namespace(target="claude-ai", skill=None, out=None, json=True)
    with pytest.raises(SystemExit) as excinfo:
        hub.cmd_cloud_export(args)
    assert excinfo.value.code == 1

    payload = json.loads(capsys.readouterr().out)
    assert [r["skill"] for r in payload["results"]] == ["demo"]
    assert any("other" in e and "Permission denied" in e for e in payload["errors"])

    # The good skill's zip exists AND is recorded, so it does not re-report new.
    assert (tmp_data_home / "exports" / "claude-ai" / "demo.zip").is_file()
    sidecar = json.loads(
        (tmp_data_home / "state" / "cloud" / "claude-ai.json").read_text()
    )
    assert set(sidecar["skills"]) == {"demo"}
    assert _by_name(_status(tmp_data_home)["skills"])["demo"]["status"] == "up_to_date"


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root ignores the read bit, so nothing would fail",
)
def test_export_isolates_a_genuinely_unreadable_skill(tmp_data_home):
    """The same isolation, driven by a real filesystem permission error."""
    _seed_two_skills(tmp_data_home)
    blocked = tmp_data_home / "skills" / "other" / "SKILL.md"
    os.chmod(blocked, 0o000)
    try:
        proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    finally:
        os.chmod(blocked, 0o644)

    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "Traceback" not in proc.stderr
    payload = json.loads(proc.stdout)
    assert [r["skill"] for r in payload["results"]] == ["demo"]
    assert any(e.startswith("other:") for e in payload["errors"])


def test_export_exits_non_zero_when_a_source_dir_is_missing(tmp_data_home):
    registry = _seed_two_skills(tmp_data_home)
    registry["skills"]["other"]["source"] = str(tmp_data_home / "skills" / "vanished")
    _write_registry(tmp_data_home, registry)

    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"])
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert [r["skill"] for r in payload["results"]] == ["demo"]
    assert any("source directory not found" in e for e in payload["errors"])

    # Human mode reports the same failure rather than "nothing to export".
    proc = _run(tmp_data_home, ["cloud", "export", "claude-ai"])
    assert proc.returncode == 1
    assert "source directory not found" in (proc.stdout + proc.stderr)


def test_missing_source_counts_toward_the_targets_drift_rollup(tmp_data_home):
    """`equipped 1` next to an empty drift cluster was the honest-state bug."""
    registry = _seed_registry(tmp_data_home)
    registry["skills"]["demo"]["source"] = str(tmp_data_home / "skills" / "vanished")
    registry["cloud"] = {"claude-ai": {"bundles": [], "enabled": ["demo"]}}
    _write_registry(tmp_data_home, registry)

    proc = _run(tmp_data_home, ["cloud", "targets", "--json"])
    assert proc.returncode == 0, proc.stderr
    row = _by_name(json.loads(proc.stdout), key="id")["claude-ai"]
    assert row["equipped"] == 1
    assert row["drift"]["missing"] == 1

    proc = _run(tmp_data_home, ["cloud", "targets"])
    assert "1 missing" in proc.stdout


def test_targets_reports_the_last_export_time(tmp_data_home):
    _seed_registry(tmp_data_home)
    _equip_demo(tmp_data_home)
    assert _run(tmp_data_home, ["cloud", "export", "claude-ai", "--json"]).returncode == 0

    rows = _by_name(
        json.loads(_run(tmp_data_home, ["cloud", "targets", "--json"]).stdout), key="id"
    )
    recorded = json.loads(
        (tmp_data_home / "state" / "cloud" / "claude-ai.json").read_text()
    )
    assert rows["claude-ai"]["last_exported"] == recorded["skills"]["demo"]["exported_at"]
    assert rows["chatgpt-web"]["last_exported"] is None


def test_unequip_still_works_after_the_skill_disappears(tmp_data_home):
    """The case that matters most: the skill was archived while equipped here."""
    registry = _seed_registry(tmp_data_home)
    registry["cloud"] = {"claude-ai": {"bundles": ["pack"], "enabled": ["ghost"]}}
    _write_registry(tmp_data_home, registry)
    registry = _load_registry(tmp_data_home)
    del registry["bundles"]["pack"]
    _write_registry(tmp_data_home, registry)

    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "skill", "--name", "ghost",
         "--state", "off", "--json"],
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout)["enabled"] == []

    proc = _run(
        tmp_data_home,
        ["cloud", "equip", "claude-ai", "--kind", "bundle", "--name", "pack",
         "--state", "off", "--json"],
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout)["bundles"] == []


def test_archive_unequips_the_skill_from_every_cloud_target(tmp_data_home):
    registry = _seed_registry(tmp_data_home)
    registry["cloud"] = {
        "claude-ai": {"bundles": [], "enabled": ["demo"]},
        "chatgpt-web": {"bundles": [], "enabled": ["demo"]},
    }
    _write_registry(tmp_data_home, registry)

    proc = _run(tmp_data_home, ["archive", "demo", "--dry-run"])
    assert proc.returncode == 0, proc.stderr
    assert "would unequip from cloud targets: chatgpt-web, claude-ai" in proc.stdout

    proc = _run(tmp_data_home, ["archive", "demo"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    cloud = _load_registry(tmp_data_home)["cloud"]
    assert cloud["claude-ai"]["enabled"] == []
    assert cloud["chatgpt-web"]["enabled"] == []


def test_bundle_delete_unequips_the_bundle_from_every_cloud_target(tmp_data_home):
    registry = _seed_registry(tmp_data_home)
    registry["cloud"] = {"claude-ai": {"bundles": ["pack"], "enabled": []}}
    _write_registry(tmp_data_home, registry)

    proc = _run(tmp_data_home, ["bundle", "delete", "pack", "--dry-run"])
    assert proc.returncode == 0, proc.stderr
    assert "would unequip from cloud targets: claude-ai" in proc.stdout
    assert _load_registry(tmp_data_home)["cloud"]["claude-ai"]["bundles"] == ["pack"]

    proc = _run(tmp_data_home, ["bundle", "delete", "pack"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _load_registry(tmp_data_home)["cloud"]["claude-ai"]["bundles"] == []


def test_harness_list_needs_codex_installed_for_the_desktop_annotation(
    tmp_data_home, monkeypatch, capsys
):
    """ChatGPT.app on disk says nothing on its own: with codex absent hub writes
    no ~/.agents/skills at all, so "already handled" would be a flat lie."""
    from skill_hub.infrastructure.filesystem import cloud_targets
    from skill_hub.infrastructure.harnesses import harnesses

    _seed_registry(tmp_data_home)
    monkeypatch.setattr(cloud_targets, "chatgpt_desktop_installed", lambda: True)
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"claude-code"})
    rows = _harness_rows(capsys)
    assert "also_serves" not in rows["codex"]

    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"claude-code", "codex"})
    rows = _harness_rows(capsys)
    assert rows["codex"]["also_serves"] == ["ChatGPT desktop app"]


def test_skill_source_fails_cleanly_without_a_source_key(tmp_data_home):
    """A hand-edited / partially restored registry entry must not KeyError."""
    registry = _seed_registry(tmp_data_home)
    del registry["skills"]["demo"]["source"]
    registry["cloud"] = {"claude-ai": {"bundles": [], "enabled": ["demo"]}}
    _write_registry(tmp_data_home, registry)

    proc = _run(tmp_data_home, ["cloud", "status", "claude-ai", "--json"])
    assert proc.returncode != 0
    assert "Traceback" not in proc.stderr
    assert "missing its `source:` path" in (proc.stdout + proc.stderr)


def test_chatgpt_desktop_note_points_at_global_scope(tmp_data_home):
    """The note used to say "equip those through a project" — which reaches the
    desktop app only inside that repo. `~/.agents/skills` needs scope: global."""
    from skill_hub.infrastructure.filesystem import cloud_targets

    note = " ".join(cloud_targets.CLOUD_TARGETS["chatgpt-web"].notes)
    assert "scope: global" in note
    assert "<repo>/.agents/skills" in note
