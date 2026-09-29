"""`hub hook …` CLI verbs + deprecated `permissions hooks` aliases + the
permissions-engine hook-drop guard (hooks-surface tasks 2.6 / 2.2 backend).

Drives the `cmd_hook_*` handlers directly with `argparse.Namespace`; `_auto_sync`
is monkeypatched to a no-op so the tests exercise registry-mutation logic without
running a full sync.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest
import yaml

import hub
import skill_hub.entrypoints.cli.hook


def _seed(data_home: Path, registry: dict | None = None) -> None:
    reg = registry or {
        "harnesses_global": ["claude-code"],
        "projects": {"alpha": {"path": str(data_home / "alpha"), "permissions": {}}},
        "skills": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


def _reg(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _data_home_snapshot(data_home: Path) -> list[tuple[str, int]]:
    """Sorted (relative path, mtime_ns) pairs for every file under `data_home` —
    a real "nothing was written" proof, unlike a single-directory existence
    check that stays vacuously true when that directory was never populated."""
    return sorted(
        (str(p.relative_to(data_home)), p.stat().st_mtime_ns)
        for p in data_home.rglob("*")
        if p.is_file()
    )


@pytest.fixture(autouse=True)
def _no_auto_sync(monkeypatch):
    monkeypatch.setattr(hub, "_auto_sync", lambda: None)


def _ns(**kw):
    return argparse.Namespace(**kw)


# ─────────────────────────────────────────────────────────────────────────────
# new / list / show
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_new_then_list_json(tmp_data_home, capsys):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/bin/echo",
        tools="Edit,Write", matcher=None, timeout=5, harnesses=None,
    ))
    reg = _reg(tmp_data_home)
    assert reg["hooks"]["fmt"]["event"] == "PostToolUse"
    assert reg["hooks"]["fmt"]["tools"] == ["Edit", "Write"]
    assert reg["hooks"]["fmt"]["timeout"] == 5

    capsys.readouterr()
    hub.cmd_hook_list(_ns(json=True))
    payload = json.loads(capsys.readouterr().out)
    names = {h["name"] for h in payload["hooks"]}
    assert "fmt" in names
    assert "reach" in payload


def test_hook_new_rejects_duplicate(tmp_data_home):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    with pytest.raises(SystemExit):
        hub.cmd_hook_new(_ns(
            name="fmt", event="PreToolUse", command="/y",
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))


def test_hook_new_rejects_reserved_name_new(tmp_data_home):
    """'new' collides with the app's /hook/new create-mode route sentinel."""
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_new(_ns(
            name="new", event="PostToolUse", command="/x",
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))


def test_hook_new_rejects_unknown_event(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_new(_ns(
            name="fmt", event="NotAnEvent", command="/x",
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))


def test_hook_new_rejects_builtin_name(tmp_data_home, monkeypatch):
    from skill_hub.domain.hooks import hooks_model

    _seed(tmp_data_home)
    monkeypatch.setattr(
        hooks_model, "load_builtin_hooks",
        lambda *a, **k: {
            "lsp-report": hooks_model.HookDefinition(
                name="lsp-report", event="PostToolUse", command="/lsp",
                provenance="builtin",
            )
        },
    )
    with pytest.raises(SystemExit):
        hub.cmd_hook_new(_ns(
            name="lsp-report", event="PostToolUse", command="/x",
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))


def test_hook_show_json(tmp_data_home, capsys):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher="Edit", timeout=None, harnesses=None,
    ))
    hub.cmd_hook_attach(_ns(name="fmt", global_=True, project=None))
    capsys.readouterr()
    hub.cmd_hook_show(_ns(name="fmt", json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["name"] == "fmt"
    assert payload["attached_global"] is True
    assert payload["matcher"] == "Edit"


# ─────────────────────────────────────────────────────────────────────────────
# edit
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_edit_mutates_user_def(tmp_data_home):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    hub.cmd_hook_edit(_ns(
        name="fmt", event="PreToolUse", command="/y",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    reg = _reg(tmp_data_home)
    assert reg["hooks"]["fmt"]["event"] == "PreToolUse"
    assert reg["hooks"]["fmt"]["command"] == "/y"


def test_hook_edit_timeout_set_then_cleared(tmp_data_home):
    """--timeout "" clears a previously-set timeout — distinct from omitting
    --timeout entirely (None), which leaves it untouched."""
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    hub.cmd_hook_edit(_ns(
        name="fmt", event=None, command=None,
        tools=None, matcher=None, timeout="30", harnesses=None,
    ))
    assert _reg(tmp_data_home)["hooks"]["fmt"]["timeout"] == 30

    # Omitting --timeout leaves it untouched.
    hub.cmd_hook_edit(_ns(
        name="fmt", event="PreToolUse", command=None,
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    assert _reg(tmp_data_home)["hooks"]["fmt"]["timeout"] == 30

    # An explicit empty string clears it.
    hub.cmd_hook_edit(_ns(
        name="fmt", event=None, command=None,
        tools=None, matcher=None, timeout="", harnesses=None,
    ))
    assert "timeout" not in _reg(tmp_data_home)["hooks"]["fmt"]


def test_hook_edit_without_command_flag_leaves_the_command_untouched(
    tmp_data_home, monkeypatch, capsys
):
    """HOOKS-BUG-05: driven through the REAL parser, because the bug only exists
    in the namespace argparse produces — the top-level subparser stores the
    SUBCOMMAND under `command`, so `hub hook edit fmt --timeout 60` (no
    `--command`) used to rewrite the hook's command to the literal string "hook",
    turning a timeout tweak into a silently broken hook."""
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/usr/bin/fmt --write",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))

    monkeypatch.setattr(sys, "argv", ["hub", "hook", "edit", "fmt", "--timeout", "60"])
    hub.main()
    capsys.readouterr()

    block = _reg(tmp_data_home)["hooks"]["fmt"]
    assert block["command"] == "/usr/bin/fmt --write"
    assert block["timeout"] == 60


def test_hook_edit_with_command_flag_still_applies(tmp_data_home, monkeypatch, capsys):
    """The other half of the contract: `--command` through the real parser still
    reaches the registry (the fix must not deafen the flag)."""
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/old",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))

    monkeypatch.setattr(
        sys, "argv", ["hub", "hook", "edit", "fmt", "--command", "/new"]
    )
    hub.main()
    capsys.readouterr()

    assert _reg(tmp_data_home)["hooks"]["fmt"]["command"] == "/new"


def test_hook_command_arg_ignores_the_subparser_dest(tmp_data_home):
    """Unit-level: an argparse namespace that carries BOTH dests resolves to the
    hook one, even when it is None."""
    assert skill_hub.entrypoints.cli.hook._hook_command_arg(_ns(hook_command=None, command="hook")) is None
    assert skill_hub.entrypoints.cli.hook._hook_command_arg(_ns(hook_command="/x", command="hook")) == "/x"
    # Direct callers/tests that only pass `command` keep working.
    assert skill_hub.entrypoints.cli.hook._hook_command_arg(_ns(command="/y")) == "/y"


def test_hook_edit_rejects_non_integer_timeout(tmp_data_home):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    with pytest.raises(SystemExit):
        hub.cmd_hook_edit(_ns(
            name="fmt", event=None, command=None,
            tools=None, matcher=None, timeout="soon", harnesses=None,
        ))


def test_hook_edit_rejects_builtin(tmp_data_home, monkeypatch):
    from skill_hub.domain.hooks import hooks_model

    _seed(tmp_data_home)
    monkeypatch.setattr(
        hooks_model, "load_builtin_hooks",
        lambda *a, **k: {
            "lsp-report": hooks_model.HookDefinition(
                name="lsp-report", event="PostToolUse", command="/lsp",
                provenance="builtin",
            )
        },
    )
    with pytest.raises(SystemExit):
        hub.cmd_hook_edit(_ns(
            name="lsp-report", event="PreToolUse", command=None,
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))


# ─────────────────────────────────────────────────────────────────────────────
# attach / detach
# ─────────────────────────────────────────────────────────────────────────────


def test_attach_detach_global_and_project_idempotent(tmp_data_home):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    hub.cmd_hook_attach(_ns(name="fmt", global_=True, project=None))
    hub.cmd_hook_attach(_ns(name="fmt", global_=True, project=None))  # idempotent
    assert _reg(tmp_data_home)["hooks_global"] == ["fmt"]

    hub.cmd_hook_attach(_ns(name="fmt", global_=False, project="alpha"))
    assert _reg(tmp_data_home)["projects"]["alpha"]["hooks"] == ["fmt"]

    hub.cmd_hook_detach(_ns(name="fmt", global_=False, project="alpha"))
    assert _reg(tmp_data_home)["projects"]["alpha"].get("hooks") == []
    hub.cmd_hook_detach(_ns(name="fmt", global_=True, project=None))
    assert _reg(tmp_data_home)["hooks_global"] == []


def test_companion_cli_ops_hook_mutations_accept_operation_context():
    """The real reconcile facade forwards its frozen context to hook helpers."""
    from skill_hub.entrypoints.cli.companions import CliOps

    registry = {
        "hooks": {"fmt": {"event": "PostToolUse", "command": "/old"}},
        "hooks_global": [],
        "projects": {},
    }
    context = object()
    ops = CliOps(context)

    assert ops.hook_attach(
        registry, "fmt", scope_global=True, proj_name=None, operation_context=context
    )
    ops.hook_update(
        registry,
        "fmt",
        event="PreToolUse",
        command="/new",
        operation_context=context,
    )
    assert registry["hooks_global"] == ["fmt"]
    assert registry["hooks"]["fmt"]["command"] == "/new"
    assert ops.hook_detach(
        registry, "fmt", scope_global=True, proj_name=None, operation_context=context
    )
    assert registry["hooks_global"] == []


def test_attach_requires_exactly_one_scope(tmp_data_home):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    with pytest.raises(SystemExit):
        hub.cmd_hook_attach(_ns(name="fmt", global_=False, project=None))


# ─────────────────────────────────────────────────────────────────────────────
# set-settings
# ─────────────────────────────────────────────────────────────────────────────


def test_set_settings_global_and_project_merge(tmp_data_home):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    hub.cmd_hook_set_settings(_ns(
        name="fmt", global_=True, project=None, json='{"a": 1, "nested": {"x": 1}}'
    ))
    assert _reg(tmp_data_home)["hooks"]["fmt"]["settings"] == {"a": 1, "nested": {"x": 1}}
    # Deep-merge preserves untouched keys.
    hub.cmd_hook_set_settings(_ns(
        name="fmt", global_=True, project=None, json='{"nested": {"y": 2}}'
    ))
    assert _reg(tmp_data_home)["hooks"]["fmt"]["settings"] == {
        "a": 1, "nested": {"x": 1, "y": 2}
    }
    # Project override tier.
    hub.cmd_hook_set_settings(_ns(
        name="fmt", global_=False, project="alpha", json='{"b": 9}'
    ))
    assert _reg(tmp_data_home)["projects"]["alpha"]["hook_settings"]["fmt"] == {"b": 9}


def test_set_settings_builtin_global_refused(tmp_data_home, monkeypatch):
    from skill_hub.domain.hooks import hooks_model

    _seed(tmp_data_home)
    monkeypatch.setattr(
        hooks_model, "load_builtin_hooks",
        lambda *a, **k: {
            "lsp-report": hooks_model.HookDefinition(
                name="lsp-report", event="PostToolUse", command="/lsp",
                provenance="builtin",
            )
        },
    )
    with pytest.raises(SystemExit):
        hub.cmd_hook_set_settings(_ns(
            name="lsp-report", global_=True, project=None, json='{"a": 1}'
        ))


# ─────────────────────────────────────────────────────────────────────────────
# delete
# ─────────────────────────────────────────────────────────────────────────────


def test_delete_requires_confirm_and_detaches_everywhere(tmp_data_home, capsys):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    hub.cmd_hook_attach(_ns(name="fmt", global_=True, project=None))
    hub.cmd_hook_attach(_ns(name="fmt", global_=False, project="alpha"))
    hub.cmd_hook_set_settings(_ns(
        name="fmt", global_=False, project="alpha", json='{"b": 1}'
    ))

    # Without --yes: preview only, nothing removed.
    hub.cmd_hook_delete(_ns(name="fmt", yes=False))
    assert "Re-run with" in capsys.readouterr().out
    assert "fmt" in _reg(tmp_data_home)["hooks"]

    # With --yes: definition gone + detached from every scope + hook_settings gone.
    hub.cmd_hook_delete(_ns(name="fmt", yes=True))
    reg = _reg(tmp_data_home)
    assert "hooks" not in reg or "fmt" not in reg.get("hooks", {})
    assert reg["hooks_global"] == []
    assert reg["projects"]["alpha"].get("hooks") == []
    assert "hook_settings" not in reg["projects"]["alpha"]


def test_delete_builtin_refused(tmp_data_home, monkeypatch):
    from skill_hub.domain.hooks import hooks_model

    _seed(tmp_data_home)
    monkeypatch.setattr(
        hooks_model, "load_builtin_hooks",
        lambda *a, **k: {
            "lsp-report": hooks_model.HookDefinition(
                name="lsp-report", event="PostToolUse", command="/lsp",
                provenance="builtin",
            )
        },
    )
    with pytest.raises(SystemExit):
        hub.cmd_hook_delete(_ns(name="lsp-report", yes=True))


# ─────────────────────────────────────────────────────────────────────────────
# Deprecated `permissions hooks` aliases route into the library
# ─────────────────────────────────────────────────────────────────────────────


def test_permissions_hooks_add_alias_warns_and_routes(tmp_data_home, capsys):
    _seed(tmp_data_home)
    hub.cmd_permissions_hooks_add(_ns(
        global_=True, project=None, personal=False,
        event="PostToolUse", matcher="Edit", command="/x", harnesses=None,
    ))
    err = capsys.readouterr().err
    assert "deprecated" in err.lower()
    reg = _reg(tmp_data_home)
    # A library hook was created + attached globally.
    assert reg.get("hooks")
    name = next(iter(reg["hooks"]))
    assert name in reg["hooks_global"]
    assert reg["hooks"][name]["event"] == "PostToolUse"


def test_permissions_hooks_remove_alias_detaches(tmp_data_home, capsys):
    _seed(tmp_data_home)
    hub.cmd_permissions_hooks_add(_ns(
        global_=True, project=None, personal=False,
        event="PostToolUse", matcher="Edit", command="/x", harnesses=None,
    ))
    capsys.readouterr()
    hub.cmd_permissions_hooks_remove(_ns(
        global_=True, project=None, personal=False,
        event="PostToolUse", matcher="Edit", command="/x",
    ))
    assert _reg(tmp_data_home)["hooks_global"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Task 2.2 backend — permissions set drops a `hooks` key with a warning
# ─────────────────────────────────────────────────────────────────────────────


def test_permissions_set_drops_hooks_key(tmp_data_home, capsys, monkeypatch):
    _seed(tmp_data_home)
    payload = {
        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}],
        "hooks": [{"event": "PostToolUse", "matcher": "Edit", "command": "/x"}],
    }
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(payload)))
    hub.cmd_permissions_set(_ns(
        global_=True, project=None, personal=False,
        stdin_json=True, json_file=None,
    ))
    cap = capsys.readouterr()
    assert "ignoring `hooks`" in cap.err
    reg = _reg(tmp_data_home)
    block = reg["permissions_global"]
    assert not block.get("hooks")
    assert any(
        (r.get("pattern") if isinstance(r, dict) else r) == "Bash(npm:*)"
        for r in block.get("allow", [])
    )


# ─────────────────────────────────────────────────────────────────────────────
# Guard rails — the `fail()` paths that stop a mistyped command from writing a
# malformed registry (a hook with no command, an attach list naming a project
# that does not exist, `settings` set to a JSON array).
# ─────────────────────────────────────────────────────────────────────────────


def _fmt(tmp_data_home, **overrides):
    """Seed the registry with one plain user hook named `fmt`."""
    _seed(tmp_data_home)
    kw = dict(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    )
    kw.update(overrides)
    hub.cmd_hook_new(_ns(**kw))


def test_hook_new_rejects_invalid_slug(tmp_data_home):
    """A name that is not a slug never reaches the registry (it would become an
    unreferenceable `hooks:` key and a bad attach-list entry)."""
    _seed(tmp_data_home)
    for bad in ("Fmt Hook", "fmt_hook", "fmt/../etc"):
        with pytest.raises(SystemExit):
            hub.cmd_hook_new(_ns(
                name=bad, event="PostToolUse", command="/x",
                tools=None, matcher=None, timeout=None, harnesses=None,
            ))
    assert not _reg(tmp_data_home).get("hooks")


def test_hook_new_rejects_empty_command(tmp_data_home):
    """A definition with no command would resolve, attach, and write an empty
    command string into a harness settings file."""
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_new(_ns(
            name="fmt", event="PostToolUse", command="",
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))
    assert not _reg(tmp_data_home).get("hooks")


def test_hook_edit_with_no_field_flags_fails_and_persists_nothing(tmp_data_home):
    """`hub hook edit fmt` with no field flags is a no-op error — and critically
    must not save the half-built block it assembled before the check."""
    _fmt(tmp_data_home, matcher="Edit", timeout=7)
    before = _reg(tmp_data_home)["hooks"]["fmt"]

    with pytest.raises(SystemExit):
        hub.cmd_hook_edit(_ns(
            name="fmt", event=None, command=None,
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))
    assert _reg(tmp_data_home)["hooks"]["fmt"] == before


def test_hook_edit_rejects_empty_command(tmp_data_home):
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_edit(_ns(
            name="fmt", event=None, command="",
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))
    assert _reg(tmp_data_home)["hooks"]["fmt"]["command"] == "/x"


def test_hook_edit_rejects_unknown_event_and_keeps_the_old_one(tmp_data_home):
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_edit(_ns(
            name="fmt", event="PostToolUsage", command=None,
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))
    assert _reg(tmp_data_home)["hooks"]["fmt"]["event"] == "PostToolUse"


def test_hook_edit_unknown_name_fails(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_edit(_ns(
            name="nope", event="PreToolUse", command=None,
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))


def test_hook_show_unknown_name_fails(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_show(_ns(name="nope", json=True))


def test_hook_delete_unknown_name_fails(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_delete(_ns(name="nope", yes=True))


def test_attach_unknown_hook_fails(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_attach(_ns(name="nope", global_=True, project=None))
    assert not _reg(tmp_data_home).get("hooks_global")


def test_attach_unknown_project_fails_without_mutating(tmp_data_home):
    """An attach naming a project that does not exist must not invent one (nor
    leave a dangling name the sync stream then has to tolerate)."""
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_attach(_ns(name="fmt", global_=False, project="ghost"))
    reg = _reg(tmp_data_home)
    assert set(reg["projects"]) == {"alpha"}
    assert reg["projects"]["alpha"].get("hooks") in (None, [])


def test_detach_unknown_project_fails(tmp_data_home):
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_detach(_ns(name="fmt", global_=False, project="ghost"))


def test_detach_requires_exactly_one_scope(tmp_data_home):
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_detach(_ns(name="fmt", global_=False, project=None))


def test_detach_when_not_attached_is_a_soft_no_op(tmp_data_home, capsys):
    """Detaching something that was never attached is NOT an error (idempotent
    verb) — it prints a notice and leaves the registry alone."""
    _fmt(tmp_data_home)
    hub.cmd_hook_detach(_ns(name="fmt", global_=True, project=None))
    assert "was not attached" in capsys.readouterr().out
    assert _reg(tmp_data_home).get("hooks_global") in (None, [])


def test_set_settings_unknown_hook_fails(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_set_settings(_ns(
            name="nope", global_=True, project=None, json='{"a": 1}'
        ))


def test_set_settings_rejects_malformed_json(tmp_data_home):
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_set_settings(_ns(
            name="fmt", global_=True, project=None, json='{"a": 1'
        ))
    assert "settings" not in _reg(tmp_data_home)["hooks"]["fmt"]


def test_set_settings_rejects_non_object_json(tmp_data_home):
    """`settings` is always a map — an array/scalar payload would break the
    deep-merge and the built-in settings contract."""
    _fmt(tmp_data_home)
    for payload in ('[1, 2]', '"nope"', 'null', '3'):
        with pytest.raises(SystemExit):
            hub.cmd_hook_set_settings(_ns(
                name="fmt", global_=True, project=None, json=payload
            ))
    assert "settings" not in _reg(tmp_data_home)["hooks"]["fmt"]


def test_set_settings_unknown_project_fails(tmp_data_home):
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_set_settings(_ns(
            name="fmt", global_=False, project="ghost", json='{"a": 1}'
        ))
    assert set(_reg(tmp_data_home)["projects"]) == {"alpha"}


def test_set_settings_rejects_both_scopes(tmp_data_home):
    _fmt(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_set_settings(_ns(
            name="fmt", global_=True, project="alpha", json='{"a": 1}'
        ))


def test_permissions_hooks_remove_alias_no_match_fails(tmp_data_home, capsys):
    """The deprecated alias resolves by (event, matcher, command); no match must
    fail with guidance rather than silently detaching the wrong hook."""
    _seed(tmp_data_home)
    hub.cmd_permissions_hooks_add(_ns(
        global_=True, project=None, personal=False,
        event="PostToolUse", matcher="Edit", command="/x", harnesses=None,
    ))
    capsys.readouterr()
    with pytest.raises(SystemExit):
        hub.cmd_permissions_hooks_remove(_ns(
            global_=True, project=None, personal=False,
            event="PostToolUse", matcher="Edit", command="/different",
        ))
    # The real attachment is untouched.
    assert len(_reg(tmp_data_home)["hooks_global"]) == 1


def test_permissions_hooks_remove_alias_matching_but_unattached_fails(
    tmp_data_home, capsys
):
    """A definition that matches but is not attached to the requested scope is
    also an error — `remove` never silently succeeds on a no-op."""
    _seed(tmp_data_home)
    hub.cmd_permissions_hooks_add(_ns(
        global_=True, project=None, personal=False,
        event="PostToolUse", matcher="Edit", command="/x", harnesses=None,
    ))
    capsys.readouterr()
    with pytest.raises(SystemExit):
        hub.cmd_permissions_hooks_remove(_ns(
            global_=False, project="alpha", personal=False,
            event="PostToolUse", matcher="Edit", command="/x",
        ))


# ─────────────────────────────────────────────────────────────────────────────
# Hook scripts — new/edit mode transitions, script show/save, JSON shapes
# ─────────────────────────────────────────────────────────────────────────────


def _run(monkeypatch, capsys, *argv):
    """Drive the REAL parser (the script flags only exist in argparse)."""
    monkeypatch.setattr(sys, "argv", ["hub", *argv])
    hub.main()
    return capsys.readouterr().out


def _script_dir(data_home: Path, name: str) -> Path:
    return data_home / "hooks" / name


def test_hook_new_managed_script_seeds_a_stub(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")

    block = _reg(tmp_data_home)["hooks"]["fmt"]
    assert block["script"] == {"source": "managed", "interpreter": "bash"}
    assert "command" not in block
    body = (_script_dir(tmp_data_home, "fmt") / "script.sh").read_text()
    assert body.startswith("#!/usr/bin/env bash")


def test_hook_new_managed_script_seeds_from_a_body_file(tmp_data_home, monkeypatch, capsys, tmp_path):
    _seed(tmp_data_home)
    seed = tmp_path / "seed.sh"
    seed.write_text("echo seeded")
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "python3",
         "--script-body-file", str(seed))
    assert (_script_dir(tmp_data_home, "fmt") / "script.py").read_text() == "echo seeded\n"


def test_hook_new_repo_script_records_the_relative_path(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--script-source", "repo", "--script-interpreter", "bash",
         "--script-path", "./scripts/lint.sh", "--script-args=--all")
    block = _reg(tmp_data_home)["hooks"]["lint"]
    assert block["script"] == {
        "source": "repo", "interpreter": "bash",
        "path": "scripts/lint.sh", "args": "--all",
    }
    # No managed dir is created for a repo script.
    assert not _script_dir(tmp_data_home, "lint").exists()


def test_hook_new_rejects_command_and_script_together(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_new(_ns(
            name="fmt", event="PostToolUse", command="/x",
            tools=None, matcher=None, timeout=None, harnesses=None,
            script_source="managed", script_interpreter="bash",
            script_path=None, script_args=None, script_body_file=None,
        ))


def test_hook_new_rejects_neither_command_nor_script(tmp_data_home):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_hook_new(_ns(
            name="fmt", event="PostToolUse", command=None,
            tools=None, matcher=None, timeout=None, harnesses=None,
        ))


@pytest.mark.parametrize("extra", [
    ["--script-source", "repo", "--script-interpreter", "bash", "--script-path", "../evil.sh"],
    ["--script-source", "repo", "--script-interpreter", "bash", "--script-path", "/etc/evil.sh"],
    ["--script-source", "repo", "--script-interpreter", "bash"],           # no path
    ["--script-source", "managed", "--script-interpreter", "bash", "--script-path", "x.sh"],
    ["--script-source", "managed", "--script-interpreter", "perl"],
    ["--script-source", "sftp", "--script-interpreter", "bash"],
    ["--script-interpreter", "bash"],                                       # no source
])
def test_hook_new_rejects_invalid_script_combos(tmp_data_home, monkeypatch, capsys, extra):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse", *extra)
    assert "hooks" not in (_reg(tmp_data_home) or {})


def test_hook_new_rejects_a_body_file_for_a_repo_script(tmp_data_home, monkeypatch, capsys, tmp_path):
    _seed(tmp_data_home)
    seed = tmp_path / "seed.sh"
    seed.write_text("x")
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
             "--script-source", "repo", "--script-interpreter", "bash",
             "--script-path", "s.sh", "--script-body-file", str(seed))


def test_hook_edit_command_to_managed_script_creates_the_dir(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    _run(monkeypatch, capsys, "hook", "edit", "fmt",
         "--script-source", "managed", "--script-interpreter", "bash")
    block = _reg(tmp_data_home)["hooks"]["fmt"]
    assert block["script"]["source"] == "managed"
    assert "command" not in block
    assert (_script_dir(tmp_data_home, "fmt") / "script.sh").exists()


def test_hook_edit_managed_to_command_deletes_the_managed_dir(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    assert _script_dir(tmp_data_home, "fmt").exists()

    _run(monkeypatch, capsys, "hook", "edit", "fmt", "--command", "/bin/echo")
    block = _reg(tmp_data_home)["hooks"]["fmt"]
    assert block["command"] == "/bin/echo"
    assert "script" not in block
    assert not _script_dir(tmp_data_home, "fmt").exists()


def test_hook_edit_managed_to_repo_deletes_the_managed_dir(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    _run(monkeypatch, capsys, "hook", "edit", "fmt",
         "--script-source", "repo", "--script-path", "scripts/fmt.sh")
    block = _reg(tmp_data_home)["hooks"]["fmt"]
    assert block["script"] == {
        "source": "repo", "interpreter": "bash", "path": "scripts/fmt.sh",
    }
    assert not _script_dir(tmp_data_home, "fmt").exists()


def test_hook_edit_interpreter_change_carries_the_body_over(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    (_script_dir(tmp_data_home, "fmt") / "script.sh").write_text("echo mine\n")

    _run(monkeypatch, capsys, "hook", "edit", "fmt", "--script-interpreter", "python3")
    assert (_script_dir(tmp_data_home, "fmt") / "script.py").read_text() == "echo mine\n"
    assert not (_script_dir(tmp_data_home, "fmt") / "script.sh").exists()


def test_hook_edit_args_only_keeps_the_rest_of_the_script(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--script-source", "repo", "--script-interpreter", "bash",
         "--script-path", "scripts/lint.sh")
    _run(monkeypatch, capsys, "hook", "edit", "lint", "--script-args=--fix")
    assert _reg(tmp_data_home)["hooks"]["lint"]["script"] == {
        "source": "repo", "interpreter": "bash",
        "path": "scripts/lint.sh", "args": "--fix",
    }


def test_hook_edit_clearing_the_script_needs_a_command(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "edit", "fmt", "--script-source", "")
    # The definition (and its body) survive the refusal.
    assert "script" in _reg(tmp_data_home)["hooks"]["fmt"]
    assert _script_dir(tmp_data_home, "fmt").exists()

    _run(monkeypatch, capsys, "hook", "edit", "fmt",
         "--script-source", "", "--command", "/bin/echo")
    assert _reg(tmp_data_home)["hooks"]["fmt"]["command"] == "/bin/echo"
    assert not _script_dir(tmp_data_home, "fmt").exists()


def test_hook_edit_rejects_command_and_script_together(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="fmt", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "edit", "fmt", "--command", "/y",
             "--script-source", "managed", "--script-interpreter", "bash")


def test_hook_edit_rejects_a_traversal_path(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--script-source", "repo", "--script-interpreter", "bash",
         "--script-path", "scripts/lint.sh")
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "edit", "lint", "--script-path", "../../etc/x.sh")
    assert _reg(tmp_data_home)["hooks"]["lint"]["script"]["path"] == "scripts/lint.sh"


def test_hook_delete_removes_the_managed_dir(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    # The dry-run plan names the dir but deletes nothing.
    out = _run(monkeypatch, capsys, "hook", "delete", "fmt")
    assert "delete managed script" in out
    assert _script_dir(tmp_data_home, "fmt").exists()

    _run(monkeypatch, capsys, "hook", "delete", "fmt", "--yes")
    assert not _script_dir(tmp_data_home, "fmt").exists()


def test_hook_script_show_and_save_round_trip(tmp_data_home, monkeypatch, capsys, tmp_path):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    body = tmp_path / "new.sh"
    body.write_text("echo saved")
    _run(monkeypatch, capsys, "hook", "script", "save", "fmt", "--body-file", str(body))

    out = _run(monkeypatch, capsys, "hook", "script", "show", "fmt")
    assert out.strip() == "echo saved"

    out = _run(monkeypatch, capsys, "hook", "script", "show", "fmt", "--json")
    payload = json.loads(out)
    assert payload["body"] == "echo saved\n"
    assert payload["interpreter"] == "bash"
    assert payload["path"].endswith("/hooks/fmt/script.sh")


def test_hook_script_save_from_stdin(tmp_data_home, monkeypatch, capsys):
    import io

    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    monkeypatch.setattr(sys, "stdin", io.StringIO("echo piped"))
    _run(monkeypatch, capsys, "hook", "script", "save", "fmt", "--stdin")
    assert (_script_dir(tmp_data_home, "fmt") / "script.sh").read_text() == "echo piped\n"


def test_hook_script_show_refuses_non_managed_hooks(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="plain", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--script-source", "repo", "--script-interpreter", "bash",
         "--script-path", "scripts/lint.sh")
    for name in ("plain", "lint", "nope"):
        with pytest.raises(SystemExit):
            _run(monkeypatch, capsys, "hook", "script", "show", name)


def test_hook_script_show_json_reports_a_missing_body_as_null(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    (_script_dir(tmp_data_home, "fmt") / "script.sh").unlink()
    payload = json.loads(_run(monkeypatch, capsys, "hook", "script", "show", "fmt", "--json"))
    assert payload["body"] is None


def test_hook_list_json_carries_the_action_discriminator(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    hub.cmd_hook_new(_ns(
        name="plain", event="PostToolUse", command="/x",
        tools=None, matcher=None, timeout=None, harnesses=None,
    ))
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash")
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--script-source", "repo", "--script-interpreter", "bash",
         "--script-path", "scripts/lint.sh")

    payload = json.loads(_run(monkeypatch, capsys, "hook", "list", "--json"))
    actions = {h["name"]: h["action"] for h in payload["hooks"]}
    assert actions["plain"] == "command"
    assert actions["fmt"] == "script:managed"
    assert actions["lint"] == "script:repo"
    scripts = {h["name"]: h["script"] for h in payload["hooks"]}
    assert scripts["plain"] is None
    assert scripts["lint"]["path"] == "scripts/lint.sh"
    # `hook list` never reads a body off disk.
    assert "body" not in scripts["fmt"]


def test_hook_show_json_includes_the_managed_body(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "python3",
         "--script-args=--fix")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "fmt", "--json"))
    assert payload["action"] == "script:managed"
    assert payload["script"]["interpreter"] == "python3"
    assert payload["script"]["args"] == "--fix"
    assert payload["script"]["body"].startswith("#!/usr/bin/env python3")
    assert payload["script_projects"] == []


def test_hook_show_json_reports_repo_script_presence_per_project(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    good = tmp_path / "good"
    (good / "scripts").mkdir(parents=True)
    (good / "scripts" / "lint.sh").write_text("echo")
    bad = tmp_path / "bad"
    bad.mkdir()
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "projects": {
            "alpha": {"path": str(good), "hooks": ["lint"]},
            "beta": {"path": str(bad), "hooks": ["lint"]},
            "gamma": {"path": str(bad)},
        },
        "skills": {},
    })
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--script-source", "repo", "--script-interpreter", "bash",
         "--script-path", "scripts/lint.sh")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    assert payload["script_projects"] == [
        {"project": "alpha", "path_exists": True},
        {"project": "beta", "path_exists": False},
    ]


def test_hook_show_json_repo_script_projects_follows_a_global_attach(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    proj = tmp_path / "proj"
    proj.mkdir()
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "projects": {"alpha": {"path": str(proj)}},
        "skills": {},
    })
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--script-source", "repo", "--script-interpreter", "bash",
         "--script-path", "scripts/lint.sh")
    _run(monkeypatch, capsys, "hook", "attach", "lint", "--global")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    assert payload["script_projects"] == [{"project": "alpha", "path_exists": False}]


# ─────────────────────────────────────────────────────────────────────────────
# --description (review B1: the app sends it on every save)
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_new_accepts_description_through_the_real_parser(
    tmp_data_home, monkeypatch, capsys
):
    """B1: the app's editor sends `--description` on every save — argparse must
    know the flag, or every save exits 2 before a handler ever runs."""
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--command", "/usr/bin/fmt", "--description", "Formats edited files")
    assert _reg(tmp_data_home)["hooks"]["fmt"]["description"] == "Formats edited files"


def test_hook_edit_sets_then_clears_description(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--command", "/usr/bin/fmt")
    assert "description" not in _reg(tmp_data_home)["hooks"]["fmt"]

    # A description-only edit is a real edit (not "nothing to edit") and it must
    # not disturb the command.
    _run(monkeypatch, capsys, "hook", "edit", "fmt", "--description", "Now with lint")
    block = _reg(tmp_data_home)["hooks"]["fmt"]
    assert block["description"] == "Now with lint"
    assert block["command"] == "/usr/bin/fmt"

    # Empty string clears — same sentinel convention as --tools/--matcher.
    _run(monkeypatch, capsys, "hook", "edit", "fmt", "--description", "")
    assert "description" not in _reg(tmp_data_home)["hooks"]["fmt"]


def test_hook_description_reaches_list_and_show_json(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--command", "/x", "--description", "One-liner")
    listed = json.loads(_run(monkeypatch, capsys, "hook", "list", "--json"))
    assert {h["name"]: h["description"] for h in listed["hooks"]}["fmt"] == "One-liner"
    shown = json.loads(_run(monkeypatch, capsys, "hook", "show", "fmt", "--json"))
    assert shown["description"] == "One-liner"


def test_hook_edit_with_only_description_on_a_builtin_is_refused(
    tmp_data_home, monkeypatch, capsys
):
    from skill_hub.domain.hooks import hooks_model

    _seed(tmp_data_home)
    monkeypatch.setattr(
        hooks_model, "load_builtin_hooks",
        lambda *a, **k: {
            "lsp-report": hooks_model.HookDefinition(
                name="lsp-report", event="PostToolUse", command="/lsp",
                provenance="builtin",
            )
        },
    )
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "edit", "lsp-report",
             "--description", "mine now")
    assert "hooks" not in _reg(tmp_data_home)


# ─────────────────────────────────────────────────────────────────────────────
# Built-in scripts are read-only (review B4)
# ─────────────────────────────────────────────────────────────────────────────


def _builtin_managed(monkeypatch):
    """A fake built-in that claims a MANAGED script — the shape that let
    `hook script show/save` reach past the built-in boundary."""
    from skill_hub.domain.hooks import hooks_model

    monkeypatch.setattr(
        hooks_model, "load_builtin_hooks",
        lambda *a, **k: {
            "lsp-report": hooks_model.HookDefinition(
                name="lsp-report", event="PostToolUse", provenance="builtin",
                script=hooks_model.HookScript(source="managed", interpreter="bash"),
            )
        },
    )


def test_hook_script_show_and_save_refuse_a_builtin(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _builtin_managed(monkeypatch)
    body = tmp_path / "pwn.sh"
    body.write_text("echo pwned\n")

    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "script", "show", "lsp-report")
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "script", "save", "lsp-report",
             "--body-file", str(body))

    assert not (tmp_data_home / "hooks" / "lsp-report").exists()


def test_a_user_hook_shadowing_a_builtin_name_is_still_editable(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Provenance, not name, decides: a registry definition shadowing a built-in
    is a USER hook and its script stays writable. (Seeded straight into the
    registry — `hub hook new` refuses to collide with a built-in name.)"""
    _builtin_managed(monkeypatch)
    _seed(tmp_data_home, {
        "harnesses_global": [],
        "projects": {},
        "skills": {},
        "hooks": {
            "lsp-report": {
                "event": "PostToolUse",
                "script": {"source": "managed", "interpreter": "bash"},
            }
        },
    })
    body = tmp_path / "mine.sh"
    body.write_text("echo mine")
    _run(monkeypatch, capsys, "hook", "script", "save", "lsp-report",
         "--body-file", str(body))
    assert (
        (_script_dir(tmp_data_home, "lsp-report") / "script.sh").read_text()
        == "echo mine\n"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Hook-name path traversal (review B2)
# ─────────────────────────────────────────────────────────────────────────────


def _seed_traversal_hook(data_home: Path) -> Path:
    """Registry carrying a hostile hook NAME + the dir it would escape into.

    `<data_home>/hooks/../victim` resolves to `<data_home>/victim`, so the victim
    dir is outside the managed-hooks tree that hub owns.
    """
    victim = data_home / "victim"
    victim.mkdir(parents=True, exist_ok=True)
    (victim / "keep.txt").write_text("precious")
    _seed(data_home, {
        "harnesses_global": [],
        "projects": {},
        "skills": {},
        "hooks": {
            "../victim": {
                "event": "PostToolUse",
                "script": {"source": "managed", "interpreter": "bash"},
            }
        },
    })
    return victim


def test_hook_delete_of_a_traversal_named_entry_never_touches_the_escaped_dir(
    tmp_data_home, monkeypatch, capsys
):
    """B2: `hub hook delete "../victim" --yes` used to rmtree outside the managed
    tree. The registry entry must still go — only the disk removal stands down."""
    victim = _seed_traversal_hook(tmp_data_home)

    plan = _run(monkeypatch, capsys, "hook", "delete", "../victim")
    assert "cannot address a managed script dir" in plan
    assert victim.exists()

    _run(monkeypatch, capsys, "hook", "delete", "../victim", "--yes")

    assert (victim / "keep.txt").read_text() == "precious"
    assert "hooks" not in _reg(tmp_data_home)


def test_hook_script_save_on_a_traversal_name_fails_closed(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    victim = _seed_traversal_hook(tmp_data_home)
    body = tmp_path / "pwn.sh"
    body.write_text("echo pwned\n")

    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "script", "save", "../victim",
             "--body-file", str(body))
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "script", "show", "../victim")

    assert list(victim.iterdir()) == [victim / "keep.txt"]


def test_hook_edit_on_a_traversal_named_managed_hook_fails_before_writing(
    tmp_data_home, monkeypatch, capsys
):
    victim = _seed_traversal_hook(tmp_data_home)
    with pytest.raises(SystemExit):
        _run(monkeypatch, capsys, "hook", "edit", "../victim",
             "--script-interpreter", "python3")
    # Neither the registry nor the escaped dir moved.
    assert _reg(tmp_data_home)["hooks"]["../victim"]["script"]["interpreter"] == "bash"
    assert list(victim.iterdir()) == [victim / "keep.txt"]


def test_hook_show_of_a_traversal_named_hook_reports_a_null_body_path(
    tmp_data_home, monkeypatch, capsys
):
    """Read-only surfaces must survive a hand-edited registry, not traceback."""
    _seed_traversal_hook(tmp_data_home)
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "../victim", "--json"))
    assert payload["script"]["body_path"] is None
    assert payload["script"]["body"] is None


# ─────────────────────────────────────────────────────────────────────────────
# Wave B: `baked_command` + `builtin` body on `hook show --json`
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_show_of_the_real_builtin_lsp_report_carries_its_baked_command_and_body(
    tmp_data_home, monkeypatch, capsys
):
    """No mock: `code_home()` resolves to this worktree, which ships the real
    `hooks/lsp-report/` — the show payload must expose its real body + the
    command the harness would actually receive, WITHOUT writing anything."""
    _seed(tmp_data_home)
    payload = json.loads(
        _run(monkeypatch, capsys, "hook", "show", "lsp-report", "--json")
    )

    baked = payload["baked_command"]
    assert baked is not None
    assert "lsp_report.py" in baked
    assert "--config" in baked

    builtin = payload["builtin"]
    assert builtin is not None
    assert builtin["dir"].endswith("hooks/lsp-report")
    names = [f["name"] for f in builtin["files"]]
    assert names == ["lsp_report.py", "hook.yaml"]  # hook.yaml sorts last
    lsp_file = builtin["files"][0]
    assert lsp_file["body"].startswith("#!/usr/bin/env python3")
    yaml_file = builtin["files"][1]
    assert yaml_file["body"] is not None

    # A read must never materialize the per-scope config it references.
    assert not (tmp_data_home / "state" / "hooks" / "lsp-report.global.json").exists()


def test_hook_show_baked_command_of_a_managed_script_hook_contains_path_and_args(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "bash",
         "--script-args=--fix")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "fmt", "--json"))
    baked = payload["baked_command"]
    managed_path = str(_script_dir(tmp_data_home, "fmt") / "script.sh")
    assert managed_path in baked
    assert "--fix" in baked
    assert payload["builtin"] is None


def test_hook_show_baked_command_of_a_command_hook_equals_its_command(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--command", "/bin/echo hi")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "fmt", "--json"))
    assert payload["baked_command"] == "/bin/echo hi"
    assert payload["builtin"] is None


# ─────────────────────────────────────────────────────────────────────────────
# Wave D: `command_script` + `repo_script_conversion` on `hook show --json`
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_show_json_command_script_absolute_path_reads_the_body(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    script = tmp_path / "audit.sh"
    script.write_text("#!/bin/bash\necho audit\n")
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "audit", "--event", "PostToolUse",
         "--command", f"bash {script} --now")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "audit", "--json"))
    cs = payload["command_script"]
    assert cs["kind"] == "absolute"
    assert cs["token"] == str(script)
    loc = cs["locations"]
    assert len(loc) == 1
    assert loc[0]["project"] is None
    assert loc[0]["exists"] is True
    assert loc[0]["body"].startswith("#!/bin/bash")
    assert loc[0]["reason"] is None
    # `bash <absolute path>` is never convertible — a repo script is per-project.
    assert payload["repo_script_conversion"] is None


def test_hook_show_json_command_script_home_path_reads_the_body(
    tmp_data_home, monkeypatch, capsys
):
    script = Path.home() / "bin" / "audit.sh"
    script.parent.mkdir(parents=True)
    script.write_text("echo hi\n")
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "audit", "--event", "PostToolUse",
         "--command", "~/bin/audit.sh --now")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "audit", "--json"))
    cs = payload["command_script"]
    assert cs["kind"] == "home"
    assert cs["token"] == "~/bin/audit.sh"
    loc = cs["locations"][0]
    assert loc["project"] is None
    assert loc["exists"] is True
    assert loc["body"] == "echo hi\n"
    assert payload["repo_script_conversion"] is None


def test_hook_show_json_command_script_home_token_for_a_nonexistent_user_is_unresolvable(
    tmp_data_home, monkeypatch, capsys
):
    """`~nosuchuser/lint.sh` can't be expanded (no such user) — the location
    falls back to the literal path instead of raising."""
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--command", "bash ~nosuchuser/lint.sh")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    cs = payload["command_script"]
    assert cs["kind"] == "home"
    loc = cs["locations"]
    assert len(loc) == 1
    assert loc[0]["exists"] is False
    assert loc[0]["body"] is None
    assert loc[0]["reason"] == "unresolvable"


def test_hook_show_json_command_script_relative_across_two_projects_one_missing(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    good = tmp_path / "good"
    (good / "scripts").mkdir(parents=True)
    (good / "scripts" / "lint.sh").write_text("#!/bin/bash\necho lint\n")
    bad = tmp_path / "bad"
    bad.mkdir()
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "projects": {
            "alpha": {"path": str(good), "permissions": {}},
            "beta": {"path": str(bad), "permissions": {}},
        },
        "hooks_global": ["lint"],
        "hooks": {"lint": {"event": "PostToolUse", "command": "bash scripts/lint.sh --fix"}},
        "skills": {},
        "permissions_global": {},
        "remotes": {},
    })
    # A whole-tree snapshot (not just "does state/ exist") — the migration
    # pass inside `load_registry` would otherwise rewrite registry.yaml on
    # every load and this seed is already in the post-migration shape so it
    # actually proves the READ made zero writes.
    before = _data_home_snapshot(tmp_data_home)
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    cs = payload["command_script"]
    assert cs["kind"] == "relative"
    assert cs["token"] == "scripts/lint.sh"
    locs = {row["project"]: row for row in cs["locations"]}
    assert set(locs) == {"alpha", "beta"}
    assert locs["alpha"]["exists"] is True
    assert locs["alpha"]["body"].startswith("#!/bin/bash")
    assert locs["alpha"]["reason"] is None
    assert locs["beta"]["exists"] is False
    assert locs["beta"]["body"] is None
    assert locs["beta"]["reason"] is None
    # A read never writes anything anywhere under the data home.
    assert _data_home_snapshot(tmp_data_home) == before


def test_hook_show_json_command_script_traversal_token_is_outside_project(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    proj = tmp_path / "proj"
    proj.mkdir()
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "projects": {"alpha": {"path": str(proj)}},
        "hooks_global": ["lint"],
        "hooks": {"lint": {"event": "PostToolUse", "command": "bash ../escape.sh"}},
        "skills": {},
    })
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    cs = payload["command_script"]
    assert cs["kind"] == "relative"
    loc = cs["locations"][0]
    assert loc["project"] == "alpha"
    assert loc["exists"] is False
    assert loc["body"] is None
    assert loc["reason"] == "outside_project"
    assert payload["repo_script_conversion"] is None


def test_hook_show_json_command_script_and_conversion_null_for_a_one_liner(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "notify", "--event", "Stop",
         "--command", "say done")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "notify", "--json"))
    assert payload["command_script"] is None
    assert payload["repo_script_conversion"] is None


def test_hook_show_json_repo_script_conversion_from_a_bash_command_with_quoted_args(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--command", 'bash scripts/lint.sh --fix "a b"')
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    assert payload["repo_script_conversion"] == {
        "interpreter": "bash",
        "path": "scripts/lint.sh",
        "args": "--fix 'a b'",
    }


def test_hook_show_json_repo_script_conversion_from_a_bare_python_script(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--command", "scripts/lint.py")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    assert payload["repo_script_conversion"] == {
        "interpreter": "python3", "path": "scripts/lint.py", "args": "",
    }


def test_hook_show_json_repo_script_conversion_null_for_bash_dash_c(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--command", 'bash -c "echo hi"')
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    assert payload["repo_script_conversion"] is None


def test_hook_show_json_repo_script_conversion_null_for_python_dash_m(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--command", "python3 -m mod")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    assert payload["repo_script_conversion"] is None


def test_hook_show_json_repo_script_conversion_null_for_an_absolute_python_command(
    tmp_data_home, monkeypatch, capsys
):
    """`python3 /abs/x.py` is not convertible (a repo script is per-project), but
    `command_script` still detects the absolute path — the two keys are decided
    independently."""
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "lint", "--event", "PostToolUse",
         "--command", "python3 /abs/x.py")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "lint", "--json"))
    assert payload["repo_script_conversion"] is None
    assert payload["command_script"]["kind"] == "absolute"


def test_hook_show_json_command_script_and_conversion_null_for_the_real_builtin(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    payload = json.loads(
        _run(monkeypatch, capsys, "hook", "show", "lsp-report", "--json")
    )
    assert payload["command_script"] is None
    assert payload["repo_script_conversion"] is None


def test_hook_show_json_command_script_and_conversion_null_for_a_managed_script_hook(
    tmp_data_home, monkeypatch, capsys
):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--script-source", "managed", "--script-interpreter", "python3")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "show", "fmt", "--json"))
    assert payload["command_script"] is None
    assert payload["repo_script_conversion"] is None


# ─────────────────────────────────────────────────────────────────────────────
# Wave C: `hub hook doctor`
# ─────────────────────────────────────────────────────────────────────────────


def _fake_installed(monkeypatch, harness_ids):
    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setattr(harnesses, "detect_installed", lambda: set(harness_ids))


def test_hook_doctor_json_shape_is_clean_when_healthy(
    tmp_data_home, monkeypatch, capsys
):
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": ["fmt"],
        "hooks": {"fmt": {"event": "PostToolUse", "command": "/bin/echo hi"}},
        "projects": {},
        "skills": {},
    })
    payload = json.loads(_run(monkeypatch, capsys, "hook", "doctor", "--json"))
    assert payload == {"findings": [], "danger_count": 0}


def test_hook_doctor_deleted_managed_body_is_one_finding_attributed_to_its_hook(
    tmp_data_home, monkeypatch, capsys
):
    """No `hook new` ever ran, so the managed dir was never created — the same
    shape as a body deleted outside Skill Tree."""
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": ["fmt"],
        "hooks": {
            "fmt": {
                "event": "PostToolUse",
                "script": {"source": "managed", "interpreter": "bash"},
            }
        },
        "projects": {},
        "skills": {},
    })
    payload = json.loads(_run(monkeypatch, capsys, "hook", "doctor", "--json"))
    assert len(payload["findings"]) == 1
    f = payload["findings"][0]
    assert f["hook"] == "fmt"
    assert f["code"] == "HOOK_SCRIPT_MISSING"
    assert f["scope"] == "registry"
    assert f["harness"] == ""
    assert payload["danger_count"] == 0


def test_hook_doctor_sudo_hook_is_danger_json_exits_0_text_exits_2(
    tmp_data_home, monkeypatch, capsys
):
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": ["elevate"],
        "hooks": {
            "elevate": {"event": "PostToolUse", "command": "sudo /bin/echo hi"}
        },
        "projects": {},
        "skills": {},
    })
    out = _run(monkeypatch, capsys, "hook", "doctor", "--json")
    payload = json.loads(out)
    assert payload["danger_count"] == 1
    codes = {f["code"] for f in payload["findings"]}
    assert "HOOK_RUNS_SUDO" in codes
    assert payload["findings"][0]["hook"] == "elevate"
    assert payload["findings"][0]["scope"] == "global"
    assert payload["findings"][0]["harness"] == "claude-code"

    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, capsys, "hook", "doctor")
    assert exc.value.code == 2


def test_hook_doctor_is_a_pure_read_never_writes_under_state_hooks(
    tmp_data_home, monkeypatch, capsys
):
    """Exercises both bake paths (the real built-in lsp-report + a managed
    script hook whose body is missing) without materializing anything."""
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": ["lsp-report", "fmt"],
        "hooks": {
            "fmt": {
                "event": "PostToolUse",
                "script": {"source": "managed", "interpreter": "bash"},
            }
        },
        "projects": {},
        "skills": {},
    })
    _run(monkeypatch, capsys, "hook", "doctor", "--json")
    assert not (tmp_data_home / "state").exists()


def test_hook_doctor_dedupes_a_global_hook_across_projects_and_harnesses(
    tmp_data_home, monkeypatch, capsys
):
    """A `sudo` hook attached globally resolves into every installed harness
    AND every registered project — the raw scan would otherwise repeat the
    same finding (2 harnesses × (1 global + 2 projects) = 6 times). Dedupe on
    (hook, code, detail) collapses that to one, and `danger_count` is counted
    after dedupe."""
    _fake_installed(monkeypatch, {"claude-code", "codex"})
    alpha = tmp_data_home / "alpha"
    beta = tmp_data_home / "beta"
    alpha.mkdir()
    beta.mkdir()
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code", "codex"],
        "hooks_global": ["elevate"],
        "hooks": {
            "elevate": {"event": "PostToolUse", "command": "sudo /bin/echo hi"}
        },
        "projects": {
            "alpha": {"path": str(alpha)},
            "beta": {"path": str(beta)},
        },
        "skills": {},
    })
    payload = json.loads(_run(monkeypatch, capsys, "hook", "doctor", "--json"))
    sudo_findings = [f for f in payload["findings"] if f["code"] == "HOOK_RUNS_SUDO"]
    assert len(sudo_findings) == 1
    assert sudo_findings[0]["hook"] == "elevate"
    assert payload["danger_count"] == 1


def test_hook_doctor_skips_a_quarantined_project(tmp_data_home, monkeypatch, capsys):
    """`path_unresolved` mirrors the same guard `_run_hooks_stream` uses around
    hub.py's per-project pass — a quarantined project must not be scanned."""
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": ["elevate"],
        "hooks": {
            "elevate": {"event": "PostToolUse", "command": "sudo /bin/echo hi"}
        },
        "projects": {
            "ghost": {"path": "/nonexistent/does-not-exist", "path_unresolved": True},
        },
        "skills": {},
    })
    payload = json.loads(_run(monkeypatch, capsys, "hook", "doctor", "--json"))
    scopes = {f["scope"] for f in payload["findings"]}
    assert "project:ghost" not in scopes
    assert payload["danger_count"] == 1  # the global finding still fires


def test_hook_doctor_tolerates_a_non_dict_capability_cache_harnesses_value(
    tmp_data_home, monkeypatch, capsys
):
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": ["fmt"],
        "hooks": {"fmt": {"event": "PostToolUse", "command": "/bin/echo hi"}},
        "projects": {},
        "skills": {},
    })
    cache_path = tmp_data_home / "state" / "harness-capabilities.json"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({"harnesses": []}))
    payload = json.loads(_run(monkeypatch, capsys, "hook", "doctor", "--json"))
    assert payload == {"findings": [], "danger_count": 0}


def test_hook_doctor_tolerates_a_non_dict_capability_cache_entry(
    tmp_data_home, monkeypatch, capsys
):
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": ["fmt"],
        "hooks": {"fmt": {"event": "PostToolUse", "command": "/bin/echo hi"}},
        "projects": {},
        "skills": {},
    })
    cache_path = tmp_data_home / "state" / "harness-capabilities.json"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({"harnesses": {"claude-code": "not-a-dict"}}))
    payload = json.loads(_run(monkeypatch, capsys, "hook", "doctor", "--json"))
    assert payload == {"findings": [], "danger_count": 0}


def test_hook_doctor_skips_an_unattached_managed_hook_with_a_missing_body(
    tmp_data_home, monkeypatch, capsys
):
    """A definition that is neither in `hooks_global` nor any project's `hooks`
    never runs — its missing body must not surface a finding."""
    _fake_installed(monkeypatch, {"claude-code"})
    _seed(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "hooks_global": [],
        "hooks": {
            "fmt": {
                "event": "PostToolUse",
                "script": {"source": "managed", "interpreter": "bash"},
            }
        },
        "projects": {},
        "skills": {},
    })
    payload = json.loads(_run(monkeypatch, capsys, "hook", "doctor", "--json"))
    assert payload == {"findings": [], "danger_count": 0}


def test_hook_list_json_carries_the_baked_command(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    _run(monkeypatch, capsys, "hook", "new", "fmt", "--event", "PostToolUse",
         "--command", "/bin/echo hi")
    payload = json.loads(_run(monkeypatch, capsys, "hook", "list", "--json"))
    row = next(h for h in payload["hooks"] if h["name"] == "fmt")
    assert row["baked_command"] == "/bin/echo hi"
