"""Only an explicit receiver-side confirmation authorizes a checkout."""

import copy
import subprocess

import pytest

from skill_hub.domain.loadout.loadout_profiles import ProfileError, ReceiverProfiles, binding_digest


def proposal(mode="manual"):
    value = {
        "mode": mode,
        "source_fingerprint": "a" * 64,
        "source_project": "app",
        "destination_key": "app",
        "harnesses": ["codex"],
        "confirmation": None,
    }
    if mode == "repository":
        value.update(
            source_repository={"url": "https://github.com/example/app.git", "remote": "origin", "subdirectory": "."},
            destination_repository={"url": "git@github.com:example/app.git", "remote": "origin", "subdirectory": "."},
        )
    return value


def git(path, url):
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "remote", "add", "origin", url], check=True)
    return path


def test_confirm_existing_manual_checkout_no_git_then_revalidate(tmp_path):
    store = ReceiverProfiles(tmp_path / "receiver")
    path = tmp_path / "project"
    path.mkdir()
    store.initialize("box-a")
    binding = proposal()
    receipt = store.confirm("app-on-box", binding, path, installed={"codex"})
    assert receipt["receiver_id"] == "box-a"
    assert receipt["binding_digest"] == binding_digest("app-on-box", binding)
    assert store.checkout("app-on-box", binding, receipt) == path.resolve()
    renamed = copy.deepcopy(binding)
    renamed["source_project"] = "renamed"
    assert store.checkout("app-on-box", renamed, receipt) == path.resolve()
    changed = copy.deepcopy(binding)
    changed["harnesses"] = ["claude-code"]
    with pytest.raises(ProfileError, match="confirmation"):
        store.checkout("app-on-box", changed, receipt)


def test_repository_confirmation_checks_actual_checkout_and_each_use(tmp_path):
    store = ReceiverProfiles(tmp_path / "receiver")
    store.initialize("box-a")
    path = git(tmp_path / "project", "https://github.com/example/app.git")
    binding = proposal("repository")
    receipt = store.confirm("main", binding, path, installed={"codex"})
    subprocess.run(
        ["git", "-C", str(path), "remote", "set-url", "origin", "https://github.com/fork/app.git"], check=True
    )
    with pytest.raises(ProfileError) as error:
        store.checkout("main", binding, receipt)
    assert error.value.code == "destination_repository_mismatch"


def test_confirm_refuses_overlap_and_missing_provider_without_mutation(tmp_path):
    store = ReceiverProfiles(tmp_path / "receiver")
    store.initialize("box-a")
    path = tmp_path / "project"
    child = path / "sub"
    child.mkdir(parents=True)
    store.confirm("main", proposal(), path, installed={"codex"})
    before = store.path.read_bytes()
    second = {**proposal(), "destination_key": "other"}
    with pytest.raises(ProfileError) as error:
        store.confirm("second", second, child, installed={"codex"})
    assert error.value.code == "overlapping_checkouts"
    with pytest.raises(ProfileError) as error:
        store.confirm("main", proposal(), path, installed=set())
    assert error.value.code == "receiver_provider_unavailable"
    assert store.path.read_bytes() == before


def test_second_binding_does_not_invalidate_first_and_replaced_directory_does(tmp_path):
    store = ReceiverProfiles(tmp_path / "receiver")
    store.initialize("box-a")
    first, second = tmp_path / "one", tmp_path / "two"
    first.mkdir()
    second.mkdir()
    receipt = store.confirm("one", proposal(), first, installed={"codex"})
    store.confirm("two", {**proposal(), "destination_key": "two"}, second, installed={"codex"})
    assert store.checkout("one", proposal(), receipt) == first.resolve()
    first.rename(tmp_path / "old")
    first.mkdir()
    with pytest.raises(ProfileError) as error:
        store.checkout("one", proposal(), receipt)
    assert error.value.code == "checkout_replaced"


def test_corrupt_profile_never_becomes_empty(tmp_path):
    store = ReceiverProfiles(tmp_path / "receiver")
    store.initialize("box-a")
    store.path.write_text('{"schema":1,"schema":1}')
    before = store.path.read_bytes()
    with pytest.raises(ProfileError):
        store.initialize("box-a")
    assert store.path.read_bytes() == before


@pytest.mark.parametrize("damage", ["timestamp", "extra_binding_key"])
def test_profile_rejects_malformed_saved_confirmation(tmp_path, damage):
    import json

    store = ReceiverProfiles(tmp_path / "receiver")
    store.initialize("box-a")
    project = tmp_path / "project"
    project.mkdir()
    store.confirm("main", proposal(), project, installed={"codex"})
    value = json.loads(store.path.read_text())
    record = value["bindings"]["main"]
    if damage == "timestamp":
        record["confirmation"]["observed_at"] = ["invalid"]
    else:
        record["binding"]["unreviewed"] = "unknown"
    store.path.write_text(json.dumps(value))
    with pytest.raises(ProfileError) as error:
        store.read()
    assert error.value.code == "receiver_profile_invalid"


def test_new_installation_generation_invalidates_controller_receipts(tmp_path):
    store = ReceiverProfiles(tmp_path / "receiver")
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    first = store.initialize("box-a", "a" * 64)
    receipt = store.confirm("main", proposal(), checkout, installed={"codex"})
    assert store.initialize("box-a", "a" * 64)["installation_id"] == first["installation_id"]
    changed = store.initialize("box-a", "b" * 64)
    assert changed["installation_id"] != first["installation_id"]
    with pytest.raises(ProfileError) as error:
        store.checkout("main", proposal(), receipt)
    assert error.value.code == "binding_confirmation_required"
    confirmed = store.confirm("main", proposal(), checkout, installed={"codex"})
    assert store.checkout("main", proposal(), confirmed) == checkout.resolve()
