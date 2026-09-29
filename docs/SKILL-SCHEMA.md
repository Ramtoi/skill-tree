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
*Triggering* picker). These flags are the canonical Hub intent. Sync translates
that intent into native settings for each delivery destination.

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
- Claude Code supports both flags. Pi supports User-only but retains `/skill:name`
  for Model-only. Codex User-only writes `policy.allow_implicit_invocation: false`
  in a generated `agents/openai.yaml`. Codex Model-only allows implicit use but
  cannot disable explicit invocation.
- Auto restores source-native settings. A source-authored Codex false remains
  false in Auto. Hub never edits the source YAML during sync.
- opencode support depends on observed capability. Release 1.18.31 exposes both
  model discovery and slash commands. Its Model-only restriction is unsupported.
  V2 metadata remains unverified because released runtime evidence is absent.
- `hub skill invocation <name> [--project <project>] --json` reads target outcomes
  and previews without running sync or probing a runtime. The existing project
  invocation read retains `library`, `override`, and `effective` as intent and
  adds `outcomes`. Each result separates support from delivery and includes its
  source fingerprint, capability profile and observation time.
- Affinity chooses delivery destinations. Invocation never changes affinity.
  Shared discovery paths mean affinity is not an access-control boundary.
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
next sync re-derives it). Variants also carry native policy for library defaults
and global skills. Shared physical destinations receive one combined payload.
Do not delete the variant tree while live links reference it. Sync collects
unused artifacts after replacement, retaining failed or skipped consumers.
Malformed native YAML and write failures retain the last good delivery and make
sync report failure. Unsupported capabilities are reported as limits, not as
transient write failures.

**`description` writing tips:**
- Start with what the skill does and when to use it
- Include explicit trigger phrases the AI should recognize
- Keep it under 150 words — it's injected on every session
- Phrase it as instructions: "Use this skill when X" / "Trigger on Y"

### `ships_with:` — companion agents, hooks, and permission rules

A skill may declare companions it wants provisioned alongside it — a pair of
sub-agents, a guard hook, a deny/ask permission rule. Frontmatter is the
source of truth; the hub mirrors it verbatim into `skills.<n>.ships_with` on
sync (read-only from the registry side, exactly like `harnesses:`).

```yaml
---
name: orchestrate-advanced
description: |
  ...
ships_with:
  agents: [orch-implementer, orch-reviewer]   # <skill>/agents/<name>.md files
  hooks:
    - name: orch-scope-guard
      event: PreToolUse                         # any of the 14 canonical hook events
      tools: [Edit, Write, MultiEdit]            # optional
      command: scripts/scope-guard.sh            # relative to the SKILL dir — no
                                                  # `..`, no absolute path, no symlink
                                                  # that resolves outside the skill dir
      activation: while-running                  # always | while-running (display-only —
                                                  # see note below)
      harnesses: [claude-code, codex]             # optional per-hook affinity
    - ref: lsp-report                             # OR a reference into the hooks
                                                  # library (user or built-in) instead
                                                  # of an inline definition — see below
  permissions:
    deny: ["Bash(git push --force:*)"]
    ask: ["Bash(gh pr merge:*)"]
---
```

A single malformed field (a bad event name, an out-of-tree hook command, a
missing agent file, an un-representable permission pattern) drops the WHOLE
block on sync, with one warning — never a partial mirror.

**A hook entry may be a REFERENCE instead of an inline definition** —
`{ref: <name>}`, naming an existing hooks-library entry (user-defined or
built-in) — normalized to exactly `{ref: <name>, name: <name>}` and nothing
else: event, tools, matcher, timeout, and harness affinity all come from the
referenced definition at provisioning/reconcile time, never from the
`ships_with` block itself. A referenced hook is attached as-is; if the
library entry later disappears, the doctor reports `COMPANION_REF_MISSING`
and the companion shows as `missing`. An inline hook and a ref may not
declare the same `name` — that fails the whole block, same as any other
malformed field.

**`agents/<name>.md`** is a harness-agnostic sub-agent definition living
inside the skill directory:

```yaml
---
name: orch-implementer
description: <one line>
tier: worker            # deep | planner | worker
tools: [Read, Edit, Write, Bash, Grep, Glob]   # Claude Code tool names
---
<body = the agent's system prompt>
```

`tier` maps to a concrete model per harness at provisioning time (Claude Code
model alias for Claude Code, `model` + `model_reasoning_effort` for Codex) —
never a literal model name in the source file, so the mapping can move
without touching every skill that ships an agent. A field a target harness
doesn't model (Codex has no `tools` key) is dropped with a warning rather
than causing an error.

**`activation`** (`always` | `while-running`) is display metadata only: no
harness can scope a hook's *attachment* to "only while a particular skill's
workflow is active" — the hook stays attached at the project scope for as
long as the companion relationship exists, and a `while-running` hook's own
script is responsible for exiting immediately when there is no matching
active-workflow marker. The hub shows the word so the user knows what they're
looking at; it changes no write behavior.

**Provisioning** (`hub enable <skill> --project <p> --with-companions`,
`hub disable --keep-companions`, `hub skill companions <skill>`) and the two
related doctor findings ship in later waves of this feature; this section
covers the frontmatter shape and the registry mirror only. Every
`hub skill companions <skill>` read's payload — project-less or with
`--project` alike — always carries a top-level `provisioned_on` list — every
scope (a project name, or the literal `"global"`) whose companions ledger
claims the skill, never narrowed to a `--project` argument the caller passed
— so it can say WHERE a companion is actually installed instead of only
present/absent.

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
      transport: stdio          # stdio | http | sse. Absent means stdio.
      runtime: python           # python | node. Informational. Nothing reads it.
      command: python3          # The executable to run. Only for stdio.
                                 # Absent on a stdio block means python3.
      args: ["{source}/server.py"]  # {source} expands to the resolved source
                                 # path for a project write. It stays literal
                                 # in a remote-connector wire dict — see
                                 # "The {source} placeholder on a remote" below.
      env:                      # Environment variables. Only for stdio.
        MY_KEY: "${MY_KEY}"     # A ${VAR} reference — see "Secrets" below.
      url: https://example.com/mcp   # Only for http or sse.
      headers:                  # Only for http or sse.
        Authorization: "Bearer ${MY_TOKEN}"
      timeout_ms: 30000          # Optional request timeout, in milliseconds.
      allow_literal_secrets: false  # Set by `hub mcp add --allow-literal`.
                                 # True means a header or env value looks like
                                 # a real credential and the user approved it.

    # Secrets: use a "${VAR}" reference, never a literal credential. hub reads
    # the value from the process environment at delivery time. `hub mcp add`
    # and `hub mcp set` refuse a value that looks like a real secret unless
    # you pass `--allow-literal`. A literal secret an operator allows is
    # excluded from backups (see docs/BACKUP.md), but it still lands in every
    # native config file hub writes.
    #
    # `hub mcp set --json-stdin` reads a PARTIAL `mcp:` object from stdin and
    # merges it over the current block — but not by union like a hooks merge:
    # a key set to `null` DELETES it (a header, an env var, or a top-level
    # key like `url`), one level into `headers`/`env` or at the top; a `null`
    # that would leave the spec invalid (e.g. an http server losing its
    # `url`) is refused, exit 2, naming the key; a list (`args`) REPLACES the
    # stored list wholesale, never merges element-by-element; any other key
    # not mentioned in the partial is left untouched.
    #
    # Each harness expands a reference differently:
    #   - Claude Code and Pi keep "${VAR}" as written.
    #   - Codex turns "Authorization: Bearer ${VAR}" into a
    #     `bearer_token_env_var`, a lone "${VAR}" header into
    #     `env_http_headers`, and a stdio env value that is exactly
    #     "${KEY}" (key and var name matching) into its `env_vars` list.
    #     A reference Codex cannot express is dropped, and hub sync names
    #     the server and the field.
    #   - opencode rewrites "${VAR}" to "{env:VAR}".
    #   - A "${VAR:-default}" form (a fallback value) reaches only Claude
    #     Code and Pi. Codex and opencode drop it and hub sync says so.
    #   - Codex has no way to run an sse server. hub sync skips that server
    #     for Codex and writes nothing for it there.
    #
    # The {source} placeholder on a remote: a project write expands
    # "{source}" in `args` to the skill's real path on disk. A remote
    # connector's copy of the same server keeps the literal string
    # "{source}" — by design, so a scaffolded server's stored fingerprint
    # never changes — but it means the string is not expanded on the remote
    # box today. This is a known gap.

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
    include: [unslop, review]      # Optional: the ONLY upstream skill names this
                                   #   source may auto-register. Absent ⇒ follow
                                   #   the repo in full; `[]` ⇒ nothing new
                                   #   follows. Written ONLY when an explicit
                                   #   add-time `selected_new` leaves out some NEW
                                   #   candidate; holds selected NEW ∪ every
                                   #   conflict name ∪ already-owned names (never
                                   #   INVALID ones). Edited with
                                   #   `hub source edit <id> --include|--include-all`.
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

### Claude Code and Pi: `<project>/.mcp.json`

Hub writes the same `.mcp.json` file for Pi and Claude Code — one write, not
two. A stdio server keeps today's shape exactly, with no `"type"` key. This
is observed, not documented by Claude Code itself: today's hub-written files
omit `"type"` on a stdio entry and work on this machine. See
DEFERRED-OBSERVATIONS.md for the follow-up check after the next Claude Code
upgrade.

```json
{
  "mcpServers": {
    "code-reviewer": {
      "command": "python3",
      "args": ["/absolute/path/to/mcp-servers/code-reviewer/server.py"],
      "env": {}
    },
    "remote-tool": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {"Authorization": "Bearer ${REMOTE_TOOL_TOKEN}"}
    }
  }
}
```

If `.pi/mcp.json` already exists, Pi reads that file instead of
`.mcp.json`. In this case, hub's MCP servers stay invisible to Pi. Hub
prints a warning during sync. It does not write to `.pi/mcp.json`.

### Codex: `<project>/.codex/config.toml`

```toml
[mcp_servers.code-reviewer]
command = "python3"
args = ["/absolute/path/to/mcp-servers/code-reviewer/server.py"]
env = {}

[mcp_servers.remote-tool]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOOL_TOKEN"
```

Codex cannot read every shape hub's schema allows:

| Registry shape | Codex table |
|---|---|
| A stdio env value that is exactly `${KEY}` and the key matches the var name | Moved to `env_vars` (Codex's own forward list); left out of `env` |
| A stdio env value that is `${OTHER}` under a different key | Dropped. hub sync names the server and the key |
| An `Authorization` header set to exactly `Bearer ${VAR}` | `bearer_token_env_var = "VAR"` |
| Any other header set to exactly `${VAR}` | Moved to `env_http_headers` |
| A header with no `${…}` at all | Kept in `http_headers` |
| A header mixing fixed text and a reference, or using the `${VAR:-default}` form | Dropped. hub sync names the server and the header |
| `transport: sse` | The whole server is skipped for Codex. Nothing is written for it there |

### opencode: `<project>/opencode.json`

```json
{
  "mcp": {
    "code-reviewer": {
      "type": "local",
      "command": ["python3", "/absolute/path/to/mcp-servers/code-reviewer/server.py"],
      "enabled": true
    },
    "remote-tool": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": true,
      "headers": {"Authorization": "{env:REMOTE_TOOL_TOKEN}"}
    }
  }
}
```

opencode has one remote type — an `sse` server degrades to `"type": "remote"`
the same as an `http` one. A `${VAR}` reference is rewritten to `{env:VAR}`.
A `${VAR:-default}` form cannot be expressed; hub sync drops it and names
the server and the field.

---

## How hub reports MCP delivery

`hub sync` writes files. It does not prove that a harness will load a
server, or that the server answers. Hub keeps these three facts separate:

1. **Did hub write it?** A row on the sync report, one per (harness, scope,
   server).
2. **Will the harness load it?** Two checks hub can do from files it already
   reads, at sync time, with no network call.
3. **Does the server answer?** A live check. Only `hub mcp check` does this.
   `hub sync` never does.

### Delivery rows

Every sync writes `report.global.mcp.delivery` and, per project,
`report.projects.<name>.mcp_delivery`. Each row has this shape:

```json
{
  "harness": "claude-code",
  "adapter": "claude",
  "scope": "project:alpha",
  "server": "code-reviewer",
  "target_file": "/path/to/alpha/.mcp.json",
  "state": "written",
  "reason": null,
  "detail": null
}
```

`state` is one of:

| State | Meaning |
|---|---|
| `written` | Hub changed this file for this server on this run. |
| `unchanged` | The server is already in the file and matches. **This does not mean the server answered** — only that the bytes match. |
| `skipped` | Hub deliberately wrote nothing (affinity rule, no target for this harness, a shape this harness cannot express). |
| `blocked` | The bytes are on disk, but the harness still will not load the server (see below). |

When `state` is `skipped` or `blocked`, `reason` names why:
`affinity`, `no_global_target`, `not_hub_owned`,
`adapter_missing`, `parse_aborted`, `claude_project_not_approved`,
`codex_untrusted_project`, `codex_no_sse`, `codex_header_not_representable`,
`codex_env_not_representable`, `opencode_default_dropped`. The last three
always carry a `detail` — the header or env key that could not be carried
over. A whole-server refusal (for example `codex_no_sse`, where Codex cannot
speak SSE at all) is `skipped`, never `blocked` — no bytes were written for
it anywhere.

### Approval — why `written` can still mean "blocked"

Writing a file is not the same as the harness using it.

- **Claude Code** only loads a project's `.mcp.json` servers that are listed
  in `enabledMcpjsonServers`, inside `.claude/settings.local.json` — the
  personal, uncommitted settings file. Hub writes that list itself: it adds
  every server it delivers and removes a name it stops delivering, but it
  never touches a name the user added by hand. If hub cannot write or parse
  that file, every server row for that project becomes
  `blocked` / `claude_project_not_approved`.
- **Codex** only loads a project's `[mcp_servers.*]` table when that project
  is marked `trust_level = "trusted"` in `~/.codex/config.toml`. Hub never
  sets that flag itself — trust also turns on project hooks and a committed
  `.codex/config.toml`, and granting it is not hub's call to make from the
  MCP writer. An untrusted project's rows read
  `blocked` / `codex_untrusted_project`.

### The live probe — `hub mcp check`

```
hub mcp check <name> [--project P] [--timeout-s N] [--env-from-shell|--no-env-from-shell] [--json]
hub mcp check --all [--json]
```

`--project` is context only — hub does not have a per-project MCP config to
check against, so this always resolves the server the same way, project or
not.

This is the only command that opens a real connection to a server: it spawns
the process (stdio) or sends one request (http/sse), and speaks the MCP
handshake (`initialize`, then `tools/list`). `hub sync` never does this — a
live check costs seconds, and sync runs after almost every click in the app.

Every `${VAR}` reference in the server's `env`, `headers`, or `url` must
resolve before hub checks anything. Hub looks first in its own process
environment, then in a snapshot of your login shell (the app is not launched
from a terminal, so it does not see everything your shell profile exports).
A name that resolves nowhere stops the check before it spawns or sends
anything, with `state: "unresolved_ref"` and the missing names listed.

The result is one row:

```json
{
  "name": "code-reviewer",
  "transport": "stdio",
  "state": "ok",
  "tool_count": 3,
  "tools": ["review", "lint", "suggest"],
  "latency_ms": 42,
  "protocol_version": "2024-11-05",
  "unresolved_refs": [],
  "env_from_shell": true,
  "error": null,
  "checked_at": "2026-09-06T00:00:00Z"
}
```

`state` is one of `ok`, `unresolved_ref`, `unreachable` (connection refused,
DNS failure, non-2xx response, or the process exited), `protocol_error` (a
response that is not valid JSON-RPC), `timeout`, or `unsupported`.
`env_from_shell` is `false` when hub could not read your login shell's
exported variables — a check can then only see variables exported to GUI
apps, which is usually fewer than a terminal sees.

Every check writes its row to a cache at
`<data_home>/state/mcp/probes.json`. `hub mcp show <name> --json` reads the
same cache back as `last_probe`. `hub mcp add --probe` runs one check right
after registering a server. The doctor reads this cache too — never a live
check — and reports `MCP_PROBE_STALE` when a server has never been checked,
or was last checked more than seven days ago.

---

## MCP Server Protocol

Hub MCP servers use the MCP stdio transport:
- One JSON-RPC message per line (newline-delimited)
- Server reads from stdin, writes to stdout
- Required methods: `initialize`, `tools/list`, `tools/call`

See `mcp-servers/code-reviewer/server.py` for a complete working example.
