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
