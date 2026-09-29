from __future__ import annotations

import json
import sys
from argparse import Namespace

import pytest


def _seed(registry):
    from skill_hub import hub_core

    hub_core.save_registry(registry)


def _load():
    from skill_hub import hub_core

    return hub_core.load_registry()


def test_update_playbook_persists_and_projects_it_in_json(tmp_data_home, monkeypatch, capsys):
    import hub

    _seed(
        {
            "version": "1",
            "skills": {"alpha": {}, "ghost": {}},
            "bundles": {"pack": {"skills": ["alpha"]}},
        }
    )
    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    hub.cmd_bundle_update(Namespace(
        bundle_name="pack", skills=None, description=None, icon=None, scope=None,
        source=None, detach_source=False,
        playbook=json.dumps([{"id": "unsectioned", "title": "", "skills": ["alpha"]}]),
        json=True,
    ))
    payload = json.loads(capsys.readouterr().out)
    assert payload["bundle"]["playbook"][0]["id"] == "unsectioned"
    assert _load()["bundles"]["pack"]["playbook"][0]["skills"] == ["alpha"]


def test_invalid_playbook_does_not_write(tmp_data_home, monkeypatch):
    import hub

    _seed(
        {
            "version": "1",
            "skills": {"alpha": {}},
            "bundles": {"pack": {"skills": ["alpha"]}},
        }
    )
    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    with pytest.raises(SystemExit):
        hub.cmd_bundle_update(Namespace(
            bundle_name="pack", skills=None, description=None, icon=None, scope=None,
            source=None, detach_source=False,
            playbook=json.dumps([{"id": "a", "title": "A", "skills": ["missing"]}]),
            json=True,
        ))
    assert "playbook" not in _load()["bundles"]["pack"]


def test_parser_accepts_exact_playbook_flag(tmp_data_home, monkeypatch):
    import hub

    _seed(
        {
            "version": "1",
            "skills": {"alpha": {}},
            "bundles": {"pack": {"skills": ["alpha"]}},
        }
    )
    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    monkeypatch.setattr(sys, "argv", ["hub", "bundle", "update", "pack", "--playbook", "[]", "--json"])
    hub.main()
    assert _load()["bundles"]["pack"]["playbook"] == []


@pytest.mark.parametrize("linked", [False, True])
def test_layout_only_update_skips_auto_sync(tmp_data_home, monkeypatch, linked):
    import hub

    calls = []
    _seed(
        {
            "version": "1",
            "skills": {"alpha": {}},
            "bundles": {
                "pack": {
                    "skills": ["alpha"],
                    **({"source": "org"} if linked else {}),
                }
            },
        }
    )
    monkeypatch.setattr(hub, "_auto_sync", lambda: calls.append(True))
    hub.cmd_bundle_update(
        Namespace(
            bundle_name="pack", skills=None, description=None, icon=None,
            scope=None, source=None, detach_source=False,
            playbook=json.dumps([{"id": "unsectioned", "title": "", "skills": ["alpha"]}]),
            json=True,
        )
    )
    assert calls == []


def test_new_bundle_validates_and_persists_playbook_atomically(tmp_data_home, monkeypatch, capsys):
    import hub

    _seed({"version": "1", "skills": {"alpha": {}}})
    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    hub.cmd_bundle_new(
        Namespace(
            bundle_name="pack", skills="alpha", description=None, icon=None,
            scope=None, source=None,
            playbook=json.dumps([{"id": "unsectioned", "title": "", "skills": ["alpha"]}]),
            json=True,
        )
    )
    capsys.readouterr()
    assert _load()["bundles"]["pack"]["playbook"][0]["skills"] == ["alpha"]


def test_membership_write_normalizes_stale_refs_and_appends_new_skill(
    tmp_data_home, monkeypatch
):
    import hub

    _seed(
        {
            "version": "1",
            "skills": {name: {} for name in ("alpha", "beta", "stale")},
            "bundles": {
                "pack": {
                    "skills": ["alpha", "stale"],
                    "playbook": [
                        {"id": "named", "title": "Named", "skills": ["stale", "alpha"]}
                    ],
                }
            },
        }
    )
    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    hub.cmd_bundle_update(
        Namespace(
            bundle_name="pack", skills="alpha,beta", description=None, icon=None,
            scope=None, source=None, detach_source=False, playbook=None, json=False,
        )
    )
    sections = _load()["bundles"]["pack"]["playbook"]
    assert sections[0]["skills"] == ["alpha"]
    assert sections[-1] == {"id": "unsectioned", "title": "", "skills": ["beta"]}


def test_playbook_duplicate_ids_and_assignments_are_rejected(tmp_data_home, monkeypatch):
    import hub

    _seed({"version": "1", "skills": {"alpha": {}}, "bundles": {"pack": {"skills": ["alpha"]}}})
    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    for payload in (
        [{"id": "x", "title": "X", "skills": []}, {"id": "x", "title": "Y", "skills": []}],
        [{"id": "x", "title": "X", "skills": ["alpha"]}, {"id": "y", "title": "Y", "skills": ["alpha"]}],
    ):
        with pytest.raises(SystemExit):
            hub.cmd_bundle_update(
                Namespace(
                    bundle_name="pack", skills=None, description=None, icon=None,
                    scope=None, source=None, detach_source=False,
                    playbook=json.dumps(payload), json=True,
                )
            )
    assert "playbook" not in _load()["bundles"]["pack"]


def test_rename_and_archive_helpers_update_section_refs_and_restore_by_id():
    from skill_hub.entrypoints.cli.archive import (
        _capture_skill_references,
        _prune_skill_references,
        _restore_skill_references,
    )

    registry = {
        "skills": {"old": {}},
        "bundles": {
            "pack": {
                "skills": ["old"],
                "playbook": [
                    {"id": "a", "title": "A", "skills": ["old"]},
                    {"id": "unsectioned", "title": "", "skills": []},
                ],
            }
        },
    }
    _prune_skill_references(registry, "old", replacement="new")
    assert registry["bundles"]["pack"]["playbook"][0]["skills"] == ["new"]
    registry["skills"] = {"new": {}}
    refs = _capture_skill_references(registry, "new")
    registry["bundles"]["pack"]["playbook"] = [
        {"id": "unsectioned", "title": "", "skills": []},
        {"id": "a", "title": "A", "skills": []},
    ]
    _prune_skill_references(registry, "new")
    _restore_skill_references(registry, "new", refs)
    assert registry["bundles"]["pack"]["playbook"][1]["skills"] == ["new"]


def test_linked_source_refresh_prunes_removed_playbook_refs_before_readd(monkeypatch):
    from skill_hub.infrastructure.registry import sources

    registry = {
        "bundles": {
            "pack": {
                "source": "org",
                "skills": ["alpha", "beta"],
                "playbook": [
                    {"id": "named", "title": "Named", "skills": ["alpha", "beta"]},
                    {"id": "unsectioned", "title": "", "skills": []},
                ],
            }
        }
    }
    owned = {"alpha", "beta"}
    monkeypatch.setattr(sources, "source_owned_skill_names", lambda _registry, _source: owned)
    assert sources.reconcile_bundle_membership(registry, "pack", "org") is None
    owned.remove("beta")
    sources.reconcile_bundle_membership(registry, "pack", "org")
    assert registry["bundles"]["pack"]["skills"] == ["alpha"]
    assert registry["bundles"]["pack"]["playbook"][0]["skills"] == ["alpha"]
    owned.add("beta")
    sources.reconcile_bundle_membership(registry, "pack", "org")
    assert registry["bundles"]["pack"]["skills"] == ["alpha", "beta"]
    assert registry["bundles"]["pack"]["playbook"][0]["skills"] == ["alpha"]
