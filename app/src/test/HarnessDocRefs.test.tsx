import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Routes, Route, useLocation } from "react-router-dom";
import { EditorView } from "@codemirror/view";

import { HarnessDocEditor } from "@/screens/HarnessDocEditor";
import { useAppStore, type HarnessStatus } from "@/store";
import { renderWithProviders, makeQueryClient, primeRegistry, sampleRegistry, mockCommands } from "@/test/helpers";
import type { Registry } from "@/types";

// ─── Fixture: two known harnesses, and a registry that adds `code-review`
// (`brainstorm` is already in `sampleRegistry`) so a harness doc can mention
// both. Mirrors the fixture shape `SkillRefsSection.test.tsx` uses. ─────────

const CLAUDE: HarnessStatus = {
	id: "claude-code",
	label: "Claude Code",
	installed: true,
	on_globally: true,
	used_by_projects: [],
	global_doc: "/home/test/.claude/CLAUDE.md",
	global_doc_exists: true,
};

const PI: HarnessStatus = {
	id: "pi",
	label: "Pi",
	installed: true,
	on_globally: false,
	used_by_projects: [],
	global_doc: "/home/test/.pi/agent/AGENTS.md",
	global_doc_exists: false,
};

const DOC_STATUS = [
	{
		harness: "claude-code",
		label: "Claude Code",
		path: "/home/test/.claude/CLAUDE.md",
		state: "standalone",
		follows: null,
		followers: [],
		bytes: 40,
	},
	{
		harness: "pi",
		label: "Pi",
		path: "/home/test/.pi/agent/AGENTS.md",
		state: "missing",
		follows: null,
		followers: [],
		bytes: null,
	},
];

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

const DOC_CONTENT: Record<string, string> = {
	"claude-code": "Use `code-review` and `brainstorm` before merging.",
	pi: "",
};

function mockInvoke(content: Record<string, string> = DOC_CONTENT, docStatus: unknown[] = DOC_STATUS) {
	mockCommands({
		global_doc_read: (args: unknown) => {
			const harnessId = (args as { harnessId?: string } | undefined)?.harnessId ?? "claude-code";
			const path =
				harnessId === "pi" ? "/home/test/.pi/agent/AGENTS.md" : "/home/test/.claude/CLAUDE.md";
			return {
				path,
				resolved_path: path,
				is_link: false,
				exists: true,
				content: content[harnessId] ?? "",
				sha256: "sha-loaded",
			};
		},
		global_doc_write: { sha256: "sha-written" },
		hub_cmd: (args: unknown) => {
			const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
			if (cmdArgs[0] === "harness" && cmdArgs[1] === "doc" && cmdArgs[2] === "status") {
				return { success: true, output: JSON.stringify(docStatus) };
			}
			return { success: true, output: "" };
		},
	});
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

function renderEditor(route: string, registryData: Registry = registry) {
	const client = makeQueryClient();
	primeRegistry(client, registryData);
	return renderWithProviders(
		<Routes>
			<Route path="/harness/:id/doc" element={<HarnessDocEditor />} />
			<Route path="/skill/:name" element={<TargetProbe />} />
			<Route path="/harnesses" element={<TargetProbe />} />
		</Routes>,
		{ client, initialRoute: route },
	);
}

/** Expand the section only when it is collapsed — matches
 *  `SkillRefsSection.test.tsx`'s own helper. */
function ensureOpen(head: HTMLElement) {
	if (head.getAttribute("aria-expanded") === "false") fireEvent.click(head);
}

/** Reliably drive a CodeMirror text change so the buffer goes dirty. Copied
 *  from `HarnessDocEditor.test.tsx` — see its own comment for why the wait +
 *  `act` are both needed. */
async function typeInto(container: HTMLElement, insert: string, settled = "") {
	await waitFor(() => {
		expect(container.querySelector(".cm-editor")).toBeInTheDocument();
		expect(container.querySelector(".cm-content")?.textContent ?? "").toContain(settled);
	});
	const el = container.querySelector(".cm-editor") as HTMLElement;
	const view = EditorView.findFromDOM(el)!;
	await act(async () => {
		view.dispatch({ changes: { from: 0, insert } });
	});
}

function expectDirty() {
	return waitFor(() =>
		expect(document.querySelector(".doc-editor-bar-right .btn-signal")).toBeInTheDocument(),
	);
}

beforeEach(() => {
	useAppStore.setState({ harnesses: [CLAUDE, PI], mutating: false });
});

describe("HarnessDocEditor — skill references", () => {
	it("renders References with rows for code-review and brainstorm", async () => {
		mockInvoke();
		renderEditor("/harness/claude-code/doc");
		const head = await screen.findByTestId("side-section-refs");
		expect(head).toHaveTextContent("References");
		ensureOpen(head);
		expect(screen.getByTestId("skill-ref-row-out-code-review")).toBeInTheDocument();
		expect(screen.getByTestId("skill-ref-row-out-brainstorm")).toBeInTheDocument();
	});

	it("a row click lands on /skill/code-review with the harness doc as referrer", async () => {
		mockInvoke();
		renderEditor("/harness/claude-code/doc");
		const head = await screen.findByTestId("side-section-refs");
		ensureOpen(head);
		fireEvent.click(screen.getByTestId("skill-ref-row-out-code-review"));
		await waitFor(() =>
			expect(screen.getByTestId("target-path")).toHaveTextContent("/skill/code-review"),
		);
		const state = JSON.parse(screen.getByTestId("target-state").textContent || "null");
		expect(state.from.label).toBe("Claude Code");
		expect(state.from.path).toBe("/harness/claude-code/doc");
	});

	it("/harness/pi/doc (empty doc) renders no side-section-refs", async () => {
		mockInvoke();
		renderEditor("/harness/pi/doc");
		await waitFor(() => expect(document.querySelector(".doc-editor-shell")).toBeInTheDocument());
		expect(screen.queryByTestId("side-section-refs")).toBeNull();
	});

	it("with the buffer dirty, an attempted navigation raises the leave confirm and stays; Leave proceeds", async () => {
		mockInvoke({ "claude-code": "# Loaded body\n", pi: "" });
		const { container } = renderEditor("/harness/claude-code/doc");
		await typeInto(container, "PREFIX ", "Loaded body");
		await expectDirty();

		fireEvent.click(screen.getByRole("button", { name: /harnesses/i }));

		await waitFor(() => expect(screen.getByText("Leave without saving?")).toBeInTheDocument());
		// The navigation was refused — still on the doc editor, not the probe.
		expect(screen.queryByTestId("target-path")).toBeNull();
		expect(document.querySelector(".doc-editor-shell")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /^leave$/i }));

		await waitFor(() =>
			expect(screen.getByTestId("target-path")).toHaveTextContent("/harnesses"),
		);
	});
});
