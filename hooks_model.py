"""Hook library model — definitions, attach lists, resolution (hooks-surface D1).

A hook is a named, provenance-aware definition stored under the registry's top-level
``hooks:`` map (``provenance: user``) OR shipped as a built-in at
``code_home()/hooks/<name>/hook.yaml`` (``provenance: builtin``). It is *attached*
at a scope via membership in ``hooks_global`` (global, machine-wide) or a project's
``projects.<n>.hooks`` list; per-project ``hook_settings`` deep-merge over a
definition's base ``settings``.

This module is pure model + resolution — it never writes native harness files (the
hook adapters / sync stream, a later wave, own that) and never mutates the registry
(the CLI wave owns writes; the migration in ``hub.load_registry`` is the sole
exception and lives in ``hub.py``). Warnings are emitted through an injectable
``warn`` callback so the sync stream can route them into its log and tests can
capture them; the default prints in hub's ``!``-prefixed style to stderr.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

try:
    import yaml
except ImportError:  # pragma: no cover - hub.py already hard-fails without yaml
    yaml = None  # type: ignore

WarnFn = Callable[[str], None]

VALID_PROVENANCE = ("user", "builtin")


def _default_warn(message: str) -> None:
    """Hub-style warning to stderr (keeps machine --json stdout clean)."""
    print(f"  ! {message}", file=sys.stderr)


def _resolve_warn(warn: Optional[WarnFn]) -> WarnFn:
    return warn if warn is not None else _default_warn


# ─────────────────────────────────────────────────────────────────────────────
# Definition + resolved shapes
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class HookDefinition:
    """One hook definition (registry entry or built-in).

    ``matcher`` is a raw regex escape hatch; when non-empty it WINS over ``tools``
    at translation time (D1 / spec). ``settings`` is free-form, consumed by the
    hook's own script; for built-ins the ``hook.yaml`` settings are the DEFAULTS
    that project ``hook_settings`` deep-merge over.
    """

    name: str
    event: str = ""
    command: str = ""
    description: str = ""
    tools: list[str] = field(default_factory=list)
    matcher: str = ""
    timeout: Optional[int] = None
    harnesses: Optional[list[str]] = None
    settings: dict[str, Any] = field(default_factory=dict)
    provenance: str = "user"

    def to_block(self) -> dict:
        """Registry block dict (round-trips through ``from_block``).

        Only non-default fields are emitted so a hand-written registry stays terse;
        ``provenance`` is NOT emitted (it is intrinsic — registry entries are always
        ``user``; built-ins are resolved from disk).
        """
        block: dict[str, Any] = {}
        if self.description:
            block["description"] = self.description
        block["event"] = self.event
        if self.tools:
            block["tools"] = list(self.tools)
        if self.matcher:
            block["matcher"] = self.matcher
        block["command"] = self.command
        if self.timeout is not None:
            block["timeout"] = self.timeout
        if self.harnesses is not None:
            block["harnesses"] = list(self.harnesses)
        if self.settings:
            block["settings"] = dict(self.settings)
        return block

    @classmethod
    def from_block(
        cls, name: str, block: dict, *, provenance: str = "user"
    ) -> "HookDefinition":
        """Tolerant parse of a definition block. Coerces scalar types; unusable
        collection types (non-list ``tools``/``harnesses``, non-dict ``settings``)
        fall back to safe empties rather than raising — malformed WHOLE entries are
        rejected upstream by the caller (which warns + skips)."""
        tools_raw = block.get("tools")
        tools = [str(t) for t in tools_raw] if isinstance(tools_raw, list) else []
        harnesses_raw = block.get("harnesses")
        harnesses = (
            [str(h) for h in harnesses_raw]
            if isinstance(harnesses_raw, list)
            else None
        )
        settings_raw = block.get("settings")
        settings = dict(settings_raw) if isinstance(settings_raw, dict) else {}
        timeout_raw = block.get("timeout")
        timeout: Optional[int]
        try:
            timeout = int(timeout_raw) if timeout_raw is not None else None
        except (TypeError, ValueError):
            timeout = None
        return cls(
            name=name,
            event=str(block.get("event") or ""),
            command=str(block.get("command") or ""),
            description=str(block.get("description") or ""),
            tools=tools,
            matcher=str(block.get("matcher") or ""),
            timeout=timeout,
            harnesses=harnesses,
            settings=settings,
            provenance=provenance,
        )


@dataclass
class ResolvedHook:
    """A hook attached at a scope, with settings merged for that scope.

    Harness-affinity + capability filtering happens at ADAPTER time (later wave) —
    ``harnesses`` is carried through unfiltered here.
    """

    name: str
    event: str
    command: str
    tools: list[str]
    matcher: str
    timeout: Optional[int]
    harnesses: Optional[list[str]]
    settings: dict[str, Any]
    provenance: str

    @classmethod
    def from_definition(
        cls, definition: HookDefinition, merged_settings: dict[str, Any]
    ) -> "ResolvedHook":
        return cls(
            name=definition.name,
            event=definition.event,
            command=definition.command,
            tools=list(definition.tools),
            matcher=definition.matcher,
            timeout=definition.timeout,
            harnesses=(
                list(definition.harnesses)
                if definition.harnesses is not None
                else None
            ),
            settings=merged_settings,
            provenance=definition.provenance,
        )


# ─────────────────────────────────────────────────────────────────────────────
# Deep merge
# ─────────────────────────────────────────────────────────────────────────────


def deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge ``override`` over ``base``. Project wins per-key; nested
    dicts merge recursively; non-dict values (incl. lists) replace wholesale."""
    result: dict = dict(base)
    for key, val in (override or {}).items():
        if isinstance(val, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], val)
        else:
            result[key] = val
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Registry + built-in parsing
# ─────────────────────────────────────────────────────────────────────────────


def parse_registry_hooks(
    registry: dict, *, warn: Optional[WarnFn] = None
) -> dict[str, HookDefinition]:
    """Parse the top-level ``hooks:`` map. Malformed entries are skipped + warned."""
    _warn = _resolve_warn(warn)
    raw = (registry or {}).get("hooks") or {}
    if not isinstance(raw, dict):
        _warn("registry `hooks:` is not a map — ignoring all definitions")
        return {}
    out: dict[str, HookDefinition] = {}
    for name, block in raw.items():
        if not isinstance(block, dict):
            _warn(f"hook '{name}': definition is not a map — skipped")
            continue
        out[str(name)] = HookDefinition.from_block(
            str(name), block, provenance="user"
        )
    return out


def builtin_hooks_dir(code_home: Optional[Path] = None) -> Path:
    if code_home is None:
        import hub

        code_home = hub.code_home()
    return Path(code_home) / "hooks"


def load_builtin_hooks(
    code_home: Optional[Path] = None, *, warn: Optional[WarnFn] = None
) -> dict[str, HookDefinition]:
    """Scan ``code_home/hooks/<name>/hook.yaml`` for built-in definitions.

    Each sub-directory is one built-in; the DIR name is authoritative (a ``name:``
    inside hook.yaml is ignored). An absent/empty ``hooks/`` dir yields ``{}`` with
    no error (the lsp-report wave creates it). A malformed hook.yaml is skipped +
    warned. Built-in ``settings`` are the DEFAULTS.
    """
    _warn = _resolve_warn(warn)
    root = builtin_hooks_dir(code_home)
    try:
        entries = sorted(p for p in root.iterdir() if p.is_dir())
    except (FileNotFoundError, NotADirectoryError):
        return {}
    except OSError as exc:  # pragma: no cover - defensive
        _warn(f"cannot scan built-in hooks dir {root}: {exc}")
        return {}
    out: dict[str, HookDefinition] = {}
    for entry in entries:
        hook_yaml = entry / "hook.yaml"
        if not hook_yaml.exists():
            continue
        if yaml is None:  # pragma: no cover
            _warn(f"built-in hook '{entry.name}': pyyaml unavailable — skipped")
            continue
        try:
            block = yaml.safe_load(hook_yaml.read_text()) or {}
        except (OSError, yaml.YAMLError) as exc:
            _warn(f"built-in hook '{entry.name}': unreadable hook.yaml ({exc}) — skipped")
            continue
        if not isinstance(block, dict):
            _warn(f"built-in hook '{entry.name}': hook.yaml is not a map — skipped")
            continue
        out[entry.name] = HookDefinition.from_block(
            entry.name, block, provenance="builtin"
        )
    return out


def resolve_definition(
    name: str,
    registry_defs: dict[str, HookDefinition],
    builtin_defs: dict[str, HookDefinition],
    *,
    warn: Optional[WarnFn] = None,
) -> Optional[HookDefinition]:
    """Resolve one name: a registry definition SHADOWS a same-named built-in (warn);
    otherwise the built-in; otherwise ``None`` (dangling — caller warns + omits)."""
    _warn = _resolve_warn(warn)
    if name in registry_defs:
        if name in builtin_defs:
            _warn(
                f"hook '{name}': registry definition shadows the built-in of the "
                f"same name (using the registry definition)"
            )
        return registry_defs[name]
    if name in builtin_defs:
        return builtin_defs[name]
    return None


def all_definitions(
    registry: dict,
    *,
    code_home: Optional[Path] = None,
    warn: Optional[WarnFn] = None,
) -> dict[str, HookDefinition]:
    """Every resolvable definition by name (registry shadowing built-ins). Used by
    ``list``/UI surfaces."""
    registry_defs = parse_registry_hooks(registry, warn=warn)
    builtin_defs = load_builtin_hooks(code_home, warn=warn)
    merged: dict[str, HookDefinition] = dict(builtin_defs)
    for name, definition in registry_defs.items():
        if name in builtin_defs:
            _resolve_warn(warn)(
                f"hook '{name}': registry definition shadows the built-in of the "
                f"same name (using the registry definition)"
            )
        merged[name] = definition
    return merged


# ─────────────────────────────────────────────────────────────────────────────
# Attach resolution
# ─────────────────────────────────────────────────────────────────────────────


def _dedupe(names: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _attached_project_names(project: dict, registry: dict) -> list[str]:
    global_names = list((registry or {}).get("hooks_global") or [])
    project_names = list((project or {}).get("hooks") or [])
    return _dedupe([str(n) for n in global_names + project_names])


def resolve_project_hooks(
    project_name: str,
    registry: dict,
    *,
    code_home: Optional[Path] = None,
    warn: Optional[WarnFn] = None,
) -> list[ResolvedHook]:
    """Resolve the hooks attached to a project.

    Attached set = ``hooks_global ∪ project.hooks`` (order preserved, deduped). Each
    name is resolved registry-then-builtin; a dangling name (neither) is warned and
    omitted. Settings = definition defaults deep-merged with the project's
    ``hook_settings[name]`` (project wins per-key). Orphaned ``hook_settings`` keys
    (a name not attached to this project) are warned + pruned from the resolved view
    — the registry is NOT rewritten. Harness-affinity/capability filtering is the
    adapter wave's job; ``harnesses`` is carried through here.
    """
    _warn = _resolve_warn(warn)
    projects = (registry or {}).get("projects") or {}
    project = projects.get(project_name) or {}
    registry_defs = parse_registry_hooks(registry, warn=warn)
    builtin_defs = load_builtin_hooks(code_home, warn=warn)

    attached = _attached_project_names(project, registry)
    attached_set = set(attached)

    hook_settings = project.get("hook_settings") or {}
    if isinstance(hook_settings, dict):
        for settings_name in hook_settings:
            if str(settings_name) not in attached_set:
                _warn(
                    f"project '{project_name}': hook_settings for '{settings_name}' "
                    f"is not attached to this project — pruned from the resolved view"
                )
    else:
        hook_settings = {}

    resolved: list[ResolvedHook] = []
    for name in attached:
        definition = resolve_definition(
            name, registry_defs, builtin_defs, warn=warn
        )
        if definition is None:
            _warn(
                f"project '{project_name}': attached hook '{name}' resolves to no "
                f"definition or built-in — omitted"
            )
            continue
        override = hook_settings.get(name) if isinstance(hook_settings, dict) else None
        merged = deep_merge(
            definition.settings, override if isinstance(override, dict) else {}
        )
        resolved.append(ResolvedHook.from_definition(definition, merged))
    return resolved


def resolve_global_hooks(
    registry: dict,
    *,
    code_home: Optional[Path] = None,
    warn: Optional[WarnFn] = None,
) -> list[ResolvedHook]:
    """Resolve globally-attached hooks (``hooks_global`` only).

    Global settings = each definition's base ``settings`` (there is no global
    ``hook_settings`` override tier in v1 — D1). Dangling names warned + omitted.
    """
    _warn = _resolve_warn(warn)
    registry_defs = parse_registry_hooks(registry, warn=warn)
    builtin_defs = load_builtin_hooks(code_home, warn=warn)
    attached = _dedupe([str(n) for n in ((registry or {}).get("hooks_global") or [])])
    resolved: list[ResolvedHook] = []
    for name in attached:
        definition = resolve_definition(
            name, registry_defs, builtin_defs, warn=warn
        )
        if definition is None:
            _warn(
                f"global hook '{name}' resolves to no definition or built-in — omitted"
            )
            continue
        resolved.append(
            ResolvedHook.from_definition(definition, dict(definition.settings))
        )
    return resolved
