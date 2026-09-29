"""MCP delivery truth: per-(harness, scope, server) sync-report rows, the
Claude Code project approval writer, and the MCP doctor leg.

A leaf (stdlib + `hub_core`-adjacent siblings only: `risks`, `permissions`,
`permission_adapter_codex`, `permission_adapter_base`, `mcp_spec`). Never
imports `hub` or `mcp_sync` — `tests/test_hub_split_guard.py::LEAF_SIBLINGS`
enforces this.

Three separate truths (plans/C.md §2), kept separate on purpose:

1. Did hub write it? — `rows_from_project_result` / `rows_from_global_result`
   turn a `McpProjectWriteResult` / `GlobalMcpWriteResult` (wave A/B) into rows.
2. Will the harness load it? — the two static gates below
   (`claude_project_approval_state`, `codex_project_trust_state`) plus
   `write_claude_approval`, which produce `blocked` rows and doctor findings.
3. Does the server answer? — NOT here. That is `mcp_probe.py`'s live probe,
   never run from sync (`doctor_findings` reads the probe *cache* only).

`doctor_findings` also lives here (not `risks.py`) so `hub.py`'s own doctor
leg stays a three-line guarded call (grill M2: `hub.py` had 42 lines of
headroom under `MAX_HUB_LINES`).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Mapping, Optional

from skill_hub.domain.diagnostics.risks import RiskFinding, RiskSeverity
from skill_hub.domain.mcp import mcp_spec
from skill_hub.domain.permissions.permission_adapter_base import _atomic_replace, _backup_once_per_session
from skill_hub.domain.permissions.permissions import ProjectScope, delete_sidecar, read_sidecar, write_sidecar
from skill_hub.infrastructure.mcp import mcp_probe

if TYPE_CHECKING:
    from skill_hub.application.harnesses.harness_operation_context import OperationAdapterContext

__all__ = [
    "DELIVERY_STATES",
    "DELIVERY_REASONS",
    "delivery_row",
    "rows_from_project_result",
    "rows_from_global_result",
    "claude_project_approval_state",
    "write_claude_approval",
    "codex_project_trust_state",
    "doctor_findings",
]

# ─────────────────────────────────────────────────────────────────────────────
# Vocabularies (plans/INTERFACES.md §4)
# ─────────────────────────────────────────────────────────────────────────────

DELIVERY_STATES: frozenset = frozenset({"written", "unchanged", "skipped", "blocked"})

#: Every non-null `<delivery row>.reason` word this module may emit. A new word
#: needs a row here first (plans/INTERFACES.md "Change control").
DELIVERY_REASONS: frozenset = frozenset({
    "affinity",
    "no_global_target",
    "not_hub_owned",
    "adapter_missing",
    "parse_aborted",
    "claude_project_not_approved",
    "codex_untrusted_project",
    "codex_no_sse",
    "codex_header_not_representable",
    "codex_env_not_representable",
    "opencode_default_dropped",
})

_APPROVAL_SIDECAR_KIND = "mcp-approval"


# ─────────────────────────────────────────────────────────────────────────────
# The delivery row
# ─────────────────────────────────────────────────────────────────────────────


def delivery_row(
    *,
    harness: str,
    adapter: str,
    scope: str,
    server: str,
    target_file: str,
    state: str,
    reason: Optional[str] = None,
    detail: Optional[str] = None,
    operation_context: Optional["OperationAdapterContext"] = None,
    spec: object = None,
) -> dict:
    """One `<delivery row>` (plans/INTERFACES.md §4).

    `reason` may be a bare word (`"codex_no_sse"`) or carry the
    `mcp_spec.to_native` `<reason>:<detail>` grammar
    (`"codex_header_not_representable:X-Trace"`) — when `detail` is not passed
    explicitly, a colon in `reason` is split on the FIRST `:` (F3).
    """
    if reason is not None and detail is None and ":" in reason:
        reason, _, split_detail = reason.partition(":")
        detail = split_detail or None
    row = {
        "harness": harness,
        "adapter": adapter,
        "scope": scope,
        "server": server,
        "target_file": target_file,
        "state": state,
        "reason": reason,
        "detail": detail,
    }
    if operation_context is not None:
        row.update(operation_context.row_metadata(harness))
        if spec is not None:
            compatibility = row.get("compatibility")
            if isinstance(compatibility, dict):
                compatibility["comparison"] = operation_context.compare_mcp(
                    harness, adapter, spec
                )
    return row


def _annotate_context(
    rows: list[dict],
    operation_context: Optional["OperationAdapterContext"],
    *,
    adapter: str = "",
    specs: Optional[Mapping[str, object]] = None,
) -> list[dict]:
    if operation_context is not None:
        for row in rows:
            row.update(operation_context.row_metadata(row["harness"]))
            spec = specs.get(row["server"]) if specs is not None else None
            if spec is not None:
                row["compatibility"]["comparison"] = operation_context.compare_mcp(
                    row["harness"], adapter, spec
                )
    return rows


def rows_from_project_result(
    result,
    *,
    harness_ids: list,
    adapter: str,
    scope_label: str,
    operation_context: Optional["OperationAdapterContext"] = None,
    specs: Optional[Mapping[str, object]] = None,
) -> list:
    """`<delivery row>` list for one project-scope `McpAdapter.write` result.

    One row per (harness in `harness_ids`, server, applicable reason) — a
    shared file (e.g. `.mcp.json` serving both `claude-code` and `pi`) reaches
    every harness that reads it, even though only one physical write happened.
    """
    rows: list = []
    target_file = str(result.target) if result.target is not None else ""

    if result.aborted:
        for harness in harness_ids:
            for name in sorted(result.managed):
                rows.append(
                    delivery_row(
                        harness=harness,
                        adapter=adapter,
                        scope=scope_label,
                        server=name,
                        target_file=target_file,
                        state="skipped",
                        reason="parse_aborted",
                    )
                )
        return _annotate_context(rows, operation_context, adapter=adapter, specs=specs)

    written = set(result.added) | set(result.updated)
    unchanged = (set(result.managed) - written) | set(result.adopted)

    for harness in harness_ids:
        for name in sorted(written):
            rows.append(
                delivery_row(
                    harness=harness,
                    adapter=adapter,
                    scope=scope_label,
                    server=name,
                    target_file=target_file,
                    state="written",
                )
            )
        for name in sorted(unchanged):
            rows.append(
                delivery_row(
                    harness=harness,
                    adapter=adapter,
                    scope=scope_label,
                    server=name,
                    target_file=target_file,
                    state="unchanged",
                )
            )
        for name in sorted(result.preserved):
            rows.append(
                delivery_row(
                    harness=harness,
                    adapter=adapter,
                    scope=scope_label,
                    server=name,
                    target_file=target_file,
                    state="skipped",
                    reason="not_hub_owned",
                )
            )
        for name in sorted(result.skips):
            for reason_str in result.skips[name]:
                rows.append(
                    delivery_row(
                        harness=harness,
                        adapter=adapter,
                        scope=scope_label,
                        server=name,
                        target_file=target_file,
                        state="skipped",
                        reason=reason_str,
                    )
                )
    return _annotate_context(rows, operation_context, adapter=adapter, specs=specs)


def rows_from_global_result(
    result,
    *,
    harness_id: str,
    adapter: str,
    target: Path,
    operation_context: Optional["OperationAdapterContext"] = None,
    specs: Optional[Mapping[str, object]] = None,
) -> list:
    """`<delivery row>` list for one `write_global` result (scope: "global").

    `GlobalMcpWriteResult` carries no `preserved`/`adopted` split (wave A/B —
    a global target is entirely hub-owned, there is no third-party entry to
    preserve). It DOES carry `updated` (W-5): a name already `managed` that
    was rewritten in place (its serialised entry changed) is `written`, same
    as a brand-new name — only a byte-identical re-sync reads `unchanged`.
    """
    rows: list = []
    target_file = str(target)

    if result.aborted:
        for name in sorted(result.managed):
            rows.append(
                delivery_row(
                    harness=harness_id,
                    adapter=adapter,
                    scope="global",
                    server=name,
                    target_file=target_file,
                    state="skipped",
                    reason="parse_aborted",
                )
            )
        return _annotate_context(rows, operation_context, adapter=adapter, specs=specs)

    written = set(result.added) | set(result.updated)
    unchanged = set(result.managed) - written

    for name in sorted(written):
        rows.append(
            delivery_row(
                harness=harness_id,
                adapter=adapter,
                scope="global",
                server=name,
                target_file=target_file,
                state="written",
            )
        )
    for name in sorted(unchanged):
        rows.append(
            delivery_row(
                harness=harness_id,
                adapter=adapter,
                scope="global",
                server=name,
                target_file=target_file,
                state="unchanged",
            )
        )
    for name in sorted(result.skips):
        for reason_str in result.skips[name]:
            rows.append(
                delivery_row(
                    harness=harness_id,
                    adapter=adapter,
                    scope="global",
                    server=name,
                    target_file=target_file,
                    state="skipped",
                    reason=reason_str,
                )
            )
    return _annotate_context(rows, operation_context, adapter=adapter, specs=specs)


# ─────────────────────────────────────────────────────────────────────────────
# Claude Code project approval — `.claude/settings.local.json` `enabledMcpjsonServers`
# ─────────────────────────────────────────────────────────────────────────────


def _approval_scope(project_name: str, project_root: Path) -> ProjectScope:
    return ProjectScope(name=project_name, path=str(project_root), personal=True)


def _read_approval_target(
    project_root: Path, target_path: Optional[Path] = None
) -> tuple:
    """`(data, existing_text, error_reason)` for `.claude/settings.local.json`.

    `error_reason` is one of `"settings_unparseable"` / `"settings_not_object"`
    / `None`. A missing file is NOT an error: `({}, None, None)`.
    """
    target = target_path or (project_root / ".claude" / "settings.local.json")
    if not target.exists():
        return {}, None, None
    try:
        existing_text = target.read_text(encoding="utf-8")
        parsed = json.loads(existing_text)
    except (OSError, json.JSONDecodeError):
        return {}, None, "settings_unparseable"
    if not isinstance(parsed, dict):
        return {}, None, "settings_not_object"
    return parsed, existing_text, None


def claude_project_approval_state(
    project_root: Path, names: set, target_path: Optional[Path] = None
) -> tuple:
    """Read-only gate: which of `names` are currently listed in
    `enabledMcpjsonServers`, and whether the file could be read at all.

    Returns `(approved_subset_of_names, error_reason)`. Never writes.
    """
    data, _existing_text, error_reason = _read_approval_target(project_root, target_path)
    if error_reason is not None:
        return set(), error_reason
    current = data.get("enabledMcpjsonServers")
    current_set = {x for x in current if isinstance(x, str)} if isinstance(current, list) else set()
    return current_set & set(names), None


def write_claude_approval(
    project_root: Path,
    project_name: str,
    names: set,
    harness_id: str,
    target_path: Optional[Path] = None,
) -> tuple:
    """Write exactly the hub-owned names into `enabledMcpjsonServers`.

    Only that one array is hub-owned (tracked in a `kind="mcp-approval"`
    sidecar on a PERSONAL `ProjectScope`). Every other top-level key round-
    trips untouched. A name the user added by hand is preserved; a name hub
    previously approved and no longer delivers is removed; a missing/corrupt
    sidecar means hub ADDS but never removes (mirrors `write_global`).

    Returns `(wrote_or_already_correct, error_reason)` —
    `error_reason ∈ {"settings_unparseable", "settings_not_object",
    "write_failed", None}`. On any error the file is left untouched.
    """
    target = target_path or (project_root / ".claude" / "settings.local.json")
    scope = _approval_scope(project_name, project_root)
    names_set = set(names)

    data, existing_text, error_reason = _read_approval_target(project_root, target)
    if error_reason is not None:
        return False, error_reason

    prior = read_sidecar(harness_id, scope, kind=_APPROVAL_SIDECAR_KIND)
    prior_keys = set(prior.managed_keys) if prior is not None else None

    current = data.get("enabledMcpjsonServers")
    current_set = {x for x in current if isinstance(x, str)} if isinstance(current, list) else set()

    if prior_keys is None:
        # No ownership knowledge yet — ADD what hub delivers, never remove.
        final_set = current_set | names_set
    else:
        user_kept = current_set - prior_keys
        final_set = names_set | user_kept

    if final_set == current_set:
        # Byte-stable: do not touch the file. Still reconcile the sidecar so
        # a later run's `prior_keys` reflects what hub delivers NOW.
        if names_set:
            write_sidecar(harness_id, scope, sorted(names_set), target, kind=_APPROVAL_SIDECAR_KIND)
        elif prior is not None:
            delete_sidecar(harness_id, scope, kind=_APPROVAL_SIDECAR_KIND)
        return True, None

    new_data = dict(data)
    if final_set:
        new_data["enabledMcpjsonServers"] = sorted(final_set)
    else:
        new_data.pop("enabledMcpjsonServers", None)

    serialized = json.dumps(new_data, indent=2, ensure_ascii=False)
    had_trailing_newline = existing_text.endswith("\n") if existing_text is not None else True
    if had_trailing_newline:
        serialized += "\n"

    if existing_text is not None:
        _backup_once_per_session(target, scope, harness_id)
    try:
        _atomic_replace(target, serialized)
    except OSError:
        return False, "write_failed"

    if names_set:
        write_sidecar(harness_id, scope, sorted(names_set), target, kind=_APPROVAL_SIDECAR_KIND)
    else:
        delete_sidecar(harness_id, scope, kind=_APPROVAL_SIDECAR_KIND)
    return True, None


# ─────────────────────────────────────────────────────────────────────────────
# Codex project trust — a read-only gate (m11: reuse the existing reader)
# ─────────────────────────────────────────────────────────────────────────────


def codex_project_trust_state(project_root: Path, layout=None) -> bool:
    """True when `~/.codex/config.toml` already marks `project_root` trusted.

    Delegates entirely to `permission_adapter_codex.CodexPermissionAdapter`'s
    existing reader (m11) — never grants trust, only reads it. The MCP writer
    must never auto-trust a project: trust also activates hooks and a
    committed `.codex/config.toml`, and that consent belongs to the
    permissions rules writer.
    """
    from skill_hub.infrastructure.permissions.permission_adapter_codex import CodexPermissionAdapter

    scope = ProjectScope(name=project_root.name, path=str(project_root))
    perms = CodexPermissionAdapter(layout=layout).discover_existing(scope, "codex")
    return bool(perms.project_trust)


# ─────────────────────────────────────────────────────────────────────────────
# Doctor leg (M2: lives here, not risks.py, not hub.py)
# ─────────────────────────────────────────────────────────────────────────────

_STALE_DAYS = 7

#: A `${VAR:-default}` reference — S-1: a value shaped like this resolves to
#: its literal default even when `VAR` is unset, so it is never "unresolved".
_DEFAULT_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*):-[^}]*\}")


def _iter_delivery_rows(report: dict):
    global_delivery = ((report.get("global") or {}).get("mcp") or {}).get("delivery") or []
    for row in global_delivery:
        yield row
    for proj in (report.get("projects") or {}).values():
        if not isinstance(proj, dict):
            continue
        for row in proj.get("mcp_delivery") or []:
            yield row


def _probe_stale_finding(registry: dict) -> Optional[RiskFinding]:
    """`MCP_PROBE_STALE` — read from the probe CACHE only (m13). Never probes.

    W-1: a registered `mcp-server` skill that has NEVER been probed has no
    row in the cache at all, so `cache_age_summary` (which only iterates rows
    already present) counts it zero times. Every such name is counted here as
    never-checked too, on top of whatever `cache_age_summary` finds among the
    rows that do exist (a row with a missing/unparseable `checked_at`).
    """
    cache = mcp_probe.read_probe_cache()
    known = {
        name
        for name, cfg in (registry.get("skills") or {}).items()
        if isinstance(cfg, dict) and cfg.get("type") == "mcp-server"
    }
    bad_rows, stale = mcp_probe.cache_age_summary(cache, stale_days=_STALE_DAYS)
    never_checked = len(known - set(cache)) + bad_rows
    if not never_checked and not stale:
        return None
    parts = []
    if never_checked:
        plural = "s" if never_checked != 1 else ""
        parts.append(f"{never_checked} MCP server{plural} never checked")
    if stale:
        parts.append(f"{stale} last checked more than {_STALE_DAYS} days ago")
    return RiskFinding(
        code="MCP_PROBE_STALE",
        severity=RiskSeverity.INFO.value,
        explanation="Some registered MCP servers have not been probed recently.",
        detail="; ".join(parts),
    )


def doctor_findings(
    report: dict, registry: dict, env: Optional[Mapping] = None
) -> list:
    """The seven MCP doctor findings (plans/INTERFACES.md §5), read entirely
    from this run's sync-report delivery rows plus the registry (never a live
    probe — `MCP_PROBE_STALE` reads the probe cache file only).

    `env` is optional (C-2): a caller that already has a merged environment
    (e.g. `hub mcp check`) may pass it, but the common caller — every `hub
    sync`'s doctor rollup — passes `None`. This function then resolves
    `mcp_probe.resolved_env()` lazily, and only once, the first time it finds
    a delivered spec that actually references a `${VAR}` with no default —
    so an ordinary sync with no such server never spawns the login shell.
    """
    findings: list = []
    seen_by_code: dict = {}

    def _add_once(code: str, dedupe_key, finding: RiskFinding) -> None:
        bucket = seen_by_code.setdefault(code, set())
        if dedupe_key in bucket:
            return
        bucket.add(dedupe_key)
        findings.append(finding)

    for row in _iter_delivery_rows(report):
        state = row.get("state")
        reason = row.get("reason")
        server = row.get("server", "?")
        harness = row.get("harness", "?")
        target = row.get("target_file", "") or ""
        dedupe_key = (harness, server, target)

        if state == "blocked" and reason == "claude_project_not_approved":
            _add_once(
                "MCP_PROJECT_SERVER_NOT_APPROVED",
                dedupe_key,
                RiskFinding(
                    code="MCP_PROJECT_SERVER_NOT_APPROVED",
                    severity=RiskSeverity.WARNING.value,
                    explanation=(
                        "A project MCP server is written to .mcp.json but not "
                        "approved in .claude/settings.local.json — Claude Code "
                        "will not load it in an untrusted folder."
                    ),
                    detail=f"{server} ({harness}) — {target}",
                ),
            )
        elif state == "blocked" and reason == "codex_untrusted_project":
            _add_once(
                "MCP_CODEX_PROJECT_UNTRUSTED",
                dedupe_key,
                RiskFinding(
                    code="MCP_CODEX_PROJECT_UNTRUSTED",
                    severity=RiskSeverity.WARNING.value,
                    explanation=(
                        "A project [mcp_servers.*] table was written but the "
                        "project has no trust_level = \"trusted\" in "
                        "~/.codex/config.toml — Codex will not load it."
                    ),
                    detail=f"{server} ({harness}) — {target}",
                ),
            )
        elif state == "skipped" and reason == "no_global_target":
            _add_once(
                "MCP_NO_GLOBAL_TARGET",
                dedupe_key,
                RiskFinding(
                    code="MCP_NO_GLOBAL_TARGET",
                    severity=RiskSeverity.INFO.value,
                    explanation=(
                        "This harness has no user-global MCP config target — a "
                        "scope: global server only reaches it via per-project equip."
                    ),
                    detail=f"{server} ({harness})",
                ),
            )
        elif state == "skipped" and reason == "not_hub_owned":
            _add_once(
                "MCP_UNCLAIMED_NATIVE_ENTRY",
                dedupe_key,
                RiskFinding(
                    code="MCP_UNCLAIMED_NATIVE_ENTRY",
                    severity=RiskSeverity.INFO.value,
                    explanation=(
                        "A registered MCP server has a native entry that hub does "
                        "not own — it was left untouched."
                    ),
                    detail=f"{server} ({harness}) — {target}",
                ),
            )

    # Registry-driven: unresolved ${VAR} refs + literal secrets, restricted to
    # servers this run actually attempted to deliver (present in some row).
    delivered_names = {row.get("server") for row in _iter_delivery_rows(report) if row.get("server")}
    skills = registry.get("skills") if isinstance(registry, dict) else None
    resolved_env_map: Optional[Mapping] = env
    if isinstance(skills, dict):
        for name in sorted(delivered_names):
            cfg = skills.get(name)
            if not isinstance(cfg, dict) or cfg.get("type") != "mcp-server":
                continue
            try:
                spec = mcp_spec.raw_spec_from_registry(name, cfg)
            except Exception:
                continue

            unresolved: set = set()
            values = list(spec.env.values()) + list(spec.headers.values())
            if spec.url:
                values.append(spec.url)
            # S-1: a `${VAR:-default}` reference resolves to its literal
            # default even when VAR is unset — never "unresolved".
            refs_without_default: set = set()
            for value in values:
                if not isinstance(value, str):
                    continue
                defaulted = set(_DEFAULT_REF_RE.findall(value))
                refs_without_default |= set(mcp_spec.ref_names(value)) - defaulted
            if refs_without_default and resolved_env_map is None:
                # Lazy, once: only a delivered spec with a real (no-default)
                # ${VAR} reference ever triggers the login-shell snapshot.
                resolved_env_map = mcp_probe.resolved_env()[0]
            for ref in refs_without_default:
                if ref not in (resolved_env_map or {}):
                    unresolved.add(ref)
            if unresolved:
                findings.append(
                    RiskFinding(
                        code="MCP_UNRESOLVED_SECRET_REF",
                        severity=RiskSeverity.INFO.value,
                        explanation=(
                            "A delivered MCP server references an environment "
                            "variable that is not set."
                        ),
                        detail=f"{name}: {', '.join(sorted(unresolved))}",
                    )
                )

            if spec.allow_literal_secrets:
                secret_keys = mcp_spec.secret_keys_in_spec(spec)
                if secret_keys:
                    findings.append(
                        RiskFinding(
                            code="MCP_LITERAL_SECRET",
                            severity=RiskSeverity.WARNING.value,
                            explanation=(
                                "A delivered MCP server carries a literal "
                                "credential-looking value instead of a ${VAR} "
                                "reference."
                            ),
                            detail=f"{name}: {', '.join(secret_keys)}",
                        )
                    )

    stale = _probe_stale_finding(registry if isinstance(registry, dict) else {})
    if stale is not None:
        findings.append(stale)

    return findings
