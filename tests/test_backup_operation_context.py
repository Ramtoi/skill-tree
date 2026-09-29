"""Backup and restore keep unavailable native state and fixed operation bindings."""
from dataclasses import replace

import pytest

from skill_hub.application.backup import backup, restore
from skill_hub.application.harnesses import harness_operation_context as contexts


def _context(tmp_data_home, tmp_path, monkeypatch, ids=("claude-code", "codex")):
    monkeypatch.setattr(contexts, "read_inventory_cache", lambda *args: None)
    context = contexts.build_operation_context(
        tmp_data_home, ids, requested_features=("backup", "restore")
    )
    layouts = {
        hid: replace(layout, global_doc=tmp_path / "native" / hid / "instructions.md",
                     agents_dir=tmp_path / "native" / hid / "agents")
        for hid, layout in context.layouts.items()
    }
    def no_signing():
        raise OSError("fixture signing unavailable")
    monkeypatch.setattr(backup._signing(), "ensure_signing_key", no_signing)
    return replace(context, layouts=layouts)


def _snapshot(dest, data_home, context):
    return backup.assemble_snapshot(
        dest, registry={"version": "1", "skills": {}, "projects": {}},
        data_home=data_home, operation_context=context,
    )


def test_backup_preserves_uncaptured_harness_but_removes_known_deleted_doc(tmp_data_home, tmp_path, monkeypatch):
    context = _context(tmp_data_home, tmp_path, monkeypatch)
    for layout in context.layouts.values():
        layout.global_doc.parent.mkdir(parents=True)
        layout.global_doc.write_text("fixture instructions")
    dest = tmp_path / "snapshot"
    _snapshot(dest, tmp_data_home, context)
    context.layout("codex").global_doc.unlink()
    codex_only = replace(context, harness_ids=("codex",), layouts={"codex": context.layout("codex")},
                         routes={key: value for key, value in context.routes.items() if key[0] == "codex"})
    _snapshot(dest, tmp_data_home, codex_only)
    assert (dest / "global-docs/claude-code/instructions.md").read_text() == "fixture instructions"
    assert not (dest / "global-docs/codex/instructions.md").exists()
    manifest = backup.read_manifest(dest)
    assert manifest["global_docs"] == ["global-docs/claude-code/instructions.md"]


@pytest.mark.parametrize("damage", ["absent", "verified"])
def test_unimplemented_backup_route_does_not_read_native_target(tmp_data_home, tmp_path, monkeypatch, damage):
    context = _context(tmp_data_home, tmp_path, monkeypatch, ("claude-code",))
    if damage == "absent":
        context = replace(context, routes={})
    else:
        route = context.route("claude-code", "backup")
        context = replace(context, routes={
            ("claude-code", "backup"): replace(route, mode="verified", status="verified", enforced=True)
        })
    assert backup.harness_global_doc("claude-code", context) is None
    assert backup.harness_agents_dir("claude-code", context) is None


def test_restore_rejects_changed_binding_before_any_write(tmp_data_home, tmp_path, monkeypatch):
    context = _context(tmp_data_home, tmp_path, monkeypatch, ("claude-code",))
    dest = tmp_path / "snapshot"
    _snapshot(dest, tmp_data_home, context)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": str(dest)}, target_registry={}, mode="replace",
        data_home=tmp_data_home, code_home=None, home=tmp_path,
        trust_new_key=True, accept_executable_state=True, operation_context=context,
    )
    assert plan["ok"]
    assert plan["operation_context_id"] == context.context_id
    monkeypatch.setattr(restore.hub_core, "save_registry", lambda *a: pytest.fail("wrote before checking binding"))
    with pytest.raises(restore.RestoreError, match="context"):
        restore.apply_plan(plan, data_home=tmp_data_home, operation_context=replace(context, context_id="new"))


def test_unavailable_restore_member_is_reported_as_retained(tmp_data_home, tmp_path, monkeypatch):
    context = replace(_context(tmp_data_home, tmp_path, monkeypatch), routes={})
    links = tmp_path / "snapshot/state/subagents/links.json"
    links.parent.mkdir(parents=True)
    links.write_text('{"links":[{"name":"pair","scope":"user","harnesses":["claude-code","codex"]}]}')
    plan = restore._plan_links(links.parents[2], [], force=False, operation_context=context)
    assert not plan["dropped"]
    assert not plan["restored"]
    assert plan["retained"][0]["name"] == "pair"


@pytest.mark.parametrize("entry", ["harness", "global-docs"])
@pytest.mark.parametrize("kind", ["symlink", "file"])
def test_backup_refuses_invalid_native_snapshot_root(tmp_data_home, tmp_path, monkeypatch, entry, kind):
    context = _context(tmp_data_home, tmp_path, monkeypatch, ("claude-code",))
    layout = context.layout("claude-code")
    layout.agents_dir.mkdir(parents=True)
    (layout.agents_dir / "fixture.md").write_text("fixture agent")
    layout.global_doc.write_text("fixture instructions")
    dest = tmp_path / "snapshot"
    dest.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    root = dest / entry
    if kind == "symlink":
        root.symlink_to(outside, target_is_directory=True)
    else:
        root.write_text("prior file")
    with pytest.raises(backup.BackupError, match="snapshot root"):
        _snapshot(dest, tmp_data_home, context)
    assert list(outside.iterdir()) == []
    assert root.is_symlink() if kind == "symlink" else root.read_text() == "prior file"


def test_restore_text_reports_retained_unavailable_link(capsys):
    from skill_hub.entrypoints.cli.restore import _print_restore_plan

    _print_restore_plan({"links": {"retained": [{
        "name": "pair", "reason": "member restore route unavailable; existing ownership retained",
    }]}})
    output = capsys.readouterr().out
    assert "pair" in output and "retained" in output and "route unavailable" in output


def test_equivalent_context_keeps_snapshot_idempotent(tmp_data_home, tmp_path, monkeypatch):
    context = _context(tmp_data_home, tmp_path, monkeypatch, ("claude-code",))
    dest = tmp_path / "snapshot"
    _snapshot(dest, tmp_data_home, context)
    before = (dest / "manifest.json").read_bytes()
    _snapshot(dest, tmp_data_home, replace(context, context_id="next-operation"))
    assert (dest / "manifest.json").read_bytes() == before
