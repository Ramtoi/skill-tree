"""Static prompt-footprint composition and finding detection.

Leaf module (usage-loadout-analytics design D1): at module scope this
imports only stdlib, `hub_core`, `harnesses`, `agent_docs`, `global_docs`,
`mcp_probe`, `mcp_spec` and `skill_meta` — never `hub` and never
`sync_engine` (which reaches the monolith). `project_payload` and
`findings_payload` import `usage_scan` inside the function body only, so a
plain `import usage_footprint` never pulls in the transcript scanner.

`compose` and `detect_findings` are pure: they take already-resolved values
and read no ledger. `resolve_skills` is the seam that lets this leaf reach a
project's resolved skill set without importing `sync_engine` — unit C passes
`hub.resolve_project_skills`.
"""

from __future__ import annotations

import json
import math
import statistics
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from skill_hub.domain.skills import skill_meta
from skill_hub.infrastructure.filesystem import agent_docs, global_docs
from skill_hub.infrastructure.harnesses import harnesses
from skill_hub.infrastructure.mcp import mcp_probe

# ─────────────────────────────────────────────────────────────────────────────
# Thresholds (design D9) — module constants, not left to the implementer
# ─────────────────────────────────────────────────────────────────────────────

IDLE_WINDOW_DAYS = 30
IDLE_MIN_SESSIONS = 5
FOOTPRINT_PART_SHARE = 0.25
FOOTPRINT_SKILL_SHARE = 0.05
VERIFY_MIN_EDIT_SESSIONS = 3
MAX_DISCOVERABLE_DOCS = 200
MAX_DISCOVERABLE_BYTES = 512_000


# ─────────────────────────────────────────────────────────────────────────────
# Composition (design D5)
# ─────────────────────────────────────────────────────────────────────────────


def compose(
    project_name: str,
    registry: dict,
    *,
    resolve_skills: Callable[[dict, dict], list],
    harness_ids: Optional[set[str]] = None,
    discoverable: bool = True,
) -> dict:
    """Per-harness list of texts that enter the prompt.

    Returns a block for every effective harness, including one with no
    scanner: what a scanner-less harness lacks is the observed number, not
    the static composition (design D5, G9). `harness_ids`, when given,
    overrides the effective-harness computation — the caller already
    resolved it, or a test wants one harness in isolation.
    """
    proj_cfg = (registry.get("projects") or {}).get(project_name, {})
    if harness_ids is None:
        harness_ids = harnesses.resolve_effective(proj_cfg, registry)
    equipped = list(resolve_skills(proj_cfg, registry))
    probe_cache = mcp_probe.read_probe_cache()

    blocks: dict = {}
    for harness_id in sorted(harness_ids):
        harness = harnesses.HARNESSES.get(harness_id)
        if harness is None:
            continue
        skills_part = _skills_part(harness_id, harness, equipped, registry)
        docs_part, upfront_paths = _agent_docs_part(harness_id, harness, proj_cfg, registry)
        mcp_part, mcp_unknown = _mcp_schemas_part(
            harness_id, harness, equipped, registry, probe_cache
        )
        parts = [skills_part, docs_part, mcp_part]
        bytes_total = sum(p["bytes"] for p in parts)
        block = {
            "parts": parts,
            "unknown": mcp_unknown,
            "bytes_total": bytes_total,
            "approx_tokens": math.ceil(bytes_total / 4) if bytes_total else 0,
        }
        block["skill_lines"] = _skill_lines(harness_id, harness, equipped, registry)
        if discoverable:
            docs = _discoverable_docs(harness, proj_cfg, upfront_paths)
            block["discoverable"] = docs["docs"]
            block["discoverable_bytes"] = docs["bytes"]
            block["discoverable_truncated"] = docs["truncated"]
        blocks[harness_id] = block
    return {"project": project_name, "harnesses": blocks}


def _skill_paths(
    harness_id: str, harness: "harnesses.Harness", equipped: list, registry: dict
) -> dict[str, str]:
    """name -> harness-relative path, for every skill available to this
    harness: the project's resolved skills plus every `scope: global` skill,
    each filtered by its own harness affinity. The path is harness-relative,
    never absolute (design D5, G3). Shared by `_skills_part` and the
    per-skill footprint-bytes lookup `project_payload` uses to enrich
    utilization rows, so the two selections can never disagree."""
    skills_cfg = registry.get("skills") or {}
    paths: dict[str, str] = {}
    for name in equipped:
        cfg = skills_cfg.get(name)
        if not isinstance(cfg, dict) or cfg.get("type") == "mcp-server":
            continue
        affinity = skill_meta.skill_affinity(cfg)
        if affinity is not None and harness_id not in affinity:
            continue
        paths[name] = str(harness.project_skills_dir / name)
    for name, cfg in skills_cfg.items():
        if not isinstance(cfg, dict) or cfg.get("type") == "mcp-server":
            continue
        if cfg.get("scope") != "global":
            continue
        affinity = skill_meta.skill_affinity(cfg)
        if affinity is not None and harness_id not in affinity:
            continue
        paths.setdefault(name, str(harness.global_skills_dir / name))
    return paths


def _skills_part(
    harness_id: str, harness: "harnesses.Harness", equipped: list, registry: dict
) -> dict:
    """One line per skill available to this harness. See `_skill_paths` for
    the selection rule."""
    skills_cfg = registry.get("skills") or {}
    paths = _skill_paths(harness_id, harness, equipped, registry)
    ordered = sorted(paths)
    texts = [_format_skill_line(name, skills_cfg.get(name) or {}, paths[name]) for name in ordered]
    text = "\n".join(texts)
    return {
        "part": "skills",
        "label": f"Skill descriptions ({len(ordered)})",
        "text": text,
        "bytes": len(text.encode("utf-8")),
    }


def _format_skill_line(name: str, cfg: dict, path: str) -> str:
    description = cfg.get("description") or ""
    return f"{name}: {description} ({path})"


def _skill_byte_map(
    harness_id: str, harness: "harnesses.Harness", equipped: list, registry: dict
) -> dict[str, int]:
    """name -> UTF-8 byte length of that skill's own line within this
    harness's `skills` part text (not the whole part's total). This is the
    per-skill footprint-bytes seam `project_payload` enriches utilization
    rows from — `usage_scan.utilization_rows` cannot know it, only the
    skill-line composition here does."""
    return {line["key"]: line["bytes"] for line in _skill_lines(harness_id, harness, equipped, registry)}


def _skill_lines(
    harness_id: str, harness: "harnesses.Harness", equipped: list, registry: dict
) -> list[dict]:
    """Return the selected skill lines with their UTF-8 byte counts."""
    skills_cfg = registry.get("skills") or {}
    paths = _skill_paths(harness_id, harness, equipped, registry)
    return [
        {
            "key": name,
            "text": _format_skill_line(name, skills_cfg.get(name) or {}, paths[name]),
            "bytes": len(
                _format_skill_line(name, skills_cfg.get(name) or {}, paths[name]).encode("utf-8")
            ),
        }
        for name in sorted(paths)
    ]


def _read_doc_text(path: Path) -> Optional[str]:
    try:
        if not path.exists() and not path.is_symlink():
            return None
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _safe_resolve(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path


def _resolve_harness_root_name(
    harness: "harnesses.Harness", proj_cfg: dict, registry: dict
) -> Optional[str]:
    """Which root-doc filename this harness actually reads, per
    `agent_docs.resolve_canonical_root` (design D5) rather than a bare
    per-harness filename guess. `harness.root_doc` names claude-code's
    `CLAUDE.md` or every other harness's `AGENTS.md`; this matches it
    against whichever of `canonical`/`derived` `resolve_canonical_root` says
    is real for this project, so a legacy layout or a broken derived link
    surfaces as "no root" (an empty chain) instead of a bare filename guess
    silently reading the wrong — or no — file."""
    chain = agent_docs.resolve_canonical_root(proj_cfg, registry)
    if chain.get("canonical") == harness.root_doc:
        return chain["canonical"]
    if chain.get("derived") == harness.root_doc:
        return chain["derived"]
    return None


def _agent_docs_part(
    harness_id: str, harness: "harnesses.Harness", proj_cfg: dict, registry: dict
) -> tuple[dict, set[Path]]:
    """The canonical root chain this harness reads, in load order: the root
    doc (resolved through `_resolve_harness_root_name`, design D5), its
    imports followed transitively (cycle guard, `agent_docs.MAX_IMPORT_HOPS`
    cap, existing external targets included per design D5 G28), then the
    harness's own user-global doc."""
    raw_path = proj_cfg.get("path")
    texts: list[str] = []
    import_count = 0
    visited: set[Path] = set()
    root_name = _resolve_harness_root_name(harness, proj_cfg, registry)
    if isinstance(raw_path, str) and raw_path and root_name:
        proj_root = Path(raw_path)
        root_file = proj_root / root_name
        root_text = _read_doc_text(root_file)
        if root_text is not None:
            texts.append(root_text)
            visited = {_safe_resolve(root_file)}
            queue: list[tuple[Path, int]] = [(root_file, 0)]
            while queue:
                doc, depth = queue.pop(0)
                targets = agent_docs.resolve_import_targets(doc, proj_root)
                for external in targets["external"]:
                    external_text = _read_doc_text(external)
                    if external_text is not None:
                        texts.append(external_text)
                        import_count += 1
                if depth + 1 > agent_docs.MAX_IMPORT_HOPS:
                    continue
                for target in targets["resolved"]:
                    key = _safe_resolve(target)
                    if key in visited:
                        continue
                    visited.add(key)
                    target_text = _read_doc_text(target)
                    if target_text is not None:
                        texts.append(target_text)
                        import_count += 1
                    queue.append((target, depth + 1))

    global_path = global_docs.doc_path(harness_id)
    if global_path is not None:
        global_text = _read_doc_text(global_path)
        if global_text is not None:
            texts.append(global_text)

    text = "\n\n".join(texts)
    plural = "" if import_count == 1 else "s"
    return {
        "part": "agent_docs",
        "label": f"{harness.root_doc} + {import_count} import{plural}",
        "text": text,
        "bytes": len(text.encode("utf-8")),
    }, visited


def _discoverable_docs(
    harness: "harnesses.Harness", proj_cfg: dict, upfront_paths: set[Path]
) -> dict:
    """Collect nested instruction documents that are not already upfront."""
    raw_path = proj_cfg.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        return {"docs": [], "bytes": 0, "truncated": False}
    root = Path(raw_path)
    candidates: list[dict] = []
    for rel_dir in sorted(agent_docs.discover_instruction_dirs(root)):
        if rel_dir == "":
            continue
        path = root / rel_dir / harness.root_doc
        if path.name == "CLAUDE.local.md":
            continue
        if _safe_resolve(path) in upfront_paths:
            continue
        text = _read_doc_text(path)
        if text is None:
            continue
        candidates.append({
            "rel": path.relative_to(root).as_posix(),
            "text": text,
            "bytes": len(text.encode("utf-8")),
        })
    docs: list[dict] = []
    total = 0
    truncated = len(candidates) > MAX_DISCOVERABLE_DOCS
    for candidate in candidates:
        if len(docs) >= MAX_DISCOVERABLE_DOCS:
            break
        if total + candidate["bytes"] > MAX_DISCOVERABLE_BYTES:
            truncated = True
            break
        docs.append(candidate)
        total += candidate["bytes"]
    return {"docs": docs, "bytes": total, "truncated": truncated}


def _mcp_schemas_part(
    harness_id: str,
    harness: "harnesses.Harness",
    equipped: list,
    registry: dict,
    probe_cache: dict,
) -> tuple:
    """The delivered `tool_schemas` for every MCP server this (project,
    harness) pair reaches (design D5): a `scope: global` server reaches only
    a harness with a `global_mcp_config`; every other equipped server reaches
    the harness when its own `harnesses:` affinity allows it. A server with
    no cache row, or no `tool_schemas` in its row, is `unknown` and
    contributes nothing to the text."""
    skills_cfg = registry.get("skills") or {}
    names: dict[str, None] = {}
    for name in equipped:
        cfg = skills_cfg.get(name)
        if not isinstance(cfg, dict) or cfg.get("type") != "mcp-server":
            continue
        if cfg.get("scope") == "global":
            continue
        affinity = skill_meta.skill_affinity(cfg)
        if affinity is not None and harness_id not in affinity:
            continue
        names.setdefault(name, None)
    for name, cfg in skills_cfg.items():
        if not isinstance(cfg, dict) or cfg.get("type") != "mcp-server":
            continue
        if cfg.get("scope") != "global":
            continue
        if harness.global_mcp_config is None:
            continue
        names.setdefault(name, None)

    texts = []
    unknown: list[dict] = []
    server_count = 0
    for name in sorted(names):
        row = probe_cache.get(name)
        schemas = row.get("tool_schemas") if isinstance(row, dict) else None
        if not schemas:
            unknown.append(
                {
                    "part": "mcp_schemas",
                    "label": name,
                    "reason": "never_probed",
                    "hint": f"hub mcp check {name}",
                }
            )
            continue
        server_count += 1
        for schema in schemas:
            texts.append(json.dumps(schema, sort_keys=True))

    text = "\n".join(texts)
    plural = "" if server_count == 1 else "s"
    part = {
        "part": "mcp_schemas",
        "label": f"MCP tool schemas ({server_count} server{plural})",
        "text": text,
        "bytes": len(text.encode("utf-8")),
    }
    return part, unknown


# ─────────────────────────────────────────────────────────────────────────────
# Findings (design D9)
# ─────────────────────────────────────────────────────────────────────────────


def detect_findings(
    *,
    project: str,
    utilization: list,
    outcomes: dict,
    footprint: dict,
    sessions_in_window: int,
) -> list:
    """Pure finding detector. Reads no file, so waves 2-4 can reuse it
    against literals. `footprint` must already be narrowed to the scanned
    harnesses only — this function does not know which harnesses have a
    scanner."""
    findings: list = []
    idle = _idle_finding(project, utilization, sessions_in_window)
    if idle is not None:
        findings.append(idle)
    findings.extend(_footprint_findings(project, utilization, footprint))
    verification = _verification_finding(project, outcomes)
    if verification is not None:
        findings.append(verification)
    return findings


def _idle_finding(project: str, utilization: list, sessions_in_window: int) -> Optional[dict]:
    if sessions_in_window < IDLE_MIN_SESSIONS:
        return None
    idle_skills = sorted(
        row["key"] for row in utilization if isinstance(row, dict) and row.get("idle") is True
    )
    if not idle_skills:
        return None
    count = len(idle_skills)
    was_were = "was" if count == 1 else "were"
    skill_noun = "skill" if count == 1 else "skills"
    return {
        "id": f"idle-skills:{project}",
        "kind": "idle",
        "project": project,
        "observation": (
            f"{count} {skill_noun} {was_were} never invoked in {IDLE_WINDOW_DAYS} days "
            f"across {sessions_in_window} sessions."
        ),
        "numbers": {
            "skills": idle_skills,
            "sessions": sessions_in_window,
            "bytes_per_skill": {
                row["key"]: row.get("footprint_bytes", 0)
                for row in utilization
                if row.get("key") in idle_skills
            },
        },
        "moves": [
            {"label": "Unequip", "kind": "unequip", "targets": idle_skills},
            {"label": "Set user-only", "kind": "invocation", "targets": idle_skills},
        ],
        "review": {"area": "loadout", "project": project, "highlight": idle_skills},
    }


def _footprint_findings(project: str, utilization: list, footprint: dict) -> list:
    findings: list = []
    for harness_id in sorted(footprint):
        block = footprint[harness_id]
        bytes_total = block.get("bytes_total") or 0
        if bytes_total <= 0:
            continue
        for part in block.get("parts", []):
            part_bytes = part.get("bytes", 0)
            share = part_bytes / bytes_total
            if share < FOOTPRINT_PART_SHARE:
                continue
            part_name = part.get("part")
            area = "agent_docs" if part_name == "agent_docs" else "loadout"
            findings.append(
                {
                    "id": f"footprint-{part_name}:{harness_id}:{project}",
                    "kind": "footprint",
                    "project": project,
                    "observation": (
                        f"{part.get('label')} is {round(share * 100)}% of the "
                        f"{harness_id} prompt ({part_bytes} bytes)."
                    ),
                    "numbers": {
                        "harness": harness_id,
                        "part": part_name,
                        "share": share,
                        "bytes": part_bytes,
                        "bytes_total": bytes_total,
                    },
                    "moves": [{"label": "Review", "kind": "review", "targets": []}],
                    "review": {"area": area, "project": project, "highlight": []},
                }
            )

    # R20: `footprint_bytes` on a row is already the SUM of that skill's line
    # across every scanned harness (`_enrich_utilization_with_footprint`).
    # The denominator must match that same sum — dividing by one harness's
    # `bytes_total` at a time (and firing once per harness) double-counted
    # and inflated the share the moment two harnesses were scanned.
    for row in sorted(utilization, key=lambda r: r.get("key", "")):
        footprint_bytes = row.get("footprint_bytes")
        if footprint_bytes is None:
            continue
        included = [h for h in (row.get("harnesses") or []) if h in footprint]
        bytes_total = sum(footprint[h].get("bytes_total") or 0 for h in included)
        if bytes_total <= 0:
            continue
        share = footprint_bytes / bytes_total
        if share < FOOTPRINT_SKILL_SHARE:
            continue
        name = row.get("key")
        harness_label = "/".join(sorted(included))
        findings.append(
            {
                "id": f"footprint-skill-{name}:{project}",
                "kind": "footprint",
                "project": project,
                "observation": (
                    f"{name} is {round(share * 100)}% of the {harness_label} prompt "
                    f"({footprint_bytes} bytes)."
                ),
                "numbers": {
                    "harnesses": sorted(included),
                    "skill": name,
                    "share": share,
                    "bytes": footprint_bytes,
                    "bytes_total": bytes_total,
                },
                "moves": [
                    {"label": "Unequip", "kind": "unequip", "targets": [name]},
                    {"label": "Set user-only", "kind": "invocation", "targets": [name]},
                ],
                "review": {"area": "loadout", "project": project, "highlight": [name]},
            }
        )
    return findings


def _verification_finding(project: str, outcomes: dict) -> Optional[dict]:
    """An editing session has `activity.edit > 0`; an unverified one also has
    `activity.verify == 0`. Fires when at least one unverified editing
    session exists and the project has at least `VERIFY_MIN_EDIT_SESSIONS`
    editing sessions (design D9, G7). Reads the pre-aggregated counts off
    `outcomes` — `editing_sessions` and `unverified_editing_sessions` — which
    `usage_scan.outcome_metrics` must supply alongside `verified_edit_session_ratio`."""
    editing = outcomes.get("editing_sessions") or 0
    unverified = outcomes.get("unverified_editing_sessions") or 0
    if editing < VERIFY_MIN_EDIT_SESSIONS or unverified <= 0:
        return None
    return {
        "id": f"verification:{project}",
        "kind": "verification",
        "project": project,
        "observation": (
            f"{unverified} of {editing} editing sessions had no verification step."
        ),
        "numbers": {
            "editing_sessions": editing,
            "unverified_editing_sessions": unverified,
            "min_sessions": VERIFY_MIN_EDIT_SESSIONS,
        },
        "moves": [{"label": "Review", "kind": "review", "targets": []}],
        "review": {
            "area": "agent_docs",
            "project": project,
            "highlight": [],
            "also": ["loadout"],
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Composed payloads (design D7)
# ─────────────────────────────────────────────────────────────────────────────


def _observed_footprint(rows: list, harness_id: str, scanned_harnesses: tuple) -> Optional[int]:
    """Median `first_turn_input_total` over the window, for one harness. A
    harness with no scanner, or no session in the window, yields None
    (design D5's "Observed footprint")."""
    if harness_id not in scanned_harnesses:
        return None
    values = [
        row.get("first_turn_input_total")
        for row in rows
        if row.get("harness") == harness_id and row.get("first_turn_input_total") is not None
    ]
    if not values:
        return None
    return statistics.median(values)


def _aggregate_subagents(rows: list) -> list:
    agg: dict[tuple, dict] = {}
    for row in rows:
        for spawn in row.get("subagents") or []:
            key = (spawn.get("subagent_type"), spawn.get("model"))
            entry = agg.setdefault(
                key,
                {
                    "subagent_type": spawn.get("subagent_type"),
                    "model": spawn.get("model"),
                    "count": 0,
                    "tokens": 0,
                },
            )
            entry["count"] += spawn.get("count", 0)
            entry["tokens"] += spawn.get("tokens", 0)
    return [agg[key] for key in sorted(agg, key=lambda k: (k[0] or "", k[1] or ""))]


def _equipped_skill_keys(proj_cfg: dict, registry: dict, resolve_skills: Callable) -> list:
    skills_cfg = registry.get("skills") or {}
    out = []
    for name in resolve_skills(proj_cfg, registry):
        cfg = skills_cfg.get(name)
        if isinstance(cfg, dict) and cfg.get("type") != "mcp-server":
            out.append(name)
    return out


def _skill_byte_maps(harness_list: list, registry: dict, equipped: list) -> dict:
    """harness_id -> `_skill_byte_map(...)` for every effective harness.
    Computed once per `project_payload` call and shared by the display-window
    and the fixed-findings-window utilization enrichments below — the
    per-skill byte breakdown is a structural property of the composition,
    not of a session window."""
    byte_maps: dict[str, dict[str, int]] = {}
    for harness_id in harness_list:
        harness = harnesses.HARNESSES.get(harness_id)
        if harness is None:
            continue
        byte_maps[harness_id] = _skill_byte_map(harness_id, harness, equipped, registry)
    return byte_maps


def _enrich_utilization_with_footprint(
    utilization: list, byte_maps: dict, harness_list: list, scanned_harnesses: tuple
) -> list:
    """Attach `footprint_bytes` (summed over the scanned harnesses' `skills`
    line for this skill, 0 when it has none) and `harnesses` (the sorted
    effective harnesses whose composition includes it) to each utilization
    row. `usage_scan.utilization_rows` cannot know either value — only the
    per-harness skill-line composition (`_skill_byte_maps`) does."""
    enriched = []
    for row in utilization:
        name = row.get("key")
        included = sorted(h for h in harness_list if name in byte_maps.get(h, {}))
        total_bytes = sum(
            byte_maps.get(h, {}).get(name, 0) for h in harness_list if h in scanned_harnesses
        )
        enriched.append(
            {
                **row,
                "footprint_bytes": total_bytes,
                "harnesses": included,
                "idle": row.get("count", 0) == 0
                and row.get("sessions_with_skill", 0) >= IDLE_MIN_SESSIONS,
            }
        )
    return enriched


def project_payload(
    project_name: str,
    registry: dict,
    *,
    resolve_skills: Callable[[dict, dict], list],
    window_days: int = 30,
    now: Optional[datetime] = None,
) -> dict:
    """The payload behind the project Usage area and drill-down (design D7).
    Composes unit A's readers behind a function-local `import usage_scan`, so
    a plain import of this module never reaches the scanner."""
    from skill_hub.infrastructure.usage import usage_scan

    if now is None:
        now = usage_scan.now()
    proj_cfg = (registry.get("projects") or {}).get(project_name, {})
    effective = harnesses.resolve_effective(proj_cfg, registry)
    harness_list = sorted(effective)

    static_footprint = compose(
        project_name,
        registry,
        resolve_skills=resolve_skills,
        harness_ids=effective,
        discoverable=False,
    )["harnesses"]

    all_rows, _ = usage_scan.read_session_rows()
    equipped = _equipped_skill_keys(proj_cfg, registry, resolve_skills)
    byte_maps = _skill_byte_maps(harness_list, registry, equipped)

    display_rows = usage_scan.window_rows(all_rows, project_name, window_days, now)
    # A child remains a child even when its parent transcript was pruned.  The
    # ledger's explicit parent identity is the canonical top-level boundary;
    # children are retained only for the session sheet.
    aggregate_rows = [row for row in display_rows if not row.get("parent_session_id")]
    top_level_rows = [row for row in all_rows if not row.get("parent_session_id")]
    loadout_reader: Callable[[], tuple] = getattr(
        usage_scan, "read_loadout_rows", lambda: ([], [])
    )
    loadout_rows, _ = loadout_reader()
    utilization = usage_scan.utilization_rows(
        aggregate_rows, registry, equipped, window_days, now, loadout_rows
    )
    utilization = _enrich_utilization_with_footprint(
        utilization, byte_maps, harness_list, usage_scan.SCANNED_HARNESSES
    )
    outcomes = usage_scan.outcome_metrics(aggregate_rows, top_level_rows)

    # The static parts are harness-agnostic; "observed" is the one number a
    # scanner-less harness always lacks (design D5).
    footprint = {
        harness_id: {
            "observed": _observed_footprint(display_rows, harness_id, usage_scan.SCANNED_HARNESSES),
            "parts": block["parts"],
            "unknown": block["unknown"],
            "bytes_total": block["bytes_total"],
            "approx_tokens": block["approx_tokens"],
        }
        for harness_id, block in static_footprint.items()
    }

    # Findings are fixed at IDLE_WINDOW_DAYS regardless of the requested
    # window (design D9), so they are evaluated against their own window.
    if window_days == IDLE_WINDOW_DAYS:
        findings_rows = aggregate_rows
        findings_utilization = utilization
        findings_outcomes = outcomes
    else:
        findings_rows = [
            row
            for row in usage_scan.window_rows(all_rows, project_name, IDLE_WINDOW_DAYS, now)
            if not row.get("parent_session_id")
        ]
        findings_utilization = usage_scan.utilization_rows(
            findings_rows, registry, equipped, IDLE_WINDOW_DAYS, now, loadout_rows
        )
        findings_utilization = _enrich_utilization_with_footprint(
            findings_utilization, byte_maps, harness_list, usage_scan.SCANNED_HARNESSES
        )
        findings_outcomes = usage_scan.outcome_metrics(findings_rows, top_level_rows)

    scanned_footprint = {
        h: block for h, block in footprint.items() if h in usage_scan.SCANNED_HARNESSES
    }
    findings = detect_findings(
        project=project_name,
        utilization=findings_utilization,
        outcomes=findings_outcomes,
        footprint=scanned_footprint,
        sessions_in_window=len(findings_rows),
    )

    sessions = [
        {
            "session_id": row.get("session_id"),
            "harness": row.get("harness"),
            "parent_session_id": row.get("parent_session_id"),
            "started_at": row.get("started_at"),
            "last_activity_at": row.get("last_activity_at"),
            "tokens_total": (row.get("tokens") or {}).get("total"),
            "cache_hit_ratio": row.get("cache_hit_ratio"),
            "steering_count": row.get("steering_count"),
            "loadout_assumed": row.get("loadout_assumed"),
            "analysed": True,
        }
        for row in display_rows
    ]
    not_analysed = [
        {"harness": harness_id, "reason": "no_scanner"}
        for harness_id in harness_list
        if harness_id not in usage_scan.SCANNED_HARNESSES
    ]

    return {
        "ok": True,
        "project": project_name,
        "window": window_days,
        "findings_window": IDLE_WINDOW_DAYS,
        "last_scan_at": usage_scan.last_scan_at(),
        "harnesses": harness_list,
        "footprint": footprint,
        "utilization": utilization,
        "subagents": _aggregate_subagents(display_rows),
        "outcomes": outcomes,
        "findings": findings,
        "sessions": sessions,
        "not_analysed": not_analysed,
    }


def findings_payload(
    registry: dict,
    *,
    resolve_skills: Callable[[dict, dict], list],
    project: Optional[str] = None,
    now: Optional[datetime] = None,
) -> dict:
    """`{ok, window, findings_window, last_scan_at, findings}` — the payload
    the navigator plaque reads (design D7). Delegates entirely to
    `project_payload` per project, so the utilization enrichment
    (`footprint_bytes`/`harnesses`) that feeds the per-skill footprint
    finding is already applied by the time `findings` is extracted here.

    R9: an explicit, unknown `project` is the one case none of the other
    reads could confuse with "clean" — `project`, `footprint` and `session`
    all carry a `reason` for a bad name, so this one must too, rather than
    reporting `ok: true, findings: []` and letting a stale project name read
    as an all-clear.
    """
    from skill_hub.infrastructure.usage import usage_scan

    if now is None:
        now = usage_scan.now()
    projects_cfg = registry.get("projects") or {}
    if project is not None and project not in projects_cfg:
        return {
            "ok": False,
            "reason": "not_found",
            "window": IDLE_WINDOW_DAYS,
            "findings_window": IDLE_WINDOW_DAYS,
            "last_scan_at": usage_scan.last_scan_at(),
            "findings": [],
        }
    names = [project] if project else sorted(projects_cfg)

    all_findings: list = []
    for name in names:
        if name not in projects_cfg:
            continue
        payload = project_payload(
            name,
            registry,
            resolve_skills=resolve_skills,
            window_days=IDLE_WINDOW_DAYS,
            now=now,
        )
        all_findings.extend(payload["findings"])

    rows = usage_scan.read_session_rows()[0]
    analysed_sessions = sorted(
        f"{row.get('harness')}:{row.get('session_id')}"
        for row in rows
        if project is None or row.get("project") == project
    )
    return {
        "ok": True,
        "window": IDLE_WINDOW_DAYS,
        "findings_window": IDLE_WINDOW_DAYS,
        "last_scan_at": usage_scan.last_scan_at(),
        "findings": all_findings,
        "analysed_sessions": analysed_sessions,
    }
