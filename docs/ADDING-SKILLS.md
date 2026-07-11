# Adding Skills to the Hub

This guide covers creating new skills and MCP servers, registering them, enabling them per project, and grouping them into reusable bundles.

---

## Deciding: Claude Skill vs MCP Server

|                      | Claude Skill                                                    | MCP Server                                               |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| **Format**           | `SKILL.md` markdown file                                        | Python/Node process (stdio)                              |
| **Invocation**       | Injected into system prompt — AI reads and follows instructions | Exposed as a callable tool — AI sends JSON requests      |
| **Best for**         | Workflows, multi-step processes, style guides, planning agents  | External data, code analysis, file operations, API calls |
| **Examples**         | brainstorm, grill, openspec-propose                             | code-reviewer, database query, git ops                   |
| **Runtime overhead** | None (just text)                                                | Subprocess per session                                   |
| **Model support**    | Claude Code, Pi (both read SKILL.md natively)                   | Claude Code, Pi (via MCP adapter)                        |

**Rule of thumb:** if it's a workflow the AI should _follow_, use a Skill. If it's a tool the AI should _call_, use an MCP server.

---

## Creating a Claude Skill

### 1. Scaffold

```bash
hub new skill my-skill-name
```

This creates `~/Dev/.skill-hub/skills/my-skill-name/SKILL.md` and registers it in `registry.yaml`.

### 2. Write the skill

Edit `skills/my-skill-name/SKILL.md`. The frontmatter is the most important part:

```yaml
---
name: my-skill-name
description: |
  One-line description + trigger phrases: "do X", "/my-skill-name".
---
```

The description is injected into the AI's system prompt verbatim — it determines when and how the AI uses the skill. Write it imperatively: _"Use this skill when..."_ / _"Trigger on..."_.

### 3. Set scope in registry.yaml

Open `registry.yaml` and update the auto-generated entry:

```yaml
my-skill-name:
  scope: global # global | portable | project-specific
  tags: [my-tag]
```

- **global** — always active in Claude Code + Pi everywhere
- **portable** — must be explicitly enabled per project
- **project-specific** — only makes sense in one project

### 4. Enable for projects (if portable or project-specific)

```bash
hub enable my-skill-name --project example-app
```

### 5. Sync

```bash
hub sync
```

Symlinks are created from the hub into the managed runtime locations. Claude Code and Pi pick them up immediately on next session.

`hub sync` also validates that each Claude skill's `SKILL.md` frontmatter `name:` matches its registry key. This prevents hidden collisions where two different folders declare the same runtime skill name.

---

## Creating an MCP Server

### 1. Scaffold

```bash
hub new mcp my-tool-name
```

Creates:

- `mcp-servers/my-tool-name/server.py` — MCP stdio server template
- `mcp-servers/my-tool-name/SKILL.md` — describes the tool for the AI
- Auto-registers in `registry.yaml` with `type: mcp-server`

### 2. Implement the server

Edit `server.py`. Key things to change:

- `handle_tools_list`: declare your tool name, description, and JSON schema
- `handle_tools_call`: implement your tool logic

The template uses the raw MCP stdio protocol (no external deps). For complex tools, you can use the `mcp` Python library:

```python
pip install mcp
from mcp.server import Server
```

### 3. Configure the MCP entry in registry.yaml

```yaml
my-tool-name:
  mcp:
    runtime: python
    command: python3
    args: ["{source}/server.py"]
    env:
      MY_API_KEY: "..." # or leave empty and use env vars
```

### 4. Enable for a project

```bash
hub enable my-tool-name --project side-project
hub sync
```

`hub sync` writes to:

- `<project>/.mcp.json` — Claude Code picks this up
- `<project>/.pi/mcp.json` — Pi picks this up

---

## Versioning

Each skill has a `version` field in `registry.yaml`. Bump it manually when the skill content changes meaningfully:

```yaml
my-skill-name:
  version: "1.1.0" # was 1.0.0
```

Skill Tree shows the current version + a dot indicating update status:

- **Grey dot** — no upstream URL (local only, version is informational)
- **Green dot** — upstream configured and version matches
- **Yellow dot** — upstream has a newer version

To configure an upstream for a skill you maintain in a git repo:

```yaml
my-skill-name:
  upstream: "https://github.com/you/skills/tree/main/my-skill-name"
```

Run `hub update` to check all upstreams.

---

## Harness affinity (which runtimes get this skill)

By default, a skill syncs to **every harness** that is effective on a project
(claude-code, codex, pi — whichever the project has installed and enabled).

To narrow a skill to specific harnesses, add `harnesses:` to its SKILL.md
frontmatter:

```yaml
---
name: claude-hooks-debugger
description: |
  Debug Claude Code hooks. Only meaningful inside Claude Code.
harnesses: [claude-code]   # narrow targeting
---
```

When `hub sync` runs, the effective set is `(harnesses_global ∪ project.harnesses) ∩ installed`,
then for each skill its target dirs are the intersection of that set with the
skill's `harnesses:` affinity. If the intersection is empty, the skill is
skipped on that project (logged so you can see why).

You can also set this from the CLI:

```bash
hub set-meta my-skill --harnesses claude-code,codex   # narrow
hub set-meta my-skill --harnesses ""                  # clear (back to "all")
```

Codex's own `[[skills.config]]` enable mechanism is separate from Skill Hub
symlinking — `harnesses:` controls *whether the symlink is created*; Codex
controls *whether to expose the symlinked skill to the model* via its own
config. The two are independent.

## Adopting a skill hand-authored inside a project

If a skill is created directly in a project's `.claude/skills/<name>/` (e.g. an
agent authored it while working in that repo), it is **not** in the hub yet —
it's a real directory, not a hub-managed symlink. The hub detects these but
never adopts them automatically (adoption swaps the directory for a symlink, so
it stays an explicit action). There are three surfaces over the same detection:

```bash
# CLI — list un-adopted project-local skills (read-only; the shared surface)
hub project scan-skills --json                 # across all registered projects
hub project scan-skills --project myapp        # one project, human-readable

# CLI — adopt one (copies into the data home, registers project-specific,
# enables it on the project; next `hub sync` re-creates it as a symlink).
# Multi-file skills (SKILL.md + references/…) are preserved whole.
hub project import-skill <name> --project myapp
```

- **Agents (MCP):** the control-plane server exposes a read-only
  `skill_candidates` tool (discover) that pairs with `skill_import_project`
  (adopt) — so an agent that just authored a skill can surface and adopt it.
- **App:** a project's view shows a **Detected local skills** section with a
  one-click **Adopt** per `NEW` candidate (`INVALID_NAME` candidates are shown
  read-only with the slug rule). Adopt routes through `import-skill`.

## Adding skills from an external Git source

Skills don't have to live in your data home. Point Skill Tree at a Git
repository (public or private) and it caches the checkout under
`~/.skill-hub/sources/<id>/worktree/`, then imports each discovered `SKILL.md`
as a `managed: external` skill.

```bash
# Preview without mutating anything — clones to a temp dir, scans, removes it.
hub source add git https://github.com/org/skills --dry-run --json

# Apply: clones to the data-home cache and registers NEW candidates.
hub source add git https://github.com/org/skills --id org-skills --name "Org Skills"

# GitHub tree URLs are parsed: branch and subdirectory come from the URL.
hub source add git https://github.com/org/skills/tree/dev/packs/android

# Status / lifecycle
hub source list --json
hub source check  org-skills          # git fetch + compare refs
hub source sync   org-skills          # pull, rescan, update metadata
hub source remove org-skills --dry-run --json
hub source remove org-skills --mode unequip       # delete external skills + scrub bundles/projects
hub source remove org-skills --mode keep-local    # copy into data-home, mark as local, keep equips
hub source duplicate <skill-name> --as <name>-local   # external → local editable copy
```

**Supported repo layouts** (discovery scans the configured directory itself,
its immediate children, and conventional `skills/` / `mcp-servers/` folders
when no explicit subdirectory was given):

```
repo/SKILL.md                          # Single skill at repo root
repo/<skill-name>/SKILL.md             # Multiple skills at root
repo/skills/<skill-name>/SKILL.md      # Conventional skills/ folder
repo/mcp-servers/<name>/SKILL.md       # Conventional mcp-servers/ folder
repo/path/to/<single-skill>/SKILL.md   # With --path path/to
```

**Private repos** use your existing system Git auth: SSH keys, the macOS
keychain credential helper, or configured HTTPS credentials. Skill Tree
invokes `git` with `GIT_TERMINAL_PROMPT=0`, so misconfigured auth fails fast
instead of blocking on a TTY prompt. **Credentials are never stored in
`registry.yaml`.**

**Conflict handling** — if an external candidate shares a name with an
existing local skill, the import preview classifies it as `CONFLICT` and skips
it on apply (V1). Use `hub source duplicate` to convert an external skill to
local for editing.

**Removed upstream** — if `hub source sync` notices a previously imported
skill is gone from the repo, the registry entry is **flagged** with
`source_missing: true` rather than deleted. Resolve by re-equipping a
replacement, duplicating it to local, or removing the source.

## Bulk import via bootstrap (alternative entry point)

On first launch — and any time you re-run with `--force` — `hub bootstrap` scans
your global skill dirs (`~/.claude/skills/`, `~/.codex/skills/`,
`~/.pi/agent/skills/`) for SKILL.md-bearing folders and lets you register them
in batch. Each candidate is slug-validated; collisions with existing registry
entries are surfaced as **conflicts** with Skip / Replace / Register-with-suffix
options (default Skip — never silent).

```bash
hub bootstrap                  # interactive wizard, CLI or via Skill Tree app
hub bootstrap --dry-run --json # preview { legacy_detected, candidates, blocked, conflicts }
hub bootstrap --force          # re-run after first-time setup
```

Use this when you have many existing skills under one of the dot-dirs and want
to register them all at once. For one-off migration of a single existing skill,
`hub migrate <name>` (below) is still the right tool.

## Migrating Existing Skills

If you have a skill living outside the hub (e.g., in a project's `.claude/skills/`):

```bash
hub migrate existing-skill-name
```

This copies it to `~/.skill-hub/skills/existing-skill-name/`, updates `source` in `registry.yaml`, then run `hub sync` to replace the original with a symlink.

The hub should be the only place where skill definitions live. Runtime locations like `~/.claude/skills/`, `~/.pi/agent/skills/`, and project `.claude/skills/` / `.agents/skills/` should contain hub-managed symlinks, not independent skill copies.

---

## Registering a New Project

```bash
hub project add myproject ~/Dev/myproject
hub enable brainstorm --project myproject
hub sync
```

---

## Bundles

Bundles are reusable groups of skills.

- **project-specific bundle** — assign it to one or more projects with `hub bundle apply <bundle> --project <name>`
- **global bundle** — applies automatically to every registered project after `hub sync`; do not assign it per project

Examples:

```bash
hub bundle new android --skills android-compose-ui,android-navigation --scope project-specific
hub bundle new workflow --skills brainstorm,grill --scope global
hub bundle list
hub bundle apply android --project example-app
hub bundle update workflow --scope project-specific
```

## Quick Reference

```
hub list                                  All skills
hub list --project example-app            Skills for a specific project
hub enable <skill> --project <p>          Enable for project
hub disable <skill> --project <p>         Disable for project
hub sync                                  Apply all changes (symlinks + MCP configs)
hub new skill <name>                      Scaffold a new Claude skill
hub new mcp <name>                        Scaffold a new MCP server
hub bundle list                           List bundles and scopes
hub bundle new <name> --skills s1,s2      Create a bundle (--scope global|project-specific)
hub bundle apply <name> --project <p>     Assign a project-specific bundle
hub bundle update <name> --scope <scope>  Change bundle scope or metadata
hub migrate <name>                        Move existing skill into hub
hub project add <name> <path>             Register a new project
hub dashboard                             Open Skill Tree native app
hub update                                Check for upstream updates
hub cleanup-backups                       Delete hub-created backup artifacts
```
