"""Compile selected project skills into a path-free, provider-specific projection.

Uses the local CLI invocation renderer and reports capability limitations.
Source integrity and remote ownership checks remain publication boundaries.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

from skill_hub.application.loadout.loadout_control import validate_source
from skill_hub.application.skills.skill_invocation import render_invocation_document, render_native_invocation
from skill_hub.application.sync.sync_engine import resolve_project_skills
from skill_hub.domain.loadout.loadout_native_codec import LoadoutCodecContext
from skill_hub.domain.loadout.loadout_profiles import ProfileError, binding_digest
from skill_hub.domain.skills.skill_meta import (
    RENAME_VARIANT_MODE,
    skill_affinity,
    skill_invocation,
    skill_rename_patch,
    skill_source,
)
from skill_hub.infrastructure.harnesses.harnesses import HARNESSES
from skill_hub.infrastructure.loadout.loadout_feed import (
    MAX_ASSET,
    MAX_ASSETS,
    MAX_TOTAL,
    asset_digest,
    safe_asset_path,
    validate_projection,
)
from skill_hub.infrastructure.registry.sources import skills_from_disabled_sources


class ProjectionSourceError(ProfileError):
    """Safe, contextual source diagnostics suitable for the controller UI."""


def _linked_asset(file: Path, roots: tuple[Path, ...]) -> int:
    """Open a registered source asset without following links during the read."""
    try:
        resolved = file.resolve(strict=True)
        if '.git' in resolved.parts or not any(resolved.is_relative_to(root) for root in roots):
            raise ValueError()
        directory_fd = os.open(resolved.anchor, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in resolved.parts[1:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                os.close(directory_fd)
                directory_fd = next_fd
            return os.open(resolved.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        finally:
            os.close(directory_fd)
    except (OSError, RuntimeError, ValueError):
        raise ProfileError(
            'unsupported_source', 'File link must resolve to a regular asset in a registered skill source.'
        ) from None


def _skill_tree(
    root: Path, *, require_skill: bool = True, source_roots: tuple[Path, ...] = ()
) -> dict[str, tuple[bytes, int]]:
    if not root.is_dir():
        raise ProfileError("source_missing", "A selected skill source is missing.")
    files: dict[str, tuple[bytes, int]] = {}
    total = 0
    for directory, dirs, names, directory_fd in os.fwalk(root, follow_symlinks=False):
        if len(Path(directory).relative_to(root).parts) > 32:
            raise ProfileError("source_limit", "A skill tree exceeds the directory depth limit.")
        if len(dirs) + len(names) > MAX_ASSETS:
            raise ProfileError("source_limit", "A skill directory contains too many entries.")
        dirs[:] = [name for name in dirs if name != ".git"]
        for name in dirs:
            if stat.S_ISLNK(os.stat(name, dir_fd=directory_fd, follow_symlinks=False).st_mode):
                raise ProfileError(
                    "unsupported_source",
                    f"Directory link {str((Path(directory) / name).relative_to(root))!r} is not supported. "
                    "Use regular skill directories."
                )
        for name in sorted(names):
            if name == '.git':
                continue
            file = Path(directory) / name
            relative = safe_asset_path(file.relative_to(root).as_posix())
            try:
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                fd = (_linked_asset(file, source_roots) if stat.S_ISLNK(info.st_mode)
                      else os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd))
                with os.fdopen(fd, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ASSET:
                        raise ProfileError('unsupported_source', 'Skill assets must be bounded regular files.')
                    content = stream.read(MAX_ASSET + 1)
            except ProfileError as exc:
                raise ProfileError(exc.code, f"Asset {relative!r}: {exc}") from None
            except OSError:
                raise ProfileError('unsupported_source', f"Asset {relative!r} could not be read safely.") from None
            total += len(content)
            if len(content) > MAX_ASSET or total > MAX_TOTAL or len(files) >= MAX_ASSETS:
                raise ProfileError("source_limit", "The selected skill exceeds receiver limits.")
            files[relative] = content, 0o755 if relative.startswith("scripts/") and info.st_mode & 0o100 else 0o644
    if require_skill and "SKILL.md" not in files:
        raise ProfileError("source_missing", "A selected skill has no SKILL.md.")
    return files


def compile_projection(
    registry: dict, target, *, feed_id: str, generation: int, previous: str | None,
    invocation_outcomes: list[dict] | None = None,
    native_limitations: list[dict] | None = None,
    codec_context: LoadoutCodecContext,
) -> tuple[dict, dict]:
    bindings = target.project_bindings
    if not isinstance(bindings, dict) or not bindings:
        raise ProfileError("binding_confirmation_required", "Confirm at least one project checkout before publishing.")
    assets: dict[str, bytes] = {}
    projected = {}
    skills = registry.get("skills") or {}
    source_roots = tuple(
        skill_source(cfg).resolve() for cfg in skills.values()
        if isinstance(cfg, dict) and cfg.get('source')
    )
    disabled = skills_from_disabled_sources(registry)
    for binding_id, binding in bindings.items():
        validate_source(registry, binding)
        digest = binding_digest(binding_id, binding)
        confirmation = binding.get("confirmation")
        if (
            not isinstance(confirmation, dict)
            or confirmation.get("binding_digest") != digest
            or confirmation.get("receiver_id") != target.id
        ):
            raise ProfileError("binding_confirmation_required", "Confirm every selected checkout before publishing.")
        project = registry["projects"][binding["source_project"]]
        files = []
        skill_contents = {}
        selected = list(
            dict.fromkeys(
                resolve_project_skills(project, registry)
                + [
                    name
                    for name, cfg in skills.items()
                    if isinstance(cfg, dict)
                    and cfg.get("type") == "mcp-server"
                    and cfg.get("scope") == "global"
                    and "mcp" in binding.get("global_native", [])
                ]
            )
        )
        for name in selected:
            if name in disabled:
                continue
            if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
                raise ProfileError("invalid_skill", "A selected skill has an invalid name.")
            cfg = skills.get(name)
            if not isinstance(cfg, dict):
                raise ProfileError("source_missing", "A selected skill is missing from the registry.")
            affinity = skill_affinity(cfg)
            providers = set(binding["harnesses"])
            if affinity is not None:
                providers &= affinity
            if not providers:
                continue
            if cfg.get("type") == "mcp-server":
                if not cfg.get("source"):
                    continue
            source = skill_source(cfg)
            try:
                content = _skill_tree(source, require_skill=cfg.get("type") != "mcp-server", source_roots=source_roots)
            except ProfileError as exc:
                raise ProjectionSourceError(
                    exc.code, f"Project {binding['source_project']!r}, skill {name!r}: {exc}"
                ) from None
            skill_contents[name] = content
            renamed = skill_rename_patch(name, cfg) if cfg.get("type") != "mcp-server" else None
            if renamed is not None:
                content["SKILL.md"] = renamed.encode(), 0o644
            mode = skill_invocation(cfg)
            scope = "global" if cfg.get("scope") == "global" else "project"
            if scope != "global":
                mode = (project.get("invocation_overrides") or {}).get(name, mode)
            destination_field = "global_skills_dir" if scope == "global" else "project_skills_dir"
            destination_groups: dict[str, set[str]] = {}
            for provider in providers:
                destination = str(getattr(HARNESSES[provider], destination_field))
                destination_groups.setdefault(destination, set()).add(provider)
            for provider in sorted(providers):
                native = dict(content)
                destination = str(getattr(HARNESSES[provider], destination_field))
                native_files: dict[str, bytes] = {}
                outcomes: list[dict] = []
                if cfg.get("type") != "mcp-server":
                    overridden = scope != "global" and name in (project.get("invocation_overrides") or {})
                    native_files, outcomes = render_native_invocation(
                        name, destination_groups[destination], mode, content.get("agents/openai.yaml", (None, 0))[0],
                        mode_origin="project" if overridden else "library",
                    )
                if invocation_outcomes is not None:
                    invocation_outcomes.extend(
                        {**row, "binding": binding_id} for row in outcomes if row["harness"] == provider
                    )
                if cfg.get("type") != "mcp-server":
                    build_mode = (
                        RENAME_VARIANT_MODE if renamed is not None and mode == "auto" and not overridden else mode
                    )
                    original = content["SKILL.md"][0].decode()
                    if (overridden and mode == skill_invocation(cfg) and renamed is None
                            and "codex" not in destination_groups[destination]):
                        rendered = original
                    else:
                        rendered = render_invocation_document(
                            original, build_mode, renamed=renamed, native_files=native_files,
                            harnesses=destination_groups[destination],
                        )
                    native["SKILL.md"] = rendered.encode(), 0o644
                for relative, payload in native_files.items():
                    native[relative] = payload, 0o644
                for relative, (payload, mode_bits) in sorted(native.items()):
                    sha = asset_digest(payload)
                    assets[sha] = payload
                    files.append(
                        {
                            "scope": scope,
                            "harness": provider,
                            "area": "skills",
                            "name": name,
                            "path": relative,
                            "asset": sha,
                            "mode": mode_bits,
                        }
                    )
        proposal = {key: binding[key] for key in ("destination_key", "source_fingerprint", "harnesses", "mode")}
        if binding["mode"] == "repository":
            proposal.update({key: binding[key] for key in ("source_repository", "destination_repository")})
        from skill_hub.domain.loadout.loadout_native_codec import compile_units, selections

        proposal.update(selections(binding))
        native_units = compile_units(
            registry,
            project,
            binding,
            [n for n in selected if n not in disabled],
            assets,
            skill_contents,
            limitations=native_limitations,
            context=codec_context,
        )
        projected[binding_id] = {"proposal": proposal, "confirmation": confirmation, "files": files}
        if native_units:
            projected[binding_id]["native"] = native_units
    retired = target.retired_bindings or {}
    if not isinstance(retired, dict) or any(
        not isinstance(v, dict) or v.get("disposition") != "retain" for v in retired.values()
    ):
        raise ProfileError("invalid_bindings", "A retired binding must explicitly retain remote files.")
    projection = {
        "schema": 1,
        "feed_id": feed_id,
        "receiver_id": target.id,
        "generation": generation,
        "previous": previous,
        "bindings": projected,
        "retired": {key: "retain" for key in retired},
        "assets": {key: len(value) for key, value in assets.items()},
    }
    if any(record.get("native") for record in projected.values()):
        from skill_hub.domain.loadout.loadout_native_codec import capabilities

        projection["schema"] = 2
        projection["capabilities"] = capabilities(codec_context)["digest"]
        for record in projected.values():
            record.setdefault("native", [])
    validate_projection(projection, assets)
    return projection, assets
