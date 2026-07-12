# Schema Reference

## SKILL.md Frontmatter

Claude Code and Pi parse frontmatter from `SKILL.md` to expose the skill.

```yaml
---
name: skill-name           # Required. Must match directory name and registry key.
description: |             # Required. Injected into the system prompt.
  One-line description.    # Write trigger conditions and phrases here.
  Trigger: "/slash", "phrase", "phrase2".
disable-model-invocation: false  # Optional. Invocation axis — see table below.
user-invocable: true       # Optional. Invocation axis — see table below.
harnesses: [claude-code]   # Optional. Restrict which harnesses receive this skill on
                           # sync. Absent ⇒ all of the project's effective harnesses.
                           # Valid ids: claude-code, codex, pi. Unknown ids warn but
                           # do not reject the skill (forward-compat).
---
```

### Invocation axis (who may invoke the skill)

Two frontmatter flags encode a three-state **invocation mode**. The hub mirrors
it into the registry at sync (`skills.<n>.invocation`, absent = `auto`) and
edits it via `hub set-meta <skill> --invocation <mode>` (or the Skill Editor's
*Triggering* picker). Frontmatter is the source of truth — it's what the
harness reads.

| Mode | Frontmatter | You (`/name`) | Claude | Description in context |
|---|---|---|---|---|
| `auto` (default) | *(neither flag)* | ✓ | ✓ | Always |
| `user-only` | `disable-model-invocation: true` | ✓ | ✗ | **No** — loads only when you invoke (saves context) |
| `model-only` | `user-invocable: false` | ✗ (hidden from `/` menu) | ✓ | Always |

Notes:
- Both flags at once is a hand-authored contradiction — the hub surfaces it as
  the read-only `conflicted` state (sync warning + warn badge); any
  `set-meta --invocation` write repairs it.
- `user-only` also stops Claude Code from preloading the skill into subagents
  and firing it from scheduled tasks (Claude Code ≥ 2.1.196).
- The flags are Claude-family semantics: Claude Code (and Pi) honor them;
  Codex/opencode ignore them (inert, not harmful).
- `managed: external` skills: the hub never edits upstream checkouts, so the
  library default is read-only — use a per-project override instead.

**Per-project override** (`projects.<n>.invocation_overrides`, set via
`hub project invocation <project> --skill <s> --mode <m|inherit>`): sync points
the project's skill symlink at a generated *variant* dir
(`<data_home>/state/skill_variants/<skill>@<mode>/` — a real SKILL.md with
patched frontmatter + per-file symlinks back to the library). Overrides only
work for `portable` / `project-specific` skills: a `scope: global` skill lives
in `~/.claude/skills/`, and Claude Code gives user-level skills precedence over
same-name project skills, so a project-level copy could never win. ⚠️ The
variant SKILL.md is generated — edit the library copy, not the file reached
through an overridden project path (a marker comment in the file says so; the
next sync re-derives it). The whole `skill_variants/` tree is regenerable and
safe to delete.

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
    invocation: user-only      # Sync-time MIRROR of the SKILL.md invocation flags
                               # (absent = auto). Never edit here — edit the
                               # frontmatter via `hub set-meta --invocation`.

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
    invocation_overrides:      # Optional. Per-skill invocation override for THIS
      skill-name: user-only    # project (auto | user-only | model-only). Only
                               # valid for portable/project-specific skills —
                               # see § Invocation axis. Synced via variant dirs.
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

Scope is the skill's **reach** — where it is available — not how it gets
invoked (that's the invocation axis above). The two axes are independent.

| Scope | Reach | Synced to | Enabled by | Mechanical difference? |
|---|---|---|---|---|
| `global` | Everywhere — active in every project, always on | `~/.claude/skills/<name>` (symlink) | Always | — |
| `portable` | Per-project — equip it where you need it; reusable across projects | `<project>/.claude/skills/<name>` + `<project>/.agents/skills/<name>` | `hub enable <skill> --project <name>` | **None vs `project-specific`** — intent label only |
| `project-specific` | Per-project — built for one specific project | Same as portable | `hub enable <skill> --project <name>` | **None vs `portable`** — intent label only |

**`portable` vs `project-specific` is an intent label, not a mechanism:**
- `portable`: the skill makes sense in multiple projects (e.g., `android-compose-ui`)
- `project-specific`: the skill references project-specific docs/rules and is only meaningful in one project (e.g., `proj-git`, which references example-app's `docs/git.md`)

Scope also gates the invocation axis: per-project invocation overrides are only
possible for the two per-project scopes (see Invocation axis above).

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
