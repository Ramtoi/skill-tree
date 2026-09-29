# Sub-Agents (Claude Code + Codex)

Skill Tree manages sub-agents **in place** — it reads and writes the actual definition files each
harness loads, never a copy in the hub registry. Sub-agents are **harness-specific
configuration**: an installed + enabled harness exposes its own configuration surface at
`/harness/:id`. Two harnesses support agent definitions today — **Claude Code**
([docs](https://code.claude.com/docs/en/sub-agents)) and **Codex CLI**
([docs](https://developers.openai.com/codex/subagents)); the surface is gated on the harness
registry's `agents_dir` capability, not on hardcoded ids. Topics routed here: *sub-agent*,
*subagent*, *agent definition*, *codex agent*, *linked twin*, *drift*, *attach skill to agent*,
*provision skill*, *disable agent*, *harness config*.

## What a sub-agent is, per harness

| | Claude Code | Codex |
|---|---|---|
| File | Markdown + YAML frontmatter | TOML (one agent per file) |
| User scope | `~/.claude/agents/*.md` | `$CODEX_HOME/agents/*.toml` (default `~/.codex/agents`) |
| Project scope | `<project>/.claude/agents/` | **Not yet** — trust-gated, ships in a later wave |
| Identity | `name:` field (lowercase+hyphens) | `name` field (lowercase+hyphens+underscores) |
| System prompt | the markdown body | `developer_instructions` |
| Required | `name`, `description` | `name`, `description`, `developer_instructions` |
| Capability scoping | `tools`/`disallowedTools` allowlist/denylist | `sandbox_mode` (read-only / workspace-write / danger-full-access) — **no per-tool rules** |
| Other guided fields | `model`, `skills`, `color` | `model` (free-form id), `model_reasoning_effort`, `skills.config`, `nickname_candidates` |
| Advanced escape hatch | raw YAML panel | raw TOML panel (`advanced_format` in the contract) |
| Built-ins (read-only) | general-purpose, Explore, Plan (deny-disableable) | default, worker, explorer (not disableable — no file) |
| Disable | `Agent(<name>)` in scope `settings.json` `permissions.deny` | hub renames `x.toml` ⇄ `x.toml.disabled` (suffix is the sole state) |

Codex `skills.config` references skills by **absolute path** under the codex discovery root
(`~/.agents/skills/<name>/SKILL.md` — the dir `hub sync` already populates). Live-verified
constraint: a path outside the discovery root is silently inert, which is exactly why
provisioning (below) targets that root. Hand-authored entries with foreign paths or
`enabled = false` are preserved verbatim and shown read-only ("Other skill entries").

## Linked twins (one logical agent across both harnesses)

An agent that exists under the same `name` in both harnesses can be **linked**: the shared core
(description, system prompt, attached skills) is co-written to both native files on every save,
translated to each format. Everything else — model (different id namespaces), Claude tool rules /
color, Codex sandbox / reasoning effort / nicknames — stays **per-harness**, shown in clearly
badged harness-only sections.

- **Linking is explicit, recorded state** — a membership-only sidecar at
  `~/.skill-hub/state/subagents/links.json` (never content; the native files stay the sole
  storage). A same-name unlinked pair is only *suggested* ("Link?" chip), never auto-linked.
- **Copy to <harness>** projects the shared core into a new file in the other harness (model
  resets to inherit, overlay empty) and links the pair.
- **Drift**: if the two files' shared cores diverge (e.g. one was hand-edited), the editor shows a
  banner with **both values per field** and a keep-Claude/keep-Codex choice; drifted fields are
  locked in the form until resolved — never auto-clobbered. Saving unrelated fields still works
  and leaves the drifted field frozen on both sides.
- **Twin lost**: sidecar-linked but the twin file was hand-deleted/renamed → surfaced as a
  warning chip, not silently degraded. **Unlink** stops co-writing, keeps both files, and is
  durable (the pair won't re-link by name). Deleting a linked agent asks one-file-or-both;
  the one-file delete auto-unlinks.

## Attaching skills + provisioning (never a dangling reference)

Attaching is validated at the point of choice (unresolvable flagged;
`disable-model-invocation: true` skills blocked with the reason), and — new — **guaranteed to
resolve**: attaching a registry skill that isn't yet available to the agent's harness+scope
triggers the two-phase provisioning flow instead of writing a dead reference:

1. Save is blocked with a `needs_provisioning` detail per skill.
2. A consequence panel explains the scope change ("Makes the skill global — installed into every
   harness's user-level skill directory…"). On confirm, the hub provisions (project-scope agent →
   enable on the project + targeted resync; user-scope agent → flip the skill to `scope: global`
   + re-run only the global-skills pass — never a full `hub sync`) and re-saves automatically.
3. **Guards**: skills imported from a remote (`origin: remote:<id>`) are hard-refused (quarantine
   preserved); a skill whose harness affinity excludes the agent's harness gets a second, distinct
   "widen affinity" confirm.

One global provisioning covers every installed harness at once (Claude `~/.claude/skills` *and*
Codex `~/.agents/skills`). The relationship stays bidirectional: a skill's page shows "Preloaded
by N sub-agents" with harness badges, and "Attach to sub-agent…" offers agents from every
agent-capable harness.

## Skill-shipped companion agents (`ships_with`)

A skill can declare, in its own `SKILL.md` frontmatter, agents (plus hooks and permission
rules — see `docs/HOOKS.md` and `docs/permissions.md`) that it wants alongside it. `ships_with.py`
owns the schema, the plan builder, and the per-harness agent renderer; `hub_cli/skill.py` owns the
transaction. Topics routed here (sub-agent side only): *ships with*, *companion agent*, *shipped
agent*, *skill provisions agent*.

```yaml
ships_with:
  agents: [orch-implementer, orch-reviewer]   # <skill>/agents/<name>.md
```

Each `<skill>/agents/<name>.md` contains the shared agent definition. Its body becomes the system prompt for both harnesses. The source also contains `name`, `description`, and optional Claude `tools`.

The `tier` field selects defaults from `ships_with.TIER_MODELS`. Existing values are `deep`, `planner`, and `worker`. An optional `harnesses` mapping overrides the model for each harness:

```yaml
tier: worker
harnesses:
  claude-code:
    model: sonnet
  codex:
    model: gpt-5.6-luna
    model_reasoning_effort: high
```

An omitted field uses its tier default. An empty string selects session inheritance and suppresses that default. Custom model IDs remain valid.

In a skill's **Ships with** section, an agent opens the shared source editor. The editor shows separate Claude Code and Codex model controls. It also shows Codex reasoning effort. You can edit the source before provisioning the agent.

Save updates the source and refreshes clean copies that Skill Tree already owns. It preserves unrelated source fields and refuses concurrent source changes. Drifted native copies remain unchanged and require explicit resolution. Save does not provision the agent onto missing targets. Standalone agents retain their existing harness editor.

- **Registered exactly like any other user-scope agent** — same files
  (`~/.claude/agents/*.md`, `$CODEX_HOME/agents/*.toml`), same **linked-twin** sidecar
  (`~/.skill-hub/state/subagents/links.json`) when 2+ agent-capable harnesses are effective for the
  project. On a one-agent-capable-harness machine (e.g. only Claude Code installed) the plan
  reports `"linked": false` and no sidecar entry is written — there is nothing to link.
- **Ownership is per-project, in `projects.<n>.companions.<skill>.agents`** (the same ledger that
  tracks the skill's shipped hooks and permission rules — see the other two docs for those). Two
  different projects can equip the same `ships_with` skill and both end up listing the same shared
  agent name in their own ledger; `hub disable` only deletes the actual user-scope file when
  **no other project's ledger** still names it (`ships_with.agent_refcount`, refcounted excluding
  the project being disabled) — otherwise the agent is kept and reported `kept_shared`.
- **A name collision that no ledger claims is a hard refuse, not a silent overwrite.** If an agent
  file already exists under the declared name and neither this project's ledger nor any other
  project's ledger for the same skill claims it, `hub enable --with-companions` refuses the whole
  transaction (exit 1, nothing written) rather than clobbering a file it doesn't own.
- **Transactional, all-or-nothing.** Agent files are the one filesystem write this flow makes
  directly (hooks and permission rules are registry mutations picked up by the next sync). A
  failure partway through a multi-agent, multi-harness apply deletes every file already written in
  that same call and unlinks any twin it had just linked — the ledger entry is set only once
  everything succeeded.

CLI (see `docs/HOOKS.md` for the hook side and `docs/permissions.md` for the rule side — the
same three verbs cover all three companion kinds at once):

```
hub enable <skill> --project <p> [--with-companions | --skill-only] [--json]
hub disable <skill> --project <p> [--keep-companions] [--json]
hub skill companions <skill> [--project <p>] --json
```

With neither flag, `hub enable` on a `ships_with` skill equips it and exits **2** with a
`needs_provisioning` JSON payload (skill/project/`items`, one row per agent×harness plus every
hook/permission/trust row — see `docs/permissions.md` §Skill-shipped permission rules for the full
item shape) printed as the compact, single, FIRST stdout line — a machine contract the MCP `equip`
tool and the app's consequence dialog both parse. `--with-companions` runs the whole transaction
above in one command; `--skill-only` equips and exits 0 without touching a single agent file.
`hub skill companions` is read-only status: the declared block plus the same per-item plan, each
item additionally carrying `"provisioned": true|false` once a `--project` is given. A `scope:
global` skill with no `--project` runs `--with-companions` against the REAL global ledger
(`companions_global`, `hooks_global`, `permissions_global`) instead of the project-less
present/absent read a portable skill gets — no Codex trust row there (nothing to trust). A
`--with-companions` confirmation on a skill that is already active **only** via a bundle provisions
without appending it to the project's `enabled` list, so a later `hub bundle remove` still removes
it cleanly.

### Editing the declaration in place — `companions set`/`add`/`remove`/`resolve`

A hook entry may be a full inline definition, as above, OR a **reference** into the hooks library —
`{ref: <name>}` — attaching an existing user or built-in hook definition as-is (the library owns its
event/command/harness-affinity; a missing reference surfaces as the doctor finding
`COMPANION_REF_MISSING` and the row reads `missing`, never a crash). One CLI verb owns every edit to
the declaration itself:

```
hub skill companions set <skill> {--json-stdin | --json-body <json>}
hub skill companions add <skill> --kind agent|hook|permission --item <name-or-pattern> [--rule-kind allow|deny|ask]
hub skill companions remove <skill> --kind agent|hook|permission --item <name-or-pattern> [--rule-kind allow|deny|ask]
hub skill companions resolve <skill> --agent <n> --op keep-mine|keep-skill [--project <p> | --global]
```

`set` replaces the WHOLE `agents`/`hooks`/`permissions` block in one transaction: it stages any
`agents[].from: {harness: <id>}` COPY (projecting an existing per-harness sub-agent definition onto
the harness-agnostic `tier: worker` shape) before validating — the file has to exist for the block
to normalize — rewrites the SKILL.md frontmatter (fail-closed: a rewrite that can't be verified
leaves the file byte-untouched and unwinds any staged copy), re-mirrors the registry, and runs ONE
reconcile pass (below) before printing `{"ok": true, "skill", "block", "reconcile", "kept_files"}` as
its first stdout line (or `{"ok": false, "error", "field"}`, exit 1, on any validation failure). A
removed agent's `<skill>/agents/<name>.md` is never deleted here — it stays on disk and is named in
`kept_files`. `add`/`remove` are thin read-splice-write aliases over the same transaction. A skill
whose `managed: external`/remote-quarantined status blocks provisioning also blocks `set` (same
wording as the invocation-override refusal).

An agent whose rendered file no longer matches what the ledger recorded is **drift** — reported,
never clobbered. `resolve --op keep-mine` re-records the CURRENT on-disk bytes as the new baseline;
`resolve --op keep-skill` deletes both rendered twins, re-renders fresh from the skill's own
`agents/<name>.md`, re-links, and re-records — backup-first, every written harness at once (never
through the linked-twin `save_linked` path, which refuses on drift and would co-write the surviving
twin — precisely the collision this verb exists to resolve).

### The sync-time reconcile pass (ledger schema 2)

Every `hub sync` (and the tail of `companions set`) reconciles each `(project, skill)` ledger — and
the `scope: global` skill's own `companions_global` ledger — against the CURRENT frontmatter
declaration:

- **declared − ledger = pending.** Never written by sync (the same two-phase consent as `hub
  enable`); surfaced as the section's status line and a `Provision` action.
- **ledger − declared = stale.** De-provisioned this run, backup-first — but ONLY for a hook/rule
  ledger schema 2 records this ledger itself `attached: true`/`added: true` for — a hook the USER
  also attached by hand, or a rule they added directly, is left alone (`kept`). A stale agent is
  deleted only when no OTHER project's ledger (nor the global ledger) still claims it.
- **A changed inline hook definition** is re-attached in place; a **`{ref}` hook needs no
  reconcile at all** — the hooks stream always reads the library live.
- **An outdated agent** (the skill's own `agents/<name>.md` changed, every rendered copy still
  matches its recorded hash) is re-rendered in place; a genuinely **drifted** one (a rendered copy
  no longer matches) is reported via `COMPANION_AGENT_DRIFT` and left untouched.

Ledger schema 2 adds `hook_state.<name>.{origin, attached, def_sha256}`, `agent_state.<name>.
{origin, source_sha256, files: {<harness>: {sha256, written}}}`, and a top-level `permissions[].
added` flag, alongside the existing v1 `hooks`/`agents`/`permissions`/`provisioned_at`/`trust`
keys. **A v1 entry (no `schema: 2` key yet) is backfilled on its first v2 sync**: `attached`/
`added`/`written` all default to `true` (wave 1's pre-check refused any collision a ledger didn't
already claim, so every v1-ledgered item really is hub's) and the hashes are taken from whatever is
on disk RIGHT NOW — which means an edit made between a wave-1 provision and the first v2 sync is
silently adopted as the new baseline rather than reported as drift. Reported (never fatal) via
`--skip-hooks`/`--skip-permissions`: the reconcile still PLANS and reports pending/drift/
missing-refs, but applies no ops at all (`skipped: "hooks"` / `"permissions"` on that scope's
record). The per-scope record — `pending`, `stale_removed`, `reattached`, `drift`, `missing_refs`,
`backfilled`, `kept`, `errors`, `skipped` — lands in `state/sync-report.json` under
`projects.<p>.companions` / `global.companions` on every sync, present (lists possibly empty) even
for a project the run never otherwise touched.

Doctor codes (both `warning`, non-blocking): `COMPANION_REF_MISSING` (a `{ref}` hook's library
definition disappeared) and `COMPANION_AGENT_DRIFT` (a rendered agent copy no longer matches its
recorded hash).

## The three lifecycle dimensions

- **Fresh Skill Tree install, harness already configured** — in-place management: existing agents
  (Claude *and* `~/.codex/agents`) appear immediately, no import.
- **Adding a harness after Skill Tree** — the Configure affordance is capability-gated on
  installed + enabled; it appears when the harness does.
- **Working live** — edits write the real files. Claude Code loads agents at session start
  (restart hint near Save); Codex picks up agent files on the next session. The Codex pipeline is
  additionally proven by a live gate: `RUN_LIVE_CODEX=1 pytest tests/test_subagents_live_codex.py`
  authors an agent through the hub, has real `codex exec` spawn it, and asserts the attached
  skill loaded through the discovery root.

## Editing safely (can't-misconfigure design)

The guided form prevents the footguns; the raw escape hatch keeps power reachable. Validation
blocks a save (file untouched) on: invalid name (per-harness slug rule) or within-scope collision
(codex collisions include disabled files), missing description / system prompt, invalid `model`
or `color` (Claude), invalid `sandbox_mode` (Codex), a preload of a `disable-model-invocation`
skill, unparseable Advanced YAML/TOML, and newly-attached unresolved registry skills (which route
to provisioning). Warnings (non-blocking): unknown tool tokens / reasoning efforts, unresolved
pre-existing skills, `permissionMode: bypassPermissions`. Unknown/advanced fields are **always
preserved** across a save in both formats (tomlkit round-trip keeps comments).

### Tool access (Claude) / Capability (Codex)

Claude keeps the All / Read-only / Custom control (+ "can use other skills on demand" toggling the
`Skill` tool; denylist agents round-trip via Advanced). Codex has no per-tool rules — capability
is the `sandbox_mode` radio (inherit / read-only / workspace-write / danger-full-access, the last
styled as the loud danger option).

## Disable vs delete

- **Disable** is reversible and zero-friction. Claude: merge-preserving, backup-first
  `Agent(<name>)` deny entry (not hub-managed; `hub sync` leaves it intact; works for built-ins).
  Codex: the hub renames the file out of the `*.toml` glob — disabled agents stay listed and
  editable; the disabled state survives edits and renames; codex built-ins can't be disabled (no
  file).
- **Delete** removes the definition file (after a backup); Claude also strips the deny entry.
  Danger zone + confirm; linked agents get the one-or-both choice.

## CLI

All subcommands emit JSON; `--harness claude-code|codex` defaults to claude-code.

```
hub subagent list [--harness H] --scope user|project [--project NAME]
hub subagent show [--harness H] --scope … --name NAME
hub subagent save                       # JSON on stdin; `harness` rides in the payload
hub subagent delete [--harness H] --name NAME [--link-action this|both]
hub subagent set-disabled [--harness H] --name NAME --disabled true|false
hub subagent skill-usage                # reverse index; entries carry `harness`
hub subagent attachable-skills [--harness H] --scope …
hub subagent link --name X [--copy-from H]     # link twins (optionally project the core)
hub subagent unlink --name X
hub subagent link-status
hub subagent resolve-drift --name X            # decisions on stdin: {"decisions":{"field":"codex"}}
hub subagent provision-skill --skill S (--global | --project P) [--harness H] [--widen-affinity]
```

Contract notes: results carry `harness`; `show` carries `advanced_format` (`yaml`|`toml`),
`foreign_skill_entries`, `link`, `drift`; a linked save reports `cowrote_twin`/`twin_harness`;
provisioning errors carry `needs_provisioning {skill, scope_fix, consequence}`. Backups land under
`~/.skill-hub/_hub-backups/subagents/`. The hub never mirrors agent content into `registry.yaml`
— the link sidecar records membership only.
