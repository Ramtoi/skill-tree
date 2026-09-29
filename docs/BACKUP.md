# Backup & Restore

The retained Usage inspection database at
`state/usage/inspection.sqlite3` is private local evidence. It is marked
`backup = false` and excluded from portable snapshots. Usage summaries and
loadout ledgers remain portable through their existing per-machine entries.

Skill Hub takes a **portable snapshot** of your whole Skill Tree state, assembles
it into a dedicated local git repo (`~/.skill-hub-backup/` by default) and pushes
that repo to a private GitHub repo. The local clone is the local backup, the push
is the cloud copy, and git history is the versioning. Restore reads a snapshot
back onto any machine.

The snapshot is **not** the data home. Copying `~/.skill-hub/` would be wrong in
both directions: critical state lives *outside* it (sub-agent definitions in
`~/.claude/agents/` and `$CODEX_HOME/agents/`, user-global agent docs), and part
of what *is* inside must never be published (signing keys, machine-local caches,
~60 absolute paths in `registry.yaml`). So the snapshot is **assembled** from an
explicit allowlist, transformed to be machine-independent, and gated before every
commit.

Three modules own this: `backup.py` (manifest table, gather, transform, gates,
snapshot assembly, the `hub sync` tail), `backup_git.py` (git ops, the
ssh → PAT → `gh` auth ladder, GitHub repo creation) and `restore.py`
(integrity/trust, plan, apply, `source restore`).

## The model

```yaml
backup:                          # top-level registry block — machine-LOCAL, never travels
  dir: ~/.skill-hub-backup       # the local backup repo
  remote: git@github.com:me/skill-hub-backup.git
  repo: me/skill-hub-backup      # owner/name when init resolved one
  branch: main                   # pinned; recorded here
  auth: auto                     # auto | ssh | gh | pat  (a preference, not a fact)
  gh_login: Ramtoi               # which gh account init used (mismatch detection)
  enabled: false                 # gates the sync tail pass
  push_failures: 0               # consecutive; ≥3 → loud
  last_push_error: null          # also carries `secret_leak: …` / `prefix_leak: …`
  allowed_secrets: []            # acknowledged finding sha256s
  pending_reconcile: false       # set by restore; blocks PUSH until acknowledged
```

`hub backup init` is the **only** thing that creates this block and the repo. The
sync tail pass runs only when `enabled` is true *and* the dir is already an
initialized git repo — it never bootstraps state behind your back.

### Snapshot layout

```
manifest.json      # schema 1: created_at, hostname, hub version, recorded
                   # HOME/DATA_HOME/CODE_HOME prefixes, per-file sha256 + tree
                   # digest, source classification, counts, warnings, signer pubkey
manifest.sig       # SSHSIG over the finished manifest (namespace skill-hub-backup)
registry.yaml      # PORTABLE form (tokenized, redacted, machine keys dropped)
.gitignore         # defensive only — assembly is allowlist-driven
skills/  mcp-servers/  snippets/  connectors/  hooks/
state/subagents/links.json
audit/<hostname>.jsonl
usage/<hostname>.jsonl  usage/sessions-<hostname>.jsonl  usage/loadouts-<hostname>.jsonl
harness/claude-code/agents/*.md      harness/codex/agents/*.toml{,.disabled}
global-docs/<harness-id>/<docname>   # only harnesses with a global_doc (opencode has none)
```

Everything above is **hub-owned**: each snapshot clears those entries and rebuilds
them, so a deletion in your library propagates into the snapshot (and into git
history). `.git/` is never touched. If the rebuilt tree is byte-identical the
prior `manifest.json` is put back verbatim rather than restamped — otherwise the
timestamp alone would make every sync a noise commit and idempotency a fiction.

## What travels — one canonical manifest table

Skill classification travels inside each skill's registry entry. Snapshots preserve
all assigned fields, including custom classes and outputs. Both merge and replace
restore retain the incoming classification object under their existing conflict rules.
Merge uses the incoming skill entry when the same skill exists on both sides.
The app derives reference contributions again from saved skill files. The backup does not
store them as assignments. Older snapshots can omit classification entirely.

`backup.MANIFEST` is a single table of `(entry, backup, migrate, secret)` rows,
consumed by backup, restore **and** `hub migrate-home`. There is no second list.

| entry | backup | migrate | notes |
|---|---|---|---|
| `registry.yaml` | ✅ | ✅ | stored in portable form |
| `skills/` | ✅ | ✅ | a nested `.git` is recorded + skipped, with a warning |
| `mcp-servers/` | ✅ | ✅ | |
| `snippets/` | ✅ | ✅ | |
| `connectors/` | ✅ | ✅ | user-authored drop-in connector code |
| `hooks/` | ✅ | ✅ | managed hook script bodies |
| `state/subagents/links.json` | ✅ | ✅ | linked-twin membership |
| `state/audit.jsonl` | ✅ → `audit/<hostname>.jsonl` | ✅ | per-machine, so two machines never clobber each other's ledger |
| `state/usage/history.jsonl` | ✅ → `usage/<hostname>.jsonl` | ✅ | per-machine day-by-day usage ledger; restore writes it back only when this machine has none |
| `state/usage/sessions.jsonl` | ✅ → `usage/sessions-<hostname>.jsonl` | ✅ | per-machine transcript-scan session ledger; same write-back rule |
| `state/usage/loadouts.jsonl` | ✅ → `usage/loadouts-<hostname>.jsonl` | ✅ | per-machine append-only loadout history; same write-back rule |
| `state/usage/inspection.sqlite3` | ❌ | ✅ | private retained transcript evidence; several GB; rebuilt by a scan when the raw transcripts exist |
| `state/ssh/known_hosts` | ❌ | ✅ | publishes raw IPs of private boxes; derived — `ssh.py` re-seeds from the registry pin |
| `state/signing/`, `state/codex-workers/` | ❌ **secret** | ✅ | |
| `state/` (rest) | ❌ derived | ✅ (per-**child** collision policy) | a non-empty target `state/` must never strand legacy signing keys |
| `sources/` | ❌ | ✅ | re-cloned by `hub source restore` |
| `_hub-backups/` | ❌ | ✅ | your rollback snapshots — migrate MUST keep them |
| `usage/` | ❌ | ✅ | `latest-ccusage.json`, a derived cache |
| `.lock`, `*.bak-*` | ❌ | ❌ | |

**Unknown top-level entries** get an explicit, asymmetric policy: `migrate-home`
**moves** them (a local move must never abandon user data); backup **skips** them
with a `not backed up (unknown data-home entry …)` warning (never silently publish
unknown content). Adding a new data-home entry means adding a `MANIFEST` row.

### Gathered from outside the data home

- **Sub-agents** — via `subagents.agents_dir()` (honors `$SKILL_HUB_CLAUDE_HOME` /
  `$CODEX_HOME`), *not* the inert `Harness.agents_dir` PurePath. Codex `.disabled`
  twins travel too, so a disabled agent stays disabled.
- **User-global agent docs** — via the same home resolvers, one dir per harness
  that declares a `global_doc`.

Safe relative file references within `skills/`, `snippets/`, `connectors/`, and
`mcp-servers/` become regular files before signing. References must stay within
those sections at every hop. Other symlinks keep their existing representation.
A symlink escaping the data home is skipped and warned; a drop-in connector that is a symlink into another checkout is
recorded in `manifest.external_connectors` by name, so restore can report the
expectation gap instead of you discovering an empty `connectors/` later.

### Stated exclusions

- **Project working trees.** The registry holds pointers; your projects are their
  own repos.
- **Project-scope sub-agents** (`<repo>/.claude/agents/`) — same reason.
- **Harness-native files hub regenerates** (`.mcp.json`, `settings.json`,
  `skill-hub.rules`, symlinked skills). `hub sync` rebuilds them.
- **Secrets, always.** No private key bytes, no tokens, no `mcp.env` values,
  no `mcp.headers` values, no `mcp.url` query string.
- **`sources/` clones** — re-derivable from someone else's repo.
- **The usage inspection database** (`state/usage/inspection.sqlite3`). It holds
  raw transcript bodies and grows to several GB. It is local evidence, not
  configuration. See [Usage](USAGE.md) for retention.
- **Restore of the audit ledger.** It travels, but restore never writes it
  back. Each machine keeps its own audit history. The files stay readable in
  the backup repo.
- **Restore of the usage ledgers onto a machine that has one.** A usage ledger
  is written back only when this machine has no ledger of that kind, or an
  empty one. Restore takes the file for this hostname. When the snapshot holds
  exactly one machine, it takes that machine's file. Several other machines
  is ambiguous: restore skips the ledger and names the hostnames in the
  report. An existing ledger is never merged or overwritten. So a reinstalled
  MacBook gets its Usage history back, and a second machine keeps its own.
- **Tarball export** and OAuth device flow: not built (slot reserved).
- **Multi-machine merge** beyond git's own: single-writer assumption,
  last-push-wins, history as the safety net.

## The portability transform

Field-scoped, **not** a blanket string sweep. Only these paths are rewritten:

| field path | tokens it may produce |
|---|---|
| `projects.*.path` | `{HOME}` **only** |
| `skills.*.source` | `{DATA_HOME}` `{CODE_HOME}` `{HOME}` |
| `skills.*.mcp.args.*` | all three |
| `sources.*.cache` | all three |
| `remotes.*.home` | `{HOME}` |
| `hooks.*.command` | `{DATA_HOME}` **only** |
| `permissions_global.hooks.*.command` | `{DATA_HOME}` **only** |
| `projects.*.permissions.hooks.*.command` | `{DATA_HOME}` **only** |
| `projects.*.permissions_local.hooks.*.command` | `{DATA_HOME}` **only** |
| `worktree_defaults.base_dir` | `{HOME}` **only** |

`projects.*.path` is `{HOME}`-only on purpose: on a dev machine one registered
project's path *is* the code home, and a blanket substitution would rewrite a
legitimate project path into a token meaning something else on the restore
machine. Values are normalized to absolute form **before** tokenizing (most live
skill sources are `~`-collapsed and would match no absolute prefix otherwise);
longest-prefix wins; restore re-expands and re-collapses.

**Every value is rewritten at path BOUNDARIES only** — a match counts when it
is the whole value or the next character is a path separator. `/A/.skill-hub`
matches `/A/.skill-hub/skills/s/x.sh` but **not** `/A/.skill-hub-backup/x.sh` —
hub's own default backup directory, and a plausible place for a user script.
A non-boundary occurrence is never rewritten, and the leak gate applies the
same boundary rule, so a correctly-declined sibling path is never mistaken for
a leak.

**Hook commands are `{DATA_HOME}`-only, in all four places one can live.** A
provisioned `ships_with` companion hook's `command:` is an absolute path under
the data home, and it must follow the data home to the restore machine.
`{HOME}` and `{CODE_HOME}` are deliberately excluded: `~/bin/x.sh` is a
user-authored command hub does not own, and a code home is
installation-specific with its content not in the snapshot — both stay
verbatim and keep their `machine_absolute` report line (below). A hook command
lives in more than one registry shape — the top-level hooks library, and the
`hooks` list under `permissions_global` and under a project's own
`permissions`/`permissions_local` blocks — so all four are transform rows;
repairing only the library would leave the other three travelling verbatim
with nothing saying which half. `projects.*.hook_settings` is the one
hook-adjacent shape **not** in this list: it is arbitrary third-party hook
config at arbitrary depth under arbitrary key names, which this field-path
grammar cannot express and hub does not own or interpret. It always travels
verbatim and is reported per entry (below).

These four fields are also treated as **shell strings a person authors**, not
bare paths hub owns: on restore, an expanded result is **never** `~`-collapsed
back (every hub writer of a hook command emits a resolved absolute path, and
`~` inside a command is expanded only by a shell hub does not control), and
the leak gate raises on a leaked data-home path exactly as for every other
field but adds **no advisory line** for any other machine prefix — an absolute
path outside the data home (`~/bin/lint.sh`) is the normal, supported shape
here, and `scan_for_machine_prefixes` already reports the same value once from
`registry.yaml`.

One documented limit: `_expanduser_with` (and therefore the transform) only
ever expands a **leading** `~`. `bash ~/.skill-hub/s/x.sh` is never tokenized —
the absolute data-home prefix the transform looks for is never present in that
spelling — so it is neither repaired here nor turned into a false "rewritten"
claim by restore; it is reported verbatim, same as any other absolute hook
command outside the data home.

**Dropped keys** (`PORTABLE_DROP_KEYS`): `hub_path` (dead), `bootstrap`
(per-machine first-run state — restore writes its own), `signing` (pins the
public half of a keypair whose private half never travels; a dangling pin would
break fail-closed verification), `backup` (this machine's dir, gh login, failure
counters — carrying it would let a restored machine push over the snapshot it
just restored from). Restore **preserves the target's copies** of exactly these
keys, even in `--mode replace`.

**Redacted:** every `skills.*.mcp.env` value, every `skills.*.mcp.headers`
value, and the query string of every `skills.*.mcp.url` become
`"{REDACTED}"` (`redact_mcp_secrets`, widened from `redact_mcp_env`). All
three legitimately hold an API key or bearer token — including a literal
value a user approved with `hub mcp add --allow-literal` — so none of them
travel, and restore names each `(skill, field)` pair you have to re-enter.

**Source classification:** every `skills.*.source` is classified at snapshot time
as `inside-data-home | inside-code-home | git-source | foreign` and recorded in
the manifest. Restore reports the classes whose content is *not* in the snapshot
as dangling rather than writing a broken path and calling it done.

## Secrets: coded gates, fail-closed

Three independent layers, so a bug in any one of them cannot leak:

1. **Allowlist assembly** — nothing gets copied that no `MANIFEST` row names.
2. **Path assertion** — anything under a `secret: true` entry found in the staged
   tree is a finding, regardless of how it got there.
3. **Content scan** before every commit — private-key markers in raw bytes, plus
   the token regexes (`gh[pousr]_`, `github_pat_`, `sk-…`, `AKIA…`, `xox[baprs]-`,
   `BEGIN … PRIVATE KEY`) and credential-shaped values assigned to
   `api_key`/`token`/`password`/`secret`-ish keys (obvious placeholders excluded).
   `manifest.json` gets its own pass, since it is written *after* the tree scan.

Findings are `path:line: <what>` and refuse the commit (`SecretLeakError`).
Acknowledge one at a time with `--allow-secret <sha256>` (the sha is printed with
the finding, and lands in `backup.allowed_secrets`) — deliberately per-finding
rather than a blanket override.

Two **stated trade-offs**: only the first 2 MiB of each file is read (the scan
runs on every sync; the allowlist and path exclusions are the real defenses), and
a file with a NUL byte in that window gets the private-key-marker check only
(decoding arbitrary binary as text produces noise, not findings).

**Prefix-leak gate:** after assembly the staged tree is grepped for the recorded
`HOME` / `DATA_HOME` / `CODE_HOME` prefixes. A hit fails the backup
(`PrefixLeakError`) — this is what *proves* the transform actually ran, rather
than trusting a round-trip equality test.

Both refusals are **fail-closed even inside the fail-open sync tail**: they are
recorded with `error_kind: "secret_leak" | "prefix_leak"` in the sync report and
in `backup.last_push_error`, and raise the StatusBar chip to danger.

## The auth ladder

`hub backup auth` walks three rungs and reports every one of them. `method` is
the **push** method (`ssh → pat → gh`); `create_method` is what `--create` may use
(`gh` only).

| Rung | Probe | Used for |
|---|---|---|
| **ssh** | `ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new git@github.com` | push (preferred) |
| **gh** | `gh auth status` exit 0 | repo **creation** only |
| **pat** | a token in the OS keychain at `skill-hub:github-backup` | push |

The ssh probe classifies on **stderr text** ("successfully authenticated"), never
the exit code — GitHub's shell-less endpoint exits 1 on success.

`gh` is deliberately **last** for pushing: several `gh` accounts can live on one
machine and the active one is ambient global state, so a push that silently
borrows whichever is active is a footgun. `init` records `gh_login`; `hub backup
status` fails loudly on an active-account mismatch and tells you to
`gh auth switch --user <login>`.

**PAT guidance:** a **fine-grained** PAT, scoped to the single backup repo,
Repository permissions → **Contents: Read and write**. That grant cannot create
repositories — so `--create` requires `gh`, and on the PAT rung hub prints
`manual_create_instructions` (create the private repo at github.com/new yourself,
then re-run `init` without `--create`).

Token handling: `hub backup auth --login-pat` reads the token from **stdin only**
(never an argv flag) and stores it in the OS keychain via
`connectors/transport/keychain.py`. At push time it reaches git through an inline
credential helper that names an env var — `SKILL_HUB_BACKUP_TOKEN`, set only in
the child process. The token is never in argv, never in the remote URL, never in
a file. The Rust layer scrubs `gh[pousr]_` / `github_pat_` shapes from any output
it surfaces to the app.

**Degradation without `keyring`:** `pat_available: false` with the plain reason
`keyring library unavailable — install it with pip install --user 'keyring…'`.
Not a traceback — it is an ordinary state on a fresh install, and the app renders
that reason verbatim.

## Cadence

- **Manual:** `hub backup now` (always re-assembles; 120 s push timeout).
- **Automatic:** a tail pass on `hub sync`, opt out with `--skip-backup`.

Design details that matter:

- The tail runs inside `cmd_sync`'s `try/finally`, so it still runs on the paths
  where the body `sys.exit()`s (stream write errors, doctor danger findings) —
  i.e. exactly when the configuration changed most.
- **Dirty gate:** a stat-based content fingerprint short-circuits an unchanged
  data home (`skipped: "unchanged"`), so a per-click sync costs a few hundred
  `stat()` calls instead of a multi-megabyte copy. `hub backup now` forces past it.
- **`_auto_sync` commits but does not push** (`backup_push=False`), mirroring the
  `skip_remotes` pattern: an equip click never waits on a GitHub round-trip. The
  push happens on the next explicit `hub sync`.
- **Non-fast-forward is structurally impossible.** Each run does
  `git fetch && git reset --hard origin/<branch>` → rebuild the whole tree from
  the data home → commit → push. Every commit is a complete tree, so this is
  lossless; hub never merges and **never force-pushes**. If the remote had moved
  on, the local-only history is first saved to a timestamped ref and that ref is
  reported.
- **Fail-open, never fail-silent.** Git missing, network down, a hung `git`
  hitting the 20 s network timeout — all log and return; sync never breaks over a
  backup. But `record_push_outcome` counts **consecutive** push failures in the
  `backup:` block, and at ≥3 the status warning and the StatusBar chip go danger.
- **Locking:** `run_backup` takes the data-home lock itself, around **assembly +
  commit only**. It is never held across the network push.
- **Guards re-run every time**, not just at `init`: a backup dir inside the data
  home or code home, a non-empty non-repo dir, a foreign git repo with commits but
  no `manifest.json`, or a remote branch whose tip has no `manifest.json` are all
  refusals. The dir is `chmod 700`.

The sync report gains a `global.backup` slot (`ran`, `skipped`, `committed`,
`pushed`, `conflict`, `error`, `error_kind`, `at`), written on every exit path.

> Note: the design's `BACKUP_STALE` / `BACKUP_AUTH_EXPIRED` **doctor** codes are
> not emitted by `risks.py` today. Staleness surfaces through `hub backup status`
> warnings, the sync-report `backup` slot, and the StatusBar chip.

## Restore

Restore is the destructive verb, and it is built to be boring about it.

**Dry run is the default; `--apply` is required.** The dry-run payload is the same
structure the apply path consumes, so the preview cannot disagree with reality.

### Integrity and trust, before anything else

The tree digest and the SSHSIG signature are checked before anything past
`manifest.json` is even read — a truncated clone aborts instead of half-restoring.
Trust folds the signature verdict against a machine-local TOFU pin store at
`<data_home>/state/backup-signers.json` (which lives under `state/` precisely so a
snapshot can never carry the pins meant to judge it).

| Verdict | Meaning |
|---|---|
| `verified` | Signed by the key pinned for this source. Proceeds silently. |
| `unverified-new-key` | Signs fine, but this machine has never seen this source. **Consent-gated** (`--trust-new-key`, or an interactive TTY prompt); pinned on apply. |
| `unverified-unsigned` / `unverified-unavailable` | No signature (or no `ssh-keygen`). Consent-gated — unattested, but nothing claims otherwise. |
| `key-mismatch` | A **different** key is pinned for this source, *or* a source that has signed before now arrives unsigned. **HARD refusal, no flag overrides it.** Drop the pin yourself if you deliberately re-keyed. |
| `invalid-signature` | Signature does not verify. **HARD refusal.** |

A hard failure sets `fatal: true` and returns a **truncated plan** — nothing
beyond the manifest is inspected. Consent-gated states continue building the plan,
because showing you what you are being asked to accept is the whole point of a
dry run. Safe relative file references within snapshot data sections restore as regular files.
Historical signatures did not cover link targets. The preview lists each legacy
reference and requires `--accept-executable-state` consent for its unsigned placement.
Apply checks the target and content against that preview before writing.
Absolute, escaping, cyclic, dangling, and directory links are rejected. Every extracted path is
re-validated under its root after `resolve()`.

### Registry modes

`--mode replace` takes the backup wholesale (the machine-migration case);
`--mode merge` unions `projects` / `bundles` / `skills` / `remotes` / `sources` /
`hooks` / `snippets` key-by-key with the **backup winning** every conflict (each
conflict listed). A non-empty target registry with **neither** flag is a refusal
with a diff summary: `+N added, -M that would be LOST, K conflicts`, enumerated
per section and per top-level key. `PORTABLE_DROP_KEYS` are always preserved from
the target.

### Executable-state consent

Both the dry run and the apply enumerate every hook (**command strings
verbatim**), permission rule, and Codex trust grant the snapshot would install —
including the implicit grants (a project with translatable `Bash(<cmd>:*)` rules,
because sync auto-grants `trust_level = "trusted"` so they load). `--apply`
requires `--accept-executable-state` when any exist. Hook commands naming script
paths that don't exist here are reported as broken per hook.

### Collisions outside the data home

Sub-agents and global docs get a **three-way** verdict per file:

| Action | When |
|---|---|
| `skip` | Byte-identical — a re-run stays quiet. |
| `write` | Not present on this machine. |
| `sibling` | Differs (or the target is a symlink) → written as `<name>.from-backup` alongside, diff reported. |
| `overwrite` | `--force` only, with a timestamped pre-write backup. |
| `unsupported` | No target for that harness here. |

Silently overwriting a file you edited on *this* machine is the one outcome a
restore must never produce by accident, so `sibling` is the default for a
divergence. `links.json` is restored **last**, filtered to links whose member
agent files actually landed, merged by `(name, scope)` with the target's existing
links; dropped links are named.

Every sub-agent row also carries a `companion` field — `null` when no
`ships_with` companions ledger claims that agent, otherwise
`{agent, skills, scopes, written, written_pairs, backfill_pairs, d9_pairs}`
(`skills` and `scopes` are sorted and deduplicated across every claim;
`"global"` means the global ledger; the three `*_pairs` lists are the same
claims grouped as `{skill, scope}`, so a printed command names the right
skill AND the right scope). The join key is the agent's name and the harness
id — the ledger records no path, so a filename like `reviewer.toml.disabled`
is stripped to `reviewer` first. A claim comes from either the entry's
`agent_state` (a v2 ledger, keyed by harness) or its `agents` list (kept
alongside `agent_state` in a v2 entry too — AGENTS.md §Data Model): when
`agent_state` claims the agent but never recorded THIS harness in its
`files` map, the claim falls through to the `agents` list instead of
disappearing, reporting `written: false` rather than no claim at all.

`written` is true only when the ledger recorded a copy hub itself wrote for
that harness. A `written: false` claim splits by ledger version, because it
means two different things for the next `hub sync`: a pre-v2 entry (no
`schema: 2` — `backfill_pairs`) is NOT left alone — sync's backfill path
still records the local file as the tracked copy if the skill still ships
this agent, or deletes it if the skill no longer does; a v2 entry that
recorded no copy (`d9_pairs`, the `already_present`/D9 path) really is left
alone, untouched by sync. The field is present on **every** verdict,
including `unsupported`, so a `--json` consumer never has to branch on its
absence — but the printed sentence appears only for the two collision
verdicts, `sibling` and `overwrite`: for a `written` claim it says `hub sync`
will treat a mismatch here as companion *drift* and never overwrite it, with
one runnable `hub skill companions resolve <skill> --agent <agent>
{--global | --project <p>} --op keep-mine|keep-skill` command per claiming
`(skill, scope)` pair (never a single skill picked out of several
claimants); for an unwritten claim it says what the next sync will actually
do, per the version split above. This is report-only — restore never syncs,
so nothing about the write itself changes. `global_docs[]` rows never carry
the field; a global doc is not an agent.

### Project-path quarantine

Imported projects keep their loadouts and historical paths with
`path_unresolved: true`. An existing historical directory does not establish a
local attachment. Sync skips unattached projects and never counts them as synced.
The app shows "No local directory attached" and offers **Attach directory**.

Use the recovery journey to select a repository and then attach a checkout.
Repository selection alone does not attach a directory. Automatic suggestions
match repository identity only. You can select a local folder explicitly or skip.
A skipped project keeps its skills, bundles, permissions, and repository settings.

The ordinary `hub project edit-path <name> <path>` command clears quarantine after
validating and saving the path. Subsequent delivery errors do not undo that save.
Recovery attachment saves the path without automatic sync. The final recovery
step runs local sync without backup publication or remote dispatch.

### What restore reports rather than fakes

`plan.report` names, per entry: dangling remote `secret_ref`s (with the exact
`hub remote rotate-token` command), redacted `mcp.env` keys to re-enter,
`foreign` / `inside-code-home` skill sources whose content is not in the snapshot,
connector dirs that were symlinks out of the data home, skipped nested `.git`
dirs, quarantined projects, dropped links, and `machine_absolute[]` — every
absolute string carried by a hook command (`hooks.*.command`,
`permissions_global.hooks.*.command`, `projects.*.permissions.hooks.*.command`,
`projects.*.permissions_local.hooks.*.command`), by `projects.*.hook_settings`
(the one hook-adjacent shape no transform rule owns — arbitrary third-party
config hub does not interpret), and by `permissions*.additional_dirs`.

Each `machine_absolute[]` row now carries `rewritten: bool`. A `hooks.*` row
whose command was tokenized at backup time and expanded onto this machine's
data home prints "rewritten for this machine's data home" — evidence read from
the snapshot's own portable value, never guessed from the path in hand.
Everything else — a hook command outside the data home, a `hook_settings`
entry, an `additional_dirs` path, and the documented non-leading-`~` case —
still prints "carried verbatim; verify on this machine", exactly as before.

Worktree defaults are omitted from snapshots unless `include_in_backup` is true.
When included, the complete validated block travels and its HOME-relative
`base_dir` is tokenized; a base directory outside HOME remains in
`machine_absolute[]` for review. Worktree folders and project files are never
included by this setting. A snapshot that omits the block preserves the target's
existing defaults during both merge and replace restore modes.

### What restore deliberately never does

- **It never syncs.** It materializes files and prints ordered next steps.
  Installing restored configuration into the harnesses is a separate, explicit
  act; `--sync` opts into a **local** sync (`skip_backup=True, skip_remotes=True`)
  so a restored, unreviewed state cannot be published over the snapshot it came
  from, and remote dispatch cannot push to live boxes mid-restore.
- **It never pushes.** Restore sets `backup.pending_reconcile: true`;
  `hub backup now` then holds the push (`push held back: a restore is pending
  reconciliation`) until you clear it with
  `hub backup now --acknowledge-restore`.
- **It never destroys silently.** `_registry_migration_backup("pre-restore")`
  plus timestamped copies of every overwritten file land under
  `<data_home>/_hub-backups/restore/<stamp>/` before any write.

Apply order is deliberate: registry backup → data dirs → registry → out-of-home
agent files → `links.json` last (its validity depends on which agent files landed)
→ TOFU pin write.

## `hub source restore`

`sources/` never travels (it is a re-derivable clone of someone else's repo) and
`hub source sync` **fails outright** on a missing cache — so this is the only
recovery path for a restored machine's git sources, and restore prints one command
per registered source.

It shallow-clones `sources.<id>.url` (at `branch` if set), re-points `cache`, and
best-effort deepens to the recorded `current_ref`; landing on the branch tip
instead is a **reported** outcome, not a silent one. A healthy existing cache is a
no-op (idempotent). `--all` does every registered git source.

## Bootstrap: restore-first

`hub bootstrap --restore-from <URL|PATH>` runs the restore **before any import
scanning**, and deliberately skips **both** the import wizard and the
global-permissions adoption prompt: the snapshot already answers each, and
adopting this machine's pre-existing native rules on top of a just-restored
`permissions_global` would silently merge two unrelated configurations. Restore
writes the `bootstrap:` block itself (`completed_at`, `restored_from`,
`restored_at`) — otherwise the app would re-show the first-run wizard over a fully
populated registry. A full `hub sync` follows.

Flags: `--restore-mode replace|merge` (default `replace`), `--restore-branch`,
`--accept-executable-state`, `--trust-new-key`.

## App surface

- **Backup screen** (`/backup`, chord **`g ⇧b`** — shifted to avoid `g b`
  Bundles, the same disambiguation `g ⇧p` uses). Four cards: **Repository**
  (dir/remote/branch, last commit, drift as a `FreshnessBadge`), **GitHub
  credential** (every ladder rung, the `pat_available` reason verbatim, the gh
  account-mismatch warning, stdin PAT login/logout), enable/disable + **Back up
  now**, and a **restore danger zone**.
- **Restore danger zone** — three steps with no way to skip the preview: source →
  dry-run preview → confirm. The `ConfirmDialog` enumerates out-of-data-home write
  targets and hook commands verbatim, and is gated twice: typing the literal word
  `RESTORE`, plus an explicit checkbox for `--accept-executable-state` (shown only
  when the plan actually installs any).
- **Bootstrap wizard** now opens on a **choice**: *Set up fresh* (→ import wizard)
  or *Restore from backup* (→ `BootstrapRestoreStep`, which skips the import step
  entirely and defaults to `replace`). A final, freely **skippable** backup step
  offers credential → repo → first push; it is skippable without consequence
  because a mandatory GitHub step is the worst possible first impression, and the
  screen is reachable forever after.
- **StatusBar chip** (`backupWarning`, mandatory-visible): `backup refused`
  (danger, on a secret/prefix leak), `backup paused — restore pending` (warn),
  `backup stale · N failed pushes` (danger, at ≥3). Clicking navigates to
  `/backup`.
- The Rust layer (`commands/backup.rs`) only marshals `hub backup …` /
  `hub restore …`, pipes the PAT over stdin (`run_hub_stdin`), and scrubs token
  shapes from combined stdout+stderr. The PAT never reaches JS state or a toast.

## Resume recovery

After app restore, **Finish setup** continues through sources, projects, local-only
sources, and local sync. Reopen it from Backup without importing the snapshot again.
Each row retains its result after restart. Skipped items keep their complete loadout.

Choose repositories from the authenticated GitHub account, or select an existing
local checkout. Repository selection stores an association. Attachment requires
an explicit checkout selection or clone destination. Automatic matches use repository
identity, never folder names. No selection leaves the project unattached.

Recover all sources retries incomplete sources and preserves completed and skipped
work. An individual retry can revisit a skipped source. Select valid content for
missing local-only sources. The final sync reports delivered, skipped, and failed
projects separately. It does not publish backups or dispatch remotes.

**Finish later** preserves unresolved work for a later visit. Normal finish requires
resolved or skipped rows and a current local sync result.

## Machine A → machine B

On **A** (the machine that has the hub):

```bash
hub backup auth                                   # check the ladder; --login-pat if needed
hub backup init --repo me/skill-hub-backup --create   # --create needs gh; else create it in the browser
hub backup now                                    # first snapshot + push
```

On **B** (the new machine), with Skill Tree installed and no hub yet:

```bash
hub bootstrap --restore-from git@github.com:me/skill-hub-backup.git \
  --restore-mode replace --trust-new-key --accept-executable-state
```

or, on a machine that already has a hub, the reviewable long way:

```bash
hub restore --from git@github.com:me/skill-hub-backup.git          # DRY RUN — read it
hub restore --from … --mode merge --apply --accept-executable-state --trust-new-key
```

Then work the printed next steps, in this order:

1. `hub recovery restore-source --all --json` retries incomplete registered Git sources.
2. Re-enter each redacted `mcp.env` value (named per skill in the report).
3. Re-provision remote tokens:
   `printf '%s' "$NEW_TOKEN" | hub remote rotate-token <id>` per dangling
   `secret_ref`. (Remote ownership sidecars are machine-local and did not travel,
   so the first remote sync reads as full drift — reconcile it deliberately with
   `hub remote diff <id>` + `hub remote resolve <id> --artifact … --op …`.)
4. Use **Attach directory** for each quarantined project. Review any
   `.from-backup` siblings next to your sub-agents and global docs.
5. Verify the machine-absolute strings the report named (hook commands,
   `hook_settings`, `additional_dirs`).
6. `hub recovery sync --json` installs locally and retains backup reconciliation.
   Two connectors can be symlinks into another checkout; the manifest lists them
   under `external_connectors`. Clone that checkout and recreate the symlinks
   before `hub sync`, or the connector features stay off.
7. `hub backup init --repo me/skill-hub-backup` on B, then
   `hub backup now --acknowledge-restore` once you are happy. Until then, B will
   not push over the snapshot it restored from.

## Troubleshooting

| Symptom | What it means | Fix |
|---|---|---|
| StatusBar: `backup stale · N failed pushes` | ≥3 consecutive push failures; the cloud copy is behind. `last_push_error` has the reason. | `hub backup status`, then fix the credential (`hub backup auth`) and `hub backup now`. |
| StatusBar: `backup refused` | `secret_leak` / `prefix_leak` — hub found credential-shaped material, or the path transform did not run. **Nothing was committed or pushed.** | Read the `file:line` findings. Remove the credential, or acknowledge one with `hub backup now --allow-secret <sha256>`. |
| StatusBar: `backup paused — restore pending` | `backup.pending_reconcile: true` after a restore. Commits still happen locally; pushes are held. | Review the restored state, then `hub backup now --acknowledge-restore`. |
| `Backup: disabled` / `not initialized` in sync | No `backup:` block, or `enabled: false`, or the dir is not a repo. | `hub backup init` / `hub backup enable`. |
| `nothing changed since the last snapshot` | The fingerprint dirty gate short-circuited. | Expected. `hub backup now` forces a re-assembly. |
| `gh is active as 'X' but this backup was configured with 'Y'` | Two gh accounts on this machine; a push/create would use the wrong one. | `gh auth switch --user Y`, or re-run `hub backup init`. |
| `pat_available: false — keyring library unavailable` | The optional `keyring` dep is not installed. | `python3 -m pip install --user 'keyring>=24,<26'`, or use the ssh rung. |
| `UNVERIFIED SNAPSHOT (new signing key …)` | TOFU: this machine has never seen a snapshot from this source. | Confirm it is yours, then `--trust-new-key` (or answer the interactive prompt). It is pinned on apply. |
| `this source is pinned to signing key … refusing` | **Hard** refusal — key substitution, or a downgrade to unsigned from a source that used to sign. No flag overrides it. | If you genuinely re-keyed, delete the entry from `<data_home>/state/backup-signers.json` and restore again. |
| `the target registry already has content: +N, -M, K conflicts` | `--apply` without a mode. | Choose `--mode replace` or `--mode merge` after reading the dry-run diff. |
| `this snapshot installs executable state (…)` | Hooks / permission rules / Codex trust grants would be installed. | Read the enumerated list, then re-run with `--accept-executable-state`. |
| Project skipped as `path_unresolved` | Restore requires explicit local attachment, even if the historical path exists. | Use **Attach directory** in recovery. Keep quarantine until a validated checkout is attached. |
| `hub source sync` fails on a missing cache | `sources/` never travels. | `hub source restore <id>` (or `--all`). |
| `refusing to adopt the existing git repo at …` | The backup dir has commits but no `manifest.json` — not a Skill Tree backup. | Point `--dir` / `--repo` at a fresh empty location or private repo. |
| `<name>.from-backup` files appeared | A sub-agent / global doc diverged from the snapshot; the local file was left intact. | Diff and merge by hand, or re-restore with `--force` (backed up first). |

## CLI reference

```
hub backup init [--repo owner/name | --remote URL] [--create] [--dir PATH] [--json]
hub backup now [--no-push] [--allow-secret SHA[,SHA...]] [--acknowledge-restore] [--json]
hub backup status [--json]
hub backup auth [--login-pat] [--logout] [--json]      # --login-pat reads the token from STDIN
hub backup enable | disable [--json]
hub sync --skip-backup                                 # bypass the backup tail pass

hub restore [--from URL|PATH] [--branch B] [--mode replace|merge] [--apply]
            [--force] [--accept-executable-state] [--trust-new-key] [--sync] [--json]
hub source restore <id> | --all [--json]
hub recovery status | start | finish [--defer] | sync [--json]
hub recovery restore-source <id> | --all [--json]
hub bootstrap --restore-from URL|PATH [--restore-mode replace|merge] [--restore-branch B]
              [--accept-executable-state] [--trust-new-key]
```

Notes (verified against `hub.py` argparse):

- `--repo` and `--remote` are mutually exclusive. `--create` requires `--repo` and
  an authenticated `gh`. `init` sets `enabled: true` and resets the failure
  counters.
- `--from` accepts a URL, or a local dir. A dir already holding `manifest.json` is
  used **in place** (never re-cloned); anything else is cloned/fetched into
  `<data_home>/state/restore-cache/<slug>`, so nothing is written outside the data
  home and a re-run is cheap.
- Omitting `--from` restores from this machine's configured `backup.dir`.
- `hub restore` exits non-zero on a fatal plan, or on an `--apply` that the plan
  blocked. `--sync` only runs when the apply actually happened.
- A new signing key can be accepted interactively at a TTY; a pipe or `--json`
  must pass `--trust-new-key`.
- `hub source restore` is a registry mutation (triggers `_auto_sync`); `backup
  status` / `auth` are read-only.

Topics routed here: *backup*, *restore*, *snapshot*, *backup repo*, *machine
migration*, *move to a new machine*, *portable registry*, *`backup now`*,
*`restore --apply`*, *pending reconcile*, *push failures*, *PAT*, *auth ladder*,
*signing key*, *unverified snapshot*, *allow-secret*, *quarantined project*,
*`source restore`*, *restore-from*.
