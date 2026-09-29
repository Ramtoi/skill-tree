"""Bindings remain proposals until receiver confirmation, across project edits."""

import json
import subprocess
import sys

import pytest
import yaml


def call(monkeypatch, capsys, *args):
    import hub

    monkeypatch.setattr(sys, "argv", ["hub", *args])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    result = capsys.readouterr()
    return code, result.out, result.err


@pytest.fixture
def configured(tmp_data_home, monkeypatch):
    import hub

    project = tmp_data_home / "app"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(
        ["git", "-C", str(project), "remote", "add", "origin", "https://github.com/example-org/app.git"], check=True
    )
    registry = {
        "version": "1",
        "skills": {},
        "bundles": {},
        "harnesses_global": [],
        "projects": {
            "app": {
                "path": str(project),
                "enabled": [],
                "bundles": [],
                "harnesses": [],
                "repository": {
                    "url": "https://github.com/example-org/app.git",
                    "remote": "origin",
                    "subdirectory": ".",
                },
            }
        },
        "remotes": {"box-a": {"connector": "headless-loadouts", "sync_enabled": False}},
    }
    file = tmp_data_home / "registry.yaml"
    file.write_text(yaml.safe_dump(registry))
    monkeypatch.setattr(hub, "_auto_sync", lambda **kwargs: None)
    return project, file


def add(monkeypatch, capsys, *, manual=True):
    target = (
        ["--manual"]
        if manual
        else [
            "--destination-repository-json",
            json.dumps({"url": "git@github.com:example-org/app.git", "remote": "origin", "subdirectory": "."}),
        ]
    )
    return call(
        monkeypatch,
        capsys,
        "remote",
        "binding",
        "add",
        "box-a",
        "app-on-box",
        "--project",
        "app",
        "--destination-key",
        "app",
        "--harnesses",
        "codex",
        *target,
        "--json",
    )


def test_manual_binding_is_unconfirmed_and_keeps_old_remote_roundtrip(configured, monkeypatch, capsys):
    from skill_hub.infrastructure.remotes.remotes import RemoteTarget

    _, file = configured
    code, out, _ = add(monkeypatch, capsys)
    assert code == 0
    binding = json.loads(out)["bindings"]["app-on-box"]
    assert binding["confirmation"] is None
    assert binding["mode"] == "manual"
    assert binding["harnesses"] == ["codex"]
    target = yaml.safe_load(file.read_text())["remotes"]["box-a"]
    assert RemoteTarget.from_dict("box-a", target).to_dict()["project_bindings"] == target["project_bindings"]
    assert "project_bindings" not in RemoteTarget.from_dict("old", {"connector": "hermes"}).to_dict()


def test_rename_updates_reference_and_remove_blocks_before_cleanup(configured, monkeypatch, capsys):
    import skill_hub.entrypoints.cli.project

    _, file = configured
    assert add(monkeypatch, capsys)[0] == 0
    code, _, _ = call(monkeypatch, capsys, "project", "rename", "app", "renamed")
    assert code == 0
    assert (
        yaml.safe_load(file.read_text())["remotes"]["box-a"]["project_bindings"]["app-on-box"]["source_project"]
        == "renamed"
    )
    monkeypatch.setattr(
        skill_hub.entrypoints.cli.project,
        "clean_project_artifacts",
        lambda *a, **k: pytest.fail("bound project cleanup must not start"),
    )
    code, out, _ = call(monkeypatch, capsys, "project", "remove", "renamed", "--dry-run", "--json")
    assert code == 0 and json.loads(out)["blocked"] is True
    assert call(monkeypatch, capsys, "project", "remove", "renamed")[0] == 1
    assert "renamed" in yaml.safe_load(file.read_text())["projects"]


def test_changed_source_cannot_acknowledge_saved_stale_identity(configured, monkeypatch, capsys):
    _, file = configured
    assert add(monkeypatch, capsys, manual=False)[0] == 0
    new_path = file.parent / "different"
    new_path.mkdir()
    subprocess.run(["git", "init", "-q", str(new_path)], check=True)
    subprocess.run(
        ["git", "-C", str(new_path), "remote", "add", "origin", "https://github.com/example-org/different.git"],
        check=True,
    )
    assert call(monkeypatch, capsys, "project", "edit-path", "app", str(new_path))[0] == 0
    before = file.read_bytes()
    code, out, _ = call(
        monkeypatch,
        capsys,
        "remote",
        "binding",
        "acknowledge",
        "box-a",
        "app-on-box",
        "--destination-repository-json",
        json.dumps({"url": "https://github.com/example-org/app.git", "remote": "origin", "subdirectory": "."}),
        "--json",
    )
    assert code == 1
    assert json.loads(out)["error"]["code"] == "source_repository_mismatch"
    assert file.read_bytes() == before
    record = yaml.safe_load(file.read_text())["remotes"]["box-a"]["project_bindings"]["app-on-box"]
    assert record["review_required"] == "source_path_changed"


def test_clear_association_requires_explicit_manual_choice(configured, monkeypatch, capsys):
    _, file = configured
    assert add(monkeypatch, capsys, manual=False)[0] == 0
    assert call(monkeypatch, capsys, "project", "repository", "clear", "app", "--json")[0] == 0
    record = yaml.safe_load(file.read_text())["remotes"]["box-a"]["project_bindings"]["app-on-box"]
    assert record["mode"] == "repository"
    assert record["review_required"] == "source_repository_cleared"
    code, out, _ = call(
        monkeypatch, capsys, "remote", "binding", "acknowledge", "box-a", "app-on-box", "--manual", "--json"
    )
    assert code == 0
    record = json.loads(out)["bindings"]["app-on-box"]
    assert record["mode"] == "manual" and record["confirmation"] is None


def test_remove_records_explicit_retain_directive(configured, monkeypatch, capsys):
    _, file = configured
    assert add(monkeypatch, capsys)[0] == 0
    assert call(monkeypatch, capsys, "remote", "binding", "remove", "box-a", "app-on-box", "--json")[0] == 0
    target = yaml.safe_load(file.read_text())["remotes"]["box-a"]
    assert target["project_bindings"] == {}
    assert target["retired_bindings"]["app-on-box"]["disposition"] == "retain"


def test_backup_rejects_credentials_without_echoing_them(configured, tmp_data_home):
    from skill_hub.application.backup import backup

    _, file = configured
    registry = yaml.safe_load(file.read_text())
    registry["projects"]["app"]["repository"]["url"] = "https://user:secret123@github.com/org/app.git"
    with pytest.raises(backup.BackupError) as error:
        backup.to_portable(registry, data_home=tmp_data_home)
    assert "invalid_repository_metadata" in str(error.value)
    assert "secret123" not in str(error.value)


def test_defaults_save_is_offline_and_does_not_change_machine(configured, monkeypatch, capsys):
    import hub

    _, file = configured
    before = yaml.safe_load(file.read_text())["remotes"]
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("defaults must remain offline"))
    monkeypatch.setattr(hub, "_auto_sync", lambda: pytest.fail("defaults must not sync"))
    code, out, _ = call(monkeypatch, capsys, "remote", "defaults", "show", "--json")
    assert code == 0 and json.loads(out)["defaults"] == {"poll_interval_seconds": 60}
    assert "remote_defaults" not in yaml.safe_load(file.read_text())
    code, out, _ = call(monkeypatch, capsys, "remote", "defaults", "set", "--poll-interval-seconds", "120", "--json")
    assert code == 0 and json.loads(out)["defaults"] == {"poll_interval_seconds": 120}
    assert yaml.safe_load(file.read_text())["remotes"] == before
    saved = file.read_bytes()
    code, out, _ = call(monkeypatch, capsys, "remote", "defaults", "set", "--poll-interval-seconds", "1", "--json")
    assert code == 1 and not json.loads(out)["ok"]
    assert file.read_bytes() == saved


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {"poll_interval_seconds": True},
        {"poll_interval_seconds": 0},
        {"poll_interval_seconds": 60, "unknown": 1},
    ],
)
def test_invalid_hand_edited_defaults_are_visible(value):
    from skill_hub.infrastructure.remotes.remotes import remote_defaults

    with pytest.raises(ValueError):
        remote_defaults({"remote_defaults": value})


@pytest.mark.parametrize("field", ["source_repository", "destination_repository"])
def test_backup_refuses_credentials_in_retired_bindings(configured, tmp_data_home, field):
    from skill_hub.application.backup import backup

    _, file = configured
    registry = yaml.safe_load(file.read_text())
    registry["remotes"]["box-a"]["retired_bindings"] = {
        "old": {
            "disposition": "retain",
            "binding": {
                field: {"url": "https://user:retired-secret@example.com/a.git", "remote": "origin", "subdirectory": "."}
            },
        }
    }
    with pytest.raises(backup.BackupError) as error:
        backup.to_portable(registry, data_home=tmp_data_home)
    assert "invalid_repository_metadata" in str(error.value)
    assert "retired-secret" not in str(error.value)


@pytest.mark.parametrize("retired", [None, [], {"old": None}, {"old": {}}, {"old": {"binding": None}}])
def test_backup_refuses_malformed_retired_bindings(configured, tmp_data_home, retired):
    from skill_hub.application.backup import backup

    _, file = configured
    registry = yaml.safe_load(file.read_text())
    registry["remotes"]["box-a"]["retired_bindings"] = retired
    with pytest.raises(backup.BackupError, match="invalid_repository_metadata"):
        backup.to_portable(registry, data_home=tmp_data_home)


def test_invalid_defaults_read_is_typed_and_readonly(configured, monkeypatch, capsys):
    _, file = configured
    registry = yaml.safe_load(file.read_text())
    registry["remote_defaults"] = {"poll_interval_seconds": False}
    file.write_text(yaml.safe_dump(registry))
    before = file.read_bytes()
    code, out, _ = call(monkeypatch, capsys, "remote", "defaults", "show", "--json")
    assert code == 0
    assert json.loads(out)["error"]["code"] == "invalid_remote_defaults"
    assert file.read_bytes() == before


def test_metadata_free_source_uses_selected_remote_and_detects_drift(tmp_path):
    from skill_hub.application.loadout.loadout_control import validate_source
    from skill_hub.infrastructure.registry import loadout_bindings

    project = tmp_path / "monorepo"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(
        ["git", "-C", str(project), "remote", "add", "upstream", "https://github.com/example-org/app.git"],
        check=True,
    )
    source_project = project / "packages" / "editor"
    source_project.mkdir(parents=True)
    registry = {"projects": {"app": {"path": str(source_project), "enabled": []}}}
    binding = loadout_bindings.proposed_binding(
        registry, project="app", destination_key="app", harnesses=["codex"],
        destination_repository={
            "url": "git@github.com:example-org/app.git", "remote": "upstream", "subdirectory": "packages/editor"
        },
        source_remote="upstream",
    )
    assert binding["source_repository"]["subdirectory"] == "packages/editor"
    validate_source(registry, binding)

    subprocess.run(
        ["git", "-C", str(project), "remote", "set-url", "upstream", "https://github.com/example-org/fork.git"],
        check=True,
    )
    with pytest.raises(Exception) as raised:
        validate_source(registry, binding)
    assert getattr(raised.value, "code", None) == "source_repository_mismatch"
