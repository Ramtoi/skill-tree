// Pure helpers behind the Harnesses screen's USED BY chip ordering — no
// hooks, no IPC. A harness on the global switch reaches every registered
// project, so its card needs to say WHICH ones were actually used recently
// rather than spamming every name alphabetically.
//
// The usage feature (`features/usage/`) is the only source of session
// recency, but its on-disk cache is path-REDACTED (`~/redacted/<hash>`) —
// only a LIVE scan's `UsageSessionRow.project.fullPath` can be matched back
// to a registry project path. So this module derives a small map at scan
// time and the caller persists it (`storeActivity`/`readStoredActivity`) so
// a session's-worth of ordering survives past the live scan that produced it.

import type { LocalAgentUsageSnapshot } from "@/features/usage/usageTypes";

/** Last-known activity per registered project NAME. `last` is the most
 *  recent session across every harness; `byHarness` narrows to one. Both are
 *  ISO-8601 timestamp strings. */
export type ProjectActivity = Record<
	string,
	{ last: string; byHarness: Record<string, string> }
>;

/** Usage-feature harness ids that don't already match a Skill Tree harness
 *  id. `features/usage/normalizeUsage.ts`'s `KNOWN_HARNESSES` slugifies
 *  ccusage's `agent` field directly — "claude" never becomes "claude-code"
 *  at that layer, so this module owns the translation for the one harness
 *  whose usage id and Harnesses-screen id diverge. */
const USAGE_TO_HARNESS_ID: Record<string, string> = {
	claude: "claude-code",
};

function toHarnessId(usageHarnessId: string): string {
	return USAGE_TO_HARNESS_ID[usageHarnessId] ?? usageHarnessId;
}

/** Drop one trailing "/" so "/a/b" and "/a/b/" compare equal. Never touches
 *  the root "/" itself. */
function normalizePath(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function parseTime(iso: string): number {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? -Infinity : t;
}

/** First of `candidates` that is a non-empty, parseable timestamp. ccusage's
 *  `lastActivity` is free-form text from a third-party tool: an unparseable
 *  one must not swallow a perfectly good `startedAt`. */
function firstParseable(
	...candidates: Array<string | undefined>
): string | undefined {
	for (const candidate of candidates) {
		if (candidate && !Number.isNaN(Date.parse(candidate))) return candidate;
	}
	return undefined;
}

/** Match live-scan sessions to registered projects by full path, and reduce
 *  to the latest timestamp per project (overall, and per harness). Sessions
 *  without a full path (a redacted cache, or a harness the usage feature
 *  can't attribute a project to) are silently skipped — they simply can't
 *  contribute recency, not an error. */
export function deriveProjectActivity(
	snapshot: LocalAgentUsageSnapshot | null,
	projects: Record<string, { path: string }>,
): ProjectActivity {
	const out: ProjectActivity = {};
	if (!snapshot) return out;

	const nameByPath = new Map<string, string>();
	for (const [name, proj] of Object.entries(projects)) {
		nameByPath.set(normalizePath(proj.path), name);
	}
	if (nameByPath.size === 0) return out;

	for (const session of snapshot.sessions) {
		// The usage enrichment stamps a session with the registry project NAME
		// it resolved from the local logs (`hubProject`). That name survives the
		// cache's path redaction and exists for Codex sessions too, so it is
		// the primary key; a full path (live scan only) is the fallback.
		const hub = session.hubProject;
		let projectName: string | undefined =
			hub && Object.prototype.hasOwnProperty.call(projects, hub) ? hub : undefined;
		if (!projectName) {
			const fullPath = session.project?.fullPath;
			if (!fullPath) continue;
			projectName = nameByPath.get(normalizePath(fullPath));
		}
		if (!projectName) continue;

		const ts = firstParseable(session.lastActivity, session.startedAt);
		if (!ts) continue;
		const harnessId = toHarnessId(session.harnessId);

		const entry = (out[projectName] ??= { last: ts, byHarness: {} });
		if (parseTime(ts) > parseTime(entry.last)) entry.last = ts;
		const existing = entry.byHarness[harnessId];
		if (!existing || parseTime(ts) > parseTime(existing)) {
			entry.byHarness[harnessId] = ts;
		}
	}
	return out;
}

/** Merge two activity maps, keeping the later timestamp per key (overall and
 *  per harness). Neither input is mutated. */
export function mergeActivity(a: ProjectActivity, b: ProjectActivity): ProjectActivity {
	const out: ProjectActivity = {};
	for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const ea = a[name];
		const eb = b[name];
		if (ea && !eb) {
			out[name] = ea;
			continue;
		}
		if (eb && !ea) {
			out[name] = eb;
			continue;
		}
		if (!ea || !eb) continue; // unreachable — one of the two membership checks above always fires
		const last = parseTime(ea.last) >= parseTime(eb.last) ? ea.last : eb.last;
		const byHarness: Record<string, string> = { ...ea.byHarness };
		for (const [harnessId, ts] of Object.entries(eb.byHarness ?? {})) {
			const existing = byHarness[harnessId];
			if (!existing || parseTime(ts) > parseTime(existing)) {
				byHarness[harnessId] = ts;
			}
		}
		out[name] = { last, byHarness };
	}
	return out;
}

/** Order project names most-recently-active first for one harness, known
 *  activity before unknown, ties (and every unknown entry) alphabetical.
 *  `knownCount` is how many names carry a timestamp at all — the caller uses
 *  it to decide whether "most recent first" is a true statement to print. */
export function orderProjects(
	names: string[],
	activity: ProjectActivity,
	harnessId: string,
): { ordered: string[]; knownCount: number } {
	// A stored map is user-editable text and ccusage timestamps are third-party
	// strings, so treat an unparseable value as no value at all: fall back to
	// the overall `last`, and past that the name sorts as unknown. Never let it
	// count towards `knownCount` (which gates the "most recent first" hint).
	const keyFor = (name: string): string | undefined =>
		firstParseable(activity[name]?.byHarness?.[harnessId], activity[name]?.last);

	const known = names.filter((n) => keyFor(n) !== undefined);
	const unknown = names.filter((n) => keyFor(n) === undefined);

	known.sort((a, b) => {
		const diff = parseTime(keyFor(b) as string) - parseTime(keyFor(a) as string);
		return diff !== 0 ? diff : a.localeCompare(b);
	});
	unknown.sort((a, b) => a.localeCompare(b));

	return { ordered: [...known, ...unknown], knownCount: known.length };
}

export const PROJECT_ACTIVITY_KEY = "st:project-activity";

function isProjectActivity(value: unknown): value is ProjectActivity {
	if (!value || typeof value !== "object") return false;
	// An array parses as an object and its (possibly zero) values could pass
	// the entry check, which would hand every consumer a value keyed "0", "1",
	// … instead of by project name. Reject the whole shape.
	if (Array.isArray(value)) return false;
	return Object.values(value as Record<string, unknown>).every((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const e = entry as Record<string, unknown>;
		if (typeof e.last !== "string") return false;
		// `byHarness` is REQUIRED, not optional: every consumer dereferences it
		// (`mergeActivity` spreads it, `orderProjects` indexes it), so letting
		// an entry without it through here is how a hand-edited localStorage
		// value would throw on the Harnesses screen.
		if (typeof e.byHarness !== "object" || e.byHarness === null) return false;
		if (Array.isArray(e.byHarness)) return false;
		return Object.values(e.byHarness).every((v) => typeof v === "string");
	});
}

/** Read the persisted activity map. Anything unreadable, unparseable, or
 *  shaped wrong collapses to `{}` — this is a display nicety, never worth a
 *  thrown error or a stale/malformed value leaking into the ordering. */
export function readStoredActivity(): ProjectActivity {
	try {
		const raw = localStorage.getItem(PROJECT_ACTIVITY_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		return isProjectActivity(parsed) ? (parsed as ProjectActivity) : {};
	} catch {
		return {};
	}
}

/** Best-effort persist — a full/unavailable localStorage must never break
 *  the screen it's a convenience for. */
export function storeActivity(map: ProjectActivity): void {
	try {
		localStorage.setItem(PROJECT_ACTIVITY_KEY, JSON.stringify(map));
	} catch {
		/* best-effort only */
	}
}
