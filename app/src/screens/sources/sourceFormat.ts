import { plural as pluralize } from "@/lib/plural";

export function fmtTimestamp(s: string | null | undefined): string {
	if (!s) return "—";
	try {
		const d = new Date(s);
		return d.toLocaleString();
	} catch {
		return s;
	}
}

/** `1 skill` / `3 skills` — the count and its noun as one token. The noun form
 *  comes from the shared `plural` helper so the rule lives in exactly one place. */
export function plural(n: number, word: string): string {
	return `${n} ${pluralize(n, word)}`;
}
