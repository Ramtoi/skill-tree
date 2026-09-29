"""Captured Usage transcript roots and host-owned source inventory rules."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Mapping, Optional

from skill_hub.application.harnesses.harness_layout_context import OperationLayout, capture_layouts

_UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
_HARNESS_ORDER = ("claude-code", "codex")


@dataclass(frozen=True)
class UsageLayout:
    """The lexical transcript roots captured for one Usage operation."""

    _entries: tuple[tuple[str, Path], ...]

    def roots(self) -> dict[str, Path]:
        """Return a mutable snapshot for callers that need a roots mapping."""
        return dict(self._entries)

    def root(self, harness: str) -> Optional[Path]:
        """Return one captured root, or ``None`` when it was undeclared."""
        return dict(self._entries).get(harness)

    @property
    def claude_projects_root(self) -> Optional[Path]:
        return self.root("claude-code")

    @property
    def codex_sessions_root(self) -> Optional[Path]:
        return self.root("codex")


def capture_usage_layout(
    layouts: Optional[Mapping[str, OperationLayout]] = None,
) -> UsageLayout:
    """Derive Usage roots from an already captured harness layout.

    ``capture_layouts`` is called exactly once when no mapping is supplied.
    Missing ``config_dir`` declarations stay missing; this function never
    invents a home or consults the environment itself.
    """
    captured = layouts if layouts is not None else capture_layouts(_HARNESS_ORDER)
    entries: list[tuple[str, Path]] = []
    for harness in _HARNESS_ORDER:
        layout = captured.get(harness)
        config_dir = getattr(layout, "config_dir", None) if layout is not None else None
        if config_dir is None:
            continue
        suffix = "projects" if harness == "claude-code" else "sessions"
        entries.append((harness, Path(config_dir) / suffix))
    return UsageLayout(tuple(entries))


def _claude_path_accepted(path: Path) -> bool:
    return bool(_UUID.fullmatch(path.stem)) or (
        path.parent.name == "subagents"
        or (
            path.stem.startswith("agent-")
            and any(parent.name == "subagents" for parent in path.parents)
        )
    )


def _source_path_accepted(harness: str, path: Path) -> bool:
    if harness == "claude-code":
        return _claude_path_accepted(path)
    if harness == "codex":
        return path.name.startswith("rollout-") and path.name.endswith(".jsonl")
    return False


def iter_source_candidates(harness: str, root: Path) -> Iterator[tuple[Path, bool]]:
    """Yield lexical JSONL candidates and whether each is an accepted source."""
    root = Path(root)
    if not root.is_dir():
        return
    if harness == "claude-code":
        for path in sorted(root.rglob("*.jsonl"), key=str):
            yield path, _source_path_accepted(harness, path)
    elif harness == "codex":
        for path in sorted(root.rglob("rollout-*.jsonl"), key=str):
            yield path, True


def iter_source_paths(harness: str, root: Path) -> Iterator[Path]:
    """Yield accepted source paths below a captured lexical root."""
    for path, accepted in iter_source_candidates(harness, root):
        if accepted:
            yield path


def _safe_session_id(session_id: str) -> bool:
    return (
        bool(session_id)
        and session_id not in {".", ".."}
        and "/" not in session_id
        and "\\" not in session_id
        and "\x00" not in session_id
    )


def source_present(layout: UsageLayout, harness: str, session_id: str) -> bool:
    """Check presence using the same accepted paths as host discovery."""
    if not isinstance(session_id, str) or not _safe_session_id(session_id):
        return False
    root = layout.root(harness)
    if root is None:
        return False
    try:
        for path in iter_source_paths(harness, root):
            if harness == "codex":
                if path.name.endswith(f"{session_id}.jsonl"):
                    return True
            elif path.stem == session_id:
                return True
    except OSError:
        return False
    return False


__all__ = [
    "UsageLayout",
    "capture_usage_layout",
    "iter_source_candidates",
    "iter_source_paths",
    "source_present",
]
