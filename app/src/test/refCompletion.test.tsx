import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup, waitFor } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { CodeAreaEdit } from "@/components/CodeArea";
import { skillRefCompletion } from "@/components/skillRefs/refCompletion";
import { isTextEntryTarget } from "@/lib/focusScreenSearch";
import type { SkillRefRenderOptions } from "@/lib/skillRefs";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// vitest.config.ts runs with `css: false` — a plain `import "…css"` is a
// no-op in this environment, so a jsdom cascade / computed-style check on
// OUR rule is unreachable here (not merely "weak" — CM's own base theme
// still ships, via `@codemirror/view`'s `style-mod`, which inserts real
// `<style>` tags at extension-load, independent of Vite's CSS pipeline).
// T-8 below reads the real stylesheet file off disk and checks specificity
// directly instead (plans/2.md §Test tasks T-8's sanctioned fallback form).

function opts(names: string[], describeMap: Record<string, string> = {}): SkillRefRenderOptions {
	return {
		names,
		describe: (name) => describeMap[name],
		onOpen: () => {},
	};
}

function mountEditor(extraExtensions: ReturnType<typeof skillRefCompletion>) {
	const { container } = render(
		<CodeAreaEdit content="" onChange={() => {}} extraExtensions={extraExtensions} />,
	);
	const editorEl = container.querySelector(".cm-editor") as HTMLElement;
	const view = EditorView.findFromDOM(editorEl)!;
	return { container, view };
}

/** Simulates real typing: each character is its own transaction, annotated
 *  `input.type` — `activateOnTyping` only reacts to that annotation, so a
 *  bare `view.dispatch({ changes })` would never open the overlay
 *  (plans/2.md §Interfaces, plans/GRILL.md finding 12). */
function typeChar(view: EditorView, ch: string) {
	const pos = view.state.selection.main.head;
	view.dispatch({
		changes: { from: pos, insert: ch },
		selection: { anchor: pos + ch.length },
		annotations: Transaction.userEvent.of("input.type"),
	});
}

function typeString(view: EditorView, text: string) {
	for (const ch of text) typeChar(view, ch);
}

async function waitForTooltip() {
	await waitFor(() => {
		expect(document.querySelector(".cm-tooltip-autocomplete")).toBeTruthy();
	});
}

// ─── T-5: mounted-editor interaction ──────────────────────────────────────────
describe("skillRefCompletion — mounted editor interaction (T-5)", () => {
	it("typing `/cod` opens the overlay with `code-review` first, Enter inserts the reference", async () => {
		const { view } = mountEditor(
			skillRefCompletion(
				opts(["code-review", "code-search"], {
					"code-review": "Review the current diff for correctness bugs.",
				}),
				{ interactionDelay: 0 },
			),
		);

		typeString(view, "/cod");
		await waitForTooltip();

		const firstOption = document.querySelector(
			'.cm-tooltip-autocomplete li[role="option"]',
		);
		expect(firstOption?.querySelector(".cm-completionLabel")?.textContent).toBe(
			"code-review",
		);

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "Enter" }),
			"editor",
		);
		expect(handled).toBe(true);
		expect(view.state.doc.toString()).toBe("/code-review");
	});

	it("Escape closes the overlay and leaves the typed text as-is", async () => {
		const { view } = mountEditor(
			skillRefCompletion(opts(["code-review"]), { interactionDelay: 0 }),
		);

		typeString(view, "/cod");
		await waitForTooltip();
		const before = view.state.doc.toString();

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "Escape" }),
			"editor",
		);
		expect(handled).toBe(true);
		expect(view.state.doc.toString()).toBe(before);
		await waitFor(() => {
			expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();
		});
	});

	it("Tab with no overlay open returns false — keeps its normal (focus-move) meaning", () => {
		const { view } = mountEditor(
			skillRefCompletion(opts(["code-review"]), { interactionDelay: 0 }),
		);
		expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "Tab" }),
			"editor",
		);
		expect(handled).toBe(false);
	});

	it("Tab with the overlay open inserts the selected reference, same as Enter", async () => {
		const { view } = mountEditor(
			skillRefCompletion(opts(["code-review"]), { interactionDelay: 0 }),
		);
		typeString(view, "/cod");
		await waitForTooltip();

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "Tab" }),
			"editor",
		);
		expect(handled).toBe(true);
		expect(view.state.doc.toString()).toBe("/code-review");
	});
});

// ─── T-7: the `/` global hotkey stays out of the editor ──────────────────────
describe("isTextEntryTarget guards CodeMirror's editable surface (T-7)", () => {
	it("returns true for .cm-content and a descendant of it", () => {
		const { container } = mountEditor(skillRefCompletion(opts(["code-review"])));
		void container;
		const content = document.querySelector(".cm-content") as HTMLElement;
		expect(content).toBeTruthy();
		expect(isTextEntryTarget(content)).toBe(true);

		const line = content.querySelector(".cm-line") as HTMLElement | null;
		expect(line).toBeTruthy();
		expect(isTextEntryTarget(line)).toBe(true);
	});
});

// ─── T-8: the lit slot actually wins (CSS specificity, not paint) ────────────
// `vitest.config.ts` runs `css: false`, so neither a normal import NOR a
// getComputedStyle/cascade check can reach `styles/skill-refs.css` here —
// this is the "jsdom's cascade proves too weak" case plans/2.md §Test tasks
// T-8 names, in its strongest form (unreachable, not merely weak). The
// fallback it sanctions: scan for the rule actually applied and compare its
// specificity, structurally, against CM's own generated selector — which is
// exactly the invariant F6 exists to guarantee (our rule wins REGARDLESS of
// insertion order or resolved color, because (0,4,2) always beats (0,3,2)).
function ruleSpecificity(selector: string): [number, number, number] {
	let ids = 0;
	let classLevel = 0; // classes, attribute selectors, pseudo-classes
	let elements = 0;
	// A class/id token's body is any run of non-delimiter characters — NOT
	// `\w` alone, which is ASCII-only and would silently drop CodeMirror's
	// own generated theme-id class (`.ͼ2`, a non-ASCII combining character).
	const tokens =
		selector.match(
			/#[^\s.#[\]:>+~,]+|\.[^\s.#[\]:>+~,]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?|[A-Za-z][\w-]*/g,
		) ?? [];
	for (const token of tokens) {
		if (token.startsWith("#")) ids++;
		else if (token.startsWith(".") || token.startsWith("[") || token.startsWith(":")) {
			classLevel++;
		} else elements++;
	}
	return [ids, classLevel, elements];
}

function beats(a: [number, number, number], b: [number, number, number]): boolean {
	if (a[0] !== b[0]) return a[0] > b[0];
	if (a[1] !== b[1]) return a[1] > b[1];
	return a[2] > b[2];
}

function selectedRowSelectors(): string[] {
	const selectors: string[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of Array.from(rules)) {
			const selectorText = (rule as CSSStyleRule).selectorText;
			if (selectorText?.includes("aria-selected") && selectorText.includes("tooltip-autocomplete")) {
				selectors.push(selectorText);
			}
		}
	}
	return selectors;
}

describe("the app's selected-row rule beats CM's base theme (T-8)", () => {
	it("our `.cm-editor`-prefixed selector out-specifies CM's own", () => {
		// 1. Mount a real editor with the completion extension — CM's own base
		//    theme (style-mod) is inserted into document.head at extension
		//    load, independent of Vite's (disabled) CSS pipeline.
		mountEditor(skillRefCompletion(opts(["code-review"])));
		const cmSelectors = selectedRowSelectors().filter((s) => !s.includes("cm-editor"));
		expect(cmSelectors.length).toBeGreaterThan(0);
		const cmSpecificity = cmSelectors
			.map(ruleSpecificity)
			.reduce((max, s) => (beats(s, max) ? s : max));

		// 2. Inject the app's real stylesheet (read off disk — `css: false`
		//    means an `import` of it here would be a silent no-op) and find
		//    OUR selected-row rule the same way.
		const css = readFileSync(
			resolve(__dirname, "../styles/skill-refs.css"),
			"utf-8",
		);
		const style = document.createElement("style");
		style.textContent = css;
		document.head.appendChild(style);

		try {
			const ourSelectors = selectedRowSelectors().filter((s) => s.includes("cm-editor"));
			expect(ourSelectors.length).toBeGreaterThan(0);
			const ourSpecificity = ourSelectors
				.map(ruleSpecificity)
				.reduce((max, s) => (beats(s, max) ? s : max));

			expect(
				beats(ourSpecificity, cmSpecificity),
				`expected our specificity ${JSON.stringify(ourSpecificity)} to beat CM's ${JSON.stringify(cmSpecificity)}`,
			).toBe(true);
		} finally {
			document.head.removeChild(style);
		}
	});
});
