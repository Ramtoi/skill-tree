// ─── Edit mode: the slash-reference completion overlay ───────────────────────
// Typing `/` at a position where a slash reference would parse (per
// `lib/skillRefs.ts::slashRefContextAt`), followed by at least one character,
// opens a small CodeMirror completion overlay listing matching registered
// skills. Ranking is ours (`rankSkillCompletions`) — CM's own fuzzy filter is
// off (`filter: false`) so the tier gate below is exactly what ships.
//
// The tier gate (`SUBSTRING_MIN_QUERY`) exists because ungated substring/
// description matching opens the overlay on every single typed letter and
// arms a destructive `Enter` on ordinary path words (`/etc`, `/dev`, `/bin`,
// measured against the real registry — plans/GRILL.md finding 2). Below the
// gate, only a literal name-prefix match is offered.
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
	acceptCompletion,
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
	type CompletionSource,
} from "@codemirror/autocomplete";
import { slashRefContextAt, type SkillRefRenderOptions } from "@/lib/skillRefs";

/** Rows rendered before the author is expected to narrow by typing. */
export const MAX_COMPLETION_OPTIONS = 8;

/** Below this query length only tier 0 (name prefix) runs — see
 *  plans/GRILL.md finding 2: ungated substring/description matching opened
 *  the overlay on every single letter and made Enter destructive on ordinary
 *  path words. */
export const SUBSTRING_MIN_QUERY = 3;

function ascending(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** Ordered candidate names for `query`, capped at `limit`.
 *
 * Tier 0 name-prefix (always); tiers 1 (name substring) and 2 (description
 * substring) only when `query.length >= SUBSTRING_MIN_QUERY`. Name-ascending
 * inside each tier, using plain `<`/`>` (never `localeCompare` — names are
 * ASCII slugs). Pure — no CodeMirror, no React.
 */
export function rankSkillCompletions(
	query: string,
	candidates: readonly string[],
	describe: (name: string) => string | undefined,
	limit: number = MAX_COMPLETION_OPTIONS,
): string[] {
	const gateOpen = query.length >= SUBSTRING_MIN_QUERY;

	const tier0: string[] = [];
	const tier1: string[] = [];
	const tier2: string[] = [];

	for (const name of candidates) {
		if (name.startsWith(query)) {
			tier0.push(name);
			continue;
		}
		if (!gateOpen) continue;
		if (name.includes(query)) {
			tier1.push(name);
			continue;
		}
		const description = describe(name);
		if (description && description.toLowerCase().includes(query)) {
			tier2.push(name);
		}
	}

	tier0.sort(ascending);
	tier1.sort(ascending);
	tier2.sort(ascending);

	return [...tier0, ...tier1, ...tier2].slice(0, limit);
}

/** The `CompletionSource` behind the overlay. Exported for unit tests so the
 *  open/close policy (T4–T6) can be asserted without mounting an editor.
 *
 *  T4: a bare `/` (empty query) never opens. T5: zero ranked candidates
 *  closes silently — no "no skill matches" row (a `/` in prose is the
 *  overwhelming common case, not an error). T6: when the top-ranked option
 *  already equals the typed query verbatim, there is nothing left to
 *  complete, so the source returns `null` and `Enter` is a newline again.
 */
export function skillRefCompletionSource(opts: SkillRefRenderOptions): CompletionSource {
	const ignoreNames = opts.ignore ?? [];
	return (context: CompletionContext): CompletionResult | null => {
		const ctx = slashRefContextAt(context.state.doc.toString(), context.pos);
		if (!ctx) return null;
		const { from, to, query } = ctx;
		if (query.length < 1) return null; // T4

		const candidates = opts.names.filter(
			(name) => name !== opts.self && !ignoreNames.includes(name),
		);
		const ranked = rankSkillCompletions(query, candidates, opts.describe, MAX_COMPLETION_OPTIONS);
		if (ranked.length === 0) return null; // T5
		if (ranked[0] === query) return null; // T6 — already fully typed

		const options: Completion[] = ranked.map((name) => ({
			label: name,
			detail: opts.describe(name),
			type: "keyword",
			apply: "/" + name,
		}));

		return { from, to, options, filter: false };
	};
}

/** The extension: `autocompletion()` with our source as the sole `override`,
 *  plus the one `Tab` binding CM's `completionKeymap` does not carry.
 *
 *  `opts` must be referentially stable across keystrokes — same contract as
 *  `skillRefExtension`, and the same caller (`useSkillRefs`) guarantees it.
 *
 *  `interactionDelay` is a parameter (default = CM's own 75ms) ONLY so a unit
 *  test can pass 0; CM refuses `acceptCompletion` inside that window, which
 *  would otherwise make a fast synthetic `Enter` flaky in a mounted-editor
 *  test. Production callers never pass it.
 */
export function skillRefCompletion(
	opts: SkillRefRenderOptions,
	{ interactionDelay = 75 }: { interactionDelay?: number } = {},
): Extension {
	return [
		autocompletion({
			override: [skillRefCompletionSource(opts)],
			defaultKeymap: true,
			activateOnTyping: true,
			closeOnBlur: true,
			icons: false,
			interactionDelay,
			activateOnTypingDelay: 100,
		}),
		// `Tab` is not in CM's own `completionKeymap`; `acceptCompletion` returns
		// `false` when no completion is active, so Tab keeps its normal meaning
		// (focus move) everywhere else.
		Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
	];
}
