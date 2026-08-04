"""Hook adapters — nested Claude schema, codex TOML tables, sidecar disjointness,
byte-stable re-sync, flat-entry repair, honest capability gating."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import tomlkit

import hook_adapters as ha
import permission_adapters as pa
from harness_probe import (
    FEATURE_OFF,
    NOT_INSTALLED,
    SUPPORTED,
    UNSUPPORTED,
    HookCapability,
)
from hooks_model import ResolvedHook
from permissions import (
    GlobalScope,
    NormalizedPermissions,
    ProjectScope,
    Rule,
    read_sidecar,
)


@pytest.fixture(autouse=True)
def _reset_backup_state():
    ha._reset_backup_session_state_for_tests()
    pa._reset_backup_session_state_for_tests()
    yield
    ha._reset_backup_session_state_for_tests()
    pa._reset_backup_session_state_for_tests()


def _base_keys(keys):
    """Managed keys with their identity-fingerprint suffix stripped.

    Ownership keys are `hooks.<Event>[<i>]#<fp>`; assertions about WHICH slots
    hub claims care only about the `hooks.<Event>[<i>]` part. The fingerprint
    itself is pinned by the identity-ownership tests below.
    """
    return [str(k).split("#", 1)[0] for k in keys]


def _hook(name="c-hook", event="PostToolUse", command="./c.sh", tools=None,
          matcher="", timeout=None, harnesses=None):
    return ResolvedHook(
        name=name,
        event=event,
        command=command,
        tools=list(tools or []),
        matcher=matcher,
        timeout=timeout,
        harnesses=harnesses,
        settings={},
        provenance="user",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Claude adapter
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_nested_schema_pinned(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    hook = _hook(event="PostToolUse", matcher="Edit|Write", command="./c.sh")
    result = adapter.apply(scope, [hook], "claude-code")

    target = tmp_path / ".claude" / "settings.local.json"
    assert result.target == target
    assert result.written is True
    data = json.loads(target.read_text())
    entry = data["hooks"]["PostToolUse"][0]
    assert entry["matcher"] == "Edit|Write"
    assert entry["hooks"] == [{"type": "command", "command": "./c.sh"}]


def test_claude_global_lands_in_user_settings(tmp_data_home, tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    adapter = ha.ClaudeHookAdapter()
    result = adapter.apply(GlobalScope(), [_hook()], "claude-code")
    assert result.target == (home / ".claude" / "settings.json")
    assert result.target.exists()


def test_claude_project_never_writes_committed_settings(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="alpha", path=str(tmp_path))
    adapter.apply(scope, [_hook()], "claude-code")
    assert (tmp_path / ".claude" / "settings.local.json").exists()
    assert not (tmp_path / ".claude" / "settings.json").exists()


def test_claude_timeout_emitted(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook(timeout=45)], "claude-code")
    data = json.loads((tmp_path / ".claude/settings.local.json").read_text())
    assert data["hooks"]["PostToolUse"][0]["hooks"][0]["timeout"] == 45


def test_claude_preserves_unrelated_keys(tmp_data_home, tmp_path):
    target = tmp_path / ".claude" / "settings.local.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({
        "model": "sonnet",
        "permissions": {"allow": ["UserAuthored(*)"]},
        "unrelated": {"foo": "bar"},
    }, indent=2) + "\n")
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook()], "claude-code")
    data = json.loads(target.read_text())
    assert data["model"] == "sonnet"
    assert data["permissions"]["allow"] == ["UserAuthored(*)"]
    assert data["unrelated"] == {"foo": "bar"}
    assert "PostToolUse" in data["hooks"]


def test_claude_empty_tools_is_all_tools_matcher(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook(tools=[])], "claude-code")
    data = json.loads((tmp_path / ".claude/settings.local.json").read_text())
    assert data["hooks"]["PostToolUse"][0]["matcher"] == ""


def test_claude_tools_translate_to_matcher(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook(tools=["Edit", "Write"], matcher="")], "claude-code")
    data = json.loads((tmp_path / ".claude/settings.local.json").read_text())
    assert data["hooks"]["PostToolUse"][0]["matcher"] == "Edit|Write"


def test_claude_matcher_bypasses_translation(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    # A raw matcher wins over tools verbatim.
    adapter.apply(scope, [_hook(tools=["Edit"], matcher="^Bash$")], "claude-code")
    data = json.loads((tmp_path / ".claude/settings.local.json").read_text())
    assert data["hooks"]["PostToolUse"][0]["matcher"] == "^Bash$"


def test_claude_byte_stable_resync(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    target = tmp_path / ".claude/settings.local.json"
    r1 = adapter.apply(scope, [_hook()], "claude-code")
    assert r1.written is True
    text1 = target.read_text()
    r2 = adapter.apply(scope, [_hook()], "claude-code")
    assert r2.written is False
    assert target.read_text() == text1


def test_claude_sidecar_kind_is_hooks(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook()], "claude-code")
    sc = read_sidecar("claude-code", scope, "hooks")
    assert sc is not None
    assert _base_keys(sc.managed_keys) == ["hooks.PostToolUse[0]"]
    # The permissions (default-kind) sidecar is NOT created by a hook write.
    assert read_sidecar("claude-code", scope, "") is None


def test_hooks_and_permissions_sidecars_coexist(tmp_data_home, tmp_path):
    """A permission rule and a hook written to the same settings.local.json —
    disjoint sidecars, neither strip clobbers the other's content."""
    scope = ProjectScope(name="a", path=str(tmp_path), personal=True)
    hook_scope = ProjectScope(name="a", path=str(tmp_path))

    # Permission rule → settings.local.json (personal scope) + permissions sidecar.
    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(npm:*)", kind="allow")])
    padapter = pa.ClaudePermissionAdapter()
    presult = padapter.translate(perms, scope, "claude-code")
    padapter.apply(scope, presult.writes[0], "claude-code")

    # Hook → same file + a DISJOINT hooks sidecar.
    hadapter = ha.ClaudeHookAdapter()
    hadapter.apply(hook_scope, [_hook()], "claude-code")

    target = tmp_path / ".claude/settings.local.json"
    data = json.loads(target.read_text())
    assert "Bash(npm:*)" in data["permissions"]["allow"]
    assert "PostToolUse" in data["hooks"]

    perm_sc = read_sidecar("claude-code", scope, "")
    hook_sc = read_sidecar("claude-code", hook_scope, "hooks")
    assert perm_sc is not None and perm_sc.managed_keys == ["permissions.allow[0]"]
    assert hook_sc is not None
    assert _base_keys(hook_sc.managed_keys) == ["hooks.PostToolUse[0]"]

    # Re-applying the hook leaves the permission rule intact.
    hadapter.apply(hook_scope, [_hook()], "claude-code")
    data = json.loads(target.read_text())
    assert "Bash(npm:*)" in data["permissions"]["allow"]
    assert len(data["hooks"]["PostToolUse"]) == 1


def test_claude_cleanup_only_removes_sidecar_owned(tmp_data_home, tmp_path):
    target = tmp_path / ".claude/settings.local.json"
    target.parent.mkdir(parents=True)
    # A user-authored hook already on disk.
    target.write_text(json.dumps({
        "hooks": {"PostToolUse": [
            {"matcher": "UserTool", "hooks": [{"type": "command", "command": "user.sh"}]}
        ]}
    }, indent=2) + "\n")
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    # Hub appends its own at index 1.
    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    data = json.loads(target.read_text())
    assert len(data["hooks"]["PostToolUse"]) == 2

    res = adapter.cleanup(scope, "claude-code", owned_names=set())
    assert res.removed is True
    data = json.loads(target.read_text())
    cmds = [e["hooks"][0]["command"] for e in data["hooks"]["PostToolUse"]]
    assert cmds == ["user.sh"]  # hub entry gone, user entry survives
    assert read_sidecar("claude-code", scope, "hooks") is None


def test_claude_cleanup_backs_up_before_rewriting(tmp_data_home, tmp_path):
    """cleanup() must back up the native file before stripping, same as apply()."""
    import hub

    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook()], "claude-code")
    ha._reset_backup_session_state_for_tests()  # cleanup gets its own backup slot

    res = adapter.cleanup(scope, "claude-code", owned_names=set())
    assert res.removed is True
    backup_dir = hub.data_home() / "_hub-backups" / "hooks" / "claude-code" / scope.slug
    backups = list(backup_dir.glob("*.json"))
    assert len(backups) == 1
    backed_up = json.loads(backups[0].read_text())
    assert "hooks" in backed_up  # backup captured the PRE-strip content


def test_claude_detach_removes_prior_hub_entry(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook()], "claude-code")
    # Next sync with the hook detached (empty list) strips the prior entry.
    r = adapter.apply(scope, [], "claude-code")
    data = json.loads((tmp_path / ".claude/settings.local.json").read_text())
    assert "hooks" not in data
    assert read_sidecar("claude-code", scope, "hooks") is None
    assert r.managed_keys == []


def test_claude_flat_entry_repaired_to_nested_one_write(tmp_data_home, tmp_path):
    """A legacy FLAT hooks.* entry recorded in the hooks sidecar is stripped and
    re-emitted nested in a single apply; a re-run makes no further change."""
    from permissions import write_sidecar

    target = tmp_path / ".claude/settings.local.json"
    target.parent.mkdir(parents=True)
    # Legacy flat shape hub used to write, recorded in the hooks sidecar.
    target.write_text(json.dumps({
        "hooks": {"PostToolUse": [{"matcher": "Edit|Write", "command": "./c.sh"}]}
    }, indent=2) + "\n")
    scope = ProjectScope(name="a", path=str(tmp_path))
    write_sidecar("claude-code", scope, ["hooks.PostToolUse[0]"], target, "hooks")

    adapter = ha.ClaudeHookAdapter()
    r1 = adapter.apply(scope, [_hook(matcher="Edit|Write")], "claude-code")
    assert r1.written is True
    data = json.loads(target.read_text())
    entry = data["hooks"]["PostToolUse"][0]
    assert "command" not in entry  # flat key gone
    assert entry["hooks"] == [{"type": "command", "command": "./c.sh"}]
    assert len(data["hooks"]["PostToolUse"]) == 1  # not duplicated

    r2 = adapter.apply(scope, [_hook(matcher="Edit|Write")], "claude-code")
    assert r2.written is False  # idempotent


def test_claude_two_hooks_on_different_events(tmp_data_home, tmp_path):
    """Index allocation is per-event: two hooks on DIFFERENT events each take
    index 0 of their own event list."""
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    r = adapter.apply(scope, [
        _hook(name="a", event="PostToolUse", command="/a.sh"),
        _hook(name="b", event="PreToolUse", command="/b.sh"),
    ], "claude-code")
    assert _base_keys(r.managed_keys) == ["hooks.PostToolUse[0]", "hooks.PreToolUse[0]"]
    data = json.loads((tmp_path / ".claude/settings.local.json").read_text())
    assert len(data["hooks"]["PostToolUse"]) == 1
    assert len(data["hooks"]["PreToolUse"]) == 1


def test_claude_unsupported_event_skipped(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    r = adapter.apply(scope, [_hook(event="NoSuchEvent")], "claude-code")
    assert r.written is False
    assert not (tmp_path / ".claude/settings.local.json").exists()
    assert len(r.skipped) == 1


def test_claude_affinity_narrows_away_from_codex_only_hook(tmp_data_home, tmp_path):
    """A hook declaring `harnesses: [codex]` must NOT reach claude-code."""
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    r = adapter.apply(scope, [_hook(harnesses=["codex"])], "claude-code")
    assert r.written is False
    assert not (tmp_path / ".claude/settings.local.json").exists()
    assert len(r.skipped) == 1
    assert "affinity" in r.skipped[0].reason


def test_claude_affinity_reaches_matching_harness(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    r = adapter.apply(scope, [_hook(harnesses=["claude-code", "codex"])], "claude-code")
    assert r.written is True
    assert r.written_names == ["c-hook"]


def test_claude_feature_off_keeps_entries(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook()], "claude-code")
    target = tmp_path / ".claude/settings.local.json"
    before = target.read_text()
    cap = HookCapability(harness_id="claude-code", verdict=FEATURE_OFF, reason="off")
    r = adapter.apply(scope, [_hook()], "claude-code", capability=cap)
    assert r.disabled is True
    assert r.written is False
    assert target.read_text() == before  # entries kept, untouched


def test_claude_unsupported_capability_no_write(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    cap = HookCapability(harness_id="pi", verdict=UNSUPPORTED, reason="pi shim")
    r = adapter.apply(scope, [_hook()], "pi", capability=cap)
    assert r.written is False
    assert not (tmp_path / ".pi/agent/settings.local.json").exists()
    assert r.reason == "pi shim"


def test_claude_discover_existing(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook(matcher="Edit", timeout=10)], "claude-code")
    found = adapter.discover_existing(scope, "claude-code")
    assert len(found) == 1
    assert found[0].event == "PostToolUse"
    assert found[0].matcher == "Edit"
    assert found[0].command == "./c.sh"
    assert found[0].timeout == 10


# ─────────────────────────────────────────────────────────────────────────────
# Codex adapter
# ─────────────────────────────────────────────────────────────────────────────


def _codex_apply(tmp_path, hooks, existing=None, capability=None):
    target = tmp_path / "config.toml"
    if existing is not None:
        target.write_text(existing)
    adapter = ha.CodexHookAdapter()
    # Point the adapter at our tmp config.toml.
    orig = adapter._target
    adapter._target = lambda scope: target  # type: ignore
    result = adapter.apply(GlobalScope(), hooks, "codex", capability=capability)
    adapter._target = orig  # type: ignore
    return adapter, target, result


def test_codex_skips_gracefully_without_tomlkit(tmp_data_home, tmp_path, monkeypatch):
    """A Python env without tomlkit (e.g. a CI job that never pip-installs it)
    must degrade the Codex hook write to a clean skip, not crash the whole
    sync with an uncaught ImportError."""
    monkeypatch.setattr(ha, "_tomlkit_missing", lambda: True)
    adapter, target, result = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch")]
    )
    assert result.written is False
    assert not target.exists()
    assert len(result.skipped) == 1
    assert "tomlkit" in result.reason

    assert adapter.discover_existing(GlobalScope(), "codex") == []
    assert adapter.cleanup(GlobalScope(), "codex", owned_names=set()).removed is False


def test_codex_toml_shape_pinned(tmp_data_home, tmp_path):
    _, target, result = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch", command="true", timeout=60)]
    )
    assert result.written is True
    doc = tomlkit.parse(target.read_text())
    aot = doc["hooks"]["PostToolUse"]
    assert len(aot) == 1
    assert aot[0]["matcher"] == "apply_patch"
    inner = aot[0]["hooks"]
    assert inner[0]["type"] == "command"
    assert inner[0]["command"] == "true"          # STRING, never an array
    assert isinstance(inner[0]["command"], str)
    assert inner[0]["timeout"] == 60


def test_codex_edit_family_maps_to_apply_patch(tmp_data_home, tmp_path):
    _, target, _ = _codex_apply(
        tmp_path, [_hook(tools=["Edit", "Write", "MultiEdit"], matcher="")]
    )
    doc = tomlkit.parse(target.read_text())
    assert doc["hooks"]["PostToolUse"][0]["matcher"] == "apply_patch"


def test_codex_all_tools_unsupported_skips_the_whole_write(tmp_data_home, tmp_path):
    """A hook whose canonical tools ALL drop on the target harness (Claude-only
    tools on codex) must SKIP — never degrade to the empty all-tools matcher, and
    never create the file. The skip reason has to name the tools so the sync log
    explains why the hook is absent."""
    _, target, r = _codex_apply(tmp_path, [_hook(tools=["Read", "Glob"], matcher="")])
    assert r.written is False
    assert not target.exists()
    assert len(r.skipped) == 1
    assert "Read" in r.skipped[0].reason
    assert read_sidecar("codex", GlobalScope(), "hooks") is None


def test_codex_partially_unsupported_tools_still_write_the_survivors(
    tmp_data_home, tmp_path
):
    """Only tools absent on codex drop — a list mixing supported and unsupported
    tools still writes, matching on what survived (never all tools)."""
    _, target, r = _codex_apply(
        tmp_path, [_hook(tools=["Read", "Edit", "Bash"], matcher="")]
    )
    assert r.written is True
    doc = tomlkit.parse(target.read_text())
    assert doc["hooks"]["PostToolUse"][0]["matcher"] == "apply_patch|Bash"


def test_codex_merge_preserves_unrelated_tables(tmp_data_home, tmp_path):
    existing = (
        '[model]\nname = "gpt"\n\n'
        '[mcp_servers.foo]\ncommand = "python3"\n\n'
        '[projects."/x/y"]\ntrust_level = "trusted"\n'
    )
    _, target, _ = _codex_apply(tmp_path, [_hook(matcher="apply_patch")], existing=existing)
    doc = tomlkit.parse(target.read_text())
    assert doc["model"]["name"] == "gpt"
    assert doc["mcp_servers"]["foo"]["command"] == "python3"
    assert doc["projects"]["/x/y"]["trust_level"] == "trusted"
    assert "PostToolUse" in doc["hooks"]


def test_codex_project_scope_skipped_no_write(tmp_data_home, tmp_path):
    target = tmp_path / "config.toml"
    adapter = ha.CodexHookAdapter()
    adapter._target = lambda scope: target  # type: ignore
    scope = ProjectScope(name="a", path=str(tmp_path))
    r = adapter.apply(scope, [_hook()], "codex")
    assert r.written is False
    assert not target.exists()
    assert len(r.skipped) == 1
    assert "v1" in r.reason


def test_codex_unsupported_event_skipped_no_table(tmp_data_home, tmp_path):
    # SessionEnd is NOT in codex's 10-event set.
    _, target, r = _codex_apply(tmp_path, [_hook(event="SessionEnd")])
    assert r.written is False
    assert not target.exists()
    assert len(r.skipped) == 1


def test_codex_supported_event_written(tmp_data_home, tmp_path):
    _, target, r = _codex_apply(tmp_path, [_hook(event="PreToolUse", matcher="apply_patch")])
    assert r.written is True
    doc = tomlkit.parse(target.read_text())
    assert "PreToolUse" in doc["hooks"]


def test_codex_never_writes_hooks_state(tmp_data_home, tmp_path):
    _, target, _ = _codex_apply(tmp_path, [_hook(matcher="apply_patch")])
    doc = tomlkit.parse(target.read_text())
    hooks_tbl = doc["hooks"]
    assert "state" not in hooks_tbl


def test_codex_preexisting_hooks_state_survives(tmp_data_home, tmp_path):
    existing = (
        '[hooks.state."my-hook"]\ntrusted_hash = "sha256:abc"\nenabled = true\n'
    )
    _, target, _ = _codex_apply(tmp_path, [_hook(matcher="apply_patch")], existing=existing)
    doc = tomlkit.parse(target.read_text())
    # Hub added its event table but left the trust state untouched.
    assert "PostToolUse" in doc["hooks"]
    assert doc["hooks"]["state"]["my-hook"]["trusted_hash"] == "sha256:abc"
    assert doc["hooks"]["state"]["my-hook"]["enabled"] is True


def test_codex_unparseable_config_aborts_untouched(tmp_data_home, tmp_path):
    bad = "[model\nname = broken = \n"
    target = tmp_path / "config.toml"
    target.write_text(bad)
    adapter = ha.CodexHookAdapter()
    adapter._target = lambda scope: target  # type: ignore
    # Must not raise past the caller.
    r = adapter.apply(GlobalScope(), [_hook(matcher="apply_patch")], "codex")
    assert r.error is not None
    assert r.written is False
    assert target.read_text() == bad  # file untouched
    assert len(r.skipped) == 1


def test_codex_byte_stable_resync(tmp_data_home, tmp_path):
    adapter, target, r1 = _codex_apply(tmp_path, [_hook(matcher="apply_patch")])
    assert r1.written is True
    text1 = target.read_text()
    adapter._target = lambda scope: target  # type: ignore
    r2 = adapter.apply(GlobalScope(), [_hook(matcher="apply_patch")], "codex")
    assert r2.written is False
    assert target.read_text() == text1


def test_codex_cleanup_preserves_user_entries_and_state(tmp_data_home, tmp_path):
    existing = (
        '[hooks.state."h"]\ntrusted_hash = "sha256:z"\n\n'
        '[[hooks.PostToolUse]]\nmatcher = "user"\n\n'
        '[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = "user.sh"\n'
    )
    adapter, target, _ = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch", command="hub.sh")], existing=existing
    )
    doc = tomlkit.parse(target.read_text())
    assert len(doc["hooks"]["PostToolUse"]) == 2

    adapter._target = lambda scope: target  # type: ignore
    res = adapter.cleanup(GlobalScope(), "codex", owned_names=set())
    assert res.removed is True
    doc = tomlkit.parse(target.read_text())
    cmds = [e["hooks"][0]["command"] for e in doc["hooks"]["PostToolUse"]]
    assert cmds == ["user.sh"]
    assert doc["hooks"]["state"]["h"]["trusted_hash"] == "sha256:z"
    assert read_sidecar("codex", GlobalScope(), "hooks") is None


def test_codex_cleanup_backs_up_before_rewriting(tmp_data_home, tmp_path):
    """cleanup() must back up config.toml before stripping, same as apply()."""
    import hub

    adapter, target, _ = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch", command="hub.sh")]
    )
    before = target.read_text()
    ha._reset_backup_session_state_for_tests()  # cleanup gets its own backup slot
    adapter._target = lambda scope: target  # type: ignore

    res = adapter.cleanup(GlobalScope(), "codex", owned_names=set())
    assert res.removed is True
    backup_dir = hub.data_home() / "_hub-backups" / "hooks" / "codex" / GlobalScope().slug
    backups = list(backup_dir.glob("*.toml"))
    assert len(backups) == 1
    assert backups[0].read_text() == before  # backup captured PRE-strip content


def test_codex_discover_existing_skips_state(tmp_data_home, tmp_path):
    existing = (
        '[hooks.state."h"]\ntrusted_hash = "sha256:z"\n\n'
        '[[hooks.PostToolUse]]\nmatcher = "apply_patch"\n\n'
        '[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = "x.sh"\ntimeout = 5\n'
    )
    target = tmp_path / "config.toml"
    target.write_text(existing)
    adapter = ha.CodexHookAdapter()
    adapter._target = lambda scope: target  # type: ignore
    found = adapter.discover_existing(GlobalScope(), "codex")
    assert len(found) == 1
    assert found[0].event == "PostToolUse"
    assert found[0].command == "x.sh"
    assert found[0].timeout == 5


# ─────────────────────────────────────────────────────────────────────────────
# read_hook_trust_state (read-only)
# ─────────────────────────────────────────────────────────────────────────────


def test_read_hook_trust_state_parses(tmp_path):
    cfg = tmp_path / "config.toml"
    cfg.write_text(
        '[hooks.state."my-hook"]\ntrusted_hash = "sha256:deadbeef"\nenabled = true\n\n'
        '[hooks.state."other"]\ntrusted_hash = "sha256:aa"\n'
    )
    state = ha.read_hook_trust_state(cfg)
    assert state["my-hook"] == {"trusted_hash": "sha256:deadbeef", "enabled": True}
    assert state["other"] == {"trusted_hash": "sha256:aa"}


def test_read_hook_trust_state_missing_file(tmp_path):
    assert ha.read_hook_trust_state(tmp_path / "nope.toml") == {}


def test_read_hook_trust_state_no_state_table(tmp_path):
    cfg = tmp_path / "config.toml"
    cfg.write_text('[model]\nname = "x"\n')
    assert ha.read_hook_trust_state(cfg) == {}


def test_read_hook_trust_state_without_tomlkit_is_empty(tmp_path, monkeypatch):
    """A Python env without tomlkit degrades the trust-state read to `{}` rather
    than raising — same graceful-degradation contract as the Codex writer."""
    cfg = tmp_path / "config.toml"
    cfg.write_text('[hooks.state."my-hook"]\ntrusted_hash = "sha256:deadbeef"\n')
    # Sanity: with tomlkit present the state IS parsed…
    assert ha.read_hook_trust_state(cfg) != {}
    # …and without it the call is an honest empty, not an ImportError.
    monkeypatch.setattr(ha, "_tomlkit_missing", lambda: True)
    assert ha.read_hook_trust_state(cfg) == {}


# ─────────────────────────────────────────────────────────────────────────────
# apply()-path backup contract (docs/HOOKS.md "backup-first, only when the write
# changes the file"). The cleanup() tests above cannot catch an apply-path
# regression: the backup is the ONLY recovery point when hub rewrites a user's
# settings.json / config.toml, and its correctness rests entirely on the
# statement order `_backup_hook_once(...)` → `_atomic_replace(...)` inside the
# `new_text != existing_text` guard.
# ─────────────────────────────────────────────────────────────────────────────


def _hook_backups(harness_id: str, scope, ext: str) -> list[Path]:
    import hub

    d = hub.data_home() / "_hub-backups" / "hooks" / harness_id / scope.slug
    return sorted(d.glob(f"*.{ext}")) if d.exists() else []


def test_claude_apply_backs_up_pre_write_content(tmp_data_home, tmp_path):
    """apply() must back up BEFORE it rewrites an existing settings file, and the
    backup must hold the PRE-write bytes (a post-write copy is worthless)."""
    target = tmp_path / ".claude" / "settings.local.json"
    target.parent.mkdir(parents=True)
    original = json.dumps({"model": "sonnet"}, indent=2) + "\n"
    target.write_text(original)

    scope = ProjectScope(name="a", path=str(tmp_path))
    r = ha.ClaudeHookAdapter().apply(scope, [_hook()], "claude-code")
    assert r.written is True

    backups = _hook_backups("claude-code", scope, "json")
    assert len(backups) == 1
    assert backups[0].read_text() == original          # PRE-write bytes
    assert "hooks" not in json.loads(backups[0].read_text())
    assert "hooks" in json.loads(target.read_text())   # the live file DID change


def test_claude_apply_creating_a_new_file_takes_no_backup(tmp_data_home, tmp_path):
    """Nothing to lose ⇒ nothing to back up when apply() creates the file."""
    scope = ProjectScope(name="a", path=str(tmp_path))
    r = ha.ClaudeHookAdapter().apply(scope, [_hook()], "claude-code")
    assert r.written is True
    assert _hook_backups("claude-code", scope, "json") == []


def test_claude_byte_stable_resync_takes_no_backup(tmp_data_home, tmp_path):
    """A no-op re-sync must not spam a backup per run (the session guard alone
    does not prove this — a fresh process resets it, so the `written` guard is
    what has to hold)."""
    target = tmp_path / ".claude" / "settings.local.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"model": "sonnet"}, indent=2) + "\n")

    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    adapter.apply(scope, [_hook()], "claude-code")
    assert len(_hook_backups("claude-code", scope, "json")) == 1

    # A LATER sync process (session guard cleared) that changes nothing.
    ha._reset_backup_session_state_for_tests()
    r2 = adapter.apply(scope, [_hook()], "claude-code")
    assert r2.written is False
    assert len(_hook_backups("claude-code", scope, "json")) == 1  # still just one


def test_codex_apply_backs_up_pre_write_content(tmp_data_home, tmp_path):
    existing = '[model]\nname = "gpt"\n'
    _, target, r = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch")], existing=existing
    )
    assert r.written is True
    backups = _hook_backups("codex", GlobalScope(), "toml")
    assert len(backups) == 1
    assert backups[0].read_text() == existing         # PRE-write bytes
    assert "hooks" not in backups[0].read_text()
    assert "hooks" in target.read_text()


def test_codex_byte_stable_resync_takes_no_backup(tmp_data_home, tmp_path):
    adapter, target, _ = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch")], existing='[model]\nname = "gpt"\n'
    )
    assert len(_hook_backups("codex", GlobalScope(), "toml")) == 1

    ha._reset_backup_session_state_for_tests()
    adapter._target = lambda scope: target  # type: ignore
    r2 = adapter.apply(GlobalScope(), [_hook(matcher="apply_patch")], "codex")
    assert r2.written is False
    assert len(_hook_backups("codex", GlobalScope(), "toml")) == 1


# ─────────────────────────────────────────────────────────────────────────────
# Two hub hooks on ONE codex event — the only case where the per-hook
# `idx = len(aot)` recomputation and the reverse-order multi-index strip actually
# matter (the ordinary case the moment a user attaches anything alongside the
# built-in `lsp-report`). The Claude-side equivalents live above.
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_two_hooks_same_event_index_bookkeeping(tmp_data_home, tmp_path):
    h1 = _hook(name="h1", command="a.sh", matcher="apply_patch")
    h2 = _hook(name="h2", command="b.sh", matcher="Bash")
    adapter, target, r1 = _codex_apply(tmp_path, [h1, h2])
    assert _base_keys(r1.managed_keys) == ["hooks.PostToolUse[0]", "hooks.PostToolUse[1]"]
    doc = tomlkit.parse(target.read_text())
    assert [e["hooks"][0]["command"] for e in doc["hooks"]["PostToolUse"]] == [
        "a.sh", "b.sh",
    ]

    adapter._target = lambda scope: target  # type: ignore
    text = target.read_text()
    r2 = adapter.apply(GlobalScope(), [h1, h2], "codex")
    assert r2.written is False
    assert target.read_text() == text

    r3 = adapter.apply(GlobalScope(), [h1], "codex")
    assert r3.written is True
    doc = tomlkit.parse(target.read_text())
    assert [e["hooks"][0]["command"] for e in doc["hooks"]["PostToolUse"]] == ["a.sh"]
    assert _base_keys(r3.managed_keys) == ["hooks.PostToolUse[0]"]


# ─────────────────────────────────────────────────────────────────────────────
# feature_off → re-enable round-trip (design D4: "feature-off ≠ uninstall").
# The capability short-circuit returns BEFORE the sidecar reconcile, so the
# hooks sidecar must survive a disabled pass — otherwise a later `supported`
# sync would find nothing to strip and APPEND a second copy of every hook.
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_feature_off_preserves_sidecar_and_re_enable_does_not_duplicate(
    tmp_data_home, tmp_path
):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    target = tmp_path / ".claude/settings.local.json"
    adapter.apply(scope, [_hook()], "claude-code")
    before = target.read_text()
    keys_before = read_sidecar("claude-code", scope, "hooks").managed_keys

    cap_off = HookCapability(harness_id="claude-code", verdict=FEATURE_OFF, reason="off")
    r_off = adapter.apply(scope, [_hook()], "claude-code", capability=cap_off)
    assert r_off.disabled is True
    # The sidecar is NOT deleted by a feature-off pass — ownership survives.
    sc = read_sidecar("claude-code", scope, "hooks")
    assert sc is not None and sc.managed_keys == keys_before

    # Feature toggled back ON: strip-then-re-emit ⇒ exactly one entry, byte-stable.
    cap_on = HookCapability(harness_id="claude-code", verdict=SUPPORTED, reason="ok")
    r_on = adapter.apply(scope, [_hook()], "claude-code", capability=cap_on)
    assert r_on.written is False
    assert target.read_text() == before
    assert len(json.loads(target.read_text())["hooks"]["PostToolUse"]) == 1
    assert read_sidecar("claude-code", scope, "hooks").managed_keys == keys_before


def test_codex_feature_off_preserves_sidecar_and_re_enable_does_not_duplicate(
    tmp_data_home, tmp_path
):
    hook = _hook(matcher="apply_patch")
    adapter, target, _ = _codex_apply(tmp_path, [hook])
    before = target.read_text()
    keys_before = read_sidecar("codex", GlobalScope(), "hooks").managed_keys
    adapter._target = lambda scope: target  # type: ignore

    cap_off = HookCapability(harness_id="codex", verdict=FEATURE_OFF, reason="off")
    r_off = adapter.apply(GlobalScope(), [hook], "codex", capability=cap_off)
    assert r_off.disabled is True and r_off.written is False
    assert target.read_text() == before
    sc = read_sidecar("codex", GlobalScope(), "hooks")
    assert sc is not None and sc.managed_keys == keys_before

    cap_on = HookCapability(harness_id="codex", verdict=SUPPORTED, reason="ok")
    r_on = adapter.apply(GlobalScope(), [hook], "codex", capability=cap_on)
    assert r_on.written is False
    assert target.read_text() == before
    doc = tomlkit.parse(target.read_text())
    assert len(doc["hooks"]["PostToolUse"]) == 1


# ─────────────────────────────────────────────────────────────────────────────
# Codex full detach — the user's off-switch. The apply path strips with
# `prune_empty_table=False` (for byte-stability) and then explicitly deletes the
# emptied [hooks] table, so a full detach must leave NO residue in config.toml.
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_detach_removes_prior_hub_entry_and_empty_hooks_table(
    tmp_data_home, tmp_path
):
    existing = '[model]\nname = "gpt"\n'
    adapter, target, _ = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch")], existing=existing
    )
    assert "hooks" in target.read_text()

    adapter._target = lambda scope: target  # type: ignore
    r = adapter.apply(GlobalScope(), [], "codex")
    assert r.written is True
    assert r.managed_keys == []
    doc = tomlkit.parse(target.read_text())
    assert "hooks" not in doc                    # no emptied [hooks] residue
    assert doc["model"]["name"] == "gpt"         # unrelated tables preserved
    text = target.read_text()
    assert "[hooks" not in text                  # no residual table header either
    assert text.strip() == existing.strip()      # back to the pre-hub content
    assert read_sidecar("codex", GlobalScope(), "hooks") is None


def test_codex_detach_keeps_hooks_table_when_state_remains(tmp_data_home, tmp_path):
    """A full detach must NOT drop [hooks.state] — codex owns hook trust."""
    existing = '[hooks.state."my-hook"]\ntrusted_hash = "sha256:abc"\n'
    adapter, target, _ = _codex_apply(
        tmp_path, [_hook(matcher="apply_patch")], existing=existing
    )
    adapter._target = lambda scope: target  # type: ignore
    adapter.apply(GlobalScope(), [], "codex")
    doc = tomlkit.parse(target.read_text())
    assert "PostToolUse" not in doc["hooks"]
    assert doc["hooks"]["state"]["my-hook"]["trusted_hash"] == "sha256:abc"
    assert read_sidecar("codex", GlobalScope(), "hooks") is None


# ─────────────────────────────────────────────────────────────────────────────
# HOOKS-BUG-01 — an unparseable target ABORTS the write.
#
# Resetting the parsed document to `{}` and serializing it back would replace the
# user's ENTIRE settings file (model, permissions, env, statusLine …) with hub's
# hooks block, while reporting success. The file must come out byte-identical and
# the failure must be reported honestly.
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_unparseable_settings_aborts_without_writing(tmp_data_home, tmp_path):
    target = tmp_path / ".claude" / "settings.local.json"
    target.parent.mkdir(parents=True)
    original = '{"model": "opus", "permissions": {"allow": ["Bash(npm:*)"]},,,\n'
    target.write_text(original)

    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    result = adapter.apply(scope, [_hook()], "claude-code")

    assert target.read_text() == original      # not one byte touched
    assert result.error is not None
    assert result.written is False
    assert len(result.skipped) == 1
    # No phantom ownership claimed over a file we never wrote.
    assert read_sidecar("claude-code", scope, "hooks") is None


def test_claude_non_object_settings_root_aborts_without_writing(
    tmp_data_home, tmp_path
):
    """Valid JSON whose root is a list/scalar is just as unsafe to overwrite."""
    target = tmp_path / ".claude" / "settings.local.json"
    target.parent.mkdir(parents=True)
    original = '["not", "a", "settings", "object"]\n'
    target.write_text(original)

    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    result = adapter.apply(scope, [_hook()], "claude-code")

    assert target.read_text() == original
    assert result.error is not None
    assert result.written is False


def test_claude_permission_adapter_aborts_on_unparseable_settings(
    tmp_data_home, tmp_path
):
    """The sibling defect: `ClaudePermissionAdapter.apply` must not rebuild an
    unparseable settings file from `{}` either."""
    target = tmp_path / ".claude" / "settings.json"
    target.parent.mkdir(parents=True)
    original = '{"model": "opus"  <-- hand-edited into nonsense\n'
    target.write_text(original)

    scope = ProjectScope(name="a", path=str(tmp_path))
    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(npm:*)", kind="allow")])
    adapter = pa.ClaudePermissionAdapter()
    write = adapter.translate(perms, scope, "claude-code").writes[0]
    assert write.target_path == target

    assert adapter.apply(scope, write, "claude-code") is False
    assert target.read_text() == original


# ─────────────────────────────────────────────────────────────────────────────
# HOOKS-BUG-02 — ownership is IDENTITY-based, not index-based.
#
# The user edits the same list hub writes into. A prepend shifts hub's entry down
# (its recorded index now points at the USER's hook); a deletion shifts it up
# (the recorded index now points at someone else's entry, or past the end).
# Stripping by index in either case deletes a user hook or duplicates hub's.
# ─────────────────────────────────────────────────────────────────────────────


def _claude_commands(target: Path, event="PostToolUse"):
    data = json.loads(target.read_text())
    out = []
    for entry in data.get("hooks", {}).get(event, []):
        inner = entry.get("hooks") or [{}]
        out.append(inner[0].get("command"))
    return out


def test_claude_user_prepend_does_not_steal_the_users_hook(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    target = tmp_path / ".claude/settings.local.json"

    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    assert _claude_commands(target) == ["hub.sh"]

    # The user PREPENDS their own hook — hub's entry is now at index 1 while the
    # sidecar still records index 0.
    data = json.loads(target.read_text())
    data["hooks"]["PostToolUse"].insert(0, {
        "matcher": "UserTool",
        "hooks": [{"type": "command", "command": "user.sh"}],
    })
    target.write_text(json.dumps(data, indent=2) + "\n")

    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    commands = _claude_commands(target)
    assert "user.sh" in commands                       # the user's hook survives
    assert commands.count("hub.sh") == 1               # exactly one hub entry


def test_claude_user_deletion_does_not_duplicate_the_hub_hook(tmp_data_home, tmp_path):
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    target = tmp_path / ".claude/settings.local.json"
    target.parent.mkdir(parents=True)
    # A user hook first, so hub's lands at index 1.
    target.write_text(json.dumps({
        "hooks": {"PostToolUse": [
            {"matcher": "UserTool", "hooks": [{"type": "command", "command": "user.sh"}]}
        ]}
    }, indent=2) + "\n")
    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    assert _claude_commands(target) == ["user.sh", "hub.sh"]

    # The user DELETES their own hook — hub's slides to index 0 while the sidecar
    # still records index 1 (out of range ⇒ the old code stripped nothing and
    # appended a second copy).
    data = json.loads(target.read_text())
    del data["hooks"]["PostToolUse"][0]
    target.write_text(json.dumps(data, indent=2) + "\n")

    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    assert _claude_commands(target).count("hub.sh") == 1


def test_claude_detach_after_a_user_prepend_leaves_the_user_hook(
    tmp_data_home, tmp_path
):
    """Full detach + a shifted index: strip must remove hub's entry, not the
    user's entry now sitting at hub's recorded index."""
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    target = tmp_path / ".claude/settings.local.json"

    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    data = json.loads(target.read_text())
    data["hooks"]["PostToolUse"].insert(0, {
        "matcher": "UserTool",
        "hooks": [{"type": "command", "command": "user.sh"}],
    })
    target.write_text(json.dumps(data, indent=2) + "\n")

    adapter.apply(scope, [], "claude-code")             # hook detached
    assert _claude_commands(target) == ["user.sh"]


def test_claude_cleanup_after_a_user_prepend_leaves_the_user_hook(
    tmp_data_home, tmp_path
):
    """The uninstall path shares the same identity strip."""
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    target = tmp_path / ".claude/settings.local.json"

    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    data = json.loads(target.read_text())
    data["hooks"]["PostToolUse"].insert(0, {
        "matcher": "UserTool",
        "hooks": [{"type": "command", "command": "user.sh"}],
    })
    target.write_text(json.dumps(data, indent=2) + "\n")

    assert adapter.cleanup(scope, "claude-code", owned_names=set()).removed is True
    assert _claude_commands(target) == ["user.sh"]


def test_claude_hand_deleted_hub_entry_is_treated_as_already_gone(
    tmp_data_home, tmp_path
):
    """The user deletes hub's OWN entry and keeps theirs at that index. The next
    sync must not delete the user's hook to 'reclaim' the slot."""
    adapter = ha.ClaudeHookAdapter()
    scope = ProjectScope(name="a", path=str(tmp_path))
    target = tmp_path / ".claude/settings.local.json"

    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    target.write_text(json.dumps({
        "hooks": {"PostToolUse": [
            {"matcher": "UserTool", "hooks": [{"type": "command", "command": "user.sh"}]}
        ]}
    }, indent=2) + "\n")

    adapter.apply(scope, [_hook(command="hub.sh")], "claude-code")
    commands = _claude_commands(target)
    assert "user.sh" in commands
    assert commands.count("hub.sh") == 1


def test_legacy_sidecar_without_fingerprints_still_strips(tmp_data_home, tmp_path):
    """Backward compatibility: a sidecar written before fingerprints existed has
    bare `hooks.<Event>[<i>]` keys. They must still reconcile (index fallback) —
    no crash, no duplicate — and the rewritten sidecar carries fingerprints."""
    from permissions import write_sidecar

    target = tmp_path / ".claude/settings.local.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({
        "hooks": {"PostToolUse": [
            {"matcher": "", "hooks": [{"type": "command", "command": "./c.sh"}]}
        ]}
    }, indent=2) + "\n")
    scope = ProjectScope(name="a", path=str(tmp_path))
    write_sidecar("claude-code", scope, ["hooks.PostToolUse[0]"], target, "hooks")

    adapter = ha.ClaudeHookAdapter()
    adapter.apply(scope, [_hook()], "claude-code")
    assert _claude_commands(target) == ["./c.sh"]       # reconciled, not doubled

    sc = read_sidecar("claude-code", scope, "hooks")
    assert sc is not None
    assert sc.managed_keys[0].startswith("hooks.PostToolUse[0]#")


def test_codex_user_prepend_does_not_steal_the_users_hook(tmp_data_home, tmp_path):
    """Same identity contract on the codex TOML writer."""
    adapter, target, _ = _codex_apply(tmp_path, [_hook(command="hub.sh",
                                                       matcher="apply_patch")])
    adapter._target = lambda scope: target  # type: ignore

    doc = tomlkit.parse(target.read_text())
    user_tbl = tomlkit.table()
    user_tbl["matcher"] = "UserTool"
    inner = tomlkit.aot()
    cmd = tomlkit.table()
    cmd["type"] = "command"
    cmd["command"] = "user.sh"
    inner.append(cmd)
    user_tbl["hooks"] = inner
    doc["hooks"]["PostToolUse"].insert(0, user_tbl)
    target.write_text(tomlkit.dumps(doc))

    adapter.apply(GlobalScope(), [_hook(command="hub.sh", matcher="apply_patch")],
                  "codex")
    doc = tomlkit.parse(target.read_text())
    commands = [e["hooks"][0]["command"] for e in doc["hooks"]["PostToolUse"]]
    assert "user.sh" in commands
    assert commands.count("hub.sh") == 1


# ─────────────────────────────────────────────────────────────────────────────
# Adapter selection
# ─────────────────────────────────────────────────────────────────────────────


def test_get_hook_adapter_selection():
    assert isinstance(ha.get_hook_adapter("claude-code"), ha.ClaudeHookAdapter)
    assert isinstance(ha.get_hook_adapter("codex"), ha.CodexHookAdapter)
    assert ha.get_hook_adapter("opencode") is None
    assert ha.get_hook_adapter("pi") is None
