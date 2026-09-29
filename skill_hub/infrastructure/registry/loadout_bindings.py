"""Project references and explicit confirmation for headless loadout targets.

This module never connects to a machine. A proposed binding is inactive until
the receiver acknowledges its own verified checkout profile.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterator, Optional

from skill_hub.infrastructure.registry import project_repository

CONNECTOR = "headless-loadouts"


def iter_bindings(registry: dict, project: Optional[str] = None) -> Iterator[tuple[str, str, dict]]:
    remotes = registry.get("remotes")
    if not isinstance(remotes, dict):
        return
    for remote_id, target in remotes.items():
        if not isinstance(target, dict) or target.get("connector") != CONNECTOR:
            continue
        bindings = target.get("project_bindings")
        if not isinstance(bindings, dict):
            continue
        for binding_id, binding in bindings.items():
            if isinstance(binding, dict) and (project is None or binding.get("source_project") == project):
                yield remote_id, binding_id, binding


def source_references(registry: dict, project: str) -> list[dict[str, str]]:
    return [{"remote": remote, "binding": binding} for remote, binding, _ in iter_bindings(registry, project)]


def invalidate_source(registry: dict, project: str, reason: str, *, repository_only: bool = False) -> None:
    for _, _, binding in iter_bindings(registry, project):
        if repository_only and binding.get("mode") != "repository":
            continue
        binding["review_required"] = reason
        binding["confirmation"] = None


def rename_source(registry: dict, old: str, new: str) -> None:
    for _, _, binding in iter_bindings(registry, old):
        binding["source_project"] = new


def source_fingerprint(project: dict) -> str:
    identity = {
        "path": str(Path(project["path"]).expanduser().resolve()),
        "repository": project.get("repository"),
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def inspect_source(project: dict, remote: Optional[str] = None) -> project_repository.RepositoryAssociation:
    saved = project.get("repository")
    if saved is None:
        # A project may predate optional repository metadata.  The caller must
        # select the live remote explicitly when it matters.
        return project_repository.inspect_project_repository(
            Path(project["path"]).expanduser(), remote=remote or "origin"
        ).association
    association = project_repository.validate_repository_association(saved)
    inspected = project_repository.inspect_project_repository(
        Path(project["path"]).expanduser(), remote=association.remote
    )
    if not project_repository.same_repository(association, inspected.association):
        raise project_repository.RepositoryError(
            "The current project checkout does not match its saved repository association.",
            code="source_repository_mismatch",
            field="repository",
        )
    return inspected.association


def validate_portable_metadata(registry: dict) -> None:
    """Refuse unsafe hand-edited repository metadata before backup assembly.

    This is deliberately a validation, not redaction: a backup must not claim
    it faithfully retained a repository identity after silently changing it.
    """
    projects = registry.get("projects") or {}
    if isinstance(projects, dict):
        for project in projects.values():
            if isinstance(project, dict) and "repository" in project:
                project_repository.validate_repository_association(project["repository"])

    def validate_binding(binding):
        if not isinstance(binding, dict):
            raise project_repository.RepositoryError(
                "Invalid repository binding metadata.", code="invalid_repository_metadata"
            )
        for field in ("source_repository", "destination_repository"):
            if field in binding:
                project_repository.validate_repository_association(binding[field])

    remotes = registry.get("remotes") or {}
    if isinstance(remotes, dict):
        for target in remotes.values():
            if not isinstance(target, dict) or target.get("connector") != CONNECTOR:
                continue
            for field in ("project_bindings", "retired_bindings"):
                values = target.get(field, {})
                if not isinstance(values, dict):
                    raise project_repository.RepositoryError(
                        "Invalid repository binding metadata.", code="invalid_repository_metadata"
                    )
                for value in values.values():
                    if field == "retired_bindings":
                        if not isinstance(value, dict) or "binding" not in value:
                            raise project_repository.RepositoryError(
                                "Invalid retired binding metadata.", code="invalid_repository_metadata"
                            )
                        value = value["binding"]
                    validate_binding(value)


def proposed_binding(
    registry: dict,
    *,
    project: str,
    destination_key: str,
    harnesses: list[str],
    destination_repository: Optional[dict] = None,
    source_remote: Optional[str] = None,
    manual: bool = False,
    global_native: Optional[list[str]] = None,
    global_agents: Optional[list[str]] = None,
) -> dict[str, Any]:
    import re

    from skill_hub.infrastructure.harnesses.harnesses import HARNESSES

    if not isinstance(destination_key, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", destination_key):
        raise project_repository.RepositoryError("Invalid destination key.", code="invalid_destination_key")
    cfg = (registry.get("projects") or {}).get(project)
    if not isinstance(cfg, dict):
        raise project_repository.RepositoryError("Unknown source project.", code="unknown_project")
    if manual == (destination_repository is not None):
        raise project_repository.RepositoryError(
            "Choose a repository destination or explicitly choose manual mode.", code="binding_mode_required"
        )
    if not harnesses or any(harness not in HARNESSES for harness in harnesses):
        raise project_repository.RepositoryError(
            "Select at least one known receiver provider.", code="invalid_harnesses"
        )
    result: dict[str, Any] = {
        "source_project": project,
        "destination_key": destination_key,
        "mode": "manual" if manual else "repository",
        "source_fingerprint": source_fingerprint(cfg),
        "confirmation": None,
        "harnesses": sorted(set(harnesses)),
    }
    from skill_hub.domain.loadout.loadout_native_codec import selections

    result.update(
        selections(
            {"global_native": sorted(set(global_native or [])), "global_agents": sorted(set(global_agents or []))}
        )
    )
    if not manual:
        source = inspect_source(cfg, remote=source_remote)
        destination = project_repository.validate_repository_association(destination_repository)
        if not project_repository.same_repository(source, destination):
            raise project_repository.RepositoryError(
                "The destination repository or project subdirectory does not match.",
                code="destination_repository_mismatch",
            )
        result["source_repository"] = asdict(source)
        result["destination_repository"] = asdict(destination)
    return result
