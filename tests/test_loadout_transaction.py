"""Crash recovery must never overwrite an edit or advance a partial revision."""

import json

import pytest

from skill_hub.application.loadout.loadout_transaction import FileMutation, Image, ReceiverTransaction, snapshot
from skill_hub.domain.loadout.loadout_profiles import ProfileError


@pytest.mark.parametrize(
    "boundary",
    [
        "journal:prepared",
        "journal:applying",
        "before:0",
        "intent:0",
        "after:0",
        "before:1",
        "intent:1",
        "after:1",
        "applied",
        "journal:committed",
    ],
)
def test_each_crash_boundary_recovers_or_finishes_commit(tmp_path, boundary):
    checkout = (tmp_path / "checkout").resolve()
    checkout.mkdir()
    first, second = checkout / "one", checkout / "nested" / "two"
    first.write_bytes(b"old")
    roots = (checkout,)
    mutations = [
        FileMutation(first, snapshot(first, roots), Image.file(b"new"), "one"),
        FileMutation(second, Image("missing"), Image.file(b"created", 0o700), "two"),
    ]

    def crash(event):
        if event == boundary:
            raise KeyboardInterrupt("simulated process death")

    transaction = ReceiverTransaction(tmp_path / "state", roots, checkpoint=crash)
    with pytest.raises(KeyboardInterrupt):
        transaction.apply(mutations, {"generation": 1})
    resumed = ReceiverTransaction(tmp_path / "state", roots)
    resumed.recover()
    if boundary in {"applied", "journal:committed"}:
        assert resumed.read_applied()["state"]["generation"] == 1
        assert first.read_bytes() == b"new" and second.read_bytes() == b"created"
        assert second.stat().st_mode & 0o777 == 0o700
    else:
        assert resumed.read_applied() is None
        assert first.read_bytes() == b"old" and not second.exists()
    assert resumed.recover() is False


def test_recovery_preserves_concurrent_edit_and_blocks_next_revision(tmp_path):
    checkout = (tmp_path / "checkout").resolve()
    checkout.mkdir()
    file = checkout / "one"
    file.write_bytes(b"old")
    roots = (checkout,)

    def crash(event):
        if event == "after:0":
            raise KeyboardInterrupt()

    transaction = ReceiverTransaction(tmp_path / "state", roots, checkpoint=crash)
    with pytest.raises(KeyboardInterrupt):
        transaction.apply([FileMutation(file, snapshot(file, roots), Image.file(b"new"), "one")], {"generation": 1})
    file.write_bytes(b"local edit")
    resumed = ReceiverTransaction(tmp_path / "state", roots)
    with pytest.raises(ProfileError) as error:
        resumed.apply([], {"generation": 2})
    assert error.value.code == "partial_apply"
    assert file.read_bytes() == b"local edit"
    assert resumed.read_applied() is None
    assert json.loads(resumed.journal.read_text())["phase"] == "recovery_required"


def test_recheck_before_each_mutation_rolls_back_earlier_writes(tmp_path):
    checkout = tmp_path.resolve()
    first, second = checkout / "one", checkout / "two"
    first.write_bytes(b"old")
    second.write_bytes(b"old2")
    roots = (checkout,)
    mutations = [FileMutation(path, snapshot(path, roots), Image.file(b"new"), path.name) for path in (first, second)]

    def edit(event):
        if event == "before:1":
            second.write_bytes(b"local edit")

    transaction = ReceiverTransaction(tmp_path / "state", roots, checkpoint=edit)
    with pytest.raises(ProfileError):
        transaction.apply(mutations, {"generation": 1})
    assert first.read_bytes() == b"old" and second.read_bytes() == b"local edit"
    assert transaction.read_applied() is None


def test_equal_images_validate_without_replacing_file(tmp_path):
    checkout = tmp_path.resolve()
    file = checkout / "already-current"
    file.write_bytes(b"signed content")
    roots = (checkout,)
    current = snapshot(file, roots)
    inode = file.stat().st_ino
    transaction = ReceiverTransaction(checkout / "state", roots)

    transaction.apply([FileMutation(file, current, current, "owned")], {"generation": 2})

    assert file.stat().st_ino == inode
    assert file.read_bytes() == b"signed content"
    assert transaction.read_applied()["state"]["generation"] == 2


def test_equal_images_recheck_at_write_and_preserve_concurrent_edit(tmp_path):
    checkout = tmp_path.resolve()
    file = checkout / "already-current"
    file.write_bytes(b"signed content")
    roots = (checkout,)
    current = snapshot(file, roots)

    def edit(event):
        if event == "before:0":
            file.write_bytes(b"local edit")

    transaction = ReceiverTransaction(checkout / "state", roots, checkpoint=edit)
    with pytest.raises(ProfileError) as error:
        transaction.apply([FileMutation(file, current, current, "owned")], {"generation": 2})
    assert error.value.code == "partial_apply"
    assert file.read_bytes() == b"local edit"
    assert transaction.read_applied() is None


def test_parent_symlink_and_outside_path_cannot_redirect_writes(tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (checkout / "redirect").symlink_to(outside, target_is_directory=True)
    transaction = ReceiverTransaction(tmp_path / "state", (checkout.resolve(),))
    for path in (outside / "file", checkout / "redirect" / "file"):
        with pytest.raises(ProfileError) as error:
            transaction.apply([FileMutation(path, Image("missing"), Image.file(b"bad"), "one")], {"generation": 1})
        assert error.value.code == "write_confinement"
    assert not (outside / "file").exists()


def test_corrupt_journal_and_state_do_not_reset_ownership(tmp_path):
    transaction = ReceiverTransaction(tmp_path / "state", (tmp_path.resolve(),))
    transaction.root.mkdir()
    transaction.journal.write_text('{"schema":1,"schema":1}')
    with pytest.raises(ProfileError, match="journal"):
        transaction.apply([], {"generation": 1})
    transaction.journal.unlink()
    transaction.applied.write_text("null")
    with pytest.raises(ProfileError, match="state"):
        transaction.apply([], {"generation": 1})


@pytest.mark.parametrize("target", ["/etc/passwd", "../../outside", "managed/source"])
def test_delivery_rejects_symlink_operations(tmp_path, target):
    file = tmp_path / "delivered"
    transaction = ReceiverTransaction(tmp_path / "state", (tmp_path.resolve(),))
    with pytest.raises(ProfileError, match="symlinks"):
        transaction.apply([FileMutation(file, Image("missing"), Image("symlink", target), "one")], {})
    assert not file.is_symlink() and not transaction.journal.exists()


def test_oversized_journal_and_invalid_state_leave_everything_untouched(tmp_path, monkeypatch):
    from skill_hub.application.loadout import loadout_transaction

    file = tmp_path / "delivered"
    transaction = ReceiverTransaction(tmp_path / "state", (tmp_path.resolve(),))
    plan = [FileMutation(file, Image("missing"), Image.file(b"x" * 1000), "one")]
    monkeypatch.setattr(loadout_transaction, "MAX_JOURNAL", 1024)
    for state in ({"generation": 1}, []):
        with pytest.raises(ProfileError):
            transaction.apply(plan, state)
        assert not file.exists() and not transaction.journal.exists() and not transaction.applied.exists()


def test_journal_budget_precedes_full_plan_serialization(tmp_path, monkeypatch):
    from skill_hub.application.loadout import loadout_transaction

    transaction = ReceiverTransaction(tmp_path / "state", (tmp_path.resolve(),))
    plan = [FileMutation(tmp_path / "file", Image("missing"), Image.file(b"x" * 1000), "one")]
    monkeypatch.setattr(loadout_transaction, "MAX_JOURNAL", 1024)

    def unexpected_serialization(value):
        pytest.fail("Oversized journal reached full serialization")

    monkeypatch.setattr(loadout_transaction, "canonical", unexpected_serialization)
    with pytest.raises(ProfileError) as error:
        transaction.apply(plan, {})
    assert error.value.code == "invalid_write_plan"
    assert not transaction.journal.exists() and not (tmp_path / "file").exists()


def test_preimage_budget_precedes_base64_allocation(tmp_path, monkeypatch):
    from skill_hub.application.loadout import loadout_transaction

    path = tmp_path / "existing"
    path.write_bytes(b"existing settings")
    budget = loadout_transaction.ImageBudget()
    monkeypatch.setattr(loadout_transaction, "MAX_IMAGES", 4)

    def unexpected_encoding(*args, **kwargs):
        pytest.fail("Oversized preimage reached base64 allocation")

    monkeypatch.setattr(loadout_transaction.base64, "b64encode", unexpected_encoding)
    with pytest.raises(ProfileError) as error:
        snapshot(path, (tmp_path,), budget=budget)
    assert error.value.code == "invalid_write_plan"
    assert path.read_bytes() == b"existing settings"


def test_recovery_does_not_restore_an_unattempted_file_matching_postimage(tmp_path):
    first, second = tmp_path / "one", tmp_path / "two"
    roots = (tmp_path.resolve(),)
    first.write_bytes(b"old1")
    second.write_bytes(b"old2")
    plan = [FileMutation(path, snapshot(path, roots), Image.file(b"new"), path.name) for path in (first, second)]

    def crash(event):
        if event == "before:1":
            second.write_bytes(b"new")
            raise KeyboardInterrupt()

    transaction = ReceiverTransaction(tmp_path / "state", roots, checkpoint=crash)
    with pytest.raises(KeyboardInterrupt):
        transaction.apply(plan, {})
    ReceiverTransaction(tmp_path / "state", roots).recover()
    assert first.read_bytes() == b"old1"
    assert second.read_bytes() == b"new"


def test_repeated_updates_keep_one_preceding_recovery_copy(tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    file = checkout / "skill"
    roots = (checkout,)
    transaction = ReceiverTransaction(tmp_path / "state", roots)
    for generation in range(8):
        payload = str(generation).encode() * 100000
        transaction.apply(
            [FileMutation(file, snapshot(file, roots), Image.file(payload), "main")], {"generation": generation}
        )
    history = list((transaction.root / "history").iterdir())
    assert [path.name for path in history] == ["previous.json"]
    prior = json.loads(history[0].read_text())
    assert prior["new_state"]["generation"] == 6
    assert sum(path.stat().st_size for path in history) < 400000
