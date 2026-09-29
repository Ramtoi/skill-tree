"""Native fragment ownership preserves settings authored on the receiver."""

import json

import pytest

from skill_hub.application.loadout.loadout_transaction import ReceiverTransaction
from skill_hub.infrastructure.loadout.loadout_native import DocumentOp, plan_documents


def test_native_documents_share_the_skill_image_budget(tmp_data_home, monkeypatch):
    from skill_hub.application.loadout import loadout_transaction

    path = tmp_data_home / "settings.json"
    operation = DocumentOp(path, "json", "object", ("managed",), "value", "app")
    budget = loadout_transaction.ImageBudget()
    monkeypatch.setattr(loadout_transaction, "MAX_IMAGES", 100)
    budget.reserve(72)  # Skills already occupy 96 encoded bytes of the budget.

    def unexpected_encoding(*args, **kwargs):
        pytest.fail("Native output exceeded the shared budget before encoding")

    monkeypatch.setattr(loadout_transaction.base64, "b64encode", unexpected_encoding)
    ledger, changes, blockers = plan_documents([operation], {}, (tmp_data_home,), set(), {"app"}, set(), budget=budget)
    assert not ledger and not changes and blockers[0]["code"] == "invalid_write_plan"
    assert not path.exists()


def test_json_shared_file_preserves_unowned_entries_and_detects_owned_drift(tmp_data_home):
    path = tmp_data_home / "settings.json"
    path.write_text(json.dumps({"theme": "dark", "permissions": {"allow": ["Read(*)"]}}))
    root = (tmp_data_home,)
    operations = [
        DocumentOp(path, "json", "array", ("permissions", "allow"), "Bash(git:*)", "app"),
        DocumentOp(path, "json", "array", ("hooks", "Stop"), {"command": "reviewed"}, "app"),
    ]
    ledger, changes, blockers = plan_documents(operations, {}, root, set(), {"app"}, set())
    assert not blockers and len(changes) == 1
    ReceiverTransaction(tmp_data_home / "state", root).apply(changes, {"ledger": ledger})
    settings = json.loads(path.read_text())
    assert settings["theme"] == "dark" and settings["permissions"]["allow"] == ["Read(*)", "Bash(git:*)"]
    settings["theme"] = "light"
    path.write_text(json.dumps(settings))
    current, changes, blockers = plan_documents(operations, ledger, root, set(), {"app"}, set())
    assert not changes and not blockers
    settings["permissions"]["allow"].remove("Bash(git:*)")
    path.write_text(json.dumps(settings))
    _, changes, blockers = plan_documents(operations, current, root, set(), {"app"}, set())
    assert not changes and blockers[0]["code"] == "blocked_drift"


@pytest.mark.parametrize(
    "fmt,body",
    [
        ("json", '{"mcpServers":{"search":{"url":"https://example.com"}}}'),
        ("toml", '# keep\n[mcpServers.search]\nurl="https://example.com"\n'),
    ],
)
def test_equal_unowned_is_never_adopted(fmt, body, tmp_data_home):
    path = tmp_data_home / ("config." + fmt)
    path.write_text(body)
    op = DocumentOp(path, fmt, "object", ("mcpServers", "search"), {"url": "https://example.com"}, "app")
    ledger, changes, blockers = plan_documents([op], {}, (tmp_data_home,), set(), {"app"}, set())
    assert not ledger and not changes and blockers[0]["code"] == "unmanaged_existing"
    assert path.read_text() == body


def test_toml_composition_removal_and_retention(tmp_data_home):
    path = tmp_data_home / "config.toml"
    path.write_text('# user comment\nmodel="mine"\n')
    root = (tmp_data_home,)
    one = DocumentOp(path, "toml", "object", ("mcp_servers", "search"), {"command": "search"}, "app")
    two = DocumentOp(
        path, "toml", "array", ("hooks", "Stop"), {"matcher": "", "hooks": [{"command": "reviewed"}]}, "app"
    )
    ledger, changes, blockers = plan_documents([one, two], {}, root, set(), {"app"}, set())
    assert not blockers and len(changes) == 1
    tx = ReceiverTransaction(tmp_data_home / "state", root)
    tx.apply(changes, {})
    assert "# user comment" in path.read_text() and 'model="mine"' in path.read_text()
    ledger, changes, blockers = plan_documents([two], ledger, root, set(), {"app"}, set())
    assert not blockers and len(changes) == 1
    tx.apply(changes, {})
    assert "search" not in path.read_text() and "Stop" in path.read_text()
    before = path.read_bytes()
    ledger, changes, blockers = plan_documents([], ledger, root, {"app"}, set(), set())
    assert not ledger and not changes and not blockers and path.read_bytes() == before


def test_shared_contributor_retirement_and_conflict(tmp_data_home):
    path = tmp_data_home / "settings.json"
    root = (tmp_data_home,)

    def op(owner, value="same"):
        return DocumentOp(path, "json", "object", ("mcpServers", "shared"), {"command": value}, owner)

    ledger, changes, blockers = plan_documents([op("app"), op("other")], {}, root, set(), {"app", "other"}, set())
    assert not blockers
    ReceiverTransaction(tmp_data_home / "state", root).apply(changes, {})
    retained, changes, blockers = plan_documents([op("app")], ledger, root, {"other"}, {"app"}, set())
    assert not changes and not blockers
    assert next(iter(retained[str(path)]["fragments"].values()))["owners"] == ["app", "other"]
    _, changes, blockers = plan_documents([op("app", "changed")], retained, root, {"other"}, {"app"}, set())
    assert not changes and blockers[0]["code"] == "retained_fragment_conflict"
    _, _, blockers = plan_documents([op("app"), op("other", "different")], ledger, root, set(), {"app", "other"}, set())
    assert blockers[0]["code"] == "native_conflict"


def test_invalid_operations_are_typed_errors_and_duplicate_unowned_arrays_block(tmp_data_home):
    from skill_hub.domain.loadout.loadout_profiles import ProfileError

    path = tmp_data_home / "settings.json"
    with pytest.raises(ProfileError) as exc:
        plan_documents(
            [DocumentOp(path, "json", "invalid", ("x",), True, "app")], {}, (tmp_data_home,), set(), {"app"}, set()
        )
    assert exc.value.code == "native_invalid"
    path.write_text('{"permissions":{"allow":["Read(*)","Read(*)"]}}')
    _, changes, blockers = plan_documents(
        [DocumentOp(path, "json", "array", ("permissions", "allow"), "Read(*)", "app")],
        {},
        (tmp_data_home,),
        set(),
        {"app"},
        set(),
    )
    assert not changes and blockers[0]["code"] == "unmanaged_existing"
