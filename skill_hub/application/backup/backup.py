"""skill_hub/application/backup/backup.py — portable snapshot assembly + git backup backend.

Skill Tree's full state does NOT live in one place: the data home
(`~/.skill-hub/`) holds the registry + owned skills, but sub-agent definitions
and user-global agent docs live in the harness dirs (`~/.claude/agents/`,
`$CODEX_HOME/agents/`, …), and part of what IS in the data home must never be
copied (signing keys, machine-local caches, ~60 absolute paths in
`registry.yaml`).

Implements design v2 (`openspec/changes/backup-and-restore/design.md`). Five
responsibilities, each factored so the M3 restore wave can import it directly:

1. **One canonical manifest table** (§1) — `(entry, backup, migrate, secret)`
   rows consumed by backup, restore, AND `hub migrate-home`, plus an explicit
   unknown-entry policy: migrate MOVES unknown entries (a local move must never
   abandon user data), backup SKIPS them with a warning (never silently publish
   unknown content).
2. **Snapshot assembly** (§2) into a dedicated local git repo
   (default `~/.skill-tree-backup/`). Local working copy = local backup, push =
   cloud sync, git history = versioned backups.
3. **A FIELD-SCOPED path transform** (§3) — not a blanket string sweep. Each
   rule names a field path and the tokens it may produce; `projects.*.path` may
   only become `{HOME}` because on this machine one project's path IS the code
   home, and a blanket substitution would destroy it. Values are normalized to
   absolute form BEFORE tokenizing (most live skill sources are `~`-collapsed
   and match no absolute prefix otherwise).
4. **Secret + prefix exclusion as coded gates** (§3, §4) — allowlist assembly,
   `skills.*.mcp.env`/`mcp.headers`/`mcp.url` (query string) redaction, a
   `signing:` drop, a credential-shape content scan that refuses the commit
   with `file:line`, and a machine-prefix leak scan that proves the transform
   actually ran.

   Two STATED trade-offs in the content scan, both deliberate:

   * Only the first `SECRET_SCAN_MAX_BYTES` (2 MiB) of each file are read. A
     credential hiding past 2 MiB of a single file is not caught. The bound
     exists because the scan runs on every snapshot (i.e. on every sync) and an
     unbounded read over a large skill library would make backups feel broken;
     the allowlist assembly and the `state/signing` path exclusion are the real
     defenses, of which this scan is the third, independent layer.
   * A file containing a NUL byte in that window is treated as binary and gets
     the private-key-marker check ONLY — the regex passes are skipped. Decoding
     arbitrary binary as text produces replacement-character noise, not
     findings. Binary payloads therefore travel unscanned for token shapes;
     they still cannot carry a private key past the marker pass.
5. **Git ops + auth ladder** (§7) — a non-fast-forward is made structurally
   impossible (fetch → reset to the remote tip → rebuild the whole tree from the
   data home → commit), so hub never merges and never force-pushes. Auth is
   ssh → PAT for pushing, `gh` for repo creation only; a PAT reaches git through
   an inline credential helper naming an env var, so the token is never in argv,
   in the remote URL, or in any file.

Stdlib only (Python 3.9+). `keyring` is optional and reached through
`connectors/transport/keychain.py`, which degrades gracefully when it is absent.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import socket

# The git runner moved to backup_git.py, but the tests patch
# `backup.subprocess.run`; it is the same module object that
# `backup_git.git()` runs through, so the seam is real.
import subprocess  # noqa: F401
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import yaml

from skill_hub.application.backup import references as _references
from skill_hub.application.projects import worktree_defaults
from skill_hub.domain.mcp import mcp_spec
from skill_hub.hub_core import _now_iso
from skill_hub.infrastructure.backup.backup_git import (  # noqa: F401  (re-exported: `backup.<name>` must keep resolving)
    _PARKED_REF_PREFIX,
    _PAT_CREDENTIAL_HELPER,
    AUTH_METHODS,
    DEFAULT_BRANCH,
    GIT_IDENTITY_EMAIL,
    GIT_IDENTITY_NAME,
    INTERACTIVE_PUSH_TIMEOUT,
    KEYCHAIN_ACCOUNT,
    KEYCHAIN_SERVICE,
    KEYRING_MISSING_DETAIL,
    LOCAL_GIT_TIMEOUT,
    MANIFEST_FILE,
    MAX_PARKED_LOCAL_TIPS,
    NETWORK_TIMEOUT,
    PAT_SCOPE_HELP,
    PAT_SECRET_REF,
    PUSH_FAILURE_ALERT_THRESHOLD,
    PUSH_METHOD_ORDER,
    BackupError,
    GitError,
    _divergence,
    _gh_bin,
    _harden_dir,
    _is_https,
    _keychain,
    _parse_gh_login,
    _run,
    _save_local_tip,
    create_github_repo,
    delete_pat,
    detect_auth,
    get_pat,
    gh_active_login,
    git,
    git_adopt_remote_tip,
    git_ahead_behind,
    git_auth_options,
    git_commit,
    git_current_branch,
    git_init,
    git_is_dirty,
    git_last_commit,
    git_push,
    git_remote_url,
    git_set_remote,
    is_git_repo,
    keyring_available,
    local_tip_ref_name,
    manual_create_instructions,
    normalize_repo,
    parked_local_tips,
    probe_gh,
    probe_pat,
    probe_ssh,
    prune_local_tip_refs,
    ref_has_manifest,
    remote_tip_has_manifest,
    remote_url_for,
    store_pat,
)

SCHEMA_VERSION = 1


# ─────────────────────────────────────────────────────────────────────────────
# 1. Canonical data-home manifest — ONE table, not three lists (design §1)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ManifestRow:
    """One data-home entry and what each consumer does with it.

    `entry` is a data-home-relative path (a top-level name, or a nested path for
    the `state/` carve-outs). `snapshot_as` overrides where it lands inside the
    snapshot when the two differ.
    """

    entry: str
    backup: bool
    migrate: bool
    secret: bool = False
    snapshot_as: Optional[str] = None
    note: str = ""


MANIFEST: tuple = (
    ManifestRow("registry.yaml", True, True, note="stored in portable form (§3)"),
    ManifestRow("skills", True, True, note="nested .git is skipped + warned"),
    ManifestRow("mcp-servers", True, True),
    ManifestRow("snippets", True, True),
    ManifestRow("connectors", True, True, note="user-authored drop-in connector code"),
    ManifestRow("hooks", True, True, note="managed hook script bodies"),
    ManifestRow("state/subagents/links.json", True, True, note="linked-twin membership"),
    ManifestRow(
        "state/audit.jsonl",
        True,
        True,
        snapshot_as="audit/{hostname}.jsonl",
        note="per-machine so two machines never clobber each other's ledger",
    ),
    ManifestRow(
        "state/usage/history.jsonl",
        True,
        True,
        snapshot_as="usage/{hostname}.jsonl",
        note="per-machine so two machines never clobber each other's usage ledger",
    ),
    ManifestRow(
        "state/usage/sessions.jsonl",
        True,
        True,
        snapshot_as="usage/sessions-{hostname}.jsonl",
        note="per-machine so two machines never clobber each other's session ledger",
    ),
    ManifestRow(
        "state/usage/loadouts.jsonl",
        True,
        True,
        snapshot_as="usage/loadouts-{hostname}.jsonl",
        note="per-machine append-only loadout history",
    ),
    ManifestRow(
        "state/usage/inspection.sqlite3",
        False,
        True,
        note="private retained transcript evidence; local migration only",
    ),
    ManifestRow(
        "state/ssh/known_hosts",
        False,
        True,
        note="publishes raw IPs of private boxes; derived — ssh re-seeds from the registry pin",
    ),
    ManifestRow("state/signing", False, True, secret=True),
    ManifestRow("state/codex-workers", False, True, secret=True),
    ManifestRow("state", False, True, note="the rest of state/ is derived; migrate merges per child"),
    ManifestRow("sources", False, True, note="re-cloned by `hub source restore` (M3)"),
    ManifestRow("_hub-backups", False, True, note="the user's rollback snapshots — migrate MUST keep them"),
    ManifestRow("usage", False, True),
    ManifestRow(".lock", False, False),
)

#: Derived views. Keep these as the ONLY way other modules read the table.
DATA_HOME_PORTABLE = tuple(
    row.entry for row in MANIFEST if row.backup and "/" not in row.entry
)
DATA_HOME_STATE_PORTABLE = tuple(
    row.entry for row in MANIFEST if row.backup and row.entry.startswith("state/")
)
DATA_HOME_SECRET = tuple(row.entry for row in MANIFEST if row.secret)
DATA_HOME_DERIVED = tuple(
    row.entry for row in MANIFEST if not row.backup and not row.secret
)
#: Top-level entries `hub migrate-home` knows about. Unknown entries are added
#: at call time by `migrate_entries()` — see the unknown-entry policy above.
MIGRATE_HOME_ENTRIES = tuple(
    row.entry for row in MANIFEST if row.migrate and "/" not in row.entry
)
#: Entries whose target collision is resolved per CHILD rather than skipped
#: wholesale — a non-empty target `state/` must never strand the legacy signing
#: keys at the old home.
MIGRATE_MERGE_ENTRIES = ("state",)
#: Never moved, never snapshotted.
MIGRATE_SKIP_PATTERNS = (".lock", ".DS_Store")


def snapshot_row(entry: str) -> Optional[ManifestRow]:
    for row in MANIFEST:
        if row.entry == entry:
            return row
    return None


def migrate_entries(legacy: Path) -> list:
    """Ordered entries `hub migrate-home` should move out of `legacy`.

    Known rows first (deterministic), then any UNKNOWN top-level entry — a local
    move must never abandon data just because this table has not heard of it.
    """
    known = list(MIGRATE_HOME_ENTRIES)
    out = list(known)
    try:
        present = sorted(p.name for p in Path(legacy).iterdir())
    except OSError:
        return out
    skip = set(known) | {row.entry for row in MANIFEST if "/" not in row.entry}
    for name in present:
        if name in skip or name in MIGRATE_SKIP_PATTERNS:
            continue
        if name.startswith(".bak-") or ".bak-" in name:
            continue
        out.append(name)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 2. Snapshot layout (design §2)
# ─────────────────────────────────────────────────────────────────────────────

#: Where a NEW backup's local working copy is created.
#:
#: The product is Skill Tree; `hub` is the CLI. A user who opens the Backup
#: screen, reads "skill-tree-backup" as the suggested repo name, and then sees
#: `~/.skill-hub-backup` on disk has to work out that these are the same
#: product. Only NEW inits are affected: `backup.dir` is recorded in the
#: registry at init time and every later read honours whatever is stored there
#: (see `backup_config`), so no existing install moves.
#:
#: Deliberately NOT renamed alongside it: `KEYCHAIN_SERVICE` /
#: `KEYCHAIN_ACCOUNT` (a token is already stored under those in the wild) and
#: `SIGNING_NAMESPACE` (pinned signing keys are looked up by it).
DEFAULT_BACKUP_DIR = "~/.skill-tree-backup"
#: `DEFAULT_BRANCH` now lives in backup_git.py (imported above) — the git
#: layer is the one that needs it at `git init` time.

#: Top-level entries in the backup repo hub owns and fully regenerates on every
#: snapshot (so a deletion here propagates). Everything else — notably `.git/` —
#: is left alone.
SNAPSHOT_OWNED = (
    "manifest.json",
    "manifest.sig",
    "registry.yaml",
    ".gitignore",
    ".gitattributes",
    "skills",
    "mcp-servers",
    "snippets",
    "connectors",
    "state",
    "audit",
    "harness",
    "global-docs",
)

_COPY_EXCLUDE_NAMES = {".git", ".DS_Store", "__pycache__", ".lock"}
_HOSTNAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")

#: `manifest.json` records the tree digest, so it cannot be part of it; the
#: signature is taken OVER the finished manifest, so it cannot either. Both are
#: therefore excluded from `compute_tree_digest` and verified by their own step.
#: (`MANIFEST_FILE` now lives in backup_git.py — the git layer identifies a
#: Skill Tree tip by it.)
SIGNATURE_FILE = "manifest.sig"
#: `.gitattributes` pins `* -text` so no checkout on any platform can rewrite
#: line endings (or decay a symlink into a text file) underneath us. It is
#: excluded from the tree digest for the same reason the manifest is: it exists
#: to protect the bytes the digest covers, and a git-normalized copy of it on a
#: `core.autocrlf=true` clone must not be able to invalidate an otherwise intact
#: snapshot.
GITATTRIBUTES_FILE = ".gitattributes"
DIGEST_EXCLUDED = (MANIFEST_FILE, SIGNATURE_FILE, GITATTRIBUTES_FILE)

#: SSHSIG binds a signature to a namespace, so a manifest signature can never be
#: replayed as a remote-connector manifest signature (which uses signing.py's
#: default namespace).
SIGNING_NAMESPACE = "skill-hub-backup"

GITIGNORE_BODY = """\
# Managed by Skill Tree (`hub backup`). Defensive only — snapshot assembly is
# allowlist-driven and every file is re-scanned for credentials and for leaked
# machine paths before each commit, so nothing below should ever be produced.
state/signing/
state/codex-workers/
state/ssh/
sources/
/usage/latest-ccusage.json
_hub-backups/
*.lock
.DS_Store
*.pem
*.key
id_rsa*
id_ecdsa*
id_ed25519*
!*.pub
"""

#: Managed by hub, written into every snapshot. `* -text` disables git's
#: end-of-line normalization for the WHOLE tree: on a machine with
#: `core.autocrlf=true` (a Windows default) a checkout would otherwise rewrite
#: every LF to CRLF, changing the bytes of files whose sha256 the manifest
#: records — and `verify_tree_digest` would then reject an intact snapshot as
#: "incomplete" with no way for the user to see why.
GITATTRIBUTES_BODY = """\
# Managed by Skill Tree (`hub backup`). The manifest records a sha256 per file,
# so git must hand every file back byte-for-byte: no EOL normalization, no
# text/binary guessing, on any platform.
* -text
"""

# ─────────────────────────────────────────────────────────────────────────────
# 3. Path-portability transform — FIELD-SCOPED (design §3)
# ─────────────────────────────────────────────────────────────────────────────

TOKEN_DATA_HOME = "{DATA_HOME}"
TOKEN_CODE_HOME = "{CODE_HOME}"
TOKEN_HOME = "{HOME}"

ALL_TOKENS = (TOKEN_DATA_HOME, TOKEN_CODE_HOME, TOKEN_HOME)

#: `(field path, tokens this field may produce)`. `*` matches any dict key or
#: list index. NOTHING outside these paths is rewritten.
#:
#: `projects.*.path` is `{HOME}`-only on purpose: on this machine a registered
#: project's path IS the code home, so allowing `{CODE_HOME}` would rewrite a
#: legitimate project path into a token that means something else entirely on
#: the restore machine.
TRANSFORM_RULES = (
    ("projects.*.path", (TOKEN_HOME,)),
    ("skills.*.source", ALL_TOKENS),
    ("skills.*.mcp.args.*", ALL_TOKENS),
    ("sources.*.cache", ALL_TOKENS),
    ("remotes.*.home", (TOKEN_HOME,)),
    # Hook commands — `{DATA_HOME}` ONLY. A provisioned `ships_with` companion
    # hook's command is `<data home>/skills/<skill>/scripts/<x>`
    # (`hub_cli/skill.py`, `ships_with_reconcile.py`) and must follow the data
    # home to the restore machine. `{HOME}` and `{CODE_HOME}` are deliberately
    # excluded: `~/bin/x.sh` is a user-authored command hub does not own, and a
    # code home is installation-specific with its content not in the snapshot.
    # Both stay verbatim and keep their `machine_absolute` report line.
    #
    # All FOUR places a hook command lives are listed. `permissions.Hook`
    # serializes into a LIST under a permissions block, and a project carries a
    # shared `permissions` block and a personal `permissions_local` one.
    # `projects.*.hook_settings` is the one hook-adjacent shape NOT here: it is
    # arbitrary third-party config at arbitrary depth under arbitrary keys,
    # which this field-path grammar cannot express and hub does not own. It
    # stays verbatim and is reported per entry by
    # `restore.collect_machine_absolute`.
    ("hooks.*.command", (TOKEN_DATA_HOME,)),
    ("permissions_global.hooks.*.command", (TOKEN_DATA_HOME,)),
    ("projects.*.permissions.hooks.*.command", (TOKEN_DATA_HOME,)),
    ("projects.*.permissions_local.hooks.*.command", (TOKEN_DATA_HOME,)),
    # Worktree defaults are settings, so only the user HOME prefix travels;
    # machine-local data/code prefixes are never meaningful here.
    ("worktree_defaults.base_dir", (TOKEN_HOME,)),
)

#: Transform-owned fields whose value is a SHELL STRING a person authors, not a
#: bare path hub owns. Two deliberate consequences:
#:
#: * `from_portable` never `~`-collapses the expanded result. `~` inside a
#:   command is expanded only by a shell hub does not control, and every hub
#:   writer of these fields emits a resolved absolute path.
#: * `assert_transform_applied` still RAISES on a leaked prefix the field's own
#:   tokens could have consumed (that is the proof the transform ran), but adds
#:   no advisory line for any other machine prefix. An absolute path outside the
#:   data home is the normal shape here; advising would fire on every backup of a
#:   correct configuration, and `scan_for_machine_prefixes` already reports the
#:   same value once from `registry.yaml`.
SHELL_STRING_FIELDS = (
    "hooks.*.command",
    "permissions_global.hooks.*.command",
    "projects.*.permissions.hooks.*.command",
    "projects.*.permissions_local.hooks.*.command",
    "worktree_defaults.base_dir",
)

#: Keys dropped from the portable registry copy.
#: * `hub_path`  — dead key.
#: * `bootstrap` — per-machine first-run state; the restore target decides its own.
#: * `signing`   — pins the PUBLIC half of a keypair whose PRIVATE half never
#:                 travels; carrying the pin would leave a dangling reference
#:                 that breaks fail-closed signature verification.
#: * `backup`    — this machine's own backup config: an absolute `dir`, a `gh`
#:                 login, push-failure counters, acknowledged-finding hashes.
#:                 Carrying it would put machine A's paths in machine B's
#:                 registry and let a restored machine push over the snapshot it
#:                 just restored from. The restore machine runs `hub backup init`.
PORTABLE_DROP_KEYS = ("hub_path", "bootstrap", "signing", "backup")

#: Placeholder written over every `skills.*.mcp.env`/`mcp.headers` value, and
#: the query string of `skills.*.mcp.url`, in the portable copy (`redact_mcp_secrets`).
#: An MCP env/header block, or a url query param, legitimately holds an API key
#: or bearer token (docs/ADDING-SKILLS.md §3); all three are re-enterable on
#: the restore machine, so none of them travel.
REDACTED = "{REDACTED}"

SOURCE_CLASSES = ("inside-data-home", "inside-code-home", "git-source", "foreign")

#: Manifest fields describing THIS MACHINE rather than the captured content.
#: Refreshed even when an identical tree digest lets the rest of a prior
#: manifest be reused verbatim (see `assemble_snapshot`).
_MANIFEST_REFRESH_ON_REUSE = (
    "hostname",
    "hub_version",
    "prefixes",
    "external_connectors",
    "signing",
    "operation_context",
    "retained_artifacts",
)

# ─────────────────────────────────────────────────────────────────────────────
# 4. Credential scanning (the fail-closed pre-commit gate, design §4)
# ─────────────────────────────────────────────────────────────────────────────

PRIVATE_KEY_MARKERS = (
    b"BEGIN OPENSSH PRIVATE KEY",
    b"BEGIN RSA PRIVATE KEY",
    b"BEGIN DSA PRIVATE KEY",
    b"BEGIN EC PRIVATE KEY",
    b"BEGIN PGP PRIVATE KEY",
    b"BEGIN ENCRYPTED PRIVATE KEY",
    b"BEGIN PRIVATE KEY",
    b"PuTTY-User-Key-File",
)

SECRET_PATTERNS = (
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}")),
    ("github-fine-grained-pat", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("private-key-header", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
)

_ASSIGNED_SECRET_RE = re.compile(
    r"(?i)\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|"
    r"client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*"
    r"[\"']?([A-Za-z0-9/+_\-]{20,})[\"']?"
)

_PLACEHOLDER_RE = re.compile(
    r"(?i)^(x{4,}|\.{3,}|-+|_+|"
    r".*(redacted|placeholder|your[_-]?|example|changeme|change[_-]?me|dummy|"
    r"sample|not[_-]?a[_-]?secret|fake|todo|none|null|undefined).*)$"
)

SECRET_SCAN_MAX_BYTES = 2 * 1024 * 1024

# The auth ladder (§5, design §7) now lives in `backup_git.py`; its 13
# constants are re-imported at the top of this file.


# ─────────────────────────────────────────────────────────────────────────────
# Errors
#
# `BackupError` and `GitError` now live in `backup_git.py` (re-imported at the
# top of this file) — the leaf owns the base class its own git-op errors
# subclass. `SecretLeakError`/`PrefixLeakError` (snapshot-layer errors) still
# subclass `BackupError` here, unchanged.
# ─────────────────────────────────────────────────────────────────────────────


class SecretLeakError(BackupError):
    """The assembled snapshot contains material that must never be committed."""


class PrefixLeakError(BackupError):
    """A hub-generated snapshot file still carries this machine's absolute paths."""


# ─────────────────────────────────────────────────────────────────────────────
# Small helpers
# ─────────────────────────────────────────────────────────────────────────────


def safe_hostname() -> str:
    return _HOSTNAME_SAFE.sub("-", socket.gethostname()).strip("-") or "unknown-host"


def _rm(path: Path) -> None:
    """Remove a file, symlink, or directory tree. Missing is a no-op."""
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    except OSError:
        pass


def _within(path: Path, root: Path) -> bool:
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        # Python <= 3.12 raises RuntimeError for a symlink loop.
        return False


def _count_children(path: Path) -> int:
    try:
        return sum(1 for _ in path.iterdir())
    except OSError:
        return 0


def _core():
    from skill_hub import hub_core  # leaf primitives only — never the CLI monolith

    return hub_core


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


# `_harden_dir` now lives in `backup_git.py` (re-imported at the top of this
# file) — `git_init` needs it too, so the leaf owns it.


# ─────────────────────────────────────────────────────────────────────────────
# Gathering seams (design §2)
#
# Sub-agents resolve through `subagents.agents_dir()`, which honors
# $SKILL_HUB_CLAUDE_HOME / $CODEX_HOME. `Harness.agents_dir` is an INERT
# PurePath default — reading it directly would bypass those overrides and, in a
# test, walk the developer's real ~/.claude/agents.
# ─────────────────────────────────────────────────────────────────────────────


def _context_route(
    operation_context: object, harness_id: str, feature: str = "backup"
):
    """Return the captured backup route, or an unavailable sentinel.

    A supplied operation context is authoritative.  In particular, an empty
    context must not fall back to the legacy harness registry or environment.
    """
    try:
        return operation_context.route(harness_id, feature)
    except AttributeError:
        return None


def _context_layout(operation_context: object, harness_id: str):
    try:
        return operation_context.layout(harness_id)
    except AttributeError:
        return None


def _backup_route_usable(
    operation_context: object, harness_id: str, feature: str = "backup"
) -> bool:
    route = _context_route(operation_context, harness_id, feature)
    layout = _context_layout(operation_context, harness_id)
    return (
        layout is not None
        and getattr(layout, "status", None) != "unavailable"
        and callable(getattr(layout, "agent_target", None))
        and callable(getattr(layout, "doc_target", None))
        and route is not None
        and getattr(route, "status", "unavailable") == "shadow"
        and getattr(route, "mode", "unavailable") == "legacy_shadow"
    )


def harness_agents_dir(
    harness_id: str, operation_context: object = None, *, feature: str = "backup"
) -> Optional[Path]:
    """Env-aware user-scope agents dir for a harness id, or None if unsupported."""
    if operation_context is not None:
        if not _backup_route_usable(operation_context, harness_id, feature):
            return None
        layout = _context_layout(operation_context, harness_id)
        return layout.agent_target("user") if layout is not None else None
    from skill_hub.infrastructure.harnesses import subagents

    try:
        return Path(subagents.agents_dir("user", harness_id=harness_id))
    except (ValueError, KeyError):
        return None


def harness_global_doc(
    harness, operation_context: object = None, *, feature: str = "backup"
) -> Optional[Path]:
    """Env-aware user-global agent-doc path for a `Harness`, or None.

    Thin alias — the resolver now lives in `global_docs.doc_path` (the
    global-doc-sharing module, which resolves by harness id directly), kept
    here so nothing else in this file needs to change.
    """
    if operation_context is not None:
        harness_id = harness if isinstance(harness, str) else getattr(harness, "id", "")
        if not _backup_route_usable(operation_context, harness_id, feature):
            return None
        layout = _context_layout(operation_context, harness_id)
        return layout.doc_target() if layout is not None else None

    from skill_hub.infrastructure.filesystem import global_docs

    return global_docs.doc_path(harness.id)


def iter_harness_sources(operation_context: object = None) -> list:
    """`[(harness_id, agents_dir_or_None, global_doc_or_None)]`, sorted by id."""
    if operation_context is not None:
        out = []
        for h_id in sorted(getattr(operation_context, "harness_ids", ())):
            layout = _context_layout(operation_context, h_id)
            if layout is None:
                out.append((h_id, None, None))
                continue
            out.append(
                (
                    h_id,
                    harness_agents_dir(h_id, operation_context),
                    harness_global_doc(h_id, operation_context),
                )
            )
        return out
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    out = []
    for h_id in sorted(_harnesses.HARNESSES):
        harness = _harnesses.HARNESSES[h_id]
        agents = harness_agents_dir(h_id) if harness.agents_dir is not None else None
        out.append((h_id, agents, harness_global_doc(harness)))
    return out


def _agent_files(agents_dir: Path, agent_format: Optional[str]) -> list:
    """Sub-agent definition files for one harness, by declared format.

    Claude Code uses `*.md`; Codex uses `*.toml` plus the hub-owned
    `*.toml.disabled` rename that encodes the disabled state. Symlinks are
    skipped (never dereferenced).
    """
    if not agents_dir.is_dir():
        return []
    suffixes = (".toml", ".toml.disabled") if agent_format == "toml" else (".md",)
    out = []
    try:
        entries = sorted(agents_dir.iterdir())
    except OSError:
        return []
    for entry in entries:
        if entry.is_symlink() or not entry.is_file():
            continue
        if any(entry.name.endswith(suffix) for suffix in suffixes):
            out.append(entry)
    return out


def gather_subagents(dest: Path, operation_context: object = None) -> list:
    """Copy every harness's user-scope sub-agent files into `harness/<id>/agents/`.

    Project-scope sub-agents (`<repo>/.claude/agents/`) are a STATED exclusion —
    projects are their own repos.
    """
    if operation_context is not None:
        written: list = []
        for h_id, agents_dir, _doc in iter_harness_sources(operation_context):
            if agents_dir is None:
                continue
            layout = _context_layout(operation_context, h_id)
            files = _agent_files(agents_dir, getattr(layout, "agent_format", None))
            if not files:
                continue
            target = dest / "harness" / h_id / "agents"
            target.mkdir(parents=True, exist_ok=True)
            for src in files:
                shutil.copy2(src, target / src.name)
                written.append("harness/" + h_id + "/agents/" + src.name)
        return written

    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    written: list = []
    for h_id, agents_dir, _doc in iter_harness_sources():
        if agents_dir is None:
            continue
        files = _agent_files(agents_dir, _harnesses.HARNESSES[h_id].agent_format)
        if not files:
            continue
        target = dest / "harness" / h_id / "agents"
        target.mkdir(parents=True, exist_ok=True)
        for src in files:
            shutil.copy2(src, target / src.name)
            written.append("harness/" + h_id + "/agents/" + src.name)
    return written


def gather_global_docs(dest: Path, operation_context: object = None) -> list:
    """Copy each harness's user-global agent doc into `global-docs/<id>/<name>`."""
    written: list = []
    for h_id, _agents, doc in iter_harness_sources(operation_context):
        if doc is None or doc.is_symlink() or not doc.is_file():
            continue
        target = dest / "global-docs" / h_id
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(doc, target / doc.name)
        written.append("global-docs/" + h_id + "/" + doc.name)
    return written


# ─────────────────────────────────────────────────────────────────────────────
# Copying with a strict symlink policy
#
# A symlink whose target escapes `allowed_root` (the data home) is NEVER
# dereferenced: following one there is an exfiltration vector (a link planted
# inside a skill dir could pull `~/.ssh/` into a repo that gets pushed to
# GitHub) — it is skipped with a warning instead.
#
# A symlink inside one of `references.REFERENCE_SECTIONS` whose target
# resolves, hop by hop, to a regular file that stays inside those same
# sections IS dereferenced — its target bytes are written as a regular file
# at the link's own snapshot location (`references.resolve_reference_chain`
# enforces the same containment `restore._data_file_source` checks on the far
# side, so this is not the exfiltration case above: the target can only ever
# be another file already inside the data home's own skill/connector/MCP/
# snippet content). This is what lets a safe internal reference (one skill
# pointing at another's file) travel under the tree digest and signature
# instead of as an inert, unsigned link `restore.py` would otherwise have to
# trust blind. Any other internal symlink (outside those sections, e.g. under
# `hooks/`) keeps the old behavior: copied AS a link, unresolved.
# ─────────────────────────────────────────────────────────────────────────────


def _copy_dir(
    src: Path,
    dst: Path,
    *,
    allowed_root: Path,
    warnings: list,
    nested_git: list,
    rel: str,
) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    try:
        entries = sorted(src.iterdir())
    except OSError as exc:
        warnings.append("could not read " + rel + ": " + str(exc))
        return
    for entry in entries:
        name = entry.name
        child_rel = rel + "/" + name if rel else name
        if name == ".git":
            # A nested repo would be recorded as a gitlink (an unusable commit
            # pointer) in the backup repo. Record it and skip the .git dir only —
            # the skill's own content still travels.
            nested_git.append(child_rel)
            warnings.append(
                "nested git repo not snapshotted (its history stays upstream): " + child_rel
            )
            continue
        if name in _COPY_EXCLUDE_NAMES or name.endswith(".pyc"):
            continue
        target = dst / name
        if entry.is_symlink():
            if not _within(entry, allowed_root):
                warnings.append(
                    "skipped symlink pointing outside the data home: " + child_rel
                )
                continue
            if child_rel.split("/", 1)[0] in _references.REFERENCE_SECTIONS:
                # A safe internal reference (its target resolves, hop by hop,
                # to a regular file inside an allowed data section) is
                # materialized as a regular file NOW, before signing — so its
                # placement and content travel under the same tree digest and
                # SSHSIG as every other file, with no schema change. This is
                # the fix, not a convenience: a symlink here would otherwise
                # carry an unsigned target that restore has to trust blind
                # (see `restore.REFERENCE_ONLY_SECTIONS`).
                try:
                    resolved = _references.resolve_reference_chain(
                        allowed_root, entry, sections=_references.REFERENCE_SECTIONS
                    )
                except _references.ReferenceError as exc:
                    warnings.append(
                        "skipped internal reference (" + str(exc) + "): " + child_rel
                    )
                    continue
                try:
                    shutil.copy2(resolved, target)
                except OSError as exc:
                    warnings.append(
                        "could not materialize reference " + child_rel + ": " + str(exc)
                    )
                continue
            try:
                os.symlink(os.readlink(entry), target)
            except OSError as exc:
                warnings.append("could not copy symlink " + child_rel + ": " + str(exc))
            continue
        try:
            if entry.is_dir():
                _copy_dir(
                    entry,
                    target,
                    allowed_root=allowed_root,
                    warnings=warnings,
                    nested_git=nested_git,
                    rel=child_rel,
                )
            elif entry.is_file():
                shutil.copy2(entry, target)
        except OSError as exc:
            warnings.append("could not copy " + child_rel + ": " + str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# Field-scoped path transform (design §3)
# ─────────────────────────────────────────────────────────────────────────────


def _mutate_at(node: Any, parts: tuple, fn: Callable) -> None:
    """Apply `fn` to every string reachable at the `parts` field path, in place."""
    head = parts[0]
    last = len(parts) == 1
    if isinstance(node, dict):
        keys = list(node.keys()) if head == "*" else ([head] if head in node else [])
        for key in keys:
            if last:
                if isinstance(node[key], str):
                    node[key] = fn(node[key])
            else:
                _mutate_at(node[key], parts[1:], fn)
    elif isinstance(node, list) and head == "*":
        for index, value in enumerate(node):
            if last:
                if isinstance(value, str):
                    node[index] = fn(value)
            else:
                _mutate_at(value, parts[1:], fn)


def machine_prefixes(
    data_home: Path, code_home: Optional[Path], home: Optional[Path]
) -> list:
    """`[(absolute prefix, token)]` ordered longest-first.

    Absolute only: values are normalized with `expanduser` before matching, so
    the `~`-collapsed spellings that dominate the live registry are handled by
    normalization rather than by a second set of rules.
    """
    home = Path(home) if home is not None else Path.home()
    pairs = [
        (Path(data_home), TOKEN_DATA_HOME),
        (code_home if code_home is None else Path(code_home), TOKEN_CODE_HOME),
        (home, TOKEN_HOME),
    ]
    rules = [(str(base), token) for base, token in pairs if base is not None]
    seen = set()
    deduped = []
    for prefix, token in rules:
        if prefix in seen:
            continue
        seen.add(prefix)
        deduped.append((prefix, token))
    deduped.sort(key=lambda pair: len(pair[0]), reverse=True)
    return deduped


def _expanduser_with(value: str, home: Path) -> str:
    """`~` expansion against an EXPLICIT home.

    `os.path.expanduser` would consult the live `$HOME`, which is wrong whenever
    we are transforming for a different machine (and untestable).
    """
    if value == "~":
        return str(home)
    if value.startswith("~/"):
        return str(home) + os.sep + value[2:]
    return value


def _prefix_hit(value: str, prefix: str) -> bool:
    """`prefix` occurs in `value` at a PATH BOUNDARY — the match ends the value,
    or the next character is `os.sep`.

    A plain `in` test makes `/A/.skill-hub` match `/A/.skill-hub-backup/x.sh`,
    which the transform must never rewrite (a sibling directory is a different
    place) and the prefix gate must never call a leak. The leading branch of
    `_tokenize_path` has always required this; the embedded pass and the gate
    now agree with it.
    """
    if not prefix:
        return False
    start = value.find(prefix)
    while start != -1:
        end = start + len(prefix)
        if end == len(value) or value[end] == os.sep:
            return True
        start = value.find(prefix, start + 1)
    return False


def _replace_at_boundaries(value: str, prefix: str, token: str) -> str:
    """Replace every BOUNDARY occurrence of `prefix` with `token`; leave a
    non-boundary occurrence (`<prefix>-backup/…`) exactly as it is."""
    if not prefix:
        return value
    out = []
    i = 0
    while True:
        start = value.find(prefix, i)
        if start == -1:
            out.append(value[i:])
            break
        end = start + len(prefix)
        if end == len(value) or value[end] == os.sep:
            out.append(value[i:start])
            out.append(token)
            i = end
        else:
            # Not a boundary match — keep the character and resume scanning
            # from the very next position, so a later boundary match is not
            # skipped just because an earlier non-boundary one overlapped it.
            out.append(value[i : start + 1])
            i = start + 1
    return "".join(out)


def _tokenize_embedded(value: str, rules: list, allowed: tuple) -> str:
    """Replace machine prefixes that appear INSIDE a value, not just at its start.

    A declared field legitimately holds strings that only EMBED a path —
    `--data-dir=/Users/alice/x`, `python3 /Users/alice/x/server.py`. A
    leading-prefix-only transform leaves those absolute, and
    `assert_transform_applied` (which looks for the prefix anywhere) then refuses
    every future snapshot with no way out. Rewriting them here is safe because
    the reverse (`_expand_path`) expands tokens wherever they occur, so the
    round-trip is closed; and it is scoped, because it only ever runs inside the
    fields `TRANSFORM_RULES` already claims to own.

    Only a BOUNDARY occurrence — the match ends the value or the next character
    is `os.sep` — is ever rewritten (`_prefix_hit`/`_replace_at_boundaries`), so
    a sibling directory (`{DATA_HOME}-backup/x.sh`) is never produced.

    `rules` is longest-prefix-first, so a data home nested under `$HOME` is
    consumed by `{DATA_HOME}` before `{HOME}` can bite off its parent.
    """
    for prefix, token in rules:
        if token not in allowed or not prefix:
            continue
        if _prefix_hit(value, prefix):
            value = _replace_at_boundaries(value, prefix, token)
    return value


def _tokenize_path(value: str, rules: list, allowed: tuple, home: Path) -> str:
    """Normalize → longest-prefix-first tokenize, restricted to `allowed` tokens.

    Returns the ORIGINAL string untouched when nothing matches, so relative
    values (`{source}/server.py`) and non-path strings survive verbatim.
    """
    normalized = _expanduser_with(value, home)
    out = None
    for prefix, token in rules:
        if token not in allowed:
            continue
        if normalized == prefix:
            return token
        if normalized.startswith(prefix + os.sep):
            out = token + "/" + normalized[len(prefix) + 1 :].replace(os.sep, "/")
            break
    # A leading match consumes only the leading prefix; a value like
    # `{HOME}/bin/x --data-dir=/Users/alice/y` would still carry one. Run the
    # embedded pass over the result either way.
    return _tokenize_embedded(value if out is None else out, rules, allowed)


def _expand_path(value: str, values: dict, home: Path, collapse: bool) -> str:
    for token, replacement in values.items():
        if value == token:
            expanded = str(replacement)
        elif value.startswith(token + "/"):
            expanded = str(replacement) + os.sep + value[len(token) + 1 :].replace("/", os.sep)
        else:
            continue
        if collapse:
            return _collapse_home(expanded, home)
        return expanded
    # Embedded tokens (the `--data-dir={DATA_HOME}/x` shape `_tokenize_embedded`
    # produces) are expanded in place. NOT `~`-collapsed: a token in the middle
    # of a command string is an argument, and `~` there is only expanded by a
    # shell we do not control.
    if any(token in value for token in values):
        for token, replacement in values.items():
            value = value.replace(token, str(replacement))
    return value


def _collapse_home(value: str, home: Path) -> str:
    """`hub.collapse_home` semantics, without importing hub for a pure helper."""
    home_str = str(home)
    if value == home_str:
        return "~"
    if value.startswith(home_str + os.sep):
        return "~" + value[len(home_str) :]
    return value


def _redact_mcp_url_userinfo(url: str) -> Optional[str]:
    """`user:pw@host` → `host` (E3 rev 2 §2.7, catalogue U01) — a literal
    credential in a URL's userinfo is exactly as much a secret as an
    `env`/`headers` value, and must not travel to the backup repo either.
    Returns the rewritten URL, or `None` if there was nothing to strip.

    A thin delegator over `mcp_spec.redact_url_secrets` (plans/G.md §5.11):
    `flagged_params=set()` asks it to touch ONLY the userinfo, never the
    query string — this function's callers redact `mcp.url`'s query
    themselves (a blunt whole-string `?{REDACTED}`, `redact_mcp_secrets`
    below), so a second, more surgical rewrite here would be redundant.
    """
    redacted = mcp_spec.redact_url_secrets(url, flagged_params=set())
    return redacted if redacted != url else None


def redact_mcp_secrets(registry: dict) -> int:
    """Overwrite every `skills.<n>.mcp.env`/`mcp.headers` value with
    `{REDACTED}`, strip a literal `user:pw@` from `mcp.url`'s userinfo, and
    redact the query string of `mcp.url` with `?{REDACTED}`, IN PLACE.

    Widened from `redact_mcp_env` (M6, plans/B.md wave B): a remote MCP spec
    can carry a bearer/API-key credential in a header, in a url query
    param, or in a url's userinfo just as easily as in `env`, and a user's
    `--allow-literal` escape hatch (wave B) makes that a real, not
    hypothetical, case. None of these surfaces travel to the backup repo.
    """
    count = 0
    skills = registry.get("skills")
    if not isinstance(skills, dict):
        return 0
    for cfg in skills.values():
        if not isinstance(cfg, dict):
            continue
        mcp = cfg.get("mcp")
        if not isinstance(mcp, dict):
            continue
        for field in ("env", "headers"):
            values = mcp.get(field)
            if not isinstance(values, dict):
                continue
            for key in list(values):
                if values[key] in (None, "", REDACTED):
                    continue
                values[key] = REDACTED
                count += 1
        url = mcp.get("url")
        if isinstance(url, str) and url:
            stripped = _redact_mcp_url_userinfo(url)
            if stripped is not None:
                url = stripped
                mcp["url"] = url
                count += 1
            if "?" in url:
                base, _, query = url.partition("?")
                if query and query != REDACTED:
                    mcp["url"] = f"{base}?{REDACTED}"
                    count += 1
    return count


#: Back-compat alias — kept for one release in case a caller pins the old name.
redact_mcp_env = redact_mcp_secrets


def to_portable(
    registry: dict,
    *,
    data_home: Path,
    code_home: Optional[Path] = None,
    home: Optional[Path] = None,
) -> dict:
    """Machine-specific registry → portable registry (design §3).

    Field-scoped: only the paths named in `TRANSFORM_RULES` are rewritten, each
    limited to the tokens that are meaningful for it. Drops the keys that must
    not travel and redacts MCP env secrets. Operates on a deep copy — the
    caller's dict (and the live `registry.yaml`) is untouched.
    """
    home_path = Path(home) if home is not None else Path.home()
    rules = machine_prefixes(Path(data_home), code_home, home_path)
    out = copy.deepcopy(registry)
    from skill_hub.infrastructure.registry import loadout_bindings, project_repository

    try:
        loadout_bindings.validate_portable_metadata(out)
    except project_repository.RepositoryError as exc:
        raise BackupError(
            "invalid_repository_metadata: reconnect or clear the invalid repository association before backup"
        ) from exc
    if "worktree_defaults" in out:
        normalized = worktree_defaults.normalize(
            out["worktree_defaults"], home=home_path
        )
        if not normalized["include_in_backup"]:
            out.pop("worktree_defaults", None)
        else:
            # Include the complete block, including the opt-in flag, even when
            # the source registry was written by an older serializer.
            out["worktree_defaults"] = normalized
    for field_path, allowed in TRANSFORM_RULES:
        _mutate_at(
            out,
            tuple(field_path.split(".")),
            lambda value, _a=allowed: _tokenize_path(value, rules, _a, home_path),
        )
    for key in PORTABLE_DROP_KEYS:
        out.pop(key, None)
    redact_mcp_secrets(out)
    return out


def from_portable(
    registry: dict,
    *,
    data_home: Path,
    code_home: Optional[Path] = None,
    home: Optional[Path] = None,
    collapse: bool = True,
) -> dict:
    """Portable registry → concrete registry for THIS machine.

    `collapse` re-applies hub's `~` convention to results under `$HOME`, which is
    how the live registry spells most paths. Reversibility holds in TOKEN space —
    `to_portable(from_portable(to_portable(r))) == to_portable(r)` — not in byte
    space, since dropped keys and redacted env values are gone for good.
    """
    home_path = Path(home) if home is not None else Path.home()
    values = {TOKEN_DATA_HOME: Path(data_home), TOKEN_HOME: home_path}
    if code_home is not None:
        values[TOKEN_CODE_HOME] = Path(code_home)
    ordered = dict(sorted(values.items(), key=lambda kv: len(kv[0]), reverse=True))
    out = copy.deepcopy(registry)
    for field_path, _allowed in TRANSFORM_RULES:
        collapse_here = collapse and field_path not in SHELL_STRING_FIELDS
        _mutate_at(
            out,
            tuple(field_path.split(".")),
            lambda value, _c=collapse_here: _expand_path(value, ordered, home_path, _c),
        )
    if "worktree_defaults" in out:
        normalized_worktree = worktree_defaults.normalize(
            out["worktree_defaults"], home=home_path
        )
        if not collapse and normalized_worktree["base_dir"].startswith("~/"):
            normalized_worktree["base_dir"] = str(
                home_path / normalized_worktree["base_dir"][2:]
            )
        elif not collapse and normalized_worktree["base_dir"] == "~":
            normalized_worktree["base_dir"] = str(home_path)
        out["worktree_defaults"] = normalized_worktree
    return out


def tokenized_fields(
    portable_registry: dict, token: str = TOKEN_DATA_HOME
) -> frozenset:
    """Transform-owned field paths whose PORTABLE value carries
    `token`, spelled as `_collect_at` spells them (`hooks.h.command`,
    `permissions_global.hooks[0].command`).

    This is how restore knows which machine-absolute strings arrived through
    the transform. It is EVIDENCE — the value in the snapshot really did carry
    the token — never an inference from a path prefix, which is wrong for a
    non-leading `~` spelling the transform cannot see and for the truncated
    fragments `restore._command_paths` produces from a path containing spaces.
    """
    out: set = set()
    for field_path in SHELL_STRING_FIELDS:
        found: list = []
        _collect_at(portable_registry, tuple(field_path.split(".")), found)
        for where, value in found:
            # `{HOME}` is transform-owned only for the worktree base path;
            # shell command fields may contain a user-authored literal token.
            if token == TOKEN_HOME and field_path != "worktree_defaults.base_dir":
                continue
            if token in value:
                out.add(where)
    return frozenset(out)


def remap_prefix(
    node: Any,
    old_prefix: Path,
    new_prefix: Path,
    *,
    skip_entries: Optional[set] = None,
    left_behind: Optional[list] = None,
) -> Any:
    """Rewrite every leading `old_prefix` (absolute OR `~`-collapsed) to `new_prefix`.

    Used by `hub migrate-home` after a LOCAL data-home move, where a blanket
    sweep is exactly right: every string naming the old location must follow the
    files. (This is the opposite of `to_portable`, which must stay field-scoped.)

    `skip_entries` names top-level entries that did NOT actually move (a target
    collision left them at the legacy home). Values under those entries keep the
    OLD path — rewriting them would point the registry at files that are not
    there, turning a partial move into a broken install. Every such value is
    appended to `left_behind` so the caller can say so out loud.
    """
    home = Path.home()
    skip_entries = skip_entries or set()
    variants = [str(old_prefix)]
    try:
        rel = Path(old_prefix).relative_to(home)
        variants.append("~" if str(rel) == "." else "~/" + rel.as_posix())
    except ValueError:
        pass
    variants.sort(key=len, reverse=True)
    new = str(new_prefix)

    def fn(value: str) -> str:
        for variant in variants:
            if value == variant:
                return new
            if value.startswith(variant + "/") or value.startswith(variant + os.sep):
                remainder = value[len(variant) + 1 :]
                top = remainder.replace(os.sep, "/").split("/", 1)[0]
                if top in skip_entries:
                    if left_behind is not None:
                        left_behind.append(value)
                    return value
                return new + os.sep + remainder
        return value

    def walk(inner: Any) -> Any:
        if isinstance(inner, dict):
            return {k: walk(v) for k, v in inner.items()}
        if isinstance(inner, (list, tuple)):
            return [walk(v) for v in inner]
        if isinstance(inner, str):
            return fn(inner)
        return inner

    return walk(node)


def classify_sources(
    registry: dict,
    *,
    data_home: Path,
    code_home: Optional[Path],
    home: Optional[Path],
) -> dict:
    """Classify every `skills.*.source` so restore can report instead of guessing.

    `inside-data-home` content travels in the snapshot. `inside-code-home`,
    `git-source`, and `foreign` do NOT — recording the class lets restore say
    "this skill's content is not in the backup, here is where it came from"
    rather than writing a path that resolves to nothing.

    `~` expansion goes through `_expanduser_with(value, home)`, NOT
    `os.path.expanduser`: the latter reads the live `$HOME`, so classification
    would silently disagree with the transform (which uses the passed `home`)
    the moment the two differ — exactly the different-HOME round-trip case.
    """
    home = Path(home) if home is not None else Path.home()
    caches = []
    for cfg in (registry.get("sources") or {}).values():
        if isinstance(cfg, dict) and cfg.get("cache"):
            caches.append(Path(_expanduser_with(str(cfg["cache"]), home)))

    out: dict = {}
    for name, cfg in (registry.get("skills") or {}).items():
        if not isinstance(cfg, dict) or not cfg.get("source"):
            continue
        raw = str(cfg["source"])
        resolved = Path(_expanduser_with(raw, home))
        if any(_within(resolved, cache) or resolved == cache for cache in caches):
            klass = "git-source"
        elif _within(resolved, data_home):
            klass = "inside-data-home"
        elif code_home is not None and _within(resolved, code_home):
            klass = "inside-code-home"
        else:
            klass = "foreign"
        out[name] = {
            "class": klass,
            "in_snapshot": klass == "inside-data-home",
        }
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Coded gates: credential content + machine-prefix leaks (design §3, §4)
# ─────────────────────────────────────────────────────────────────────────────


def finding_id(finding: str) -> str:
    """Stable sha256 of a finding, so `--allow-secret <sha>` can acknowledge one."""
    return hashlib.sha256(finding.encode()).hexdigest()


def _scan_text_for_secrets(rel: str, text: str) -> list:
    findings: list = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(line):
                findings.append(rel + ":" + str(lineno) + ": " + label)
        match = _ASSIGNED_SECRET_RE.search(line)
        if match and not _PLACEHOLDER_RE.match(match.group(2)):
            findings.append(
                rel + ":" + str(lineno) + ": credential-shaped value assigned to '"
                + match.group(1) + "'"
            )
    return findings


def _iter_snapshot_files(root: Path):
    for path in sorted(Path(root).rglob("*")):
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        if rel == ".git" or rel.startswith(".git/"):
            continue
        yield rel, path


def scan_for_secrets(root: Path) -> list:
    """Findings across the staged tree; empty means clean.

    Three independent checks, so a bug in the allowlist alone cannot leak:
      * **path**   — anything under a secret entry from the manifest table;
      * **binary** — private-key headers anywhere in the raw bytes;
      * **text**   — credential shapes, reported as `path:line: <what>`.
    Symlinks are never followed (their targets are outside the snapshot).
    """
    findings: list = []
    root = Path(root)
    if not root.is_dir():
        return findings
    for rel, path in _iter_snapshot_files(root):
        for forbidden in DATA_HOME_SECRET:
            if rel == forbidden or rel.startswith(forbidden + "/"):
                findings.append("forbidden path in snapshot: " + rel)
        if path.is_symlink() or not path.is_file():
            continue
        try:
            with open(path, "rb") as handle:
                blob = handle.read(SECRET_SCAN_MAX_BYTES)
        except OSError:
            continue
        for marker in PRIVATE_KEY_MARKERS:
            if marker in blob:
                findings.append(
                    rel + ": private-key material (" + marker.decode("ascii", "replace") + ")"
                )
                break
        if b"\x00" in blob:
            continue  # binary — the marker pass above is the only meaningful one
        findings.extend(_scan_text_for_secrets(rel, blob.decode("utf-8", "replace")))
    return sorted(dict.fromkeys(findings))


def assert_findings_acknowledged(findings: list, allowed: Optional[set] = None) -> None:
    """Raise `SecretLeakError` for any finding not in the acknowledged set."""
    allowed = allowed or set()
    unacknowledged = [f for f in findings if finding_id(f) not in allowed]
    if unacknowledged:
        raise SecretLeakError(
            "refusing to commit — snapshot contains credential-shaped material:\n  "
            + "\n  ".join(
                f + "\n      acknowledge with --allow-secret " + finding_id(f)
                for f in unacknowledged
            )
        )


def assert_no_secrets(root: Path, allowed: Optional[set] = None) -> None:
    """Raise `SecretLeakError` unless every finding has been acknowledged.

    Called immediately before `git add`/`commit`, so a suspected leak aborts the
    backup rather than being published. Fail-closed by design: a false positive
    costs a skipped backup, a false negative costs a published credential — hence
    the per-finding `--allow-secret <sha256>` escape hatch rather than a blanket
    override.
    """
    assert_findings_acknowledged(scan_for_secrets(root), allowed)


def scan_manifest_text(text: str) -> list:
    """Scan the generated `manifest.json` body for credential shapes.

    `manifest.json` is written AFTER `assert_no_secrets` (it must hash the final
    tree), so the tree scan structurally cannot see it. It is hub-generated, but
    it embeds user-controlled strings — warnings, skill names, source paths — so
    it gets its own pass rather than an exemption.

    Findings are `file:line`-keyed like every other one, which for a generated
    JSON file means an acknowledgement can go stale when the manifest reflows.
    That is the fail-closed direction (the user is asked again), and it is
    preferable to a content-only id that would silently keep acknowledging a
    finding that moved into a different field.
    """
    return _scan_text_for_secrets("manifest.json", text)


def _collect_at(node, parts: tuple, out: list, trail: str = "") -> None:
    """Collect `(field path, value)` for every string at the `parts` field path."""
    head = parts[0]
    last = len(parts) == 1
    if isinstance(node, dict):
        keys = list(node.keys()) if head == "*" else ([head] if head in node else [])
        for key in keys:
            where = trail + "." + str(key) if trail else str(key)
            if last:
                if isinstance(node[key], str):
                    out.append((where, node[key]))
            else:
                _collect_at(node[key], parts[1:], out, where)
    elif isinstance(node, list) and head == "*":
        for index, value in enumerate(node):
            where = trail + "[" + str(index) + "]"
            if last:
                if isinstance(value, str):
                    out.append((where, value))
            else:
                _collect_at(value, parts[1:], out, where)


def assert_transform_applied(
    portable_registry: dict, prefixes: list, rules: Optional[list] = None
) -> list:
    """HARD gate: no transform-owned field may still hold a REWRITABLE machine path.

    This is the primary proof that the transform ran — round-trip equality alone
    would pass on a no-op transform. It is scoped to exactly the fields
    `TRANSFORM_RULES` claims to rewrite, which makes it both precise (a missed
    rewrite always trips it) and false-positive-free (it can never fire on prose
    or on a hook command string that hub does not own and cannot rewrite).

    `rules` (the `[(prefix, token)]` from `machine_prefixes`) makes the gate
    honest about its own scope. A field declares WHICH tokens it may produce —
    `projects.*.path` may only become `{HOME}` — so a code-home path embedded in
    one is something no rule could ever have rewritten. Hard-failing on that
    would brick every future backup over a value the user has no way to fix.
    Those are RETURNED as advisory findings (the caller folds them into the
    snapshot warnings, alongside the same soft treatment file content gets);
    only a prefix the field's own tokens COULD have consumed still raises.

    With `rules=None` every prefix counts as rewritable — the strict, historical
    behaviour, which is what the unit tests of the gate itself want.

    The verdict for a value never depends on `prefixes`' order: every prefix is
    checked, and a rewritable hit always wins over a non-rewritable one, so a
    genuine leak is caught whether the caller lists the data home before or
    after the (usually broader) home prefix.
    """
    prefixes = [p for p in prefixes if p]
    leaked: list = []
    advisory: list = []
    for field_path, allowed in TRANSFORM_RULES:
        if rules is None:
            rewritable = set(prefixes)
        else:
            rewritable = {p for p, token in rules if p and token in allowed}
        advise = field_path not in SHELL_STRING_FIELDS
        found: list = []
        _collect_at(portable_registry, tuple(field_path.split(".")), found)
        for where, value in found:
            # Check EVERY prefix rather than stopping at the first hit — the
            # verdict must not depend on prefix order (review 4b #5). A
            # shorter, less-specific prefix (e.g. `home`) can be a literal
            # string-prefix of a longer, more-specific one (e.g. `data_home`,
            # when the data home lives under the user's home dir) and match
            # first; if that first hit happens not to be rewritable while a
            # later, more-specific one is, the value must still be caught.
            hits = [prefix for prefix in prefixes if _prefix_hit(value, prefix)]
            if any(prefix in rewritable for prefix in hits):
                leaked.append(where + " = " + value)
            elif hits and advise:
                advisory.append(
                    "machine path in a registry field no transform rule owns "
                    "(carried verbatim): " + where + " = " + value
                )
    if leaked:
        raise PrefixLeakError(
            "refusing to commit — the path transform left machine-specific paths "
            "in registry fields it owns:\n  " + "\n  ".join(sorted(set(leaked)))
        )
    return sorted(dict.fromkeys(advisory))


def scan_for_machine_prefixes(root: Path, prefixes: list) -> list:
    """SOFT scan: report any snapshot file still carrying an absolute machine path.

    Advisory, not blocking. Most hits are user-authored prose (a skill doc that
    happens to mention a path) which hub neither owns nor rewrites; hard-failing
    on those would brick every future backup over content the user cannot easily
    find. `manifest.json` is excluded — it records the prefixes on purpose so
    restore can remap.
    """
    out: list = []
    root = Path(root)
    prefixes = [p for p in prefixes if p]
    if not root.is_dir() or not prefixes:
        return out
    for rel, path in _iter_snapshot_files(root):
        if rel == "manifest.json" or path.is_symlink() or not path.is_file():
            continue
        try:
            with open(path, "rb") as handle:
                blob = handle.read(SECRET_SCAN_MAX_BYTES)
        except OSError:
            continue
        if b"\x00" in blob:
            continue
        text = blob.decode("utf-8", "replace")
        for lineno, line in enumerate(text.splitlines(), start=1):
            for prefix in prefixes:
                if prefix in line:
                    out.append(
                        "machine path in snapshot content (not hub-rewritable): "
                        + rel + ":" + str(lineno)
                    )
                    break
    return sorted(dict.fromkeys(out))


def compute_tree_digest(root: Path) -> tuple:
    """`({rel: sha256}, tree_digest)` over every regular file except the manifest.

    `manifest.json` and `manifest.sig` are excluded (they are derived FROM this
    digest, so including them would be circular) and are covered instead by the
    signature step. Restore verifies this BEFORE touching anything, so a
    truncated clone is a hard abort rather than a half-restore.
    """
    files: dict = {}
    for rel, path in _iter_snapshot_files(root):
        if rel in DIGEST_EXCLUDED or path.is_symlink() or not path.is_file():
            continue
        try:
            files[rel] = _sha256_file(path)
        except OSError:
            continue
    joined = "\n".join(rel + " " + files[rel] for rel in sorted(files))
    return files, hashlib.sha256(joined.encode()).hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# Cheap change detection
#
# `_auto_sync` fires on EVERY registry mutation (one equip click = one sync), so
# an unconditional snapshot would mean a multi-megabyte copy and a noise commit
# per click. This stat-only fingerprint makes an unchanged state cost a few
# hundred `stat()` calls and nothing else.
# ─────────────────────────────────────────────────────────────────────────────


def _fingerprint_walk(root: Path, out: list, label: str) -> None:
    if not root.exists():
        return
    if root.is_file():
        try:
            st = root.stat()
        except OSError:
            return
        out.append(label + ":" + str(st.st_size) + ":" + str(st.st_mtime_ns))
        return
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            out.append(label + "/" + rel + ":link")
            continue
        if not path.is_file():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        out.append(
            label + "/" + rel + ":" + str(st.st_size) + ":" + str(st.st_mtime_ns)
        )


#: Snapshot inputs the change-detection fingerprint deliberately IGNORES.
#:
#: `state/audit.jsonl` gains a line on EVERY registry mutation, so including it
#: would make the fingerprint differ on every single `_auto_sync` — the dirty
#: gate would never fire and each equip click would pay a full multi-megabyte
#: assembly for a one-line append. `state/usage/history.jsonl` is rewritten on
#: every capture-on-open of the Usage screen, for the same reason: leaving it
#: in the digest would make the sync-tail auto-backup dirty gate fire on every
#: visit to that screen. `state/usage/sessions.jsonl` is rewritten on every
#: `hub usage scan-sessions`, and `state/usage/loadouts.jsonl` gains a row on
#: every `hub sync` whose resolved loadout changed — both would fire the same
#: dirty gate on an ordinary scan or equip click (usage-loadout-analytics
#: design D8). All four ledgers still travel: an explicit `hub sync` /
#: `hub backup now` runs with `force=True`, which bypasses the fingerprint
#: entirely and re-assembles (and therefore re-commits) them.
FINGERPRINT_EXCLUDED = (
    "state/audit.jsonl",
    "state/usage/history.jsonl",
    "state/usage/sessions.jsonl",
    "state/usage/loadouts.jsonl",
)


def snapshot_fingerprint(
    data_home: Optional[Path] = None, operation_context: object = None
) -> str:
    """Mostly-stat digest of everything a snapshot would contain.

    TRADE-OFF: `(size, mtime_ns)` misses an edit that preserves both — a
    same-size rewrite by a tool that restores mtimes (`cp -p`, `rsync -t`, a
    `git checkout` of an equal-length file). `registry.yaml` is exempted and
    hashed for real: it is the one file where a same-size, mtime-preserved
    change is plausible (an id swap, a flag flip) and also the one whose loss
    matters most. Everything else keeps the cheap stat, and `git_is_dirty()` in
    `run_backup` is the backstop that catches a missed change on the next run.
    """
    data_home = Path(data_home) if data_home is not None else _core().data_home()
    parts: list = []
    registry_file = data_home / "registry.yaml"
    if registry_file.is_file():
        try:
            parts.append("registry.yaml:sha256:" + _sha256_file(registry_file))
        except OSError:
            pass
    for entry in DATA_HOME_PORTABLE:
        if entry == "registry.yaml":
            # Already hashed above. Stat-walking it as well would put its
            # `mtime_ns` back into the digest and undo the exemption entirely:
            # sync rewrites `registry.yaml` atomically on paths where the content
            # does not change at all, so every single sync produced a "changed"
            # fingerprint and the dirty gate never fired.
            continue
        _fingerprint_walk(data_home / entry, parts, entry)
    for rel in DATA_HOME_STATE_PORTABLE:
        if rel in FINGERPRINT_EXCLUDED:
            continue
        _fingerprint_walk(data_home / rel, parts, rel)
    for h_id, agents_dir, global_doc in iter_harness_sources(operation_context):
        if agents_dir is not None:
            _fingerprint_walk(agents_dir, parts, "harness/" + h_id)
        if global_doc is not None:
            _fingerprint_walk(global_doc, parts, "global-docs/" + h_id)
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def fingerprint_path(data_home: Optional[Path] = None) -> Path:
    data_home = Path(data_home) if data_home is not None else _core().data_home()
    return data_home / "state" / "backup-fingerprint.json"


def read_fingerprint(data_home: Optional[Path] = None) -> Optional[str]:
    try:
        return json.loads(fingerprint_path(data_home).read_text()).get("fingerprint")
    except (OSError, ValueError, AttributeError):
        return None


def write_fingerprint(value: str, data_home: Optional[Path] = None) -> None:
    path = fingerprint_path(data_home)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"fingerprint": value, "at": _now_iso()}, indent=2) + "\n")
        os.replace(tmp, path)
    except OSError:
        pass  # derived state — losing it only costs one redundant snapshot


def _backup_context_provenance(operation_context: object) -> dict:
    """Return the safe, non-reversible portion of a backup context.

    Context observations may include installation paths and native probe data;
    neither belongs in a portable manifest.  Identity values are represented by
    one digest so a manifest can still be compared without disclosing them.
    """
    identities = []
    inventory = getattr(operation_context, "inventory", None)
    for identity in getattr(inventory, "identities", ()):
        identities.append(
            {
                "harness_id": str(getattr(identity, "harness_id", "")),
                "installation_id": str(getattr(identity, "installation_id", "")),
                "version": str(getattr(identity, "version", "")),
            }
        )
    identity_digest = hashlib.sha256(
        json.dumps(sorted(identities, key=lambda item: tuple(item.values())), sort_keys=True).encode()
    ).hexdigest()
    routes = {}
    for harness_id in getattr(operation_context, "harness_ids", ()):
        route = _context_route(operation_context, harness_id)
        routes[str(harness_id)] = {
            "status": getattr(route, "status", "unavailable"),
            "mode": getattr(route, "mode", "unavailable"),
        }
    catalog = getattr(operation_context, "catalog", None)
    context_id = str(getattr(operation_context, "context_id", ""))
    if "/" in context_id or "\\" in context_id:
        context_id = hashlib.sha256(context_id.encode()).hexdigest()
    return {
        "context_id": context_id,
        "catalog_digest": getattr(catalog, "content_digest", None),
        "catalog_generation": getattr(catalog, "generation", None),
        "identity_digest": identity_digest,
        "routes": routes,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Snapshot assembly (design §2)
# ─────────────────────────────────────────────────────────────────────────────


def assemble_snapshot(
    dest: Path,
    *,
    registry: Optional[dict] = None,
    data_home: Optional[Path] = None,
    code_home: Optional[Path] = None,
    home: Optional[Path] = None,
    allowed_secrets: Optional[set] = None,
    operation_context: object = None,
) -> dict:
    """Build the full snapshot tree at `dest` and return a summary dict.

    Pure read on the data home + a write into the backup repo — nothing in
    `~/.skill-hub/` or in any harness dir is ever modified. The hub-owned
    entries at `dest` are cleared first so a deletion here propagates to the
    snapshot (and, on the next commit, to git history).

    Ends with the two coded gates: `assert_no_secrets` and
    `assert_transform_applied`.
    """
    core = _core()
    data_home = Path(data_home) if data_home is not None else core.data_home()
    if code_home is None:
        try:
            code_home = core.code_home()
        except Exception:
            code_home = None
    home = Path(home) if home is not None else Path.home()

    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    _harden_dir(dest)

    # Read the previous manifest BEFORE clearing: if the rebuilt tree turns out
    # byte-identical, we put it back verbatim rather than stamping a fresh
    # `created_at`. Without this, the timestamp alone would make every snapshot
    # differ — one noise commit per sync, and idempotency would be a fiction.
    prior_manifest = read_manifest(dest)
    prior_signature = read_signature(dest)
    warnings: list = []

    # A cache miss or an unavailable route cannot prove that an existing
    # harness artifact is obsolete. Preserve those bytes while still rebuilding
    # the other snapshot sections normally; the safety gates below scan the
    # retained tree as well as newly captured files.
    retained_ids: dict[str, set[str]] = {"harness": set(), "global-docs": set()}
    if operation_context is not None:
        for entry in retained_ids:
            root = dest / entry
            if root.is_symlink() or (root.exists() and not root.is_dir()):
                raise BackupError("invalid native snapshot root: " + entry)
    for entry in SNAPSHOT_OWNED:
        root = dest / entry
        if operation_context is None or entry not in retained_ids:
            _rm(root)
            continue
        # Clean each available harness independently. An uncaptured harness is
        # unavailable, even when every captured route is usable.
        if root.is_dir() and not root.is_symlink():
            for child in root.iterdir():
                if _backup_route_usable(operation_context, child.name):
                    _rm(child)
                else:
                    retained_ids[entry].add(child.name)
                    warnings.append(entry + "/" + child.name + " retained: backup route unavailable")
    preserve_harness = bool(retained_ids["harness"])
    preserve_global_docs = bool(retained_ids["global-docs"])

    nested_git: list = []

    # --- portable data-home dirs -------------------------------------------
    for entry in DATA_HOME_PORTABLE:
        if entry == "registry.yaml":
            continue  # written below, in portable form
        src = data_home / entry
        if not src.is_dir():
            continue
        _copy_dir(
            src,
            dest / entry,
            allowed_root=data_home,
            warnings=warnings,
            nested_git=nested_git,
            rel=entry,
        )

    # --- unknown top-level entries: skip, never silently publish ------------
    known_top = {row.entry for row in MANIFEST if "/" not in row.entry}
    try:
        for child in sorted(data_home.iterdir()):
            if child.name in known_top or child.name in MIGRATE_SKIP_PATTERNS:
                continue
            if child.name.startswith("."):
                continue
            warnings.append(
                "not backed up (unknown data-home entry — add it to backup.MANIFEST "
                "if it should travel): " + child.name
            )
    except OSError:
        pass

    # --- registry.yaml, in PORTABLE form ------------------------------------
    if registry is None:
        reg_path = data_home / "registry.yaml"
        try:
            registry = yaml.safe_load(reg_path.read_text()) or {}
        except OSError:
            registry = {}
        except yaml.YAMLError as exc:
            raise BackupError("registry.yaml is unparseable: " + str(exc))
    portable = to_portable(registry, data_home=data_home, code_home=code_home, home=home)
    (dest / "registry.yaml").write_text(
        yaml.safe_dump(
            portable, default_flow_style=False, allow_unicode=True, sort_keys=False
        )
    )
    source_classes = classify_sources(
        registry, data_home=data_home, code_home=code_home, home=home
    )

    # --- state allowlist (with per-row snapshot placement) ------------------
    hostname = safe_hostname()
    state_files: list = []
    for row in MANIFEST:
        if not row.backup or "/" not in row.entry:
            continue
        src = data_home / row.entry
        if src.is_symlink() or not src.is_file():
            continue
        rel_target = (row.snapshot_as or row.entry).format(hostname=hostname)
        target = dest / rel_target
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        state_files.append(rel_target)

    # --- connectors that live OUTSIDE the data home -------------------------
    # A drop-in connector is often a symlink into a checkout elsewhere. Copying
    # through it is refused (a link is never dereferenced), which is correct —
    # but silently ending up with an empty `connectors/` would make a restore
    # look complete while the code is gone. Name them, and record them so
    # restore can report the expectation gap instead of the user discovering it.
    external_connectors = _external_connector_links(data_home)
    for item in external_connectors:
        warnings.append(
            "connector not backed up (it is a symlink out of the data home — its "
            "code lives in another checkout): " + item["name"] + " -> " + item["target"]
        )

    # --- out-of-home state --------------------------------------------------
    subagents = gather_subagents(dest, operation_context)
    global_docs = gather_global_docs(dest, operation_context)
    if operation_context is not None and (preserve_harness or preserve_global_docs):
        prior_subagents = prior_manifest.get("subagents") if prior_manifest else None
        prior_global_docs = prior_manifest.get("global_docs") if prior_manifest else None
        def retained_manifest_paths(paths, section):
            return {
                rel for rel in paths or ()
                if len(str(rel).split("/")) >= 3
                and str(rel).split("/")[0] == section
                and str(rel).split("/")[1] in retained_ids[section]
            }
        subagents = sorted(set(subagents) | retained_manifest_paths(prior_subagents, "harness"))
        global_docs = sorted(set(global_docs) | retained_manifest_paths(prior_global_docs, "global-docs"))

    (dest / ".gitignore").write_text(GITIGNORE_BODY)
    (dest / GITATTRIBUTES_FILE).write_text(GITATTRIBUTES_BODY)

    # --- gates --------------------------------------------------------------
    assert_no_secrets(dest, allowed=allowed_secrets)
    prefixes = [str(data_home), str(home)]
    if code_home is not None:
        prefixes.append(str(code_home))
    warnings.extend(
        assert_transform_applied(
            portable, prefixes, machine_prefixes(data_home, code_home, home)
        )
    )
    warnings.extend(scan_for_machine_prefixes(dest, prefixes))

    counts = {
        "skills": _count_children(dest / "skills"),
        "mcp_servers": _count_children(dest / "mcp-servers"),
        "snippets": _count_children(dest / "snippets"),
        "connectors": _count_children(dest / "connectors"),
        "state_files": len(state_files),
        "subagents": len(subagents),
        "global_docs": len(global_docs),
    }

    files, tree_digest = compute_tree_digest(dest)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "created_at": _now_iso(),
        "hostname": hostname,
        "hub_version": _safe_hub_version(),
        "prefixes": {
            "data_home": str(data_home),
            "code_home": str(code_home) if code_home is not None else None,
            "home": str(home),
        },
        "counts": counts,
        "state_files": state_files,
        "subagents": subagents,
        "global_docs": global_docs,
        "source_classification": source_classes,
        "nested_git": nested_git,
        "external_connectors": external_connectors,
        "redactions": ["skills.*.mcp.env", "skills.*.mcp.headers", "skills.*.mcp.url (query string)"],
        "dropped_keys": list(PORTABLE_DROP_KEYS),
        "warnings": warnings,
        "tree_digest": tree_digest,
        "files": files,
        "retained_artifacts": {
            "harness": bool(preserve_harness),
            "global_docs": bool(preserve_global_docs),
        },
    }
    if operation_context is not None:
        provenance = _backup_context_provenance(operation_context)
        prior_provenance = (prior_manifest or {}).get("operation_context")
        if isinstance(prior_provenance, dict) and (
            {k: v for k, v in provenance.items() if k != "context_id"}
            == {k: v for k, v in prior_provenance.items() if k != "context_id"}
        ):
            # An operation UUID is not a snapshot change. Keep the provenance
            # of the same captured binding instead of creating a noise commit.
            provenance = prior_provenance
        manifest["operation_context"] = provenance

    # The signer's PUBLIC key goes INTO the manifest (so restore can pin it via
    # TOFU without a side channel); the signature over the finished manifest goes
    # into the `manifest.sig` sidecar. A machine without `ssh-keygen` still gets a
    # usable snapshot — it is just an UNSIGNED one, which restore reports loudly
    # rather than accepting quietly.
    signing_warning = None
    try:
        pubkey = _signing().ensure_signing_key()
        manifest["signing"] = {
            "pubkey": pubkey,
            "key_id": _signing().key_id(pubkey),
            "namespace": SIGNING_NAMESPACE,
        }
    except Exception as exc:
        pubkey = None
        signing_warning = (
            "snapshot is UNSIGNED (could not use the hub signing key: "
            + str(exc)
            + ") — a restore from it will require explicit --trust-new-key"
        )
        warnings.append(signing_warning)
        manifest["warnings"] = warnings

    reused = False
    if prior_manifest is not None and prior_manifest.get("tree_digest") == tree_digest:
        # Same content as the last snapshot — keep the original manifest so the
        # whole tree stays byte-identical and `git commit` correctly no-ops.
        # `created_at` therefore means "when this content was first captured",
        # which is also the more useful reading.
        #
        # The MACHINE-scoped fields are refreshed anyway: identical content says
        # nothing about which host wrote it, where its homes are, which
        # connectors are external here, or which key is signing now. Keeping a
        # stale `prefixes` would make restore remap from the wrong machine, and a
        # stale `signing.pubkey` would name a key the re-signed `manifest.sig`
        # was NOT made with — a snapshot that fails its own verification. When
        # every one of them already matches, the bytes are unchanged and the
        # commit still no-ops, so the idempotency guarantee is untouched.
        refreshed = {k: manifest[k] for k in _MANIFEST_REFRESH_ON_REUSE if k in manifest}
        dropped = [k for k in _MANIFEST_REFRESH_ON_REUSE if k not in manifest]
        manifest = dict(prior_manifest)
        manifest.update(refreshed)
        for key in dropped:
            manifest.pop(key, None)
        reused = True
    manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    # The tree scan above ran before this file existed (it has to — the manifest
    # hashes the finished tree), so scan it explicitly rather than trusting that
    # hub-generated JSON is inherently safe: it carries user-controlled strings.
    assert_findings_acknowledged(scan_manifest_text(manifest_text), allowed_secrets)
    (dest / MANIFEST_FILE).write_text(manifest_text)

    # Reuse the prior signature when the manifest body is unchanged AND it still
    # verifies: re-signing identical bytes should be deterministic for ed25519,
    # but relying on that would make a signature-format change show up as a noise
    # commit on every sync rather than as an explicit re-sign.
    signature = None
    if reused and prior_signature and manifest_signer(manifest):
        if verify_manifest_signature(
            manifest_text, prior_signature, manifest_signer(manifest)
        ):
            signature = prior_signature
    if signature is None and manifest_signer(manifest):
        try:
            signature = sign_manifest_text(manifest_text)
        except Exception as exc:
            signature = None
            warnings.append(
                "snapshot could not be signed (" + str(exc) + ") — a restore from "
                "it will require explicit --trust-new-key"
            )
    if signature:
        (dest / SIGNATURE_FILE).write_text(
            signature if signature.endswith("\n") else signature + "\n"
        )

    return {
        "dir": str(dest),
        "counts": counts,
        "manifest": manifest,
        "signed": bool(signature),
        "warnings": warnings,
    }


def _external_connector_links(data_home: Path) -> list:
    """Drop-in connectors that are symlinks pointing OUT of the data home.

    `[{"name", "target"}]`, sorted. These are correctly skipped by `_copy_dir`
    (a symlink is never dereferenced into the snapshot) — this just makes the
    omission legible in the manifest instead of leaving an empty `connectors/`.
    """
    out: list = []
    root = Path(data_home) / "connectors"
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return out
    for entry in entries:
        if not entry.is_symlink() or _within(entry, Path(data_home)):
            continue
        try:
            target = os.readlink(entry)
        except OSError:
            target = "?"
        out.append({"name": entry.name, "target": target})
    return out


def _safe_hub_version() -> str:
    try:
        return _core().hub_version()
    except Exception:
        return "unknown"


def read_manifest(dest: Path) -> Optional[dict]:
    """Parse `manifest.json` from a snapshot dir (None if missing/invalid)."""
    try:
        return json.loads((Path(dest) / "manifest.json").read_text())
    except (OSError, ValueError):
        return None


def verify_tree_digest(dest: Path) -> dict:
    """Re-hash a snapshot dir and compare against its manifest (M3 restore gate)."""
    manifest = read_manifest(dest)
    if manifest is None:
        return {"ok": False, "detail": "manifest.json missing or unparseable"}
    _files, digest = compute_tree_digest(dest)
    if digest != manifest.get("tree_digest"):
        return {"ok": False, "detail": "tree digest mismatch — snapshot is incomplete"}
    return {"ok": True, "detail": "tree digest matches"}


# ─────────────────────────────────────────────────────────────────────────────
# Manifest signing (design §2 "SSHSIG signature by hub signing key", §5 TOFU)
#
# The signature is taken over the FINISHED `manifest.json` bytes, which in turn
# carry the tree digest and every per-file hash — so one signature transitively
# attests the whole snapshot. It lives in a sidecar (`manifest.sig`) rather than
# inside the manifest, because a field inside the document cannot sign the
# document that contains it.
#
# The signer's PUBLIC key travels inside the manifest (`signing.pubkey`); the
# private half never leaves `state/signing/`. Publishing the pubkey is not a
# leak — it is what makes TOFU pinning possible on the restore machine — and it
# is deliberately NOT the registry's `signing:` pin, which is dropped from the
# portable registry precisely because it pins a key that does not travel.
# ─────────────────────────────────────────────────────────────────────────────


def _signing():
    from skill_hub.infrastructure.connectors import signing as _mod

    return _mod


def signature_items(manifest_text: str) -> list:
    """The `(relpath, sha256)` pairs fed to `signing.canonical_manifest_bytes`.

    Exactly one pair — the sha256 of the manifest body — so verification only
    needs the manifest file itself, and any edit to any recorded hash (or to the
    tree digest) invalidates the signature.
    """
    return [(MANIFEST_FILE, hashlib.sha256(manifest_text.encode("utf-8")).hexdigest())]


def read_signature(dest: Path) -> Optional[str]:
    try:
        return (Path(dest) / SIGNATURE_FILE).read_text()
    except OSError:
        return None


def manifest_signer(manifest: Optional[dict]) -> Optional[str]:
    """The armored pubkey the manifest claims as its signer, or None."""
    block = (manifest or {}).get("signing")
    if not isinstance(block, dict):
        return None
    pub = block.get("pubkey")
    return str(pub) if pub else None


def sign_manifest_text(manifest_text: str, *, runner=None) -> str:
    """SSHSIG-sign a manifest body with the hub signing key (creating it if new)."""
    sig = _signing()
    sig.ensure_signing_key(runner=runner)
    return sig.sign_manifest(
        signature_items(manifest_text), namespace=SIGNING_NAMESPACE, runner=runner
    )


def verify_manifest_signature(
    manifest_text: str, signature: str, pubkey: str, *, runner=None
) -> bool:
    """Fail-closed verify of a manifest body against an armored pubkey."""
    sig = _signing()
    try:
        return bool(
            sig.verify_manifest(
                signature_items(manifest_text),
                signature,
                pubkey,
                namespace=SIGNING_NAMESPACE,
                runner=runner,
            )
        )
    except sig.SigningError:
        return False


#: Verdicts `verify_snapshot_signature` can return. Only `signed` means the
#: bytes are attested; the TRUST decision (is this signer known?) belongs to the
#: restore-side pin store, not here.
SIG_SIGNED = "signed"
SIG_UNSIGNED = "unsigned"
SIG_INVALID = "invalid"
SIG_UNAVAILABLE = "unavailable"


def verify_snapshot_signature(dest: Path, *, runner=None) -> dict:
    """Verify a snapshot dir's `manifest.sig` against the pubkey in its manifest.

    Returns `{"state", "pubkey", "key_id", "detail"}`. `invalid` means the bytes
    were tampered with (or signed by a different key than the manifest claims)
    and MUST be a hard refusal; `unsigned` and `unavailable` are consent-gated
    states, not silent passes.
    """
    dest = Path(dest)
    manifest_path = dest / MANIFEST_FILE
    try:
        manifest_text = manifest_path.read_text()
    except OSError:
        return {
            "state": SIG_INVALID,
            "pubkey": None,
            "key_id": None,
            "detail": "manifest.json is missing or unreadable",
        }
    manifest = read_manifest(dest)
    pubkey = manifest_signer(manifest)
    signature = read_signature(dest)
    if not pubkey or not signature:
        return {
            "state": SIG_UNSIGNED,
            "pubkey": pubkey,
            "key_id": _signing().key_id(pubkey) if pubkey else None,
            "detail": "snapshot carries no signature (written by an unsigned hub, "
            "or the signature file was removed)",
        }
    sig = _signing()
    if not sig.is_available():
        return {
            "state": SIG_UNAVAILABLE,
            "pubkey": pubkey,
            "key_id": sig.key_id(pubkey),
            "detail": "ssh-keygen is unavailable — the signature cannot be checked "
            "on this machine",
        }
    ok = verify_manifest_signature(manifest_text, signature, pubkey, runner=runner)
    return {
        "state": SIG_SIGNED if ok else SIG_INVALID,
        "pubkey": pubkey,
        "key_id": sig.key_id(pubkey),
        "detail": (
            "signature verifies against the key the manifest names"
            if ok
            else "SIGNATURE DOES NOT VERIFY — the snapshot was modified after it "
            "was signed, or it was signed by a different key"
        ),
    }


def commit_message(manifest: dict) -> str:
    """`backup: <host> <ts>` + a one-line content summary + the hub version."""
    counts = manifest.get("counts") or {}
    summary = ", ".join(
        "{0}: {1}".format(key.replace("_", "-"), counts.get(key, 0))
        for key in ("skills", "mcp_servers", "snippets", "subagents", "global_docs")
    )
    return "backup: {host} {ts}\n\n{summary}\nhub {version}\n".format(
        host=manifest.get("hostname", "unknown"),
        ts=manifest.get("created_at", _now_iso()),
        summary=summary,
        version=manifest.get("hub_version", "unknown"),
    )


# Git ops (design §7), the auth ladder and GitHub repo creation now live in
# `backup_git.py`; every name is re-imported at the top of this file.


# ─────────────────────────────────────────────────────────────────────────────
# `hub backup init` guards (design §7)
# ─────────────────────────────────────────────────────────────────────────────


def validate_backup_dir(
    dest: Path,
    *,
    data_home: Optional[Path] = None,
    code_home: Optional[Path] = None,
) -> None:
    """Refuse a backup dir that would be self-referential or hijack another repo.

    * Inside the data home  → the snapshot would recursively contain itself.
    * Inside the code home  → it would pollute (and be wiped by) the install.
    * Non-empty and not ours → we would commit and push a stranger's files.

    Cheap enough (stats, plus one `git log` only in the ambiguous
    repo-without-manifest case) to re-run on EVERY snapshot, which `run_backup`
    does: `hub backup init` is not the only path to a `backup.dir`, since the
    registry is a user-editable file and `migrate-home` can move the data home
    out from under it. `run_backup` would otherwise `git init` and prune
    `SNAPSHOT_OWNED` names inside whatever directory the registry names.
    """
    core = _core()
    dest = Path(dest)
    if data_home is None:
        data_home = core.data_home()
    if code_home is None:
        try:
            code_home = core.code_home()
        except Exception:
            code_home = None

    for base, label in ((data_home, "the data home"), (code_home, "the code home")):
        if base is None:
            continue
        same = Path(dest).resolve(strict=False) == Path(base).resolve(strict=False)
        if same or _within(dest, base):
            raise BackupError(
                "backup dir " + str(dest) + " must not live inside " + label
                + " (" + str(base) + ")"
            )

    if not dest.exists():
        return
    if not dest.is_dir():
        raise BackupError("backup dir " + str(dest) + " exists and is not a directory")
    entries = [e for e in dest.iterdir() if e.name != ".DS_Store"]
    if not entries:
        return
    if not is_git_repo(dest):
        raise BackupError(
            "backup dir " + str(dest) + " is not empty and is not a git repo — "
            "point --dir at a new or empty location"
        )
    if (dest / MANIFEST_FILE).exists():
        return  # ours
    if git_last_commit(dest) is None:
        return  # empty repo — safe to adopt
    if ref_has_manifest(dest, "HEAD"):
        # Ours, mid-rebuild. `assemble_snapshot` prunes every SNAPSHOT_OWNED
        # name (manifest.json first) before it writes the new ones, so an
        # interrupt — ^C, a crash, a laptop lid — leaves a repo whose COMMITS
        # carry a manifest while the working tree does not. Judging that by the
        # working tree alone made the refusal permanent: every later run,
        # including `hub backup init`, saw "commits but no manifest.json" and
        # bricked the directory for good. HEAD is the durable statement of whose
        # repo this is; `heal_working_tree` puts the tree back.
        return
    raise BackupError(
        "refusing to adopt the existing git repo at " + str(dest)
        + " — it has commits but no Skill Tree manifest.json"
    )


def heal_working_tree(repo_dir: Path) -> Optional[str]:
    """Restore a snapshot working tree that an interrupted assembly left pruned.

    Returns a human detail when it did something, else None. Only ever fires on
    a repo whose HEAD carries a manifest and whose working tree does not — i.e.
    a tree hub itself half-deleted. Everything under `SNAPSHOT_OWNED` is
    regenerated by the next assembly anyway; restoring HEAD first means the
    prior manifest is readable again (so an unchanged snapshot still no-ops
    instead of stamping a fresh `created_at`) and no half-pruned leftovers
    survive into the commit.
    """
    repo_dir = Path(repo_dir)
    if not is_git_repo(repo_dir) or (repo_dir / MANIFEST_FILE).exists():
        return None
    if not ref_has_manifest(repo_dir, "HEAD"):
        return None
    reset = git(repo_dir, "reset", "--hard", "-q", "HEAD", check=False)
    if reset.returncode != 0:
        return (
            "an interrupted snapshot left the backup dir without a manifest.json and "
            "it could not be restored from HEAD: "
            + ((reset.stderr or reset.stdout or "").strip().splitlines() or ["unknown"])[0]
        )
    return (
        "recovered from an interrupted snapshot — the working tree was restored "
        "from the last commit before rebuilding"
    )


def verify_remote_is_ours(repo_dir: Path, branch: str, timeout: int = NETWORK_TIMEOUT) -> dict:
    """If the remote branch already has commits, require `manifest.json` at its tip.

    An unverifiable remote (offline, auth not set up yet) is a WARNING, never a
    refusal — we cannot prove anything about a repo we cannot read. A remote we
    CAN read that carries someone else's history is a hard refusal.
    """
    ls = git(repo_dir, "ls-remote", "--heads", "origin", branch, check=False, timeout=timeout)
    if ls.returncode != 0:
        return {"verified": False, "detail": "could not reach the remote to verify it"}
    if not (ls.stdout or "").strip():
        return {"verified": True, "detail": "remote branch is empty — safe to publish"}
    fetched = git(repo_dir, "fetch", "-q", "origin", branch, check=False, timeout=timeout)
    if fetched.returncode != 0:
        return {"verified": False, "detail": "could not fetch the remote branch to verify it"}
    if git(repo_dir, "cat-file", "-e", "FETCH_HEAD:manifest.json", check=False).returncode != 0:
        raise BackupError(
            "remote branch '" + branch + "' already has commits but no manifest.json — "
            "that is not a Skill Tree backup repo; point --repo at a fresh private repo"
        )
    return {"verified": True, "detail": "remote tip carries a Skill Tree manifest"}


# ─────────────────────────────────────────────────────────────────────────────
# Registry `backup:` block
# ─────────────────────────────────────────────────────────────────────────────


def default_backup_config() -> dict:
    return {
        "dir": DEFAULT_BACKUP_DIR,
        "remote": None,
        "repo": None,
        "branch": DEFAULT_BRANCH,
        "auth": "auto",
        "gh_login": None,
        "enabled": False,
        "push_failures": 0,
        "last_push_error": None,
        "allowed_secrets": [],
        # Set by M3 restore; `hub backup now` refuses to PUSH while true so a
        # degraded restored state never overwrites the good snapshot.
        "pending_reconcile": False,
        # When that hold started, so the doctor can tell "restored an hour ago"
        # from "has been blocking every push for three weeks".
        "pending_reconcile_at": None,
    }


def load_backup_config(registry: dict) -> dict:
    """Normalized `backup:` block (defaults filled in; never mutates `registry`)."""
    cfg = default_backup_config()
    raw = (registry or {}).get("backup")
    if isinstance(raw, dict):
        for key in cfg:
            if key in raw and raw[key] is not None:
                cfg[key] = raw[key]
    cfg["enabled"] = bool(cfg["enabled"])
    cfg["pending_reconcile"] = bool(cfg["pending_reconcile"])
    if not cfg["pending_reconcile"]:
        cfg["pending_reconcile_at"] = None
    cfg["dir"] = str(cfg["dir"] or DEFAULT_BACKUP_DIR)
    cfg["branch"] = str(cfg["branch"] or DEFAULT_BRANCH)
    try:
        cfg["push_failures"] = int(cfg["push_failures"])
    except (TypeError, ValueError):
        cfg["push_failures"] = 0
    if not isinstance(cfg["allowed_secrets"], list):
        cfg["allowed_secrets"] = []
    if cfg["auth"] not in AUTH_METHODS:
        cfg["auth"] = "auto"
    return cfg


def save_backup_config(registry: dict, cfg: dict) -> None:
    registry["backup"] = {
        "dir": cfg.get("dir") or DEFAULT_BACKUP_DIR,
        "remote": cfg.get("remote"),
        "repo": cfg.get("repo"),
        "branch": cfg.get("branch") or DEFAULT_BRANCH,
        "auth": cfg.get("auth") or "auto",
        "gh_login": cfg.get("gh_login"),
        "enabled": bool(cfg.get("enabled")),
        "push_failures": int(cfg.get("push_failures") or 0),
        "last_push_error": cfg.get("last_push_error"),
        "allowed_secrets": list(cfg.get("allowed_secrets") or []),
        "pending_reconcile": bool(cfg.get("pending_reconcile")),
        "pending_reconcile_at": (
            cfg.get("pending_reconcile_at") if cfg.get("pending_reconcile") else None
        ),
    }


def has_backup_config(registry: dict) -> bool:
    return isinstance((registry or {}).get("backup"), dict)


def backup_dir(registry: dict) -> Path:
    return Path(load_backup_config(registry)["dir"]).expanduser()


def is_initialized(registry: dict) -> bool:
    """True iff a `backup:` block exists AND its dir is a git repo."""
    return has_backup_config(registry) and is_git_repo(backup_dir(registry))


def record_push_outcome(registry: dict, result: dict) -> bool:
    """Fold a run's push outcome into the `backup:` block. True if it changed.

    Fail-open must not mean fail-SILENT: a run of consecutive failures is what
    the doctor and the StatusBar key off.
    """
    if not has_backup_config(registry):
        return False
    cfg = load_backup_config(registry)
    before = (cfg["push_failures"], cfg["last_push_error"])
    if result.get("skipped") or not result.get("push_attempted"):
        return False
    if result.get("pushed"):
        cfg["push_failures"] = 0
        cfg["last_push_error"] = None
    else:
        cfg["push_failures"] = int(cfg["push_failures"]) + 1
        cfg["last_push_error"] = result.get("error") or result.get("push_detail") or "push failed"
    if (cfg["push_failures"], cfg["last_push_error"]) == before:
        return False
    save_backup_config(registry, cfg)
    return True


# ─────────────────────────────────────────────────────────────────────────────
# High-level entry points
# ─────────────────────────────────────────────────────────────────────────────


def _data_home_lock():
    """`hub.data_home_lock()`, degrading to a no-op if hub cannot provide one.

    Held only around snapshot assembly + commit (never across the push), so a
    concurrent registry mutation can never be captured half-written, while a
    slow network never blocks another hub process.
    """
    try:
        return _core().data_home_lock()
    except Exception:
        from contextlib import nullcontext

        return nullcontext()


def run_backup(
    registry: dict,
    *,
    push: bool = True,
    force: bool = False,
    push_timeout: int = NETWORK_TIMEOUT,
    data_home: Optional[Path] = None,
    code_home: Optional[Path] = None,
    home: Optional[Path] = None,
    operation_context: object = None,
) -> dict:
    """Assemble → commit → (optionally) push. Returns a machine-readable result.

    `force=False` (the `_auto_sync` path) short-circuits on an unchanged
    stat-fingerprint so a per-click sync costs a few hundred `stat()` calls
    instead of a multi-megabyte copy. Expected failures (git/network/auth) are
    reported in the result rather than raised, so the sync tail pass stays
    fail-open — but `SecretLeakError` / `PrefixLeakError` DO propagate: refusing
    to publish a credential (or a broken transform) is not a "soft" failure.

    Takes the data-home lock ITSELF, around assembly + commit only — callers
    must NOT wrap the whole call, or the lock would again be held across the
    network push.
    """
    core = _core()
    resolved_data_home = Path(data_home) if data_home is not None else core.data_home()
    cfg = load_backup_config(registry)
    dest = Path(cfg["dir"]).expanduser()
    branch = cfg["branch"]

    # Re-validate on EVERY run, not just at `init`: everything below this line
    # writes into `dest` (git init, then `_rm()` of every SNAPSHOT_OWNED name),
    # and nothing guarantees the registry's `backup.dir` still points where init
    # left it. An already-ours dir (our manifest + a repo) or an empty/missing
    # one returns immediately; anything else refuses before the first write.
    validate_backup_dir(dest, data_home=resolved_data_home, code_home=code_home)

    git_init(dest, branch)
    if cfg.get("remote"):
        git_set_remote(dest, str(cfg["remote"]))

    result = {
        "ok": True,
        "dir": str(dest),
        "skipped": None,
        "committed": False,
        "commit": None,
        "push_attempted": False,
        "pushed": False,
        "conflict": False,
        "push_detail": "",
        "auth": None,
        "counts": {},
        "warnings": [],
        "error": None,
    }

    if push and cfg.get("pending_reconcile"):
        push = False
        result["warnings"].append(
            "push held back: a restore is pending reconciliation "
            "(clear it before publishing over the snapshot)"
        )

    # Put an interrupted rebuild's working tree back BEFORE the dirty check —
    # otherwise the half-pruned tree reads as dirty forever and every run pays a
    # full assembly (and `read_manifest` sees nothing, so the manifest reuse that
    # keeps an unchanged snapshot commit-free cannot fire).
    healed = heal_working_tree(dest)
    if healed:
        result["warnings"].append(healed)

    fingerprint = snapshot_fingerprint(resolved_data_home, operation_context)
    if not force and fingerprint == read_fingerprint(resolved_data_home):
        try:
            dirty = git_is_dirty(dest)
        except GitError:
            dirty = True
        if not dirty:
            result["skipped"] = "unchanged"
            result["push_detail"] = "nothing changed since the last snapshot"
            return result

    # Adopt the remote tip FIRST so the rebuilt tree is a fast-forward by
    # construction — hub never merges and never force-pushes. This is a NETWORK
    # op, so it stays outside the data-home lock (see below).
    #
    # Gated on `push`, not merely on a configured remote: `_auto_sync` (one
    # equip click = one sync) passes `push=False`, and a `git fetch` on that path
    # would put a network round-trip — up to the full timeout against an
    # unreachable GitHub — behind every click, to prepare a push that is not
    # going to happen. The next explicit `hub sync` adopts and pushes.
    if push and cfg.get("remote"):
        try:
            adopted = git_adopt_remote_tip(dest, branch, timeout=push_timeout)
            if adopted.get("foreign"):
                # Never publish over a repo that is not a Skill Tree backup.
                push = False
                result["ok"] = False
                result["error"] = adopted["detail"]
                result["warnings"].append(adopted["detail"])
            elif not adopted["adopted"] and (
                adopted.get("warn") or "could not fetch" in adopted["detail"]
            ):
                result["warnings"].append(adopted["detail"] + " — snapshotting locally")
            elif adopted.get("saved_ref"):
                result["saved_ref"] = adopted["saved_ref"]
                result["warnings"].append(
                    "the remote had moved on; this machine's local-only snapshot history "
                    "was preserved at " + adopted["saved_ref"] + " before adopting the remote tip"
                )
        except GitError as exc:
            result["warnings"].append("remote unreachable (" + str(exc) + ") — snapshotting locally")

    # The data-home lock covers assembly + commit ONLY. Holding it across the
    # push would block every other hub process (an equip click, the app) for the
    # length of a network round-trip to GitHub — up to the full push timeout —
    # for no benefit: once the commit lands, the push reads git objects only and
    # touches nothing under the data home.
    with _data_home_lock():
        summary = assemble_snapshot(
            dest,
            data_home=data_home,
            code_home=code_home,
            home=home,
            allowed_secrets=set(cfg.get("allowed_secrets") or []),
            operation_context=operation_context,
        )
        manifest = summary["manifest"]
        result["counts"] = summary["counts"]
        result["warnings"].extend(summary.get("warnings") or [])

        try:
            sha = git_commit(dest, commit_message(manifest))
        except GitError as exc:
            result["ok"] = False
            result["error"] = str(exc)
            return result
        result["committed"] = sha is not None
        result["commit"] = sha
        write_fingerprint(fingerprint, resolved_data_home)

    if not push:
        result["push_detail"] = "push deferred"
        return result
    if not cfg.get("remote"):
        result["push_detail"] = "no remote configured"
        return result

    auth = detect_auth(cfg.get("auth"))
    result["auth"] = auth["method"]
    result["push_attempted"] = True
    if auth["method"] is None:
        result["push_detail"] = "no usable GitHub credential (see `hub backup auth`)"
        result["warnings"].append(result["push_detail"])
        return result
    try:
        pushed = git_push(dest, method=auth["method"], branch=branch, timeout=push_timeout)
    except BackupError as exc:
        result["ok"] = False
        result["error"] = str(exc)
        result["push_detail"] = str(exc)
        return result
    result["pushed"] = bool(pushed.get("pushed"))
    result["conflict"] = bool(pushed.get("conflict"))
    result["push_detail"] = pushed.get("detail", "")
    if result["conflict"]:
        result["warnings"].append(result["push_detail"])
    if result["pushed"]:
        # Every tip parked before this push had its content go out in the tree we
        # just published, so none of them can still recover anything. The one
        # this run parked (if any) is kept — it is what the warning points at.
        pruned = prune_local_tip_refs(
            dest, keep=0, exclude=[result.get("saved_ref")]
        )
        if pruned:
            result["pruned_refs"] = pruned
    return result


def backup_status(registry: dict, operation_context: object = None) -> dict:
    """Status of the backup repo. No network dial except the `gh` account check.

    The full auth ladder is deliberately NOT walked here (`hub backup auth`
    exists for that) so the app can poll status cheaply. The one exception is
    the `gh` active-account check, and only when init actually recorded a `gh`
    login — a silently switched `gh` account would otherwise create or push the
    backup under the wrong user's GitHub.
    """
    cfg = load_backup_config(registry)
    dest = Path(cfg["dir"]).expanduser()
    initialized = has_backup_config(registry) and is_git_repo(dest)
    if operation_context is None:
        pat = probe_pat()
    else:
        pat = {
            "available": False,
            "detail": "unavailable (cache-only operation context)",
        }

    out = {
        "enabled": bool(cfg["enabled"]),
        "initialized": initialized,
        "configured": has_backup_config(registry),
        "dir": str(dest),
        "remote": cfg.get("remote"),
        "repo": cfg.get("repo"),
        "branch": cfg.get("branch"),
        "auth": {
            "configured": cfg.get("auth", "auto"),
            "pat_available": pat["available"],
            "pat_detail": pat["detail"],
            "gh_login": cfg.get("gh_login"),
            "gh_active_login": None,
            "gh_account_mismatch": False,
        },
        "push_failures": cfg.get("push_failures", 0),
        "last_push_error": cfg.get("last_push_error"),
        "pending_reconcile": bool(cfg.get("pending_reconcile")),
        "last_commit": None,
        "ahead": None,
        "behind": None,
        "drift": "unknown",
        "manifest": None,
        "warnings": [],
    }

    if cfg.get("gh_login") and operation_context is None:
        active = gh_active_login()
        out["auth"]["gh_active_login"] = active
        if active and active != cfg["gh_login"]:
            out["auth"]["gh_account_mismatch"] = True
            out["warnings"].append(
                "gh is active as '" + active + "' but this backup was configured with '"
                + str(cfg["gh_login"]) + "' — run `gh auth switch --user "
                + str(cfg["gh_login"]) + "` before creating repos, or re-run `hub backup init`"
            )

    # NO push-failure warning here. `push_failures` + `last_push_error` are
    # already in this payload, and every consumer renders them in the error
    # channel; adding a prose restatement made the app say the same fact four
    # times over (header chip, error card, "Push failures" row, and a BLUE
    # informational banner — the wrong channel for an error). The CLI's own
    # status printer says it once, from the counters, just below.
    if not initialized:
        return out

    out["branch"] = git_current_branch(dest)
    out["last_commit"] = git_last_commit(dest)
    out["manifest"] = read_manifest(dest)
    counts = git_ahead_behind(dest, out["branch"])
    if counts is not None:
        out["ahead"] = counts["ahead"]
        out["behind"] = counts["behind"]
        if counts["ahead"] and counts["behind"]:
            out["drift"] = "diverged"
        elif counts["ahead"]:
            out["drift"] = "ahead"
        elif counts["behind"]:
            out["drift"] = "behind"
        else:
            out["drift"] = "in-sync"
    return out
