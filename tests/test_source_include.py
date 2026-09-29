"""Tests for per-skill selection at `hub source add git` time and the
`sources.<id>.include:` filter it persists.

Covers:
  * `--decisions-stdin` payload key `selected_new` (absent ⇒ import every NEW
    candidate; present ⇒ only the listed ones; unknown names fail closed);
  * the strict-subset rule that decides whether `include:` is written at all;
  * `hub source sync` honoring `include:` (excluded arrivals are REPORTED, never
    silently registered);
  * `hub source edit --include / --include-all` and registry validation.

All Git interactions use temporary local repositories via `file://` URLs.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import hub

REPO_ROOT = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not on PATH")


# ─── helpers (mirror test_source_add.py / test_source_lifecycle.py) ─────────


def _git(*args: str, cwd: Path) -> None:
    env = os.environ.copy()
    env.update(
        GIT_TERMINAL_PROMPT="0",
        GIT_AUTHOR_NAME="test",
        GIT_AUTHOR_EMAIL="test@local",
        GIT_COMMITTER_NAME="test",
        GIT_COMMITTER_EMAIL="test@local",
    )
    res = subprocess.run(
        ["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True
    )
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {res.stderr}")


def _skill_md(name: str, description: str = "external skill") -> str:
    return f"---\nname: {name}\ndescription: {description}\nversion: 1.0.0\n---\n# {name}\n"


def _make_repo(repo_dir: Path, layout: dict[str, str]) -> Path:
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git("init", "-q", "-b", "main", ".", cwd=repo_dir)
    _git("config", "user.email", "test@local", cwd=repo_dir)
    _git("config", "user.name", "test", cwd=repo_dir)
    for rel, content in layout.items():
        target = repo_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    _git("add", ".", cwd=repo_dir)
    _git("commit", "-q", "-m", "init", cwd=repo_dir)
    return repo_dir


def _commit_changes(repo_dir: Path, changes: dict[str, str], message: str = "update") -> None:
    for rel, content in changes.items():
        target = repo_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    _git("add", "-A", cwd=repo_dir)
    _git("commit", "-q", "-m", message, cwd=repo_dir)


def _seed_code_home(tmp_data_home: Path, monkeypatch) -> Path:
    code_root = tmp_data_home.parent / f"{tmp_data_home.name}-code"
    code_root.mkdir(exist_ok=True)
    (code_root / "hub.py").write_text("# placeholder\n")
    (code_root / "skills").mkdir(exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_CODE", str(code_root))
    return code_root


def _seed_registry(tmp_data_home: Path, registry: dict | None = None) -> None:
    reg = registry or {"version": "1", "skills": {}}
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


def _run_hub_cli(
    tmp_data_home: Path,
    code_root: Path,
    args: list[str],
    stdin_data: str | None = None,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(tmp_data_home)
    env["SKILL_HUB_CODE"] = str(code_root)
    env.pop("SKILL_HUB_DIR", None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    # Fake HOME: `source sync` auto-syncs, and a harness's GLOBAL skills dir is
    # an absolute `~/.claude/skills` path — never let a test touch real dotfiles.
    fake_home = tmp_data_home.parent / f"{tmp_data_home.name}-home"
    fake_home.mkdir(parents=True, exist_ok=True)
    env["HOME"] = str(fake_home)
    env["USERPROFILE"] = str(fake_home)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        input=stdin_data,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _payload(result: subprocess.CompletedProcess) -> dict:
    """Parse the payload-first JSON object (auto-sync chatter may follow it)."""
    text = result.stdout
    start = text.find("{")
    if start < 0:
        raise AssertionError(f"no JSON payload in stdout:\n{text}\n{result.stderr}")
    obj, _end = json.JSONDecoder().raw_decode(text[start:])
    return obj


def _registry(tmp_data_home: Path) -> dict:
    return yaml.safe_load((tmp_data_home / "registry.yaml").read_text()) or {}


def _apply(
    tmp_data_home: Path,
    code_root: Path,
    repo: Path,
    stdin_payload: dict | None = None,
    source_id: str = "org-skills",
) -> subprocess.CompletedProcess:
    args = ["source", "add", "git", f"file://{repo}", "--id", source_id, "--json"]
    data = None
    if stdin_payload is not None:
        args.append("--decisions-stdin")
        data = json.dumps(stdin_payload)
    return _run_hub_cli(tmp_data_home, code_root, args, stdin_data=data)


# ─── selection at add time ─────────────────────────────────────────────────


def test_no_selected_new_registers_every_candidate(tmp_data_home, monkeypatch, tmp_path):
    """Back-compat: an apply without `selected_new` imports all NEW skills."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
            "skills/gamma/SKILL.md": _skill_md("gamma"),
        },
    )
    result = _apply(tmp_data_home, code_root, repo, {"decisions": {}})
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert sorted(payload["registered"]) == ["alpha", "beta", "gamma"]

    reg = _registry(tmp_data_home)
    assert sorted(reg["skills"]) == ["alpha", "beta", "gamma"]
    # Whole upstream taken ⇒ no filter is persisted.
    assert "include" not in reg["sources"]["org-skills"]


def test_selected_subset_registers_only_selected_and_writes_include(
    tmp_data_home, monkeypatch, tmp_path
):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
            "skills/gamma/SKILL.md": _skill_md("gamma"),
        },
    )
    result = _apply(
        tmp_data_home,
        code_root,
        repo,
        {"decisions": {}, "selected_new": ["alpha", "gamma"]},
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert sorted(payload["registered"]) == ["alpha", "gamma"]
    assert {s["name"]: s["reason"] for s in payload["skipped"]} == {
        "beta": "NOT_SELECTED"
    }

    reg = _registry(tmp_data_home)
    assert sorted(reg["skills"]) == ["alpha", "gamma"]
    assert reg["sources"]["org-skills"]["include"] == ["alpha", "gamma"]


def test_selecting_everything_writes_no_include(tmp_data_home, monkeypatch, tmp_path):
    """An explicit full selection is not a subset — the source follows upstream."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    result = _apply(
        tmp_data_home,
        code_root,
        repo,
        {"decisions": {}, "selected_new": ["alpha", "beta"]},
    )
    assert result.returncode == 0, result.stderr
    assert "include" not in _registry(tmp_data_home)["sources"]["org-skills"]


def test_unknown_selected_new_fails_closed(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(tmp_path / "remote", {"skills/alpha/SKILL.md": _skill_md("alpha")})
    result = _apply(
        tmp_data_home,
        code_root,
        repo,
        {"decisions": {}, "selected_new": ["alpha", "ghost"]},
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["ok"] is False
    assert "ghost" in payload["error"]

    # No partial write: neither the source nor any skill landed.
    reg = _registry(tmp_data_home)
    assert not reg.get("sources")
    assert not reg.get("skills")


def test_selected_new_must_be_a_list_of_names(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(tmp_path / "remote", {"skills/alpha/SKILL.md": _skill_md("alpha")})
    result = _apply(
        tmp_data_home, code_root, repo, {"decisions": {}, "selected_new": "alpha"}
    )
    assert result.returncode == 1
    assert "selected_new" in _payload(result)["error"]
    assert not _registry(tmp_data_home).get("sources")


def _seed_local_grill(tmp_data_home) -> None:
    """A locally-owned `grill` skill, so an upstream `grill` is a CONFLICT."""
    local_dir = tmp_data_home / "skills" / "grill"
    local_dir.mkdir(parents=True, exist_ok=True)
    (local_dir / "SKILL.md").write_text(_skill_md("grill", "local grill"))
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {
                "grill": {
                    "source": str(local_dir),
                    "type": "claude-skill",
                    "scope": "portable",
                    "managed": "local",
                }
            },
        },
    )


def test_skipped_conflict_alone_writes_no_include(
    tmp_data_home, monkeypatch, tmp_path
):
    """A default-skipped conflict is "not now", not "never" — no filter.

    The user made no selection at all here, so nothing was excluded on purpose.
    Persisting a filter would silently demote the conflict to "never ask again".
    """
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_local_grill(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/grill/SKILL.md": _skill_md("grill", "upstream grill"),
        },
    )
    result = _apply(tmp_data_home, code_root, repo, {"decisions": {}})
    assert result.returncode == 0, result.stderr
    assert "include" not in _registry(tmp_data_home)["sources"]["org-skills"]


def test_add_without_stdin_writes_no_include_even_with_a_conflict(
    tmp_data_home, monkeypatch, tmp_path
):
    """The plain `hub source add git` — no stdin at all — never filters."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_local_grill(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/grill/SKILL.md": _skill_md("grill", "upstream grill"),
        },
    )
    result = _apply(tmp_data_home, code_root, repo, None)
    assert result.returncode == 0, result.stderr
    assert "include" not in _registry(tmp_data_home)["sources"]["org-skills"]


def test_add_without_stdin_writes_no_include_with_an_invalid_candidate(
    tmp_data_home, monkeypatch, tmp_path
):
    """An unusable upstream NAME is not a user decision — still no filter."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/Bad Name/SKILL.md": "---\nname: Bad Name\ndescription: x\n---\n",
        },
    )
    result = _apply(tmp_data_home, code_root, repo, None)
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["counts"]["invalid"] == 1
    assert "include" not in _registry(tmp_data_home)["sources"]["org-skills"]


def test_subset_include_keeps_conflicts_and_drops_invalid_names(
    tmp_data_home, monkeypatch, tmp_path
):
    """The filter = selected NEW ∪ EVERY conflict ∪ owned — never INVALID.

    The conflict is in there even though it was skipped: it has to keep coming
    back as `new_pending` until it is actually resolved.
    """
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_local_grill(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
            "skills/grill/SKILL.md": _skill_md("grill", "upstream grill"),
            "skills/Bad Name/SKILL.md": "---\nname: Bad Name\ndescription: x\n---\n",
        },
    )
    result = _apply(
        tmp_data_home, code_root, repo, {"decisions": {}, "selected_new": ["alpha"]}
    )
    assert result.returncode == 0, result.stderr
    assert _registry(tmp_data_home)["sources"]["org-skills"]["include"] == [
        "alpha",
        "grill",
    ]


def test_subset_include_carries_already_imported_names(
    tmp_data_home, monkeypatch, tmp_path
):
    """A re-add that curates must not evict what this source already owns."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
            "skills/gamma/SKILL.md": _skill_md("gamma"),
        },
    )
    assert _apply(tmp_data_home, code_root, repo, {"decisions": {}}).returncode == 0

    # Drop the source entry only — its skills stay owned (origin.source intact),
    # so a second add sees them as IMPORTED rather than NEW.
    reg = _registry(tmp_data_home)
    reg.pop("sources", None)
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    _commit_changes(repo, {"skills/delta/SKILL.md": _skill_md("delta")}, "add delta")
    result = _apply(
        tmp_data_home, code_root, repo, {"decisions": {}, "selected_new": []}
    )
    assert result.returncode == 0, result.stderr
    assert _registry(tmp_data_home)["sources"]["org-skills"]["include"] == [
        "alpha",
        "beta",
        "gamma",
    ]


def test_selected_new_empty_writes_an_empty_include(
    tmp_data_home, monkeypatch, tmp_path
):
    """"Import none" is a real answer: `include: []`, and sync honors it."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    result = _apply(
        tmp_data_home, code_root, repo, {"decisions": {}, "selected_new": []}
    )
    assert result.returncode == 0, result.stderr
    assert _payload(result)["registered"] == []
    assert _registry(tmp_data_home)["sources"]["org-skills"]["include"] == []

    # The next sync must NOT re-import what was declined.
    sync = _run_hub_cli(
        tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]
    )
    assert sync.returncode == 0, sync.stderr
    payload = _payload(sync)
    assert payload["added"] == []
    assert sorted(payload["excluded"]) == ["alpha", "beta"]
    assert not _registry(tmp_data_home).get("skills")


def test_replaced_conflict_keeps_the_source_unfiltered(
    tmp_data_home, monkeypatch, tmp_path
):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    local_dir = tmp_data_home / "skills" / "grill"
    local_dir.mkdir(parents=True, exist_ok=True)
    (local_dir / "SKILL.md").write_text(_skill_md("grill", "local grill"))
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {
                "grill": {
                    "source": str(local_dir),
                    "type": "claude-skill",
                    "scope": "portable",
                    "managed": "local",
                }
            },
        },
    )
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/grill/SKILL.md": _skill_md("grill", "upstream grill"),
        },
    )
    result = _apply(
        tmp_data_home, code_root, repo, {"decisions": {"grill": "replace"}}
    )
    assert result.returncode == 0, result.stderr
    assert "include" not in _registry(tmp_data_home)["sources"]["org-skills"]


# ─── sync enforcement ──────────────────────────────────────────────────────


def test_sync_excludes_upstream_arrivals_outside_the_filter(
    tmp_data_home, monkeypatch, tmp_path
):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    add = _apply(
        tmp_data_home, code_root, repo, {"decisions": {}, "selected_new": ["alpha"]}
    )
    assert add.returncode == 0, add.stderr

    _commit_changes(repo, {"skills/delta/SKILL.md": _skill_md("delta")}, "add delta")
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["added"] == []
    assert sorted(payload["excluded"]) == ["beta", "delta"]

    reg = _registry(tmp_data_home)
    assert sorted(reg["skills"]) == ["alpha"]


def test_sync_registers_an_arrival_named_in_the_filter(
    tmp_data_home, monkeypatch, tmp_path
):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    add = _apply(
        tmp_data_home, code_root, repo, {"decisions": {}, "selected_new": ["alpha"]}
    )
    assert add.returncode == 0, add.stderr

    # Widen the filter, then let the named skill arrive upstream.
    edit = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "edit", "org-skills", "--include", "alpha,delta", "--json"],
    )
    assert edit.returncode == 0, edit.stderr
    _commit_changes(repo, {"skills/delta/SKILL.md": _skill_md("delta")}, "add delta")

    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["added"] == ["delta"]
    assert payload["excluded"] == ["beta"]
    assert sorted(_registry(tmp_data_home)["skills"]) == ["alpha", "delta"]


def test_sync_surfaces_conflicts_and_invalid_names_outside_the_filter(
    tmp_data_home, monkeypatch, tmp_path
):
    """The filter gates auto-registration ONLY.

    A pre-existing `include:` that does not name an upstream arrival must not
    silence it when that arrival is a CONFLICT (it still needs a decision) or an
    INVALID name (it still needs reporting). Neither is an "exclusion".
    """
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_local_grill(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    add_res = _apply(
        tmp_data_home, code_root, repo, {"decisions": {}, "selected_new": ["alpha"]}
    )
    assert add_res.returncode == 0, add_res.stderr
    assert _registry(tmp_data_home)["sources"]["org-skills"]["include"] == ["alpha"]

    _commit_changes(
        repo,
        {
            "skills/grill/SKILL.md": _skill_md("grill", "upstream grill"),
            "skills/Bad Name/SKILL.md": "---\nname: Bad Name\ndescription: x\n---\n",
        },
        "add conflict + invalid",
    )
    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)

    pending = {c["name"]: c["category"] for c in payload["new_pending"]}
    assert pending == {"grill": "CONFLICT", "Bad Name": "INVALID"}
    # Only would-be-NEW names are exclusions; an unusable name is never one.
    assert payload["excluded"] == ["beta"]
    assert payload["added"] == []


def test_sync_without_filter_still_registers_everything(
    tmp_data_home, monkeypatch, tmp_path
):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(tmp_path / "remote", {"skills/alpha/SKILL.md": _skill_md("alpha")})
    assert _apply(tmp_data_home, code_root, repo).returncode == 0
    _commit_changes(repo, {"skills/delta/SKILL.md": _skill_md("delta")}, "add delta")

    result = _run_hub_cli(
        tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"]
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["added"] == ["delta"]
    assert payload["excluded"] == []


# ─── hub source edit --include / --include-all ─────────────────────────────


def test_source_edit_include_round_trip(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    assert _apply(tmp_data_home, code_root, repo).returncode == 0

    set_res = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "edit", "org-skills", "--include", "beta, alpha", "--json"],
    )
    assert set_res.returncode == 0, set_res.stderr
    assert _payload(set_res)["source"]["include"] == ["alpha", "beta"]
    assert _registry(tmp_data_home)["sources"]["org-skills"]["include"] == [
        "alpha",
        "beta",
    ]

    clear_res = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "edit", "org-skills", "--include-all", "--json"],
    )
    assert clear_res.returncode == 0, clear_res.stderr
    assert _payload(clear_res)["source"]["include"] is None
    assert "include" not in _registry(tmp_data_home)["sources"]["org-skills"]


def test_source_edit_include_does_not_archive_owned_skills(
    tmp_data_home, monkeypatch, tmp_path
):
    """Setting a filter is forward-looking only — nothing already owned is dropped."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    assert _apply(tmp_data_home, code_root, repo).returncode == 0
    res = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "edit", "org-skills", "--include", "alpha", "--json"],
    )
    assert res.returncode == 0, res.stderr
    assert sorted(_registry(tmp_data_home)["skills"]) == ["alpha", "beta"]


def test_source_edit_rejects_invalid_include_name(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(tmp_path / "remote", {"skills/alpha/SKILL.md": _skill_md("alpha")})
    assert _apply(tmp_data_home, code_root, repo).returncode == 0
    res = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "edit", "org-skills", "--include", "Bad Name", "--json"],
    )
    assert res.returncode == 1
    assert "include" not in _registry(tmp_data_home)["sources"]["org-skills"]


def test_source_edit_requires_a_change(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(tmp_path / "remote", {"skills/alpha/SKILL.md": _skill_md("alpha")})
    assert _apply(tmp_data_home, code_root, repo).returncode == 0
    res = _run_hub_cli(tmp_data_home, code_root, ["source", "edit", "org-skills", "--json"])
    assert res.returncode == 1


def test_source_edit_name_still_works(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_repo(tmp_path / "remote", {"skills/alpha/SKILL.md": _skill_md("alpha")})
    assert _apply(tmp_data_home, code_root, repo).returncode == 0
    res = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "edit", "org-skills", "--name", "Org Skills", "--json"],
    )
    assert res.returncode == 0, res.stderr
    assert _payload(res)["source"]["name"] == "Org Skills"


# ─── unit: include helpers + registry validation ───────────────────────────


@pytest.mark.parametrize(
    "cfg",
    [
        {},
        {"include": None},
        {"include": "alpha"},
        {"include": ["", "  "]},
        {"include": ["alpha", ""]},
        {"include": ["alpha", 3]},
    ],
)
def test_source_include_names_degrades_to_none(cfg):
    """Absent or MALFORMED ⇒ no filter (permissive), never silent exclusion."""
    assert hub.source_include_names(cfg) is None


def test_source_include_names_keeps_a_well_formed_empty_list():
    """`[]` is a filter that admits nothing — collapsing it to None would
    re-import exactly the skills the user declined at add time."""
    assert hub.source_include_names({"include": []}) == []


def test_source_include_names_trims():
    assert hub.source_include_names({"include": [" alpha ", "beta"]}) == [
        "alpha",
        "beta",
    ]


def test_validate_sources_registry_accepts_include_list():
    registry = {
        "sources": {
            "org": {"type": "git", "url": "https://x/y.git", "include": ["a", "b"]}
        }
    }
    assert hub.validate_sources_registry(registry) == []


@pytest.mark.parametrize("bad", ["alpha", {"a": 1}, ["a", 3], ["a", ""]])
def test_validate_sources_registry_rejects_bad_include(bad):
    registry = {
        "sources": {"org": {"type": "git", "url": "https://x/y.git", "include": bad}}
    }
    errors = hub.validate_sources_registry(registry)
    assert any("include" in e for e in errors), errors
