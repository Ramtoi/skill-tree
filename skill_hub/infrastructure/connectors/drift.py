"""Pure 3-way drift classification — connector-agnostic, no I/O.

The remote ownership sidecar records, per managed artifact, `last_pushed_sha256`
= the **base**. A scan compares base vs the remote-current sha vs the
local-current sha and `classify()` derives one `DriftStatus`.

Truth table (DECISIONS.md D8 / design.md §5):

| base vs remote | base vs local         | status         | sync action      |
|----------------|-----------------------|----------------|------------------|
| same           | same                  | in-sync        | noop             |
| same           | changed               | local-ahead    | fast_forward     |
| changed        | same                  | remote-drifted | SKIP (offer pull)|
| changed        | changed (remote≠local)| conflict       | SKIP (resolve)   |
| (managed) gone remotely               | missing        | report           |
| local removed, still present remotely | orphaned       | remove           |

`None` shas encode presence/absence:
  - `remote_sha is None` → the artifact is not (or no longer) on the remote.
  - `local_sha is None`  → the artifact was removed locally.

A sha is compared only for equality; callers pass any stable content digest.
"""

from __future__ import annotations

from typing import Optional

from .base import DriftStatus


def classify(
    base_sha: Optional[str],
    remote_sha: Optional[str],
    local_sha: Optional[str],
) -> DriftStatus:
    """Classify one artifact from (base, remote-current, local-current) shas.

    `base_sha` is the sidecar's `last_pushed_sha256` (None ⇒ never pushed /
    unmanaged — but for unmanaged artifacts callers should not reach here; the
    ownership invariant keeps them out of the managed plan).
    """
    # Removed locally but still present on the remote → orphan (sidecar-scoped
    # remove). Checked first: a local removal is the dominant intent regardless
    # of base.
    if local_sha is None:
        if remote_sha is None:
            # Gone both sides — nothing to do.
            return DriftStatus.IN_SYNC
        return DriftStatus.ORPHANED

    # Present locally, but the managed artifact has vanished from the remote
    # (the agent deleted it). Report; do not silently recreate during plan
    # classification (plan/apply decide separately whether to re-create).
    if remote_sha is None:
        return DriftStatus.MISSING

    remote_changed = remote_sha != base_sha
    local_changed = local_sha != base_sha

    if not remote_changed and not local_changed:
        return DriftStatus.IN_SYNC
    if not remote_changed and local_changed:
        return DriftStatus.LOCAL_AHEAD
    if remote_changed and not local_changed:
        return DriftStatus.REMOTE_DRIFTED
    # Both changed.
    if remote_sha == local_sha:
        # Converged independently to the same content — treat as in-sync; only
        # the base lags (a re-base, not a conflict).
        return DriftStatus.IN_SYNC
    return DriftStatus.CONFLICT
