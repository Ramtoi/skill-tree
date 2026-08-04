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


def _seed(data_home: Path, registry: dict | None = None) -> None:
    reg = registry or {
        "harnesses_global": ["claude-code"],
        "projects": {"alpha": {"path": str(data_home / "alpha"), "permissions": {}}},
        "skills": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


def _reg(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


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
    import hooks_model

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
    assert hub._hook_command_arg(_ns(hook_command=None, command="hook")) is None
    assert hub._hook_command_arg(_ns(hook_command="/x", command="hook")) == "/x"
    # Direct callers/tests that only pass `command` keep working.
    assert hub._hook_command_arg(_ns(command="/y")) == "/y"


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
    import hooks_model

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
    import hooks_model

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
    import hooks_model

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
