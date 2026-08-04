import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { EditorView } from "@codemirror/view";

import { HarnessDocEditor } from "@/screens/HarnessDocEditor";
import { useAppStore, type HarnessStatus } from "@/store";
import { renderWithProviders } from "./helpers";

const CLAUDE: HarnessStatus = {
	id: "claude-code",
	label: "Claude Code",
	installed: true,
	on_globally: true,
	used_by_projects: [],
	global_doc: "/home/test/.claude/CLAUDE.md",
	global_doc_exists: true,
};

const CODEX_MISSING: HarnessStatus = {
	id: "codex",
	label: "Codex",
	installed: true,
	on_globally: false,
	used_by_projects: [],
	global_doc: "/home/test/.codex/AGENTS.md",
	global_doc_exists: false,
};

function renderEditor(route: string) {
	return renderWithProviders(
		<Routes>
			<Route path="/harness/:id/doc" element={<HarnessDocEditor />} />
		</Routes>,
		{ initialRoute: route },
	);
}

/** Reliably drive a CodeMirror text change (fires onChange → marks dirty).
 *  Waits until the seeded content has settled (so the dispatch isn't clobbered
 *  by the async load's seeding effect) before inserting. */
async function typeInto(
	container: HTMLElement,
	insert: string,
	settled = "",
) {
	await waitFor(() => {
		expect(container.querySelector(".cm-editor")).toBeInTheDocument();
		expect(container.querySelector(".cm-content")?.textContent ?? "").toContain(
			settled,
		);
	});
	const el = container.querySelector(".cm-editor") as HTMLElement;
	const view = EditorView.findFromDOM(el)!;
	view.dispatch({ changes: { from: 0, insert } });
}

function mockReadWrite(opts: {
	content?: string;
	exists?: boolean;
	sha256?: string | null;
	writeReject?: string;
}) {
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		if (cmd === "global_doc_read") {
			return {
				path: "/home/test/.claude/CLAUDE.md",
				exists: opts.exists ?? true,
				content: opts.content ?? "# Global\n\nBe concise.\n",
				sha256: opts.sha256 === undefined ? "sha-loaded" : opts.sha256,
			};
		}
		if (cmd === "global_doc_write") {
			if (opts.writeReject) throw new Error(opts.writeReject);
			return { sha256: "sha-written" };
		}
		return undefined;
	}) as never);
}

beforeEach(() => {
	useAppStore.setState({ harnesses: [CLAUDE, CODEX_MISSING], mutating: false });
});

describe("HarnessDocEditor", () => {
	it("loads the harness global doc into the editor shell", async () => {
		mockReadWrite({ content: "# Loaded body\n" });
		renderEditor("/harness/claude-code/doc");
		await waitFor(() => {
			expect(document.querySelector(".doc-editor-shell")).toBeInTheDocument();
		});
		expect(invoke).toHaveBeenCalledWith("global_doc_read", {
			harnessId: "claude-code",
		});
		expect(screen.getByText("/home/test/.claude/CLAUDE.md")).toBeInTheDocument();
	});

	it("edit → UNSAVED pill → save calls write with the loaded sha", async () => {
		mockReadWrite({ content: "# Loaded body\n", sha256: "sha-loaded" });
		const { container } = renderEditor("/harness/claude-code/doc");
		await typeInto(container, "PREFIX ", "Loaded body");
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"global_doc_write",
				expect.objectContaining({
					harnessId: "claude-code",
					expectedSha256: "sha-loaded",
				}),
			),
		);
	});

	it("a drift error surfaces the overwrite confirm; force-retry passes null sha", async () => {
		mockReadWrite({
			content: "# Loaded body\n",
			sha256: "sha-loaded",
			writeReject: "drift: CLAUDE.md changed on disk",
		});
		const { container } = renderEditor("/harness/claude-code/doc");
		await typeInto(container, "PREFIX ", "Loaded body");
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());

		fireEvent.keyDown(window, { key: "s", metaKey: true });

		// Drift dialog appears with an Overwrite action.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /overwrite/i }),
			).toBeInTheDocument(),
		);

		// Now let the forced write succeed.
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "global_doc_write") return { sha256: "sha-written" };
			if (cmd === "harness_list") return [CLAUDE, CODEX_MISSING];
			return {
				path: "/home/test/.claude/CLAUDE.md",
				exists: true,
				content: "# Loaded body\n",
				sha256: "sha-loaded",
			};
		}) as never);

		fireEvent.click(screen.getByRole("button", { name: /overwrite/i }));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"global_doc_write",
				expect.objectContaining({
					harnessId: "claude-code",
					expectedSha256: null,
				}),
			),
		);
	});

	it("missing file → create-on-save note + first save (sha null)", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "global_doc_read") {
				return {
					path: "/home/test/.codex/AGENTS.md",
					exists: false,
					content: "",
					sha256: null,
				};
			}
			if (cmd === "global_doc_write") return { sha256: "sha-written" };
			return undefined;
		}) as never);

		const { container } = renderEditor("/harness/codex/doc");
		await waitFor(() =>
			expect(screen.getByText(/doesn't exist yet/i)).toBeInTheDocument(),
		);

		await typeInto(container, "# new file\n");
		await waitFor(() => expect(screen.getByText("UNSAVED")).toBeInTheDocument());
		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"global_doc_write",
				expect.objectContaining({
					harnessId: "codex",
					expectedSha256: null,
				}),
			),
		);
	});

	it("unknown harness id → EmptyState with a way back", async () => {
		mockReadWrite({});
		renderEditor("/harness/aider/doc");
		await waitFor(() =>
			expect(screen.getByText(/No such harness/i)).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: /Harnesses/i }),
		).toBeInTheDocument();
	});
});
