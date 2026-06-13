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
import sys
from dataclasses import dataclass, field
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
