"""MCP adapter abstraction — write MCP server specs to per-harness config files.

Two v1 adapters:

- `ClaudeMcpAdapter` writes `.mcp.json` (JSON `mcpServers`). Used by BOTH
  `claude-code` and `pi` — Pi docs prefer `.mcp.json` as project-local MCP
  config. The adapter instance is shared so dispatch dedup naturally collapses
  the two harnesses to one write.
- `CodexMcpAdapter` writes `.codex/config.toml` `[mcp_servers.<name>]` tables,
  round-tripping via `tomlkit` to preserve all unrelated content (model,
  `[projects.*]`, `[plugins.*]`, `[marketplaces.*]`, comments, key order).

Project-level ownership (wave A, plans/A.md §2): each `write`/`remove` call
takes the caller's `harness_id` + `project_name` and consults a name-keyed
sidecar (`permissions.{read,write,delete}_sidecar`, `kind="mcp"`) so cleanup
only ever touches names hub itself put there — the same discipline
`write_global` already has, now extended to the per-project writers. See the
two-tier "First run and migration" rule below `_apply_project_ownership`.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Mapping, Optional, Protocol

from skill_hub.domain.mcp.mcp_spec import McpServerSpec, normalize_native, to_native  # noqa: F401 (re-exported)
from skill_hub.domain.permissions.permissions import ProjectScope, delete_sidecar, read_sidecar, write_sidecar
from skill_hub.hub_core import _TOMLKIT_MISSING_REASON, _tomlkit_missing

if TYPE_CHECKING:  # pragma: no cover - typing only
    from skill_hub.application.harnesses.harness_operation_context import OperationAdapterContext

__all__ = [
    "McpServerSpec",
    "McpProjectWriteResult",
    "McpAdapter",
    "GlobalMcpWriteResult",
    "ClaudeMcpAdapter",
    "CodexMcpAdapter",
    "OpenCodeMcpAdapter",
    "ADAPTERS",
    "get_adapter",
    "select_mcp_adapter",
    "select_mcp_decoder",
    "select_adapter",
    "encode_native",
    "decode_native",
]


@dataclass(frozen=True)
class McpProjectWriteResult:
    """Outcome of a per-project `McpAdapter.write`/`.remove` call.

    Mirrors `GlobalMcpWriteResult` but frozenset-typed (M1: a `frozen=True`
    dataclass cannot take a mutable `set` default, and `mcp_adapters.py` is
    under strict mypy — `tests/test_lint_baseline.py:32`).

    `preserved` and `adopted` carry the two-tier ownership outcomes (see
    `_apply_project_ownership`): `preserved` is a name hub declines to write
    because it is not (yet) hub-owned; `adopted` is a name hub claims on
    first sight because the on-disk entry is byte-identical to what hub would
    write (the upgrade path — no sidecar existed yet). `skips` (wave B) maps
    a server name to the `mcp_spec.to_native` skip-reason strings for THIS
    adapter — populated even for a server whose entry was written (a partial
    skip, e.g. one unrepresentable header) and for one written nowhere at all
    (a whole-server refusal, e.g. `codex_no_sse`).
    """

    managed: frozenset[str]
    added: frozenset[str] = frozenset()
    updated: frozenset[str] = frozenset()
    removed: frozenset[str] = frozenset()
    preserved: frozenset[str] = frozenset()
    adopted: frozenset[str] = frozenset()
    changed: bool = False
    aborted: bool = False
    target: Optional[Path] = None
    skips: dict[str, list[str]] = field(default_factory=dict)


class McpAdapter(Protocol):
    """Each harness's `mcp_adapter` (when not None) implements this."""

    def write(
        self,
        project_root: Path,
        specs: list[McpServerSpec],
        *,
        harness_id: str,
        project_name: str,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult: ...

    def remove(
        self,
        project_root: Path,
        names: set[str],
        *,
        harness_id: str,
        project_name: str,
        dry_run: bool = False,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult: ...


@dataclass(frozen=True)
class GlobalMcpWriteResult:
    """Outcome of a `write_global` call.

    `managed` is the set of hub-owned global server names now present in the
    file (= the names to persist to the sidecar). `changed` is True only when
    the write actually altered the file on disk (drives backup + logging).
    `aborted` is True when the target existed but could not be parsed (the file
    was left untouched). `skips` (wave B) mirrors `McpProjectWriteResult.skips`.
    `updated` (wave C, W-5) is the subset of `managed` that was ALREADY present
    (in `prior_managed`) whose serialised entry changed on this write — without
    it, `mcp_delivery.py` cannot distinguish an in-place edit from a byte-stable
    re-sync and books both as `unchanged`.
    """

    managed: set[str]
    added: set[str] = field(default_factory=set)
    removed: set[str] = field(default_factory=set)
    updated: set[str] = field(default_factory=set)
    changed: bool = False
    aborted: bool = False
    skips: dict[str, list[str]] = field(default_factory=dict)


def backup_global_mcp(harness_id: str, ext: str, source: Path) -> Optional[Path]:
    """Copy `source` to `~/.skill-hub/_hub-backups/mcp/<harness>/global/<ts>.<ext>`.

    Returns the backup path, or None if the source does not exist (a brand-new
    file has nothing to back up). Callers MUST only invoke this when a write
    actually changes the file (no backup spam on idempotent syncs).
    """
    if not source.exists():
        return None
    from skill_hub import hub_core  # leaf primitives; kept local to keep module import cheap

    ts = datetime.now().strftime("%Y%m%dT%H%M%S_%f")
    backup_dir = hub_core.data_home() / "_hub-backups" / "mcp" / harness_id / "global"
    backup_dir.mkdir(parents=True, exist_ok=True)
    dest = backup_dir / f"{ts}.{ext}"
    shutil.copy2(source, dest)
    return dest


def _atomic_write_text(path: Path, text: str) -> None:
    """Write `text` to `path` via a sibling temp file + `os.replace` (same fs)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.hub-tmp.{os.getpid()}")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


# ─────────────────────────────────────────────────────────────────────────────
# Project-level ownership: the sidecar and the two-tier adopt/preserve/manage
# rule shared by all three project writers (plans/A.md §2, §3)
# ─────────────────────────────────────────────────────────────────────────────

# The claude-code/pi shared `.mcp.json` writes ONE sidecar for both harness
# ids: WRITE under claude-code when it is effective for the project, else pi;
# READ checks both ids in this fixed order and takes the first that exists
# (m1). Every other adapter key maps 1:1 onto its own harness id.
_CLAUDE_FAMILY_IDS: tuple[str, ...] = ("claude-code", "pi")


def _project_scope(project_name: str, project_root: Path) -> ProjectScope:
    return ProjectScope(name=project_name, path=str(project_root))


def _project_sidecar_read(
    harness_id: str, project_name: str, project_root: Path, *, data_home_path: Optional[Path] = None
) -> tuple[Optional[set[str]], dict[str, object], Optional[str]]:
    """Read the project MCP sidecar for `(harness_id, project_name)`.

    Returns `(managed_keys, managed_values, found_under)`. `managed_keys` is
    None when no sidecar exists (or it is corrupt — `read_sidecar` already
    degrades that to None) for ANY of the ids consulted — "no prior ownership
    knowledge", the signal that gates the whole two-tier rule below.
    `managed_values` is the v2 name→entry snapshot hub recorded at write time
    (empty dict when absent, e.g. a v1 sidecar predating this field) — the
    removal path uses it to detect a hand-edit since (W3). `found_under` names
    the harness id the sidecar was actually found under, so a write under a
    new representative id can migrate it (m1).
    """
    scope = _project_scope(project_name, project_root)
    ids = _CLAUDE_FAMILY_IDS if harness_id in _CLAUDE_FAMILY_IDS else (harness_id,)
    for hid in ids:
        state = read_sidecar(hid, scope, kind="mcp", data_home_path=data_home_path)
        if state is not None:
            return set(state.managed_keys), dict(state.managed_values), hid
    return None, {}, None


def _project_sidecar_write(
    harness_id: str,
    project_name: str,
    project_root: Path,
    target: Path,
    managed: set[str],
    managed_values: Mapping[str, object],
    found_under: Optional[str],
    *, data_home_path: Optional[Path] = None,
) -> None:
    """Write the sidecar under `harness_id` (the current representative),
    migrating away from `found_under` when it names a different id (m1).

    `managed_values` records the entry hub wrote for each managed name (W3),
    so a later removal can tell an untouched entry from a hand-edited one.
    """
    scope = _project_scope(project_name, project_root)
    write_sidecar(
        harness_id,
        scope,
        sorted(managed),
        target,
        kind="mcp",
        managed_values=dict(managed_values),
        data_home_path=data_home_path,
    )
    if found_under is not None and found_under != harness_id:
        delete_sidecar(found_under, scope, kind="mcp", data_home_path=data_home_path)


def _project_sidecar_delete(
    harness_id: str, project_name: str, project_root: Path, found_under: Optional[str], *,
    data_home_path: Optional[Path] = None,
) -> None:
    scope = _project_scope(project_name, project_root)
    delete_sidecar(harness_id, scope, kind="mcp", data_home_path=data_home_path)
    if found_under is not None and found_under != harness_id:
        delete_sidecar(found_under, scope, kind="mcp", data_home_path=data_home_path)


def _entry_matches_recorded(entry: object, recorded: Optional[object]) -> bool:
    """True when `entry` (the current on-disk value) is safe to treat as
    still-hub-written for removal purposes (W3): either there is no recorded
    v2 value to check against (a v1 sidecar, or this name predates the v2
    field — fall back to the old trust-the-key rule), or the value is
    unchanged since hub wrote it."""
    return recorded is None or entry == recorded


def _apply_project_ownership(
    existing: Mapping[str, object],
    desired: Mapping[str, object],
    managed_keys: Optional[set[str]],
    managed_values: Optional[Mapping[str, object]] = None,
) -> tuple[set[str], set[str], set[str], set[str], set[str], set[str]]:
    """The two-tier ownership rule (plans/A.md §2 "First run and migration").

    | sidecar          | name in `desired` AND in `existing`   | outcome              |
    |-------------------|---------------------------------------|-----------------------|
    | absent (None)     | entry EQUAL to what hub would write   | adopted (claimed)     |
    | absent (None)     | entry DIFFERS                          | preserved (untouched) |
    | present           | name NOT in managed_keys               | preserved (strict)    |
    | present           | name IN managed_keys                   | written/updated       |

    A `desired` name absent from `existing` is always simply `added` — there
    is nothing there to preserve, regardless of sidecar state. Removal only
    ever drops a `managed_keys` name that has fallen out of `desired`, only
    when a sidecar exists (no sidecar ⇒ no removal — a strict machine that
    never learned ownership must never delete a stranger's entry), AND only
    when the on-disk entry still matches the recorded `managed_values` value
    (W3) — a hub-owned entry the user hand-edited since is `preserved`, not
    silently deleted, so an unequip never eats an in-place edit.

    Returns `(added, updated, removed, preserved, adopted, managed)` name
    sets. `managed` is the set the caller should persist to the sidecar (or,
    if empty, delete the sidecar for).
    """
    added: set[str] = set()
    updated: set[str] = set()
    removed: set[str] = set()
    preserved: set[str] = set()
    adopted: set[str] = set()
    managed: set[str] = set()

    sidecar_present = managed_keys is not None
    managed_set = set(managed_keys) if managed_keys is not None else set()
    values = managed_values or {}

    for name, entry in desired.items():
        cur = existing.get(name)
        if cur is None:
            added.add(name)
            managed.add(name)
            continue
        if sidecar_present:
            if name in managed_set:
                if cur != entry:
                    updated.add(name)
                managed.add(name)
            else:
                preserved.add(name)
        else:
            if cur == entry:
                adopted.add(name)
                managed.add(name)
            else:
                preserved.add(name)

    if sidecar_present:
        for name in managed_set:
            if name not in desired and name in existing:
                if _entry_matches_recorded(existing[name], values.get(name)):
                    removed.add(name)
                else:
                    preserved.add(name)

    return added, updated, removed, preserved, adopted, managed


# ─────────────────────────────────────────────────────────────────────────────
# `to_native` delegation shared by all three project writers (wave B)
# ─────────────────────────────────────────────────────────────────────────────


def _build_desired(specs: list, to_entry) -> tuple[dict, dict[str, list[str]]]:
    """Run `to_entry` (an adapter's own `_spec_to_entry`, which wraps
    `mcp_spec.to_native`) over `specs`.

    Returns `(desired, skips)`: `desired` maps server name to its native
    entry, and `skips` maps a server name to its skip-reason strings — a
    name appears in `skips` whether or not it also appears in `desired`
    (a partial skip, e.g. one unrepresentable header, still writes an
    entry; a whole-server refusal, e.g. `codex_no_sse`, comes back with an
    EMPTY entry and is therefore left OUT of `desired` — nothing is written
    for it anywhere).
    """
    desired: dict = {}
    skips: dict[str, list[str]] = {}
    for s in specs:
        entry, skip_reasons = to_entry(s)
        if skip_reasons:
            skips[s.name] = skip_reasons
        if entry:
            desired[s.name] = entry
    return desired, skips


def _dict_to_toml_table(entry: dict):
    """A plain `to_native` dict → a `tomlkit` table, key order preserved."""
    import tomlkit

    table = tomlkit.table()
    for key, value in entry.items():
        table.add(key, value)
    return table


# ─────────────────────────────────────────────────────────────────────────────
# Claude / Pi — .mcp.json (JSON `mcpServers`)
# ─────────────────────────────────────────────────────────────────────────────


class ClaudeMcpAdapter:
    """Writes `<project>/.mcp.json` with `mcpServers` object.

    Pi docs declare `.mcp.json` as the preferred project-local MCP config, so
    this adapter is shared between the `claude-code` and `pi` harnesses.
    """

    file_relative = ".mcp.json"
    format_key = "json"
    adapter_key = "claude"

    def _spec_to_entry(self, spec: McpServerSpec) -> tuple[dict, list[str]]:
        return to_native(spec, self.adapter_key)

    def write(
        self,
        project_root: Path,
        specs: list[McpServerSpec],
        *,
        harness_id: str,
        project_name: str,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult:
        path = project_root / self.file_relative
        existing_text: Optional[str] = None
        data: dict = {}
        if path.exists():
            try:
                existing_text = path.read_text(encoding="utf-8")
                data = json.loads(existing_text)
                if not isinstance(data, dict):
                    raise ValueError("top-level JSON is not an object")
                if not isinstance(data.get("mcpServers", {}), dict):
                    raise ValueError("mcpServers is not an object")
            except (OSError, ValueError, json.JSONDecodeError) as e:
                print(
                    f"warning: cannot parse {path}: {e} — skipping .mcp.json for "
                    f"this project (file left untouched)",
                    file=sys.stderr,
                )
                managed_keys, _mv, _fu = _project_sidecar_read(
                    harness_id, project_name, project_root, data_home_path=data_home_path
                )
                return McpProjectWriteResult(
                    managed=frozenset(managed_keys or ()), aborted=True, target=path
                )

        servers = dict(data.get("mcpServers") or {})
        desired, skips = _build_desired(specs, self._spec_to_entry)
        managed_keys, managed_values, found_under = _project_sidecar_read(
            harness_id, project_name, project_root, data_home_path=data_home_path
        )

        if not specs and existing_text is None and managed_keys is None:
            # Nothing to add, nothing on disk, nothing a sidecar lets us
            # remove — do NOT materialize a spurious .mcp.json.
            return McpProjectWriteResult(managed=frozenset(), target=path)

        added, updated, removed, preserved, adopted, managed = _apply_project_ownership(
            servers, desired, managed_keys, managed_values
        )

        if not (added or updated or removed):
            # Nothing to mutate — an adopted/preserved-only run must leave the
            # file exactly as found, not merely content-equal-after-reformat.
            changed = False
        else:
            new_servers = dict(servers)
            for name in added | updated:
                new_servers[name] = desired[name]
            for name in removed:
                new_servers.pop(name, None)

            new_data = dict(data)
            if new_servers:
                new_data["mcpServers"] = new_servers
            else:
                new_data.pop("mcpServers", None)

            if not new_data:
                # .mcp.json is MCP-dedicated: nothing left to hold, remove it.
                changed = path.exists()
                if changed:
                    path.unlink()
            else:
                serialized = json.dumps(new_data, indent=2, ensure_ascii=False)
                had_trailing_newline = (
                    existing_text.endswith("\n") if existing_text is not None else True
                )
                if had_trailing_newline:
                    serialized += "\n"
                changed = existing_text != serialized
                if changed:
                    _atomic_write_text(path, serialized)

        if managed:
            _project_sidecar_write(
                harness_id,
                project_name,
                project_root,
                path,
                managed,
                {name: desired[name] for name in managed},
                found_under,
                data_home_path=data_home_path,
            )
        else:
            _project_sidecar_delete(harness_id, project_name, project_root, found_under, data_home_path=data_home_path)

        return McpProjectWriteResult(
            managed=frozenset(managed),
            added=frozenset(added),
            updated=frozenset(updated),
            removed=frozenset(removed),
            preserved=frozenset(preserved),
            adopted=frozenset(adopted),
            changed=changed,
            target=path,
            skips=skips,
        )

    def remove(
        self,
        project_root: Path,
        names: set[str],
        *,
        harness_id: str,
        project_name: str,
        dry_run: bool = False,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult:
        path = project_root / self.file_relative
        managed_keys, managed_values, found_under = _project_sidecar_read(
            harness_id, project_name, project_root, data_home_path=data_home_path
        )
        managed_set = set(managed_keys or ())
        if not path.exists():
            return McpProjectWriteResult(managed=frozenset(managed_set), target=path)
        try:
            existing_text = path.read_text(encoding="utf-8")
            data = json.loads(existing_text)
            if not isinstance(data, dict):
                data = {}
        except (OSError, json.JSONDecodeError):
            return McpProjectWriteResult(managed=frozenset(managed_set), target=path)

        servers = dict(data.get("mcpServers") or {})
        # Ownership-gated AND value-verified (W3): a name must be BOTH
        # requested, sidecar-owned, AND unchanged since hub wrote it — a
        # hub-owned entry the user hand-edited is declined, not deleted.
        to_remove: set[str] = set()
        declined: set[str] = set()
        for n in names:
            if n not in servers:
                continue
            if n not in managed_set:
                declined.add(n)
            elif _entry_matches_recorded(servers[n], managed_values.get(n)):
                to_remove.add(n)
            else:
                declined.add(n)
        if not to_remove:
            return McpProjectWriteResult(
                managed=frozenset(managed_set), preserved=frozenset(declined), target=path
            )
        if dry_run:
            return McpProjectWriteResult(
                managed=frozenset(managed_set - to_remove - declined),
                removed=frozenset(to_remove), preserved=frozenset(declined),
                changed=True, target=path,
            )

        new_servers = dict(servers)
        for k in to_remove:
            del new_servers[k]
        new_data = dict(data)
        if new_servers:
            new_data["mcpServers"] = new_servers
        else:
            new_data.pop("mcpServers", None)

        if not new_data:
            path.unlink()
            changed = True
        else:
            serialized = json.dumps(new_data, indent=2, ensure_ascii=False)
            if existing_text.endswith("\n"):
                serialized += "\n"
            changed = existing_text != serialized
            if changed:
                _atomic_write_text(path, serialized)

        remaining_managed = managed_set - to_remove - declined
        if remaining_managed:
            _project_sidecar_write(
                harness_id,
                project_name,
                project_root,
                path,
                remaining_managed,
                {n: v for n, v in managed_values.items() if n in remaining_managed},
                found_under,
                data_home_path=data_home_path,
            )
        else:
            _project_sidecar_delete(harness_id, project_name, project_root, found_under, data_home_path=data_home_path)

        return McpProjectWriteResult(
            managed=frozenset(remaining_managed),
            removed=frozenset(to_remove),
            preserved=frozenset(declined),
            changed=changed,
            target=path,
        )

    # ── Global MCP dispatch (user-global ~/.claude.json `mcpServers`) ──────────

    def write_global(
        self,
        global_path: Path,
        specs: list[McpServerSpec],
        prior_managed: Optional[set[str]],
        harness_id: str = "claude-code",
    ) -> GlobalMcpWriteResult:
        """Merge hub-managed specs into ~/.claude.json `mcpServers`, atomically.

        Distinct from `write()`: the live ~/.claude.json is serialized with
        `ensure_ascii=False`, `indent=2`, and NO trailing newline, and contains
        non-ASCII bytes. We MUST round-trip byte-identically, so this method
        does NOT reuse `write()` (which forces `ensure_ascii=True` + a trailing
        `\n`). We preserve every other top-level key and the file's existing
        trailing-newline state.

        Cleanup is scoped strictly to `prior_managed` (the sidecar names): only
        previously-hub-managed names that are no longer in `specs` are removed.
        If `prior_managed` is None (sidecar missing/corrupt), cleanup is a no-op.

        On unparseable existing JSON the write ABORTS (file untouched) and
        returns `aborted=True`.
        """
        existing_text: Optional[str] = None
        data: dict = {}
        had_trailing_newline = False
        if global_path.exists():
            try:
                existing_text = global_path.read_text(encoding="utf-8")
                data = json.loads(existing_text)
                if not isinstance(data, dict):
                    raise ValueError("top-level JSON is not an object")
            except (OSError, ValueError, json.JSONDecodeError) as e:
                print(
                    f"warning: cannot parse {global_path}: {e} — aborting global "
                    f"MCP write for {harness_id} (file left untouched)",
                    file=sys.stderr,
                )
                return GlobalMcpWriteResult(
                    managed=set(prior_managed or set()), aborted=True
                )
            had_trailing_newline = existing_text.endswith("\n")

        prior = set(prior_managed) if prior_managed is not None else None

        # Nothing to add and nothing the sidecar lets us remove on a fresh file
        # → no-op. Do NOT materialize a spurious ~/.claude.json.
        if not specs and existing_text is None:
            return GlobalMcpWriteResult(managed=set(), changed=False)

        servers = dict(data.get("mcpServers") or {})
        added: set[str] = set()
        removed: set[str] = set()
        updated: set[str] = set()
        skips: dict[str, list[str]] = {}
        represented_names: set[str] = set()

        for s in specs:
            entry, skip_reasons = self._spec_to_entry(s)
            if skip_reasons:
                skips[s.name] = skip_reasons
            if not entry:
                continue  # whole-server refusal — write nothing for this name
            represented_names.add(s.name)
            if servers.get(s.name) != entry:
                if s.name not in servers:
                    added.add(s.name)
                elif prior is not None and s.name in prior:
                    # W-5: already hub-managed, already on disk, entry
                    # differs — an in-place edit, not a fresh write.
                    updated.add(s.name)
                servers[s.name] = entry

        # Remove only previously-hub-managed names now absent from the names
        # actually WRITTEN — not from `spec_names` (C1): a whole-server
        # refusal (empty entry, e.g. `codex_no_sse`) never joins
        # `represented_names`, so its stale table is removed here even
        # though the server is still present in `specs`.
        # (review S4, acknowledged, no fix: `_to_native_claude` always returns
        # a non-empty entry, so `represented_names == {s.name for s in specs}`
        # for Claude today — this branch is exercised only on the Codex side
        # until a Claude-side whole-server refusal exists.)
        if prior is not None:
            for name in prior:
                if name not in represented_names and name in servers:
                    del servers[name]
                    removed.add(name)

        new_managed = represented_names

        # Recompute the resulting top-level object and serialize.
        new_data = dict(data)
        if servers or "mcpServers" in data:
            new_data["mcpServers"] = servers
        serialized = json.dumps(new_data, indent=2, ensure_ascii=False)
        if had_trailing_newline:
            serialized += "\n"

        changed = existing_text != serialized
        if not changed:
            return GlobalMcpWriteResult(managed=new_managed, changed=False, skips=skips)

        backup_global_mcp(harness_id, "json", global_path)
        _atomic_write_text(global_path, serialized)
        return GlobalMcpWriteResult(
            managed=new_managed,
            added=added,
            removed=removed,
            updated=updated,
            changed=True,
            skips=skips,
        )


# ─────────────────────────────────────────────────────────────────────────────
# Codex — .codex/config.toml with [mcp_servers.<name>] tables
# ─────────────────────────────────────────────────────────────────────────────


class CodexMcpAdapter:
    """Writes `<project>/.codex/config.toml` MCP server tables via tomlkit.

    Round-trips all non-MCP content (model, [projects.*], [plugins.*], etc.)
    to preserve user-managed config. Malformed TOML triggers a WARN log and
    a skip — Skill Hub never rewrites a file it cannot parse.
    """

    file_relative = "config.toml"
    format_key = "toml"
    adapter_key = "codex"

    def _config_path(self, project_root: Path) -> Path:
        return project_root / ".codex" / self.file_relative

    def _spec_to_entry(self, spec: McpServerSpec) -> tuple[dict, list[str]]:
        return to_native(spec, self.adapter_key)

    def _spec_to_table(self, spec: McpServerSpec):
        """Back-compat name kept for any external caller; returns the entry
        (an empty dict for a whole-server refusal), discarding skip reasons."""
        entry, _skip_reasons = self._spec_to_entry(spec)
        return _dict_to_toml_table(entry)

    def _load_doc(self, path: Path):
        if _tomlkit_missing():
            print(
                f"warning: {_TOMLKIT_MISSING_REASON} — skipping Codex MCP for this project",
                file=sys.stderr,
            )
            return None, False

        import tomlkit

        if not path.exists():
            return tomlkit.document(), True
        try:
            text = path.read_text()
            return tomlkit.parse(text), True
        except Exception as e:
            print(
                f"warning: cannot parse {path}: {e} — skipping Codex MCP for this project",
                file=sys.stderr,
            )
            return None, False

    def write(
        self,
        project_root: Path,
        specs: list[McpServerSpec],
        *,
        harness_id: str,
        project_name: str,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult:
        path = self._config_path(project_root)
        file_existed = path.exists()
        original_text = path.read_text() if file_existed else ""
        doc, ok = self._load_doc(path)
        managed_keys, managed_values, found_under = _project_sidecar_read(
            harness_id, project_name, project_root, data_home_path=data_home_path
        )
        if not ok:
            return McpProjectWriteResult(
                managed=frozenset(managed_keys or ()), aborted=True, target=path
            )

        import tomlkit

        if not specs and not file_existed and managed_keys is None:
            return McpProjectWriteResult(managed=frozenset(), target=path)

        existing_table = doc.get("mcp_servers")
        existing_view: dict = (
            {k: existing_table[k] for k in existing_table} if existing_table is not None else {}
        )
        desired_entries, skips = _build_desired(specs, self._spec_to_entry)
        desired_tables = {
            name: _dict_to_toml_table(entry) for name, entry in desired_entries.items()
        }

        added, updated, removed, preserved, adopted, managed = _apply_project_ownership(
            existing_view, desired_tables, managed_keys, managed_values
        )

        changed = False
        if added or updated or removed:
            # Only mutate on a real delta — an adopted/preserved-only run must
            # leave the file exactly as found (tomlkit round-trips an
            # untouched doc byte-for-byte, but there is no reason to pay for
            # the dump+compare when nothing was asked to change).
            servers = existing_table
            if (added or updated) and servers is None:
                servers = tomlkit.table()
                doc.add("mcp_servers", servers)
            if servers is not None:
                for name in added | updated:
                    servers[name] = desired_tables[name]
                for name in removed:
                    if name in servers:
                        del servers[name]

            serialized = tomlkit.dumps(doc)
            changed = serialized != original_text
            if changed:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(serialized)

        if managed:
            _project_sidecar_write(
                harness_id,
                project_name,
                project_root,
                path,
                managed,
                {name: desired_tables[name].unwrap() for name in managed},
                found_under,
                data_home_path=data_home_path,
            )
        else:
            _project_sidecar_delete(harness_id, project_name, project_root, found_under, data_home_path=data_home_path)

        return McpProjectWriteResult(
            managed=frozenset(managed),
            added=frozenset(added),
            updated=frozenset(updated),
            removed=frozenset(removed),
            preserved=frozenset(preserved),
            adopted=frozenset(adopted),
            changed=changed,
            target=path,
            skips=skips,
        )

    def remove(
        self,
        project_root: Path,
        names: set[str],
        *,
        harness_id: str,
        project_name: str,
        dry_run: bool = False,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult:
        path = self._config_path(project_root)
        managed_keys, managed_values, found_under = _project_sidecar_read(
            harness_id, project_name, project_root, data_home_path=data_home_path
        )
        managed_set = set(managed_keys or ())
        doc, ok = self._load_doc(path)
        if not ok:
            return McpProjectWriteResult(
                managed=frozenset(managed_set), aborted=True, target=path
            )
        if not path.exists():
            return McpProjectWriteResult(managed=frozenset(managed_set), target=path)

        servers = doc.get("mcp_servers")
        if servers is None:
            return McpProjectWriteResult(managed=frozenset(managed_set), target=path)

        # Ownership-gated AND value-verified (W3): a name must be BOTH
        # requested, sidecar-owned, AND unchanged since hub wrote it — a
        # hub-owned entry the user hand-edited is declined, not deleted.
        to_remove: set[str] = set()
        declined: set[str] = set()
        for n in names:
            if n not in servers:
                continue
            if n not in managed_set:
                declined.add(n)
            elif _entry_matches_recorded(servers[n], managed_values.get(n)):
                to_remove.add(n)
            else:
                declined.add(n)
        if not to_remove:
            return McpProjectWriteResult(
                managed=frozenset(managed_set), preserved=frozenset(declined), target=path
            )
        if dry_run:
            return McpProjectWriteResult(
                managed=frozenset(managed_set - to_remove - declined),
                removed=frozenset(to_remove), preserved=frozenset(declined),
                changed=True, target=path,
            )

        import tomlkit

        original_text = path.read_text()
        for k in to_remove:
            del servers[k]
        # Leave the (now possibly empty) [mcp_servers] section header — tomlkit
        # emits it as a blank table; that is less destructive than removing it,
        # and this file carries other user config the removal must not touch.
        serialized = tomlkit.dumps(doc)
        changed = serialized != original_text
        if changed:
            path.write_text(serialized)

        remaining_managed = managed_set - to_remove - declined
        if remaining_managed:
            _project_sidecar_write(
                harness_id,
                project_name,
                project_root,
                path,
                remaining_managed,
                {n: v for n, v in managed_values.items() if n in remaining_managed},
                found_under,
                data_home_path=data_home_path,
            )
        else:
            _project_sidecar_delete(harness_id, project_name, project_root, found_under, data_home_path=data_home_path)

        return McpProjectWriteResult(
            managed=frozenset(remaining_managed),
            removed=frozenset(to_remove),
            preserved=frozenset(declined),
            changed=changed,
            target=path,
        )

    # ── Global MCP dispatch (user-global ~/.codex/config.toml) ────────────────

    def write_global(
        self,
        global_path: Path,
        specs: list[McpServerSpec],
        prior_managed: Optional[set[str]],
        harness_id: str = "codex",
    ) -> GlobalMcpWriteResult:
        """Merge hub-managed `[mcp_servers.<name>]` tables into the ABSOLUTE
        `global_path` (bypassing `_config_path()`, which hardcodes a project
        root), round-tripping via tomlkit so other tables (`node_repl`,
        `startup_timeout_sec`, comments, key order) survive untouched.

        Cleanup is scoped strictly to `prior_managed`. None ⇒ cleanup no-op.
        Unparseable existing TOML ABORTS (file untouched).
        """
        if _tomlkit_missing():
            print(
                f"warning: {_TOMLKIT_MISSING_REASON} — aborting global MCP write "
                f"for {harness_id} (file left untouched)",
                file=sys.stderr,
            )
            return GlobalMcpWriteResult(managed=set(prior_managed or set()), aborted=True)

        import tomlkit

        existing_text: Optional[str] = None
        if global_path.exists():
            try:
                existing_text = global_path.read_text(encoding="utf-8")
                doc = tomlkit.parse(existing_text)
            except Exception as e:
                print(
                    f"warning: cannot parse {global_path}: {e} — aborting global "
                    f"MCP write for {harness_id} (file left untouched)",
                    file=sys.stderr,
                )
                return GlobalMcpWriteResult(
                    managed=set(prior_managed or set()), aborted=True
                )
        else:
            doc = tomlkit.document()

        prior = set(prior_managed) if prior_managed is not None else None
        added: set[str] = set()
        removed: set[str] = set()
        updated: set[str] = set()

        existing_servers = doc.get("mcp_servers")

        # Build every entry FIRST (C1): a whole-server refusal (empty entry,
        # e.g. `codex_no_sse`) must not count as "written", so removal and the
        # early no-op guard below both key off `represented_names` — the names
        # actually written — never off `specs`.
        skips: dict[str, list[str]] = {}
        represented_names: set[str] = set()
        built: dict[str, dict] = {}
        for s in specs:
            entry, skip_reasons = self._spec_to_entry(s)
            if skip_reasons:
                skips[s.name] = skip_reasons
            if not entry:
                continue  # whole-server refusal — write nothing for this name
            represented_names.add(s.name)
            built[s.name] = entry

        # Nothing to add and nothing the sidecar lets us remove → no-op. Do NOT
        # materialize an empty [mcp_servers] table on a fresh file.
        names_to_remove = (
            {n for n in prior if n not in represented_names} if prior is not None else set()
        )
        if not represented_names and (existing_servers is None or not names_to_remove):
            return GlobalMcpWriteResult(managed=set(), changed=False, skips=skips)

        servers = existing_servers
        if servers is None:
            servers = tomlkit.table()
            doc.add("mcp_servers", servers)

        for name, entry in built.items():
            if name not in servers:
                added.add(name)
            elif prior is not None and name in prior:
                # W-5: already hub-managed, already on disk — compare the
                # existing table (unwrapped to plain python) against the new
                # entry to tell an in-place edit from a byte-stable re-sync.
                # tomlkit's item types subclass their native Python
                # counterparts, so a straight `!=` compares by value; any
                # unexpected shape falls back to "changed" rather than
                # silently reporting `unchanged`.
                try:
                    existing_plain = dict(servers[name])  # type: ignore[arg-type]
                except Exception:
                    existing_plain = None
                if existing_plain != entry:
                    updated.add(name)
            servers[name] = _dict_to_toml_table(entry)

        if prior is not None:
            for name in names_to_remove:
                if name in servers:
                    del servers[name]
                    removed.add(name)

        new_managed = represented_names
        serialized = tomlkit.dumps(doc)

        changed = existing_text != serialized
        if not changed:
            return GlobalMcpWriteResult(managed=new_managed, changed=False, skips=skips)

        backup_global_mcp(harness_id, "toml", global_path)
        _atomic_write_text(global_path, serialized)
        return GlobalMcpWriteResult(
            managed=new_managed,
            added=added,
            removed=removed,
            updated=updated,
            changed=True,
            skips=skips,
        )


# ─────────────────────────────────────────────────────────────────────────────
# opencode — opencode.json `mcp` object (JSON, distinct shape)
# ─────────────────────────────────────────────────────────────────────────────


class OpenCodeMcpAdapter:
    """Writes opencode's `opencode.json` MCP servers under the `mcp` key.

    opencode's MCP shape differs from `.mcp.json` (so it cannot reuse
    `ClaudeMcpAdapter`): the object is keyed by server name, each entry carries
    a required `type` discriminator, a single flat `command` array (command +
    args combined) for a LOCAL server, an `environment` map (not `env`), and
    `enabled`. Verified against https://opencode.ai/config.json (McpLocalConfig)
    — fetched 2026-06-10. A stdio spec maps to `type: "local"`; a http/sse spec
    (wave B) maps to `type: "remote"` (opencode has one remote type — sse
    degrades to it). A `${VAR}` reference is rewritten to `{env:VAR}`
    (`mcp_spec.to_native`); a `${VAR:-default}` form cannot be expressed and is
    dropped with `opencode_default_dropped:<Key>`.

    Writes the project-local `<project>/opencode.json` only — like the Claude
    and Codex MCP adapters, MCP sync is per-project (servers come from equipped
    skills); there is no global MCP write. The same file carries opencode's
    `permission` block (the permission adapter owns `permission.*`); each writer
    touches a disjoint subtree — so, unlike `.mcp.json`, this file is NEVER
    deleted outright even when the last MCP server is removed (the other
    subtrees may still hold real content). Malformed JSON ⇒ WARN + skip.
    """

    file_relative = "opencode.json"
    format_key = "opencode-json"
    adapter_key = "opencode"

    def _spec_to_entry(self, spec: McpServerSpec) -> tuple[dict, list[str]]:
        return to_native(spec, self.adapter_key)

    def _load(self, path: Path) -> Optional[dict]:
        if not path.exists():
            return {}
        try:
            with open(path) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError) as e:
            print(
                f"warning: cannot parse {path}: {e} — skipping opencode MCP for this project",
                file=sys.stderr,
            )
            return None

    def write(
        self,
        project_root: Path,
        specs: list[McpServerSpec],
        *,
        harness_id: str,
        project_name: str,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult:
        path = project_root / self.file_relative
        file_existed = path.exists()
        existing = self._load(path)
        managed_keys, managed_values, found_under = _project_sidecar_read(
            harness_id, project_name, project_root, data_home_path=data_home_path
        )
        if existing is None:
            return McpProjectWriteResult(
                managed=frozenset(managed_keys or ()), aborted=True, target=path
            )

        original_text = path.read_text() if file_existed else None
        servers = dict(existing.get("mcp") or {})
        desired, skips = _build_desired(specs, self._spec_to_entry)

        if not specs and not file_existed and managed_keys is None:
            return McpProjectWriteResult(managed=frozenset(), target=path)

        added, updated, removed, preserved, adopted, managed = _apply_project_ownership(
            servers, desired, managed_keys, managed_values
        )

        changed = False
        if added or updated or removed:
            # Only mutate on a real delta — an adopted/preserved-only run must
            # leave the file exactly as found, not merely content-equal after
            # a reformat (json.dumps does not round-trip byte-for-byte).
            new_servers = dict(servers)
            for name in added | updated:
                new_servers[name] = desired[name]
            for name in removed:
                new_servers.pop(name, None)

            new_data = dict(existing)
            if new_servers:
                new_data["mcp"] = new_servers
            else:
                new_data.pop("mcp", None)

            if new_data or file_existed:
                serialized = json.dumps(new_data, indent=2) + "\n"
                changed = original_text != serialized
                if changed:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_write_text(path, serialized)

        if managed:
            _project_sidecar_write(
                harness_id,
                project_name,
                project_root,
                path,
                managed,
                {name: desired[name] for name in managed},
                found_under,
                data_home_path=data_home_path,
            )
        else:
            _project_sidecar_delete(harness_id, project_name, project_root, found_under, data_home_path=data_home_path)

        return McpProjectWriteResult(
            managed=frozenset(managed),
            added=frozenset(added),
            updated=frozenset(updated),
            removed=frozenset(removed),
            preserved=frozenset(preserved),
            adopted=frozenset(adopted),
            changed=changed,
            target=path,
            skips=skips,
        )

    def remove(
        self,
        project_root: Path,
        names: set[str],
        *,
        harness_id: str,
        project_name: str,
        dry_run: bool = False,
        data_home_path: Optional[Path] = None,
    ) -> McpProjectWriteResult:
        path = project_root / self.file_relative
        managed_keys, managed_values, found_under = _project_sidecar_read(
            harness_id, project_name, project_root, data_home_path=data_home_path
        )
        managed_set = set(managed_keys or ())
        if not path.exists():
            return McpProjectWriteResult(managed=frozenset(managed_set), target=path)
        existing = self._load(path)
        if existing is None:
            return McpProjectWriteResult(
                managed=frozenset(managed_set), aborted=True, target=path
            )

        original_text = path.read_text()
        servers = dict(existing.get("mcp") or {})
        # Ownership-gated AND value-verified (W3): a name must be BOTH
        # requested, sidecar-owned, AND unchanged since hub wrote it — a
        # hub-owned entry the user hand-edited is declined, not deleted.
        to_remove: set[str] = set()
        declined: set[str] = set()
        for n in names:
            if n not in servers:
                continue
            if n not in managed_set:
                declined.add(n)
            elif _entry_matches_recorded(servers[n], managed_values.get(n)):
                to_remove.add(n)
            else:
                declined.add(n)
        if not to_remove:
            return McpProjectWriteResult(
                managed=frozenset(managed_set), preserved=frozenset(declined), target=path
            )
        if dry_run:
            return McpProjectWriteResult(
                managed=frozenset(managed_set - to_remove - declined),
                removed=frozenset(to_remove), preserved=frozenset(declined),
                changed=True, target=path,
            )

        new_servers = dict(servers)
        for k in to_remove:
            del new_servers[k]
        new_data = dict(existing)
        if new_servers:
            new_data["mcp"] = new_servers
        else:
            new_data.pop("mcp", None)

        serialized = json.dumps(new_data, indent=2) + "\n"
        changed = original_text != serialized
        if changed:
            _atomic_write_text(path, serialized)

        remaining_managed = managed_set - to_remove - declined
        if remaining_managed:
            _project_sidecar_write(
                harness_id,
                project_name,
                project_root,
                path,
                remaining_managed,
                {n: v for n, v in managed_values.items() if n in remaining_managed},
                found_under,
                data_home_path=data_home_path,
            )
        else:
            _project_sidecar_delete(harness_id, project_name, project_root, found_under, data_home_path=data_home_path)

        return McpProjectWriteResult(
            managed=frozenset(remaining_managed),
            removed=frozenset(to_remove),
            preserved=frozenset(declined),
            changed=changed,
            target=path,
        )


# ─────────────────────────────────────────────────────────────────────────────
# Shared registry of adapter instances (referenced by harnesses by key)
# ─────────────────────────────────────────────────────────────────────────────


_CLAUDE_ADAPTER = ClaudeMcpAdapter()
_CODEX_ADAPTER = CodexMcpAdapter()
_OPENCODE_ADAPTER = OpenCodeMcpAdapter()

ADAPTERS: dict[str, McpAdapter] = {
    "claude": _CLAUDE_ADAPTER,
    "codex": _CODEX_ADAPTER,
    "opencode": _OPENCODE_ADAPTER,
}


def get_adapter(key: Optional[str]) -> Optional[McpAdapter]:
    if key is None:
        return None
    return ADAPTERS.get(key)


def select_mcp_adapter(
    operation_context: "OperationAdapterContext", harness_id: str
) -> Optional[McpAdapter]:
    """Select an MCP adapter from one captured operation route.

    The legacy shadow route deliberately delegates to the existing host
    adapter and its current native codec.  An absent route is a hard stop;
    there is no ambient harness lookup or broad fallback.  The production
    trusted MCP record table is empty, so a future verified route is also
    refused until an exact codec binding exists.
    """
    layout = operation_context.layout(harness_id)
    route = operation_context.route(harness_id, "mcp")
    if layout is None or route.mode != "legacy_shadow" or route.status != "shadow":
        return None
    adapter_key = route.adapter_key or layout.mcp_adapter_key
    if adapter_key is None or adapter_key != layout.mcp_adapter_key:
        return None
    return ADAPTERS.get(adapter_key)


def select_mcp_decoder(
    operation_context: "OperationAdapterContext", harness_id: str
):
    """Return the SDK decoder bound to one captured MCP route.

    Native decoding is a source interpretation operation, so it uses the same
    route validation as writes.  Callers must supply the context; there is no
    ambient current-harness fallback.
    """
    adapter = select_mcp_adapter(operation_context, harness_id)
    if adapter is None:
        return None
    layout = operation_context.layout(harness_id)
    route = operation_context.route(harness_id, "mcp")
    adapter_key = route.adapter_key or (layout.mcp_adapter_key if layout else None)
    if adapter_key is None:
        return None
    from skill_hub.infrastructure.harnesses.harness_bundled_mcp import bundled_decoder

    try:
        return bundled_decoder(adapter_key)
    except ValueError:
        return None


# Keep the route-factory naming consistent with the other adapter domains.
select_adapter = select_mcp_adapter


def encode_native(
    spec: McpServerSpec,
    adapter_key: str,
    *,
    operation_context: Optional["OperationAdapterContext"] = None,
    harness_id: Optional[str] = None,
) -> tuple[dict, list[str]]:
    """Encode through the route captured for this operation.

    Legacy shadow is intentionally the existing host ``to_native`` baseline.
    A verified route has no production MCP codec binding yet and therefore
    fails closed instead of deriving support from layout metadata.
    """
    if operation_context is not None:
        if harness_id is None or select_mcp_adapter(operation_context, harness_id) is None:
            return {}, ["unavailable_route"]
        route = operation_context.route(harness_id, "mcp")
        if route.mode != "legacy_shadow":
            return {}, ["unavailable_route"]
    return to_native(spec, adapter_key)


def decode_native(
    native: object,
    *,
    name: str,
    adapter_key: str,
    operation_context: Optional["OperationAdapterContext"] = None,
    harness_id: Optional[str] = None,
    decoder=None,
):
    """Decode through the captured route, preserving the legacy baseline."""
    if operation_context is not None:
        if harness_id is None or select_mcp_adapter(operation_context, harness_id) is None:
            return normalize_native({}, name=name, adapter_key=adapter_key)
        route = operation_context.route(harness_id, "mcp")
        if route.mode != "legacy_shadow":
            return normalize_native({}, name=name, adapter_key=adapter_key)
        decoder = decoder or select_mcp_decoder(operation_context, harness_id)
        if decoder is None:
            return normalize_native({}, name=name, adapter_key=adapter_key)
    return normalize_native(native, name=name, adapter_key=adapter_key, decoder=decoder)
