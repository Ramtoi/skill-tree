# CLI reference

Every `hub` subcommand, grouped by family. Each group has one line
on what it is for, then the commands themselves with their flags.

## Bootstrap and migration

First run and moving the data home.

```
hub bootstrap                             # first-run wizard: optional migrate-home, import wizard, sync, writes bootstrap.completed_at
hub bootstrap --dry-run --json            # preview legacy detection, importable candidates, conflicts
hub migrate-home                          # move ~/Dev/.skill-hub/ contents → ~/.skill-hub/
```

## Harnesses

Which harnesses are on, and their global agent docs.

```
hub harness list                          # show installed × on-globally × used-by-projects
hub harness enable <id>                   # add to harnesses_global (claude-code | codex | pi | opencode)
hub harness disable <id>                  # remove from harnesses_global
hub harness doc status --json             # every harness's global-doc state (missing|standalone|source|follows|broken|external)
hub harness doc link <harness> --to <source> [--on-conflict replace|merge]  # make <harness> follow <source>'s global instructions
hub harness doc unlink <harness>          # detach <harness>; it keeps a real copy of the shared text
```

## Agent docs

Canonical root strategy and layout fixes for AGENTS.md/CLAUDE.md.

```
hub agent-docs strategy --get             # show global root-derivation strategy (symlink|import)
hub agent-docs strategy --set import      # set global; add --project <n> for per-project override; --clear to drop it
hub agent-docs fix                        # dry-run transactional canonical-layout plan (all projects); `migrate` = alias
hub agent-docs fix --project <n> --apply  # promote/derive root + clean legacy AGENT.md links (backup-first, abort-on-disk-change)
hub agent-docs fix --project <n> --apply --nested all  # also promote nested CLAUDE.md dirs (opt-in)
hub agent-docs fix --project <n> --apply --rename-legacy  # also rename lone user-authored AGENT.md → AGENTS.md (opt-in)
hub agent-docs fix --project <n> --apply --commit  # opt-in: git-commit ONLY the touched files, prepared message, never pushes
hub agent-docs resolve --project <n> --op keep_agents|keep_claude|absorb_appendix  # explicit conflict/appendix resolution
hub agent-docs publish-on-save --project <n> --enable|--disable  # set the project opt-in; omit both to read it
hub agent-docs publish-now --project <n>        # guarded commit + normal push of root Agent Docs to origin/main
```

## Projects

Register, inspect, and remove projects.

```
hub project harnesses <name>              # show effective + per-source breakdown
hub project harnesses <name> --add <ids>  # mutate project.harnesses (comma-separated)
hub project add <name> <path>             # register a project
hub project worktree-defaults show --json # show effective new-project defaults
hub project worktree-defaults set --config-json <object> --json
hub project worktree-defaults preview --name <slug> --path <absolute-project-path> [--config-json <draft>] --json
hub project edit-path <name> <new-path>   # move a project's filesystem location (cleans old artifacts)
hub project rename <name> <new-name>      # rename in place: block + path stay, state/ sidecars follow (the header's inline field)
hub project remove <name>                 # unregister a project (cleans hub-owned artifacts)
hub project remove <name> --dry-run --json # preview removal plan
hub project import-skill <name> --project <p>  # adopt a hand-authored project-local skill (.claude/skills/<n>) into the hub; auto-syncs
hub project invocation <name>             # table: library mode / override / effective per active skill
hub project invocation <name> --skill <skill> --mode user-only|inherit  # set/clear a per-project invocation override
```

## Skill companions

Provision and resolve a skill's shipped agents, hooks, and rules.

```
hub skill companions <skill> [--project <p>] --json  # declared ships_with + plan_provision items (+ provisioned per item)
hub skill companions set <skill> {--json-stdin | --json-body <json>}  # rewrite the whole ships_with block, then reconcile
hub skill companions add <skill> --kind agent|hook|permission --item <name-or-pattern>     # splice-in alias over `set`
hub skill companions remove <skill> --kind agent|hook|permission --item <name-or-pattern>  # splice-out alias over `set`
hub skill companions new-hook <skill> --item <n> --event <E> [--tools a,b] [--activation while-running|always] [--command scripts/<slug>.sh] [--no-scaffold]  # declare + scaffold a NEW inline hook
hub skill companions resolve <skill> --agent <n> --op keep-mine|keep-skill [--project <p> | --global]  # drift resolution
```

## Skills

Equip, unequip, and edit skill metadata.

```
hub set-meta <skill> --harnesses claude-code,codex   # narrow a skill's harness targeting
hub list                                  # all skills with bundle membership
hub skill refs                            # whole reference graph (--json for {edges:[{from,to,count}]})
hub skill refs <name> --json              # one skill: refs, referenced_by, ignored (with per-edge counts)
hub set-meta <n> --refs-ignore a,b        # mute false-positive references (empty string clears)
hub rename <old> <new> --rewrite-refs [--rewrite-agent-docs] [--json]  # rewrite every mention of the old name in
                                          #   other skills' markdown, snippets, and (opt-in) project agent docs
hub enable <skill> --project <p> [--with-refs]  # equip; --with-refs also equips the skills it references (one level)
hub enable <skill> --project <p> --with-companions  # + provision its ships_with agents/hooks/permission rules
hub enable <skill> --project <p> --skill-only    # equip only — never provision ships_with companions
hub enable <skill> --project <p> --json          # neither flag + a ships_with skill: equips, then exits 2 with a
                                          #   `{"needs_provisioning": {...}}` line so the caller can re-decide
hub disable <skill> --project <p>         # unequip; also deprovisions its ships_with companions (ledger-scoped)
hub disable <skill> --project <p> --keep-companions  # leave provisioned companions in place (doctor then warns)
hub set-meta <skill> --scope portable     # update skill registry metadata
hub set-meta <skill> --harnesses claude-code,codex  # narrow harness affinity (now also editable in the skill editor UI)
hub set-meta <skill> --invocation user-only  # who may invoke: auto|user-only|model-only (rewrites SKILL.md frontmatter)
hub set-meta <skill> --classes-json '["process","delivery"]'  # registry-only responsibility labels
hub set-meta <skill> --outputs-json '["plan","PR","research report"]'
hub set-meta <skill> --working-mode mixed  # inline|delegator|mixed
hub set-meta <skill> --interaction-style checkpointed  # conversational|checkpointed|autonomous
hub set-meta <skill> --maturity confident  # experimental|confident|trusted
hub set-meta <skill> --classes-json '[]'   # clear classes; other fields stay assigned
hub set-meta <skill> --working-mode ''    # clear an enum field
```

## Bundles

Group skills and apply them to projects.

```
hub bundle list                           # bundles + assigned projects
hub bundle apply <bundle> --project <p>   # assign bundle (creates symlinks)
hub bundle remove <bundle> --project <p>  # unassign bundle (removes symlinks)
hub bundle new <name> --skills s1,s2      # create bundle
hub bundle new <name> --skills s1,s2 --playbook '<json>' # create with presentation sections
hub bundle new <name> --skills s1,s2 --source <src>  # create a LINKED bundle that follows an external source
hub bundle update <name> --detach-source  # unlink a linked bundle (skill list stays, becomes editable)
hub bundle update <name> --skills s1,s2   # update bundle metadata or membership
hub bundle update <name> --playbook '<json>' # update presentation sections; [] clears them
hub bundle rename <old> <new>             # rename in place: membership + every project/remote/cloud reference follow
hub bundle delete <name>                  # delete + unassign from all projects
```

## Sources

External git sources that skills can come from.

```
hub source add git <url> --decisions-stdin  # clone+register; per-conflict skip|replace|suffix + optional
                                          #   `selected_new` subset on stdin (both fail-closed). A deep
                                          #   github tree/blob URL scopes the scan; --path (repo-relative) wins.
                                          #   A missing scan base is an error: `path_not_found` (+ `hint_path`).
                                          #   Registers, then auto-syncs — no manual `hub sync` needed.
hub source edit <id> --name <str>         # rename a source's display name (id is immutable)
hub source edit <id> --include a,b        # curate: only these upstream names may be registered later
hub source edit <id> --include-all        # clear the curation filter (follow the repo in full)
hub source disable <id>                   # keep source + skills registered; stop syncing them to projects (auto-syncs)
hub source duplicate <skill> [--as <new>] # copy a read-only (external or built-in) skill into the library as an editable local skill
hub source enable <id>                    # resume syncing a disabled source's skills (auto-syncs)
hub source sync <id>                      # pull + rescan: REGISTERS new upstream skills (CONFLICT/INVALID stay in
                                          #   new_pending; NEW ones outside `include:` → reported as `excluded`),
                                          #   reconciles linked bundles (bundle_updates in --json), auto-syncs on change
hub source dropped [id] --skill <n> --content --json  # read-only: skills upstream renamed/deleted, classified + successor + equipped
hub source recover <name>                 # Keep as local: restore a dropped-upstream skill's last-known content
```

## Archive

Forget a skill and undo that.

```
hub archive <name> [<name>…] --json       # Forget/archive one or more skills; writes an undo sidecar first
hub unarchive <name> [<name>…] --json     # undo `hub archive`: restores dir + registry entry + every reference
```

## MCP servers

Register and probe MCP servers you already have.

```
hub mcp add <name> [--transport stdio|http|sse] [flags]  # register an MCP server you already have
hub mcp add <name> --json-stdin           # paste a server's native JSON (bare object, or a {"mcpServers":{...}} wrapper)
hub mcp set <name> [flags] [--json-stdin] # edit a registered server; --json-stdin merges a partial `mcp:` block (a nested `null` deletes that key, a list replaces)
hub mcp show <name> --json                # spec + secret refs + per-harness resolved rows + last_probe (from the probe cache)
hub mcp list --json                       # every registered MCP server + equip counts
hub mcp remove <name> --yes               # archive a registered MCP server (delegates to `hub archive`)
hub mcp check <name> [--project P (context only — resolution is registry-wide)] [--timeout-s N] [--no-catalog] [--catalog-timeout-s N] [--json]  # live probe: spawns/connects, speaks initialize+tools/list; also fetches the capability catalogue by default (--no-catalog opts out, and deletes any stale one); never touches the registry
hub mcp check --all [--catalog] [--json]  # probe every registered server, sequentially; catalogue fetch defaults OFF here (opt in with --catalog); the CLI-only liveness sweep for a user who never opens the app
hub mcp catalog <name> [--instructions] [--json]  # print the last-fetched capability catalogue (tools/resources/templates/prompts + parameters); read-only, never probes; fails closed (code "no_catalog") if nothing has been fetched yet
hub mcp reconcile [--global | --project P] [--harness H] [--json]  # discover MCP servers already configured natively, classified new|conflict|already_managed|unsupported|stale
hub mcp reconcile [--global | --project P] --apply --decisions-stdin [--json]  # adopt chosen candidates in one transaction (import|keep|unkeep|skip|remove decisions on stdin)
```

## Skill packs

Export or import a skill as a portable file.

```
hub skill export <n> --format zip         # deterministic <skill>/SKILL.md archive for manual cloud upload (default: pack)
hub skill import <file> [--name <n>] [--dry-run] [--json]  # import a `.skillpack`; registers, then auto-syncs
```

## Sync

Rebuild every symlink and native file from the registry.

```
hub sync                                  # rebuild symlinks from registry (also runs the permissions stream + doctor)
hub sync --skip-permissions               # bypass the permissions stream and doctor rollup
hub sync --skip-hooks                     # bypass the hooks stream (doctor still covers permissions)
```

## Permissions

Allow, deny, and ask rules, plus adoption of pre-existing ones.

```
hub permissions list                      # summary of permission counts per scope
hub permissions show --global             # show global rules
hub permissions show --project <n> --effective  # show resolved (global+project) rules with origin
hub permissions add --global --kind allow --pattern "Bash(npm:*)"
hub permissions remove --global --kind allow --pattern "Bash(npm:*)"
hub permissions hooks add --global --event PreToolUse --matcher Bash --command "..."
hub permissions reconcile --global --json         # unified discovery: merged/conflict/un-importable (machine output)
hub permissions reconcile --global --apply --decisions-stdin  # transactional + auto-syncing apply of chosen decisions
hub permissions adopt --global --action import    # legacy shortcut: ingest all pre-existing native rules
hub permissions adopt --project <n> --action skip --harness claude-code
hub permissions import --global --interactive     # legacy alias → reconcile; per-rule import/keep/drop (MOVE)
hub permissions migrate-scope                     # dry-run: strip global-sourced duplicates from project files
hub permissions migrate-scope --apply             # back up + remove the duplicates
hub permissions doctor                    # detect risks; non-zero exit on danger findings
hub permissions disable --mode restore --project <n>           # dry-run preview
hub permissions disable --mode restore --project <n> --apply   # revert to backup, drop registry block
hub permissions disable --mode detach --global --apply         # leave rules in native files as user-authored
```

## Hooks

Define, attach, and inspect hooks.

```
hub hook list                             # every hook definition + attach scopes + capability reach
hub hook show <name>                      # one definition + resolved per-project settings + reach
hub hook doctor [--json]                  # read-only risk scan over every ATTACHED hook, deduped across scopes (--json always exits 0)
hub hook new <name> --event PostToolUse --command "..." [--tools Edit,Write] [--matcher <re>] [--timeout N] [--harnesses claude-code,codex]
hub hook edit <name> [--event|--command|--tools|--matcher|--timeout|--harnesses ...]  # user hooks only (built-in command/event read-only)
hub hook delete <name> --yes              # delete a user hook + detach from every scope
hub hook attach <name> {--global | --project <p>}    # attach at a scope
hub hook detach <name> {--global | --project <p>}    # detach from a scope
hub hook set-settings <name> {--global | --project <p>} --json '{...}'  # deep-merge settings (built-in globals read-only → use --project)
```

## Snippets

Reusable agent-doc instruction blocks.

```
hub snippet list                          # snippets + scan-derived usage (applied/modified/outdated/orphaned)
hub snippet list --no-usage               # names only — skips the project-tree scan (fast)
hub snippet show <name> --no-usage        # body + metadata only — skips the project-tree scan (fast)
hub snippet new <name> --tags a,b --body-file f   # create a reusable agent-doc instruction block
hub snippet rename <old> <new>            # rename + rewrite marker ids in every applied block
hub snippet apply <name> --project <p>    # append marker-wrapped block to the canonical root (--file <rel> for others)
hub snippet update <name> --all           # propagate a library edit to every outdated block (skips modified)
hub snippet remove <name> --project <p>   # excise the block (--force when edited in-file)
hub snippet status --json                 # marker scan across registered projects (no tracking store)
```

## Remotes

Push skills and agent docs to a box over SSH.

```
hub remote list                           # configured remotes (table or --json)
hub remote keyscan <ssh-host>             # fetch live SHA256 host-key fingerprint (TOFU; pre-registration)
hub remote setup-key [<id>] [--ssh-host H] # one-time ssh-copy-id of our pubkey (id OR raw host)
hub remote add <id> --connector hermes --ssh-host H --host-key SHA256:… [--secret-ref REF] [--bundles a,b]
hub remote show <id>                      # config + resolved skills
hub remote diff <id>                      # dry-run plan: per-artifact drift (no writes)
hub remote sync <id> [--force]            # sync one remote now (--force ignores sync_enabled)
hub remote resolve <id> --artifact NAME --op push|pull|keep-local|keep-remote [--kind skill|mcp|agent_doc]
hub remote equip <id> --kind bundle|skill --name <n> --state on|off  # registry-only equip toggle for a remote
hub remote import-skill [NAME] --remote <id> [--scan]  # adopt a box-native skill (origin: remote:<id>); auto-syncs
hub remote fetch-doc <id> --doc SOUL.md|MEMORY.md|USER.md   # fetch agent-doc (read-only)
hub remote push-doc <id> --doc … [--force] # push edited agent-doc (content on stdin; drift-checked)
hub remote enable|disable <id>            # toggle sync_enabled
hub remote remove <id>                    # unregister (drops registry entry + sidecars; box untouched)
hub remote clear <id>                     # forget ownership (clear sidecars only; box untouched)
hub remote health <id>                    # reachable / authenticated / host-key-match
hub remote doctor                         # risk scan (host-key mismatch=danger, unreachable, stale sidecars, unresolved drift)
```

## Cloud targets

Manual-upload ZIPs for claude.ai and ChatGPT web.

```
hub cloud targets                         # catalog + per-target equipped count + drift rollup
hub cloud equip <target> --kind bundle|skill --name <n> --state on|off  # registry-only equip toggle (no sync)
hub cloud status <target>                 # per skill: new|up_to_date|changed|missing (+ orphaned, + frontmatter lints)
hub cloud export <target> [--skill <n>] [--out DIR]  # build ZIPs, record fingerprints, prune orphans (exit 1 if any skill errored)
```

## Usage

The token and cost ledger.

```
hub usage record [--from-cache [PATH]] [--json]  # fold a ccusage scan cache into the durable usage ledger
hub usage history [--since D] [--until D] [--json]  # day-by-day ledger payload (provenance, costKnown, splitKnown, claude_stats)
hub usage import-claude-stats [--path P] [--dry-run] [--json]  # one-time tokens-only import of Claude Code's stats-cache.json
hub usage reprice [--dry-run] [--json]    # re-price ledger rows against ccusage-pricing.json (token counts never change)
hub usage scan-sessions [--json]          # scan Claude and Codex transcripts into local inspection evidence
hub usage inspect-index [--json]         # list captured inspection sessions
hub usage inspect <id> --harness <h> --view overview|tools|changes [--run <id>] [--after <cursor>] [--limit <n>] [--json]
hub usage inspect <id> --harness <h> --view body --body <body-id> [--after-chunk <n>] [--limit-chunks <n>] [--json]
hub usage pin add|remove <id> --harness <h> [--run <run-id>] [--json]
hub usage pin list [--after <cursor>] [--limit <n>] [--json]
```

Inspection commands read the private local SQLite evidence store. They do not
capture on read and never place the store in a backup snapshot.

## Dashboard

Launch the native app.

```
hub dashboard                             # launch Skill Tree native app
```

### Headless delivery policy and fleet actions

- `hub remote delivery show --json`: read the Sync preference and last fleet result.
- `hub remote delivery set --publish-on-sync true|false --json`: save whether explicit Sync includes headless publication.
- `hub remote delivery run --json`: publish and request delivery for enabled headless machines. Paused machines remain paused.

These commands preserve receiver approval and conflict checks. Saving the preference does not contact a receiver.
