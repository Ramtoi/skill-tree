"""Tests for the skill invocation axis (openspec change: skill-invocation-axis).

Covers:
- frontmatter → registry mirroring (auto / user-only / model-only / conflicted)
- `hub set-meta --invocation` minimal frontmatter rewriting + refusals
- `hub project invocation` overrides (set / inherit / gating / stale handling)
- variant-directory sync mechanics (patching, sharing, elision, idempotency,
  orphan cleanup, ownership preservation)
"""

from __future__ import annotations

import argparse
import dataclasses
import os
from pathlib import Path

import pytest
import yaml


BODY = "\n# Brainstorm\n\nDo the thing.\n"


def _seed_skill(data_home: Path, name: str, fm_extra: list[str] | None = None) -> Path:
    src = data_home / "skills" / name
    src.mkdir(parents=True, exist_ok=True)
    fm = ["---", f"name: {name}", "description: t"] + (fm_extra or []) + ["---"]
    (src / "SKILL.md").write_text("\n".join(fm) + BODY)
    (src / "helper.txt").write_text("resource\n")
    return src


def _write_registry(data_home: Path, skills: dict, projects: dict) -> None:
    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": skills,
        "projects": projects,
        "bundles": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _skill_cfg(src: Path, scope: str = "portable", **extra) -> dict:
    cfg = {
        "version": "1.0.0",
        "description": "",
        "source": str(src),
        "type": "claude-skill",
        "scope": scope,
        "upstream": None,
    }
    cfg.update(extra)
    return cfg


def _project_cfg(path: Path, enabled: list[str], **extra) -> dict:
    cfg = {"path": str(path), "enabled": enabled, "bundles": [], "harnesses": []}
    cfg.update(extra)
    return cfg


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _set_meta_args(name: str, **kw) -> argparse.Namespace:
    base = dict(
        name=name,
        version=None,
        description=None,
        scope=None,
        upstream=None,
        harnesses=None,
        invocation=None,
    )
    base.update(kw)
    return argparse.Namespace(**base)


@pytest.fixture
def claude_only_env(tmp_data_home, monkeypatch):
    """Claude-code detected as installed; its global dir pointed into tmp."""
    import harnesses

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


# ─────────────────────────────────────────────────────────────────────────────
# invocation_from_frontmatter / render_invocation_frontmatter (unit)
# ─────────────────────────────────────────────────────────────────────────────


def test_invocation_from_frontmatter_modes():
    import hub

    assert hub.invocation_from_frontmatter({}) == "auto"
    assert hub.invocation_from_frontmatter({"disable-model-invocation": True}) == "user-only"
    assert hub.invocation_from_frontmatter({"user-invocable": False}) == "model-only"
    assert (
        hub.invocation_from_frontmatter(
            {"disable-model-invocation": True, "user-invocable": False}
        )
        == "conflicted"
    )
    # Explicit non-restrictive values are auto.
    assert (
        hub.invocation_from_frontmatter(
            {"disable-model-invocation": False, "user-invocable": True}
        )
        == "auto"
    )


def test_render_refuses_broken_frontmatter():
    import hub

    assert hub.render_invocation_frontmatter("no frontmatter at all", "user-only") is None
    assert hub.render_invocation_frontmatter("---\nname: x\n", "user-only") is None
    assert hub.render_invocation_frontmatter("---\nname: x\n---\n", "bogus") is None


# ─────────────────────────────────────────────────────────────────────────────
# Frontmatter → registry mirroring at sync
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_mirrors_invocation_modes(tmp_data_home):
    import hub

    src_a = _seed_skill(tmp_data_home, "alpha", ["disable-model-invocation: true"])
    src_b = _seed_skill(tmp_data_home, "beta", ["user-invocable: false"])
    src_c = _seed_skill(tmp_data_home, "gamma")
    _write_registry(
        tmp_data_home,
        {
            "alpha": _skill_cfg(src_a),
            "beta": _skill_cfg(src_b),
            "gamma": _skill_cfg(src_c, invocation="user-only"),  # stale mirror
        },
        {},
    )
    registry = hub.load_registry()
    changed = hub.sync_skill_frontmatter_metadata(registry)
    assert changed
    assert registry["skills"]["alpha"]["invocation"] == "user-only"
    assert registry["skills"]["beta"]["invocation"] == "model-only"
    # auto = key removed (stale mirror reconciled)
    assert "invocation" not in registry["skills"]["gamma"]


def test_sync_flags_conflicted_frontmatter(tmp_data_home, capsys):
    import hub

    src = _seed_skill(
        tmp_data_home,
        "alpha",
        ["disable-model-invocation: true", "user-invocable: false"],
    )
    _write_registry(tmp_data_home, {"alpha": _skill_cfg(src)}, {})
    registry = hub.load_registry()
    hub.sync_skill_frontmatter_metadata(registry)
    assert registry["skills"]["alpha"]["invocation"] == "conflicted"
    err = capsys.readouterr().err
    assert "BOTH" in err and "alpha" in err


# ─────────────────────────────────────────────────────────────────────────────
# hub set-meta --invocation
# ─────────────────────────────────────────────────────────────────────────────


def test_set_meta_user_only_is_byte_minimal(tmp_data_home, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    src = _seed_skill(tmp_data_home, "alpha")
    _write_registry(tmp_data_home, {"alpha": _skill_cfg(src)}, {})
    before = (src / "SKILL.md").read_text()

    hub.cmd_set_meta(_set_meta_args("alpha", invocation="user-only"))
    capsys.readouterr()

    after = (src / "SKILL.md").read_text()
    added = [ln for ln in after.splitlines() if ln not in before.splitlines()]
    assert added == ["disable-model-invocation: true"]
    # Everything else byte-identical.
    assert after.replace("disable-model-invocation: true\n", "") == before
    assert _read_registry(tmp_data_home)["skills"]["alpha"]["invocation"] == "user-only"


def test_set_meta_auto_repairs_conflicted(tmp_data_home, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    src = _seed_skill(
        tmp_data_home,
        "alpha",
        ["disable-model-invocation: true", "user-invocable: false"],
    )
    _write_registry(
        tmp_data_home, {"alpha": _skill_cfg(src, invocation="conflicted")}, {}
    )
    hub.cmd_set_meta(_set_meta_args("alpha", invocation="auto"))
    capsys.readouterr()

    text = (src / "SKILL.md").read_text()
    assert "disable-model-invocation" not in text
    assert "user-invocable" not in text
    assert "invocation" not in _read_registry(tmp_data_home)["skills"]["alpha"]


def test_set_meta_round_trip_restores_original(tmp_data_home, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    src = _seed_skill(tmp_data_home, "alpha")
    _write_registry(tmp_data_home, {"alpha": _skill_cfg(src)}, {})
    before = (src / "SKILL.md").read_text()

    hub.cmd_set_meta(_set_meta_args("alpha", invocation="model-only"))
    hub.cmd_set_meta(_set_meta_args("alpha", invocation="auto"))
    capsys.readouterr()
    assert (src / "SKILL.md").read_text() == before


@pytest.mark.parametrize(
    "cfg_extra, message_part",
    [
        ({"managed": "external", "origin": {"source": "org"}}, "external"),
        ({"managed": "starter"}, "read-only"),
        ({"type": "mcp-server"}, "claude-skills only"),
    ],
)
def test_set_meta_refusals(tmp_data_home, monkeypatch, capsys, cfg_extra, message_part):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    src = _seed_skill(tmp_data_home, "alpha")
    cfg = _skill_cfg(src)
    cfg.update(cfg_extra)
    _write_registry(tmp_data_home, {"alpha": cfg}, {})
    before = (src / "SKILL.md").read_text()

    with pytest.raises(SystemExit):
        hub.cmd_set_meta(_set_meta_args("alpha", invocation="user-only"))
    assert message_part in capsys.readouterr().out
    assert (src / "SKILL.md").read_text() == before
    assert "invocation" not in _read_registry(tmp_data_home)["skills"]["alpha"]


def test_set_meta_refuses_unparseable_frontmatter(tmp_data_home, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    src = _seed_skill(tmp_data_home, "alpha")
    (src / "SKILL.md").write_text("just a body, no fence\n")
    _write_registry(tmp_data_home, {"alpha": _skill_cfg(src)}, {})

    with pytest.raises(SystemExit):
        hub.cmd_set_meta(_set_meta_args("alpha", invocation="user-only"))
    assert "unparseable" in capsys.readouterr().out
    assert (src / "SKILL.md").read_text() == "just a body, no fence\n"


def test_set_meta_scope_global_warns_about_live_overrides(
    tmp_data_home, monkeypatch, capsys
):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    src = _seed_skill(tmp_data_home, "alpha")
    proj = tmp_data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        tmp_data_home,
        {"alpha": _skill_cfg(src)},
        {"p1": _project_cfg(proj, ["alpha"], invocation_overrides={"alpha": "user-only"})},
    )
    hub.cmd_set_meta(_set_meta_args("alpha", scope="global"))
    err = capsys.readouterr().err
    assert "inert" in err and "p1" in err
    # Override preserved, never silently deleted.
    reg = _read_registry(tmp_data_home)
    assert reg["projects"]["p1"]["invocation_overrides"] == {"alpha": "user-only"}


# ─────────────────────────────────────────────────────────────────────────────
# hub project invocation (overrides CLI)
# ─────────────────────────────────────────────────────────────────────────────


def _inv_args(name: str, **kw) -> argparse.Namespace:
    base = dict(name=name, skill=None, mode=None, json=False)
    base.update(kw)
    return argparse.Namespace(**base)


def _seed_project_env(tmp_data_home, scope="portable", enabled=True):
    src = _seed_skill(tmp_data_home, "alpha")
    proj = tmp_data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        tmp_data_home,
        {"alpha": _skill_cfg(src, scope=scope)},
        {"p1": _project_cfg(proj, ["alpha"] if enabled else [])},
    )
    return src, proj


def test_override_set_and_inherit(tmp_data_home, monkeypatch, capsys):
    import hub

    calls = []
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.append(1))
    _seed_project_env(tmp_data_home)

    hub.cmd_project_invocation(_inv_args("p1", skill="alpha", mode="user-only"))
    reg = _read_registry(tmp_data_home)
    assert reg["projects"]["p1"]["invocation_overrides"] == {"alpha": "user-only"}
    assert calls == [1]

    hub.cmd_project_invocation(_inv_args("p1", skill="alpha", mode="inherit"))
    reg = _read_registry(tmp_data_home)
    assert "invocation_overrides" not in reg["projects"]["p1"]
    assert calls == [1, 1]
    capsys.readouterr()


def test_override_rejects_global_scope(tmp_data_home, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    _seed_project_env(tmp_data_home, scope="global")

    with pytest.raises(SystemExit):
        hub.cmd_project_invocation(_inv_args("p1", skill="alpha", mode="user-only"))
    out = capsys.readouterr().out
    assert "precedence" in out
    assert "invocation_overrides" not in _read_registry(tmp_data_home)["projects"]["p1"]


def test_override_accepts_inactive_skill_with_warning(tmp_data_home, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    _seed_project_env(tmp_data_home, enabled=False)

    hub.cmd_project_invocation(_inv_args("p1", skill="alpha", mode="user-only"))
    captured = capsys.readouterr()
    assert "inert" in captured.err
    reg = _read_registry(tmp_data_home)
    assert reg["projects"]["p1"]["invocation_overrides"] == {"alpha": "user-only"}


def test_override_show_json(tmp_data_home, monkeypatch, capsys):
    import hub
    import json as _json

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    _seed_project_env(tmp_data_home)
    hub.cmd_project_invocation(_inv_args("p1", skill="alpha", mode="model-only"))
    capsys.readouterr()

    hub.cmd_project_invocation(_inv_args("p1", json=True))
    payload = _json.loads(capsys.readouterr().out)
    assert payload["project"] == "p1"
    row = next(r for r in payload["skills"] if r["skill"] == "alpha")
    assert row["library"] == "auto"
    assert row["override"] == "model-only"
    assert row["effective"] == "model-only"
    assert payload["stale_overrides"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Variant sync mechanics
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_links_overridden_skill_to_patched_variant(claude_only_env, capsys):
    import hub

    data_home = claude_only_env
    src, proj = _seed_project_env(data_home)
    reg = _read_registry(data_home)
    reg["projects"]["p1"]["invocation_overrides"] = {"alpha": "user-only"}
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    _sync()
    capsys.readouterr()

    link = proj / ".claude" / "skills" / "alpha"
    assert link.is_symlink()
    target = os.readlink(link)
    expected_variant = (
        data_home / "state" / "skill_variants" / "alpha@user-only"
    ).resolve()
    assert Path(target).resolve() == expected_variant
    # Ownership: readlink target stays under data_home.
    assert str(expected_variant).startswith(str(data_home))

    patched = (expected_variant / "SKILL.md").read_text()
    assert "disable-model-invocation: true" in patched
    assert hub.VARIANT_MARKER_COMMENT in patched
    assert patched.endswith(BODY)
    # Non-SKILL.md entries are symlinks back to the library.
    helper = expected_variant / "helper.txt"
    assert helper.is_symlink()
    assert Path(os.readlink(helper)).resolve() == (src / "helper.txt").resolve()


def test_variant_shared_across_projects(claude_only_env, capsys):
    data_home = claude_only_env
    src = _seed_skill(data_home, "alpha")
    p1 = data_home / "projects" / "p1"
    p2 = data_home / "projects" / "p2"
    p1.mkdir(parents=True)
    p2.mkdir(parents=True)
    _write_registry(
        data_home,
        {"alpha": _skill_cfg(src)},
        {
            "p1": _project_cfg(p1, ["alpha"], invocation_overrides={"alpha": "user-only"}),
            "p2": _project_cfg(p2, ["alpha"], invocation_overrides={"alpha": "user-only"}),
        },
    )
    _sync()
    capsys.readouterr()

    variant = data_home / "state" / "skill_variants" / "alpha@user-only"
    for proj in (p1, p2):
        link = proj / ".claude" / "skills" / "alpha"
        assert Path(os.readlink(link)).resolve() == variant.resolve()


def test_override_equal_to_library_mode_is_elided(claude_only_env, capsys):
    data_home = claude_only_env
    src = _seed_skill(data_home, "alpha", ["disable-model-invocation: true"])
    proj = data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        data_home,
        {"alpha": _skill_cfg(src)},
        {"p1": _project_cfg(proj, ["alpha"], invocation_overrides={"alpha": "user-only"})},
    )
    _sync()
    capsys.readouterr()

    link = proj / ".claude" / "skills" / "alpha"
    assert Path(os.readlink(link)).resolve() == src.resolve()  # straight to the library
    assert not (data_home / "state" / "skill_variants" / "alpha@user-only").exists()


def test_second_sync_is_write_free(claude_only_env, capsys):
    import json as _json

    data_home = claude_only_env
    src, proj = _seed_project_env(data_home)
    reg = _read_registry(data_home)
    reg["projects"]["p1"]["invocation_overrides"] = {"alpha": "user-only"}
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    _sync()
    variant_md = data_home / "state" / "skill_variants" / "alpha@user-only" / "SKILL.md"
    first_bytes = variant_md.read_text()

    _sync()
    capsys.readouterr()
    report = _json.loads((data_home / "state" / "sync-report.json").read_text())
    assert report["projects"]["p1"]["writes"] == 0
    assert report["projects"]["p1"]["removed"] == 0
    assert variant_md.read_text() == first_bytes


def test_orphaned_variant_cleaned_after_override_cleared(claude_only_env, capsys):
    data_home = claude_only_env
    src, proj = _seed_project_env(data_home)
    reg = _read_registry(data_home)
    reg["projects"]["p1"]["invocation_overrides"] = {"alpha": "user-only"}
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    _sync()
    variant = data_home / "state" / "skill_variants" / "alpha@user-only"
    assert variant.exists()

    reg = _read_registry(data_home)
    del reg["projects"]["p1"]["invocation_overrides"]
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    _sync()
    capsys.readouterr()

    assert not variant.exists()
    link = proj / ".claude" / "skills" / "alpha"
    assert Path(os.readlink(link)).resolve() == src.resolve()


def test_library_edits_propagate_into_variant(claude_only_env, capsys):
    data_home = claude_only_env
    src, proj = _seed_project_env(data_home)
    reg = _read_registry(data_home)
    reg["projects"]["p1"]["invocation_overrides"] = {"alpha": "user-only"}
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    _sync()

    text = (src / "SKILL.md").read_text()
    (src / "SKILL.md").write_text(text.replace("Do the thing.", "Do the NEW thing."))
    (src / "extra.md").write_text("more\n")
    _sync()
    capsys.readouterr()

    variant = data_home / "state" / "skill_variants" / "alpha@user-only"
    patched = (variant / "SKILL.md").read_text()
    assert "Do the NEW thing." in patched
    assert "disable-model-invocation: true" in patched
    assert (variant / "extra.md").is_symlink()


def test_stale_override_warned_and_preserved_at_sync(claude_only_env, capsys):
    data_home = claude_only_env
    src = _seed_skill(data_home, "alpha")
    proj = data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        data_home,
        {"alpha": _skill_cfg(src)},
        {"p1": _project_cfg(proj, [], invocation_overrides={"alpha": "user-only"})},
    )
    _sync()
    out = capsys.readouterr().out
    assert "inert" in out
    reg = _read_registry(data_home)
    assert reg["projects"]["p1"]["invocation_overrides"] == {"alpha": "user-only"}
    assert not (data_home / "state" / "skill_variants" / "alpha@user-only").exists()


def test_global_scope_override_falls_back_to_direct_link(claude_only_env, capsys):
    data_home = claude_only_env
    src = _seed_skill(data_home, "alpha")
    proj = data_home / "projects" / "p1"
    proj.mkdir(parents=True)
    _write_registry(
        data_home,
        {"alpha": _skill_cfg(src, scope="global")},
        # Hand-edited registry: an override the CLI would have rejected.
        {"p1": _project_cfg(proj, ["alpha"], invocation_overrides={"alpha": "user-only"})},
    )
    _sync()
    out = capsys.readouterr().out
    assert "inert" in out
    link = proj / ".claude" / "skills" / "alpha"
    assert Path(os.readlink(link)).resolve() == src.resolve()
    assert not (data_home / "state" / "skill_variants" / "alpha@user-only").exists()


def test_ensure_variant_falls_back_on_broken_frontmatter(tmp_data_home):
    import hub

    src = tmp_data_home / "skills" / "alpha"
    src.mkdir(parents=True)
    (src / "SKILL.md").write_text("no fence here\n")
    assert hub.ensure_skill_variant("alpha", src, "user-only") is None


def test_auto_sync_wiring_applies_override_end_to_end(claude_only_env, capsys):
    """cmd_project_invocation without monkeypatching: the auto-sync must leave
    the project symlink pointing at the variant."""
    import hub

    data_home = claude_only_env
    src, proj = _seed_project_env(data_home)
    hub.cmd_project_invocation(_inv_args("p1", skill="alpha", mode="user-only"))
    capsys.readouterr()

    link = proj / ".claude" / "skills" / "alpha"
    assert (
        Path(os.readlink(link)).resolve()
        == (data_home / "state" / "skill_variants" / "alpha@user-only").resolve()
    )


# ─────────────────────────────────────────────────────────────────────────────
# Hardening (post-review): strict booleans, OSError fallback, CLI rejects
# ─────────────────────────────────────────────────────────────────────────────


def test_non_boolean_frontmatter_values_do_not_flip_mode():
    import hub

    # Quoted strings are NOT booleans — must stay auto, not become user-only.
    assert hub.invocation_from_frontmatter({"disable-model-invocation": "false"}) == "auto"
    assert hub.invocation_from_frontmatter({"disable-model-invocation": "true"}) == "auto"
    assert hub.invocation_from_frontmatter({"disable-model-invocation": 1}) == "auto"
    assert hub.invocation_from_frontmatter({"user-invocable": "false"}) == "auto"


def test_ensure_variant_degrades_to_none_on_write_failure(tmp_data_home, monkeypatch, capsys):
    import hub

    src = _seed_skill(tmp_data_home, "alpha")

    def _boom(*a, **kw):
        raise OSError("disk full")

    monkeypatch.setattr(hub, "_write_skill_variant", _boom)
    assert hub.ensure_skill_variant("alpha", src, "user-only") is None
    assert "falling back" in capsys.readouterr().err


def test_override_mutation_rejects_bad_invocations(tmp_data_home, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    src, proj = _seed_project_env(tmp_data_home)

    # --skill without --mode
    with pytest.raises(SystemExit):
        hub.cmd_project_invocation(_inv_args("p1", skill="alpha"))
    assert "together" in capsys.readouterr().out

    # unknown skill
    with pytest.raises(SystemExit):
        hub.cmd_project_invocation(_inv_args("p1", skill="ghost", mode="user-only"))
    assert "Unknown skill" in capsys.readouterr().out

    # mcp-server
    reg = _read_registry(tmp_data_home)
    reg["skills"]["srv"] = {**_skill_cfg(src), "type": "mcp-server"}
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    with pytest.raises(SystemExit):
        hub.cmd_project_invocation(_inv_args("p1", skill="srv", mode="user-only"))
    assert "claude-skills only" in capsys.readouterr().out
    assert "invocation_overrides" not in _read_registry(tmp_data_home)["projects"]["p1"]
