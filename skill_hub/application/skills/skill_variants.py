"""Invocation-override / rename variants and the per-project skill pass.

Cut verbatim out of hub.py (wave 23g of AUDIT.md). Not a leaf until wave 23h:
`_demanded_variant_names` and `_sync_project_skills` read `resolve_project_skills`,
`new_project_report` and `_skill_affinity`, which stay in hub.py until the sync
engine moves, through a function-local `import hub` — call-time reads, so a
`hub.<name>` stub still lands. `data_home` is read as `hub_core.data_home()`.
Module scope imports hub_core, skill_meta, sources, sync_links and mcp_sync; the
`harnesses` / `mcp_adapters` / `skill_refs` imports stay function-local as they
were. hub.py re-imports every name so `hub.<name>` keeps resolving.

Stub visibility: `effective_skill_source` and `ensure_skill_variant` call
`_write_skill_variant` through this module's globals, so the two tests that
stub it (tests/test_invocation.py, tests/test_source_rename_variants.py) patch
`skill_variants._write_skill_variant`, not `hub.` — repointed in wave 23g. The
same holds for every other intra-module call (`_sync_project_skills` →
`effective_skill_source` / `_apply_invocation_override` / `project_sync_skip_reason`,
`_cleanup_variant_orphans` → `_demanded_variant_names`, …): a stub for one of
those goes on `skill_variants.<name>`. The reverse holds too: hub.py's
`_sync_global_skills` / `_cmd_sync_body` and the two stream modules still call
`effective_skill_source`, `_sync_project_skills`, `_cleanup_variant_orphans`
and `project_sync_skip_reason` through hub.py's re-exported binding, so a
`hub.<name>` stub reaches THOSE callers but not the per-project pass here (one
binding became two; wave 23h moves the engine and narrows this).
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Mapping, Optional

from skill_hub import hub_core
from skill_hub.application.skills.skill_invocation import (
    InvocationError,
    codex_implicit,
    render_invocation_document,
    render_native_invocation,
    resolve_invocation,
)
from skill_hub.application.sync.mcp_sync import _representative_harness, project_has_mcp_target, sync_mcp_for_project
from skill_hub.domain.skills.skill_meta import (
    RENAME_VARIANT_MODE,
    VALID_INVOCATIONS,
    render_invocation_frontmatter,
    skill_invocation,
    skill_rename_patch,
    skill_source,
)
from skill_hub.hub_core import BOLD, CYAN, DIM, GREEN, RED, YELLOW, c, expand
from skill_hub.infrastructure.filesystem.sync_links import ensure_symlink, is_hub_owned_link, link_target_abs
from skill_hub.infrastructure.registry.sources import skills_from_disabled_sources

# ─────────────────────────────────────────────────────────────────────────────
# Invocation-override variants
#
# A per-project invocation override can't ride the shared library symlink (one
# SKILL.md, one frontmatter). Instead the project's symlink is pointed at a
# generated VARIANT dir in data_home: a real SKILL.md with patched frontmatter
# plus per-entry symlinks back to the library dir. The project-side entry stays
# a symlink whose readlink target is under data_home, so every ownership /
# cleanup / scanner path keeps working unchanged. Variants are keyed by
# (skill, mode) and shared across projects; the whole tree is regenerable.
# ─────────────────────────────────────────────────────────────────────────────


def skill_variants_root(operation_context=None) -> Path:
    """Return the variant store for this operation's captured data home."""
    if operation_context is not None:
        raw = getattr(operation_context, "data_home", None)
        if raw:
            return Path(raw) / "state" / "skill_variants"
        # A malformed captured context must fail closed rather than write to
        # whichever ambient data home happens to be active.
        return Path(os.devnull) / "skill_variants"
    return hub_core.data_home() / "state" / "skill_variants"


def _layout(operation_context, harness_id: str):
    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses

        return harnesses.HARNESSES.get(harness_id)
    try:
        return operation_context.layout(harness_id)
    except AttributeError:
        return None


def _route_available(operation_context, harness_id: str, feature: str = "skills") -> bool:
    if operation_context is None:
        return _layout(None, harness_id) is not None
    layout = _layout(operation_context, harness_id)
    try:
        route = operation_context.route(harness_id, feature)
    except AttributeError:
        return False
    return (
        layout is not None
        and getattr(layout, "status", None) != "unavailable"
        and getattr(route, "status", "unavailable") == "shadow"
        and getattr(route, "mode", "unavailable") == "legacy_shadow"
    )


def _layouts(operation_context):
    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses

        return dict(harnesses.HARNESSES)
    out = {}
    for harness_id in getattr(operation_context, "harness_ids", ()):
        layout = _layout(operation_context, harness_id)
        if layout is not None:
            out[harness_id] = layout
    return out


def _opencode_paths(operation_context):
    """Return the captured OpenCode path snapshot when one is supplied."""
    return (
        getattr(operation_context, "opencode_paths", None)
        if operation_context is not None
        else None
    )


def _variant_dir_name(skill_name: str, mode: str, native_key: str | None = None) -> str:
    """Return a stable variant name.

    The old two-part names remain stable for frontmatter-only variants. Native
    payloads get a suffix so a profile or destination change cannot reuse an
    artifact containing the wrong policy.
    """
    return f"{skill_name}@{mode}" + (f"@{native_key}" if native_key else "")


def _source_fingerprint(src: Path) -> str:
    digest = hashlib.sha256()
    try:
        digest.update(str(src.resolve()).encode("utf-8"))
        entries = sorted(p for p in src.rglob("*") if not p.is_dir())
        for path in entries:
            digest.update(str(path.relative_to(src)).encode())
            try:
                digest.update(path.read_bytes())
            except OSError:
                continue
        # `Path.rglob` does not descend through a symlinked agents directory,
        # but the native policy remains part of the source contract.
        policy = src / "agents" / "openai.yaml"
        if policy.is_file():
            digest.update(b"agents/openai.yaml")
            digest.update(policy.read_bytes())
    except OSError:
        return ""
    return digest.hexdigest()


def _payload_identity(
    patched: str, native_files: dict[str, bytes], native_key: str
) -> str:
    digest = hashlib.sha256()
    digest.update(patched.encode("utf-8"))
    for name, payload in sorted(native_files.items()):
        digest.update(name.encode("utf-8"))
        digest.update(payload)
    return f"{native_key}-{digest.hexdigest()[:16]}"


def _cached_invocation_profiles() -> dict:
    """Read the parent-owned capability cache without probing from sync helpers."""
    try:
        from skill_hub.infrastructure.harnesses import harness_probe

        cached = harness_probe.cached_invocations()
        return cached if isinstance(cached, dict) else {}
    except (ImportError, AttributeError, OSError, ValueError, TypeError):
        return {}


def _profiles_from_context(operation_context) -> Optional[dict]:
    if operation_context is None:
        return None
    observations = getattr(operation_context, "invocation_observations", None)
    if not isinstance(observations, dict) and observations is not None:
        try:
            observations = dict(observations)
        except (TypeError, ValueError):
            return {}
    if not observations:
        return {}
    return {
        str(harness): dict(observation)
        for harness, observation in observations.items()
        if isinstance(observation, Mapping)
    }


def _profile_for(harness: str, profiles: Optional[dict] = None) -> str:
    source = _cached_invocation_profiles() if profiles is None else profiles
    value = source.get(harness, {})
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("profile") or "unknown")
    return "unknown"


def _opencode_selection_unavailable(operation_context) -> bool:
    """Whether this operation must retain all existing opencode consumers."""
    if operation_context is None:
        return False
    harness_ids = getattr(operation_context, "harness_ids", ())
    if "opencode" not in harness_ids:
        return False
    if _opencode_paths(operation_context) is None:
        return True
    if not _route_available(operation_context, "opencode", "skills"):
        return True
    profile_getter = getattr(operation_context, "trusted_invocation_profile", None)
    if not callable(profile_getter):
        return True
    return profile_getter("opencode") is None


def _resolve_outcome(
    skill_name: str,
    harness: str,
    mode: str,
    *,
    mode_origin: str,
    project: Optional[str],
    source: Optional[bytes],
    delivery: str = "pending",
    profiles: Optional[dict] = None,
    input_fingerprint: Optional[str] = None,
    operation_context=None,
    profile_override: Optional[str] = None,
) -> dict:
    profile = profile_override if profile_override is not None else _profile_for(harness, profiles)
    source_implicit = codex_implicit(source) if harness == "codex" else True
    result = resolve_invocation(
        skill_name,
        harness,
        mode,
        mode_origin=mode_origin,
        profile=profile,
        source_implicit=source_implicit,
        project=project,
        delivery=delivery,
        native_resolver=(
            operation_context.trusted_invocation_resolver(harness)
            if operation_context is not None else None
        ),
    )
    row = dict(result) if isinstance(result, dict) else {}
    row.setdefault("skill", skill_name)
    row.setdefault("harness", harness)
    row.setdefault("project", project)
    row.setdefault("requested_mode", mode)
    row.setdefault("mode_origin", mode_origin)
    row.setdefault("capability_profile", profile)
    row.setdefault("delivery", delivery)
    row.setdefault("input_fingerprint", input_fingerprint or "")
    row.setdefault("observed_at", hub_core._now_iso())
    return row


def _native_payload(
    src: Path,
    harnesses: set[str],
    mode: str,
    *,
    profiles: Optional[dict] = None,
    mode_origin: str = "library",
    project: Optional[str] = None,
    operation_context=None,
) -> tuple[dict[str, bytes], Optional[str], list[dict]]:
    """Read local source state around the shared CLI invocation renderer."""
    source_bytes = None
    if "codex" in harnesses:
        policy_path = src / "agents" / "openai.yaml"
        try:
            source_bytes = policy_path.read_bytes() if policy_path.is_file() else None
        except OSError as exc:
            raise InvocationError(str(exc)) from exc
    resolved_profiles = {harness: _profile_for(harness, profiles) for harness in harnesses}
    native, outcomes = render_native_invocation(
        src.name, harnesses, mode, source_bytes, profiles=resolved_profiles,
        mode_origin=mode_origin, project=project,
        native_resolvers={h: operation_context.trusted_invocation_resolver(h) for h in harnesses}
        if operation_context is not None else None,
    )
    for row in outcomes:
        row["input_fingerprint"] = _source_fingerprint(src)
        row["observed_at"] = hub_core._now_iso()
    native_key = f"codex-{resolved_profiles['codex']}" if native else None
    return native, native_key, outcomes


def effective_skill_source(
    skill_name: str,
    skill_cfg: dict,
    rec: Optional[dict] = None,
    cache: Optional[dict] = None,
    operation_context=None,
) -> Path:
    """The dir a symlink for this skill must point at.

    The library/checkout dir, except for a renamed source-managed skill, where it
    is a materialized rename variant whose SKILL.md declares the registry key.
    Any filesystem failure degrades to the unpatched source (a wrong-named skill
    beats an aborted sync), exactly like the invocation variants.

    `cache` is a per-SYNC-RUN memo (`{skill_name: resolved_path}`) owned by
    `cmd_sync`: a rename variant is one dir shared by every project, so
    reconciling it once per (project, skill) pair re-read and re-walked the same
    tree N times. Callers OUTSIDE a sync run pass no cache and always reconcile,
    so an export or a provision never trusts a stale decision.
    """
    if cache is not None and skill_name in cache:
        return cache[skill_name]
    src = skill_source(skill_cfg)
    patched = skill_rename_patch(skill_name, skill_cfg)
    if patched is None:
        if cache is not None:
            cache[skill_name] = src
        return src
    try:
        vdir, writes = _write_skill_variant(
            skill_name,
            src,
            RENAME_VARIANT_MODE,
            patched,
            operation_context=operation_context,
        )
    except OSError as exc:
        print(
            f"  {c('!', YELLOW)} rename variant write failed for '{skill_name}' "
            f"({exc}) — syncing the upstream copy under its own name",
            file=sys.stderr,
        )
        return src
    if rec is not None:
        rec["writes"] += writes
    if cache is not None:
        cache[skill_name] = vdir
    return vdir


def ensure_skill_variant(
    skill_name: str, src: Path, mode: str, operation_context=None
) -> Optional[tuple[Path, int]]:
    """Create/refresh the variant dir for (skill, mode). Deterministic and
    byte-stable: derives desired content from the current library copy and
    writes only what differs. Returns (variant_dir, writes) or None when the
    library SKILL.md is unreadable/unparseable (caller falls back to the
    direct, unpatched symlink)."""
    try:
        text = (src / "SKILL.md").read_text()
    except OSError:
        return None
    patched = render_invocation_frontmatter(text, mode, generated_marker=True)
    if patched is None:
        return None

    try:
        return _write_skill_variant(
            skill_name, src, mode, patched, operation_context=operation_context
        )
    except OSError as exc:
        print(
            f"  {c('!', YELLOW)} variant write failed for '{skill_name}' ({exc}) — "
            f"falling back to the library copy",
            file=sys.stderr,
        )
        return None


def _ensure_combined_variant(
    skill_name: str,
    src: Path,
    mode: str,
    *,
    renamed: Optional[str] = None,
    native_harnesses: Optional[set[str]] = None,
    mode_origin: str = "library",
    project: Optional[str] = None,
    profiles: Optional[dict] = None,
    native_mode: Optional[str] = None,
    operation_context=None,
) -> tuple[Path, int, list[dict]]:
    """Build one variant from the original source and all requested edits."""
    try:
        original = (src / "SKILL.md").read_text()
    except OSError as exc:
        raise InvocationError(str(exc)) from exc
    native_target_harnesses = native_harnesses or set()
    native_mode_for_render = native_mode or mode
    native_files, native_key, outcomes = _native_payload(
        src,
        native_target_harnesses,
        native_mode_for_render,
        profiles=profiles,
        mode_origin=mode_origin,
        project=project,
        operation_context=operation_context,
    )
    patched = render_invocation_document(
        original, mode, renamed=renamed, native_files=native_files,
        harnesses=native_target_harnesses,
    )
    for row in outcomes:
        row["skill"] = skill_name
        row["project"] = project
        row["mode_origin"] = mode_origin
        row["requested_mode"] = native_mode or mode
        row["input_fingerprint"] = _source_fingerprint(src)
    # If native output was unnecessary and this is a direct source copy, no
    # variant is needed. Rename and frontmatter edits still require one.
    # Codex native policies are snapshotted above even when no edit is needed,
    # preserving a working policy if the upstream later becomes malformed.
    if (
        renamed is None
        and not native_files
        and (
            mode == "auto"
            or mode == "conflicted"
            or (mode == "user-only" and native_target_harnesses <= {"codex"})
        )
    ):
        return src, 0, outcomes
    if native_files:
        if native_key is not None:
            native_key = _payload_identity(patched, native_files, native_key)
        if native_key is None:
            raise InvocationError("native payload is missing its identity", code="native-identity")
        vdir, writes = _write_native_variant_atomic(
            skill_name,
            src,
            mode,
            patched,
            native_files,
            native_key,
            operation_context=operation_context,
        )
    else:
        vdir, writes = _write_skill_variant(
            skill_name, src, mode, patched, operation_context=operation_context
        )
    return vdir, writes, outcomes


def _remove_variant_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def _native_variant_matches(
    vdir: Path, src: Path, patched: str, native_files: dict[str, bytes]
) -> bool:
    if not vdir.is_dir() or vdir.is_symlink():
        return False
    try:
        if (vdir / "SKILL.md").read_text() != patched:
            return False
        source_entries = {
            entry.name: entry
            for entry in src.iterdir()
            if entry.name not in {"SKILL.md", "agents"}
        }
        for name, target in source_entries.items():
            link = vdir / name
            if not link.is_symlink() or os.readlink(link) != str(target):
                return False
        if set(p.name for p in vdir.iterdir()) - {"SKILL.md", "agents"} != set(
            source_entries
        ):
            return False
        agents = vdir / "agents"
        if not agents.is_dir() or agents.is_symlink():
            return False
        source_agents = src / "agents"
        source_agent_entries = (
            {entry.name: entry for entry in source_agents.iterdir()}
            if source_agents.is_dir()
            else {}
        )
        for name, target in source_agent_entries.items():
            link = agents / name
            if name == "openai.yaml" and "agents/openai.yaml" in native_files:
                continue
            if not link.is_symlink() or os.readlink(link) != str(target):
                return False
        for rel, payload in native_files.items():
            target = vdir / rel
            if not target.is_file() or target.is_symlink() or target.read_bytes() != payload:
                return False
        expected_agents = set(source_agent_entries)
        if "agents/openai.yaml" in native_files:
            expected_agents.discard("openai.yaml")
        expected_agents.update(
            Path(rel).relative_to("agents").parts[0] for rel in native_files
        )
        if {entry.name for entry in agents.iterdir()} != expected_agents:
            return False
        return True
    except OSError:
        return False


def _write_native_variant_atomic(
    skill_name: str,
    src: Path,
    mode: str,
    patched: str,
    native_files: dict[str, bytes],
    native_key: str,
    operation_context=None,
) -> tuple[Path, int]:
    root = skill_variants_root(operation_context)
    vdir = root / _variant_dir_name(skill_name, mode, native_key)
    if _native_variant_matches(vdir, src, patched, native_files):
        return vdir, 0
    root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{vdir.name}.stage-", dir=str(root)))
    backup: Optional[Path] = None
    try:
        _stage_dir, writes = _write_skill_variant(
            skill_name,
            src,
            mode,
            patched,
            native_files=native_files,
            native_key=native_key,
            _destination=stage,
            operation_context=operation_context,
        )
        if vdir.exists() or vdir.is_symlink():
            backup = root / f".{vdir.name}.previous-{os.getpid()}"
            _remove_variant_path(backup)
            os.replace(vdir, backup)
        os.replace(stage, vdir)
        if backup is not None:
            _remove_variant_path(backup)
        return vdir, writes + 1
    except BaseException:
        if stage.exists() or stage.is_symlink():
            _remove_variant_path(stage)
        if backup is not None and not (vdir.exists() or vdir.is_symlink()):
            os.replace(backup, vdir)
        raise


def _write_skill_variant(
    skill_name: str,
    src: Path,
    mode: str,
    patched: str,
    *,
    native_files: Optional[dict[str, bytes]] = None,
    native_key: Optional[str] = None,
    _destination: Optional[Path] = None,
    operation_context=None,
) -> tuple[Path, int]:
    native_files = native_files or {}
    vdir = _destination or (
        skill_variants_root(operation_context)
        / _variant_dir_name(skill_name, mode, native_key)
    )
    writes = 0
    if not vdir.is_dir():
        if vdir.is_symlink() or vdir.exists():
            vdir.unlink()
        vdir.mkdir(parents=True)
        writes += 1

    # One real, patched SKILL.md.
    dst_md = vdir / "SKILL.md"
    current = None
    if dst_md.is_file() and not dst_md.is_symlink():
        try:
            current = dst_md.read_text()
        except OSError:
            current = None
    if current != patched:
        if dst_md.is_symlink() or dst_md.is_file():
            dst_md.unlink()
        elif dst_md.is_dir():
            shutil.rmtree(dst_md)
        dst_md.write_text(patched)
        writes += 1

    # Every other library entry: an absolute symlink back into the library dir.
    # `agents/` is materialized only when a native file is patched. This avoids
    # ever writing through a source directory symlink.
    expected: dict[str, Path] = {
        entry.name: entry
        for entry in src.iterdir()
        if entry.name != "SKILL.md" and not (entry.name == "agents" and native_files)
    }
    for entry_name, target in sorted(expected.items()):
        link = vdir / entry_name
        if link.is_symlink():
            if os.readlink(link) == str(target):
                continue
            link.unlink()
        elif link.exists():
            shutil.rmtree(link) if link.is_dir() else link.unlink()
        link.symlink_to(target)
        writes += 1

    if native_files:
        expected["agents"] = src / "agents"
        agents = vdir / "agents"
        if agents.is_symlink() or (agents.exists() and not agents.is_dir()):
            agents.unlink()
            writes += 1
        if not agents.exists():
            agents.mkdir(parents=True)
            writes += 1
        source_agents = src / "agents"
        source_entries: dict[str, Path] = {}
        if source_agents.is_dir():
            source_entries = {
                entry.name: entry for entry in source_agents.iterdir()
            }
        for rel, payload in sorted(native_files.items()):
            rel_path = Path(rel)
            if not rel_path.parts or rel_path.parts[0] != "agents":
                raise InvocationError(f"native payload outside agents/: {rel}")
            target = vdir / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            native_current: Optional[bytes] = None
            if target.is_file() and not target.is_symlink():
                try:
                    native_current = target.read_bytes()
                except OSError:
                    native_current = None
            if native_current != payload:
                tmp = target.with_name(target.name + ".tmp")
                tmp.write_bytes(payload)
                os.replace(tmp, target)
                writes += 1
        expected_agents = set(source_entries) | {
            str(Path(rel).relative_to("agents")).split("/", 1)[0]
            for rel in native_files
            if len(Path(rel).parts) > 1
        }
        for name, target in sorted(source_entries.items()):
            if name == "openai.yaml" and "agents/openai.yaml" in native_files:
                continue
            link = agents / name
            if link.is_symlink() and os.readlink(link) == str(target):
                continue
            if link.is_symlink() or link.exists():
                if link.is_dir() and not link.is_symlink():
                    shutil.rmtree(link)
                else:
                    link.unlink()
            link.symlink_to(target)
            writes += 1
        for entry in list(agents.iterdir()):
            if entry.name in expected_agents or entry.name == "openai.yaml":
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
            writes += 1

    # Reconcile: drop variant entries the library no longer has.
    for entry in list(vdir.iterdir()):
        if entry.name == "SKILL.md" or entry.name in expected:
            continue
        if entry.is_symlink() or entry.is_file():
            entry.unlink()
        else:
            shutil.rmtree(entry)
        writes += 1

    return vdir, writes


def _apply_invocation_override(
    skill_name: str,
    cfg: dict,
    src: Path,
    mode: str,
    rec: Optional[dict],
    operation_context=None,
) -> Path:
    """Resolve the symlink source for an overridden (project, skill): a patched
    variant dir, or `src` unchanged when the override is inert/elided/broken."""
    if mode not in VALID_INVOCATIONS:
        print(
            f"    {c('!', YELLOW)} invocation override for '{skill_name}' has "
            f"unknown mode '{mode}' — ignored"
        )
        return src
    if cfg.get("scope", "portable") == "global":
        print(
            f"    {c('!', YELLOW)} invocation override for '{skill_name}' is inert: "
            f"scope is global (user-level skills take precedence in Claude Code)"
        )
        return src
    if skill_invocation(cfg) == mode:
        return src  # override equals the library mode — link straight through
    result = ensure_skill_variant(
        skill_name, src, mode, operation_context=operation_context
    )
    if result is None:
        print(
            f"    {c('!', YELLOW)} cannot patch '{skill_name}' frontmatter for the "
            f"invocation override — syncing the library copy unpatched"
        )
        return src
    vdir, writes = result
    if rec is not None:
        rec["writes"] += writes
    print(f"    {c('·', CYAN)} invocation override: {skill_name} → {mode}")
    return vdir


def _demanded_variant_names(registry: dict, operation_context=None) -> set[str]:
    """Variant dir names demanded by the current registry (same gates as
    `_apply_invocation_override`, recomputed for cleanup).

    Mirrors `_sync_project_skills`: a disabled source's skills are inactive, so
    the variant dirs they demanded become orphans and get collected.
    """
    import hub

    skills = registry.get("skills") or {}
    inactive = skills_from_disabled_sources(registry)
    demanded: set[str] = set()

    # Compute variant demand from the same effective mode/destination pairs as
    # delivery. This also lets a native payload replace an old `<skill>@mode`
    # artifact without retaining the old name indefinitely.
    global_harnesses = set(registry.get("harnesses_global") or [])
    for s_name, cfg in skills.items():
        if s_name in inactive:
            continue
        rename = skill_rename_patch(s_name, cfg) is not None
        if cfg.get("scope") == "global":
            consumers = [(None, global_harnesses)]
        else:
            consumers = []
            for pname, proj_cfg in (registry.get("projects") or {}).items():
                if s_name in set(hub.resolve_project_skills(proj_cfg, registry)):
                    consumers.append((pname, global_harnesses | set(proj_cfg.get("harnesses") or [])))
        for _consumer, harnesses in consumers:
            mode = skill_invocation(cfg)
            if mode not in VALID_INVOCATIONS:
                mode = "auto"
            if mode == "auto" and rename:
                demanded.add(_variant_dir_name(s_name, RENAME_VARIANT_MODE))
            elif mode != "auto":
                # Native variants carry a content/profile-derived suffix.  The
                # resolver cannot safely predict that identity from registry
                # harness membership alone (affinity, installed consumers and
                # destination grouping all affect it).  Live consumer links
                # are added below by `_linked_variant_names`; retain only the
                # stable frontmatter variant name here for legacy artifacts.
                demanded.add(_variant_dir_name(s_name, mode))

    for proj_cfg in (registry.get("projects") or {}).values():
        overrides = proj_cfg.get("invocation_overrides") or {}
        if not overrides:
            continue
        active = set(hub.resolve_project_skills(proj_cfg, registry)) - set(inactive)
        for s_name, mode in overrides.items():
            cfg = skills.get(s_name)
            if not cfg or cfg.get("type") == "mcp-server":
                continue
            if s_name not in active:
                continue
            if cfg.get("scope", "portable") == "global":
                continue
            if mode not in VALID_INVOCATIONS or skill_invocation(cfg) == mode:
                continue
            target_harnesses = global_harnesses | set(proj_cfg.get("harnesses") or [])
            demanded.add(_variant_dir_name(s_name, mode))
    return demanded


def _cleanup_variant_orphans(registry: dict, operation_context=None) -> int:
    """Remove variant dirs no current (project, skill) override demands."""
    root = skill_variants_root(operation_context)
    if not root.is_dir():
        return 0
    demanded = _demanded_variant_names(registry, operation_context)
    linked, uncertain = _linked_variant_names(registry, root, operation_context)
    if uncertain:
        # A skipped/quarantined consumer may have an unreadable or currently
        # absent destination. Conservatively retain every generated artifact;
        # the next successful reconciliation can prove its consumers.
        return 0
    demanded |= linked
    removed = 0
    for entry in sorted(root.iterdir()):
        if entry.name in demanded:
            continue
        if entry.is_symlink() or entry.is_file():
            entry.unlink()
        else:
            shutil.rmtree(entry)
        removed += 1
        print(f"  {c('✗', RED)} removed orphaned variant: {entry.name}")
    return removed


def _linked_variant_names(
    registry: dict, root: Path, operation_context=None
) -> tuple[set[str], bool]:
    """Return generated targets still named by native consumers.

    Cleanup is intentionally consumer-led. Registry mode guesses cannot tell
    whether a Codex edit was actually needed, which profile produced a payload,
    or whether a quarantined project still points at a last-good artifact.
    """
    try:
        # Consumer targets are resolved too, including aliases such as /tmp.
        root = root.resolve()
    except (OSError, RuntimeError):
        return set(), True
    linked: set[str] = set()
    uncertain = False
    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses as _harnesses

        layouts = dict(_harnesses.HARNESSES)
    else:
        layouts = _layouts(operation_context)
    dirs: list[tuple[Path, bool]] = []
    global_harnesses = set(registry.get("harnesses_global") or [])
    known_harnesses = set(layouts)
    if operation_context is not None:
        referenced = set(global_harnesses)
        for proj_cfg in (registry.get("projects") or {}).values():
            referenced.update(proj_cfg.get("harnesses") or [])
        # A captured context is authoritative. If any requested consumer is
        # missing or unavailable, an old variant may still be its last-good
        # target, so leave the complete store intact.
        for harness_id in referenced:
            if harness_id not in known_harnesses or not _route_available(
                operation_context, harness_id, "skills"
            ):
                uncertain = True
        for harness_id, layout in layouts.items():
            if _route_available(operation_context, harness_id, "skills"):
                dirs.append((Path(str(layout.global_skills_dir)).expanduser(), False))
    else:
        dirs.extend(
            (Path(str(h.global_skills_dir)).expanduser(), False)
            for h in layouts.values()
        )
    for proj_cfg in (registry.get("projects") or {}).values():
        reason = project_sync_skip_reason(proj_cfg)
        raw = proj_cfg.get("path") if isinstance(proj_cfg, dict) else None
        if reason and (not raw or not expand(str(raw)).exists()):
            uncertain = True
            continue
        if not raw:
            uncertain = True
            continue
        base = expand(str(raw))
        for harness_id, layout in layouts.items():
            if operation_context is not None and not _route_available(
                operation_context, harness_id, "skills"
            ):
                continue
            dirs.append((base / Path(str(layout.project_skills_dir)), bool(reason)))
    for directory, mandatory in set(dirs):
        if not directory.exists() or directory.is_symlink():
            if mandatory:
                uncertain = True
            continue
        try:
            entries = list(directory.iterdir())
        except OSError:
            uncertain = True
            continue
        for entry in entries:
            if not entry.is_symlink():
                continue
            try:
                target = entry.resolve()
                if target.parent == root or str(target).startswith(str(root) + os.sep):
                    linked.add(target.name)
            except (OSError, ValueError):
                uncertain = True
    return linked, uncertain


def project_sync_skip_reason(proj_cfg: dict) -> Optional[str]:
    """Why sync must not touch this project, or None if it is safe to sync.

    Two cases, one fix:

    * `path_unresolved: true` — set by `hub restore` until the user validates
      a local attachment. A historical path may exist but belong to another
      checkout. The entry is deliberately kept so nothing is lost.
    * the path simply is not there — the same situation, reached without a
      restore (a moved or deleted repo).

    Either way every per-project writer must skip. Before this guard, sync
    happily `mkdir -p`'d `<nonexistent>/.claude/skills/` and friends, conjuring
    a phantom tree at a path the user never created — and, worse, the Codex
    permission adapter would auto-grant `trust_level = "trusted"` on that path,
    so a later real checkout there would start out pre-trusted. Cleared by
    `hub project edit-path`.
    """
    if not isinstance(proj_cfg, dict):
        return None
    if proj_cfg.get("path_unresolved"):
        return (
            "path_unresolved (restored from a backup) — run "
            "`hub project edit-path <name> <path>`"
        )
    raw = proj_cfg.get("path")
    if not raw:
        return "no path recorded"
    path = expand(str(raw))
    if not path.exists():
        return "path does not exist: " + str(raw)
    if not path.is_dir():
        return "path is not a directory: " + str(raw)
    return None


def _record_invocation_outcomes(
    rec: dict, outcomes: list[dict], *, delivery: str
) -> None:
    if outcomes and "affinity_skips" not in rec:
        rec.setdefault("ok", True)
    rows = rec.setdefault("invocation", [])
    for outcome in outcomes:
        row = dict(outcome)
        row["delivery"] = (
            "unchanged"
            if row.get("reason_code") == "conflicted-intent"
            else delivery
        )
        rows.append(row)


def _record_invocation_failure(
    rec: dict,
    skill_name: str,
    harnesses: set[str],
    project: Optional[str],
    exc: BaseException,
    *,
    requested_mode: str = "auto",
    profiles: Optional[dict] = None,
    input_fingerprint: str = "",
    applied_mode: Optional[str] = None,
    mode_origin: str = "library",
) -> None:
    code = getattr(exc, "code", None) or "native-write-failed"
    rows = rec.setdefault("invocation", [])
    for harness in sorted(harnesses):
        row = {
            "skill": skill_name,
            "harness": harness,
            "project": project,
            "requested_mode": requested_mode,
            "mode_origin": mode_origin,
            "capability_profile": _profile_for(harness, profiles),
            "support": "unknown",
            "implicit_behavior": "unknown",
            "explicit_behavior": "unknown",
            "mechanism": "delivery failed",
            "limitations": [str(exc)],
            "delivery": "failed",
            "applied_mode": applied_mode,
            "reason_code": code,
            "reason": str(exc),
            "observed_at": hub_core._now_iso(),
            "input_fingerprint": input_fingerprint,
        }
        rows.append(row)
    rec.setdefault("errors", []).append(
        {
            "stage": "invocation",
            "skill": skill_name,
            "harnesses": sorted(harnesses),
            "reason_code": code,
            "message": str(exc),
        }
    )
    if "affinity_skips" not in rec:
        rec["ok"] = False


def _applied_mode(link: Path) -> Optional[str]:
    if not link.is_symlink():
        return None
    try:
        name = link.resolve().name
    except OSError:
        return None
    if "@" not in name:
        return "auto"
    mode = name.rsplit("@", 2)[-2] if name.count("@") > 1 else name.rsplit("@", 1)[-1]
    return mode if mode in VALID_INVOCATIONS else "auto"


def _publish_skill_link(link: Path, target: Path) -> bool:
    """Publish a derived consumer without an unlink gap in its last-good link."""
    if link.is_symlink() and link.resolve() == target.resolve():
        return False
    if link.exists() and not link.is_symlink():
        # Keep the established backup behavior for unmanaged real entries.
        return ensure_symlink(link, target)
    link.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{link.name}.", dir=str(link.parent))
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.unlink()
        temporary.symlink_to(target)
        os.replace(temporary, link)
    finally:
        if temporary.is_symlink() or temporary.exists():
            temporary.unlink()
    print(f"  {c('✓', GREEN)} {link} → {target}")
    return True


def invocation_preview(
    skill_name: str,
    cfg: dict,
    target_harnesses: set[str],
    *,
    mode: Optional[str] = None,
    project: Optional[str] = None,
    project_path: Optional[Path] = None,
    mode_origin: Optional[str] = None,
    operation_context=None,
) -> list[dict]:
    """Return resolver rows for a read-only preview.

    This shares source parsing, capability-cache reads, and fingerprints with
    delivery. It intentionally never invokes a capability probe or writes a
    variant, so CLI and UI reads cannot change native state.
    """
    src = skill_source(cfg)
    requested = mode or skill_invocation(cfg)
    if requested not in VALID_INVOCATIONS and requested != "conflicted":
        requested = "auto"
    try:
        source_bytes = (src / "agents" / "openai.yaml").read_bytes()
    except FileNotFoundError:
        source_bytes = None
    except OSError as exc:
        raise InvocationError(str(exc), code="native-source-unreadable") from exc
    fingerprint = _source_fingerprint(src)
    profiles = _profiles_from_context(operation_context)
    if profiles is None:
        profiles = _cached_invocation_profiles()
    rows: list[dict] = []
    for harness in sorted(target_harnesses):
        try:
            row = _resolve_outcome(
                skill_name,
                harness,
                requested,
                mode_origin=mode_origin or (
                    "project"
                    if project and mode is not None and mode != skill_invocation(cfg)
                    else "library"
                ),
                project=project,
                source=source_bytes if harness == "codex" else None,
                profiles=profiles,
                input_fingerprint=fingerprint,
                operation_context=operation_context,
            )
            if harness == "opencode" and requested == "user-only":
                from skill_hub.infrastructure.harnesses import opencode_invocation

                if operation_context is not None and _opencode_paths(
                    operation_context
                ) is None:
                    row.update(
                        support="unknown",
                        reason_code="selection-unavailable",
                        reason="Captured OpenCode paths are unavailable.",
                        limitations=["No command or ordinary link was changed."],
                    )
                    rows.append(row)
                    continue
                opencode_layout = _layout(operation_context, harness)
                if opencode_layout is None or not _route_available(
                    operation_context, harness, "skills"
                ):
                    rows.append(row)
                    continue
                if project_path is None:
                    command_link = (
                        Path(str(opencode_layout.global_skills_dir)).expanduser()
                        / skill_name
                    )
                    command_project = None
                else:
                    command_link = (
                        project_path
                        / Path(str(opencode_layout.project_skills_dir))
                        / skill_name
                    )
                    command_project = project_path
                removable = (
                    {command_link}
                    if opencode_invocation.removable_skill_link(
                        command_link, native_paths=_opencode_paths(operation_context)
                    )
                    else set()
                )
                plan = opencode_invocation.plan_command(
                    skill_name,
                    src,
                    project_path=command_project,
                    target_harnesses=set(target_harnesses),
                    profile=_profile_for(harness, profiles),
                    removable_links=removable,
                    native_paths=_opencode_paths(operation_context),
                )
                row.update(
                    support=plan.get("support", row.get("support")),
                    reason_code=plan.get("reason_code"),
                    reason=plan.get("reason"),
                    mechanism=(
                        "opencode command-only delivery"
                        if plan.get("eligible")
                        else row.get("mechanism")
                    ),
                )
                row["limitations"] = (
                    [] if plan.get("eligible") else [plan.get("reason") or "Command delivery unavailable."]
                )
                if plan.get("eligible"):
                    row["implicit_behavior"] = "disabled"
                    row["explicit_behavior"] = "available"
        except InvocationError as exc:
            row = {
                "skill": skill_name,
                "harness": harness,
                "project": project,
                "requested_mode": requested,
                "mode_origin": mode_origin or (
                    "project"
                    if project and mode is not None and mode != skill_invocation(cfg)
                    else "library"
                ),
                "capability_profile": _profile_for(harness, profiles),
                "support": "unknown",
                "delivery": (
                    "unchanged" if requested == "conflicted" else "failed"
                ),
                "reason_code": (
                    "conflicted-intent" if requested == "conflicted" else exc.code
                ),
                "reason": str(exc),
                "mechanism": (
                    "unresolved invocation intent"
                    if requested == "conflicted"
                    else "unverified invocation capability"
                ),
                "limitations": (
                    ["The library has conflicting invocation flags; choose a mode to repair them."]
                    if requested == "conflicted"
                    else [str(exc)]
                ),
                "input_fingerprint": fingerprint,
                "observed_at": hub_core._now_iso(),
            }
        rows.append(row)
    return rows


def _try_opencode_command_delivery(
    skill_name: str,
    source: Path,
    mode: str,
    harnesses: set[str],
    *,
    project_path: Optional[Path],
    link: Path,
    profiles: Optional[dict],
    all_target_harnesses: Optional[set[str]] = None,
    operation_context=None,
) -> tuple[bool, int, Optional[dict]]:
    """Apply eligible opencode V1 command-only delivery.

    A shared destination is deliberately ineligible, so Codex/Pi consumers
    retain the ordinary skill link and their own native outcome rows.
    """
    if "opencode" not in harnesses:
        return False, 0, None
    from skill_hub.infrastructure.harnesses import opencode_invocation

    if operation_context is not None and _opencode_paths(operation_context) is None:
        row = _resolve_outcome(
            skill_name,
            "opencode",
            mode,
            mode_origin="project" if project_path is not None else "library",
            project=None,
            source=None,
            profiles=profiles,
            operation_context=operation_context,
        )
        row.update(
            support="unknown",
            reason_code="selection-unavailable",
            reason="Captured OpenCode paths are unavailable.",
            mechanism="unverified invocation capability",
            limitations=["No command or ordinary link was changed."],
            delivery="unchanged",
        )
        return harnesses == {"opencode"}, 0, row

    trusted_profile = (
        operation_context.trusted_invocation_profile("opencode")
        if operation_context is not None
        else None
    )
    trusted_resolver = (
        operation_context.trusted_invocation_resolver("opencode")
        if operation_context is not None and trusted_profile is not None
        else None
    )
    profile = trusted_profile or _profile_for("opencode", profiles)
    selection_available = (
        trusted_resolver is not None if operation_context is not None else True
    )
    if selection_available and trusted_resolver is not None:
        observed_capability = trusted_resolver("opencode", mode, profile=profile)
        selection_available = observed_capability.support != "unknown"
    if profile != opencode_invocation.SUPPORTED_PROFILE or not selection_available:
        row = _resolve_outcome(
            skill_name,
            "opencode",
            mode,
            mode_origin="project" if project_path is not None else "library",
            project=None,
            source=None,
            profiles=profiles,
            delivery="unchanged",
        )
        row.update(
            support="unknown",
            reason_code="selection-unavailable",
            reason="Verified opencode invocation selection is unavailable.",
            mechanism="unverified invocation capability",
            limitations=["No command or ordinary link was changed."],
        )
        # Ordinary shared delivery still serves Codex/Pi in auto mode. A
        # restricted mode needs a verified OpenCode binding before changing
        # that shared destination; retain its last-good state otherwise.
        return harnesses == {"opencode"} or mode != "auto", 0, row

    if mode != "user-only":
        return False, 0, None

    removable = {link} if link.is_symlink() and is_hub_owned_link(link) else set()
    plan = opencode_invocation.plan_command(
        skill_name,
        source,
        project_path=project_path,
        target_harnesses=set(all_target_harnesses if all_target_harnesses is not None else harnesses),
        profile=profile,
        removable_links=removable,
        native_paths=_opencode_paths(operation_context),
    )
    row = _resolve_outcome(
        skill_name,
        "opencode",
        mode,
        mode_origin="project" if project_path is not None else "library",
        project=None,
        source=None,
        profiles=profiles,
        operation_context=operation_context,
        profile_override=profile + "-command-eligible" if plan.get("eligible") else profile,
    )
    if plan.get("eligible") and trusted_resolver is not None and row.get("support") != "enforced":
        row.update(delivery="unchanged", reason_code="selection-unavailable")
        return True, 0, row
    row["capability_profile"] = profile
    row["support"] = plan.get("support", row.get("support"))
    row["reason_code"] = plan.get("reason_code")
    row["reason"] = plan.get("reason")
    row["limitations"] = [] if plan.get("eligible") else [plan.get("reason") or "Command delivery unavailable."]
    if not plan.get("eligible"):
        # Let the ordinary skill path publish a safe fallback while retaining
        # the command planner's concrete collision/unknown reason in reports.
        return False, 0, row
    row["mechanism"] = "opencode command-only delivery"
    row["implicit_behavior"] = "disabled"
    row["explicit_behavior"] = "available"
    try:
        writes = opencode_invocation.apply_command(plan)
        if link.is_symlink() and is_hub_owned_link(link):
            link.unlink()
            writes += 1
        row["delivery"] = "applied"
        return True, writes, row
    except (OSError, ValueError, TypeError) as exc:
        raise InvocationError(str(exc), code="opencode-command-failed") from exc


def _sync_project_skills(
    proj_name: str,
    proj_path: Path,
    proj_cfg: dict,
    registry: dict,
    effective: set[str],
    installed: set[str],
    report: Optional[dict] = None,
    variant_cache: Optional[dict] = None,
    refs_graph: Optional[dict] = None,
    operation_context=None,
) -> None:
    """Per-project sync: write symlinks per harness, dedup shared dirs, clean stale.

    Quarantined projects (no such path / `path_unresolved`) are skipped here as
    well as at the call site: every write below is a `mkdir -p` into the project
    tree, so this function must refuse on its own rather than trust its callers.
    """
    import hub

    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses as _harnesses

        layouts = dict(_harnesses.HARNESSES)
    else:
        layouts = _layouts(operation_context)
    opencode_paths = _opencode_paths(operation_context)
    opencode_paths_missing = (
        operation_context is not None
        and "opencode" in getattr(operation_context, "harness_ids", ())
        and opencode_paths is None
    )
    skill_effective = {
        h_id
        for h_id in effective
        if h_id in layouts and _route_available(operation_context, h_id, "skills")
    }
    protected_dirs: set[Path] = set()
    if operation_context is not None:
        # A shared destination must remain untouched while any participant's
        # captured skills route is unavailable. This protects both delivery
        # and cleanup from deleting or replacing another participant's
        # last-good output.
        by_path: dict[Path, set[str]] = {}
        for h_id, layout in layouts.items():
            target = proj_path / Path(str(layout.project_skills_dir))
            by_path.setdefault(target, set()).add(h_id)
        for target, harness_ids in by_path.items():
            if any(
                not _route_available(operation_context, h_id, "skills")
                for h_id in harness_ids
            ):
                protected_dirs.add(target)
        if (
            "opencode" in getattr(operation_context, "harness_ids", ())
            and _opencode_paths(operation_context) is None
        ):
            opencode_layout = layouts.get("opencode")
            if opencode_layout is not None:
                protected_dirs.add(
                    proj_path / Path(str(opencode_layout.project_skills_dir))
                )

    rec: Optional[dict] = None
    profiles = _profiles_from_context(operation_context)
    if profiles is None:
        profiles = _cached_invocation_profiles()
    skip_reason = project_sync_skip_reason(proj_cfg)
    if skip_reason:
        print(f"\n  {c(proj_name, BOLD)} [{proj_path}]")
        print(f"    {c('!', YELLOW)} skipped — {skip_reason}")
        if report is not None:
            # A quarantined project is an EXPECTED state, not a failure — `ok`
            # stays true so a freshly restored machine does not report a red sync
            # for projects it was told to leave alone.
            rec = hub.new_project_report()
            rec["quarantined"] = skip_reason
            rec["outcome"] = "skipped"
            rec["skip_reason"] = skip_reason
            report["projects"][proj_name] = rec
        return

    rec = hub.new_project_report() if report is not None else None
    opencode_command_expected: set[str] = set()
    skills = registry.get("skills", {})
    invocation_overrides = proj_cfg.get("invocation_overrides") or {}
    resolved = hub.resolve_project_skills(proj_cfg, registry)
    # A disabled source's skills stay equipped in the registry but are inactive
    # here: dropping them from `resolved` keeps them out of both the symlink
    # targets and the MCP dispatch, and the cleanup pass below (which unlinks
    # anything not expected) removes the links a previous sync wrote.
    inactive = skills_from_disabled_sources(registry)
    source_disabled = [(n, inactive[n]) for n in resolved if n in inactive]
    resolved = [n for n in resolved if n not in inactive]
    resolved_skills = [
        n for n in resolved if skills.get(n, {}).get("type") != "mcp-server"
    ]
    # Exclude scope:global mcp-servers — they are OWNED by the global-MCP pass
    # (see _run_global_mcp_dispatch). Writing them per-project too would cause a
    # double-write and let Claude's project>user precedence silently shadow the
    # global entry (mirrors how the global-skills pass owns scope:global skills).
    resolved_mcps = [
        n
        for n in resolved
        if skills.get(n, {}).get("type") == "mcp-server"
        and skills.get(n, {}).get("scope") != "global"
    ]

    # Per-project log line: effective harnesses
    effective_labels = ", ".join(
        sorted(str(getattr(layouts[h], "label", h)) for h in effective if h in layouts)
    ) or "(none)"
    print(f"\n  {c(proj_name, BOLD)} [{proj_path}]")
    print(f"    effective harnesses: {effective_labels}")

    # Log uninstalled-but-listed
    listed = set(registry.get("harnesses_global") or []) | set(
        proj_cfg.get("harnesses") or []
    )
    known_listed = listed & set(layouts)
    for missing in sorted(known_listed - installed):
        label = getattr(layouts[missing], "label", missing)
        print(
            f"    {c('!', YELLOW)} {label} listed but not installed on this "
            f"machine — skipped"
        )

    for skill_name, source_id in source_disabled:
        print(f"    {c('·', DIM)} source disabled: {skill_name} ({source_id})")

    # Build target set: { (target_dir, skill_name, source) } — dedup across
    # harnesses that share a project_skills_dir (codex + pi → .agents/skills/).
    target_dir_expected: dict[Path, set[str]] = {}

    for skill_name in resolved_skills:
        if skill_name not in skills:
            print(f"    {c('?', YELLOW)} unknown skill: {skill_name}")
            if rec is not None:
                rec["errors"].append(
                    {"stage": "unknown-skill", "message": f"unknown skill: {skill_name}"}
                )
            continue
        cfg = skills[skill_name]
        src = skill_source(cfg)
        if not src.exists():
            print(f"    {c('!', YELLOW)} source missing: {src}")
            affinity = hub._skill_affinity(cfg)
            missing_harnesses = (
                skill_effective & affinity
                if affinity is not None
                else skill_effective
            )
            for h_id in missing_harnesses:
                target_dir = proj_path / Path(str(layouts[h_id].project_skills_dir))
                link = target_dir / skill_name
                if link.is_symlink() and is_hub_owned_link(link):
                    target_dir_expected.setdefault(target_dir, set()).add(skill_name)
            if "opencode" in missing_harnesses:
                opencode_command_expected.add(skill_name)
            if rec is not None:
                rec["errors"].append(
                    {"stage": "symlink", "message": f"source missing: {src}"}
                )
                _record_invocation_failure(
                    rec,
                    skill_name,
                    set(missing_harnesses),
                    proj_name,
                    InvocationError(f"source missing: {src}", code="source-missing"),
                    requested_mode=skill_invocation(cfg),
                    profiles=profiles,
                )
            continue

        affinity = hub._skill_affinity(cfg)
        skill_target_harnesses = (
            skill_effective & affinity
            if affinity is not None
            else skill_effective
        )
        if not skill_target_harnesses:
            if affinity is not None and effective:
                affinity_str = ", ".join(sorted(affinity))
                effective_str = ", ".join(sorted(effective)) or "none"
                print(
                    f"    {c('·', DIM)} skill {skill_name} not synced: "
                    f"skill targets [{affinity_str}], effective harnesses [{effective_str}]"
                )
                if rec is not None:
                    rec["affinity_skips"].append(
                        {
                            "skill": skill_name,
                            "skill_harnesses": sorted(affinity),
                            "project_harnesses": sorted(effective),
                        }
                    )
            continue

        # Resolve each physical destination once. Codex, Pi and opencode share
        # `.agents/skills`, so the native payload must be selected from the
        # union rather than from harness-loop order.
        target_dirs: dict[Path, set[str]] = {}
        for h_id in skill_target_harnesses:
            h = layouts[h_id]
            target_dirs.setdefault(
                proj_path / Path(str(h.project_skills_dir)), set()
            ).add(h_id)

        original_src = skill_source(cfg)
        rename_patch = skill_rename_patch(skill_name, cfg)
        override_mode = invocation_overrides.get(skill_name)
        if override_mode and cfg.get("scope", "portable") == "global":
            print(
                f"    {c('!', YELLOW)} invocation override for '{skill_name}' is inert: "
                "scope is global (user-level skills take precedence in Claude Code)"
            )
            override_mode = None
        requested_mode = override_mode or skill_invocation(cfg)
        if requested_mode not in VALID_INVOCATIONS and requested_mode != "conflicted":
            requested_mode = "auto"
        mode_origin = "project" if override_mode else "library"
        build_mode = requested_mode
        if not override_mode and requested_mode == "auto" and rename_patch is not None:
            build_mode = RENAME_VARIANT_MODE
        for target_dir, destination_harnesses in target_dirs.items():
            if target_dir in protected_dirs:
                continue
            # Convert dir-level symlink to actual dir if needed (pre-existing edge case)
            if target_dir.is_symlink():
                target_dir.unlink()
                target_dir.mkdir(parents=True, exist_ok=True)
                print(
                    f"    {c('→', CYAN)} converted {target_dir.name} dir-symlink to dir"
                )
            link = target_dir / skill_name
            try:
                command_handled, command_writes, command_row = _try_opencode_command_delivery(
                    skill_name,
                    original_src,
                    requested_mode,
                    destination_harnesses,
                    project_path=proj_path,
                    link=link,
                    profiles=profiles,
                    all_target_harnesses=set(skill_target_harnesses),
                    operation_context=operation_context,
                )
                if command_handled:
                    opencode_command_expected.add(skill_name)
                    if command_row is not None and command_row.get("reason_code") == "selection-unavailable":
                        target_dir_expected.setdefault(target_dir, set()).add(skill_name)
                    if rec is not None:
                        rec["writes"] += command_writes
                        if command_row is not None:
                            command_row["project"] = proj_name
                            command_row["mode_origin"] = mode_origin
                            command_row["input_fingerprint"] = _source_fingerprint(original_src)
                            _record_invocation_outcomes(
                                rec,
                                [command_row],
                                delivery=(
                                    "unchanged"
                                    if command_row.get("reason_code") == "selection-unavailable"
                                    else "applied"
                                ),
                            )
                    continue
                cache_key = (
                    "native",
                    skill_name,
                    build_mode,
                    requested_mode,
                    tuple(sorted(destination_harnesses)),
                    mode_origin,
                    tuple(sorted((k, str(v)) for k, v in profiles.items())),
                    _source_fingerprint(original_src),
                )
                if (
                    override_mode
                    and override_mode == skill_invocation(cfg)
                    and rename_patch is None
                    and "codex" not in destination_harnesses
                ):
                    src, writes, outcomes = original_src, 0, _native_payload(
                        original_src,
                        destination_harnesses,
                        requested_mode,
                        profiles=profiles,
                        mode_origin=mode_origin,
                        project=proj_name,
                        operation_context=operation_context,
                    )[2]
                elif variant_cache is not None and cache_key in variant_cache:
                    src, _cached_writes, cached_outcomes = variant_cache[cache_key]
                    writes, outcomes = 0, [dict(row) for row in cached_outcomes]
                    for row in outcomes:
                        row["project"] = proj_name
                else:
                    src, writes, outcomes = _ensure_combined_variant(
                        skill_name,
                        original_src,
                        build_mode,
                        renamed=rename_patch,
                        native_harnesses=destination_harnesses,
                        mode_origin=mode_origin,
                        project=proj_name,
                        profiles=profiles,
                        native_mode=requested_mode,
                        operation_context=operation_context,
                    )
                    if variant_cache is not None:
                        variant_cache[cache_key] = (src, writes, outcomes)
                if _publish_skill_link(link, src) and rec is not None:
                    rec["writes"] += 1
                if "opencode" in destination_harnesses:
                    from skill_hub.infrastructure.harnesses import opencode_invocation

                    # Remove an old command only after the ordinary skill has
                    # been delivered successfully. Failed builds preserve the
                    # command as a last-good consumer below.
                    if rec is not None and not opencode_paths_missing:
                        rec["removed"] += opencode_invocation.remove_owned_command(
                            skill_name,
                            proj_path,
                            native_paths=_opencode_paths(operation_context),
                        )
                    elif not opencode_paths_missing:
                        opencode_invocation.remove_owned_command(
                            skill_name,
                            proj_path,
                            native_paths=_opencode_paths(operation_context),
                        )
                if command_row is not None:
                    command_row["delivery"] = "applied"
                    command_row["project"] = proj_name
                    command_row["mode_origin"] = mode_origin
                    command_row["input_fingerprint"] = _source_fingerprint(original_src)
                    outcomes = [
                        command_row if row.get("harness") == "opencode" else row
                        for row in outcomes
                    ]
                if rec is not None:
                    rec["writes"] += writes
                    _record_invocation_outcomes(rec, outcomes, delivery="applied")
            except (InvocationError, OSError, ValueError, TypeError) as exc:
                # A failed native build must never repoint a working consumer at
                # an unpatched source. Keep a previous hub-owned link demanded;
                # first delivery remains absent and is reported as failed.
                if link.is_symlink() and is_hub_owned_link(link):
                    target_dir_expected.setdefault(target_dir, set()).add(skill_name)
                if "opencode" in destination_harnesses:
                    opencode_command_expected.add(skill_name)
                if rec is not None:
                    _record_invocation_failure(
                        rec,
                        skill_name,
                        destination_harnesses,
                        proj_name,
                        exc,
                        requested_mode=requested_mode,
                        profiles=profiles,
                        input_fingerprint=_source_fingerprint(original_src),
                        applied_mode=_applied_mode(link),
                        mode_origin=mode_origin,
                    )
                continue
            target_dir_expected.setdefault(target_dir, set()).add(skill_name)

    from skill_hub.infrastructure.harnesses import opencode_invocation

    # Overrides for skills not active here are kept but inert — say so.
    for ov_name in sorted(set(invocation_overrides) - set(resolved_skills)):
        print(
            f"    {c('!', YELLOW)} invocation override for '{ov_name}' is inert "
            f"(skill not active on this project)"
        )

    # Cleanup: walk EVERY known harness's project_skills_dir, including ones
    # not in effective. This is what removes orphans when a harness is disabled.
    managed_dirs: set[Path] = {
        proj_path / Path(str(layout.project_skills_dir))
        for h_id, layout in layouts.items()
        if _route_available(operation_context, h_id, "skills")
    }
    owned_opencode_commands = (
        []
        if opencode_paths_missing
        else opencode_invocation.owned_command_links(
            proj_path, native_paths=opencode_paths
        )
    )
    opencode_in_scope = "opencode" in effective or "opencode" in listed or bool(owned_opencode_commands)
    if opencode_in_scope and _opencode_selection_unavailable(operation_context):
        # An unknown OpenCode binding makes cleanup unsafe: a command or
        # ordinary shared skill link may be the only surviving consumer until
        # the next selection refresh. Retain every Hub-owned consumer in this
        # scope, including entries whose registry record was removed.
        opencode_command_expected.update(
            path.stem for path in owned_opencode_commands
        )
        opencode_layout = layouts.get("opencode")
        preserved_dirs = (
            {proj_path / Path(str(opencode_layout.project_skills_dir))}
            if opencode_layout is not None else set()
        )
        for skills_dir in preserved_dirs:
            if not skills_dir.is_dir() or skills_dir.is_symlink():
                continue
            for link in skills_dir.iterdir():
                if link.is_symlink() and is_hub_owned_link(link):
                    target_dir_expected.setdefault(skills_dir, set()).add(link.name)

    removed_commands = (
        0
        if opencode_paths_missing
        else opencode_invocation.cleanup_commands(
            proj_path,
            opencode_command_expected,
            native_paths=opencode_paths,
        )
    )
    if rec is not None:
        rec["removed"] += removed_commands

    for skills_dir in managed_dirs:
        if skills_dir in protected_dirs:
            continue
        if not skills_dir.exists() or skills_dir.is_symlink():
            continue
        expected = target_dir_expected.get(skills_dir, set())
        for link in skills_dir.iterdir():
            if link.is_symlink() and link.name not in expected:
                # The one ownership rule, shared with the global sweep and
                # `clean_project_artifacts`: never unlink another install's link.
                if not is_hub_owned_link(link):
                    if rec is not None:
                        rec["skipped_unowned"] += 1
                    print(
                        f"    {c('·', DIM)} skipped unowned: "
                        f"{link.relative_to(proj_path)} → {link_target_abs(link)}"
                    )
                    continue
                link.unlink()
                if rec is not None:
                    rec["removed"] += 1
                print(f"    {c('✗', RED)} removed stale: {link.relative_to(proj_path)}")

    # MCP entries a disabled source owns must LEAVE the project's native configs.
    # Dropping them from `resolved_mcps` is not enough on its own:
    # `sync_mcp_for_project` only ever writes specs, and it is not even called
    # when the disabled source owned the project's only mcp-servers — so excise
    # them explicitly through each effective adapter's `remove()`. Restricted to
    # non-global servers: a scope:global one is owned by the global-MCP pass and
    # hub never writes it here, so a same-named project entry is the user's own.
    disabled_mcps = {
        name
        for name, _sid in source_disabled
        if skills.get(name, {}).get("type") == "mcp-server"
        and skills.get(name, {}).get("scope") != "global"
    }
    if disabled_mcps:
        from skill_hub.infrastructure.mcp import mcp_adapters

        adapter_keys: set[str] = set()
        for h_id in effective:
            if h_id not in layouts:
                continue
            if operation_context is not None and not _route_available(
                operation_context, h_id, "mcp"
            ):
                continue
            key = layouts[h_id].mcp_adapter_key
            if key is not None:
                adapter_keys.add(key)
        for key in sorted(adapter_keys):
            if operation_context is None:
                adapter = mcp_adapters.get_adapter(key)
            else:
                harness_id = _representative_harness(
                    key, effective, operation_context
                )
                adapter = (
                    mcp_adapters.select_mcp_adapter(operation_context, harness_id)
                    if harness_id is not None
                    else None
                )
            harness_id = _representative_harness(
                key, effective, operation_context
            )
            if adapter is None or harness_id is None:
                continue
            try:
                removed_entry = adapter.remove(
                    proj_path, disabled_mcps, harness_id=harness_id, project_name=proj_name
                )
            except Exception as e:
                print(f"    {c('!', RED)} MCP adapter '{key}' remove failed: {e}")
                continue
            if removed_entry.removed:
                print(
                    f"    {c('✗', RED)} removed MCP({key}) entries: "
                    f"{', '.join(sorted(disabled_mcps))}"
                )
            for name in sorted(removed_entry.preserved):
                print(
                    f"    {c('!', YELLOW)} {name} still in MCP({key}) and not "
                    f"hub-managed — remove it by hand"
                )

    if project_has_mcp_target(effective, operation_context=operation_context):
        print(f"\n  {c(proj_name + ' MCP:', BOLD)}")
        if report is not None:
            report["projects"][proj_name] = rec
        sync_mcp_for_project(
            proj_path,
            resolved_mcps,
            registry,
            project_name=proj_name,
            report=report,
            operation_context=operation_context,
        )

    if report is not None and rec is not None:
        if refs_graph is not None:
            from skill_hub.domain.skills import skill_refs as _skill_refs

            global_sources = [
                n
                for n, c in skills.items()
                if c.get("scope") == "global" and c.get("type") != "mcp-server"
            ]
            rec["missing_refs"] = _skill_refs.missing_refs_for(
                resolved, registry, refs_graph, global_sources
            )
        rec["ok"] = len(rec["errors"]) == 0
        report["projects"][proj_name] = rec
