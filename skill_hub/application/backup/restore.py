"""skill_hub/application/backup/restore.py — reading a portable snapshot back onto a machine (design v2 §5, §6).

Backup is a pure read; restore is the destructive verb, and it is built to be
boring about it:

* **Dry-run is the default.** Nothing is written without `--apply`, and the
  dry-run payload is the same structure the apply path acts on, so the preview
  is not a separate code path that can disagree with reality.
* **Integrity before inspection.** The tree digest and the SSHSIG signature are
  checked before anything past `manifest.json` is read, so a truncated clone or
  a tampered tree aborts instead of half-restoring. An unknown signing key is
  trust-on-first-use: loud, and gated behind an explicit flag. A key that
  disagrees with the pin recorded for this source is a HARD refusal — that is
  the substitution case a pin exists to catch.
* **Restore never syncs and never pushes.** It materializes files and then
  prints ordered next steps. Installing the restored configuration into the
  harnesses is a separate, explicit act (`--sync` opts in), and
  `backup.pending_reconcile` blocks a push so a degraded restore cannot
  overwrite the good snapshot it came from.
* **Executable state is consented to, not assumed.** Hooks (command strings
  verbatim), permission rules, and Codex trust grants are enumerated in both the
  dry-run and the apply output; an apply that would install any of them requires
  `--accept-executable-state`.
* **What the snapshot could not carry is REPORTED, never faked.** Redacted MCP
  env values, keychain secret refs, skills whose source lives outside the data
  home, connector dirs that were symlinks out of the data home, project paths
  that do not exist here, and the machine-absolute strings no transform rule
  owns (hook commands, `hook_settings`, `additional_dirs`) each get a named line
  in the report rather than a silently broken registry.

Stdlib only, plus `yaml` (as everywhere else in the hub).
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import yaml

from skill_hub import hub_core
from skill_hub.application.backup import backup as _backup
from skill_hub.application.backup import references as _references
from skill_hub.application.projects import worktree_defaults
from skill_hub.domain.skills import ships_with
from skill_hub.hub_core import _now_iso, _sha256_file
from skill_hub.infrastructure.backup import backup_git as _backup_git
from skill_hub.infrastructure.registry import sources

SCHEMA_VERSION = 1

#: Registry sections whose entries are keyed maps — `--mode merge` unions these
#: key-by-key (the backup copy wins on a conflicting key, and every conflict is
#: listed). Everything else is a whole-value replacement.
MERGE_SECTIONS = (
    "projects",
    "bundles",
    "skills",
    "remotes",
    "sources",
    "hooks",
    "snippets",
)

#: Top-level registry keys that are MACHINE-LOCAL and are dropped from every
#: portable snapshot (`backup.PORTABLE_DROP_KEYS`). Even `--mode replace` keeps
#: the target's copies: replacing "everything the snapshot carries" must not
#: silently delete this machine's signing pin or its own backup configuration.
PRESERVE_TARGET_KEYS = tuple(_backup.PORTABLE_DROP_KEYS)

#: Data-home directories materialized from the snapshot. Identical to
#: `references.REFERENCE_SECTIONS` by construction (see that module) — kept
#: as its own name here since it predates the shared helper and is the name
#: the rest of this file (and its tests) already use.
DATA_DIRS = _references.REFERENCE_SECTIONS
# `hooks/` is signed snapshot data, but it is not an internal-reference
# section.  Keep it on a separate route so managed bodies cannot accidentally
# gain reference-chain semantics.
MANAGED_HOOKS_DIR = "hooks"

#: Registry field paths that legitimately carry machine-absolute strings NO
#: transform rule owns, so restore must hard-report them per entry rather than
#: pretend they travelled cleanly (design §5, audit #4).
#:
#: The three `*.hooks.*.command` paths ARE owned by `backup.TRANSFORM_RULES`
#: (`{DATA_HOME}`-only) — they are reported here too because a command outside
#: the data home still travels verbatim and still needs a line.
#: `projects.*.hook_settings` is the one hook-adjacent shape NO transform rule
#: owns: arbitrary third-party hook config at arbitrary depth under arbitrary
#: keys, which the field-path grammar cannot express and hub does not
#: interpret. It always travels verbatim.
MACHINE_ABSOLUTE_FIELDS = (
    "hooks.*.command",
    "permissions_global.hooks.*.command",
    "projects.*.permissions.hooks.*.command",
    "projects.*.permissions_local.hooks.*.command",
    "projects.*.hook_settings",
    "permissions_global.additional_dirs",
    "projects.*.permissions.additional_dirs",
    "projects.*.permissions_local.additional_dirs",
)

#: Written by restore so the app does not re-show the first-run wizard over a
#: populated registry.
BOOTSTRAP_VERSION = 1

#: A `Bash(<cmd>:*)` rule is what makes the Codex adapter auto-grant project
#: trust; `Bash(*)` is unbounded and stays a SkipReason, so it does not.
_BASH_RULE_RE = re.compile(r"^Bash\((?!\*\))")

_SLUG_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")

RESTORE_CACHE = "restore-cache"
SIGNERS_FILE = "backup-signers.json"

CLONE_TIMEOUT = 120


class RestoreError(RuntimeError):
    """Any refusal or hard failure on the restore path."""

    def __init__(self, message: str, *, details: Optional[dict] = None):
        super().__init__(message)
        self.details = details or {}


# ─────────────────────────────────────────────────────────────────────────────
# Small helpers
# ─────────────────────────────────────────────────────────────────────────────


def _stamp() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _safe_join(root: Path, rel: str) -> Path:
    """Join `rel` under `root`, refusing anything that escapes after resolve().

    Belt AND braces: the lexical checks catch the obvious `../` and absolute
    forms, and the post-`resolve()` containment check catches the ones that only
    become escapes once symlinks and `..` are collapsed. A snapshot is a git repo
    that may have come from anywhere, so its entry names are untrusted input.
    """
    rel = str(rel)
    if not rel or rel.startswith("/") or rel.startswith("\\"):
        raise RestoreError("refusing absolute path in snapshot: " + rel)
    if os.path.isabs(rel) or ":" in Path(rel).drive:
        raise RestoreError("refusing absolute path in snapshot: " + rel)
    parts = Path(rel).parts
    if any(part == ".." for part in parts):
        raise RestoreError("refusing path traversal in snapshot: " + rel)
    target = Path(root) / rel
    resolved_root = Path(root).resolve(strict=False)
    resolved = target.resolve(strict=False)
    try:
        resolved.relative_to(resolved_root)
    except ValueError:
        raise RestoreError(
            "refusing snapshot path that escapes its root after resolution: " + rel
        )
    return target


def _data_file_source(snapshot_dir: Path, path: Path) -> Path:
    """Resolve relative file references within snapshot data, checking each hop.

    Delegates to `references.resolve_reference_chain` — the same hop-by-hop
    rules `backup._copy_dir` applies at snapshot-assembly time — so restore
    and backup can never quietly diverge on what counts as a safe internal
    reference. `path` not being a symlink at all (the ordinary case, and the
    ONLY case for a snapshot written by the fixed backup code, which
    materializes a safe reference as a regular file before signing) resolves
    to itself immediately.
    """
    try:
        return _references.resolve_reference_chain(snapshot_dir, path, sections=DATA_DIRS)
    except _references.ReferenceError as exc:
        raise RestoreError(str(exc))


def _managed_hook_file_source(snapshot_dir: Path, path: Path) -> Path:
    """Validate one signed managed hook body without following symlinks.

    Backup intentionally preserves hook symlinks as links.  They carry no
    portable body and must not become a way for restore to read or write
    outside the signed snapshot tree.
    """
    root = Path(snapshot_dir) / MANAGED_HOOKS_DIR
    if root.is_symlink():
        raise RestoreError("refusing symlink in managed hook snapshot")
    try:
        rel = path.relative_to(root).as_posix()
    except ValueError:
        raise RestoreError("managed hook path is outside its snapshot root")
    candidate = _safe_join(Path(snapshot_dir), MANAGED_HOOKS_DIR + "/" + rel)
    part = root
    for name in Path(rel).parts:
        part = part / name
        if part.is_symlink():
            raise RestoreError("refusing symlink in managed hook snapshot")
    if not candidate.is_file():
        raise RestoreError("managed hook body is not a regular file")
    return candidate


def _data_destination(data_home: Path, rel: str) -> Path:
    """Do not follow an existing destination link, including a section root."""
    target = _safe_join(data_home, rel)
    part = Path(data_home)
    for name in Path(rel).parts:
        part = part / name
        if part.is_symlink():
            raise RestoreError("destination contains a symlink")
    return target


def _iter_tree(root: Path):
    """`(rel, path)` for every entry under `root`, `.git` excluded, sorted."""
    root = Path(root)
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*")):
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        if rel == ".git" or rel.startswith(".git/"):
            continue
        yield rel, path


# ─────────────────────────────────────────────────────────────────────────────
# TOFU pin store (machine-local — never in a snapshot)
#
# Lives under `state/`, which the manifest table marks derived-and-not-backed-up,
# so a snapshot can never carry the pins that are supposed to judge it.
# ─────────────────────────────────────────────────────────────────────────────


def signers_path(data_home: Optional[Path] = None) -> Path:
    data_home = Path(data_home) if data_home is not None else hub_core.data_home()
    return data_home / "state" / SIGNERS_FILE


def read_pins(data_home: Optional[Path] = None) -> dict:
    """The pin store, or `{}` when it has never been written.

    A store that EXISTS but does not parse is a hard error, not `{}`. Failing
    open there would silently discard every pin this machine holds and turn the
    next restore from a long-known source into a fresh, consent-gated TOFU
    decision — exactly the state an attacker who can corrupt one file would
    want. A missing/unreadable file is the ordinary first-run case and still
    yields `{}`.
    """
    path = signers_path(data_home)
    try:
        raw = path.read_text()
    except OSError:
        return {}
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise RestoreError(
            "the signing pin store at " + str(path) + " is corrupt (" + str(exc) + ") — "
            "refusing to fall back to 'no pins'. Inspect it, then fix or delete it."
        )
    if not isinstance(data, dict) or not isinstance(data.get("signers", {}), dict):
        raise RestoreError(
            "the signing pin store at " + str(path) + " is malformed (no `signers` "
            "mapping) — refusing to fall back to 'no pins'. Inspect it, then fix or "
            "delete it."
        )
    return data.get("signers") or {}


def pinned_keys(pins: dict, key: str) -> list:
    """The SET of signing keys pinned for one source, normalized, oldest first.

    A source is a fleet, not a machine: laptop A and desktop B both push to the
    same backup repo and each signs with its OWN hub key, so "the" pinned key was
    never a well-formed idea. Reads the legacy single-`pubkey` shape too, so a
    store written before this change keeps working.
    """
    from skill_hub.infrastructure.connectors import signing as _signing

    entry = (pins or {}).get(key) or {}
    if not isinstance(entry, dict):
        return []
    raw = entry.get("pubkeys")
    if not isinstance(raw, list):
        raw = [entry.get("pubkey")] if entry.get("pubkey") else []
    out: list = []
    for item in raw:
        if not item:
            continue
        normalized = _signing._normalize_pubkey(str(item))
        if normalized not in out:
            out.append(normalized)
    return out


def pinned_key_ids(pins: dict, key: str) -> list:
    from skill_hub.infrastructure.connectors import signing as _signing

    return [_signing.key_id(pub) for pub in pinned_keys(pins, key)]


def write_pin(source_key: str, pubkey: str, *, data_home: Optional[Path] = None) -> None:
    """ADD a signer to the set pinned for one snapshot source.

    Additive on purpose: pinning machine B's key must not un-pin machine A's, or
    every alternating restore in a two-machine fleet would re-prompt.
    """
    from skill_hub.infrastructure.connectors import signing as _signing

    path = signers_path(data_home)
    pins = read_pins(data_home)
    prior = pins.get(source_key) if isinstance(pins.get(source_key), dict) else {}
    keys = pinned_keys(pins, source_key)
    normalized = _signing._normalize_pubkey(pubkey)
    if normalized not in keys:
        keys.append(normalized)
    pins[source_key] = {
        "pubkeys": keys,
        "key_ids": [_signing.key_id(pub) for pub in keys],
        "first_seen": prior.get("first_seen") or _now_iso(),
        "last_seen": _now_iso(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"signers": pins}, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def source_key(source: str) -> str:
    """Stable identity for a snapshot source (a URL, or an absolute local path)."""
    raw = str(source or "").strip()
    if not raw:
        return "(unknown)"
    candidate = Path(raw).expanduser()
    if candidate.exists():
        return str(candidate.resolve(strict=False))
    return raw.rstrip("/")


#: Trust verdicts. `verified` is the only one that needs no extra consent.
TRUST_VERIFIED = "verified"
TRUST_NEW_KEY = "unverified-new-key"
TRUST_UNSIGNED = "unverified-unsigned"
TRUST_UNAVAILABLE = "unverified-unavailable"
TRUST_MISMATCH = "key-mismatch"
TRUST_INVALID = "invalid-signature"


def classify_trust(
    verdict: dict, *, key: str, pins: dict, trust_new_key: bool = False
) -> dict:
    """Fold a signature verdict + the pin store into a trust decision.

    The pin for a source is a SET of signers, because a source IS a fleet: the
    laptop and the desktop both push to the same backup repo and each signs with
    its own hub key. Outcomes:

    * signature verifies by a key already in the set → `verified` (proceed);
    * signature verifies by a key the set does not hold → `unverified-new-key`,
      the TOFU case: consent-gated, and ADDED to the set on apply. That covers
      both "this machine has never restored from here" and "a second machine
      joined the fleet" — the two are indistinguishable from here, and refusing
      the second outright is what made multi-machine unusable;
    * signature does not verify → `invalid-signature`, a HARD refusal. Tampered
      bytes are never a consent question;
    * a source with pinned signers offering NO verifiable signature →
      `key-mismatch`, also hard. Silently accepting a downgrade to unsigned is
      what would make the whole pin decorative, so it stays a refusal even
      though a widened key set is not;
    * an unpinned source with no signature → `unverified-unsigned` /
      `unverified-unavailable` (consent-gated: unattested, but nothing claims
      otherwise).
    """
    state = verdict.get("state")
    pubkey = verdict.get("pubkey")
    pinned = pins.get(key) if isinstance(pins.get(key), dict) else {}
    pinned_set = pinned_keys(pins, key)
    pinned_ids = pinned_key_ids(pins, key)

    if state == _backup.SIG_INVALID:
        return {
            "state": TRUST_INVALID,
            "ok": False,
            "hard": True,
            "detail": verdict.get("detail") or "signature does not verify",
            "key_id": verdict.get("key_id"),
            "pinned_key_id": pinned_ids[0] if pinned_ids else None,
            "pinned_key_ids": pinned_ids,
        }
    if state == _backup.SIG_SIGNED:
        from skill_hub.infrastructure.connectors import signing as _signing

        offered = _signing._normalize_pubkey(str(pubkey)) if pubkey else None
        if offered and offered in pinned_set:
            return {
                "state": TRUST_VERIFIED,
                "ok": True,
                "hard": False,
                "detail": "signed by a key already pinned for this source",
                "key_id": verdict.get("key_id"),
                "pinned_key_id": verdict.get("key_id"),
                "pinned_key_ids": pinned_ids,
            }
        if pinned_set:
            detail = (
                "UNVERIFIED SNAPSHOT (signing key "
                + str(verdict.get("key_id"))
                + " is not among the "
                + str(len(pinned_set))
                + " key(s) pinned for this source: "
                + ", ".join(pinned_ids)
                + "). That is what a SECOND MACHINE writing to the same backup "
                "looks like — and also what a substituted snapshot looks like. "
                "Accept only if you recognise the key; --trust-new-key adds it "
                "to the set (the existing pins are kept)."
            )
        else:
            detail = (
                "UNVERIFIED SNAPSHOT (new signing key "
                + str(verdict.get("key_id"))
                + ") — this machine has never seen a snapshot from this source. "
                "Re-run with --trust-new-key to accept and pin it."
            )
        return {
            "state": TRUST_NEW_KEY,
            "ok": bool(trust_new_key),
            "hard": False,
            "detail": detail,
            "key_id": verdict.get("key_id"),
            "pinned_key_id": pinned_ids[0] if pinned_ids else None,
            "pinned_key_ids": pinned_ids,
        }
    unsigned_state = (
        TRUST_UNAVAILABLE if state == _backup.SIG_UNAVAILABLE else TRUST_UNSIGNED
    )
    if pinned_set:
        # A source that HAS signed before must keep signing: silently accepting a
        # downgrade to unsigned would make the pin decorative.
        return {
            "state": TRUST_MISMATCH,
            "ok": False,
            "hard": True,
            "detail": (
                "this source is pinned to signing key(s) "
                + ", ".join(pinned_ids)
                + " but this snapshot carries no verifiable signature — refusing"
            ),
            "key_id": None,
            "pinned_key_id": pinned_ids[0] if pinned_ids else None,
            "pinned_key_ids": pinned_ids,
        }
    return {
        "state": unsigned_state,
        "ok": bool(trust_new_key),
        "hard": False,
        "detail": (
            "UNVERIFIED SNAPSHOT ("
            + str(verdict.get("detail") or "unsigned")
            + ") — re-run with --trust-new-key to accept it anyway."
        ),
        "key_id": None,
        "pinned_key_id": None,
        "pinned_key_ids": [],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Getting the snapshot onto this machine (design §5 "clone/pull to a cache")
# ─────────────────────────────────────────────────────────────────────────────


def cache_root(data_home: Optional[Path] = None) -> Path:
    data_home = Path(data_home) if data_home is not None else hub_core.data_home()
    return data_home / "state" / RESTORE_CACHE


def _cache_slug(source: str) -> str:
    tail = _SLUG_UNSAFE.sub("-", str(source).rstrip("/").split("/")[-1] or "snapshot")
    digest = hashlib.sha256(str(source).encode()).hexdigest()[:10]
    return (tail[:40].strip("-") or "snapshot") + "-" + digest


def _git(
    *args: str,
    cwd: Optional[Path] = None,
    timeout: int = CLONE_TIMEOUT,
    env_overrides: Optional[dict] = None,
):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    if env_overrides:
        env.update(env_overrides)
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise RestoreError("git is not installed or not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise RestoreError("git " + " ".join(args) + " timed out") from exc


def _github_repo(source: str) -> Optional[str]:
    """The owner/repo identity for a GitHub clone URL, if it has one."""
    raw = str(source).strip()
    match = re.match(r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?/?$", raw)
    if match:
        return match.group(1) + "/" + match.group(2)

    parsed = urlparse(raw)
    if parsed.scheme not in ("https", "ssh"):
        return None
    if (parsed.hostname or "").lower() != "github.com":
        return None
    if parsed.password or parsed.query or parsed.fragment or parsed.params:
        return None
    if parsed.scheme == "https" and parsed.username:
        return None
    if parsed.scheme == "ssh" and parsed.username != "git":
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port not in (None, 443 if parsed.scheme == "https" else 22):
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        return None
    owner, name = parts
    return owner + "/" + (name[:-4] if name.endswith(".git") else name)


def _snapshot_transport(source: str, registry: dict) -> tuple[str, list, dict]:
    """Select GitHub restore transport without changing the source identity.

    If no rung is available, use canonical HTTPS with ambient Git access:
    public repositories and a user's existing Git credential helpers must still
    work. The original source remains the cache key and reported identity.
    Local paths and non-GitHub sources never enter the backup ladder.
    """
    repo = _github_repo(source)
    if not repo:
        return source, [], {}
    config = _backup.load_backup_config(registry)
    auth = _backup.detect_auth(config.get("auth"), non_mutating=True)
    method = auth.get("method")
    if not method:
        return _backup.remote_url_for(repo, None), [], {}
    url = _backup.remote_url_for(repo, method)
    try:
        args, env = _backup.git_auth_options(method, url=url)
    except _backup.BackupError as exc:
        raise RestoreError("could not prepare GitHub backup authentication") from exc
    if method == "ssh":
        env = dict(env)
        env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"
    return url, args, env


def resolve_snapshot(
    source: Optional[str],
    *,
    registry: Optional[dict] = None,
    data_home: Optional[Path] = None,
    branch: Optional[str] = None,
) -> dict:
    """Produce a local snapshot directory for `source`.

    Three shapes, in order:

    * omitted → this machine's configured `backup.dir` (the "I already have the
      repo locally" case);
    * an existing directory that already holds a `manifest.json` → used IN
      PLACE, never re-cloned. Cloning the backup dir into a cache would double a
      possibly-large tree for nothing;
    * anything else (a URL, or a git repo without a checked-out manifest) →
      cloned/fetched into `state/restore-cache/<slug>`, so a re-run is cheap and
      nothing is written outside the data home.
    """
    data_home = Path(data_home) if data_home is not None else hub_core.data_home()
    if not source:
        cfg = _backup.load_backup_config(registry or {})
        source = cfg.get("dir") or _backup.DEFAULT_BACKUP_DIR
        branch = branch or cfg.get("branch")
    raw = str(source)
    local = Path(raw).expanduser()

    if local.is_dir() and (local / _backup.MANIFEST_FILE).is_file():
        return {
            "dir": local,
            "source": raw,
            "key": source_key(raw),
            "mode": "in-place",
            "detail": "using the snapshot at " + str(local) + " in place",
        }
    if local.exists() and not (local / ".git").exists():
        raise RestoreError(
            str(local) + " is not a Skill Tree snapshot (no manifest.json) and not a "
            "git repo — point --from at a backup repo or its URL"
        )

    dest = cache_root(data_home) / _cache_slug(raw)
    dest.parent.mkdir(parents=True, exist_ok=True)
    clone_url = str(local) if local.exists() else raw
    auth_args: list = []
    auth_env: dict = {}
    if not local.exists():
        clone_url, auth_args, auth_env = _snapshot_transport(raw, registry or {})
    if (dest / ".git").exists():
        remote = _git("remote", "set-url", "origin", clone_url, cwd=dest)
        if remote.returncode != 0:
            raise RestoreError(
                "could not update the cached snapshot transport: "
                + (remote.stderr or remote.stdout or "git remote set-url failed").strip()
            )
        fetched = _git(
            *auth_args,
            "fetch",
            "--quiet",
            "origin",
            cwd=dest,
            env_overrides=auth_env or None,
        )
        if fetched.returncode != 0:
            raise RestoreError(
                "could not refresh the cached snapshot at "
                + str(dest)
                + ": "
                + (fetched.stderr or fetched.stdout or "git fetch failed").strip()
            )
        head = branch or _default_remote_branch(dest)
        reset = _git("reset", "--hard", "--quiet", "origin/" + head, cwd=dest)
        if reset.returncode != 0:
            raise RestoreError(
                "could not check out origin/" + head + " in the snapshot cache: "
                + (reset.stderr or reset.stdout or "").strip()
            )
        detail = "refreshed the cached clone of " + raw
    else:
        args = [*auth_args, "clone", "--quiet", "--depth", "1"]
        if branch:
            args += ["--branch", branch]
        args += [clone_url, str(dest)]
        cloned = _git(*args, env_overrides=auth_env or None)
        if cloned.returncode != 0:
            shutil.rmtree(dest, ignore_errors=True)
            raise RestoreError(
                "could not clone the snapshot from "
                + raw
                + ": "
                + (cloned.stderr or cloned.stdout or "git clone failed").strip()
            )
        detail = "cloned " + raw + " into " + str(dest)

    if not (dest / _backup.MANIFEST_FILE).is_file():
        raise RestoreError(
            raw + " does not look like a Skill Tree backup repo — no manifest.json at "
            "its tip"
        )
    return {
        "dir": dest,
        "source": raw,
        "key": source_key(raw),
        "mode": "cache",
        "detail": detail,
    }


def _default_remote_branch(repo: Path) -> str:
    proc = _git("symbolic-ref", "--short", "HEAD", cwd=repo)
    return (proc.stdout or "").strip() or _backup.DEFAULT_BRANCH


# ─────────────────────────────────────────────────────────────────────────────
# Registry diffing + merging (design §5 "registry modes")
# ─────────────────────────────────────────────────────────────────────────────


def registry_is_populated(registry: dict) -> bool:
    """Does the target registry hold user content a replace would destroy?"""
    for key in MERGE_SECTIONS:
        block = (registry or {}).get(key)
        if isinstance(block, dict) and block:
            return True
    return False


def diff_registry(target: dict, incoming: dict) -> dict:
    """`{sections, top_level, totals}` describing replace's effect on `target`.

    Enumerates, per section, what appears (`added`), what would be LOST, and
    which keys exist on both sides with different content (`conflicts`). Plus the
    top-level keys themselves, since a snapshot from an older hub can be missing
    a whole block the target has.
    """
    sections: dict = {}
    for key in MERGE_SECTIONS:
        tgt = target.get(key) if isinstance(target.get(key), dict) else {}
        inc = incoming.get(key) if isinstance(incoming.get(key), dict) else {}
        sections[key] = {
            "added": sorted(set(inc) - set(tgt)),
            "lost": sorted(set(tgt) - set(inc)),
            "conflicts": sorted(k for k in set(tgt) & set(inc) if tgt[k] != inc[k]),
        }
    keep = set(PRESERVE_TARGET_KEYS)
    # Worktree defaults have their own optional-block status below. Keeping it
    # out of generic top-level loss/addition lists prevents an omitted block
    # from being counted as a file loss during restore preview.
    special = {"worktree_defaults"}
    top_added = sorted((set(incoming) - set(target)) - special)
    top_lost = sorted(k for k in set(target) - set(incoming) if k not in keep and k not in special)
    totals = {
        "added": sum(len(s["added"]) for s in sections.values()),
        "lost": sum(len(s["lost"]) for s in sections.values()),
        "conflicts": sum(len(s["conflicts"]) for s in sections.values()),
    }
    target_worktree = worktree_defaults.configured(target)
    incoming_worktree = worktree_defaults.configured(incoming)
    if target_worktree is None and incoming_worktree is None:
        worktree_status = "unchanged"
        worktree_value = None
    elif target_worktree is None:
        worktree_status = "added"
        worktree_value = incoming_worktree
    elif incoming_worktree is None:
        worktree_status = "preserved"
        worktree_value = target_worktree
    elif target_worktree == incoming_worktree:
        worktree_status = "unchanged"
        worktree_value = incoming_worktree
    else:
        worktree_status = "changed"
        worktree_value = incoming_worktree
    return {
        "sections": sections,
        "top_level_added": top_added,
        "top_level_lost": top_lost,
        "worktree_defaults": {
            "status": worktree_status,
            "value": worktree_value,
        },
        "totals": totals,
    }


def merge_registry(target: dict, incoming: dict) -> dict:
    """Union `incoming` over `target`; the BACKUP wins every conflicting key."""
    out = dict(target)
    for key, value in incoming.items():
        if key in MERGE_SECTIONS and isinstance(value, dict):
            base = out.get(key)
            merged = dict(base) if isinstance(base, dict) else {}
            merged.update(value)
            out[key] = merged
        else:
            out[key] = value
    return out


def replace_registry(target: dict, incoming: dict) -> dict:
    """Wholesale swap, except the machine-local keys a snapshot never carries."""
    out = dict(incoming)
    for key in PRESERVE_TARGET_KEYS:
        if key in target:
            out[key] = target[key]
    # Older snapshots may omit this optional settings block. Replace therefore
    # preserves a destination block just as merge does; a fresh target keeps
    # the built-in defaults implicit.
    if "worktree_defaults" not in incoming and "worktree_defaults" in target:
        out["worktree_defaults"] = copy.deepcopy(target["worktree_defaults"])
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Executable-state consent (design §5)
# ─────────────────────────────────────────────────────────────────────────────


_PATHISH = re.compile(r"(?:^|(?<=\s))(~?/[^\s\"']+)")


def _command_paths(command: str) -> list:
    return [m.group(1) for m in _PATHISH.finditer(str(command or ""))]


def _broken_command_paths(command: str) -> list:
    """Absolute paths named by a hook command that do not exist on this machine.

    Hook commands are machine-absolute BY DESIGN (they point at scripts), so no
    transform rule owns them — which is exactly why a restored one is the most
    likely thing in the whole registry to be silently dead.
    """
    missing = []
    for candidate in _command_paths(command):
        if not Path(candidate).expanduser().exists():
            missing.append(candidate)
    return missing


#: Snapshot sections whose contents are EXECUTABLE CODE the restored machine
#: will run, mapped to the noun used in the consent prompt.
#:
#: * `connectors/` — `connectors/discovery.py` imports every drop-in `*.py` in
#:   the data home the next time anything touches the connector registry, so a
#:   restored file is executed in-process by the very next `hub` command.
#: * `mcp-servers/` — spawned as subprocesses by the harnesses hub writes MCP
#:   entries into.
#:
#: Both were being materialized by `apply_plan` while `collect_executable_state`
#: named only hooks, permission rules, and trust grants — so a snapshot could
#: install arbitrary code past a consent gate that never mentioned it.
CODE_DIR_KINDS = (("connectors", "connector"), ("mcp-servers", "mcp-server"))


def collect_code_dirs(snapshot_dir: Path, data_home: Path) -> list:
    """`[{kind, name, files, action}]` for every executable entry coming in.

    `action` is `new` (nothing here by that name), `overwrite` (present and at
    least one incoming file differs) or `identical` (byte-for-byte what is
    already installed). Only the first two are new code, so only those demand
    consent — re-running an accepted restore must not re-prompt.
    """
    out: list = []
    snapshot_dir = Path(snapshot_dir)
    data_home = Path(data_home)
    for section, kind in CODE_DIR_KINDS:
        root = snapshot_dir / section
        if not root.is_dir():
            continue
        grouped: dict = {}
        for rel, path in _iter_tree(root):
            try:
                source = _data_file_source(snapshot_dir, path)
            except RestoreError:
                continue
            grouped.setdefault(rel.split("/", 1)[0], []).append((rel, source))
        for name in sorted(grouped):
            files = sorted(rel for rel, _p in grouped[name])
            target_root = data_home / section
            entry_target = target_root / name
            if not entry_target.exists():
                action = "new"
            else:
                action = "identical"
                for rel, path in grouped[name]:
                    try:
                        target = _safe_join(target_root, rel)
                    except RestoreError:
                        continue
                    if not target.exists() or _sha256_file(path) != _sha256_file(target):
                        action = "overwrite"
                        break
            out.append(
                {
                    "kind": kind,
                    "section": section,
                    "name": name,
                    "files": files,
                    "action": action,
                }
            )
    return out


def collect_unverified_references(snapshot_dir: Path, data_home: Path) -> list:
    """`[{rel, target_rel, sha256}]` for every legacy reference still present
    as an actual symlink in `DATA_DIRS`.

    A snapshot written by the fixed backup code never contains one of these —
    a safe internal reference is materialized as a regular file before
    signing, so it is an ordinary, fully-attested entry by the time restore
    ever sees it. A real symlink surviving into this function is therefore
    always a snapshot from before that fix, or one hand-crafted afterward:
    either way its placement (which bytes land at this path) was never
    covered by `compute_tree_digest` or the manifest signature, so it is
    named for explicit consent instead of materializing silently.

    `data_home` is accepted for signature symmetry with `collect_code_dirs`
    (both are called the same way from `collect_executable_state`) but is not
    read here — a reference's authentication depends only on the snapshot
    that carries it, never on what is already installed on this machine.
    """
    del data_home
    out: list = []
    snapshot_dir = Path(snapshot_dir)
    for section in DATA_DIRS:
        root = snapshot_dir / section
        for rel, path in _iter_tree(root):
            if not path.is_symlink():
                continue
            try:
                source = _data_file_source(snapshot_dir, path)
            except RestoreError:
                continue
            out.append(
                {
                    "rel": section + "/" + rel,
                    "target_rel": source.relative_to(snapshot_dir).as_posix(),
                    "sha256": _sha256_file(source),
                }
            )
    return out


def collect_executable_state(
    registry: dict,
    *,
    snapshot_dir: Optional[Path] = None,
    data_home: Optional[Path] = None,
) -> dict:
    """Every hook, permission rule, Codex trust grant, and executable dir installed.

    `snapshot_dir`/`data_home` are optional so the registry-only callers (and the
    tests of the registry legs) stay unchanged; when both are given, the
    incoming `connectors/` + `mcp-servers/` entries are enumerated too and count
    toward consent.
    """
    hooks: list = []
    hook_block = registry.get("hooks")
    if isinstance(hook_block, dict):
        for name in sorted(hook_block):
            block = hook_block[name]
            if not isinstance(block, dict):
                continue
            command = str(block.get("command") or "")
            broken = _broken_command_paths(command)
            hooks.append(
                {
                    "name": name,
                    "event": block.get("event") or "",
                    "command": command,
                    "harnesses": block.get("harnesses"),
                    "broken": bool(broken),
                    "missing_paths": broken,
                    "attached_global": name
                    in list(registry.get("hooks_global") or []),
                    "attached_projects": sorted(
                        p
                        for p, cfg in (registry.get("projects") or {}).items()
                        if isinstance(cfg, dict) and name in (cfg.get("hooks") or [])
                    ),
                }
            )

    rules: list = []
    trust: list = []

    def _rules_from(block: Any, scope: str) -> list:
        out = []
        if not isinstance(block, dict):
            return out
        for kind in ("allow", "deny", "ask"):
            for rule in block.get(kind) or []:
                if isinstance(rule, dict):
                    pattern = str(rule.get("pattern") or "")
                elif isinstance(rule, str):
                    pattern = rule
                else:
                    continue
                out.append({"scope": scope, "kind": kind, "pattern": pattern})
        return out

    rules.extend(_rules_from(registry.get("permissions_global"), "global"))
    for proj_name in sorted(registry.get("projects") or {}):
        cfg = (registry.get("projects") or {})[proj_name]
        if not isinstance(cfg, dict):
            continue
        proj_rules = _rules_from(cfg.get("permissions"), "project:" + proj_name)
        proj_rules += _rules_from(
            cfg.get("permissions_local"), "project-local:" + proj_name
        )
        rules.extend(proj_rules)
        block = cfg.get("permissions") if isinstance(cfg.get("permissions"), dict) else {}
        explicit = block.get("project_trust") is True
        translatable = [
            r for r in proj_rules if _BASH_RULE_RE.match(r["pattern"] or "")
        ]
        if explicit or translatable:
            trust.append(
                {
                    "project": proj_name,
                    "path": cfg.get("path"),
                    "explicit": bool(explicit),
                    "reason": (
                        "permissions.project_trust is true"
                        if explicit
                        else "has "
                        + str(len(translatable))
                        + " translatable Bash rule(s); sync auto-grants Codex "
                        "trust_level = trusted so they load"
                    ),
                }
            )

    code_dirs: list = []
    references_unverified: list = []
    if snapshot_dir is not None and data_home is not None:
        code_dirs = collect_code_dirs(snapshot_dir, data_home)
        references_unverified = collect_unverified_references(snapshot_dir, data_home)
    incoming_code = [d for d in code_dirs if d["action"] != "identical"]

    return {
        "hooks": hooks,
        "permission_rules": rules,
        "codex_trust": trust,
        "code_dirs": code_dirs,
        "references_unverified": references_unverified,
        "any": bool(hooks or rules or trust or incoming_code or references_unverified),
        "broken_hooks": [h["name"] for h in hooks if h["broken"]],
    }


def collect_machine_absolute(
    registry: dict, *, rewritten_fields: frozenset = frozenset()
) -> list:
    """Carried absolute strings, per entry (design §5, audit #4).

    Row: `{"field": str, "value": str, "rewritten": bool}`.

    Every hook command in the registry is walked: the top-level library, and
    the `hooks` list of `permissions_global`, `projects.*.permissions` and
    `projects.*.permissions_local`. `projects.*.hook_settings` is walked too —
    it is the one hook-adjacent shape NO transform rule owns, because it is
    arbitrary third-party config at arbitrary depth under arbitrary keys, so it
    always travels verbatim and always needs a report line.

    `rewritten` is True for a row whose `field` is in `rewritten_fields`
    (`backup.tokenized_fields(portable)`) — the fields whose SNAPSHOT value
    carried `{DATA_HOME}` and were repaired for this machine. It is never
    inferred from the value's own prefix: a non-leading `~` spelling is never
    tokenized, and `_command_paths` truncates a path containing spaces. With
    the default empty set every row is `rewritten: False`. For a
    `_hook_list_commands` field (a permissions-block hook, never the
    top-level library), a command that splits into MORE than one row is never
    reported `rewritten: True` for any of them — `_command_paths`' whitespace
    split can silently truncate one of several path-ish fragments, so no
    single row can be pinned to the field's own tokenized evidence with
    confidence; they fall back to the honest "carried verbatim; verify on
    this machine" wording until a `shlex`-based follow-up can parse the
    command properly (review 4b #9).
    """
    out: list = []
    home_path = Path.home().resolve()

    def _worktree_rewritten(value: str, trail: str) -> bool:
        if trail not in rewritten_fields:
            return False
        if trail != "worktree_defaults.base_dir":
            return True
        expanded = Path(value).expanduser().resolve(strict=False)
        try:
            expanded.relative_to(home_path)
        except ValueError:
            # A HOME token can resolve through a symlink to a machine path
            # outside HOME. Report the effective path for review.
            return False
        return True

    def _abs_strings(node: Any, trail: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                _abs_strings(value, trail + "." + str(key))
        elif isinstance(node, list):
            for index, value in enumerate(node):
                _abs_strings(value, trail + "[" + str(index) + "]")
        elif isinstance(node, str) and (node.startswith("/") or node.startswith("~/")):
            out.append(
                {"field": trail, "value": node, "rewritten": _worktree_rewritten(node, trail)}
            )

    def _hook_list_commands(hooks: Any, trail: str) -> None:
        if not isinstance(hooks, list):
            return
        for index, hook in enumerate(hooks):
            if not isinstance(hook, dict):
                continue
            field = trail + "[" + str(index) + "].command"
            command = str(hook.get("command") or "")
            paths = _command_paths(command)
            confident = len(paths) <= 1
            for path in paths:
                out.append(
                    {
                        "field": field,
                        "value": path,
                        "rewritten": confident and field in rewritten_fields,
                    }
                )

    hook_block = registry.get("hooks")
    if isinstance(hook_block, dict):
        for name in sorted(hook_block):
            block = hook_block[name]
            if not isinstance(block, dict):
                continue
            field = "hooks." + name + ".command"
            command = str(block.get("command") or "")
            for path in _command_paths(command):
                out.append(
                    {"field": field, "value": path, "rewritten": field in rewritten_fields}
                )

    for proj_name in sorted(registry.get("projects") or {}):
        cfg = (registry.get("projects") or {})[proj_name]
        if not isinstance(cfg, dict):
            continue
        _abs_strings(cfg.get("hook_settings"), "projects." + proj_name + ".hook_settings")
        for key in ("permissions", "permissions_local"):
            block = cfg.get(key)
            if isinstance(block, dict):
                _abs_strings(
                    block.get("additional_dirs"),
                    "projects." + proj_name + "." + key + ".additional_dirs",
                )
                _hook_list_commands(
                    block.get("hooks"), "projects." + proj_name + "." + key + ".hooks"
                )
    global_block = registry.get("permissions_global")
    if isinstance(global_block, dict):
        _abs_strings(
            global_block.get("additional_dirs"), "permissions_global.additional_dirs"
        )
        _hook_list_commands(global_block.get("hooks"), "permissions_global.hooks")
    worktree_block = registry.get("worktree_defaults")
    if isinstance(worktree_block, dict):
        _abs_strings(worktree_block.get("base_dir"), "worktree_defaults.base_dir")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# The plan
# ─────────────────────────────────────────────────────────────────────────────


def _agent_file_candidates(
    name: str, harness_id: str, operation_context: object = None
) -> list:
    """Filenames a sub-agent `name` can have for `harness_id`, in preference order."""
    if operation_context is not None:
        layout = _backup._context_layout(operation_context, harness_id)
        if getattr(layout, "agent_format", None) == "toml":
            return [name + ".toml", name + ".toml.disabled"]
        return [name + ".md"]
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    harness = _harnesses.HARNESSES.get(harness_id)
    fmt = getattr(harness, "agent_format", None) if harness is not None else None
    if fmt == "toml":
        return [name + ".toml", name + ".toml.disabled"]
    return [name + ".md"]


def _three_way(src: Path, target: Optional[Path], force: bool) -> dict:
    """Compare one snapshot file against its target. Never writes.

    `identical → skip` keeps a re-run quiet; `missing → write` is the whole
    point; `differs → sibling` is the honest default, because silently
    overwriting a file the user edited on THIS machine is the one outcome a
    restore must never produce by accident.
    """
    if target is None:
        return {"action": "unsupported", "detail": "no target for this harness here"}
    if not target.exists():
        return {"action": "write", "detail": "not present on this machine"}
    if target.is_symlink():
        return {
            "action": "sibling",
            "detail": "target is a symlink — not followed; writing a sibling instead",
        }
    if _sha256_file(src) == _sha256_file(target):
        return {"action": "skip", "detail": "identical"}
    if force:
        return {"action": "overwrite", "detail": "--force: existing file backed up first"}
    return {
        "action": "sibling",
        "detail": "differs from the local file — written alongside it as "
        + target.name
        + ".from-backup",
    }


#: Suffixes a sub-agent filename can carry, LONGEST first so a disabled Codex
#: agent (`reviewer.toml.disabled`) is not mistaken for a `.toml` one.
_AGENT_SUFFIXES = (".toml.disabled", ".toml", ".md")


def _agent_name_from_filename(filename: str) -> str:
    """`reviewer.toml.disabled` → `reviewer`. Longest suffix first. Unknown
    suffix → the filename unchanged."""
    for suffix in _AGENT_SUFFIXES:
        if filename.endswith(suffix):
            return filename[: -len(suffix)]
    return filename


def companion_agent_claims(
    registry: dict, *, harness_id: str, agent_name: str
) -> list:
    """Every companions-ledger claim on `(agent_name, harness_id)`.

    Walks `ships_with.ledger_scopes(registry)` — `companions_global` plus every
    project's `companions` — and returns, sorted by `(scope, skill)`:

        {"scope": <project name | ships_with.GLOBAL_SCOPE>,
         "skill": <skill name>,
         "written": bool,
         "is_backfill": bool}

    A claim exists when `agent_name` appears in the entry's `agents` list —
    unconditionally, since that list survives into a v2 entry alongside
    `agent_state` (AGENTS.md §Data Model) — OR is a key in the entry's
    `agent_state`. When it is a v2 `agent_state` key AND `harness_id` is
    itself a key in that agent's `files` map, `written` is `bool(agent_state
    .files.<harness_id>.written)` — the flag `ships_with_reconcile` uses to
    decide whether it compares that file's bytes at all. When the v2 entry's
    `agent_state` exists but never recorded THIS harness (`harness_id` is not
    a key in `files`), the claim falls through to the entry's own `agents`
    list instead of disappearing — a harness this ledger never rendered to
    still claims the name, just with `written: false` (R3, review 4b #3).

    `is_backfill` is `entry.get("schema") != 2` — `ships_with_reconcile`'s own
    gate (`ships_with_reconcile.py:325`) for whether the NEXT `hub sync` still
    treats this skill's ledger entry as pre-v2. It is what `written: false`
    actually means for THIS claim: for a `is_backfill` claim, sync's
    `OP_AGENT_HASH`/`OP_AGENT_STALE` ops still resolve it (record the local
    file as written, or delete it) the moment they run; for a non-backfill
    (v2) `written: false` claim, sync's `already_present`/D9 path never
    touches it at all (review 4b #2).

    `[]` = nothing claims it.
    """
    claims: list = []
    for scope, container in ships_with.ledger_scopes(registry):
        for skill_name, entry in (container or {}).items():
            if not isinstance(entry, dict):
                continue
            v2_names = entry.get("agent_state") or {}
            v1_names = entry.get("agents") or []
            is_backfill = entry.get("schema") != 2
            if agent_name in v2_names:
                files = ships_with.agent_state(entry, agent_name).get("files") or {}
                if harness_id in files:
                    written = bool((files.get(harness_id) or {}).get("written"))
                elif agent_name in v1_names:
                    written = False
                else:
                    continue
            elif agent_name in v1_names:
                written = False
            else:
                continue
            claims.append(
                {
                    "scope": scope,
                    "skill": skill_name,
                    "written": written,
                    "is_backfill": is_backfill,
                }
            )
    claims.sort(key=lambda claim: (claim["scope"], claim["skill"]))
    return claims


def _companion_summary(claims: list, *, agent: str) -> Optional[dict]:
    """Claims → the row's `companion` value, or `None` for no claim.

        {"agent": str,                    # agent name, no file suffix
         "skills": [str, ...],            # sorted unique, every claim
         "scopes": [str, ...],            # sorted unique, every claim; "global"
                                           #   is the global ledger
         "written": bool,                 # True if ANY claim recorded a copy
                                           #   hub wrote
         "written_pairs": [{"skill", "scope"}, ...],   # `written: true` claims —
                                           #   each is a runnable resolve target
         "backfill_pairs": [{"skill", "scope"}, ...],  # `written: false`,
                                           #   pre-v2 (`schema` != 2) — the
                                           #   next `hub sync` still adopts or
                                           #   removes the file
         "d9_pairs": [{"skill", "scope"}, ...]}        # `written: false`, v2
                                           #   `already_present`/D9 — `hub
                                           #   sync` really does skip it

    The three `*_pairs` lists partition `claims` by (written, is_backfill) —
    every claim lands in exactly one — so the printer (`hub_cli/restore.py`)
    can phrase each bucket honestly instead of collapsing them into one
    `written` bit that speaks for the wrong bucket (review 4b #1/#2/#4).
    """
    if not claims:
        return None

    def _pairs(pred) -> list:
        unique = sorted({(c["skill"], c["scope"]) for c in claims if pred(c)})
        return [{"skill": skill, "scope": scope} for skill, scope in unique]

    return {
        "agent": agent,
        "skills": sorted({claim["skill"] for claim in claims}),
        "scopes": sorted({claim["scope"] for claim in claims}),
        "written": any(claim["written"] for claim in claims),
        "written_pairs": _pairs(lambda c: c["written"]),
        "backfill_pairs": _pairs(lambda c: not c["written"] and c["is_backfill"]),
        "d9_pairs": _pairs(lambda c: not c["written"] and not c["is_backfill"]),
    }


def _retained_extra_files(snapshot_section: Path, target_section: Path) -> list:
    """Files an OVERLAY restore leaves behind, per entry the snapshot also owns.

    STATED SEMANTICS: restore is an overlay, in BOTH modes. Materializing a
    snapshot's `skills/foo/` copies its files over the local ones; a file that
    exists in the local `foo/` and NOT in the snapshot is retained, not deleted —
    even under `--mode replace`, which is a REGISTRY mode and has never claimed
    to own the filesystem.

    That is deliberate rather than pending: deleting on a mode flag would make
    `replace` silently destroy hand-edits inside a skill the user still has,
    and the pre-restore safety copy only preserves files restore itself
    overwrites. So the divergence is REPORTED per file instead — the user can
    then delete what they meant to.

    Entries the snapshot does not carry at all are untouched and unreported:
    those are simply skills this machine has and the backup does not.
    """
    out: list = []
    snapshot_section = Path(snapshot_section)
    target_section = Path(target_section)
    if not snapshot_section.is_dir() or not target_section.is_dir():
        return out
    incoming = {rel for rel, path in _iter_tree(snapshot_section) if path.is_file()}
    entries = {rel.split("/", 1)[0] for rel in incoming}
    for entry in sorted(entries):
        local = target_section / entry
        if not local.is_dir():
            continue
        for rel, path in _iter_tree(local):
            if path.is_symlink() or not path.is_file():
                continue
            full = entry + "/" + rel
            if full not in incoming:
                out.append(full)
    return sorted(out)


def _load_snapshot_registry(snapshot_dir: Path) -> dict:
    try:
        data = yaml.safe_load((snapshot_dir / "registry.yaml").read_text()) or {}
    except OSError as exc:
        raise RestoreError("snapshot has no readable registry.yaml: " + str(exc))
    except yaml.YAMLError as exc:
        raise RestoreError("snapshot registry.yaml is unparseable: " + str(exc))
    if not isinstance(data, dict):
        raise RestoreError("snapshot registry.yaml is not a mapping")
    return data


def build_plan(
    snapshot: dict,
    *,
    target_registry: dict,
    mode: Optional[str],
    data_home: Path,
    code_home: Optional[Path],
    home: Path,
    force: bool = False,
    trust_new_key: bool = False,
    accept_executable_state: bool = False,
    pins: Optional[dict] = None,
    operation_context: object = None,
) -> dict:
    """The single structure both the dry-run print and the apply path consume."""
    # A DRY RUN must not touch the caller's registry, and `merge_registry` only
    # copies the top two levels — the per-project dicts are shared, so the
    # quarantine pass below was stamping `path_unresolved: true` straight into
    # the live registry object the CLI had just loaded. Anything that saved that
    # object afterwards (an `--apply` that later failed, a caller reusing it for
    # a second plan) persisted a quarantine nobody asked for.
    target_registry = copy.deepcopy(target_registry or {})

    snapshot_dir = Path(snapshot["dir"])
    manifest = _backup.read_manifest(snapshot_dir) or {}
    warnings: list = []
    errors: list = []

    # ── integrity FIRST: nothing past the manifest is trusted until these pass
    digest = _backup.verify_tree_digest(snapshot_dir)
    sig_verdict = _backup.verify_snapshot_signature(snapshot_dir)
    trust = classify_trust(
        sig_verdict,
        key=snapshot["key"],
        pins=pins if pins is not None else read_pins(data_home),
        trust_new_key=trust_new_key,
    )
    integrity = {
        "tree_digest": digest,
        "signature": sig_verdict,
        "trust": trust,
        "ok": bool(digest["ok"]) and bool(trust["ok"]),
    }
    plan: dict = {
        "ok": True,
        # `fatal` = the snapshot itself cannot be trusted (truncated tree, bad
        # signature, pin mismatch). Distinct from `ok`, which also goes False for
        # the consent-gated states a dry-run exists to SHOW you.
        "fatal": False,
        "schema_version": SCHEMA_VERSION,
        "apply": False,
        "operation_context_id": getattr(operation_context, "context_id", None),
        "source": snapshot["source"],
        "snapshot_dir": str(snapshot_dir),
        "fetch_detail": snapshot.get("detail"),
        "mode": mode,
        "force": bool(force),
        "integrity": integrity,
        "manifest": {
            "created_at": manifest.get("created_at"),
            "hostname": manifest.get("hostname"),
            "hub_version": manifest.get("hub_version"),
            "counts": manifest.get("counts") or {},
            "prefixes": manifest.get("prefixes") or {},
        },
        "warnings": warnings,
        "errors": errors,
    }
    # A hard integrity/trust failure stops here: nothing beyond `manifest.json`
    # is inspected, let alone written. Consent-gated states (a new signing key,
    # an unsigned snapshot) DO continue, because the whole point of the dry-run
    # is to show what you are being asked to accept.
    if not digest["ok"]:
        errors.append("integrity: " + str(digest["detail"]))
        plan["ok"] = False
        plan["fatal"] = True
        return plan
    if trust.get("hard"):
        errors.append("trust: " + str(trust["detail"]))
        plan["ok"] = False
        plan["fatal"] = True
        return plan
    if not trust["ok"]:
        errors.append("trust: " + str(trust["detail"]))
        plan["ok"] = False

    # ── registry ────────────────────────────────────────────────────────────
    portable = _load_snapshot_registry(snapshot_dir)
    incoming = _backup.from_portable(
        portable, data_home=data_home, code_home=code_home, home=home, collapse=True
    )
    diff = diff_registry(target_registry, incoming)
    populated = registry_is_populated(target_registry)
    plan["registry"] = {
        "target_populated": populated,
        "mode_required": bool(populated and not mode),
        "diff": diff,
    }
    if populated and not mode:
        errors.append(
            "the target registry already has content: +{added} entries, "
            "-{lost} entries that would be LOST, {conflicts} conflicting entries. "
            "Choose --mode replace (take the backup wholesale) or --mode merge "
            "(union, backup wins on conflict).".format(**diff["totals"])
        )
        plan["ok"] = False

    if mode == "merge":
        resolved = merge_registry(target_registry, incoming)
    else:
        resolved = replace_registry(target_registry, incoming)

    # ── project-path quarantine ─────────────────────────────────────────────
    projects_report: list = []
    for proj_name in sorted(resolved.get("projects") or {}):
        cfg = (resolved.get("projects") or {})[proj_name]
        if not isinstance(cfg, dict):
            continue
        raw = str(cfg.get("path") or "")
        expanded = Path(raw).expanduser()
        exists = expanded.is_dir()
        # An imported historical path is not evidence of local attachment.
        # Keep established target-only projects intact during a merge.
        unresolved_path = (
            proj_name in (incoming.get("projects") or {})
            or not exists or bool(cfg.get("path_unresolved"))
        )
        if unresolved_path:
            cfg["path_unresolved"] = True
        projects_report.append(
            {"name": proj_name, "path": raw, "resolved": str(expanded), "exists": exists,
             "attached": not unresolved_path}
        )
    unresolved = [p["name"] for p in projects_report if not p["attached"]]
    plan["projects"] = projects_report
    for name in unresolved:
        warnings.append(
            "project '"
            + name
            + "' has no validated local attachment — kept but QUARANTINED "
            "(path_unresolved: true). Sync skips it entirely; point it at the "
            "local checkout with `hub project edit-path " + name + " <path>`."
        )

    # ── bootstrap + pending reconcile ───────────────────────────────────────
    resolved["bootstrap"] = {
        "version": BOOTSTRAP_VERSION,
        "completed_at": _now_iso(),
        "restored_from": snapshot["source"],
        "restored_at": _now_iso(),
    }
    backup_cfg = _backup.load_backup_config(resolved)
    backup_cfg["pending_reconcile"] = True
    # Stamped so the doctor can age the hold: an un-acknowledged restore blocks
    # EVERY push, so one that has sat for weeks is a backup outage, not a state.
    backup_cfg["pending_reconcile_at"] = _now_iso()
    _backup.save_backup_config(resolved, backup_cfg)
    plan["resolved_registry"] = resolved

    # ── files from the snapshot tree ────────────────────────────────────────
    rejected: list = []
    data_plan: dict = {}
    for section in DATA_DIRS:
        root = snapshot_dir / section
        files = 0
        entries: list = []
        for rel, path in _iter_tree(root):
            if not path.is_symlink() and not path.is_file():
                continue
            try:
                _data_file_source(snapshot_dir, path)
                _data_destination(data_home, section + "/" + rel)
            except RestoreError as exc:
                rejected.append({"rel": section + "/" + rel, "reason": str(exc)})
                continue
            files += 1
        if root.is_dir():
            entries = sorted(p.name for p in root.iterdir() if p.name != ".git")
        data_plan[section] = {
            "entries": entries,
            "files": files,
            "retained": _retained_extra_files(root, data_home / section),
        }
    # Managed hook bodies are signed snapshot data, but are not reference
    # material.  Keep their validation and overlay pass separate from
    # DATA_DIRS so a hook symlink cannot inherit reference semantics.
    hooks_root = snapshot_dir / MANAGED_HOOKS_DIR
    hook_files = 0
    hook_entries: list = []
    hook_hashes: dict = {}
    if hooks_root.is_symlink():
        rejected.append(
            {"rel": MANAGED_HOOKS_DIR, "reason": "refusing symlink in managed hook snapshot"}
        )
    else:
        for rel, path in _iter_tree(hooks_root):
            if not path.is_symlink() and not path.is_file():
                continue
            try:
                source = _managed_hook_file_source(snapshot_dir, path)
                _data_destination(data_home, MANAGED_HOOKS_DIR + "/" + rel)
            except RestoreError as exc:
                rejected.append(
                    {"rel": MANAGED_HOOKS_DIR + "/" + rel, "reason": str(exc)}
                )
                continue
            hook_files += 1
            hook_hashes[rel] = _sha256_file(source)
    if hooks_root.is_dir() and not hooks_root.is_symlink():
        hook_entries = sorted(
            p.name for p in hooks_root.iterdir() if p.name != ".git"
        )
    data_plan[MANAGED_HOOKS_DIR] = {
        "entries": hook_entries,
        "files": hook_files,
        "file_hashes": hook_hashes,
        "retained": _retained_extra_files(
            hooks_root, data_home / MANAGED_HOOKS_DIR
        ),
    }
    plan["data"] = data_plan
    plan["rejected"] = rejected

    # ── sub-agents (three-way) ──────────────────────────────────────────────
    subagents: list = []
    for rel in manifest.get("subagents") or []:
        parts = str(rel).split("/")
        if len(parts) != 4 or parts[0] != "harness" or parts[2] != "agents":
            rejected.append({"rel": str(rel), "reason": "unexpected sub-agent path"})
            continue
        h_id, filename = parts[1], parts[3]
        src = snapshot_dir / rel
        if not src.is_file() or src.is_symlink():
            continue
        agents_dir = _backup.harness_agents_dir(
            h_id, operation_context, feature="restore"
        )
        target = (agents_dir / filename) if agents_dir is not None else None
        verdict = _three_way(src, target, force)
        if operation_context is not None:
            route = operation_context.route(h_id, "restore")
            verdict["route"] = {
                "status": getattr(route, "status", "unavailable"),
                "mode": getattr(route, "mode", "unavailable"),
            }
            if not _backup._backup_route_usable(operation_context, h_id, "restore"):
                verdict["retained"] = True
        agent_name = _agent_name_from_filename(filename)
        claims = companion_agent_claims(resolved, harness_id=h_id, agent_name=agent_name)
        subagents.append(
            {
                "rel": rel,
                "harness": h_id,
                "name": filename,
                "target": str(target) if target is not None else None,
                **verdict,
                "companion": _companion_summary(claims, agent=agent_name),
            }
        )

    # ── global docs (three-way) ─────────────────────────────────────────────
    global_docs: list = []
    for rel in manifest.get("global_docs") or []:
        parts = str(rel).split("/")
        if len(parts) != 3 or parts[0] != "global-docs":
            rejected.append({"rel": str(rel), "reason": "unexpected global-doc path"})
            continue
        h_id, filename = parts[1], parts[2]
        src = snapshot_dir / rel
        if not src.is_file() or src.is_symlink():
            continue
        if operation_context is None:
            from skill_hub.infrastructure.harnesses import harnesses as _harnesses

            harness = _harnesses.HARNESSES.get(h_id)
            target = _backup.harness_global_doc(harness) if harness is not None else None
        else:
            target = _backup.harness_global_doc(
                h_id, operation_context, feature="restore"
            )
        verdict = _three_way(src, target, force)
        if operation_context is not None:
            route = operation_context.route(h_id, "restore")
            verdict["route"] = {
                "status": getattr(route, "status", "unavailable"),
                "mode": getattr(route, "mode", "unavailable"),
            }
            if not _backup._backup_route_usable(operation_context, h_id, "restore"):
                verdict["retained"] = True
        global_docs.append(
            {
                "rel": rel,
                "harness": h_id,
                "name": filename,
                "target": str(target) if target is not None else None,
                **verdict,
            }
        )

    plan["subagents"] = subagents
    plan["global_docs"] = global_docs

    # ── links.json (restored LAST, filtered to links that can still resolve) ─
    plan["links"] = _plan_links(
        snapshot_dir, subagents, force=force, operation_context=operation_context
    )

    # ── executable state ────────────────────────────────────────────────────
    exec_state = collect_executable_state(
        resolved, snapshot_dir=snapshot_dir, data_home=data_home
    )
    exec_state["accepted"] = bool(accept_executable_state)
    exec_state["requires_consent"] = bool(exec_state["any"])
    plan["executable_state"] = exec_state
    if exec_state["any"] and not accept_executable_state:
        incoming_code = [
            d for d in (exec_state.get("code_dirs") or []) if d["action"] != "identical"
        ]
        unverified_refs = exec_state.get("references_unverified") or []
        errors.append(
            "this snapshot installs executable state ("
            + str(len(exec_state["hooks"]))
            + " hook(s), "
            + str(len(exec_state["permission_rules"]))
            + " permission rule(s), "
            + str(len(exec_state["codex_trust"]))
            + " Codex trust grant(s), "
            + str(len(incoming_code))
            + " executable dir(s) — connector/MCP-server code this machine will "
            "run, "
            + str(len(unverified_refs))
            + " unverified internal reference(s) — a legacy symlink whose target "
            "the snapshot signature never covered). Review the list above, then "
            "re-run with --accept-executable-state."
        )
        plan["ok"] = False
    for hook in exec_state["hooks"]:
        if hook["broken"]:
            warnings.append(
                "hook '"
                + hook["name"]
                + "' names script path(s) that do not exist here: "
                + ", ".join(hook["missing_paths"])
                + " — it will fail on every "
                + str(hook["event"] or "event")
                + " until you fix it"
            )

    # ── per-machine usage ledgers (written back only where this machine has none)
    plan["usage_ledgers"] = _plan_usage_ledgers(snapshot_dir, data_home)

    # ── reporting ───────────────────────────────────────────────────────────
    plan["report"] = _build_report(
        resolved,
        manifest,
        projects_report,
        data_plan,
        rewritten_fields=(
            _backup.tokenized_fields(portable)
            | _backup.tokenized_fields(portable, _backup.TOKEN_HOME)
        ),
        usage_plan=plan["usage_ledgers"],
    )
    plan["next_steps"] = _next_steps(plan)
    return plan


def _plan_links(
    snapshot_dir: Path,
    subagents: list,
    *,
    force: bool,
    operation_context: object = None,
) -> dict:
    """Which linked-twin entries can survive on this machine, and which cannot.

    A link whose member agent file did not land is not a link — it is a dangling
    membership record that would make `hub subagent link-status` lie. Those are
    dropped and named.
    """
    src = snapshot_dir / "state" / "subagents" / "links.json"
    out = {"restored": [], "dropped": [], "retained": [], "present": src.is_file()}
    if not src.is_file():
        return out
    try:
        data = json.loads(src.read_text())
    except (OSError, ValueError) as exc:
        out["error"] = "links.json unreadable (" + str(exc) + ") — skipped"
        return out
    entries = data.get("links") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        out["error"] = "links.json malformed (no links array) — skipped"
        return out

    landed = {
        (item["harness"], item["name"])
        for item in subagents
        if item.get("action") in ("write", "overwrite", "skip")
    }
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        name = str(entry["name"])
        scope = str(entry.get("scope") or "user")
        members = [str(h) for h in (entry.get("harnesses") or [])]
        if operation_context is not None and any(
            not _backup._backup_route_usable(operation_context, h_id, "restore") for h_id in members
        ):
            out["retained"].append({
                "name": name, "scope": scope, "harnesses": members,
                "reason": "member restore route unavailable; existing ownership retained",
            })
            continue
        missing = []
        for h_id in members:
            agents_dir = _backup.harness_agents_dir(
                h_id, operation_context, feature="restore"
            )
            candidates = _agent_file_candidates(name, h_id, operation_context)
            landed_here = any((h_id, fname) in landed for fname in candidates)
            on_disk = agents_dir is not None and any(
                (agents_dir / fname).exists() for fname in candidates
            )
            if not landed_here and not on_disk:
                missing.append(h_id)
        if missing:
            out["dropped"].append(
                {
                    "name": name,
                    "scope": scope,
                    "harnesses": members,
                    "reason": "member agent file(s) did not land for: "
                    + ", ".join(missing),
                }
            )
        else:
            out["restored"].append({"name": name, "scope": scope, "harnesses": members})
    return out


_HOST_PLACEHOLDER = "{hostname}"


def _usage_ledger_rows() -> list:
    """The `MANIFEST` rows that land under `usage/` in the snapshot, most
    specific literal prefix first — `usage/{hostname}.jsonl` would otherwise
    also match `usage/sessions-<host>.jsonl`."""
    rows = [
        row
        for row in _backup.MANIFEST
        if row.backup and row.snapshot_as and row.snapshot_as.startswith("usage/")
    ]
    rows.sort(key=lambda r: len(r.snapshot_as.split(_HOST_PLACEHOLDER)[0]), reverse=True)
    return rows


def _match_usage_ledger(rel: str, rows: list) -> Optional[tuple]:
    """`(row, hostname)` for a snapshot path under `usage/`, or None."""
    for row in rows:
        prefix, suffix = row.snapshot_as.split(_HOST_PLACEHOLDER, 1)
        if rel.startswith(prefix) and rel.endswith(suffix) and len(rel) > len(prefix) + len(suffix):
            return row, rel[len(prefix) : len(rel) - len(suffix)]
    return None


def _plan_usage_ledgers(
    snapshot_dir: Path, data_home: Path, hostname: Optional[str] = None
) -> dict:
    """Decide which per-machine usage ledgers to write back.

    A ledger is an append-only record of one machine. Restore writes a
    snapshot copy back ONLY when this machine has no ledger of that kind yet
    (missing or empty) — a reinstalled machine gets its history back, an
    established one is never overwritten or merged. The copy comes from the
    file for this hostname; when the snapshot holds exactly one machine, that
    machine's file is taken instead. Several other machines is ambiguous and
    reported, not guessed.
    """
    hostname = hostname or _backup.safe_hostname()
    rows = _usage_ledger_rows()
    by_entry: dict = {row.entry: {} for row in rows}
    usage_root = Path(snapshot_dir) / "usage"
    if usage_root.is_dir():
        for path in sorted(usage_root.iterdir()):
            if path.is_symlink() or not path.is_file():
                continue
            hit = _match_usage_ledger("usage/" + path.name, rows)
            if hit is None:
                continue
            row, host = hit
            by_entry[row.entry][host] = "usage/" + path.name
    restored: list = []
    skipped: list = []
    for row in rows:
        hosts = by_entry[row.entry]
        target = Path(data_home) / row.entry
        if not hosts:
            skipped.append({"entry": row.entry, "reason": "not in snapshot"})
            continue
        if target.exists() and (target.is_symlink() or target.stat().st_size > 0):
            skipped.append(
                {
                    "entry": row.entry,
                    "reason": "this machine has its own ledger",
                    "hosts": sorted(hosts),
                }
            )
            continue
        if hostname in hosts:
            host = hostname
        elif len(hosts) == 1:
            host = next(iter(hosts))
        else:
            skipped.append(
                {
                    "entry": row.entry,
                    "reason": "several machines in the snapshot, none is this one",
                    "hosts": sorted(hosts),
                }
            )
            continue
        restored.append(
            {
                "entry": row.entry,
                "rel": hosts[host],
                "host": host,
                "target": str(target),
                "action": "write",
            }
        )
    return {"hostname": hostname, "restored": restored, "skipped": skipped}


def _usage_ledgers_note(usage_plan: Optional[dict]) -> Optional[str]:
    if not usage_plan:
        return None
    restored = usage_plan.get("restored") or []
    skipped = usage_plan.get("skipped") or []
    in_snapshot = [s for s in skipped if s.get("reason") != "not in snapshot"]
    if not restored and not in_snapshot:
        return None
    parts = []
    if restored:
        hosts = sorted({r["host"] for r in restored})
        parts.append(
            str(len(restored))
            + " usage ledger(s) written back from "
            + ", ".join(hosts)
            + " — this machine had none: "
            + ", ".join(r["entry"] for r in restored)
        )
    kept = [s for s in in_snapshot if s["reason"] == "this machine has its own ledger"]
    if kept:
        parts.append(
            "this machine keeps its own "
            + ", ".join(s["entry"] for s in kept)
            + " — a ledger is never merged or overwritten; the snapshot copies stay "
            "readable in the backup repo"
        )
    ambiguous = [s for s in in_snapshot if s["reason"].startswith("several")]
    if ambiguous:
        parts.append(
            "not written back — the snapshot holds ledgers from several machines ("
            + ", ".join(sorted({h for s in ambiguous for h in s.get("hosts") or []}))
            + ") and none is this one ("
            + str(usage_plan.get("hostname"))
            + "): "
            + ", ".join(s["entry"] for s in ambiguous)
        )
    return "; ".join(parts)


def _build_report(
    resolved: dict,
    manifest: dict,
    projects_report: list,
    data_plan: Optional[dict] = None,
    *,
    rewritten_fields: frozenset = frozenset(),
    usage_plan: Optional[dict] = None,
) -> dict:
    """Everything the snapshot could NOT carry, named per entry."""
    secret_refs = []
    for remote_id in sorted(resolved.get("remotes") or {}):
        cfg = (resolved.get("remotes") or {})[remote_id]
        if isinstance(cfg, dict) and cfg.get("secret_ref"):
            secret_refs.append(
                {
                    "remote": remote_id,
                    "secret_ref": cfg["secret_ref"],
                    "fix": "printf '%s' \"$NEW_TOKEN\" | hub remote rotate-token "
                    + remote_id,
                }
            )

    redacted = []
    for skill_name in sorted(resolved.get("skills") or {}):
        cfg = (resolved.get("skills") or {})[skill_name]
        if not isinstance(cfg, dict):
            continue
        mcp = cfg.get("mcp") if isinstance(cfg.get("mcp"), dict) else None
        if not isinstance(mcp, dict):
            continue
        # Widened alongside `redact_mcp_secrets` (M6, plans/B.md wave B):
        # `mcp.env`, `mcp.headers`, and the query string of `mcp.url` are all
        # redacted on the way out, so this notice must name all three fields,
        # not just `env` — an operator following only the old advice would
        # miss a redacted header or restore a broken `?{REDACTED}` url with
        # no warning at all.
        env = mcp.get("env") if isinstance(mcp.get("env"), dict) else {}
        headers = mcp.get("headers") if isinstance(mcp.get("headers"), dict) else {}
        keys = sorted(k for k, v in env.items() if v == _backup.REDACTED)
        keys += sorted(f"headers.{k}" for k, v in headers.items() if v == _backup.REDACTED)
        url = mcp.get("url")
        if isinstance(url, str) and url.endswith(f"?{_backup.REDACTED}"):
            keys.append("url.query")
        if keys:
            redacted.append({"skill": skill_name, "keys": keys})

    classification = manifest.get("source_classification") or {}
    dangling_sources = [
        {"skill": name, "class": info.get("class")}
        for name, info in sorted(classification.items())
        if isinstance(info, dict) and not info.get("in_snapshot")
    ]

    source_cmds = []
    for source_id in sorted(resolved.get("sources") or {}):
        cfg = (resolved.get("sources") or {})[source_id]
        if isinstance(cfg, dict) and (cfg.get("type") or "git") == "git" and cfg.get("url"):
            source_cmds.append(
                {"source": source_id, "command": "hub source restore " + source_id}
            )

    retained: list = []
    for section in sorted(data_plan or {}):
        for rel in (data_plan or {})[section].get("retained") or []:
            retained.append({"section": section, "path": rel})

    return {
        "dangling_secret_refs": secret_refs,
        "redacted_mcp_env": redacted,
        "dangling_skill_sources": dangling_sources,
        "external_connectors": manifest.get("external_connectors") or [],
        "nested_git": manifest.get("nested_git") or [],
        "unresolved_projects": [p["name"] for p in projects_report if not p["attached"]],
        "machine_absolute": collect_machine_absolute(
            resolved, rewritten_fields=rewritten_fields
        ),
        "source_restore_commands": source_cmds,
        "retained_extra_files": retained,
        # The snapshot carries `audit/<hostname>.jsonl` per machine so the
        # record survives a disk loss — but restore does NOT write any of them
        # back. A ledger is an append-only log of what happened ON one machine;
        # merging another machine's into this one's would fabricate history, and
        # overwriting this one's would erase it. They stay readable in the
        # snapshot repo. Documented, not restored.
        "audit_ledgers_note": (
            "per-machine audit ledgers (audit/<hostname>.jsonl in the snapshot) are "
            "NOT restored — this machine keeps its own state/audit.jsonl; read the "
            "others in the backup repo if you need them"
        )
        if (manifest.get("state_files") or manifest.get("counts", {}).get("state_files"))
        else None,
        # The usage ledgers travel per machine too. Unlike the audit ledger,
        # restore writes one back when THIS machine has none of that kind yet
        # (a reinstall) — never over an existing one. `_plan_usage_ledgers`
        # decides; this sentence reports the decision.
        "usage_ledgers_note": _usage_ledgers_note(usage_plan),
        "remote_baseline_note": (
            "remote ownership sidecars are machine-local and did NOT travel — the "
            "restored remotes have no baseline here, so the first sync reads as full "
            "drift; run `hub remote diff <id>` to see it and `hub remote resolve <id> "
            "--artifact <name> --op push|pull|keep-local|keep-remote` to settle each "
            "artifact before enabling remote sync"
        )
        if (resolved.get("remotes") or {})
        else None,
        "snapshot_warnings": manifest.get("warnings") or [],
    }


def _next_steps(plan: dict) -> list:
    steps: list = []
    for item in plan.get("report", {}).get("source_restore_commands") or []:
        steps.append(item["command"])
    if plan.get("report", {}).get("redacted_mcp_env"):
        steps.append("re-enter the redacted MCP env values (they never travel)")
    if plan.get("report", {}).get("dangling_secret_refs"):
        steps.append("re-provision each remote token (see dangling secret refs above)")
    if plan.get("report", {}).get("unresolved_projects"):
        steps.append(
            "`hub project edit-path <name> <path>` for each quarantined project"
        )
    steps.append("review the restored registry, then run `hub sync`")
    steps.append(
        "`hub backup now --acknowledge-restore` once you are happy — until then "
        "backup will not push over the snapshot you restored from"
    )
    return steps


# ─────────────────────────────────────────────────────────────────────────────
# Apply
# ─────────────────────────────────────────────────────────────────────────────


def _backup_root(data_home: Path, stamp: str) -> Path:
    return Path(data_home) / "_hub-backups" / "restore" / stamp


def _preserve(path: Path, backup_dir: Path, rel: str, taken: list) -> None:
    """Timestamped copy of a file about to be overwritten. Missing = no-op."""
    if not path.exists() or path.is_symlink():
        return
    dest = backup_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(path, dest)
        taken.append({"source": str(path), "backup": str(dest)})
    except OSError as exc:
        taken.append({"source": str(path), "backup": None, "error": str(exc)})


def apply_plan(
    plan: dict, *, data_home: Path, operation_context: object = None
) -> dict:
    """Materialize an approved plan; reject a plan that failed its consent gates.

    Order is deliberate: registry backup → data dirs → registry → out-of-home
    agent files → `links.json` LAST, because the link sidecar's validity depends
    on which agent files actually landed.
    """
    if not plan.get("ok"):
        raise RestoreError("restore plan is not approved; rebuild the plan with required consent")
    expected_context = plan.get("operation_context_id")
    if expected_context is not None or operation_context is not None:
        if not expected_context or expected_context != getattr(operation_context, "context_id", None):
            raise RestoreError("restore plan operation context changed; rebuild the plan")
        if Path(getattr(operation_context, "data_home")) != Path(data_home):
            raise RestoreError("restore operation context belongs to a different data home")
    data_home = Path(data_home)
    snapshot_dir = Path(plan["snapshot_dir"])
    stamp = _stamp()
    backup_dir = _backup_root(data_home, stamp)
    backups: list = []
    writes: list = []
    result = {
        "applied": True,
        "backup_dir": str(backup_dir),
        "backups": backups,
        "writes": writes,
        "warnings": list(plan.get("warnings") or []),
    }

    # 1. the registry's own pre-migration snapshot (same convention as every
    #    other breaking rewrite, so `_hub-backups/registry/` stays the one place
    #    to look for "the registry before X").
    try:
        if hub_core.registry_file().exists():
            result["registry_backup"] = str(hub_core._registry_migration_backup("pre-restore"))
    except OSError as exc:
        result["warnings"].append("could not back up registry.yaml: " + str(exc))

    # 2. data-home content
    # A legacy reference (an actual symlink under `DATA_DIRS`)
    # was named in the plan's `references_unverified`, pinned to a
    # `target_rel`/`sha256`. That pin is re-checked here, fresh, against the
    # snapshot on disk right now — not against the plan's own copy of those
    # fields — so a reference retargeted or added to the snapshot after the
    # preview was shown is refused rather than silently materialized.
    consented_refs = {
        r["rel"]: r
        for r in (plan.get("executable_state") or {}).get("references_unverified") or []
    }
    for section in DATA_DIRS:
        root = snapshot_dir / section
        if not root.is_dir():
            continue
        for rel, path in _iter_tree(root):
            if not path.is_symlink() and not path.is_file():
                continue
            full_rel = section + "/" + rel
            try:
                source = _data_file_source(snapshot_dir, path)
                target = _data_destination(data_home, full_rel)
            except RestoreError:
                continue
            if path.is_symlink():
                fresh_target_rel = source.relative_to(snapshot_dir).as_posix()
                fresh_sha256 = _sha256_file(source)
                expected = consented_refs.get(full_rel)
                if (
                    expected is None
                    or expected.get("target_rel") != fresh_target_rel
                    or expected.get("sha256") != fresh_sha256
                ):
                    result["warnings"].append(
                        "skipped unverified reference " + full_rel + ": it changed "
                        "since the plan was built — rebuild the plan to review it "
                        "again"
                    )
                    continue
                _preserve(target, backup_dir, full_rel, backups)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                writes.append(
                    {
                        "kind": "reference-unverified",
                        "target": str(target),
                        "target_rel": fresh_target_rel,
                        "sha256": fresh_sha256,
                    }
                )
                continue
            _preserve(target, backup_dir, full_rel, backups)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            writes.append({"kind": "data", "target": str(target)})

    # Managed hook bodies use a dedicated route.  They are signed snapshot
    # files, not internal references, so symlinks and symlinked directories
    # are refused by the same path checks used while building the plan.
    hooks_root = snapshot_dir / MANAGED_HOOKS_DIR
    if hooks_root.is_dir() and not hooks_root.is_symlink():
        planned_hook_hashes = (
            (plan.get("data") or {}).get(MANAGED_HOOKS_DIR) or {}
        ).get("file_hashes") or {}
        for rel, path in _iter_tree(hooks_root):
            if not path.is_file() or path.is_symlink():
                continue
            full_rel = MANAGED_HOOKS_DIR + "/" + rel
            try:
                source = _managed_hook_file_source(snapshot_dir, path)
                target = _data_destination(data_home, full_rel)
            except RestoreError:
                continue
            expected_hash = planned_hook_hashes.get(rel)
            if expected_hash is None:
                result["warnings"].append(
                    "skipped managed hook " + full_rel + ": it was not present "
                    "when the plan was built"
                )
                continue
            if _sha256_file(source) != expected_hash:
                result["warnings"].append(
                    "skipped managed hook " + full_rel + ": it changed since "
                    "the plan was built — rebuild the plan to review it again"
                )
                continue
            _preserve(target, backup_dir, full_rel, backups)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            writes.append({"kind": "managed-hook", "target": str(target)})

    # 2b. per-machine usage ledgers — only the ones the plan found this
    #     machine lacks; an existing ledger was already excluded there.
    for item in (plan.get("usage_ledgers") or {}).get("restored") or []:
        src = snapshot_dir / item["rel"]
        target = Path(item["target"])
        if not src.is_file() or (target.exists() and target.stat().st_size > 0):
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            writes.append({"kind": "usage-ledger", "target": str(target), "host": item["host"]})
        except OSError as exc:
            result["warnings"].append("could not write " + str(target) + ": " + str(exc))

    # 3. registry
    hub_core.save_registry(plan["resolved_registry"])
    writes.append({"kind": "registry", "target": str(hub_core.registry_file())})

    # 4. sub-agents + global docs (three-way, decided in the plan)
    for item in list(plan.get("subagents") or []) + list(plan.get("global_docs") or []):
        target_raw = item.get("target")
        if not target_raw or item["action"] in ("skip", "unsupported"):
            continue
        src = snapshot_dir / item["rel"]
        target = Path(target_raw)
        rel = item["rel"]
        if item["action"] == "sibling":
            target = target.with_name(target.name + ".from-backup")
            rel += ".from-backup"
        _preserve(target, backup_dir, rel, backups)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            writes.append({"kind": "agent-file", "target": str(target), "action": item["action"]})
        except OSError as exc:
            result["warnings"].append("could not write " + str(target) + ": " + str(exc))

    # 5. links.json LAST — merged by (name, scope) with whatever is already here.
    links_plan = plan.get("links") or {}
    if links_plan.get("restored"):
        from skill_hub.infrastructure.harnesses import subagent_links

        existing, _warn = subagent_links.read_links(context=operation_context)
        by_key = {(e.get("name"), e.get("scope") or "user"): e for e in existing}
        for entry in links_plan["restored"]:
            by_key[(entry["name"], entry["scope"])] = {
                "name": entry["name"],
                "scope": entry["scope"],
                "harnesses": list(entry["harnesses"]),
            }
        merged = [by_key[k] for k in sorted(by_key, key=lambda k: (str(k[0]), str(k[1])))]
        subagent_links.write_links(merged, context=operation_context)
        writes.append({"kind": "links", "target": str(subagent_links._links_file(operation_context))})

    # 6. TOFU: pin the signer we just accepted, so the NEXT restore from this
    #    source is checked against it rather than asked about again.
    trust = (plan.get("integrity") or {}).get("trust") or {}
    signature = (plan.get("integrity") or {}).get("signature") or {}
    if trust.get("state") in (TRUST_NEW_KEY, TRUST_VERIFIED) and signature.get("pubkey"):
        write_pin(
            source_key(plan["source"]), signature["pubkey"], data_home=data_home
        )
        result["pinned"] = signature.get("key_id")

    result["backup_dir"] = str(backup_dir) if backups else None
    return result


# ─────────────────────────────────────────────────────────────────────────────
# `hub source restore` (design §6)
# ─────────────────────────────────────────────────────────────────────────────


def source_transport_attempts(url: str, registry: dict) -> list[dict]:
    """Return the source's normal transport plus one bounded GitHub fallback."""
    repo = _github_repo(url)
    if not repo:
        return [{"method": "configured", "url": str(url), "args": [], "env": {}}]

    config = _backup.load_backup_config(registry)
    auth = _backup.detect_auth(config.get("auth"), non_mutating=True)
    return _backup_git.github_read_transports(repo, str(url), auth)


_source_transport_attempts = source_transport_attempts


def _ssh_auth_failure(proc) -> bool:
    """Whether a failed Git invocation is safe to retry over HTTPS."""
    detail = ((proc.stderr or "") + "\n" + (proc.stdout or "")).lower()
    return any(
        marker in detail
        for marker in (
            "permission denied (publickey)",
            "permission denied",
            "publickey",
            "authentication failed",
        )
    )


def _redact_git_detail(detail: str) -> str:
    """Keep one useful Git error line without returning embedded credentials."""
    line = (detail or "git clone failed").strip().splitlines()[0]
    line = re.sub(r"(https?://)[^/\s@]+@", r"\1<redacted>@", line)
    line = re.sub(r"([?&](?:token|access_token|password|secret|pat)=)[^&\s]+", r"\1<redacted>", line, flags=re.I)
    line = re.sub(r"(?:gh[pousr]_[A-Za-z0-9_\-]+|github_pat_[A-Za-z0-9_\-]+)", "<redacted>", line)
    return line[:300]


def restore_source(
    registry: dict, source_id: str, *, data_home: Optional[Path] = None
) -> dict:
    """Re-clone one registered git source into its cache. Idempotent when healthy.

    `sources/` deliberately never travels in a snapshot (it is a re-derivable
    clone of someone else's repo), and `hub source sync` FAILS on a missing
    cache — so this is the ONLY recovery path for a restored machine's git
    sources, and restore prints one of these commands per registered source.
    """
    cfg = (registry.get("sources") or {}).get(source_id)
    if not isinstance(cfg, dict):
        raise RestoreError("source '" + source_id + "' not found")
    if (cfg.get("type") or "git") != "git":
        raise RestoreError("source '" + source_id + "' is not a git source")
    url = cfg.get("url")
    if not url:
        raise RestoreError("source '" + source_id + "' has no url to re-clone from")

    cache = Path(cfg.get("cache") or str(sources.source_worktree_dir(source_id))).expanduser()
    branch = cfg.get("branch")
    wanted_ref = cfg.get("current_ref")

    if (cache / ".git").exists():
        head = _git("rev-parse", "HEAD", cwd=cache)
        if head.returncode == 0:
            return {
                "ok": True,
                "source": source_id,
                "cache": str(cache),
                "cloned": False,
                "ref": (head.stdout or "").strip() or None,
                "detail": "cache is already present and healthy — nothing to do",
            }
        shutil.rmtree(cache, ignore_errors=True)
    elif cache.exists():
        # A leftover non-repo dir would make `git clone` fail with a confusing
        # "already exists"; it holds nothing we can recover, so it goes.
        shutil.rmtree(cache, ignore_errors=True)

    cache.parent.mkdir(parents=True, exist_ok=True)
    transports = source_transport_attempts(str(url), registry)
    attempts: list[dict] = []
    selected: Optional[dict] = None
    for index, transport in enumerate(transports):
        args = [*transport["args"], "clone", "--quiet", "--depth", "1"]
        if branch:
            args += ["--branch", str(branch)]
        args += [transport["url"], str(cache)]
        clone_kwargs = {"env_overrides": transport["env"]} if transport["env"] else {}
        cloned = _git(*args, **clone_kwargs)
        if cloned.returncode == 0:
            selected = transport
            break
        attempts.append(
            {
                "transport": transport["method"],
                "error": _redact_git_detail(cloned.stderr or cloned.stdout),
            }
        )
        # Only SSH authentication failures may cross the transport boundary;
        # network, repository, and branch errors remain single-attempt errors.
        if index + 1 >= len(transports) or transport["method"] != "ssh" or not _ssh_auth_failure(cloned):
            break
        shutil.rmtree(cache, ignore_errors=True)

    if selected is None:
        shutil.rmtree(cache, ignore_errors=True)
        summary = "; ".join(
            item["transport"] + ": " + item["error"] for item in attempts
        )
        raise RestoreError(
            "could not clone source '"
            + source_id
            + "' ("
            + (summary or "git clone failed")
            + ")",
            details={"source": source_id, "attempts": attempts},
        )

    detail = "re-cloned " + str(url)
    if selected["method"] != "ssh" and attempts:
        detail += " using GitHub HTTPS after SSH authentication failed"
    ref_proc = _git("rev-parse", "HEAD", cwd=cache)
    ref = (ref_proc.stdout or "").strip() or None
    if wanted_ref and ref != wanted_ref:
        # A depth-1 clone cannot contain an arbitrary older commit; fetching the
        # exact one is best-effort, and landing on the branch tip instead is a
        # reported outcome, not a silent one.
        fetch_kwargs = {"env_overrides": selected["env"]} if selected["env"] else {}
        deepen = _git(
            *selected["args"],
            "fetch",
            "--quiet",
            "--depth",
            "1",
            "origin",
            str(wanted_ref),
            cwd=cache,
            **fetch_kwargs,
        )
        if deepen.returncode == 0:
            checkout = _git("checkout", "--quiet", str(wanted_ref), cwd=cache)
            if checkout.returncode == 0:
                ref = str(wanted_ref)
                detail += " at the recorded ref"
        if ref != wanted_ref:
            detail += (
                " — the recorded ref " + str(wanted_ref)[:12] + " is not reachable in a "
                "shallow clone; landed on the branch tip instead"
            )

    cfg["cache"] = str(cache)
    cfg["current_ref"] = ref
    cfg["status"] = sources.SOURCE_STATUS_UP_TO_DATE
    cfg["error"] = None
    cfg["last_synced_at"] = _now_iso()
    cfg["last_checked_at"] = _now_iso()
    return {
        "ok": True,
        "source": source_id,
        "cache": str(cache),
        "cloned": True,
        "ref": ref,
        "detail": detail,
        "transport": selected["method"],
        "attempts": attempts,
    }
