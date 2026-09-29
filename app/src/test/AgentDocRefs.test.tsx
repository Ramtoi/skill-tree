import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { EditorView } from "@codemirror/view";
import { AgentDocsView } from "@/components/AgentDocsView";
import { renderWithProviders, primeRegistry, sampleRegistry } from "./helpers";
import { attemptNavigation } from "@/lib/navGuard";
import type { AgentDocContent, AgentDocFile, AgentDocsListing } from "@/types/agentDocs";
import type { Registry } from "@/types";

// ─── Fixture: a project with four root docs — AGENTS.md (mentions
// `code-review` + /brainstorm), NOTES.md (no mentions), PLAN.md (mentions
// `code-review` only), and DRAFT.md (missing — the create-draft branch). ────

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

function fileRow(rel: string, exists: boolean): AgentDocFile {
	return {
		rel,
		name: rel,
		label: rel,
		absolute_path: `/p/${rel}`,
		exists,
		is_known: true,
		is_discovered: false,
		is_symlink: false,
		symlink_to: null,
		symlink_target_in_project: false,
		can_read: exists,
		can_write: true,
		size: exists ? 40 : null,
		modified_at: exists ? 1716_000_000 : null,
		hash: exists ? `hash-${rel}` : null,
		error: null,
	};
}

const REL_BODY: Record<string, string> = {
	"AGENTS.md": "Use `code-review` before merging. Also see /brainstorm for ideas.",
	"NOTES.md": "Just notes, no ref here.",
	"PLAN.md": "Run `code-review` once more.",
};

function docsListing(): AgentDocsListing {
	return {
		project_path: "/p",
		all_rels: ["AGENTS.md", "NOTES.md", "PLAN.md", "DRAFT.md"],
		instruction_rels: ["AGENTS.md", "NOTES.md", "PLAN.md", "DRAFT.md"],
		external_imports: [],
		ignored_count: 0,
		include_ignored: false,
		required_formats: ["AGENT"],
		instruction_sets: [],
		policy: {
			requires_claude: false,
			requires_agent: true,
			strategy: "symlink",
			canonical: "AGENTS.md",
			derived: "CLAUDE.md",
		},
		root: {
			name: "",
			path: "",
			files: [
				fileRow("AGENTS.md", true),
				fileRow("NOTES.md", true),
				fileRow("PLAN.md", true),
				fileRow("DRAFT.md", false),
			],
			dirs: [],
		},
	} as AgentDocsListing;
}

function docContent(rel: string): AgentDocContent {
	const body = REL_BODY[rel] ?? "";
	return {
		rel,
		absolute_path: `/p/${rel}`,
		content: body,
		size: body.length,
		modified_at: 1716_000_000,
		hash: `hash-${rel}`,
		is_symlink: false,
		symlink_to: null,
		oversized: false,
		is_derived_pointer: false,
	};
}

function setupInvoke() {
	vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === "list_agent_docs") return docsListing();
		if (cmd === "read_agent_doc") {
			const a = (args ?? {}) as { relativePath: string };
			return docContent(a.relativePath);
		}
		if (cmd === "harness_list") return [];
		if (cmd === "hub_cmd") return { success: true, output: "" };
		return undefined;
	});
}

// The edit surface is a CodeMirror 6 editor — set its document by dispatching
// a transaction on the live EditorView, mirroring AgentDocsView.test.tsx.
function editorView(): EditorView {
	const dom = document.querySelector(".agent-docs-editor .cm-editor") as HTMLElement | null;
	if (!dom) throw new Error("CodeMirror editor not mounted");
	const view = EditorView.findFromDOM(dom);
	if (!view) throw new Error("no EditorView for .cm-editor");
	return view;
}

function setEditorContent(value: string) {
	const view = editorView();
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
}

function editorText(): string {
	return editorView().state.doc.toString();
}

function TargetProbe() {
	const location = useLocation();
	return (
		<div>
			<span data-testid="target-path">{location.pathname}</span>
			<span data-testid="target-state">{JSON.stringify(location.state)}</span>
		</div>
	);
}

/** Mirrors ProjectWorkspace's own wiring: the project area strip's `onChange`
 *  goes through `attemptNavigation` (F7), and `AgentDocsView` only mounts
 *  while `view === "agent-docs"` — a component-state switch, not a route
 *  change, which is exactly why the busiest exit needed its own guard. */
function ProjectHost() {
	const [view, setView] = useState<"agent-docs" | "loadout">("agent-docs");
	return (
		<>
			{view === "agent-docs" && (
				<AgentDocsView
					projectName="moon-base"
					projectPath="/p"
					projectHarnesses={["claude-code"]}
					navigator={
						<button
							type="button"
							onClick={() => attemptNavigation(() => setView("loadout"))}
						>
							Loadout
						</button>
					}
				/>
			)}
			{view === "loadout" && <div data-testid="loadout-view">Loadout</div>}
		</>
	);
}

function renderPane(
	initialRoute:
		| string
		| { pathname: string; search?: string; state?: unknown } = "/project/moon-base?tab=agent-docs",
) {
	setupInvoke();
	const { client } = renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectHost />} />
			<Route path="/skill/:name" element={<TargetProbe />} />
		</Routes>,
		{ initialRoute },
	);
	primeRegistry(client, registry);
	return client;
}

describe("AgentDocRefs", () => {
	it("renders the References strip above AppliedSnippetsStrip (DOM order)", async () => {
		renderPane();
		const strip = await screen.findByTestId("agent-docs-refs-strip");
		const appliedHead = screen.getByText("Applied snippets").closest(".snip-strip");
		expect(appliedHead).not.toBeNull();
		// strip precedes appliedHead in document order.
		expect(
			strip.compareDocumentPosition(appliedHead as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("a strip row click carries the agent-docs back target with the open file restored", async () => {
		renderPane();
		const strip = await screen.findByTestId("agent-docs-refs-strip");
		fireEvent.click(within(strip).getByTestId("skill-ref-row-out-code-review"));
		await waitFor(() =>
			expect(screen.getByTestId("target-path")).toHaveTextContent("/skill/code-review"),
		);
		const state = JSON.parse(screen.getByTestId("target-state").textContent || "null");
		expect(state.from.path).toBe("/project/moon-base?tab=agent-docs");
		expect(state.from.restore).toEqual({ adSelected: "AGENTS.md" });
	});

	it("recomputes the strip's rows when the selected file changes", async () => {
		renderPane();
		let strip = await screen.findByTestId("agent-docs-refs-strip");
		expect(within(strip).getByTestId("skill-ref-row-out-code-review")).toBeInTheDocument();
		expect(within(strip).getByTestId("skill-ref-row-out-brainstorm")).toBeInTheDocument();

		fireEvent.click(screen.getByText("PLAN.md"));
		await waitFor(() => expect(editorText()).toMatch(/Run/));
		strip = screen.getByTestId("agent-docs-refs-strip");
		expect(within(strip).getByTestId("skill-ref-row-out-code-review")).toBeInTheDocument();
		expect(within(strip).queryByTestId("skill-ref-row-out-brainstorm")).toBeNull();
	});

	it("renders no strip for a buffer with no mentions", async () => {
		renderPane();
		await screen.findByTestId("agent-docs-refs-strip");
		fireEvent.click(screen.getByText("NOTES.md"));
		await waitFor(() => expect(editorText()).toMatch(/Just notes/));
		expect(screen.queryByTestId("agent-docs-refs-strip")).toBeNull();
	});

	it("seeds the selection from restore.adSelected", async () => {
		renderPane({
			pathname: "/project/moon-base",
			search: "?tab=agent-docs",
			state: { adSelected: "PLAN.md" },
		});
		await waitFor(() => expect(editorText()).toMatch(/Run/));
		expect(document.querySelector(".ad-doc-name")?.textContent).toBe("PLAN.md");
	});

	it("falls back to the default selection when restore.adSelected names a file absent from the tree", async () => {
		renderPane({
			pathname: "/project/moon-base",
			search: "?tab=agent-docs",
			state: { adSelected: "nope.md" },
		});
		await waitFor(() =>
			expect(document.querySelector(".ad-doc-name")?.textContent).toBe("AGENTS.md"),
		);
	});

	it("threads the refs extension and link renderer into every Edit/Preview branch, including the create-draft one", async () => {
		renderPane();
		await screen.findByTestId("agent-docs-refs-strip");

		// Existing-file branch: decoration present in Edit mode, link present
		// once switched to Preview.
		await waitFor(() => expect(document.querySelector(".cm-skill-ref")).not.toBeNull());
		fireEvent.click(screen.getByText("Preview"));
		await waitFor(() => expect(document.querySelector(".md-skill-ref")).not.toBeNull());
		fireEvent.click(screen.getByText("Edit"));

		// Create-draft branch: DRAFT.md does not exist yet.
		fireEvent.click(screen.getByText("DRAFT.md"));
		await waitFor(() => expect(screen.getByText(/doesn't exist yet/)).toBeInTheDocument());
		act(() => setEditorContent("Try `code-review` here."));
		await waitFor(() => expect(document.querySelector(".cm-skill-ref")).not.toBeNull());
		fireEvent.click(screen.getByText("Preview"));
		await waitFor(() => expect(document.querySelector(".md-skill-ref")).not.toBeNull());
	});

	it("(F7) raises the leave confirm on a dirty buffer's project-area switch, and Leave completes it", async () => {
		renderPane();
		await waitFor(() => expect(editorText()).toMatch(/code-review/));
		act(() => setEditorContent("dirty edit\n"));
		await waitFor(() => expect(screen.getAllByText("UNSAVED").length).toBeGreaterThan(0));

		fireEvent.click(screen.getByText("Loadout"));
		expect(screen.getByText("Leave without saving?")).toBeInTheDocument();
		expect(screen.queryByTestId("loadout-view")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Leave" }));
		await waitFor(() => expect(screen.getByTestId("loadout-view")).toBeInTheDocument());
	});
});
