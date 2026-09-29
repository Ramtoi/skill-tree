# Agent Docs Snippets

Reusable markdown instruction blocks composed into project agent doc files
(`AGENTS.md` / `CLAUDE.md` / nested docs). Define an instruction once — a
validation procedure, documentation style rules, a review checklist — and
apply it to any registered project's docs; remove or update it later without
disturbing the rest of the file.

## Concept

- A **snippet** lives at `~/.skill-hub/snippets/<name>.md`: YAML frontmatter
  (`description`, `tags`, `version`, timestamps) + the markdown body that gets
  appended verbatim. The kebab-case name is the marker id embedded in every
  file the snippet is applied to — `hub snippet rename <old> <new>` renames the
  library file and rewrites that marker id everywhere it was applied.
- `version` is a monotonic integer bumped automatically whenever the body
  changes. It is display-only; the apply-time hash drives all status logic.
- Bodies may not contain lines starting with `<!-- skill-tree:snippet` (they
  would corrupt marker scanning in target files).

## Marker format (hub-owned — never hand-author)

Hub maintains all complete snippet blocks as one **trailing region** at the end
of the target file, separated from the user-authored document by one blank
line. Applying adds to that region; updating, removing, and saving a
snippet-bearing Agent Doc reconcile the whole region first.

```markdown
<!-- skill-tree:snippet id=validation-procedure v=2 sha=3f9ab2c41d07 -->
…snippet body verbatim…
<!-- skill-tree:snippet:end id=validation-procedure -->
```

`sha` is the first 12 hex chars of sha256 over the normalized library body
**at apply time** (CRLF→LF, trailing whitespace trimmed). That one field lets a
pure scan tell *modified* from *outdated*.

## Scan-based state — no tracking store

There is **no sidecar / no registry entry** recording applications. Every
status is derived by scanning registered projects' agent doc files for marker
pairs and comparing against the library — correct across `git pull`, clones,
and branch switches by construction.

| Status | Condition (per block) | Actions |
|---|---|---|
| `applied`  | in-file body hash == `sha` == current library hash | Remove |
| `modified` | in-file body hash ≠ `sha` (edited inside the markers; **wins over outdated**) | Update / Remove — both require `--force` / confirm (in-file edits are lost) |
| `outdated` | body matches `sha`, but the library body changed since | Update, Remove |
| `orphaned` | intact block whose id is not in the library (deleted snippet, or arrived via git) | Remove only |
| *damaged*  | an unpaired start/end marker line — a **file-level warning**, not a block status | none — clean up by hand in the editor |

## Drift & fallback semantics

- Removal locates the marker pair **by its lines**, never byte offsets —
  unrelated edits anywhere else in the file never break it. A clean
  apply→remove round-trips the file byte-identically.
- Damaged markers fail **closed**: auto-removal never touches the file; the
  editor is the fallback, and manual cleanup is self-sufficient (the next scan
  simply reflects the file).
- The same fail-closed rule applies to marker-looking inline text, nested or
  mismatched blocks, and duplicate snippet ids. Hub will report the document as
  blocked rather than guessing which text it owns.
- A scan reports placement as `canonical`, `misplaced`, or `blocked` for each
  discovered block. `misplaced` means a safe repair is available; `blocked`
  requires manual marker cleanup first.
- Editing a library snippet never silently changes any file. Propagation is
  explicit: `hub snippet update <name> --all` (or "Update everywhere" in the
  app) refreshes intact outdated blocks and **skips** modified ones.
- Targets are confined to **registered projects** (project + relative path,
  agent-doc basenames only). Applying to an absent known root (`AGENTS.md` /
  `CLAUDE.md`) creates it; a derived-pointer `CLAUDE.md` is rejected with a
  redirect to the canonical `AGENTS.md`. Mirror-bound roots (both real and
  byte-identical) are kept in sync after any mutation.
- Every apply/update/remove backs the target up first under
  `~/.skill-hub/_hub-backups/snippets/<project>/`.
- Renaming rewrites the marker id in every applied block (in-file `v=`/`sha=`
  are preserved exactly, so `applied`/`outdated`/`modified` status is
  unaffected). It is per-file error-isolated like every other snippet
  mutation: a file it cannot rewrite keeps the old id and reads as
  **orphaned** afterward, since the library no longer has a snippet under
  that name.

## CLI

```
hub snippet list [--tag t] [--query q] [--no-usage] [--json]  # library + scan-derived usage
hub snippet show <name> [--no-usage] [--json]                 # body + applied locations
hub snippet new <name> [--description d] [--tags a,b] [--body -|TEXT | --body-file f]
hub snippet edit <name> [...]                        # body change bumps version, reports outdated count
hub snippet rename <old> <new> [--json]              # rename + rewrite the marker id in every applied block
hub snippet delete <name> [--force]                  # refuses while applied; --force orphans blocks
hub snippet apply  <name> --project <p> [--file <rel>]   # default: canonical root
hub snippet update <name> (--project <p> [--file <rel>] | --all) [--force]
hub snippet remove <name> --project <p> [--file <rel>] [--force]
hub snippet status [--name n] [--project p] [--json] # scan report incl. damaged-marker warnings
hub snippet reconcile --project <p> [--file <rel>] [--apply] # preview by default; repair external/git drift with --apply
```

`list` scans every registered project's agent docs only once. It does not scan
once per snippet. It builds each snippet's usage summary from that one scan.

Add `--no-usage` to `list` or `show` to skip the scan. The command then
returns in well under a second, and the output has no `usage` key. Use
`hub snippet status --name <n>` to get the applied-location list on its own.
It runs the same single scan that `list` runs.

## App surfaces

- **Snippets screens** (`< >` rail icon, palette: "Open snippets"): `/snippets`
  is a landing route with no list of its own — it lands on the most recently
  visited snippet, or else the first one alphabetically, and shows a
  "No snippets yet" CTA only when the library is empty. `/snippet/:name` edits
  one snippet — the header name edits in place (`hub snippet rename`, undoable
  via a toast, same pattern as a bundle's header rename), Edit/Preview/Diff, an
  applied-locations panel with per-row
  Update/Remove and "Update everywhere", danger-zone delete listing affected
  files. `/snippet/new` creates one. The navigator's Context group lists every
  snippet and is the actual browsing surface.
  The editor first loads the body from `show --no-usage`. This skips the scan,
  so the body appears almost at once. It then loads applied locations and
  usage counts from `status --name`, which runs one scan and feeds the panel
  too. While that scan runs, the header shows a skeleton pill instead of the
  usage tags, the applied-locations panel shows placeholder rows, and the
  Delete button is disabled. Delete needs the scan result first, so it knows
  how many blocks it would orphan.
  When a body edit is pending and the snippet is applied somewhere, Save reads
  "Save & update N" and refreshes those N applied/outdated locations in the
  same step as the write — one tracked process with two phases, shown on the
  process card, instead of a separate Save then "Update everywhere". Blocks
  edited by hand (`modified`) are skipped either way; the side panel calls out
  how many.
- **Agent Docs strip** (per selected file in a project's Agent Docs view):
  blocks in this file with status badges, Add-snippet picker, damaged-marker
  warnings. Blocked while the editor buffer is dirty (mutations rewrite the
  file); after any mutation the buffer reloads from disk.

Implementation: `snippets.py` (engine + CLI logic), `hub.py` `snippet`
subcommands, `app/src-tauri/src/commands/snippets.rs` (thin marshal),
`app/src/screens/Snippets.tsx` (landing), `app/src/screens/SnippetEditor.tsx`
(edit/create), `app/src/components/snippets/`.
