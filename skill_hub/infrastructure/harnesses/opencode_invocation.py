"""Fail-closed opencode V1 command-only delivery.

This leaf deliberately keeps eligibility separate from delivery.  ``plan_command``
only reads the project, user-global discovery/configuration and source files;
``apply_command`` is the only operation that writes the generated payload and
the opencode command link.  The generated command points at the source
``SKILL.md`` instead of copying its body into opencode's template language.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from skill_hub import hub_core
from skill_hub.domain.skills import skill_meta

SUPPORTED_PROFILE = "opencode-v1.18.31"
# V1 exposes both server commands and a TUI slash-command registry.  Keep this
# conservative until a primary source pins the complete precedence table.
_BUILTIN_COMMANDS = frozenset(
    (
        "help",
        "model",
        "models",
        "connect",
        "exit",
        "quit",
        "session",
        "sessions",
        "new",
        "share",
        "unshare",
        "compact",
        "undo",
        "redo",
        "editor",
        "export",
        "themes",
        "theme",
        "status",
        "details",
        "timeline",
        "fork",
        "rename",
        "agents",
        "agent",
        "init",
        "review",
    )
)
_COMMAND_DIR_NAMES = ("command", "commands")
_SKILL_DIRS = (
    ".agents/skills",
    ".agents/skill",
    ".claude/skills",
    ".claude/skill",
    ".opencode/skills",
    ".opencode/skill",
)
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_UNSAFE_PATH_CHARS = frozenset((",", "`", "$"))


@dataclass(frozen=True)
class NativePaths:
    """Immutable path and environment snapshot for one operation."""

    home: Path
    data_home: Path
    xdg_config_home: Path
    xdg_data_home: Path
    config_content: str | None = None
    config_path: Path | None = None
    config_dir: str | None = None


def capture_native_paths(
    *, home: Path | None = None, data_home: Path | None = None
) -> NativePaths:
    """Capture only path/config settings used by native OpenCode delivery."""

    captured_home = _absolute(home if home is not None else Path.home())
    config_raw = os.environ.get("XDG_CONFIG_HOME", "").strip()
    data_raw = os.environ.get("XDG_DATA_HOME", "").strip()
    config_env = os.environ.get("OPENCODE_CONFIG", "").strip()
    config_dir = os.environ.get("OPENCODE_CONFIG_DIR", "").strip() or None
    config_path = (
        _expand_user_path(config_env, captured_home) if config_env else None
    )
    return NativePaths(
        home=captured_home,
        data_home=_absolute(data_home if data_home is not None else hub_core._resolve_data_home_path()),
        xdg_config_home=(
            _absolute(_expand_user_path(config_raw, captured_home))
            if config_raw
            else captured_home / ".config"
        ),
        xdg_data_home=(
            _absolute(_expand_user_path(data_raw, captured_home))
            if data_raw
            else captured_home / ".local" / "share"
        ),
        config_content=os.environ.get("OPENCODE_CONFIG_CONTENT"),
        config_path=config_path,
        config_dir=config_dir,
    )


def _expand_user_path(raw: str, home: Path) -> Path:
    if raw == "~":
        return home
    if raw.startswith("~/"):
        return home / raw[2:]
    return Path(raw).expanduser()


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _inside(path: Path, root: Path) -> bool:
    """Return whether ``path`` is inside ``root`` without resolving symlinks."""

    try:
        _absolute(path).relative_to(_absolute(root))
    except ValueError:
        return False
    return True


def _resolved_inside(path: Path, root: Path) -> bool:
    try:
        Path(os.path.realpath(path)).relative_to(Path(os.path.realpath(root)))
    except ValueError:
        return False
    return True


def _path_has_unsafe_chars(path: Path) -> bool:
    text = os.fspath(path)
    return any(character.isspace() or character in _UNSAFE_PATH_CHARS for character in text)


def _source_paths(source: Path) -> tuple[Path, Path]:
    source = _absolute(source)
    if source.suffix.lower() == ".md" or source.name == "SKILL.md":
        return source, source.parent
    return source / "SKILL.md", source


def _home(native_paths: NativePaths | None = None) -> Path:
    return native_paths.home if native_paths is not None else _absolute(Path.home())


def _xdg_config_home(native_paths: NativePaths | None = None) -> Path:
    if native_paths is not None:
        return native_paths.xdg_config_home
    raw = os.environ.get("XDG_CONFIG_HOME", "").strip()
    return _absolute(Path(raw)) if raw else _home() / ".config"


def _xdg_data_home(native_paths: NativePaths | None = None) -> Path:
    if native_paths is not None:
        return native_paths.xdg_data_home
    raw = os.environ.get("XDG_DATA_HOME", "").strip()
    return _absolute(Path(raw)) if raw else _home() / ".local" / "share"


def _project_ancestors(project_path: Path | None) -> list[Path]:
    if project_path is None:
        return []
    current = _absolute(project_path)
    if not current.is_dir() and current.suffix:
        current = current.parent
    result: list[Path] = []
    while True:
        result.append(current)
        if current.parent == current:
            break
        current = current.parent
    return result


def _global_skill_roots(native_paths: NativePaths | None = None) -> list[Path]:
    home = _home(native_paths)
    config = _xdg_config_home(native_paths) / "opencode"
    data = _xdg_data_home(native_paths) / "opencode"
    roots = [
        home / ".agents" / "skills",
        home / ".agents" / "skill",
        home / ".claude" / "skills",
        home / ".claude" / "skill",
        home / ".opencode" / "skills",
        home / ".opencode" / "skill",
        config / "skills",
        config / "skill",
        data / "skills",
        data / "skill",
    ]
    return _unique_paths(roots)


def _skill_roots(
    project_path: Path | None, native_paths: NativePaths | None = None
) -> list[Path]:
    roots: list[Path] = []
    for ancestor in _project_ancestors(project_path):
        roots.extend(ancestor / relative for relative in _SKILL_DIRS)
    roots.extend(_global_skill_roots(native_paths))
    return _unique_paths(roots)


def _unique_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        absolute = _absolute(path)
        key = os.path.normcase(os.fspath(absolute))
        if key not in seen:
            seen.add(key)
            result.append(absolute)
    return result


def _command_dirs(
    project_path: Path | None, native_paths: NativePaths | None = None
) -> list[Path]:
    if project_path is None:
        roots = [_xdg_config_home(native_paths) / "opencode"]
    else:
        roots = [_absolute(project_path) / ".opencode"]
    return _unique_paths(root / name for root in roots for name in _COMMAND_DIR_NAMES)


def _visible_command_dirs(
    project_path: Path | None, native_paths: NativePaths | None = None
) -> list[Path]:
    """Every command directory opencode can see for a project."""

    roots: list[Path] = []
    if project_path is not None:
        roots.extend(ancestor / ".opencode" for ancestor in _project_ancestors(project_path))
    roots.append(_xdg_config_home(native_paths) / "opencode")
    return _unique_paths(root / name for root in roots for name in _COMMAND_DIR_NAMES)


def _config_paths(
    project_path: Path | None, native_paths: NativePaths | None = None
) -> list[Path]:
    paths: list[Path] = []
    for ancestor in _project_ancestors(project_path):
        for base in (ancestor, ancestor / ".opencode"):
            paths.extend((base / "opencode.json", base / "opencode.jsonc"))
    config_root = _xdg_config_home(native_paths) / "opencode"
    paths.extend(
        (
            config_root / "opencode.json",
            config_root / "opencode.jsonc",
            config_root / "config.json",
            config_root / "config.jsonc",
        )
    )
    return _unique_paths(paths)


def _strip_jsonc(text: str) -> str:
    """Strip JSONC comments while retaining strings, URLs and line endings."""

    output: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        character = text[index]
        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            output.append(character)
            index += 1
            continue
        if character == "/" and index + 1 < len(text) and text[index + 1] == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
            continue
        if character == "/" and index + 1 < len(text) and text[index + 1] == "*":
            index += 2
            while index + 1 < len(text) and text[index : index + 2] != "*/":
                if text[index] in "\r\n":
                    output.append(text[index])
                index += 1
            index = min(len(text), index + 2)
            continue
        output.append(character)
        index += 1
    return "".join(output)


def _strip_trailing_commas(text: str) -> str:
    output: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        character = text[index]
        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            output.append(character)
            index += 1
            continue
        if character == ",":
            lookahead = index + 1
            while lookahead < len(text) and text[lookahead].isspace():
                lookahead += 1
            if lookahead < len(text) and text[lookahead] in "}]":
                index += 1
                continue
        output.append(character)
        index += 1
    return "".join(output)


def _read_jsonc(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return None, f"could not read opencode config {path}: {exc}"
    try:
        value = json.loads(_strip_trailing_commas(_strip_jsonc(text)))
    except (TypeError, ValueError) as exc:
        return None, f"invalid opencode config {path}: {exc}"
    if not isinstance(value, dict):
        return None, f"opencode config {path} must contain an object"
    return value, None


def _env_config(
    native_paths: NativePaths | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Read explicitly selected config without ever writing or probing it."""

    content = (
        native_paths.config_content
        if native_paths is not None
        else os.environ.get("OPENCODE_CONFIG_CONTENT")
    )
    if content is not None:
        try:
            value = json.loads(_strip_trailing_commas(_strip_jsonc(content)))
        except (TypeError, ValueError) as exc:
            return [], f"invalid OPENCODE_CONFIG_CONTENT: {exc}"
        if not isinstance(value, dict):
            return [], "OPENCODE_CONFIG_CONTENT must contain an object"
        return [value], None

    paths: list[Path] = []
    config = (
        str(native_paths.config_path)
        if native_paths is not None and native_paths.config_path is not None
        else ""
        if native_paths is not None
        else os.environ.get("OPENCODE_CONFIG", "").strip()
    )
    config_dir = (
        native_paths.config_dir
        if native_paths is not None
        else os.environ.get("OPENCODE_CONFIG_DIR", "").strip()
    )
    if config_dir:
        # The directory also changes plugin/skill discovery.  Its contents are
        # intentionally handled as an unknown source by the caller unless a
        # future probe enumerates its complete runtime contract.
        return [], "OPENCODE_CONFIG_DIR changes opencode discovery roots"
    if config:
        paths.append(
            _absolute(
                native_paths.config_path
                if native_paths is not None and native_paths.config_path is not None
                else Path(config).expanduser()
            )
        )
    configs: list[dict[str, Any]] = []
    for path in _unique_paths(paths):
        if not path.exists():
            return [], f"configured opencode config does not exist: {path}"
        value, error = _read_jsonc(path)
        if error:
            return [], error
        if value is not None:
            configs.append(value)
    return configs, None


def _nonempty(value: object) -> bool:
    if value is None or value is False or value == "":
        return False
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


def _config_risk(value: object, *, context: tuple[str, ...] = ()) -> str | None:
    """Return a reason for config controls that make discovery incomplete."""

    if isinstance(value, Mapping):
        for key, child in value.items():
            key_text = str(key).lower().replace("-", "_")
            next_context = context + (key_text,)
            if key_text in {"plugin", "plugins", "mcp", "prompt", "prompts"} and _nonempty(child):
                return f"configured {key_text} sources cannot be safely enumerated"
            if key_text in {"skill", "skills"} and _nonempty(child):
                return "configured skill sources cannot be safely excluded"
            if key_text in {"command", "commands"} and isinstance(child, Mapping):
                # The mapping is checked separately for name collisions. Nested
                # command values are templates and do not affect discovery.
                continue
            if _config_risk(child, context=next_context):
                return _config_risk(child, context=next_context)
        return None
    if isinstance(value, list):
        for child in value:
            if _config_risk(child, context=context):
                return _config_risk(child, context=context)
        return None
    if isinstance(value, str) and value.lower().startswith(("http://", "https://")):
        if any(part in context for part in ("skill", "skills", "plugin", "plugins", "mcp", "prompt", "prompts")):
            return "remote opencode sources cannot be safely excluded"
    return None


def _configured_command_names(config: Mapping[str, Any]) -> set[str]:
    names: set[str] = set()
    for key, value in config.items():
        if str(key).lower().replace("-", "_") not in {"command", "commands"}:
            continue
        if isinstance(value, Mapping):
            names.update(str(name) for name in value)
    return names


def _read_configs(
    project_path: Path | None, native_paths: NativePaths | None = None
) -> tuple[list[dict[str, Any]], str | None]:
    explicit, error = _env_config(native_paths)
    if error:
        return [], error
    configs = list(explicit)
    config_file = (
        str(native_paths.config_path)
        if native_paths is not None and native_paths.config_path is not None
        else ""
        if native_paths is not None
        else os.environ.get("OPENCODE_CONFIG", "").strip()
    )
    if config_file:
        path = _absolute(
            native_paths.config_path
            if native_paths is not None and native_paths.config_path is not None
            else Path(config_file).expanduser()
        )
        if not path.exists():
            return [], f"configured opencode config does not exist: {path}"
        value, error = _read_jsonc(path)
        if error:
            return [], error
        if value is not None:
            configs.append(value)
    for path in _config_paths(project_path, native_paths):
        if not path.exists():
            continue
        value, error = _read_jsonc(path)
        if error:
            return [], error
        if value is not None:
            configs.append(value)
    return configs, None


def _autodiscovered_risk(
    project_path: Path | None, native_paths: NativePaths | None = None
) -> str | None:
    """Account for runtime-loaded plugins and remote/auth discovery files."""

    plugin_dirs: list[Path] = []
    for ancestor in _project_ancestors(project_path):
        plugin_dirs.extend((ancestor / ".opencode" / "plugins", ancestor / "plugins"))
    config_root = _xdg_config_home(native_paths) / "opencode"
    data_root = _xdg_data_home(native_paths) / "opencode"
    plugin_dirs.extend((config_root / "plugins", data_root / "plugins"))
    for directory in _unique_paths(plugin_dirs):
        if not directory.exists():
            continue
        if not directory.is_dir():
            return f"opencode plugin path is not a directory: {directory}"
        try:
            if any(directory.rglob("*")):
                return f"autodiscovered opencode plugins cannot be safely excluded: {directory}"
        except OSError as exc:
            return f"could not scan opencode plugin path {directory}: {exc}"

    auth_paths = [
        config_root / "auth.json",
        config_root / "auth.jsonc",
        data_root / "auth.json",
        data_root / "auth.jsonc",
    ]
    for path in _unique_paths(auth_paths):
        if not path.exists():
            continue
        try:
            if path.stat().st_size:
                return f"autodiscovered opencode remote/auth config cannot be safely excluded: {path}"
        except OSError as exc:
            return f"could not inspect opencode remote/auth config {path}: {exc}"
    return None


def _owned_root(native_paths: NativePaths | None = None) -> Path:
    # ``plan_command`` is explicitly read-only.  ``data_home()`` creates its
    # standard subdirectories, so use the resolver here and let ``apply`` make
    # only the artifact directory it actually needs.
    data_home = (
        native_paths.data_home
        if native_paths is not None
        else hub_core._resolve_data_home_path()
    )
    return _absolute(data_home / "state" / "invocation_commands")


def _artifact_path(
    name: str, source: Path, native_paths: NativePaths | None = None
) -> Path:
    identity = f"{name}\0{_absolute(source)}".encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()
    return _owned_root(native_paths) / f"{digest}.md"


def _is_owned_target(path: Path, native_paths: NativePaths | None = None) -> bool:
    root = _owned_root(native_paths)
    return (
        path.is_symlink()
        and not root.is_symlink()
        and _resolved_inside(path, root)
    )


def _is_removable(
    path: Path,
    removable_links: set[Path],
    native_paths: NativePaths | None = None,
) -> bool:
    absolute = _absolute(path)
    listed = {_absolute(item) for item in removable_links}
    if absolute not in listed:
        return False
    if _is_owned_target(absolute, native_paths):
        return True
    return removable_skill_link(absolute, native_paths=native_paths)


def removable_skill_link(
    path: Path, *, native_paths: NativePaths | None = None
) -> bool:
    """Read-only ownership check for ordinary links this delivery may remove."""
    if not path.is_symlink():
        return False
    current_home = _absolute(
        native_paths.data_home
        if native_paths is not None
        else hub_core._resolve_data_home_path()
    )
    if not current_home.exists():
        return False
    target = Path(os.path.realpath(path))
    return any(_inside(target, current_home / subtree) for subtree in (
        "skills", "sources", "state/skill_variants",
    ))


def _iter_skill_files(root: Path) -> tuple[list[Path], str | None]:
    if not root.exists():
        return [], None
    if not root.is_dir():
        return [], f"opencode skill discovery root is not a directory: {root}"
    files: list[Path] = []
    visited: set[str] = set()

    def walk(directory: Path) -> str | None:
        try:
            real = os.path.realpath(directory)
            if real in visited:
                return None
            visited.add(real)
            entries = list(os.scandir(directory))
        except OSError as exc:
            return f"could not scan opencode skill root {directory}: {exc}"
        for entry in entries:
            path = Path(entry.path)
            try:
                if entry.is_dir(follow_symlinks=True):
                    error = walk(path)
                    if error:
                        return error
                elif entry.name == "SKILL.md" and entry.is_file(follow_symlinks=True):
                    files.append(path)
            except OSError as exc:
                return f"could not inspect discovered skill path {path}: {exc}"
        return None

    error = walk(root)
    return ([], error) if error else (sorted(files), None)


def _same_skill_conflict(
    name: str,
    source_file: Path,
    project_path: Path | None,
    removable_links: set[Path],
    native_paths: NativePaths | None = None,
) -> tuple[str | None, str | None]:
    for root in _skill_roots(project_path, native_paths):
        files, error = _iter_skill_files(root)
        if error:
            return "unknown", error
        for skill_file in files:
            skill_path = _absolute(skill_file)
            if _is_removable(skill_path, removable_links, native_paths) or _is_removable(
                skill_path.parent, removable_links, native_paths
            ):
                continue
            try:
                text = skill_path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc:
                return "unknown", f"could not read discovered skill {skill_path}: {exc}"
            metadata = skill_meta.parse_frontmatter_text(text)
            if metadata is None:
                return "unknown", f"invalid frontmatter in discovered skill {skill_path}"
            declared = metadata.get("name")
            if isinstance(declared, str) and declared.strip() == name:
                return "unsupported", f"skill '{name}' is discoverable at {skill_path}"
    return None, None


def _command_collision(
    name: str,
    project_path: Path | None,
    configs: list[dict[str, Any]],
    removable_links: set[Path],
    native_paths: NativePaths | None = None,
) -> tuple[str | None, str | None]:
    if name in _BUILTIN_COMMANDS:
        return "unsupported", f"'{name}' is reserved by opencode"
    for directory in _visible_command_dirs(project_path, native_paths):
        if not directory.exists():
            continue
        if directory.is_symlink() or directory.parent.is_symlink() or not directory.is_dir():
            return "unknown", f"opencode command directory is not a directory: {directory}"
        for candidate in (directory / name, directory / f"{name}.md"):
            if directory in _command_dirs(project_path, native_paths) and _is_owned_target(
                candidate, native_paths
            ):
                continue
            if _is_removable(candidate, removable_links, native_paths):
                continue
            if candidate.exists() or candidate.is_symlink():
                return "unsupported", f"opencode command '{name}' already exists at {candidate}"
    for config in configs:
        if name in _configured_command_names(config):
            return "unsupported", f"opencode command '{name}' is configured in opencode.json"
    return None, None


def _command_content(name: str, source_file: Path, base_dir: Path) -> str:
    # Keep this template fixed.  In particular, do not interpolate source text
    # into opencode's shell/argument expansion language.
    source_text = _absolute(source_file).as_posix()
    base_text = _absolute(base_dir).as_posix()
    return (
        f"@{source_text}\n"
        "\n"
        f"Base directory for this skill: {base_text}\n"
        f"Relative paths are relative to {base_text}.\n"
        "$ARGUMENTS\n"
    )


def _result(
    *,
    eligible: bool,
    support: str,
    reason_code: str | None,
    reason: str,
    command_path: Path | None,
    content: str | None,
    artifact_path: Path | None = None,
) -> dict[str, Any]:
    return {
        "eligible": eligible,
        "support": support,
        "reason_code": reason_code,
        "reason": reason,
        "command_path": command_path,
        "content": content,
        "artifact_path": artifact_path,
    }


def plan_command(
    name: str,
    source: Path,
    *,
    project_path: Path | None = None,
    target_harnesses: set[str],
    profile: str,
    removable_links: set[Path],
    native_paths: NativePaths | None = None,
) -> dict[str, Any]:
    """Read-only command-only eligibility and desired payload plan."""

    project = _absolute(project_path) if project_path is not None else None
    command_path = None
    if isinstance(name, str) and _SAFE_NAME.fullmatch(name):
        command_path = _command_dirs(project, native_paths)[-1] / f"{name}.md"
    if not isinstance(name, str) or not _SAFE_NAME.fullmatch(name):
        return _result(
            eligible=False,
            support="unknown",
            reason_code="unsafe-command-name",
            reason="opencode command names must be simple path-safe slugs",
            command_path=command_path,
            content=None,
        )
    if target_harnesses != {"opencode"}:
        return _result(
            eligible=False,
            support="unsupported",
            reason_code="opencode-exclusive-target",
            reason="command-only delivery requires opencode to be the exclusive target",
            command_path=command_path,
            content=None,
        )
    if profile != SUPPORTED_PROFILE:
        return _result(
            eligible=False,
            support="unknown",
            reason_code="unknown-profile",
            reason=f"command expansion is only verified for {SUPPORTED_PROFILE}",
            command_path=command_path,
            content=None,
        )
    source_file, base_dir = _source_paths(Path(source))
    if _path_has_unsafe_chars(source_file) or _path_has_unsafe_chars(base_dir):
        return _result(
            eligible=False,
            support="unknown",
            reason_code="unsafe-source-path",
            reason="opencode file references cannot safely represent whitespace, comma, backtick, or dollar paths",
            command_path=command_path,
            content=None,
        )
    try:
        source_text = source_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return _result(
            eligible=False,
            support="unknown",
            reason_code="source-unreadable",
            reason=f"could not read source SKILL.md: {exc}",
            command_path=command_path,
            content=None,
        )
    metadata = skill_meta.parse_frontmatter_text(source_text)
    if metadata is None or str(metadata.get("name") or "").strip() != name:
        return _result(
            eligible=False,
            support="unknown",
            reason_code="source-frontmatter-invalid",
            reason="source SKILL.md must have valid frontmatter declaring the requested name",
            command_path=command_path,
            content=None,
        )
    source_absolute = _absolute(source_file)
    for root in _skill_roots(project, native_paths):
        if _inside(source_absolute, root) or _resolved_inside(source_absolute, root):
            return _result(
                eligible=False,
                support="unsupported",
                reason_code="source-in-discovery-root",
                reason=f"source SKILL.md is inside opencode discovery root {root}",
                command_path=command_path,
                content=None,
            )

    configs, config_error = _read_configs(project, native_paths)
    if config_error:
        return _result(
            eligible=False,
            support="unknown",
            reason_code="config-unreadable",
            reason=config_error,
            command_path=command_path,
            content=None,
        )
    autodiscovered_error = _autodiscovered_risk(project, native_paths)
    if autodiscovered_error:
        return _result(
            eligible=False,
            support="unknown",
            reason_code="autodiscovery-unknown",
            reason=autodiscovered_error,
            command_path=command_path,
            content=None,
        )
    for config in configs:
        risk = _config_risk(config)
        if risk:
            return _result(
                eligible=False,
                support="unknown",
                reason_code="config-discovery-unknown",
                reason=risk,
                command_path=command_path,
                content=None,
            )

    conflict, reason = _same_skill_conflict(
        name, source_absolute, project, removable_links, native_paths
    )
    if conflict:
        return _result(
            eligible=False,
            support=conflict,
            reason_code="skill-discovery-conflict" if conflict == "unsupported" else "discovery-unknown",
            reason=reason or "opencode skill discovery could not be established",
            command_path=command_path,
            content=None,
        )
    conflict, reason = _command_collision(
        name, project, configs, removable_links, native_paths
    )
    if conflict:
        return _result(
            eligible=False,
            support=conflict,
            reason_code=(
                "builtin-command"
                if name in _BUILTIN_COMMANDS
                else "command-collision"
                if conflict == "unsupported"
                else "command-discovery-unknown"
            ),
            reason=reason or "opencode command collision could not be established",
            command_path=command_path,
            content=None,
        )
    for directory in _command_dirs(project, native_paths):
        if directory.is_symlink() or directory.parent.is_symlink():
            return _result(
                eligible=False,
                support="unknown",
                reason_code="command-path-unknown",
                reason=f"opencode command path traverses a symlink: {directory}",
                command_path=command_path,
                content=None,
            )

    content = _command_content(name, source_absolute, base_dir)
    result = _result(
        eligible=True,
        support="enforced",
        reason_code=None,
        reason="opencode command-only delivery is eligible",
        command_path=command_path,
        content=content,
        artifact_path=_artifact_path(name, source_absolute, native_paths),
    )
    result["native_paths"] = native_paths
    return result


def _write_bytes_stable(path: Path, content: bytes) -> int:
    if path.is_symlink():
        raise FileExistsError(f"refusing to replace foreign command artifact: {path}")
    if path.exists() and path.is_file():
        try:
            if path.read_bytes() == content:
                return 0
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return 1


def _replace_link(
    path: Path, target: Path, native_paths: NativePaths | None = None
) -> int:
    if path.is_symlink():
        try:
            if Path(os.path.realpath(path)) == _absolute(target):
                return 0
        except OSError:
            pass
        if not _is_owned_target(path, native_paths):
            raise FileExistsError(f"refusing to replace foreign opencode command: {path}")
    elif path.exists():
        raise FileExistsError(f"refusing to replace foreign opencode command: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        temporary.symlink_to(_absolute(target))
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return 1


def apply_command(plan: Mapping[str, Any]) -> int:
    """Materialize an eligible plan and atomically publish its Hub-owned link."""

    if not plan.get("eligible"):
        return 0
    command_path = plan.get("command_path")
    artifact_path = plan.get("artifact_path")
    content = plan.get("content")
    if not isinstance(command_path, Path) or not isinstance(artifact_path, Path) or not isinstance(content, str):
        raise ValueError("invalid opencode command plan")
    native_paths = plan.get("native_paths")
    if native_paths is not None and not isinstance(native_paths, NativePaths):
        raise ValueError("invalid opencode native path snapshot")
    owned_root = _owned_root(native_paths)
    if owned_root.is_symlink() or not _inside(artifact_path, owned_root):
        raise ValueError("opencode command artifact is outside the Hub-owned root")
    if command_path.exists() and not command_path.is_symlink():
        raise FileExistsError(f"refusing to replace foreign opencode command: {command_path}")
    writes = _write_bytes_stable(artifact_path, content.encode("utf-8"))
    writes += _replace_link(command_path, artifact_path, native_paths)
    return writes


def _owned_command_paths(
    name: str,
    project_path: Path | None,
    native_paths: NativePaths | None = None,
) -> list[Path]:
    return [
        directory / f"{name}.md"
        for directory in _command_dirs(project_path, native_paths)
    ]


def remove_owned_command(
    name: str,
    project_path: Path | None,
    *,
    native_paths: NativePaths | None = None,
) -> int:
    """Remove only this install's command links for ``name``."""

    removed = 0
    for path in _owned_command_paths(name, project_path, native_paths):
        if _is_owned_target(path, native_paths):
            path.unlink()
            removed += 1
    return removed


def owned_command_links(
    project_path: Path | None, *, native_paths: NativePaths | None = None
) -> list[Path]:
    """List this installation's command links in this delivery scope."""
    links = []
    for directory in _command_dirs(project_path, native_paths):
        if directory.is_symlink() or not directory.is_dir():
            continue
        for path in directory.iterdir():
            if path.suffix == ".md" and _is_owned_target(path, native_paths):
                links.append(path)
    return links


def cleanup_commands(
    project_path: Path | None,
    expected: set[str],
    *,
    native_paths: NativePaths | None = None,
) -> int:
    """Remove stale Hub-owned links; leave foreign commands and payloads intact."""
    removed = 0
    for path in owned_command_links(project_path, native_paths=native_paths):
        if path.stem not in expected:
            path.unlink()
            removed += 1
    return removed


def collect_orphan_payloads(
    project_paths: list[Path], *, native_paths: NativePaths | None = None
) -> int:
    """Collect only generated payloads after checking every registered consumer.

    Missing or unreadable project paths may still consume a last-good command
    when mounted again, so uncertainty retains all payloads.
    """
    root = _owned_root(native_paths)
    if root.is_symlink() or not root.is_dir():
        return 0
    live: set[Path] = set()
    try:
        for project in [None, *project_paths]:
            if project is not None and not project.is_dir():
                return 0
            for directory in _command_dirs(project, native_paths):
                if directory.is_symlink():
                    return 0
            live.update(
                link.resolve()
                for link in owned_command_links(project, native_paths=native_paths)
            )
        removed = 0
        for payload in root.iterdir():
            if re.fullmatch(r"[a-f0-9]{64}\.md", payload.name) and payload.is_file() and not payload.is_symlink():
                if payload not in live:
                    payload.unlink()
                    removed += 1
        return removed
    except OSError:
        return 0


__all__ = [
    "NativePaths",
    "SUPPORTED_PROFILE",
    "apply_command",
    "capture_native_paths",
    "cleanup_commands",
    "plan_command",
    "owned_command_links",
    "collect_orphan_payloads",
    "removable_skill_link",
    "remove_owned_command",
]
