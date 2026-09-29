"""Pure repository identity and bounded local checkout discovery.

This module deliberately has no registry or network dependencies.  Git is
used only for read-only inspection of a caller supplied path.
"""

from __future__ import annotations

import ipaddress
import os
import re
import stat
import subprocess
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List, Mapping, Optional, Sequence, Tuple, Union
from urllib.parse import urlsplit

_GIT_TIMEOUT_SECONDS = 2.0
_MAX_SCAN_SECONDS = 5.0
_MAX_SCAN_DEPTH = 8
_MAX_VISITED_DIRECTORIES = 10_000
_MAX_CANDIDATES = 1_000
_MAX_SCAN_ROOTS = 64
_MAX_ENTRIES_PER_DIRECTORY = 2_000
_SKIP_DIRECTORY_NAMES = {
    ".cache", ".git", ".hg", ".mypy_cache", ".npm", ".pnpm-store", ".tox",
    ".venv", "__pycache__", "Cache", "Caches", "Library", "node_modules",
    "target",
}
_REMOTE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_SCP_URL = re.compile(r"^(?:([^/@:]+)@)?([^/:]+):(.+)$")


@dataclass(frozen=True)
class RepositoryAssociation:
    """A credential-free repository locator selected from a local checkout."""

    url: str
    remote: str
    subdirectory: str


@dataclass(frozen=True)
class RepositoryIdentity:
    """Comparison identity for a repository URL.

    ``path`` is a slash-separated repository path without a leading slash or
    one trailing ``.git`` suffix.  A missing port means the transport's
    default port, which permits the known HTTPS/SSH GitHub forms to match.
    """

    host: str
    port: Optional[int]
    path: str
    # Defaults preserve the original three-field constructor while retaining
    # conservative semantics for non-GitHub SSH and HTTPS forms.
    transport: str = "https"
    user: Optional[str] = None
    path_kind: str = "uri"


@dataclass(frozen=True)
class RepositoryInspection:
    project_path: str
    git_root: str
    association: RepositoryAssociation
    is_worktree: bool


@dataclass(frozen=True)
class CheckoutCandidate:
    path: str
    git_root: str
    is_worktree: bool
    remotes: Tuple[RepositoryAssociation, ...]
    subdirectories: Tuple[str, ...] = (".",)


@dataclass(frozen=True)
class DiscoveryResult:
    candidates: Tuple[CheckoutCandidate, ...]
    issues: Tuple["RepositoryIssue", ...]
    truncated: bool


@dataclass(frozen=True)
class RepositoryIssue:
    """A sanitized, serializable issue returned by bounded discovery."""

    code: str
    message: str
    field: Optional[str] = None


_ERROR_MESSAGES = {
    "invalid_association": "repository association must be an object",
    "invalid_field": "repository association field is invalid",
    "unsupported_repository_url": "repository URL format is unsupported",
    "repository_credentials_disallowed": "repository URL credentials are not allowed",
    "invalid_subdirectory": "repository subdirectory is invalid",
    "invalid_remote": "repository remote name is invalid",
    "git_unavailable": "Git is not available",
    "git_failed": "Git inspection failed",
    "not_a_repository": "path is not a Git repository",
    "remote_not_found": "repository remote was not found",
    "project_outside_repository": "project path is outside the repository",
    "invalid_root": "discovery root is invalid",
    "scan_limit": "repository discovery reached its scan limit",
    "scan_failed": "repository discovery could not read a directory",
}


class RepositoryError(ValueError):
    """Stable, sanitized failure from repository identity or inspection."""

    def __init__(self, message: str, *, code: str, field: Optional[str] = None):
        self.code = code
        self.field = field
        super().__init__(message)


def _error(code: str, field: Optional[str] = None) -> RepositoryError:
    return RepositoryError(_ERROR_MESSAGES.get(code, "repository operation failed"), code=code, field=field)


def _reject_url(code: str = "unsupported_repository_url") -> RepositoryError:
    # Never interpolate the rejected value.  Remote URLs can contain secrets.
    return RepositoryError(_ERROR_MESSAGES.get(code, "repository operation failed"), code=code, field="url")


def _has_control(value: str) -> bool:
    return any(ord(char) < 32 or ord(char) == 127 for char in value)


def _validate_host(host: Optional[str], *, reject_alias: bool = False) -> str:
    if (
        not host
        or _has_control(host)
        or any(char.isspace() for char in host)
        or any(char in host for char in "@/?#\\")
    ):
        raise _reject_url()
    host = host.lower()
    # A bare, unknown SSH name is commonly an ssh config alias.  It cannot be
    # resolved without consulting user config, so it is not an auto-match key.
    if reject_alias and "." not in host and host != "localhost":
        try:
            ipaddress.ip_address(host)
        except ValueError:
            raise _reject_url()
    return host


def _parse_port(parsed: Any, default: int) -> Optional[int]:
    try:
        port = parsed.port
    except ValueError:
        raise _reject_url()
    if port is None or port == default:
        return None
    if port < 1 or port > 65535:
        raise _reject_url()
    return port


def _validate_ssh_user(user: Optional[str]) -> Optional[str]:
    if user is None:
        return None
    if (
        not user
        or _has_control(user)
        or any(char in user for char in "@/:?#\\%")
        or any(char.isspace() for char in user)
    ):
        raise _reject_url()
    return user


def _normalize_path(raw_path: str) -> str:
    if (
        not raw_path
        or _has_control(raw_path)
        or "\\" in raw_path
        or "%" in raw_path
        or "?" in raw_path
        or "#" in raw_path
    ):
        raise _reject_url()
    path = raw_path.lstrip("/")
    if not path or path.endswith("/") or "//" in path:
        raise _reject_url()
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise _reject_url()
    if path.endswith(".git"):
        path = path[:-4]
    if not path:
        raise _reject_url()
    return path


def _make_identity(
    host: str,
    port: Optional[int],
    path: str,
    *,
    scheme: str,
    user: Optional[str],
    path_kind: str,
) -> RepositoryIdentity:
    # GitHub's documented HTTPS and git-user SSH clone forms are the one
    # cross-transport equivalence we can establish without user config.
    if host == "github.com" and port is None:
        if scheme == "https" and user is None:
            return RepositoryIdentity(host, None, path, "github", None, "repo")
        if scheme == "ssh" and user == "git":
            return RepositoryIdentity(host, None, path, "github", None, "repo")
    return RepositoryIdentity(host, port, path, scheme, user, path_kind)


def normalize_repository_url(url: str) -> RepositoryIdentity:
    """Return a safe comparison identity for a familiar Git URL.

    HTTPS/HTTP URLs and SSH URLs are accepted.  SCP-style SSH URLs are
    accepted when their host is a concrete DNS name or address; unknown SSH
    aliases are intentionally rejected because resolving them would require
    user SSH configuration.
    """

    if not isinstance(url, str) or not url or url != url.strip() or _has_control(url):
        raise _reject_url()

    try:
        parsed = urlsplit(url)
    except ValueError:
        raise _reject_url()
    scheme = parsed.scheme.lower()
    if scheme in ("http", "https"):
        if not parsed.netloc or parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
            if "@" in parsed.netloc or parsed.username is not None or parsed.password is not None:
                raise _reject_url("repository_credentials_disallowed")
            raise _reject_url()
        if parsed.query or parsed.fragment:
            raise _reject_url()
        host = _validate_host(parsed.hostname)
        port = _parse_port(parsed, 443 if scheme == "https" else 80)
        path = _normalize_path(parsed.path)
        return _make_identity(host, port, path, scheme=scheme, user=None, path_kind="uri")

    if scheme == "ssh":
        if parsed.query or parsed.fragment or not parsed.netloc or parsed.password is not None:
            if parsed.password is not None:
                raise _reject_url("repository_credentials_disallowed")
            raise _reject_url()
        host = _validate_host(parsed.hostname, reject_alias=True)
        user = _validate_ssh_user(parsed.username)
        port = _parse_port(parsed, 22)
        path = _normalize_path(parsed.path)
        return _make_identity(
            host,
            port,
            path,
            scheme=scheme,
            user=user,
            path_kind="uri",
        )

    # SCP syntax has no URI scheme, so handle it after rejecting other schemes.
    if not scheme:
        match = _SCP_URL.fullmatch(url)
        if match:
            host = _validate_host(match.group(2), reject_alias=True)
            user = _validate_ssh_user(match.group(1))
            return _make_identity(
                host,
                None,
                _normalize_path(match.group(3)),
                scheme="ssh",
                user=user,
                path_kind="scp",
            )
    raise _reject_url()


def _normalize_subdirectory(value: Any) -> str:
    if not isinstance(value, str) or not value or _has_control(value) or "\\" in value:
        raise _error("invalid_subdirectory", field="subdirectory")
    if value.startswith("/"):
        raise _error("invalid_subdirectory", field="subdirectory")
    parts = value.split("/")
    if any(part == ".." for part in parts):
        raise _error("invalid_subdirectory", field="subdirectory")
    normalized = [part for part in parts if part not in ("", ".")]
    return "/".join(normalized) or "."


def _validate_remote(value: Any) -> str:
    if not isinstance(value, str) or not _REMOTE_NAME.fullmatch(value):
        raise _error("invalid_remote", field="remote")
    return value


def validate_repository_association(value: Any) -> RepositoryAssociation:
    """Validate and normalize a persisted ``repository`` block."""

    if not isinstance(value, Mapping):
        raise _error("invalid_association")
    expected = {"url", "remote", "subdirectory"}
    if set(value) != expected:
        raise _error("invalid_association")
    url = value["url"]
    normalize_repository_url(url)
    remote = _validate_remote(value["remote"])
    subdirectory = _normalize_subdirectory(value["subdirectory"])
    return RepositoryAssociation(url=url, remote=remote, subdirectory=subdirectory)


def _git_environment() -> dict:
    # Remove every Git-controlled override, including config injection and
    # alternate indexes.  Then disable system/global config so insteadOf rules
    # cannot turn a literal local remote into a guessed identity.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment["GIT_CONFIG_GLOBAL"] = os.devnull
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    environment["GIT_TERMINAL_PROMPT"] = "0"
    return environment


def _run_git(path: Path, args: Sequence[str]) -> subprocess.CompletedProcess:
    git_args = list(args)
    if git_args and git_args[0] == "config":
        git_args.insert(1, "--no-includes")
    command = ["git", "--no-optional-locks", "-C", str(path)] + git_args
    try:
        return subprocess.run(
            command,
            check=False,
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_git_environment(),
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        raise _error("git_unavailable")
    except (OSError, subprocess.TimeoutExpired):
        raise _error("git_failed")


def _canonical_directory(path: Union[str, os.PathLike]) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.exists() or not candidate.is_dir():
        raise _error("not_a_repository", field="path")
    return candidate.resolve(strict=True)


def _git_root(path: Path) -> Path:
    result = _run_git(path, ["rev-parse", "--show-toplevel"])
    if result.returncode != 0:
        raise _error("not_a_repository")
    root_text = result.stdout.strip()
    if not root_text:
        raise _error("git_failed")
    root = Path(root_text).resolve(strict=False)
    if not root.is_dir():
        raise _error("git_failed")
    return root


def _remote_key(remote: str) -> str:
    return "remote." + remote + ".url"


def _read_remote_urls(path: Path, remote: str) -> List[str]:
    _validate_remote(remote)
    result = _run_git(path, ["config", "--local", "--get-all", _remote_key(remote)])
    if result.returncode == 1:
        raise _error("remote_not_found", field="remote")
    if result.returncode != 0:
        raise _error("git_failed")
    urls = [line for line in result.stdout.splitlines() if line]
    if not urls:
        raise _error("remote_not_found", field="remote")
    return urls


def _read_all_remotes(path: Path) -> Tuple[Tuple[RepositoryAssociation, ...], Tuple[RepositoryError, ...]]:
    result = _run_git(path, ["config", "--local", "--get-regexp", r"^remote\..*\.url$"])
    if result.returncode not in (0, 1):
        raise _error("git_failed")
    associations: List[RepositoryAssociation] = []
    issues: List[RepositoryError] = []
    for line in result.stdout.splitlines():
        try:
            key, url = line.split(None, 1)
        except ValueError:
            issues.append(_error("git_failed"))
            continue
        if not (key.startswith("remote.") and key.endswith(".url")):
            issues.append(_error("git_failed"))
            continue
        remote = key[len("remote.") : -len(".url")]
        try:
            _validate_remote(remote)
            normalize_repository_url(url)
            associations.append(RepositoryAssociation(url=url, remote=remote, subdirectory="."))
        except RepositoryError as exc:
            # Keep malformed remote values out of returned data and logs.
            issues.append(RepositoryError(str(exc), code=exc.code, field="remote"))
    associations.sort(key=lambda item: (item.remote, item.url))
    return tuple(associations), tuple(issues)


def _git_dir_pair(path: Path) -> Tuple[Path, Path]:
    result = _run_git(path, ["rev-parse", "--git-dir", "--git-common-dir"])
    if result.returncode != 0:
        raise _error("git_failed")
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 2:
        raise _error("git_failed")

    def resolve_git_dir(value: str) -> Path:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = path / candidate
        return candidate.resolve(strict=False)

    return resolve_git_dir(lines[0]), resolve_git_dir(lines[1])


def _is_worktree(path: Path, git_root: Path) -> bool:
    try:
        if not stat.S_ISREG(os.lstat(git_root / ".git").st_mode):
            return False
    except OSError:
        return False
    git_dir, common_dir = _git_dir_pair(path)
    return git_dir != common_dir


def inspect_project_repository(
    path: Union[str, os.PathLike], remote: str = "origin"
) -> RepositoryInspection:
    """Inspect one project directory and its selected literal Git remote."""

    project_path = _canonical_directory(path)
    git_root = _git_root(project_path)
    try:
        subdirectory = project_path.relative_to(git_root).as_posix() or "."
    except ValueError:
        raise _error("project_outside_repository")
    urls = _read_remote_urls(project_path, remote)
    # Multiple push/fetch URLs are valid Git configuration.  The selected
    # association records the first literal URL, while discovery exposes all.
    url = urls[0]
    normalize_repository_url(url)
    association = validate_repository_association(
        {"url": url, "remote": remote, "subdirectory": subdirectory}
    )
    return RepositoryInspection(
        project_path=str(project_path),
        git_root=str(git_root),
        association=association,
        is_worktree=_is_worktree(project_path, git_root),
    )


def inspect_project_remotes(path: Union[str, os.PathLike]) -> Tuple[RepositoryAssociation, ...]:
    """Read all valid source associations, including a project subdirectory."""
    project_path = Path(path).expanduser().resolve(strict=True)
    remotes, _ = _read_all_remotes(project_path)
    associations = []
    for name in sorted({remote.remote for remote in remotes}):
        try:
            associations.append(inspect_project_repository(project_path, remote=name).association)
        except RepositoryError:
            continue
    return tuple(associations)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _marker_is_checkout(path: Path) -> bool:
    try:
        mode = os.lstat(path / ".git").st_mode
    except OSError:
        return False
    return stat.S_ISDIR(mode) or stat.S_ISREG(mode)


def _inspect_checkout(
    path: Path, approved_root: Path
) -> Tuple[Optional[CheckoutCandidate], Tuple[RepositoryError, ...]]:
    try:
        git_root = _git_root(path)
    except RepositoryError as exc:
        return None, (exc,)
    if not _inside(git_root, approved_root):
        return None, (_error("project_outside_repository"),)
    issues: List[RepositoryError] = []
    try:
        remotes, remote_issues = _read_all_remotes(path)
        issues.extend(remote_issues)
    except RepositoryError as exc:
        # A broken local config should make this candidate incomplete while
        # allowing sibling checkouts in the same bounded scan to continue.
        remotes = ()
        issues.append(exc)
    try:
        is_worktree = _is_worktree(path, git_root)
    except RepositoryError as exc:
        is_worktree = False
        issues.append(exc)
    return (
        CheckoutCandidate(
            path=str(path),
            git_root=str(git_root),
            is_worktree=is_worktree,
            remotes=remotes,
        ),
        tuple(issues),
    )


def discover_checkouts(
    roots: Optional[Iterable[Union[str, os.PathLike]]] = None, *, subdirectories: Sequence[str] = (),
) -> DiscoveryResult:
    """Find Git checkout roots beneath bounded roots, defaulting to the home."""

    if len(subdirectories) > 64:
        raise _error("scan_limit")
    requested_subdirectories = sorted({_normalize_subdirectory(value) for value in subdirectories})
    if roots is None:
        roots = (Path.home(),)

    if isinstance(roots, (str, os.PathLike)):
        roots = (roots,)
    candidates: List[CheckoutCandidate] = []
    issues: List[RepositoryError] = []
    approved_roots: List[Path] = []
    root_limit_hit = False
    for root_index, raw_root in enumerate(roots):
        if root_index >= _MAX_SCAN_ROOTS:
            root_limit_hit = True
            break
        try:
            root = Path(raw_root).expanduser()
            if not stat.S_ISDIR(os.lstat(root).st_mode):
                raise _error("invalid_root", field="root")
            approved_roots.append(root.resolve(strict=True))
        except (OSError, TypeError, ValueError):
            issues.append(_error("invalid_root", field="root"))
    if not approved_roots:
        if root_limit_hit:
            issues.append(_error("scan_limit"))
        serializable_issues = tuple(
            RepositoryIssue(code=issue.code, message=str(issue), field=issue.field) for issue in issues
        )
        return DiscoveryResult(candidates=(), issues=serializable_issues, truncated=root_limit_hit)

    started = time.monotonic()
    visited: set[Path] = set()
    seen_candidates: set[Path] = set()
    truncated = root_limit_hit
    limit_reported = root_limit_hit
    if root_limit_hit:
        issues.append(_error("scan_limit"))
    stack = deque((root, root, 0) for root in approved_roots)

    def hit_limit() -> None:
        nonlocal truncated, limit_reported
        truncated = True
        if not limit_reported:
            issues.append(_error("scan_limit"))
            limit_reported = True

    while stack:
        if time.monotonic() - started >= _MAX_SCAN_SECONDS:
            hit_limit()
            break
        current, approved_root, depth = stack.popleft()
        try:
            current = current.resolve(strict=False)
        except OSError:
            issues.append(_error("scan_failed"))
            continue
        if not _inside(current, approved_root):
            issues.append(_error("project_outside_repository"))
            continue
        if current in visited:
            continue
        if len(visited) >= _MAX_VISITED_DIRECTORIES:
            hit_limit()
            break
        visited.add(current)

        # Re-resolve immediately before touching the directory.  This closes
        # the common symlink replacement race between stack insertion and the
        # scan operation and keeps every processed path inside its root.
        try:
            current_check = current.resolve(strict=False)
        except OSError:
            issues.append(_error("scan_failed"))
            continue
        if current_check != current or not _inside(current_check, approved_root):
            issues.append(_error("project_outside_repository"))
            continue

        if _marker_is_checkout(current):
            if current not in seen_candidates:
                seen_candidates.add(current)
                if len(candidates) >= _MAX_CANDIDATES:
                    hit_limit()
                    break
                candidate, candidate_issues = _inspect_checkout(current, approved_root)
                issues.extend(candidate_issues)
                if candidate is not None:
                    from dataclasses import replace

                    available = {"."}
                    for subdirectory in requested_subdirectories:
                        child = current / subdirectory
                        try:
                            if child.is_dir() and _inside(child.resolve(strict=True), current):
                                available.add(subdirectory)
                        except OSError:
                            continue
                    candidates.append(replace(candidate, subdirectories=tuple(sorted(available))))

        try:
            with os.scandir(current) as entries:
                children = []
                for entry_index, entry in enumerate(entries):
                    if entry_index >= _MAX_ENTRIES_PER_DIRECTORY:
                        hit_limit()
                        break
                    if time.monotonic() - started >= _MAX_SCAN_SECONDS:
                        hit_limit()
                        break
                    children.append(entry)
                children.sort(key=lambda entry: entry.name, reverse=True)
                for entry in children:
                    if entry.name in _SKIP_DIRECTORY_NAMES:
                        continue
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    if depth >= _MAX_SCAN_DEPTH:
                        hit_limit()
                        continue
                    child = Path(entry.path)
                    try:
                        resolved_child = child.resolve(strict=False)
                    except OSError:
                        issues.append(_error("scan_failed"))
                        continue
                    if not _inside(resolved_child, approved_root):
                        issues.append(_error("project_outside_repository"))
                        continue
                    stack.append((resolved_child, approved_root, depth + 1))
        except OSError:
            issues.append(_error("scan_failed"))

    candidates.sort(key=lambda item: item.path)
    serializable_issues = tuple(
        RepositoryIssue(code=issue.code, message=str(issue), field=issue.field) for issue in issues
    )
    return DiscoveryResult(candidates=tuple(candidates), issues=serializable_issues, truncated=truncated)


def _as_association(value: Any) -> RepositoryAssociation:
    if isinstance(value, RepositoryInspection):
        return value.association
    if isinstance(value, RepositoryAssociation):
        return value
    if isinstance(value, Mapping):
        return validate_repository_association(value)
    raise _error("invalid_association")


def same_repository(left: Any, right: Any) -> bool:
    """Compare repository identity and project subdirectory.

    Remote names and branches intentionally do not participate in this
    comparison.  Repository identities can also be compared directly when a
    caller has already normalized both URLs.
    """

    if isinstance(left, RepositoryIdentity) or isinstance(right, RepositoryIdentity):
        return isinstance(left, RepositoryIdentity) and isinstance(right, RepositoryIdentity) and left == right
    left_association = _as_association(left)
    right_association = _as_association(right)
    return (
        normalize_repository_url(left_association.url) == normalize_repository_url(right_association.url)
        and left_association.subdirectory == right_association.subdirectory
    )


__all__ = [
    "CheckoutCandidate",
    "DiscoveryResult",
    "RepositoryAssociation",
    "RepositoryError",
    "RepositoryIdentity",
    "RepositoryInspection",
    "RepositoryIssue",
    "discover_checkouts",
    "inspect_project_repository",
    "normalize_repository_url",
    "same_repository",
    "validate_repository_association",
]
