"""SDK-only codecs for Claude Markdown and Codex TOML subagent documents.

The host owns filesystem paths, registry state, validation, and the decision
which Codex skill entries are managed.  This module only parses and renders
native text with the declared pure Python format dependencies.
"""

from __future__ import annotations

import re
from typing import Any, Optional

import yaml  # type: ignore[import-untyped]

from skill_hub.domain.harnesses.harness_adapter_api import (
    CodexRenderInput,
    NativeAgentCodec,
    NativeAgentDocument,
    thaw_native_value,
)

_FRONTMATTER_ORDER = (
    "name", "description", "model", "tools", "disallowedTools", "skills", "color",
)
_CODEX_MODELED_KEYS = frozenset({
    "name", "description", "developer_instructions", "model",
    "model_reasoning_effort", "sandbox_mode", "nickname_candidates", "skills",
})


class ParseError(Exception):
    """Raised when a Claude frontmatter fence cannot be read."""


def thaw_agent_value(value: Any) -> Any:
    """Restore native mapping keys and container shapes at the host boundary."""
    return thaw_native_value(value)


def _split_frontmatter(text: str) -> tuple[str, str]:
    lines = text.splitlines(keepends=True)
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if i >= len(lines) or lines[i].strip() != "---":
        raise ParseError("missing frontmatter fence")
    start = i + 1
    for j in range(start, len(lines)):
        if lines[j].strip() == "---":
            return "".join(lines[start:j]), "".join(lines[j + 1:])
    raise ParseError("incomplete frontmatter fence")


def _lenient_frontmatter(fm_text: str) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    key_re = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t](.*))?$")
    current: Optional[str] = None
    for raw in fm_text.splitlines():
        match = key_re.match(raw)
        if match and not raw.startswith((" ", "\t", "-")):
            current = match.group(1)
            meta[current] = match.group(2) if match.group(2) is not None else ""
        elif current is not None:
            meta[current] = (str(meta[current]) + "\n" + raw).strip("\n")
    return meta


def parse_claude_agent(text: str) -> NativeAgentDocument:
    fm_text, body = _split_frontmatter(text)
    try:
        metadata = yaml.safe_load(fm_text)
        if metadata is None:
            metadata = {}
        if not isinstance(metadata, dict):
            raise ParseError("frontmatter is not a mapping")
    except yaml.YAMLError:
        metadata = _lenient_frontmatter(fm_text)
        if not metadata:
            raise ParseError("frontmatter is empty or unparseable")
    return NativeAgentDocument(frontmatter=metadata, body=body, raw_text=text)


def serialize_claude_agent(frontmatter: dict[str, Any], body: str) -> str:
    ordered: dict[str, Any] = {}
    for key in _FRONTMATTER_ORDER:
        if key in frontmatter:
            ordered[key] = frontmatter[key]
    for key, value in frontmatter.items():
        if key not in ordered:
            ordered[key] = value
    dumped = yaml.safe_dump(
        ordered, sort_keys=False, allow_unicode=True, default_flow_style=False, width=4096,
    )
    return f"---\n{dumped}---\n{body}"


def normalize_body(body: str) -> str:
    return body + "\n" if body and not body.endswith("\n") else body


def _tomlkit() -> Any:
    import tomlkit
    return tomlkit


def parse_codex_agent(text: str) -> NativeAgentDocument:
    tomlkit = _tomlkit()
    try:
        document = tomlkit.parse(text)
    except Exception as exc:
        raise ValueError(f"invalid TOML: {exc}") from exc
    data = document.unwrap()
    if not isinstance(data, dict):
        raise ValueError("agent TOML is not a table")
    frontmatter: dict[str, Any] = {}
    for key in ("name", "description", "model", "model_reasoning_effort",
                "sandbox_mode", "nickname_candidates"):
        if key in data:
            frontmatter[key] = data[key]
    for key, value in data.items():
        if key not in _CODEX_MODELED_KEYS:
            frontmatter[key] = value
    skills = data.get("skills")
    native_skills: tuple[Any, ...] = ()
    if isinstance(skills, dict) and isinstance(skills.get("config"), list):
        native_skills = tuple(skills["config"])
    return NativeAgentDocument(
        frontmatter=frontmatter, body="" if data.get("developer_instructions") is None
        else str(data["developer_instructions"]), raw_text=text, native_skills=native_skills,
    )


def advanced_codex_fragment(text: str) -> str:
    tomlkit = _tomlkit()
    try:
        document = tomlkit.parse(text)
    except Exception as exc:
        raise ValueError(f"invalid TOML: {exc}") from exc
    output = tomlkit.document()
    for key in list(document.keys()):
        if key not in _CODEX_MODELED_KEYS:
            output[key] = document[key]
    dumped = tomlkit.dumps(output)
    return dumped if dumped.strip() else ""


def _render_managed_skills(tomlkit: Any, document: Any, request: CodexRenderInput) -> None:
    """Replace host-selected managed entries while retaining all other nodes."""
    skills_table = document.get("skills") if "skills" in document else None
    original = (
        list(skills_table["config"])
        if skills_table is not None and "config" in skills_table
        else []
    )
    selected = set(request.managed_skill_indices)
    if any(index < 0 or index >= len(original) for index in selected):
        raise ValueError("managed skill index is outside the native config")

    replacements = iter(request.replacement_skill_paths)
    replacement_by_index: dict[int, str] = {}
    for index in sorted(selected):
        try:
            replacement_by_index[index] = next(replacements)
        except StopIteration:
            break
    remaining = list(replacements)
    output = tomlkit.aot()
    for index, item in enumerate(original):
        if index not in selected:
            output.append(item)
            continue
        replacement = replacement_by_index.get(index)
        if replacement is None:
            continue
        table = tomlkit.table()
        table["path"] = replacement
        table["enabled"] = True
        output.append(table)
    for replacement in remaining:
        table = tomlkit.table()
        table["path"] = replacement
        table["enabled"] = True
        output.append(table)

    if output:
        if skills_table is None:
            document["skills"] = tomlkit.table()
            skills_table = document["skills"]
        skills_table["config"] = output
    elif skills_table is not None:
        if "config" in skills_table:
            del skills_table["config"]
        if len(list(skills_table.keys())) == 0:
            del document["skills"]


def render_codex_agent(request: CodexRenderInput) -> str:
    tomlkit = _tomlkit()
    document = tomlkit.parse(request.existing_text) if request.existing_text else tomlkit.document()
    frontmatter = request.frontmatter
    document["name"] = str(frontmatter.get("name") or "").strip()
    description = frontmatter.get("description")
    document["description"] = "" if description is None else str(description)

    body = request.body or ""
    if "\n" in body:
        try:
            document["developer_instructions"] = tomlkit.string(body, multiline=True)
        except Exception:
            document["developer_instructions"] = body
    else:
        document["developer_instructions"] = body

    for key in ("model", "model_reasoning_effort", "sandbox_mode"):
        value = str(frontmatter.get(key) or "").strip()
        if value:
            document[key] = value
        elif key in document:
            del document[key]
    nicknames = [
        str(item) for item in (frontmatter.get("nickname_candidates") or [])
        if str(item).strip()
    ]
    if nicknames:
        document["nickname_candidates"] = nicknames
    elif "nickname_candidates" in document:
        del document["nickname_candidates"]

    _render_managed_skills(tomlkit, document, request)

    submitted = request.advanced_toml or ""
    try:
        current = advanced_codex_fragment(tomlkit.dumps(document))
    except ValueError:
        current = ""
    if submitted.strip() != current.strip():
        advanced = tomlkit.parse(submitted) if submitted.strip() else tomlkit.document()
        for key in [key for key in list(document.keys()) if key not in _CODEX_MODELED_KEYS]:
            if key not in advanced:
                del document[key]
        for key in advanced.keys():
            if key not in _CODEX_MODELED_KEYS:
                document[key] = advanced[key]
    return tomlkit.dumps(document)


class ClaudeAgentCodec:
    def parse(self, text: str) -> NativeAgentDocument:
        return parse_claude_agent(text)

    def advanced_fragment(self, text: str) -> str:
        return ""

    def render(self, request: CodexRenderInput) -> str:
        return serialize_claude_agent(thaw_agent_value(request.frontmatter), request.body)


class CodexAgentCodec:
    def parse(self, text: str) -> NativeAgentDocument:
        return parse_codex_agent(text)

    def advanced_fragment(self, text: str) -> str:
        return advanced_codex_fragment(text)

    def render(self, request: CodexRenderInput) -> str:
        return render_codex_agent(request)


# Naming aliases keep the small codec facade consistent with the other
# bundled native codecs while leaving one implementation per format.
ClaudeSubagentCodec = ClaudeAgentCodec
CodexSubagentCodec = CodexAgentCodec


_CODECS: dict[str, NativeAgentCodec] = {
    "claude-code": ClaudeAgentCodec(),
    "codex": CodexAgentCodec(),
}


def bundled_agent_codec(harness_id: str) -> NativeAgentCodec:
    try:
        return _CODECS[harness_id]
    except KeyError as exc:
        raise ValueError(f"unknown subagent harness: {harness_id!r}") from exc


def agent_codec(harness_id: str) -> Optional[NativeAgentCodec]:
    return _CODECS.get(harness_id)


bundled_subagent_codec = bundled_agent_codec
subagent_codec = agent_codec
bundled_codec = bundled_agent_codec


__all__ = [
    "ClaudeAgentCodec", "ClaudeSubagentCodec", "CodexAgentCodec",
    "CodexSubagentCodec", "ParseError", "agent_codec",
    "advanced_codex_fragment", "bundled_agent_codec", "normalize_body",
    "parse_claude_agent", "parse_codex_agent", "render_codex_agent",
    "serialize_claude_agent", "bundled_subagent_codec", "subagent_codec", "bundled_codec",
    "thaw_agent_value",
]
