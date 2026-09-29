import { join } from "node:path";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { EditorView } from "@codemirror/view";
import { Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Snippets } from "@/screens/Snippets";
import { SnippetEditor } from "@/screens/SnippetEditor";
import { AppliedLocationsPanel } from "@/components/snippets/AppliedLocationsPanel";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import type { SnippetInfo, SnippetLocation } from "@/types/snippets";
import { deferredInvoke, makeDeferred, renderWithProviders, sampleRegistry } from "./helpers";
import { expectOnlySidePanelSections } from "./helpers/disclosureGuard";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	revealItemInDir: vi.fn(async () => undefined),
}));

const LIB: SnippetInfo[] = [
	{
		name: "validation-procedure",
		description: "Validation steps to run at the end of a task.",
		tags: ["workflow", "quality"],
		version: 3,
		created: "",
		updated: "today",
		hash: "aaa111bbb222",
		usage: { count: 2, summary: "outdated", outdated_count: 1 },
	},
	{
		name: "documentation-style",
		description: "House rules for writing docs.",
		tags: ["docs"],
		version: 1,
		created: "",
		updated: "1w ago",
		hash: "ccc333ddd444",
		usage: { count: 0, summary: "none", outdated_count: 0 },
	},
];

const SHOW_VALIDATION = {
	...LIB[0],
	body: "## Validation\n\n1. Build.\n",
	usage: {
		count: 2,
		summary: "outdated" as const,
		outdated_count: 1,
		locations: [
			{
				project: "demo",
				rel: "AGENTS.md",
				path: "/p/AGENTS.md",
				snippet: "validation-procedure",
				version: "3",
				applied_sha: "aaa111bbb222",
				status: "applied" as const,
			},
			{
				project: "other",
				rel: "AGENTS.md",
				path: "/o/AGENTS.md",
				snippet: "validation-procedure",
				version: "1",
				applied_sha: "000999888777",
				status: "outdated" as const,
			},
		],
	},
};

/** 9 locations (past `FILTER_THRESHOLD` = 8) across 3 projects, nested rel
 *  paths, and one of every status — the row/filter/menu tests below render
 *  `AppliedLocationsPanel` directly against this, no `SnippetEditor` needed. */
const DENSE_LOCATIONS: SnippetLocation[] = [
	{ project: "example-app", rel: "AGENTS.md", path: "/Users/dev/example-app/AGENTS.md", snippet: "dense-snippet", version: "3", applied_sha: "aaa", status: "applied" },
	{ project: "example-app", rel: "apps/mobile/AGENTS.md", path: "/Users/dev/example-app/apps/mobile/AGENTS.md", snippet: "dense-snippet", version: "3", applied_sha: "aaa", status: "applied" },
	{ project: "example-app", rel: "apps/web/AGENTS.md", path: "/Users/dev/example-app/apps/web/AGENTS.md", snippet: "dense-snippet", version: "2", applied_sha: "bbb", status: "outdated" },
	{ project: "example-app", rel: "packages/ui/AGENTS.md", path: "/Users/dev/example-app/packages/ui/AGENTS.md", snippet: "dense-snippet", version: "3", applied_sha: "aaa", status: "applied" },
	{ project: "example-app", rel: "packages/core/AGENTS.md", path: "/Users/dev/example-app/packages/core/AGENTS.md", snippet: "dense-snippet", version: "1", applied_sha: "ccc", status: "modified" },
	{ project: "moon-base", rel: "AGENTS.md", path: "/Users/dev/moon-base/AGENTS.md", snippet: "dense-snippet", version: "3", applied_sha: "aaa", status: "applied" },
	{ project: "moon-base", rel: "docs/AGENTS.md", path: "/Users/dev/moon-base/docs/AGENTS.md", snippet: "dense-snippet", version: "2", applied_sha: "bbb", status: "outdated" },
	{ project: "skill-hub", rel: "AGENTS.md", path: "/Users/dev/skill-hub/AGENTS.md", snippet: "dense-snippet", version: "3", applied_sha: "aaa", status: "applied" },
	{ project: "skill-hub", rel: "docs/guides/AGENTS.md", path: "/Users/dev/skill-hub/docs/guides/AGENTS.md", snippet: "dense-snippet", version: "3", applied_sha: "aaa", status: "applied" },
];

function renderPanel(props: Partial<Parameters<typeof AppliedLocationsPanel>[0]> = {}) {
	return renderWithProviders(
		<>
			<AppliedLocationsPanel
				name="dense-snippet"
				version={3}
				locations={DENSE_LOCATIONS}
				onApplyOpen={() => {}}
				onUpdateEverywhere={() => {}}
				onMutated={() => {}}
				{...props}
			/>
			<LocationProbe />
		</>,
	);
}

function mockSnippetBackend() {
	vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
		switch (cmd) {
			case "snippets_list":
				return LIB;
			case "snippet_show":
				// The editor reads "not found" off this call's error, not off the
				// list — a name the library never had must fail here.
				if ((args as { name: string }).name === "no-such-snippet")
					throw new Error("no such snippet");
				return SHOW_VALIDATION;
			case "snippet_status":
				return { locations: SHOW_VALIDATION.usage.locations, damaged: [] };
			case "snippet_new":
				return { ...LIB[1], name: (args as { name: string }).name };
			case "snippet_edit":
				// An honest `SnippetEditResult`: SHOW_VALIDATION's own locations are
				// 1 applied + 1 outdated, so a body edit refreshes 2.
				return {
					...SHOW_VALIDATION,
					version: SHOW_VALIDATION.version + 1,
					body_changed: true,
					outdated_locations: 2,
				};
			case "snippet_update":
				return {
					action: "update-everywhere",
					snippet: "validation-procedure",
					refreshed: [{}],
					skipped: [SHOW_VALIDATION.usage.locations[0]],
				};
			case "snippet_delete":
				return { deleted: "validation-procedure", orphaned_blocks: [] };
			case "read_registry":
				return sampleRegistry;
			default:
				return undefined;
		}
	});
}

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{loc.pathname}</div>;
}

/** The landing route redirects into `/snippet/:name`; a probe there is enough
 *  to see WHERE it redirected without needing the full editor mounted. */
function renderLanding(initialRoute = "/snippets") {
	return renderWithProviders(
		<Routes>
			<Route path="/snippets" element={<Snippets />} />
			<Route path="/snippet/:name" element={<LocationProbe />} />
		</Routes>,
		{ initialRoute },
	);
}

/** The editor route; `/snippets` (reached via delete) is a probe here too — the
 *  landing's own redirect logic is covered separately, above. */
function renderEditor(initialRoute: string) {
	// The probe is a plain sibling, not a route: a delete lands on ANOTHER
	// `/snippet/:name`, which must still render the editor.
	return renderWithProviders(
		<>
			<Routes>
				<Route path="/snippets" element={<Snippets />} />
				<Route path="/snippet/:name" element={<SnippetEditor />} />
			</Routes>
			<LocationProbe />
		</>,
		{ initialRoute },
	);
}

describe("Snippets landing — redirect", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [], recentlyVisited: [] });
		mockSnippetBackend();
	});

	it("redirects to the first snippet alphabetically with no recent chip", async () => {
		renderLanding();
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/snippet/documentation-style",
			),
		);
	});

	it("fetches the redirect list with noUsage: true (names-only fast path)", async () => {
		renderLanding();
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"snippets_list",
				expect.objectContaining({ noUsage: true }),
			),
		);
	});

	it("redirects to the most recently visited snippet that still exists", async () => {
		useAppStore.setState({
			recentlyVisited: [{ type: "snippet", name: "validation-procedure" }],
		});
		renderLanding();
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/snippet/validation-procedure",
			),
		);
	});

	it("ignores a recent chip for a snippet that no longer exists", async () => {
		useAppStore.setState({
			recentlyVisited: [{ type: "snippet", name: "deleted-long-ago" }],
		});
		renderLanding();
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/snippet/documentation-style",
			),
		);
	});
});

describe("Snippets landing — empty and loading", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [], recentlyVisited: [] });
	});

	it("shows exactly one empty state whose CTA goes to /snippet/new", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) =>
			cmd === "snippets_list"
				? []
				: cmd === "read_registry"
					? sampleRegistry
					: undefined,
		);
		const { container } = renderLanding();
		await screen.findByText("No snippets yet");
		expect(container.querySelectorAll(".empty-state")).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: /New snippet/ }));
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe("/snippet/new"),
		);
	});

	it("never flashes the empty-library takeover while the list is in flight", async () => {
		const gate = makeDeferred<SnippetInfo[]>();
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "snippets_list") return gate.promise;
			if (cmd === "read_registry") return sampleRegistry;
			return undefined;
		}) as never);

		renderLanding();

		expect(screen.queryByText("No snippets yet")).toBeNull();
		expect(screen.queryByRole("button", { name: "New snippet" })).toBeNull();
		expect(screen.getByText("Loading snippets")).toBeInTheDocument();

		await act(async () => {
			gate.resolve(LIB);
		});
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/snippet/documentation-style",
			),
		);
	});
});

describe("SnippetEditor — existing snippet", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		mockSnippetBackend();
	});

	it("renders the name in the header with version + applied tags", async () => {
		renderEditor("/snippet/validation-procedure");
		// The route name alone paints the loading header too (same identity, no
		// data yet) — wait for the loaded editor itself before reading tags.
		await screen.findByText(/Applied to/);
		expect(
			document.querySelector(".main-header .title-mono")?.textContent,
		).toBe("validation-procedure");
		expect(screen.getByText("v3")).toBeInTheDocument();
		expect(screen.getByText("2 applied")).toBeInTheDocument();
		// Scoped to the header: the side panel's APPLIED TO summary reads the
		// same "1 outdated" words.
		const header = document.querySelector(".main-header") as HTMLElement;
		expect(within(header).getByText("1 outdated")).toBeInTheDocument();
	});

	it("the compact TAGS input shows a named + affordance, never an ellipsised word", async () => {
		renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		const tagInput = screen.getByRole("textbox", { name: "Add tag" });
		expect(tagInput).toHaveAttribute("placeholder", "+");
	});

	it("fetches the snippet with noUsage: true — the editor never waits on show's own scan", async () => {
		renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		expect(invoke).toHaveBeenCalledWith("snippet_show", {
			name: "validation-procedure",
			noUsage: true,
		});
	});

	it("shows scan-derived applied locations with status badges", async () => {
		renderEditor("/snippet/validation-procedure");
		expect(await screen.findByText(/Applied to/)).toBeInTheDocument();
		expect(screen.getByText("demo")).toBeInTheDocument();
		expect(screen.getByText("other")).toBeInTheDocument();
		// The status word now lives on the dot's own `aria-label` (and the row's
		// `title`) — `getByTitle` here would resolve the row `<div>` instead of
		// the badge it was written for, and would keep passing even if the
		// badge were deleted outright.
		expect(screen.getByLabelText("applied")).toBeInTheDocument();
		expect(screen.getByLabelText("outdated")).toBeInTheDocument();
	});

	it("update everywhere reports skipped modified blocks", async () => {
		renderEditor("/snippet/validation-procedure");
		const btn = await screen.findByTitle("Refresh every outdated location");
		fireEvent.click(btn);
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_update",
				expect.objectContaining({ name: "validation-procedure", all: true }),
			);
		});
		await waitFor(() => {
			const msgs = useAppStore
				.getState()
				.toasts.map((t) => `${t.title} ${t.body ?? ""}`);
			expect(
				msgs.some((m) => m.includes("1 modified block skipped")),
			).toBe(true);
		});
	});

	it("guarded delete lists affected files, warns about orphaning, and opens the next snippet", async () => {
		renderEditor("/snippet/validation-procedure");
		fireEvent.click(await screen.findByRole("button", { name: /Delete snippet/ }));
		const modal = await screen.findByText(/Delete validation-procedure\?/);
		expect(modal).toBeInTheDocument();
		const dialog = document.querySelector(".modal") as HTMLElement;
		expect(within(dialog).getByText(/read as/)).toBeInTheDocument();
		const dialogFiles = document.querySelectorAll(".snip-delete-file");
		expect(dialogFiles.length).toBe(2);

		fireEvent.click(
			screen.getByRole("button", { name: /Delete · leave 2 orphaned/ }),
		);
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("snippet_delete", {
				name: "validation-procedure",
				force: true,
			});
		});
		// Straight to the next snippet — never through `/snippets`, whose
		// redirect would read the cached list that still names the deleted one.
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/snippet/documentation-style",
			),
		);
	});

	it("has exactly one disclosure implementation on the side panel", async () => {
		const { container } = renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		const side = container.querySelector(".editor-side") as HTMLElement;
		const src = join(process.cwd(), "src");
		const editorPath = join(src, "screens", "SnippetEditor.tsx");
		const panelPath = join(src, "components", "snippets", "AppliedLocationsPanel.tsx");
		// APPLIED TO (AppliedLocationsPanel) + MARKER FORMAT (SnippetEditor) — the
		// only two `SidePanelSection`s on this panel.
		expectOnlySidePanelSections(side, 2, [editorPath, panelPath]);
	});

	it("shows a not-found empty state for an unknown name", async () => {
		renderEditor("/snippet/no-such-snippet");
		expect(await screen.findByText("Snippet not found")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Back to snippets/ }));
		// Through the real landing, which redirects to the first snippet.
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/snippet/documentation-style",
			),
		);
	});
});

describe("SnippetEditor — paints before the applied-locations scan resolves", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		mockSnippetBackend();
	});

	it("shows the body + header name, a skeleton pill, and a disabled Delete while the scan is pending — no Update everywhere", async () => {
		const gate = deferredInvoke((cmd) => cmd === "snippet_status");
		renderEditor("/snippet/validation-procedure");

		// The body paints from `snippet_show` alone — it never waits on the scan.
		// ("Applied to" renders in both the scanning and loaded states, so its
		// appearance here just marks the loaded editor, same as the other tests.)
		await screen.findByText(/Applied to/);
		expect(
			document.querySelector(".main-header .title-mono")?.textContent,
		).toBe("validation-procedure");
		expect(screen.getByText("v3")).toBeInTheDocument();

		// Usage is unknown mid-scan: a skeleton pill stands in for the tags.
		expect(document.querySelector(".snip-usage-skel")).toBeInTheDocument();
		expect(screen.queryByText("2 applied")).toBeNull();

		// The panel shows two row skeletons, no "Update everywhere", and no
		// "Not applied to any file yet" (that would be a lie mid-scan).
		expect(document.querySelectorAll(".snip-loc-list .lds-skel-row")).toHaveLength(2);
		expect(screen.queryByTitle("Refresh every outdated location")).toBeNull();
		expect(screen.queryByText("Not applied to any file yet.")).toBeNull();

		// "Apply to…" stays clickable during the scan — the header's primary
		// button is the one entry point (the panel's own footer button is
		// gone; it would only ever restate the header's verb).
		expect(screen.getByRole("button", { name: "Apply to…" })).not.toBeDisabled();

		// Delete is soft-disabled with a reason, not hard-removed.
		const deleteBtn = screen.getByRole("button", { name: /Delete snippet/ });
		expect(deleteBtn).toHaveAttribute("aria-disabled", "true");
		expect(deleteBtn).toHaveAttribute(
			"title",
			"Wait for the scan — deleting needs to know how many blocks it orphans.",
		);

		// Settle the scan before the test ends so no state update leaks into the
		// next test unwrapped.
		await act(async () => {
			gate.resolve({ locations: SHOW_VALIDATION.usage.locations, damaged: [] });
		});
	});

	it("swaps in the real tags, locations, and an enabled Delete once the scan resolves", async () => {
		const gate = deferredInvoke((cmd) => cmd === "snippet_status");
		renderEditor("/snippet/validation-procedure");

		await screen.findByText(/Applied to/);
		expect(document.querySelector(".snip-usage-skel")).toBeInTheDocument();

		await act(async () => {
			gate.resolve({ locations: SHOW_VALIDATION.usage.locations, damaged: [] });
		});

		await waitFor(() => expect(screen.getByText("2 applied")).toBeInTheDocument());
		// Scoped to the header: the side panel's APPLIED TO summary reads the
		// same "1 outdated" words.
		const header = document.querySelector(".main-header") as HTMLElement;
		expect(within(header).getByText("1 outdated")).toBeInTheDocument();
		expect(document.querySelector(".snip-usage-skel")).toBeNull();
		expect(screen.getByText("demo")).toBeInTheDocument();
		expect(screen.getByText("other")).toBeInTheDocument();

		const deleteBtn = screen.getByRole("button", { name: /Delete snippet/ });
		expect(deleteBtn).not.toHaveAttribute("aria-disabled");
	});
});

describe("SnippetEditor — Save becomes Save & update N", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		mockSnippetBackend();
	});

	/** Dispatches a real CodeMirror transaction that appends a line to the
	 *  body — `container.querySelector("textarea")` finds the DESCRIPTION
	 *  field's plain `<textarea>` on this screen, not the CodeMirror body, so
	 *  driving the body needs the editor view directly (same approach as the
	 *  "undo history isolation" CodeArea test: `EditorView.findFromDOM`). */
	function editBody(container: HTMLElement, insert = "\nOne more rule.") {
		const el = container.querySelector(".doc-editor-body .cm-editor") as HTMLElement;
		const view = EditorView.findFromDOM(el)!;
		view.dispatch({ changes: { from: view.state.doc.length, insert } });
	}

	/** The Save button's accessible name is its label plus the trailing `⌘S`
	 *  kbd hint (`"Save"` + `<kbd>⌘S</kbd>` -> `"Save ⌘S"`) — strip that
	 *  suffix before comparing against the label under test. */
	function saveButtonNamed(label: string) {
		return screen.getByRole("button", {
			name: (name) => name.replace(/ ⌘S$/, "") === label,
		});
	}
	function findSaveButtonNamed(label: string) {
		return screen.findByRole("button", {
			name: (name) => name.replace(/ ⌘S$/, "") === label,
		});
	}

	it("Save alone: editing only the description never calls snippet_update", async () => {
		renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);

		const descInput = screen.getByPlaceholderText(
			"One line — what this snippet instructs",
		);
		fireEvent.change(descInput, { target: { value: "Updated description." } });

		const saveBtn = saveButtonNamed("Save");
		fireEvent.click(saveBtn);
		expect(saveBtn).toHaveAttribute("aria-busy", "true");

		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_edit",
				expect.objectContaining({
					name: "validation-procedure",
					description: "Updated description.",
				}),
			);
		});
		await waitFor(() => expect(saveBtn).not.toHaveAttribute("aria-busy"));
		expect(invoke).not.toHaveBeenCalledWith(
			"snippet_update",
			expect.anything(),
		);
	});

	it("Save & update: a body edit turns Save into 'Save & update 2' and runs both writes as one process", async () => {
		const { container } = renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		act(() => editBody(container));

		const saveBtn = await findSaveButtonNamed("Save & update 2");
		const gate = deferredInvoke((cmd) => cmd === "snippet_update");
		fireEvent.click(saveBtn);

		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_update",
				expect.objectContaining({ name: "validation-procedure", all: true }),
			);
		});
		// Edit ran before update — same process, two ordered writes.
		const calls = vi.mocked(invoke).mock.calls.map((c) => c[0]);
		expect(calls.indexOf("snippet_edit")).toBeGreaterThanOrEqual(0);
		expect(calls.indexOf("snippet_update")).toBeGreaterThan(
			calls.indexOf("snippet_edit"),
		);

		await waitFor(() =>
			expect(saveButtonNamed("Updating 2…")).toHaveAttribute("aria-busy", "true"),
		);
		expect(document.querySelectorAll(".snip-loc-refreshing")).toHaveLength(2);
		expect(screen.queryByTitle("Refresh every outdated location")).toBeNull();

		await act(async () => {
			gate.resolve({
				action: "update-everywhere",
				snippet: "validation-procedure",
				refreshed: [{}, {}],
				skipped: [],
			});
		});

		await waitFor(() => {
			const msgs = useAppStore
				.getState()
				.toasts.map((t) => `${t.title} ${t.body ?? ""}`);
			expect(msgs.some((m) => m.includes("refreshed 2"))).toBe(true);
		});
		expect(invoke).toHaveBeenCalledWith(
			"snippet_status",
			expect.objectContaining({ name: "validation-procedure" }),
		);
	});

	it("locks 'Update everywhere' while Save's own write runs and starts exactly one refresh", async () => {
		const { container } = renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		expect(screen.getByTitle("Refresh every outdated location")).toBeInTheDocument();
		act(() => editBody(container));

		const gate = deferredInvoke((cmd) => cmd === "snippet_edit");
		fireEvent.click(await findSaveButtonNamed("Save & update 2"));
		// Phase 1 (the library write) is in flight and no refresh has started yet —
		// the panel's own refresh control must already be gone, or a click on it
		// would start a second `snippet update --all` beside the save.
		await waitFor(() =>
			expect(saveButtonNamed("Saving…")).toHaveAttribute("aria-busy", "true"),
		);
		expect(screen.queryByTitle("Refresh every outdated location")).toBeNull();

		await act(async () => {
			gate.resolve({
				...SHOW_VALIDATION,
				version: SHOW_VALIDATION.version + 1,
				body_changed: true,
				outdated_locations: 2,
			});
		});
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /^(Saving|Updating)/ })).toBeNull(),
		);
		const updates = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "snippet_update");
		expect(updates).toHaveLength(1);
	});

	it("Update everywhere marks only the outdated rows as updating — applied rows are not rewritten", async () => {
		renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		const gate = deferredInvoke((cmd) => cmd === "snippet_update");
		fireEvent.click(screen.getByTitle("Refresh every outdated location"));

		await waitFor(() =>
			expect(document.querySelectorAll(".snip-loc-refreshing")).toHaveLength(1),
		);
		expect(
			document.querySelector('.snip-loc[data-status="outdated"] .snip-loc-refreshing'),
		).not.toBeNull();
		expect(
			document.querySelector('.snip-loc[data-status="applied"] .snip-loc-refreshing'),
		).toBeNull();
		expect(screen.getByText(/refreshing 1…/)).toBeInTheDocument();

		await act(async () => {
			gate.resolve({
				action: "update-everywhere",
				snippet: "validation-procedure",
				refreshed: [{}],
				skipped: [],
			});
		});
		await waitFor(() =>
			expect(document.querySelectorAll(".snip-loc-refreshing")).toHaveLength(0),
		);
	});

	it("Retry after a failed write saves the buffer as it is NOW, not as it was at the click", async () => {
		Processes.dismissAllDone();
		const { container } = renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		act(() => editBody(container, "\nFirst edit."));

		const gate = deferredInvoke((cmd) => cmd === "snippet_edit");
		fireEvent.click(await findSaveButtonNamed("Save & update 2"));
		await act(async () => {
			gate.reject(new Error("disk full"));
		});
		const failed = await waitFor(() => {
			const p = Processes.list().find(
				(p) => p.status === "error" && p.title === "Saving validation-procedure",
			);
			expect(p).toBeDefined();
			return p!;
		});

		// The user keeps typing after the failure, then hits Retry on the card.
		mockSnippetBackend();
		act(() => editBody(container, "\nSecond edit."));
		await act(async () => {
			failed.retry?.();
		});
		await waitFor(() => {
			const bodies = vi
				.mocked(invoke)
				.mock.calls.filter((c) => c[0] === "snippet_edit")
				.map((c) => (c[1] as { body: string }).body);
			expect(bodies.length).toBe(2);
			expect(bodies[1]).toContain("Second edit.");
		});
	});

	it("excludes hand-edited (modified) locations from the refresh count and calls them out in the plaque", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			switch (cmd) {
				case "snippets_list":
					return LIB;
				case "snippet_show":
					return SHOW_VALIDATION;
				case "snippet_status":
					return {
						locations: [
							...SHOW_VALIDATION.usage.locations,
							{
								project: "third",
								rel: "AGENTS.md",
								path: "/t/AGENTS.md",
								snippet: "validation-procedure",
								version: "2",
								applied_sha: "555",
								status: "modified" as const,
							},
						],
						damaged: [],
					};
				case "snippet_edit":
					return {
						...SHOW_VALIDATION,
						version: SHOW_VALIDATION.version + 1,
						body_changed: true,
						outdated_locations: 2,
					};
				case "read_registry":
					return sampleRegistry;
				default:
					return undefined;
			}
		});
		const { container } = renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		act(() => editBody(container));

		expect(await findSaveButtonNamed("Save & update 2")).toBeInTheDocument();
		// Scoped to the plaque, not document-wide — the sentence must live where
		// the test name says it does.
		const plaque = document.querySelector(".source-banner") as HTMLElement;
		expect(
			within(plaque).getByText(/1 hand-edited block is kept as it is/),
		).toBeInTheDocument();
	});

	it("hides the save-consequence plaque while the save itself is in flight", async () => {
		const { container } = renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		act(() => editBody(container));
		expect(document.querySelector(".source-banner")).toBeInTheDocument();

		const gate = deferredInvoke((cmd) => cmd === "snippet_edit");
		fireEvent.click(await findSaveButtonNamed("Save & update 2"));
		await waitFor(() =>
			expect(saveButtonNamed("Saving…")).toHaveAttribute("aria-busy", "true"),
		);
		// The process card carries the message now — the plaque would otherwise
		// double up on it (`!saving` in the visibility gate).
		expect(document.querySelector(".source-banner")).toBeNull();

		await act(async () => {
			gate.resolve({
				...SHOW_VALIDATION,
				version: SHOW_VALIDATION.version + 1,
				body_changed: true,
				outdated_locations: 2,
			});
		});
	});

	it("edit ok, refresh fails: toast says so, a process errors, and the header still gets the new version", async () => {
		const { container } = renderEditor("/snippet/validation-procedure");
		await screen.findByText(/Applied to/);
		act(() => editBody(container));

		const saveBtn = await findSaveButtonNamed("Save & update 2");
		const gate = deferredInvoke((cmd) => cmd === "snippet_update");
		fireEvent.click(saveBtn);

		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_update",
				expect.objectContaining({ all: true }),
			);
		});

		await act(async () => {
			gate.reject(new Error("disk full"));
		});

		await waitFor(() => {
			const titles = useAppStore.getState().toasts.map((t) => t.title);
			expect(titles).toContain("Saved, but couldn't refresh locations");
		});
		expect(Processes.list().some((p) => p.status === "error")).toBe(true);
		// invalidate() ran despite the refresh failure — the snippet + scan
		// queries refetch so the header/rows stop lying about the edit.
		expect(
			vi.mocked(invoke).mock.calls.filter((c) => c[0] === "snippet_show").length,
		).toBeGreaterThan(1);
	});
});

// ─── Applied-locations rows: identity, filter, meta, row menu (wave 2b audit) ─
describe("AppliedLocationsPanel — dense rows", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
			const a = args as { name?: string; project?: string; relativePath?: string } | undefined;
			if (cmd === "snippet_remove") {
				return {
					action: "remove",
					snippet: a?.name ?? "dense-snippet",
					project: a?.project ?? "",
					rel: a?.relativePath ?? "",
					path: "",
					backup: null,
					mirrored: [],
				};
			}
			return undefined;
		});
	});

	it("shows a nested row's identity as the path relative to the project root, not the bare filename", async () => {
		renderPanel();
		const row = await screen.findByTitle(
			"/Users/dev/example-app/apps/mobile/AGENTS.md",
		);
		expect(row.textContent).toBe("apps/mobile/AGENTS.md");
	});

	it("gives `modified` its own ring, distinct from `outdated`'s filled dot", async () => {
		renderPanel();
		const modified = await screen.findByLabelText("modified");
		expect(modified).toHaveAttribute("data-shape", "ring");
		// Two outdated rows in the fixture — either carries the same shape.
		const [outdated] = screen.getAllByLabelText("outdated");
		expect(outdated).toHaveAttribute("data-shape", "dot");
	});

	it("shows the applied version only on outdated rows", async () => {
		renderPanel();
		await screen.findByTitle("/Users/dev/example-app/AGENTS.md");
		// Two outdated rows in the fixture, each stamped v2 or v1.
		expect(screen.getAllByText(/^v[12]$/)).toHaveLength(2);
		// No applied row's version ever renders, though every one carries a v3.
		expect(screen.queryByText("v3")).toBeNull();
	});

	it("hides the filter at exactly FILTER_THRESHOLD (8), shows it past it (9)", async () => {
		renderPanel({ locations: DENSE_LOCATIONS.slice(0, 8) });
		await screen.findByText("example-app");
		expect(screen.queryByPlaceholderText("Filter by project or path…")).toBeNull();
	});

	it("filter matches project name or relative path, and the empty state names the query", async () => {
		renderPanel();
		const input = await screen.findByPlaceholderText("Filter by project or path…");

		fireEvent.change(input, { target: { value: "moon-base" } });
		expect(screen.getByText("moon-base")).toBeInTheDocument();
		expect(screen.queryByText("example-app")).toBeNull();

		fireEvent.change(input, { target: { value: "docs/guides" } });
		expect(screen.getByTitle("/Users/dev/skill-hub/docs/guides/AGENTS.md")).toBeInTheDocument();
		expect(screen.queryByText("moon-base")).toBeNull();

		fireEvent.change(input, { target: { value: "nothing-matches-this" } });
		expect(screen.getByText(/No locations match/)).toBeInTheDocument();
	});

	it("resets the filter when the snippet name changes (no remount on /snippet/:name)", async () => {
		const { rerender } = renderPanel();
		const input = await screen.findByPlaceholderText("Filter by project or path…");
		fireEvent.change(input, { target: { value: "moon-base" } });
		expect((input as HTMLInputElement).value).toBe("moon-base");

		rerender(
			<>
				<AppliedLocationsPanel
					name="another-dense-snippet"
					version={3}
					locations={DENSE_LOCATIONS.map((l) => ({ ...l, snippet: "another-dense-snippet" }))}
					onApplyOpen={() => {}}
					onUpdateEverywhere={() => {}}
					onMutated={() => {}}
				/>
				<LocationProbe />
			</>,
		);
		const inputAfter = await screen.findByPlaceholderText("Filter by project or path…");
		expect((inputAfter as HTMLInputElement).value).toBe("");
		expect(screen.getByText("moon-base")).toBeInTheDocument();
	});

	it("row menu: Open in Agent Docs navigates to the project's Agent Docs area", async () => {
		renderPanel();
		const row = (await screen.findByTitle("/Users/dev/example-app/AGENTS.md")).closest(
			".snip-loc",
		) as HTMLElement;
		fireEvent.click(within(row).getByTestId("overflow-trigger"));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Agent Docs" }));
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/project/example-app",
			),
		);
	});

	it("row menu: Reveal in Finder calls the opener with the row's absolute path, and reports a failure", async () => {
		renderPanel();
		const row = (
			await screen.findByTitle("/Users/dev/example-app/apps/mobile/AGENTS.md")
		).closest(".snip-loc") as HTMLElement;
		fireEvent.click(within(row).getByTestId("overflow-trigger"));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Reveal in Finder" }));
		expect(revealItemInDir).toHaveBeenCalledWith(
			"/Users/dev/example-app/apps/mobile/AGENTS.md",
		);

		vi.mocked(revealItemInDir).mockRejectedValueOnce(new Error("gone"));
		fireEvent.click(within(row).getByTestId("overflow-trigger"));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Reveal in Finder" }));
		await waitFor(() => {
			const titles = useAppStore.getState().toasts.map((t) => t.title);
			expect(titles).toContain("Couldn't reveal the file");
		});
	});

	it("row menu: Copy path writes the absolute path to the clipboard and toasts", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.assign(navigator, { clipboard: { writeText } });
		renderPanel();
		const row = (await screen.findByTitle("/Users/dev/example-app/AGENTS.md")).closest(
			".snip-loc",
		) as HTMLElement;
		fireEvent.click(within(row).getByTestId("overflow-trigger"));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
		expect(writeText).toHaveBeenCalledWith("/Users/dev/example-app/AGENTS.md");
		await waitFor(() => {
			const titles = useAppStore.getState().toasts.map((t) => t.title);
			expect(titles).toContain("Path copied");
		});
	});

	it("row menu: Remove calls snippet_remove and the row stays busy until it settles", async () => {
		const gate = deferredInvoke((cmd) => cmd === "snippet_remove");
		const onMutated = vi.fn();
		renderPanel({ onMutated });
		const row = (await screen.findByTitle("/Users/dev/example-app/AGENTS.md")).closest(
			".snip-loc",
		) as HTMLElement;
		fireEvent.click(within(row).getByTestId("overflow-trigger"));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));

		await waitFor(() => expect(row).toHaveAttribute("data-busy", "true"));
		expect(invoke).toHaveBeenCalledWith(
			"snippet_remove",
			expect.objectContaining({ project: "example-app", relativePath: "AGENTS.md" }),
		);

		await act(async () => {
			gate.resolve({});
		});
		await waitFor(() => expect(row).not.toHaveAttribute("data-busy"));
		expect(onMutated).toHaveBeenCalled();
	});

	it("row menu: Remove is disabled while the row is mid-refresh", async () => {
		renderPanel({ refreshing: "outdated" });
		// The outdated example-app row is in refresh scope while `refreshing`.
		const row = (await screen.findByTitle("/Users/dev/example-app/apps/web/AGENTS.md")).closest(
			".snip-loc",
		) as HTMLElement;
		fireEvent.click(within(row).getByTestId("overflow-trigger"));
		const removeItem = await screen.findByRole("menuitem", { name: "Remove" });
		expect(removeItem).toBeDisabled();
	});
});

describe("SnippetEditor — create", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		mockSnippetBackend();
	});

	it("rejects invalid names and existing-name collisions", async () => {
		renderEditor("/snippet/new");
		const nameInput = await screen.findByPlaceholderText(
			"e.g. validation-procedure",
		);
		fireEvent.change(nameInput, { target: { value: "Bad Name!" } });
		expect(screen.getByText(/Use lowercase kebab-case/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Create snippet/ })).toBeDisabled();

		fireEvent.change(nameInput, { target: { value: "documentation-style" } });
		expect(screen.getByText(/already exists/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Create snippet/ })).toBeDisabled();
	});

	it("prefills the name from ?name= once", async () => {
		renderWithProviders(
			<Routes>
				<Route path="/snippet/:name" element={<SnippetEditor />} />
			</Routes>,
			{ initialRoute: "/snippet/new?name=Review-Checklist" },
		);
		const nameInput = await screen.findByPlaceholderText(
			"e.g. validation-procedure",
		);
		expect((nameInput as HTMLInputElement).value).toBe("review-checklist");
	});

	it("creates a snippet and navigates to its new route", async () => {
		// A plain sibling probe (not routed) so it reflects wherever navigation
		// lands without needing a second route shape to guess the target name.
		renderWithProviders(
			<>
				<Routes>
					<Route path="/snippet/:name" element={<SnippetEditor />} />
				</Routes>
				<LocationProbe />
			</>,
			{ initialRoute: "/snippet/new" },
		);
		const nameInput = await screen.findByPlaceholderText(
			"e.g. validation-procedure",
		);
		fireEvent.change(nameInput, { target: { value: "review-checklist" } });
		fireEvent.click(screen.getByRole("button", { name: /Create snippet/ }));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_new",
				expect.objectContaining({ name: "review-checklist" }),
			);
		});
		await waitFor(() =>
			expect(screen.getByTestId("loc").textContent).toBe(
				"/snippet/review-checklist",
			),
		);
	});

	it("shows aria-busy on Create until snippet_new resolves", async () => {
		renderWithProviders(
			<Routes>
				<Route path="/snippet/:name" element={<SnippetEditor />} />
			</Routes>,
			{ initialRoute: "/snippet/new" },
		);
		const nameInput = await screen.findByPlaceholderText(
			"e.g. validation-procedure",
		);
		fireEvent.change(nameInput, { target: { value: "review-checklist" } });

		const gate = deferredInvoke((cmd) => cmd === "snippet_new");
		const createBtn = screen.getByRole("button", { name: /Create snippet/ });
		fireEvent.click(createBtn);
		expect(createBtn).toHaveAttribute("aria-busy", "true");

		await act(async () => {
			gate.resolve({ ...LIB[1], name: "review-checklist" });
		});
		await waitFor(() => expect(createBtn).not.toHaveAttribute("aria-busy"));
	});
});
