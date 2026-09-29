/**
 * Restore-plan contract (`hub restore … --json` → `restore.py::build_plan`):
 * the normalized `RestorePlan`, its consent/apply predicates, and the typed
 * confirmation. Cut verbatim out of backupContract.ts (wave 24 of AUDIT.md);
 * backupContract.ts re-exports everything here so existing import paths stay.
 */
// PRODUCT_NAME is only read inside a function body at call time, so this
// import cycle with backupContract.ts (which re-exports this module) is safe.
import { PRODUCT_NAME } from "./backupContract";

// ─────────────────────────────────────────────────────────────────────────────
// Restore plan (`hub restore … --json`) — implemented (`restore.py::build_plan`)
// ─────────────────────────────────────────────────────────────────────────────

export type RestoreMode = "replace" | "merge";

/**
 * What each mode does, in ONE place, because two screens described `merge` with
 * OPPOSITE conflict rules immediately before an irreversible write: the
 * bootstrap fork said "keep what's here", the Backup screen said "the backup
 * wins conflicts".
 *
 * GROUND TRUTH — `restore.py::merge_registry`:
 *
 *     merged = dict(base); merged.update(value)   # value = the SNAPSHOT
 *
 * The union is taken, entries only this machine holds survive, and on any key
 * both sides hold **the backup overwrites**. The CLI's own `--mode` help says
 * the same ("union, backup wins on conflict"), so both UI strings were the
 * outliers and one of them was simply false.
 *
 * Every surface reads these constants, so a future divergence has to be a
 * deliberate edit here rather than a screen quietly inventing its own words.
 */
export const RESTORE_MODE_LABELS: Record<RestoreMode, string> = {
	merge: "merge — keeps what's only here; the backup wins conflicts",
	replace: "replace — take the backup wholesale",
};

/** The modes in the order they are offered. `merge` leads because it is the
 *  default and the non-destructive half of the pair. */
export const RESTORE_MODES: RestoreMode[] = ["merge", "replace"];

/** Mode-neutral summary for a collapsed row: names the pair and the one
 *  guarantee true of both — nothing is written before a preview. */
export const RESTORE_MODE_HINT = "merge or replace, previewed first";

/**
 * `integrity.trust.state` — the four-way verdict `restore.py::classify_trust`
 * folds a signature verdict and the pin store into.
 *
 * Two of them are **hard** (`hard: true`): no CLI flag overrides them and the
 * UI must offer no consent path — a pinned source signed by a different key is
 * exactly the substitution attack the pin exists to catch. The `unverified-*`
 * three are consent-gated and cleared by `--trust-new-key`, which also pins.
 */
export type RestoreTrustState =
	| "verified"
	| "unverified-new-key"
	| "unverified-unsigned"
	| "unverified-unavailable"
	| "key-mismatch"
	| "invalid-signature"
	| "unknown";

export interface RestoreTrust {
	state: RestoreTrustState;
	/** True only when the snapshot may proceed as-is (verified, or consented). */
	ok: boolean;
	/** True ⇒ refusal. Never render a checkbox for it. */
	hard: boolean;
	/** The CLI's own sentence. Shown verbatim; never re-worded. */
	detail: string;
	keyId: string | null;
	pinnedKeyId: string | null;
	/** `pinned_key_ids` — a source may hold more than one pinned signer (key
	 *  rotation). Falls back to the single `pinned_key_id` when absent, so the
	 *  older payload and the newer one both read the same way. */
	pinnedKeyIds: string[];
}

/** One file the restore writes OUTSIDE the data home (a harness agent dir or a
 *  global harness doc). `action` is `restore.py::_three_way`'s verdict. */
export interface RestoreOutOfHomeTarget {
	/** Absolute path actually written — the `.from-backup` sibling for `sibling`. */
	path: string;
	/** "sub-agent" | "global doc" */
	kind: string;
	/** write | sibling | overwrite */
	action: string;
	detail: string;
}

/** A single piece of executable state the restore would install. Enumerated
 *  verbatim in the confirm dialog — a hook command is arbitrary code that will
 *  run on this machine, so it is shown as-is, never summarized. */
export interface RestoreExecutableItem {
	/** "hook" | "permission" | "trust" | "connector" | "mcp-server" | anything
	 *  a later wave adds — rendered, not switched on. */
	kind: string;
	label: string;
	/** For a hook: the command string, verbatim. For a code dir: its section. */
	detail: string;
	/** Hook script path that doesn't exist on this machine (design §5). */
	broken?: boolean;
	/**
	 * True for a restored **code directory** — a connector or an MCP server that
	 * hub itself will import and execute, as opposed to a command it hands to a
	 * harness. Rendered as its own group: "a Python module this app imports" is
	 * a different thing to consent to than "a hook command your agent runs".
	 */
	code?: boolean;
	/** Code dirs only: `new` | `overwrite`. `identical` never reaches here. */
	action?: string;
	/** Code dirs only: the files the directory carries. */
	files?: string[];
}

export interface RestoreLostEntry {
	kind: string;
	name: string;
	detail?: string;
}

export interface RestoreConflict {
	kind: string;
	name: string;
	/** Which side wins under the chosen mode (backup wins on `merge`). */
	resolution?: string;
}

export interface RestoreUnresolvedProject {
	name: string;
	path: string;
}

export type RestoreWorktreeDefaultsStatus =
	| "added"
	| "changed"
	| "preserved"
	| "unchanged";

export interface RestoreWorktreeDefaultsValue {
	location: "shared-directory" | "project-subdirectory";
	base_dir: string;
	access_enabled: boolean;
	include_in_backup: boolean;
}

export interface RestoreMachineAbsolute {
	field: string;
	value: string;
	rewritten: boolean;
}

/** The settings-only registry diff. It never contributes to destructive
 * consequence counts because it changes configuration, not files or folders. */
export interface RestoreWorktreeDefaults {
	status: RestoreWorktreeDefaultsStatus;
	value: RestoreWorktreeDefaultsValue | null;
	/** The report row for `worktree_defaults.base_dir`, when the backend emitted
	 * one. No other machine-absolute report rows are exposed through this plan. */
	machineAbsolute: RestoreMachineAbsolute | null;
}

/** The normalized plan every consumer reads. */
export interface RestorePlan {
	/** The CLI's own verdict: false whenever ANY gate is unmet — including the
	 *  consent gates the UI exists to satisfy. Never gate the apply button on
	 *  this; use `fatal` / `error` / the `requires*Consent` flags. */
	ok: boolean;
	/**
	 * `fatal: true` ⇒ the snapshot itself cannot be trusted (truncated tree, bad
	 * signature, key mismatch). The plan is truncated after `manifest` and there
	 * is **no** consent path — the UI must refuse, not offer a checkbox.
	 */
	fatal: boolean;
	/** A hard, unfixable-from-the-UI refusal, ready to render. Consent-gated
	 *  errors are deliberately NOT folded in here — they are the flags below. */
	error: string | null;
	/** Every message the CLI listed, consent-gated ones included. */
	errors: string[];
	source: string;
	mode: RestoreMode | null;
	/**
	 * The inputs this plan was PREVIEWED with, frozen at request time.
	 *
	 * Load-bearing: the apply must be sent with the source/mode the user was
	 * shown consequences for, never with whatever the form holds at click time.
	 * Reading them back off the plan closes the window where a form edit and a
	 * stale dialog disagree — a restore is destructive, so "the dialog said A,
	 * the CLI got B" is not a survivable class of bug. `mode` above is what the
	 * CLI *echoed*; these are what we *asked for* (identical in practice, but a
	 * missing echo must not silently un-freeze the request).
	 */
	requestedSource: string;
	requestedMode: RestoreMode | null;
	/** `integrity.trust` — drives the unverified banner and the trust checkbox. */
	trust: RestoreTrust;
	/** `integrity.ok` — tree digest AND trust. False on any consent-gated state. */
	integrityOk: boolean;
	/** `integrity.tree_digest.ok` — false ⇒ the snapshot is incomplete/tampered. */
	treeDigestOk: boolean;
	/** `--trust-new-key` is required and CAN be given (never true when `hard`). */
	requiresTrustConsent: boolean;
	/** `executable_state.requires_consent` — `--accept-executable-state` needed. */
	requiresExecConsent: boolean;
	/** `registry.target_populated` — this machine already holds hub content. */
	targetPopulated: boolean;
	/** `registry.mode_required` — populated target and no `--mode` was passed. */
	modeRequired: boolean;
	/** Registry entries the TARGET machine loses by restoring. The headline
	 *  consequence — enumerated first in the confirm dialog. */
	lostEntries: RestoreLostEntry[];
	conflicts: RestoreConflict[];
	/** Hooks / permission rules / trust grants, flattened from the three arrays. */
	executableState: RestoreExecutableItem[];
	/** Legacy snapshot signatures did not cover these reference placements. */
	unverifiedReferences?: Array<{ path: string; target: string; sha256: string }>;
	/** Projects whose recorded path doesn't exist here — quarantined, sync skips them. */
	unresolvedProjects: RestoreUnresolvedProject[];
	/** Incoming or preserved global defaults for newly registered projects. */
	worktreeDefaults: RestoreWorktreeDefaults;
	/** Files the restore writes OUTSIDE the data home (harness agent dirs, global docs). */
	outOfHomeTargets: RestoreOutOfHomeTarget[];
	warnings: string[];
	/**
	 * Files this machine KEEPS that the snapshot does not carry — the
	 * `data.<section>.retained` lists plus `report.retained_extra_files`. The
	 * reassuring half of the disclosure: a `replace` does not mean "everything
	 * not in the backup is gone".
	 */
	retainedFiles: number;
	/** `report.audit_ledgers_note` — the CLI's sentence about append-only
	 *  ledgers that were merged rather than replaced. Shown verbatim or not at
	 *  all; `null` when the payload predates it. */
	auditLedgersNote: string | null;
	/** True whenever `trust.state !== "verified"` — the TOFU banner's condition. */
	unverified: boolean;
	/** Ordered next steps the CLI prints (restore never runs sync itself). */
	nextSteps: string[];
	/** True only on an apply reply that actually wrote (`apply: true`). */
	applied: boolean;
}

/** Read the first present key from a list of candidates. THE integration seam:
 *  a field rename on the Python side is one added string here. */
function pick<T>(raw: Record<string, unknown>, keys: string[], fallback: T): T {
	for (const k of keys) {
		const v = raw[k];
		if (v !== undefined && v !== null) return v as T;
	}
	return fallback;
}

function asArray(v: unknown): Record<string, unknown>[] {
	if (!Array.isArray(v)) return [];
	return v.map((item) =>
		typeof item === "object" && item !== null
			? (item as Record<string, unknown>)
			: { name: String(item) },
	);
}

function asStrings(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.map((item) =>
		typeof item === "string" ? item : String((item as { path?: string })?.path ?? item),
	);
}

function str(v: unknown, fallback = ""): string {
	if (typeof v === "string") return v;
	if (v === undefined || v === null) return fallback;
	return String(v);
}

function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

function worktreeValue(v: unknown): RestoreWorktreeDefaultsValue | null {
	const value = obj(v);
	if (
		(value.location !== "shared-directory" && value.location !== "project-subdirectory") ||
		typeof value.base_dir !== "string" ||
		typeof value.access_enabled !== "boolean" ||
		typeof value.include_in_backup !== "boolean"
	) {
		return null;
	}
	return {
		location: value.location,
		base_dir: value.base_dir,
		access_enabled: value.access_enabled,
		include_in_backup: value.include_in_backup,
	};
}

function worktreeStatus(v: unknown): RestoreWorktreeDefaultsStatus {
	return v === "added" || v === "changed" || v === "preserved" || v === "unchanged"
		? v
		: "unchanged";
}

/** `projects` → `project`, `hooks` → `hook`, … for the section tags. */
function singular(section: string): string {
	return section.endsWith("s") ? section.slice(0, -1) : section;
}

/** The three-way verdicts that actually put bytes on disk. `skip` (identical)
 *  and `unsupported` (no target for this harness here) write nothing, so
 *  listing them under "writes outside the data home" would be a lie. */
const WRITE_ACTIONS = new Set(["write", "sibling", "overwrite"]);

/** Where a `sibling` verdict actually lands, per `restore.py::apply_plan`. */
function writtenPath(target: string, action: string): string {
	return action === "sibling" ? `${target}.from-backup` : target;
}

/** Flatten the real `executable_state` object (three typed arrays) into the flat
 *  list the consent dialog enumerates. */
function flattenExecutableState(block: Record<string, unknown>): RestoreExecutableItem[] {
	const out: RestoreExecutableItem[] = [];

	for (const h of asArray(block.hooks)) {
		const name = str(h.name);
		const event = str(h.event);
		out.push({
			kind: "hook",
			label: event ? `${event} · ${name}` : name,
			// The command is the thing the user is actually consenting to — verbatim.
			detail: str(h.command),
			broken: h.broken === true,
		});
	}

	for (const rule of asArray(block.permission_rules)) {
		const pattern = str(rule.pattern);
		out.push({
			kind: "permission",
			label: `${str(rule.kind, "allow")} · ${str(rule.scope, "global")}`,
			detail: pattern,
		});
	}

	for (const grant of asArray(block.codex_trust)) {
		out.push({
			kind: "trust",
			label: `Codex trust · ${str(grant.project)}`,
			detail: str(grant.reason) || str(grant.path),
		});
	}

	// ── code_dirs: restored connector / MCP-server source ────────────────────
	//
	// These MUST be enumerated. `requires_consent` counts every non-`identical`
	// entry, so a snapshot whose only executable state is connector code would
	// otherwise present a consent dialog with an empty list — asking the user to
	// accept "the 0 items above". `identical` entries are skipped to match the
	// Python side exactly: a byte-identical directory installs nothing new and
	// is not something to consent to.
	for (const dir of asArray(block.code_dirs)) {
		const action = str(dir.action);
		if (action === "identical") continue;
		const files = asStrings(dir.files);
		out.push({
			kind: str(dir.kind, "code") || "code",
			label: str(dir.name) || str(dir.section),
			detail: str(dir.section),
			code: true,
			action: action || "new",
			files,
		});
	}

	return out;
}

/** Legacy/defensive path: an already-flat array of executable items. */
function flatExecutableArray(items: Record<string, unknown>[]): RestoreExecutableItem[] {
	return items.map((e) => ({
		kind: str(pick(e, ["kind", "type"], "item"), "item"),
		label: str(pick(e, ["label", "name", "id", "event"], "")),
		detail: str(pick(e, ["command", "detail", "pattern", "rule", "path"], "")),
		broken: pick<boolean>(e, ["broken", "missing", "script_missing"], false),
	}));
}

/** `integrity.trust` → the normalized verdict. An absent block is treated as
 *  `unknown` + not-ok: a plan we cannot read the trust of is not a trusted one. */
function toTrust(integrity: Record<string, unknown>): RestoreTrust {
	const raw = obj(integrity.trust);
	const hasState = typeof raw.state === "string";
	const pinnedOne = typeof raw.pinned_key_id === "string" ? raw.pinned_key_id : null;
	const pinnedMany = asStrings(raw.pinned_key_ids);
	return {
		state: (hasState ? (raw.state as RestoreTrustState) : "unknown") as RestoreTrustState,
		// Only an explicit `ok: true` counts. A missing trust block never reads as fine.
		ok: raw.ok === true,
		hard: raw.hard === true,
		detail: str(raw.detail),
		keyId: typeof raw.key_id === "string" ? raw.key_id : null,
		// The singular stays the headline (it is what the banner names); the
		// plural is the full pin set, defaulting to the singular when absent.
		pinnedKeyId: pinnedOne ?? (pinnedMany.length > 0 ? pinnedMany[0] : null),
		pinnedKeyIds: pinnedMany.length > 0 ? pinnedMany : pinnedOne ? [pinnedOne] : [],
	};
}

/**
 * Normalize a raw `hub restore --json` payload into a [`RestorePlan`].
 *
 * Written defensively on purpose: `fatal` plans are truncated after `manifest`
 * (no `registry`, no `projects`, no `executable_state`), and an absent section
 * degrades to an empty list rather than throwing — so a shape drift shows up as
 * a thinner dialog, never a white screen over a destructive verb.
 */
export function toRestorePlan(
	raw: unknown,
	sourceHint = "",
	modeHint: RestoreMode | null = null,
): RestorePlan {
	const r = obj(raw);

	const fatal = r.fatal === true;
	const errors = asStrings(pick(r, ["errors"], []));
	const integrity = obj(r.integrity);
	const trust = toTrust(integrity);
	const treeDigestOk = obj(integrity.tree_digest).ok !== false;

	const registry = obj(r.registry);
	const sections = obj(obj(registry.diff).sections);

	// ── losses + conflicts: per-section name lists inside `registry.diff` ──────
	const lostEntries: RestoreLostEntry[] = [];
	const conflicts: RestoreConflict[] = [];
	const mode = pick<RestoreMode | null>(r, ["mode"], null);
	const resolution = mode === "merge" ? "backup wins" : "replaced by the backup";
	for (const section of Object.keys(sections)) {
		const block = obj(sections[section]);
		for (const name of asStrings(block.lost)) {
			lostEntries.push({ kind: singular(section), name });
		}
		for (const name of asStrings(block.conflicts)) {
			conflicts.push({ kind: singular(section), name, resolution });
		}
	}
	for (const key of asStrings(obj(registry.diff).top_level_lost)) {
		lostEntries.push({ kind: "registry key", name: key });
	}
	// Tolerated legacy/flat spellings, only when the real structure is absent.
	if (lostEntries.length === 0) {
		for (const e of asArray(pick(r, ["lost_entries", "lost", "would_lose", "removed"], []))) {
			lostEntries.push({
				kind: str(pick(e, ["kind", "type", "section"], "entry"), "entry"),
				name: str(pick(e, ["name", "id", "key"], "")),
				detail: str(pick(e, ["detail", "path", "description"], "")) || undefined,
			});
		}
	}
	if (conflicts.length === 0) {
		for (const e of asArray(pick(r, ["conflicts", "conflicting"], []))) {
			conflicts.push({
				kind: str(pick(e, ["kind", "type", "section"], "entry"), "entry"),
				name: str(pick(e, ["name", "id", "key"], "")),
				resolution: str(pick(e, ["resolution", "winner", "wins"], "")) || undefined,
			});
		}
	}

	// ── executable state: object of three arrays (or a legacy flat array) ─────
	const execRaw = r.executable_state ?? r.executable ?? r.executable_items;
	const executableState = Array.isArray(execRaw)
		? flatExecutableArray(asArray(execRaw))
		: flattenExecutableState(obj(execRaw));
	const execBlock = obj(Array.isArray(execRaw) ? {} : execRaw);
	const unverifiedReferences = asArray(r.references_unverified ?? execBlock.references_unverified).map((reference) => ({
		path: str(reference.rel), target: str(reference.target_rel), sha256: str(reference.sha256),
	}));
	const requiresExecConsent =
		execBlock.requires_consent === true ||
		(execBlock.requires_consent === undefined && (executableState.length > 0 || unverifiedReferences.length > 0));

	// Old reports only carried existence; new reports carry validated attachment.
	let unresolvedProjects: RestoreUnresolvedProject[] = asArray(r.projects)
		.filter((p) => p.attached === false || p.exists === false)
		.map((p) => ({ name: str(p.name), path: str(p.path) }));
	if (unresolvedProjects.length === 0) {
		unresolvedProjects = asArray(
			pick(r, ["unresolved_projects", "quarantined_projects", "unresolved"], []),
		).map((e) => ({
			name: str(pick(e, ["name", "project"], "")),
			path: str(pick(e, ["path", "expected_path"], "")),
		}));
	}

	// ── out-of-home writes: the sub-agent + global-doc three-way verdicts ─────
	const outOfHomeTargets: RestoreOutOfHomeTarget[] = [];
	for (const [key, kind] of [
		["subagents", "sub-agent"],
		["global_docs", "global doc"],
	] as const) {
		for (const entry of asArray(r[key])) {
			const action = str(entry.action);
			const target = str(entry.target);
			if (!target || !WRITE_ACTIONS.has(action)) continue;
			outOfHomeTargets.push({
				path: writtenPath(target, action),
				kind,
				action,
				detail: str(entry.detail),
			});
		}
	}
	if (outOfHomeTargets.length === 0) {
		for (const path of asStrings(
			pick(r, ["out_of_home_targets", "outside_data_home", "external_writes"], []),
		)) {
			outOfHomeTargets.push({ path, kind: "file", action: "write", detail: "" });
		}
	}

	// ── retained files: per-section lists + the report's tail count ───────────
	// Tolerant of both spellings the report may use (a list to count, or an
	// already-counted number), and of the whole block being absent.
	const dataSections = obj(r.data);
	let retainedFiles = 0;
	for (const key of Object.keys(dataSections)) {
		retainedFiles += asStrings(obj(dataSections[key]).retained).length;
	}
	const report = obj(r.report);
	const extra = report.retained_extra_files;
	retainedFiles += Array.isArray(extra)
		? extra.length
		: typeof extra === "number"
			? extra
			: 0;
	const auditLedgersNote =
		typeof report.audit_ledgers_note === "string" && report.audit_ledgers_note
			? report.audit_ledgers_note
			: null;
	const worktreeDiff = obj(obj(registry.diff).worktree_defaults);
	const worktreeMachineAbsolute = asArray(report.machine_absolute).find(
		(entry) => entry.field === "worktree_defaults.base_dir" && typeof entry.value === "string",
	);
	const worktreeDefaults: RestoreWorktreeDefaults = {
		status: worktreeStatus(worktreeDiff.status),
		value: worktreeValue(worktreeDiff.value),
		machineAbsolute: worktreeMachineAbsolute
			? {
					field: "worktree_defaults.base_dir",
					value: String(worktreeMachineAbsolute.value),
					rewritten: worktreeMachineAbsolute.rewritten === true,
			  }
			: null,
	};

	// A consent-gated error is a GATE, not a failure — folding the "re-run with
	// --accept-executable-state" line into `error` would disable the very button
	// whose checkbox clears it. Only a fatal plan (or the CLI's own top-level
	// `{ok:false,error}` bail-out) is an unfixable-from-here refusal.
	const topError = pick<string | null>(r, ["error"], null);
	const error = topError ?? (fatal ? errors.join(" ") || "the snapshot could not be trusted" : null);

	return {
		ok: pick<boolean>(r, ["ok"], true),
		fatal,
		error,
		errors,
		source: str(pick(r, ["source", "from", "repo"], sourceHint), sourceHint),
		mode,
		// The hint is what we actually sent, so it WINS over the echo.
		requestedSource: sourceHint || str(pick(r, ["source", "from", "repo"], "")),
		requestedMode: modeHint ?? mode,
		trust,
		integrityOk: integrity.ok === true,
		treeDigestOk,
		// A hard verdict has no flag that clears it — never offer the checkbox.
		requiresTrustConsent: !trust.ok && !trust.hard && !fatal,
		requiresExecConsent,
		targetPopulated: registry.target_populated === true,
		modeRequired: registry.mode_required === true,
		lostEntries,
		conflicts,
		executableState,
		unverifiedReferences,
		unresolvedProjects,
		worktreeDefaults,
		outOfHomeTargets,
		warnings: asStrings(pick(r, ["warnings", "warning"], [])),
		retainedFiles,
		auditLedgersNote,
		unverified: trust.state !== "verified",
		nextSteps: asStrings(pick(r, ["next_steps", "nextSteps", "follow_up"], [])),
		// `applied` is an OBJECT on the wire (backup dir, writes, pins). The
		// boolean the UI wants is the plan's own `apply` flag.
		applied: r.apply === true || obj(r.applied).applied === true,
	};
}

/** Design §5: `--apply` REQUIRES `--accept-executable-state` when the plan
 *  installs any hooks / permission rules / trust grants. The UI gates its
 *  confirm button on this so the CLI's refusal is never how the user finds out. */
export function requiresExecutableConsent(plan: RestorePlan): boolean {
	return plan.requiresExecConsent;
}

/** Design §5: `--trust-new-key` accepts *and pins* a signer this machine has
 *  never seen. Never true for a `hard` verdict — those are refusals. */
export function requiresTrustConsent(plan: RestorePlan): boolean {
	return plan.requiresTrustConsent;
}

/**
 * Can the apply button fire at all, given the consents the user has ticked?
 *
 * The one place the gate composition lives, so the Backup screen's danger zone
 * and the bootstrap wizard can never disagree about what blocks a restore.
 */
export function canApplyRestore(
	plan: RestorePlan | null,
	consents: { executableState?: boolean; trustNewKey?: boolean } = {},
): boolean {
	if (!plan) return false;
	if (plan.fatal || plan.error) return false;
	if (plan.modeRequired) return false;
	if (plan.requiresExecConsent && !consents.executableState) return false;
	if (plan.requiresTrustConsent && !consents.trustNewKey) return false;
	return true;
}

/** Why the apply button is disabled, in the CLI's own words where it has them. */
export function restoreBlockReason(
	plan: RestorePlan | null,
	consents: { executableState?: boolean; trustNewKey?: boolean } = {},
): string | undefined {
	if (!plan) return "Preview the snapshot first";
	if (plan.error) return plan.error;
	if (plan.modeRequired)
		return `${PRODUCT_NAME} on this machine already has content — pick replace or merge first`;
	if (plan.requiresExecConsent && !consents.executableState)
		return plan.unverifiedReferences?.length
			? "Review and accept the unverified references and any executable state above to continue"
			: "Accept the executable state above to continue";
	if (plan.requiresTrustConsent && !consents.trustNewKey)
		return "Accept the unverified signing key above to continue";
	return undefined;
}

/** The literal word both restore surfaces make the user type. */
export const RESTORE_CONFIRM_WORD = "RESTORE";

/** Has the user typed the confirmation word? Case- and whitespace-forgiving,
 *  because the gate exists to defeat muscle memory, not typing accuracy. */
export function typedConfirmationMet(typed: string): boolean {
	return typed.trim().toUpperCase() === RESTORE_CONFIRM_WORD;
}

/**
 * Does this plan need the typed-word gate?
 *
 * The Backup screen's danger zone always asks (a mid-life restore is never
 * routine). The first-run wizard asks only when the restore can actually
 * destroy something: it lists losses/conflicts, or this machine already holds
 * hub content. A genuinely empty first run stays a two-click flow — adding
 * ceremony where there is nothing to lose trains people to type it blind.
 */
export function requiresTypedConfirmation(plan: RestorePlan | null): boolean {
	if (!plan) return false;
	return plan.lostEntries.length > 0 || plan.conflicts.length > 0 || plan.targetPopulated;
}

/** Total count of destructive consequences — drives the dialog's headline. */
export function consequenceCount(plan: RestorePlan): number {
	return (
		plan.lostEntries.length +
		plan.conflicts.length +
		plan.executableState.length +
		(plan.unverifiedReferences?.length ?? 0) +
		plan.outOfHomeTargets.length
	);
}

export function restoreConsentText(plan: RestorePlan): string {
	const references = plan.unverifiedReferences?.length ?? 0;
	if (references > 0) {
		const executable = plan.executableState.length > 0 ? " and the executable state listed above" : "";
		return `I accept the ${references} unverified reference${references === 1 ? "" : "s"}${executable}. The old snapshot signature does not cover these reference placements.`;
	}
	const code = plan.executableState.some((item) => item.code);
	return `I accept the ${plan.executableState.length} executable item${plan.executableState.length === 1 ? "" : "s"} above. ${code ? "Hooks, permission rules, and restored connector / MCP code" : "Hooks and permission rules"} will run on this machine.`;
}
