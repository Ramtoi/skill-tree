import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SnippetEditor } from "@/screens/SnippetEditor";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import type { SnippetInfo } from "@/types/snippets";
import { renderWithProviders, sampleRegistry } from "./helpers";
import type { Registry } from "@/types";

// A registry that also carries `code-review` — `sampleRegistry` doesn't, and
// every test below decorates a mention of it (mirrors `SkillRefsSection.test.tsx`).
const registry: Registry = {
	...sampleRegistry,
	skills: {
		...sampleRegistry.skills,
		"code-review": {
			version: "1.0.0",
			description: "Review code for correctness and cleanup.",
			source: "~/skill-hub/skills/code-review",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		},
	},
};

const LIB: SnippetInfo[] = [
	{
		name: "android-conventions",
		description: "Project conventions.",
		tags: ["android"],
		version: 2,
		created: "",
		updated: "today",
		hash: "a1b2c3d4",
		usage: { count: 0, summary: "none", outdated_count: 0 },
	},
	{
		name: "commit-message-format",
		description: "Commit format.",
		tags: ["git"],
		version: 1,
		created: "",
		updated: "1w ago",
		hash: "ee99ff00",
		usage: { count: 0, summary: "none", outdated_count: 0 },
	},
];

/** `android-conventions`' own body mentions `code-review` (backtick form) so
 *  every edit-mode test below has a real reference to click. Every other
 *  name falls back to a plain, mention-free body. */
function showFor(name: string) {
	const base = LIB.find((s) => s.name === name) ?? LIB[0];
	const body =
		name === "android-conventions"
			? "## Body\n\nRun `code-review` before merging.\n"
			: `## Body\n\n${base.description}\n`;
	return {
		...base,
		name,
		body,
		usage: { count: 0, summary: "none" as const, outdated_count: 0, locations: [] },
	};
}

/** Same shape as `SnippetRename.test.tsx`'s own helper — captures every
 *  `hub_cmd` argv and answers the rest of the editor's fetches. */
function mockSnippetBackend(
	override?: (a: string[]) => { success: boolean; output: string } | undefined,
) {
	const calls: string[][] = [];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "hub_cmd") {
			const a = (args as { args: string[] }).args;
			calls.push(a);
			return override?.(a) ?? { success: true, output: "" };
		}
		switch (cmd) {
			case "snippets_list":
				return LIB;
			case "snippet_show":
				return showFor((args as { name: string }).name);
			case "snippet_status":
				return { locations: [], damaged: [] };
			case "snippet_new":
				return {
					...showFor((args as { name: string }).name),
					usage: { count: 0, summary: "none" as const, outdated_count: 0 },
				};
			case "read_registry":
				return registry;
			case "read_search_corpus":
				return { skills: {}, snippets: {} };
			default:
				return undefined;
		}
	}) as never);
	return calls;
}

function LocationProbe() {
	const loc = useLocation();
	return (
		<div data-testid="loc" data-state={JSON.stringify(loc.state ?? null)}>
			{loc.pathname}
		</div>
	);
}

function readLocState(): { from?: { path?: string; label?: string; restore?: Record<string, unknown> } } | null {
	return JSON.parse(screen.getByTestId("loc").dataset.state ?? "null");
}

function renderEditor(initialRoute: string) {
	return renderWithProviders(
		<>
			<LocationProbe />
			<Routes>
				<Route path="/snippet/:name" element={<SnippetEditor />} />
				<Route path="/skill/:name" element={<div data-testid="skill-screen" />} />
				<Route path="/snippets" element={<div data-testid="snippets-screen" />} />
			</Routes>
			<ToastContainer />
		</>,
		{ initialRoute },
	);
}

describe("SnippetEditor — references (edit mode)", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("renders the References section above AppliedLocationsPanel (row 19)", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		const refsSection = await screen.findByTestId("side-section-refs");
		const appliedSection = await screen.findByTestId("side-section-applied");
		// DOM order: refs comes BEFORE applied.
		expect(
			refsSection.compareDocumentPosition(appliedSection) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("a References row click carries the snippet editor as the back target (row 20)", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		const refsHead = await screen.findByTestId("side-section-refs");
		const refsSection = refsHead.closest("section") as HTMLElement;
		const row = within(refsSection).getByTestId("skill-ref-row-out-code-review");
		await userEvent.click(row);

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/skill/code-review"),
		);
		expect(readLocState()?.from?.path).toBe("/snippet/android-conventions");
	});

	it("(F3) a dirty description buffer does not block a header rename navigation", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		const descInput = await screen.findByPlaceholderText(
			"One line — what this snippet instructs",
		);
		fireEvent.change(descInput, { target: { value: "A hand-edited description." } });

		await userEvent.click(
			screen.getByRole("button", { name: "Rename snippet name: android-conventions" }),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "android-guidelines");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/android-guidelines"),
		);
		expect(screen.queryByText("Leave without saving?")).not.toBeInTheDocument();
	});

	it("(F3) a dirty description buffer does not block the rename-undo navigation", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		await userEvent.click(
			await screen.findByRole("button", { name: "Rename snippet name: android-conventions" }),
		);
		const field = screen.getByRole("textbox", { name: "Snippet name" });
		await userEvent.clear(field);
		await userEvent.type(field, "android-guidelines");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/android-guidelines"),
		);

		const descInput = await screen.findByPlaceholderText(
			"One line — what this snippet instructs",
		);
		fireEvent.change(descInput, { target: { value: "Edited after rename." } });

		fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/android-conventions"),
		);
		expect(screen.queryByText("Leave without saving?")).not.toBeInTheDocument();
	});

	it("(F3) a dirty description buffer does not block the delete navigation", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/android-conventions");

		const descInput = await screen.findByPlaceholderText(
			"One line — what this snippet instructs",
		);
		fireEvent.change(descInput, { target: { value: "Edited before delete." } });

		fireEvent.click(screen.getByRole("button", { name: "Delete snippet" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete snippet" }));

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/commit-message-format"),
		);
		expect(screen.queryByText("Leave without saving?")).not.toBeInTheDocument();
	});
});

describe("SnippetEditor — references (create mode)", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	it("renders no References section on an untouched form (row 23)", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/new");
		await screen.findByPlaceholderText("e.g. validation-procedure");
		expect(screen.queryByTestId("side-section-refs")).not.toBeInTheDocument();
	});

	it("(F11) a ⌘-click on a decorated reference navigates with no confirm and carries the draft (row 22)", async () => {
		mockSnippetBackend();
		const { container } = renderEditor("/snippet/new");

		const editorEl = await waitFor(() => {
			const el = container.querySelector(".cm-editor");
			if (!el) throw new Error("editor not mounted yet");
			return el as HTMLElement;
		});
		const view = EditorView.findFromDOM(editorEl)!;
		act(() => {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: "Use `code-review`." },
			});
		});

		const refEl = await waitFor(() => {
			const el = container.querySelector(".cm-skill-ref");
			if (!el) throw new Error("not decorated yet");
			return el as HTMLElement;
		});

		// The click runs through the host's `wrapNavigate` seam
		// (`leaveGuard.bypass`) — no hover needed to disarm the guard first.
		// It also preempts CodeMirror's own click handling — `preventDefault`
		// fires, so the raw `dispatchEvent` result comes back `false` (the
		// same "no CM multi-cursor" contract skill-refs.journey.spec.ts pins
		// on the skill editor; CodeMirror only adds a selection range on a
		// modifier mousedown it gets to handle, `@codemirror/view`'s
		// mousedown chain).
		expect(fireEvent.mouseDown(refEl, { metaKey: true })).toBe(false);

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/skill/code-review"),
		);
		expect(screen.queryByText("Discard this draft?")).not.toBeInTheDocument();

		const from = readLocState()?.from;
		expect(from?.path).toBe("/snippet/new");
		expect(from?.label).toBe("New snippet");
		expect(from?.restore?.snippetDraft).toMatchObject({ body: "Use `code-review`." });
	});

	it("(keyboard) Enter on a focused .skill-ref-row in the References section navigates with no confirm and carries the draft", async () => {
		mockSnippetBackend();
		const { container } = renderEditor("/snippet/new");

		const editorEl = await waitFor(() => {
			const el = container.querySelector(".cm-editor");
			if (!el) throw new Error("editor not mounted yet");
			return el as HTMLElement;
		});
		const view = EditorView.findFromDOM(editorEl)!;
		act(() => {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: "Use `code-review`." },
			});
		});

		const row = await screen.findByTestId("skill-ref-row-out-code-review");
		expect(row).toHaveClass("skill-ref-row");
		row.focus();
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/skill/code-review"),
		);
		expect(screen.queryByText("Discard this draft?")).not.toBeInTheDocument();

		const from = readLocState()?.from;
		expect(from?.path).toBe("/snippet/new");
		expect(from?.restore?.snippetDraft).toMatchObject({ body: "Use `code-review`." });
	});

	it("(F11) returning via the back arrow restores the draft", async () => {
		mockSnippetBackend();
		// Simulate arriving back at `/snippet/new` the way the header back arrow
		// on `/skill/:name` would (`snippetBackTarget("", draft)`'s restore
		// state) — the round trip itself is covered by the ⌘-click test above.
		renderWithProviders(
			<>
				<LocationProbe />
				<Routes>
					<Route path="/snippet/:name" element={<SnippetEditor />} />
				</Routes>
			</>,
			{
				initialRoute: {
					pathname: "/snippet/new",
					state: {
						snippetDraft: {
							name: "my-draft",
							desc: "notes",
							tags: ["android"],
							body: "Use `code-review`.",
						},
					},
				},
			},
		);

		expect(await screen.findByDisplayValue("my-draft")).toBeInTheDocument();
		expect(screen.getByDisplayValue("notes")).toBeInTheDocument();
		expect(screen.getByText("android")).toBeInTheDocument();
		const editorEl = await waitFor(() => {
			const el = document.querySelector(".cm-editor");
			if (!el) throw new Error("editor not mounted yet");
			return el as HTMLElement;
		});
		expect(EditorView.findFromDOM(editorEl)!.state.doc.toString()).toBe(
			"Use `code-review`.",
		);
	});

	it("(F3) a touched form navigates to the created snippet with no confirm", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/new");
		const nameField = await screen.findByPlaceholderText("e.g. validation-procedure");
		fireEvent.change(nameField, { target: { value: "new-snippet" } });

		fireEvent.click(screen.getByRole("button", { name: "Create snippet" }));

		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/new-snippet"),
		);
		expect(screen.queryByText("Discard this draft?")).not.toBeInTheDocument();
	});

	it("(F4 positive) a typed form raises the discard confirm on an unrelated exit (row 24)", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/new");
		const nameField = await screen.findByPlaceholderText("e.g. validation-procedure");
		fireEvent.change(nameField, { target: { value: "my-new-snippet" } });

		fireEvent.click(screen.getByRole("button", { name: "Back to Snippets" }));
		expect(await screen.findByText("Discard this draft?")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Stay" }));
		expect(screen.getByPlaceholderText("e.g. validation-procedure")).toHaveValue(
			"my-new-snippet",
		);
	});

	it("(F4 negative) an untouched form leaves with no prompt (row 24)", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/new");
		await screen.findByPlaceholderText("e.g. validation-procedure");

		fireEvent.click(screen.getByRole("button", { name: "Back to Snippets" }));
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/snippets"),
		);
		expect(screen.queryByText("Discard this draft?")).not.toBeInTheDocument();
	});

	it("(F4 negative) a ?name= prefilled form leaves with no prompt (row 24)", async () => {
		mockSnippetBackend();
		renderEditor("/snippet/new?name=android-x");
		await waitFor(() =>
			expect(screen.getByPlaceholderText("e.g. validation-procedure")).toHaveValue(
				"android-x",
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Back to Snippets" }));
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/snippets"),
		);
		expect(screen.queryByText("Discard this draft?")).not.toBeInTheDocument();
	});
});

/** Simulates real typing: each character is its own transaction, annotated
 *  `input.type` — `activateOnTyping` only reacts to that annotation
 *  (refCompletion.test.tsx uses the same helper for the bare-extension
 *  case; this is the same thing through the real snippet editor host). */
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

describe("SnippetEditor — slash-reference completion (host wiring)", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	// skill-ref-completion.journey.spec.ts T-6b: "snippet editor: the same
	// three steps work with zero host-side wiring" — refCompletion.test.tsx
	// (T-5) already proves the overlay/insert mechanics on a bare
	// `skillRefCompletion` extension; this is the only test that a SNIPPET
	// host actually wires `extraExtensions={refs.extension}` the same way
	// the skill editor does. `/snippet/new` renders `SnippetCreateForm.tsx`
	// (~:232), the create-mode host — a distinct component from the
	// edit-existing-snippet path in `SnippetEditor.tsx` (~:663), which wires
	// the same extension the same way but is not this test's route.
	it("typing `/cod` opens the overlay and Enter inserts a code-review reference", async () => {
		mockSnippetBackend();
		const { container } = renderEditor("/snippet/new");
		await screen.findByPlaceholderText("e.g. validation-procedure");

		const editorEl = await waitFor(() => {
			const el = container.querySelector(".cm-editor");
			if (!el) throw new Error("editor not mounted yet");
			return el as HTMLElement;
		});
		const view = EditorView.findFromDOM(editorEl)!;
		// A fresh `/snippet/new` form seeds a starter body template — clear it
		// first so the typed text lands at a known, empty document.
		act(() => {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: "" },
			});
		});

		typeString(view, "/cod");
		const tooltip = await waitFor(() => {
			const el = document.querySelector(".cm-tooltip-autocomplete");
			if (!el) throw new Error("tooltip not open yet");
			return el as HTMLElement;
		});
		expect(
			tooltip.querySelector('li[role="option"] .cm-completionLabel')?.textContent,
		).toBe("code-review");

		// Clears CM's `interactionDelay` (production default 75ms) the same way
		// the journey's `clearInteractionDelay` does, so a scripted Enter right
		// after the tooltip opens does not land inside the ignore window.
		await new Promise((resolve) => setTimeout(resolve, 120));

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "Enter" }),
			"editor",
		);
		expect(handled).toBe(true);
		expect(view.state.doc.toString()).toBe("/code-review");

		await waitFor(() =>
			expect(
				container.querySelector('.cm-skill-ref[data-ref="code-review"]'),
			).not.toBeNull(),
		);
	});
});

describe("SnippetEditor — slash-reference completion (edit-route host wiring)", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	// skill-ref-completion.journey.spec.ts T-6b: "snippet editor: the same
	// three steps work with zero host-side wiring" — the create-mode test
	// above proves the wiring on `SnippetCreateForm.tsx` (~:232); the journey
	// itself runs against `/snippet/android-conventions`, the EDIT-existing-
	// snippet route (`SnippetEditor.tsx` ~:663), a distinct component that
	// wires the same `extraExtensions={refs.extension}` bundle.
	it("typing `/cod` in an existing snippet opens the overlay and Enter inserts a code-review reference", async () => {
		mockSnippetBackend();
		const { container } = renderEditor("/snippet/android-conventions");

		const editorEl = await waitFor(() => {
			const el = container.querySelector(".cm-editor");
			if (!el) throw new Error("editor not mounted yet");
			return el as HTMLElement;
		});
		const view = EditorView.findFromDOM(editorEl)!;
		// `android-conventions`' seeded body ends in a newline — a legal
		// slash-lead position — so the doc's end needs no clearing first.
		await waitFor(() => expect(view.state.doc.toString()).toContain("code-review"));
		const before = container.querySelectorAll('.cm-skill-ref[data-ref="code-review"]').length;

		act(() => {
			view.dispatch({ selection: { anchor: view.state.doc.length } });
		});

		typeString(view, "/cod");
		const tooltip = await waitFor(() => {
			const el = document.querySelector(".cm-tooltip-autocomplete");
			if (!el) throw new Error("tooltip not open yet");
			return el as HTMLElement;
		});
		expect(
			tooltip.querySelector('li[role="option"] .cm-completionLabel')?.textContent,
		).toBe("code-review");

		// Clears CM's `interactionDelay` (production default 75ms) the same way
		// the journey's `clearInteractionDelay` does, so a scripted Enter right
		// after the tooltip opens does not land inside the ignore window.
		await new Promise((resolve) => setTimeout(resolve, 120));

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "Enter" }),
			"editor",
		);
		expect(handled).toBe(true);

		await waitFor(() =>
			expect(
				container.querySelectorAll('.cm-skill-ref[data-ref="code-review"]').length,
			).toBe(before + 1),
		);
	});
});

describe("SnippetEditor — plain click on a decorated reference", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
	});

	// skill-refs.journey.spec.ts "a plain click in edit mode does not
	// navigate" (~:137): only a ⌘/Ctrl-click opens the referenced skill —
	// the ⌘-click create-mode test above already proves the modified click
	// on this exact host; this is the un-modified one. Same single-line
	// dispatched content as that test (a `code-review` mention) — CodeMirror
	// falls through to its own default cursor-placement handling on an
	// un-modified mousedown, which measures a `Range`'s `getClientRects()`
	// to find the click position, and jsdom's multi-line/heading layout
	// makes that measurement throw (TESTS.md §6, real layout); a short
	// single-line buffer plus a one-rect stub is enough for the coordinate
	// scan to resolve, without asserting any real geometry.
	it("a mousedown without a modifier key does not navigate", async () => {
		mockSnippetBackend();
		const { container } = renderEditor("/snippet/new");

		const editorEl = await waitFor(() => {
			const el = container.querySelector(".cm-editor");
			if (!el) throw new Error("editor not mounted yet");
			return el as HTMLElement;
		});
		const view = EditorView.findFromDOM(editorEl)!;
		act(() => {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: "Use `code-review`." },
			});
		});

		const refEl = await waitFor(() => {
			const el = container.querySelector(".cm-skill-ref");
			if (!el) throw new Error("not decorated yet");
			return el as HTMLElement;
		});

		const fakeRect = { top: 0, bottom: 14, left: 0, right: 8, width: 8, height: 14, x: 0, y: 0, toJSON() {} } as DOMRect;
		const origRects = Range.prototype.getClientRects;
		const origRect = Range.prototype.getBoundingClientRect;
		Range.prototype.getClientRects = () => [fakeRect] as unknown as DOMRectList;
		Range.prototype.getBoundingClientRect = () => fakeRect;
		try {
			// Non-zero coordinates: CM's coordinate scan treats (0, 0) as an
			// edge case that never resolves a `closestRect` even with the rect
			// stub in place.
			fireEvent.mouseDown(refEl, { clientX: 4, clientY: 7 });
		} finally {
			Range.prototype.getClientRects = origRects;
			Range.prototype.getBoundingClientRect = origRect;
		}

		expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/new");
	});
});
