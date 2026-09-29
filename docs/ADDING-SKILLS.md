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

### Register a server you already have

If you already run an MCP server — one you use with Claude Desktop, or one
someone gave you a `claude mcp add-json` command for — register it with one
command. You do not need to scaffold anything.

By flags:

```bash
hub mcp add context7 --transport http --url https://mcp.context7.com/mcp \
  --header "Authorization: Bearer \${CONTEXT7_TOKEN}"
```

By pasting the server's JSON on stdin:

```bash
echo '{"command": "npx", "args": ["-y", "some-mcp-server"]}' \
  | hub mcp add my-tool --json-stdin
```

Use a `${VAR}` reference for any credential, never the credential itself.
`hub mcp add` reads the value from your environment when it delivers the
server. If a header or environment value looks like a real secret, `hub mcp
add` refuses and shows the `${VAR}` form to use instead; pass
`--allow-literal` only when you understand that a literal secret is excluded
from backups but still lands in every native config file hub writes for
that server.

`hub mcp add` creates a `mcp-servers/<name>/SKILL.md` describing the server,
registers it in `registry.yaml`, and (with `--project`) equips it right
away. This is a different job from the two below: `hub new mcp` scaffolds a
brand-new Python server, and `hub mcp-control` manages Skill Tree's own
control-plane server.

Fresh setup registers the `skill-tree` MCP server and equips the bundled
`skt-mcp` companion skill globally. The server uses the interpreter running
Skill Tree, including bundled Python in the desktop app. Restore previews
include this setup before apply. Custom registrations remain unchanged.

Use `hub mcp-control install` to request setup explicitly. Use
`hub mcp-control uninstall` to remove the managed server and record an opt-out.
Later setup respects that choice. A normal sync does not recreate the server.

### Adopt servers you already configured natively

If you have already run `claude mcp add`, hand-edited `.mcp.json`, or added
a server to Codex or opencode, hub can find those servers and bring them
under its management. Use `hub mcp reconcile`.

Step 1: preview what hub found.

```bash
hub mcp reconcile --project my-app
```

This prints one line per server. Each server gets a status:

- `new` — hub can register this server. The same server, found in more than
  one place with the same settings, still counts as one `new` server.
- `conflict` — the same server name has two different definitions (in two
  harnesses, or one in a harness and one already in the registry). You must
  say which one to keep.
- `already_managed` — hub already owns this server. It is listed for
  visibility only and accepts no decision — there is nothing to import,
  keep, or remove.
- `unsupported` — hub cannot register this server (see the reasons below).
- `stale` — the server is in the registry but not active here, and the
  native file still has an old copy. Use `remove` to delete the leftover
  entry, or `keep` to leave it alone.

A server counts as `unsupported` for one of these reasons:

- `ws_transport` — a WebSocket server. Only Claude Code can talk to one.
- `oauth_block` — the server needs an OAuth login. Hub cannot complete an
  OAuth flow on its own.
- `headers_helper` — the server gets its headers from a helper script, not
  from plain text. Hub cannot read a script's output.
- `unknown_shape` — the entry does not look like a server hub understands
  (for example, a plain string or a list instead of an object).
- `local_scope_unregistered_project` — Claude Code's local scope (the
  default for `claude mcp add`) names a project path hub does not know.
  Register that project first.
- `no_global_target` — hub has no way to write a user-wide MCP server for
  opencode or Pi. The server is shown so you know it exists, but it cannot
  be imported at this scope.

A `literal_secret:<key>` warning means a header or environment value looks
like a real password or token. The key name is shown; the value never is.

Step 2: decide, per server, and apply.

```bash
echo '{"decisions": [
  {"name": "context7", "action": "import"},
  {"name": "old-tool", "action": "keep"}
]}' | hub mcp reconcile --project my-app --apply --decisions-stdin
```

Decision actions:

- `import` — register the server and equip it here. A `conflict` needs a
  `harness` field naming which definition to use (`"claude-code"`,
  `"codex"`, `"opencode"`, or `"registry"` to keep the registry's own
  definition and just take ownership of the file entry). When the SAME
  harness shows up twice (Claude Code's local scope and its project scope
  can both hold a definition), also pass `scope` to say which one you mean.
  A server carrying a `literal_secret:<key>` warning is refused unless you
  also pass `"replace_with_ref": true` (hub rewrites the value to a `${VAR}`
  reference and tells you the variable name, in the response's
  `suggested_refs` list) or `"allow_literal": true` (hub imports the real
  value as-is).
- `keep` — stop asking about this server. It will not show up again until
  you `unkeep` it.
- `unkeep` — undo a `keep`.
- `skip` — do nothing. The server shows up again next time.
- `remove` — only valid on a `stale` server. Deletes the leftover native
  entry. Does not change the registry.

`hub mcp reconcile --apply` is all-or-nothing: if any decision is invalid,
or something fails partway through, nothing is written and nothing is
changed.

`keep` and `unkeep` are CLI-only. The app does not show a list of servers
you have parked with `keep` — use the command line to see or change that
list.

A server's native name does not have to already be a hub-legal name.
`hub mcp add` and `hub mcp reconcile` both turn a name like `Sanity` into
`sanity` on import (lowercase, hyphens, no other characters) — the CLI
warns `renamed_from:Sanity` when this happens. A name that still cannot
become a legal skill name after that (empty, or made only of characters
hub cannot use) is refused with the reason `invalid_name`. A native entry
hub cannot understand at all — a bad transport, a `url` and a `command`
both set, a malformed header — is refused too, each with its own one-word
reason (`transport_conflict`, `malformed_field:args`, and so on); nothing
half-understood is ever written to `registry.yaml`. When a name is
renamed on import, the ORIGINAL native entry is deleted (with a backup)
so the same server never has two different keys at once. When it is not
renamed, adopting it at project scope claims any other copy already in a
file that harness's own adapter writes at this scope (so the next sync
keeps it in step), and removes a Claude Code **local**-scope copy
outright — no per-project adapter ever writes that file, so a leftover
copy there would keep shadowing every later hub edit.

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

- `TOOLS`: declare your tool name, description, and input JSON schema
- `ANNOTATIONS` / `OUTPUT_SCHEMA`: declare each tool's hints and its result shape
- `handle_tools_call`: implement your tool logic

The template uses the raw MCP stdio protocol (no external deps). The scaffolded server answers `initialize`, a sorted `tools/list` (with `annotations` and `outputSchema`), and `tools/call` (with text and `structuredContent`). For complex tools, you can use the `mcp` Python library:

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
      MY_API_KEY: "${MY_API_KEY}"  # a reference, resolved from the
                                    # environment at delivery time — never
                                    # write the credential itself here
```

### 4. Enable for a project

```bash
hub enable my-tool-name --project side-project
hub sync
```

`hub sync` writes to `<project>/.mcp.json`. Claude Code and Pi both read
this one file — hub does not write a separate `.pi/mcp.json` file. (If
`.pi/mcp.json` already exists, Pi reads that file instead, and hub's MCP
servers stay invisible to Pi until you remove it.)

A skill with `scope: global` is different: hub writes it to each installed
harness's user-level MCP config, not to a project file. Only Claude Code
and Codex have a user-level MCP file. Pi and opencode do not, so a
`scope: global` MCP server never reaches them — equip it on a project
instead.

---

## Built-in skills (the Starter Pack)

Skill Tree ships a few skills inside the app, under `code_home()/skills/`
(`skills/` in a source checkout). `hub sync` registers each of them once, as
a `managed: starter` entry with `scope: portable`: the skill shows in the
Library with the Starter Pack banner, its files are read-only, and it reaches
a session only after you equip it on a project (or widen its scope with
`hub set-meta <name> --scope global`).

Rules you will meet:

- **A local skill with the same name wins.** The built-in is skipped with a
  sync warning until you rename yours.
- **You cannot archive a built-in.** The next sync would register it again,
  so `hub archive` refuses and asks you to unequip instead.
- **Edits go through a copy.** `hub source duplicate <name> --as <new-name>`
  copies the skill into your library as a normal local skill.
- **An upgrade follows you.** When the app moves or a new version lands, the
  entry's `source` is re-pointed at the current copy on the next sync.

To ship a new built-in, add `skills/<name>/SKILL.md` to the repo with a
frontmatter `name` equal to the directory name; `tests/test_starter_pack_contents.py`
lints the pack and `scripts/smoke-test-bundle.sh` proves it is in the build.

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
# enables it on the project, then syncs in the same command — no manual
# `hub sync` needed. The symlink is in place when the command returns).
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

# GitHub deep links are parsed: the branch and the subdirectory come from the
# URL. Both /tree/ (a directory) and /blob/ (a file) links work, and a link to
# a SKILL.md file resolves to the skill directory that holds it.
hub source add git https://github.com/org/skills/tree/dev/packs/android
hub source add git https://github.com/org/skills/blob/dev/packs/android/foo/SKILL.md

# --path is repo-relative and wins over the subdirectory in the URL. There is
# no composition of the two: what you pass is what gets scanned.
hub source add git https://github.com/org/skills/tree/dev/packs --path packs/android

# Status / lifecycle
hub source list --json
hub source check  org-skills          # git fetch + compare refs
hub source sync   org-skills          # pull, rescan, update metadata
hub source remove org-skills --dry-run --json
hub source remove org-skills --mode unequip       # delete external skills + scrub bundles/projects
hub source remove org-skills --mode keep-local    # copy into data-home, mark as local, keep equips
hub source duplicate <skill-name> --as <name>-local   # external → local editable copy

# Manage
hub source edit    org-skills --name "Org Skills" # change the display name
hub source edit    org-skills --include a,b       # follow only these upstream skills
hub source edit    org-skills --include-all       # follow every upstream skill again
hub source disable org-skills         # keep the source, stop the sync of its skills
hub source enable  org-skills         # start the sync of its skills again
```

### Scan path errors

The scan starts at the repo root, or at the effective subdirectory (from
`--path`, or from the subdirectory in a deep URL). If that directory does not
exist in the checkout, the command fails instead of showing an empty preview:

```json
{
  "ok": false,
  "error": "path_not_found",
  "message": "path 'skills/foo' does not exist in the repository — did you mean 'packs/skills/foo'?",
  "scanned_path": "skills/foo",
  "hint_path": "packs/skills/foo"
}
```

`hint_path` is present only when the URL carried a subdirectory AND
`<url-subdirectory>/<--path>` exists in the checkout — the usual cause is a
`--path` typed relative to the URL instead of relative to the repo root. A plain
repo URL therefore gets the error without a suggestion. A path that resolves to
a file rather than a directory says `is not a directory` instead. A directory
that exists but holds no skills is a different result: `ok: true` with all
counts at zero.

Every preview and apply payload carries `scanned_path` — the effective
repo-relative directory the scan used, normalized (`""` for the repo root, so
`--path .` reads as the root; no leading `./`, no trailing `/`). A `--path`
ending in `SKILL.md` (any case) resolves to the directory that holds the file,
exactly like a `/blob/` URL.

### Choose which skills to import

By default every `NEW` candidate is imported. To import a subset, add
`selected_new` to the `--decisions-stdin` payload:

```bash
echo '{"decisions": {"grill": "skip"}, "selected_new": ["unslop", "review"]}' \
  | hub source add git https://github.com/org/skills --id org-skills \
      --decisions-stdin --json
```

`selected_new` is optional. When it is absent, every `NEW` candidate is
imported. When it is present, only the listed names are, and a name that is
not a discovered `NEW` candidate fails the command before anything is written.
Candidates you left out are reported in `skipped` with the reason
`NOT_SELECTED`.

#### When the `include` filter is written

`sources.<id>.include:` is written **only** when you send an explicit
`selected_new` that leaves out at least one discovered `NEW` candidate. Adding a
source without `selected_new` — the plain `hub source add git …` — never writes
the field, whatever the scan found. That is the point: only an explicit
deselection is a decision to exclude something forever.

When the field is written it holds the union of:

- the `NEW` names you selected,
- **every** conflicting upstream name, whatever you decided for it, and
- the upstream names this source already owns (`IMPORTED`).

`INVALID` names are never listed. They cannot be registered by any path, so
putting them in the filter would only make it lie about what you chose.

Conflicts are in the filter even when you skipped them, because a skipped
conflict means "not now", not "never": it must keep re-surfacing under
`new_pending` on later syncs so you can still decide. Only deselected `NEW`
skills are excluded for good.

`include` is a filter for the FUTURE: `hub source sync` classifies each upstream
candidate first, then registers only the ones that classify as `NEW` **and** are
named in the filter. The rest of the `NEW` ones are reported under `excluded` in
the `--json` payload (and as a line in the text output). `CONFLICT` and `INVALID`
candidates keep flowing to `new_pending` untouched and never appear in
`excluded`. Skills the source already owns are never affected, so setting the
filter never archives anything.

An empty `include: []` is a real filter, not an absent one: it means "no new
upstream skill follows this source". A malformed or absent `include` degrades to
no filter at all.

```bash
hub source edit org-skills --include unslop,review   # replace the filter
hub source edit org-skills --include-all             # clear it
```

Take everything at add time and no `include` field is written — the source
then follows the repository in full.

### Rename a source

A source has a fixed `id` and a display name. The `id` never changes, because
skills and cache directories refer to it. To change the display name, run
`hub source edit <id> --name "<new name>"`. The app and the CLI show the new
name. The `id` stays visible for commands.

### Disable a source

`hub source disable <id>` turns a source off without data loss. The skills of
the source stay in the registry, in bundles, and in project lists. The next
sync removes their symlinks from each project and their MCP entries. Projects
do not receive these skills while the source is off.

`hub source enable <id>` turns the source on again. The next sync writes the
symlinks back. Both commands run the sync automatically and report the
affected skills, bundles, and projects in their `--json` output.

Use `hub source remove` only to delete a source and its skills. Use `disable`
when you are not sure — it is fully reversible.

### Bundles from a source

The Sources screen can create a bundle that contains all skills of a source,
or add them to a bundle that exists. A new bundle can be a **linked bundle**
or a **snapshot**.

```bash
hub bundle new org-pack --skills skill-a,skill-b --source org-skills  # linked bundle
hub bundle new org-pack --skills skill-a,skill-b                      # snapshot
hub bundle update org-pack --source org-skills     # link a bundle that exists
# CAUTION: when you link a bundle that exists, skills that do not belong to
# the source leave the bundle at the next reconcile. Detach keeps the list.
# CAUTION: a linked bundle with scope `global` applies to every project. A
# source update then changes every project's loadout on the next sync.
hub bundle update org-pack --detach-source         # unlink; the skill list stays
```

**Linked bundle** — the bundle follows the source. Each `hub source sync`
updates the bundle: new skills from the source join it, and skills that the
source no longer has leave it. The skill order stays stable; new skills go to
the end. You cannot edit the skill list of a linked bundle by hand. To edit
it, detach the bundle first with `--detach-source`. The app shows a
"Follows &lt;source&gt;" tag on a linked bundle and offers Detach in the bundle
editor.

**Snapshot** — the bundle records the skills that the source has at that
moment. A skill that arrives later does not join the bundle. Add it with
`hub bundle update`.

Note: `hub source sync` now also registers new skills that appear in the
source repository (it did not before this feature). Skills whose names
collide with existing skills are reported and skipped, the same as at
`hub source add` time.

**Supported repo layouts** — discovery starts at the repository root, or at
the `--path` subdirectory when you give one. It walks the tree and records
each directory that has a valid `SKILL.md`, up to 4 levels below the start.
When a directory is a skill, the scan does not descend below it. Files inside
a skill belong to that skill. The start directory is the one exception. If it
is itself a skill, the scan records it and continues into its subdirectories.
As a result, a collection repo that also keeps a `SKILL.md` at its root
imports every skill.

```
repo/SKILL.md                            # One skill at the repo root
repo/<skill-name>/SKILL.md               # Skills as top-level folders
repo/skills/<skill-name>/SKILL.md        # Conventional skills/ folder
repo/skills/<category>/<name>/SKILL.md   # Category-nested skills
repo/SKILL.md + repo/<skill>/SKILL.md    # Root skill plus sibling skills (all import)
repo/path/to/<skill>/SKILL.md            # With --path path/to
```

Hidden directories (names that start with `.`) are not scanned. A `SKILL.md`
without valid frontmatter, or without a `name:` field, is ignored.

**Private repos** use your existing system Git auth: SSH keys, the macOS
keychain credential helper, or configured HTTPS credentials. Skill Tree
invokes `git` with `GIT_TERMINAL_PROMPT=0`, so misconfigured auth fails fast
instead of blocking on a TTY prompt. **Credentials are never stored in
`registry.yaml`.**

**Conflict handling** — if an external candidate shares a name with an
existing local skill, the import preview classifies it as `CONFLICT` and skips
it on apply (V1). Use `hub source duplicate` to convert an external skill to
local for editing.

### When upstream drops a skill

`hub source sync` can find that a skill it registered before is gone from the
repo. It does not delete the skill. It flags the registry entry with
`source_missing: true` instead. The skill stays in the registry exactly as
equipped before — a project that had it enabled still shows it enabled, a
bundle that carried it still carries it — but its files are gone from the
checkout, so the next `hub sync` cannot link it into any project. The skill
looks equipped and does nothing.

Check which skills are in this state:

```bash
hub source dropped --json              # every dropped-upstream skill, across all sources
hub source dropped org-skills --json   # only this source
hub source dropped --skill diagnose --json --content   # one skill, with its last-known SKILL.md body
```

Each entry says why the skill dropped:

- **Renamed** — hub follows the rename in the source's history, commit by
  commit, to wherever the skill ended up (a skill renamed twice still
  resolves to its final name), and is confident enough in the match to call
  it a rename (`successor`). The entry names the new path and, when the new
  skill is already registered, the name it was registered under
  (`successor.registered_as`).
- **Deleted** — the skill is gone with no confident rename in sight. Hub may
  still have found a weak, unconfirmed candidate (`possible_successor`) —
  worth a look, but not trusted enough to call a rename outright. The same
  applies when hub DID follow a rename but the trail ends in another
  deletion (the renamed copy was later removed too) or leads OUTSIDE the
  source's own scanned subdirectory: either way there is no live successor
  to point at, so it reads as "deleted".
- **Unknown** — the source checkout is missing, or hub could not read the
  needed git history. Hub never guesses here; it says "unknown" instead. A
  git clone is shallow (depth 1) and is never deepened, so a commit that
  fell off the far end of history can go unreachable even while the skill's
  registry entry still names it — "recoverable" turns `false` when that
  happens, and "Keep as local" below refuses cleanly instead of half-copying.

Three actions follow from this:

1. **Open the successor.** When the skill was renamed and the new one is
   already registered, go use that one instead. Nothing to run.
2. **Keep as local.** `hub source recover <name>` copies the skill's
   last-known content — pinned to the commit where it still existed, while
   that commit is still in the checkout (see "Unknown" above) — into
   `<data_home>/skills/<name>` and re-registers it as `managed: local`. It
   stops following the source. Edit it freely from here on.
3. **Forget it.** `hub archive <name>` removes the registry entry (there is
   no local copy to move for a dropped skill, so this is a pure registry
   edit). It is undoable: `hub unarchive <name>` puts it back — the entry,
   its place in every bundle, and every project's equip state — using an
   undo record hub writes to `<data_home>/state/archive/<name>.json` at
   archive time. `hub archive` also takes more than one name at once
   (`hub archive a b c`) for archiving several dropped skills in one pass;
   archiving a name a second time while its first undo record is still
   pending is refused — run `hub unarchive <name>` first.

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
- **portable bundle** — assign it to one or more projects, same as project-specific; `portable` and `project-specific` are intent labels with identical mechanics, only `global` behaves differently everywhere
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
hub bundle new <name> --skills s1,s2      Create a bundle (--scope global|portable|project-specific)
hub bundle apply <name> --project <p>     Assign a project-specific bundle
hub bundle update <name> --scope <scope>  Change bundle scope or metadata
hub bundle rename <old> <new>             Rename a bundle (references follow)
hub migrate <name>                        Move existing skill into hub
hub project add <name> <path>             Register a new project
hub dashboard                             Open Skill Tree native app
hub update                                Check for upstream updates
hub cleanup-backups                       Delete hub-created backup artifacts
```
