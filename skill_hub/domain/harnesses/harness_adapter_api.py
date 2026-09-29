"""Immutable contracts shared by runtime inventory and adapter resolution.

This module deliberately has no imports from the hub, registry, or application
layers.  The records are suitable for passing through a later operation context
without exposing mutable configuration dictionaries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import total_ordering
from types import MappingProxyType
from typing import Any, Mapping, Optional, Protocol, Tuple


def _freeze(value: Any) -> Any:
    """Recursively turn common JSON-shaped values into immutable values."""
    if isinstance(value, Mapping):
        return MappingProxyType({str(k): _freeze(v) for k, v in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set):
        return frozenset(_freeze(item) for item in value)
    return value


class _McpFrozenList(tuple):
    """Immutable list-shaped value retained for the MCP host bridge."""


class _McpFrozenTuple(tuple):
    """Immutable tuple-shaped value retained for the MCP host bridge."""


class _McpFrozenSet(frozenset):
    """Immutable set-shaped value retained for the MCP host bridge."""


class _McpFrozenFrozenSet(frozenset):
    """Immutable frozenset-shaped value retained for the MCP host bridge."""


def _freeze_mcp(value: Any) -> Any:
    """Freeze MCP values while retaining their legacy container shapes."""
    if isinstance(value, Mapping):
        return MappingProxyType({k: _freeze_mcp(v) for k, v in value.items()})
    if isinstance(value, _McpFrozenList):
        return _McpFrozenList(_freeze_mcp(item) for item in value)
    if isinstance(value, _McpFrozenTuple):
        return _McpFrozenTuple(_freeze_mcp(item) for item in value)
    if isinstance(value, _McpFrozenSet):
        return _McpFrozenSet(_freeze_mcp(item) for item in value)
    if isinstance(value, _McpFrozenFrozenSet):
        return _McpFrozenFrozenSet(_freeze_mcp(item) for item in value)
    if isinstance(value, list):
        return _McpFrozenList(_freeze_mcp(item) for item in value)
    if isinstance(value, tuple):
        return _McpFrozenTuple(_freeze_mcp(item) for item in value)
    if isinstance(value, set):
        return _McpFrozenSet(_freeze_mcp(item) for item in value)
    if isinstance(value, frozenset):
        return _McpFrozenFrozenSet(_freeze_mcp(item) for item in value)
    return value


def thaw_mcp_value(value: Any) -> Any:
    """Restore MCP native values to the container shapes supplied by callers."""
    if isinstance(value, Mapping):
        return {key: thaw_mcp_value(item) for key, item in value.items()}
    if isinstance(value, _McpFrozenList):
        return [thaw_mcp_value(item) for item in value]
    if isinstance(value, _McpFrozenTuple):
        return tuple(thaw_mcp_value(item) for item in value)
    if isinstance(value, _McpFrozenSet):
        return {thaw_mcp_value(item) for item in value}
    if isinstance(value, _McpFrozenFrozenSet):
        return frozenset(thaw_mcp_value(item) for item in value)
    return value


@total_ordering
@dataclass(frozen=True)
class Version:
    """A normalized semantic version, or an explicitly unknown version."""

    major: int
    minor: int = 0
    patch: int = 0
    prerelease: Optional[str] = None

    def __post_init__(self) -> None:
        if min(self.major, self.minor, self.patch) < 0:
            raise ValueError("version components must be non-negative")
        if self.prerelease is not None and not re.fullmatch(r"[0-9A-Za-z.-]+", self.prerelease):
            raise ValueError("invalid prerelease")

    @classmethod
    def parse(cls, value: object) -> Optional["Version"]:
        if not isinstance(value, str):
            return None
        match = re.fullmatch(r"[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", value.strip())
        if match is None:
            return None
        return cls(int(match.group(1)), int(match.group(2)), int(match.group(3)), match.group(4))

    @property
    def is_stable(self) -> bool:
        return self.prerelease is None

    def __str__(self) -> str:
        suffix = "-" + self.prerelease if self.prerelease else ""
        return f"{self.major}.{self.minor}.{self.patch}{suffix}"

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, Version):
            return NotImplemented
        # A stable release sorts after every prerelease of the same triple.
        return (
            self.major,
            self.minor,
            self.patch,
            self.prerelease is None,
            self.prerelease or "",
        ) < (
            other.major,
            other.minor,
            other.patch,
            other.prerelease is None,
            other.prerelease or "",
        )


# Version of the immutable adapter SDK contract.  Host applications pass this
# separately from their own release version when resolving constraints.
SDK_VERSION = Version(1, 0, 0)


@dataclass(frozen=True)
class VersionConstraint:
    """An exact version or a half-open stable range ``[lower, upper)``."""

    kind: str
    exact: Optional[Version] = None
    lower: Optional[Version] = None
    upper: Optional[Version] = None

    def __post_init__(self) -> None:
        if self.kind not in {"any", "exact", "half_open"}:
            raise ValueError("unknown version constraint kind")
        if self.kind == "exact" and self.exact is None:
            raise ValueError("exact constraint requires a version")
        if self.kind == "half_open" and (self.lower is None or self.upper is None or self.lower >= self.upper):
            raise ValueError("half-open constraint requires lower < upper")
        if self.kind == "half_open" and (not self.lower.is_stable or not self.upper.is_stable):  # type: ignore[union-attr]
            raise ValueError("half-open constraints require stable bounds")
        if self.kind != "exact" and self.exact is not None:
            raise ValueError("exact version only belongs on an exact constraint")

    @classmethod
    def any(cls) -> "VersionConstraint":
        return cls("any")

    @classmethod
    def exact_version(cls, version: object) -> "VersionConstraint":
        parsed = version if isinstance(version, Version) else Version.parse(version)
        if parsed is None:
            raise ValueError("invalid exact version")
        return cls("exact", exact=parsed)

    exact_release = exact_version

    @classmethod
    def half_open(cls, lower: object, upper: object) -> "VersionConstraint":
        low = lower if isinstance(lower, Version) else Version.parse(lower)
        high = upper if isinstance(upper, Version) else Version.parse(upper)
        if low is None or high is None:
            raise ValueError("invalid half-open version range")
        return cls("half_open", lower=low, upper=high)

    @classmethod
    def from_text(cls, value: str) -> "VersionConstraint":
        if value == "*":
            return cls.any()
        if value.startswith("="):
            return cls.exact_version(value[1:])
        if value.startswith("[") and value.endswith(")") and "," in value:
            low, high = value[1:-1].split(",", 1)
            return cls.half_open(low, high)
        return cls.exact_version(value)

    def matches(self, version: Optional[Version]) -> bool:
        if version is None:
            return False
        if self.kind == "any":
            return version.is_stable
        if self.kind == "exact":
            return version == self.exact
        return version.is_stable and self.lower <= version < self.upper  # type: ignore[operator]

    def overlaps(self, other: "VersionConstraint") -> bool:
        if self.kind == "any":
            return other.kind != "exact" or other.exact is not None
        if other.kind == "any":
            return True
        if self.kind == "exact":
            return other.matches(self.exact)
        if other.kind == "exact":
            return self.matches(other.exact)
        return self.lower < other.upper and other.lower < self.upper  # type: ignore[operator]


@dataclass(frozen=True)
class ProbeOutcome:
    """Bounded result of one version probe."""

    status: str
    raw_output: str = ""
    normalized_version: Optional[Version] = None
    exit_code: Optional[int] = None
    error: Optional[str] = None
    timed_out: bool = False
    truncated: bool = False
    observed_at: Optional[str] = None


@dataclass(frozen=True)
class RuntimeIdentity:
    harness_id: str
    installation_id: str
    executable_path: Optional[str] = None
    raw_version: str = ""
    version: Optional[Version] = None
    build: Optional[str] = None
    channel: Optional[str] = None
    environment: str = "cli"
    os_name: str = "unknown"
    os_version: Optional[str] = None
    architecture: str = "unknown"
    home_root: Optional[str] = None
    config_root: Optional[str] = None
    root_identity: Optional[str] = None
    probe: Optional[ProbeOutcome] = None
    executable_fingerprint: Optional[str] = None
    config_fingerprint: Optional[str] = None
    profile: Optional[str] = None
    evidence: str = "probe"
    observed_at: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.harness_id or not self.installation_id:
            raise ValueError("runtime identity needs harness and installation ids")
        if self.environment not in {"cli", "desktop", "embedded", "unknown"}:
            raise ValueError("unknown runtime environment")


@dataclass(frozen=True)
class HarnessVariant:
    harness_id: str
    variant_id: str = "default"
    version_constraint: Optional[VersionConstraint] = None
    host_constraint: VersionConstraint = VersionConstraint(kind="any")
    sdk_constraint: VersionConstraint = VersionConstraint(kind="any")
    os_names: Tuple[str, ...] = ()
    architectures: Tuple[str, ...] = ()
    environments: Tuple[str, ...] = ()
    features: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    validation_evidence: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    profile: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        object.__setattr__(self, "os_names", tuple(self.os_names))
        object.__setattr__(self, "architectures", tuple(self.architectures))
        object.__setattr__(self, "environments", tuple(self.environments))
        object.__setattr__(self, "features", _freeze(self.features))
        object.__setattr__(self, "validation_evidence", _freeze(self.validation_evidence))
        object.__setattr__(self, "metadata", _freeze(self.metadata))


@dataclass(frozen=True)
class AdapterManifest:
    package_id: str
    release_version: Version
    digest: str
    variants: Tuple[HarnessVariant, ...] = ()
    host_constraint: VersionConstraint = VersionConstraint(kind="any")
    sdk_constraint: VersionConstraint = VersionConstraint(kind="any")
    active: bool = True
    staged: bool = False
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        if not self.package_id or not self.digest:
            raise ValueError("manifest identity is required")
        object.__setattr__(self, "variants", tuple(self.variants))
        object.__setattr__(self, "metadata", _freeze(self.metadata))

    @property
    def release_id(self) -> str:
        return f"{self.package_id}@{self.release_version}"


@dataclass(frozen=True)
class CatalogSnapshot:
    generation: str
    manifests: Tuple[AdapterManifest, ...]
    active_release_ids: Optional[Tuple[str, ...]] = None
    content_digest: str = ""
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        object.__setattr__(self, "manifests", tuple(self.manifests))
        active = (
            tuple(self.active_release_ids)
            if self.active_release_ids is not None
            else tuple(m.release_id for m in self.manifests if m.active and not m.staged)
        )
        object.__setattr__(self, "active_release_ids", active)
        object.__setattr__(self, "metadata", _freeze(self.metadata))

    @property
    def active_manifests(self) -> Tuple[AdapterManifest, ...]:
        active_ids = self.active_release_ids or ()
        return tuple(
            m for m in self.manifests if m.release_id in active_ids and m.active and not m.staged
        )


@dataclass(frozen=True)
class AdapterBinding:
    package_id: str
    release_version: Version
    release_digest: str
    harness_id: str
    variant_id: str
    installation_id: str
    profile: Optional[str]
    runtime_version: Version
    runtime_identity: RuntimeIdentity
    validation_provenance: str = "declared"


@dataclass(frozen=True)
class FeatureDecision:
    feature: str
    status: str
    reason: str
    binding: Optional[AdapterBinding] = None
    validation_provenance: str = "none"

    @property
    def supported(self) -> bool:
        return self.status in {"supported", "unverified"} and self.binding is not None


@dataclass(frozen=True)
class OperationResolution:
    catalog_generation: str
    decisions: Tuple[FeatureDecision, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "decisions", tuple(self.decisions))

    def decision(self, feature: str) -> Optional[FeatureDecision]:
        return next((item for item in self.decisions if item.feature == feature), None)


@dataclass(frozen=True)
class McpNativeRequest:
    """Immutable host-to-codec MCP encoding request."""

    name: str
    command: str = ""
    args: Tuple[str, ...] = ()
    env: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    cwd: Optional[str] = None
    transport: str = "stdio"
    url: Optional[str] = None
    headers: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    timeout_ms: Optional[int] = None
    allow_literal_secrets: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "args", _freeze_mcp(self.args))
        object.__setattr__(self, "env", _freeze_mcp(self.env))
        object.__setattr__(self, "headers", _freeze_mcp(self.headers))


@dataclass(frozen=True)
class McpNativeResult:
    """Immutable result; the bridge thaws it only at the legacy host edge."""

    native_entry: Mapping[str, Any]
    skip_reasons: Tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "native_entry", _freeze_mcp(self.native_entry))
        object.__setattr__(self, "skip_reasons", tuple(self.skip_reasons))


class McpNativeCodec(Protocol):
    def encode(self, request: McpNativeRequest) -> McpNativeResult: ...


@dataclass(frozen=True)
class McpDecodedEntry:
    """Immutable harness-agnostic MCP entry produced by a native decoder."""

    command: str
    args: Tuple[str, ...]
    env: Mapping[str, str]
    cwd: Optional[str]
    transport: str
    url: Optional[str]
    headers: Mapping[str, str]
    timeout_ms: Optional[int]

    def __post_init__(self) -> None:
        object.__setattr__(self, "args", tuple(self.args))
        object.__setattr__(self, "env", _freeze_mcp(self.env))
        object.__setattr__(self, "headers", _freeze_mcp(self.headers))


@dataclass(frozen=True)
class McpNativeDecodeResult:
    """One decoded entry or one refusal reason, plus ordered warnings."""

    entry: Optional[McpDecodedEntry] = None
    reason: Optional[str] = None
    warnings: Tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if (self.entry is None) == (self.reason is None):
            raise ValueError("decode result requires exactly one entry or reason")
        object.__setattr__(self, "warnings", tuple(self.warnings))


class McpNativeDecoder(Protocol):
    def decode(self, native: object) -> McpNativeDecodeResult: ...


@dataclass(frozen=True)
class PermissionCommandRule:
    """Immutable bounded command rule passed to a native permission codec."""

    tokens: Tuple[str, ...]
    kind: str
    source_pattern: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "tokens", tuple(self.tokens))


@dataclass(frozen=True)
class NativePermissionRuleObservation:
    """One native rule and whether it can enter the registry model."""

    tokens: Optional[Tuple[str, ...]]
    native_decision: Any
    importable: bool
    reason: Optional[str] = None
    lineno: Optional[int] = None
    end_lineno: Optional[int] = None
    justification: Any = None
    has_match: bool = False
    native_pattern: Optional[str] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "native_decision", _freeze_mcp(self.native_decision))
        object.__setattr__(self, "justification", _freeze_mcp(self.justification))
        if self.tokens is not None:
            object.__setattr__(self, "tokens", tuple(self.tokens))


class PermissionNativeRuleCodec(Protocol):
    def encode(self, rules: Tuple[PermissionCommandRule, ...]) -> Any: ...

    def decode(self, native: object) -> Tuple[NativePermissionRuleObservation, ...]: ...


@dataclass(frozen=True)
class PermissionPatternBlock:
    """Immutable native pattern arrays used by Claude-family settings."""

    allow: Tuple[str, ...] = ()
    deny: Tuple[str, ...] = ()
    ask: Tuple[str, ...] = ()
    additional_directories: Tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field_name in ("allow", "deny", "ask", "additional_directories"):
            object.__setattr__(self, field_name, tuple(getattr(self, field_name)))


class PermissionPatternCodec(Protocol):
    """Codec for native allow/deny/ask pattern blocks."""

    def validation_error(self, pattern: object) -> Optional[str]: ...

    def encode(self, block: PermissionPatternBlock) -> Mapping[str, Any]: ...

    def decode(self, native: object) -> PermissionPatternBlock: ...


def thaw_native_value(value: Any) -> Any:
    """Restore native container types at a host boundary, retaining frozen SDK values."""
    return thaw_mcp_value(value)


@dataclass(frozen=True)
class HookNativeRequest:
    """Immutable host-to-codec hook encoding request."""

    event: str
    tools: Tuple[str, ...] = ()
    matcher: str = ""
    command: str = ""
    timeout: Optional[int] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tools", tuple(self.tools))


@dataclass(frozen=True)
class HookNativeEntry:
    """One semantic native hook entry before host-specific serialization."""

    event: str
    matcher: str
    command: str
    timeout: Optional[int] = None


@dataclass(frozen=True)
class HookNativeResult:
    """Immutable hook encoding result; ``entry=None`` means an honest skip."""

    entry: Optional[HookNativeEntry] = None
    skip_reasons: Tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "skip_reasons", tuple(self.skip_reasons))


class HookNativeCodec(Protocol):
    def encode(self, request: HookNativeRequest) -> HookNativeResult: ...

    def decode(self, event: object, entry: object) -> Tuple[HookNativeEntry, ...]: ...

    def supported_events(self) -> Tuple[str, ...]: ...

    def translate_tools(self, tools: Tuple[str, ...]) -> Optional[str]: ...


@dataclass(frozen=True)
class HarnessNativeLayout:
    """Immutable native path and capability declarations for one harness."""

    id: str
    project_skills_dir: str
    global_skills_dir: str
    detector_dir: str
    detector_marker: str
    mcp_adapter_key: Optional[str]
    legacy_global_skills_dirs: Tuple[str, ...] = ()
    permission_adapter_key: Optional[str] = None
    root_doc: str = "AGENTS.md"
    global_doc: Optional[str] = None
    global_mcp_config: Optional[str] = None
    agents_dir: Optional[str] = None
    project_agents_dir: Optional[str] = None
    agent_format: Optional[str] = None
    hook_mechanism: str = "none"

    def __post_init__(self) -> None:
        object.__setattr__(self, "legacy_global_skills_dirs", tuple(self.legacy_global_skills_dirs))

    @property
    def detect_dir(self) -> str:
        """Compatibility spelling matching the emitted ``detect`` payload."""
        return self.detector_dir

    @property
    def detect_marker(self) -> str:
        """Compatibility spelling matching the emitted ``detect`` payload."""
        return self.detector_marker


@dataclass(frozen=True)
class InvocationCapability:
    """Native invocation behavior, separate from host delivery state."""

    support: str
    implicit_behavior: str
    explicit_behavior: str
    mechanism: str
    limitations: Tuple[str, ...] = ()
    reason_code: Optional[str] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "limitations", tuple(self.limitations))


class NativeInvocationError(ValueError):
    """A native invocation payload cannot be safely interpreted or rendered."""

    def __init__(self, message: str, code: str = "invocation-error") -> None:
        super().__init__(message)
        self.code = code


class InvocationNativeCodec(Protocol):
    """Callable native capability resolver implemented by bundled functions."""

    def __call__(
        self, harness: str, mode: str, *, profile: str = "unknown",
        source_implicit: bool = True, reason_code: Optional[str] = None,
    ) -> InvocationCapability: ...


@dataclass(frozen=True)
class NativeAgentDocument:
    """Immutable native agent document returned by a bundled format codec.

    ``native_skills`` contains the plain decoded entries from a native skills
    table.  Ownership decisions (which entries belong to the hub) stay at the
    host boundary; the codec never receives paths or registry objects.
    """

    frontmatter: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    body: str = ""
    raw_text: str = ""
    native_skills: Tuple[Any, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "frontmatter", _freeze_mcp(self.frontmatter))
        object.__setattr__(
            self, "native_skills", tuple(_freeze_mcp(item) for item in self.native_skills)
        )


@dataclass(frozen=True)
class CodexRenderInput:
    """Host-computed inputs for a comment-preserving Codex TOML render."""

    existing_text: Optional[str]
    frontmatter: Mapping[str, Any]
    advanced_toml: str
    body: str
    managed_skill_indices: Tuple[int, ...] = ()
    replacement_skill_paths: Tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "frontmatter", _freeze_mcp(self.frontmatter))
        object.__setattr__(self, "managed_skill_indices", tuple(self.managed_skill_indices))
        object.__setattr__(self, "replacement_skill_paths", tuple(self.replacement_skill_paths))


class NativeAgentCodec(Protocol):
    """SDK-only codec contract for native Claude/Codex agent documents."""

    def parse(self, text: str) -> NativeAgentDocument: ...

    def advanced_fragment(self, text: str) -> str: ...

    def render(self, request: CodexRenderInput) -> str: ...
