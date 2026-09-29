# Changelog

All notable changes to Skill Tree are recorded here. Versions follow
[semantic versioning](https://semver.org/); the version in `VERSION` is the
source of truth and is what the CLI, the app, and the release tag all report.

## [1.0.0] — 2026-09-28

The first release Skill Tree calls stable. The registry format, the `hub` CLI
surface, and the sync contract are frozen from here: a breaking change to any
of them gets a major bump. Everything since 0.9.0 is in this section.

### ✨ Added

#### 📊 Usage
- Durable usage history: a ledger, a backup row, and Claude Code stats import.
- Codex usage and a Codex transcript scanner next to the Claude Code one.
- Loadout analytics: transcript scanner, per-skill footprint, and a `hub usage` CLI.
- Project and session drill-downs, and Usage on every project surface.
- Guidance: Why, Review, equip cost, and the after-change delta.
- Token-activity heatmap, session measures, and the Over time band.
- Day, week, and month detail dialogs from any chart.
- Searchable skill filters on usage charts.
- Retained session evidence with incremental capture and tiered retention.
- Canonical summaries and own-token display.
- Session sheet Diff area: a read-only branch diff with honest fallbacks.
- Copy retained body text, and open registry skills from Usage in place.
- Prices disclosure, readable model names, and unpriced marks on the token bar.

#### 🔌 MCP servers
- `hub mcp add|set|show|list|remove` with remote transports and `${VAR}` secret references.
- Per-harness delivery rows, Claude approval and Codex trust gates, `hub mcp check`, and doctor findings.
- `hub mcp reconcile`: discover, classify, and adopt natively configured servers in one step.
- MCP editor panel: connection, credentials, delivery truth, and a live check.
- Add an existing server first, or adopt one from the Library.
- Capability catalogue captured on Check, with a CAPABILITIES block and browse sheet.
- Built-in control-plane server with tool annotations and structured results.

#### 🤝 Companions (ships with)
- A skill can declare the hooks, sub-agents, and permissions it ships with.
- Dense SHIPS WITH section, in-app companion editing, and reconcile on sync.
- Companions survive export, import, remote push, backup, and restore.
- Author companions from either direction: inline scaffolds, or "Ship with…" from Hooks, Sub-agents, and Permissions.
- Honest state when nothing, or something elsewhere, is provisioned.

#### 🔗 Skill references
- `hub skill refs`, a `missing_refs` sync finding, and `enable --with-refs`.
- Clickable references in every editor, a REFERENCES panel, and slash completion.
- Missing-reference badge and banner on the Loadout, with an equip guardrail.
- Renaming a skill rewrites its references everywhere.

#### 🖥️ Remotes and headless machines
- Deliver confirmed project loadouts to headless machines.
- Explicit remote publication controls in Settings.
- Reconnect a receiver from a new Mac: `hub receive configure --rotate` and `--replace-channel`.
- Cloud targets: `hub cloud equip|export|status` for claude.ai and ChatGPT, plus a Cloud apps band on Remotes.
- Skill sharing: `hub skill export` and `hub skill import` with a single `.skillpack` file.

#### 📚 Library and bundles
- Unified floating search over skills, MCP, bundles, and snippets, keyboard first, covering content.
- Adaptive filter row, and the Library remembers where you were.
- Bundle mode replaces the bundle detail screen; bundles arrange as editable playbooks.
- Bundle rename, global-scope toggle, emoji picker, and create a skill from a bundle.
- Linked bundles follow an external source until you detach it.
- Skill classification: responsibilities, reference contributions, and provenance-ordered chips.
- Built-in Starter Pack: `skt-mcp` and `skill-authoring` ship with the app as read-only skills.

#### 🧭 Projects, restore, and settings
- Rename a project from its header; `hub project rename`.
- Project loadout overview with grouped sources, and review missing skills before equipping.
- Global Settings with agent worktree defaults and opt-in worktree directory access.
- Restore: resumable recovery, explicit project attachment, and usage ledgers written back.
- Attention queue explains problems before you choose an action.
- Dropped-upstream skills: `hub source dropped` and `hub source recover`.
- Undoable archive: `hub archive` takes several skills and `hub unarchive` restores everything.
- Scoped source registration from a deep GitHub URL with an `include:` filter.
- Anonymous feedback from the app.

#### 🧩 Harnesses and invocation
- Native invocation modes per harness, with reported capability limits.
- Five delegation tiers with model and effort per harness.
- Global instructions shared across harnesses.
- Edit both harness models for a sub-agent from its skill.
- Side panels: harness doc panel and sub-agent editor.
- Integration corpus and inventory CLI.

#### 🪝 Hooks, permissions, snippets, and agent docs
- Hooks screen: what runs, where, and whether it is healthy.
- Hook scripts: read, reveal, or convert the script behind a shell-command hook.
- Compact expandable card for equipped project hooks.
- Permissions: save and apply in one step, a divergence doctor, and import a subset of rules.
- Snippets: "Save & update N", inline rename, `hub snippet rename`, and open originals from Agent Docs.
- Agent Docs: one map with a filter and `@` import following, safe root publish, actionable marker errors.
- Description length meter calibrated to the real harness limits.

### 🔄 Changed
- Contextual navigator: the rail picks a section, and the header follows where you came from.
- Every screen wears the same header, and section icons share one register.
- Sources screen overhaul: search, filter, sort, rename, and reversible disable.
- Backup screen reads as a guided journey before setup and a health summary after.
- Expandable icon rail with an optional labels mode.
- Agent-doc snippets pin to a trailing region of the document.
- The stylesheet is a token scale; Tailwind is gone.
- Every clickable element is a real control for keyboard and screen readers.

### 🐛 Fixed
- Sync wedge on suffix-registered source skills.
- Symlink sweeps only unlink targets in this install's managed subtrees.
- Self-deadlock on the data-home lock, and GUI `PATH` misses for Codex and `gh`.
- Source discovery no longer stops at a repo-root `SKILL.md`.
- Archive and rename prune bundles, remotes, cloud targets, and overrides.
- Skill editor keeps frontmatter and runs the bundled interpreter.
- Claude 5 pricing and ledger reprice; quoted credential redaction.
- Project MCP writers own only what hub wrote.
- Provisioning survives a harness with no sub-agents.
- Backup restore authentication and delivery feedback.
- Remote setup, checkout discovery, publication, polling, and resume controls.
- Built-in Skill Tree MCP setup on fresh installations.
- Menus no longer close on in-place scrolls; focus lands after commit.

### 🛠️ Internals
- Python engine organized by layer and subject behind one facade.
- Every CI gate runs on every PR: pytest, vitest, eslint, tsc, cargo, ruff, mypy.
- One seam per crossing: a single `hub.py` runner in Rust and one `hub_cmd` runner in the frontend, with parity tests.
- Tests fake `$HOME`; nothing can write into real dotfiles.
- Browser journeys consolidated; flaky tests are ledgered and owned.

### 🚀 Release engineering
- Development internals stay out of the public snapshot.
- `publish.yml` takes `build_macos` and `build_windows` inputs; the release body comes from this file.
- `scripts/preflight-publish.sh` reproduces the snapshot, guard, and mirror simulation locally.

### Known limitations

- Fresh-machine restore needs further verification. Recovery fixed the observed source delivery failures, but native folder selection and some restore status messages remain under review.
- Feedback submission is verified on Linux. macOS submission, email metadata, and behavior after form deactivation remain unverified.
- `hub update` does not implement automatic checks. The desktop updater is a separate feature.
- LiteLLM sources and harness configuration beyond Claude Code and Codex remain incomplete.
- The macOS `ccusage` helper supports Apple Silicon only in this build. Usage features that require this helper do not work on Intel Macs.
- Windows is best-effort and unsupported. This release has no verified Windows build.

## Earlier releases

These predate this file; each line is the release's headline, not its full
contents. See the [releases page](https://github.com/Ramtoi/skill-tree/releases)
for the tags.

- **0.9.0** — 2026-08-04 — Backup and restore as a portable git snapshot, the
  hooks surface plus a round of hardening, the public/private plugin boundary,
  a local agent usage dashboard, and the first (unsigned, unsupported) Windows
  installers.
- **0.8.0** — 2026-07-12 — The app ships its own CPython, so a machine with no
  system `python3` can still run it. Global agent-doc editor.
- **0.7.0** — 2026-07-11 — MCP server refresh: 27 tools down to 17 agent-first
  ones. Markdown browsing in the agent-docs view. Project renamed to Skill Tree.
- **0.6.0** — 2026-07-10 — Second UX audit: reliability fixes, honest empty and
  error states, a narrow-width contract, and a copy sweep.
- **0.5.0** — 2026-07-07 — Fresh-install onboarding audit and a first-run tips
  tour.
- **0.4.2** — 2026-07-07 — Snippets editor opened with a blank body.
- **0.4.1** — 2026-07-07 — Source id collisions were confusing to resolve.
- **0.4.0** — 2026-07-06 — Pluggable remote connectors and the per-skill
  invocation axis (`auto` / `user-only` / `model-only`, overridable per project).
- **0.3.0** — 2026-07-05 — UI responsiveness pass (the Tauri command layer went
  async), workspace UX polish, and the sanitized public mirror.
- **0.2.1**–**0.2.3** — 2026-06 — Self-updating app and CLI, plus onboarding
  fixes for a false "Python not detected".
- **0.2.0** — 2026-06-14 — The auto-updater.
- **0.1.0** — 2026-06-13 — First public release.
