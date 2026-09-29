"""Tests for the portable `.skillpack` format — `hub skill export|import`.

The pack is a single JSON envelope (v1), so every assertion here is about the
exact bytes that cross the machine boundary: what gets written, what is refused
fail-closed, and what a partially-applied import leaves behind (nothing).
"""

from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path

import pytest

BINARY = b"\x89PNG\r\n\x1a\n\xff\xfe\x00\x01binary-not-utf8"


# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────


def _seed_registry(skills: dict | None = None) -> dict:
    import hub

    registry = {"skills": skills or {}, "projects": {}, "bundles": {}}
    hub.save_registry(registry)
    return registry


def _write_skill(root: Path, name: str, extra: dict | None = None) -> Path:
    """Write a minimal on-disk skill dir (+ optional extra files)."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: |\n  demo skill\n---\n\n# {name}\n"
    )
    for rel, data in (extra or {}).items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, bytes):
            target.write_bytes(data)
        else:
            target.write_text(data)
    return root


def _register_skill(name: str, extra: dict | None = None, **overrides) -> Path:
    """Create the skill on disk under the data home AND register it."""
    import hub

    root = _write_skill(hub.hub_skills_dir() / name, name, extra)
    entry = {
        "version": "1.0.0",
        "description": "demo skill",
        "source": hub.collapse_home(root),
        "type": "claude-skill",
        "scope": "portable",
        "upstream": None,
    }
    entry.update(overrides)
    registry = hub.load_registry()
    registry.setdefault("skills", {})[name] = entry
    hub.save_registry(registry)
    return root


def _export(name: str, out: Path | None = None, json_mode: bool = False):
    import hub

    hub.cmd_skill_export(
        Namespace(name=name, out=str(out) if out else None, json=json_mode)
    )


def _import(file: Path, dry_run=False, name=None, json_mode=False):
    import hub

    hub.cmd_skill_import(
        Namespace(file=str(file), dry_run=dry_run, name=name, json=json_mode)
    )


def _json_out(capsys) -> dict:
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def _write_pack(path: Path, **overrides) -> Path:
    """A minimal VALID pack, with per-key overrides for the negative cases."""
    pack = {
        "format": "skill-tree-pack",
        "format_version": 1,
        "skill": {
            "name": "packed",
            "version": "1.0.0",
            "description": "a packed skill",
            "type": "claude-skill",
            "scope": "portable",
        },
        "files": [
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"}
        ],
    }
    for key, value in overrides.items():
        if key == "skill" and isinstance(value, dict):
            pack["skill"].update(value)
        else:
            pack[key] = value
    path.write_text(json.dumps(pack))
    return path


# ─────────────────────────────────────────────────────────────────────────────
# export
# ─────────────────────────────────────────────────────────────────────────────


def test_export_roundtrip_multifile_including_binary(tmp_data_home, tmp_path):
    import hub

    _seed_registry()
    _register_skill(
        "demo",
        {
            "scripts/run.py": "print('hi')\n",
            "assets/logo.png": BINARY,
            "docs/nested/deep.md": "# deep\n",
        },
    )

    pack_file = tmp_path / "demo.skillpack"
    _export("demo", pack_file)

    pack = json.loads(pack_file.read_text())
    assert pack["format"] == "skill-tree-pack"
    assert pack["format_version"] == 1
    assert pack["skill"]["name"] == "demo"
    paths = [f["path"] for f in pack["files"]]
    assert paths == sorted(paths), "file list must be deterministically sorted"
    assert paths == [
        "SKILL.md",
        "assets/logo.png",
        "docs/nested/deep.md",
        "scripts/run.py",
    ]
    by_path = {f["path"]: f for f in pack["files"]}
    assert by_path["assets/logo.png"]["encoding"] == "base64"
    assert by_path["scripts/run.py"]["encoding"] == "utf8"

    # …and back in under a fresh name.
    _import(pack_file, name="demo-copy")

    dest = hub.hub_skills_dir() / "demo-copy"
    assert (dest / "scripts" / "run.py").read_text() == "print('hi')\n"
    assert (dest / "assets" / "logo.png").read_bytes() == BINARY
    assert (dest / "docs" / "nested" / "deep.md").read_text() == "# deep\n"

    entry = hub.load_registry()["skills"]["demo-copy"]
    assert entry["type"] == "claude-skill"
    assert entry["scope"] == "portable"
    assert entry["version"] == "1.0.0"
    assert entry["upstream"] is None
    assert entry["source"] == hub.collapse_home(dest)


def test_export_omits_registry_only_classification(tmp_data_home, tmp_path):
    _seed_registry()
    _register_skill(
        "classified",
        classification={
            "classes": ["process"],
            "outputs": ["plan"],
            "working_mode": "mixed",
        },
    )
    out = tmp_path / "classified.skillpack"
    _export("classified", out)
    raw = out.read_text()
    pack = json.loads(raw)
    assert "classification" not in pack["skill"]
    assert "process" not in raw


def test_export_default_filename(tmp_data_home, tmp_path, monkeypatch):
    _seed_registry()
    _register_skill("demo")
    monkeypatch.chdir(tmp_path)

    _export("demo")

    assert (tmp_path / "demo.skillpack").is_file()


def test_export_json_output(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _register_skill("demo", {"scripts/run.py": "x = 1\n"})
    out = tmp_path / "p.skillpack"

    _export("demo", out, json_mode=True)

    payload = _json_out(capsys)
    # `format` was added when `--format zip` landed; `pack` stays the default.
    assert payload == {
        "exported": "demo",
        "out": str(out),
        "files": 2,
        "format": "pack",
    }


def test_export_refuses_mcp_server(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _register_skill("srv", type="mcp-server")

    with pytest.raises(SystemExit) as exc:
        _export("srv", tmp_path / "p.skillpack", json_mode=True)
    assert exc.value.code == 1
    assert "MCP server" in _json_out(capsys)["error"]
    assert not (tmp_path / "p.skillpack").exists()


def test_export_refuses_unknown_skill(tmp_data_home, tmp_path, capsys):
    _seed_registry()

    with pytest.raises(SystemExit):
        _export("nope", tmp_path / "p.skillpack", json_mode=True)
    assert "Unknown skill" in _json_out(capsys)["error"]


def test_export_refuses_missing_source_dir(tmp_data_home, tmp_path, capsys):
    import hub

    _seed_registry()
    _register_skill("ghost")
    import shutil

    shutil.rmtree(hub.hub_skills_dir() / "ghost")

    with pytest.raises(SystemExit):
        _export("ghost", tmp_path / "p.skillpack", json_mode=True)
    assert "not found" in _json_out(capsys)["error"]


def test_export_skips_machine_noise(tmp_data_home, tmp_path):
    _seed_registry()
    _register_skill(
        "demo",
        {
            ".DS_Store": "junk",
            "__pycache__/mod.pyc": b"\x00\x01",
            ".hub-bak-20260101/SKILL.md": "old",
            "keep.txt": "keep",
        },
    )

    _export("demo", tmp_path / "p.skillpack")

    paths = [f["path"] for f in json.loads((tmp_path / "p.skillpack").read_text())["files"]]
    assert paths == ["SKILL.md", "keep.txt"]


def test_export_resolves_symlinked_file_by_content(tmp_data_home, tmp_path):
    """A link that stays INSIDE the skill still ships by content (self-contained)."""
    _seed_registry()
    root = _register_skill("demo", {"real/inside.txt": "inside content\n"})
    (root / "linked.txt").symlink_to(root / "real" / "inside.txt")

    _export("demo", tmp_path / "p.skillpack")

    files = {f["path"]: f for f in json.loads((tmp_path / "p.skillpack").read_text())["files"]}
    assert files["linked.txt"]["content"] == "inside content\n"
    assert files["linked.txt"]["encoding"] == "utf8"


def test_export_skips_symlink_pointing_outside_the_skill_dir(
    tmp_data_home, tmp_path, capsys
):
    """`notes.txt -> ~/.ssh/id_rsa` must NOT ride along in a shareable pack."""
    _seed_registry()
    root = _register_skill("demo")
    secret = tmp_path / "id_rsa"
    secret.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n")
    (root / "notes.txt").symlink_to(secret)

    _export("demo", tmp_path / "p.skillpack")

    captured = capsys.readouterr()
    raw = (tmp_path / "p.skillpack").read_text()
    paths = [f["path"] for f in json.loads(raw)["files"]]
    assert paths == ["SKILL.md"]
    assert "BEGIN OPENSSH PRIVATE KEY" not in raw
    assert "notes.txt" in captured.err
    assert "outside the skill dir" in captured.err


def test_export_skips_symlink_escaping_via_relative_traversal(tmp_data_home, tmp_path):
    """`..`-relative links resolve outside too, and are skipped the same way."""
    _seed_registry()
    root = _register_skill("demo")
    (root.parent / "sibling.txt").write_text("not mine\n")
    (root / "nested").mkdir()
    (root / "nested" / "escape.txt").symlink_to(Path("..") / ".." / "sibling.txt")

    _export("demo", tmp_path / "p.skillpack")

    raw = (tmp_path / "p.skillpack").read_text()
    assert [f["path"] for f in json.loads(raw)["files"]] == ["SKILL.md"]
    assert "not mine" not in raw


def test_export_carries_harnesses_and_invocation(tmp_data_home, tmp_path):
    _seed_registry()
    _register_skill("demo", harnesses=["claude-code"], invocation="user-only")

    _export("demo", tmp_path / "p.skillpack")

    skill = json.loads((tmp_path / "p.skillpack").read_text())["skill"]
    assert skill["harnesses"] == ["claude-code"]
    assert skill["invocation"] == "user-only"


def test_export_omits_unset_optional_fields(tmp_data_home, tmp_path):
    _seed_registry()
    _register_skill("demo")

    _export("demo", tmp_path / "p.skillpack")

    skill = json.loads((tmp_path / "p.skillpack").read_text())["skill"]
    assert "harnesses" not in skill
    assert "invocation" not in skill


def test_export_marks_executable_scripts_only(tmp_data_home, tmp_path):
    _seed_registry()
    root = _register_skill(
        "demo",
        {"scripts/run.sh": "#!/bin/sh\necho hi\n", "scripts/data.txt": "not a script\n"},
    )
    (root / "scripts" / "run.sh").chmod(0o755)
    (root / "scripts" / "data.txt").chmod(0o644)

    _export("demo", tmp_path / "p.skillpack")

    files = {f["path"]: f for f in json.loads((tmp_path / "p.skillpack").read_text())["files"]}
    assert files["scripts/run.sh"]["executable"] is True
    assert "executable" not in files["scripts/data.txt"]


def test_export_envelope_unchanged_when_nothing_is_executable(tmp_data_home, tmp_path):
    _seed_registry()
    _register_skill("demo", {"scripts/run.sh": "echo hi\n", "notes.txt": "notes\n"})

    _export("demo", tmp_path / "p.skillpack")

    files = json.loads((tmp_path / "p.skillpack").read_text())["files"]
    assert all("executable" not in f for f in files)


def test_export_does_not_mark_an_executable_outside_scripts(tmp_data_home, tmp_path):
    _seed_registry()
    root = _register_skill("demo", {"bin/tool": "#!/bin/sh\n", "runme.sh": "#!/bin/sh\n"})
    (root / "bin" / "tool").chmod(0o755)
    (root / "runme.sh").chmod(0o755)

    _export("demo", tmp_path / "p.skillpack")

    files = {f["path"]: f for f in json.loads((tmp_path / "p.skillpack").read_text())["files"]}
    assert "executable" not in files["bin/tool"]
    assert "executable" not in files["runme.sh"]


# ─────────────────────────────────────────────────────────────────────────────
# import — dry run
# ─────────────────────────────────────────────────────────────────────────────


def test_dry_run_json_schema_and_no_mutation(tmp_data_home, tmp_path, capsys):
    import hub

    _seed_registry()
    _register_skill("demo", {"scripts/run.py": "x = 1\n", "assets/logo.png": BINARY})
    pack_file = tmp_path / "p.skillpack"
    _export("demo", pack_file)
    capsys.readouterr()

    before = hub._registry_sha()
    _import(pack_file, dry_run=True, json_mode=True)
    payload = _json_out(capsys)

    assert set(payload) == {
        "valid",
        "errors",
        "name",
        "version",
        "description",
        "type",
        "scope",
        "files",
        "collision",
        "existing",
    }
    assert payload["valid"] is True
    assert payload["errors"] == []
    assert payload["name"] == "demo"
    assert payload["version"] == "1.0.0"
    assert payload["type"] == "claude-skill"
    assert payload["scope"] == "portable"
    assert payload["collision"] is True  # 'demo' is the skill we just exported
    assert payload["existing"]["version"] == "1.0.0"
    assert payload["existing"]["scope"] == "portable"
    assert [f["path"] for f in payload["files"]] == [
        "SKILL.md",
        "assets/logo.png",
        "scripts/run.py",
    ]
    assert {f["path"]: f["bytes"] for f in payload["files"]}["assets/logo.png"] == len(
        BINARY
    )

    # …and it changed nothing at all.
    assert hub._registry_sha() == before
    assert not hub.audit_log_path().exists()


def test_dry_run_no_collision_on_fresh_name(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(tmp_path / "p.skillpack")

    _import(tmp_path / "p.skillpack", dry_run=True, json_mode=True)

    payload = _json_out(capsys)
    assert payload["collision"] is False
    assert payload["existing"] is None
    assert payload["valid"] is True


def test_dry_run_name_override_is_reflected_and_validated(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(tmp_path / "p.skillpack")

    _import(tmp_path / "p.skillpack", dry_run=True, name="renamed", json_mode=True)
    assert _json_out(capsys)["name"] == "renamed"

    _import(tmp_path / "p.skillpack", dry_run=True, name="Bad Name", json_mode=True)
    payload = _json_out(capsys)
    assert payload["valid"] is False
    assert any("Invalid name" in e for e in payload["errors"])


def test_dry_run_reports_errors_without_exiting(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(tmp_path / "p.skillpack", format="tarball")

    _import(tmp_path / "p.skillpack", dry_run=True, json_mode=True)

    payload = _json_out(capsys)
    assert payload["valid"] is False
    assert any("Unknown format" in e for e in payload["errors"])


def test_dry_run_human_output(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(tmp_path / "p.skillpack")

    _import(tmp_path / "p.skillpack", dry_run=True)

    out = capsys.readouterr().out
    assert "DRY-RUN" in out
    assert "SKILL.md" in out
    assert "valid" in out


def test_validate_pack_collects_exec_set_and_ignores_non_true_values(tmp_data_home):
    import skill_hub.entrypoints.cli.skill as skill_mod

    pack = {
        "format": "skill-tree-pack",
        "format_version": 1,
        "skill": {"name": "packed"},
        "files": [
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "scripts/a.sh", "encoding": "utf8", "content": "a", "executable": True},
            {"path": "scripts/b.sh", "encoding": "utf8", "content": "b", "executable": "yes"},
            {"path": "scripts/c.sh", "encoding": "utf8", "content": "c", "executable": 1},
            {"path": "scripts/d.sh", "encoding": "utf8", "content": "d", "executable": None},
        ],
    }

    errors, meta = skill_mod.validate_skill_pack(pack)

    assert errors == []
    assert meta["_exec"] == {"scripts/a.sh"}


def test_dry_run_listing_and_human_output_flag_executables(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {
                "path": "scripts/run.sh",
                "encoding": "utf8",
                "content": "echo hi",
                "executable": True,
            },
            {"path": "scripts/data.txt", "encoding": "utf8", "content": "plain"},
        ],
    )

    _import(tmp_path / "p.skillpack", dry_run=True, json_mode=True)
    files = {f["path"]: f for f in _json_out(capsys)["files"]}
    assert files["scripts/run.sh"]["executable"] is True
    assert "executable" not in files["scripts/data.txt"]

    _import(tmp_path / "p.skillpack", dry_run=True)
    out = capsys.readouterr().out
    lines = {ln.strip(): ln for ln in out.splitlines()}
    run_line = next(ln for path, ln in lines.items() if "scripts/run.sh" in path)
    data_line = next(ln for path, ln in lines.items() if "scripts/data.txt" in path)
    assert run_line.rstrip().endswith("+x")
    assert not data_line.rstrip().endswith("+x")


def test_import_ignores_an_executable_flag_outside_scripts_and_says_so(
    tmp_data_home, tmp_path, capsys
):
    import skill_hub.entrypoints.cli.skill as skill_mod

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {
                "path": "bin/tool",
                "encoding": "utf8",
                "content": "#!/bin/sh\n",
                "executable": True,
            },
        ],
    )
    pack = json.loads((tmp_path / "p.skillpack").read_text())
    errors, meta = skill_mod.validate_skill_pack(pack)
    assert errors == []
    assert meta["_exec_ignored"] == ["bin/tool"]

    _import(tmp_path / "p.skillpack")

    import hub

    dest = hub.hub_skills_dir() / "packed"
    assert not (dest / "bin" / "tool").stat().st_mode & 0o100
    err = capsys.readouterr().err
    assert "bin/tool" in err


# ─────────────────────────────────────────────────────────────────────────────
# import — validation (fail-closed)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_path,needle",
    [
        ("/etc/passwd", "absolute path"),
        ("../../../etc/passwd", "escapes the skill dir"),
        ("nested/../../out.txt", "escapes the skill dir"),
        ("", "empty or non-string path"),
        ("   ", "empty or non-string path"),
        ("C:\\Windows\\evil.txt", "backslash"),
        ("\\\\server\\share\\evil.txt", "backslash"),
    ],
)
def test_import_rejects_unsafe_paths(tmp_data_home, tmp_path, capsys, bad_path, needle):
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": bad_path, "encoding": "utf8", "content": "pwned"},
        ],
    )

    with pytest.raises(SystemExit) as exc:
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert exc.value.code == 1
    payload = _json_out(capsys)
    assert any(needle in e for e in payload["errors"])
    assert not (hub.hub_skills_dir() / "packed").exists()
    assert "packed" not in hub.load_registry().get("skills", {})


@pytest.mark.parametrize(
    "overrides,needle",
    [
        ({"format": "tarball"}, "Unknown format"),
        ({"format_version": 2}, "Unsupported format_version"),
        ({"format_version": "1"}, "Unsupported format_version"),
        ({"skill": {"name": "Bad Name"}}, "Invalid skill name"),
        ({"skill": {"name": "UPPER"}}, "Invalid skill name"),
        ({"skill": {"type": "mcp-server"}}, "MCP servers cannot be shared"),
        ({"skill": {"scope": "weird"}}, "Invalid scope"),
        ({"skill": {"version": "not-semver"}}, "Invalid version"),
        ({"skill": {"invocation": "sometimes"}}, "Invalid invocation"),
        ({"files": []}, "no files"),
    ],
)
def test_import_refuses_malformed_pack(tmp_data_home, tmp_path, capsys, overrides, needle):
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack", **overrides)

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert any(needle in e for e in _json_out(capsys)["errors"])
    assert not hub.hub_skills_dir().joinpath("packed").exists()


def test_import_refuses_pack_without_skill_md(tmp_data_home, tmp_path, capsys):
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[{"path": "docs/readme.md", "encoding": "utf8", "content": "hi"}],
    )

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert any("missing SKILL.md" in e for e in _json_out(capsys)["errors"])
    assert not (hub.hub_skills_dir() / "packed").exists()


def test_import_refuses_undecodable_base64_and_leaves_nothing(
    tmp_data_home, tmp_path, capsys
):
    """A bad blob mid-pack: no dest dir, no registry entry, no partial write."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "a.txt", "encoding": "utf8", "content": "fine"},
            {"path": "b.bin", "encoding": "base64", "content": "!!!not base64!!!"},
        ],
    )
    before = hub._registry_sha()

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)

    assert any("undecodable base64" in e for e in _json_out(capsys)["errors"])
    assert not (hub.hub_skills_dir() / "packed").exists()
    assert hub._registry_sha() == before


def test_import_refuses_unknown_encoding(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "rot13", "content": "---\nname: packed\n---\n"}
        ],
    )

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert any("unknown encoding" in e for e in _json_out(capsys)["errors"])


def test_import_refuses_duplicate_paths(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "SKILL.md", "encoding": "utf8", "content": "shadow"},
        ],
    )

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert any("Duplicate file path" in e for e in _json_out(capsys)["errors"])


def test_import_refuses_non_json_file(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    bad = tmp_path / "p.skillpack"
    bad.write_text("this is not json")

    with pytest.raises(SystemExit):
        _import(bad, json_mode=True)
    assert "not valid JSON" in _json_out(capsys)["error"]


def test_import_refuses_missing_file(tmp_data_home, tmp_path, capsys):
    _seed_registry()

    with pytest.raises(SystemExit):
        _import(tmp_path / "nope.skillpack", json_mode=True)
    assert "not found" in _json_out(capsys)["error"]


# ─────────────────────────────────────────────────────────────────────────────
# import — collisions + apply
# ─────────────────────────────────────────────────────────────────────────────


def test_import_collision_refused_then_name_override_succeeds(
    tmp_data_home, tmp_path, capsys
):
    import hub

    _seed_registry()
    _register_skill("demo", {"scripts/run.py": "x = 1\n"})
    pack_file = tmp_path / "p.skillpack"
    _export("demo", pack_file)
    capsys.readouterr()

    original = (hub.hub_skills_dir() / "demo" / "scripts" / "run.py").read_text()
    with pytest.raises(SystemExit) as exc:
        _import(pack_file, json_mode=True)
    assert exc.value.code == 1
    assert "--name" in _json_out(capsys)["error"]
    # the incumbent is untouched
    assert (hub.hub_skills_dir() / "demo" / "scripts" / "run.py").read_text() == original

    _import(pack_file, name="demo-2", json_mode=True)
    assert _json_out(capsys) == {"imported": "demo-2", "files": 2}
    assert (hub.hub_skills_dir() / "demo-2" / "scripts" / "run.py").read_text() == original
    assert "demo-2" in hub.load_registry()["skills"]


def test_import_collision_on_dest_dir_without_registry_entry(
    tmp_data_home, tmp_path, capsys
):
    """A stray dir in skills/ is a collision even with no registry entry."""
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack")
    _write_skill(hub.hub_skills_dir() / "packed", "packed")

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert "already exists" in _json_out(capsys)["error"]


def test_import_override_that_also_collides_is_refused(tmp_data_home, tmp_path, capsys):
    import hub

    _seed_registry()
    _register_skill("taken")
    _write_pack(tmp_path / "p.skillpack")

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", name="taken", json_mode=True)
    assert "pick another --name" in _json_out(capsys)["error"]
    assert not (hub.hub_skills_dir() / "packed").exists()


def test_import_override_rewrites_skill_md_name(tmp_data_home, tmp_path):
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {
                "path": "SKILL.md",
                "encoding": "utf8",
                "content": "---\nname: packed\ndescription: d\n---\n",
            }
        ],
    )

    _import(tmp_path / "p.skillpack", name="renamed")

    text = (hub.hub_skills_dir() / "renamed" / "SKILL.md").read_text()
    assert "name: renamed" in text
    assert "name: packed" not in text


def test_import_preserves_harnesses_and_invocation(tmp_data_home, tmp_path):
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        skill={"harnesses": ["claude-code", "codex"], "invocation": "user-only"},
    )

    _import(tmp_path / "p.skillpack")

    entry = hub.load_registry()["skills"]["packed"]
    assert entry["harnesses"] == ["claude-code", "codex"]
    assert entry["invocation"] == "user-only"


def test_import_registers_six_field_entry(tmp_data_home, tmp_path):
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        skill={"scope": "project-specific", "version": "2.3.4", "description": "hello"},
    )

    _import(tmp_path / "p.skillpack")

    entry = hub.load_registry()["skills"]["packed"]
    assert entry == {
        "version": "2.3.4",
        "description": "hello",
        "source": hub.collapse_home(hub.hub_skills_dir() / "packed"),
        "type": "claude-skill",
        "scope": "project-specific",
        "upstream": None,
    }


def test_import_writes_audit_record(tmp_data_home, tmp_path):
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack")

    _import(tmp_path / "p.skillpack")

    records = [
        json.loads(line)
        for line in hub.audit_log_path().read_text().splitlines()
        if line.strip()
    ]
    assert any(r["verb"] == "skill-import" and r["changed"] for r in records)


def test_import_cleans_up_dest_on_mid_write_failure(tmp_data_home, tmp_path, monkeypatch):
    """An OSError halfway through the copy leaves no dir and no registry entry."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "a.txt", "encoding": "utf8", "content": "fine"},
            {"path": "b.txt", "encoding": "utf8", "content": "boom"},
        ],
    )
    hub.load_registry()  # let the schema migrations settle first
    before = hub._registry_sha()

    real_write_bytes = Path.write_bytes

    def exploding_write_bytes(self, data):
        if self.name == "b.txt":
            raise OSError("disk full")
        return real_write_bytes(self, data)

    monkeypatch.setattr(Path, "write_bytes", exploding_write_bytes)

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack")

    assert not (hub.hub_skills_dir() / "packed").exists()
    assert hub._registry_sha() == before
    assert "packed" not in hub.load_registry().get("skills", {})


def test_import_json_success_shape(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "a.txt", "encoding": "utf8", "content": "a"},
            {"path": "b.bin", "encoding": "base64", "content": "AAEC"},
        ],
    )

    _import(tmp_path / "p.skillpack", json_mode=True)

    assert _json_out(capsys) == {"imported": "packed", "files": 3}


def test_import_chmods_only_the_flagged_entries(tmp_data_home, tmp_path):
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {
                "path": "scripts/run.sh",
                "encoding": "utf8",
                "content": "echo hi\n",
                "executable": True,
            },
            {"path": "notes.txt", "encoding": "utf8", "content": "plain\n"},
        ],
    )

    _import(tmp_path / "p.skillpack")

    dest = hub.hub_skills_dir() / "packed"
    assert (dest / "scripts" / "run.sh").stat().st_mode & 0o100

    # Every other file must be left at whatever mode `write_bytes` gives it
    # under the CALLER's own umask — never widened, never narrowed. Compare
    # against a control file written the same way in this same process, so
    # the assertion holds at any umask instead of hard-coding one.
    control = tmp_path / "control.txt"
    control.write_bytes(b"plain\n")
    assert (dest / "notes.txt").stat().st_mode == control.stat().st_mode


def test_import_v1_pack_without_executable_key_still_imports(tmp_data_home, tmp_path):
    """Back-compat: a pack with no `executable` key imports fine, non-executable."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "scripts/run.sh", "encoding": "utf8", "content": "echo hi\n"},
        ],
    )

    _import(tmp_path / "p.skillpack")

    dest = hub.hub_skills_dir() / "packed"
    control = tmp_path / "control.sh"
    control.write_bytes(b"echo hi\n")
    assert (dest / "scripts" / "run.sh").stat().st_mode == control.stat().st_mode
    assert not (dest / "scripts" / "run.sh").stat().st_mode & 0o100


def test_import_auto_syncs_and_keeps_stdout_json_clean(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(tmp_path / "p.skillpack")

    _import(tmp_path / "p.skillpack", json_mode=True)

    captured = capsys.readouterr()
    stdout_lines = [ln for ln in captured.out.splitlines() if ln.strip()]
    assert len(stdout_lines) == 1
    assert json.loads(stdout_lines[0]) == {"imported": "packed", "files": 1}
    assert "sync complete" in captured.err


def test_import_base64_blob_roundtrips_exactly(tmp_data_home, tmp_path):
    import base64

    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {
                "path": "assets/logo.png",
                "encoding": "base64",
                "content": base64.b64encode(BINARY).decode("ascii"),
            },
        ],
    )

    _import(tmp_path / "p.skillpack")

    assert (hub.hub_skills_dir() / "packed" / "assets" / "logo.png").read_bytes() == BINARY


# ─────────────────────────────────────────────────────────────────────────────
# import — envelope/frontmatter name agreement
#
# `validate_registry_skills` treats registry-key ≠ SKILL.md-name as FATAL and
# exits from inside `hub sync`, which every registry mutation reaches through
# `_auto_sync`. A pack that disagrees with itself must therefore be refused at
# the door — otherwise it imports "successfully" and wedges the whole hub.
# ─────────────────────────────────────────────────────────────────────────────


def _mismatched_pack(path: Path, envelope: str, frontmatter_line: str) -> Path:
    return _write_pack(
        path,
        skill={"name": envelope},
        files=[
            {
                "path": "SKILL.md",
                "encoding": "utf8",
                "content": f"---\n{frontmatter_line}\ndescription: d\n---\n",
            }
        ],
    )


@pytest.mark.parametrize(
    "frontmatter_line",
    ["name: evil", 'name: "evil"', "name: 'evil'"],
)
def test_dry_run_flags_frontmatter_name_mismatch(
    tmp_data_home, tmp_path, capsys, frontmatter_line
):
    _seed_registry()
    _mismatched_pack(tmp_path / "p.skillpack", "innocent", frontmatter_line)

    _import(tmp_path / "p.skillpack", dry_run=True, json_mode=True)

    payload = _json_out(capsys)
    assert payload["valid"] is False
    assert any(
        "Name mismatch" in e and "innocent" in e and "evil" in e
        for e in payload["errors"]
    )


@pytest.mark.parametrize(
    "frontmatter_line",
    ["name: evil", 'name: "evil"', "name: 'evil'"],
)
def test_import_refuses_frontmatter_name_mismatch(
    tmp_data_home, tmp_path, capsys, frontmatter_line
):
    import hub

    _seed_registry()
    _mismatched_pack(tmp_path / "p.skillpack", "innocent", frontmatter_line)
    hub.load_registry()  # let the schema migrations settle first
    before = hub._registry_sha()

    with pytest.raises(SystemExit) as exc:
        _import(tmp_path / "p.skillpack", json_mode=True)

    assert exc.value.code == 1
    assert any("Name mismatch" in e for e in _json_out(capsys)["errors"])
    assert not (hub.hub_skills_dir() / "innocent").exists()
    assert not (hub.hub_skills_dir() / "evil").exists()
    assert "innocent" not in hub.load_registry().get("skills", {})
    assert hub._registry_sha() == before


def test_import_refuses_skill_md_without_a_frontmatter_name(
    tmp_data_home, tmp_path, capsys
):
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\ndescription: d\n---\n"}
        ],
    )

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert any("missing a `name:` field" in e for e in _json_out(capsys)["errors"])
    assert not (hub.hub_skills_dir() / "packed").exists()


def test_import_refuses_skill_md_without_frontmatter(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[{"path": "SKILL.md", "encoding": "utf8", "content": "# just prose\n"}],
    )

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert any("no readable `---` frontmatter" in e for e in _json_out(capsys)["errors"])


def test_import_accepts_quoted_frontmatter_name_that_matches(tmp_data_home, tmp_path):
    import hub

    _seed_registry()
    _mismatched_pack(tmp_path / "p.skillpack", "packed", 'name: "packed"')

    _import(tmp_path / "p.skillpack")

    assert "packed" in hub.load_registry()["skills"]


def test_import_override_rewrites_a_quoted_frontmatter_name(tmp_data_home, tmp_path):
    """The old raw `text.replace("name: packed", …)` no-opped on quoted names."""
    import hub

    _seed_registry()
    _mismatched_pack(tmp_path / "p.skillpack", "packed", 'name: "packed"')

    _import(tmp_path / "p.skillpack", name="renamed")

    skill_md = hub.hub_skills_dir() / "renamed" / "SKILL.md"
    assert hub.parse_skill_frontmatter_name(skill_md) == "renamed"
    assert "packed" not in skill_md.read_text()
    # …and the registry key agrees, so validation passes.
    hub.validate_registry_skills(hub.load_registry())


def test_import_override_does_not_corrupt_a_description_mentioning_name(
    tmp_data_home, tmp_path
):
    """Only the `name:` KEY line is rewritten — never a look-alike in prose."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {
                "path": "SKILL.md",
                "encoding": "utf8",
                "content": (
                    "---\n"
                    'description: "beware of name: packed strings"\n'
                    "name: packed\n"
                    "---\n\nbody mentioning name: packed too\n"
                ),
            }
        ],
    )

    _import(tmp_path / "p.skillpack", name="renamed")

    skill_md = hub.hub_skills_dir() / "renamed" / "SKILL.md"
    front = hub.parse_skill_frontmatter(skill_md)
    assert front["name"] == "renamed"
    assert front["description"] == "beware of name: packed strings"
    assert "body mentioning name: packed too" in skill_md.read_text()


def test_import_override_fails_closed_when_the_name_line_cannot_be_rewritten(
    tmp_data_home, tmp_path, capsys
):
    """A flow-mapping frontmatter parses but has no `name:` line to rewrite."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {
                "path": "SKILL.md",
                "encoding": "utf8",
                "content": "---\n{name: packed, description: d}\n---\n",
            }
        ],
    )

    with pytest.raises(SystemExit) as exc:
        _import(tmp_path / "p.skillpack", name="renamed", json_mode=True)

    assert exc.value.code == 1
    assert "cannot rewrite" in _json_out(capsys)["error"]
    assert not (hub.hub_skills_dir() / "renamed").exists()
    assert "renamed" not in hub.load_registry().get("skills", {})


# ─────────────────────────────────────────────────────────────────────────────
# import — path collisions that only a normalizing filesystem would notice
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "twin_a,twin_b",
    [
        ("notes.md", "NOTES.md"),
        ("docs/Guide.txt", "docs/guide.txt"),
        ("caf\u00e9.txt", "cafe\u0301.txt"),  # NFC vs NFD twins of "café.txt"
    ],
)
def test_import_refuses_case_or_unicode_twin_paths(
    tmp_data_home, tmp_path, capsys, twin_a, twin_b
):
    """Two entries, one inode: the previewed file would not be the one that lands."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": twin_a, "encoding": "utf8", "content": "honest"},
            {"path": twin_b, "encoding": "utf8", "content": "shadow"},
        ],
    )

    with pytest.raises(SystemExit) as exc:
        _import(tmp_path / "p.skillpack", json_mode=True)

    assert exc.value.code == 1
    assert any("Colliding file path" in e for e in _json_out(capsys)["errors"])
    assert not (hub.hub_skills_dir() / "packed").exists()


def test_import_refuses_a_skill_md_case_twin(tmp_data_home, tmp_path, capsys):
    """`SKILL.md` + `skill.md` would let the previewed manifest be swapped out."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "skill.md", "encoding": "utf8", "content": "---\nname: evil\n---\n"},
        ],
    )

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    assert any("Colliding file path" in e for e in _json_out(capsys)["errors"])
    assert not (hub.hub_skills_dir() / "packed").exists()


def test_import_still_reports_exact_duplicates_distinctly(tmp_data_home, tmp_path, capsys):
    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        files=[
            {"path": "SKILL.md", "encoding": "utf8", "content": "---\nname: packed\n---\n"},
            {"path": "a.txt", "encoding": "utf8", "content": "one"},
            {"path": "a.txt", "encoding": "utf8", "content": "two"},
        ],
    )

    with pytest.raises(SystemExit):
        _import(tmp_path / "p.skillpack", json_mode=True)
    errors = _json_out(capsys)["errors"]
    assert any("Duplicate file path: a.txt" in e for e in errors)
    assert not any("Colliding file path" in e for e in errors)


# ─────────────────────────────────────────────────────────────────────────────
# import — post-write failure modes
# ─────────────────────────────────────────────────────────────────────────────


def test_import_affinity_failure_leaves_no_orphan_dest_dir(
    tmp_data_home, tmp_path, monkeypatch
):
    """Harness affinity is resolved BEFORE the first write, so nothing strands."""
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack", skill={"harnesses": ["claude-code"]})
    hub.load_registry()  # let the schema migrations settle first
    before = hub._registry_sha()

    def boom(values, context):
        raise RuntimeError("affinity exploded")

    monkeypatch.setattr(hub, "_validate_harness_affinity", boom)

    with pytest.raises(RuntimeError):
        _import(tmp_path / "p.skillpack")

    assert not (hub.hub_skills_dir() / "packed").exists()
    assert "packed" not in hub.load_registry().get("skills", {})
    assert hub._registry_sha() == before


def test_import_dangling_symlink_at_dest_is_a_clean_collision(
    tmp_data_home, tmp_path, capsys
):
    """`exists()` is False for a broken link — `lexists()` keeps the error honest."""
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack")
    hub.hub_skills_dir().mkdir(parents=True, exist_ok=True)
    dangling = hub.hub_skills_dir() / "packed"
    dangling.symlink_to(tmp_path / "gone-away")
    assert not dangling.exists() and dangling.is_symlink()

    with pytest.raises(SystemExit) as exc:
        _import(tmp_path / "p.skillpack", json_mode=True)

    assert exc.value.code == 1
    error = _json_out(capsys)["error"]
    assert "already exists" in error
    assert "File exists" not in error  # not a raw EEXIST leak
    assert dangling.is_symlink()  # the stray link is left for the user to clear
    assert "packed" not in hub.load_registry().get("skills", {})


def test_import_stamps_invocation_frontmatter_bytes_user_only(tmp_data_home, tmp_path):
    """F9: pin the exact imported SKILL.md bytes for `user-only`."""
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack", skill={"invocation": "user-only"})

    _import(tmp_path / "p.skillpack")

    text = (hub.hub_skills_dir() / "packed" / "SKILL.md").read_text()
    assert text == "---\nname: packed\ndisable-model-invocation: true\n---\n"


def test_import_stamps_invocation_frontmatter_bytes_model_only(tmp_data_home, tmp_path):
    """F9: pin the exact imported SKILL.md bytes for `model-only`."""
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack", skill={"invocation": "model-only"})

    _import(tmp_path / "p.skillpack")

    text = (hub.hub_skills_dir() / "packed" / "SKILL.md").read_text()
    assert text == "---\nname: packed\nuser-invocable: false\n---\n"


def test_import_auto_invocation_skips_rewrite_when_already_bare(tmp_data_home, tmp_path):
    """F3/F9: a declared `auto` already matches the pack's flag-free
    frontmatter, so the rewrite is skipped — the imported SKILL.md is
    byte-identical to the pack's own, not a stripped-and-reinserted copy."""
    import hub

    _seed_registry()
    _write_pack(tmp_path / "p.skillpack", skill={"invocation": "auto"})

    _import(tmp_path / "p.skillpack")

    text = (hub.hub_skills_dir() / "packed" / "SKILL.md").read_text()
    assert text == "---\nname: packed\n---\n"


def test_import_already_flagged_pack_is_byte_stable(tmp_data_home, tmp_path):
    """F3/F9: re-importing a pack whose SKILL.md already carries the declared
    invocation flag must not touch it — the rewrite is skipped (not a
    strip-then-reinsert round trip that could shuffle byte order)."""
    import hub

    _seed_registry()
    content = "---\nname: packed\ndisable-model-invocation: true\n---\n"
    _write_pack(
        tmp_path / "p.skillpack",
        skill={"invocation": "user-only"},
        files=[{"path": "SKILL.md", "encoding": "utf8", "content": content}],
    )

    _import(tmp_path / "p.skillpack")

    text = (hub.hub_skills_dir() / "packed" / "SKILL.md").read_text()
    assert text == content


def test_import_invocation_mode_mismatch_still_rewrites(tmp_data_home, tmp_path):
    """F3 sanity check: the skip is scoped to a MATCHING mode — a pack that
    declares `user-only` but ships a `model-only`-flagged SKILL.md still gets
    rewritten to the declared mode."""
    import hub

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        skill={"invocation": "user-only"},
        files=[
            {
                "path": "SKILL.md",
                "encoding": "utf8",
                "content": "---\nname: packed\nuser-invocable: false\n---\n",
            }
        ],
    )

    _import(tmp_path / "p.skillpack")

    text = (hub.hub_skills_dir() / "packed" / "SKILL.md").read_text()
    assert text == "---\nname: packed\ndisable-model-invocation: true\n---\n"


def test_import_invocation_with_unreadable_frontmatter_warns_not_aborts(
    tmp_data_home, tmp_path, capsys, monkeypatch
):
    """F2: `validate_skill_pack` only ever validates the envelope keys, never
    SKILL.md content — the pre-existing `_skillpack_frontmatter_errors` check
    happens to also catch a fenceless SKILL.md today, so this bypasses it (the
    same way a future relaxation of that check could) to prove the invocation
    stamp is independently defensive: a SKILL.md the stamp cannot parse must
    degrade to a printed warning, never abort an otherwise-valid import."""
    import hub
    import skill_hub.entrypoints.cli.skill as skill_mod

    monkeypatch.setattr(skill_mod, "_skillpack_frontmatter_errors", lambda *a, **k: [])

    _seed_registry()
    _write_pack(
        tmp_path / "p.skillpack",
        skill={"invocation": "user-only"},
        files=[{"path": "SKILL.md", "encoding": "utf8", "content": "# no fence at all\n"}],
    )

    _import(tmp_path / "p.skillpack")

    entry = hub.load_registry()["skills"]["packed"]
    assert entry["invocation"] == "user-only"
    text = (hub.hub_skills_dir() / "packed" / "SKILL.md").read_text()
    assert text == "# no fence at all\n"  # left untouched, not corrupted
    err = capsys.readouterr().err
    assert "could not stamp invocation" in err
