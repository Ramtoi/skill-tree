# Cloud Targets

Get hub-managed skills into the hosted chat products — **claude.ai** and
**ChatGPT on the web** — which accept a skill only as a hand-uploaded ZIP.
There is no API on the far side, so hub does the two mechanical things it
honestly can: build a byte-reproducible archive in the layout those products
require, and remember the fingerprint of what it last handed you so it can say
what has drifted since.

A cloud target is **not** a remote. Nothing connects, nothing syncs, and
`hub sync` never touches a cloud target. The upload is a manual step the user
performs, and every surface says so rather than implying a live link.

## Feasibility — what this feature encodes

The design is downstream of what the platforms actually expose. Each of these
is a constraint, not a roadmap item:

- **No skill API, no connector API.** Neither claude.ai nor ChatGPT web offers
  a programmatic way to install, list, update, or delete a personal skill.
  Manual ZIP upload through the product's own settings UI is the only sanctioned
  path, in both directions — hub cannot push, and cannot read back what is
  installed. Everything hub reports is about *its own* export state.
- **claude.ai skills follow the account.** A skill enabled in claude.ai's
  settings is available across claude.ai, the Claude desktop app, and the Claude
  add-ins for Excel, PowerPoint, Word and Outlook. Anthropic's docs do **not**
  state that it reaches the Claude mobile apps — hub says "check the app before
  relying on it" rather than guessing.
- **ChatGPT personal skills do not cross surfaces.** A skill uploaded on the web
  is not installed on the ChatGPT mobile app, and vice versa. Each surface needs
  its own upload.
- **ChatGPT *desktop* is not a cloud target.** The desktop app reads
  `~/.agents/skills` — the codex harness's **global** skills dir
  (`Harness.global_skills_dir`), written by the global-skills pass for skills with
  `scope: global`. So the way to reach it is to give the skill `scope: global`;
  a **project** equip writes `<repo>/.agents/skills` instead and reaches the
  desktop app only inside that repo's workspace. Either way there is no ZIP, no
  upload, and no cloud target for it. `hub harness list` annotates the codex row
  with `also_serves: ["ChatGPT desktop app"]` — but **only when codex is actually
  installed** *and* `cloud_targets.chatgpt_desktop_installed()` (one
  `Path.exists()` against `/Applications/ChatGPT.app`) is true. Both halves are
  required: an uninstalled codex writes no `~/.agents/skills` at all, so
  "already handled for you" would be a flat lie. The app's info card applies the
  same `installed &&` filter in `useAlsoServed`.
- **Local stdio MCP servers can never reach a hosted app, and hub deliberately
  does not bridge or tunnel one.** claude.ai talks only to *remote* connectors
  added by URL; ChatGPT's connectors are developer-mode and remote-only. Hub
  will not stand up a tunnel to close that gap, because doing so would take a
  process holding local filesystem access and local credentials and put it
  behind an internet-reachable endpoint — converting a machine-local trust
  boundary into a public one for a convenience. `type: mcp-server` registry
  entries are therefore refused by every export path and surface as
  `unsupported` with a reason.

## The catalog — fixed in code

`CLOUD_TARGETS` in `cloud_targets.py` is the **single edit point**. It is
hardcoded by design: it describes somebody else's product, not user data, so it
is never registry-driven and never user-editable. When a platform changes its
upload page, its in-product path, or its limits, edit that dict and everything —
CLI table, JSON payloads, the app's Limits section — follows.

| id | label | `upload_url` | `upload_path` (in-product breadcrumb) | `supports` |
|---|---|---|---|---|
| `claude-ai` | claude.ai | `https://claude.ai/customize/skills` | `Customize > Skills > + > Create skill (upload the .zip)` | `skill` |
| `chatgpt-web` | ChatGPT (web) | `https://chatgpt.com` | `Plugins > Skills > Create > Upload from your computer` | `skill` |

Each target also carries `notes` — the product's own limits, authored backend-side
and **quoted verbatim** by every consumer. The UI must never paraphrase them: the
caveats (mobile reach, remote-only MCP, the required ZIP root) are exactly where
a paraphrase would overclaim. An unknown target id fails loudly with the known
ids listed; `load_cloud` silently drops unknown keys from the registry so a stale
key left by a downgrade can never invent a target.

**Every reader goes through the sanitizer.** `equip_for(target_id, registry)` —
`load_cloud` plus an empty-`CloudEquip` fallback — is the one entry point, used
by `partition_equipped` and therefore by `status`, `targets`, and `export`. It
drops unknown target ids, non-mapping target entries, non-list name fields, and
non-string names. A `cloud:` block is hand-editable YAML, so a shape like
`cloud: "nope"` must degrade to "nothing equipped", never raise out of a command
(or out of the app's Cloud band, which would render the traceback).

## Registry: the `cloud:` block

Top-level, parallel to `projects:` and `remotes:`. Absent means nothing is
equipped anywhere.

```yaml
cloud:
  claude-ai:                     # id from the FIXED in-code catalog
    bundles: [android]           # equipped bundles (project equip model)
    enabled: [extra-skill]       # individually equipped skills
    apply_global_bundles: false  # optional; default false
```

`resolve_cloud_skills` delegates to `remotes.resolve_remote_skills` →
`hub.resolve_project_skills`, so a cloud target's `bundles` ∪ `enabled` resolve
with exactly the same union, order, and dedup as a project's or a remote's — one
equip model, everywhere. Like a remote, a cloud target does **not** inherit
`scope: global` bundles unless it opts in via `apply_global_bundles: true`; the
flag is read but has no `hub cloud` flag today (unlike `hub remote set-global`),
so setting it means editing `registry.yaml`.

Equipping is **registry-only**: `hub cloud equip` runs under the data-home lock,
writes the block, and deliberately does **not** auto-sync — nothing on disk
changes and nothing leaves the machine until you export.

Two rules the equip path follows because it *writes*:

- **`--state on` validates the name; `--state off` does not.** Unequipping a name
  the registry no longer knows is precisely the case that matters (the skill was
  archived while still equipped here); refusing it would leave the entry
  unremovable except by hand-editing YAML.
- **A malformed block is refused, not replaced.** Where the read path sanitizes,
  the write path fails with the file path and the offending type — silently
  rewriting `cloud:` would delete every other target's equip list without a word.

`hub archive <skill>` and `hub bundle delete <bundle>` prune the `cloud:` block
the same way they prune `projects:` (`_prune_cloud_equip`; the `--dry-run` output
lists the affected target ids). Without that, an archived skill stayed equipped on
claude.ai forever, showing up as `unsupported` ("not in the registry any more") on
every status.

## The deterministic ZIP

`build_skill_zip(skill_name, root, out_path)` writes the archive claude.ai
requires: exactly **one top-level folder named after the skill**, with `SKILL.md`
inside it — `<skill>/SKILL.md`, `<skill>/references/…`. No wrapper dir, no `./`
prefix. ChatGPT reads the same package format, so one builder serves both
targets, and `hub skill export --format zip` uses the same code.

Byte-reproducibility (the same tree always yields the same bytes):

- entries written in sorted order,
- every `ZipInfo.date_time` pinned to the 1980 ZIP epoch `(1980, 1, 1, 0, 0, 0)`,
- fixed `0o644` member permissions and a fixed `create_system = 3` (Unix), so
  neither the builder's umask nor its OS leaks into the archive,
- deflate at the default level (zlib is deterministic for equal input),
- written to a sibling `.tmp` and `os.replace`d into place, so a reader never
  sees a half-written archive.

**The filename is validated.** `zip_name_for(skill_name)` is the one place a name
becomes a filename, and it refuses anything that is not a bare slug
(`hub.SLUG_RE`, the same gate every other name in the repo passes). A skill name
is a registry key and a sidecar key — both hand-editable text — so an unvalidated
`../../pwned` would escape the export dir on write *and* on the prune's
`unlink()`. `hub skill export --format zip` fails cleanly on such a name;
`hub cloud export` records it in `errors[]` and carries on with the rest.

**Content walk.** `collect_zip_entries` reuses `hub.collect_skill_pack_files`
verbatim, so a `.skillpack` and a `.zip` of one skill can never disagree about
what the skill contains:

- junk excluded: `.DS_Store`, `__pycache__/`, `.hub-bak*` (from the shared walk)
  plus `*.pyc` / `*.pyo` (the zip's documented superset — a stray `.pyc` outside
  a `__pycache__` dir would otherwise ride along),
- **symlinks that resolve outside the skill dir are skipped with a warning** — a
  `notes.txt -> ~/.ssh/id_rsa` link must never have its bytes embedded in an
  archive you hand to a web upload form; links resolving back inside the skill
  are exported by content, and broken links and directories are skipped,
- `type: mcp-server` entries are **refused**: a hard failure in
  `hub skill export --format zip`, and an `unsupported` row (never an export) in
  every `hub cloud` path.

**The fingerprint.** `content_fingerprint(skill_name, root)` is the one drift
value, and it is a sha256 over the **content walk**, not over the `.zip`
container:

```
sha256( b"skill-tree-cloud-zip-v1\n" || skill_name || \0 || Σ (path \0 len \0 bytes) )
```

The archive is reproducible, so its own digest would also work — but
`hub cloud status` must answer "has this drifted?" *without writing a zip*, and a
content hash is computable from the source tree alone. One value, one meaning:
the `sha256` reported by `status`, `export`, `skill export --format zip`, and the
sidecar are all this number. Length-prefixing each blob keeps the stream
unambiguous, and folding in the skill name makes a rename count as drift even
when the bytes are identical.

## Export state and the status grammar

Each target keeps one sidecar at `<data_home>/state/cloud/<target>.json`:

```json
{
  "schema_version": 1,
  "skills": {
    "demo-skill": {
      "sha256": "df8c79298be6…",
      "exported_at": "2026-08-19T13:09:32",
      "zip_name": "demo-skill.zip"
    }
  }
}
```

Written atomically (temp + `os.replace`, keys sorted) under the data-home lock.
Reads **fail open**: a corrupt or foreign file is treated as empty and reported
through a `warnings` entry on the status payload, because this file records only
"what we last handed the user" — losing it costs a re-export, never data. The app
surfaces that `warnings[]` as a banner on the detail screen: fail-open is only
honest if the screen says *why* everything suddenly reads `new`.

A stored `zip_name` is hub's own state but still a plain JSON string on disk, so
it is honoured by **basename only** (`recorded_zip_name`); when neither it nor the
skill name yields a safe filename the result is `null` — displayed as nothing, and
never a delete candidate.

| Status | Meaning |
|---|---|
| `new` | equipped, never exported for this target |
| `up_to_date` | current content fingerprint equals the one recorded at last export |
| `changed` | edited since the last export — re-export and upload it again |
| `missing` | the skill's source directory is gone; nothing to export |
| `orphaned` | recorded in the sidecar but no longer equipped — its own list, never a row inside `skills[]` |

**Honest-state framing.** `up_to_date` means *"matches the ZIP you last
exported"*, **not** *"delivered"* or *"synced"*. Hub cannot see what is actually
installed in claude.ai or ChatGPT — a ZIP you exported and never uploaded reads
`up_to_date` exactly like one you did. Every surface uses that grammar
deliberately: the badge hints say "Matches the ZIP you last exported for this
target", the detail screen's subline says "Manual ZIP upload · hub tracks what
you last exported", and the two-step strip keeps the upload step on screen after
the export throws the user out to Finder and a browser tab.

Status is read-only: it classifies drift from the source tree, writes no ZIP, and
never touches the sidecar.

## Pruning — ownership-scoped

`hub cloud export` prunes sidecar entries for skills that are no longer equipped.
The **sidecar entry is always dropped**; the `<skill>.zip` file is deleted only
when all of these hold:

- the export ran against the **default** export dir (`<data_home>/exports/<target>/`),
  never a user-chosen `--out` dir,
- the sidecar itself records that hub wrote that `zip_name`, taken as a
  **basename** (a doctored `../../evil.zip` becomes `evil.zip`),
- the candidate, once `resolve()`d, still has the resolved export dir among its
  parents — a resolve that raises counts as *not contained*,
- the candidate is a regular file and not a symlink.

Hub never removes a file it does not own, never removes anything from a directory
the user named, and never removes anything outside the export dir however the name
was spelled. Removing the skill from the *product* is still manual — the app says
so on the Orphaned section.

## Frontmatter lints — warn, never block

`lint_skill` reports claude.ai's hard caps as non-blocking warnings, so a
deliberate export still succeeds:

- `name` missing, or longer than **64** chars (`NAME_MAX`),
- `description` missing (the target cannot tell when to use the skill), or longer
  than **200** chars (`DESCRIPTION_MAX`),
- `SKILL.md` absent, or carrying no readable `---` frontmatter block.

Warnings ride along on `status` rows, on `export` results, and under each row in
the app.

## CLI

```
hub cloud targets [--json]                    # catalog + per-target equipped count + drift rollup
hub cloud equip <target> --kind bundle|skill --name <n> --state on|off [--json]
hub cloud status <target> [--json]            # per-skill new|up_to_date|changed|missing + orphans + lints
hub cloud export <target> [--skill <n>] [--out DIR] [--json]
hub skill export <n> --format zip [--out PATH] [--json]   # one-off zip, outside the equip model
```

```bash
hub cloud targets                                     # both targets, drift at a glance
hub cloud equip claude-ai --kind bundle --name android --state on
hub cloud equip claude-ai --kind skill --name brainstorm --state off
hub cloud status claude-ai --json                     # machine-readable drift + lints
hub cloud export claude-ai                            # all equipped → ~/.skill-hub/exports/claude-ai/
hub cloud export claude-ai --skill brainstorm --out ~/Desktop
hub skill export brainstorm --format zip --out ~/Desktop/brainstorm.zip
```

Shapes worth knowing:

- `cloud targets --json` is a top-level **array**; each row is the catalog entry
  plus `equipped`, `drift: {new, changed, up_to_date, missing, orphaned}`, and
  `last_exported` (the newest `exported_at` in that target's sidecar, `null` if
  hub has never exported for it). `missing` is in the rollup because leaving it
  out let a card read "equipped 1" beside an empty drift cluster.
- `cloud status --json` returns `{target, label, upload_url, upload_path,
  last_exported, notes, skills[], orphaned[], unsupported[], summary}` where
  `summary` counts `equipped, new, changed, up_to_date, missing, orphaned,
  unsupported, lint_warnings`; `warnings[]` appears only when the sidecar was
  unreadable.
- `cloud export --json` returns `{target, label, upload_url, upload_path,
  out_dir, results[], pruned[], unsupported[], errors[], notes}`. Each result
  carries `status_before` — what the skill *was* before this export — plus
  `zip_path`, `sha256`, `files`, `lint`.
- `skill export --format zip --json` returns
  `{exported, out, files, format: "zip", sha256}`; default output path is
  `./<name>.zip`. `--format pack` (the default) is unchanged.
- `hub cloud export` re-stamps `exported_at` on every run, even when the content
  did not change.

**Export is two-phase, isolated, and honest about its exit code.**

1. **Build (no lock).** Each archive is written to a sibling temp and
   `os.replace`d, so it needs no cross-process mutex — and holding the one global
   data-home lock across a multi-second compress would stall every unrelated hub
   command and app click for its duration.
2. **Record (locked).** The sidecar read-modify-write plus the prune happen under
   `data_home_lock()`. That is the part that must be atomic.

A skill that cannot be read — a missing source dir, a `PermissionError`, an unsafe
name — lands in `errors[]` and the run **continues**. One unreadable folder must
not throw away the ZIPs already built or the sidecar entries recording them
(before, the abort left already-written ZIPs unrecorded, so they re-reported as
`new` forever). A non-empty `errors[]` makes the command **exit non-zero**, matching
the `hub sync` / doctor convention: a run that could not export what it was asked
to export did not succeed, whatever else it managed. The JSON payload is still
printed in full, so a caller reads the payload rather than the exit code to see
*what* worked.

`equip` validates the target id, validates the bundle/skill name on `--state on`,
and takes the lock; `export` only ever *reads* the registry. `targets` and
`status` are read-only.

## App surfaces

- **Cloud apps band** on the Remotes screen (`/remotes`,
  `components/cloud/CloudAppsSection.tsx`). Cloud targets are not remotes, but
  they answer the same question — "what is equipped off this machine, and is it
  stale?" — so they share that surface instead of taking a rail slot for an
  occasional job. Each card is deliberately zero-click: an identity-ramp `cloud`
  glyph (its own icon — `globe` is reserved for `scope.global`, and two meanings
  on one shape is the collision the identity register must avoid), the equipped
  count, **last exported** as a relative time (`relTime`, raw stamp on hover,
  "never" before the first export), and the **drift cluster** (`driftCluster` —
  changed, new, missing, orphaned in reading order, collapsing to one green "up
  to date" when everything is settled). Alongside them, an info card for the
  **ChatGPT desktop app** appears whenever an **installed** harness reports
  `also_serves: ["ChatGPT desktop app"]`; it states that codex writes
  `~/.agents/skills` for `scope: global` skills, that a project equip writes
  `<repo>/.agents/skills` and reaches the desktop app only inside that repo, and
  that no upload is needed either way.
- **Cloud target detail** (`/cloud/:id`, `screens/CloudTarget.tsx`; section chrome
  resolves to `remotes`, back link to Remotes). One primary action —
  **Export & open <label>** — runs `hub cloud export <id> --json`, then reveals
  the output folder and opens the product's upload page; a failure to open either
  is a convenience failure and never reads as a failed export. Because a partial
  export now exits non-zero while still printing its payload, the screen reads the
  **payload**, not `res.success`, and emits exactly **one** toast: the success
  toast only when `errors[]` is empty, otherwise a single "Exported N of M skills"
  (or "Couldn't export to <label>" when nothing built). Reveal/open are skipped
  when nothing was built — an empty folder plus a browser tab is noise on top of
  bad news. A numbered
  two-step strip keeps the manual upload on screen before *and* after that
  action. Below it: an inline `EquipPicker` (Bundles / Skills tabs) writing
  through `hub cloud equip`, the per-skill status list with badges + lint lines +
  relative last-export time, then **Orphaned**, **Not exportable**, and
  **Limits** (the catalog notes, rendered verbatim with backtick spans styled as
  mono).
- **Command palette**: "Open claude.ai skills" / "Open ChatGPT (web) skills",
  injected from the mirrored `CLOUD_TARGET_CATALOG` so app boot costs no
  subprocess. There is no dedicated chord.
- The Rust layer has **no** cloud commands — every call goes through the generic
  `hub_cmd` bridge, keeping product logic in Python.

## Implementation

`cloud_targets.py` (catalog, `equip_for` sanitizer, ZIP + `zip_name_for`
validation, fingerprint, sidecar + `recorded_zip_name` / `last_exported_at`,
status, lints), `hub.py` `cmd_cloud_targets` / `cmd_cloud_equip` /
`cmd_cloud_status` / `cmd_cloud_export` (marshalling + output only),
`_prune_cloud_equip` + `_cloud_targets_equipping` (called from `cmd_archive` and
`cmd_bundle_delete`) and `cmd_skill_export`'s `zip`
branch, `app/src/lib/cloud.ts` (payload contracts + badge meta + `driftCluster`),
`app/src/hooks/useCloud.ts`, `app/src/components/cloud/`,
`app/src/screens/CloudTarget.tsx`.

Tests: `tests/test_cloud_targets.py` (byte-reproducibility, layout, the status
grammar, prune ownership + containment, malformed-`cloud:` shapes, unsafe names,
partial-export isolation + exit code, archive/bundle-delete pruning; CLI cases
spawn `hub.py` against an isolated `SKILL_HUB_HOME`),
`app/src/test/CloudTargets.test.tsx`,
`app/e2e/cloud-targets.journey.spec.ts`, and the `cloud-apps-band` /
`cloud-detail` visual scenes in `app/visual/capture.mjs`.
`app/src/test/cliContract.test.ts` asserts the mirrored `CLOUD_TARGET_CATALOG`
ids still match the live CLI, so a backend catalog change fails the suite rather
than drifting.
