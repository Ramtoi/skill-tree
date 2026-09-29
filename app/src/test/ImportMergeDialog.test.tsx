import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { ImportMergeDialog } from "@/components/ImportMergeDialog";
import { splitPattern } from "@/components/permissions/PatternText";
import type { ImportCandidateSet } from "@/types/permissions";

// `PatternText` splits a pattern across `.tool`/`.inner` sibling spans so the
// tool prefix can be dimmed — which means no single node holds the full
// string as a direct text-node child (`getNodeText` only looks at OWN text
// nodes), so a plain `getByText("Bash(npm:*)")` can never match. A function
// matcher that reads the element's full `textContent` is DOM Testing
// Library's documented way out ("text is broken up by multiple elements").
function patternText(pattern: string) {
	return (_content: string, element: Element | null) =>
		element?.tagName === "CODE" &&
		element.classList.contains("reconcile-pattern") &&
		element.textContent === pattern;
}

const CANDIDATES: ImportCandidateSet = {
	scope_kind: "global",
	project: null,
	merged: [
		{
			pattern: "Bash(npm:*)",
			kind: "allow",
			harnesses: null,
			sources: [
				{ harness: "claude-code", source: "settings.json" },
				{ harness: "codex", source: "default.rules" },
			],
		},
	],
	conflicts: [
		{
			pattern: "Bash(git:*)",
			options: { allow: ["claude-code"], ask: ["codex"] },
		},
	],
	un_importable: [
		{
			source: "default.rules",
			harness: "codex",
			reason: "uses match/not_match argument constraints",
			file: "/x/default.rules",
		},
	],
};

// Two single-harness groups (claude-code, codex) + one shared claude-code+codex
// group — the shape the spec calls out for the grouping/bulk-action tests.
const GROUPED_CANDIDATES: ImportCandidateSet = {
	scope_kind: "global",
	project: null,
	merged: [
		{
			pattern: "Bash(cargo:*)",
			kind: "allow",
			harnesses: null,
			sources: [{ harness: "claude-code", source: "settings.json" }],
		},
		{
			pattern: "Bash(terraform plan:*)",
			kind: "allow",
			harnesses: null,
			sources: [{ harness: "claude-code", source: "settings.json" }],
		},
		{
			pattern: "Bash(./gradlew :app:compileDebugKotlin:*)",
			kind: "allow",
			harnesses: null,
			sources: [{ harness: "codex", source: "default.rules" }],
		},
		{
			pattern: "Bash(./gradlew :domain:test:*)",
			kind: "ask",
			harnesses: null,
			sources: [{ harness: "codex", source: "default.rules" }],
		},
		{
			pattern: "Bash(pytest:*)",
			kind: "allow",
			harnesses: null,
			sources: [
				{ harness: "claude-code", source: "settings.json" },
				{ harness: "codex", source: "default.rules" },
			],
		},
	],
	conflicts: [],
	un_importable: [],
};

function renderDialog(candidates: ImportCandidateSet, onApplied = () => {}) {
	vi.mocked(invoke).mockImplementation((cmd: string) => {
		if (cmd === "permissions_reconcile_candidates")
			return Promise.resolve(candidates);
		return Promise.resolve({ imported: 0, dropped: 0, kept: 0 });
	});
	return render(
		<ImportMergeDialog
			open
			scope={{ kind: "global" }}
			onClose={() => {}}
			onApplied={onApplied}
		/>,
	);
}

describe("ImportMergeDialog", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders candidates, conflicts, and un-importable rows", async () => {
		vi.mocked(invoke).mockResolvedValue(CANDIDATES);
		render(
			<ImportMergeDialog
				open
				scope={{ kind: "global" }}
				onClose={() => {}}
				onApplied={() => {}}
			/>,
		);
		expect(
			await screen.findByTestId("import-merged-row"),
		).toBeInTheDocument();
		expect(screen.getByText(patternText("Bash(npm:*)"))).toBeInTheDocument();
		expect(screen.getByTestId("import-conflict-row")).toBeInTheDocument();
		expect(screen.getByText(patternText("Bash(git:*)"))).toBeInTheDocument();
		// Un-importable shown read-only with its reason.
		const unimp = screen.getByTestId("import-unimportable-row");
		expect(unimp).toHaveTextContent(/match\/not_match/);
		expect(unimp).toHaveTextContent("read-only");
	});

	it("applies only the decisions that the user chose", async () => {
		vi.mocked(invoke).mockImplementation((cmd: string) => {
			if (cmd === "permissions_reconcile_candidates")
				return Promise.resolve(CANDIDATES);
			return Promise.resolve({ imported: 1, dropped: 0, kept: 0 });
		});
		const onApplied = vi.fn();
		render(
			<ImportMergeDialog
				open
				scope={{ kind: "global" }}
				onClose={() => {}}
				onApplied={onApplied}
			/>,
		);
		await screen.findByTestId("import-merged-row");
		const apply = screen.getByRole("button", { name: "Apply selected" });
		expect(apply).toBeDisabled();
		const conflictRow = screen.getByTestId("import-conflict-row");
		fireEvent.click(within(conflictRow).getByRole("radio", { name: "both" }));
		expect(apply).toBeEnabled();
		fireEvent.click(apply);

		await waitFor(() => expect(onApplied).toHaveBeenCalled());
		const applyCall = vi
			.mocked(invoke)
			.mock.calls.find((c) => c[0] === "permissions_reconcile_apply");
		expect(applyCall).toBeTruthy();
		const payload = applyCall?.[1] as { decisions: unknown[] };
		// The untouched npm rule stays native. "Both" expands to the two chosen
		// conflict decisions only.
		expect(payload.decisions).not.toContainEqual(
			expect.objectContaining({ pattern: "Bash(npm:*)" }),
		);
		const gitDecisions = payload.decisions.filter(
			(d) => (d as { pattern: string }).pattern === "Bash(git:*)",
		);
		expect(gitDecisions).toHaveLength(2);
	});

	it("groups importable rows by source-harness set with no per-row harness tag", async () => {
		// The dialog renders through a portal (Modal → createPortal into
		// document.body), so `render()`'s own `container` never sees it —
		// query the whole document instead.
		renderDialog(GROUPED_CANDIDATES);
		const rows = await screen.findAllByTestId("import-merged-row");

		const heads = document.body.querySelectorAll(".reconcile-group-head");
		expect(heads.length).toBe(3);
		const combined = Array.from(heads).find((h) =>
			h.textContent?.includes("+"),
		);
		expect(combined).toBeTruthy();
		expect(combined?.textContent).toMatch(/Claude Code/);
		expect(combined?.textContent).toMatch(/Codex/);
		// No per-row harness Tag remains — the group head names the source(s)
		// once. Scoped to each ROW (not the whole document): the harness name
		// legitimately appears in the sibling group head above it.
		for (const row of rows) {
			expect(within(row).queryAllByText(/Claude Code/)).toHaveLength(0);
			expect(within(row).queryAllByText(/Codex/)).toHaveLength(0);
		}
	});

	it("Import all stages one source group and leaves other groups for later", async () => {
		const { applyDecisions } = wireApplyCapture(GROUPED_CANDIDATES);
		render(
			<ImportMergeDialog
				open
				scope={{ kind: "global" }}
				onClose={() => {}}
				onApplied={() => {}}
			/>,
		);
		await screen.findAllByTestId("import-merged-row");

		const codexGroupHead = screen
			.getByText(patternText("Bash(./gradlew :app:compileDebugKotlin:*)"))
			.closest(".reconcile-group")!
			.querySelector<HTMLElement>(".reconcile-group-head")!;
		fireEvent.click(
			within(codexGroupHead).getByRole("button", { name: /Import all/ }),
		);

		// Both Codex-only rows become staged imports.
		const gradlewRow = screen
			.getByText(patternText("Bash(./gradlew :app:compileDebugKotlin:*)"))
			.closest('[data-testid="import-merged-row"]')!;
		expect(gradlewRow).toHaveAttribute("data-choice", "import");
		const domainRow = screen
			.getByText(patternText("Bash(./gradlew :domain:test:*)"))
			.closest('[data-testid="import-merged-row"]')!;
		expect(domainRow).toHaveAttribute("data-choice", "import");

		// The untouched Claude Code group stays for later.
		const cargoRow = screen
			.getByText(patternText("Bash(cargo:*)"))
			.closest('[data-testid="import-merged-row"]')!;
		expect(cargoRow).toHaveAttribute("data-choice", "later");

		fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
		await waitFor(() => expect(applyDecisions.length).toBe(1));
		const { decisions } = applyDecisions[0] as { decisions: unknown[] };
		expect(decisions).toContainEqual({
			pattern: "Bash(./gradlew :app:compileDebugKotlin:*)",
			action: "import",
			kind: "allow",
		});
		expect(decisions).toContainEqual({
			pattern: "Bash(./gradlew :domain:test:*)",
			action: "import",
			kind: "ask",
		});
		expect(decisions).not.toContainEqual(
			expect.objectContaining({ pattern: "Bash(cargo:*)" }),
		);
	});

	it("the footer summary separates staged choices from rules left for later", async () => {
		// The dialog renders through a portal, so query document.body rather
		// than `render()`'s own container (see the grouping test above).
		renderDialog(CANDIDATES);
		await screen.findByTestId("import-merged-row");
		const summary = document.body.querySelector(".reconcile-summary")!;
		expect(summary).toHaveTextContent("0 import · 0 keep · 0 drop · 2 later");

		const conflictRow = screen.getByTestId("import-conflict-row");
		fireEvent.click(within(conflictRow).getByRole("radio", { name: "allow" }));
		expect(summary).toHaveTextContent("1 import · 0 keep · 0 drop · 1 later");

		const npmRow = screen.getByTestId("import-merged-row");
		fireEvent.click(within(npmRow).getByRole("radio", { name: "Import" }));
		expect(summary).toHaveTextContent("2 import · 0 keep · 0 drop · 0 later");
	});

	it("a 'both' conflict resolution counts as one import in the footer", async () => {
		renderDialog(CANDIDATES);
		await screen.findByTestId("import-merged-row");
		const summary = document.body.querySelector(".reconcile-summary")!;

		const conflictRow = screen.getByTestId("import-conflict-row");
		fireEvent.click(within(conflictRow).getByRole("radio", { name: "both" }));
		// "Both" expands to two decisions on Apply but counts as one reviewed row.
		expect(summary).toHaveTextContent("1 import · 0 keep · 0 drop · 1 later");
	});

	it("moves likely one-off approvals into a collapsed section with guidance", async () => {
		renderDialog({
			...GROUPED_CANDIDATES,
			merged: [
				...GROUPED_CANDIDATES.merged,
				{
					pattern: "Bash(./gradlew test --tests com.example.RepositoryTest:*)",
					kind: "allow",
					harnesses: null,
					sources: [{ harness: "codex", source: "default.rules" }],
				},
			],
		});
		await screen.findAllByTestId("import-merged-row");

		const toggle = screen.getByTestId("import-specific-toggle");
		expect(toggle).toHaveTextContent(/Specific approvals\s*1/);
		expect(screen.getByText(/Import a rule only if you want to reuse it/)).toBeVisible();
		expect(
			screen.queryByText(
				patternText("Bash(./gradlew test --tests com.example.RepositoryTest:*)"),
			),
		).not.toBeInTheDocument();

		fireEvent.click(toggle);
		expect(
			screen.getByText(
				patternText("Bash(./gradlew test --tests com.example.RepositoryTest:*)"),
			),
		).toBeVisible();
		expect(screen.getByText("Names an exact test target.")).toBeVisible();
	});

	it("keeps same-source general and specific choices in separate radio groups", async () => {
		const candidates: ImportCandidateSet = {
			...GROUPED_CANDIDATES,
			merged: [
				{
					pattern: "Bash(./gradlew :app:compileDebugKotlin:*)",
					kind: "allow",
					harnesses: null,
					sources: [{ harness: "codex", source: "default.rules" }],
				},
				{
					pattern: "Bash(pytest tests/test_cli.py:*)",
					kind: "allow",
					harnesses: null,
					sources: [{ harness: "codex", source: "default.rules" }],
				},
			],
		};
		const { applyDecisions } = wireApplyCapture(candidates);
		render(
			<ImportMergeDialog
				open
				scope={{ kind: "global" }}
				onClose={() => {}}
				onApplied={() => {}}
			/>,
		);
		await screen.findByTestId("import-merged-row");

		const generalRow = screen
			.getByText(patternText("Bash(./gradlew :app:compileDebugKotlin:*)"))
			.closest('[data-testid="import-merged-row"]') as HTMLElement;
		fireEvent.click(within(generalRow).getByRole("radio", { name: "Import" }));
		fireEvent.click(screen.getByTestId("import-specific-toggle"));
		const specificRow = screen
			.getByText(patternText("Bash(pytest tests/test_cli.py:*)"))
			.closest('[data-testid="import-merged-row"]') as HTMLElement;
		fireEvent.click(within(specificRow).getByRole("radio", { name: "Import" }));

		expect(
			within(generalRow).getByRole("radio", { name: "Import" }),
		).toBeChecked();
		expect(
			within(specificRow).getByRole("radio", { name: "Import" }),
		).toBeChecked();
		fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));

		await waitFor(() => expect(applyDecisions.length).toBe(1));
		const { decisions } = applyDecisions[0] as { decisions: unknown[] };
		expect(decisions).toHaveLength(2);
		expect(decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pattern: "Bash(./gradlew :app:compileDebugKotlin:*)",
				}),
				expect.objectContaining({ pattern: "Bash(pytest tests/test_cli.py:*)" }),
			]),
		);
	});

	it("a conflict row carries data-unresolved until a choice is made", async () => {
		renderDialog(CANDIDATES);
		await screen.findByTestId("import-merged-row");
		const conflictRow = screen.getByTestId("import-conflict-row");
		expect(conflictRow).toHaveAttribute("data-unresolved");
		fireEvent.click(within(conflictRow).getByRole("radio", { name: "allow" }));
		expect(conflictRow).not.toHaveAttribute("data-unresolved");
	});

	it("renders inside the Modal primitive with no hand-rolled inline backdrop", async () => {
		renderDialog(CANDIDATES);
		const dialog = await screen.findByRole("dialog");
		expect(dialog.className).toMatch(/\bmodal\b/);

		const here = path.resolve(
			process.cwd(),
			"src/components/ImportMergeDialog.tsx",
		);
		const contents = readFileSync(here, "utf-8");
		expect(contents.includes('position: "fixed"')).toBe(false);
		expect(contents.includes("position:fixed")).toBe(false);
	});

	describe("splitPattern", () => {
		it("splits a tool(...) pattern into tool + inner", () => {
			expect(splitPattern("Bash(npm:*)")).toEqual({ tool: "Bash", inner: "npm:*" });
			expect(splitPattern("Read(src/**)")).toEqual({
				tool: "Read",
				inner: "src/**",
			});
		});

		it("leaves a bare string whole with tool: null", () => {
			expect(splitPattern("just-a-string")).toEqual({
				tool: null,
				inner: "just-a-string",
			});
		});

		it("keeps nested parens in the inner text intact (greedy match)", () => {
			expect(splitPattern('Bash(echo "(x)":*)')).toEqual({
				tool: "Bash",
				inner: 'echo "(x)":*',
			});
		});
	});
});

function wireApplyCapture(candidates: ImportCandidateSet) {
	const applyDecisions: unknown[] = [];
	vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
		if (cmd === "permissions_reconcile_candidates")
			return Promise.resolve(candidates);
		if (cmd === "permissions_reconcile_apply") {
			applyDecisions.push(args);
			return Promise.resolve({ imported: 0, dropped: 0, kept: 0 });
		}
		return Promise.resolve(undefined);
	});
	return { applyDecisions };
}
