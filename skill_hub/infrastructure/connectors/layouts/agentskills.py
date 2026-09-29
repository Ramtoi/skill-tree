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


def _exec_eligible(rel: str) -> bool:
    """Whether `rel` may carry the `SkillTree.executable` flag.

    Confined to `scripts/` — the leaf-side twin of `hub._pack_exec_eligible`
    (this module is a `LEAF_SIBLINGS` leaf and may not `import hub`, so the
    "scripts/-only" rule has two independent one-line definitions; the shared
    behavioural source of truth is each side's own test suite).
    """
    return rel.startswith("scripts/")


@dataclass(frozen=True)
class SkillTree:
    """An in-memory snapshot of a skill directory: relpath → file bytes.

    `executable` is an OPTIONAL, ADDITIVE set of `scripts/`-relative paths
    (see `_exec_eligible`) that should carry the execute bit. It is deliberately
    NOT part of `tree_sha256` (see that function's docstring), and a tree built
    by a producer that never populates it — a v1 hermes blob, a drop-in
    connector, any third-party `pull_artifact` — behaves exactly as it did
    before this field existed: `write_skill_dir` issues no chmod for it at all.
    """

    name: str
    files: dict[str, bytes] = field(default_factory=dict)
    executable: set[str] = field(default_factory=set)

    @property
    def skill_md(self) -> bytes:
        return self.files.get(SKILL_FILE, b"")


def _iter_files(root: Path):
    """Yield (relative-posix-path, absolute Path) for every regular file under root."""
    for p in sorted(root.rglob("*")):
        if p.is_file() and not p.is_symlink():
            yield p.relative_to(root).as_posix(), p


def read_skill_dir(root: Path) -> SkillTree:
    """Read a skill directory into a `SkillTree` (relpath → bytes).

    `executable` collects the `scripts/`-relative paths (see `_exec_eligible`)
    whose owner-execute bit (`st_mode & 0o100`) is set on disk. Every other
    file is read unchanged regardless of its mode.
    """
    files: dict[str, bytes] = {}
    executable: set[str] = set()
    for rel, abs_path in _iter_files(root):
        files[rel] = abs_path.read_bytes()
        if _exec_eligible(rel) and (abs_path.stat().st_mode & 0o100):
            executable.add(rel)
    return SkillTree(name=root.name, files=files, executable=executable)


def write_skill_dir(root: Path, tree: SkillTree) -> None:
    """Write `tree` into `root`, creating parents. Does not delete extra files.

    Callers that need an exact mirror should clear/replace the dir first; this
    helper only ensures the tree's files are present with the given bytes.

    ADDITIVE ONLY: a `rel` is chmod'd to `0o755` only when it is BOTH in
    `tree.executable` AND `_exec_eligible` (i.e. under `scripts/`). No other
    file's mode is ever read or written here — an empty/unaware `executable`
    set (a v1 hermes blob, a drop-in connector, any producer built before this
    field existed) therefore issues NO chmod at all, so this can never strip
    an execute bit an existing destination file already has. Accepted
    consequence: a file that stops being executable upstream keeps its bit at
    the destination until someone removes it by hand.
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
        if rel in tree.executable and _exec_eligible(rel):
            dest.chmod(0o755)


def tree_sha256(tree: SkillTree) -> str:
    """Stable sha256 over a `SkillTree`'s relpaths + bytes (order-independent).

    Deliberately EXCLUDES `executable`: `connectors/transport/ssh.py::dir_sha256`
    reproduces this hash byte-for-byte inside a remote `python3` snippet, and
    every remote ownership sidecar stores its output as the drift base. Folding
    the mode into the hash would re-classify every already-managed skill on
    every remote as drifted on the next sync. Consequence, accepted: a
    mode-only difference is invisible to drift classification and is repaired
    only when a file's bytes also change.
    """
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
