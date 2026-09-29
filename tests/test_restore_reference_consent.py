"""Materialized references participate in executable-state consent."""

import pytest

from skill_hub.application.backup import restore


@pytest.mark.parametrize("section", ["connectors", "mcp-servers"])
def test_reference_into_code_directory_requires_consent(tmp_path, section):
    snapshot = tmp_path / "snapshot"
    payload = snapshot / "skills" / "tool" / "script.py"
    payload.parent.mkdir(parents=True)
    payload.write_text("print('run')\n")
    reference = snapshot / section / "tool" / "plugin.py"
    reference.parent.mkdir(parents=True)
    reference.symlink_to("../../skills/tool/script.py")
    target = tmp_path / "target"

    state = restore.collect_executable_state({}, snapshot_dir=snapshot, data_home=target)
    assert state["any"] is True
    assert state["code_dirs"][0]["files"] == ["tool/plugin.py"]
    assert state["code_dirs"][0]["action"] == "new"

    installed = target / section / "tool" / "plugin.py"
    installed.parent.mkdir(parents=True)
    installed.write_bytes(payload.read_bytes())
    unchanged = restore.collect_executable_state({}, snapshot_dir=snapshot, data_home=target)
    assert unchanged["code_dirs"][0]["action"] == "identical"
    assert unchanged["references_unverified"]  # Placement remains unsigned.
    installed.write_text("older version\n")
    changed = restore.collect_executable_state({}, snapshot_dir=snapshot, data_home=target)
    assert changed["any"] is True
    assert changed["code_dirs"][0]["action"] == "overwrite"


def test_apply_refuses_a_plan_that_has_not_passed_consent(tmp_path):
    target = tmp_path / "target"
    with pytest.raises(restore.RestoreError, match="required consent"):
        restore.apply_plan({"ok": False}, data_home=target)
    assert not target.exists()
