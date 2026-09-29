"""Defaults for the worktree directory and access intent of new projects.

This module deliberately resolves one concrete directory at a time.  It does
not create worktrees, directories, or agent instructions.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional

DEFAULTS = {
    "location": "shared-directory",
    "base_dir": "~/Dev/worktrees",
    "access_enabled": False,
    "include_in_backup": False,
}
LOCATIONS = ("shared-directory", "project-subdirectory")
_SLUG_RE = re.compile(r"^[a-z0-9-]+$")
_FIELDS = frozenset(DEFAULTS)


class WorktreeDefaultsError(ValueError):
    """A worktree-defaults value cannot be safely used."""

    def __init__(self, message: str, *, code: str = "invalid_config", field: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.field = field


def _collapse_home(path: Path, home: Path) -> str:
    resolved = str(path)
    home_str = str(home)
    if resolved == home_str:
        return "~"
    if resolved.startswith(home_str + os.sep):
        return "~" + resolved[len(home_str) :]
    return resolved


def _validate_base_dir(value: Any, *, home: Path) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise WorktreeDefaultsError(
            "base_dir must be a non-empty path", field="base_dir"
        )
    raw = value.strip()
    if raw == "~":
        expanded = home
    elif raw.startswith("~/"):
        expanded = home / raw[2:]
    else:
        expanded = Path(raw.replace("\\", os.sep) if os.name == "nt" else raw)
    if not expanded.is_absolute():
        raise WorktreeDefaultsError("base_dir must be absolute or use ~", field="base_dir")
    resolved = expanded.resolve(strict=False)
    if resolved.exists() and not resolved.is_dir():
        raise WorktreeDefaultsError("base_dir must name a directory", field="base_dir")
    return _collapse_home(resolved, home)


def normalize(value: Any, *, home: Optional[Path] = None) -> dict[str, Any]:
    """Validate and return the canonical complete persisted block.

    Missing fields retain the built-in defaults for compatibility with older
    registries.  Unknown fields are rejected so a misspelled setting cannot be
    silently ignored.
    """
    if value is None:
        raise WorktreeDefaultsError("worktree_defaults must be an object")
    if not isinstance(value, dict):
        raise WorktreeDefaultsError("worktree_defaults must be an object")
    unknown = sorted(set(value) - _FIELDS)
    if unknown:
        raise WorktreeDefaultsError(
            "unknown worktree_defaults field: " + unknown[0], field=unknown[0]
        )
    merged = {**DEFAULTS, **value}
    location = merged["location"]
    if location not in LOCATIONS:
        raise WorktreeDefaultsError(
            "location must be shared-directory or project-subdirectory", field="location"
        )
    for field in ("access_enabled", "include_in_backup"):
        if not isinstance(merged[field], bool):
            raise WorktreeDefaultsError(f"{field} must be boolean", field=field)
    home_path = (Path(home) if home is not None else Path.home()).expanduser().resolve()
    return {
        "location": location,
        "base_dir": _validate_base_dir(merged["base_dir"], home=home_path),
        "access_enabled": merged["access_enabled"],
        "include_in_backup": merged["include_in_backup"],
    }


def configured(registry: dict[str, Any], *, home: Optional[Path] = None) -> Optional[dict[str, Any]]:
    """Return a validated configured block, or ``None`` when it is absent."""
    if "worktree_defaults" not in registry:
        return None
    raw = registry.get("worktree_defaults")
    if raw is None:
        raise WorktreeDefaultsError("worktree_defaults must be an object")
    return normalize(raw, home=home)


def effective(registry: dict[str, Any], *, home: Optional[Path] = None) -> dict[str, Any]:
    """Return effective defaults without persisting a missing block."""
    if "worktree_defaults" not in registry:
        return normalize(dict(DEFAULTS), home=home)
    return configured(registry, home=home) or normalize(dict(DEFAULTS), home=home)


def _validate_absolute_project_path(project_path: str | Path) -> Path:
    path = Path(project_path).expanduser()
    if not path.is_absolute():
        raise WorktreeDefaultsError("project path must be absolute", code="invalid_path", field="path")
    if "\x00" in str(project_path):
        raise WorktreeDefaultsError("project path contains NUL", code="invalid_path", field="path")
    # Preview is allowed to describe a not-yet-created checkout. Registration
    # performs its own existence check before calling this resolver. An
    # existing file is always invalid because it cannot contain `.worktrees`.
    if path.exists() and not path.is_dir():
        raise WorktreeDefaultsError(
            "project path is not a directory",
            code="invalid_path",
            field="path",
        )
    return path.resolve()


def resolve(
    defaults: dict[str, Any],
    *,
    name: str,
    project_path: str | Path,
    home: Optional[Path] = None,
) -> dict[str, Any]:
    """Resolve a validated defaults block to one normalized project directory."""
    if not isinstance(name, str) or not _SLUG_RE.fullmatch(name):
        raise WorktreeDefaultsError(
            "name must use lowercase letters, numbers, and hyphens",
            code="invalid_name",
            field="name",
        )
    home_path = (Path(home) if home is not None else Path.home()).expanduser().resolve()
    normalized = normalize(defaults, home=home_path)
    project = _validate_absolute_project_path(project_path)
    if normalized["location"] == "shared-directory":
        raw_base = normalized["base_dir"]
        target_base = (
            home_path / raw_base[2:]
            if raw_base.startswith("~/")
            else home_path
            if raw_base == "~"
            else Path(raw_base)
        )
        target = target_base / name
    else:
        target = project / ".worktrees"
    # NormalizedPermissions owns the directory-grant path grammar.  Enable the
    # temporary validation input even when the stored access choice is off.
    from skill_hub.domain.permissions.permissions import NormalizedPermissions

    try:
        checked = NormalizedPermissions.from_block(
            {"worktree_access": {"enabled": True, "path": str(target)}}
        ).worktree_access
    except ValueError as exc:
        raise WorktreeDefaultsError(str(exc), code="invalid_path", field="base_dir") from exc
    assert checked is not None
    return {
        "path": checked["path"],
        "access_enabled": normalized["access_enabled"],
        "missing_directory": not Path(checked["path"]).is_dir(),
    }


def project_permissions(
    defaults: dict[str, Any],
    *,
    name: str,
    project_path: str | Path,
    home: Optional[Path] = None,
) -> dict[str, Any]:
    result = resolve(defaults, name=name, project_path=project_path, home=home)
    return {"worktree_access": {"enabled": result["access_enabled"], "path": result["path"]}}
