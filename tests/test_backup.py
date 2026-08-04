"""Tests for `backup.py` + the `hub backup …` CLI + the `hub sync` tail pass.

Covers design v2 §1 (manifest table), §2 (gather seams), §3 (field-scoped
transform + prefix-leak gate), §4 (credential content gate), §7 (git ops, auth
ladder, fail-open), and §10 (isolation).

Every test runs against `tmp_data_home` plus the autouse harness-isolation guard
in `conftest.py`, so nothing here can read or write a real harness dir.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

import backup
import hub


# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────


_ANSI = __import__("re").compile(r"\x1b\[[0-9;]*m")


def _plain(text: str) -> str:
    """Strip ANSI colour codes so assertions can match the human wording."""
    return _ANSI.sub("", text)


#: Captured BEFORE `_no_network_auth` stubs them, so the few tests that exercise
#: the real probes can restore just the one they need.
_REAL_PROBE_SSH = backup.probe_ssh
_REAL_PROBE_GH = backup.probe_gh
_REAL_PROBE_PAT = backup.probe_pat
_REAL_GH_LOGIN = backup.gh_active_login


def _ns(**kw):
    return argparse.Namespace(**kw)


def _seed_skill(data_home: Path, name: str) -> Path:
    src = data_home / "skills" / name
    src.mkdir(parents=True, exist_ok=True)
    (src / "SKILL.md").write_text("---\nname: {0}\ndescription: t\n---\nbody\n".format(name))
    return src


def _seed(data_home: Path, registry: dict = None, skills=("brainstorm",)) -> dict:
    for name in skills:
        _seed_skill(data_home, name)
    reg = registry or {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            name: {
                "version": "1.0.0",
                "description": "",
                "source": str(data_home / "skills" / name),
                "type": "claude-skill",
                "scope": "portable",
            }
            for name in skills
        },
        "projects": {},
        "bundles": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    return reg


def _reg(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


@pytest.fixture(autouse=True)
def _no_network_auth(monkeypatch):
    """No test may dial GitHub. Every rung reports unavailable unless re-patched."""
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": False, "detail": "stubbed", "user": None})
    monkeypatch.setattr(backup, "probe_gh", lambda timeout=10: {
        "method": "gh", "available": False, "detail": "stubbed", "user": None})
    monkeypatch.setattr(backup, "probe_pat", lambda: {
        "method": "pat", "available": False, "detail": "stubbed", "user": None})
    monkeypatch.setattr(backup, "gh_active_login", lambda timeout=10: None)


@pytest.fixture
def outside(tmp_path_factory):
    """A scratch dir OUTSIDE the data home.

    `tmp_data_home` resolves to pytest's `tmp_path` itself, so anything built
    from `tmp_path` would sit inside the data home — which `validate_backup_dir`
    (rightly) refuses and which would make the snapshot contain itself.
    """
    return tmp_path_factory.mktemp("outside")


@pytest.fixture
def wired(tmp_data_home, outside):
    """A data home with one skill and an initialized (remote-less) backup repo."""
    _seed(tmp_data_home)
    dest = outside / "backup-repo"
    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg["dir"] = str(dest)
    cfg["enabled"] = True
    backup.save_backup_config(registry, cfg)
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    return tmp_data_home, dest


# ─────────────────────────────────────────────────────────────────────────────
# 1. Manifest table (design §1)
# ─────────────────────────────────────────────────────────────────────────────


def test_manifest_derived_views_agree_with_table():
    assert "registry.yaml" in backup.DATA_HOME_PORTABLE
    assert "connectors" in backup.DATA_HOME_PORTABLE  # v2 gap fix
    assert "state/signing" in backup.DATA_HOME_SECRET
    assert "state/codex-workers" in backup.DATA_HOME_SECRET
    # known_hosts is migrate-only: it leaks private-box IPs and is re-seeded.
    assert "state/ssh/known_hosts" not in backup.DATA_HOME_STATE_PORTABLE
    row = backup.snapshot_row("state/ssh/known_hosts")
    assert row.migrate is True and row.backup is False
    # _hub-backups + usage must survive a local move (rollback story).
    for entry in ("_hub-backups", "usage", "sources", "state"):
        assert entry in backup.MIGRATE_HOME_ENTRIES


def test_migrate_entries_moves_unknown_top_level_entries(tmp_path):
    legacy = tmp_path / "legacy"
    (legacy / "skills").mkdir(parents=True)
    (legacy / "brand-new-thing").mkdir()
    (legacy / ".lock").write_text("")
    entries = backup.migrate_entries(legacy)
    assert "brand-new-thing" in entries, "unknown entries must still move"
    assert ".lock" not in entries


def test_backup_warns_about_unknown_data_home_entry(tmp_data_home, tmp_path):
    _seed(tmp_data_home)
    (tmp_data_home / "mystery-dir").mkdir()
    summary = backup.assemble_snapshot(tmp_path / "snap", data_home=tmp_data_home)
    assert any("mystery-dir" in w for w in summary["warnings"])
    assert not (tmp_path / "snap" / "mystery-dir").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 2. Gather seams (design §2)
# ─────────────────────────────────────────────────────────────────────────────


def test_gather_subagents_uses_env_aware_resolver(tmp_data_home, tmp_path, monkeypatch):
    """The gather must follow $SKILL_HUB_CLAUDE_HOME / $CODEX_HOME, not the
    inert `Harness.agents_dir` default — otherwise a test walks the real
    ~/.claude/agents."""
    claude_home = tmp_path / "fake-claude"
    codex_home = tmp_path / "fake-codex"
    (claude_home / "agents").mkdir(parents=True)
    (codex_home / "agents").mkdir(parents=True)
    (claude_home / "agents" / "reviewer.md").write_text("---\nname: reviewer\n---\n")
    (claude_home / "agents" / "ignored.txt").write_text("not an agent")
    (codex_home / "agents" / "planner.toml").write_text("name = 'planner'\n")
    (codex_home / "agents" / "off.toml.disabled").write_text("name = 'off'\n")
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(claude_home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))

    dest = tmp_path / "snap"
    dest.mkdir()
    written = backup.gather_subagents(dest)
    assert written == [
        "harness/claude-code/agents/reviewer.md",
        "harness/codex/agents/off.toml.disabled",
        "harness/codex/agents/planner.toml",
    ]
    assert not (dest / "harness" / "claude-code" / "agents" / "ignored.txt").exists()


def test_gather_global_docs_reads_declared_field(tmp_data_home, tmp_path, monkeypatch):
    import dataclasses
    import harnesses

    doc = tmp_path / "global" / "CLAUDE.md"
    doc.parent.mkdir(parents=True)
    doc.write_text("# global instructions\n")
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(patched["claude-code"], global_doc=doc)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    dest = tmp_path / "snap"
    dest.mkdir()
    written = backup.gather_global_docs(dest)
    assert written == ["global-docs/claude-code/CLAUDE.md"]
    assert (dest / "global-docs" / "claude-code" / "CLAUDE.md").read_text().startswith("# global")


def test_gather_ignores_real_harness_dirs_by_default(tmp_data_home, tmp_path):
    """With the conftest guard active, a bare gather finds nothing at all."""
    dest = tmp_path / "snap"
    dest.mkdir()
    assert backup.gather_subagents(dest) == []
    assert backup.gather_global_docs(dest) == []


def test_symlink_escaping_data_home_is_skipped(tmp_data_home, outside):
    _seed(tmp_data_home)
    secret = outside / "outside-secret.txt"
    secret.write_text("sensitive")
    os.symlink(secret, tmp_data_home / "skills" / "brainstorm" / "leak.txt")

    summary = backup.assemble_snapshot(outside / "snap", data_home=tmp_data_home)
    assert not (outside / "snap" / "skills" / "brainstorm" / "leak.txt").exists()
    assert any("outside the data home" in w for w in summary["warnings"])


def test_nested_git_dir_is_skipped_and_recorded(tmp_data_home, tmp_path):
    _seed(tmp_data_home)
    nested = tmp_data_home / "skills" / "brainstorm" / ".git"
    nested.mkdir()
    (nested / "HEAD").write_text("ref: refs/heads/main\n")

    summary = backup.assemble_snapshot(tmp_path / "snap", data_home=tmp_data_home)
    assert not (tmp_path / "snap" / "skills" / "brainstorm" / ".git").exists()
    assert "skills/brainstorm/.git" in summary["manifest"]["nested_git"]


# ─────────────────────────────────────────────────────────────────────────────
# 3. Field-scoped path transform (design §3)
# ─────────────────────────────────────────────────────────────────────────────


def test_project_path_never_tokenizes_to_code_home():
    """The live registry has a project whose path IS code_home. A blanket sweep
    would rewrite it to {CODE_HOME} and destroy it on restore."""
    home = Path("/Users/x")
    data_home = home / ".skill-hub"
    code_home = home / "Dev" / ".skill-hub"
    registry = {"projects": {"skill-tree": {"path": str(code_home)}}}

    out = backup.to_portable(registry, data_home=data_home, code_home=code_home, home=home)
    assert out["projects"]["skill-tree"]["path"] == "{HOME}/Dev/.skill-hub"


def test_tilde_collapsed_sources_normalize_before_tokenizing():
    home = Path("/Users/x")
    data_home = home / ".skill-hub"
    registry = {"skills": {"a": {"source": "~/.skill-hub/skills/a"}}}
    out = backup.to_portable(registry, data_home=data_home, code_home=None, home=home)
    assert out["skills"]["a"]["source"] == "{DATA_HOME}/skills/a"


def test_transform_is_field_scoped_not_a_blanket_sweep():
    home = Path("/Users/x")
    registry = {
        "skills": {"a": {"source": str(home / "s"), "description": str(home / "s")}},
        "note": str(home / "s"),
    }
    out = backup.to_portable(registry, data_home=home / ".skill-hub", home=home)
    assert out["skills"]["a"]["source"] == "{HOME}/s"
    # Not a declared field path → untouched.
    assert out["skills"]["a"]["description"] == str(home / "s")
    assert out["note"] == str(home / "s")


def test_relative_and_template_values_survive_verbatim():
    home = Path("/Users/x")
    registry = {"skills": {"a": {"mcp": {"args": ["{source}/server.py", "--flag"]}}}}
    out = backup.to_portable(registry, data_home=home / ".skill-hub", home=home)
    assert out["skills"]["a"]["mcp"]["args"] == ["{source}/server.py", "--flag"]


def test_transform_round_trips_in_token_space():
    home = Path("/Users/x")
    data_home = home / ".skill-hub"
    code_home = home / "Dev" / ".skill-hub"
    registry = {
        "projects": {"p": {"path": str(home / "code" / "p")}},
        "skills": {
            "a": {"source": str(data_home / "skills" / "a")},
            "b": {"source": str(code_home / "skills" / "b")},
        },
        "sources": {"s": {"cache": "~/.skill-hub/sources/s"}},
    }
    portable = backup.to_portable(
        registry, data_home=data_home, code_home=code_home, home=home
    )
    assert portable["skills"]["a"]["source"] == "{DATA_HOME}/skills/a"
    assert portable["skills"]["b"]["source"] == "{CODE_HOME}/skills/b"
    assert portable["sources"]["s"]["cache"] == "{DATA_HOME}/sources/s"

    # Expand onto a DIFFERENT machine, then re-tokenize: identical token form.
    other_home = Path("/Users/y")
    landed = backup.from_portable(
        portable,
        data_home=other_home / ".skill-hub",
        code_home=other_home / "Dev" / ".skill-hub",
        home=other_home,
    )
    assert landed["skills"]["a"]["source"] == "~/.skill-hub/skills/a"
    assert landed["projects"]["p"]["path"] == "~/code/p"
    again = backup.to_portable(
        landed,
        data_home=other_home / ".skill-hub",
        code_home=other_home / "Dev" / ".skill-hub",
        home=other_home,
    )
    assert again == portable


def test_drop_keys_and_mcp_env_redaction():
    home = Path("/Users/x")
    registry = {
        "hub_path": "/somewhere",
        "bootstrap": {"completed_at": "now"},
        "signing": {"pubkey": "ssh-ed25519 AAAA..."},
        "skills": {"a": {"mcp": {"env": {"MY_API_KEY": "ghp_realtokenvalue0123456789"}}}},
    }
    out = backup.to_portable(registry, data_home=home / ".skill-hub", home=home)
    assert "hub_path" not in out
    assert "bootstrap" not in out
    assert "signing" not in out, "the signing pin must never travel"
    assert out["skills"]["a"]["mcp"]["env"]["MY_API_KEY"] == backup.REDACTED
    assert registry["skills"]["a"]["mcp"]["env"]["MY_API_KEY"].startswith("ghp_")


def test_source_classification(tmp_data_home, tmp_path):
    data_home = Path("/Users/x/.skill-hub")
    code_home = Path("/Users/x/Dev/.skill-hub")
    registry = {
        "sources": {"gitsrc": {"cache": "/Users/x/.skill-hub/sources/gitsrc"}},
        "skills": {
            "owned": {"source": "/Users/x/.skill-hub/skills/owned"},
            "bundled": {"source": "/Users/x/Dev/.skill-hub/skills/bundled"},
            "cloned": {"source": "/Users/x/.skill-hub/sources/gitsrc/skills/cloned"},
            "foreign": {"source": "~/.codex/skills/gh-fix-ci"},
        },
    }
    out = backup.classify_sources(
        registry, data_home=data_home, code_home=code_home, home=Path("/Users/x")
    )
    assert out["owned"]["class"] == "inside-data-home"
    assert out["owned"]["in_snapshot"] is True
    assert out["bundled"]["class"] == "inside-code-home"
    assert out["cloned"]["class"] == "git-source"
    assert out["foreign"]["class"] == "foreign"
    assert all(not out[k]["in_snapshot"] for k in ("bundled", "cloned", "foreign"))


# ─────────────────────────────────────────────────────────────────────────────
# Prefix-leak gate (design §3 — the PRIMARY transform proof)
# ─────────────────────────────────────────────────────────────────────────────


def test_prefix_leak_in_a_transform_owned_field_hard_fails():
    """The gate is scoped to the fields TRANSFORM_RULES claims to rewrite, so a
    missed rewrite always trips it."""
    portable = {"skills": {"a": {"source": "/Users/x/.skill-hub/skills/a"}}}
    with pytest.raises(backup.PrefixLeakError) as exc:
        backup.assert_transform_applied(portable, ["/Users/x/.skill-hub", "/Users/x"])
    assert "skills.a.source" in str(exc.value)


def test_prefix_gate_passes_on_a_correctly_transformed_registry():
    portable = {
        "skills": {"a": {"source": "{DATA_HOME}/skills/a"}},
        "projects": {"p": {"path": "{HOME}/code/p"}},
        # A field hub does NOT own may keep an absolute path without blocking.
        "hooks": {"fmt": {"command": "python3 /Users/x/bin/fmt.py"}},
    }
    backup.assert_transform_applied(portable, ["/Users/x"])  # no raise


def test_prefix_leak_in_file_content_is_advisory_only(tmp_path):
    """Hard-failing on user prose would brick every future backup."""
    snap = tmp_path / "snap"
    (snap / "skills" / "a").mkdir(parents=True)
    (snap / "skills" / "a" / "SKILL.md").write_text("see /Users/x/notes.md\n")
    warnings = backup.scan_for_machine_prefixes(snap, ["/Users/x"])
    assert warnings and "not hub-rewritable" in warnings[0]


def test_manifest_json_is_exempt_from_the_prefix_gate(tmp_data_home, tmp_path):
    """The exemption must be REAL (the prefix is in there) and SCOPED to it.

    Both halves matter: if `manifest.json` stopped recording the prefixes the
    exemption would be pointless, and if the exemption widened to the whole tree
    the scan would stop reporting anything at all.
    """
    _seed(tmp_data_home)
    snap = tmp_path / "snap"
    backup.assemble_snapshot(snap, data_home=tmp_data_home)
    prefixes = [str(tmp_data_home)]

    manifest = json.loads((snap / "manifest.json").read_text())
    assert manifest["prefixes"]["data_home"] == str(tmp_data_home)
    assert str(tmp_data_home) in (snap / "manifest.json").read_text(), (
        "the exemption is only meaningful because the manifest DOES carry the prefix"
    )
    assert backup.scan_for_machine_prefixes(snap, prefixes) == []

    # The very same bytes in any other file must still be reported.
    (snap / "skills" / "brainstorm" / "NOTES.md").write_text(
        "see " + str(tmp_data_home) + "/skills for the source\n"
    )
    warnings = backup.scan_for_machine_prefixes(snap, prefixes)
    assert [w for w in warnings if "NOTES.md" in w], warnings
    assert not [w for w in warnings if "manifest.json" in w], warnings


def test_assembled_registry_carries_no_machine_paths(tmp_data_home, tmp_path):
    _seed(tmp_data_home)
    backup.assemble_snapshot(tmp_path / "snap", data_home=tmp_data_home)
    text = (tmp_path / "snap" / "registry.yaml").read_text()
    assert str(tmp_data_home) not in text
    assert "{DATA_HOME}/skills/brainstorm" in text


# ─────────────────────────────────────────────────────────────────────────────
# 4. Secret gates (design §4)
# ─────────────────────────────────────────────────────────────────────────────


def test_signing_dir_is_never_copied_into_the_snapshot(tmp_data_home, tmp_path):
    """Coded exclusion: a planted private key must not reach the snapshot."""
    _seed(tmp_data_home)
    signing = tmp_data_home / "state" / "signing"
    signing.mkdir(parents=True)
    (signing / "hub_ed25519").write_text(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n"
    )
    (tmp_data_home / "state" / "codex-workers").mkdir(parents=True)
    (tmp_data_home / "state" / "codex-workers" / "id_ed25519").write_text(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n"
    )

    backup.assemble_snapshot(tmp_path / "snap", data_home=tmp_data_home)
    assert not (tmp_path / "snap" / "state" / "signing").exists()
    assert not (tmp_path / "snap" / "state" / "codex-workers").exists()
    assert backup.scan_for_secrets(tmp_path / "snap") == []


def test_assert_no_secrets_refuses_a_planted_private_key(tmp_path):
    snap = tmp_path / "snap"
    (snap / "state" / "signing").mkdir(parents=True)
    (snap / "state" / "signing" / "hub_ed25519").write_text(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n"
    )
    with pytest.raises(backup.SecretLeakError) as exc:
        backup.assert_no_secrets(snap)
    message = str(exc.value)
    assert "forbidden path" in message
    assert "private-key material" in message


def test_credential_content_scan_reports_file_and_line(tmp_path):
    snap = tmp_path / "snap"
    (snap / "skills" / "a").mkdir(parents=True)
    (snap / "skills" / "a" / "SKILL.md").write_text(
        "line one\napi_key: ghp_abcdefghijklmnopqrstuvwxyz0123\n"
    )
    findings = backup.scan_for_secrets(snap)
    assert any("skills/a/SKILL.md:2" in f for f in findings)
    with pytest.raises(backup.SecretLeakError):
        backup.assert_no_secrets(snap)


def test_allow_secret_acknowledges_one_specific_finding(tmp_path):
    snap = tmp_path / "snap"
    snap.mkdir()
    (snap / "notes.md").write_text("token: AKIAIOSFODNN7EXAMPLE\n")
    findings = backup.scan_for_secrets(snap)
    assert findings
    allowed = {backup.finding_id(f) for f in findings}
    backup.assert_no_secrets(snap, allowed=allowed)  # no raise
    with pytest.raises(backup.SecretLeakError):
        backup.assert_no_secrets(snap, allowed={"deadbeef"})


def test_placeholder_values_do_not_trip_the_scanner(tmp_path):
    snap = tmp_path / "snap"
    snap.mkdir()
    (snap / "doc.md").write_text(
        "api_key: your-api-key-goes-right-here\n"
        "password: {REDACTED}\n"
        "token: replace-with-example-value\n"
    )
    assert backup.scan_for_secrets(snap) == []


def test_manifest_json_is_scanned_for_secrets_too(tmp_data_home, tmp_path):
    """`manifest.json` is written AFTER the tree scan, so it needs its own gate.

    It is hub-generated but carries user-controlled strings — here the name of
    an unknown data-home entry, echoed verbatim into a warning.
    """
    _seed(tmp_data_home)
    (tmp_data_home / "AKIAIOSFODNN7EXAMPLE").mkdir()
    snap = tmp_path / "snap"
    with pytest.raises(backup.SecretLeakError) as exc:
        backup.assemble_snapshot(snap, data_home=tmp_data_home)
    assert "manifest.json" in str(exc.value)
    assert not (snap / "manifest.json").exists(), "the refused manifest must not be written"

    # …and the same per-finding acknowledgement applies, with the sha the error
    # itself hands the user.
    sha = __import__("re").search(r"--allow-secret ([0-9a-f]{64})", str(exc.value)).group(1)
    backup.assemble_snapshot(snap, data_home=tmp_data_home, allowed_secrets={sha})
    assert (snap / "manifest.json").is_file()


def test_out_of_home_connector_symlinks_are_named_and_recorded(tmp_data_home, tmp_path, outside):
    """A skipped connector must not look like "no connectors" (audit fix F9)."""
    _seed(tmp_data_home)
    external = outside / "my-connector-checkout"
    external.mkdir()
    (external / "__init__.py").write_text("# code that lives elsewhere\n")
    (tmp_data_home / "connectors").mkdir(exist_ok=True)
    os.symlink(external, tmp_data_home / "connectors" / "hermes_fork")

    snap = tmp_path / "snap"
    summary = backup.assemble_snapshot(snap, data_home=tmp_data_home)
    assert summary["counts"]["connectors"] == 0
    assert any(
        "hermes_fork" in w and "symlink out of the data home" in w
        for w in summary["warnings"]
    ), summary["warnings"]
    recorded = backup.read_manifest(snap)["external_connectors"]
    assert [item["name"] for item in recorded] == ["hermes_fork"]
    assert recorded[0]["target"] == str(external)
    assert not (snap / "connectors" / "hermes_fork").exists()


def test_fingerprint_catches_an_mtime_preserving_registry_edit(tmp_data_home):
    """Stat-only would miss a same-size, mtime-restored rewrite (audit fix F8)."""
    _seed(tmp_data_home)
    reg_path = tmp_data_home / "registry.yaml"
    before = backup.snapshot_fingerprint(tmp_data_home)

    original = reg_path.read_text()
    stat = reg_path.stat()
    edited = original.replace("scope: portable", "scope: globalxx", 1)
    assert edited != original and len(edited) == len(original)
    reg_path.write_text(edited)
    os.utime(reg_path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert reg_path.stat().st_size == stat.st_size
    assert reg_path.stat().st_mtime_ns == stat.st_mtime_ns

    assert backup.snapshot_fingerprint(tmp_data_home) != before, (
        "the registry is hashed for real precisely so this cannot slip through"
    )


def test_mcp_env_secret_is_redacted_before_it_can_be_scanned(tmp_data_home, tmp_path):
    reg = _seed(tmp_data_home)
    reg["skills"]["brainstorm"]["mcp"] = {
        "command": "python3",
        "env": {"MY_API_KEY": "ghp_abcdefghijklmnopqrstuvwxyz0123"},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    backup.assemble_snapshot(tmp_path / "snap", data_home=tmp_data_home)
    text = (tmp_path / "snap" / "registry.yaml").read_text()
    assert "ghp_" not in text
    assert backup.REDACTED in text


# ─────────────────────────────────────────────────────────────────────────────
# Manifest integrity (design §2 / §5 restore gate)
# ─────────────────────────────────────────────────────────────────────────────


def test_manifest_records_per_file_hashes_and_a_tree_digest(tmp_data_home, tmp_path):
    _seed(tmp_data_home)
    snap = tmp_path / "snap"
    backup.assemble_snapshot(snap, data_home=tmp_data_home)
    manifest = backup.read_manifest(snap)
    assert "skills/brainstorm/SKILL.md" in manifest["files"]
    assert len(manifest["tree_digest"]) == 64
    assert backup.verify_tree_digest(snap)["ok"] is True

    (snap / "skills" / "brainstorm" / "SKILL.md").write_text("tampered")
    assert backup.verify_tree_digest(snap)["ok"] is False


def test_audit_log_is_scoped_per_machine(tmp_data_home, tmp_path):
    _seed(tmp_data_home)
    (tmp_data_home / "state").mkdir(exist_ok=True)
    (tmp_data_home / "state" / "audit.jsonl").write_text('{"verb":"enable"}\n')
    snap = tmp_path / "snap"
    backup.assemble_snapshot(snap, data_home=tmp_data_home)
    expected = "audit/" + backup.safe_hostname() + ".jsonl"
    assert (snap / expected).exists()
    assert expected in backup.read_manifest(snap)["state_files"]


# ─────────────────────────────────────────────────────────────────────────────
# 5. Git ops (design §7)
# ─────────────────────────────────────────────────────────────────────────────


def test_git_init_pins_the_main_branch(tmp_path):
    repo = tmp_path / "repo"
    backup.git_init(repo)
    assert backup.git_current_branch(repo) == "main"
    assert oct(repo.stat().st_mode)[-3:] == "700"


def test_commit_is_idempotent_when_nothing_changed(wired):
    data_home, dest = wired
    registry = _reg(data_home)

    first = backup.run_backup(registry, push=False, force=True, data_home=data_home)
    assert first["committed"] is True
    head = backup.git_last_commit(dest)["sha"]

    second = backup.run_backup(registry, push=False, force=True, data_home=data_home)
    assert second["committed"] is False, "an unchanged snapshot must not commit"
    assert backup.git_last_commit(dest)["sha"] == head


def test_fingerprint_gate_skips_the_copy_entirely(wired, monkeypatch):
    data_home, dest = wired
    registry = _reg(data_home)
    backup.run_backup(registry, push=False, force=True, data_home=data_home)

    def _boom(*a, **kw):
        raise AssertionError("assemble_snapshot must not run for unchanged state")

    monkeypatch.setattr(backup, "assemble_snapshot", _boom)
    result = backup.run_backup(registry, push=False, force=False, data_home=data_home)
    assert result["skipped"] == "unchanged"

    # A real change re-arms it.
    monkeypatch.undo()
    _seed_skill(data_home, "second-skill")
    result = backup.run_backup(registry, push=False, force=False, data_home=data_home)
    assert result["skipped"] is None
    assert result["committed"] is True


def _git_out(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    ).stdout.strip()


def test_non_fast_forward_is_structurally_impossible(tmp_data_home, outside, monkeypatch):
    """Two GENUINELY divergent machines, one bare remote, and no force-push.

    B is not a fresh clone of A: it has its own data home, its own local-only
    snapshot history built while offline, and it meets a remote that has moved
    on. That is exactly the situation a `push --force` gets reached for. The
    backup instead adopts the remote tip and rebuilds its whole tree on top —
    lossless, because every commit is a complete tree — and the local-only
    history it resets away is parked under `refs/backup/local-*` rather than
    amputated.
    """
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "local", "user": None})
    bare = outside / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", "-b", "main", str(bare)], check=True)

    machine_a = outside / "a"
    machine_b = outside / "b"
    data_home_b = outside / "data-home-b"
    data_home_b.mkdir()

    def _cfg(data_home: Path, dest: Path, remote):
        registry = yaml.safe_load((data_home / "registry.yaml").read_text())
        cfg = backup.load_backup_config(registry)
        cfg["dir"] = str(dest)
        cfg["remote"] = str(remote) if remote else None
        cfg["enabled"] = True
        backup.save_backup_config(registry, cfg)
        return registry

    # --- machine A publishes first -----------------------------------------
    _seed(tmp_data_home, skills=("only-on-a",))
    res_a = backup.run_backup(
        _cfg(tmp_data_home, machine_a, bare), push=True, force=True, data_home=tmp_data_home
    )
    assert res_a["pushed"] is True, res_a
    sha_a = backup.git_last_commit(machine_a)["sha"]

    # --- machine B: different content, and two OFFLINE commits of its own ---
    _seed(data_home_b, skills=("only-on-b",))
    reg_b_offline = _cfg(data_home_b, machine_b, None)
    for i in range(2):
        _seed_skill(data_home_b, "offline-{0}".format(i))
        backup.run_backup(reg_b_offline, push=False, force=True, data_home=data_home_b)
    local_tip = backup.git_last_commit(machine_b)["sha"]
    assert local_tip != sha_a
    assert len(_git_out(machine_b, "log", "--format=%H").splitlines()) == 2

    # --- B now meets the moved-on remote ------------------------------------
    res_b = backup.run_backup(
        _cfg(data_home_b, machine_b, bare), push=True, force=True, data_home=data_home_b
    )
    assert res_b["conflict"] is False
    assert res_b["pushed"] is True, res_b

    # The local-only history was PARKED, not discarded (audit fix F2).
    saved = res_b.get("saved_ref")
    assert saved and saved.startswith("refs/backup/local-"), res_b
    assert _git_out(machine_b, "rev-parse", saved) == local_tip
    assert any("preserved at " + saved in w for w in res_b["warnings"]), res_b["warnings"]

    # The push was a fast-forward over A's commit — no force anywhere.
    assert subprocess.run(
        ["git", "-C", str(bare), "merge-base", "--is-ancestor", sha_a, "main"]
    ).returncode == 0, "A's snapshot must remain in the published history"
    tree = _git_out(bare, "ls-tree", "-r", "--name-only", "main").splitlines()
    assert "skills/only-on-b/SKILL.md" in tree, "the remote must end with B's content"
    assert "skills/only-on-a/SKILL.md" not in tree, "B's tree replaces A's, wholesale"


def test_a_foreign_remote_tip_is_never_adopted_or_published_over(
    tmp_data_home, outside, monkeypatch
):
    """A remote with commits but no `manifest.json` is somebody else's repo."""
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "local", "user": None})
    _seed(tmp_data_home)

    # A bare repo whose tip is a stranger's work.
    bare = outside / "theirs.git"
    seed = outside / "theirs"
    subprocess.run(["git", "init", "--bare", "-q", "-b", "main", str(bare)], check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(seed)], check=True)
    (seed / "README.md").write_text("their project\n")
    for cmd in (
        ["add", "-A"],
        ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "theirs"],
        ["push", "-q", str(bare), "main"],
    ):
        subprocess.run(["git", "-C", str(seed), *cmd], check=True)
    their_sha = _git_out(bare, "rev-parse", "main")

    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg.update(dir=str(outside / "ours"), remote=str(bare), enabled=True)
    backup.save_backup_config(registry, cfg)

    result = backup.run_backup(registry, push=True, force=True, data_home=tmp_data_home)
    assert result["ok"] is False
    assert "not a Skill Tree backup repo" in (result["error"] or "")
    assert result["pushed"] is False
    assert result["push_attempted"] is False, "we must not even try to publish"
    assert _git_out(bare, "rev-parse", "main") == their_sha, "their history is untouched"


def test_push_conflict_is_reported_never_forced(wired, monkeypatch):
    data_home, dest = wired
    backup.git_init(dest)
    backup.git_set_remote(dest, "https://example.invalid/repo.git")

    class _Rejected:  # noqa: D401
        returncode = 1
        stdout = ""
        stderr = "! [rejected] main -> main (non-fast-forward)"

    monkeypatch.setattr(backup, "git", lambda *a, **kw: _Rejected())
    monkeypatch.setattr(backup, "git_remote_url", lambda *a, **kw: "https://example.invalid/r.git")
    out = backup.git_push(dest, method="ssh", branch="main")
    assert out["pushed"] is False
    assert out["conflict"] is True
    assert "never force-pushes" in out["detail"]


def test_git_timeout_surfaces_as_a_catchable_git_error(tmp_path, monkeypatch):
    def _hang(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="git", timeout=1)

    monkeypatch.setattr(backup.subprocess, "run", _hang)
    with pytest.raises(backup.GitError) as exc:
        backup.git(tmp_path, "status")
    assert "timed out" in str(exc.value)


def test_git_env_overrides_win_over_the_defaults(tmp_path):
    repo = tmp_path / "repo"
    backup.git_init(repo)
    captured = {}
    real_run = backup.subprocess.run

    def _spy(cmd, **kw):
        captured.update(kw.get("env") or {})
        return real_run(cmd, **kw)

    backup.subprocess.run = _spy
    try:
        backup.git(repo, "status", "--porcelain", env_overrides={"GIT_TERMINAL_PROMPT": "1"})
    finally:
        backup.subprocess.run = real_run
    assert captured["GIT_TERMINAL_PROMPT"] == "1", "caller env must be applied LAST"


# ─────────────────────────────────────────────────────────────────────────────
# 6. Auth ladder (design §7)
# ─────────────────────────────────────────────────────────────────────────────


def _fake_proc(returncode=0, stdout="", stderr=""):
    class _P:
        pass

    p = _P()
    p.returncode = returncode
    p.stdout = stdout
    p.stderr = stderr
    return p


def test_ssh_probe_classifies_on_stderr_not_exit_code(monkeypatch):
    """GitHub's `ssh -T` exits 1 on SUCCESS — the greeting is the only signal."""
    monkeypatch.setattr(backup, "probe_ssh", _REAL_PROBE_SSH)
    monkeypatch.setattr(
        backup,
        "_run",
        lambda cmd, timeout=10: _fake_proc(
            returncode=1,
            stderr="Hi Ramtoi! You've successfully authenticated, but GitHub does "
            "not provide shell access.\n",
        ),
    )
    out = backup.probe_ssh()
    assert out["available"] is True
    assert out["user"] == "Ramtoi"


def test_ssh_probe_rejects_a_denied_key(monkeypatch):
    monkeypatch.setattr(backup, "probe_ssh", _REAL_PROBE_SSH)
    monkeypatch.setattr(
        backup,
        "_run",
        lambda cmd, timeout=10: _fake_proc(returncode=255, stderr="Permission denied (publickey)."),
    )
    assert backup.probe_ssh()["available"] is False


def test_ssh_probe_never_mutates_known_hosts_interactively(monkeypatch):
    seen = {}
    monkeypatch.setattr(backup, "probe_ssh", _REAL_PROBE_SSH)

    def _capture(cmd, timeout=10):
        seen["cmd"] = cmd
        return _fake_proc(1)

    monkeypatch.setattr(backup, "_run", _capture)
    backup.probe_ssh()
    assert "BatchMode=yes" in seen["cmd"]
    assert "StrictHostKeyChecking=accept-new" in seen["cmd"]


def test_gh_probe_extracts_the_active_account(monkeypatch):
    monkeypatch.setattr(backup, "probe_gh", _REAL_PROBE_GH)
    monkeypatch.setattr(backup, "gh_active_login", _REAL_GH_LOGIN)
    monkeypatch.setattr(
        backup,
        "_run",
        lambda cmd, timeout=10: _fake_proc(
            returncode=0, stdout="  ✓ Logged in to github.com account Ramtoi (keyring)\n"
        ),
    )
    assert backup.probe_gh()["user"] == "Ramtoi"
    assert backup.gh_active_login() == "Ramtoi"


def test_push_prefers_ssh_then_pat_and_gh_is_creation_only(monkeypatch):
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": False, "detail": "", "user": None})
    monkeypatch.setattr(backup, "probe_gh", lambda timeout=10: {
        "method": "gh", "available": True, "detail": "", "user": "Ramtoi"})
    monkeypatch.setattr(backup, "probe_pat", lambda: {
        "method": "pat", "available": True, "detail": "", "user": None})
    auth = backup.detect_auth()
    assert auth["method"] == "pat", "gh must not win the push race"
    assert auth["create_method"] == "gh"


def test_missing_keyring_degrades_gracefully(monkeypatch):
    monkeypatch.setattr(backup, "probe_pat", _REAL_PROBE_PAT)
    monkeypatch.setattr(backup, "keyring_available", lambda: False)
    out = backup.probe_pat()
    assert out["available"] is False
    assert "keyring library unavailable" in out["detail"]
    assert "Traceback" not in out["detail"]


def test_pat_credential_helper_never_embeds_the_token():
    """The helper names an ENV VAR; the value only exists in the child process."""
    assert "$SKILL_HUB_BACKUP_TOKEN" in backup._PAT_CREDENTIAL_HELPER
    assert "ghp_" not in backup._PAT_CREDENTIAL_HELPER


_GIT_STUB = """\
#!/bin/sh
{
  for a in "$@"; do echo "ARG:$a"; done
  echo "---ENV---"
  env
} >> "$GIT_STUB_LOG"
exit 0
"""


def _stub_git_on_path(tmp_path, monkeypatch) -> Path:
    """Put a fake `git` first on PATH that records its own argv + env.

    Stubbing `backup.git` would only prove what the caller *passed*; the claim
    under test is about what the real runner hands to the real child process.
    """
    bindir = tmp_path / "stub-bin"
    bindir.mkdir()
    log = tmp_path / "git-invocations.txt"
    script = bindir / "git"
    script.write_text(_GIT_STUB)
    script.chmod(0o755)
    monkeypatch.setenv("GIT_STUB_LOG", str(log))
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ.get("PATH", ""))
    return log


def test_pat_push_passes_the_token_only_through_the_child_env(wired, tmp_path, monkeypatch):
    """End-to-end through the REAL runner and a REAL child process.

    Three claims, all checked against what the child actually received:
      * the token is absent from argv;
      * it is present in the child's environment;
      * `credential.helper=` is blanked BEFORE ours is installed, so a
        configured OS helper cannot shadow (or cache) the inline one.
    """
    _data_home, dest = wired
    backup.git_init(dest)
    token = "ghp_secretvalue0123456789abcd"
    monkeypatch.setattr(backup, "get_pat", lambda: token)
    monkeypatch.setattr(backup, "git_remote_url", lambda *a, **kw: "https://example.invalid/r.git")
    monkeypatch.setattr(backup, "git_current_branch", lambda *a, **kw: "main")

    log = _stub_git_on_path(tmp_path, monkeypatch)
    out = backup.git_push(dest, method="pat", branch="main")
    assert out["pushed"] is True

    recorded = log.read_text()
    argv_block, _, env_block = recorded.partition("---ENV---")
    args = [line[4:] for line in argv_block.splitlines() if line.startswith("ARG:")]

    assert args, "the stub git was never invoked — PATH shadowing failed"
    assert token not in argv_block, "token must never reach argv"
    assert "push" in args
    assert (token in env_block) and ("SKILL_HUB_BACKUP_TOKEN=" + token) in env_block, (
        "the token must reach git only through the child environment"
    )
    assert "credential.helper=" in args, "the OS helper must be blanked first"
    assert args.index("credential.helper=") < args.index(
        "credential.helper=" + backup._PAT_CREDENTIAL_HELPER
    ), "blanking must come BEFORE our inline helper, or it would erase it"


def test_ssh_push_never_carries_a_token_at_all(wired, tmp_path, monkeypatch):
    """The non-PAT rungs must not touch the keychain or the credential plumbing."""
    _data_home, dest = wired
    backup.git_init(dest)

    def _boom():
        raise AssertionError("the ssh rung must never read the stored PAT")

    monkeypatch.setattr(backup, "get_pat", _boom)
    monkeypatch.setattr(backup, "git_remote_url", lambda *a, **kw: "git@example.invalid:r.git")
    monkeypatch.setattr(backup, "git_current_branch", lambda *a, **kw: "main")
    log = _stub_git_on_path(tmp_path, monkeypatch)
    backup.git_push(dest, method="ssh", branch="main")
    argv_block = log.read_text().partition("---ENV---")[0]
    assert "credential.helper" not in argv_block
    assert "SKILL_HUB_BACKUP_TOKEN" not in argv_block


def test_create_repo_is_gh_only(monkeypatch):
    """`--create` is a `gh` capability, and no other rung may stand in for it.

    A fine-grained PAT scoped to one repo (the permission we actually want the
    user to grant) cannot create repositories, so a PAT-only ladder must fail
    LOUDLY with the manual path — never quietly try something else.
    """
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "", "user": None})
    monkeypatch.setattr(backup, "probe_gh", lambda timeout=10: {
        "method": "gh", "available": False, "detail": "not logged in", "user": None})
    monkeypatch.setattr(backup, "probe_pat", lambda: {
        "method": "pat", "available": True, "detail": "", "user": None})
    auth = backup.detect_auth()
    assert auth["method"] == "ssh", "pushing still works"
    assert auth["create_method"] is None, "but nothing may claim it can CREATE"

    # The function itself shells out to `gh` and to nothing else — no PAT read,
    # no https API call — and refuses (rather than no-ops) when gh is missing.
    def _boom():
        raise AssertionError("create must never fall back to the PAT")

    monkeypatch.setattr(backup, "get_pat", _boom)
    calls: list = []

    def _no_gh(cmd, timeout=10):
        calls.append(cmd)
        return None  # binary not found

    monkeypatch.setattr(backup, "_run", _no_gh)
    with pytest.raises(backup.BackupError) as exc:
        backup.create_github_repo("owner/name")
    assert calls == [["gh", "repo", "create", "owner/name", "--private"]]
    assert "gh CLI not available" in str(exc.value)

    instructions = backup.manual_create_instructions("owner/name")
    assert "github.com/new" in instructions
    assert "Contents: Read and write" in instructions


def test_cli_create_on_a_pat_only_ladder_never_calls_create(tmp_data_home, outside, capsys, monkeypatch):
    """The CLI gate must fire BEFORE any repo-creation attempt."""
    _seed(tmp_data_home)
    monkeypatch.setattr(backup, "probe_pat", lambda: {
        "method": "pat", "available": True, "detail": "stored", "user": None})
    called: list = []
    monkeypatch.setattr(
        backup, "create_github_repo",
        lambda *a, **kw: called.append(a) or {"created": True, "detail": ""},
    )
    with pytest.raises(SystemExit):
        hub.cmd_backup_init(_ns(
            repo="owner/name", remote=None, create=True,
            dir=str(outside / "bk"), json=True,
        ))
    assert called == [], "a PAT ladder must not reach repo creation"
    assert "github.com/new" in json.loads(capsys.readouterr().out)["error"]


# ─────────────────────────────────────────────────────────────────────────────
# 7. `--dir` / remote guards (design §7)
# ─────────────────────────────────────────────────────────────────────────────


def test_backup_dir_may_not_live_inside_the_data_home(tmp_data_home):
    with pytest.raises(backup.BackupError) as exc:
        backup.validate_backup_dir(tmp_data_home / "nested-backup", data_home=tmp_data_home)
    assert "data home" in str(exc.value)


def test_backup_dir_refuses_a_foreign_git_repo(tmp_data_home, outside):
    foreign = outside / "someone-elses"
    foreign.mkdir()
    subprocess.run(["git", "init", "-q", str(foreign)], check=True)
    (foreign / "README.md").write_text("not ours\n")
    subprocess.run(
        ["git", "-C", str(foreign), "-c", "user.name=t", "-c", "user.email=t@t",
         "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(foreign), "-c", "user.name=t", "-c", "user.email=t@t",
         "commit", "-qm", "theirs"], check=True)
    with pytest.raises(backup.BackupError) as exc:
        backup.validate_backup_dir(foreign, data_home=tmp_data_home, code_home=None)
    assert "manifest.json" in str(exc.value)


def test_backup_dir_accepts_an_empty_or_missing_dir(tmp_data_home, outside):
    backup.validate_backup_dir(outside / "brand-new", data_home=tmp_data_home, code_home=None)
    empty = outside / "empty"
    empty.mkdir()
    backup.validate_backup_dir(empty, data_home=tmp_data_home, code_home=None)


def test_backup_dir_refuses_a_non_empty_non_repo(tmp_data_home, outside):
    busy = outside / "busy"
    busy.mkdir()
    (busy / "stuff.txt").write_text("x")
    with pytest.raises(backup.BackupError):
        backup.validate_backup_dir(busy, data_home=tmp_data_home, code_home=None)


def test_run_backup_revalidates_the_dir_every_time(tmp_data_home, outside):
    """`init` is not the only way a `backup.dir` gets set (audit fix F1).

    `registry.yaml` is a user-editable file and `migrate-home` can move the data
    home, so `run_backup` must re-run the guards itself: it `git init`s the dir
    and `_rm()`s every SNAPSHOT_OWNED name inside it.
    """
    _seed(tmp_data_home)
    victim = outside / "someones-notes"
    victim.mkdir()
    (victim / "skills").mkdir()  # a SNAPSHOT_OWNED name — pruning would eat it
    (victim / "skills" / "precious.md").write_text("not ours\n")

    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg.update(dir=str(victim), enabled=True)
    backup.save_backup_config(registry, cfg)

    with pytest.raises(backup.BackupError) as exc:
        backup.run_backup(registry, push=False, force=True, data_home=tmp_data_home)
    assert "not empty" in str(exc.value)
    assert (victim / "skills" / "precious.md").read_text() == "not ours\n"
    assert not (victim / ".git").exists(), "no repo may be created in a foreign dir"


def test_run_backup_fast_paths_a_dir_that_is_already_ours(wired):
    """Re-validation must not cost anything on the normal path."""
    data_home, dest = wired
    registry = _reg(data_home)
    backup.run_backup(registry, push=False, force=True, data_home=data_home)
    assert (dest / "manifest.json").is_file()
    # Second run over the now-populated, hub-owned dir: still fine.
    _seed_skill(data_home, "another")
    result = backup.run_backup(registry, push=False, force=True, data_home=data_home)
    assert result["ok"] is True
    assert result["committed"] is True


def test_run_backup_refuses_a_dir_that_moved_inside_the_data_home(tmp_data_home, outside):
    """The migrate-home hazard: the dir did not move, the data home did."""
    _seed(tmp_data_home)
    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg.update(dir=str(tmp_data_home / "nested-backup"), enabled=True)
    backup.save_backup_config(registry, cfg)
    with pytest.raises(backup.BackupError) as exc:
        backup.run_backup(registry, push=False, force=True, data_home=tmp_data_home)
    assert "data home" in str(exc.value)


# ─────────────────────────────────────────────────────────────────────────────
# 8. CLI surface
# ─────────────────────────────────────────────────────────────────────────────


def test_cli_init_records_the_backup_block(tmp_data_home, outside, capsys):
    _seed(tmp_data_home)
    dest = outside / "bk"
    hub.cmd_backup_init(_ns(
        repo=None, remote=None, create=False, dir=str(dest), json=True,
    ))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["enabled"] is True
    assert payload["initialized"] is True

    block = _reg(tmp_data_home)["backup"]
    assert set(block) == {
        "dir", "remote", "repo", "branch", "auth", "gh_login",
        "enabled", "push_failures", "last_push_error", "allowed_secrets",
        "pending_reconcile", "pending_reconcile_at",
    }
    assert block["branch"] == "main"
    assert block["enabled"] is True


def test_cli_init_rejects_a_dir_inside_the_data_home(tmp_data_home, capsys):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_backup_init(_ns(
            repo=None, remote=None, create=False,
            dir=str(tmp_data_home / "inside"), json=True,
        ))
    assert json.loads(capsys.readouterr().out)["ok"] is False


def test_cli_init_create_without_gh_explains_the_manual_path(tmp_data_home, outside, capsys):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_backup_init(_ns(
            repo="owner/name", remote=None, create=True,
            dir=str(outside / "bk"), json=True,
        ))
    error = json.loads(capsys.readouterr().out)["error"]
    assert "github.com/new" in error


def test_cli_now_then_status(tmp_data_home, outside, capsys):
    _seed(tmp_data_home)
    hub.cmd_backup_init(_ns(repo=None, remote=None, create=False, dir=str(outside / "bk"), json=True))
    capsys.readouterr()

    hub.cmd_backup_now(_ns(no_push=True, allow_secret=None, json=True))
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True
    assert result["committed"] is True
    assert result["counts"]["skills"] == 1

    hub.cmd_backup_status(_ns(json=True))
    status = json.loads(capsys.readouterr().out)
    assert status["initialized"] is True
    assert status["last_commit"]["subject"].startswith("backup: ")
    assert status["drift"] == "unknown"  # never pushed


def test_cli_now_without_init_fails_clearly(tmp_data_home, capsys):
    _seed(tmp_data_home)
    with pytest.raises(SystemExit):
        hub.cmd_backup_now(_ns(no_push=True, allow_secret=None, json=True))
    assert "hub backup init" in json.loads(capsys.readouterr().out)["error"]


def test_cli_enable_disable_round_trip(tmp_data_home, outside, capsys):
    _seed(tmp_data_home)
    hub.cmd_backup_init(_ns(repo=None, remote=None, create=False, dir=str(outside / "bk"), json=True))
    hub.cmd_backup_disable(_ns(json=True))
    assert _reg(tmp_data_home)["backup"]["enabled"] is False
    hub.cmd_backup_enable(_ns(json=True))
    assert _reg(tmp_data_home)["backup"]["enabled"] is True


def test_cli_auth_json_shape(tmp_data_home, capsys, monkeypatch):
    _seed(tmp_data_home)
    hub.cmd_backup_auth(_ns(json=True, login_pat=False, logout=False))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["method"] is None
    assert [r["method"] for r in payload["ladder"]] == ["ssh", "gh", "pat"]
    assert payload["pat_available"] is False
    assert "pat_detail" in payload
    assert payload["create_method"] is None


def test_cli_auth_login_pat_reads_stdin_only(tmp_data_home, monkeypatch, capsys):
    _seed(tmp_data_home)
    stored = {}
    monkeypatch.setattr(backup, "store_pat", lambda token: stored.update(token=token))
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("ghp_fromstdin0123456789\n"))
    hub.cmd_backup_auth(_ns(json=True, login_pat=True, logout=False))
    assert stored["token"].strip() == "ghp_fromstdin0123456789"
    assert json.loads(capsys.readouterr().out)["stored"] is True


def test_cli_allow_secret_gates_a_flagged_snapshot(tmp_data_home, outside, capsys):
    """The escape hatch has to work end-to-end, through the CLI, per finding."""
    _seed(tmp_data_home)
    (tmp_data_home / "skills" / "brainstorm" / "NOTES.md").write_text(
        "old creds we keep for reference\naws: AKIAIOSFODNN7EXAMPLE\n"
    )
    hub.cmd_backup_init(_ns(repo=None, remote=None, create=False, dir=str(outside / "bk"), json=True))
    capsys.readouterr()

    with pytest.raises(SystemExit):
        hub.cmd_backup_now(_ns(no_push=True, allow_secret=None, json=True))
    error = json.loads(capsys.readouterr().out)["error"]
    assert "skills/brainstorm/NOTES.md:2" in error
    assert backup.git_last_commit(outside / "bk") is None, "nothing may be committed"

    sha = __import__("re").search(r"--allow-secret ([0-9a-f]{64})", error).group(1)
    hub.cmd_backup_now(_ns(no_push=True, allow_secret=sha, json=True))
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True and result["committed"] is True
    assert _reg(tmp_data_home)["backup"]["allowed_secrets"] == [sha]

    # A DIFFERENT finding is still refused — the ack is per finding, not a mute.
    (tmp_data_home / "skills" / "brainstorm" / "MORE.md").write_text(
        "token: ghp_abcdefghijklmnopqrstuvwxyz0123\n"
    )
    capsys.readouterr()
    with pytest.raises(SystemExit):
        hub.cmd_backup_now(_ns(no_push=True, allow_secret=None, json=True))
    assert "MORE.md:1" in json.loads(capsys.readouterr().out)["error"]


def test_cli_now_names_a_refused_publish_as_a_leak_not_a_generic_error(
    tmp_data_home, outside, capsys
):
    """A fail-CLOSED refusal must be machine-identifiable without parsing prose.

    The app renders "Refused to publish — …" for a leak and the plain reason for
    everything else; with no `error_kind` on the wire it could only ever show the
    generic form — exactly the case that most needs the loud framing. Same
    vocabulary the sync report's `global.backup` slot already uses.
    """
    _seed(tmp_data_home)
    (tmp_data_home / "skills" / "brainstorm" / "NOTES.md").write_text(
        "token: ghp_abcdefghijklmnopqrstuvwxyz0123\n"
    )
    hub.cmd_backup_init(
        _ns(repo=None, remote=None, create=False, dir=str(outside / "bk"), json=True)
    )
    capsys.readouterr()

    with pytest.raises(SystemExit):
        hub.cmd_backup_now(_ns(no_push=True, allow_secret=None, json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["error_kind"] == "secret_leak"

    # An unconfigured hub is an ordinary failure — it must NOT read as a leak.
    reg = _reg(tmp_data_home)
    reg.pop("backup", None)
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg))
    capsys.readouterr()
    with pytest.raises(SystemExit):
        hub.cmd_backup_now(_ns(no_push=True, allow_secret=None, json=True))
    assert "error_kind" not in json.loads(capsys.readouterr().out)


def test_backup_now_has_no_token_argv_flag():
    """A `--token` argv precedent exists elsewhere; it must NOT exist here."""
    import inspect

    source = inspect.getsource(hub.cmd_backup_auth)
    assert "args.token" not in source
    assert "sys.stdin.read()" in source


# ─────────────────────────────────────────────────────────────────────────────
# 9. Push-failure bookkeeping (fail-open != fail-silent)
# ─────────────────────────────────────────────────────────────────────────────


def test_record_push_outcome_folds_a_run_into_the_block(tmp_data_home, outside):
    _seed(tmp_data_home)
    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg["dir"] = str(outside / "bk")
    backup.save_backup_config(registry, cfg)

    failed = {"push_attempted": True, "pushed": False, "push_detail": "boom"}
    for expected in (1, 2, 3):
        assert backup.record_push_outcome(registry, failed) is True
        assert registry["backup"]["push_failures"] == expected

    status = backup.backup_status(registry)
    assert any("consecutive push failures" in w for w in status["warnings"])

    ok = {"push_attempted": True, "pushed": True}
    assert backup.record_push_outcome(registry, ok) is True
    assert registry["backup"]["push_failures"] == 0

    # A run that never attempted a push must not count as a failure.
    assert backup.record_push_outcome(registry, {"skipped": "unchanged"}) is False
    assert registry["backup"]["push_failures"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# 10. `hub sync` tail pass — fail-open on every exit path (design §7)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def sync_env(tmp_data_home, outside, monkeypatch):
    import harnesses as _harnesses

    fake_home = outside / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed(tmp_data_home)
    return tmp_data_home


def _enable_backup(data_home: Path, dest: Path, remote=None) -> None:
    registry = _reg(data_home)
    cfg = backup.load_backup_config(registry)
    cfg["dir"] = str(dest)
    cfg["enabled"] = True
    if remote is not None:
        cfg["remote"] = str(remote)
    backup.save_backup_config(registry, cfg)
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    backup.git_init(dest)


def test_sync_tail_takes_a_snapshot(sync_env, outside, capsys):
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    out = _plain(capsys.readouterr().out)
    assert "Backup:" in out
    assert backup.git_last_commit(dest) is not None

    report = json.loads((sync_env / "state" / "sync-report.json").read_text())
    assert report["schema_version"] == 1, "adding `backup` must not bump the schema"
    assert report["global"]["backup"]["ran"] is True
    assert report["global"]["backup"]["committed"] is True


def test_sync_tail_is_fail_open_when_the_backup_explodes(sync_env, outside, monkeypatch, capsys):
    dest = outside / "bk"
    _enable_backup(sync_env, dest)

    def _explode(*a, **kw):
        raise RuntimeError("github is on fire")

    monkeypatch.setattr(backup, "run_backup", _explode)
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    out = _plain(capsys.readouterr().out)
    assert "backup skipped: github is on fire" in out
    assert "sync complete" in out


def test_sync_tail_is_fail_open_when_git_hangs(sync_env, outside, monkeypatch, capsys):
    dest = outside / "bk"
    _enable_backup(sync_env, dest)

    def _hang(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="git", timeout=backup.NETWORK_TIMEOUT)

    monkeypatch.setattr(backup.subprocess, "run", _hang)
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    out = _plain(capsys.readouterr().out)
    assert "timed out" in out, "a hung git must surface, not hang the sync"
    assert "sync complete" in out, "and it must NOT fail the sync"


def test_sync_tail_runs_even_when_the_body_exits(sync_env, outside, monkeypatch, capsys):
    """The v1 tail placement was unreachable exactly when config changed."""
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    monkeypatch.setattr(hub, "_run_doctor_rollup", lambda *a, **kw: 2)

    with pytest.raises(SystemExit):
        hub.cmd_sync(_ns(skip_remotes=True))
    assert "Backup:" in _plain(capsys.readouterr().out)
    assert backup.git_last_commit(dest) is not None


def test_sync_skip_backup_flag(sync_env, outside, capsys):
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True, skip_backup=True))
    assert "skipped (--skip-backup)" in _plain(capsys.readouterr().out)
    assert backup.git_last_commit(dest) is None


def test_auto_sync_commits_locally_but_defers_the_push(sync_env, outside, monkeypatch, capsys):
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    seen = {}

    real = backup.run_backup
    monkeypatch.setattr(
        backup, "run_backup",
        lambda registry, **kw: seen.update(kw) or real(registry, **kw),
    )
    hub._auto_sync()
    assert seen["push"] is False
    assert "push deferred" in _plain(capsys.readouterr().out)


def test_backup_pass_is_a_no_op_when_disabled_or_uninitialized(sync_env, capsys):
    # No `backup:` block at all — a user who never ran `hub backup init` must
    # not be told on every single sync that a feature they never asked for is
    # "disabled". Silent in the human output, still stamped in the report.
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    out = _plain(capsys.readouterr().out)
    assert "Backup:" not in out
    report = json.loads((sync_env / "state" / "sync-report.json").read_text())
    assert report["global"]["backup"]["skipped"] == "not-configured"

    # A block that EXISTS but is switched off does say so — that is a state the
    # user chose, and its absence would read as a silent failure.
    registry = _reg(sync_env)
    backup.save_backup_config(registry, dict(backup.default_backup_config(), enabled=False))
    (sync_env / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    assert "Backup: disabled" in _plain(capsys.readouterr().out)

    registry = _reg(sync_env)
    backup.save_backup_config(registry, dict(backup.default_backup_config(), enabled=True))
    (sync_env / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    assert "not initialized" in _plain(capsys.readouterr().out)


def test_consecutive_push_failures_are_counted_and_reset(sync_env, outside, monkeypatch, capsys):
    """Through the WIRING: a failing push must land in the registry block.

    The counter is what the doctor and the StatusBar read, and nothing else
    writes it — so the thing worth pinning is that a real `hub sync` with a
    failing push persists it, and that a success clears it.
    """
    dest = outside / "bk"
    bare = outside / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", "-b", "main", str(bare)], check=True)
    _enable_backup(sync_env, dest, remote=bare)
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "local", "user": None})

    outcome = {"pushed": False, "conflict": False, "detail": "github said no"}
    monkeypatch.setattr(backup, "git_push", lambda *a, **kw: dict(outcome))

    sync_args = _ns(skip_remotes=True, skip_permissions=True, skip_hooks=True)
    for expected in (1, 2):
        _seed_skill(sync_env, "skill-{0}".format(expected))  # re-arm the fingerprint
        hub.cmd_sync(sync_args)
        block = _reg(sync_env)["backup"]
        assert block["push_failures"] == expected, _plain(capsys.readouterr().out)
        assert block["last_push_error"] == "github said no"

    outcome.update(pushed=True, detail="pushed")
    _seed_skill(sync_env, "skill-3")
    hub.cmd_sync(sync_args)
    block = _reg(sync_env)["backup"]
    assert block["push_failures"] == 0, "a success must clear the run"
    assert block["last_push_error"] is None


def test_a_refused_snapshot_is_reported_as_a_secret_leak(sync_env, outside, monkeypatch, capsys):
    """Fail-closed must not read as fail-silent (audit fix F6).

    A `SecretLeakError` used to fall into the tail's broad `except` and degrade
    to one yellow "backup skipped" line, indistinguishable from a flaky network.
    """
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    (sync_env / "skills" / "brainstorm" / "LEAK.md").write_text(
        "aws: AKIAIOSFODNN7EXAMPLE\n"
    )

    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    out = _plain(capsys.readouterr().out)
    assert "backup REFUSED (secret_leak)" in out
    assert "sync complete" in out, "a refusal still must not break sync"
    assert backup.git_last_commit(dest) is None

    slot = json.loads((sync_env / "state" / "sync-report.json").read_text())["global"]["backup"]
    assert slot["error_kind"] == "secret_leak"
    assert "LEAK.md" in slot["error"]
    assert slot["committed"] is False

    block = _reg(sync_env)["backup"]
    assert block["last_push_error"].startswith("secret_leak: ")


def test_the_data_home_lock_is_released_before_the_push(sync_env, outside, monkeypatch):
    """Holding the lock across a network push blocks every other hub process."""
    dest = outside / "bk"
    _enable_backup(sync_env, dest, remote=outside / "origin.git")
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "local", "user": None})
    depth: dict = {}

    real_assemble = backup.assemble_snapshot

    def _assemble(*a, **kw):
        depth["assemble"] = hub._LOCK_DEPTH
        return real_assemble(*a, **kw)

    monkeypatch.setattr(backup, "assemble_snapshot", _assemble)
    monkeypatch.setattr(
        backup, "git_push",
        lambda *a, **kw: depth.update(push=hub._LOCK_DEPTH) or {
            "pushed": True, "conflict": False, "detail": "ok"},
    )
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    assert depth["assemble"] > 0, "assembly must be locked against a concurrent mutation"
    assert depth["push"] == 0, "the push must NOT hold the data-home lock"


def test_unchanged_content_produces_a_byte_identical_snapshot(wired):
    """Regression: `manifest.json`'s `created_at` used to change every run, so
    every sync produced a manifest-only diff and a noise commit."""
    data_home, dest = wired
    registry = _reg(data_home)

    backup.run_backup(registry, push=False, force=True, data_home=data_home)
    first = (dest / "manifest.json").read_text()

    import time

    time.sleep(1.1)  # cross a whole-second boundary — the old bug's trigger
    backup.run_backup(registry, push=False, force=True, data_home=data_home)
    assert (dest / "manifest.json").read_text() == first
    assert backup.git_is_dirty(dest) is False

    # A real change still stamps a fresh manifest.
    _seed_skill(data_home, "another")
    backup.run_backup(registry, push=False, force=True, data_home=data_home)
    assert (dest / "manifest.json").read_text() != first


def test_backup_block_never_travels_in_the_snapshot(tmp_data_home, outside):
    """The `backup:` block is machine-local — an absolute dir, a gh login, push
    counters. Carrying it would also let a restored machine push over the very
    snapshot it restored from."""
    _seed(tmp_data_home)
    registry = _reg(tmp_data_home)
    backup.save_backup_config(registry, dict(
        backup.default_backup_config(),
        dir=str(outside / "bk"), gh_login="SomeAccount", enabled=True,
    ))
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    backup.assemble_snapshot(outside / "snap", data_home=tmp_data_home)
    portable = yaml.safe_load((outside / "snap" / "registry.yaml").read_text())
    assert "backup" not in portable
    assert "SomeAccount" not in (outside / "snap" / "registry.yaml").read_text()


# ─────────────────────────────────────────────────────────────────────────────
# 12. Recovery + cost: an interrupted snapshot, the auto-sync path, parked tips
# ─────────────────────────────────────────────────────────────────────────────


def test_an_interrupted_snapshot_self_heals_instead_of_bricking_the_dir(wired):
    """PB1: `assemble_snapshot` prunes `manifest.json` FIRST and rewrites it LAST.

    A ^C / crash / closed lid in between leaves a repo whose COMMITS carry a
    manifest while its WORKING TREE does not. `validate_backup_dir` judged that
    by the working tree alone, so it read "commits but no Skill Tree
    manifest.json" — a permanent refusal, from every entry point including
    `hub backup init`. One interrupt bricked the backup dir for good.
    """
    data_home, dest = wired
    registry = _reg(data_home)
    assert backup.run_backup(registry, push=False, force=True, data_home=data_home)[
        "committed"
    ] is True

    # Exactly what the interrupt leaves behind: pruned, nothing rewritten.
    for entry in ("manifest.json", "manifest.sig", "skills", "registry.yaml"):
        backup._rm(dest / entry)
    assert not (dest / backup.MANIFEST_FILE).exists()
    assert backup.git_last_commit(dest) is not None

    # HEAD is the durable statement of whose repo this is.
    assert backup.ref_has_manifest(dest, "HEAD") is True
    backup.validate_backup_dir(dest, data_home=data_home)  # must not raise

    _seed_skill(data_home, "added-after-the-crash")
    result = backup.run_backup(registry, push=False, force=True, data_home=data_home)
    assert result["ok"] is True
    assert result["committed"] is True, "the recovery run must produce a commit"
    assert any("interrupted snapshot" in w for w in result["warnings"]), result["warnings"]

    # The tree is whole again, and nothing was left half-pruned in the commit.
    assert (dest / backup.MANIFEST_FILE).is_file()
    assert (dest / "registry.yaml").is_file()
    assert (dest / "skills" / "brainstorm" / "SKILL.md").is_file()
    assert (dest / "skills" / "added-after-the-crash" / "SKILL.md").is_file()
    assert backup.git_is_dirty(dest) is False


def test_a_foreign_repo_without_a_manifest_at_head_is_still_refused(tmp_data_home, outside):
    """The PB1 relaxation must not become a way into somebody else's repo."""
    _seed(tmp_data_home)
    stranger = outside / "stranger"
    stranger.mkdir()
    backup.git_init(stranger)
    (stranger / "notes.md").write_text("mine\n")
    backup.git_commit(stranger, "not a skill tree backup")

    with pytest.raises(backup.BackupError) as exc:
        backup.validate_backup_dir(stranger, data_home=tmp_data_home)
    assert "no Skill Tree manifest.json" in str(exc.value)
    assert backup.heal_working_tree(stranger) is None


def test_auto_sync_costs_nothing_and_dials_nothing_when_nothing_changed(
    sync_env, outside, monkeypatch
):
    """PM3: `_auto_sync` fires on EVERY registry mutation (one equip = one sync).

    Two things had to hold and neither did: the dirty gate must actually fire
    (the audit ledger grows on every mutation, so including it in the
    fingerprint meant the gate NEVER fired), and no network call may sit on the
    path (the remote-tip fetch was gated on a configured remote, not on whether
    a push was going to happen).
    """
    dest = outside / "bk"
    _enable_backup(sync_env, dest, remote="https://example.invalid/nope.git")

    calls: list = []
    real_git = backup.git

    def _recording_git(repo_dir, *args, **kw):
        calls.append(list(args))
        return real_git(repo_dir, *args, **kw)

    monkeypatch.setattr(backup, "git", _recording_git)

    hub._auto_sync()
    assert any("commit" in a for a in calls), "the first auto-sync must commit"

    # A mutation happened — the audit ledger grew — but nothing a snapshot
    # carries actually changed.
    (sync_env / "state").mkdir(parents=True, exist_ok=True)
    with open(sync_env / "state" / "audit.jsonl", "a") as handle:
        handle.write(json.dumps({"op": "enable", "at": "now"}) + "\n")

    calls.clear()
    monkeypatch.setattr(
        backup,
        "assemble_snapshot",
        lambda *a, **kw: pytest.fail("an unchanged auto-sync must not re-assemble"),
    )
    hub._auto_sync()

    assert not any("commit" in a for a in calls), "no noise commit"
    assert not any(
        verb in a for a in calls for verb in ("fetch", "ls-remote", "push")
    ), ("no auto-sync may dial the network: " + repr(calls))


def test_an_explicit_sync_still_commits_the_audit_ledger(sync_env, outside):
    """The other half of PM3(b): excluded from the FINGERPRINT, not from the SNAPSHOT."""
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))
    first = backup.git_last_commit(dest)["sha"]

    (sync_env / "state").mkdir(parents=True, exist_ok=True)
    (sync_env / "state" / "audit.jsonl").write_text(
        json.dumps({"op": "enable", "skill": "brainstorm"}) + "\n"
    )
    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=True, skip_hooks=True))

    assert backup.git_last_commit(dest)["sha"] != first, (
        "an explicit sync runs with force=True, so the ledger reaches a commit"
    )
    hostname = backup.safe_hostname()
    assert (dest / "audit" / (hostname + ".jsonl")).is_file()
    assert "brainstorm" in (dest / "audit" / (hostname + ".jsonl")).read_text()


def _bare_remote(outside: Path, name: str) -> Path:
    bare = outside / name
    subprocess.run(["git", "init", "--bare", "-q", "-b", "main", str(bare)], check=True)
    return bare


def test_plain_local_ahead_never_parks_a_ref_or_cries_divergence(
    tmp_data_home, outside, monkeypatch
):
    """PM4: an unpushed auto-sync commit is NOT the remote 'moving on'.

    `_save_local_tip` fired on any non-empty `origin/<branch>..HEAD`, which is
    the ordinary state of every machine that has auto-synced since its last
    push. Each such run left a PERMANENT ref behind and warned that "the remote
    had moved on" when it demonstrably had not.
    """
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "local", "user": None})
    bare = _bare_remote(outside, "origin.git")
    dest = outside / "repo"

    _seed(tmp_data_home)
    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg.update(dir=str(dest), remote=str(bare), enabled=True)
    backup.save_backup_config(registry, cfg)

    assert backup.run_backup(
        registry, push=True, force=True, data_home=tmp_data_home
    )["pushed"] is True

    # Two offline (auto-sync style) commits — local-ahead, remote untouched.
    for i in range(2):
        _seed_skill(tmp_data_home, "offline-{0}".format(i))
        backup.run_backup(registry, push=False, force=True, data_home=tmp_data_home)
    assert backup.parked_local_tips(dest) == []

    result = backup.run_backup(registry, push=True, force=True, data_home=tmp_data_home)
    assert result["pushed"] is True
    assert "saved_ref" not in result, result
    assert not any("moved on" in w for w in result["warnings"]), result["warnings"]
    assert backup.parked_local_tips(dest) == [], "no ref may accumulate per unpushed run"


def test_a_genuine_divergence_parks_exactly_one_ref_and_says_so(
    tmp_data_home, outside, monkeypatch
):
    """The case the parking exists for: the remote ALSO moved, so the reset drops work."""
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "local", "user": None})
    bare = _bare_remote(outside, "origin.git")
    dest = outside / "repo"
    other_home = outside / "other-data-home"
    other_home.mkdir()
    other_repo = outside / "other-repo"

    _seed(tmp_data_home)
    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg.update(dir=str(dest), remote=str(bare), enabled=True)
    backup.save_backup_config(registry, cfg)
    backup.run_backup(registry, push=True, force=True, data_home=tmp_data_home)

    # This machine commits offline…
    _seed_skill(tmp_data_home, "only-here")
    backup.run_backup(registry, push=False, force=True, data_home=tmp_data_home)
    local_tip = backup.git_last_commit(dest)["sha"]

    # …while ANOTHER machine advances the remote.
    _seed(other_home, skills=("only-there",))
    other_reg = yaml.safe_load((other_home / "registry.yaml").read_text())
    other_cfg = backup.load_backup_config(other_reg)
    other_cfg.update(dir=str(other_repo), remote=str(bare), enabled=True)
    backup.save_backup_config(other_reg, other_cfg)
    assert backup.run_backup(
        other_reg, push=True, force=True, data_home=other_home
    )["pushed"] is True

    result = backup.run_backup(registry, push=True, force=True, data_home=tmp_data_home)
    saved = result.get("saved_ref")
    assert saved and saved.startswith("refs/backup/local-"), result
    assert _git_out(dest, "rev-parse", saved) == local_tip
    assert any("moved on" in w for w in result["warnings"]), result["warnings"]
    assert backup.parked_local_tips(dest) == [saved], "exactly one, not one per run"


def test_parked_tips_are_pruned_once_a_push_has_superseded_them(tmp_path):
    """The cap: a parked ref is a recovery aid, never an archive."""
    repo = tmp_path / "repo"
    backup.git_init(repo)
    (repo / "a.txt").write_text("a\n")
    backup.git_commit(repo, "one")
    head = backup.git_last_commit(repo)["sha"]
    for stamp in ("20260101T000000Z", "20260102T000000Z", "20260103T000000Z"):
        backup.git(repo, "update-ref", "refs/backup/local-" + stamp, head)
    assert len(backup.parked_local_tips(repo)) == 3

    keeper = "refs/backup/local-20260103T000000Z"
    pruned = backup.prune_local_tip_refs(repo, keep=0, exclude=[keeper])
    assert sorted(pruned) == [
        "refs/backup/local-20260101T000000Z",
        "refs/backup/local-20260102T000000Z",
    ]
    assert backup.parked_local_tips(repo) == [keeper], (
        "the ref this run reports must survive the same run's prune"
    )


def test_a_failed_reset_is_reported_instead_of_silently_leaving_the_old_tip(
    tmp_data_home, outside, monkeypatch
):
    """m4: the `reset --hard` result was discarded, so a failure looked like success."""
    monkeypatch.setattr(backup, "probe_ssh", lambda timeout=10: {
        "method": "ssh", "available": True, "detail": "local", "user": None})
    bare = _bare_remote(outside, "origin.git")
    dest = outside / "repo"
    _seed(tmp_data_home)
    registry = _reg(tmp_data_home)
    cfg = backup.load_backup_config(registry)
    cfg.update(dir=str(dest), remote=str(bare), enabled=True)
    backup.save_backup_config(registry, cfg)
    backup.run_backup(registry, push=True, force=True, data_home=tmp_data_home)

    real_git = backup.git

    def _fail_reset(repo_dir, *args, **kw):
        if args[:1] == ("reset",):
            return _fake_proc(1, stderr="fatal: could not reset\n")
        return real_git(repo_dir, *args, **kw)

    monkeypatch.setattr(backup, "git", _fail_reset)
    verdict = backup.git_adopt_remote_tip(dest, "main")
    assert verdict["adopted"] is False
    assert verdict.get("warn") is True
    assert "could not reset" in verdict["detail"]


# ─────────────────────────────────────────────────────────────────────────────
# 13. Byte-stability defences: `.gitattributes`, manifest reuse
# ─────────────────────────────────────────────────────────────────────────────


def test_gitattributes_pins_the_bytes_and_stays_out_of_the_digest(tmp_data_home, outside):
    """PM7: `core.autocrlf` on a Windows checkout would rewrite every file's bytes
    underneath the per-file sha256 the manifest records."""
    _seed(tmp_data_home)
    dest = outside / "snap"
    summary = backup.assemble_snapshot(dest, data_home=tmp_data_home)

    attributes = dest / backup.GITATTRIBUTES_FILE
    assert attributes.is_file()
    assert "* -text" in attributes.read_text()

    files, digest = backup.compute_tree_digest(dest)
    assert backup.GITATTRIBUTES_FILE not in files
    assert backup.GITATTRIBUTES_FILE not in summary["manifest"]["files"]
    assert backup.GITATTRIBUTES_FILE in backup.DIGEST_EXCLUDED
    assert backup.GITATTRIBUTES_FILE in backup.SNAPSHOT_OWNED
    assert digest == summary["manifest"]["tree_digest"]

    # The round trip still verifies, with the file present.
    assert backup.verify_tree_digest(dest)["ok"] is True
    assert backup.verify_snapshot_signature(dest)["state"] == backup.SIG_SIGNED


def test_a_reused_manifest_refreshes_the_fields_that_describe_this_machine(
    wired, monkeypatch
):
    """m3: identical CONTENT says nothing about which host wrote it.

    A stale `prefixes` would make restore remap from the wrong machine, and a
    stale `signing.pubkey` would name a key the re-signed `manifest.sig` was not
    made with — a snapshot that fails its own verification.
    """
    data_home, dest = wired
    registry = _reg(data_home)
    backup.run_backup(registry, push=False, force=True, data_home=data_home)
    first = json.loads((dest / "manifest.json").read_text())

    monkeypatch.setattr(backup, "safe_hostname", lambda: "renamed-laptop")
    backup.run_backup(registry, push=False, force=True, data_home=data_home)
    second = json.loads((dest / "manifest.json").read_text())

    assert second["tree_digest"] == first["tree_digest"], "content is unchanged"
    assert second["created_at"] == first["created_at"], "capture time is content's"
    assert second["hostname"] == "renamed-laptop"
    assert second["prefixes"]["data_home"] == str(data_home)
    # …and the snapshot still verifies against the key its manifest NAMES.
    assert backup.verify_snapshot_signature(dest)["state"] == backup.SIG_SIGNED


def test_a_content_free_registry_rewrite_does_not_re_arm_the_fingerprint(wired):
    """The registry is hashed for real precisely so its mtime cannot matter —
    but it was ALSO stat-walked, which put `mtime_ns` straight back in."""
    data_home, dest = wired
    registry = _reg(data_home)
    backup.run_backup(registry, push=False, force=True, data_home=data_home)
    before = backup.snapshot_fingerprint(data_home)

    path = data_home / "registry.yaml"
    body = path.read_text()
    import time

    time.sleep(0.01)
    path.write_text(body)  # identical bytes, brand-new mtime
    assert backup.snapshot_fingerprint(data_home) == before

    path.write_text(body + "\n# a real change\n")
    assert backup.snapshot_fingerprint(data_home) != before


# ─────────────────────────────────────────────────────────────────────────────
# 14. Embedded machine paths inside transform-owned fields (PM2)
# ─────────────────────────────────────────────────────────────────────────────


def test_an_embedded_machine_path_is_tokenized_and_round_trips():
    """A declared field legitimately holds a string that only EMBEDS a path.

    The transform rewrote LEADING prefixes only, while the gate looked for the
    prefix ANYWHERE — so `--data-dir=/Users/alice/…` in an MCP arg raised
    `PrefixLeakError` on every future snapshot, with no escape hatch and no way
    for the user to know what to edit.
    """
    data_home = Path("/Users/alice/.skill-hub")
    home = Path("/Users/alice")
    registry = {
        "skills": {
            "notes": {
                "mcp": {
                    "args": [
                        "/Users/alice/.skill-hub/mcp-servers/notes/server.py",
                        "--data-dir=/Users/alice/.skill-hub/notes-data",
                        "--log=/Users/alice/logs/notes.log",
                        "--port=8080",
                    ]
                }
            }
        }
    }
    portable = backup.to_portable(registry, data_home=data_home, home=home)
    args = portable["skills"]["notes"]["mcp"]["args"]
    assert args[0] == "{DATA_HOME}/mcp-servers/notes/server.py"
    assert args[1] == "--data-dir={DATA_HOME}/notes-data"
    assert args[2] == "--log={HOME}/logs/notes.log"
    assert args[3] == "--port=8080", "non-path values still survive verbatim"

    # The gate that used to reject this now passes…
    prefixes = [str(data_home), str(home)]
    assert backup.assert_transform_applied(portable, prefixes) == []

    # …and the reverse is exact, on a DIFFERENT machine.
    other_home = Path("/Users/bob")
    other_dh = Path("/Users/bob/.skill-hub")
    back = backup.from_portable(
        portable, data_home=other_dh, home=other_home, collapse=False
    )
    assert back["skills"]["notes"]["mcp"]["args"] == [
        "/Users/bob/.skill-hub/mcp-servers/notes/server.py",
        "--data-dir=/Users/bob/.skill-hub/notes-data",
        "--log=/Users/bob/logs/notes.log",
        "--port=8080",
    ]
    # Token-space round trip: re-tokenizing on B reproduces the portable form.
    assert (
        backup.to_portable(back, data_home=other_dh, home=other_home)["skills"]["notes"]
        == portable["skills"]["notes"]
    )


def test_the_longest_prefix_wins_for_an_embedded_path():
    """A data home nested under `$HOME` must not be bitten in half by `{HOME}`."""
    portable = backup.to_portable(
        {"skills": {"s": {"mcp": {"args": ["--d=/Users/alice/.skill-hub/x"]}}}},
        data_home=Path("/Users/alice/.skill-hub"),
        home=Path("/Users/alice"),
    )
    assert portable["skills"]["s"]["mcp"]["args"] == ["--d={DATA_HOME}/x"]


def test_a_prefix_no_rule_could_rewrite_is_advisory_not_a_hard_refusal(
    tmp_data_home, outside
):
    """PM2(b): `projects.*.path` may only ever become `{HOME}`.

    A code-home path embedded there is something NO rule could have rewritten,
    so hard-failing would brick every future backup over a value the user cannot
    fix. It is reported instead — the same soft treatment file content gets.
    """
    code_home = outside / "code"
    code_home.mkdir()
    registry = {"projects": {"p": {"path": "/elsewhere" + str(code_home) + "/checkout"}}}
    prefixes = [str(tmp_data_home), str(Path.home()), str(code_home)]
    rules = backup.machine_prefixes(tmp_data_home, code_home, Path.home())

    advisory = backup.assert_transform_applied(registry, prefixes, rules)
    assert advisory and "no transform rule owns" in advisory[0]

    # Without the rules the gate stays strict — that is the unit-level contract.
    with pytest.raises(backup.PrefixLeakError):
        backup.assert_transform_applied(registry, prefixes)

    # A rewritable prefix in the SAME field is still a hard refusal.
    leaking = {"projects": {"p": {"path": str(Path.home()) + "/proj"}}}
    with pytest.raises(backup.PrefixLeakError):
        backup.assert_transform_applied(leaking, prefixes, rules)


# ─────────────────────────────────────────────────────────────────────────────
# 15. Doctor findings for a backup that has quietly stopped working (D3)
# ─────────────────────────────────────────────────────────────────────────────


def test_no_backup_block_produces_no_backup_findings():
    import risks

    assert risks.detect_backup_risks(None) == []
    assert risks.detect_backup_risks({}) == []


def test_repeated_push_failures_raise_backup_stale():
    import risks

    findings = risks.detect_backup_risks(
        dict(backup.default_backup_config(), push_failures=3,
             last_push_error="Could not resolve host: github.com")
    )
    codes = [f.code for f in findings]
    assert "BACKUP_STALE" in codes
    assert "BACKUP_AUTH_EXPIRED" not in codes, "a network failure is not an auth failure"
    assert all(f.severity != "danger" for f in findings), (
        "a stale backup must not fail `hub sync` — fail-open is the whole design"
    )

    # Below the threshold nothing fires: one flaky push is not an outage.
    assert risks.detect_backup_risks(
        dict(backup.default_backup_config(), push_failures=1,
             last_push_error="Could not resolve host: github.com")
    ) == []


def test_an_auth_shaped_push_error_raises_backup_auth_expired():
    import risks

    for message in (
        "remote: Invalid username or password",
        "fatal: Authentication failed for 'https://github.com/x/y.git'",
        "git@github.com: Permission denied (publickey).",
        "no usable GitHub credential (see `hub backup auth`)",
    ):
        codes = [
            f.code
            for f in risks.detect_backup_risks(
                dict(backup.default_backup_config(), push_failures=1,
                     last_push_error=message)
            )
        ]
        assert "BACKUP_AUTH_EXPIRED" in codes, message


def test_an_aged_pending_reconcile_raises_backup_stale():
    import datetime as _dt
    import risks

    fresh = (_dt.datetime.now(tz=_dt.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert risks.detect_backup_risks(
        dict(backup.default_backup_config(), pending_reconcile=True,
             pending_reconcile_at=fresh)
    ) == [], "a restore an hour ago is a state, not an outage"

    old = (
        _dt.datetime.now(tz=_dt.timezone.utc) - _dt.timedelta(days=30)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    findings = risks.detect_backup_risks(
        dict(backup.default_backup_config(), pending_reconcile=True,
             pending_reconcile_at=old)
    )
    assert [f.code for f in findings] == ["BACKUP_STALE"]
    assert "holding every push" in findings[0].detail

    # An UNDATED hold (written before the stamp existed) still surfaces.
    assert [
        f.code
        for f in risks.detect_backup_risks(
            dict(backup.default_backup_config(), pending_reconcile=True)
        )
    ] == ["BACKUP_STALE"]


def test_the_new_codes_are_in_the_schema_the_ui_mirrors():
    import risks

    codes = {row["code"] for row in risks.emit_schema()}
    assert {"BACKUP_STALE", "BACKUP_AUTH_EXPIRED"} <= codes


def test_the_sync_doctor_surfaces_a_stale_backup(sync_env, outside, capsys):
    """Through the WIRING: fail-open must not mean fail-silent."""
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    registry = _reg(sync_env)
    cfg = backup.load_backup_config(registry)
    cfg.update(push_failures=5, last_push_error="fatal: Authentication failed")
    backup.save_backup_config(registry, cfg)
    (sync_env / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    hub.cmd_sync(_ns(skip_remotes=True, skip_permissions=False, skip_hooks=True))
    out = _plain(capsys.readouterr().out)
    assert "backup BACKUP_STALE" in out
    assert "backup BACKUP_AUTH_EXPIRED" in out


def test_the_permissions_doctor_command_surfaces_it_too(sync_env, outside, capsys):
    dest = outside / "bk"
    _enable_backup(sync_env, dest)
    registry = _reg(sync_env)
    cfg = backup.load_backup_config(registry)
    cfg.update(push_failures=4, last_push_error="Could not resolve host: github.com")
    backup.save_backup_config(registry, cfg)
    (sync_env / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    hub.cmd_permissions_doctor(_ns(json=True))
    payload = json.loads(capsys.readouterr().out)
    codes = {f["code"] for f in payload["findings"]}
    assert "BACKUP_STALE" in codes
    assert payload["danger_count"] == 0
