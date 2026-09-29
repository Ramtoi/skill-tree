// `ships_with` (D1-D5, I2/A2/A5/A6/A11) — the pure module. No React import, no
// IPC of its own: every input here is a value the caller already holds (a
// parsed CLI payload, an already-loaded `Registry`). This is the ONE place the
// companion shapes are declared; `types.ts` imports `ShipsWith` and
// `CompanionLedgerEntry` from here for the `Skill`/`Project` registry fields.

import { CANONICAL_EVENTS, type CanonicalEvent } from "@/lib/hookCatalog";
import { parseCmdPayload } from "@/lib/hubWrite";
import { plural } from "@/lib/plural";
import type { Registry } from "@/types";
import type { RuleKind } from "@/types/permissions";

// ─── I2 + A2 + A5 + A6 shapes ─────────────────────────────────────────────

/** A2: the exit-2 payload gains a fourth kind for the Codex trust auto-grant
 *  row — never folded, never summarised (risk 3 / `NEVER_FOLD`). */
export type CompanionKind = "hook" | "agent" | "permission" | "trust";

/** Vocabulary of `hub skill companions`/exit-2 rows. Mirrors
 *  `harness_probe.py`'s four-verdict model plus `will_write` for "this hasn't
 *  landed yet but will". */
export type CompanionVerdict =
	| "will_write"
	| "already_present"
	| "unsupported"
	| "feature_off"
	| "not_installed";

/** A1: `project` was dropped after grill W12 — a project-attached hook is
 *  already project-scoped, so the word carried no information. */
export type CompanionActivation = "always" | "while-running";

/**
 * I5 (wave 2): per-harness provisioning state on a `hub skill companions`
 * read, replacing any use of `verdict` in the panel (D7 — glyphs are STATE,
 * not verdict words). `present`/`absent` are the project-less read's own
 * pair (never `pending` there — I5's own rule). `outdated` is an inline hook
 * whose definition changed and was re-synced in place (D11); `stale` never
 * renders a row (it means "no longer declared") — it reaches the user only
 * through the reconcile sentence/toast/log (plan 2 Risk 3).
 */
export type CompanionState =
	| "provisioned"
	| "pending"
	| "unsupported"
	| "drift"
	| "outdated"
	| "missing"
	| "stale"
	| "present"
	| "absent";

/** One row of the I2 `items[]` (also the shape of a `hub skill companions`
 *  row, plus `provisioned`, A5, and `state`/`route`, I5). */
export interface CompanionItem {
	kind: CompanionKind;
	/** Hook/agent name, rule pattern, or the literal `"trust_level"`. */
	name: string;
	harness: string;
	/** Path this item would land at (or already lives at). `null` for a
	 *  project-less read (W-4: the planner has no project scope to name a
	 *  target under) — a renderer must show a neutral "no file" wording
	 *  instead of handing `null` to `PathText`. Render a non-null value
	 *  through `PathText` — this module never truncates it. */
	target: string | null;
	verdict: CompanionVerdict;
	/** Required on `unsupported` / `feature_off` / `trust` rows. I5 widens
	 *  this to `| null` (a live read can know there is no reason to give); a
	 *  renderer binding this straight to a DOM `title`-typed prop must
	 *  coalesce `null` to `undefined` itself — this module never does that
	 *  for a caller. */
	reason?: string | null;
	/** Hooks only. */
	activation?: CompanionActivation;
	/** Agents only. */
	scope?: "user" | "project";
	/** Permissions only. */
	rule_kind?: RuleKind;
	/** A5: present only on `hub skill companions --project <p>` rows. */
	provisioned?: boolean;
	/** I5: per-harness provisioning state (D7). Optional here — never present
	 *  on the I2 exit-2 payload (`verdict` still drives that dialog), and a
	 *  pre-wave-2 fixture builds a `CompanionItem` without it. A real
	 *  `hub skill companions` read always populates it. */
	state?: CompanionState;
	/** I5/A21: the in-app path this row's name should navigate to. A rule's
	 *  `route` is AUTHORITATIVE — `/project/<p>?tab=permissions&focus=<kind>:
	 *  <enc(pattern)>` verbatim from the CLI; `lib/companionRoutes.ts` never
	 *  recomputes a rule's route, only an agent/hook row's. `null`/absent
	 *  when there is nothing to link to yet (e.g. a project-less read). */
	route?: string | null;
	/** D17/W2/S2: every scope whose companions ledger claims THIS EXACT
	 *  companion (hook/agent by name, rule by `(pattern, kind)`) — the
	 *  per-item twin of the payload's top-level `provisioned_on`. Optional:
	 *  a pre-D17 fixture and the exit-2 `needs_provisioning` payload never
	 *  carry it; no renderer reads it today (the row-level state/reason
	 *  already carry what a component needs), it exists so the wire shape
	 *  matches the CLI's one-to-one (`hub_cli/companions.py`). */
	provisioned_on?: string[];
}

/** The exit-2 payload printed by `hub enable <skill> --project <p>` when the
 *  skill ships companions and neither `--with-companions` nor `--skill-only`
 *  was passed (I1/A4). */
export interface NeedsCompanions {
	skill: string;
	project: string;
	items: CompanionItem[];
}

/** I3/A6: the MIRROR keeps bare pattern strings under `permissions`; only the
 *  LEDGER (`CompanionLedgerEntry`, below) pairs a pattern with its kind. */
export interface ShipsWithHook {
	name: string;
	event: string;
	tools?: string[];
	/** Relative to the skill dir in SKILL.md frontmatter; baked to an absolute
	 *  path in the registry mirror by the hub (plan 1). This module never cares
	 *  which form it's holding — it only ever renders/compares the string. */
	command: string;
	activation: CompanionActivation;
	harnesses?: string[];
}

/**
 * A18/C5: a declared hook is inline or a reference into the hooks library
 * (`{"ref": <name>, "name": <name>}` — `normalize_block` emits nothing else).
 * Both carry `name`, so every consumer that only needs the name (row keys,
 * `shippedBy`/`via` lookups, `groupRows`) tolerates a ref with zero special
 * casing; a consumer that needs `event`/`command`/`activation` must narrow
 * with `isHookRef` first and resolve those from the hooks library itself
 * (`["hooks","list"]`) — a ref never carries them inline.
 */
export interface ShipsWithHookRef {
	ref: string;
	name: string;
}

/** I3/A18: the declared-block hook shape — inline or a library reference. */
export type ShipsWithHookEntry = ShipsWithHook | ShipsWithHookRef;

/** Narrows a `ShipsWithHookEntry` to its reference arm. */
export function isHookRef(h: ShipsWithHookEntry): h is ShipsWithHookRef {
	return "ref" in h;
}

/** `skills.<n>.ships_with` — the D1 shape verbatim, mirrored from SKILL.md
 *  frontmatter by `sync_skill_frontmatter_metadata`, read-only from the
 *  registry side. `hooks` widened to `ShipsWithHookEntry[]` by A18. */
export interface ShipsWith {
	agents?: string[];
	hooks?: ShipsWithHookEntry[];
	permissions?: {
		allow?: string[];
		deny?: string[];
		ask?: string[];
	};
}

/** `{pattern, kind}` — the shape the LEDGER (never the mirror) uses for a
 *  permission row (A6). */
export interface RuleKey {
	pattern: string;
	kind: RuleKind;
}

/** `projects.<n>.companions.<skill>` (D4) — one project's ownership record for
 *  everything a skill's `ships_with` provisioned there. `agents` are user-scope
 *  and so shared across every project that provisioned them; the ledger only
 *  records that THIS project's equip put them there. */
export interface CompanionLedgerEntry {
	hooks?: string[];
	agents?: string[];
	permissions?: RuleKey[];
	provisioned_at?: string;
}

/** I5: the top-level per-state rollup, so the section's status line never
 *  recounts `items[]` itself. */
export interface CompanionsSummary {
	provisioned: number;
	pending: number;
	drift: number;
	missing: number;
}

/** A5/W9, extended by I5 — `hub skill companions <skill> [--project <p>]
 *  --json`. `project` is `null` for the project-independent (declaration-
 *  only) read AND for a `scope: global` skill's read (A17) — `project_context`
 *  is what tells the two apart.
 *
 *  `summary`/`project_context` are typed optional even though I5 pins them as
 *  always-present on a real read: a pre-wave-2 fixture
 *  (`test/ShipsWithSection.test.tsx`, predating this wave and rebuilt in the
 *  next one) constructs a `CompanionsPayload` without them, and widening a
 *  payload with new optional fields is the non-breaking way to extend it.
 *  Every derivation in this module that reads them (`statusLine`) treats an
 *  absent `summary` as all-zero and an absent `project_context` as `false`. */
export interface CompanionsPayload {
	skill: string;
	project: string | null;
	declared: ShipsWith;
	items: CompanionItem[];
	summary?: CompanionsSummary;
	/** True for a project read AND for a `scope: global` skill read against
	 *  `companions_global` (A17) — the status line then says "Provisioned
	 *  globally". */
	project_context?: boolean;
	/** D17: scopes whose companions ledger claims this skill — project names
	 *  plus the literal `"global"`. Optional here only for pre-D17 fixtures;
	 *  a real read always emits it (`[]` when nothing claims the skill). */
	provisioned_on?: string[];
}

// ─── I6 — `hub skill companions set <skill> {--json-stdin|--json-body}` ────
// (A15: the app always uses `--json-body` since Tauri's `hub_cmd` pipes no
// stdin.)

/** One agent in the I6 stdin/`--json-body` block. `from` names which
 *  existing definition to COPY into `<skill>/agents/<name>.md` when the file
 *  does not exist yet (D9); omitted/`null` means the file must already
 *  exist. */
export interface CompanionsSetAgent {
	name: string;
	from?: { harness: string } | null;
}

/** Wave 4c unit 1/2 (plans/3.md §3.1/§6.2): a scaffold REQUEST riding on a
 *  NEW inline hook's `set`-body entry — consumed and STRIPPED server-side
 *  (`_apply_set_body`) before `ships_with.normalize_block` ever sees the
 *  entry, so it never reaches the registry mirror or SKILL.md frontmatter.
 *  `template` is advisory only: the target `command`'s SUFFIX decides, and a
 *  mismatch is refused rather than silently picked (§6.2). */
export interface ShipsWithHookScaffold {
	template: "bash" | "python3";
}

/** One hook in the I6 `--json-body` block: a `{ref}`, or an inline
 *  definition optionally carrying `scaffold` (wave 4c unit 1/2). */
export type CompanionsSetHook = { ref: string } | (ShipsWithHook & { scaffold?: ShipsWithHookScaffold });

/** The whole-block replace body `hub skill companions set` validates and
 *  writes (D10). A hook is inline or `{ref}` — never `{ref, name}`: the
 *  `name` on `ShipsWithHookRef` is a read-side convenience this module adds
 *  when parsing the declared block back out of the mirror; the SET body
 *  only ever needs the ref's own name. */
export interface CompanionsSetBlock {
	agents: CompanionsSetAgent[];
	hooks: CompanionsSetHook[];
	permissions: { allow: string[]; deny: string[]; ask: string[] };
}

/** First stdout line of `hub skill companions set` (D10/I6): the normalized
 *  block plus the I7 reconcile result on success; `{ok:false,...}` on a
 *  validation failure (exit 1), `field` naming the offending path when
 *  known. `scaffolded`/`missing_commands` (wave 4c unit 1/2, §6.3) are
 *  additive and optional — an older CLI that predates them is unaffected. */
export type CompanionsSetResult =
	| {
			ok: true;
			skill: string;
			block: ShipsWith;
			reconcile: ReconcileResult;
			/** Absolute paths hub scaffolded THIS call (never a re-write of an
			 *  already-existing script — R3). */
			scaffolded?: string[];
			/** Skill-relative `command` values of declared inline hooks whose
			 *  file is absent on disk and which asked for no scaffold —
			 *  reporting only, no behaviour change (the `HOOK_BROKEN_SCRIPT`
			 *  doctor code is the enforcement). */
			missing_commands?: string[];
	  }
	| { ok: false; error: string; field?: string };

// ─── I7 — reconcile result ──────────────────────────────────────────────────
// Printed by `set`, by `hub sync --json`, and mirrored into the sync report
// at `projects.<p>.companions` / `global.companions` (A16) — so the Loadout
// banner and the navigator read it through the existing `sync_report()` IPC
// with zero new commands.
//
// R11 (milestone 6 review): this shape is aligned to `ships_with_reconcile.py`
// AS IT EMITS TODAY (`_new_scope_report`/`_clone_report`, and
// `hub_cli/companions.py`'s `_empty_scope_report`/`_skipped_report`), not to
// the earlier prose description — `drift`/`missing_refs` are objects, not
// bare names, and `skipped` is one discriminant, never a list. A future edit
// to either module must edit this comment's line references too.

/** `ships_with_reconcile.py:508-510` — `report["drift"].append({"skill":
 *  skill_name, "agent": name, "harnesses": diff_harnesses})`: an agent whose
 *  rendered file no longer matches at least one WRITTEN harness's recorded
 *  hash. */
export interface CompanionDriftEntry {
	skill: string;
	agent: string;
	harnesses: string[];
}

/** `ships_with_reconcile.py:335-337` — `report["missing_refs"].append({
 *  "skill": skill_name, "name": name, "ref": h["ref"]})`: a `{ref}` hook
 *  whose hooks-library entry has disappeared. */
export interface CompanionMissingRefEntry {
	skill: string;
	name: string;
	ref: string;
}

/** One project's (or the global scope's) reconcile outcome (D11/I7). Every
 *  list is present on a fresh write; the optional ones are upgrades a
 *  consumer must tolerate being absent on an older record. */
export interface ReconcileProjectRecord {
	/** declared − ledger: companion names ONLY (hook/rule/agent), never a
	 *  bare skill name (R27 — `ships_with_reconcile.py:309-320`'s no-ledger
	 *  branch used to push `skill_name` itself; it now pushes each declared
	 *  companion's own name). The app groups a scope's `pending` entries by
	 *  their owning skill from that skill's OWN declared rows — never from
	 *  this list. Never auto-written by sync; surfaced with a `Provision`
	 *  action. */
	pending: string[];
	/** ledger − declared: companion names, de-provisioned this run
	 *  (backup-first). */
	stale_removed: string[];
	/** An inline hook whose definition changed and was re-synced in place —
	 *  the hook's name. */
	reattached: string[];
	/** R11: objects, not names (`ships_with_reconcile.py:508`) — see
	 *  `CompanionDriftEntry`. */
	drift: CompanionDriftEntry[];
	/** R11: objects, not names (`ships_with_reconcile.py:336`) — see
	 *  `CompanionMissingRefEntry`. */
	missing_refs: CompanionMissingRefEntry[];
	/** v1 ledger rows upgraded to the schema-2 shape (W2) — agent/hook
	 *  names. */
	backfilled?: string[];
	/** Hand-edited away — nothing left to remove (W12) — companion names. */
	kept?: string[];
	/** Per-op failures — never fatal to the reconcile as a whole (W6) — free-
	 *  text messages, e.g. `"hook orch-x: <exception>"`. */
	errors?: string[];
	/** R11: a single discriminant, never an array
	 *  (`hub_cli/companions.py:800-815`) — `null` (nothing skipped, the I7
	 *  contract's normal value) or which stream `hub sync --skip-hooks`/
	 *  `--skip-permissions` planned-but-never-applied this pass. The real
	 *  payload always carries this key; typed optional here only because a
	 *  pre-existing fixture (`test/companionsReconcileToast.test.tsx`,
	 *  `test/projectLoadoutCompanions.test.tsx`, outside this wave's allowed
	 *  files) constructs a record without it. */
	skipped?: "hooks" | "permissions" | null;
}

export interface ReconcileResult {
	projects: Record<string, ReconcileProjectRecord>;
	global?: ReconcileProjectRecord;
}

// ─── I9 — `hub skill companions resolve` ───────────────────────────────────

/** `hub skill companions resolve <skill> --agent <n> --op keep-mine|keep-skill
 *  [--project <p> | --global]` (A20/C6). */
export type CompanionResolveOp = "keep-mine" | "keep-skill";

/** A13 — the first stdout line of `hub disable <skill> --project <p> --json`.
 *  Every list is present (possibly empty) so a caller never has to guard for
 *  an absent key. */
export interface RemovedCompanions {
	hooks: string[];
	agents: string[];
	permissions: RuleKey[];
}

export interface DisablePayload {
	removed_companions: RemovedCompanions;
}

// ─── Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse a `hub enable … --json` reply for the I2 `needs_provisioning` payload.
 * Reuses `parseCmdPayload`'s payload-first-line contract (A4: the payload is
 * printed before the auto-sync tail), so trailing sync chatter on the same
 * stdout never defeats the parse; a pretty-printed payload still falls
 * through to the tolerant parser. `null` on a plain failure or when the first
 * parseable object simply doesn't carry the field.
 */
export function parseNeedsCompanions(output: string): NeedsCompanions | null {
	const payload = parseCmdPayload<{ needs_provisioning?: NeedsCompanions }>(output);
	return payload?.needs_provisioning ?? null;
}

// ─── Provenance (A11) ──────────────────────────────────────────────────────

export interface CompanionsIndex {
	/** MIRROR lookup — project-independent (Hooks library, guardrails nav, the
	 *  user-scope sub-agent list). `null` when no registered skill's
	 *  `ships_with` declares this hook/agent name. */
	shippedBy(kind: "hook" | "agent", name: string): { skill: string } | null;
	/** LEDGER lookup — per project (project screens only). A hook/agent present
	 *  in the mirror but never provisioned on THIS project's ledger misses here
	 *  (it still answers `shippedBy`, never `via`). */
	via(project: string, kind: "hook" | "agent", name: string): { skill: string } | null;
	via(project: string, kind: "permission", key: RuleKey): { skill: string } | null;
}

/** Whether one project/global ledger ENTRY (one skill's claim) references the
 *  given hook/agent name or `(pattern, kind)` pair — the one place `via`,
 *  `removalConsequences` and the R28 global read share the match logic. */
function ledgerEntryMatches(
	entry: CompanionLedgerEntry,
	kind: "hook" | "agent" | "permission",
	key: string | RuleKey,
): boolean {
	if (kind === "agent") return (entry.agents ?? []).includes(key as string);
	if (kind === "hook") return (entry.hooks ?? []).includes(key as string);
	const wanted = key as RuleKey;
	return (entry.permissions ?? []).some(
		(p) => p.pattern === wanted.pattern && p.kind === wanted.kind,
	);
}

function viaLookup(
	reg: Registry | undefined,
	project: string,
	kind: "hook" | "agent" | "permission",
	key: string | RuleKey,
): { skill: string } | null {
	const entries = reg?.projects?.[project]?.companions;
	if (!entries) return null;
	for (const [skill, entry] of Object.entries(entries)) {
		if (ledgerEntryMatches(entry, kind, key)) return { skill };
	}
	return null;
}

/** R28: `registry.companions_global.<skill>` — the global-scope (A17) twin
 *  of `projects.<n>.companions`, written by `ships_with.py`'s
 *  `global_ledger`/`set_global_ledger_entry`. Not yet declared on the shared
 *  `Registry` type (`types.ts`, outside this wave's allowed files — a
 *  straight pass-through field the same way `cloud`/`remotes` are), so it is
 *  read here through a narrow local shape rather than widening `Registry`
 *  itself; a registry that predates A17 (or the type catching up later)
 *  simply has none, never throws. */
interface RegistryWithGlobalCompanions {
	companions_global?: Record<string, CompanionLedgerEntry>;
}

function globalLedgerMatches(
	reg: Registry | undefined,
	kind: "hook" | "agent" | "permission",
	key: string | RuleKey,
): boolean {
	const global = (reg as unknown as RegistryWithGlobalCompanions | undefined)
		?.companions_global;
	if (!global) return false;
	return Object.values(global).some((entry) => ledgerEntryMatches(entry, kind, key));
}

/** Builds the two-lookup provenance index (A11). Every read is a plain object
 *  scan — cheap enough to rebuild per render, so callers needn't memoise it
 *  themselves beyond whatever `useRegistry` already gives them. */
export function companionsIndex(reg: Registry | undefined): CompanionsIndex {
	return {
		shippedBy(kind, name) {
			const skills = reg?.skills ?? {};
			for (const [skill, def] of Object.entries(skills)) {
				const sw = def.ships_with;
				if (!sw) continue;
				if (kind === "agent" && (sw.agents ?? []).includes(name)) return { skill };
				if (kind === "hook" && (sw.hooks ?? []).some((h) => h.name === name)) {
					return { skill };
				}
			}
			return null;
		},
		via: ((project: string, kind: "hook" | "agent" | "permission", key: string | RuleKey) =>
			viaLookup(reg, project, kind, key)) as CompanionsIndex["via"],
	};
}

// ─── Dialog grouping (W7) ──────────────────────────────────────────────────

/** Kinds that are never folded and never summarised into the harness count —
 *  today just `trust` (risk 3): a future consequential kind is a one-line
 *  addition here, not a lost `if`. */
export const NEVER_FOLD: CompanionKind[] = ["trust"];

export interface HarnessGroup {
	harness: string;
	/** `will_write` items, excluding anything in `NEVER_FOLD` — summarised by
	 *  `harnessSummary`, itemised only behind the group's disclosure. */
	write: CompanionItem[];
	/** Everything else (not `will_write`, not `NEVER_FOLD`) — collapsed into
	 *  one neutral count line by the caller, using each item's `reason`. */
	folded: CompanionItem[];
	/** `NEVER_FOLD` items (the trust row) — always rendered in full, first. */
	pinned: CompanionItem[];
}

/**
 * Splits I2 `items[]` into one group per harness, each split into
 * write/folded/pinned (W7's default-collapsed dialog shape). `order` names the
 * harness display order; a harness present in `items` but absent from `order`
 * is appended afterward in first-encountered order, so a caller can never
 * silently lose a row by passing a stale/partial order list.
 */
export function groupByHarness(items: CompanionItem[], order: string[]): HarnessGroup[] {
	const harnesses: string[] = [];
	for (const h of order) {
		if (!harnesses.includes(h) && items.some((i) => i.harness === h)) harnesses.push(h);
	}
	for (const i of items) {
		if (!harnesses.includes(i.harness)) harnesses.push(i.harness);
	}

	return harnesses.map((harness) => {
		const forHarness = items.filter((i) => i.harness === harness);
		const pinned = forHarness.filter((i) => NEVER_FOLD.includes(i.kind));
		const rest = forHarness.filter((i) => !NEVER_FOLD.includes(i.kind));
		return {
			harness,
			write: rest.filter((i) => i.verdict === "will_write"),
			folded: rest.filter((i) => i.verdict !== "will_write"),
			pinned,
		};
	});
}

const SUMMARY_NOUNS: Partial<Record<CompanionKind, [string, string]>> = {
	agent: ["agent", "agents"],
	hook: ["hook", "hooks"],
	permission: ["rule", "rules"],
};

/** Ordered so the default sentence reads "will write N agents, N hooks, N
 *  rules" — the example shape W7 pins. */
const SUMMARY_ORDER: CompanionKind[] = ["agent", "hook", "permission"];

/** "will write 5 agents, 3 hooks, 2 rules" — the collapsed default row for one
 *  harness group. "nothing to write" when `write` is empty (every item for
 *  this harness was folded or pinned). */
export function harnessSummary(g: HarnessGroup): string {
	const parts = SUMMARY_ORDER.map((kind) => {
		const n = g.write.filter((i) => i.kind === kind).length;
		if (n === 0) return null;
		const [singular, pluralForm] = SUMMARY_NOUNS[kind]!;
		return `${n} ${plural(n, singular, pluralForm)}`;
	}).filter((s): s is string => s !== null);
	return parts.length > 0 ? `will write ${parts.join(", ")}` : "nothing to write";
}

const VERDICT_LABELS: Record<CompanionVerdict, string> = {
	will_write: "will write",
	already_present: "already there",
	unsupported: "not supported",
	feature_off: "feature off",
	not_installed: "not installed",
};

/** Neutral verdict word for one row — never a severity color (S2): a
 *  capability gap is neither provenance nor risk. */
export function verdictLabel(v: CompanionVerdict): string {
	return VERDICT_LABELS[v];
}

/** A1: `while <skill> runs` for `while-running`, `always on` otherwise
 *  (including an absent/`always` activation — hooks omit the field on nothing
 *  today, but a permission/agent row has no activation at all). */
export function activationWords(a: CompanionActivation | undefined, skill: string): string {
	return a === "while-running" ? `while ${skill} runs` : "always on";
}

/** "Removed 3 hooks, 5 agents, 2 rules" — the undo toast body (W7/C8). Omits
 *  any zero count; "Nothing removed" when every list was empty (a
 *  `--skill-only` equip's disable, say). */
export function removalSentence(p: DisablePayload): string {
	const r = p.removed_companions;
	const parts: string[] = [];
	if (r.hooks.length > 0) parts.push(`${r.hooks.length} ${plural(r.hooks.length, "hook")}`);
	if (r.agents.length > 0) parts.push(`${r.agents.length} ${plural(r.agents.length, "agent")}`);
	if (r.permissions.length > 0) {
		parts.push(`${r.permissions.length} ${plural(r.permissions.length, "rule")}`);
	}
	return parts.length > 0 ? `Removed ${parts.join(", ")}` : "Nothing removed";
}

// ─── D7 row grammar ─────────────────────────────────────────────────────────
// One dense row per companion. `declaredRows`/`groupRows` are the ONLY place
// a `ShipsWith` block gets flattened into rows — `CompanionRow` (wave B) is
// data-thin and never recomputes this itself.

export type DeclKind = "agent" | "hook" | "permission";

export interface DeclRow {
	kind: DeclKind;
	/** Agent/hook name, or the rule pattern. */
	name: string;
	/** Permission rows only. */
	rule_kind?: RuleKind;
	/** A18/C5: true when this hook row is a hooks-library reference rather
	 *  than an inline definition — a hover card must resolve its
	 *  event/command from the hooks library instead of the declared block;
	 *  every other consumer keys on `name` and doesn't care. */
	isRef?: boolean;
}

const DECL_GROUP_LABEL: Record<DeclKind, string> = {
	agent: "AGENTS",
	hook: "HOOKS",
	permission: "RULES",
};

/** Rule kinds in the same order the exit-2 payload builder walks them (deny,
 *  ask, allow) — an arbitrary but STABLE order, so the row list never
 *  reshuffles between renders. */
const RULE_KIND_ORDER: RuleKind[] = ["deny", "ask", "allow"];

/** Flattens a declared `ships_with` block into one row per companion — agents,
 *  then hooks, then permission rules, in that stable order — independent of
 *  any live read (D7). */
export function declaredRows(sw: ShipsWith): DeclRow[] {
	const rows: DeclRow[] = [];
	for (const name of sw.agents ?? []) {
		rows.push({ kind: "agent", name });
	}
	for (const hook of sw.hooks ?? []) {
		rows.push({ kind: "hook", name: hook.name, isRef: isHookRef(hook) });
	}
	for (const ruleKind of RULE_KIND_ORDER) {
		for (const pattern of sw.permissions?.[ruleKind] ?? []) {
			rows.push({ kind: "permission", name: pattern, rule_kind: ruleKind });
		}
	}
	return rows;
}

export interface CompanionGroup {
	kind: DeclKind;
	label: string;
	rows: DeclRow[];
}

/** Slices `declaredRows` into the three AGENTS/HOOKS/RULES sub-groups (D7's
 *  "said three times, not sixteen" label grammar) — a group with no rows is
 *  omitted entirely. */
export function groupRows(sw: ShipsWith): CompanionGroup[] {
	const rows = declaredRows(sw);
	const order: DeclKind[] = ["agent", "hook", "permission"];
	return order
		.map((kind) => ({
			kind,
			label: DECL_GROUP_LABEL[kind],
			rows: rows.filter((r) => r.kind === kind),
		}))
		.filter((g) => g.rows.length > 0);
}

// ─── D7 glyph state ─────────────────────────────────────────────────────────

/** The harness glyph's visual register (D7/S4 — "identity glyph, presence-
 *  dimmed"): `lit` = full-opacity brand mark, `dim` = `opacity: .38`,
 *  `unsupported` = dim + a slash, `none` = the glyph lights nothing at all
 *  (a `missing`/`stale` item has no meaningful per-harness presence to show —
 *  the row's neutral `Tag` carries that state instead, plan 2 Risk 3). */
export type CompanionGlyphState = "lit" | "dim" | "unsupported" | "none";

const GLYPH_STATE_BY_COMPANION_STATE: Record<CompanionState, CompanionGlyphState> = {
	provisioned: "lit",
	present: "lit",
	drift: "lit",
	outdated: "lit",
	pending: "dim",
	absent: "dim",
	unsupported: "unsupported",
	missing: "none",
	stale: "none",
};

/** Maps a per-harness `CompanionState` to the glyph's visual register — the
 *  ONLY place that mapping is decided (no component computes state). */
export function glyphStateFor(state: CompanionState): CompanionGlyphState {
	return GLYPH_STATE_BY_COMPANION_STATE[state];
}

// ─── D7 status line ─────────────────────────────────────────────────────────

export interface StatusLine {
	text: string;
	tone: "pending" | "drift" | "ok" | "idle";
	/** Whether a `Provision` rung should render alongside this line. */
	showProvision: boolean;
	/** F5: the idle branch's one rung — opens + scrolls the side panel's
	 *  `usedby` section (ConnectionsPanel's inline EquipPicker). */
	action?: { label: string; target: "usedby" };
}

/** The section head's ONE status line (D7/D13/D17): pending outranks drift (a
 *  drifted row still gets its own in-place `Tag`/menu — the header's job is
 *  to say whether anything needs a human decision RIGHT NOW), which outranks
 *  the plain "provisioned" acknowledgement. A project-less read gets four
 *  MORE branches below that, in order: the D17 ledger claim (truthful
 *  "Provisioned on …" without a project, replacing the pre-D17 silence a
 *  successful `--with-companions` equip left behind), an unresolved `{ref}`
 *  (F3 — one broken reference must not silence the whole section), the true
 *  pre-equip "nothing anywhere" case, and a residual hedge for the one shape
 *  the ledger can't explain (an agent present on disk with no ledger entry
 *  anywhere, e.g. hand-authored). `null` only when there is truly nothing to
 *  say — no project context, no ledger claim, no considered item at all. */
export function statusLine(payload: CompanionsPayload): StatusLine | null {
	const summary = payload.summary ?? { provisioned: 0, pending: 0, drift: 0, missing: 0 };
	const projectContext = payload.project_context ?? false;
	const provisionedOn = payload.provisioned_on ?? [];
	if (summary.pending > 0) {
		return {
			text: payload.project
				? `${summary.pending} pending on ${payload.project}`
				: `${summary.pending} pending`,
			tone: "pending",
			showProvision: true,
		};
	}
	if (summary.drift > 0) {
		return {
			text: `${summary.drift} ${plural(summary.drift, "drifted", "drifted")}`,
			tone: "drift",
			showProvision: false,
		};
	}
	if (projectContext) {
		return {
			text: payload.project ? `Provisioned on ${payload.project}` : "Provisioned globally",
			tone: "ok",
			showProvision: false,
		};
	}
	// D17: the project-less read's own truth — the ledger claims this skill
	// somewhere, so say where instead of asking the reader to re-equip it.
	// S1: the literal ledger-scope token `"global"` is not a project name —
	// spell it out — and the collapsed 4+ form says "scopes", not "projects"
	// (a skill can be claimed by project ledgers AND the global one at once).
	if (!projectContext && provisionedOn.length > 0) {
		const scopeLabel = (s: string) => (s === "global" ? "the global scope" : s);
		const text =
			provisionedOn.length <= 3
				? `Provisioned on ${provisionedOn.map(scopeLabel).join(", ")}`
				: `Provisioned on ${provisionedOn.length} ${plural(provisionedOn.length, "scope")}`;
		return { text, tone: "ok", showProvision: false };
	}
	// F3: a missing `{ref}` must not silence the section — it excludes itself
	// from `considered` below, so it needs its own line first.
	if (!projectContext && summary.missing > 0) {
		return {
			text: `${summary.missing} ${plural(summary.missing, "reference")} can't be resolved`,
			tone: "idle",
			showProvision: false,
		};
	}
	// F11(a): a consistency guard against `summary` disagreeing with `items`,
	// not a load-bearing condition — `considered.every(absent)` already
	// implies `summary.provisioned === 0` by construction.
	const considered = payload.items.filter(
		(i) => i.state != null && i.state !== "unsupported" && i.state !== "missing",
	);
	if (considered.length > 0 && considered.every((i) => i.state === "absent")) {
		return {
			text: `Not provisioned anywhere — equip ${payload.skill} on a project to install these`,
			tone: "idle",
			showProvision: false,
			action: { label: "Equip…", target: "usedby" },
		};
	}
	// F1: the one shape the ledger can't explain — some items are lit with
	// no ledger claim anywhere (e.g. a hand-authored agent file). A
	// project-less read genuinely cannot see a project-scoped hook/rule, so
	// this hedges rather than guessing.
	if (
		considered.length > 0 &&
		considered.some((i) => i.state === "absent") &&
		considered.some((i) => i.state !== "absent")
	) {
		return {
			text: "A project-less read can't see project-scoped hooks and rules — open this skill from a project for its real state",
			tone: "idle",
			showProvision: false,
		};
	}
	return null;
}

// ─── D9/Approach-9 the edit sheet's staged draft ───────────────────────────

/** The Sheet's three staged drafts, seeded from a declared block and
 *  converted back to the I6 block on Save — nothing is written per row
 *  (Approach 9). */
export interface CompanionsDraft {
	agents: string[];
	hooks: ShipsWithHookEntry[];
	permissions: { allow: string[]; deny: string[]; ask: string[] };
}

/** Seeds a staged draft from a declared `ships_with` block. */
export function draftFromDeclared(sw: ShipsWith): CompanionsDraft {
	return {
		agents: [...(sw.agents ?? [])],
		hooks: [...(sw.hooks ?? [])],
		permissions: {
			allow: [...(sw.permissions?.allow ?? [])],
			deny: [...(sw.permissions?.deny ?? [])],
			ask: [...(sw.permissions?.ask ?? [])],
		},
	};
}

/** Converts a staged draft into the I6 `--json-body` block (D10). A ref hook
 *  drops its convenience `name` field — the SET body's ref shape is
 *  `{ref}` only (never `{ref, name}`). */
export function blockFromDraft(draft: CompanionsDraft): CompanionsSetBlock {
	return {
		agents: draft.agents.map((name) => ({ name })),
		hooks: draft.hooks.map((h) => (isHookRef(h) ? { ref: h.ref } : h)),
		permissions: {
			allow: [...draft.permissions.allow],
			deny: [...draft.permissions.deny],
			ask: [...draft.permissions.ask],
		},
	};
}

// ─── I7 reconcile sentence ──────────────────────────────────────────────────

/** One (label, record) pair per scope this sentence/consequence reader
 *  walks: every project, PLUS the global (A17) record when present (R28 —
 *  a global-scope pending item or de-provision used to produce no sentence
 *  at all). `null` labels the global scope; every other label is a project
 *  name. */
function scopeEntries(
	result: ReconcileResult,
): Array<readonly [string | null, ReconcileProjectRecord]> {
	const entries: Array<readonly [string | null, ReconcileProjectRecord]> = Object.entries(
		result.projects ?? {},
	);
	return result.global ? [...entries, [null, result.global] as const] : entries;
}

/** "N pending on P" / "pending on N projects" (falling back to "…and
 *  globally" when the global scope also has a pending companion, R28) —
 *  plus `kept`/error counts when present — the leading clause of the save/
 *  sync toast (Approach 6/9; the toast itself, wave 2's
 *  `companionsReconcileToast`, appends the action and the removed-item
 *  names). "Reconciled" when every scope's record is empty across every
 *  field this sentence reads. */
export function reconcileSentence(result: ReconcileResult): string {
	const entries = scopeEntries(result);
	const pendingByScope = entries
		.map(([label, record]) => [label, record.pending.length] as const)
		.filter(([, n]) => n > 0);
	const totalPending = pendingByScope.reduce((sum, [, n]) => sum + n, 0);

	const parts: string[] = [];
	if (totalPending > 0) {
		if (pendingByScope.length === 1) {
			const [label, n] = pendingByScope[0];
			parts.push(label ? `${n} pending on ${label}` : `${n} pending globally`);
		} else {
			const projectCount = pendingByScope.filter(([label]) => label !== null).length;
			const globalPending = pendingByScope.some(([label]) => label === null);
			parts.push(
				globalPending
					? `pending on ${projectCount} projects and globally`
					: `pending on ${projectCount} projects`,
			);
		}
	}
	const totalKept = entries.reduce((sum, [, r]) => sum + (r.kept?.length ?? 0), 0);
	if (totalKept > 0) parts.push(`kept ${totalKept}`);
	const totalErrors = entries.reduce((sum, [, r]) => sum + (r.errors?.length ?? 0), 0);
	if (totalErrors > 0) parts.push(`${totalErrors} ${plural(totalErrors, "error")}`);

	return parts.length > 0 ? parts.join(" · ") : "Reconciled";
}

// ─── Removal consequences (Approach 9/W12) ─────────────────────────────────

/** The projects whose ledger currently references this companion — removing
 *  it from the declared block will de-provision it from each of these on the
 *  next sync/save — PLUS the literal `"global"` when the A17 global-scope
 *  ledger also references it (R28). The Sheet renders one line per returned
 *  label; wording (including how it renders `"global"`) is its job, not this
 *  module's. */
export function removalConsequences(
	reg: Registry | undefined,
	kind: "agent" | "hook" | "permission",
	key: string | RuleKey,
): string[] {
	const projects = Object.keys(reg?.projects ?? {}).filter(
		(project) => viaLookup(reg, project, kind, key) !== null,
	);
	return globalLedgerMatches(reg, kind, key) ? [...projects, "global"] : projects;
}

// ─── New inline hook authoring (wave 4c unit 2, plans/3.md §2.1/§3.1a/§6.3a) ─
// The sheet's `NewHookForm` front end over the same staged-script scaffold
// `hub_cli/companions.py._stage_hook_script` writes server-side. Pure — no
// React, no IPC.

const HOOK_SCRIPT_DIR = "scripts";
const HOOK_SLUG_RE = /[^a-z0-9]+/g;

/**
 * TS twin of `ships_with.default_hook_script_rel` (T9 pins parity):
 * "scope-guard" -> "scripts/scope-guard.sh". `null` when the name slugifies
 * to nothing (never a bare "scripts/.sh") — mirrors the Python function's
 * strip/lower/collapse-non-alnum-runs/strip("-") order exactly.
 */
export function defaultHookScriptPath(hookName: string): string | null {
	if (typeof hookName !== "string") return null;
	const slug = hookName
		.trim()
		.toLowerCase()
		.replace(HOOK_SLUG_RE, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) return null;
	return `${HOOK_SCRIPT_DIR}/${slug}.sh`;
}

/** §6.3a `HOOK_NAME_TAKEN`, split by SOURCE (not unioned) so a message can
 *  say WHICH one collided — `library` is the FULL hooks library (registry
 *  entries + shipped built-ins, registry shadowing), read by the caller from
 *  `useHookList()` (this module has no IPC of its own). */
export interface NewHookTaken {
	inline: string[];
	refs: string[];
	library: string[];
}

/** The `NewHookForm`'s four fields (§2.1: name, event, tools, activation —
 *  no matcher/harness/script-mode). */
export interface NewHookDraft {
	name: string;
	event: string;
	tools: string[];
	activation: CompanionActivation;
}

export type NewHookValidation =
	| { ok: true }
	| { ok: false; field: "name" | "event"; message: string };

/**
 * Validates a `NewHookForm` draft against the shared §6.3a name-taken set —
 * the form's own front end for the SAME refusal `_apply_set_body`'s inline
 * arm and `cmd_companions_new_hook` enforce server-side (the full set, no
 * carve-out: this form only ever CREATES, it never re-saves an already-
 * provisioned inline hook), so the sheet never sends a body the CLI will
 * bounce.
 */
export function validateNewHook(draft: NewHookDraft, taken: NewHookTaken): NewHookValidation {
	const name = draft.name.trim();
	if (!name) {
		return { ok: false, field: "name", message: "Name the hook." };
	}
	// Suggestion 12 (opus review 6-review-4c.md) — §5 asked for a slug-shaped
	// NON-EMPTY name check here: a name like "###" (all punctuation) slugifies
	// to nothing (`defaultHookScriptPath` returns `null`), yet nothing here
	// caught that — `Add` stayed enabled and `NewHookForm.handleAdd` only
	// discovered it via its OWN `!command` fallback, surfacing the unrelated
	// "Name the hook." message on a name that plainly was not empty. A name
	// with spaces/mixed case (e.g. "Scope Guard") is fine as a NAME — it
	// slugifies to a real path (`scripts/scope-guard.sh`) and is kept
	// verbatim, never silently rewritten.
	if (!defaultHookScriptPath(name)) {
		return {
			ok: false,
			field: "name",
			message: "Name must include at least one letter or digit.",
		};
	}
	if (taken.inline.includes(name) || taken.refs.includes(name)) {
		return {
			ok: false,
			field: "name",
			message: `'${name}' is already declared on this skill.`,
		};
	}
	if (taken.library.includes(name)) {
		return {
			ok: false,
			field: "name",
			message: `'${name}' is already a hooks-library definition — reference it instead.`,
		};
	}
	if (!CANONICAL_EVENTS.includes(draft.event as CanonicalEvent)) {
		return { ok: false, field: "event", message: "Choose an event." };
	}
	return { ok: true };
}
