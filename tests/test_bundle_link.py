"""Tests for source-linked bundles (`bundles.<n>.source`).

A linked bundle FOLLOWS a git source: every `hub source sync <id>` rewrites its
membership to exactly what that source owns (retained skills keep their order,
new arrivals are appended sorted), and manual `--skills` edits are refused until
the bundle is detached.

The suite mirrors `test_source_lifecycle.py`: hermetic local git repos, no
network, and a faked `$HOME` on every CLI invocation — `source sync` and the
bundle verbs auto-sync, and sync resolves user-global harness paths off `$HOME`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git not on PATH"
)


# ─── helpers (mirror test_source_lifecycle.py) ─────────────────────────────


def _git(*args: str, cwd: Path) -> None:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_AUTHOR_NAME"] = "test"
    env["GIT_AUTHOR_EMAIL"] = "test@local"
    env["GIT_COMMITTER_NAME"] = "test"
    env["GIT_COMMITTER_EMAIL"] = "test@local"
    res = subprocess.run(
        ["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True
    )
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {res.stderr}")


def _skill_md(name: str, description: str = "tested external skill", version: str = "1.0.0") -> str:
    return f"---\nname: {name}\ndescription: {description}\nversion: {version}\n---\n# {name}\n"


def _make_local_repo(repo_dir: Path, layout: dict, branch: str = "main") -> Path:
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git("init", "-q", "-b", branch, ".", cwd=repo_dir)
    _git("config", "user.email", "test@local", cwd=repo_dir)
    _git("config", "user.name", "test", cwd=repo_dir)
    for rel, content in layout.items():
        target = repo_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    _git("add", ".", cwd=repo_dir)
    _git("commit", "-q", "-m", "init", cwd=repo_dir)
    return repo_dir


def _commit_changes(repo_dir: Path, changes: dict, message: str = "update") -> None:
    for rel, content in changes.items():
        target = repo_dir / rel
        if content is None:
            if target.exists():
                target.unlink()
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
    _git("add", "-A", cwd=repo_dir)
    _git("commit", "-q", "-m", message, cwd=repo_dir)


def _seed_registry(tmp_data_home: Path, registry: dict | None = None) -> Path:
    reg = registry or {"version": "1", "skills": {}}
    reg_path = tmp_data_home / "registry.yaml"
    reg_path.write_text(yaml.safe_dump(reg, sort_keys=False))
    return reg_path


def _seed_code_home(tmp_data_home: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    code_root = tmp_data_home.parent / f"{tmp_data_home.name}-code"
    code_root.mkdir(exist_ok=True)
    (code_root / "hub.py").write_text("# placeholder\n")
    (code_root / "skills").mkdir(exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_CODE", str(code_root))
    return code_root


def _run_hub_cli(tmp_data_home: Path, code_root: Path, args: list) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(tmp_data_home)
    env["SKILL_HUB_CODE"] = str(code_root)
    env.pop("SKILL_HUB_DIR", None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    # SAFETY: every command here may auto-sync, and sync resolves user-global
    # harness paths off $HOME. Never let a test reach the real dotfiles.
    fake_home = tmp_data_home.parent / f"{tmp_data_home.name}-home"
    fake_home.mkdir(exist_ok=True)
    env["HOME"] = str(fake_home)
    repo_root = Path(__file__).resolve().parent.parent
    return subprocess.run(
        [sys.executable, str(repo_root / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(repo_root),
    )


def _payload(result: subprocess.CompletedProcess) -> dict:
    """Parse the payload-first JSON object (auto-sync chatter may follow it)."""
    text = result.stdout
    start = text.find("{")
    if start < 0:
        raise AssertionError(f"no JSON payload in stdout:\n{text}")
    obj, _end = json.JSONDecoder().raw_decode(text[start:])
    return obj


def _add_git_source(tmp_data_home: Path, code_root: Path, repo: Path, source_id: str = "org-skills") -> dict:
    result = _run_hub_cli(
        tmp_data_home, code_root,
        ["source", "add", "git", f"file://{repo}", "--id", source_id, "--json"],
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _load_registry(tmp_data_home: Path) -> dict:
    with open(tmp_data_home / "registry.yaml") as f:
        return yaml.safe_load(f) or {}


def _write_registry(tmp_data_home: Path, reg: dict) -> None:
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


@pytest.fixture
def source_env(tmp_data_home, monkeypatch, tmp_path):
    """A configured git source owning `alpha` + `beta`."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/alpha/SKILL.md": _skill_md("alpha"),
            "skills/beta/SKILL.md": _skill_md("beta"),
        },
    )
    _add_git_source(tmp_data_home, code_root, repo)
    return tmp_data_home, code_root, repo


# ─── B: hub bundle new --source / --json ───────────────────────────────────


def test_bundle_new_json_links_source(source_env):
    data_home, code_root, _repo = source_env

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "beta,alpha",
         "--description", "org pack", "--icon", "🧰",
         "--source", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["created"] is True
    assert payload["errors"] == []
    assert payload["bundle"] == {
        "name": "pack",
        "skills": ["beta", "alpha"],
        "description": "org pack",
        "icon": "🧰",
        "scope": "project-specific",
        "source": "org-skills",
    }

    reg = _load_registry(data_home)
    assert reg["bundles"]["pack"]["source"] == "org-skills"


def test_bundle_new_source_reconciles_and_warns_about_non_owned_skills(source_env):
    """Linking GATES at creation: a skill the source doesn't own is dropped
    right away, loudly — not silently wiped by the first later sync."""
    data_home, code_root, _repo = source_env
    reg = _load_registry(data_home)
    reg["skills"]["homegrown"] = {
        "version": "1.0.0",
        "description": "local",
        "source": str(data_home / "skills" / "homegrown"),
        "type": "claude-skill",
        "scope": "portable",
        "managed": "local",
    }
    _write_registry(data_home, reg)

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha,homegrown",
         "--source", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["created"] is True
    # Reconciled AT CREATION: retained order kept, arrivals appended, the
    # non-owned skill dropped.
    assert payload["bundle"]["skills"] == ["alpha", "beta"]
    assert len(payload["warnings"]) == 1
    assert "dropped ['homegrown']" in payload["warnings"][0]
    assert "warning:" in result.stderr and "homegrown" in result.stderr
    assert _load_registry(data_home)["bundles"]["pack"]["skills"] == ["alpha", "beta"]


def test_bundle_new_source_without_adjustment_has_no_warning(source_env):
    data_home, code_root, _repo = source_env
    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha,beta", "--source", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    assert _payload(result)["warnings"] == []


def test_bundle_new_global_scope_linked_warns(source_env):
    """A global linked bundle rewrites EVERY project's loadout on each sync."""
    data_home, code_root, _repo = source_env
    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha,beta", "--scope", "global",
         "--source", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    warnings = _payload(result)["warnings"]
    assert len(warnings) == 1
    assert "scope 'global'" in warnings[0]
    assert "EVERY project" in warnings[0]
    assert "scope 'global'" in result.stderr


def test_bundle_update_global_scope_link_warns(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--scope", "global"],
    ).returncode == 0

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "update", "pack", "--source", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    warnings = _payload(result)["warnings"]
    assert any("scope 'global'" in w for w in warnings)


def test_bundle_new_portable_scope_is_recorded(source_env):
    """`portable` is a valid bundle scope, recorded like any other."""
    data_home, code_root, _repo = source_env
    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--scope", "portable", "--json"],
    )
    assert result.returncode == 0, result.stderr
    assert _payload(result)["bundle"]["scope"] == "portable"
    assert _load_registry(data_home)["bundles"]["pack"]["scope"] == "portable"


def test_bundle_new_invalid_scope_fails(source_env):
    """`--scope` is argparse-gated by VALID_BUNDLE_SCOPES, so an unknown value
    is rejected before `parse_bundle_scope` ever runs (argparse "invalid
    choice", not the "Invalid bundle scope" runtime message — that message
    guards non-CLI paths, e.g. a hand-edited registry.yaml)."""
    data_home, code_root, _repo = source_env
    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--scope", "bogus"],
    )
    assert result.returncode != 0
    assert "invalid choice: 'bogus'" in result.stderr
    assert "portable" in result.stderr


def test_bundle_new_json_payload_is_first_line_before_sync_chatter(source_env):
    """The payload must survive the auto-sync log that follows it on stdout."""
    data_home, code_root, _repo = source_env

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--json"],
    )
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert json.loads(lines[0])["created"] is True
    # Auto-sync really did run and really did write chatter after the payload.
    assert len(lines) > 1
    assert "sync" in result.stdout.lower()


def test_bundle_new_json_unknown_skill_fails(source_env):
    data_home, code_root, _repo = source_env

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "ghost", "--json"],
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["bundle"] is None
    assert len(payload["errors"]) == 1
    assert "ghost" in payload["errors"][0]
    assert "pack" not in (_load_registry(data_home).get("bundles") or {})


def test_bundle_new_rejects_unknown_source(source_env):
    data_home, code_root, _repo = source_env

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--source", "nope", "--json"],
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["bundle"] is None
    assert "unknown source 'nope'" in payload["errors"][0]
    assert "pack" not in (_load_registry(data_home).get("bundles") or {})


@pytest.mark.parametrize("builtin", ["local", "starter"])
def test_bundle_new_rejects_builtin_source(source_env, builtin):
    data_home, code_root, _repo = source_env

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--source", builtin, "--json"],
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["bundle"] is None
    assert "built-in" in payload["errors"][0]
    assert "pack" not in (_load_registry(data_home).get("bundles") or {})


# ─── A: source sync reconciles linked bundles ──────────────────────────────


def test_linked_bundle_follows_source_add_and_remove(source_env):
    data_home, code_root, repo = source_env
    # Deliberately non-alphabetical, so order preservation is observable.
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "beta,alpha", "--source", "org-skills"],
    ).returncode == 0

    _commit_changes(
        repo,
        {"skills/alpha/SKILL.md": None, "skills/gamma/SKILL.md": _skill_md("gamma")},
        "swap alpha for gamma",
    )

    result = _run_hub_cli(data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["added"] == ["gamma"]
    assert payload["removed_upstream"] == ["alpha"]
    assert payload["bundle_updates"] == [
        {"bundle": "pack", "added": ["gamma"], "removed": ["alpha"]}
    ]

    reg = _load_registry(data_home)
    # Retained order preserved; the arrival is appended.
    assert reg["bundles"]["pack"]["skills"] == ["beta", "gamma"]
    assert reg["bundles"]["pack"]["source"] == "org-skills"
    # The dropped skill is NOT deleted from the registry, only flagged.
    assert reg["skills"]["alpha"]["source_missing"] is True


def test_linked_bundle_regains_restored_skill(source_env):
    data_home, code_root, repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "beta,alpha", "--source", "org-skills"],
    ).returncode == 0

    _commit_changes(repo, {"skills/alpha/SKILL.md": None}, "drop alpha")
    assert _run_hub_cli(data_home, code_root, ["source", "sync", "org-skills"]).returncode == 0
    assert _load_registry(data_home)["bundles"]["pack"]["skills"] == ["beta"]

    _commit_changes(repo, {"skills/alpha/SKILL.md": _skill_md("alpha")}, "restore alpha")
    result = _run_hub_cli(data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["bundle_updates"] == [
        {"bundle": "pack", "added": ["alpha"], "removed": []}
    ]

    reg = _load_registry(data_home)
    assert reg["bundles"]["pack"]["skills"] == ["beta", "alpha"]
    assert "source_missing" not in reg["skills"]["alpha"]


def test_unlinked_bundle_is_not_reconciled(source_env):
    data_home, code_root, repo = source_env
    assert _run_hub_cli(
        data_home, code_root, ["bundle", "new", "pack", "--skills", "alpha"]
    ).returncode == 0

    _commit_changes(repo, {"skills/gamma/SKILL.md": _skill_md("gamma")}, "add gamma")
    result = _run_hub_cli(data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    assert _payload(result)["bundle_updates"] == []
    assert _load_registry(data_home)["bundles"]["pack"]["skills"] == ["alpha"]


def test_dedupe_only_reconcile_reports_no_bundle_update(source_env):
    """A duplicate-only cleanup writes the deduped list but is not a delta."""
    import hub

    data_home, _code_root, _repo = source_env
    registry = _load_registry(data_home)
    registry["bundles"] = {
        "pack": {
            "description": "",
            "icon": "📦",
            "scope": "project-specific",
            "skills": ["alpha", "beta", "alpha"],
            "source": "org-skills",
        }
    }

    assert hub.reconcile_bundle_membership(registry, "pack", "org-skills") is None
    assert registry["bundles"]["pack"]["skills"] == ["alpha", "beta"]
    assert hub.reconcile_linked_bundles(registry, "org-skills") == []


def test_linked_bundle_with_unknown_source_is_skipped(source_env):
    """A dangling `source:` link warns instead of exploding."""
    import hub

    data_home, code_root, _repo = source_env
    reg = _load_registry(data_home)
    reg["bundles"] = {"ghost-pack": {"skills": ["alpha"], "source": "gone"}}
    _write_registry(data_home, reg)

    registry = _load_registry(data_home)
    assert hub.reconcile_linked_bundles(registry, "gone") == []
    assert registry["bundles"]["ghost-pack"]["skills"] == ["alpha"]


# ─── C: hub bundle update --source / --detach-source ───────────────────────


def test_bundle_update_skills_refused_on_linked_bundle(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--source", "org-skills"],
    ).returncode == 0

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "update", "pack", "--skills", "alpha,beta", "--json"],
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["bundle"] is None
    assert payload["errors"] == [
        "bundle 'pack' follows source 'org-skills' — its skill list is managed; "
        "use --detach-source first"
    ]
    # Creation already reconciled the linked bundle to the source's skills.
    assert _load_registry(data_home)["bundles"]["pack"]["skills"] == ["alpha", "beta"]


def test_bundle_update_metadata_allowed_on_linked_bundle(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--source", "org-skills"],
    ).returncode == 0

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "update", "pack", "--description", "renamed", "--icon", "🚀", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["changed"] is True
    assert payload["bundle"]["description"] == "renamed"
    assert payload["bundle"]["icon"] == "🚀"
    assert payload["bundle"]["source"] == "org-skills"


def test_bundle_update_detach_then_skills(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--source", "org-skills"],
    ).returncode == 0

    detached = _run_hub_cli(
        data_home, code_root, ["bundle", "update", "pack", "--detach-source", "--json"]
    )
    assert detached.returncode == 0, detached.stderr
    payload = _payload(detached)
    assert payload["changed"] is True
    assert payload["bundle"]["source"] is None
    # Detaching keeps the membership it had while linked.
    assert payload["bundle"]["skills"] == ["alpha", "beta"]
    assert "source" not in _load_registry(data_home)["bundles"]["pack"]

    edited = _run_hub_cli(
        data_home, code_root,
        ["bundle", "update", "pack", "--skills", "beta,alpha", "--json"],
    )
    assert edited.returncode == 0, edited.stderr
    assert _payload(edited)["bundle"]["skills"] == ["beta", "alpha"]


def test_bundle_update_source_links_and_reconciles_now(source_env):
    data_home, code_root, _repo = source_env
    # A hand-made bundle holding one source skill plus a local one.
    reg = _load_registry(data_home)
    reg["skills"]["homegrown"] = {
        "version": "1.0.0",
        "description": "local",
        "source": str(data_home / "skills" / "homegrown"),
        "type": "claude-skill",
        "scope": "portable",
        "managed": "local",
    }
    reg["bundles"] = {
        "pack": {
            "description": "",
            "icon": "📦",
            "scope": "project-specific",
            "skills": ["alpha", "homegrown"],
        }
    }
    _write_registry(data_home, reg)

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "update", "pack", "--source", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = _payload(result)
    assert payload["bundle"]["source"] == "org-skills"
    # Linking reconciles immediately: retained order kept, arrivals appended,
    # non-owned members dropped.
    assert payload["bundle"]["skills"] == ["alpha", "beta"]
    assert _load_registry(data_home)["bundles"]["pack"]["skills"] == ["alpha", "beta"]


def test_bundle_update_source_and_detach_conflict(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root, ["bundle", "new", "pack", "--skills", "alpha"]
    ).returncode == 0

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "update", "pack", "--source", "org-skills", "--detach-source", "--json"],
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["bundle"] is None
    assert "mutually exclusive" in payload["errors"][0]
    assert "source" not in _load_registry(data_home)["bundles"]["pack"]


def test_bundle_update_source_with_skills_rejected(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root, ["bundle", "new", "pack", "--skills", "alpha"]
    ).returncode == 0

    result = _run_hub_cli(
        data_home, code_root,
        ["bundle", "update", "pack", "--source", "org-skills", "--skills", "beta", "--json"],
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["bundle"] is None
    assert "--skills cannot be combined with --source" in payload["errors"][0]
    reg = _load_registry(data_home)
    assert "source" not in reg["bundles"]["pack"]
    assert reg["bundles"]["pack"]["skills"] == ["alpha"]


def test_bundle_update_detach_on_unlinked_bundle_is_honest(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root, ["bundle", "new", "pack", "--skills", "alpha"]
    ).returncode == 0

    result = _run_hub_cli(
        data_home, code_root, ["bundle", "update", "pack", "--detach-source"]
    )
    assert result.returncode == 0, result.stderr
    assert "was not linked to a source" in result.stdout
    assert "detached from source" not in result.stdout

    as_json = _run_hub_cli(
        data_home, code_root, ["bundle", "update", "pack", "--detach-source", "--json"]
    )
    assert _payload(as_json)["changed"] is False


def test_bundle_update_unknown_bundle_json(source_env):
    data_home, code_root, _repo = source_env
    result = _run_hub_cli(
        data_home, code_root, ["bundle", "update", "ghost", "--description", "x", "--json"]
    )
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["bundle"] is None
    assert "ghost" in payload["errors"][0]


def test_bundle_update_no_op_reports_unchanged(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root, ["bundle", "new", "pack", "--skills", "alpha"]
    ).returncode == 0

    result = _run_hub_cli(data_home, code_root, ["bundle", "update", "pack", "--json"])
    assert result.returncode == 0, result.stderr
    assert _payload(result)["changed"] is False


# ─── D: hub bundle delete --json ───────────────────────────────────────────


def test_bundle_delete_json(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root, ["bundle", "new", "pack", "--skills", "alpha"]
    ).returncode == 0

    result = _run_hub_cli(data_home, code_root, ["bundle", "delete", "pack", "--json"])
    assert result.returncode == 0, result.stderr
    assert _payload(result) == {"deleted": "pack", "errors": []}
    assert "pack" not in (_load_registry(data_home).get("bundles") or {})


def test_bundle_delete_json_unknown(source_env):
    data_home, code_root, _repo = source_env
    result = _run_hub_cli(data_home, code_root, ["bundle", "delete", "ghost", "--json"])
    assert result.returncode == 1
    payload = _payload(result)
    assert payload["deleted"] is None
    assert "ghost" in payload["errors"][0]


# ─── E: source remove drops the link ───────────────────────────────────────


@pytest.mark.parametrize("mode", ["unequip", "keep-local"])
def test_source_remove_unlinks_bundles(source_env, mode):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha,beta", "--source", "org-skills"],
    ).returncode == 0

    preview = _run_hub_cli(
        data_home, code_root, ["source", "remove", "org-skills", "--dry-run", "--json"]
    )
    assert preview.returncode == 0, preview.stderr
    assert _payload(preview)["impact"]["unlinked_bundles"] == ["pack"]

    result = _run_hub_cli(
        data_home, code_root, ["source", "remove", "org-skills", "--mode", mode, "--json"]
    )
    assert result.returncode == 0, result.stderr
    assert _payload(result)["impact"]["unlinked_bundles"] == ["pack"]

    bundle = _load_registry(data_home)["bundles"]["pack"]
    assert "source" not in bundle
    # unequip scrubs membership; keep-local converts the skills and keeps it.
    assert bundle["skills"] == ([] if mode == "unequip" else ["alpha", "beta"])


def test_source_remove_human_output_names_unlinked_bundles(source_env):
    data_home, code_root, _repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha,beta", "--source", "org-skills"],
    ).returncode == 0

    preview = _run_hub_cli(
        data_home, code_root, ["source", "remove", "org-skills", "--dry-run"]
    )
    assert preview.returncode == 0, preview.stderr
    assert "would unlink" in preview.stdout and "pack" in preview.stdout

    result = _run_hub_cli(
        data_home, code_root, ["source", "remove", "org-skills", "--mode", "keep-local"]
    )
    assert result.returncode == 0, result.stderr
    assert "unlinked bundles: pack" in result.stdout


# ─── audit ─────────────────────────────────────────────────────────────────


def test_source_sync_writes_an_audit_record(source_env):
    """`source sync` mutates the registry, so it carries the mutation wrapper."""
    data_home, code_root, repo = source_env
    _commit_changes(repo, {"skills/gamma/SKILL.md": _skill_md("gamma")}, "add gamma")

    result = _run_hub_cli(data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr

    records = [
        json.loads(line)
        for line in (data_home / "state" / "audit.jsonl").read_text().splitlines()
        if line.strip()
    ]
    synced = [r for r in records if r["verb"] == "source-sync"]
    assert len(synced) == 1
    assert synced[0]["target"] == {"id": "org-skills"}
    assert synced[0]["changed"] is True


# ─── loadout materialization ───────────────────────────────────────────────


def test_linked_membership_change_materializes_project_symlinks(
    source_env, monkeypatch
):
    """A linked-bundle membership change must reach project symlinks with no
    separate `hub sync` — `cmd_source_sync` auto-syncs like every other
    registry mutation."""
    import dataclasses

    import hub
    from skill_hub.infrastructure.harnesses import harnesses

    data_home, code_root, repo = source_env
    assert _run_hub_cli(
        data_home, code_root,
        ["bundle", "new", "pack", "--skills", "alpha", "--source", "org-skills"],
    ).returncode == 0

    proj_path = data_home / "projects" / "demo"
    proj_path.mkdir(parents=True)
    reg = _load_registry(data_home)
    reg["harnesses_global"] = []
    reg["projects"] = {
        "demo": {
            "path": str(proj_path),
            "bundles": ["pack"],
            "enabled": [],
            "harnesses": ["claude-code"],
        }
    }
    _write_registry(data_home, reg)

    # Force harnesses "installed", keep every global dir inside the tmp home,
    # and stub the permission/hook streams (they resolve real user paths).
    fake_global = data_home / "fake-globals"
    fake_global.mkdir()
    patched = {
        h_id: dataclasses.replace(
            h,
            detect=(lambda: True),
            global_skills_dir=type(h.global_skills_dir)(
                str(fake_global / h_id / "skills")
            ),
        )
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    monkeypatch.setattr(hub, "_run_permissions_stream", lambda *a, **k: 0)
    monkeypatch.setattr(hub, "_run_hooks_stream", lambda *a, **k: 0)

    # Baseline: one explicit sync materializes the bundle as it stands today.
    skills_dir = proj_path / ".claude" / "skills"
    hub.cmd_sync(argparse.Namespace())
    assert (skills_dir / "alpha").is_symlink()
    assert (skills_dir / "beta").is_symlink()

    _commit_changes(
        repo,
        {"skills/alpha/SKILL.md": None, "skills/gamma/SKILL.md": _skill_md("gamma")},
        "swap alpha for gamma",
    )
    hub.cmd_source_sync(argparse.Namespace(id="org-skills", json=False))

    assert _load_registry(data_home)["bundles"]["pack"]["skills"] == ["beta", "gamma"]
    assert (skills_dir / "gamma").is_symlink()
    assert (skills_dir / "beta").is_symlink()
    assert not (skills_dir / "alpha").exists()
