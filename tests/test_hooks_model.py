"""Tests for hooks_model.py — definitions, attach resolution, settings merge.

No dependency on hub's data_home()/tmp_data_home; ``builtin_hooks_dir``/
``load_builtin_hooks`` accept an explicit ``code_home`` so built-in scanning is
tested against a plain ``tmp_path``. Warnings are captured via the injectable
``warn`` callback (a list-appending closure) rather than asserted on stderr.
"""

from __future__ import annotations

from pathlib import Path

import hooks_model as hm

REPO_ROOT = Path(__file__).resolve().parent.parent


def _capture():
    msgs: list[str] = []
    return msgs.append, msgs


# ─────────────────────────────────────────────────────────────────────────────
# HookDefinition parsing + round-trip
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_registry_hooks_round_trip():
    registry = {
        "hooks": {
            "my-hook": {
                "description": "desc",
                "event": "PostToolUse",
                "tools": ["Bash", "Edit"],
                "matcher": "",
                "command": "echo hi",
                "timeout": 30,
                "harnesses": ["claude-code"],
                "settings": {"foo": "bar"},
            }
        }
    }
    defs = hm.parse_registry_hooks(registry)
    assert set(defs) == {"my-hook"}
    d = defs["my-hook"]
    assert d.name == "my-hook"
    assert d.event == "PostToolUse"
    assert d.command == "echo hi"
    assert d.tools == ["Bash", "Edit"]
    assert d.timeout == 30
    assert d.harnesses == ["claude-code"]
    assert d.settings == {"foo": "bar"}
    assert d.provenance == "user"

    # Round-trip through to_block()/from_block().
    block = d.to_block()
    d2 = hm.HookDefinition.from_block("my-hook", block, provenance="user")
    assert d2 == d


def test_to_block_omits_default_fields():
    d = hm.HookDefinition(name="bare", event="PreToolUse", command="echo")
    block = d.to_block()
    assert block == {"event": "PreToolUse", "command": "echo"}


def test_parse_registry_hooks_not_a_map_warns_and_returns_empty():
    warn, msgs = _capture()
    defs = hm.parse_registry_hooks({"hooks": ["not", "a", "map"]}, warn=warn)
    assert defs == {}
    assert any("not a map" in m for m in msgs)


def test_parse_registry_hooks_skips_malformed_entry():
    warn, msgs = _capture()
    registry = {
        "hooks": {
            "good": {"event": "PreToolUse", "command": "c"},
            "bad": "not-a-dict",
        }
    }
    defs = hm.parse_registry_hooks(registry, warn=warn)
    assert set(defs) == {"good"}
    assert any("bad" in m and "skipped" in m for m in msgs)


def test_from_block_tolerant_coercion_of_bad_collections():
    d = hm.HookDefinition.from_block(
        "x",
        {
            "event": "PreToolUse",
            "command": "c",
            "tools": "not-a-list",
            "harnesses": "not-a-list",
            "settings": "not-a-dict",
            "timeout": "not-an-int",
        },
    )
    assert d.tools == []
    assert d.harnesses is None
    assert d.settings == {}
    assert d.timeout is None


# ─────────────────────────────────────────────────────────────────────────────
# Deep merge
# ─────────────────────────────────────────────────────────────────────────────


def test_deep_merge_project_wins_per_key_nested_merges_lists_replace():
    base = {"a": 1, "nested": {"x": 1, "y": 2}, "list": [1, 2]}
    override = {"nested": {"y": 99, "z": 3}, "list": [9]}
    merged = hm.deep_merge(base, override)
    assert merged == {"a": 1, "nested": {"x": 1, "y": 99, "z": 3}, "list": [9]}


def test_deep_merge_empty_override_is_a_copy_of_base():
    base = {"a": 1}
    merged = hm.deep_merge(base, {})
    assert merged == base
    assert merged is not base


def test_deep_merge_override_dict_over_non_dict_base_replaces():
    base = {"a": "scalar"}
    override = {"a": {"nested": 1}}
    assert hm.deep_merge(base, override) == {"a": {"nested": 1}}


# ─────────────────────────────────────────────────────────────────────────────
# Built-in scanning (tmp code_home)
# ─────────────────────────────────────────────────────────────────────────────


def test_builtin_hooks_dir_joins_code_home(tmp_path):
    assert hm.builtin_hooks_dir(tmp_path) == tmp_path / "hooks"


def test_load_builtin_hooks_absent_dir_returns_empty(tmp_path):
    assert hm.load_builtin_hooks(tmp_path / "nonexistent") == {}


def test_load_builtin_hooks_scans_dir_with_script(tmp_path):
    hook_dir = tmp_path / "hooks" / "my-builtin"
    hook_dir.mkdir(parents=True)
    (hook_dir / "hook.yaml").write_text(
        "event: PreToolUse\ncommand: ./script.sh\nsettings:\n  threshold: 5\n"
    )
    (hook_dir / "script.sh").write_text("#!/bin/sh\necho ok\n")
    defs = hm.load_builtin_hooks(tmp_path)
    assert set(defs) == {"my-builtin"}
    d = defs["my-builtin"]
    assert d.name == "my-builtin"
    assert d.event == "PreToolUse"
    assert d.command == "./script.sh"
    assert d.settings == {"threshold": 5}
    assert d.provenance == "builtin"


def test_builtin_dir_name_is_authoritative_over_yaml_name_field(tmp_path):
    hook_dir = tmp_path / "hooks" / "real-name"
    hook_dir.mkdir(parents=True)
    (hook_dir / "hook.yaml").write_text("name: fake-name\nevent: Stop\ncommand: x\n")
    defs = hm.load_builtin_hooks(tmp_path)
    assert set(defs) == {"real-name"}
    assert defs["real-name"].name == "real-name"


def test_load_builtin_hooks_skips_dir_without_hook_yaml(tmp_path):
    (tmp_path / "hooks" / "empty-dir").mkdir(parents=True)
    assert hm.load_builtin_hooks(tmp_path) == {}


def test_load_builtin_hooks_malformed_yaml_skipped_and_warned(tmp_path):
    hook_dir = tmp_path / "hooks" / "bad"
    hook_dir.mkdir(parents=True)
    (hook_dir / "hook.yaml").write_text("- just\n- a\n- list\n")
    warn, msgs = _capture()
    defs = hm.load_builtin_hooks(tmp_path, warn=warn)
    assert defs == {}
    assert any("bad" in m for m in msgs)


def test_load_builtin_hooks_multiple_dirs(tmp_path):
    for name, event in (("a-hook", "PreToolUse"), ("b-hook", "Stop")):
        d = tmp_path / "hooks" / name
        d.mkdir(parents=True)
        (d / "hook.yaml").write_text(f"event: {event}\ncommand: c\n")
    defs = hm.load_builtin_hooks(tmp_path)
    assert set(defs) == {"a-hook", "b-hook"}
    assert defs["a-hook"].event == "PreToolUse"
    assert defs["b-hook"].event == "Stop"


# ─────────────────────────────────────────────────────────────────────────────
# Shadow resolution (registry wins over built-in, warns)
# ─────────────────────────────────────────────────────────────────────────────


def test_resolve_definition_registry_shadows_builtin_and_warns(tmp_path):
    builtin_dir = tmp_path / "hooks" / "shared-hook"
    builtin_dir.mkdir(parents=True)
    (builtin_dir / "hook.yaml").write_text("event: PreToolUse\ncommand: builtin-cmd\n")
    registry = {"hooks": {"shared-hook": {"event": "PostToolUse", "command": "user-cmd"}}}
    warn, msgs = _capture()
    result = hm.resolve_definition(
        "shared-hook",
        hm.parse_registry_hooks(registry),
        hm.load_builtin_hooks(tmp_path),
        warn=warn,
    )
    assert result is not None
    assert result.command == "user-cmd"
    assert result.provenance == "user"
    assert any("shadows" in m for m in msgs)


def test_resolve_definition_no_warning_when_only_builtin_exists(tmp_path):
    builtin_dir = tmp_path / "hooks" / "only-builtin"
    builtin_dir.mkdir(parents=True)
    (builtin_dir / "hook.yaml").write_text("event: PreToolUse\ncommand: c\n")
    warn, msgs = _capture()
    result = hm.resolve_definition(
        "only-builtin", {}, hm.load_builtin_hooks(tmp_path), warn=warn
    )
    assert result is not None
    assert result.provenance == "builtin"
    assert msgs == []


def test_resolve_definition_dangling_name_returns_none_no_warning_itself():
    # resolve_definition itself does not warn on dangling — callers warn + omit.
    warn, msgs = _capture()
    result = hm.resolve_definition("ghost", {}, {}, warn=warn)
    assert result is None
    assert msgs == []


def test_all_definitions_registry_wins_and_warns(tmp_path):
    builtin_dir_1 = tmp_path / "hooks" / "b1"
    builtin_dir_1.mkdir(parents=True)
    (builtin_dir_1 / "hook.yaml").write_text("event: PreToolUse\ncommand: builtin-cmd\n")
    builtin_dir_2 = tmp_path / "hooks" / "b2"
    builtin_dir_2.mkdir(parents=True)
    (builtin_dir_2 / "hook.yaml").write_text("event: PostToolUse\ncommand: only-builtin\n")
    registry = {"hooks": {"b1": {"event": "Stop", "command": "user-cmd"}}}
    warn, msgs = _capture()
    defs = hm.all_definitions(registry, code_home=tmp_path, warn=warn)
    assert set(defs) == {"b1", "b2"}
    assert defs["b1"].command == "user-cmd"
    assert defs["b1"].provenance == "user"
    assert defs["b2"].provenance == "builtin"
    assert any("shadows" in m for m in msgs)


# ─────────────────────────────────────────────────────────────────────────────
# Attach resolution: ordering/dedup, dangling names, settings merge
# ─────────────────────────────────────────────────────────────────────────────


def test_resolve_project_hooks_union_order_global_then_project():
    registry = {
        "hooks": {
            "h1": {"event": "PreToolUse", "command": "c1"},
            "h2": {"event": "PostToolUse", "command": "c2"},
        },
        "hooks_global": ["h1"],
        "projects": {"proj": {"hooks": ["h2"]}},
    }
    resolved = hm.resolve_project_hooks("proj", registry)
    assert [r.name for r in resolved] == ["h1", "h2"]


def test_resolve_project_hooks_dedupes_when_in_both_global_and_project():
    registry = {
        "hooks": {"h1": {"event": "PreToolUse", "command": "c1"}},
        "hooks_global": ["h1"],
        "projects": {"proj": {"hooks": ["h1"]}},
    }
    resolved = hm.resolve_project_hooks("proj", registry)
    assert [r.name for r in resolved] == ["h1"]


def test_resolve_project_hooks_preserves_list_order_not_sorted():
    registry = {
        "hooks": {
            "zeta": {"event": "PreToolUse", "command": "c"},
            "alpha": {"event": "PreToolUse", "command": "c"},
        },
        "hooks_global": ["zeta", "alpha"],
        "projects": {"proj": {}},
    }
    resolved = hm.resolve_project_hooks("proj", registry)
    assert [r.name for r in resolved] == ["zeta", "alpha"]


def test_resolve_project_hooks_dangling_name_warns_and_omits():
    registry = {"hooks": {}, "projects": {"proj": {"hooks": ["ghost"]}}}
    warn, msgs = _capture()
    resolved = hm.resolve_project_hooks("proj", registry, warn=warn)
    assert resolved == []
    assert any("ghost" in m and "omitted" in m for m in msgs)


def test_resolve_project_hooks_unknown_project_yields_empty():
    registry = {"hooks": {}, "hooks_global": [], "projects": {}}
    assert hm.resolve_project_hooks("nope", registry) == []


def test_resolve_project_hooks_settings_deep_merge_project_wins():
    registry = {
        "hooks": {
            "h1": {
                "event": "PreToolUse",
                "command": "c1",
                "settings": {"a": 1, "nested": {"x": 1, "y": 2}},
            },
        },
        "hooks_global": ["h1"],
        "projects": {
            "proj": {
                "hook_settings": {"h1": {"a": 2, "nested": {"y": 99, "z": 3}}},
            }
        },
    }
    resolved = hm.resolve_project_hooks("proj", registry)
    assert len(resolved) == 1
    assert resolved[0].settings == {"a": 2, "nested": {"x": 1, "y": 99, "z": 3}}


def test_resolve_project_hooks_no_override_uses_definition_defaults():
    registry = {
        "hooks": {"h1": {"event": "PreToolUse", "command": "c1", "settings": {"a": 1}}},
        "hooks_global": ["h1"],
        "projects": {"proj": {}},
    }
    resolved = hm.resolve_project_hooks("proj", registry)
    assert resolved[0].settings == {"a": 1}


def test_resolve_project_hooks_orphaned_hook_settings_warns_and_pruned():
    registry = {
        "hooks": {"h1": {"event": "PreToolUse", "command": "c1"}},
        "projects": {
            "proj": {
                "hooks": ["h1"],
                "hook_settings": {"h1": {"a": 1}, "ghost": {"b": 2}},
            }
        },
    }
    warn, msgs = _capture()
    resolved = hm.resolve_project_hooks("proj", registry, warn=warn)
    assert len(resolved) == 1
    assert resolved[0].settings == {"a": 1}
    assert any("ghost" in m and "not attached" in m for m in msgs)


def test_resolve_project_hooks_hook_settings_not_a_dict_ignored():
    registry = {
        "hooks": {"h1": {"event": "PreToolUse", "command": "c1", "settings": {"a": 1}}},
        "hooks_global": ["h1"],
        "projects": {"proj": {"hook_settings": "not-a-dict"}},
    }
    resolved = hm.resolve_project_hooks("proj", registry)
    assert resolved[0].settings == {"a": 1}


def test_resolve_project_hooks_resolves_via_builtin(tmp_path):
    builtin_dir = tmp_path / "hooks" / "b1"
    builtin_dir.mkdir(parents=True)
    (builtin_dir / "hook.yaml").write_text(
        "event: PreToolUse\ncommand: builtin-cmd\nsettings:\n  a: 1\n"
    )
    registry = {"hooks": {}, "projects": {"proj": {"hooks": ["b1"]}}}
    resolved = hm.resolve_project_hooks("proj", registry, code_home=tmp_path)
    assert len(resolved) == 1
    assert resolved[0].provenance == "builtin"
    assert resolved[0].settings == {"a": 1}


# ─────────────────────────────────────────────────────────────────────────────
# resolve_global_hooks
# ─────────────────────────────────────────────────────────────────────────────


def test_resolve_global_hooks_uses_definition_base_settings():
    registry = {
        "hooks": {"h1": {"event": "PreToolUse", "command": "c1", "settings": {"a": 1}}},
        "hooks_global": ["h1"],
    }
    resolved = hm.resolve_global_hooks(registry)
    assert [r.name for r in resolved] == ["h1"]
    assert resolved[0].settings == {"a": 1}


def test_resolve_global_hooks_dedupes_and_preserves_order():
    registry = {
        "hooks": {
            "h1": {"event": "PreToolUse", "command": "c1"},
            "h2": {"event": "PostToolUse", "command": "c2"},
        },
        "hooks_global": ["h2", "h1", "h2"],
    }
    resolved = hm.resolve_global_hooks(registry)
    assert [r.name for r in resolved] == ["h2", "h1"]


def test_resolve_global_hooks_dangling_name_warns_and_omits():
    registry = {"hooks": {}, "hooks_global": ["ghost"]}
    warn, msgs = _capture()
    resolved = hm.resolve_global_hooks(registry, warn=warn)
    assert resolved == []
    assert any("ghost" in m and "omitted" in m for m in msgs)


def test_resolve_global_hooks_empty_when_no_hooks_global_key():
    assert hm.resolve_global_hooks({"hooks": {}}) == []


# ─────────────────────────────────────────────────────────────────────────────
# The SHIPPED built-ins (real code_home = the repo root)
#
# Every test above scans a synthetic tmp_path code_home. `load_builtin_hooks`
# WARNS-AND-SKIPS a malformed/absent hook.yaml and `resolve_definition` then
# returns None for the attached name — so a yaml typo or a dropped file makes the
# built-in vanish from every user's sync with no error and no non-zero exit.
# These load the real on-disk definitions and pin the shipped contract.
# ─────────────────────────────────────────────────────────────────────────────


def _shipped():
    warn, msgs = _capture()
    defs = hm.load_builtin_hooks(REPO_ROOT, warn=warn)
    return defs, msgs


def test_shipped_builtins_parse_cleanly_from_the_repo_code_home():
    defs, msgs = _shipped()
    assert msgs == [], f"a shipped hook.yaml failed to parse: {msgs}"
    assert "lsp-report" in defs, (
        "the built-in lsp-report disappeared from code_home()/hooks/ — an attached "
        "name that resolves to nothing is only WARNED, never an error"
    )
    assert defs["lsp-report"].provenance == "builtin"
    # The dir name is authoritative, and every shipped dir has a real hook.yaml.
    for name, definition in defs.items():
        assert definition.name == name
        assert (REPO_ROOT / "hooks" / name / "hook.yaml").is_file()


def test_shipped_lsp_report_pins_event_and_edit_tool_family():
    defs, _ = _shipped()
    d = defs["lsp-report"]
    assert d.event == "PostToolUse"
    # The Edit family is load-bearing: codex collapses Edit|Write|MultiEdit onto
    # its single `apply_patch` tool, so drifting off this list silently stops the
    # hook firing there (tool_catalog.translate_tools).
    assert d.tools == ["Edit", "Write", "MultiEdit"]
    # `matcher` must stay empty — a raw matcher would BYPASS that translation and
    # be written verbatim on every harness.
    assert d.matcher == ""
    assert d.description


def test_shipped_lsp_report_pins_the_documented_language_defaults():
    """docs/HOOKS.md §Per-language settings: python/go on, typescript/rust off,
    all advisory @30s. Drift here also desynchronizes the script's own
    `_DEFAULT_LANGUAGES` fail-open fallback."""
    defs, _ = _shipped()
    assert defs["lsp-report"].settings == {
        "languages": {
            "python": {"enabled": True, "mode": "advisory", "timeout": 30},
            "go": {"enabled": True, "mode": "advisory", "timeout": 30},
            "typescript": {"enabled": False, "mode": "advisory", "timeout": 30},
            "rust": {"enabled": False, "mode": "advisory", "timeout": 30},
        }
    }


def test_shipped_lsp_report_ships_its_script_next_to_hook_yaml():
    # `lsp_report_sync.lsp_report_command` bakes exactly this path.
    assert (REPO_ROOT / "hooks" / "lsp-report" / "lsp_report.py").is_file()


def test_shipped_lsp_report_resolves_when_attached_without_a_registry_entry():
    """The built-in must be reachable by NAME alone — it is never written into
    registry.yaml, so an attach list is the only thing pointing at it."""
    registry = {
        "hooks": {},
        "hooks_global": ["lsp-report"],
        "projects": {"proj": {}},
    }
    warn, msgs = _capture()
    resolved = hm.resolve_global_hooks(registry, code_home=REPO_ROOT, warn=warn)
    assert [r.name for r in resolved] == ["lsp-report"]
    assert resolved[0].provenance == "builtin"
    assert resolved[0].event == "PostToolUse"
    assert resolved[0].settings["languages"]["python"]["enabled"] is True
    assert msgs == []

    project_resolved = hm.resolve_project_hooks(
        "proj", registry, code_home=REPO_ROOT
    )
    assert [r.name for r in project_resolved] == ["lsp-report"]


def test_shipped_lsp_report_project_hook_settings_deep_merge_over_defaults():
    registry = {
        "hooks": {},
        "projects": {
            "proj": {
                "hooks": ["lsp-report"],
                "hook_settings": {
                    "lsp-report": {"languages": {"rust": {"enabled": True}}}
                },
            }
        },
    }
    resolved = hm.resolve_project_hooks("proj", registry, code_home=REPO_ROOT)
    langs = resolved[0].settings["languages"]
    assert langs["rust"] == {"enabled": True, "mode": "advisory", "timeout": 30}
    # Untouched languages keep the shipped defaults (deep merge, not replace).
    assert langs["python"]["enabled"] is True
    assert langs["typescript"]["enabled"] is False


def test_resolve_global_hooks_settings_is_independent_copy():
    registry = {
        "hooks": {"h1": {"event": "PreToolUse", "command": "c1", "settings": {"a": 1}}},
        "hooks_global": ["h1"],
    }
    resolved = hm.resolve_global_hooks(registry)
    resolved[0].settings["a"] = 999
    # Re-resolving must not see the mutation (the definition's own settings dict
    # is untouched — ResolvedHook.settings is a fresh dict()).
    resolved_again = hm.resolve_global_hooks(registry)
    assert resolved_again[0].settings == {"a": 1}
