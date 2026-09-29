"""Restore pre-native invocation links before installing an older Hub version.

Run with this version still installed. The default only describes changes;
--apply replaces this installation's links without changing selected modes.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skill_hub.application.skills import skill_variants as variants  # noqa: E402
from skill_hub.application.skills.import_scanner import _read_registry_optional  # noqa: E402
from skill_hub.domain.skills.skill_meta import render_invocation_frontmatter, skill_invocation  # noqa: E402
from skill_hub.infrastructure.filesystem.sync_links import is_hub_owned_link  # noqa: E402
from skill_hub.infrastructure.harnesses import (
    harnesses,  # noqa: E402
    opencode_invocation,  # noqa: E402
)


def reconcile(registry: dict, *, apply: bool = False) -> dict:
    """Reconcile extant consumers only; never equip a new skill or edit intent."""
    result: dict = {"applied": apply, "links": [], "commands": [], "errors": []}
    scopes = [(None, None, {})] + [
        (name, Path(cfg["path"]), cfg)
        for name, cfg in registry.get("projects", {}).items() if cfg.get("path")
    ]
    for project, project_path, project_cfg in scopes:
        directories = {
            (Path(str(h.global_skills_dir)).expanduser() if project_path is None
             else project_path / str(h.project_skills_dir))
            for h in harnesses.HARNESSES.values()
        }
        try:
            commands = opencode_invocation.owned_command_links(project_path)
        except OSError as exc:
            result["errors"].append(str(exc))
            continue
        for name, cfg in registry.get("skills", {}).items():
            if cfg.get("type") == "mcp-server":
                continue
            links = [directory / name for directory in directories
                     if not directory.is_symlink() and is_hub_owned_link(directory / name)]
            command_links = [path for path in commands if path.stem == name]
            if command_links:
                h = harnesses.HARNESSES["opencode"]
                link = (Path(str(h.global_skills_dir)).expanduser() if project_path is None
                        else project_path / str(h.project_skills_dir)) / name
                if link not in links:
                    if link.exists() or link.is_symlink() or link.parent.is_symlink():
                        result["errors"].append(f"cannot restore owned command over foreign skill: {link}")
                        continue
                    links.append(link)
            if not links:
                continue
            try:
                source = variants.skill_source(cfg)
                original = (source / "SKILL.md").read_text()
                renamed = variants.skill_rename_patch(name, cfg)
                override = None if cfg.get("scope") == "global" else (
                    project_cfg.get("invocation_overrides") or {}).get(name)
                mode = override or skill_invocation(cfg)
                target = source
                # The predecessor derives project overrides and source renames.
                # Library flags already live in source and remain untouched.
                if override or renamed is not None:
                    variant_mode = override or variants.RENAME_VARIANT_MODE
                    body = renamed if renamed is not None else original
                    if override:
                        body = render_invocation_frontmatter(body, mode, generated_marker=True)
                        if body is None:
                            raise ValueError(f"invalid source frontmatter: {source}")
                    target = variants.skill_variants_root() / f"{name}@{variant_mode}"
                    if apply:
                        target, _ = variants._write_skill_variant(name, source, variant_mode, body)
                for link in links:
                    result["links"].append({"link": str(link), "target": str(target), "project": project})
                    if apply:
                        variants._publish_skill_link(link, target)
                for command in command_links:
                    result["commands"].append(str(command))
                    if apply:
                        command.unlink()
            except (OSError, ValueError) as exc:
                result["errors"].append(f"{project or 'global'}/{name}: {exc}")
    if apply and not result["errors"]:
        variants._cleanup_variant_orphans(registry)
        opencode_invocation.collect_orphan_payloads([
            path for _, path, _ in scopes if path is not None
        ])
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    report = reconcile(_read_registry_optional(), apply=args.apply)
    print(json.dumps(report, indent=2))
    raise SystemExit(1 if report["errors"] else 0)
