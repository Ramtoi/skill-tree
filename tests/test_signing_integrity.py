"""C1 signed-manifest integrity + M2 round-trip controls (OFFLINE).

The signing primitives are exercised with a MOCK `ssh-keygen` runner so the unit
tests never require the real binary; a separate set uses the real `ssh-keygen`
when present (skipped otherwise). Sign-on-push is driven through the Hermes
connector against the same FakeBox pattern used elsewhere. M2 pull/import
controls are driven through `hub.py` against a tmp data home.

Covers:
  * canonical manifest bytes are deterministic + match the documented format
  * sign -> verify round-trip (mock + real); tampered fails; wrong key fails
  * missing ssh-keygen -> typed SigningUnavailable (no crash)
  * sign-on-push writes a verifiable manifest into the hub-owned subtree ONLY
    (write-confinement guard not violated)
  * confirm-on-pull blocks without --yes; --yes adopts
  * pulled skill is quarantined to scope: project-specific
  * provenance origin tag + remote-agent audit entry recorded on pull + import
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

import hub
from connectors import signing as S
from connectors.transport import audit as _audit
from connectors import sidecar as _sidecar


# ─────────────────────────────────────────────────────────────────────────────
# Mock ssh-keygen runner — a deterministic in-process stand-in. It "signs" a
# payload by HMAC-ish hashing it with the private-key file bytes, and "verifies"
# by recomputing against the pinned pubkey (which we tie to the same private key
# file via a sidecar map). Good enough to assert the canonicalization + the
# tamper/wrong-key/round-trip behaviour without the real binary.
# ─────────────────────────────────────────────────────────────────────────────


class MockSshKeygen:
    SIG_HEADER = "-----BEGIN SSH SIGNATURE-----"
    SIG_FOOTER = "-----END SSH SIGNATURE-----"

    def __init__(self):
        # pubkey-body -> private-seed, so verify can recompute the same digest.
        self.pub_to_seed: dict[str, str] = {}
        self._counter = 0

    def _digest(self, seed: str, namespace: str, payload: bytes) -> str:
        h = hashlib.sha256()
        h.update(seed.encode())
        h.update(b"\x00")
        h.update(namespace.encode())
        h.update(b"\x00")
        h.update(payload)
        return h.hexdigest()

    def __call__(self, argv, *, input=None):
        argv = list(argv)
        if argv[0] != "ssh-keygen":
            return S.RunResult(returncode=1, stderr="not ssh-keygen")

        # keygen: -t ed25519 -N "" -C ... -f <path>
        if "-t" in argv and "-Y" not in argv and "-Q" not in argv:
            i = argv.index("-f")
            keypath = Path(argv[i + 1])
            self._counter += 1
            seed = f"seed-{self._counter}"
            keypath.write_text(f"PRIV {seed}\n")
            body = f"AAAAMOCK{self._counter:04d}"
            pub = f"ssh-ed25519 {body} skill-hub-signing"
            keypath.with_suffix(".pub").write_text(pub + "\n")
            self.pub_to_seed[body] = seed
            return S.RunResult(returncode=0)

        # availability probe: -Q -t ed25519
        if "-Q" in argv:
            return S.RunResult(returncode=0)

        # sign: -Y sign -n <ns> -f <priv>
        if "-Y" in argv and "sign" in argv:
            ns = argv[argv.index("-n") + 1]
            priv = Path(argv[argv.index("-f") + 1])
            seed = priv.read_text().split()[1]
            digest = self._digest(seed, ns, input or b"")
            sig = f"{self.SIG_HEADER}\n{ns}:{digest}\n{self.SIG_FOOTER}\n"
            return S.RunResult(returncode=0, stdout=sig)

        # verify: -Y verify -n <ns> -f <signers> -I <id> -s <sigfile>
        if "-Y" in argv and "verify" in argv:
            ns = argv[argv.index("-n") + 1]
            signers = Path(argv[argv.index("-f") + 1]).read_text()
            sigtext = Path(argv[argv.index("-s") + 1]).read_text()
            # pinned pubkey is "<id> ssh-ed25519 <body> <comment>"
            parts = signers.split()
            body = None
            for tok in parts:
                if tok in self.pub_to_seed:
                    body = tok
                    break
            if body is None:
                return S.RunResult(returncode=1, stderr="unknown signer")
            seed = self.pub_to_seed[body]
            want = self._digest(seed, ns, input or b"")
            # sig line is "<ns>:<digest>"
            got = ""
            for ln in sigtext.splitlines():
                if ":" in ln and self.SIG_HEADER not in ln and self.SIG_FOOTER not in ln:
                    got = ln.split(":", 1)[1]
            return S.RunResult(returncode=0 if got == want else 1)

        return S.RunResult(returncode=1, stderr="unhandled")


@pytest.fixture
def mock_keygen():
    return MockSshKeygen()


# ─────────────────────────────────────────────────────────────────────────────
# Canonical bytes
# ─────────────────────────────────────────────────────────────────────────────


def test_canonical_bytes_are_deterministic_and_sorted():
    a = [("z/SKILL.md", "1" * 64), ("a/SKILL.md", "2" * 64)]
    b = [("a/SKILL.md", "2" * 64), ("z/SKILL.md", "1" * 64)]
    cb_a = S.canonical_manifest_bytes(a)
    cb_b = S.canonical_manifest_bytes(b)
    assert cb_a == cb_b  # order-independent
    assert not cb_a.endswith(b"\n")  # no trailing newline
    obj = json.loads(cb_a)
    assert obj["namespace"] == S.DEFAULT_NAMESPACE
    assert obj["items"][0][0] == "a/SKILL.md"  # sorted by relpath
    # single-line compact form
    assert b"\n" not in cb_a
    assert b", " not in cb_a and b": " not in cb_a  # compact separators


def test_namespace_changes_bytes():
    items = [("a", "b" * 64)]
    assert S.canonical_manifest_bytes(items, namespace="x") != \
        S.canonical_manifest_bytes(items, namespace="y")


# ─────────────────────────────────────────────────────────────────────────────
# sign / verify (mock)
# ─────────────────────────────────────────────────────────────────────────────


def test_sign_verify_roundtrip_mock(tmp_data_home, mock_keygen):
    pub = S.ensure_signing_key(runner=mock_keygen)
    items = [("foo/SKILL.md", "a" * 64), ("foo/ref.md", "b" * 64)]
    sig = S.sign_manifest(items, runner=mock_keygen)
    assert "BEGIN SSH SIGNATURE" in sig
    assert S.verify_manifest(items, sig, pub, runner=mock_keygen) is True


def test_tampered_manifest_fails(tmp_data_home, mock_keygen):
    pub = S.ensure_signing_key(runner=mock_keygen)
    items = [("foo/SKILL.md", "a" * 64)]
    sig = S.sign_manifest(items, runner=mock_keygen)
    tampered = [("foo/SKILL.md", "f" * 64)]
    assert S.verify_manifest(tampered, sig, pub, runner=mock_keygen) is False


def test_wrong_key_fails(tmp_data_home, mock_keygen):
    S.ensure_signing_key(runner=mock_keygen)
    items = [("foo/SKILL.md", "a" * 64)]
    sig = S.sign_manifest(items, runner=mock_keygen)
    # A pubkey the mock never minted → unknown signer → fail.
    bogus = "ssh-ed25519 AAAANOTREAL skill-hub-signing"
    assert S.verify_manifest(items, sig, bogus, runner=mock_keygen) is False


def test_missing_ssh_keygen_is_typed_error(tmp_data_home, monkeypatch):
    # The DEFAULT runner translates a missing binary into a typed
    # SigningUnavailable (FileNotFoundError from subprocess.run).
    def boom(*a, **k):
        raise FileNotFoundError("ssh-keygen")

    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(S.SigningUnavailable):
        S.ensure_signing_key()
    # is_available swallows it to False (no crash).
    assert S.is_available() is False


def test_ensure_signing_key_idempotent(tmp_data_home, mock_keygen):
    p1 = S.ensure_signing_key(runner=mock_keygen)
    p2 = S.ensure_signing_key(runner=mock_keygen)
    assert p1 == p2  # second call returns the existing pubkey, no regen


def test_key_id_distinguishes_keys():
    a = S.key_id("ssh-ed25519 AAAABODYONE c")
    b = S.key_id("ssh-ed25519 AAAABODYTWO c")
    assert a != b and a.startswith("SHA256:")


# ─────────────────────────────────────────────────────────────────────────────
# sign / verify (REAL ssh-keygen, when present)
# ─────────────────────────────────────────────────────────────────────────────

_has_real_keygen = S.is_available()
needs_keygen = pytest.mark.skipif(not _has_real_keygen, reason="ssh-keygen not installed")


@needs_keygen
def test_real_sign_verify_roundtrip(tmp_data_home):
    pub = S.ensure_signing_key()
    items = [("foo/SKILL.md", "a" * 64), ("bar/SKILL.md", "b" * 64)]
    sig = S.sign_manifest(items)
    assert S.verify_manifest(items, sig, pub) is True
    assert S.verify_manifest([("foo/SKILL.md", "c" * 64)], sig, pub) is False


# ─────────────────────────────────────────────────────────────────────────────
# Sign-on-push through the Hermes connector (FakeBox; mock keygen)
# ─────────────────────────────────────────────────────────────────────────────


def _import_hermes_box():
    # Reuse the FakeBox + helpers from the Hermes connector test module.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_hermes_test_helpers",
        str(Path(__file__).parent / "test_hermes_connector.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_sign_on_push_writes_verifiable_manifest_in_hub_subtree(tmp_data_home, mock_keygen, monkeypatch):
    h = _import_hermes_box()
    root = tmp_data_home / "box"
    root.mkdir()
    box = h.FakeBox(root)
    connector = h._connector_for(box)
    target = h._target()

    # Init signing with the mock so get_public_key() is non-None and sign uses mock.
    pub = S.ensure_signing_key(runner=mock_keygen)
    # Route the connector's sign call through the mock runner.
    monkeypatch.setattr(S, "_default_runner", mock_keygen)

    tree = h._make_skill_tree("alpha")
    desired = h._desired(skills=[tree])
    plan = connector.plan(target, desired)
    result = connector.apply(target, plan)
    assert "alpha" in result.created
    assert not result.errors, result.errors

    # The manifest + signature landed in the hub-owned skill-hub/ subtree ONLY.
    manifest = root / "skill-hub" / S.MANIFEST_FILE
    sig = root / "skill-hub" / S.MANIFEST_SIG_FILE
    assert manifest.exists() and sig.exists()
    # NOT in the box-native skills/ tree.
    assert not (root / "skills" / S.MANIFEST_FILE).exists()

    # The manifest verifies against the pinned pubkey.
    obj = json.loads(manifest.read_text())
    items = [(p, s) for p, s in obj["items"]]
    assert items  # covers alpha/SKILL.md
    assert all(p.startswith("alpha/") for p, _ in items)
    assert S.verify_manifest(items, sig.read_text(), pub,
                             namespace=obj["namespace"], runner=mock_keygen) is True


def _import_codex_box():
    pytest.importorskip("connectors_private")  # the codex box helpers are private-mirror-only
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_codex_test_helpers",
        str(Path(__file__).parent / "test_codex_workers_connector.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_codex_sign_on_push_writes_manifest_in_skills_subtree(tmp_data_home, mock_keygen, monkeypatch):
    cw = _import_codex_box()
    root = tmp_data_home / "codexbox"
    root.mkdir()
    box = cw.FakeBox(root)
    connector = cw._connector_for(box)
    target = cw._target()

    pub = S.ensure_signing_key(runner=mock_keygen)
    monkeypatch.setattr(S, "_default_runner", mock_keygen)

    tree = cw._make_skill_tree("delta")
    desired = cw._desired(skills=[tree])
    result = connector.apply(target, connector.plan(target, desired))
    assert "delta" in result.created
    assert not result.errors, result.errors

    manifest = root / "skills" / S.MANIFEST_FILE
    sig = root / "skills" / S.MANIFEST_SIG_FILE
    assert manifest.exists() and sig.exists()
    obj = json.loads(manifest.read_text())
    items = [(p, s) for p, s in obj["items"]]
    assert S.verify_manifest(items, sig.read_text(), pub,
                             namespace=obj["namespace"], runner=mock_keygen) is True


def test_sign_on_push_skipped_when_no_key(tmp_data_home):
    # No signing key initialized → push still succeeds, no manifest written.
    h = _import_hermes_box()
    root = tmp_data_home / "box2"
    root.mkdir()
    box = h.FakeBox(root)
    connector = h._connector_for(box)
    target = h._target()
    tree = h._make_skill_tree("beta")
    desired = h._desired(skills=[tree])
    result = connector.apply(target, connector.plan(target, desired))
    assert "beta" in result.created
    assert not result.errors
    assert not (root / "skill-hub" / S.MANIFEST_FILE).exists()


def test_write_signed_manifest_guard_blocks_escape(tmp_data_home, mock_keygen, monkeypatch):
    # The guard callback must be honoured — a subtree outside the allowlist refuses.
    from connectors.hermes import HermesConnector, _Paths, UpgradeSafetyViolation
    S.ensure_signing_key(runner=mock_keygen)
    monkeypatch.setattr(S, "_default_runner", mock_keygen)

    paths = _Paths("/box")
    conn = HermesConnector()

    class _T:
        def atomic_write(self, *a, **k):
            raise AssertionError("must not write outside the allowlist")

    with pytest.raises(UpgradeSafetyViolation):
        S.write_signed_manifest(
            _T(), "/box/hermes-agent", [("x/SKILL.md", "a" * 64)],
            guard=lambda p: conn._guard_write_path(paths, p),
        )


# ─────────────────────────────────────────────────────────────────────────────
# M2 pull/import controls through hub.py
# ─────────────────────────────────────────────────────────────────────────────


def _setup_remote_with_drift(tmp_data_home, monkeypatch):
    """Register a hermes remote backed by a FakeBox holding a managed skill that
    has drifted on the remote, so resolve --op pull has something to adopt."""
    h = _import_hermes_box()
    root = tmp_data_home / "remotebox"
    root.mkdir()
    box = h.FakeBox(root)
    connector = h._connector_for(box)
    target = h._target("rmt")

    # Push a managed skill so it is sidecar-tracked, then mutate it on the box to
    # simulate an agent edit (remote-drifted).
    tree = h._make_skill_tree("gamma", body="original")
    connector.apply(target, connector.plan(target, h._desired(skills=[tree])))
    # Agent edits the remote SKILL.md.
    (root / "skill-hub" / "gamma" / "SKILL.md").write_text(
        "---\nname: gamma\nversion: 1.0.0\n---\nAGENT EDITED\n"
    )

    # Register the remote in a real registry under the tmp home.
    reg = hub._read_registry_optional()
    reg.setdefault("skills", {})
    reg["remotes"] = {"rmt": target.to_dict()}
    hub.save_registry(reg)

    # Point the global hermes connector instance at this box for hub.py's lookups
    # (monkeypatch auto-restores the real factory after the test).
    from connectors import REMOTE_CONNECTORS
    monkeypatch.setattr(
        REMOTE_CONNECTORS["hermes"], "_transport_factory",
        h._connector_for(box)._transport_factory,
    )
    return box


def _args(**kw):
    import types
    return types.SimpleNamespace(**kw)


def test_confirm_on_pull_blocks_without_yes(tmp_data_home, monkeypatch, capsys):
    _setup_remote_with_drift(tmp_data_home, monkeypatch)
    # _confirm returns False (decline).
    monkeypatch.setattr(hub, "_confirm", lambda prompt: False)
    args = _args(id="rmt", artifact="gamma", op="pull", kind="skill", yes=False)
    with pytest.raises(SystemExit):
        hub.cmd_remote_resolve(args)
    # The skill was NOT adopted into the registry.
    reg = hub._read_registry_optional()
    assert "gamma" not in (reg.get("skills") or {})


def test_pull_with_yes_quarantines_and_tags_provenance(tmp_data_home, monkeypatch):
    _setup_remote_with_drift(tmp_data_home, monkeypatch)
    args = _args(id="rmt", artifact="gamma", op="pull", kind="skill", yes=True)
    hub.cmd_remote_resolve(args)
    reg = hub._read_registry_optional()
    entry = reg["skills"]["gamma"]
    # Quarantine: scope project-specific (NOT global).
    assert entry["scope"] == "project-specific"
    # Provenance origin tag.
    assert entry["origin"] == "remote:rmt"
    # Audit entry tagging remote-agent origin.
    entries = _audit.read_all("rmt")
    pulls = [e for e in entries if e.get("action") == "pull-adopt"]
    assert pulls and "remote-agent-origin" in (pulls[-1].get("detail") or "")


def test_pull_forces_project_specific_over_existing_global(tmp_data_home, monkeypatch):
    _setup_remote_with_drift(tmp_data_home, monkeypatch)
    # Pre-seed a GLOBAL entry for gamma; pull must downgrade it to project-specific.
    reg = hub._read_registry_optional()
    reg["skills"]["gamma"] = {"version": "1.0.0", "scope": "global", "type": "claude-skill"}
    hub.save_registry(reg)
    args = _args(id="rmt", artifact="gamma", op="pull", kind="skill", yes=True)
    hub.cmd_remote_resolve(args)
    reg = hub._read_registry_optional()
    assert reg["skills"]["gamma"]["scope"] == "project-specific"
