import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// jsdom does not run a layout engine, so clientHeight / overflow cannot be
// measured here (see design.md § 8 risk). Instead we assert the CSS contract
// that *enforces* the layout: fixed header heights, a single scrollbar style,
// the two-column grid model, screen-gutter tokens, and the removed diet classes.
const css = readFileSync(resolve(process.cwd(), "src/App.css"), "utf-8");

function rule(selector: string): string {
	// Grab the first `{ ... }` block following the selector at a line start.
	const re = new RegExp(
		`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
	);
	const m = css.match(re);
	return m ? m[2] : "";
}

describe("screen layout contract (CSS)", () => {
	it("defines the screen-gutter tokens, density-aware", () => {
		expect(css).toMatch(/--pad-screen-x:\s*24px/);
		expect(css).toMatch(/--pad-screen-y:\s*16px/);
		expect(css).toMatch(
			/\[data-density="compact"\][^}]*--pad-screen-x:\s*20px/,
		);
		expect(css).toMatch(/\[data-density="cozy"\][^}]*--pad-screen-x:\s*28px/);
	});

	it("fixes the two header rows via density-aware tokens", () => {
		expect(rule(".main-header")).toMatch(/height:\s*var\(--header-row-1\)/);
		expect(rule(".main-header")).not.toMatch(/min-height/);
		expect(rule(".main-subheader")).toMatch(/height:\s*var\(--header-row-2\)/);
		expect(css).toMatch(/--header-row-1:\s*56px/);
		expect(css).toMatch(/--header-row-2:\s*40px/);
		expect(css).toMatch(/\[data-density="compact"\][^}]*--header-row-1:\s*52px/);
		expect(css).toMatch(/\[data-density="cozy"\][^}]*--header-row-1:\s*60px/);
	});

	it("makes the header reflow on content-column width via container queries", () => {
		expect(rule(".app-main")).toMatch(/container-type:\s*inline-size/);
		expect(rule(".app-main")).toMatch(/container-name:\s*appmain/);
		expect(css).toMatch(/@container appmain \(max-width:/);
	});

	it("defines the state-pill variants (StatusBadge preset)", () => {
		// StatePill is now a StatusBadge preset: channel drives hue, and the
		// mono/square-border look is carried by .status-badge.state-pill*.
		expect(css).toMatch(/\.status-badge\.state-pill/);
		expect(css).toMatch(/\.status-badge\.state-pill-saved/);
	});

	it("defines the subheader-group separator", () => {
		expect(css).toMatch(
			/\.subheader-group \+ \.subheader-group\s*\{[^}]*border-left/,
		);
	});

	it("keeps the header rows on one line (nowrap, shrink 0)", () => {
		expect(rule(".main-header")).toMatch(/flex-wrap:\s*nowrap/);
		expect(rule(".main-header")).toMatch(/flex-shrink:\s*0/);
		expect(rule(".main-subheader")).toMatch(/flex-wrap:\s*nowrap/);
	});

	it("uses the gutter token on the header rows", () => {
		expect(rule(".main-header")).toMatch(/padding:\s*0 var\(--pad-screen-x\)/);
		expect(rule(".main-subheader")).toMatch(
			/padding:\s*0 var\(--pad-screen-x\)/,
		);
	});

	it("models the editor as a height-filling grid (no grid-level scroll)", () => {
		const grid = rule(".editor-grid");
		expect(grid).toMatch(/display:\s*grid/);
		expect(grid).not.toMatch(/overflow-y:\s*auto/);
	});

	it("makes the code area the editor's scroller", () => {
		const code = rule(".code-area");
		expect(code).toMatch(/overflow:\s*auto/);
		expect(code).toMatch(/overscroll-behavior:\s*contain/);
		expect(code).not.toMatch(/calc\(100vh/);
	});

	it("keeps the editor pane from competing with the code-area scroller", () => {
		const main = rule(".editor-main");
		expect(main).toMatch(/overflow-y:\s*auto/);
		expect(main).toMatch(/overflow-x:\s*hidden/);
		expect(main).not.toMatch(/overflow:\s*auto/);
	});

	it("lets the CodeMirror editor fill the code-area scroller in edit mode", () => {
		// Edit mode is owned by CodeMirror 6 (one layer — no overlay), so the
		// .code-area wrapper stays the single scroll owner and CM fills it.
		expect(rule(".code-area--edit .cm-editor")).toMatch(/height:\s*100%/);
		expect(rule(".code-area--edit .cm-scroller")).toMatch(/overflow:\s*auto/);
	});

	it("has no editor-scoped scrollbar override", () => {
		expect(css).not.toMatch(/\.editor-side\s*\{[^}]*scrollbar-color/);
		expect(css).not.toMatch(/\.editor-grid::-webkit-scrollbar/);
	});

	it("keeps a single global scrollbar style", () => {
		expect(css).toMatch(
			/::-webkit-scrollbar-thumb\s*\{\s*background:\s*var\(--bg-3\)/,
		);
	});

	it("drops the permissions stat-grid and header bands", () => {
		expect(css).not.toMatch(/\.perm-stat-grid\s*\{/);
		expect(css).not.toMatch(/\.perm-header\s*\{/);
		expect(css).not.toMatch(/\.perm-save-state\s*\{/);
	});

	it("gives each permissions pane its own scroller (no sticky hack)", () => {
		expect(rule(".perm-main")).toMatch(/overflow:\s*auto/);
		expect(rule(".perm-side")).toMatch(/overflow-y:\s*auto/);
		expect(rule(".perm-side")).not.toMatch(/position:\s*sticky/);
		expect(rule(".perm-side")).not.toMatch(/calc\(100vh/);
	});

	it("spaces project workspace bands with twice the vertical gutter", () => {
		expect(css).toMatch(
			/\.ws-band \+ \.ws-band\s*\{\s*margin-top:\s*calc\(var\(--pad-screen-y\) \* 2\)/,
		);
	});
});
