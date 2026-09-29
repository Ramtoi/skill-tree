"""`@path` import parsing — the app and the CLI must agree.

The repo's standing invariant is that the Rust scanner and `agent_docs.py`
classify a project identically. Imports change what counts as an instruction
file, so leaving them app-side would let `hub sync` report a project `ok` while
the app shows an unresolved-import warning on the same file. Both
implementations are pinned against the shared corpus.
"""

import json
from pathlib import Path

import pytest

from skill_hub.infrastructure.filesystem import agent_docs

CORPUS = json.loads(
    (Path(__file__).parent / "fixtures" / "agent_docs_corpus.json").read_text()
)


@pytest.mark.parametrize("case", CORPUS["import_cases"], ids=lambda c: c["name"])
def test_parse_imports_matches_the_shared_corpus(case):
    assert agent_docs.parse_imports(case["content"]) == case["expect"]


def test_relative_targets_resolve_against_the_importing_file(tmp_path):
    agent = tmp_path / "docs" / "agent"
    agent.mkdir(parents=True)
    (agent / "rules.md").write_text("@findability.md\n")
    (agent / "findability.md").write_text("# F\n")

    out = agent_docs.resolve_import_targets(agent / "rules.md", tmp_path)
    assert out["resolved"] == [agent / "findability.md"]
    assert out["missing"] == []


def test_an_external_target_is_a_state_not_an_error(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "prefs.md").write_text("# prefs\n")
    project = tmp_path / "proj"
    project.mkdir()
    (project / "CLAUDE.md").write_text("- @~/.claude/prefs.md\n")
    monkeypatch.setenv("HOME", str(home))

    out = agent_docs.resolve_import_targets(project / "CLAUDE.md", project)
    assert out["external"] == [home / ".claude" / "prefs.md"]
    assert out["missing"] == []


def test_a_missing_target_is_reported_against_its_importer(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("@docs/agent/gone.md\n")
    assert agent_docs.unresolved_imports(tmp_path) == {
        "CLAUDE.md": ["docs/agent/gone.md"]
    }


def test_symlinked_root_twins_report_once(tmp_path):
    # The originating report exactly: AGENTS.md and AGENT.md are symlinks to CLAUDE.md.
    # Without canonical-target dedup the same miss is reported three times, and
    # which rel gets the blame depends on walk order.
    (tmp_path / "CLAUDE.md").write_text("@docs/gone.md\n")
    (tmp_path / "AGENTS.md").symlink_to("CLAUDE.md")
    (tmp_path / "AGENT.md").symlink_to("CLAUDE.md")
    assert agent_docs.unresolved_imports(tmp_path) == {"CLAUDE.md": ["docs/gone.md"]}


def test_the_graph_is_followed_transitively_and_terminates_on_a_cycle(tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (tmp_path / "CLAUDE.md").write_text("@docs/a.md\n")
    (docs / "a.md").write_text("@../CLAUDE.md\n@b.md\n")
    (docs / "b.md").write_text("@gone.md\n")

    assert agent_docs.unresolved_imports(tmp_path) == {"docs/b.md": ["gone.md"]}


def test_the_fifth_hop_is_not_followed(tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (tmp_path / "CLAUDE.md").write_text("@docs/h1.md\n")
    for i in range(1, 5):
        (docs / f"h{i}.md").write_text(f"@h{i + 1}.md\n")
    # h5 is the fourth hop and IS parsed; its own import would be the fifth.
    (docs / "h5.md").write_text("@gone.md\n")

    assert agent_docs.unresolved_imports(tmp_path) == {}


def test_detect_status_reports_unresolved_imports(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("@docs/gone.md\n")
    project = {"path": str(tmp_path), "harnesses": ["claude-code"]}
    status = agent_docs.detect_status(
        project, {"harnesses_global": []}, installed={"claude-code"}
    )
    assert status["unresolved_imports"] == {"CLAUDE.md": ["docs/gone.md"]}


def test_sync_detection_prints_an_unresolved_import(tmp_data_home, tmp_path, capsys):
    """The scenario the CLI-parity requirement names: a project whose root doc
    imports a path that does not exist is reported by `hub sync`'s agent-docs
    pass, in the same terms the app uses."""
    import hub

    project = tmp_path / "proj"
    project.mkdir()
    (project / "CLAUDE.md").write_text("@docs/agent/gone.md\n")
    registry = {
        "harnesses_global": ["claude-code"],
        "projects": {"proj": {"path": str(project)}},
    }
    hub._run_agent_docs_detection(
        registry, registry["projects"], installed={"claude-code"}
    )
    out = capsys.readouterr().out
    assert "proj: CLAUDE.md imports docs/agent/gone.md — not found" in out


def test_a_deeply_nested_doc_is_seen_by_the_cli_too(tmp_path):
    """The Rust walker lost its depth cap when the eager metadata pass it
    bounded went away. Keeping one here would classify a deep doc in the GUI
    and leave `hub sync` blind to the same directory."""
    deep = tmp_path.joinpath(*list("abcdefghi"))
    deep.mkdir(parents=True)
    (deep / "CLAUDE.md").write_text("@gone.md\n")

    assert "a/b/c/d/e/f/g/h/i" in agent_docs.discover_instruction_dirs(tmp_path)
    assert agent_docs.unresolved_imports(tmp_path) == {
        "a/b/c/d/e/f/g/h/i/CLAUDE.md": ["gone.md"]
    }


def test_claude_local_md_is_an_import_seed(tmp_path):
    """It is an `ALLOWED_BASENAMES` entry on the Rust side and seeds the graph
    there; seeding only the three older basenames here would flag its broken
    import in the app and nowhere else."""
    (tmp_path / "CLAUDE.local.md").write_text("@docs/local-rules.md\n")
    assert agent_docs.unresolved_imports(tmp_path) == {
        "CLAUDE.local.md": ["docs/local-rules.md"]
    }
    assert "" in agent_docs.discover_instruction_dirs(tmp_path)


def test_a_missing_external_target_is_not_reported(tmp_path, monkeypatch):
    """hub cannot see another machine's home directory, so a `@~/…` path absent
    here is the documented cross-worktree pattern seen from the other worktree,
    not a broken configuration."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    project = tmp_path / "proj"
    project.mkdir()
    (project / "CLAUDE.md").write_text("- @~/.claude/not-here-8f3a.md\n")

    out = agent_docs.resolve_import_targets(project / "CLAUDE.md", project)
    assert out["missing"] == []
    assert agent_docs.unresolved_imports(project) == {}


def test_unresolved_imports_stay_out_of_a_non_claude_project(tmp_path):
    (tmp_path / "AGENTS.md").write_text("@docs/gone.md\n")
    project = {"path": str(tmp_path), "harnesses": ["codex"]}
    status = agent_docs.detect_status(
        project, {"harnesses_global": []}, installed={"codex"}
    )
    assert status["unresolved_imports"] == {}
