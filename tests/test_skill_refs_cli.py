"""CLI contract tests for skill cross-references: `hub skill refs`,
`hub set-meta --refs-ignore`, `hub enable --with-refs`, and the `hub bundle
apply` / `hub enable` equip-time hint.

Every mutating command here (`enable`, `bundle apply`) runs the post-mutation
auto-sync, which writes into `$HOME/.claude` / `$HOME/.codex` / `$HOME/.agents`.
`_run` therefore ALWAYS sandboxes `HOME`/`USERPROFILE` to a throwaway tmp dir
and unsets `CODEX_HOME` — the real dotfiles are never touched, even by the
read-only `skill refs` / `set-meta` tests (uniform default, no exceptions).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import hub

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _write_skill(root: Path, name: str, body: str = "") -> Path:
    """Create a minimal skill dir at `root` and return it."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(f"---\nname: {name}\ndescription: t\n---\n{body}")
    return root


def _skill_cfg(data_home: Path, name: str, scope: str = "portable", extra=None) -> dict:
    cfg = {
        "version": "1.0.0",
        "description": "",
        "source": str(data_home / "skills" / name),
        "type": "claude-skill",
        "scope": scope,
        "upstream": None,
    }
    if extra:
        cfg.update(extra)
    return cfg


def _seed_registry(
    data_home: Path,
    skills: dict,
    projects: dict | None = None,
    bundles: dict | None = None,
) -> None:
    registry = {
        "version": "1",
        "skills": skills,
        "projects": projects or {},
        "bundles": bundles or {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _run(data_home: Path, home_dir: Path, args: list[str], cwd: Path | None = None):
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(data_home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    # HARD SAFETY RULE: `enable` / `bundle apply` auto-sync into $HOME's native
    # config files — never let that be the real $HOME.
    env["HOME"] = str(home_dir)
    env["USERPROFILE"] = str(home_dir)
    env.pop("CODEX_HOME", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(cwd or REPO_ROOT),
    )


@pytest.fixture
def cli_env(tmp_path):
    data_home = tmp_path / "data-home"
    data_home.mkdir()
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    return data_home, home_dir


# ─────────────────────────────────────────────────────────────────────────────
# `hub skill refs`
# ─────────────────────────────────────────────────────────────────────────────


def test_refs_graph_json_shape(cli_env):
    data_home, home_dir = cli_env
    _write_skill(data_home / "skills" / "a", "a", "See `b` for details.\n")
    _write_skill(data_home / "skills" / "b", "b")
    _seed_registry(
        data_home,
        {"a": _skill_cfg(data_home, "a"), "b": _skill_cfg(data_home, "b")},
    )

    proc = _run(data_home, home_dir, ["skill", "refs", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert set(payload.keys()) == {"edges"}
    assert payload["edges"] == [{"from": "a", "to": "b", "count": 1}]
    for edge in payload["edges"]:
        assert set(edge.keys()) == {"from", "to", "count"}


def test_refs_skill_json_shape(cli_env):
    data_home, home_dir = cli_env
    _write_skill(data_home / "skills" / "a", "a", "See `b` for details.\n")
    _write_skill(data_home / "skills" / "b", "b")
    _write_skill(data_home / "skills" / "c", "c", "Mentions `a` here and `a` again.\n")
    _seed_registry(
        data_home,
        {
            "a": _skill_cfg(data_home, "a"),
            "b": _skill_cfg(data_home, "b"),
            "c": _skill_cfg(data_home, "c"),
        },
    )

    proc = _run(data_home, home_dir, ["skill", "refs", "a", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert set(payload.keys()) == {"skill", "refs", "referenced_by", "ignored"}
    assert payload["skill"] == "a"
    assert payload["refs"] == [{"name": "b", "count": 1}]
    assert payload["referenced_by"] == [{"name": "c", "count": 2}]
    assert payload["ignored"] == []


def test_set_meta_classification_parser_normalizes_and_clears(tmp_data_home, monkeypatch):
    skill_dir = tmp_data_home / "skills" / "a"
    _write_skill(skill_dir, "a")
    _seed_registry(tmp_data_home, {"a": _skill_cfg(tmp_data_home, "a")})
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "hub",
            "set-meta",
            "a",
            "--classes-json",
            '[" Process ", "process", "PROCESS", "release, coordination", ""]',
            "--outputs-json",
            '["Plan", "plan"]',
            "--working-mode",
            "mixed",
            "--interaction-style",
            "checkpointed",
            "--maturity",
            "confident",
        ],
    )
    hub.main()
    cfg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["skills"]["a"]
    assert cfg["classification"] == {
        "classes": ["Process", "release, coordination"],
        "outputs": ["Plan"],
        "working_mode": "mixed",
        "interaction_style": "checkpointed",
        "maturity": "confident",
    }

    monkeypatch.setattr(sys, "argv", ["hub", "set-meta", "a", "--working-mode="])
    hub.main()
    cfg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["skills"]["a"]
    assert "working_mode" not in cfg["classification"]


@pytest.mark.parametrize(
    ("flag", "value"),
    [
        ("--classes-json", "[broken"),
        ("--classes-json", "[1]"),
        ("--outputs-json", '["ok", 2]'),
        ("--working-mode", "invalid"),
        ("--interaction-style", "invalid"),
        ("--maturity", "invalid"),
    ],
)
def test_set_meta_invalid_classification_preflights_before_invocation_write(
    tmp_data_home, monkeypatch, flag, value
):
    skill_dir = tmp_data_home / "skills" / "a"
    _write_skill(skill_dir, "a")
    skill_md = skill_dir / "SKILL.md"
    _seed_registry(tmp_data_home, {"a": _skill_cfg(tmp_data_home, "a")})
    before_registry = (tmp_data_home / "registry.yaml").read_bytes()
    before_skill = skill_md.read_bytes()
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "hub",
            "set-meta",
            "a",
            "--invocation",
            "user-only",
            flag,
            value,
        ],
    )
    with pytest.raises(SystemExit):
        hub.main()
    assert (tmp_data_home / "registry.yaml").read_bytes() == before_registry
    assert skill_md.read_bytes() == before_skill


@pytest.mark.parametrize(
    ("flag", "value", "remaining"),
    [
        (
            "--classes-json",
            "[]",
            {
                "outputs": ["plan"], "working_mode": "mixed",
                "interaction_style": "checkpointed", "maturity": "confident",
            },
        ),
        (
            "--outputs-json",
            "[]",
            {
                "classes": ["process"], "working_mode": "mixed",
                "interaction_style": "checkpointed", "maturity": "confident",
            },
        ),
        (
            "--working-mode",
            "",
            {"classes": ["process"], "outputs": ["plan"], "interaction_style": "checkpointed", "maturity": "confident"},
        ),
        (
            "--interaction-style",
            "",
            {"classes": ["process"], "outputs": ["plan"], "working_mode": "mixed", "maturity": "confident"},
        ),
        (
            "--maturity",
            "",
            {"classes": ["process"], "outputs": ["plan"], "working_mode": "mixed", "interaction_style": "checkpointed"},
        ),
    ],
)
def test_set_meta_classification_fields_clear_independently(
    tmp_data_home, monkeypatch, flag, value, remaining
):
    _write_skill(tmp_data_home / "skills" / "a", "a")
    _seed_registry(
        tmp_data_home,
        {
            "a": _skill_cfg(
                tmp_data_home,
                "a",
                extra={
                    "classification": {
                        "classes": ["process"],
                        "outputs": ["plan"],
                        "working_mode": "mixed",
                        "interaction_style": "checkpointed",
                        "maturity": "confident",
                    }
                },
            )
        },
    )
    monkeypatch.setattr(sys, "argv", ["hub", "set-meta", "a", flag, value])
    hub.main()
    cfg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["skills"]["a"]
    assert cfg["classification"] == remaining


def test_set_meta_classification_clears_last_field_and_parent(
    tmp_data_home, monkeypatch
):
    _write_skill(tmp_data_home / "skills" / "a", "a")
    _seed_registry(
        tmp_data_home,
        {
            "a": _skill_cfg(
                tmp_data_home,
                "a",
                extra={"classification": {"classes": ["process"]}},
            )
        },
    )
    monkeypatch.setattr(sys, "argv", ["hub", "set-meta", "a", "--classes-json", "[]"])
    hub.main()
    cfg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["skills"]["a"]
    assert "classification" not in cfg


def test_set_meta_classifies_external_and_starter_without_touching_source(
    tmp_data_home, monkeypatch
):
    external = tmp_data_home.parent / "external" / "ext"
    starter_root = tmp_data_home.parent / "code" / "skills" / "starter"
    external_md = _write_skill(external, "external") / "SKILL.md"
    starter_md = _write_skill(starter_root, "starter") / "SKILL.md"
    monkeypatch.setenv("SKILL_HUB_CODE", str(starter_root.parent.parent))
    _seed_registry(
        tmp_data_home,
        {
            "external": _skill_cfg(
                tmp_data_home,
                "external",
                extra={"source": str(external), "managed": "external"},
            ),
            "starter": _skill_cfg(
                tmp_data_home, "starter", extra={"source": str(starter_root)}
            ),
        },
    )
    for name, source_md in (("external", external_md), ("starter", starter_md)):
        before = source_md.read_bytes()
        monkeypatch.setattr(
            sys,
            "argv",
            ["hub", "set-meta", name, "--classes-json", '["managed"]'],
        )
        hub.main()
        assert source_md.read_bytes() == before
        cfg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["skills"][name]
        assert cfg["classification"] == {"classes": ["managed"]}
        monkeypatch.setattr(
            sys, "argv", ["hub", "set-meta", name, "--invocation", "user-only"]
        )
        with pytest.raises(SystemExit):
            hub.main()
        assert source_md.read_bytes() == before


def test_refs_reports_ignored_separately(cli_env):
    data_home, home_dir = cli_env
    _write_skill(data_home / "skills" / "a", "a", "See `b` for details.\n")
    _write_skill(data_home / "skills" / "b", "b")
    _seed_registry(
        data_home,
        {
            "a": _skill_cfg(data_home, "a", extra={"refs_ignore": ["b"]}),
            "b": _skill_cfg(data_home, "b"),
        },
    )

    proc = _run(data_home, home_dir, ["skill", "refs", "a", "--json"])
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["refs"] == []
    assert payload["ignored"] == ["b"]


def test_refs_unknown_skill_exits_1(cli_env):
    data_home, home_dir = cli_env
    _seed_registry(data_home, {})

    proc = _run(data_home, home_dir, ["skill", "refs", "ghost"])
    assert proc.returncode == 1
    # `fail()` (hub_core) prints on stdout, not stderr — asserted against the
    # real implementation, not the informal "stderr" phrasing in 1-backend.md.
    assert "Unknown skill 'ghost'" in proc.stdout
    assert "{" not in proc.stdout  # no half JSON


def test_refs_table_output_is_stable(cli_env):
    data_home, home_dir = cli_env
    _write_skill(data_home / "skills" / "a", "a", "See `b` for details.\n")
    _write_skill(data_home / "skills" / "b", "b")
    _seed_registry(
        data_home,
        {"a": _skill_cfg(data_home, "a"), "b": _skill_cfg(data_home, "b")},
    )

    proc = _run(data_home, home_dir, ["skill", "refs", "a"])
    assert proc.returncode == 0, proc.stderr
    assert "MENTIONS" in proc.stdout
    assert "MENTIONED BY" in proc.stdout
    assert "IGNORED" in proc.stdout
    assert "(none)" in proc.stdout  # MENTIONED BY / IGNORED are both empty

    proc2 = _run(data_home, home_dir, ["skill", "refs"])
    assert proc2.returncode == 0, proc2.stderr
    assert "1 edges across 2 skills." in proc2.stdout


# ─────────────────────────────────────────────────────────────────────────────
# `hub set-meta --refs-ignore`
# ─────────────────────────────────────────────────────────────────────────────


def test_set_meta_refs_ignore_round_trip(cli_env):
    data_home, home_dir = cli_env
    _write_skill(data_home / "skills" / "a", "a")
    _seed_registry(data_home, {"a": _skill_cfg(data_home, "a")})

    proc = _run(data_home, home_dir, ["set-meta", "a", "--refs-ignore", "b,a"])
    assert proc.returncode == 0, proc.stderr
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    assert reg["skills"]["a"]["refs_ignore"] == ["a", "b"]

    proc2 = _run(data_home, home_dir, ["set-meta", "a", "--refs-ignore", ""])
    assert proc2.returncode == 0, proc2.stderr
    reg2 = yaml.safe_load((data_home / "registry.yaml").read_text())
    assert "refs_ignore" not in reg2["skills"]["a"]

    proc3 = _run(data_home, home_dir, ["set-meta", "a", "--refs-ignore", "Not_A_Slug!"])
    assert proc3.returncode != 0
    reg3 = yaml.safe_load((data_home / "registry.yaml").read_text())
    assert "refs_ignore" not in reg3["skills"]["a"]


# ─────────────────────────────────────────────────────────────────────────────
# `hub enable [--with-refs]` / `hub bundle apply`
# ─────────────────────────────────────────────────────────────────────────────


def test_enable_prints_missing_ref_hint(cli_env, tmp_path):
    data_home, home_dir = cli_env
    proj_path = tmp_path / "proj"
    proj_path.mkdir()

    _write_skill(data_home / "skills" / "a", "a", "See `b` for details.\n")
    _write_skill(data_home / "skills" / "b", "b")
    _seed_registry(
        data_home,
        {"a": _skill_cfg(data_home, "a"), "b": _skill_cfg(data_home, "b")},
        projects={
            "p": {"path": str(proj_path), "enabled": [], "bundles": [], "harnesses": []}
        },
    )

    proc = _run(data_home, home_dir, ["enable", "a", "--project", "p"])
    assert proc.returncode == 0, proc.stderr
    assert "references b" in proc.stdout
    assert "hub enable a --project p --with-refs" in proc.stdout

    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    assert reg["projects"]["p"]["enabled"] == ["a"]


def test_enable_with_refs_equips_one_level(cli_env, tmp_path):
    data_home, home_dir = cli_env
    proj_path = tmp_path / "proj"
    proj_path.mkdir()

    _write_skill(data_home / "skills" / "a", "a", "See `b` for details.\n")
    _write_skill(data_home / "skills" / "b", "b", "See `c` for details.\n")
    _write_skill(data_home / "skills" / "c", "c")
    _seed_registry(
        data_home,
        {
            "a": _skill_cfg(data_home, "a"),
            "b": _skill_cfg(data_home, "b"),
            "c": _skill_cfg(data_home, "c"),
        },
        projects={
            "p": {"path": str(proj_path), "enabled": [], "bundles": [], "harnesses": []}
        },
    )

    proc = _run(data_home, home_dir, ["enable", "a", "--project", "p", "--with-refs"])
    assert proc.returncode == 0, proc.stderr
    assert "+ b" in proc.stdout

    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    enabled = reg["projects"]["p"]["enabled"]
    assert set(enabled) == {"a", "b"}
    assert "c" not in enabled  # one level only — b's own ref is not pulled in


def test_enable_with_refs_on_already_enabled_skill(cli_env, tmp_path):
    data_home, home_dir = cli_env
    proj_path = tmp_path / "proj"
    proj_path.mkdir()

    _write_skill(data_home / "skills" / "a", "a", "See `b` for details.\n")
    _write_skill(data_home / "skills" / "b", "b")
    _seed_registry(
        data_home,
        {"a": _skill_cfg(data_home, "a"), "b": _skill_cfg(data_home, "b")},
        projects={
            "p": {
                "path": str(proj_path),
                "enabled": ["a"],
                "bundles": [],
                "harnesses": [],
            }
        },
    )

    proc = _run(data_home, home_dir, ["enable", "a", "--project", "p", "--with-refs"])
    assert proc.returncode == 0, proc.stderr
    assert "already enabled" in proc.stdout
    assert "+ b" in proc.stdout

    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    enabled = reg["projects"]["p"]["enabled"]
    assert set(enabled) == {"a", "b"}


def test_bundle_apply_prints_one_with_refs_line_per_flagged_skill(cli_env, tmp_path):
    data_home, home_dir = cli_env
    proj_path = tmp_path / "proj"
    proj_path.mkdir()

    _write_skill(data_home / "skills" / "x", "x", "See `m1` for details.\n")
    _write_skill(data_home / "skills" / "y", "y", "See `m2` for details.\n")
    _write_skill(data_home / "skills" / "m1", "m1")
    _write_skill(data_home / "skills" / "m2", "m2")
    _seed_registry(
        data_home,
        {
            "x": _skill_cfg(data_home, "x"),
            "y": _skill_cfg(data_home, "y"),
            "m1": _skill_cfg(data_home, "m1"),
            "m2": _skill_cfg(data_home, "m2"),
        },
        projects={
            "p": {"path": str(proj_path), "enabled": [], "bundles": [], "harnesses": []}
        },
        bundles={"pack": {"description": "", "skills": ["x", "y"]}},
    )

    proc = _run(data_home, home_dir, ["bundle", "apply", "pack", "--project", "p"])
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.count("--with-refs") == 2
    assert "hub enable x --project p --with-refs" in proc.stdout
    assert "hub enable y --project p --with-refs" in proc.stdout


def test_enable_survives_doctor_danger_exit(cli_env, tmp_path):
    data_home, home_dir = cli_env
    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    # Make claude-code look "installed" (DotDirWithMarker: ~/.claude/projects)
    # so the global permissions/doctor pass actually runs against it.
    (home_dir / ".claude" / "projects").mkdir(parents=True)

    _write_skill(data_home / "skills" / "a", "a")
    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        # An unbounded Bash allow is a doctor DANGER finding (test_sync_report.py
        # uses the same fixture pattern for `test_report_written_on_permission_error_exit`).
        "permissions_global": {"allow": [{"pattern": "Bash(*)", "kind": "allow"}]},
        "skills": {"a": _skill_cfg(data_home, "a")},
        "projects": {
            "p": {"path": str(proj_path), "enabled": [], "bundles": [], "harnesses": []}
        },
        "bundles": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    proc = _run(data_home, home_dir, ["enable", "a", "--project", "p"])
    assert proc.returncode == 0, proc.stderr
    assert "auto-sync exited with rc 2" in proc.stderr

    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    assert reg["projects"]["p"]["enabled"] == ["a"]
