"""Bundled native invocation capability rules without host state or I/O."""

from __future__ import annotations

import copy
import io
from collections.abc import Mapping
from typing import Any

from skill_hub.domain.harnesses.harness_adapter_api import InvocationCapability, NativeInvocationError

VALID_MODES = frozenset(("auto", "user-only", "model-only"))
_YAML_WIDTH = 4096
_POLICY_KEY = "policy"
_IMPLICIT_KEY = "allow_implicit_invocation"
_DEFAULT_BACKEND = object()


def yaml_backend(yaml_cls: object) -> Any:
    """Configure one local ruamel class for comment-preserving round trips."""

    if yaml_cls is None or not callable(yaml_cls):
        raise NativeInvocationError(
            "ruamel.yaml is required for round-trip Codex policy edits",
            code="yaml-backend-unavailable",
        )
    try:
        yaml = yaml_cls(typ="rt")
        yaml.preserve_quotes = True
        yaml.width = _YAML_WIDTH
        yaml.allow_unicode = True
        yaml.allow_duplicate_keys = False
        yaml.indent(mapping=2, sequence=4, offset=2)
        return yaml
    except NativeInvocationError:
        raise
    except Exception as exc:
        raise NativeInvocationError(
            f"could not initialize ruamel.yaml: {exc}",
            code="yaml-backend-unavailable",
        ) from exc


def _default_yaml() -> Any:
    """Create the optional round-trip backend without an SDK import dependency."""

    try:
        from ruamel.yaml import YAML
    except Exception as exc:  # pragma: no cover - depends on installation
        raise NativeInvocationError(
            "ruamel.yaml is required for round-trip Codex policy edits",
            code="yaml-backend-unavailable",
        ) from exc
    return yaml_backend(YAML)


def _backend(factory: object) -> Any:
    if factory is _DEFAULT_BACKEND:
        return _default_yaml()
    if factory is None:
        raise NativeInvocationError(
            "ruamel.yaml is required for round-trip Codex policy edits",
            code="yaml-backend-unavailable",
        )
    if not callable(factory):
        raise NativeInvocationError(
            "Codex YAML backend must be a factory",
            code="yaml-backend-unavailable",
        )
    try:
        return factory()
    except NativeInvocationError:
        raise
    except Exception as exc:
        raise NativeInvocationError(
            f"could not initialize ruamel.yaml: {exc}",
            code="yaml-backend-unavailable",
        ) from exc


def _decode(source: bytes) -> tuple[str, bool, bool]:
    if not isinstance(source, bytes):
        raise NativeInvocationError("Codex policy source must be bytes or None", code="invalid-source")
    has_bom = source.startswith(b"\xef\xbb\xbf")
    try:
        text = source.decode("utf-8-sig" if has_bom else "utf-8")
    except UnicodeDecodeError as exc:
        raise NativeInvocationError("Codex policy is not valid UTF-8", code="invalid-encoding") from exc
    return text, b"\r\n" in source, has_bom


def _parse(source: bytes, yaml_factory: object = _DEFAULT_BACKEND) -> tuple[Any, Any, bool, bool]:
    text, crlf, has_bom = _decode(source)
    yaml = _backend(yaml_factory)
    try:
        documents = list(yaml.load_all(text))
    except Exception as exc:
        code = "duplicate-key" if "duplicate" in type(exc).__name__.lower() else "invalid-yaml"
        raise NativeInvocationError(f"invalid Codex policy YAML: {exc}", code=code) from exc
    if len(documents) > 1:
        raise NativeInvocationError(
            "Codex policy must contain exactly one YAML document", code="multiple-documents"
        )
    document = documents[0] if documents else None
    if document is None:
        document = yaml.load("{}")
        comments = "\n".join(line for line in text.splitlines() if line.lstrip().startswith("#"))
        if comments:
            document.yaml_set_start_comment(comments)
    if not isinstance(document, Mapping):
        raise NativeInvocationError("Codex policy root must be a mapping", code="invalid-root")
    return document, yaml, crlf, has_bom


def _policy(document: Mapping[str, Any]) -> Any:
    if _POLICY_KEY not in document:
        return None
    policy = document[_POLICY_KEY]
    if not isinstance(policy, Mapping):
        raise NativeInvocationError("Codex policy must be a mapping", code="invalid-policy")
    if _IMPLICIT_KEY in policy and not isinstance(policy[_IMPLICIT_KEY], bool):
        raise NativeInvocationError(
            "policy.allow_implicit_invocation must be a boolean", code="invalid-policy-value"
        )
    return policy


def _count_identity(value: Any, target: Any, active: set[int] | None = None) -> int:
    """Count alias occurrences of ``target`` without looping on cyclic YAML."""

    if value is target:
        return 1
    if active is None:
        active = set()
    value_id = id(value)
    if value_id in active:
        return 0
    if isinstance(value, Mapping):
        active.add(value_id)
        total = sum(_count_identity(child, target, active) for child in value.values())
        active.remove(value_id)
        return total
    if isinstance(value, (list, tuple)):
        active.add(value_id)
        total = sum(_count_identity(child, target, active) for child in value)
        active.remove(value_id)
        return total
    return 0


def _detach_alias(document: Any, policy: Any) -> None:
    if _count_identity(document, policy) <= 1:
        return
    try:
        document[_POLICY_KEY] = copy.deepcopy(policy)
    except Exception as exc:
        raise NativeInvocationError(
            "cannot safely patch an aliased Codex policy mapping", code="yaml-alias-conflict"
        ) from exc


def _dump(document: Any, yaml: Any, *, crlf: bool, has_bom: bool) -> bytes:
    buffer = io.StringIO()
    try:
        yaml.dump(document, buffer)
    except Exception as exc:
        raise NativeInvocationError(
            f"could not render Codex policy YAML: {exc}", code="yaml-render-failed"
        ) from exc
    rendered = buffer.getvalue()
    if crlf:
        rendered = rendered.replace("\r\n", "\n").replace("\n", "\r\n")
    output = rendered.encode("utf-8")
    return (b"\xef\xbb\xbf" if has_bom else b"") + output


def render_codex_policy(
    source: bytes | None, mode: str, *, yaml_factory: object = _DEFAULT_BACKEND
) -> bytes | None:
    """Render the one Hub-owned Codex policy leaf using a supplied YAML backend."""

    if mode not in VALID_MODES:
        raise NativeInvocationError(f"unknown invocation mode: {mode!r}", code="invalid-mode")
    if source is None:
        if mode != "user-only":
            return None
        source = b""
    document, yaml, crlf, has_bom = _parse(source, yaml_factory)
    policy = _policy(document)
    current = policy.get(_IMPLICIT_KEY) if policy is not None else None
    if mode == "auto":
        return source
    if mode == "model-only" and current is not False:
        return source
    if mode == "user-only" and current is False:
        return source
    if policy is None:
        document[_POLICY_KEY] = {}
        policy = document[_POLICY_KEY]
    else:
        _detach_alias(document, policy)
        policy = document[_POLICY_KEY]
    policy[_IMPLICIT_KEY] = mode != "user-only"
    return _dump(document, yaml, crlf=crlf, has_bom=has_bom)


def codex_implicit(source: bytes | None, *, yaml_factory: object = _DEFAULT_BACKEND) -> bool:
    """Read Codex's source-native implicit invocation baseline."""

    if source is None:
        return True
    document, _yaml_instance, _crlf, _has_bom = _parse(source, yaml_factory)
    policy = _policy(document)
    if policy is None or _IMPLICIT_KEY not in policy:
        return True
    return bool(policy[_IMPLICIT_KEY])


def resolve_capability(
    harness: str, mode: str, *, profile: str = "unknown",
    source_implicit: bool = True, reason_code: str | None = None,
) -> InvocationCapability:
    """Describe the existing native profile; callers own delivery and policy."""
    if mode not in {"auto", "user-only", "model-only"}:
        raise ValueError(f"unknown invocation mode: {mode!r}")
    support = "unknown"
    implicit = "unknown"
    explicit = "unknown"
    mechanism = "unverified invocation capability"
    limitations: list[str] = []
    derived_reason = reason_code

    if harness == "codex":
        mechanism = "agents/openai.yaml policy.allow_implicit_invocation"
        if mode == "auto":
            support = "native"
            implicit = "enabled" if source_implicit else "disabled"
            explicit = "available"
            if not source_implicit:
                limitations.append(
                    "The source disables automatic invocation; Auto preserves that source setting."
                )
        elif mode == "user-only":
            support = "enforced"
            implicit = "disabled"
            explicit = "available"
        else:
            support = "unsupported"
            implicit = "enabled"
            explicit = "available"
            limitations.append(
                "Codex has no verified Model-only setting; explicit invocation remains available."
            )
            derived_reason = derived_reason or "explicit-invocation-unsupported"

    elif harness in {"claude", "claude-code"}:
        mechanism = "SKILL.md invocation frontmatter"
        support = "native"
        if mode == "auto":
            implicit, explicit = "enabled", "available"
        elif mode == "user-only":
            support, implicit, explicit = "enforced", "disabled", "available"
        else:
            support, implicit, explicit = "enforced", "enabled", "hidden"

    elif harness == "pi":
        mechanism = "SKILL.md disable-model-invocation frontmatter"
        if mode == "model-only":
            support, implicit, explicit = "unsupported", "enabled", "available"
            limitations.append(
                "Pi has no verified per-skill manual-invocation restriction; /skill remains available."
            )
            derived_reason = derived_reason or "explicit-invocation-unsupported"
        else:
            support = "native" if mode == "auto" else "enforced"
            implicit = "enabled" if mode == "auto" else "disabled"
            explicit = "available"

    elif harness == "opencode":
        if profile in {"opencode-v1.18.31", "opencode-v1.18.31-command-eligible"}:
            mechanism = "opencode native skill discovery and slash commands"
            if mode == "auto":
                support, implicit, explicit = "native", "enabled", "available"
            elif mode == "model-only":
                support, implicit, explicit = "unsupported", "enabled", "available"
                limitations.append(
                    "This opencode release exposes a manual / command entry point; Hub cannot hide it."
                )
                derived_reason = derived_reason or "explicit-invocation-unsupported"
            elif profile == "opencode-v1.18.31-command-eligible":
                support, implicit, explicit = "enforced", "disabled", "available"
                mechanism = "opencode command-only delivery"
            else:
                support, implicit, explicit = "unsupported", "enabled", "available"
                limitations.append(
                    "User-only cannot be enforced until command-only discovery eligibility is proven."
                )
                derived_reason = derived_reason or "command-eligibility-unverified"
        elif profile in {
            "opencode-model-tool-only",
            "opencode-model-tool-only-command-eligible",
        }:
            mechanism = "opencode native model skill tool"
            if mode == "auto":
                support, implicit, explicit = "native", "enabled", "available"
            elif mode == "model-only":
                support, implicit, explicit = "native", "enabled", "available"
            elif profile.endswith("command-eligible"):
                support, implicit, explicit = "enforced", "disabled", "available"
                mechanism = "opencode command-only delivery"
            else:
                support, implicit, explicit = "unsupported", "enabled", "available"
                limitations.append(
                    "User-only cannot be enforced until command-only discovery eligibility is proven."
                )
                derived_reason = derived_reason or "command-eligibility-unverified"
        else:
            # The public V2 documentation and inspected source disagree. A
            # profile label alone is never evidence that these controls work.
            mechanism = "unverified opencode capability profile"
            limitations.append(
                "Invocation support could not be verified for this opencode build/profile."
            )
            derived_reason = derived_reason or "unknown-profile"

    else:
        derived_reason = derived_reason or "unknown-harness"

    return InvocationCapability(
        support=support, implicit_behavior=implicit, explicit_behavior=explicit,
        mechanism=mechanism, limitations=tuple(limitations), reason_code=derived_reason,
    )
