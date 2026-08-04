"""OS-keychain secret access via the Python `keyring` binding.

`registry.yaml` holds only a `secret_ref` (a keychain handle), never the secret
bytes (spec: "Secrets via OS keychain, references only"). The CLI path uses the
`keyring` library against the same OS keychain the Rust app's `keyring` crate
uses, so both paths resolve the same secret.

The `keyring` import is **guarded**: this module imports cleanly even when the
library is absent, and only fails — **fail-closed** — when a secret is actually
requested (spec: "Keychain unavailable fails closed"). There is deliberately NO
plaintext/env fallback.

Secret handle convention: ``"<service>:<account>"`` (e.g.
``"skill-hub:hermes-main"``). A handle without a colon uses a default service.
"""

from __future__ import annotations

from typing import Optional

DEFAULT_SERVICE = "skill-hub"


class KeychainUnavailable(RuntimeError):
    """Raised when the OS keychain cannot be reached and a secret is required.

    Fail-closed: callers MUST treat this as a hard stop, never as a signal to
    fall back to a plaintext or environment-sourced credential.
    """


class SecretNotFound(KeyError):
    """Raised when a secret reference resolves to nothing in the keychain."""


def _load_keyring():
    """Import `keyring` lazily; raise KeychainUnavailable if it is absent.

    Kept out of module scope so importing this module never requires the dep.
    """
    try:
        import keyring  # type: ignore
    except Exception as exc:  # ImportError or a backend init error
        raise KeychainUnavailable(
            "the `keyring` library is unavailable; secret access fails closed "
            "(no plaintext/env fallback is attempted)"
        ) from exc
    return keyring


def _split_ref(secret_ref: str) -> tuple[str, str]:
    """Parse ``"service:account"`` → (service, account). No colon ⇒ default service."""
    if ":" in secret_ref:
        service, account = secret_ref.split(":", 1)
        return (service or DEFAULT_SERVICE), account
    return DEFAULT_SERVICE, secret_ref


def get_secret(secret_ref: str) -> str:
    """Resolve `secret_ref` from the OS keychain at use time.

    Raises `KeychainUnavailable` if the keychain can't be reached and
    `SecretNotFound` if the handle has no stored value.
    """
    keyring = _load_keyring()
    service, account = _split_ref(secret_ref)
    try:
        value = keyring.get_password(service, account)
    except Exception as exc:
        raise KeychainUnavailable(f"keychain read failed for {service!r}") from exc
    if value is None:
        raise SecretNotFound(f"no secret stored for {secret_ref!r}")
    return value


def set_secret(secret_ref: str, value: str) -> None:
    """Store `value` under `secret_ref` in the OS keychain."""
    keyring = _load_keyring()
    service, account = _split_ref(secret_ref)
    try:
        keyring.set_password(service, account, value)
    except Exception as exc:
        raise KeychainUnavailable(f"keychain write failed for {service!r}") from exc


def delete_secret(secret_ref: str) -> bool:
    """Delete a secret. Returns False if it was already absent."""
    keyring = _load_keyring()
    service, account = _split_ref(secret_ref)
    try:
        keyring.delete_password(service, account)
        return True
    except Exception:
        # keyring raises PasswordDeleteError when absent; treat as a no-op.
        return False


def is_available() -> bool:
    """True iff the keyring library can be imported (no secret is touched)."""
    try:
        _load_keyring()
        return True
    except KeychainUnavailable:
        return False
