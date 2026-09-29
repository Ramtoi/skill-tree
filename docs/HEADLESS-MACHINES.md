# Headless machines

A headless machine follows selected project loadouts from Skill Tree. The Mac
publishes signed revisions to a private Git repository. It can ask the receiver
to apply immediately over pinned SSH; a systemd user timer also checks the feed
while the Mac is offline. Neither path rewrites Git history.

The connector ships with Skill Tree. Machine hosts, fingerprints, repository
URLs, checkout mappings and setup progress live in the private data home. A
missing or unreachable receiver does not stop local sync or another target.

## Set up a machine

Open **Remotes → Add remote → Headless machine**. Give it an id and an SSH host
or alias. Fetch the host key, compare its fingerprint with the machine, and
confirm it. You can save a draft and resume it later.

1. Test the connection using your SSH agent and configuration.
2. Install the receiver. It needs Linux, Python 3.9 or newer and Git. Installation
   goes under `~/.local/share/skill-tree/receiver` in the remote user account.
3. Configure a separate private Git feed. The Mac needs write access; configure
   read-only feed access for the receiver. Skill Tree does not create credentials
   or verify repository access-control policy for you.
4. Select a source project and installed providers. Discover or enter the remote
   primary checkout, choose its Git remote, and explicitly confirm the mapping.
   A candidate is only a suggestion. A path-only project can use an explicit
   manual mapping; neither GitHub CLI nor a repository is mandatory.
5. Preview the publication. Resolve blockers and approve receiver-wide changes.
   Apply the reviewed plan and start periodic delivery.

**Settings → Remotes** supplies the polling default for new drafts. Each machine
keeps its own interval, between 30 and 3600 seconds. Changing the default does not
reconfigure existing receivers. The timer needs a systemd user manager. Whether
it survives logout depends on the server's existing session configuration.
Onboarding reports partial or failed timer activation instead of claiming ready.

## Delivery and local edits

Published and applied revisions are separate observations. A successful Git push
with an offline receiver means *published, waiting for receiver*. Immediate
application uses the same receiver operation as periodic pull. Reviewed immediate
delivery also checks the exact preview digest before writing.

Preview publishes to the feed. An active receiver can pick that revision up on
its next poll. Pause first if you need to review before any delivery. Pause leaves
files in place and prevents new receiver writes and ordinary Mac publication.

The receiver writes only in confirmed checkouts and approved provider locations.
It checks repository and directory identity again before delivery. It blocks on
edited managed files and existing unowned destinations. It never silently imports
server edits into the Mac's registry or overwrites them. Review the reported
paths, reconcile the edit on the Mac or receiver, then preview again. Removing a
binding retains its files.

The receiver limits expanded file images to 128 MiB of base64 data, counting each
destination and its existing content. Shared feed assets count again for each
checkout that receives them. Native settings share this budget. Oversized plans
stop before delivery; the recovery journal has a separate 384 MiB limit that
includes ownership metadata and applied state.

A receiver code update changes its installation identity. Review and reconfirm
checkout mappings before delivering again. Repairing an identical package is
idempotent. Ordinary periodic CLI process restarts preserve the identity.

Delivery includes skill trees and invocation metadata, native MCP settings,
permissions, hooks and sub-agents for supported provider scopes. Project-native
settings are included with the project. Global native categories are opt-in per
binding; global agents also require explicit names. Review the native values and
script contents in the preview before approval. A changed native authority or
executable payload needs fresh approval. Unrelated server settings survive native
updates, and even equal pre-existing entries remain locally owned.

Codex project hooks and project agents are blocked because the current provider
adapters support them only globally. Unsupported permission forms, hook settings,
conditional companions and unportable commands also block the required delivery.
Use managed hook scripts and environment references for MCP credentials. Receiver
PATH executables and environment variables must already be available to its user
timer. Provider project trust, hook trust and login credentials remain local to
the server; applied files do not imply the provider has granted trust.

V1 prepares the confirmed primary checkout. It does not prepare agent-created
worktrees or guard provider launch. Removing a binding retains files and native
entries. A retained native entry shared with an active binding can remain unchanged.
Changing it blocks until its contributors are reconciled. Removing an owned setting from
an active loadout requires a reviewed native approval before cleanup.

## Reconnect from a new Mac

A receiver keeps one applied channel. A different Mac cannot take over that
channel by mistake. Plain `Configure receiver` refuses the change and reports
`channel_rotation_required`.

The app then shows the conflict: the receiver's current publisher key id, this
Mac's key id, and the last applied generation. Use `Reconnect receiver` to
replace the channel with this Mac's identity. Reconnect keeps the applied
files in place. It pauses delivery and clears prior approvals. It does not
delete anything on the receiver.

After reconnect, review each project mapping, preview the delivery, approve
any native changes, and resume delivery. The receiver stays paused until you
resume it. The next publication starts a new signed chain. Native changes
need a fresh approval.

Reconnect needs the current receiver package. If the receiver is older, the
app reports: "The receiver could not run the reconnect command. Repair the
receiver installation, check the connection, and retry." Run `Repair
receiver installation` first, then reconnect.

CLI: `hub remote machine configure ID --replace-channel`.

## CLI

`hub remote machine list --json` and `show ID --json` read saved setup without
contacting the machine. Explicit `connect`, `install`, `configure`, `discover`,
`bind`, `reconfirm`, `preview`, `approve`, `start`, `status` and `pause` perform the
corresponding operation. Run each with `--help` for arguments. The installed
receiver launcher exposes only `hub receive` commands.

Machine installation packages the current Skill Tree bundle and its vendored
dependencies. The desktop build includes them. When running the Mac-side CLI
from a source checkout, first run `bash scripts/vendor-deps.sh` to prepare that
checkout. A checkout with only pip-installed dependencies is not a prepared
receiver bundle; installation reports incomplete dependencies before sending it.

This feed is a deployment channel. Backup remains the recovery/archive feature;
a backup cannot create receiver-local checkout confirmations. Complete receiver
onboarding before enabling delivery on a new machine.
