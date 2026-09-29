"""Immutable host-side harness layout snapshots.

The host registry owns labels and filesystem declarations.  This module reads
those declarations once, expands the user roots once, and returns plain frozen
records for callers that need a stable operation view.  It deliberately does
not detect installations or consult a cache.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path, PurePath
from types import MappingProxyType
from typing import Any, Mapping, Optional, Sequence, cast


def _path_text(value: object) -> str:
    """Normalize POSIX and Windows PurePath declarations without I/O."""
    if isinstance(value, PurePath):
        return value.as_posix()
    return os.fspath(cast(Any, value))


def _clean_override(value: object) -> Optional[str]:
    try:
        text = os.fspath(cast(Any, value)).strip()
    except TypeError:
        return None
    return text or None


def _rooted_path(raw: object, home: Path, claude_home: Path, codex_home: Path) -> Path:
    text = _path_text(raw)
    if text == "~":
        return home
    for prefix, root in (("~/.claude", claude_home), ("~/.codex", codex_home)):
        if text == prefix:
            return root
        if text.startswith(prefix + "/"):
            return root / text[len(prefix) + 1 :]
    if text.startswith("~/"):
        return home / text[2:]
    return Path(text).expanduser()


def _relative_path(raw: object) -> PurePath:
    return PurePath(_path_text(raw))


def _override(
    values: Mapping[str, object], keys: Sequence[str], env_key: str, fallback: Path
) -> Path:
    for key in keys:
        if key in values:
            value = _clean_override(values[key])
            if value is not None:
                return Path(value).expanduser()
    value = _clean_override(os.environ.get(env_key, ""))
    return Path(value).expanduser() if value is not None else fallback


@dataclass(frozen=True)
class OperationLayout:
    """One captured harness declaration with all user roots expanded."""

    id: str
    label: str
    project_skills_dir: PurePath
    root_doc: str
    global_skills_dir: Path
    legacy_global_skills_dirs: tuple[Path, ...]
    mcp_adapter_key: Optional[str]
    permission_adapter_key: Optional[str]
    hook_mechanism: str
    global_mcp_config: Optional[Path]
    global_doc: Optional[Path]
    agents_dir: Optional[Path]
    project_agents_dir: Optional[PurePath]
    agent_format: Optional[str]
    config_dir: Optional[Path]
    permission_global_config: Optional[Path] = None
    permission_project_config: Optional[PurePath] = None
    permission_project_local_config: Optional[PurePath] = None
    permission_rules_dir: Optional[PurePath] = None
    permission_default_rules: Optional[PurePath] = None
    hook_global_config: Optional[Path] = None
    hook_project_config: Optional[PurePath] = None

    def doc_target(self) -> Optional[Path]:
        """Return this captured harness's user-global instruction document."""
        return self.global_doc

    def agent_target(
        self, scope: str, project_path: Optional[Path] = None
    ) -> Optional[Path]:
        """Return a captured agent directory, preserving Codex's project gap."""
        if scope not in {"user", "project"}:
            raise ValueError("invalid scope (expected user|project)")
        if scope == "user":
            if project_path is not None:
                raise ValueError("user scope does not accept project_path")
            return self.agents_dir
        if project_path is None:
            raise ValueError("project scope requires project_path")
        # Codex's project_agents_dir is declarative future data; the current
        # host contract intentionally keeps project-scope agents unsupported.
        if self.id == "codex" or self.project_agents_dir is None:
            return None
        return Path(project_path) / self.project_agents_dir


def capture_layouts(
    harness_ids: Sequence[str],
    *,
    home: Optional[Path] = None,
    home_overrides: Optional[Mapping[str, object]] = None,
) -> Mapping[str, OperationLayout]:
    """Capture requested host layouts and return an immutable mapping.

    Registry objects, detector callables, and environment values are read only
    during this call.  Missing IDs are omitted rather than represented by a
    guessed layout.
    """
    from skill_hub.infrastructure.harnesses import harnesses

    values = dict(home_overrides or {})
    base_home = Path(home).expanduser() if home is not None else Path.home()
    claude_home = _override(
        values,
        ("claude-code", "claude", "SKILL_HUB_CLAUDE_HOME"),
        "SKILL_HUB_CLAUDE_HOME",
        base_home / ".claude",
    )
    codex_home = _override(
        values,
        ("codex", "CODEX_HOME"),
        "CODEX_HOME",
        base_home / ".codex",
    )

    captured: dict[str, OperationLayout] = {}
    declarations = harnesses.HARNESSES
    for harness_id in tuple(dict.fromkeys(harness_ids)):
        declaration = declarations.get(harness_id)
        if declaration is None:
            continue
        global_doc = (
            _rooted_path(declaration.global_doc, base_home, claude_home, codex_home)
            if declaration.global_doc is not None
            else None
        )
        global_mcp = (
            _rooted_path(
                declaration.global_mcp_config, base_home, claude_home, codex_home
            )
            if declaration.global_mcp_config is not None
            else None
        )
        agents_dir = (
            _rooted_path(declaration.agents_dir, base_home, claude_home, codex_home)
            if declaration.agents_dir is not None
            else None
        )
        if harness_id == "claude-code":
            config_dir = claude_home
        elif harness_id == "codex":
            config_dir = codex_home
        elif harness_id == "pi":
            config_dir = base_home / ".pi" / "agent"
        elif harness_id == "opencode":
            config_dir = base_home / ".config" / "opencode"
        else:
            config_dir = None
        if harness_id == "claude-code":
            permission_project = PurePath(".claude/settings.json")
            permission_local = PurePath(".claude/settings.local.json")
        elif harness_id == "pi":
            permission_project = PurePath(".pi/agent/settings.json")
            permission_local = PurePath(".pi/agent/settings.local.json")
        elif harness_id == "opencode":
            permission_project = PurePath("opencode.json")
            permission_local = None
        else:
            permission_project = None
            permission_local = None
        captured[harness_id] = OperationLayout(
            id=str(declaration.id),
            label=str(declaration.label),
            project_skills_dir=_relative_path(declaration.project_skills_dir),
            root_doc=_path_text(declaration.root_doc),
            global_skills_dir=_rooted_path(
                declaration.global_skills_dir, base_home, claude_home, codex_home
            ),
            legacy_global_skills_dirs=tuple(
                _rooted_path(path, base_home, claude_home, codex_home)
                for path in declaration.legacy_global_skills_dirs
            ),
            mcp_adapter_key=declaration.mcp_adapter_key,
            permission_adapter_key=declaration.permission_adapter_key,
            hook_mechanism=str(declaration.hook_mechanism),
            global_mcp_config=global_mcp,
            global_doc=global_doc,
            agents_dir=agents_dir,
            project_agents_dir=(
                _relative_path(declaration.project_agents_dir)
                if declaration.project_agents_dir is not None
                else None
            ),
            agent_format=declaration.agent_format,
            config_dir=config_dir,
            permission_global_config=(
                config_dir / "settings.json"
                if harness_id in {"claude-code", "pi"} and config_dir is not None
                else config_dir / "config.toml"
                if harness_id == "codex" and config_dir is not None
                else config_dir / "opencode.json"
                if harness_id == "opencode" and config_dir is not None
                else None
            ),
            permission_project_config=permission_project,
            permission_project_local_config=permission_local,
            permission_rules_dir=PurePath(".codex/rules") if harness_id == "codex" else None,
            permission_default_rules=PurePath(".codex/rules/default.rules") if harness_id == "codex" else None,
            hook_global_config=(
                config_dir / "settings.json"
                if harness_id in {"claude-code", "pi"} and config_dir is not None
                else config_dir / "config.toml"
                if harness_id == "codex" and config_dir is not None
                else None
            ),
            hook_project_config=(
                PurePath(".claude/settings.local.json")
                if harness_id == "claude-code"
                else PurePath(".pi/agent/settings.local.json")
                if harness_id == "pi"
                else None
            ),
        )
    return MappingProxyType(captured)


def doc_target(
    layouts: Mapping[str, OperationLayout], harness_id: str
) -> Optional[Path]:
    """Resolve a document target from a captured layout mapping."""
    layout = layouts.get(harness_id)
    return layout.doc_target() if layout is not None else None


def agent_target(
    layouts: Mapping[str, OperationLayout],
    scope: str,
    project_path: Optional[Path] = None,
    harness_id: str = "claude-code",
) -> Optional[Path]:
    """Resolve an agent target from a captured layout mapping."""
    layout = layouts.get(harness_id)
    if layout is None:
        if scope not in {"user", "project"}:
            raise ValueError("invalid scope (expected user|project)")
        if scope == "project" and project_path is None:
            raise ValueError("project scope requires project_path")
        return None
    return layout.agent_target(scope, project_path)


__all__ = ["OperationLayout", "agent_target", "capture_layouts", "doc_target"]
