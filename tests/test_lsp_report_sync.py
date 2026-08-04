"""Tests for lsp_report_sync — per-scope config materialization + interpreter
baking (hooks-surface tasks 4.2–4.3)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

import lsp_report_sync
from hooks_model import ResolvedHook
from permissions import GlobalScope, ProjectScope


def _lsp_hook(settings=None, name="lsp-report"):
    return ResolvedHook(
        name=name,
        event="PostToolUse",
        command="python3 lsp_report.py --config lsp-report.json",
        tools=["Edit", "Write", "MultiEdit"],
        matcher="",
        timeout=None,
        harnesses=None,
        settings=settings
        if settings is not None
        else {
            "languages": {
                "python": {"enabled": True, "mode": "advisory", "timeout": 30},
                "go": {"enabled": True, "mode": "advisory", "timeout": 30},
            }
        },
        provenance="builtin",
    )


# ─────────────────────────────────────────────────────────────────────────────
# materialize_lsp_report
# ─────────────────────────────────────────────────────────────────────────────


def test_materialize_writes_expected_config_shape(tmp_path):
    hook = _lsp_hook()
    path = lsp_report_sync.materialize_lsp_report(hook, "global", tmp_path)
    assert path == tmp_path / "state" / "hooks" / "lsp-report.global.json"
    data = json.loads(path.read_text())
    # The shape risks.py reads: settings.languages.<lang>.enabled
    assert data["languages"]["python"]["enabled"] is True
    assert data["languages"]["python"]["mode"] == "advisory"
    assert data["languages"]["go"]["enabled"] is True


def test_materialize_uses_scope_slug_in_filename(tmp_path):
    hook = _lsp_hook()
    scope = ProjectScope(name="acme", path="/tmp/acme")
    path = lsp_report_sync.materialize_lsp_report(hook, scope.slug, tmp_path)
    assert path.name == "lsp-report.project-acme.json"


def test_materialize_serializes_project_override(tmp_path):
    # Project enabled typescript in blocking mode — the merged settings arrive
    # already deep-merged; materialize just serializes them.
    settings = {
        "languages": {
            "typescript": {"enabled": True, "mode": "blocking", "timeout": 60},
        }
    }
    hook = _lsp_hook(settings=settings)
    path = lsp_report_sync.materialize_lsp_report(hook, "project-x", tmp_path)
    data = json.loads(path.read_text())
    assert data["languages"]["typescript"] == {
        "enabled": True,
        "mode": "blocking",
        "timeout": 60,
    }


def test_materialize_is_noop_on_unchanged_content(tmp_path, monkeypatch):
    hook = _lsp_hook()
    calls: list[Path] = []
    orig = lsp_report_sync._atomic_replace

    def spy(target, content):
        calls.append(target)
        orig(target, content)

    monkeypatch.setattr(lsp_report_sync, "_atomic_replace", spy)
    lsp_report_sync.materialize_lsp_report(hook, "global", tmp_path)
    lsp_report_sync.materialize_lsp_report(hook, "global", tmp_path)
    assert len(calls) == 1  # second call unchanged → no rewrite


def test_materialize_atomic_write_no_temp_leftover(tmp_path):
    hook = _lsp_hook()
    lsp_report_sync.materialize_lsp_report(hook, "global", tmp_path)
    hooks_dir = tmp_path / "state" / "hooks"
    leftovers = [p for p in hooks_dir.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_materialize_guarantees_languages_key(tmp_path):
    hook = _lsp_hook(settings={})  # settings with no languages
    path = lsp_report_sync.materialize_lsp_report(hook, "global", tmp_path)
    data = json.loads(path.read_text())
    assert data["languages"] == {}


# ─────────────────────────────────────────────────────────────────────────────
# resolve_lsp_interpreter precedence (mirrors detect_python)
# ─────────────────────────────────────────────────────────────────────────────


def test_interpreter_precedence_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("SKILL_TREE_PYTHON", "/custom/python3")
    assert lsp_report_sync.resolve_lsp_interpreter(tmp_path) == "/custom/python3"


def test_interpreter_precedence_bundled_runtime(monkeypatch, tmp_path):
    monkeypatch.delenv("SKILL_TREE_PYTHON", raising=False)
    # Packaged layout: code_home = Contents/Resources/hub; bundled python sits at
    # Contents/Resources/python/bin/python3.
    contents = tmp_path / "Contents" / "Resources"
    code_home = contents / "hub"
    code_home.mkdir(parents=True)
    py_bin = contents / "python" / "bin"
    py_bin.mkdir(parents=True)
    bundled = py_bin / "python3"
    bundled.write_text("#!/bin/sh\n")
    got = lsp_report_sync.resolve_lsp_interpreter(code_home)
    assert got == str(bundled)


def test_interpreter_precedence_bundled_versioned_fallback(monkeypatch, tmp_path):
    monkeypatch.delenv("SKILL_TREE_PYTHON", raising=False)
    contents = tmp_path / "Contents" / "Resources"
    code_home = contents / "hub"
    code_home.mkdir(parents=True)
    py_bin = contents / "python" / "bin"
    py_bin.mkdir(parents=True)
    # No plain `python3` symlink survived; a version-qualified binary is present.
    (py_bin / "python3.12").write_text("#!/bin/sh\n")
    (py_bin / "python3.12-config").write_text("#!/bin/sh\n")  # must be ignored
    got = lsp_report_sync.resolve_lsp_interpreter(code_home)
    assert got == str(py_bin / "python3.12")


def test_interpreter_precedence_system_fallback(monkeypatch, tmp_path):
    monkeypatch.delenv("SKILL_TREE_PYTHON", raising=False)
    monkeypatch.setattr(
        lsp_report_sync.shutil,
        "which",
        lambda name: "/usr/bin/python3" if name == "python3" else None,
    )
    # code_home with no bundled runtime → system probe.
    got = lsp_report_sync.resolve_lsp_interpreter(tmp_path)
    assert got == "/usr/bin/python3"


def test_interpreter_precedence_final_sys_executable(monkeypatch, tmp_path):
    monkeypatch.delenv("SKILL_TREE_PYTHON", raising=False)
    monkeypatch.setattr(lsp_report_sync.shutil, "which", lambda name: None)
    got = lsp_report_sync.resolve_lsp_interpreter(tmp_path)
    assert got == sys.executable


# ─────────────────────────────────────────────────────────────────────────────
# Command baking (the logic hub._run_hooks_stream calls)
# ─────────────────────────────────────────────────────────────────────────────


def test_bake_rewrites_lsp_command_with_absolute_interpreter_and_config(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("SKILL_TREE_PYTHON", "/opt/py/bin/python3")
    code_home = tmp_path / "code"
    data_home = tmp_path / "data"
    code_home.mkdir()
    hook = _lsp_hook()
    lsp_report_sync.bake_resolved_hooks(
        [hook], GlobalScope(), data_home=data_home, code_home=code_home
    )
    expected_script = code_home / "hooks" / "lsp-report" / "lsp_report.py"
    expected_config = data_home / "state" / "hooks" / "lsp-report.global.json"
    assert hook.command == f"/opt/py/bin/python3 {expected_script} --config {expected_config}"
    # And the config was actually materialized.
    assert expected_config.exists()


def test_bake_leaves_non_lsp_hook_untouched(monkeypatch, tmp_path):
    monkeypatch.setenv("SKILL_TREE_PYTHON", "/opt/py/bin/python3")
    other = _lsp_hook(name="my-hook")
    original_command = other.command
    lsp_report_sync.bake_resolved_hooks(
        [other], GlobalScope(), data_home=tmp_path / "d", code_home=tmp_path / "c"
    )
    assert other.command == original_command
    # No config file materialized for a non-lsp-report hook.
    assert not (tmp_path / "d" / "state" / "hooks").exists()


def test_bake_leaves_a_user_shadow_of_lsp_report_untouched(monkeypatch, tmp_path):
    """HOOKS-BUG-06: a registry hook NAMED `lsp-report` legitimately shadows the
    built-in, and docs/HOOKS.md promises the shadowing definition is used in
    full. Matching on the name alone rewrote the user's command with the baked
    built-in one — running code they never asked for. Provenance gates the bake."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", "/opt/py/bin/python3")
    shadow = _lsp_hook()
    shadow.provenance = "user"
    shadow.command = "/bin/echo shadowed"

    lsp_report_sync.bake_resolved_hooks(
        [shadow], GlobalScope(), data_home=tmp_path / "d", code_home=tmp_path / "c"
    )
    assert shadow.command == "/bin/echo shadowed"
    # And no config is materialized on the shadowed built-in's behalf.
    assert not (tmp_path / "d" / "state" / "hooks").exists()


def test_bake_only_touches_lsp_report_in_mixed_list(monkeypatch, tmp_path):
    monkeypatch.setenv("SKILL_TREE_PYTHON", "/opt/py/bin/python3")
    lsp = _lsp_hook()
    other = _lsp_hook(name="other")
    other_cmd = other.command
    lsp_report_sync.bake_resolved_hooks(
        [other, lsp],
        GlobalScope(),
        data_home=tmp_path / "d",
        code_home=tmp_path / "c",
    )
    assert other.command == other_cmd
    assert lsp.command.startswith("/opt/py/bin/python3 ")
    assert "--config" in lsp.command


def test_bake_re_materializes_on_interpreter_change(monkeypatch, tmp_path):
    code_home = tmp_path / "c"
    data_home = tmp_path / "d"

    monkeypatch.setenv("SKILL_TREE_PYTHON", "/py/one/python3")
    hook = _lsp_hook()
    lsp_report_sync.bake_resolved_hooks(
        [hook], GlobalScope(), data_home=data_home, code_home=code_home
    )
    first = hook.command

    monkeypatch.setenv("SKILL_TREE_PYTHON", "/py/two/python3")
    hook2 = _lsp_hook()
    lsp_report_sync.bake_resolved_hooks(
        [hook2], GlobalScope(), data_home=data_home, code_home=code_home
    )
    second = hook2.command

    assert first != second
    assert first.startswith("/py/one/python3 ")
    assert second.startswith("/py/two/python3 ")
