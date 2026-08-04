"""Hook adapters — translate ResolvedHook lists → per-harness native writes.

Mirrors ``permission_adapters.py`` (house style: sidecar-tracked, atomic,
backup-first, merge-preserving) but the data source is the hook LIBRARY
(``hooks_model.ResolvedHook``), NOT the permissions block, and the writes target
a DISJOINT namespace:

  * Claude family (claude-code / pi) → the JSON ``hooks`` top-level key in a
    settings file, in the REAL nested schema
    ``{"<Event>": [{"matcher": ..., "hooks": [{"type": "command", "command": ...,
    "timeout"?: n}]}]}``. Managed keys are ``hooks.<Event>[<i>]`` tracked in a
    ``kind="hooks"`` sidecar — never the permissions sidecar, so a hook write
    never clobbers a ``permissions.*`` managed key in a shared settings.json.
  * Codex → ``[[hooks.<Event>]]`` array-of-tables (each with a nested
    ``[[hooks.<Event>.hooks]]``) in ``~/.codex/config.toml`` via tomlkit
    round-trip, merge-preserving unrelated tables (and ``[hooks.state]``, which
    hub reads read-only but NEVER writes — Codex owns hook trust).

``apply`` is the reconciler: it strips every prior sidecar-owned entry, then
writes the currently-resolved hooks in one atomic write per file. That single
pass covers adds, detaches, dangling-name removals AND the legacy flat→nested
repair (a prior flat entry recorded in the sidecar is stripped by index and
re-emitted nested in the SAME write — idempotent). ``cleanup`` is the uninstall
remover (strip all sidecar-owned entries, delete the sidecar).

Capability verdicts are produced by ``harness_probe`` in the sync-stream wave and
passed in; this module never probes. opencode/pi get no adapter (honest gating is
the caller's job via the capability verdict).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Protocol

from harness_probe import FEATURE_OFF, NOT_INSTALLED, SUPPORTED, UNSUPPORTED
from hooks_model import ResolvedHook
from permissions import (
    GlobalScope,
    ProjectScope,
    Scope,
    delete_sidecar,
    read_sidecar,
    write_sidecar,
)
from tool_catalog import event_supported, translate_tools

# Reuse the house-style safe-write + JSON-strip helpers rather than re-implement.
from permission_adapters import (
    _atomic_replace,
    _parse_managed_key,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from harness_probe import HookCapability


# The sidecar `kind` for every hook write — disjoint from the permissions
# sidecar (kind="") and the Codex rules sidecar (kind="rules"). Managed keys use
# the `hooks.<Event>[<i>]` namespace so they never touch `permissions.*` keys in
# a shared settings.json.
_HOOKS_SIDECAR_KIND = "hooks"


# ─────────────────────────────────────────────────────────────────────────────
# Result types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class HookSkip:
    """One resolved hook that produced no native write, with the honest reason."""

    name: str
    event: str
    reason: str

    def to_dict(self) -> dict:
        return {"name": self.name, "event": self.event, "reason": self.reason}


@dataclass
class HookApplyResult:
    """Outcome of one ``apply`` call for a single (scope, harness)."""

    harness_id: str
    scope: str                              # scope.slug
    target: Optional[Path] = None
    written: bool = False                   # did the native file actually change?
    disabled: bool = False                  # feature-off: entries kept, inert
    error: Optional[str] = None             # set on abort (e.g. unparseable target)
    reason: Optional[str] = None            # capability/skip context for the caller
    written_names: list[str] = field(default_factory=list)
    skipped: list[HookSkip] = field(default_factory=list)
    managed_keys: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "harness_id": self.harness_id,
            "scope": self.scope,
            "target": str(self.target) if self.target is not None else None,
            "written": self.written,
            "disabled": self.disabled,
            "error": self.error,
            "reason": self.reason,
            "written_names": list(self.written_names),
            "skipped": [s.to_dict() for s in self.skipped],
            "managed_keys": list(self.managed_keys),
        }


@dataclass
class HookCleanupResult:
    harness_id: str
    scope: str
    removed: bool = False

    def to_dict(self) -> dict:
        return {
            "harness_id": self.harness_id,
            "scope": self.scope,
            "removed": self.removed,
        }


@dataclass
class DiscoveredHook:
    """A hook read back from a native file (future-use; no consumer yet)."""

    event: str
    matcher: str
    command: str
    timeout: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "event": self.event,
            "matcher": self.matcher,
            "command": self.command,
            "timeout": self.timeout,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Protocol
# ─────────────────────────────────────────────────────────────────────────────


class HookAdapter(Protocol):
    def apply(
        self,
        scope: Scope,
        resolved_hooks: list[ResolvedHook],
        harness_id: str,
        capability: Optional["HookCapability"] = None,
    ) -> HookApplyResult: ...

    def discover_existing(
        self, scope: Scope, harness_id: str
    ) -> list[DiscoveredHook]: ...

    def cleanup(
        self,
        scope: Scope,
        harness_id: str,
        owned_names: Optional[set[str]] = None,
    ) -> HookCleanupResult: ...


# ─────────────────────────────────────────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────────────────────────────────────────


# ── Identity-based ownership (managed-key fingerprints) ──────────────────────
#
# A managed key is `hooks.<Event>[<i>]#<fp>` where `<fp>` fingerprints the entry
# hub wrote (event + matcher + command). The index alone is NOT ownership: the
# user edits the same list, so a prepend shifts hub's entry down (index now
# points at the USER's hook) and a deletion shifts it up (index now points at
# someone else's entry, or past the end). Deleting by index in either case is a
# silent data loss / duplication bug. The fingerprint makes ownership positional-
# drift-proof: hub deletes the entry that still IS its entry, wherever it moved,
# and deletes NOTHING when that entry is gone.
#
# Backward compatibility: a sidecar written before this change carries bare
# `hooks.<Event>[<i>]` keys. Those have no identity to verify, so they fall back
# to the historical index-based strip (bounds-checked, never crashing); the next
# sync rewrites the sidecar WITH fingerprints, so an install self-heals after one
# reconcile. Forward compatibility: an older hub reading a fingerprinted key
# simply fails to parse it and strips nothing — conservative, never destructive.
_MANAGED_KEY_FP_SEP = "#"


def _hook_fingerprint(event: str, matcher: str, command: str) -> str:
    """Stable short identity hash of one native hook entry."""
    payload = f"{event}\x00{matcher}\x00{command}".encode("utf-8", "surrogatepass")
    return hashlib.sha256(payload).hexdigest()[:12]


def _managed_key(event: str, index: int, fingerprint: str) -> str:
    return f"hooks.{event}[{index}]{_MANAGED_KEY_FP_SEP}{fingerprint}"


def _split_managed_key(key: str):
    """``hooks.<Event>[<i>][#<fp>]`` → ``(event, index, fingerprint|None)``.

    ``(None, None, None)`` for anything that is not a hooks managed key.
    """
    base, _, fp = str(key).partition(_MANAGED_KEY_FP_SEP)
    parsed = _parse_managed_key(base)
    if parsed is None:
        return None, None, None
    path, idx = parsed
    if len(path) != 2 or path[0] != "hooks":
        return None, None, None
    return path[1], idx, (fp or None)


def _resolve_owned_indices(entries: list, wanted: list, fp_of) -> list[int]:
    """Map recorded ``(index, fingerprint)`` pairs onto the CURRENT entry list.

    Identity wins over position:
      * fingerprint matches at the recorded index → that's ours;
      * otherwise search the list for the matching entry (the user prepended or
        deleted around us) → that's ours;
      * no match anywhere → ALREADY GONE; delete nothing (never fall back to the
        index, or we would delete the user's own hook sitting in our old slot).
    A legacy key with no fingerprint keeps the historical index behaviour.
    """
    taken: set[int] = set()
    out: list[int] = []
    for idx, fp in wanted:
        if fp is None:
            if 0 <= idx < len(entries) and idx not in taken:
                taken.add(idx)
                out.append(idx)
            continue
        if (
            0 <= idx < len(entries)
            and idx not in taken
            and fp_of(entries[idx]) == fp
        ):
            taken.add(idx)
            out.append(idx)
            continue
        for j, entry in enumerate(entries):
            if j in taken:
                continue
            if fp_of(entry) == fp:
                taken.add(j)
                out.append(j)
                break
    return out


def _group_managed_keys(managed_keys: list[str]) -> dict:
    """``{event: [(index, fingerprint|None), …]}`` from a sidecar's managed keys."""
    grouped: dict[str, list] = {}
    for key in managed_keys:
        event, idx, fp = _split_managed_key(key)
        if event is None:
            continue
        grouped.setdefault(event, []).append((idx, fp))
    return grouped


# (harness_id, scope.slug, target) keys already backed up this process.
_HOOK_BACKUP_SESSION: set[str] = set()


def _backup_hook_once(target: Path, scope: Scope, harness_id: str) -> Optional[Path]:
    """Back up ``target`` to ``_hub-backups/hooks/<harness>/<scope>/<ts>.<ext>``.

    Once per (harness, scope, file) per process. Callers invoke this ONLY right
    before a write that actually changes the file, so backups land only when the
    content changes (spec: backup-first, only when the write changes the file).
    """
    if not target.exists():
        return None
    key = f"{harness_id}::{scope.slug}::{target}"
    if key in _HOOK_BACKUP_SESSION:
        return None
    import hub

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    ext = target.suffix.lstrip(".") or "bin"
    backup_dir = hub.data_home() / "_hub-backups" / "hooks" / harness_id / scope.slug
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{ts}.{ext}"
    shutil.copy2(target, backup_path)
    _HOOK_BACKUP_SESSION.add(key)
    return backup_path


def _resolve_matcher(
    rh: ResolvedHook, harness_id: str
) -> tuple[bool, Optional[str], Optional[HookSkip]]:
    """Harness-affinity gate + per-event gate + canonical-tool → native-matcher
    translation.

    Returns ``(ok, matcher, skip)``. A raw ``matcher`` on the definition WINS
    over ``tools`` (used verbatim on every harness). Otherwise ``translate_tools``
    maps the canonical tool list to the harness's native matcher: ``[]`` → the
    all-tools matcher ``""``; a list where every tool drops → ``None`` → SKIP.
    """
    if rh.harnesses is not None and harness_id not in rh.harnesses:
        return False, None, HookSkip(
            rh.name,
            rh.event,
            f"harness affinity {rh.harnesses!r} does not include {harness_id!r}",
        )
    if not event_supported(rh.event, harness_id):
        return False, None, HookSkip(
            rh.name,
            rh.event,
            f"event {rh.event!r} is not supported on {harness_id}",
        )
    if rh.matcher:
        return True, rh.matcher, None
    matcher = translate_tools(rh.tools, harness_id)
    if matcher is None:
        return False, None, HookSkip(
            rh.name,
            rh.event,
            f"no canonical tool in {rh.tools!r} maps to a native matcher on {harness_id}",
        )
    return True, matcher, None


def _capability_short_circuit(
    capability: Optional["HookCapability"],
    resolved_hooks: list[ResolvedHook],
    result: HookApplyResult,
) -> bool:
    """Honor a probed capability verdict. Returns True when ``apply`` must
    short-circuit (no native write). SUPPORTED (or an absent verdict) proceeds.

    * FEATURE_OFF — the harness is installed but its hook feature is toggled off:
      keep any already-written entries in place (do NOT strip/rewrite/delete) and
      surface a "written but disabled" state (design D4: feature-off ≠ uninstall).
    * UNSUPPORTED / NOT_INSTALLED — no write; every hook is skipped with the
      verdict reason (honest gating for pi/opencode/uninstalled).
    """
    if capability is None or capability.verdict == SUPPORTED:
        return False
    result.reason = capability.reason
    if capability.verdict == FEATURE_OFF:
        result.disabled = True
        for rh in resolved_hooks:
            result.skipped.append(HookSkip(
                rh.name,
                rh.event,
                "harness hook feature is off; existing entries kept in place",
            ))
        return True
    # UNSUPPORTED / NOT_INSTALLED
    for rh in resolved_hooks:
        result.skipped.append(HookSkip(rh.name, rh.event, capability.reason))
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Claude / Pi adapter (JSON settings file, nested hook schema)
# ─────────────────────────────────────────────────────────────────────────────


# Scope → file mapping (spec: "Scope-targeted file mapping"). Project hooks land
# in the PERSONAL, uncommitted settings.local.json (never the committed
# settings.json): hook commands are machine-absolute code paths not meant to be
# pushed to teammates. The mapping is written generically for both Claude-family
# ids so pi is a one-line capability flip later (D2: same format), but v1 only
# invokes this adapter for a capability-SUPPORTED harness (claude-code).
_CLAUDE_HOOK_PATHS: dict[str, dict[str, str]] = {
    "claude-code": {
        "global": "~/.claude/settings.json",
        "project": ".claude/settings.local.json",
    },
    "pi": {
        "global": "~/.pi/agent/settings.json",
        "project": ".pi/agent/settings.local.json",
    },
}


def _command_hook_dict(rh: ResolvedHook) -> dict:
    """The inner ``{"type": "command", "command", "timeout"?}`` entry. Field
    order is fixed so a re-serialize is byte-stable."""
    entry: dict = {"type": "command", "command": rh.command}
    if rh.timeout is not None:
        entry["timeout"] = rh.timeout
    return entry


def _claude_entry_fingerprint(event: str, entry) -> Optional[str]:
    """Fingerprint one native Claude hooks entry (nested OR legacy flat)."""
    if not isinstance(entry, dict):
        return None
    matcher = str(entry.get("matcher", ""))
    command: Optional[str] = None
    inner = entry.get("hooks")
    if isinstance(inner, list):
        for ih in inner:
            if isinstance(ih, dict) and ih.get("type") == "command":
                command = str(ih.get("command", ""))
                break
    if command is None and isinstance(entry.get("command"), str):
        command = entry["command"]  # legacy flat shape
    if command is None:
        return None
    return _hook_fingerprint(event, matcher, command)


def _strip_claude_hooks_by_identity(data: dict, managed_keys: list[str]) -> dict:
    """Remove hub-owned entries from a Claude ``hooks`` section, verifying each
    recorded managed key's fingerprint against the CURRENT file (see
    ``_resolve_owned_indices``). Never deletes an entry hub does not own."""
    hooks_section = data.get("hooks")
    if not isinstance(hooks_section, dict):
        return data
    for event, wanted in _group_managed_keys(managed_keys).items():
        entries = hooks_section.get(event)
        if not isinstance(entries, list):
            continue
        owned = _resolve_owned_indices(
            entries, wanted, lambda e, ev=event: _claude_entry_fingerprint(ev, e)
        )
        for i in sorted(owned, reverse=True):
            del entries[i]
        if not entries:
            del hooks_section[event]
    if not hooks_section:
        data.pop("hooks", None)
    return data


class ClaudeHookAdapter:
    """Writes the nested Claude hook schema into a JSON settings file.

    Harness-agnostic body; only ``_target`` branches per harness id.
    """

    def _target(self, scope: Scope, harness_id: str) -> Path:
        paths = _CLAUDE_HOOK_PATHS.get(harness_id)
        if paths is None:
            raise ValueError(
                f"ClaudeHookAdapter: no path config for harness {harness_id!r}"
            )
        if isinstance(scope, GlobalScope):
            return Path(paths["global"]).expanduser()
        # Project scope ALWAYS routes to settings.local.json (never committed).
        return Path(scope.path) / paths["project"]

    def apply(
        self,
        scope: Scope,
        resolved_hooks: list[ResolvedHook],
        harness_id: str,
        capability: Optional["HookCapability"] = None,
    ) -> HookApplyResult:
        target = self._target(scope, harness_id)
        result = HookApplyResult(
            harness_id=harness_id, scope=scope.slug, target=target
        )
        if _capability_short_circuit(capability, resolved_hooks, result):
            return result

        existing_text = target.read_text() if target.exists() else None
        # An existing-but-unparseable settings file ABORTS this harness's write
        # (mirrors the Codex adapter). Resetting to `{}` and serializing would
        # overwrite the whole file — model, permissions, env, everything the user
        # keeps in settings.json — while reporting success. Data loss is never an
        # acceptable outcome of a hook sync: leave the file untouched and report.
        data: dict = {}
        if existing_text:
            try:
                parsed = json.loads(existing_text)
            except json.JSONDecodeError as exc:
                result.error = f"settings file is unparseable: {exc}"
            else:
                if isinstance(parsed, dict):
                    data = parsed
                else:
                    result.error = (
                        "settings file root is not a JSON object "
                        f"(got {type(parsed).__name__})"
                    )
            if result.error is not None:
                print(
                    f"warning: cannot parse {target}: {result.error} — "
                    f"skipping {harness_id} hook write",
                    file=sys.stderr,
                )
                for rh in resolved_hooks:
                    result.skipped.append(HookSkip(
                        rh.name, rh.event, "aborted: settings file unparseable"
                    ))
                return result

        # 1. Strip every prior sidecar-owned key. This removes prior hub hooks —
        #    including any legacy FLAT entry recorded at those indices — so the
        #    nested re-emit below is the flat→nested repair, fused into one write.
        prior = read_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        if prior is not None and prior.managed_keys:
            data = _strip_claude_hooks_by_identity(data, list(prior.managed_keys))

        # 2. Splice the currently-resolved hooks, grouped by event, appending
        #    AFTER any surviving (user-authored) entries so their indices hold.
        hooks_section = data.get("hooks")
        if not isinstance(hooks_section, dict):
            hooks_section = {}
        new_managed: list[str] = []
        for rh in resolved_hooks:
            ok, matcher, skip = _resolve_matcher(rh, harness_id)
            if not ok:
                assert skip is not None
                result.skipped.append(skip)
                continue
            event_list = list(hooks_section.get(rh.event) or [])
            base = len(event_list)
            event_list.append({
                "matcher": matcher,
                "hooks": [_command_hook_dict(rh)],
            })
            hooks_section[rh.event] = event_list
            new_managed.append(_managed_key(
                rh.event, base, _hook_fingerprint(rh.event, matcher, rh.command)
            ))
            result.written_names.append(rh.name)

        if hooks_section:
            data["hooks"] = hooks_section
        elif "hooks" in data:
            # Nothing left under hooks — drop the empty container.
            if not data.get("hooks"):
                del data["hooks"]

        # 3. Only write (and back up) when the bytes actually change → byte-stable
        #    re-sync + backup-first-only-on-change. Never CREATE an empty file
        #    (all hooks skipped + no pre-existing content ⇒ nothing to write).
        new_text = json.dumps(data, indent=2, sort_keys=False) + "\n"
        if new_text != (existing_text or "") and (target.exists() or data):
            if target.exists():
                _backup_hook_once(target, scope, harness_id)
            _atomic_replace(target, new_text)
            result.written = True

        # 4. Reconcile the hooks sidecar to the current managed set.
        if new_managed:
            write_sidecar(harness_id, scope, new_managed, target, _HOOKS_SIDECAR_KIND)
        else:
            delete_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        result.managed_keys = new_managed
        return result

    def discover_existing(
        self, scope: Scope, harness_id: str
    ) -> list[DiscoveredHook]:
        target = self._target(scope, harness_id)
        if not target.exists():
            return []
        try:
            data = json.loads(target.read_text())
        except (OSError, json.JSONDecodeError):
            return []
        hooks_section = data.get("hooks") if isinstance(data, dict) else None
        if not isinstance(hooks_section, dict):
            return []
        out: list[DiscoveredHook] = []
        for event, entries in hooks_section.items():
            for entry in entries or []:
                if not isinstance(entry, dict):
                    continue
                matcher = str(entry.get("matcher", ""))
                inner = entry.get("hooks")
                if not isinstance(inner, list):
                    continue
                for ih in inner:
                    if not isinstance(ih, dict) or ih.get("type") != "command":
                        continue
                    timeout = ih.get("timeout")
                    out.append(DiscoveredHook(
                        event=str(event),
                        matcher=matcher,
                        command=str(ih.get("command", "")),
                        timeout=int(timeout) if isinstance(timeout, int) else None,
                    ))
        return out

    def cleanup(
        self,
        scope: Scope,
        harness_id: str,
        owned_names: Optional[set[str]] = None,
    ) -> HookCleanupResult:
        result = HookCleanupResult(harness_id=harness_id, scope=scope.slug)
        sc = read_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        if sc is None:
            return result
        # Still-owned hooks are reconciled by `apply`; cleanup is the UNINSTALL
        # remover (owned_names empty/None ⇒ strip everything hub owns here).
        if owned_names:
            return result
        target = Path(sc.file)
        if not target.exists():
            delete_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
            result.removed = True
            return result
        try:
            data = json.loads(target.read_text())
        except (OSError, json.JSONDecodeError):
            return result
        if isinstance(data, dict):
            stripped = _strip_claude_hooks_by_identity(data, list(sc.managed_keys))
            new_text = json.dumps(stripped, indent=2, sort_keys=False) + "\n"
            if new_text != target.read_text():
                _backup_hook_once(target, scope, harness_id)
                _atomic_replace(target, new_text)
        delete_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        result.removed = True
        return result


_TOMLKIT_MISSING_REASON = (
    "Codex tooling (tomlkit) is not installed in this Python environment"
)


def _tomlkit_missing() -> bool:
    """Cheap availability check (no import) — a Python env without the
    vendored/pip-installed ``tomlkit`` package must degrade the Codex write to
    an honest skip, not crash the whole sync with an uncaught ImportError."""
    return importlib.util.find_spec("tomlkit") is None


# ─────────────────────────────────────────────────────────────────────────────
# Codex adapter (TOML [[hooks.<Event>]] array-of-tables, global scope only in v1)
# ─────────────────────────────────────────────────────────────────────────────


_CODEX_CONFIG = "~/.codex/config.toml"


def _codex_config_target() -> Path:
    return Path(_CODEX_CONFIG).expanduser()


def _codex_append_hook(doc, rh: ResolvedHook, matcher: str) -> str:
    """Append one ``[[hooks.<Event>]]`` (with a nested ``[[hooks.<Event>.hooks]]``)
    to ``doc``, preserving any pre-existing entries (incl. ``[hooks.state]``).
    Returns the managed key ``hooks.<Event>[<i>]``. Emits ONLY ``matcher`` +
    ``{type, command, timeout?}`` (task-0: command MUST be a string; extras are
    hygiene, not required — codex tolerates unknown fields)."""
    import tomlkit

    hooks_tbl = doc.get("hooks")
    if hooks_tbl is None:
        hooks_tbl = tomlkit.table()
        doc["hooks"] = hooks_tbl
    aot = hooks_tbl.get(rh.event)
    if aot is None:
        aot = tomlkit.aot()
        hooks_tbl[rh.event] = aot
    idx = len(aot)

    event_tbl = tomlkit.table()
    event_tbl["matcher"] = matcher
    inner = tomlkit.aot()
    command_tbl = tomlkit.table()
    command_tbl["type"] = "command"
    command_tbl["command"] = rh.command       # string — never an array
    if rh.timeout is not None:
        command_tbl["timeout"] = rh.timeout
    inner.append(command_tbl)
    event_tbl["hooks"] = inner
    aot.append(event_tbl)
    return _managed_key(
        rh.event, idx, _hook_fingerprint(rh.event, matcher, rh.command)
    )


def _codex_entry_fingerprint(event: str, entry) -> Optional[str]:
    """Fingerprint one ``[[hooks.<Event>]]`` table (nested OR legacy flat)."""
    if not hasattr(entry, "get"):
        return None
    matcher = str(entry.get("matcher", ""))
    command: Optional[str] = None
    inner = entry.get("hooks")
    try:
        inner_entries = list(inner) if inner is not None else []
    except TypeError:
        inner_entries = []
    for ih in inner_entries:
        if hasattr(ih, "get") and ih.get("type") == "command":
            command = str(ih.get("command", ""))
            break
    if command is None:
        raw = entry.get("command")
        if raw is not None:
            command = str(raw)  # legacy flat shape
    if command is None:
        return None
    return _hook_fingerprint(event, matcher, command)


def _codex_strip_hook_keys(
    doc, managed_keys: list[str], *, prune_empty_table: bool = True
) -> None:
    """Strip ``hooks.<Event>[<i>]`` managed keys from a tomlkit doc, preserving
    ``[hooks.state]`` and any other ``[hooks.*]`` sub-key hub does not own.

    ``prune_empty_table`` removes an emptied ``[hooks]`` container (cleanup). The
    apply path passes False so a strip-then-reappend reuses the SAME container —
    deleting + recreating it injects a leading blank line, breaking byte-stable
    re-sync.
    """
    hooks_tbl = doc.get("hooks")
    if hooks_tbl is None:
        return
    for event, wanted in _group_managed_keys(managed_keys).items():
        aot = hooks_tbl.get(event)
        if aot is None:
            continue
        try:
            entries = list(aot)
        except TypeError:  # pragma: no cover - defensive
            continue
        owned = _resolve_owned_indices(
            entries, wanted, lambda e, ev=event: _codex_entry_fingerprint(ev, e)
        )
        for i in sorted(owned, reverse=True):
            if 0 <= i < len(aot):
                del aot[i]
        if len(aot) == 0:
            try:
                del hooks_tbl[event]
            except KeyError:
                pass
    # Drop an empty [hooks] table, but keep it if state/other keys remain.
    if not prune_empty_table:
        return
    try:
        remaining = list(hooks_tbl.keys())
    except Exception:  # pragma: no cover - defensive
        remaining = ["?"]
    if not remaining:
        try:
            del doc["hooks"]
        except KeyError:
            pass


class CodexHookAdapter:
    """Writes ``[[hooks.<Event>]]`` tables into ``~/.codex/config.toml`` (global
    scope only in v1). Merge-preserving via tomlkit; never writes ``[hooks.state]``
    (Codex owns hook trust — hub reads it read-only via ``read_hook_trust_state``).
    """

    def _target(self, scope: Scope) -> Path:
        return _codex_config_target()

    def apply(
        self,
        scope: Scope,
        resolved_hooks: list[ResolvedHook],
        harness_id: str = "codex",
        capability: Optional["HookCapability"] = None,
    ) -> HookApplyResult:
        result = HookApplyResult(harness_id=harness_id, scope=scope.slug)

        # v1: project-attached hooks do NOT target codex (surface a skip reason).
        if isinstance(scope, ProjectScope):
            result.reason = (
                "Codex receives only globally-attached hooks in v1; "
                "project-attached hooks are not written to config.toml"
            )
            for rh in resolved_hooks:
                result.skipped.append(HookSkip(rh.name, rh.event, result.reason))
            return result

        if _capability_short_circuit(capability, resolved_hooks, result):
            return result

        if _tomlkit_missing():
            # Environment-capability gap (e.g. a dev/CI Python without the
            # vendored/pip-installed tomlkit), NOT a write failure: skip
            # honestly rather than letting the ImportError propagate as
            # `result.error` and poison the caller's exit code.
            result.reason = _TOMLKIT_MISSING_REASON
            for rh in resolved_hooks:
                result.skipped.append(HookSkip(rh.name, rh.event, result.reason))
            return result

        import tomlkit

        target = self._target(scope)
        result.target = target
        existing_text = target.read_text() if target.exists() else None
        if existing_text is not None:
            try:
                doc = tomlkit.parse(existing_text)
            except Exception as exc:
                # Unparseable target — abort this harness's write, file untouched.
                result.error = f"config.toml is unparseable: {exc}"
                print(
                    f"warning: cannot parse {target}: {exc} — skipping Codex hook write",
                    file=sys.stderr,
                )
                for rh in resolved_hooks:
                    result.skipped.append(HookSkip(
                        rh.name, rh.event, "aborted: config.toml unparseable"
                    ))
                return result
        else:
            doc = tomlkit.document()

        prior = read_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        if prior is not None and prior.managed_keys:
            # Keep the [hooks] container so a strip-then-reappend is byte-stable.
            _codex_strip_hook_keys(
                doc, list(prior.managed_keys), prune_empty_table=False
            )

        new_managed: list[str] = []
        for rh in resolved_hooks:
            ok, matcher, skip = _resolve_matcher(rh, harness_id)
            if not ok:
                assert skip is not None
                result.skipped.append(skip)
                continue
            new_managed.append(_codex_append_hook(doc, rh, matcher))
            result.written_names.append(rh.name)

        # Drop an emptied [hooks] table (all hub hooks stripped, none re-added,
        # nothing else under it) so a full detach leaves no residue.
        hooks_tbl = doc.get("hooks")
        if hooks_tbl is not None:
            try:
                empty = not list(hooks_tbl.keys())
            except Exception:  # pragma: no cover - defensive
                empty = False
            if empty:
                del doc["hooks"]

        new_text = tomlkit.dumps(doc)
        if new_text != (existing_text or ""):
            if target.exists():
                _backup_hook_once(target, scope, harness_id)
            _atomic_replace(target, new_text)
            result.written = True

        if new_managed:
            write_sidecar(harness_id, scope, new_managed, target, _HOOKS_SIDECAR_KIND)
        else:
            delete_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        result.managed_keys = new_managed
        return result

    def discover_existing(
        self, scope: Scope, harness_id: str = "codex"
    ) -> list[DiscoveredHook]:
        if _tomlkit_missing():
            return []

        import tomlkit

        target = self._target(scope)
        if not target.exists():
            return []
        try:
            doc = tomlkit.parse(target.read_text())
        except Exception:
            return []
        hooks_tbl = doc.get("hooks")
        if hooks_tbl is None:
            return []
        out: list[DiscoveredHook] = []
        for event in list(hooks_tbl.keys()):
            if event == "state":
                continue
            aot = hooks_tbl.get(event)
            try:
                entries = list(aot)
            except TypeError:
                continue
            for entry in entries:
                if not hasattr(entry, "get"):
                    continue
                matcher = str(entry.get("matcher", ""))
                inner = entry.get("hooks")
                try:
                    inner_entries = list(inner) if inner is not None else []
                except TypeError:
                    inner_entries = []
                for ih in inner_entries:
                    if not hasattr(ih, "get") or ih.get("type") != "command":
                        continue
                    timeout = ih.get("timeout")
                    out.append(DiscoveredHook(
                        event=str(event),
                        matcher=matcher,
                        command=str(ih.get("command", "")),
                        timeout=int(timeout) if isinstance(timeout, int) else None,
                    ))
        return out

    def cleanup(
        self,
        scope: Scope,
        harness_id: str = "codex",
        owned_names: Optional[set[str]] = None,
    ) -> HookCleanupResult:
        result = HookCleanupResult(harness_id=harness_id, scope=scope.slug)
        sc = read_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        if sc is None:
            return result
        if owned_names:  # still-owned ⇒ apply reconciles; cleanup is uninstall-only.
            return result
        if _tomlkit_missing():
            # Can't safely strip a TOML file we can't parse — leave it and the
            # sidecar untouched rather than crash; the next sync with tomlkit
            # available will complete the cleanup.
            return result

        import tomlkit

        target = Path(sc.file)
        if not target.exists():
            delete_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
            result.removed = True
            return result
        existing_text = target.read_text()
        try:
            doc = tomlkit.parse(existing_text)
        except Exception:
            return result
        _codex_strip_hook_keys(doc, list(sc.managed_keys))
        new_text = tomlkit.dumps(doc)
        if new_text != existing_text:
            _backup_hook_once(target, scope, harness_id)
            _atomic_replace(target, new_text)
        delete_sidecar(harness_id, scope, _HOOKS_SIDECAR_KIND)
        result.removed = True
        return result


# ─────────────────────────────────────────────────────────────────────────────
# Codex hook-trust state — READ-ONLY (hub never writes [hooks.state])
# ─────────────────────────────────────────────────────────────────────────────


def read_hook_trust_state(config_path) -> dict[str, dict]:
    """Parse ``[hooks.state]`` from a codex ``config.toml`` (read-only).

    Returns ``{name: {"trusted_hash"?: str, "enabled"?: bool}}`` so the UI/doctor
    can surface an "awaiting trust in Codex" state for a hub-written hook that
    Codex has not yet trusted. NEVER writes — hub does not grant hook trust (D9).
    Missing file / no ``[hooks.state]`` / parse error ⇒ ``{}``.
    """
    if _tomlkit_missing():
        return {}

    import tomlkit

    path = Path(config_path).expanduser()
    try:
        doc = tomlkit.parse(path.read_text())
    except Exception:
        return {}
    hooks_tbl = doc.get("hooks")
    if hooks_tbl is None or not hasattr(hooks_tbl, "get"):
        return {}
    state = hooks_tbl.get("state")
    if state is None or not hasattr(state, "items"):
        return {}
    out: dict[str, dict] = {}
    for name, entry in state.items():
        info: dict = {}
        if hasattr(entry, "get"):
            if "trusted_hash" in entry:
                info["trusted_hash"] = str(entry.get("trusted_hash"))
            if "enabled" in entry:
                info["enabled"] = bool(entry.get("enabled"))
        out[str(name)] = info
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Adapter selection
# ─────────────────────────────────────────────────────────────────────────────


def get_hook_adapter(harness_id: str):
    """The hook adapter for a harness id, or ``None`` when hub writes no hooks for
    it in v1 (opencode/pi/unknown — honest gating is the caller's job)."""
    if harness_id == "claude-code":
        return ClaudeHookAdapter()
    if harness_id == "codex":
        return CodexHookAdapter()
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Test seam
# ─────────────────────────────────────────────────────────────────────────────


def _reset_backup_session_state_for_tests() -> None:
    _HOOK_BACKUP_SESSION.clear()
