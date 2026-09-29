"""skill_hub/infrastructure/backup/backup_git.py — git ops, the auth ladder, and GitHub repo creation.

The bottom of the backup stack (design §7): a dedicated git runner whose
`env_overrides` win over the process env, the ssh → PAT → gh ladder, and
`gh`-only repo creation. `backup.py` sits above it and re-imports every name
here, so `backup.<name>` keeps resolving for `restore.py`, `hub_cli/*` and the
tests.

Leaf: imports `hub_core` and stdlib only — never `backup` (that would be a
load-time cycle) and never the `hub` monolith.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from skill_hub.hub_core import _now_iso

#: `DEFAULT_BRANCH` also backs `backup.py`'s snapshot-init defaults
#: (`default_backup_config`, `load_backup_config`, `save_backup_config`) — one
#: definition, re-imported there.
DEFAULT_BRANCH = "main"

#: `manifest.json` is the marker `ref_has_manifest`/`remote_tip_has_manifest`
#: look for on a remote tip before ever adopting it. `backup.py` also folds
#: this name into its own `DIGEST_EXCLUDED` tuple via the re-import below.
MANIFEST_FILE = "manifest.json"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Auth (design §7)
# ─────────────────────────────────────────────────────────────────────────────

KEYCHAIN_SERVICE = "skill-hub"
KEYCHAIN_ACCOUNT = "github-backup"
PAT_SECRET_REF = KEYCHAIN_SERVICE + ":" + KEYCHAIN_ACCOUNT

#: Ladder order for *reporting* and repo-creation capability.
AUTH_METHODS = ("ssh", "gh", "pat")
#: Ladder order for *pushing*. `gh` is deliberately last: multiple `gh` accounts
#: live on this machine and the active one is ambient global state, so a push
#: that silently borrows whichever is active is a footgun. `gh` is for repo
#: CREATION (explicit, one-time, reviewable).
PUSH_METHOD_ORDER = ("ssh", "pat", "gh")

#: The helper string in argv names the variable; it never holds the value.
_PAT_CREDENTIAL_HELPER = (
    '!f(){ echo username=x-access-token; '
    'echo "password=$SKILL_HUB_BACKUP_TOKEN"; };f'
)

PAT_SCOPE_HELP = (
    "fine-grained PAT, scoped to the single backup repo, "
    "Repository permissions -> Contents: Read and write"
)

GIT_IDENTITY_NAME = "Skill Tree Backup"
GIT_IDENTITY_EMAIL = "backup@skill-tree.local"

#: Network git ops get a SHORT timeout so the fail-open sync tail pass cannot
#: stall a sync behind an unreachable GitHub.
NETWORK_TIMEOUT = 20
#: An explicit `hub backup now` may legitimately take longer (first push of a
#: large history), so the CLI raises the ceiling.
INTERACTIVE_PUSH_TIMEOUT = 120
LOCAL_GIT_TIMEOUT = 60

#: Consecutive push failures before the doctor/StatusBar should shout.
PUSH_FAILURE_ALERT_THRESHOLD = 3


# ─────────────────────────────────────────────────────────────────────────────
# Errors
#
# `SecretLeakError`/`PrefixLeakError` (snapshot-layer errors) subclass
# `BackupError` too, from `backup.py`, via the re-import below.
# ─────────────────────────────────────────────────────────────────────────────


class BackupError(RuntimeError):
    """Any recoverable backup failure. The sync tail pass swallows these."""


class GitError(BackupError):
    """A `git` invocation failed (or timed out)."""


def _harden_dir(path: Path) -> None:
    """0700 the backup dir — it mirrors the data home's own 0700 posture."""
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Git ops (design §7)
#
# A DEDICATED runner, deliberately not `hub._run_git`: that helper applies its
# non-interactive env (including `GIT_ASKPASS=echo`) AFTER copying `os.environ`,
# which would clobber any credential plumbing we set. Here the caller's
# `env_overrides` are applied LAST, so they always win.
# ─────────────────────────────────────────────────────────────────────────────


def git(
    repo_dir: Path,
    *args: str,
    env_overrides: Optional[dict] = None,
    check: bool = True,
    timeout: int = LOCAL_GIT_TIMEOUT,
):
    """Run `git -C <repo_dir> …`, capturing output.

    Raises `GitError` on non-zero (when `check`), on a missing binary, AND on
    timeout — so every failure mode reaches callers as one catchable type and
    the sync tail pass stays genuinely fail-open.
    """
    cmd = ["git", "-C", str(repo_dir)] + list(args)
    run_env = dict(os.environ)
    run_env["GIT_TERMINAL_PROMPT"] = "0"
    if env_overrides:
        run_env.update(env_overrides)  # caller wins — see the note above
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, env=run_env, timeout=timeout
        )
    except FileNotFoundError as exc:
        raise GitError("git is not installed or not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(
            "git " + " ".join(args) + " timed out after " + str(timeout) + "s"
        ) from exc
    if check and proc.returncode != 0:
        raise GitError(
            "git " + " ".join(args) + " failed: " + (proc.stderr or proc.stdout).strip()
        )
    return proc


def is_git_repo(repo_dir: Path) -> bool:
    return (Path(repo_dir) / ".git").exists()


def git_init(repo_dir: Path, branch: str = DEFAULT_BRANCH) -> None:
    """`git init -b <branch>`, with a fallback for git < 2.28.

    Explicit because this machine's `init.defaultBranch` is unset (→ `master`)
    while GitHub/`gh` create `main`; letting the default decide would produce a
    repo whose only branch never matches the remote's.
    """
    repo_dir = Path(repo_dir)
    repo_dir.mkdir(parents=True, exist_ok=True)
    _harden_dir(repo_dir)
    if is_git_repo(repo_dir):
        return
    if git(repo_dir, "init", "-q", "-b", branch, check=False).returncode != 0:
        git(repo_dir, "init", "-q")
        git(repo_dir, "symbolic-ref", "HEAD", "refs/heads/" + branch, check=False)


def git_current_branch(repo_dir: Path) -> str:
    proc = git(repo_dir, "symbolic-ref", "--short", "HEAD", check=False)
    return (proc.stdout or "").strip() or DEFAULT_BRANCH


def git_set_remote(repo_dir: Path, url: str, name: str = "origin") -> None:
    proc = git(repo_dir, "remote", "get-url", name, check=False)
    if proc.returncode == 0:
        if (proc.stdout or "").strip() != url:
            git(repo_dir, "remote", "set-url", name, url)
    else:
        git(repo_dir, "remote", "add", name, url)


def git_remote_url(repo_dir: Path, name: str = "origin") -> Optional[str]:
    proc = git(repo_dir, "remote", "get-url", name, check=False)
    if proc.returncode != 0:
        return None
    return (proc.stdout or "").strip() or None


def git_is_dirty(repo_dir: Path) -> bool:
    return bool((git(repo_dir, "status", "--porcelain").stdout or "").strip())


def local_tip_ref_name(now: Optional[str] = None) -> str:
    """Name for the ref that preserves a local tip about to be reset away."""
    stamp = (now or _now_iso()).replace(":", "").replace("-", "")
    return "refs/backup/local-" + stamp


#: Most parked local tips to keep. They are a recovery aid, not an archive —
#: an unbounded `refs/backup/local-*` set grows one ref per divergence forever.
MAX_PARKED_LOCAL_TIPS = 10

_PARKED_REF_PREFIX = "refs/backup/local-"


def parked_local_tips(repo_dir: Path) -> list:
    """Every `refs/backup/local-*` ref currently parked, oldest name first."""
    proc = git(
        repo_dir,
        "for-each-ref",
        "--format=%(refname)",
        _PARKED_REF_PREFIX.rstrip("-") + "*",
        check=False,
    )
    if proc.returncode != 0:
        return []
    return sorted(
        line.strip()
        for line in (proc.stdout or "").splitlines()
        if line.strip().startswith(_PARKED_REF_PREFIX)
    )


def prune_local_tip_refs(
    repo_dir: Path, *, keep: int = MAX_PARKED_LOCAL_TIPS, exclude=()
) -> list:
    """Drop all but the newest `keep` parked tips. Returns the refs deleted.

    Called with `keep=0` after a SUCCESSFUL push: every tip parked BEFORE that
    push had its content rebuilt into the tree that just went out (each snapshot
    commit is a complete tree), so it has nothing left to recover. `exclude`
    spares the ref parked during THIS run — the result reports it and the
    warning names it, so deleting it in the same breath would make both a lie;
    it goes on the next successful push instead.
    """
    spared = {str(ref) for ref in (exclude or ()) if ref}
    refs = [ref for ref in parked_local_tips(repo_dir) if ref not in spared]
    doomed = refs[: max(0, len(refs) - max(0, keep))]
    deleted = []
    for ref in doomed:
        if git(repo_dir, "update-ref", "-d", ref, check=False).returncode == 0:
            deleted.append(ref)
    return deleted


def _divergence(repo_dir: Path, ref: str) -> Optional[tuple]:
    """`(behind, ahead)` between `ref` and HEAD, or None when it cannot be read."""
    proc = git(
        repo_dir, "rev-list", "--left-right", "--count", ref + "..." + "HEAD", check=False
    )
    raw = (proc.stdout or "").strip().split()
    if proc.returncode != 0 or len(raw) < 2:
        return None
    try:
        return int(raw[0]), int(raw[1])
    except ValueError:
        return None


def _save_local_tip(repo_dir: Path, ref: str) -> Optional[str]:
    """Park HEAD under `refs/backup/local-<utc>` ONLY on a genuine divergence.

    `reset --hard` can be a silent history amputation: a machine that snapshotted
    offline for a week and then meets a remote that ALSO moved would lose every
    one of those commits with no trace. The saved ref keeps them reachable (and
    out of the way — `refs/backup/*` is not a branch), so the destructive step
    becomes recoverable instead of final.

    "Local has commits the remote lacks" is NOT that case, though — it is the
    ordinary state of any machine that has auto-synced since its last push. Those
    commits are about to be superseded by a rebuild that reproduces their content
    (every snapshot commit is a complete tree), so parking a ref and shouting
    "the remote had moved on" for each one is pure noise, and it accumulates a
    permanent ref per unpushed run.

    The real thing to protect is DIVERGENCE: the remote tip carries commits we do
    not have AND we carry commits it does not. Only then does the reset drop work
    that nothing else reproduces.
    """
    if git(repo_dir, "rev-parse", "--verify", "-q", "HEAD", check=False).returncode != 0:
        return None  # no local commits yet — nothing to lose
    counts = _divergence(repo_dir, ref)
    if counts is None:
        return None
    behind, ahead = counts
    if ahead <= 0:
        return None  # local is contained in the remote — the reset drops nothing
    if behind <= 0:
        # Plain local-ahead: the remote is an ancestor of HEAD, so it did not
        # move on and the rebuild supersedes these commits. Not a loss.
        return None
    saved = local_tip_ref_name()
    if git(repo_dir, "update-ref", saved, "HEAD", check=False).returncode != 0:
        return None
    prune_local_tip_refs(repo_dir, keep=MAX_PARKED_LOCAL_TIPS)
    return saved


def ref_has_manifest(repo_dir: Path, ref: str) -> bool:
    """Does the committed `ref` carry a Skill Tree `manifest.json` in its tree?"""
    return git(
        repo_dir, "cat-file", "-e", ref + ":" + MANIFEST_FILE, check=False
    ).returncode == 0


def remote_tip_has_manifest(repo_dir: Path, ref: str) -> bool:
    """Does the already-fetched `ref` carry a Skill Tree `manifest.json`?"""
    return ref_has_manifest(repo_dir, ref)


def git_adopt_remote_tip(repo_dir: Path, branch: str, timeout: int = NETWORK_TIMEOUT) -> dict:
    """Fetch and hard-reset onto `origin/<branch>` before rebuilding the tree.

    This is what makes a non-fast-forward push STRUCTURALLY IMPOSSIBLE: we start
    every snapshot from the remote's tip, then rebuild the entire tree from the
    live data home and commit. Each commit is a complete tree, so adopting the
    remote loses no content — the other machine's history stays in the log, and
    hub never has to merge or force-push.

    Two safety rails around the `reset --hard`:
      * a remote tip WITHOUT `manifest.json` is not a Skill Tree backup, so we
        refuse to adopt it (adopting would put a stranger's tree in our working
        dir, and the next commit would publish over their history);
      * a local tip holding commits the remote lacks is parked under
        `refs/backup/local-<utc>` first, so the reset is recoverable.

    Fail-open: an unreachable remote leaves the local branch alone.
    """
    if git_remote_url(repo_dir) is None:
        return {"adopted": False, "detail": "no remote configured"}
    fetched = git(repo_dir, "fetch", "-q", "origin", branch, check=False, timeout=timeout)
    if fetched.returncode != 0:
        return {"adopted": False, "detail": "could not fetch origin/" + branch}
    ref = "origin/" + branch
    if git(repo_dir, "rev-parse", "--verify", "-q", ref, check=False).returncode != 0:
        return {"adopted": False, "detail": "remote branch does not exist yet"}
    if not remote_tip_has_manifest(repo_dir, ref):
        return {
            "adopted": False,
            "foreign": True,
            "detail": "remote branch '" + branch + "' has commits but no manifest.json — "
            "that is not a Skill Tree backup repo; refusing to adopt or publish over it",
        }
    saved_ref = _save_local_tip(repo_dir, ref)
    reset = git(repo_dir, "reset", "--hard", "-q", ref, check=False)
    if reset.returncode != 0:
        # Discarding this silently used to leave the working tree on the OLD tip
        # while every caller believed it had adopted the remote — so the next
        # commit rebuilt on the wrong base and the push was rejected with no
        # explanation anywhere in the log.
        detail = (
            "could not reset onto " + ref + ": "
            + ((reset.stderr or reset.stdout or "").strip().splitlines() or ["unknown error"])[0]
        )
        out = {"adopted": False, "warn": True, "detail": detail}
        if saved_ref:
            out["saved_ref"] = saved_ref
        return out
    out = {"adopted": True, "detail": "rebased onto " + ref}
    if saved_ref:
        out["saved_ref"] = saved_ref
        out["detail"] += " (local-only history kept at " + saved_ref + ")"
    return out


def git_commit(repo_dir: Path, message: str) -> Optional[str]:
    """Stage everything and commit. Returns the sha, or None if nothing changed.

    Identity is supplied inline (`-c user.*`) so a machine without a global git
    identity can still back up, and so we never write to the user's git config.
    """
    git(repo_dir, "add", "-A")
    if not git_is_dirty(repo_dir):
        return None
    git(
        repo_dir,
        "-c", "user.name=" + GIT_IDENTITY_NAME,
        "-c", "user.email=" + GIT_IDENTITY_EMAIL,
        "commit", "-q", "-m", message,
    )
    return (git(repo_dir, "rev-parse", "HEAD", check=False).stdout or "").strip() or None


def git_last_commit(repo_dir: Path) -> Optional[dict]:
    proc = git(repo_dir, "log", "-1", "--format=%H%x1f%cI%x1f%s", check=False)
    raw = (proc.stdout or "").strip()
    if proc.returncode != 0 or not raw:
        return None
    parts = raw.split("\x1f")
    if len(parts) < 3:
        return None
    return {"sha": parts[0], "ts": parts[1], "subject": parts[2]}


def git_ahead_behind(repo_dir: Path, branch: Optional[str] = None) -> Optional[dict]:
    """Local-vs-remote divergence from the *existing* refs — no network dial.

    Returns None when there is no remote-tracking ref yet (never pushed, or the
    ref is stale because nothing has fetched). Callers report that as "unknown"
    rather than pretending in-sync.
    """
    branch = branch or git_current_branch(repo_dir)
    ref = "origin/" + branch
    if git(repo_dir, "rev-parse", "--verify", "-q", ref, check=False).returncode != 0:
        return None
    proc = git(repo_dir, "rev-list", "--left-right", "--count", "HEAD..." + ref, check=False)
    raw = (proc.stdout or "").strip().split()
    if proc.returncode != 0 or len(raw) < 2:
        return None
    try:
        return {"ahead": int(raw[0]), "behind": int(raw[1])}
    except ValueError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Auth ladder (design §7): ssh → PAT for pushing, `gh` for repo creation
# ─────────────────────────────────────────────────────────────────────────────


def _run(cmd: list, timeout: int = 10):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def _gh_bin() -> Optional[str]:
    """Absolute path to `gh`, or None.

    NOT a bare "gh": the app is GUI-spawned, so its PATH is launchd's
    (`/usr/bin:/bin:/usr/sbin:/sbin`) and a Homebrew `gh` is invisible —
    `_run` swallows the FileNotFoundError and the auth ladder reports
    "gh CLI not installed" on a machine where the terminal finds it fine.
    """
    from skill_hub.infrastructure.harnesses.harness_probe import resolve_binary  # local import (repo convention)

    return resolve_binary("gh")


def probe_ssh(timeout: int = 10, strict_host_key_checking: str = "accept-new") -> dict:
    """`ssh -T git@github.com`.

    GitHub's shell-less endpoint **exits 1 even on success** — the signal is the
    greeting on stderr ("Hi <user>! You've successfully authenticated..."), never
    the exit code. Classification is therefore purely textual.
    """
    proc = _run(
        [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            "-o", "StrictHostKeyChecking=" + strict_host_key_checking,
            "git@github.com",
        ],
        timeout=timeout,
    )
    if proc is None:
        return {"method": "ssh", "available": False, "detail": "ssh unavailable or timed out", "user": None}
    blob = (proc.stdout or "") + (proc.stderr or "")
    if "successfully authenticated" in blob:
        user = None
        stripped = blob.strip()
        if stripped.startswith("Hi "):
            user = stripped[3:].split("!", 1)[0].strip() or None
        return {
            "method": "ssh",
            "available": True,
            "detail": "authenticated to github.com over ssh",
            "user": user,
        }
    first = (blob.strip().splitlines() or ["no ssh key accepted by github.com"])[0]
    return {"method": "ssh", "available": False, "detail": first, "user": None}


def _parse_gh_login(blob: str) -> Optional[str]:
    for line in blob.splitlines():
        if "Logged in to" in line and " account " in line:
            return line.split(" account ", 1)[1].split()[0].strip() or None
    return None


def gh_active_login(timeout: int = 10) -> Optional[str]:
    """The `gh` account currently active for github.com, or None."""
    gh = _gh_bin()
    if gh is None:
        return None
    proc = _run([gh, "auth", "status"], timeout=timeout)
    if proc is None or proc.returncode != 0:
        return None
    return _parse_gh_login((proc.stdout or "") + (proc.stderr or ""))


def probe_gh(timeout: int = 10) -> dict:
    """`gh auth status` — exit 0 means the CLI holds a usable GitHub token."""
    gh = _gh_bin()
    proc = _run([gh, "auth", "status"], timeout=timeout) if gh else None
    if proc is None:
        return {"method": "gh", "available": False, "detail": "gh CLI not installed", "user": None}
    blob = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        user = _parse_gh_login(blob)
        return {
            "method": "gh",
            "available": True,
            "detail": "gh CLI authenticated"
            + (" as " + user if user else "")
            + " (used for repo creation only)",
            "user": user,
        }
    first = (blob.strip().splitlines() or ["gh not authenticated"])[0]
    return {"method": "gh", "available": False, "detail": first, "user": None}


def _keychain():
    from skill_hub.infrastructure.connectors.transport import keychain

    return keychain


KEYRING_MISSING_DETAIL = (
    "keyring library unavailable — install it with "
    "`python3 -m pip install --user 'keyring>=24,<26'`"
)


def keyring_available() -> bool:
    try:
        return bool(_keychain().is_available())
    except Exception:
        return False


def probe_pat() -> dict:
    """Look for a stored PAT. Never returns (or logs) the token bytes.

    A missing `keyring` library is reported as a plain, actionable reason — not
    a traceback — because it is a perfectly ordinary state on a fresh install.
    """
    if not keyring_available():
        return {"method": "pat", "available": False, "detail": KEYRING_MISSING_DETAIL, "user": None}
    try:
        _keychain().get_secret(PAT_SECRET_REF)
    except Exception:
        return {
            "method": "pat",
            "available": False,
            "detail": "no token stored yet — " + PAT_SCOPE_HELP
            + " (CLI: `hub backup auth --login-pat`)",
            "user": None,
        }
    # The keychain handle is an INTERNAL identifier (`skill-hub:github-backup`,
    # kept verbatim for back-compat — renaming the service would orphan every
    # already-stored token). It travels as its OWN field so surfaces can demote
    # it to a tooltip instead of spelling the old product name out in a sentence
    # the user is meant to read.
    return {
        "method": "pat",
        "available": True,
        "detail": "token stored in your OS keychain",
        "user": None,
        "ref": PAT_SECRET_REF,
    }


def get_pat() -> str:
    """Read the stored PAT. Raises `BackupError` when it is not retrievable."""
    try:
        return _keychain().get_secret(PAT_SECRET_REF)
    except Exception as exc:
        raise BackupError("could not read the stored PAT: " + str(exc)) from exc


def store_pat(token: str) -> None:
    token = (token or "").strip()
    if not token:
        raise BackupError("empty token — nothing stored")
    try:
        _keychain().set_secret(PAT_SECRET_REF, token)
    except Exception as exc:
        raise BackupError("could not store the PAT: " + str(exc)) from exc


def delete_pat() -> bool:
    try:
        return bool(_keychain().delete_secret(PAT_SECRET_REF))
    except Exception:
        return False


def detect_auth(
    preferred: Optional[str] = None, timeout: int = 10, *, non_mutating: bool = False
) -> dict:
    """Walk the credential ladder and return the resolved method + every rung.

    `method` is the **push** method (`PUSH_METHOD_ORDER`: ssh → pat → gh);
    `create_method` is what `--create` may use (`gh` only).
    """
    ssh = (
        probe_ssh(timeout=timeout, strict_host_key_checking="yes")
        if non_mutating
        else probe_ssh(timeout=timeout)
    )
    rungs = [ssh, probe_gh(timeout=timeout), probe_pat()]
    by_method = {rung["method"]: rung for rung in rungs}
    method = None
    if preferred in AUTH_METHODS and by_method[preferred]["available"]:
        method = preferred
    else:
        for candidate in PUSH_METHOD_ORDER:
            if by_method[candidate]["available"]:
                method = candidate
                break
    return {
        "method": method,
        "configured": preferred or "auto",
        "ladder": rungs,
        "keyring_available": keyring_available(),
        "pat_available": by_method["pat"]["available"],
        "pat_detail": by_method["pat"]["detail"],
        # Internal keychain handle, hoisted so the app can show it as a tooltip
        # without any surface having to hardcode the (legacy) service name.
        "pat_ref": by_method["pat"].get("ref"),
        "gh_login": by_method["gh"]["user"],
        "create_method": "gh" if by_method["gh"]["available"] else None,
    }


def _is_https(url: Optional[str]) -> bool:
    return bool(url) and str(url).startswith("http")


def git_auth_options(
    method: Optional[str], *, url: Optional[str] = None
) -> tuple[list, dict]:
    """Git config and child environment for one resolved backup auth method.

    The token remains in the child environment only.  Clone and fetch use this
    bridge too, so every GitHub backup transport uses the same credential
    policy as push.
    """
    if method == "pat":
        return (
            [
                "-c",
                "credential.helper=",
                "-c",
                "credential.helper=" + _PAT_CREDENTIAL_HELPER,
            ],
            {"SKILL_HUB_BACKUP_TOKEN": get_pat()},
        )
    if method == "gh" and _is_https(url):
        return (["-c", "credential.helper=!gh auth git-credential"], {})
    return ([], {})


def github_read_transports(repo: str, source_url: str, auth: Optional[dict]) -> list[dict]:
    """Return bounded, credential-aware read transports for a GitHub source.

    Source records retain their original URL, so a source configured with SSH
    is tried as recorded first.  A single HTTPS candidate is then available as
    an authentication fallback.  The fallback uses the already resolved
    backup credential ladder (PAT, ``gh``, or ambient Git credentials) and
    therefore never changes Git or SSH configuration on the host.

    The caller owns deciding whether a failed attempt is eligible for the
    fallback.  Keeping that decision outside this helper lets snapshot reads
    retain their existing transport selection semantics.
    """
    raw = str(source_url).strip()
    parsed = urlparse(raw)
    is_ssh = raw.startswith("git@github.com:") or (
        parsed.scheme == "ssh" and (parsed.hostname or "").lower() == "github.com"
    )

    def candidate(method: Optional[str], url: str) -> dict:
        try:
            args, env = git_auth_options(method, url=url)
        except BackupError:
            # A credential may disappear between detection and use.  The
            # ambient HTTPS candidate remains safe and useful in that case.
            args, env = [], {}
            method = None
        if method == "ssh":
            env = dict(env)
            env["GIT_SSH_COMMAND"] = (
                "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"
            )
        return {"method": method or "ambient", "url": url, "args": args, "env": env}

    resolved = auth or {}
    preferred = resolved.get("method")
    ladder = {
        str(row.get("method")): row
        for row in (resolved.get("ladder") or [])
        if isinstance(row, dict) and row.get("method")
    }

    if is_ssh:
        # A configured HTTPS credential is an explicit preference.  Honor it
        # directly instead of probing a known-broken recorded SSH remote.
        if preferred in ("pat", "gh"):
            return [candidate(preferred, remote_url_for(repo, preferred))]
        transports = [candidate("ssh", raw)]
        fallback = preferred if preferred in ("pat", "gh") else None
        if fallback is None:
            for method in ("pat", "gh"):
                if (ladder.get(method) or {}).get("available"):
                    fallback = method
                    break
        https = remote_url_for(repo, fallback)
        transports.append(candidate(fallback, https))
        return transports

    selected_method: Optional[str] = preferred if preferred in ("pat", "gh") else None
    return [candidate(selected_method, raw)]


def git_push(
    repo_dir: Path,
    *,
    method: Optional[str],
    branch: Optional[str] = None,
    remote: str = "origin",
    timeout: int = NETWORK_TIMEOUT,
) -> dict:
    """Push HEAD to `<remote>/<branch>` using the resolved auth method.

    * `ssh`  — plain push over the ssh remote.
    * `pat`  — an inline credential helper whose argv contains only the NAME of
      the environment variable holding the token. The token exists solely in
      this one child process's environment: never in argv, never in the remote
      URL, never in a file. `credential.helper=` is blanked first so a
      configured OS helper cannot shadow (or cache) it.
    * `gh`   — last resort, https remotes only, via `gh auth git-credential`.

    A rejected push is reported as a **conflict**, never forced. In normal
    operation this cannot happen: `git_adopt_remote_tip` runs first.
    """
    repo_dir = Path(repo_dir)
    branch = branch or git_current_branch(repo_dir)
    url = git_remote_url(repo_dir, remote)
    if url is None:
        return {"pushed": False, "conflict": False, "detail": "no '" + remote + "' remote configured"}

    push_args = ["push", "-u", remote, "HEAD:refs/heads/" + branch]

    auth_args, auth_env = git_auth_options(method, url=url)
    proc = git(
        repo_dir,
        *auth_args,
        *push_args,
        env_overrides=auth_env or None,
        check=False,
        timeout=timeout,
    )

    if proc.returncode == 0:
        return {"pushed": True, "conflict": False, "detail": "pushed to " + remote + "/" + branch}

    blob = ((proc.stderr or "") + (proc.stdout or "")).strip()
    lowered = blob.lower()
    if "non-fast-forward" in lowered or "fetch first" in lowered or "rejected" in lowered:
        return {
            "pushed": False,
            "conflict": True,
            "detail": "remote moved between fetch and push — the next backup adopts it "
            "(hub never force-pushes)",
        }
    raise GitError("git push failed: " + (blob.splitlines() or ["unknown error"])[0])


# ─────────────────────────────────────────────────────────────────────────────
# GitHub repo creation (`--create`) — `gh` rung only
# ─────────────────────────────────────────────────────────────────────────────


def normalize_repo(repo: str) -> str:
    repo = (repo or "").strip().strip("/")
    if repo.endswith(".git"):
        repo = repo[:-4]
    return repo


def remote_url_for(repo: str, method: Optional[str]) -> str:
    """`owner/name` → the clone URL matching the resolved push method."""
    repo = normalize_repo(repo)
    if method == "ssh":
        return "git@github.com:" + repo + ".git"
    return "https://github.com/" + repo + ".git"


def create_github_repo(repo: str, *, private: bool = True) -> dict:
    """Create a private GitHub repo with `gh`. Never echoes a token.

    Deliberately `gh`-only: a fine-grained PAT scoped to a single repo — the
    permission we actually want the user to grant — cannot create repositories,
    and asking for account-wide admin just to bootstrap a backup is a bad trade.
    On the PAT rung the caller prints `manual_create_instructions` instead.
    """
    repo = normalize_repo(repo)
    if "/" not in repo:
        raise BackupError("--repo expects owner/name (got '" + repo + "')")
    gh = _gh_bin()
    proc = (
        _run([gh, "repo", "create", repo, "--private" if private else "--public"], timeout=60)
        if gh
        else None
    )
    if proc is None:
        raise BackupError("gh CLI not available for --create")
    if proc.returncode != 0:
        blob = ((proc.stderr or "") + (proc.stdout or "")).strip()
        if "already exists" in blob.lower():
            return {"created": False, "detail": "repo already exists"}
        raise BackupError("gh repo create failed: " + (blob.splitlines() or ["unknown"])[0])
    return {"created": True, "detail": "created " + repo + " via gh"}


def manual_create_instructions(repo: str) -> str:
    """User-facing, and read in the app as well as the terminal — so it names the
    action ("point Skill Tree at it") before the CLI incantation."""
    name = normalize_repo(repo)
    return (
        "create the PRIVATE repo yourself at https://github.com/new (name: "
        + name
        + ", visibility: Private, no README), then point Skill Tree at it "
        + "(CLI: `hub backup init --repo "
        + name
        + "` without --create). Token needed for pushing: "
        + PAT_SCOPE_HELP
    )
