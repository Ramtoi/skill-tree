"""agentskills.io SKILL.md directory layout — read / write / sha.

A skill is a directory containing a `SKILL.md` (frontmatter + body) plus any
number of supporting files (scripts, references, assets). This is the format Hub
emits locally and pushes to a remote's hub-owned skills dir.

`dir_sha256()` is a **stable content hash** over the whole tree (relative path +
file bytes), so writing a skill dir and then reading it back yields the same sha
— the foundation of drift comparison (`drift.classify`). The hash is independent
of mtime, owner, and traversal order.

Pure-ish: every function takes explicit `Path`s, so the helpers are unit-testable
against a local temp dir without any remote.
"""

from __future__ import annotations

import hashlib
import posixpath
from dataclasses import dataclass, field
from pathlib import Path

SKILL_FILE = "SKILL.md"


class UnsafeRelpath(ValueError):
    """A skill-tree relative path is absolute or escapes its root (F3).

    Relpaths in a `SkillTree` may originate from a remote (possibly
    compromised/MITM'd) box, so any absolute path or `..` traversal component is
    rejected before it is ever joined onto a local/remote destination root.
    """


def safe_relpath(rel: str) -> str:
    """Validate a tree relpath: reject absolute paths and `..` traversal.

    Returns the (unchanged) relpath when safe; raises `UnsafeRelpath` otherwise.
    Normalizing must NOT collapse a leading-`..` away, so we inspect the raw
    components: an absolute path, a `..` component, or an empty/`.`-only path is
    refused.
    """
    if rel.startswith("/") or rel.startswith("\\"):
        raise UnsafeRelpath(f"absolute skill-tree path not allowed: {rel!r}")
    # Treat both posix and Windows separators as boundaries; remote trees are
    # posix but be defensive.
    parts = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts:
        raise UnsafeRelpath(f"empty skill-tree path not allowed: {rel!r}")
    if ".." in parts:
        raise UnsafeRelpath(f"'..' traversal not allowed in skill-tree path: {rel!r}")
    # Final belt-and-braces: the normalized join must stay rooted.
    norm = posixpath.normpath("/".join(parts))
    if norm.startswith("..") or norm.startswith("/"):
        raise UnsafeRelpath(f"skill-tree path escapes its root: {rel!r}")
    return rel


@dataclass(frozen=True)
class SkillTree:
    """An in-memory snapshot of a skill directory: relpath → file bytes."""

    name: str
    files: dict[str, bytes] = field(default_factory=dict)

    @property
    def skill_md(self) -> bytes:
        return self.files.get(SKILL_FILE, b"")


def _iter_files(root: Path):
    """Yield (relative-posix-path, absolute Path) for every regular file under root."""
    for p in sorted(root.rglob("*")):
        if p.is_file() and not p.is_symlink():
            yield p.relative_to(root).as_posix(), p


def read_skill_dir(root: Path) -> SkillTree:
    """Read a skill directory into a `SkillTree` (relpath → bytes)."""
    files: dict[str, bytes] = {}
    for rel, abs_path in _iter_files(root):
        files[rel] = abs_path.read_bytes()
    return SkillTree(name=root.name, files=files)


def write_skill_dir(root: Path, tree: SkillTree) -> None:
    """Write `tree` into `root`, creating parents. Does not delete extra files.

    Callers that need an exact mirror should clear/replace the dir first; this
    helper only ensures the tree's files are present with the given bytes.
    """
    root_resolved = root.resolve()
    for rel, data in tree.files.items():
        # F3: a relpath from a (possibly compromised/MITM'd) remote must never
        # escape `root`. Reject absolute / `..` paths, then confirm the resolved
        # destination is still under root.
        safe_relpath(rel)
        dest = root / rel
        if root_resolved not in dest.resolve().parents and dest.resolve() != root_resolved:
            raise UnsafeRelpath(
                f"skill-tree path {rel!r} resolves outside root {str(root)!r}"
            )
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)


def tree_sha256(tree: SkillTree) -> str:
    """Stable sha256 over a `SkillTree`'s relpaths + bytes (order-independent)."""
    h = hashlib.sha256()
    for rel in sorted(tree.files):
        data = tree.files[rel]
        # Length-prefix each component so paths/contents can't collide by
        # concatenation (e.g. "a"+"bc" vs "ab"+"c").
        rel_b = rel.encode("utf-8")
        h.update(len(rel_b).to_bytes(8, "big"))
        h.update(rel_b)
        h.update(len(data).to_bytes(8, "big"))
        h.update(data)
    return h.hexdigest()


def dir_sha256(root: Path) -> str:
    """Stable sha256 of a skill directory on disk (read + hash)."""
    return tree_sha256(read_skill_dir(root))
