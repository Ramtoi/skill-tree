"""Host-owned I/O services for Usage capture."""
# ruff: noqa: E501

from __future__ import annotations

import hashlib
import os
import stat
import subprocess
import time
from pathlib import Path

from skill_hub.domain.usage.usage_inspection_capture import (
    BodyPartInput,
    BodyStatus,
    ChangeInput,
    SourceChangedError,
    SourceCursor,
    SourceFingerprint,
    stable_id,
)


def source_fingerprint(
    path: Path, *, prefix_bytes: int = 4096, boundary_bytes: int = 4096
) -> SourceFingerprint:
    """Read only bounded sentinels used to prove an append belongs to a file."""
    st = path.stat()
    prefix_len = min(prefix_bytes, st.st_size)
    boundary_start = max(0, st.st_size - boundary_bytes)
    boundary_len = max(0, st.st_size - boundary_start)
    with path.open("rb") as fh:
        prefix = fh.read(prefix_len)
        fh.seek(boundary_start)
        boundary = fh.read(boundary_len)
    return SourceFingerprint(
        st.st_dev,
        st.st_ino,
        st.st_size,
        st.st_mtime_ns,
        hashlib.sha256(prefix).hexdigest(),
        hashlib.sha256(boundary).hexdigest(),
    )


def snapshot_fingerprint_matches(path: Path, fingerprint: SourceFingerprint) -> bool:
    """Verify bounded sentinels from ``fingerprint`` are still present."""
    try:
        st = path.stat()
        if (
            (fingerprint.device is not None and st.st_dev != fingerprint.device)
            or (fingerprint.inode is not None and st.st_ino != fingerprint.inode)
            or st.st_size < fingerprint.size
        ):
            return False
        if st.st_size == fingerprint.size and st.st_mtime_ns != fingerprint.mtime_ns:
            return False
        prefix_len = min(4096, fingerprint.size)
        boundary_start = max(0, fingerprint.size - 4096)
        boundary_len = max(0, fingerprint.size - boundary_start)
        with path.open("rb") as fh:
            prefix = fh.read(prefix_len)
            fh.seek(boundary_start)
            boundary = fh.read(boundary_len)
        return (
            hashlib.sha256(prefix).hexdigest() == fingerprint.prefix_sha256
            and hashlib.sha256(boundary).hexdigest() == fingerprint.boundary_sha256
        )
    except (OSError, ValueError):
        return False


def committed_hashes(path: Path, offset: int) -> tuple[str, str]:
    """Hash the committed prefix/boundary at the real old lengths."""
    with path.open("rb") as fh:
        prefix = fh.read(min(4096, offset))
        boundary_start = max(0, offset - 4096)
        fh.seek(boundary_start)
        boundary = fh.read(offset - boundary_start)
    return hashlib.sha256(prefix).hexdigest(), hashlib.sha256(boundary).hexdigest()


def hashes_for_commit(path: Path, offset: int, prefix_sha256: str = "") -> tuple[str, str]:
    """Hash the bytes committed at ``offset`` using bounded physical reads."""
    if offset <= 0:
        empty = hashlib.sha256(b"").hexdigest()
        return empty, empty
    with path.open("rb") as fh:
        prefix = fh.read(min(4096, offset)) if not prefix_sha256 else None
        fh.seek(max(0, offset - 4096))
        boundary = fh.read(min(4096, offset))
    return (
        prefix_sha256 or hashlib.sha256(prefix or b"").hexdigest(),
        hashlib.sha256(boundary).hexdigest(),
    )


def read_complete_suffix(
    path: Path,
    cursor: SourceCursor,
    *,
    deadline: float | None = None,
) -> tuple[bytes, SourceFingerprint, int, int, bool]:
    """Read only the complete JSONL suffix visible in one stat snapshot."""
    snapshot = path.stat()
    append = bool(cursor.generation_id and append_proven(path, cursor))
    start = cursor.offset if append else 0
    with path.open("rb") as fh:
        fh.seek(start)
        data = fh.read(max(0, snapshot.st_size - start))
    if deadline is not None and time.monotonic() > deadline:
        raise TimeoutError("source budget exceeded")
    complete_len = len(data) if not data or data.endswith(b"\n") else data.rfind(b"\n") + 1
    prefix_len = min(4096, snapshot.st_size)
    boundary_start = max(0, snapshot.st_size - 4096)
    boundary_len = max(0, snapshot.st_size - boundary_start)
    with path.open("rb") as fh:
        prefix = fh.read(prefix_len)
        fh.seek(boundary_start)
        boundary = fh.read(boundary_len)
    final = path.stat()
    if (
        (final.st_dev, final.st_ino) != (snapshot.st_dev, snapshot.st_ino)
        or final.st_size < snapshot.st_size
    ):
        raise SourceChangedError("source replaced while reading")
    if final.st_size == snapshot.st_size and final.st_mtime_ns != snapshot.st_mtime_ns:
        raise SourceChangedError("source rewritten while reading")
    if append and cursor.committed_prefix_sha256 and cursor.committed_boundary_sha256:
        committed_prefix, committed_boundary = committed_hashes(path, cursor.offset)
        if (committed_prefix, committed_boundary) != (
            cursor.committed_prefix_sha256,
            cursor.committed_boundary_sha256,
        ):
            raise SourceChangedError("committed source prefix changed while reading")
    fp = SourceFingerprint(
        snapshot.st_dev,
        snapshot.st_ino,
        snapshot.st_size,
        snapshot.st_mtime_ns,
        hashlib.sha256(prefix).hexdigest(),
        hashlib.sha256(boundary).hexdigest(),
    )
    return data[:complete_len], fp, start, start + complete_len, complete_len != len(data)


def append_proven(path: Path, cursor: SourceCursor) -> bool:
    """Return true only when current bytes prove a safe append."""
    try:
        st = path.stat()
        if st.st_size < cursor.offset:
            return False
        fp = cursor.fingerprint
        if fp.device is not None and st.st_dev != fp.device:
            return False
        if fp.inode is not None and st.st_ino != fp.inode:
            return False
        if not cursor.committed_prefix_sha256 or not cursor.committed_boundary_sha256:
            current = source_fingerprint(path)
            return (
                st.st_size == fp.size
                and current.prefix_sha256 == fp.prefix_sha256
                and current.boundary_sha256 == fp.boundary_sha256
            )
        prefix_sha256, boundary_sha256 = committed_hashes(path, cursor.offset)
        return prefix_sha256 == cursor.committed_prefix_sha256 and boundary_sha256 == cursor.committed_boundary_sha256
    except (OSError, ValueError):
        return False


def capture_attachment(
    path: Path,
    session_tool_results: Path,
    *,
    locator: str | None = None,
    max_bytes: int | None = None,
) -> BodyPartInput:
    """Capture a Claude persisted-output file after strict confinement checks."""
    part_id = stable_id("attachment", str(path))
    root_fd: int | None = None
    directory_fds: list[int] = []
    try:
        root = Path(os.path.abspath(session_tool_results))
        lexical = Path(os.path.abspath(path)) if path.is_absolute() else root / path
        relative = lexical.relative_to(root)
        if any(component in ("", ".", "..") for component in relative.parts):
            raise OSError("attachment escapes session root")
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        directory = getattr(os, "O_DIRECTORY", 0)
        root_fd = os.open(os.sep, os.O_RDONLY | directory | nofollow)
        current_fd = root_fd
        for component in root.parts[1:]:
            next_fd = os.open(component, os.O_RDONLY | directory | nofollow, dir_fd=current_fd)
            directory_fds.append(next_fd)
            current_fd = next_fd
        components = list(relative.parts)
        if not components:
            raise OSError("attachment is not a file")
        for component in components[:-1]:
            next_fd = os.open(component, os.O_RDONLY | directory | nofollow, dir_fd=current_fd)
            directory_fds.append(next_fd)
            current_fd = next_fd
        final_fd = os.open(
            components[-1],
            os.O_RDONLY | nofollow | getattr(os, "O_NONBLOCK", 0),
            dir_fd=current_fd,
        )
        pre = os.fstat(final_fd)
        if not stat.S_ISREG(pre.st_mode) or pre.st_nlink != 1 or pre.st_blocks * 512 < pre.st_size:
            raise OSError("attachment is not a private regular file")
        with os.fdopen(final_fd, "rb") as fh:
            final_fd = -1
            data = fh.read() if max_bytes is None else fh.read(max_bytes)
            post = os.fstat(fh.fileno())
        if (pre.st_dev, pre.st_ino, pre.st_mode, pre.st_size, pre.st_mtime_ns, pre.st_ctime_ns) != (
            post.st_dev,
            post.st_ino,
            post.st_mode,
            post.st_size,
            post.st_mtime_ns,
            post.st_ctime_ns,
        ):
            raise OSError("attachment changed while reading")
        status: BodyStatus = "truncated" if max_bytes is not None and len(data) == max_bytes and post.st_size > max_bytes else "external_file"
        return BodyPartInput(part_id, "persisted_output_attachment", status, "application/octet-stream", data, str(lexical))
    except (OSError, ValueError):
        return BodyPartInput(part_id, "persisted_output_attachment", "unavailable", "application/octet-stream", None, locator)
    finally:
        if root_fd is not None:
            for fd in reversed(directory_fds):
                try:
                    os.close(fd)
                except OSError:
                    pass
            if "final_fd" in locals() and final_fd >= 0:
                try:
                    os.close(final_fd)
                except OSError:
                    pass
            try:
                os.close(root_fd)
            except OSError:
                pass


def capture_revision_patch(
    repository: Path,
    *,
    run_id: str,
    source_epoch: str,
    source_event_id: str,
    repository_id: str,
    revision_id: str,
    base_id: str,
    merge_base_id: str | None = None,
    deadline: float | None = None,
) -> ChangeInput:
    """Capture a transcript-recorded revision pair with git extensions disabled."""
    change_id = "change:" + stable_id(run_id, source_event_id, "worktree_patch")
    unavailable = BodyPartInput("body:" + stable_id(change_id), "patch", "unavailable", "text/x-diff", None, None)
    if not all(isinstance(value, str) and value for value in (repository_id, revision_id, base_id)):
        return ChangeInput(change_id, run_id, source_epoch, source_event_id, None, "worktree_patch", "unavailable", repository_id or None, revision_id or None, base_id or None, merge_base_id, (), (unavailable,))
    try:
        root = repository.resolve(strict=True)
        if not root.is_dir() or any(value.startswith("-") or "\x00" in value for value in (revision_id, base_id)):
            raise ValueError("invalid repository or revision")
        argv = ["git", "-C", str(root), "diff", "--no-ext-diff", "--no-textconv", "--binary", base_id, revision_id]
        timeout = 30.0 if deadline is None else min(30.0, deadline - time.monotonic())
        if timeout <= 0:
            raise TimeoutError("source budget exceeded")
        result = subprocess.run(argv, capture_output=True, check=False, stdin=subprocess.DEVNULL, timeout=timeout)
        if result.returncode != 0:
            raise OSError("git diff failed")
        patch = result.stdout
        files = tuple(sorted({line[6:].strip() for line in patch.decode("utf-8", "replace").splitlines() if line.startswith("+++ b/")}))
        part = BodyPartInput("body:" + stable_id(change_id, hashlib.sha256(patch).hexdigest()), "patch", "available", "text/x-diff", patch, None)
        return ChangeInput(change_id, run_id, source_epoch, source_event_id, None, "worktree_patch", "captured", repository_id, revision_id, base_id, merge_base_id, files, (part,))
    except (OSError, ValueError, subprocess.SubprocessError):
        return ChangeInput(change_id, run_id, source_epoch, source_event_id, None, "worktree_patch", "unavailable", repository_id, revision_id, base_id, merge_base_id, (), (unavailable,))


__all__ = [
    "append_proven",
    "capture_attachment",
    "capture_revision_patch",
    "committed_hashes",
    "hashes_for_commit",
    "read_complete_suffix",
    "snapshot_fingerprint_matches",
    "source_fingerprint",
]
