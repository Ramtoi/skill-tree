"""skill_hub/domain/mcp/mcp_spec.py's per-harness mapping + the remote-connector wire dict
(plans/B.md wave B, unit B1, §5 cases 13-32).

Cases 13-15 are the F1 keystone: the raw (unexpanded) and expanded readers
must diverge for a `{source}` entry, and only the raw one may feed the
remote-connector's canonical bytes. These are written and watched to fail
BEFORE anything in `hub.py`/`connectors/hermes.py` is touched (plans/B.md §7
step 3) — they exercise `mcp_spec` directly against hand-written pre-wave
dicts, with no dependency on `build_remote_desired_state`.
"""

from __future__ import annotations

import hashlib
import json

from skill_hub.domain.mcp import mcp_spec

# ─────────────────────────────────────────────────────────────────────────────
# F1 keystone (cases 13-15)
# ─────────────────────────────────────────────────────────────────────────────

_SCAFFOLDED_CFG = {
    "source": "~/.skill-hub/mcp-servers/demo",
    "mcp": {
        "runtime": "python",
        "command": "python3",
        "args": ["{source}/server.py"],
        "env": {},
    },
}

# The literal dict `build_remote_desired_state` built BEFORE this wave
# (hub.py:283, pre-wave): unconditional command/args/env, `{source}` verbatim.
_PRE_WAVE_STDIO_DICT = {
    "command": "python3",
    "args": ["{source}/server.py"],
    "env": {},
}

_CONTROL_PLANE_CFG = {
    "source": None,
    "mcp": {
        "command": "python3",
        "args": ["/abs/skill_hub_mcp_server.py"],
        "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
    },
}

_PRE_WAVE_CONTROL_PLANE_DICT = {
    "command": "python3",
    "args": ["/abs/skill_hub_mcp_server.py"],
    "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
}


def _sha(d: dict) -> str:
    return hashlib.sha256(json.dumps(d, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def test_canonical_bytes_unchanged_for_a_scaffolded_source_entry():
    raw = mcp_spec.raw_spec_from_registry("demo", _SCAFFOLDED_CFG)
    canonical = mcp_spec.canonical_spec_dict(raw)
    assert _sha(canonical) == _sha(_PRE_WAVE_STDIO_DICT)
    assert canonical["args"] == ["{source}/server.py"]
    assert "{source}" in canonical["args"][0]


def test_canonical_bytes_for_the_control_plane_entry():
    raw = mcp_spec.raw_spec_from_registry("skill-hub", _CONTROL_PLANE_CFG)
    canonical = mcp_spec.canonical_spec_dict(raw)
    assert _sha(canonical) == _sha(_PRE_WAVE_CONTROL_PLANE_DICT)


def test_expanded_spec_is_not_the_canonical_input(tmp_path):
    expanded = mcp_spec.spec_from_registry("demo", _SCAFFOLDED_CFG, source=tmp_path)
    raw = mcp_spec.raw_spec_from_registry("demo", _SCAFFOLDED_CFG)
    assert expanded != raw
    assert expanded.args != raw.args
    assert "{source}" not in expanded.args[0]
    assert "{source}" in raw.args[0]


# ─────────────────────────────────────────────────────────────────────────────
# Canonical wire dict — non-stdio (case 16)
# ─────────────────────────────────────────────────────────────────────────────


def test_canonical_bytes_for_http_spec_omit_stdio_keys():
    spec = mcp_spec.McpServerSpec(name="n", transport="http", url="https://h/mcp")
    d = mcp_spec.canonical_spec_dict(spec)
    assert "command" not in d
    assert "args" not in d
    assert "env" not in d
    assert d["transport"] == "http"
    assert d["url"] == "https://h/mcp"


def test_canonical_bytes_gain_cwd_when_present():
    """(W3a) `cwd` was never read pre-wave (`_spec_from_skill` did not pass
    it to `McpServerSpec`), so no existing remote sha carries it — this is a
    NEW key joining an otherwise-unused field, not a break of an existing
    sha. INTERFACES §1 intends this: a remote provisioned before this wave
    with `mcp.cwd` set (undocumented; nothing read it) sees its stored sha
    move exactly once, and the resulting drift self-heals as a single
    `local-ahead` fast-forward on the next `hub remote sync` — never a
    conflict, since nothing on the box could have raced to change it."""
    cfg = {"mcp": {"command": "python3", "args": ["/x.py"], "env": {}, "cwd": "/tmp"}}
    raw = mcp_spec.raw_spec_from_registry("n", cfg)
    d = mcp_spec.canonical_spec_dict(raw)
    assert d == {"command": "python3", "args": ["/x.py"], "env": {}, "cwd": "/tmp"}


def test_canonical_bytes_default_an_absent_or_null_command_to_python3():
    """(W3b) A stdio entry with no `command`, or an explicit empty/null one,
    could never have started — the same M3 default `spec_from_registry`
    already applies everywhere else. All three degenerate shapes canonicalize
    to the SAME bytes as an entry that spells `command: python3` outright, so
    none of them can diverge from a sha computed either way."""
    absent = mcp_spec.canonical_spec_dict(
        mcp_spec.raw_spec_from_registry("n", {"mcp": {"args": ["/x.py"], "env": {}}})
    )
    empty = mcp_spec.canonical_spec_dict(
        mcp_spec.raw_spec_from_registry(
            "n", {"mcp": {"command": "", "args": ["/x.py"], "env": {}}}
        )
    )
    null_cmd = mcp_spec.canonical_spec_dict(
        mcp_spec.raw_spec_from_registry(
            "n", {"mcp": {"command": None, "args": ["/x.py"], "env": {}}}
        )
    )
    explicit = mcp_spec.canonical_spec_dict(
        mcp_spec.raw_spec_from_registry(
            "n", {"mcp": {"command": "python3", "args": ["/x.py"], "env": {}}}
        )
    )
    assert absent == empty == null_cmd == explicit
    assert explicit["command"] == "python3"


# ─────────────────────────────────────────────────────────────────────────────
# Claude / Pi mapping (cases 17-18, 30)
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_native_stdio_has_no_type_key():
    spec = mcp_spec.McpServerSpec(name="n", command="python3", args=["/x.py"], env={"A": "1"})
    entry, skips = mcp_spec.to_native(spec, "claude")
    assert "type" not in entry
    assert entry == {"command": "python3", "args": ["/x.py"], "env": {"A": "1"}}
    assert skips == []


def test_claude_native_http_shape():
    spec = mcp_spec.McpServerSpec(
        name="n",
        transport="http",
        url="https://h/mcp",
        headers={"Authorization": "Bearer ${TOKEN}"},
    )
    entry, skips = mcp_spec.to_native(spec, "claude")
    assert entry == {
        "type": "http",
        "url": "https://h/mcp",
        "headers": {"Authorization": "Bearer ${TOKEN}"},
    }
    assert skips == []


def test_pi_shares_the_claude_entry():
    spec = mcp_spec.McpServerSpec(name="n", command="python3", args=["/x.py"])
    claude_entry, claude_skips = mcp_spec.to_native(spec, "claude")
    # pi has no adapter key of its own — it reuses the claude mapping (there is
    # no "pi" key in `to_native`'s dispatch table; the shared write comes from
    # `mcp_adapters.ClaudeMcpAdapter` being registered under BOTH harness ids).
    assert claude_entry == {"command": "python3", "args": ["/x.py"], "env": {}}
    assert claude_skips == []


# ─────────────────────────────────────────────────────────────────────────────
# Codex — http header split (cases 19-23)
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_bearer_token_env_var_with_extra_headers():
    spec = mcp_spec.McpServerSpec(
        name="n",
        transport="http",
        url="https://h/mcp",
        headers={"Authorization": "Bearer ${T}", "X-Org": "acme"},
    )
    entry, skips = mcp_spec.to_native(spec, "codex")
    assert entry["bearer_token_env_var"] == "T"
    assert entry["http_headers"] == {"X-Org": "acme"}
    assert not any(s.startswith("codex_header_not_representable:Authorization") for s in skips)
    assert "Authorization" not in entry.get("env_http_headers", {})


def test_codex_bearer_alone():
    spec = mcp_spec.McpServerSpec(
        name="n", transport="http", url="https://h/mcp", headers={"Authorization": "Bearer ${T}"}
    )
    entry, skips = mcp_spec.to_native(spec, "codex")
    assert entry["bearer_token_env_var"] == "T"
    assert "http_headers" not in entry
    assert "env_http_headers" not in entry
    assert skips == []


def test_codex_env_http_headers_for_pure_ref():
    spec = mcp_spec.McpServerSpec(
        name="n", transport="http", url="https://h/mcp", headers={"X-Key": "${K}"}
    )
    entry, skips = mcp_spec.to_native(spec, "codex")
    assert entry["env_http_headers"] == {"X-Key": "K"}
    assert skips == []


def test_codex_static_header_stays_http_headers():
    spec = mcp_spec.McpServerSpec(
        name="n",
        transport="http",
        url="https://h/mcp",
        headers={"X-Trace-Mode": "debug"},
    )
    entry, skips = mcp_spec.to_native(spec, "codex")
    assert entry["http_headers"] == {"X-Trace-Mode": "debug"}
    assert skips == []


def test_codex_mixed_header_is_skipped_with_reason():
    spec = mcp_spec.McpServerSpec(
        name="n",
        transport="http",
        url="https://h/mcp",
        headers={"X-Trace": "id-${T}-suffix"},
    )
    entry, skips = mcp_spec.to_native(spec, "codex")
    assert "X-Trace" not in entry.get("http_headers", {})
    assert "X-Trace" not in entry.get("env_http_headers", {})
    assert "codex_header_not_representable:X-Trace" in skips


# ─────────────────────────────────────────────────────────────────────────────
# Codex — stdio env rule (cases 24-26)
# ─────────────────────────────────────────────────────────────────────────────


def test_codex_stdio_env_matching_key_moves_to_env_vars():
    spec = mcp_spec.McpServerSpec(
        name="n", command="python3", args=[], env={"API_KEY": "${API_KEY}"}
    )
    table, skips = mcp_spec.to_native(spec, "codex")
    assert table["env_vars"] == ["API_KEY"]
    assert "API_KEY" not in table.get("env", {})
    assert skips == []


def test_codex_stdio_env_renamed_ref_is_skipped():
    spec = mcp_spec.McpServerSpec(
        name="n",
        command="python3",
        args=[],
        env={"TOKEN": "${OTHER}", "PLAIN": "literal-value"},
    )
    table, skips = mcp_spec.to_native(spec, "codex")
    assert "codex_env_not_representable:TOKEN" in skips
    assert "TOKEN" not in table.get("env", {})
    assert "TOKEN" not in table.get("env_vars", [])
    assert table["env"]["PLAIN"] == "literal-value"


def test_codex_sse_is_refused_whole_server():
    spec = mcp_spec.McpServerSpec(name="n", transport="sse", url="https://h/mcp")
    table, skips = mcp_spec.to_native(spec, "codex")
    assert skips == ["codex_no_sse"]
    assert table == {}


def test_codex_global_write_removes_a_server_flipped_to_sse(tmp_path):
    """(C1 regression) The missing half of plan case 26: a whole-server
    refusal at GLOBAL scope must REMOVE the previously written table, not
    merely drop it from `managed`. Before the fix, `write_global` computed
    removals from `spec_names` (the server is still "in specs", just
    refused), so the stale `[mcp_servers.foo]` table stayed on disk forever
    while the sidecar forgot it ever existed — an un-reclaimable orphan."""
    from skill_hub.infrastructure.mcp import mcp_adapters

    adapter = mcp_adapters.CodexMcpAdapter()
    target = tmp_path / "config.toml"

    stdio_spec = mcp_spec.McpServerSpec(name="foo", command="python3", args=[], env={})
    result1 = adapter.write_global(target, [stdio_spec], prior_managed=None)
    assert result1.managed == {"foo"}
    assert "[mcp_servers.foo]" in target.read_text()

    sse_spec = mcp_spec.McpServerSpec(name="foo", transport="sse", url="https://h/mcp")
    result2 = adapter.write_global(target, [sse_spec], prior_managed=result1.managed)
    assert result2.managed == set()
    assert result2.removed == {"foo"}
    assert result2.skips == {"foo": ["codex_no_sse"]}
    assert result2.changed is True
    assert "[mcp_servers.foo]" not in target.read_text()


# ─────────────────────────────────────────────────────────────────────────────
# opencode (cases 27-29)
# ─────────────────────────────────────────────────────────────────────────────


def test_opencode_remote_entry_and_env_substitution():
    spec = mcp_spec.McpServerSpec(
        name="n", transport="http", url="https://h/mcp", headers={"X-Key": "${K}"}
    )
    entry, skips = mcp_spec.to_native(spec, "opencode")
    assert entry == {
        "type": "remote",
        "url": "https://h/mcp",
        "enabled": True,
        "headers": {"X-Key": "{env:K}"},
    }
    assert skips == []


def test_opencode_default_form_is_dropped_with_reason():
    spec = mcp_spec.McpServerSpec(
        name="n",
        transport="http",
        url="https://h/mcp",
        headers={"Authorization": "${TOKEN:-fallback}"},
    )
    entry, skips = mcp_spec.to_native(spec, "opencode")
    assert "Authorization" not in entry.get("headers", {})
    assert "opencode_default_dropped:Authorization" in skips


def test_opencode_local_entry_unchanged_for_legacy_spec():
    spec = mcp_spec.McpServerSpec(
        name="n", command="npx", args=["-y", "foo-mcp"], env={"TOKEN": "plain-value"}
    )
    entry, skips = mcp_spec.to_native(spec, "opencode")
    assert entry == {
        "type": "local",
        "command": ["npx", "-y", "foo-mcp"],
        "enabled": True,
        "environment": {"TOKEN": "plain-value"},
    }
    assert skips == []


# ─────────────────────────────────────────────────────────────────────────────
# skill_meta validation leg (case 32)
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_meta_validates_mcp_entries():
    import pytest

    from skill_hub.domain.skills import skill_meta

    bad = {
        "skills": {
            "srv": {"type": "mcp-server", "mcp": {"transport": "http"}},
        }
    }
    with pytest.raises(SystemExit):
        skill_meta.validate_registry_skills(bad)

    good = {
        "skills": {
            "srv": {"type": "mcp-server", "mcp": {"transport": "http", "url": "https://h/mcp"}},
        }
    }
    skill_meta.validate_registry_skills(good)  # must not raise

    stdio_no_command = {
        "skills": {
            "srv": {"type": "mcp-server", "mcp": {"args": ["/x.py"]}},
        }
    }
    skill_meta.validate_registry_skills(stdio_no_command)  # must not raise (M3)


def test_skill_meta_duplicate_name_across_a_skill_and_an_mcp_server(tmp_path, capsys):
    """A registry key is unique by construction, so the only way a claude-skill
    and an mcp-server collide is the claude-skill's frontmatter naming the same
    string as the mcp-server's registry key. That mismatch is already its own
    error; asserting the SEPARATE "duplicate skill name" message also fires
    proves the mcp-server leg feeds the same `seen_names` table (plans/B.md
    §3: "adds the name to the same seen_names duplicate check")."""
    import pytest

    from skill_hub.domain.skills import skill_meta

    skill_dir = tmp_path / "my-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: shared\ndescription: d\n---\nbody\n")

    registry = {
        "skills": {
            "shared": {
                "type": "mcp-server",
                "mcp": {"transport": "http", "url": "https://h/mcp"},
            },
            "my-skill": {"type": "claude-skill", "source": str(skill_dir)},
        }
    }
    with pytest.raises(SystemExit):
        skill_meta.validate_registry_skills(registry)
    err = capsys.readouterr().err
    assert "duplicate skill name 'shared'" in err
