"""Signed-manifest integrity over the OpenSSH toolchain (SSHSIG) — finding C1.

Pushed skills are EXECUTED on the remote (some as root in codex containers), and
agent-edited skills PULLED back are unauthenticated LLM output (OWASP LLM05) that
can re-propagate fleet-wide via `hub sync`. To give those round-trip/executed
paths lightweight cryptographic integrity WITHOUT a heavy new crypto dependency,
this module reuses the OpenSSH toolchain already present on every box:

  * `ssh-keygen -Y sign`   — produce an SSHSIG armored signature over a payload.
  * `ssh-keygen -Y verify` — verify an SSHSIG against a pinned allowed signer.

The hub holds a DEDICATED ed25519 signing keypair (NOT a login key): the PRIVATE
key lives in a 0600 hub-owned file under `<data_home>/state/signing/` and the
PUBLIC key is **pinned in the registry** (a top-level `signing:` block) exactly
like a host-key fingerprint. A connector signs a manifest of `[(relpath, sha256)]`
for its hub-owned subtree on push; a remote verifier (the Wave-5 gateway, or a
future re-verify) checks the canonical bytes against the pinned pubkey before
trusting / executing the content. Fail-closed everywhere.

### Canonical manifest bytes (the Wave-5 gateway MUST byte-match this)

`canonical_manifest_bytes(items, namespace)` produces:

    {"namespace":"<ns>","items":[["<relpath>","<sha256hex>"],...]}

— a single-line UTF-8 JSON object, `items` sorted by (relpath, sha256), encoded
with `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
and **no trailing newline**. These exact bytes are the payload fed to
`ssh-keygen -Y sign -n <namespace>` and re-derived on the verify side. The
gateway re-builds them from its own on-disk view, then runs
`ssh-keygen -Y verify -n <namespace>` against the pinned pubkey.

### No secret on argv / in logs

The private key is referenced only by FILE PATH on `ssh-keygen`'s argv (never the
key bytes), and the file is 0600 hub-owned. The payload is fed to `ssh-keygen`
over **stdin**, never argv. No key material is ever logged.

The subprocess runner is injectable (`runner=`) so tests drive sign/verify
against a real `ssh-keygen` when present, or a mock when not. A missing
`ssh-keygen` raises a typed `SigningUnavailable` — callers MUST treat it as a
hard stop and never fall back to unsigned trust.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

# Default SSHSIG namespace for hub manifests. SSHSIG binds the signature to a
# namespace so a signature made for one purpose cannot be replayed in another.
DEFAULT_NAMESPACE = "skill-hub-manifest"

# Hub-owned signing key id (the comment baked into the generated keypair).
SIGNING_KEY_COMMENT = "skill-hub-signing"


class SigningError(RuntimeError):
    """Base class for signing failures (fail-closed)."""


class SigningUnavailable(SigningError):
    """`ssh-keygen` is absent or unusable; signing/verification fails closed.

    Callers MUST treat this as a hard stop — never a signal to push or adopt
    content WITHOUT a valid signature.
    """


@dataclass(frozen=True)
class RunResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


#: A runner takes an argv list (+ optional stdin bytes) → RunResult. Injectable
#: so tests can mock `ssh-keygen` without the real binary.
Runner = Callable[..., RunResult]


def _default_runner(argv: Sequence[str], *, input: Optional[bytes] = None) -> RunResult:
    """Shell out to the real subprocess (never at import)."""
    try:
        proc = subprocess.run(list(argv), input=input, capture_output=True)
    except FileNotFoundError as exc:
        raise SigningUnavailable(
            f"`{argv[0]}` not found; signing/verification fails closed"
        ) from exc
    return RunResult(
        returncode=proc.returncode,
        stdout=proc.stdout.decode("utf-8", "replace") if proc.stdout else "",
        stderr=proc.stderr.decode("utf-8", "replace") if proc.stderr else "",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Key storage — a dedicated 0600 hub-owned ed25519 keypair off argv/logs.
# ─────────────────────────────────────────────────────────────────────────────


def signing_dir() -> Path:
    """`<data_home>/state/signing/` — resolved via hub.data_home()."""
    import hub  # local import to avoid an import cycle at module load

    return hub.data_home() / "state" / "signing"


def private_key_path() -> Path:
    return signing_dir() / "hub_signing_ed25519"


def public_key_path() -> Path:
    return signing_dir() / "hub_signing_ed25519.pub"


def _normalize_pubkey(pub: str) -> str:
    """Strip a trailing newline + surrounding whitespace from a pubkey line."""
    return pub.strip()


def ensure_signing_key(*, runner: Optional[Runner] = None) -> str:
    """First-run: generate the dedicated ed25519 hub signing keypair. Idempotent.

    Stores the PRIVATE key in a 0600 hub-owned file under `signing_dir()` and
    returns the armored PUBLIC key line (`ssh-ed25519 AAAA... skill-hub-signing`).
    A second call returns the existing pubkey without regenerating. The private
    key never leaves the file — `ssh-keygen` references it by path, never bytes.
    """
    run = runner or _default_runner
    priv = private_key_path()
    pub = public_key_path()
    if priv.exists() and pub.exists():
        return _normalize_pubkey(pub.read_text())

    signing_dir().mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(signing_dir(), 0o700)
    except OSError:
        pass

    # If only one half exists, clear the stale pair so ssh-keygen does not prompt
    # to overwrite (it would block on a non-interactive runner).
    for p in (priv, pub):
        try:
            if p.exists():
                p.unlink()
        except OSError:
            pass

    # -N "" → no passphrase (the file itself is the protected secret, 0600);
    # -C    → a stable comment so the key is identifiable; -f → the key path.
    res = run(
        [
            "ssh-keygen",
            "-t", "ed25519",
            "-N", "",
            "-C", SIGNING_KEY_COMMENT,
            "-f", str(priv),
        ]
    )
    if res.returncode != 0:
        raise SigningError(f"ssh-keygen key generation failed: {res.stderr.strip()}")
    if not pub.exists():
        raise SigningError("ssh-keygen reported success but no public key was written")
    try:
        os.chmod(priv, 0o600)
        os.chmod(pub, 0o644)
    except OSError:
        pass
    return _normalize_pubkey(pub.read_text())


def get_public_key() -> Optional[str]:
    """Return the hub signing PUBLIC key line, or None if not yet initialized."""
    pub = public_key_path()
    if not pub.exists():
        return None
    return _normalize_pubkey(pub.read_text())


def key_id(pubkey: str) -> str:
    """A short, stable id for a pubkey: a sha256 prefix over the base64 body.

    Used for the registry's `signing.key_id` so the pin is human-recognizable
    without dumping the whole key. A digest (not the raw prefix) is used because
    every ed25519 key shares the same algorithm-prefix bytes — a raw slice would
    collide across keys. Pure derivation, no additional crypto claim.
    """
    import hashlib

    parts = _normalize_pubkey(pubkey).split()
    body = parts[1] if len(parts) >= 2 else (parts[0] if parts else "")
    if not body:
        return ""
    return "SHA256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


# ─────────────────────────────────────────────────────────────────────────────
# Canonical manifest bytes — the EXACT payload signed + verified (Wave-5 pins this).
# ─────────────────────────────────────────────────────────────────────────────


def canonical_manifest_bytes(items: Sequence[tuple], *, namespace: str = DEFAULT_NAMESPACE) -> bytes:
    """Canonicalize `[(relpath, sha256), ...]` → the deterministic signing payload.

    The bytes are a single-line UTF-8 JSON object:

        {"items":[["<relpath>","<sha256>"],...],"namespace":"<ns>"}

    `items` sorted by (relpath, sha256); `json.dumps(sort_keys=True,
    separators=(",", ":"), ensure_ascii=False)`; NO trailing newline. These are
    the bytes signed by `ssh-keygen -Y sign` and re-derived on verify, so any
    re-implementation (the Wave-5 gateway) MUST reproduce them byte-for-byte.
    """
    norm = sorted((str(p), str(s)) for p, s in items)
    obj = {"namespace": str(namespace), "items": [[p, s] for p, s in norm]}
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def manifest_json(items: Sequence[tuple], *, namespace: str = DEFAULT_NAMESPACE) -> str:
    """Human/file form of the manifest (pretty), distinct from the SIGNED bytes.

    Written alongside the signature so a verifier can recompute the canonical
    bytes from a stored manifest. The signature is over `canonical_manifest_bytes`,
    NOT over this pretty form.
    """
    norm = sorted((str(p), str(s)) for p, s in items)
    return json.dumps(
        {"namespace": str(namespace), "items": [[p, s] for p, s in norm]},
        indent=2,
        ensure_ascii=False,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Sign / verify via SSHSIG (ssh-keygen -Y sign / -Y verify).
# ─────────────────────────────────────────────────────────────────────────────


def sign_manifest(
    items: Sequence[tuple],
    *,
    namespace: str = DEFAULT_NAMESPACE,
    runner: Optional[Runner] = None,
) -> str:
    """Sign the canonical manifest bytes; return the SSHSIG armored signature.

    Feeds the canonical bytes to `ssh-keygen -Y sign -n <namespace> -f <privkey>`
    over STDIN (never argv) and returns the `-----BEGIN SSH SIGNATURE-----` blob.
    Requires `ensure_signing_key()` to have run. Fail-closed on any error.
    """
    run = runner or _default_runner
    priv = private_key_path()
    if not priv.exists():
        raise SigningError(
            "no hub signing key; run `hub remote signing-key --init` first"
        )
    payload = canonical_manifest_bytes(items, namespace=namespace)
    res = run(
        ["ssh-keygen", "-Y", "sign", "-n", namespace, "-f", str(priv)],
        input=payload,
    )
    if res.returncode != 0:
        raise SigningError(f"ssh-keygen sign failed: {res.stderr.strip()}")
    sig = res.stdout
    if "BEGIN SSH SIGNATURE" not in sig:
        raise SigningError("ssh-keygen sign produced no SSHSIG armored signature")
    return sig


def verify_manifest(
    items: Sequence[tuple],
    signature: str,
    allowed_pubkey: str,
    *,
    namespace: str = DEFAULT_NAMESPACE,
    runner: Optional[Runner] = None,
) -> bool:
    """Fail-closed verify of `signature` over the canonical bytes vs `allowed_pubkey`.

    Re-derives the canonical manifest bytes, writes a temporary allowed-signers
    file pinning `allowed_pubkey`, and runs
    `ssh-keygen -Y verify -n <namespace> -s <sig> -I <id> -f <signers>` with the
    payload on STDIN. Returns True ONLY on a clean exit. Any error (missing
    ssh-keygen, bad signature, wrong key, tampered items) returns False / raises
    `SigningUnavailable` — never a silent pass.

    `allowed_pubkey` is the registry-pinned hub signing pubkey; this is the same
    canonicalization the Wave-5 gateway must run, so it can call this function (or
    re-implement it byte-identically) before executing pushed content.
    """
    run = runner or _default_runner
    pub = _normalize_pubkey(allowed_pubkey)
    if not pub or "BEGIN SSH SIGNATURE" not in signature:
        return False
    payload = canonical_manifest_bytes(items, namespace=namespace)

    tmpdir = tempfile.mkdtemp(prefix="hub-verify-")
    try:
        # The allowed-signers identity is arbitrary but must match the -I arg.
        identity = SIGNING_KEY_COMMENT
        signers_path = os.path.join(tmpdir, "allowed_signers")
        sig_path = os.path.join(tmpdir, "manifest.sig")
        with open(signers_path, "w", encoding="utf-8") as f:
            # Format: "<identity> <pubkey>" — namespaces are passed via -n.
            f.write(f"{identity} {pub}\n")
        with open(sig_path, "w", encoding="utf-8") as f:
            f.write(signature if signature.endswith("\n") else signature + "\n")
        res = run(
            [
                "ssh-keygen", "-Y", "verify",
                "-n", namespace,
                "-f", signers_path,
                "-I", identity,
                "-s", sig_path,
            ],
            input=payload,
        )
        return res.returncode == 0
    finally:
        for fn in ("allowed_signers", "manifest.sig"):
            try:
                os.unlink(os.path.join(tmpdir, fn))
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Sign-on-push — write a signed manifest into a connector's hub-owned subtree.
#
# Connector-agnostic: the caller passes the transport, the hub-owned subtree root
# (the ONLY place the manifest may land — inside the write-confinement allowlist),
# a guard callback (`_guard_write_path`) so the manifest write is re-validated by
# the connector's own confinement, and the list of (relpath, sha256) covering the
# managed skills. No connector imports another (D1) — both call this shared helper.
# ─────────────────────────────────────────────────────────────────────────────

#: The two files written into the hub-owned subtree root.
MANIFEST_FILE = ".skill-hub-manifest.json"
MANIFEST_SIG_FILE = ".skill-hub-manifest.sig"


def write_signed_manifest(
    transport,
    subtree_root: str,
    items: Sequence[tuple],
    *,
    namespace: str = DEFAULT_NAMESPACE,
    guard: Optional[Callable[[str], None]] = None,
    runner: Optional[Runner] = None,
) -> Optional[dict]:
    """Sign `items` and atomically write the manifest + signature into the subtree.

    `subtree_root` is a remote POSIX dir that MUST be inside the connector's
    write-confinement allowlist — the manifest/signature files land at
    `<subtree_root>/.skill-hub-manifest.{json,sig}`. The optional `guard`
    (the connector's `_guard_write_path`) is called on each target path so the
    write is re-validated by the connector's own confinement; a violation
    propagates (the connector's hard refusal).

    No-op returning None when `items` is empty (nothing managed to attest).
    Returns `{"manifest": <path>, "signature": <path>, "covered": <n>}` on a write.
    Fail-closed: a `SigningError`/`SigningUnavailable` propagates so a push that
    cannot be attested does not silently ship unsigned.
    """
    import posixpath

    if not items:
        return None
    sig = sign_manifest(items, namespace=namespace, runner=runner)
    pretty = manifest_json(items, namespace=namespace)

    manifest_path = posixpath.join(subtree_root, MANIFEST_FILE)
    sig_path = posixpath.join(subtree_root, MANIFEST_SIG_FILE)
    if guard is not None:
        guard(manifest_path)
        guard(sig_path)
    transport.atomic_write(manifest_path, pretty.encode("utf-8"))
    transport.atomic_write(sig_path, sig.encode("utf-8"))
    return {"manifest": manifest_path, "signature": sig_path, "covered": len(items)}


def is_available(*, runner: Optional[Runner] = None) -> bool:
    """True iff `ssh-keygen` can be invoked (no key is touched)."""
    run = runner or _default_runner
    try:
        res = run(["ssh-keygen", "-Q", "-t", "ed25519"])
    except SigningUnavailable:
        return False
    except Exception:
        return False
    # Any non-crash exit means the binary exists (the probe flags may differ by
    # OpenSSH version; presence is what we assert here).
    return res.returncode is not None
