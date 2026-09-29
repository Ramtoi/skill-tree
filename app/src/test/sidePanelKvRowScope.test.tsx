import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { InlineName } from "@/components/InlineName";

// AUDIT B1: `.kv-row` is shared grammar — the skill editor puts an
// `InlineName` input inside a `.kv-row dd` too (version/upstream rows). An
// UNSCOPED `.kv-row input { ... }` rule has higher specificity than
// `.inline-name-input` and silently kills its active-edit border, its
// `aria-invalid` red edge, and its content-sized width the moment any panel
// adds a bare editable input to a `.kv-row` (the hook editor's TIMEOUT row).
// This is a stylesheet SOURCE-TEXT test (jsdom does not apply real CSS, so a
// computed-style assertion is not possible here) — see `readAppCss.ts`'s own
// note on why these tests read the rule text directly.

describe("side-panel.css — `.kv-row input` must stay scoped (AUDIT B1)", () => {
	const css = readFileSync(
		resolve(process.cwd(), "src/styles/side-panel.css"),
		"utf8",
	).replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments so they can mention the pattern freely

	it("never declares a bare `.kv-row input` selector", () => {
		// A selector list entry of exactly `.kv-row input` (optionally with a
		// trailing pseudo-class), NOT prefixed by another combinator/class.
		const bareUnscopedRule = /(^|[,{}]|\*\/)\s*\.kv-row input(?::[\w-]+)?\s*\{/m;
		expect(css).not.toMatch(bareUnscopedRule);
	});

	it("keeps the TIMEOUT-row input rule scoped to `.hook-editor-side .kv-row > dd > input`", () => {
		expect(css).toMatch(/\.hook-editor-side \.kv-row > dd > input\s*\{/);
	});
});

describe("InlineName inside a `.kv-row` (the skill editor's version/upstream rows)", () => {
	// The exact shape `SkillEditorSidePanel` renders (a `.kv` list, `.kv-row`,
	// `dt`/`dd`) WITHOUT a `.hook-editor-side` ancestor — the skill editor's
	// panel root is `.editor-side`, so the hook editor's scoped rule cannot
	// reach it structurally. This proves the wiring an unscoped rule would
	// have broken still works: the edit-mode input keeps its
	// `inline-name-input` class (the hook for `styles/shell-main.css`'s
	// active-edit border and `aria-invalid` red edge).
	it("keeps its `inline-name-input` class while editing, even nested in a `.kv-row dd`", () => {
		render(
			<dl className="kv">
				<div className="kv-row">
					<dt>version</dt>
					<dd>
						<InlineName
							value="1.0.0"
							label="Version"
							placeholder="none"
							commitOnBlur
							onSave={() => {}}
						/>
					</dd>
				</div>
			</dl>,
		);

		fireEvent.click(screen.getByRole("button", { name: /Rename version/ }));
		const input = screen.getByLabelText("Version") as HTMLInputElement;
		expect(input).toHaveClass("inline-name-input");
		expect(input.closest("dd")?.parentElement).toHaveClass("kv-row");
		// The DOM path this rule would need to match — absent here by
		// construction (no `.hook-editor-side` ancestor) — is what the
		// stylesheet test above independently guarantees is scoped.
		expect(document.querySelector(".hook-editor-side")).toBeNull();
	});
});
