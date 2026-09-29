/**
 * Pick the singular or plural form of a noun for a count.
 *
 * Counts in this app are almost always rendered next to their noun ("3 skills",
 * "1 conflict"), and hand-written `n === 1 ? … : …` ternaries were repeatedly
 * forgotten — the gallery caught "1 skills", "1 CONFLICTS", "1 MCP servers" and
 * "1 sessions". Use this instead of an inline ternary.
 *
 * ```ts
 * `${n} ${plural(n, "skill")}`            // 1 skill  / 3 skills
 * `${n} ${plural(n, "entry", "entries")}` // 1 entry  / 3 entries
 * ```
 *
 * Only ±1 is singular: a count of 0 takes the plural form ("0 skills"), which
 * is what English does.
 */
export function plural(
	n: number,
	singular: string,
	pluralForm: string = `${singular}s`,
): string {
	return Math.abs(n) === 1 ? singular : pluralForm;
}
