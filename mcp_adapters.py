"""MCP adapter abstraction — write MCP server specs to per-harness config files.

Two v1 adapters:

- `ClaudeMcpAdapter` writes `.mcp.json` (JSON `mcpServers`). Used by BOTH
  `claude-code` and `pi` — Pi docs prefer `.mcp.json` as project-local MCP
  config. The adapter instance is shared so dispatch dedup naturally collapses
  the two harnesses to one write.
- `CodexMcpAdapter` writes `.codex/config.toml` `[mcp_servers.<name>]` tables,
  round-tripping via `tomlkit` to preserve all unrelated content (model,
  `[projects.*]`, `[plugins.*]`, `[marketplaces.*]`, comments, key order).
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, Protocol


@dataclass(frozen=True)
class McpServerSpec:
    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    cwd: Optional[str] = None


class McpAdapter(Protocol):
    """Each harness's `mcp_adapter` (when not None) implements this."""

    def write(self, project_root: Path, specs: list[McpServerSpec]) -> bool: ...

    def remove(self, project_root: Path, names: set[str]) -> bool: ...


@dataclass(frozen=True)
class GlobalMcpWriteResult:
    """Outcome of a `write_global` call.

    `managed` is the set of hub-owned global server names now present in the
    file (= the names to persist to the sidecar). `changed` is True only when
    the write actually altered the file on disk (drives backup + logging).
    `aborted` is True when the target existed but could not be parsed (the file
    was left untouched).
    """

    managed: set[str]
    added: set[str] = field(default_factory=set)
    removed: set[str] = field(default_factory=set)
    changed: bool = False
    aborted: bool = False


def backup_global_mcp(harness_id: str, ext: str, source: Path) -> Optional[Path]:
    """Copy `source` to `~/.skill-hub/_hub-backups/mcp/<harness>/global/<ts>.<ext>`.

    Returns the backup path, or None if the source does not exist (a brand-new
    file has nothing to back up). Callers MUST only invoke this when a write
    actually changes the file (no backup spam on idempotent syncs).
    """
    if not source.exists():
        return None
    import hub  # local import to avoid a cycle at module load

    ts = datetime.now().strftime("%Y%m%dT%H%M%S_%f")
    backup_dir = hub.data_home() / "_hub-backups" / "mcp" / harness_id / "global"
    backup_dir.mkdir(parents=True, exist_ok=True)
    dest = backup_dir / f"{ts}.{ext}"
    shutil.copy2(source, dest)
    return dest


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

    def _spec_to_entry(self, spec: McpServerSpec) -> dict:
        out: dict = {"command": spec.command, "args": list(spec.args), "env": dict(spec.env)}
        if spec.cwd is not None:
            out["cwd"] = spec.cwd
        return out

    def write(self, project_root: Path, specs: list[McpServerSpec]) -> bool:
        path = project_root / self.file_relative
        existing = {}
        if path.exists():
            try:
                with open(path) as f:
                    existing = json.load(f)
            except (OSError, json.JSONDecodeError):
                existing = {}
        servers = dict(existing.get("mcpServers") or {})
        spec_names = {s.name for s in specs}

        # Remove keys that used to be hub-managed but are no longer in spec.
        # Detection is by name match only — same as the legacy code.
        changed = False
        for s in specs:
            entry = self._spec_to_entry(s)
            if servers.get(s.name) != entry:
                servers[s.name] = entry
                changed = True

        # If we have specs at all, ensure the section exists.
        if specs or "mcpServers" in existing:
            existing["mcpServers"] = servers
            if servers and changed:
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "w") as f:
                    json.dump(existing, f, indent=2)
                    f.write("\n")
                return True
        return False

    def remove(self, project_root: Path, names: set[str]) -> bool:
        path = project_root / self.file_relative
        if not path.exists():
            return False
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return False
        servers = data.get("mcpServers") or {}
        to_remove = [k for k in servers if k in names]
        if not to_remove:
            return False
        for k in to_remove:
            del servers[k]
        if servers:
            data["mcpServers"] = servers
            with open(path, "w") as f:
                json.dump(data, f, indent=2)
                f.write("\n")
        else:
            path.unlink()
        return True

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

        spec_names = {s.name for s in specs}
        prior = set(prior_managed) if prior_managed is not None else None

        # Nothing to add and nothing the sidecar lets us remove on a fresh file
        # → no-op. Do NOT materialize a spurious ~/.claude.json.
        if not specs and existing_text is None:
            return GlobalMcpWriteResult(managed=set(), changed=False)

        servers = dict(data.get("mcpServers") or {})
        added: set[str] = set()
        removed: set[str] = set()

        for s in specs:
            entry = self._spec_to_entry(s)
            if servers.get(s.name) != entry:
                if s.name not in servers:
                    added.add(s.name)
                servers[s.name] = entry

        # Remove only previously-hub-managed names now absent from specs.
        if prior is not None:
            for name in prior:
                if name not in spec_names and name in servers:
                    del servers[name]
                    removed.add(name)

        new_managed = set(spec_names)

        # Recompute the resulting top-level object and serialize.
        new_data = dict(data)
        if servers or "mcpServers" in data:
            new_data["mcpServers"] = servers
        serialized = json.dumps(new_data, indent=2, ensure_ascii=False)
        if had_trailing_newline:
            serialized += "\n"

        changed = existing_text != serialized
        if not changed:
            return GlobalMcpWriteResult(managed=new_managed, changed=False)

        backup_global_mcp(harness_id, "json", global_path)
        _atomic_write_text(global_path, serialized)
        return GlobalMcpWriteResult(
            managed=new_managed, added=added, removed=removed, changed=True
        )


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

    def _config_path(self, project_root: Path) -> Path:
        return project_root / ".codex" / self.file_relative

    def _spec_to_table(self, spec: McpServerSpec):
        import tomlkit

        table = tomlkit.table()
        table.add("command", spec.command)
        table.add("args", list(spec.args))
        table.add("env", dict(spec.env))
        if spec.cwd is not None:
            table.add("cwd", spec.cwd)
        return table

    def _load_doc(self, path: Path):
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

    def write(self, project_root: Path, specs: list[McpServerSpec]) -> bool:
        import tomlkit

        path = self._config_path(project_root)
        doc, ok = self._load_doc(path)
        if not ok:
            return False
        # Build the [mcp_servers] table-of-tables.
        existing = doc.get("mcp_servers")
        if existing is None:
            existing = tomlkit.table()
            doc.add("mcp_servers", existing)
        changed = False
        for s in specs:
            new_table = self._spec_to_table(s)
            current = existing.get(s.name)
            # Compare by value-form (tomlkit objects compare structurally
            # for plain str/list/dict but we sidestep by always rewriting
            # the named table — Cargo-style "always overwrite my section").
            existing[s.name] = new_table
            changed = True
        if changed:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(tomlkit.dumps(doc))
        return changed

    def remove(self, project_root: Path, names: set[str]) -> bool:
        import tomlkit

        path = self._config_path(project_root)
        doc, ok = self._load_doc(path)
        if not ok or path == path and not path.exists():
            return False
        servers = doc.get("mcp_servers")
        if servers is None:
            return False
        changed = False
        for k in list(servers.keys()):
            if k in names:
                del servers[k]
                changed = True
        if changed:
            # Drop the section entirely if it ends up empty? Spec says
            # "remove only [mcp_servers.*] entries, not the whole file".
            # Leave the (now empty) section header — tomlkit emits it as a
            # blank table; that's still less destructive than removing.
            path.write_text(tomlkit.dumps(doc))
        return changed

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

        spec_names = {s.name for s in specs}
        prior = set(prior_managed) if prior_managed is not None else None
        added: set[str] = set()
        removed: set[str] = set()

        existing_servers = doc.get("mcp_servers")
        # Nothing to add and nothing the sidecar lets us remove → no-op. Do NOT
        # materialize an empty [mcp_servers] table on a fresh file.
        names_to_remove = (
            {n for n in prior if n not in spec_names} if prior is not None else set()
        )
        if not specs and (existing_servers is None or not names_to_remove):
            return GlobalMcpWriteResult(managed=set(), changed=False)

        servers = existing_servers
        if servers is None:
            servers = tomlkit.table()
            doc.add("mcp_servers", servers)

        for s in specs:
            if s.name not in servers:
                added.add(s.name)
            servers[s.name] = self._spec_to_table(s)

        if prior is not None:
            for name in names_to_remove:
                if name in servers:
                    del servers[name]
                    removed.add(name)

        new_managed = set(spec_names)
        serialized = tomlkit.dumps(doc)

        changed = existing_text != serialized
        if not changed:
            return GlobalMcpWriteResult(managed=new_managed, changed=False)

        backup_global_mcp(harness_id, "toml", global_path)
        _atomic_write_text(global_path, serialized)
        return GlobalMcpWriteResult(
            managed=new_managed, added=added, removed=removed, changed=True
        )


# ─────────────────────────────────────────────────────────────────────────────
# opencode — opencode.json `mcp` object (JSON, distinct shape)
# ─────────────────────────────────────────────────────────────────────────────


class OpenCodeMcpAdapter:
    """Writes opencode's `opencode.json` MCP servers under the `mcp` key.

    opencode's MCP shape differs from `.mcp.json` (so it cannot reuse
    `ClaudeMcpAdapter`): the object is keyed by server name, each entry carries
    a required `type` discriminator, a single flat `command` array (command +
    args combined), an `environment` map (not `env`), and `enabled`. Verified
    against https://opencode.ai/config.json (McpLocalConfig) — fetched
    2026-06-10. Local stdio servers only (`type: "local"`); the hub's
    `McpServerSpec` has no remote form.

    Writes the project-local `<project>/opencode.json` only — like the Claude
    and Codex MCP adapters, MCP sync is per-project (servers come from equipped
    skills); there is no global MCP write. The same file carries opencode's
    `permission` block (the permission adapter owns `permission.*`); each writer
    touches a disjoint subtree. The write is merge-preserving: unrelated keys
    (`model`, `permission`, user-authored `mcp.*`) are round-tripped untouched.
    Malformed JSON ⇒ WARN + skip.
    """

    file_relative = "opencode.json"
    format_key = "opencode-json"

    def _spec_to_entry(self, spec: McpServerSpec) -> dict:
        entry: dict = {
            "type": "local",
            "command": [spec.command, *spec.args],
            "enabled": True,
        }
        if spec.env:
            entry["environment"] = dict(spec.env)
        return entry

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

    def write(self, project_root: Path, specs: list[McpServerSpec]) -> bool:
        path = project_root / self.file_relative
        existing = self._load(path)
        if existing is None:
            return False
        servers = dict(existing.get("mcp") or {})
        changed = False
        for s in specs:
            entry = self._spec_to_entry(s)
            if servers.get(s.name) != entry:
                servers[s.name] = entry
                changed = True
        if specs or "mcp" in existing:
            existing["mcp"] = servers
            if servers and changed:
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "w") as f:
                    json.dump(existing, f, indent=2)
                    f.write("\n")
                return True
        return False

    def remove(self, project_root: Path, names: set[str]) -> bool:
        path = project_root / self.file_relative
        existing = self._load(path)
        if not existing:
            return False
        servers = existing.get("mcp") or {}
        to_remove = [k for k in servers if k in names]
        if not to_remove:
            return False
        for k in to_remove:
            del servers[k]
        if servers:
            existing["mcp"] = servers
        else:
            existing.pop("mcp", None)
        with open(path, "w") as f:
            json.dump(existing, f, indent=2)
            f.write("\n")
        return True


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
