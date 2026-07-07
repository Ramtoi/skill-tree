"""Wave 0 framework tests for the remote-connectors change.

Covers: drift truth table (all 6 states), sidecar round-trip + missing/corrupt →
empty, `migrate_remotes_schema` idempotency, `get_connector`/registry,
agentskills layout sha-stability, yaml_mcp merge-preserving, the SSH wrapper with
a MOCK runner (hardened flags, atomic temp+mv, host-key mismatch), and keychain
fail-closed when `keyring` is missing.
"""

from __future__ import annotations

import builtins
import json

import pytest

from connectors import (
    Action,
    Capability,
    DriftStatus,
    REMOTE_CONNECTORS,
    get_connector,
    register_connector,
)
from connectors import drift
from connectors import sidecar
from connectors.layouts import agentskills, yaml_mcp
from connectors.transport import keychain
from connectors.transport import ssh
from connectors.transport.ssh import HostKeyMismatch, RunResult, SshTransport


# ─────────────────────────────────────────────────────────────────────────────
# drift.classify — the 6-state truth table
# ─────────────────────────────────────────────────────────────────────────────


def test_drift_in_sync():
    assert drift.classify("A", "A", "A") == DriftStatus.IN_SYNC


def test_drift_local_ahead():
    # remote == base, local changed
    assert drift.classify("A", "A", "B") == DriftStatus.LOCAL_AHEAD


def test_drift_remote_drifted():
    # local == base, remote changed
    assert drift.classify("A", "B", "A") == DriftStatus.REMOTE_DRIFTED


def test_drift_conflict():
    # both changed and remote != local
    assert drift.classify("A", "B", "C") == DriftStatus.CONFLICT


def test_drift_orphaned():
    # local removed, still present remotely
    assert drift.classify("A", "A", None) == DriftStatus.ORPHANED


def test_drift_missing():
    # present locally, gone remotely
    assert drift.classify("A", None, "A") == DriftStatus.MISSING


def test_drift_both_changed_but_converged_is_in_sync():
    # both moved off base to the SAME content → not a conflict
    assert drift.classify("A", "Z", "Z") == DriftStatus.IN_SYNC


def test_drift_gone_both_sides():
    assert drift.classify("A", None, None) == DriftStatus.IN_SYNC


# ─────────────────────────────────────────────────────────────────────────────
# sidecar round-trip + missing/corrupt → empty
# ─────────────────────────────────────────────────────────────────────────────


def test_sidecar_round_trip(tmp_data_home):
    sc = sidecar.read_sidecar("hermes-main", "skills")
    assert sc.artifacts == []
    sc.record("brainstorm", "skill", "sha-1")
    sc.record("grill", "skill", "sha-2")
    sidecar.write_sidecar(sc)

    back = sidecar.read_sidecar("hermes-main", "skills")
    assert back.managed_names() == {"brainstorm", "grill"}
    assert back.base_sha("brainstorm") == "sha-1"
    assert back.is_managed("grill")
    assert back.base_sha("absent") is None


def test_sidecar_record_updates_and_forget(tmp_data_home):
    sc = sidecar.read_sidecar("r", "skills")
    sc.record("x", "skill", "old")
    sc.record("x", "skill", "new")  # update in place, no dup
    assert len(sc.artifacts) == 1
    assert sc.base_sha("x") == "new"
    assert sc.forget("x") is True
    assert sc.forget("x") is False


def test_sidecar_missing_is_empty(tmp_data_home):
    sc = sidecar.read_sidecar("never-written", "skills")
    assert sc.artifacts == []
    assert sc.managed_names() == set()


def test_sidecar_corrupt_is_empty_never_raises(tmp_data_home):
    sc = sidecar.RemoteSidecar(remote="r", surface="skills")
    sc.record("a", "skill", "s")
    path = sidecar.write_sidecar(sc)
    path.write_text("{ this is not valid json ")
    # Must NOT raise; reads as empty so cleanup is a no-op.
    back = sidecar.read_sidecar("r", "skills")
    assert back.artifacts == []


def test_sidecar_path_under_state(tmp_data_home):
    p = sidecar.sidecar_path("hermes-main", "skills")
    assert p.parent.name == "remote_hermes-main"
    assert p.name == "skills.managed.json"
    assert str(tmp_data_home) in str(p)


# ─────────────────────────────────────────────────────────────────────────────
# migrate_remotes_schema idempotency
# ─────────────────────────────────────────────────────────────────────────────


def test_migrate_remotes_schema_adds_block():
    import remotes

    reg = {"projects": {"p": {"path": "/x"}}, "skills": {}}
    assert remotes.migrate_remotes_schema(reg) is True
    assert reg["remotes"] == {}
    # existing keys untouched
    assert reg["projects"] == {"p": {"path": "/x"}}


def test_migrate_remotes_schema_idempotent():
    import remotes

    reg = {
        "remotes": {
            "hermes-main": {"connector": "hermes", "sync_enabled": True}
        }
    }
    snapshot = json.dumps(reg, sort_keys=True)
    assert remotes.migrate_remotes_schema(reg) is False  # second run = no-op
    assert json.dumps(reg, sort_keys=True) == snapshot  # entries untouched


def test_load_remotes_parses_target():
    import remotes

    reg = {
        "remotes": {
            "hermes-main": {
                "connector": "hermes",
                "transport": {
                    "ssh_host": "hermes@moon-base",
                    "host_key_sha256": "SHA256:abc",
                    "home": "~/.hermes",
                },
                "secret_ref": "skill-hub:hermes-main",
                "sync_enabled": False,
                "bundles": ["research"],
                "enabled": ["brainstorm", "grill"],
            }
        }
    }
    targets = remotes.load_remotes(reg)
    t = targets["hermes-main"]
    assert t.connector == "hermes"
    assert t.ssh_host == "hermes@moon-base"
    assert t.host_key_sha256 == "SHA256:abc"
    assert t.home == "~/.hermes"
    assert t.secret_ref == "skill-hub:hermes-main"
    assert t.sync_enabled is False
    assert t.bundles == ("research",)
    assert t.enabled == ("brainstorm", "grill")


def test_remote_target_round_trip_has_no_secret_bytes():
    import remotes

    data = {
        "connector": "hermes",
        "transport": {"ssh_host": "hermes@box"},
        "secret_ref": "skill-hub:r",
        "host_key_sha256": "SHA256:xyz",
        "sync_enabled": True,
        "bundles": [],
        "enabled": [],
    }
    t = remotes.RemoteTarget.from_dict("r", data)
    out = t.to_dict()
    # Only references — no field carries a credential value.
    assert "secret_ref" in out and out["secret_ref"] == "skill-hub:r"
    assert "host_key_sha256" in out
    blob = json.dumps(out)
    assert "PRIVATE KEY" not in blob


def test_resolve_remote_skills_reuses_project_semantics():
    import remotes

    reg = {
        "bundles": {
            "research": {"skills": ["a", "b"], "scope": "project-specific"},
        },
        "skills": {},
    }
    remote_cfg = {"bundles": ["research"], "enabled": ["c", "a"]}
    resolved = remotes.resolve_remote_skills(remote_cfg, reg)
    # union(bundle) ∪ enabled, dedup, order preserved
    assert resolved == ["a", "b", "c"]


# ─────────────────────────────────────────────────────────────────────────────
# D15 — per-remote opt-in for global-bundle inheritance
# ─────────────────────────────────────────────────────────────────────────────


def _reg_with_global_bundle():
    return {
        "bundles": {
            "globalpack": {"skills": ["brainstorm"], "scope": "global"},
            "research": {"skills": ["a", "b"], "scope": "project-specific"},
        },
        "skills": {},
    }


def test_d15_resolver_excludes_global_bundle_by_default():
    import remotes

    reg = _reg_with_global_bundle()
    # No apply_global_bundles key → default off → NO global-bundle skills, but
    # the remote's own bundle + enabled always apply.
    remote_cfg = {"bundles": ["research"], "enabled": ["c"]}
    assert remotes.resolve_remote_skills(remote_cfg, reg) == ["a", "b", "c"]


def test_d15_resolver_includes_global_bundle_when_opted_in():
    import remotes

    reg = _reg_with_global_bundle()
    remote_cfg = {"bundles": ["research"], "enabled": ["c"], "apply_global_bundles": True}
    # Global-bundle skills lead, then own bundle, then enabled.
    assert remotes.resolve_remote_skills(remote_cfg, reg) == ["brainstorm", "a", "b", "c"]


def test_d15_resolver_own_bundles_apply_with_no_global():
    import remotes

    reg = _reg_with_global_bundle()
    # A remote with ONLY its own bundle (opted out) still gets that bundle.
    remote_cfg = {"bundles": ["research"], "enabled": []}
    assert remotes.resolve_remote_skills(remote_cfg, reg) == ["a", "b"]


def test_d15_migration_default_false_for_existing_remote():
    import remotes

    # An existing remote entry with no apply_global_bundles key.
    t = remotes.RemoteTarget.from_dict("r", {"connector": "hermes"})
    assert t.apply_global_bundles is False
    # Round-trips the key so it surfaces in show/list.
    assert t.to_dict()["apply_global_bundles"] is False


def test_d15_target_carries_flag():
    import remotes

    t = remotes.RemoteTarget.from_dict(
        "r", {"connector": "hermes", "apply_global_bundles": True}
    )
    assert t.apply_global_bundles is True
    assert t.to_dict()["apply_global_bundles"] is True


# ─────────────────────────────────────────────────────────────────────────────
# connector registry
# ─────────────────────────────────────────────────────────────────────────────


def test_hermes_connector_registered():
    # Wave 1 registers the Hermes connector at package import time.
    assert "hermes" in REMOTE_CONNECTORS
    assert get_connector("hermes").key == "hermes"
    assert get_connector("hermes").publishable is True


def test_get_connector_unknown_raises():
    with pytest.raises(KeyError):
        get_connector("does-not-exist")


def test_register_and_resolve_connector():
    from connectors.base import RemoteConnector

    class FakeConnector(RemoteConnector):
        key = "fake-test"
        publishable = True

        def capabilities(self):
            return {Capability.SKILLS}

        def health_check(self, target):
            raise NotImplementedError

        def list_remote_artifacts(self, target, kind):
            raise NotImplementedError

        def fetch_artifact(self, target, ref):
            raise NotImplementedError

        def plan(self, target, desired):
            raise NotImplementedError

        def apply(self, target, plan, *, allow=None):
            raise NotImplementedError

        def pull_artifact(self, target, ref):
            raise NotImplementedError

    inst = FakeConnector()
    try:
        register_connector(inst)
        assert get_connector("fake-test") is inst
        assert get_connector("fake-test").capabilities() == {Capability.SKILLS}
        # duplicate key with a different instance is rejected
        with pytest.raises(ValueError):
            register_connector(FakeConnector())
    finally:
        REMOTE_CONNECTORS.pop("fake-test", None)


# ─────────────────────────────────────────────────────────────────────────────
# agentskills layout sha-stability
# ─────────────────────────────────────────────────────────────────────────────


def test_agentskills_write_read_same_sha(tmp_path):
    src = tmp_path / "src" / "my-skill"
    src.mkdir(parents=True)
    (src / "SKILL.md").write_text("---\nname: my-skill\n---\nbody\n")
    (src / "ref" / "notes.md").parent.mkdir(parents=True)
    (src / "ref" / "notes.md").write_text("notes")

    tree = agentskills.read_skill_dir(src)
    sha_a = agentskills.tree_sha256(tree)

    dest = tmp_path / "dest" / "my-skill"
    dest.mkdir(parents=True)
    agentskills.write_skill_dir(dest, tree)
    sha_b = agentskills.dir_sha256(dest)

    assert sha_a == sha_b


def test_agentskills_sha_changes_with_content(tmp_path):
    d = tmp_path / "s"
    d.mkdir()
    (d / "SKILL.md").write_text("a")
    sha1 = agentskills.dir_sha256(d)
    (d / "SKILL.md").write_text("b")
    sha2 = agentskills.dir_sha256(d)
    assert sha1 != sha2


# ─────────────────────────────────────────────────────────────────────────────
# yaml_mcp merge-preserving
# ─────────────────────────────────────────────────────────────────────────────

_DOC = """\
version: 1
model: gpt-5
mcp_servers:
  existing:
    command: foo
other_section:
  keep: me
"""


def _has_yaml_backend():
    try:
        import yaml  # noqa: F401

        return True
    except Exception:
        try:
            import ruamel.yaml  # noqa: F401

            return True
        except Exception:
            return False


pytestmark_yaml = pytest.mark.skipif(
    not _has_yaml_backend(), reason="no YAML backend (ruamel.yaml/PyYAML) available"
)


@pytestmark_yaml
def test_yaml_mcp_add_key_preserves_others():
    out = yaml_mcp.merge_mcp_servers(_DOC, upserts={"hub-srv": {"command": "bar"}})
    parsed = yaml_mcp.read_mcp_servers(out)
    assert parsed["existing"] == {"command": "foo"}
    assert parsed["hub-srv"] == {"command": "bar"}
    # Sibling top-level keys survive byte-wise in the round-trip.
    assert "model: gpt-5" in out
    assert "other_section" in out and "keep: me" in out


@pytestmark_yaml
def test_yaml_mcp_update_key():
    out = yaml_mcp.merge_mcp_servers(_DOC, upserts={"existing": {"command": "baz"}})
    parsed = yaml_mcp.read_mcp_servers(out)
    assert parsed["existing"] == {"command": "baz"}


@pytestmark_yaml
def test_yaml_mcp_remove_key():
    out = yaml_mcp.merge_mcp_servers(_DOC, removals={"existing"})
    parsed = yaml_mcp.read_mcp_servers(out)
    assert "existing" not in parsed
    assert "model: gpt-5" in out  # unrelated keys untouched


@pytestmark_yaml
def test_yaml_mcp_empty_doc():
    out = yaml_mcp.merge_mcp_servers("", upserts={"a": {"command": "x"}})
    assert yaml_mcp.read_mcp_servers(out) == {"a": {"command": "x"}}


# ─────────────────────────────────────────────────────────────────────────────
# SSH wrapper with a MOCK runner
# ─────────────────────────────────────────────────────────────────────────────


class _RecordingRunner:
    """Mock runner: records argv/input, returns canned results per matcher."""

    def __init__(self):
        self.calls = []
        self._responses = []  # list of (predicate, RunResult)

    def respond(self, predicate, result):
        self._responses.append((predicate, result))

    def __call__(self, argv, *, input=None):
        self.calls.append({"argv": list(argv), "input": input})
        for pred, result in self._responses:
            if pred(argv):
                return result
        return RunResult(returncode=0, stdout="", stderr="")


def test_ssh_hardened_flags_present(tmp_data_home):
    runner = _RecordingRunner()
    runner.respond(lambda a: "cat" in a[-1], RunResult(0, stdout="hello"))
    t = SshTransport("hermes@box", runner=runner)
    data = t.read("/remote/file")
    assert data == b"hello"
    argv = runner.calls[-1]["argv"]
    joined = " ".join(argv)
    assert "StrictHostKeyChecking=yes" in joined
    assert "UserKnownHostsFile=" in joined
    # The hub-owned known_hosts lives under the data home, not ~/.ssh.
    assert str(tmp_data_home) in joined


def test_ssh_atomic_write_does_temp_then_mv(tmp_data_home):
    runner = _RecordingRunner()
    t = SshTransport("hermes@box", runner=runner)
    t.atomic_write("/remote/skill.md", b"payload")
    call = runner.calls[-1]
    remote_cmd = call["argv"][-1]
    assert ".hub-tmp" in remote_cmd
    assert "mv -f" in remote_cmd
    assert call["input"] == b"payload"


def test_ssh_host_key_match_allows(tmp_data_home):
    runner = _RecordingRunner()
    runner.respond(
        lambda a: a[0] == "ssh-keyscan", RunResult(0, stdout="box ssh-ed25519 AAAA")
    )
    runner.respond(
        lambda a: a[0] == "ssh-keygen",
        RunResult(0, stdout="256 SHA256:GOODKEY box (ED25519)"),
    )
    runner.respond(lambda a: "cat" in a[-1], RunResult(0, stdout="ok"))
    t = SshTransport("hermes@box", host_key_sha256="SHA256:GOODKEY", runner=runner)
    assert t.read("/f") == b"ok"


def test_ssh_host_key_mismatch_hard_fails(tmp_data_home):
    runner = _RecordingRunner()
    runner.respond(
        lambda a: a[0] == "ssh-keyscan", RunResult(0, stdout="box ssh-ed25519 AAAA")
    )
    runner.respond(
        lambda a: a[0] == "ssh-keygen",
        RunResult(0, stdout="256 SHA256:LIVEKEY box (ED25519)"),
    )
    t = SshTransport("hermes@box", host_key_sha256="SHA256:PINNED", runner=runner)
    with pytest.raises(HostKeyMismatch):
        t.read("/f")
    # No `cat` (read) command was ever issued — aborted before any remote read.
    assert not any("cat" in c["argv"][-1] for c in runner.calls if c["argv"][0] == "ssh")


def test_ssh_copy_id_appends_idempotently(tmp_data_home):
    runner = _RecordingRunner()
    t = SshTransport("hermes@box", runner=runner)
    t.copy_id("ssh-ed25519 AAAAPUBKEY user@host")
    cmd = runner.calls[-1]["argv"][-1]
    assert "authorized_keys" in cmd
    assert "grep -qxF" in cmd  # idempotent append guard


# ─────────────────────────────────────────────────────────────────────────────
# keychain fail-closed when keyring is missing
# ─────────────────────────────────────────────────────────────────────────────


def test_keychain_fail_closed_when_keyring_missing(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "keyring" or name.startswith("keyring."):
            raise ImportError("no keyring")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert keychain.is_available() is False
    with pytest.raises(keychain.KeychainUnavailable):
        keychain.get_secret("skill-hub:r")


def test_keychain_ref_parsing():
    assert keychain._split_ref("svc:acct") == ("svc", "acct")
    assert keychain._split_ref("bare") == (keychain.DEFAULT_SERVICE, "bare")
