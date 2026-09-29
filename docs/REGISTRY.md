# Registry data model

The shape of `registry.yaml`, the single source of truth for skills,
bundles, projects, remotes, and cloud targets. Field-by-field reference
plus the resolution rules that turn this data into what actually syncs.

```yaml
harnesses_global: [claude-code]    # top-level: harnesses always on for every project

agent_docs:                        # top-level: canonical-root derivation strategy
  root_strategy: symlink           # symlink | import (default symlink when absent)

permissions_global:                # top-level: canonical permission list applied to every project
  allow: [{pattern: "Bash(npm:*)", kind: allow}]
  deny: []
  ask: []
  hooks: []
  sandbox_mode: workspace-write    # Codex-only typed setting
  approval_policy: on-failure      # Codex-only typed setting
  additional_dirs: []
  extras: {}                       # forward-compat escape hatch
  _unmanaged: []                   # harness ids opted out of hub management

worktree_defaults:                 # optional defaults copied only into new projects
  location: shared-directory       # shared-directory | project-subdirectory
  base_dir: ~/Dev/worktrees         # retained when location is project-subdirectory
  access_enabled: false             # saved project worktree_access.enabled value
  include_in_backup: false          # include this block in portable backups

projects:
  <name>:
    path: /absolute/path
    bundles: [android, openspec]   # assigned bundles
    enabled: [extra-skill]         # individual skills outside any bundle
    harnesses: [pi]                # additive to harnesses_global
    agent_docs:
      root_strategy: import          # optional per-project override of the global strategy
      publish_on_save: true          # optional; publish saved root docs to origin/main
    permissions: {}                # per-project permissions block — same hybrid shape as permissions_global
    invocation_overrides:          # per-skill invocation override for THIS project
      extra-skill: user-only       # auto|user-only|model-only; portable/project-specific skills only
    companions:                    # per-skill ownership LEDGER of provisioned ships_with companions
      <skill>:                     #   ({pattern, kind} dicts here — the skill's own mirror below uses bare strings)
        agents: [orch-implementer]
        hooks: [orch-scope-guard]
        permissions: [{pattern: "Bash(git push --force:*)", kind: deny, added: true}]  # added: this ledger added it
        provisioned_at: "2026-09-05T00:00:00"
        schema: 2                  # absent = v1; backfilled to 2 on the first `hub sync` reconcile pass
        hook_state:                # per-hook baseline the reconcile pass compares against; a {ref} hook has no def_sha256
          orch-scope-guard: {origin: inline, def_sha256: "<64hex>", attached: true}
        agent_state:                # per-agent baseline; files.<harness>.written: false = pre-existing (D9 copy path)
          orch-implementer:
            source_sha256: "<sha of <skill>/agents/orch-implementer.md at provision time>"
            files: {claude-code: {sha256: "<rendered file bytes>", written: true}}

skills:
  <name>:
    classification:          # optional manual assignments; registry-owned
      classes: [process, delivery]
      working_mode: mixed    # inline | delegator | mixed
      outputs: [plan, PR]
      interaction_style: checkpointed  # conversational | checkpointed | autonomous
      maturity: confident   # experimental | confident | trusted
    refs_ignore: [proof-it]  # body mentions that are NOT references (CLI-managed)
    ships_with:               # mirror of the skill's own SKILL.md `ships_with:` frontmatter — D1 shape
      agents: [orch-implementer]                          #   verbatim (permissions as BARE pattern
      permissions: {deny: ["Bash(git push --force:*)"]}   #   strings; only the ledger above uses dicts)
      hooks:                                               #   a hook entry is inline (as above) OR
        - {ref: lsp-report}                                #   {ref: <hooks-library name>} — attached as-is,
                                                            #   never copied; a vanished library entry surfaces
                                                            #   as `COMPANION_REF_MISSING` on the doctor

bundles:
  <name>:
    description: "..."
    icon: "📦"
    scope: global | portable | project-specific  # only global auto-applies to all projects
    skills: [skill1, skill2]          # order is preserved on every write; nothing reads it today
    playbook:                         # optional presentation order for bundle readers
      - id: unsectioned               # reserved loose-members section; title must be empty
        title: ""
        skills: [skill1]
      - id: foundations
        title: "Foundations"
        guidance: "Start here"
        skills: [skill2]
    source: org-skills                # optional: LINKED bundle — membership follows this external
                                      # source on every `source sync` (new skills append, upstream-
                                      # removed drop); --skills edits refused until --detach-source

sources:                             # top-level: external skill sources (git checkouts cached in data_home/sources/<id>/worktree)
  <id>:                              # immutable slug; skills point back via origin.source
    type: git
    name: "Org Skills"               # free display name — rename via `hub source edit <id> --name`
    url: https://github.com/org/skills
    enabled: true                    # absent = true; false keeps skills registered but excludes them from every sync pass
    include: [unslop, review]        # optional CURATION filter: the only upstream skill names this
                                     #   source may auto-register. Absent = follow the repo in full;
                                     #   `[]` = nothing new follows (a real filter, not an absent one).
                                     #   Written ONLY when an explicit add-time `selected_new` leaves out
                                     #   some discovered NEW candidate — a plain `source add git` never
                                     #   writes it. Contents = selected NEW ∪ ALL conflict names (whatever
                                     #   the decision) ∪ already-owned names; INVALID names never.
                                     #   A skipped conflict stays in the filter on purpose: it means
                                     #   "not now", so it must keep re-surfacing in `new_pending`.
                                     #   `source sync` classifies FIRST, then filters: only NEW candidates
                                     #   outside it are skipped + reported under `excluded` (CONFLICT and
                                     #   INVALID keep flowing to `new_pending`, never to `excluded`).
                                     #   Already-owned skills are never affected. Edit via
                                     #   `hub source edit <id> --include a,b` / `--include-all` (clear).
    # + branch/path/cache/status/refs/timestamps (see docs/ADDING-SKILLS.md)

remotes:                             # top-level: pluggable remote connector targets (references only)
  <id>:
    connector: hermes                # REMOTE_CONNECTORS key
    transport: {ssh_host: hermes@moon-base}  # connector transport coords
    host_key_sha256: SHA256:...      # pinned TOFU host-key fingerprint (also accepted under transport:)
    secret_ref: skill-hub:hermes-main  # OS-keychain handle — NEVER secret bytes
    home: ~/.hermes                  # remote home dir (connector default if omitted)
    sync_enabled: true               # include in the auto-sync dispatch pass
    bundles: [android]               # equipped (project equip model)
    enabled: [extra-skill]           # individually equipped skills

cloud:                               # top-level: manual-upload cloud targets (absent = nothing equipped)
  claude-ai:                         # id from the FIXED in-code CLOUD_TARGETS catalog
    bundles: [android]               # equipped (project equip model)
    enabled: [extra-skill]           # individually equipped skills
    apply_global_bundles: false      # hand-edit ONLY (no CLI/UI flag): opt into scope:global bundles
```

Resolved active skills = union(global-bundle skills) ∪ union(applied-bundle skills) ∪ `enabled`.

Effective harnesses for a project = `(harnesses_global ∪ project.harnesses) ∩ installed`.
Sync resolves both sets: skills land in each effective harness's `project_skills_dir`,
optionally narrowed by a skill's own `harnesses:` frontmatter. Codex, Pi, and
opencode share `.agents/skills/`, so enabling any of them produces writes to the
same dir (opencode also reads `.opencode/skills/` and `.claude/skills/` natively).

**Writes are scope-targeted (D1).** Global rules (`permissions_global`) are written **only** to
each harness's user-level file; a project's native file receives **only** that project's own block
(`resolve_project_own`). Hub never copies a global rule into a project file — the harness merges
user-level + project-level itself at runtime. Installs predating this are cleaned up by
`hub permissions migrate-scope`.

`projects.<name>.permissions.worktree_access` is a project-only intent. It is not part of the
effective global permission payload. The value contains `enabled` and an absolute `path`.

`worktree_defaults` affects genuinely new project registrations only. Registration resolves
one absolute directory and stores it in the project's `worktree_access` block, even when access
is disabled. Existing projects, renamed projects, and restored project records retain their
stored paths. A missing block means shared `~/Dev/worktrees`, access off, and backup inclusion
off; enabling inclusion is required before the block enters a portable snapshot.

**Effective permissions for a project** = `merge(permissions_global, project.permissions)` — a
**display/diagnostic view only** (`resolve_effective`, used by `show --effective`, the UI inherited
section, and the doctor), **never** what gets written. Project copy wins on `(pattern, kind)` rule
dedupe **only when harness affinities overlap** (an affinity-distinct global rule survives) and on
`(event, matcher, command)` hook dedupe; typed scalar fields (`sandbox_mode`, `approval_policy`,
`project_trust`) take the project value when present and fall back to global; `additional_dirs` and
`_unmanaged` are **set-unioned** (a project opt-out never discards a global opt-out). Every resolved
rule and hook carries an `origin: "global" | "project"` provenance tag.

## Skill classification

Each skill has one optional `classification` object across all bundle memberships.
Every field defaults to unset and can be cleared independently.
Clearing the last field removes the object.
Older registries need no migration.

Classes describe responsibilities. Classes and outputs accept custom text and reuse
values already assigned in the registry. Hub trims whitespace and removes duplicate
values with the same ASCII case-insensitive identity. It preserves the first spelling
and order. No separate class catalogue exists.

The app orders output presets as `prompt`, `plan`, `code change`, then `PR`.
Other outputs, such as reviews and research reports, follow that sequence.
This display order does not indicate quality.

Classification remains in the registry, including for external and starter skills.
It never changes `SKILL.md` or an upstream checkout. Working mode and interaction
style describe the skill. The adjacent triggering control retains its functional
behavior and existing ownership restrictions.

The app derives contributed classes and outputs from the complete saved skill-reference
graph. It follows outgoing references through every level and honors `refs_ignore`.
A reference records a connection, not proof that the parent executes another skill.
Working mode, interaction style, maturity, and triggering never propagate through references.

Each value appears once with its nearest provenance: assigned, direct reference,
then indirect reference. Inspection exposes all contributing simple paths.
Paths do not repeat a skill. Missing targets contribute nothing.
Derived values never become assignments automatically and are not stored in the object.

Library and bundle class filters default to **Assigned + references**.
**Assigned only** restricts class filters and grouping to manual assignments.
Working-mode filters and grouping always use assignments.
Class grouping can repeat a skill under several headings. Overall counts remain unique.

Backups preserve the classification object and its custom values.
See [Backup and restore](BACKUP.md) and [CLI commands](CLI.md).
