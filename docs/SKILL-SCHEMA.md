# Schema Reference

## SKILL.md Frontmatter

Claude Code and Pi parse frontmatter from `SKILL.md` to expose the skill.

```yaml
---
name: skill-name           # Required. Must match directory name and registry key.
description: |             # Required. Injected into the system prompt.
  One-line description.    # Write trigger conditions and phrases here.
  Trigger: "/slash", "phrase", "phrase2".
disable-model-invocation: false  # Optional. If true, skill is listed but AI ignores it.
harnesses: [claude-code]   # Optional. Restrict which harnesses receive this skill on
                           # sync. Absent ⇒ all of the project's effective harnesses.
                           # Valid ids: claude-code, codex, pi. Unknown ids warn but
                           # do not reject the skill (forward-compat).
---
```

**`description` writing tips:**
- Start with what the skill does and when to use it
- Include explicit trigger phrases the AI should recognize
- Keep it under 150 words — it's injected on every session
- Phrase it as instructions: "Use this skill when X" / "Trigger on Y"

---

## registry.yaml — Full Schema

```yaml
version: "1"
hub_path: "~/.skill-hub"        # Informational; runtime resolves data_home()

bootstrap:                       # Written by `hub bootstrap`. Absent → wizard runs on launch.
  completed_at: "2026-05-21T14:32:00Z"   # ISO 8601 UTC.
  version: 1                              # Bootstrap schema version.

# Harness-aware sync: which coding harnesses receive synced skills.
# Effective set per project = (harnesses_global ∪ project.harnesses) ∩ installed
harnesses_global:                # Top-level: harnesses always on for every project.
  - claude-code                  # Valid ids: claude-code, codex, pi.

skills:
  <skill-name>:
    version: "1.0.0"           # SemVer. Bump manually when content changes.
    description: "..."         # One-line description shown in hub list / dashboard.
    source: "~/path/to/dir"    # Path to the directory containing SKILL.md.
                               # For MCP servers: path to the dir with server.py.
                               # For external skills: points into the data-home
                               # source cache (e.g. ~/.skill-hub/sources/<id>/worktree/...).
                               # Supports ~ expansion.
    type: claude-skill         # claude-skill | mcp-server
    scope: global              # global | portable | project-specific (see below)
    tags: [tag1, tag2]         # Used for filtering in dashboard and hub list.
    upstream: null             # null | git-URL for update checks

    # Source ownership (added by add-external-skill-sources change). Missing
    # means local / backward-compatible. See § "Sources" below.
    managed: local             # local | external | starter
    origin:                    # Only when managed: external
      source: org-skills       # Source id (key into top-level `sources:`)
      source_type: git
      path: skills/foo         # Path within the source checkout
      ref: abc123              # Synced ref at import time
    source_missing: false      # Set by `hub source sync` when upstream removed the skill

    # Only for type: mcp-server
    mcp:
      runtime: python          # python | node (informational)
      command: python3         # The executable to run
      args: ["{source}/server.py"]  # {source} is expanded to the resolved source path
      env:                     # Environment variables passed to the server process
        MY_KEY: "value"        # Use "" to inherit from parent environment

projects:
  <project-name>:
    path: "/absolute/path"     # Must be absolute. Use full path, not ~.
    harnesses:                 # Additive to harnesses_global. Optional.
      - pi                     # Valid ids: claude-code, codex, pi.
    bundles:                   # Project-specific bundles applied to this project.
      - android
    enabled:                   # List of skill names enabled for this project.
      - skill-name             # Order doesn't matter.
      - other-skill
```

---

## Sources

External skill origins live under a top-level `sources:` block. Built-in
`local` and `starter` categories are inferred at runtime and not stored here.

```yaml
sources:
  org-skills:
    type: git                      # git | litellm (reserved, coming soon)
    name: Org Skills               # Display name (defaults to id)
    url: git@github.com:org/skills.git
    branch: main                   # Optional; defaults to remote default branch
    path: skills                   # Optional repo-relative subdirectory to scan
    auth: system-git               # Informational; credentials are never stored here
    cache: ~/.skill-hub/sources/org-skills/worktree
    current_ref: abc123
    remote_ref: def456             # Optional; populated by `hub source check`
    status: update-available       # unknown | up-to-date | update-available | syncing | error
    last_checked_at: "2026-05-21T16:40:00Z"
    last_synced_at: "2026-05-21T16:38:00Z"
    error: null
```

**Source id rules:**
- Must match `^[a-z0-9-]+$` (slug).
- `local` and `starter` are reserved for the built-in categories.

**Ownership inference (legacy/backward-compat):** If a skill omits `managed`/
`origin`, the runtime classifies it by source path — under `<data_home>/skills/`
→ local, under `<code_home>/skills/` → starter, anything else → local with a
warning.

## Scope Rules

| Scope | Synced to | Enabled by | Who sees it |
|---|---|---|---|
| `global` | `~/.claude/skills/<name>` (symlink) | Always | Claude Code and Pi everywhere |
| `portable` | `<project>/.claude/skills/<name>` + `<project>/.agents/skills/<name>` | `hub enable <skill> --project <name>` | Claude Code and Pi in that project |
| `project-specific` | Same as portable | `hub enable <skill> --project <name>` | Claude Code and Pi in that project |

**Difference between `portable` and `project-specific`:**
- `portable`: the skill makes sense in multiple projects (e.g., `android-compose-ui`)
- `project-specific`: the skill references project-specific docs/rules and is only meaningful in one project (e.g., `proj-git`, which references example-app's `docs/git.md`)

---

## MCP Config Format (auto-generated by hub sync)

### Claude Code: `<project>/.mcp.json`

```json
{
  "mcpServers": {
    "code-reviewer": {
      "command": "python3",
      "args": ["/absolute/path/to/mcp-servers/code-reviewer/server.py"],
      "env": {}
    }
  }
}
```

### Pi: `<project>/.pi/mcp.json`

Same format — Pi's `pi-mcp-adapter` reads `mcpServers` with identical schema.

```json
{
  "mcpServers": {
    "code-reviewer": {
      "command": "python3",
      "args": ["/absolute/path/to/mcp-servers/code-reviewer/server.py"],
      "env": {}
    }
  }
}
```

---

## MCP Server Protocol

Hub MCP servers use the MCP stdio transport:
- One JSON-RPC message per line (newline-delimited)
- Server reads from stdin, writes to stdout
- Required methods: `initialize`, `tools/list`, `tools/call`

See `mcp-servers/code-reviewer/server.py` for a complete working example.
