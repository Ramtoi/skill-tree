# Skill Cross-References

A skill can name another skill in its SKILL.md body. Hub finds these mentions
and treats them as references: the app links them, `hub skill refs` lists
them, and a project that misses a referenced skill gets a note in the sync
report.

## The rule

A reference is a mention of a registered skill name, in one of two forms:

- A backtick span whose content is exactly the name: `` `deliver-it` ``.
- A slash token: `/deliver-it`.

A plain name in prose, with no backticks and no slash, is not a reference.

Hub reads only the body of SKILL.md. It does not read the frontmatter. It
does read a fenced code block — a code block that quotes `/deliver-it` still
counts as a reference.

A slash that looks like a path is not a reference. These forms stay plain
text: `references/plan.md`, `/plan.md`, `/name/`, `./plan`, `../plan`,
`~/plan`, and a markdown link target such as `[x](/plan)`. Names are
lowercase and must match exactly; `/Deliver-It` does not match `deliver-it`.

This feature never writes a SKILL.md file.

In the app, the editor decorates every reference it finds, in Edit and
Preview. Preview does not link a reference inside a fenced code block or
inside a multi-word inline code span, because that text is code, not prose.

## Renaming a referenced skill

When you rename a skill, other files can still name the old skill. Hub can
rewrite those mentions for you.

```
hub rename <old> <new> --rewrite-refs
```

This rewrites every mention in the markdown files of the other skills in your
library, and in the snippet library. It keeps the form of each mention: a
backtick mention stays a backtick mention, and a slash mention stays a slash
mention.

Plain `hub rename <old> <new>` renames the skill and rewrites nothing.

Hub does not rewrite a skill that comes from an external source. Those files
belong to another repository. Hub reports them as skipped. Starter skills are
skipped in the same way as source-managed skills. Hub also skips a file with a
broken frontmatter fence. If a file changes between the scan and the write,
Hub scans it again before writing.

Add `--rewrite-agent-docs` to also rewrite the `AGENTS.md` and `CLAUDE.md`
files in your registered projects. This flag needs `--rewrite-refs`. Hub
copies each file to `~/.skill-hub/_hub-backups/rename/` before it writes. Hub
skips a project with an unresolved path.

Hub does not rewrite text inside a snippet block in an agent doc. That text
belongs to the snippet. Hub rewrites the snippet in the library instead. The
applied copies then read outdated. Run `hub snippet update <name> --all` to
send the new text to every outdated block. A block that you edited by hand is
skipped.

Add `--dry-run --json` to see the plan before you change anything. Add
`--json` to get the result.

Hub renames the skill first. If a file cannot be written, the rename stays
done. The other files were still rewritten. The file that failed is listed in
`errors` and the command exits with code 2.

In the app, a rename from the skill editor asks first. The dialog lists every
file that names the skill. Agent docs are off by default.

## Where references appear

The app shows references in five editors: the skill editor, a harness's
global instructions, a project's agent docs, a snippet, and a sub-agent.

In Edit mode, each editor decorates every reference it finds. Hover over a
reference to see the target skill's name and description. Hold ⌘ (or Ctrl)
and click the reference to open the target skill.

In Preview mode, each reference is a link. Click the link to open the
target skill.

Every editor also shows a References list. The skill editor, the harness
doc editor, the snippet editor, and the sub-agent editor show this list in
a side panel. A project's agent docs show it in a strip instead, above the
applied-snippets strip. That screen has no side panel.

Click a row in the list, a Preview link, or ⌘-click a reference. Each of
these opens the target skill and adds a back arrow there. The arrow's label
names the screen you came from, for example "Back to moon-base". Click the
arrow to return.

The back arrow also restores what you were doing. A project's agent docs
restores the file you had open. A snippet's create form restores the name,
description, tags, and body you had typed.

Type `/` then a letter to open a list of matching skills. At one or two
letters, the list shows only names that start with your text. At three or
more letters, the list also shows names and descriptions that contain your
text anywhere. Use the up and down arrow keys to move through the list.
Press Enter or Tab to insert the selected skill. Press Esc to close the
list and keep your typed text unchanged. The list shows at most eight
skills. Completion never opens inside frontmatter. It never opens for a
`/` that looks like a path, such as `references/plan.md`.

A few known limits. A body that opens with a horizontal rule hides
references until the next rule. A SKILL.md never hits this limit, because
its frontmatter already opens with one. A snippet body can hit it, because
it is free markdown. The back arrow is the only way home — a browser back
button or a trackpad swipe does not restore the file or the draft. A
project-scoped sub-agent's back arrow returns to the sub-agent list, not to
the agent; only a user-scoped sub-agent's back arrow reopens the agent.
MENTIONED BY is skills-only — a snippet or an agent doc that mentions a
skill never appears on that skill's MENTIONED BY list.

## The CLI

`hub skill refs [--json]` prints the whole reference graph. Table output is
one line per edge. Add `--json` for:

```json
{"edges": [{"from": "<skill>", "to": "<skill>", "count": <int>}]}
```

`hub skill refs <name> [--json]` prints one skill's three lists — what it
mentions, who mentions it, and what it ignores:

```
orchestrate

  MENTIONS
    deliver-it                3×
    proof-it                  1×

  MENTIONED BY
    grill                     1×

  IGNORED
    unslop
```

An empty section prints `(none)`. Add `--json` for:

```json
{"skill": "<name>", "refs": [{"name": "<skill>", "count": <int>}], "referenced_by": [{"name": "<skill>", "count": <int>}], "ignored": ["<skill>", ...]}
```

An unknown skill name exits with code 1 and prints nothing on stdout.

## The sync-report field

Each project record in the sync report carries `missing_refs`. Each entry has
this shape:

```json
{"skill": "<referring-skill>", "refs": ["<missing-skill>", ...]}
```

Hub reports a missing reference when the target skill is registered, the
project does not have it active, and its scope is not `global`.

A `scope: global` skill is active on every project. So a missing reference in
a global skill's body appears on every project. Clear it once: equip the
missing skill, or run `hub set-meta <global-skill> --refs-ignore <name>`.

A missing reference never fails a sync. A project that has never synced shows
no `missing_refs` entries at all.

## The equip guardrail

When you run `hub enable <skill> --project <p>` and the skill references a
skill the project does not have, hub prints a hint after it writes the
registry:

```
  ! rt-android-expert references needs-global — not equipped on moon-base.
    Run: hub enable rt-android-expert --project moon-base --with-refs
```

Add `--with-refs` to equip the missing references in the same command. This
goes one level only — a reference of a reference stays unequipped.
`--with-refs` also works when the skill is already enabled: hub still adds
the missing references.

`hub bundle apply` prints one such hint line per flagged skill in the bundle.

In the app, an equip shows an info toast when the equipped skill references
a skill the project does not have. The toast title names the skill and its
missing references. It lists the names in alphabetical order, with at most
three names, then `+N more`. The toast body reads `Not equipped on
<project>.` The action button reads `Equip N`. It runs one `hub enable
--with-refs` for each flagged skill, then shows a result toast.

The toast fires only when you equip a skill, never when you unequip one. A
bundle apply that flags several skills shows one toast, named after the
bundle.

The project screen shows the same finding two ways. Each equipped skill
card that references a missing skill gets a badge. A banner above the card
grid names the missing references before you click. Its button reads
`Equip all N`, or `Equip these N` when the list is long.

The project navigator names any project with a missing reference:
`<project> misses a ref`, or `N projects miss a ref` for more than one.

All three surfaces — the toast, the badge and banner, and the navigator
line — read the last sync report. A project that has never synced shows
none of them.

## `refs_ignore`

Some mentions are not references — a skill named in passing, not as a
dependency. Mute one with:

```
hub set-meta <name> --refs-ignore a,b
```

This writes `skills.<name>.refs_ignore` in the registry. An empty string
clears it: `hub set-meta <name> --refs-ignore ""`.

`refs_ignore` is CLI-only in this wave. The app does not yet expose it for
editing.
