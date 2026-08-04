# Agent Docs Snippets

Reusable markdown instruction blocks composed into project agent doc files
(`AGENTS.md` / `CLAUDE.md` / nested docs). Define an instruction once — a
validation procedure, documentation style rules, a review checklist — and
apply it to any registered project's docs; remove or update it later without
disturbing the rest of the file.

## Concept

- A **snippet** lives at `~/.skill-hub/snippets/<name>.md`: YAML frontmatter
  (`description`, `tags`, `version`, timestamps) + the markdown body that gets
  appended verbatim. The kebab-case **name is immutable** — it is the marker id
  embedded in every file the snippet is applied to (rename = delete + new).
- `version` is a monotonic integer bumped automatically whenever the body
  changes. It is display-only; the apply-time hash drives all status logic.
- Bodies may not contain lines starting with `<!-- skill-tree:snippet` (they
  would corrupt marker scanning in target files).

## Marker format (hub-owned — never hand-author)

Applying appends to the **end** of the target file, separated by one blank line:

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

## CLI

```
hub snippet list [--tag t] [--query q] [--json]      # library + scan-derived usage
hub snippet show <name> [--json]                     # body + applied locations
hub snippet new <name> [--description d] [--tags a,b] [--body -|TEXT | --body-file f]
hub snippet edit <name> [...]                        # body change bumps version, reports outdated count
hub snippet delete <name> [--force]                  # refuses while applied; --force orphans blocks
hub snippet apply  <name> --project <p> [--file <rel>]   # default: canonical root
hub snippet update <name> (--project <p> [--file <rel>] | --all) [--force]
hub snippet remove <name> --project <p> [--file <rel>] [--force]
hub snippet status [--name n] [--project p] [--json] # scan report incl. damaged-marker warnings
```

## App surfaces

- **Snippets screen** (`/snippets`, `< >` rail icon, palette: "Open snippets"):
  master–detail library — search, tag filters, create/edit with
  Edit/Preview/Diff, applied-locations panel with per-row Update/Remove and
  "Update everywhere", danger-zone delete listing affected files.
- **Agent Docs strip** (per selected file in a project's Agent Docs view):
  blocks in this file with status badges, Add-snippet picker, damaged-marker
  warnings. Blocked while the editor buffer is dirty (mutations rewrite the
  file); after any mutation the buffer reloads from disk.

Implementation: `snippets.py` (engine + CLI logic), `hub.py` `snippet`
subcommands, `app/src-tauri/src/commands/snippets.rs` (thin marshal),
`app/src/screens/Snippets.tsx`, `app/src/components/snippets/`.
