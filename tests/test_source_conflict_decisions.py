"""Tests for `hub source add git … --decisions-stdin` (D7).

Per-conflict resolution on the source-add apply path: `skip` (default) leaves the
existing skill untouched, `replace` overwrites the entry from the source
candidate, `suffix` registers a de-duplicated `<name>-2`, an unknown action
fails-closed with no registry write, and NEW candidates still auto-register.

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


def _git(*args: str, cwd: Path) -> None:
    env = os.environ.copy()
    env.update(
        GIT_TERMINAL_PROMPT="0",
        GIT_AUTHOR_NAME="test",
        GIT_AUTHOR_EMAIL="test@local",
        GIT_COMMITTER_NAME="test",
        GIT_COMMITTER_EMAIL="test@local",
    )
    res = subprocess.run(["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True)
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


def _seed_code_home(tmp_data_home: Path, monkeypatch) -> Path:
    code_root = tmp_data_home.parent / f"{tmp_data_home.name}-code"
    code_root.mkdir(exist_ok=True)
    (code_root / "hub.py").write_text("# placeholder\n")
    (code_root / "skills").mkdir(exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_CODE", str(code_root))
    return code_root


def _seed_conflict_registry(tmp_data_home: Path) -> None:
    """Registry with a local skill `grill` that a source candidate will collide with."""
    skill_dir = hub.hub_skills_dir() / "grill"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(_skill_md("grill", "original local grill"))
    registry = {
        "version": "1",
        "skills": {
            "grill": {
                "source": str(skill_dir),
                "type": "claude-skill",
                "scope": "portable",
                "managed": "local",
            }
        },
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _run_apply(
    tmp_data_home: Path,
    code_root: Path,
    url: str,
    decisions: dict | None,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(tmp_data_home)
    env["SKILL_HUB_CODE"] = str(code_root)
    env.pop("SKILL_HUB_DIR", None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    args = ["source", "add", "git", url, "--id", "org-skills", "--json"]
    stdin_data = None
    if decisions is not None:
        args.append("--decisions-stdin")
        stdin_data = json.dumps({"decisions": decisions})
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        input=stdin_data,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _registry(tmp_data_home: Path) -> dict:
    return yaml.safe_load((tmp_data_home / "registry.yaml").read_text()) or {}


def test_conflict_replace_overwrites_entry(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_conflict_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {"skills/grill/SKILL.md": _skill_md("grill", "source grill")},
    )
    res = _run_apply(tmp_data_home, code_root, f"file://{repo}", {"grill": "replace"})
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    assert "grill" in payload["registered"]
    assert {"name": "grill", "action": "replace", "final_name": "grill"} in payload["resolved"]

    reg = _registry(tmp_data_home)
    grill = reg["skills"]["grill"]
    # Entry now points at the source cache with source provenance.
    assert grill["managed"] == "external"
    assert grill["origin"]["source"] == "org-skills"


def test_conflict_suffix_registers_new_name(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_conflict_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {"skills/grill/SKILL.md": _skill_md("grill", "source grill")},
    )
    res = _run_apply(tmp_data_home, code_root, f"file://{repo}", {"grill": "suffix"})
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    assert "grill-2" in payload["registered"]
    assert {"name": "grill", "action": "suffix", "final_name": "grill-2"} in payload["resolved"]

    reg = _registry(tmp_data_home)
    # Original untouched, new suffixed entry from the source.
    assert reg["skills"]["grill"]["managed"] == "local"
    assert reg["skills"]["grill-2"]["origin"]["source"] == "org-skills"


def test_conflict_skip_default_leaves_untouched(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_conflict_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {"skills/grill/SKILL.md": _skill_md("grill", "source grill")},
    )
    # Omitted from decisions ⇒ default skip.
    res = _run_apply(tmp_data_home, code_root, f"file://{repo}", {})
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    assert payload["registered"] == []
    assert {"name": "grill", "action": "skip", "final_name": None} in payload["resolved"]

    reg = _registry(tmp_data_home)
    assert reg["skills"]["grill"]["managed"] == "local"
    assert "grill-2" not in reg["skills"]


def test_unknown_action_aborts_no_write(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_conflict_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/grill/SKILL.md": _skill_md("grill", "source grill"),
            "skills/fresh/SKILL.md": _skill_md("fresh"),
        },
    )
    res = _run_apply(tmp_data_home, code_root, f"file://{repo}", {"grill": "obliterate"})
    assert res.returncode != 0
    combined = (res.stdout + res.stderr).lower()
    assert "obliterate" in combined
    # Fail-closed: NO registry write — the source was never registered and the
    # NEW `fresh` candidate was not staged.
    reg = _registry(tmp_data_home)
    assert "org-skills" not in (reg.get("sources") or {})
    assert "fresh" not in reg["skills"]
    assert reg["skills"]["grill"]["managed"] == "local"


def test_new_candidates_still_register_with_decisions(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_conflict_registry(tmp_data_home)
    repo = _make_repo(
        tmp_path / "remote",
        {
            "skills/grill/SKILL.md": _skill_md("grill", "source grill"),
            "skills/fresh/SKILL.md": _skill_md("fresh"),
        },
    )
    res = _run_apply(tmp_data_home, code_root, f"file://{repo}", {"grill": "skip"})
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    # NEW candidate auto-registers regardless of the conflict decision.
    assert "fresh" in payload["registered"]
    assert _registry(tmp_data_home)["skills"]["fresh"]["origin"]["source"] == "org-skills"
