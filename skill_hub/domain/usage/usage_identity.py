"""Canonical identity helpers shared by Usage readers.

Identity is deliberately a small, strict boundary.  A harness name must be a
known canonical id or one of the aliases emitted by the existing Usage
sources; a session id must be a UUID.  Codex periods are paths, so their
rollout UUID is extracted before constructing the key.
"""

from __future__ import annotations

import re
from typing import Any, Optional

HARNESS_IDS = frozenset(("claude-code", "codex", "pi", "opencode"))
HARNESS_ALIASES = {
    "claude": "claude-code",
    "claude-code": "claude-code",
    "codex": "codex",
    "pi": "pi",
    "opencode": "opencode",
}

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_ROLLOUT_UUID_RE = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)


def canonical_harness(value: Any) -> Optional[str]:
    """Return a known harness id, or ``None`` for unknown/ambiguous input."""
    if not isinstance(value, str):
        return None
    return HARNESS_ALIASES.get(value.lower())


def codex_rollout_id(value: Any) -> Optional[str]:
    """Extract a Codex rollout UUID while preserving the existing path rule.

    This preserves the existing normalizer contract: any UUID anchored at the
    end of a Codex period is the rollout id.  The caller still supplies the
    harness, so this permissive extraction cannot create a cross-harness join.
    """
    if not isinstance(value, str) or not value:
        return None
    tail = value.rsplit("/", 1)[-1]
    match = _ROLLOUT_UUID_RE.search(tail)
    if not match:
        return None
    return match.group(1).lower()


def session_key(harness: Any, raw_id: Any) -> Optional[str]:
    """Return ``<canonical-harness>:<lowercase-uuid>`` when fully known."""
    canonical = canonical_harness(harness)
    if canonical is None:
        return None
    candidate = codex_rollout_id(raw_id) if canonical == "codex" else raw_id
    if not isinstance(candidate, str) or not UUID_RE.fullmatch(candidate):
        return None
    return f"{canonical}:{candidate.lower()}"

