"""Hook scripts — managed bodies on disk, sync-time baking, doctor finding.

Unit-level: `hook_scripts` is driven directly with explicit `data_home`/`code_home`
so nothing depends on the ambient data home, and `risks.detect_hook_script_risks`
is driven with a plain registry dict. The CLI lives in `test_hooks_cli.py`, the
end-to-end sync path in `test_hooks_sync_stream.py`.
"""

from __future__ import annotations

import shlex

import pytest

from skill_hub.domain.diagnostics import risks
from skill_hub.domain.hooks import hooks_model as hm
from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope
from skill_hub.infrastructure.hooks import hook_scripts as hs


def _capture():
    msgs: list[str] = []
    return msgs.append, msgs


def _resolved(name, script, *, command="", provenance="user"):
    return hm.ResolvedHook(
        name=name,
        event="PostToolUse",
        command=command,
        tools=[],
        matcher="",
        timeout=None,
        harnesses=None,
        settings={},
        provenance=provenance,
        script=script,
    )


def _managed(interpreter="bash", args=""):
    return hm.HookScript(source="managed", interpreter=interpreter, args=args)


def _repo(path="scripts/lint.sh", interpreter="bash", args=""):
    return hm.HookScript(
        source="repo", interpreter=interpreter, path=path, args=args
    )


# ─────────────────────────────────────────────────────────────────────────────
# Managed body lifecycle
# ─────────────────────────────────────────────────────────────────────────────


def test_ensure_seeds_a_stub_then_leaves_an_existing_body_alone(tmp_path):
    script = _managed()
    path = hs.ensure_managed_script("fmt", script, data_home=tmp_path)
    assert path == tmp_path / "hooks" / "fmt" / "script.sh"
    assert path.read_text().startswith("#!/usr/bin/env bash")

    hs.write_managed_script("fmt", script, "echo mine", data_home=tmp_path)
    hs.ensure_managed_script("fmt", script, data_home=tmp_path)
    assert path.read_text() == "echo mine\n"


def test_ensure_with_a_body_overwrites_and_python_stub_uses_the_py_extension(tmp_path):
    script = _managed(interpreter="python3")
    path = hs.ensure_managed_script("fmt", script, data_home=tmp_path)
    assert path.name == "script.py"
    assert path.read_text().startswith("#!/usr/bin/env python3")
    hs.ensure_managed_script("fmt", script, body="print(1)", data_home=tmp_path)
    assert path.read_text() == "print(1)\n"


def test_read_managed_script_is_none_when_the_body_is_gone(tmp_path):
    assert hs.read_managed_script("fmt", _managed(), data_home=tmp_path) is None


def test_rename_carries_the_body_across_an_interpreter_change(tmp_path):
    old, new = _managed(), _managed(interpreter="python3")
    hs.write_managed_script("fmt", old, "echo hi", data_home=tmp_path)
    moved = hs.rename_managed_script("fmt", old, new, data_home=tmp_path)
    assert moved == tmp_path / "hooks" / "fmt" / "script.py"
    assert moved.read_text() == "echo hi\n"
    assert not (tmp_path / "hooks" / "fmt" / "script.sh").exists()


def test_rename_is_a_no_op_when_nothing_changed_or_nothing_exists(tmp_path):
    script = _managed()
    assert hs.rename_managed_script("fmt", script, script, data_home=tmp_path) is None
    assert (
        hs.rename_managed_script(
            "fmt", script, _managed(interpreter="python3"), data_home=tmp_path
        )
        is None
    )


def test_remove_managed_script_dir_is_idempotent(tmp_path):
    hs.ensure_managed_script("fmt", _managed(), data_home=tmp_path)
    assert hs.remove_managed_script_dir("fmt", data_home=tmp_path) is True
    assert not (tmp_path / "hooks" / "fmt").exists()
    assert hs.remove_managed_script_dir("fmt", data_home=tmp_path) is False


# ─────────────────────────────────────────────────────────────────────────────
# Hook-name traversal guard (review B2)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad", ["../victim", "../../victim", "a/b", "/etc", "..", ".", "", "Fmt", "fmt ", "f_t"]
)
def test_managed_script_dir_refuses_a_non_slug_name(tmp_path, bad):
    with pytest.raises(ValueError):
        hs.managed_script_dir(bad, data_home=tmp_path)


def test_managed_script_dir_accepts_a_slug(tmp_path):
    assert hs.managed_script_dir("lsp-report", data_home=tmp_path) == (
        tmp_path / "hooks" / "lsp-report"
    )


def test_write_paths_fail_closed_on_a_traversal_name(tmp_path):
    """Every path that CREATES a body goes through `managed_script_dir`, so a
    hostile name raises before anything reaches disk."""
    home = tmp_path / "home"
    home.mkdir()
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("precious")
    script = _managed()
    bad = "../../victim"

    for call in (
        lambda: hs.managed_script_path(bad, script, data_home=home),
        lambda: hs.write_managed_script(bad, script, "echo pwned", data_home=home),
        lambda: hs.ensure_managed_script(bad, script, data_home=home),
        lambda: hs.read_managed_script(bad, script, data_home=home),
        lambda: hs.rename_managed_script(
            bad, script, _managed(interpreter="python3"), data_home=home
        ),
        lambda: hs.script_command(bad, script, data_home=home, code_home=home),
    ):
        with pytest.raises(ValueError):
            call()

    assert sorted(p.name for p in victim.iterdir()) == ["keep.txt"]


def test_remove_managed_script_dir_warns_instead_of_rmtreeing_an_escaped_path(tmp_path):
    """The DELETE path is fail-open-but-safe: a registry entry with a hostile name
    must stay deletable from the registry, it just gets no `rmtree`."""
    home = tmp_path / "home"
    home.mkdir()
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("precious")
    warn, msgs = _capture()

    assert hs.remove_managed_script_dir("../../victim", data_home=home, warn=warn) is False

    assert (victim / "keep.txt").read_text() == "precious"
    assert any("not a slug" in m for m in msgs)


# ─────────────────────────────────────────────────────────────────────────────
# Command baking
# ─────────────────────────────────────────────────────────────────────────────


def test_managed_command_is_absolute_and_quoted_when_the_data_home_has_spaces(tmp_path):
    home = tmp_path / "Skill Tree Home"
    home.mkdir()
    script = _managed()
    hs.ensure_managed_script("fmt", script, data_home=home)
    hooks = [_resolved("fmt", script)]

    hs.bake_script_hooks(hooks, GlobalScope(), data_home=home, code_home=tmp_path)

    expected = str(home / "hooks" / "fmt" / "script.sh")
    assert hooks[0].command == f"bash {shlex.quote(expected)}"
    # The quoting is real: a shell splits the baked command back into 2 tokens.
    assert shlex.split(hooks[0].command) == ["bash", expected]


def test_managed_args_are_appended_verbatim(tmp_path):
    script = _managed(args='--fix --paths "a b"')
    hs.ensure_managed_script("fmt", script, data_home=tmp_path)
    hooks = [_resolved("fmt", script)]
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command.endswith(' --fix --paths "a b"')


def test_repo_command_stays_relative(tmp_path):
    hooks = [_resolved("lint", _repo("scripts/lint.sh", args="--all"))]
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command == "bash scripts/lint.sh --all"


def test_repo_command_quotes_a_path_with_spaces(tmp_path):
    hooks = [_resolved("lint", _repo("my scripts/lint.sh"))]
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command == "bash 'my scripts/lint.sh'"


def test_repo_script_bakes_the_same_way_at_project_scope(tmp_path):
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    hooks = [_resolved("lint", _repo())]
    hs.bake_script_hooks(hooks, scope, data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command == "bash scripts/lint.sh"


def test_python3_interpreter_uses_the_lsp_report_resolution(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILL_TREE_PYTHON", "/opt/py 3/bin/python3")
    script = _managed(interpreter="python3")
    hs.ensure_managed_script("fmt", script, data_home=tmp_path)
    hooks = [_resolved("fmt", script)]
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command.startswith("'/opt/py 3/bin/python3' ")


def test_missing_managed_body_drops_the_hook_and_warns(tmp_path):
    warn, msgs = _capture()
    hooks = [_resolved("fmt", _managed()), _resolved("other", None, command="echo hi")]
    hs.bake_script_hooks(
        hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path, warn=warn
    )
    assert [h.name for h in hooks] == ["other"]
    assert any("managed script missing" in m and "fmt" in m for m in msgs)


def test_command_hooks_and_builtins_are_never_touched(tmp_path):
    builtin_script = _managed()
    hs.ensure_managed_script("lsp-report", builtin_script, data_home=tmp_path)
    hooks = [
        _resolved("plain", None, command="echo hi"),
        _resolved(
            "lsp-report", builtin_script, command="/baked/python lsp.py",
            provenance="builtin",
        ),
    ]
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command == "echo hi"
    assert hooks[1].command == "/baked/python lsp.py"


def test_a_user_hook_shadowing_lsp_report_is_baked_as_a_script(tmp_path):
    """Provenance, not name, decides — a shadowing USER definition owns itself."""
    script = _managed()
    hs.ensure_managed_script("lsp-report", script, data_home=tmp_path)
    hooks = [_resolved("lsp-report", script, provenance="user")]
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command == (
        f"bash {shlex.quote(str(tmp_path / 'hooks' / 'lsp-report' / 'script.sh'))}"
    )


def test_bake_skips_a_traversal_named_managed_hook_and_warns(tmp_path):
    """A hand-edited registry must not take the sync stream down: the hook is
    dropped from the scope with a warning, every other hook still bakes."""
    warn, msgs = _capture()
    hooks = [
        _resolved("../../victim", _managed()),
        _resolved("other", None, command="echo hi"),
    ]

    hs.bake_script_hooks(
        hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path, warn=warn
    )

    assert [h.name for h in hooks] == ["other"]
    assert any("not a slug" in m and "skipped" in m for m in msgs)
    assert not (tmp_path / "victim").exists()


def test_bake_of_a_repo_script_ignores_the_hook_name_entirely(tmp_path):
    """A repo script's command is built from its PATH, never its name — so an
    odd name is harmless there and must not be dropped."""
    warn, msgs = _capture()
    hooks = [_resolved("../../victim", _repo("scripts/lint.sh"))]
    hs.bake_script_hooks(
        hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path, warn=warn
    )
    assert hooks[0].command == "bash scripts/lint.sh"
    assert msgs == []


def test_baking_is_byte_stable_across_repeated_runs(tmp_path):
    script = _managed()
    hs.ensure_managed_script("fmt", script, data_home=tmp_path)
    hooks = [_resolved("fmt", script)]
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    first = hooks[0].command
    hs.bake_script_hooks(hooks, GlobalScope(), data_home=tmp_path, code_home=tmp_path)
    assert hooks[0].command == first


# ─────────────────────────────────────────────────────────────────────────────
# Doctor — HOOK_SCRIPT_MISSING
# ─────────────────────────────────────────────────────────────────────────────


def _registry_with_repo_hook(projects: dict, *, attach_global=False) -> dict:
    reg = {
        "hooks": {
            "lint": {
                "event": "PostToolUse",
                "script": {
                    "source": "repo",
                    "interpreter": "bash",
                    "path": "scripts/lint.sh",
                },
            }
        },
        "projects": projects,
    }
    if attach_global:
        reg["hooks_global"] = ["lint"]
    return reg


def test_managed_missing_body_is_one_warning_finding(tmp_path):
    reg = {
        "hooks": {
            "fmt": {
                "event": "PostToolUse",
                "script": {"source": "managed", "interpreter": "bash"},
            }
        }
    }
    findings = risks.detect_hook_script_risks(reg, data_home=tmp_path)
    assert [f.code for f in findings] == ["HOOK_SCRIPT_MISSING"]
    assert findings[0].severity == "warning"
    assert "fmt" in findings[0].detail

    hs.ensure_managed_script("fmt", _managed(), data_home=tmp_path)
    assert risks.detect_hook_script_risks(reg, data_home=tmp_path) == []


def test_repo_script_missing_lists_every_attached_project(tmp_path):
    good = tmp_path / "good"
    (good / "scripts").mkdir(parents=True)
    (good / "scripts" / "lint.sh").write_text("echo")
    bad = tmp_path / "bad"
    bad.mkdir()
    reg = _registry_with_repo_hook(
        {
            "alpha": {"path": str(good), "hooks": ["lint"]},
            "beta": {"path": str(bad), "hooks": ["lint"]},
            "gamma": {"path": str(bad)},  # not attached — never reported
        }
    )
    findings = risks.detect_hook_script_risks(reg, data_home=tmp_path)
    assert len(findings) == 1
    assert "beta" in findings[0].detail
    assert "alpha" not in findings[0].detail
    assert "gamma" not in findings[0].detail


def test_global_attach_checks_every_registered_project(tmp_path):
    bad = tmp_path / "bad"
    bad.mkdir()
    reg = _registry_with_repo_hook({"beta": {"path": str(bad)}}, attach_global=True)
    findings = risks.detect_hook_script_risks(reg, data_home=tmp_path)
    assert len(findings) == 1
    assert "beta" in findings[0].detail


def test_unattached_repo_hook_raises_nothing(tmp_path):
    bad = tmp_path / "bad"
    bad.mkdir()
    reg = _registry_with_repo_hook({"beta": {"path": str(bad)}})
    assert risks.detect_hook_script_risks(reg, data_home=tmp_path) == []


def test_command_hooks_and_a_junk_registry_raise_nothing(tmp_path):
    reg = {"hooks": {"plain": {"event": "PostToolUse", "command": "echo hi"}}}
    assert risks.detect_hook_script_risks(reg, data_home=tmp_path) == []
    assert risks.detect_hook_script_risks(None, data_home=tmp_path) == []
    assert risks.detect_hook_script_risks({}, data_home=tmp_path) == []


def test_hook_script_missing_is_in_the_emitted_schema():
    codes = {row["code"]: row["severity"] for row in risks.emit_schema()}
    assert codes["HOOK_SCRIPT_MISSING"] == "warning"


def test_repo_script_hook_does_not_trip_the_broken_script_heuristic():
    """`bash scripts/lint.sh` resolves against the PROJECT root, not hub's cwd —
    HOOK_SCRIPT_MISSING owns it, so the path heuristic must stand down."""
    from skill_hub.infrastructure.harnesses.harness_probe import SUPPORTED, HookCapability

    hook = _resolved("lint", _repo())
    hook.command = "bash scripts/lint.sh"
    cap = HookCapability(harness_id="claude-code", verdict=SUPPORTED, reason="")
    codes = {
        f.code
        for f in risks.detect_hook_risks([hook], cap, "claude-code")
    }
    assert "HOOK_BROKEN_SCRIPT" not in codes


# ─────────────────────────────────────────────────────────────────────────────
# End-to-end guard: a hostile hook name never takes `hub sync` down
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_with_a_traversal_named_script_hook_warns_skips_and_succeeds(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """The one sync-level case that lives here rather than in
    `test_hooks_sync_stream.py`: it is the traversal guard's blast radius, not a
    hooks-stream behaviour. `hub sync` must warn, drop the hook, write no hook
    into the harness file, leave the escaped dir untouched — and still finish."""
    # Local imports: this is the only test in the file that needs the ambient
    # data home + a full sync.
    import argparse
    import json

    import yaml

    import hub
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    proj = tmp_path / "alpha"
    proj.mkdir()
    victim = tmp_data_home / "victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("precious")

    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump({
        "harnesses_global": ["claude-code"],
        "permissions_global": {},
        "projects": {"alpha": {"path": str(proj), "permissions": {}}},
        "skills": {},
        "hooks": {
            "../victim": {
                "event": "PostToolUse",
                "script": {"source": "managed", "interpreter": "bash"},
            }
        },
        "hooks_global": ["../victim"],
    }, sort_keys=False))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    captured = capsys.readouterr()

    assert (victim / "keep.txt").read_text() == "precious"
    assert "not a slug" in captured.out + captured.err
    settings_path = home / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    assert not settings.get("hooks")


def test_doctor_scan_survives_a_traversal_named_managed_hook(tmp_data_home):
    """One unaddressable name yields its own finding without aborting the scan
    (pre-fix it raised and hub's rollup skipped HOOK_SCRIPT_MISSING entirely)."""
    from skill_hub.domain.diagnostics import risks

    registry = {
        "hooks": {
            "../evil": {"event": "PostToolUse", "script": {"source": "managed", "interpreter": "bash"}},
            "good-hook": {"event": "PostToolUse", "script": {"source": "managed", "interpreter": "bash"}},
        },
        "projects": {},
    }
    found = risks.detect_hook_script_risks(registry, data_home=tmp_data_home)
    details = sorted(f.detail for f in found)
    assert any("../evil" in d and "cannot address" in d for d in details)
    # good-hook's body is also absent on disk — the scan still reached it.
    assert any(d.startswith("good-hook:") for d in details)
