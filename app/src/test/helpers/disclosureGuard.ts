import { readFileSync } from "node:fs";
import { expect } from "vitest";

/**
 * The one guard against a second hand-rolled disclosure creeping in beside
 * `SidePanelSection`. Every `[aria-expanded]:not([aria-haspopup])` under
 * `root` must be a `SidePanelSection`'s own toggle button
 * (`.side-panel-section-head`), and there must be exactly `expected` of them.
 * `sourceFiles` (paths to read from disk — a caller's own `join(process.cwd(),
 * "src", …)`) are also scanned so a raw `aria-expanded` in a panel's source
 * is caught even before anything renders. A popup trigger (a `Select`) also
 * carries `aria-expanded`, but it opens a menu, not a section, and says so
 * with `aria-haspopup` — that is why the query excludes it.
 */
export function expectOnlySidePanelSections(
	root: HTMLElement,
	expected: number,
	sourceFiles: string[],
): void {
	const heads = root.querySelectorAll("[aria-expanded]:not([aria-haspopup])");
	expect(heads.length).toBe(expected);
	for (const head of heads) {
		expect(head).toHaveClass("side-panel-section-head");
	}
	for (const file of sourceFiles) {
		const contents = readFileSync(file, "utf-8");
		expect(contents).not.toContain("aria-expanded");
	}
}
