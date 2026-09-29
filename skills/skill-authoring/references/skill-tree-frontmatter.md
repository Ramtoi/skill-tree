# Skill Tree frontmatter and registration

What the hub reads from a `SKILL.md`, what it mirrors into `registry.yaml`,
and how a skill gets registered and equipped. Frontmatter is the source of
truth for every field below; the registry copy is rewritten on each sync.

## The portable core

```yaml
---
name: my-skill              # = directory name = registry key; ^[a-z0-9-]+$
description: |              # at or under 200 characters; what + when + phrases
  ...
license: MIT                # optional, spec field
compatibility: ...          # optional, spec field: environment requirements only
metadata:                   # optional, string -> string; namespace your keys
  skill-tree/version: "1.2.0"
---
```

These fields travel to every harness (Claude Code, Codex, opencode, pi).
Everything below is hub- or Claude-specific.

## Scope: where the skill reaches

Scope is a registry field (`hub set-meta <name> --scope <s>`), not frontmatter.

| Scope | Reach | Written to |
|---|---|---|
| `global` | every project, always on | the harness's user-level skills dir |
| `portable` | projects where it is equipped; reusable | `<project>/.claude/skills/<name>` and `<project>/.agents/skills/<name>` |
| `project-specific` | same mechanism as portable; label for one-project skills | same |

Default for a new skill: `portable`. Make a skill `global` only when it must
be present in every session; it then costs its description in every context.

## Invocation: who may trigger it

Two Claude-family frontmatter flags; Codex and opencode ignore both.

| Mode | Frontmatter | `/name` by the user | model auto-trigger | description in context |
|---|---|---|---|---|
| `auto` (default) | none | yes | yes | always |
| `user-only` | `disable-model-invocation: true` | yes | no | no; loads on invoke only |
| `model-only` | `user-invocable: false` | no | yes | always |

Set it with `hub set-meta <name> --invocation user-only` or the editor's
Triggering control. Both flags at once is a contradiction the hub reports as
`conflicted`. Per-project override: `hub project invocation <p> --skill
<name> --mode <m>`, for `portable` and `project-specific` skills only.

Pick `user-only` for a workflow someone starts deliberately (a release
ritual, a migration). Pick `auto` when the model should notice the situation.

## Harness affinity

```yaml
harnesses: [claude-code, codex]   # optional; absent = every effective harness
```

Narrows which harnesses receive the skill on sync. Valid ids: `claude-code`,
`codex`, `pi`, `opencode`. Use it when the body depends on tools only one
harness has.

## `ships_with`: companions provisioned with the skill

```yaml
ships_with:
  agents: [my-worker]                 # <skill>/agents/my-worker.md
  hooks:
    - name: my-guard
      event: PreToolUse
      tools: [Edit, Write]
      command: scripts/guard.sh       # relative to the skill dir, no `..`
      activation: while-running       # display-only
    - ref: lsp-report                 # or a hooks-library entry by name
  permissions:
    deny: ["Bash(git push --force:*)"]
    ask: ["Bash(gh pr merge:*)"]
```

One malformed field drops the whole block with one sync warning. A companion
agent file uses `tier: deep | planner | worker` instead of a model name. The
user consents at equip time (`hub enable <name> --project <p>
--with-companions`); the hub never provisions companions silently. Use this
only when the workflow cannot work without the companion.

## Description ceilings

| Limit | Who enforces it | Effect when exceeded |
|---|---|---|
| 200 | the hub and claude.ai upload | hub lint warning; claude.ai rejects the upload |
| 250 | Claude Code | truncated when deciding whether to trigger |
| 1024 | Agent Skills spec, Codex | Codex refuses to load the skill |

Codex also caps all discovery metadata at 8000 characters or 2% of the
context window, so every long description crowds the others out.

## Cross-references between skills

A body mention counts as a reference only as a backtick span (`` `other` ``)
or a slash token (`/other`). The hub builds a graph from these and reports
`missing_refs` when a project has the referring skill but not the referenced
one. `hub enable <name> --project <p> --with-refs` equips one level of
references. Mute a false positive with `hub set-meta <name> --refs-ignore a,b`.

## Files inside the skill

```
my-skill/
  SKILL.md            required
  references/*.md     loaded on demand; say when in SKILL.md
  scripts/*           executable; handle errors inside
  assets/*            templates and files used in output
  agents/*.md         companion sub-agents named in ships_with
```

Keep links relative and one level deep. The hub's export, cloud ZIP, and
remote push walk the directory without following symlinks out of it.

## Registration and equip

| Situation | Command |
|---|---|
| new skill in the library | `hub new skill <name> [--scope s] [--description d]` or MCP `skill_create` |
| a skill written inside a project's `.claude/skills/` | `hub project import-skill <name> --project <p>` |
| a `.skillpack` file | `hub skill import <file>` |
| a skill in a Git repo | `hub source add git <url>` |
| equip on a project | `hub enable <name> --project <p>` |
| make it on everywhere | `hub set-meta <name> --scope global` |
| read metadata back | `hub list`, `hub skill refs <name> --json` |

Every registry write auto-syncs. A built-in (Starter Pack) skill is read-only;
`hub source duplicate <name> --as <new>` copies it into the library for
editing.

## Snippets are not skills

A snippet is a reusable block placed into a project's agent doc
(`AGENTS.md`/`CLAUDE.md`) and read on every turn. Use one for a rule that must
always apply in a project; use a skill for a workflow loaded on demand.
`hub snippet new <name> --body-file f`, then `hub snippet apply`.
