"""Closed portable native payloads and receiver-derived provider destinations."""

from __future__ import annotations

import copy
import os
import re
import shlex
import shutil
import stat
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, NoReturn
from urllib.parse import urlsplit

from skill_hub.domain.harnesses.harness_adapter_api import CatalogSnapshot
from skill_hub.domain.loadout.loadout_profiles import ProfileError, canonical, strict_json
from skill_hub.infrastructure.loadout.loadout_native import MAX_DOCUMENT, DocumentOp, digest

AREAS = {"mcp", "permissions", "hooks", "agents"}
PROVIDERS = {"claude-code", "codex"}
CAPABILITIES = {
    "schema": 2,
    "codecs": ["agents:1", "hooks:1", "mcp:1", "permissions:1"],
    # Keep the payload codecs stable while forcing receivers to acknowledge
    # changed native rendering semantics.
    "native_semantics": 4,
}

MAX_LIMITATIONS = 256


def _freeze_context_value(value: Any) -> Any:
    """Freeze JSON-shaped capability/provenance observations at capture time."""
    if isinstance(value, Mapping):
        return MappingProxyType({str(key): _freeze_context_value(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_context_value(item) for item in value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError("loadout codec observations must contain JSON values")


def _thaw_context_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _thaw_context_value(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw_context_value(item) for item in value]
    return value


@dataclass(frozen=True)
class LoadoutCodecContext:
    """One immutable composition of the native codecs used by a loadout."""

    mcp: dict[str, Any] = field(default_factory=dict)
    hooks: dict[str, Any] = field(default_factory=dict)
    permissions: dict[str, Any] = field(default_factory=dict)
    permission_patterns: dict[str, Any] = field(default_factory=dict)
    agents: dict[str, Any] = field(default_factory=dict)
    capability: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)
    catalog: Any = None

    def __post_init__(self) -> None:
        for name in ("mcp", "hooks", "permissions", "permission_patterns", "agents"):
            object.__setattr__(self, name, MappingProxyType(dict(getattr(self, name))))
        object.__setattr__(self, "capability", _freeze_context_value(dict(self.capability)))
        object.__setattr__(self, "provenance", _freeze_context_value(dict(self.provenance)))

    def codec(self, area: str, provider: str) -> Any:
        table = {
            "mcp": self.mcp,
            "hooks": self.hooks,
            "permissions": self.permissions,
            "permission_patterns": self.permission_patterns,
            "agents": self.agents,
        }.get(area)
        if table is None:
            raise KeyError(area)
        adapter_key = "claude" if provider == "claude-code" else provider
        codec = table.get(provider, table.get(adapter_key))
        if codec is None:
            fail(f"No captured {area} codec is available for {provider}.", "loadout_adapter_binding_required")
        return codec

    @property
    def mcp_codecs(self):
        return self.mcp

    @property
    def hook_codecs(self):
        return self.hooks

    @property
    def permission_codecs(self):
        return self.permissions

    @property
    def permission_pattern_codecs(self):
        return self.permission_patterns

    @property
    def agent_codecs(self):
        return self.agents


def capture_loadout_codec_context(
    *,
    mcp: dict[str, Any] | None = None,
    hooks: dict[str, Any] | None = None,
    permissions: dict[str, Any] | None = None,
    permission_patterns: dict[str, Any] | None = None,
    agents: dict[str, Any] | None = None,
    capability: dict[str, Any] | None = None,
    provenance: dict[str, Any] | None = None,
    catalog: CatalogSnapshot | None = None,
) -> LoadoutCodecContext:
    """Capture the bundled SDK codecs once at a loadout operation boundary."""
    from skill_hub.domain.harnesses.harness_catalog import bundled_catalog

    captured_catalog = bundled_catalog() if catalog is None else catalog
    # Check the typed, active catalog before importing or constructing any
    # bundled codecs. An active loadout declaration requires a separately
    # bound adapter package at the composition boundary.
    _reject_unbound_loadout_features(captured_catalog)

    from skill_hub.infrastructure.harnesses.harness_bundled_hooks import bundled_codec as bundled_hook_codec
    from skill_hub.infrastructure.harnesses.harness_bundled_mcp import bundled_codec as bundled_mcp_codec
    from skill_hub.infrastructure.harnesses.harness_bundled_permissions import (
        bundled_pattern_codec,
        bundled_permission_codec,
    )
    from skill_hub.infrastructure.harnesses.harness_bundled_subagents import bundled_agent_codec

    context = LoadoutCodecContext(
        mcp=({
            "claude-code": bundled_mcp_codec("claude"),
            "codex": bundled_mcp_codec("codex"),
        } if mcp is None else mcp),
        hooks=({
            "claude-code": bundled_hook_codec("claude-code"),
            "codex": bundled_hook_codec("codex"),
        } if hooks is None else hooks),
        permissions=(
            {"codex": bundled_permission_codec("codex")} if permissions is None else permissions
        ),
        permission_patterns=(
            {"claude-code": bundled_pattern_codec("claude")}
            if permission_patterns is None else permission_patterns
        ),
        agents=({
            "claude-code": bundled_agent_codec("claude-code"),
            "codex": bundled_agent_codec("codex"),
        } if agents is None else agents),
        capability=(CAPABILITIES if capability is None else capability),
        provenance=(
            {"source": "bundled", "native_semantics": CAPABILITIES["native_semantics"]}
            if provenance is None else provenance
        ),
        catalog=captured_catalog,
    )
    return context


def _reject_unbound_loadout_features(catalog: CatalogSnapshot) -> None:
    """Reject active manifest declarations that need a selectable loadout adapter."""
    names = {"loadout_mcp", "loadout_permissions", "loadout_hooks", "loadout_agents"}
    for manifest in catalog.active_manifests:
        for variant in manifest.variants:
            if any(variant.features.get(name) in {"verified", "unverified"} for name in names):
                fail("A selectable loadout feature has no bound adapter package.", "loadout_adapter_binding_required")


def _limitation(
    collector: list[dict] | None,
    *,
    area: str,
    harness: str,
    name: str,
    message: str,
    binding: str | None = None,
    risk: str | None = None,
) -> None:
    if collector is None or len(collector) >= MAX_LIMITATIONS:
        return
    row = {"area": area, "harness": harness, "name": name, "message": message}
    if binding is not None:
        row["binding"] = binding
    if risk is not None:
        row["risk"] = risk
    collector.append(row)


def capabilities(context: LoadoutCodecContext) -> dict:
    """Return the captured capability identity for a loadout operation."""
    capability = _thaw_context_value(context.capability)
    return {**capability, "digest": digest(capability)}


class NativeConfigurationError(ProfileError):
    """Curated native validation message, safe for controller receipts."""


def fail(message: str, code="unsupported_loadout_requirement") -> NoReturn:
    raise NativeConfigurationError(code, message)


def slug(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
        fail("Native names must be slugs.", "native_invalid")
    return value


def agent_name(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,127}", value):
        fail("Invalid native agent name.", "native_invalid")
    return value


def selections(binding: dict) -> dict:
    result = {}
    for key, allowed in [("global_native", AREAS), ("global_agents", None)]:
        value = binding.get(key, [])
        if (
            not isinstance(value, list)
            or any(not isinstance(x, str) for x in value)
            or value != sorted(set(value))
            or len(value) > 256
        ):
            fail("Global selections must be sorted unique names.", "invalid_binding")
        for name in value:
            if allowed is not None and name not in allowed:
                fail("Unknown global native category.", "invalid_binding")
            if allowed is None:
                agent_name(name)
        if value:
            result[key] = value
    if ("agents" in result.get("global_native", [])) != bool(result.get("global_agents")):
        fail("Select explicit global agent names with the agents category.", "invalid_binding")
    return result


def read_source(path: Path) -> bytes:
    """Read bounded regular source files; never follow their final symlink."""
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DOCUMENT:
            raise ValueError()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            data = stream.read(MAX_DOCUMENT + 1)
        if len(data) > MAX_DOCUMENT:
            raise ValueError()
        return data
    except (OSError, ValueError):
        fail("A native source is missing, linked, or too large.", "native_source_invalid")


def _strings(value, maximum=256):
    if (
        not isinstance(value, list)
        or len(value) > maximum
        or any(not isinstance(x, str) or len(x) > 8192 or "\x00" in x for x in value)
    ):
        fail("Invalid native string list.", "native_invalid")


def _portable(value):
    if isinstance(value, str) and (
        value in {"/", "~/"}
        or re.search(r"(?:^|[\s=])(?:/|~/|[A-Za-z]:\\)(?=[\w.~])", value)
        or "/Users/" in value
        or "/home/" in value
        or "\x00" in value
    ):
        fail("Replace controller paths with portable references.", "native_unportable_path")
    if isinstance(value, (list, tuple)):
        for item in value:
            _portable(item)
    if isinstance(value, dict):
        for item in value.values():
            _portable(item)


def _portable_source(text: str) -> None:
    _portable(text)
    # Source is reviewed code, but literal credential assignments are never portable.
    pattern = r"(?im)\b([A-Z_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)[A-Z_]*)\s*[=:]\s*([^\n]+)"
    for match in re.finditer(pattern, text):
        value = match.group(2).strip().strip("\"'")
        if (
            value
            and "$" not in value
            and not value.startswith(("os.environ", "os.getenv", "process.env", "None", "null"))
        ):
            fail("Use receiver environment references instead of literal credentials.", "native_secret")


def _metadata_credentials(value: Any, key: str = "") -> None:
    from skill_hub.domain.mcp.mcp_spec import looks_like_secret

    if isinstance(value, dict):
        for field, item in value.items():
            _metadata_credentials(item, str(field))
    elif isinstance(value, list):
        for item in value:
            _metadata_credentials(item, key)
    elif looks_like_secret(key, value):
        fail("Agent credentials must use environment references.", "native_secret")


def validate_payload(area: str, payload: Any) -> dict:
    fields = {
        "mcp": {"version", "spec"},
        "permissions": {"version", "allow", "deny", "ask", "sandbox_mode", "approval_policy", "project_trust"},
        "hooks": {"version", "event", "matcher", "timeout", "interpreter", "args", "script"},
        "agents": {"version", "frontmatter", "body"},
    }
    if (
        area not in fields
        or not isinstance(payload, dict)
        or (
            set(payload) != fields[area]
            and not (area == "permissions" and set(payload) == fields[area] - {"project_trust"})
        )
        or type(payload.get("version")) is not int
        or payload["version"] != 1
        or len(canonical(payload)) > MAX_DOCUMENT
    ):
        fail("Invalid native payload codec.", "native_invalid")
    if area == "mcp":
        from skill_hub.domain.mcp.mcp_spec import McpServerSpec, secret_keys_in_spec

        spec = payload["spec"]
        if not isinstance(spec, dict) or set(spec) != set(asdict(McpServerSpec("name"))):
            fail("Invalid MCP spec.", "native_invalid")
        slug(spec["name"])
        if spec["transport"] not in {"stdio", "http", "sse"} or spec["allow_literal_secrets"] is not False:
            fail("Unsupported MCP transport or literal credentials.", "native_invalid")
        _strings(spec["args"])
        for key in ("env", "headers"):
            if not isinstance(spec[key], dict) or any(
                not isinstance(k, str) or not isinstance(v, str) for k, v in spec[key].items()
            ):
                fail("Invalid MCP environment or headers.", "native_invalid")
        if (
            not isinstance(spec["command"], str)
            or (spec["cwd"] is not None and not isinstance(spec["cwd"], str))
            or (
                spec["timeout_ms"] is not None
                and (type(spec["timeout_ms"]) is not int or not 1 <= spec["timeout_ms"] <= 3600000)
            )
        ):
            fail("Invalid MCP command or timeout.", "native_invalid")
        if spec["transport"] == "stdio" and not re.fullmatch(r"[A-Za-z0-9_.+-]+", spec["command"]):
            fail("MCP commands must be receiver PATH executables.", "native_unportable_path")
        if spec["url"] is not None:
            if not isinstance(spec["url"], str):
                fail("Invalid MCP URL.", "native_invalid")
            url = urlsplit(spec["url"])
            if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
                fail("MCP URLs must use HTTPS without embedded credentials.", "native_invalid")
        if spec["transport"] != "stdio" and not spec["url"]:
            fail("MCP URL is required.", "native_invalid")
        if secret_keys_in_spec(McpServerSpec(**spec)):
            fail("Native MCP credentials must use environment references.", "native_secret")
        _portable({k: v for k, v in spec.items() if k != "url"})
    elif area == "permissions":
        if payload.get("project_trust") is not None and type(payload["project_trust"]) is not bool:
            fail("Invalid native project trust.", "native_invalid")
        for key in ("allow", "deny", "ask"):
            _strings(payload[key])
        if payload["sandbox_mode"] not in {None, "read-only", "workspace-write", "danger-full-access"} or payload[
            "approval_policy"
        ] not in {None, "untrusted", "on-failure", "on-request", "never"}:
            fail("Invalid native policy.", "native_invalid")
        _portable(payload)
    elif area == "hooks":
        from skill_hub.domain.diagnostics.tool_catalog import CANONICAL_EVENTS

        if (
            payload["event"] not in CANONICAL_EVENTS
            or not isinstance(payload["matcher"], str)
            or len(payload["matcher"]) > 1024
        ):
            fail("Invalid hook event or matcher.", "native_invalid")
        if (
            payload["interpreter"] not in {"bash", "python3", "sh"}
            or not isinstance(payload["script"], str)
            or not payload["script"]
            or "\x00" in payload["script"]
        ):
            fail("Invalid hook script.", "native_invalid")
        if payload["timeout"] is not None and (
            type(payload["timeout"]) is not int or not 1 <= payload["timeout"] <= 3600
        ):
            fail("Invalid hook timeout.", "native_invalid")
        _strings(payload["args"])
        _portable(payload["args"])
        _portable_source(payload["script"])
    else:
        if not isinstance(payload["frontmatter"], dict) or not isinstance(payload["body"], str):
            fail("Invalid agent.", "native_invalid")
        # Claude's local serializer preserves advanced YAML metadata. The
        # receiver uses that same serializer and requires approval of the full
        # rendered document; provider-specific omissions are handled at render.
        agent_name(payload["frontmatter"].get("name"))
        _portable(payload["frontmatter"])
        _metadata_credentials(payload["frontmatter"])
        _portable_source(payload["body"])
    return payload


def decode_unit(unit: dict, assets: dict) -> dict:
    if (
        not isinstance(unit, dict)
        or set(unit) != {"scope", "harness", "area", "key", "asset"}
        or unit["scope"] not in {"project", "global"}
        or unit["harness"] not in PROVIDERS
        or unit["area"] not in AREAS
        or unit["asset"] not in assets
    ):
        fail("Invalid native unit.", "native_invalid")
    (agent_name if unit["area"] == "agents" else slug)(unit["key"])
    try:
        return validate_payload(unit["area"], strict_json(assets[unit["asset"]]))
    except (ValueError, TypeError, KeyError, UnicodeError) as exc:
        if isinstance(exc, ProfileError):
            raise
        fail("Invalid native payload.", "native_invalid")


def permission_payload(
    block: dict,
    provider: str,
    *,
    limitations: list[dict] | None = None,
    name: str = "permissions",
    binding: str | None = None,
    context: LoadoutCodecContext,
) -> dict:
    from skill_hub.domain.permissions.permissions import NormalizedPermissions

    if not isinstance(block, dict) or set(block) - {
        "allow",
        "deny",
        "ask",
        "sandbox_mode",
        "approval_policy",
        "project_trust",
        "_unmanaged",
    }:
        fail("This permission block contains unsupported native requirements.")
    if block.get("_unmanaged"):
        fail("Unmanaged permissions must be resolved on the receiver.")
    permissions = NormalizedPermissions.from_block(block)
    payload: dict = {
        "version": 1,
        "sandbox_mode": permissions.sandbox_mode,
        "approval_policy": permissions.approval_policy,
        "project_trust": permissions.project_trust,
    }
    from skill_hub.domain.permissions.permission_adapter_base import _bash_prefix_tokens

    for kind in ("allow", "deny", "ask"):
        patterns = []
        for rule in getattr(permissions, kind):
            if rule.harnesses is not None and provider not in rule.harnesses:
                continue
            if provider == "codex" and _bash_prefix_tokens(rule.pattern) is None:
                _limitation(
                    limitations,
                    area="permissions",
                    harness=provider,
                    name=name,
                    binding=binding,
                    message=(
                        f"Dropped Codex {kind} rule; only bounded Bash prefixes are supported: "
                        f"{rule.pattern[:256]}"
                    ),
                    risk="dropped_deny_or_ask" if kind in {"deny", "ask"} else None,
                )
                continue
            patterns.append(rule.pattern)
        payload[kind] = sorted(set(patterns))
    from skill_hub.domain.harnesses.harness_adapter_api import PermissionCommandRule, PermissionPatternBlock

    if provider == "codex":
        rules = tuple(
            PermissionCommandRule(tuple(_bash_prefix_tokens(pattern) or ()), kind, pattern)
            for kind in ("allow", "deny", "ask")
            for pattern in payload[kind]
            if _bash_prefix_tokens(pattern) is not None
        )
        encoded = context.codec("permissions", provider).encode(rules)
        if not isinstance(encoded, str) or not encoded:
            fail("The captured Codex permission codec rejected the native rules.", "native_invalid")
    else:
        encoded = context.codec("permission_patterns", provider).encode(PermissionPatternBlock(
            allow=tuple(payload["allow"]), deny=tuple(payload["deny"]), ask=tuple(payload["ask"])
        ))
        if not isinstance(encoded, Mapping):
            fail("The captured permission codec rejected the native patterns.", "native_invalid")
    return validate_payload("permissions", payload)


def compile_units(
    registry: dict,
    project: dict,
    binding: dict,
    selected: list[str],
    assets: dict,
    skill_contents: dict[str, dict[str, tuple[bytes, int]]],
    limitations: list[dict] | None = None,
    *,
    context: LoadoutCodecContext,
) -> list[dict]:
    """Resolve selected intent without writes, receiver probes or native adoption."""
    from skill_hub.domain.harnesses.harness_adapter_api import HookNativeRequest, McpNativeRequest, thaw_native_value
    from skill_hub.domain.hooks.hooks_model import resolve_project_hooks
    from skill_hub.domain.mcp.mcp_spec import raw_spec_from_registry
    from skill_hub.domain.skills.ships_with import normalize_block
    from skill_hub.domain.skills.skill_meta import parse_skill_frontmatter, skill_affinity, skill_source

    units: list[dict] = []
    authority = selections(binding)
    # Projection compilation already expands explicit global MCP selections and
    # removes disabled sources. Never reintroduce them from the raw registry.

    def add(scope, provider, area, key, payload):
        if provider not in PROVIDERS:
            fail("This provider has no native loadout codec.")
        validate_payload(area, payload)
        data = canonical(payload)
        sha = __import__("hashlib").sha256(data).hexdigest()
        assets[sha] = data
        units.append(
            {
                "scope": scope,
                "harness": provider,
                "area": area,
                "key": (agent_name if area == "agents" else slug)(key),
                "asset": sha,
            }
        )

    def hook(scope, provider, name, event, matcher, timeout, script, interpreter="bash", args=None):
        add(
            scope,
            provider,
            "hooks",
            name,
            {
                "version": 1,
                "event": event,
                "matcher": matcher,
                "timeout": timeout,
                "interpreter": interpreter,
                "args": args or [],
                "script": script,
            },
        )

    for provider in binding["harnesses"]:
        for scope, block, key in [
            ("project", project.get("permissions"), "project"),
            ("project", project.get("permissions_local"), "personal"),
            (
                "global",
                registry.get("permissions_global") if "permissions" in authority.get("global_native", []) else None,
                "global",
            ),
        ]:
            if block:
                add(
                    scope,
                    provider,
                    "permissions",
                    key,
                    permission_payload(
                        block, provider, limitations=limitations, name=key, binding=binding.get("destination_key"),
                        context=context,
                    ),
                )
        # Resolve attached hooks without automatically inheriting controller globals.
        scoped_registry = copy.deepcopy(registry)
        scoped_registry["hooks_global"] = []
        scoped_registry["projects"] = {"selected": project}
        messages: list[str] = []
        hooks = [(h, "project") for h in resolve_project_hooks("selected", scoped_registry, warn=messages.append)]
        if "hooks" in authority.get("global_native", []):
            from skill_hub.domain.hooks.hooks_model import resolve_global_hooks

            hooks += [(h, "global") for h in resolve_global_hooks(registry, warn=messages.append)]
        if messages:
            # Resolver diagnostics cover malformed or unresolved sources. Keep
            # these as hard blockers; only provider capability gaps are soft.
            fail("A selected hook cannot be resolved completely.")
        for h, scope in hooks:
            if h.harnesses is not None and provider not in h.harnesses:
                continue
            if h.settings:
                _limitation(
                    limitations, area="hooks", harness=provider, name=h.name,
                    binding=binding.get("destination_key"),
                    message="Hook event or settings are unsupported by this provider.",
                )
                continue
            encoded = context.codec("hooks", provider).encode(HookNativeRequest(
                event=h.event,
                tools=tuple(h.tools),
                matcher=h.matcher,
                command=h.command,
                timeout=h.timeout,
            ))
            if encoded.entry is None:
                _limitation(
                    limitations, area="hooks", harness=provider, name=h.name,
                    binding=binding.get("destination_key"),
                    message="Hook event or settings are unsupported by this provider.",
                )
                continue
            attached_matcher = encoded.entry.matcher
            if h.script:
                if h.script.source == "managed":
                    from skill_hub.infrastructure.hooks.hook_scripts import managed_script_path

                    source = managed_script_path(h.name, h.script)
                else:
                    if scope != "project":
                        fail("Global repository hooks require a project mapping.")
                    source = Path(project["path"]) / h.script.path
                    if not source.resolve().is_relative_to(Path(project["path"]).resolve()):
                        fail("Hook source escapes the project.", "native_unportable_path")
                script = read_source(source).decode()
                args = shlex.split(h.script.args)
                hook(scope, provider, h.name, h.event, attached_matcher, h.timeout, script, h.script.interpreter, args)
            else:
                argv = shlex.split(h.command)
                if (
                    not argv
                    or not re.fullmatch(r"[A-Za-z0-9_.+-]+", argv[0])
                    or re.search(r"[;&|`<>\n]|\$\(", h.command)
                ):
                    fail("Use a managed script for nonportable hook commands.")
                try:
                    _portable(argv)
                except NativeConfigurationError as exc:
                    fail(
                        f"Hook '{slug(h.name)}' uses a machine-local path. "
                        "Convert it to a managed script in Hooks, then preview again.",
                        exc.code,
                    )
                hook(
                    scope, provider, h.name, h.event, attached_matcher, h.timeout,
                    "exec " + shlex.join(argv) + "\n", "sh",
                )

        for name in selected:
            cfg = registry["skills"][name]
            affinity = skill_affinity(cfg)
            if affinity is not None and provider not in affinity:
                continue
            scope = "global" if cfg.get("scope") == "global" else "project"
            if cfg.get("type") == "mcp-server":
                if scope == "global" and "mcp" not in authority.get("global_native", []):
                    continue
                from skill_hub.domain.mcp.mcp_spec import McpServerSpec

                raw_spec = McpServerSpec(**asdict(raw_spec_from_registry(name, cfg)))
                encoded = context.codec("mcp", provider).encode(McpNativeRequest(**asdict(raw_spec)))
                for reason in encoded.skip_reasons:
                    _limitation(
                        limitations,
                        area="mcp",
                        harness=provider,
                        name=name,
                        binding=binding.get("destination_key"),
                        message=f"MCP field omitted by provider adapter: {reason[:256]}",
                    )
                add(scope, provider, "mcp", name, {"version": 1, "spec": asdict(raw_spec_from_registry(name, cfg))})
                continue
            raw = (parse_skill_frontmatter(skill_source(cfg) / "SKILL.md") or {}).get(
                "ships_with", cfg.get("ships_with")
            )
            messages = []
            companions = normalize_block(raw, skill_source(cfg), warn=messages.append)
            if messages or (raw and not companions):
                fail("A selected skill has invalid required companions.")
            if not companions:
                continue
            for area in ("permissions", "hooks", "agents"):
                if scope == "global" and companions.get(area) and area not in authority.get("global_native", []):
                    fail("Select the global native categories required by this skill companion.")
            if companions.get("permissions"):
                add(
                    scope,
                    provider,
                    "permissions",
                    "companion-" + name,
                    permission_payload(
                        companions["permissions"],
                        provider,
                        limitations=limitations,
                        name="companion-" + name,
                        binding=binding.get("destination_key"),
                        context=context,
                    ),
                )
            for h in companions.get("hooks", []):
                if "ref" in h:
                    fail("Attach referenced companion hooks explicitly before receiver publication.")
                if h.get("harnesses") is not None and provider not in h["harnesses"]:
                    continue
                if h.get("activation", "always") != "always":
                    _limitation(
                        limitations,
                        area="hooks",
                        harness=provider,
                        name=name,
                        binding=binding.get("destination_key"),
                        message="Conditional companion hooks are unsupported by the receiver codec.",
                    )
                    continue
                encoded = context.codec("hooks", provider).encode(HookNativeRequest(
                    event=h["event"], tools=tuple(h.get("tools", [])), matcher=h.get("matcher", ""),
                    command="", timeout=None,
                ))
                if encoded.entry is None:
                    _limitation(
                        limitations,
                        area="hooks",
                        harness=provider,
                        name=name,
                        binding=binding.get("destination_key"),
                        message="Companion hook event or matcher is unsupported by this provider.",
                    )
                    continue
                matcher = encoded.entry.matcher
                relative = h["command"]
                content = skill_contents[name].get(relative)
                if not content:
                    fail("Companion script is not a delivered skill asset.")
                script = content[0].decode()
                interpreter = "python3" if relative.endswith(".py") else "bash"
                hook(scope, provider, name + "-" + h["name"], h["event"], matcher, None, script, interpreter)
            for agent in companions.get("agents", []):
                content = skill_contents[name].get("agents/" + agent + ".md")
                if not content:
                    fail("Companion agent is not a delivered skill asset.")
                # Companion agent assets are portable Markdown. Parse them with
                # the captured Claude Markdown codec even for a Codex target;
                # destination-specific rendering happens later.
                parsed_doc = context.codec("agents", "claude-code").parse(content[0].decode())
                parsed = {"frontmatter": thaw_native_value(parsed_doc.frontmatter), "body": parsed_doc.body}
                add(scope, provider, "agents", agent, {"version": 1, **parsed})

        # Project native agents are already part of the chosen project's loadout.
        directory = Path(project["path"]) / (".claude" if provider == "claude-code" else ".codex") / "agents"
        sources = [(p, "project") for p in sorted(directory.glob("*.md" if provider == "claude-code" else "*.toml"))]
        if "agents" in authority.get("global_native", []):
            global_dir = Path.home() / (".claude" if provider == "claude-code" else ".codex") / "agents"
            sources += [
                (global_dir / (name + (".md" if provider == "claude-code" else ".toml")), "global")
                for name in authority["global_agents"]
            ]
        if len(sources) > 256:
            fail("Too many selected native agents.", "native_limit")
        for source, scope in sources:
            if provider == "codex" and scope == "project":
                _limitation(
                    limitations,
                    area="agents",
                    harness=provider,
                    name=source.stem,
                    binding=binding.get("destination_key"),
                    message="Codex project agents are unsupported by the provider.",
                )
                continue
            text = read_source(source).decode()
            if provider == "codex":
                parsed_doc = context.codec("agents", provider).parse(text)
                parsed = {"frontmatter": thaw_native_value(parsed_doc.frontmatter), "body": parsed_doc.body}
                if parsed_doc.native_skills:
                    from skill_hub.infrastructure.harnesses.subagent_codex import _map_skills_config, codex_skills_root

                    mapped, foreign = _map_skills_config(
                        {"config": [dict(item) for item in parsed_doc.native_skills]}, codex_skills_root()
                    )
                    if foreign:
                        fail("Codex agents contain unportable skill references.")
                    if mapped:
                        parsed["frontmatter"]["skills"] = mapped
            else:
                parsed_doc = context.codec("agents", provider).parse(text)
                parsed = {"frontmatter": thaw_native_value(parsed_doc.frontmatter), "body": parsed_doc.body}
                if provider == "claude-code" and set(parsed.get("frontmatter", {})) & {
                    "model_reasoning_effort",
                    "sandbox_mode",
                    "nickname_candidates",
                }:
                    _limitation(
                        limitations,
                        area="agents",
                        harness=provider,
                        name=source.stem,
                        binding=binding.get("destination_key"),
                        message="Codex-specific agent fields are unsupported by Claude Code.",
                    )
                    continue
            add(scope, provider, "agents", source.stem, {"version": 1, **parsed})
    unique: dict[tuple, dict] = {}
    for unit in units:
        unit_key = tuple(unit[k] for k in ("scope", "harness", "area", "key"))
        if unit_key in unique and unique[unit_key] != unit:
            fail("Native source contributions disagree.", "native_conflict")
        unique[unit_key] = unit
    return [unique[key] for key in sorted(unique)]


def render_unit(
    unit: dict,
    payload: dict,
    checkout: Path,
    home: Path,
    owner: str,
    skill_roots: dict[str, Path],
    *,
    check_prerequisites=True,
    limitations: list[dict] | None = None,
    context: LoadoutCodecContext,
) -> tuple[list[DocumentOp], dict[Path, bytes]]:
    """Render only closed, provider-owned destinations; no live writes."""
    from skill_hub.domain.harnesses.harness_adapter_api import (
        CodexRenderInput,
        HookNativeRequest,
        McpNativeRequest,
        thaw_native_value,
    )
    from skill_hub.domain.mcp.mcp_spec import ref_names

    provider, scope, area, key = (unit[k] for k in ("harness", "scope", "area", "key"))
    base = home if scope == "global" else checkout
    directory = base / (".claude" if provider == "claude-code" else ".codex")
    ops: list[DocumentOp] = []
    files: dict[Path, bytes] = {}

    def op(path, kind, selector, value):
        ops.append(DocumentOp(path, "json" if provider == "claude-code" else "toml", kind, selector, value, owner))

    if area == "mcp":
        spec = copy.deepcopy(payload["spec"])
        if spec["name"] != key:
            fail("MCP key and payload disagree.", "native_invalid")
        for field in ("args", "cwd"):
            vals = spec[field] if field == "args" else [spec[field]]
            converted = []
            for value in vals:
                if isinstance(value, str) and "{source}" in value:
                    root = skill_roots.get(key)
                    if root is None or not value.startswith("{source}") or ".." in value.split("/"):
                        fail("MCP source is not delivered with this binding.")
                    value = value.replace("{source}", str(root))
                converted.append(value)
            spec[field] = converted if field == "args" else converted[0]
        native_result = context.codec("mcp", provider).encode(McpNativeRequest(**spec))
        native = thaw_native_value(native_result.native_entry)
        for reason in native_result.skip_reasons:
            _limitation(
                limitations,
                area="mcp",
                harness=provider,
                name=key,
                message=f"MCP field omitted by provider adapter: {reason[:256]}",
                binding=owner,
            )
        if not native:
            return ops, files
        if check_prerequisites:
            if spec["transport"] == "stdio" and not shutil.which(spec["command"]):
                fail("An MCP executable is unavailable on the receiver.", "native_prerequisite_missing")
            for value in list(spec["env"].values()) + list(spec["headers"].values()):
                if any(not os.environ.get(name) for name in ref_names(value)):
                    fail("A required receiver environment variable is missing.", "native_prerequisite_missing")
        path = (
            (home / ".claude.json" if scope == "global" else checkout / ".mcp.json")
            if provider == "claude-code"
            else directory / "config.toml"
        )
        op(path, "object", ("mcpServers" if provider == "claude-code" else "mcp_servers", key), native)
    elif area == "permissions":
        if provider == "claude-code":
            if payload["sandbox_mode"] is not None or payload["approval_policy"] is not None:
                fail("Codex policy settings cannot be applied to Claude.")
            path = directory / ("settings.local.json" if key == "personal" else "settings.json")
            codec = context.codec("permission_patterns", provider)

            for kind in ("allow", "deny", "ask"):
                for pattern in payload[kind]:
                    if codec.validation_error(pattern) is not None:
                        fail("A Claude permission pattern is invalid.")
                    op(path, "array", ("permissions", kind), pattern)
        else:
            from skill_hub.domain.permissions.permission_adapter_base import _bash_prefix_tokens

            entries = []
            rules = []
            for kind in ("allow", "deny", "ask"):
                for pattern in payload[kind]:
                    tokens = _bash_prefix_tokens(pattern)
                    if tokens is None:
                        _limitation(
                            limitations,
                            area="permissions",
                            harness=provider,
                            name=key,
                            message=(
                                f"Dropped Codex {kind} rule; only bounded Bash prefixes are supported: "
                                f"{pattern[:256]}"
                            ),
                            binding=owner,
                            risk="dropped_deny_or_ask" if kind in {"deny", "ask"} else None,
                        )
                        continue
                    entries.append(
                        (tokens, {"allow": "allow", "deny": "forbidden", "ask": "prompt"}[kind], kind, pattern)
                    )
                    from skill_hub.domain.harnesses.harness_adapter_api import PermissionCommandRule

                    rules.append(PermissionCommandRule(tuple(tokens), kind, pattern))
            if entries:
                files[directory / "rules" / ("skill-tree-" + key + ".rules")] = context.codec(
                    "permissions", provider
                ).encode(tuple(rules)).encode()
                # Codex only loads project rules after the confirmed checkout is
                # trusted. This is reviewed as a native config operation.
                if scope == "project":
                    op(
                        home / ".codex" / "config.toml",
                        "object",
                        ("projects", str(checkout), "trust_level"),
                        "trusted",
                    )
            if scope == "project" and payload.get("project_trust") is True and not entries:
                op(
                    home / ".codex" / "config.toml",
                    "object",
                    ("projects", str(checkout), "trust_level"),
                    "trusted",
                )
            for field in ("sandbox_mode", "approval_policy"):
                if payload[field] is not None:
                    if scope == "global":
                        op(home / ".codex" / "config.toml", "object", (field,), payload[field])
                    else:
                        _limitation(
                            limitations,
                            area="permissions",
                            harness=provider,
                            name=key,
                            message=f"Codex {field} is only applied for global permission scope.",
                            binding=owner,
                        )
    elif area == "hooks":
        if provider == "codex" and scope == "project":
            _limitation(
                limitations,
                area="hooks",
                harness=provider,
                name=key,
                message="Codex project hooks are unsupported by the provider.",
                binding=owner,
            )
            return ops, files
        encoded_hook = context.codec("hooks", provider).encode(HookNativeRequest(
            event=payload["event"], matcher=payload["matcher"], command="", timeout=payload["timeout"]
        ))
        if encoded_hook.entry is None:
            _limitation(
                limitations,
                area="hooks",
                harness=provider,
                name=key,
                message=f"Hook event {payload['event']} is unsupported by the provider.",
                binding=owner,
            )
            return ops, files
        if provider == "codex" and check_prerequisites:
            import base64

            import tomlkit

            from skill_hub.application.loadout.loadout_transaction import snapshot

            config = snapshot(home / ".codex/config.toml", (home, checkout))
            if config.kind == "file":
                try:
                    document = tomlkit.parse(base64.b64decode(config.content).decode())
                    features = document.get("features", {})
                    if not isinstance(features, dict):
                        fail("Codex feature settings are malformed.", "native_parse_error")
                    if features.get("hooks") is False:
                        fail("Enable hooks locally in Codex before delivery.", "native_hook_feature_disabled")
                except ProfileError:
                    raise
                except (ValueError, UnicodeError):
                    fail("Codex settings are malformed.", "native_parse_error")

        if check_prerequisites and not shutil.which(payload["interpreter"]):
            fail("The hook interpreter is missing on the receiver.", "native_prerequisite_missing")
        suffix = "py" if payload["interpreter"] == "python3" else "sh"
        script = directory / "hooks" / ("skill-tree-" + key + "." + suffix)
        files[script] = payload["script"].encode()
        entry = {"type": "command", "command": shlex.join([payload["interpreter"], str(script), *payload["args"]])}
        if payload["timeout"] is not None:
            entry["timeout"] = payload["timeout"]
        path = (
            directory / ("settings.local.json" if scope == "project" else "settings.json")
            if provider == "claude-code"
            else directory / "config.toml"
        )
        op(path, "array", ("hooks", payload["event"]), {"matcher": encoded_hook.entry.matcher, "hooks": [entry]})
    else:
        fm = payload["frontmatter"]
        if fm.get("name") != key:
            fail("Agent name and key disagree.", "native_invalid")
        names = fm.get("skills", [])
        _strings(names)
        if any(name not in skill_roots for name in names):
            fail("An agent references a skill missing from this delivery.")
        if provider == "codex":
            if scope != "global":
                _limitation(
                    limitations,
                    area="agents",
                    harness=provider,
                    name=key,
                    message="Codex project agents are unsupported by the provider.",
                    binding=owner,
                )
                return ops, files
            if set(fm) - {
                "name",
                "description",
                "model",
                "model_reasoning_effort",
                "sandbox_mode",
                "nickname_candidates",
                "skills",
            }:
                _limitation(
                    limitations,
                    area="agents",
                    harness=provider,
                    name=key,
                    message="Agent contains fields unsupported by Codex.",
                    binding=owner,
                )
                return ops, files
            native = {k: v for k, v in fm.items() if k != "skills"}
            native["developer_instructions"] = payload["body"]
            if names:
                native["skills"] = {
                    "config": [{"path": str(skill_roots[n] / "SKILL.md"), "enabled": True} for n in names]
                }
            files[directory / "agents" / (key + ".toml")] = context.codec("agents", provider).render(
                CodexRenderInput(
                    None,
                    native,
                    "",
                    payload["body"],
                    replacement_skill_paths=tuple(str(skill_roots[name] / "SKILL.md") for name in names),
                )
            ).encode()
        else:
            if set(fm) & {"model_reasoning_effort", "sandbox_mode", "nickname_candidates"}:
                _limitation(
                    limitations,
                    area="agents",
                    harness=provider,
                    name=key,
                    message="Agent contains fields unsupported by Claude Code.",
                    binding=owner,
                )
                return ops, files
            files[directory / "agents" / (key + ".md")] = context.codec("agents", provider).render(
                CodexRenderInput(None, fm, "", payload["body"])
            ).encode()
    return ops, files
