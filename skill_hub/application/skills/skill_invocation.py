"""Pure native invocation policy and capability resolution.

The sync and variant layers own files, links, timestamps, and fingerprints.  This
module only parses/render bytes and describes the requested behavior for a
particular harness.  In particular, rendering never edits the source document.
"""

from __future__ import annotations

from typing import Any, Mapping

try:
    from ruamel.yaml import YAML as _RuamelYAML
except Exception:  # pragma: no cover - exercised by the backend failure test
    _RuamelYAML = None  # type: ignore[assignment,misc]

from skill_hub.domain.harnesses.harness_adapter_api import InvocationNativeCodec, NativeInvocationError
from skill_hub.infrastructure.harnesses.harness_bundled_invocation import (
    codex_implicit as _native_codex_implicit,
)
from skill_hub.infrastructure.harnesses.harness_bundled_invocation import (
    render_codex_policy as _native_render_codex_policy,
)
from skill_hub.infrastructure.harnesses.harness_bundled_invocation import (
    yaml_backend as _native_yaml_backend,
)

VALID_MODES = frozenset(("auto", "user-only", "model-only"))
VALID_DELIVERIES = frozenset(
    ("pending", "applied", "unchanged", "failed", "not-targeted")
)
InvocationError = NativeInvocationError


def _yaml() -> Any:
    return _native_yaml_backend(_RuamelYAML)


def _validate_mode(mode: str) -> None:
    if mode not in VALID_MODES:
        raise InvocationError(
            f"unknown invocation mode: {mode!r}",
            code="invalid-mode",
        )


def render_codex_policy(source: bytes | None, mode: str) -> bytes | None:
    """Return a derived Codex YAML payload for ``mode``.

    ``auto`` restores the source-native policy, so it is deliberately byte
    stable. Model-only only changes a source-native ``false`` to ``true``;
    User-only writes the single policy leaf, including when no source file exists.
    Other modes leave a missing source absent.
    """

    _validate_mode(mode)
    return _native_render_codex_policy(source, mode, yaml_factory=_yaml)


def codex_implicit(source: bytes | None) -> bool:
    """Read Codex's source-native implicit-invocation baseline."""

    return _native_codex_implicit(source, yaml_factory=_yaml)


def _result(
    skill: str,
    harness: str,
    mode: str,
    *,
    mode_origin: str,
    profile: str,
    project: str | None,
    support: str,
    implicit_behavior: str,
    explicit_behavior: str,
    mechanism: str,
    limitations: list[str],
    delivery: str,
    reason_code: str | None,
) -> dict[str, Any]:
    return {
        "skill": skill,
        "harness": harness,
        "project": project,
        "requested_mode": mode,
        "mode_origin": mode_origin,
        "capability_profile": profile,
        "support": support,
        "implicit_behavior": implicit_behavior,
        "explicit_behavior": explicit_behavior,
        "mechanism": mechanism,
        "limitations": limitations,
        "delivery": delivery,
        "reason_code": reason_code,
    }


def resolve_invocation(
    skill: str,
    harness: str,
    mode: str,
    *,
    mode_origin: str = "library",
    profile: str = "unknown",
    source_implicit: bool = True,
    project: str | None = None,
    delivery: str = "pending",
    reason_code: str | None = None,
    native_resolver: InvocationNativeCodec | None = None,
) -> dict[str, Any]:
    """Describe the requested mode for one observed harness profile.

    This is intentionally a capability result, not a delivery result: callers
    supply the current delivery state and own freshness timestamps/fingerprints.
    """

    _validate_mode(mode)
    if delivery not in VALID_DELIVERIES:
        raise InvocationError(
            f"unknown delivery state: {delivery!r}",
            code="invalid-delivery",
        )

    from skill_hub.infrastructure.harnesses.harness_bundled_invocation import resolve_capability

    resolver = native_resolver if native_resolver is not None else resolve_capability
    capability = resolver(
        harness, mode, profile=profile, source_implicit=source_implicit, reason_code=reason_code,
    )

    return _result(
        skill,
        harness,
        mode,
        mode_origin=mode_origin,
        profile=profile,
        project=project,
        support=capability.support,
        implicit_behavior=capability.implicit_behavior,
        explicit_behavior=capability.explicit_behavior,
        mechanism=capability.mechanism,
        limitations=list(capability.limitations),
        delivery=delivery,
        reason_code=capability.reason_code,
    )


def render_native_invocation(
    skill: str,
    harnesses: set[str],
    mode: str,
    source_policy: bytes | None,
    *,
    profiles: dict[str, str] | None = None,
    mode_origin: str = "library",
    project: str | None = None,
    native_resolvers: dict[str, Any] | None = None,
) -> tuple[dict[str, bytes], list[dict[str, Any]]]:
    """Render shared CLI payloads; capability limitations are reportable, not fatal.

    Callers own source reads, destination ownership, and delivery state. Profiles
    describe the destination, never a different machine's installed providers.
    """
    outcomes = []
    for harness in sorted(harnesses):
        profile = (profiles or {}).get(harness, "unknown")
        try:
            outcomes.append(resolve_invocation(
                skill, harness, mode, mode_origin=mode_origin, profile=profile,
                source_implicit=codex_implicit(source_policy) if harness == "codex" else True,
                project=project, native_resolver=(native_resolvers or {}).get(harness),
            ))
        except InvocationError as exc:
            if mode != "conflicted":
                raise
            outcomes.append(_result(
                skill, harness, mode, mode_origin=mode_origin, profile=profile,
                project=project, support="unknown", implicit_behavior="unknown",
                explicit_behavior="unknown", mechanism="unresolved invocation intent",
                limitations=[str(exc)], delivery="pending", reason_code="conflicted-intent",
            ))
    native = {}
    if "codex" in harnesses:
        # Model-only enables model use even though hiding explicit invocation
        # cannot be enforced. Conflicted intent keeps the source unchanged.
        codex_outcome = next(row for row in outcomes if row["harness"] == "codex")
        if mode == "conflicted":
            rendered = source_policy
        elif codex_outcome["support"] == "unknown":
            rendered = None
        else:
            rendered = render_codex_policy(source_policy, mode)
        if rendered is not None:
            native["agents/openai.yaml"] = rendered
    return native, outcomes


def render_invocation_document(
    original: str, mode: str, *, renamed: str | None = None,
    native_files: Mapping[str, bytes], harnesses: set[str],
) -> str:
    """Render the document shared by local variants and remote projections."""
    from skill_hub.domain.skills.skill_meta import RENAME_VARIANT_MODE, render_invocation_frontmatter

    base = renamed if renamed is not None else original
    if mode in {RENAME_VARIANT_MODE, "conflicted"}:
        return base
    rendered = render_invocation_frontmatter(base, mode, generated_marker=True)
    if rendered is None:
        raise InvocationError("invalid skill frontmatter")
    if renamed is None and not native_files and (
        mode == "auto" or (mode == "user-only" and harnesses <= {"codex"})
    ):
        return original
    return rendered
