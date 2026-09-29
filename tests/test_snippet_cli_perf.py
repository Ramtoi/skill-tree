"""`hub snippet list`/`show` must scan the project tree at most once per call.

Before this fix `cmd_snippet_list` called `snippets.snippet_usage()` (which
walks every registered project's agent docs) once PER SNIPPET. These tests
pin the "one walk" contract with a counting monkeypatch of `scan_all`, and
the `--no-usage` fast path that skips the walk entirely.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import yaml

from skill_hub.infrastructure.filesystem import snippets

BODY = "## Validation\n\n1. Build.\n2. Test.\n"


def _setup(tmp_data_home: Path):
    """3 snippets, 2 registered projects, one snippet applied to one project."""
    proj_a = tmp_data_home / "proj-a"
    proj_b = tmp_data_home / "proj-b"
    proj_a.mkdir()
    proj_b.mkdir()
    (proj_a / "AGENTS.md").write_text("# A\n")
    (proj_b / "AGENTS.md").write_text("# B\n")
    (tmp_data_home / "registry.yaml").write_text(
        yaml.dump(
            {
                "harnesses_global": [],
                "projects": {
                    "a": {"path": str(proj_a)},
                    "b": {"path": str(proj_b)},
                },
            }
        )
    )
    sdir = snippets.snippets_dir(tmp_data_home)
    snippets.create_snippet(sdir, "applied-one", body=BODY)
    snippets.create_snippet(sdir, "unused-one", body="## Other\n")
    snippets.create_snippet(sdir, "unused-two", body="## Third\n")
    library = snippets.library_by_name(sdir)
    registry = {"projects": {"a": {"path": str(proj_a)}, "b": {"path": str(proj_b)}}}
    snippets.apply_snippet(
        registry, library, tmp_data_home / "_hub-backups", "applied-one", "a", rel="AGENTS.md"
    )
    return proj_a, proj_b, sdir


def _counting_scan_all(monkeypatch):
    calls = {"n": 0}
    real = snippets.scan_all

    def wrapper(registry, library):
        calls["n"] += 1
        return real(registry, library)

    monkeypatch.setattr(snippets, "scan_all", wrapper)
    return calls


def test_list_scans_the_tree_exactly_once(tmp_data_home, capsys, monkeypatch):
    import hub

    _setup(tmp_data_home)
    calls = _counting_scan_all(monkeypatch)

    hub.cmd_snippet_list(SimpleNamespace(tag=None, query=None, no_usage=False, json=True))

    assert calls["n"] == 1
    rows = json.loads(capsys.readouterr().out)
    by_name = {r["name"]: r for r in rows}
    assert by_name["applied-one"]["usage"]["count"] == 1
    assert by_name["applied-one"]["usage"]["summary"] == "applied"
    assert by_name["unused-one"]["usage"]["count"] == 0
    assert by_name["unused-two"]["usage"]["count"] == 0


def test_list_no_usage_skips_the_scan_entirely(tmp_data_home, capsys, monkeypatch):
    import hub

    _setup(tmp_data_home)
    calls = _counting_scan_all(monkeypatch)

    hub.cmd_snippet_list(SimpleNamespace(tag=None, query=None, no_usage=True, json=True))

    assert calls["n"] == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows  # snippets were still listed
    for r in rows:
        assert "usage" not in r


def test_show_no_usage_skips_the_scan_and_omits_usage(tmp_data_home, capsys, monkeypatch):
    import hub

    _setup(tmp_data_home)
    calls = _counting_scan_all(monkeypatch)

    hub.cmd_snippet_show(
        SimpleNamespace(name="applied-one", no_usage=True, json=True)
    )

    assert calls["n"] == 0
    payload = json.loads(capsys.readouterr().out)
    assert "usage" not in payload
    assert payload["name"] == "applied-one"


def test_show_with_usage_still_works(tmp_data_home, capsys, monkeypatch):
    import hub

    _setup(tmp_data_home)
    calls = _counting_scan_all(monkeypatch)

    hub.cmd_snippet_show(
        SimpleNamespace(name="applied-one", no_usage=False, json=True)
    )

    assert calls["n"] == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["usage"]["count"] == 1


# ─── TA-1-e64c: argv-layer smoke case, so a removed/broken parser reds here ──


def test_snippet_list_reached_through_hub_main_argv(tmp_data_home, monkeypatch, capsys):
    """`hub snippet list --json` must be reachable through the real argparse
    dispatch table, not only through a hand-built Namespace."""
    import sys

    import hub

    _setup(tmp_data_home)
    monkeypatch.setattr(sys, "argv", ["hub", "snippet", "list", "--json"])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    rows = json.loads(capsys.readouterr().out)
    assert code == 0
    assert any(r["name"] == "applied-one" for r in rows)
