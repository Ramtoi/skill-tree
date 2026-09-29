/** One-shot navigation state used when the command palette hands a query to
 * the Library. It stays out of the URL so the Library's list state remains
 * exactly its search query and filters. */
export const PALETTE_LIBRARY_SEARCH_FOCUS = "paletteLibrarySearchFocus";

/** Returns the state without the one-shot marker when it requests focus. */
export function takePaletteLibrarySearchFocus(state: unknown): Record<string, unknown> | null {
	if (!state || typeof state !== "object" || Array.isArray(state)) return null;
	const record = state as Record<string, unknown>;
	if (record[PALETTE_LIBRARY_SEARCH_FOCUS] !== true) return null;
	const next = { ...record };
	delete next[PALETTE_LIBRARY_SEARCH_FOCUS];
	return next;
}
