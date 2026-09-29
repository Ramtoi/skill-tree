"""skill_hub/application/backup/references.py — shared internal-reference resolution.

One hop-by-hop containment rule, used by both directions of the same
decision:

* **backup** (`backup.py:_copy_dir`) resolves a live data-home symlink to its
  target bytes so a safe internal reference (e.g.
  `skills/a/references/x.md -> ../../b/references/x.md`) is materialized as a
  regular file in the snapshot BEFORE signing — placement and content then
  travel under the existing tree digest and SSHSIG with no schema change.
* **restore** (`restore.py:_data_file_source`) resolves the same shape inside
  an already-materialized snapshot tree, for the legacy case: a snapshot
  written before this module existed still carries a real symlink, whose
  target was never covered by any digest or signature.

Living here, not in `backup.py` or `restore.py`, is what keeps the shared
logic from creating an import cycle: `restore.py` already imports `backup.py`
(it needs `verify_tree_digest`, `read_manifest`, …), so a helper `backup.py`
also needs cannot live in `restore.py`.

Pure path arithmetic — no filesystem writes, no knowledge of snapshots,
manifests, or the data home's own layout beyond "some root directory with a
few named subsections a reference may resolve within."
"""

from __future__ import annotations

import os
from pathlib import Path

#: The only data sections a reference may resolve within, on either side.
#: Kept identical to `restore.DATA_DIRS` — the two names refer to the same
#: four snapshot-relative (backup time) / data-home-relative (restore time)
#: top-level directories, and must never diverge.
REFERENCE_SECTIONS = ("skills", "mcp-servers", "snippets", "connectors")

#: A resolution chain longer than this is refused rather than followed
#: further — the same bound `restore._data_file_source` has always used.
MAX_CHAIN_HOPS = 64


class ReferenceError(RuntimeError):
    """A reference chain fails the safe-internal-reference contract."""


def resolve_reference_chain(
    root: Path, path: Path, *, sections: tuple = REFERENCE_SECTIONS
) -> Path:
    """Follow `path` (a file under `root`, possibly a symlink chain) to a
    regular file that stays under `root`, inside one of `sections`, at every
    hop.

    `path` itself need not be a symlink — an ordinary regular file resolves
    to itself immediately, so a caller can use this on every entry uniformly.

    Raises `ReferenceError` for an absolute link target, a target that
    escapes `root` (directly or through `..`), a cyclic chain, a dangling
    link, a link through a directory (any path component between `root` and
    the final target being itself a symlink), a target outside `sections`,
    or a chain longer than `MAX_CHAIN_HOPS`.
    """
    root = Path(os.path.abspath(root))
    current = Path(os.path.abspath(path))
    seen: set = set()
    for _ in range(MAX_CHAIN_HOPS):
        try:
            relative = current.relative_to(root)
        except ValueError:
            raise ReferenceError("reference escapes its root")
        if not relative.parts or relative.parts[0] not in sections:
            raise ReferenceError("reference target is outside allowed data sections")
        if current in seen:
            raise ReferenceError("cyclic reference")
        seen.add(current)
        parent = root
        for part in relative.parts[:-1]:
            parent = parent / part
            if parent.is_symlink():
                raise ReferenceError("directory references are not supported")
        if not current.is_symlink():
            if not current.is_file():
                raise ReferenceError("reference target is not a regular file")
            return current
        target = os.readlink(current)
        if os.path.isabs(target) or target.startswith("\\"):
            raise ReferenceError("absolute references are not supported")
        current = Path(os.path.abspath(current.parent / target))
    raise ReferenceError("reference chain is too long")
