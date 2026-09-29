"""Host-owned, transient enrichment for native Usage capture batches."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from pathlib import Path

from skill_hub import hub_core
from skill_hub.domain.usage import usage_classify
from skill_hub.domain.usage.usage_inspection_capture import CaptureBatch, SummaryEventSeedInput, stable_id
from skill_hub.infrastructure.harnesses import harnesses


@dataclass(frozen=True)
class CaptureEnrichmentContext:
    registry: dict
    project_roots: tuple[tuple[str, Path], ...] = ()
    skill_roots: tuple[Path, ...] = ()
    extra_verify: tuple[str, ...] = ()

    @classmethod
    def empty(cls) -> "CaptureEnrichmentContext":
        return cls({})

    @classmethod
    def from_registry(cls, registry: dict) -> "CaptureEnrichmentContext":
        projects = registry.get("projects") if isinstance(registry, dict) else {}
        roots = []
        if isinstance(projects, dict):
            for key, value in projects.items():
                path = value.get("path") if isinstance(value, dict) else None
                if isinstance(key, str) and isinstance(path, str):
                    roots.append((key, Path(path)))
        skills = registry.get("skills") if isinstance(registry, dict) else {}
        skill_roots = []
        for _name, value in projects.items() if isinstance(projects, dict) else ():
            path = value.get("path") if isinstance(value, dict) else None
            if isinstance(path, str):
                for harness in harnesses.HARNESSES.values():
                    skill_roots.append(Path(path) / harness.project_skills_dir)
        for harness in harnesses.HARNESSES.values():
            skill_roots.append(Path(str(harness.global_skills_dir)).expanduser())
        skill_roots.extend((hub_core.data_home() / "skills", hub_core.data_home() / "mcp-servers"))
        # Snapshot only the classification inputs: the caller may reload the registry.
        frozen = json.loads(json.dumps(registry, sort_keys=True, default=str))
        return cls(frozen, tuple(roots), tuple(skill_roots))

    def digest(self) -> str:
        """Hash only host facts that affect project or skill classification."""
        projects = self.registry.get("projects") if isinstance(self.registry, dict) else {}
        project_facts = {
            str(name): {"path": value.get("path"), "analytics": value.get("analytics")}
            for name, value in (projects.items() if isinstance(projects, dict) else ())
            if isinstance(value, dict)
        }
        skills = self.registry.get("skills") if isinstance(self.registry, dict) else {}
        facts = {"projects": project_facts, "skills": skills if isinstance(skills, dict) else {}}
        encoded = json.dumps(facts, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _arguments(batch_part_bytes: bytes | None) -> dict:
    if not batch_part_bytes:
        return {}
    try:
        value = json.loads(batch_part_bytes)
    except (TypeError, ValueError):
        return {"command": batch_part_bytes.decode("utf-8", "replace")[:16384]}
    return value if isinstance(value, dict) else {}


def _safe_native_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lstrip("/")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", cleaned):
        return None
    return cleaned


def _path_hash(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return "path:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def enrich_capture_batch(batch: CaptureBatch, context: CaptureEnrichmentContext) -> CaptureBatch:
    """Classify transient tool arguments and redact excerpts before persistence."""
    # Classify Codex user text before redaction/truncation, then discard it.
    message_skill_facts = {
        message.message_id: usage_classify.text_skill_mentions(
            message.excerpt_hint or message.excerpt, context.registry
        )
        for message in batch.messages
        if message.native_kind == "user_message"
    }
    messages = tuple(
        replace(
            message,
            excerpt=usage_classify.redact_excerpt(
                re.sub(r"(?:~|/)[^\s]+", "[path]", message.excerpt_hint or message.excerpt)
                if batch.root.harness == "codex" else message.excerpt_hint or message.excerpt
            ),
            excerpt_hint=None,
            slash_command=_safe_native_name(message.slash_command),
        )
        for message in batch.messages
    )
    tools = []
    seeds = [replace(seed, text_hint=None) for seed in batch.event_seeds if seed.kind != "skill_text"]
    for seed in batch.event_seeds:
        if seed.kind != "skill_text":
            continue
        seed_mentions = usage_classify.text_skill_mentions(seed.text_hint or "", context.registry)
        if seed_mentions.mention_count:
            seeds.append(replace(
                seed, event_id="seed:" + stable_id(seed.event_id, "count"),
                kind="skill_mentions", count=seed_mentions.mention_count, text_hint=None,
            ))
        for index, key in enumerate(seed_mentions.registered_keys):
            seeds.append(replace(
                seed, event_id="seed:" + stable_id(seed.event_id, key), kind="skill",
                name=key, role_ordinal=index + 1, additive=True, text_hint=None,
            ))
    # Codex legacy calls `_add_skills` only for user messages; Claude does not.
    for message in messages:
        facts = message_skill_facts.get(message.message_id)
        if facts is None:
            continue
        if facts.mention_count:
            seeds.append(
                SummaryEventSeedInput(
                    "seed:" + stable_id(message.message_id, "skill-count"),
                    message.run_id,
                    message.source_epoch,
                    message.source_ordinal,
                    message.block_ordinal,
                    message.role_ordinal,
                    message.at,
                    "skill_mentions",
                    None,
                    "user",
                    None,
                    message.message_id,
                    additive=True,
                    count=facts.mention_count,
                )
            )
        for index, key in enumerate(facts.registered_keys):
            seeds.append(
                SummaryEventSeedInput(
                    "seed:" + stable_id(message.message_id, "skill", key),
                    message.run_id,
                    message.source_epoch,
                    message.source_ordinal,
                    message.block_ordinal,
                    message.role_ordinal + index + 1,
                    message.at,
                    "skill",
                    key,
                    "user",
                    None,
                    message.message_id,
                    additive=True,
                )
            )
    for tool in batch.tool_calls:
        args = _arguments(tool.input_parts[0].bytes_value if tool.input_parts else None)
        classifier_names = {"shell_command": "Bash", "exec_command": "Bash", "bash": "Bash", "shell": "Bash"}
        classifier_name = classifier_names.get(tool.tool_name, tool.tool_name)
        if classifier_name == "Bash" and "command" not in args:
            command = args.get("cmd") or args.get("input")
            if isinstance(command, str):
                args = {**args, "command": command}
        hint = batch.source.working_directory_hint
        project = usage_classify.match_project(hint, list(context.project_roots)) if isinstance(hint, str) else None
        project_config = (context.registry.get("projects") or {}).get(project, {}) if project else {}
        analytics = project_config.get("analytics") if isinstance(project_config, dict) else {}
        prefixes = analytics.get("verify_prefixes") if isinstance(analytics, dict) else ()
        project_verify = tuple(value for value in (prefixes or ()) if isinstance(value, str))
        activity = usage_classify.classify_tool(
            classifier_name, args, extra_verify=(*context.extra_verify, *project_verify)
        )
        if batch.source.harness == "codex" and classifier_name == "Bash":
            command = args.get("command")
            command_facts = (
                usage_classify.text_skill_mentions(command, context.registry) if isinstance(command, str) else None
            )
            if command_facts and command_facts.mention_count:
                seeds.append(
                    SummaryEventSeedInput(
                        "seed:" + stable_id(batch.source.generation_id, tool.call_id, "skill-count"),
                        tool.run_id,
                        batch.source.generation_id,
                        tool.source_ordinal,
                        tool.block_ordinal,
                        tool.role_ordinal,
                        tool.at,
                        "skill_mentions",
                        None,
                        "model",
                        tool.native_call_id,
                        additive=True,
                        count=command_facts.mention_count,
                    )
                )
            if command_facts:
                for index, key in enumerate(command_facts.registered_keys):
                    seeds.append(
                        SummaryEventSeedInput(
                            "seed:" + stable_id(batch.source.generation_id, tool.call_id, "skill", key),
                            tool.run_id,
                            batch.source.generation_id,
                            tool.source_ordinal,
                            tool.block_ordinal,
                            tool.role_ordinal + index + 1,
                            tool.at,
                            "skill",
                            key,
                            "model",
                            tool.native_call_id,
                            additive=True,
                        )
                    )
        skill_key = None
        origin = None
        if tool.tool_name == "Skill":
            value = args.get("skill")
            skill_key = _safe_native_name(value)
            origin = "model" if skill_key else None
        elif tool.tool_name == "SlashCommand":
            value = args.get("command") or args.get("name")
            skill_key = _safe_native_name(value)
            origin = "model" if skill_key else None
        elif tool.tool_name in {"Bash", "bash", "shell"} and isinstance(args.get("command"), str):
            skill_key = usage_classify.script_skill_key(args["command"], context.registry, list(context.skill_roots))
            origin = "script" if skill_key else None
        mcp_server = mcp_tool = None
        match = re.fullmatch(
            r"mcp__([A-Za-z0-9][A-Za-z0-9_.-]{0,63})__([A-Za-z0-9][A-Za-z0-9_.-]{0,63})", tool.tool_name
        )
        if match:
            mcp_server, mcp_tool = match.groups()
        if tool.tool_name == "Agent":
            child_kind = _safe_native_name(args.get("subagent_type") or args.get("agent_type"))
            seeds.append(
                SummaryEventSeedInput(
                    "seed:" + stable_id(batch.source.generation_id, tool.call_id, "child"),
                    tool.run_id,
                    batch.source.generation_id,
                    tool.source_ordinal,
                    tool.block_ordinal,
                    tool.role_ordinal,
                    tool.at,
                    "child_invocation",
                    child_kind,
                    "model",
                    tool.native_call_id,
                )
            )
        if skill_key or mcp_server:
            name = skill_key or f"{mcp_server}/{mcp_tool}"
            seeds.append(
                SummaryEventSeedInput(
                    "seed:" + stable_id(batch.source.generation_id, tool.call_id, name),
                    tool.run_id,
                    batch.source.generation_id,
                    tool.source_ordinal,
                    tool.block_ordinal,
                    tool.role_ordinal,
                    tool.at,
                    "script" if origin == "script" else ("skill" if skill_key else "tool"),
                    name,
                    origin or "model",
                    tool.native_call_id,
                    additive=bool(mcp_server),
                )
            )
        path = args.get("file_path") or args.get("path")
        tools.append(
            replace(
                tool,
                activity_class=activity,
                skill_key=skill_key,
                invocation_origin=origin,
                read_file_hash=_path_hash(path) if activity == "read" and path else tool.read_file_hash,
                edit_file_hash=_path_hash(path) if activity == "edit" and path else tool.edit_file_hash,
                mcp_server=mcp_server,
                mcp_tool=mcp_tool,
            )
        )
    hint = batch.source.working_directory_hint
    project = usage_classify.match_project(hint, list(context.project_roots)) if isinstance(hint, str) else None
    source = replace(
        batch.source,
        project_key=project,
        project_attribution="matched" if project else ("unregistered" if hint else "unavailable"),
        working_directory_hint=None,
    )
    return replace(batch, source=source, messages=messages, tool_calls=tuple(tools), event_seeds=tuple(seeds))
