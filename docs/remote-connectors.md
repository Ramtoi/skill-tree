# Remote Connectors

Push Hub-managed artifacts (skills, MCP server specs, agent docs) to a **remote**
— a box reached over SSH, an MCP control plane — and read them back for drift
detection and import. A remote is configured once in the registry as a set of
*references* (never secrets), equips skills exactly like a project does, and is
kept up to date by a non-blocking pass at the tail of `hub sync`.

The framework + the **Hermes** connector are publishable (they ship in the
public mirror). Custom/private control-plane connectors live in an excluded
tree and are a separate sibling change.

## Model

A remote is a pluggable **connector** (`hermes`, …) pointed at one destination.
The registry's top-level `remotes:` block is parallel to `projects:` and holds
only references:

```yaml
remotes:
  hermes-main:
    connector: hermes               # REMOTE_CONNECTORS key
    transport:
      ssh_host: hermes@moon-base   # SSH alias or user@host
    host_key_sha256: SHA256:abc…    # pinned TOFU fingerprint (also accepted under transport:)
    secret_ref: skill-hub:hermes-main  # keychain handle — NEVER the secret bytes
    home: ~/.hermes                 # remote home dir (connector default if omitted)
    sync_enabled: true              # include in the auto-sync dispatch pass
    bundles: [android, openspec]    # equipped bundles (project equip model)
    enabled: [extra-skill]          # individually equipped skills
```

**References only — no secrets.** Secret *bytes* never enter `registry.yaml`,
argv, or the audit log; only a keychain handle (`secret_ref`) is stored, resolved
at use time against the OS keychain (`connectors.transport.keychain`). SSH auth is
via ssh-agent, so no app-owned private key is stored either.

A remote resolves its active skills with the **same equip model as a project**:
`resolve_remote_skills` delegates to `resolve_project_skills`, so
`bundles` ∪ `enabled` (plus any global-bundle skills) resolve identically.
`host_key_sha256` and `home` are accepted at the entry top level *or* nested under
`transport:` (loader normalizes both). A `home` containing a `..` component is
rejected outright.

## The connector contract

Every connector implements the `RemoteConnector` ABC (`connectors/base.py`). The
contract is **plan-then-apply** so the dry-run diff gate and 3-way drift detection
are first-class, not bolted on:

| Method | Role |
|---|---|
| `capabilities()` | subset of `{SKILLS, MCP, AGENT_DOCS}` this connector manages |
| `health_check(target)` | `HealthResult(reachable, authenticated, host_key_match)` |
| `list_remote_artifacts(target, kind)` | list remote artifacts, flagging which are sidecar-**managed** |
| `fetch_artifact(target, ref)` | fetch one artifact's bytes (diff / pull / doc edit) |
| `plan(target, desired)` | classify each artifact's drift → `RemotePlan`; performs **no** mutation |
| `apply(target, plan, *, allow=DEFAULT_ALLOW)` | execute only artifacts whose action is in `allow` |
| `pull_artifact(target, ref)` | read a remote artifact back into Hub (drift pull / import) |

`apply()`'s default allow set is `{CREATE, FAST_FORWARD, REMOVE}`. The `SKIP_*`
actions (`SKIP_remote_drifted`, `SKIP_conflict`) are **never** in the default set —
they represent drift sync refuses to clobber, surfaced and left for an explicit
resolve op.

Connectors register themselves at import time into the `REMOTE_CONNECTORS` dict;
registration is triggered **lazily** by the first registry use (`get_connector`,
`all_connectors`, the catalog command) via `connectors/discovery.py`'s memoized
`ensure_discovered()` — importing the `connectors` package alone stays
side-effect-light. `get_connector(key)` hard-errors on an unknown key. Each
connector sets class attributes: `key` (registry key), `publishable` (True → may
ship in the public mirror), and presentation/transport metadata with back-compat
defaults — `label` (falls back to a title-cased key), `description`, and
`transport_kind` (`"ssh"` default; `"https"` for endpoint+token connectors). The
wizard derives its cards and onboarding flow from these. A connector may also
override `setup_key_transport(target)` to supply a custom key-install/revoke
transport (the default `None` means the generic user-key path).

## Distributing a connector (plug-ins)

Third-party connectors need no fork. Discovery runs four sources in order —
**builtin** (Hermes) → the **`connectors_private` package** (back-compat, if
importable) → **entry points** (group `skill_hub.connectors`, for pip-installed
distributions) → the **drop-in directory** `data_home()/connectors/` (each `*.py`
file or package dir; suited to the packaged app, which has no pip environment).
An earlier source always wins a key conflict (a drop-in cannot shadow Hermes), a
broken plugin is skipped with one logged warning (it can never break `hub sync`
or the app), and `hub remote connectors --json` lists every registered connector
with `key/label/description/transport_kind/publishable/available/source` — the
app's add-remote wizard renders its cards from exactly that catalog.

> **Trust note:** placing a module in `data_home()/connectors/` (or installing a
> distribution exposing the entry point) executes that code with your user's
> privileges on first remote use. Same trust model as installing any package —
> only drop in code you trust.

**Publishable vs custom boundary.** The framework (`connectors/base.py`,
`drift.py`, `sidecar.py`, `transport/`, `layouts/`) and the `hermes` connector are
`publishable = True`. The custom control-plane connectors are private
(`publishable = False`), live under an excluded `connectors_private/` tree (the
publish git-archive drops it exactly as it drops `openspec/`), and are a **separate
sibling change** — the framework and Hermes carry zero private-connector knowledge.
Layering rule: lower modules never import higher, and **no connector imports
another**.

## Hermes connector

`connectors/hermes.py` — SSH to a Hermes box's `~/.hermes/`. Hermes is a
self-improving agent whose curator actively edits its own skills, so **remote
drift is the common case**, not the exception.

**Works out of the box.** With no `home` configured, the connector probes the box
for `$HERMES_HOME` and falls back to `~/.hermes`. Capabilities: skills, MCP, and
agent docs.

**On-remote layout:**

```
<home>/skill-hub/<name>/SKILL.md   ← hub-owned managed skills (Hub writes here)
<home>/skills/<name>/SKILL.md      ← Hermes's OWN tree — READ-ONLY, import source only
<home>/config.yaml                 ← mcp_servers: + skills.external_dirs
<home>/SOUL.md                     ← persona doc
<home>/memories/MEMORY.md          ← memory doc
<home>/memories/USER.md            ← user doc
```

- **Skills** push into the hub-owned `<home>/skill-hub/<name>/`, and that
  directory is registered once in `config.yaml` under `skills.external_dirs`
  (merge-preserving) so Hermes loads them. Hub never writes into Hermes's own
  `skills/` tree.
- **MCP servers** merge into the `mcp_servers:` mapping in `config.yaml`,
  add/update/remove only the hub-owned keys.
- **Agent docs** round-trip `SOUL.md` / `MEMORY.md` / `USER.md` (fetch, edit,
  push). Docs are never *deleted* from the box on cleanup — they are part of the
  box's identity; ownership is only forgotten.

**Comment-preserving config edits.** `config.yaml` writes go through `ruamel.yaml`
in round-trip mode (`preserve_quotes`, wide width, `allow_unicode` so 🔥/◕‿◕ stay
literal). If `ruamel.yaml` is not importable the write **fails closed** — it raises
rather than fall back to a lossy PyYAML re-serialization that would strip every
comment and reformat the file. Reads may fall back to PyYAML. A skipped config
edit is reported with a warning; skills still push.

**Upgrade-safety (write confinement).** Writes are hard-confined to the documented
extension points. `_guard_write_path` allows a normalized write path **only** if it
is inside `<home>/skill-hub/`, is exactly `<home>/config.yaml`, or is one of the
three doc paths. Anything else — the Hermes code tree (`<home>/hermes-agent/`),
Hermes's own `skills/` tree, any `..` traversal, any path that escapes `home` — is a
hard `UpgradeSafetyViolation`. This keeps the connector version-agnostic: it never
forks, patches, or collides with Hermes's own state.

## Auto-sync, drift, and conflict

An **explicit** `hub sync` runs `_run_remote_dispatch` as a third stream after the
global-skills and global-MCP passes (opt out with `--skip-remotes`). It is
**non-blocking**: an unreachable or not-ready remote logs a line and is skipped; a
dispatch error is caught per remote; drift and conflict are reported but **never
applied**. Only `sync_enabled` remotes are dispatched.

**Post-mutation auto-syncs skip remotes.** Every registry mutation (`hub enable` /
`disable`, `bundle apply/remove/new/update/delete`, project ops, `set-meta`, …) runs
a local reconcile via `_auto_sync()`, which sets `skip_remotes = True` — the remote
plan can take tens of seconds against a live box, so pushing on every click would
freeze the UI. Remote push is deferred to an **explicit** sync: the StatusBar sync
chip (`hub sync`) or `hub remote sync <id>`. The app frames this as eventual
("Reconciled on next sync"). Auto-syncs keep the local streams (skills, MCP,
permissions, doctor) enabled — only the remote dispatch is deferred.

Per artifact the connector computes a **3-way** classification using the ownership
sidecar's recorded `last_pushed_sha256` as the **base**, compared against the
remote-current sha and the local-current sha (`connectors/drift.py`):

| base vs remote | base vs local | status | sync action |
|---|---|---|---|
| same | same | `in-sync` | noop |
| same | changed | `local-ahead` | **fast-forward** (auto) |
| changed | same | `remote-drifted` | SKIP — offer pull |
| changed | changed (remote ≠ local) | `conflict` | SKIP — explicit resolve |
| — | local removed, still on remote | `orphaned` | remove (sidecar-scoped) |
| — | managed, gone from remote | `missing` | recreate |

Only **`local-ahead`** auto fast-forwards. If both sides changed but converged to
the *same* content, that is treated as `in-sync` (a re-base, not a conflict). Sync
**never clobbers** an agent's edit: `remote-drifted` and `conflict` are surfaced
with the exact `hub remote resolve …` command to run.

**TOCTOU guard.** Immediately before each write, `apply` re-fetches the remote sha
and re-classifies. If the box drifted between `plan()` and `apply()`, the write is
aborted (counted as skipped) rather than clobbering the new remote content.
Byte-identical content is a no-op; the sidecar base is rebased only for artifacts
actually applied.

**Resolving drift/conflict** is always explicit (`hub remote resolve`):

| `--op` | Effect |
|---|---|
| `push` | force-push local content (widens the allow set to include the SKIP actions) |
| `pull` | adopt remote content into the Hub registry + skills dir, then re-base the sidecar to the remote sha |
| `keep-local` | re-base the sidecar to local — next sync sees `local-ahead` and fast-forwards |
| `keep-remote` | fetch + re-base the sidecar to the remote sha (accept the agent's edit) |

## Import (remote → Hub)

A box may carry hand-authored skills Hub never pushed — they live in Hermes's own
`skills/` tree and are always flagged **unmanaged** (never in the ownership
sidecar). Hub never writes or cleans those.

`hub remote import-skill --remote <id> --scan` lists never-managed box skills as
candidates (`NEW` for a valid slug, `INVALID_NAME` for a bad one,
`ALREADY_REGISTERED` if the name is taken). `hub remote import-skill <name>
--remote <id>` read-fetches the whole skill tree, copies it into
`data_home/skills/<name>`, registers it (`scope: project-specific`,
`type: claude-skill`) with provenance **`origin: remote:<id>`**, and **never
mutates the box copy** — the next sync re-pushes it into the hub-owned
`skill-hub/` tree as a managed artifact.

## Onboarding: add a remote

Two paths, same underlying steps.

**App wizard** (`AddRemoteWizard.tsx`): pick connector type → endpoint
(`ssh_host`) → **TOFU host-key confirm** (fetch the live fingerprint, confirm,
pin) → optional confirmed `ssh-copy-id` → health check → register. Only the
host-key step gates progress; the box write (`copy-id`) is explicitly confirmed.

**Headless CLI** — the same flow as discrete commands:

```bash
# 1. TOFU: fetch the live SHA256 fingerprint to pin (BEFORE registering).
hub remote keyscan hermes@moon-base

# 2. Authorize our SSH pubkey on the box (one-time). Accepts a raw host pre-registration.
hub remote setup-key --ssh-host hermes@moon-base

# 3. Register the remote with the pinned key.
hub remote add hermes-main --connector hermes \
  --ssh-host hermes@moon-base --host-key SHA256:abc… \
  --secret-ref skill-hub:hermes-main --bundles android,openspec

# 4. Verify + first push.
hub remote health hermes-main
hub remote diff hermes-main          # dry run, no writes
hub remote sync hermes-main
```

**The `ssh-copy-id` fallback.** `setup-key` appends the pubkey to the box's
`authorized_keys` via the transport's `copy_id`. When `ssh <user>@<host>` is not
yet authorized (no password auth, no existing key — the live moon-base case), it
prints the **exact** root-side command to run manually (`ssh root@<host> "mkdir -p
~<user>/.ssh && echo '<key>' >> … && chown … && chmod …"`); it never attempts the
root write itself.

`hub remote add` warns if no host-key pin is set — a pin must exist before syncing.

## Security model

- **Secrets via OS keychain, references only.** `registry.yaml` holds a
  `secret_ref` handle (`<service>:<account>`); the value is resolved at use time
  via the `keyring` binding. The keychain import is guarded and **fails closed** —
  if `keyring` is unavailable a secret request raises; there is deliberately no
  plaintext/env fallback. Secret bytes never touch argv or the audit log.
- **Hardened SSH transport.** ssh-agent auth (no app-owned private key),
  `StrictHostKeyChecking=yes` + `BatchMode=yes`, against a **hub-owned**
  `UserKnownHostsFile` at `<data_home>/state/ssh/known_hosts` (not
  `~/.ssh/known_hosts`).
- **Host-key pinning.** The pinned `host_key_sha256` is verified before any read
  or write; a mismatch hard-fails (`HostKeyMismatch`) and no remote artifact is
  touched. A single `ssh-keyscan` returns every key type the box advertises, but
  **only the line whose fingerprint equals the pin** is seeded into the hub-owned
  `known_hosts` — an un-pinned key is never silently trusted.
- **Write confinement + ownership sidecar.** Hermes confines all writes to the
  documented extension points (above). The ownership sidecar at
  `<data_home>/state/remote_<id>/<surface>.managed.json` records, per artifact, the
  `last_pushed_sha256` base. **Cleanup and drift only ever consider sidecar-listed
  names** — the box's pre-existing library is invisible to apply/cleanup. A missing
  or corrupt sidecar reads as empty and never raises, so cleanup is a safe no-op
  when state is lost.
- **Atomic + backup-on-change + audit log.** Writes stage to an unpredictable
  remote temp path (pid + counter, same dir) and `mv -f` into place; a reader never
  sees a partial file. The prior content is copied to a sibling `<path>.hub-bak`
  **only when the content actually changes**. Every write/remove appends a
  timestamped JSONL entry (action, artifact, sha-before/after, never secrets) to
  `<data_home>/state/remote_<id>/audit.log`.
- **Dry-run diff gate.** `hub remote diff` (and the app) runs `plan()` only — no
  remote writes — so the full per-artifact action set can be reviewed before a sync.
- **Remote-supplied path validation.** Relpaths from a (possibly MITM'd) box are
  rejected if absolute or containing `..` before any join, both at the transport
  `find` boundary and again before writing.
- **Signing is deferred** — not implemented in this change.

## CLI reference

```
hub remote connectors [--json]                 # catalog of registered connector types
                                               #   (key, label, transport_kind, source…)
hub remote list [--json]                       # configured remotes (table or JSON)
hub remote add <id> [--connector hermes] [--ssh-host H] [--host-key SHA256:…]…
               [--secret-ref REF] [--home DIR] [--no-sync | --sync]
               [--bundles a,b] [--enabled s1,s2]   # register (references only)
               # --host-key may be REPEATED / comma-separated to pin BOTH the
               #   ed25519 AND rsa keys (multi-host-key, H2.3)
               # sync defaults OFF for custom/root-transport connectors (M1);
               #   --sync forces it on, --no-sync forces it off
hub remote show <id> [--json]                  # config + resolved skills
hub remote diff <id> [--json]                  # dry-run plan: per-artifact drift (no writes)
hub remote sync <id> [--force] [--strict]      # sync one remote now (--strict exits non-zero on an alarming failure)
hub remote resolve <id> --artifact NAME --op push|pull|keep-local|keep-remote
               [--kind skill|mcp|agent_doc]    # explicit drift/conflict resolution
hub remote disable <id> [--revoke-key] [--yes] # set sync_enabled=false (optionally revoke the box key too)
hub remote enable <id>                         # set sync_enabled=true
hub remote remove <id> [--revoke-key] [--yes]  # unregister: drop registry entry + sidecars (--revoke-key off-boards the box key first)
hub remote revoke-key <id> [--yes] [--json]    # surgically remove THIS connector's installed authorized_keys line (H2.1)
hub remote repin <id> [--accept SHA256:…] [--yes] [--json]   # audited host-key rotation: OLD→NEW, re-seed known_hosts (H2.2)
hub remote rotate-token <id> [--json]          # rotate a keychain token (no-op for token-less SSH connectors; gateway = Wave 5)
hub remote clear <id>                          # forget ownership (clear sidecars only; box untouched)
hub remote import-skill [NAME] --remote <id> [--scan] [--json]   # adopt a box-native skill (origin: remote:<id>)
hub remote keyscan <ssh-host> [--json]         # fetch live SHA256 host-key fingerprint (TOFU; pre-registration)
hub remote setup-key [<id>] [--ssh-host H] [--json]   # one-time ssh-copy-id (id OR raw host)
hub remote fetch-doc <id> --doc SOUL.md|MEMORY.md|USER.md [--json]   # fetch agent-doc content (read-only)
hub remote push-doc <id> --doc … [--force]     # push edited agent-doc (content on stdin; drift-checked)
hub remote health <id> [--json]                # reachable / authenticated / host-key-match
hub remote doctor [--json]                     # risk scan across all remotes
```

Notes:
- `remote diff`, `show`, `list`, `health`, `fetch-doc`, `keyscan`, `clear` are
  read-only; the rest mutate the registry, sidecars, or the box.
- `remote resolve --kind` defaults to `skill`. `push-doc` reads the new content
  from **stdin** (never argv) and refuses if the remote doc drifted since the Hub
  last touched it (sidecar base ≠ live remote sha) unless `--force`.

## `hub remote doctor`

Per remote, exit non-zero (code 2) on any **danger** finding (matching
`permissions doctor`):

| Code | Severity | Meaning |
|---|---|---|
| `host-key-mismatch` | **danger** | live fingerprint ≠ pinned `host_key_sha256` — possible MITM; sync will hard-fail |
| `unknown-connector` | **danger** | the remote's `connector` key is not registered |
| `host-key-unpinned` | warning | no pin set (TOFU not completed) |
| `host-key-unreadable` | warning | could not read the live key to verify the pin |
| `unreachable` | warning | `sync_enabled` but the box is down — sync silently skips it |
| `unresolved-drift` | warning | artifacts in `remote-drifted`/`conflict` that sync silently skips |
| `stale-sidecar` | warning | a sidecar name that is neither desired nor present on the box (ownership rot) |
| `health-error` / `plan-error` | warning | the health check or plan computation errored |

A down box does **not** raise a false danger: mismatch is detected only by the
authoritative live-fingerprint comparison, never inferred from
`health.host_key_match` (which is also False when merely unreachable).

## Off-boarding / credential lifecycle (H2)

A connector install is **two-sided**: the registry holds references and the box
holds an `authorized_keys` line that trusts the Hub. Removing the registry entry
(`hub remote remove`) does NOT revoke that trust — the box still accepts the
Hub's key. These commands close that loop. None of them run automatically; box
writes are explicit and confirmed.

### `hub remote revoke-key <id>` (H2.1)

The inverse of the key install — surgically removes ONLY this connector's
Hub-installed `authorized_keys` line, matched by the key body (never a blunt
truncate); every other line is preserved byte-for-byte. The file is rewritten
atomically. Idempotent (a second run is a no-op).

- **Hermes** (non-root `hermes`): drops the Hub's own pubkey line from
  `~hermes/.ssh/authorized_keys`, over the connector's own transport.
- **codex-workers** (root): drops the
  `command="/usr/local/bin/codex-skill-apply",restrict <dedicated-pubkey>` line
  from **root's** `authorized_keys`, matched by the dedicated key body AND the
  forced-command path — the user's own root key is untouched. The write uses the
  user's root SSH (the dedicated restricted key can only run the helper, not edit
  `authorized_keys`).

Shows the line(s) to remove + a confirm; pass `--yes` for headless. Also wired
into `hub remote remove --revoke-key` (off-boards before de-registering) and
offered by `hub remote disable` (run with `--revoke-key`, else a hint is printed).

### `hub remote repin <id>` (H2.2)

Audited host-key rotation. A bare pinned fingerprint hard-fails every op after a
legitimate host rekey with no recovery path — this is it. Fetches the live
fingerprint (`--accept SHA256:…` to pin a specific known-good value instead),
shows **OLD vs NEW**, requires confirmation (`--yes` headless), replaces the
registry pin, re-seeds the Hub-owned `known_hosts` (drops the stale entry, adds
the new), and audit-logs the rotation. Only proceed when you KNOW the rotation is
legitimate (a rekey, not a MITM).

### Multi-host-key pinning (H2.3)

`host_key_sha256` may be a single value OR a list (ed25519 **and** rsa) so a
key-type change isn't a false mismatch. `verify_host_key` accepts the live key if
**any** pinned fingerprint matches and seeds every matching `known_hosts` line
(still only pinned lines — never an un-pinned key). Pin both at add-time with a
repeated or comma-separated `--host-key`.

### `hub remote rotate-token <id>` (H2.4)

For an SSH connector there is no bearer token (auth is ssh-agent / the dedicated
key) → no-op with a message. For a future gateway connector carrying a
`secret_ref`, it overwrites the keychain entry with a new value read from
**stdin** (never argv). Wave 5 fills in the gateway side.

### Manual reversal (full off-boarding)

If you prefer to do it by hand, or to fully decommission a connector:

1. **Delete the keychain entries.** Remove any `secret_ref` value and the
   dedicated codex key store:
   - the connector's `secret_ref` (if any) from the OS keychain;
   - the dedicated codex-workers keypair under
     `<data_home>/state/codex-workers/codex_workers_ed25519{,.pub}`.
2. **Drop the host-key pin** — `hub remote remove <id>` (clears the registry
   entry) or hand-edit `host_key_sha256` out of the `remotes:<id>` block.
3. **Remove the box helper + its authorized_keys line** (codex-workers only):
   ```
   ssh root@<box> "rm -f /usr/local/bin/codex-skill-apply"
   ssh root@<box> "sed -i '\\#codex-skill-apply#d' /root/.ssh/authorized_keys"
   ```
   (or run `hub remote revoke-key <id>` first, which does the surgical
   `authorized_keys` line removal; then delete the helper binary.)
4. **Hermes**: remove the Hub's pubkey line from `~hermes/.ssh/authorized_keys`
   (`hub remote revoke-key <id>` does this surgically).

### L1 — surfacing real failures

`_run_remote_dispatch` distinguishes **unreachable** (expected; quiet/info — a
down box never blocks) from **alarming** failures: a host-key mismatch (possible
MITM), an auth refusal, or an integrity/signing failure. `hub sync
--strict-remotes` and `hub remote sync <id> --strict` **exit non-zero** on an
alarming failure (mirrors the permissions doctor's danger-exit). The default
stays non-blocking — alarming failures are printed prominently but do not fail an
ordinary sync unless `--strict`.

## Adding a new connector

1. Subclass `RemoteConnector` (`connectors/base.py`): set `key` and `publishable`,
   implement `capabilities`, `health_check`, `list_remote_artifacts`,
   `fetch_artifact`, `plan` (no mutation), `apply` (honor the `allow` set), and
   `pull_artifact`. Reuse the generic infrastructure — `drift.classify`, the
   ownership `sidecar`, the `transport/` (ssh / keychain / audit), and the
   `layouts/` helpers (`agentskills`, `yaml_mcp`). Do **not** import another
   connector.
2. Register it: `register_connector(MyConnector())` at import time (a publishable
   connector imports from `connectors/__init__.py`).
3. **Location.** A publishable connector lives under `connectors/`. A
   **custom/private** connector (`publishable = False`) lives under
   `connectors_private/` — the tree the publish git-archive excludes (like
   `openspec/`) — and registers itself from there. The custom control-plane
   connectors are exactly this case and are a separate sibling change.
4. The dispatch resolves a `DesiredState` only for the surfaces the connector
   advertises via `capabilities()`, so a skills-only connector need not handle MCP
   or docs.

## App surfaces

- **Remotes screen** (`/remotes`, `remote` rail icon; detail at `/remote/:id`):
  `RemotesScreen.tsx` + `components/remotes/` (`AddRemoteWizard`, `RemoteDetail`,
  `DriftBadge`, `RemoteDocEditor`). The wizard handles onboarding; the detail view
  shows the diff plan, drift badges, and the SOUL/MEMORY/USER doc editor.
- The Rust layer (`app/src-tauri/`) only marshals the `hub remote …` subcommands —
  no ssh / ssh-keyscan / ssh-copy-id business logic lives in Rust.

## Troubleshooting

- **`not ready (reachable=… auth=… host_key=…)`** during sync — the remote was
  skipped (non-blocking). Run `hub remote health <id>` for detail. `auth=false`
  usually means the pubkey isn't authorized: re-run `hub remote setup-key`.
- **`host key … does not match the pinned fingerprint(s)`** — either the box was
  legitimately rekeyed (recover with `hub remote repin <id>` — audited OLD→NEW
  re-pin + known_hosts re-seed) or it is a genuine MITM. Sync hard-fails and
  touches nothing until resolved; `hub remote doctor` flags this as **danger**,
  and `hub sync --strict-remotes` exits non-zero.
- **`remote-drifted` / `conflict` reported but not applied** — expected; sync never
  clobbers the box. Inspect with `hub remote diff <id>`, then `hub remote resolve
  <id> --artifact <name> --op pull|push|keep-local|keep-remote`.
- **`ruamel.yaml is required …`** on a config edit — the `mcp_servers` /
  `external_dirs` edit was skipped (fail-closed) but skills still pushed; install
  or vendor `ruamel.yaml`.
- **`keyring` unavailable** — secret resolution fails closed (no fallback); install
  the `keyring` library / a working OS keychain backend.

## Implementation

`remotes.py` (the `remotes:` block + `RemoteTarget`), `connectors/` (the framework
+ Hermes), `hub.py` `build_remote_desired_state` / `_run_remote_dispatch` /
`cmd_remote_*`, and the app surfaces above. Design/decision rationale lives in
`openspec/changes/remote-connectors/{design,DECISIONS}.md`.
