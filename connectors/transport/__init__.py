"""Generic transport mechanics shared by every connector.

- `keychain` — OS-keychain secret access (Python `keyring`, import-guarded).
- `audit`    — append-only JSONL audit log.
- `ssh`      — hardened SSH/SCP wrapper (host-key pinning, atomic remote write).

Nothing here connects or imports an optional dependency at module load; the
keyring binding and any real SSH connection are deferred to first use so the
package imports cleanly on a machine missing those deps.
"""
