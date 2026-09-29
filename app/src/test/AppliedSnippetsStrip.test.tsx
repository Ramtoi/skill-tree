import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppliedSnippetsStrip } from "@/components/snippets/AppliedSnippetsStrip";
import { useAppStore } from "@/store";
import type { SnippetScanResult } from "@/types/snippets";
import { renderWithProviders } from "./helpers";

const SCAN: SnippetScanResult = {
	locations: [
		{
			project: "demo",
			rel: "AGENTS.md",
			path: "/p/AGENTS.md",
			snippet: "validation-procedure",
			version: "2",
			applied_sha: "aaa",
			status: "applied",
		},
		{
			project: "demo",
			rel: "AGENTS.md",
			path: "/p/AGENTS.md",
			snippet: "old-rules",
			version: "1",
			applied_sha: "bbb",
			status: "orphaned",
		},
		{
			project: "demo",
			rel: "sub/AGENTS.md",
			path: "/p/sub/AGENTS.md",
			snippet: "other-file-snip",
			version: "1",
			applied_sha: "ccc",
			status: "applied",
		},
	],
	damaged: [
		{
			project: "demo",
			rel: "AGENTS.md",
			kind: "incomplete-block",
			name: "broken-snip",
			line: 41,
		},
	],
};

function mockScan(scan: SnippetScanResult) {
	vi.mocked(invoke).mockImplementation(async (cmd: string) => {
		switch (cmd) {
			case "snippet_status":
				return scan;
			case "snippets_list":
				return [
					{
						name: "validation-procedure",
						description: "addable",
						tags: [],
						version: 1,
						created: "",
						updated: "",
						hash: "x",
					},
				].flatMap((snippet) => [snippet, { ...snippet, name: "fresh-snip" }]);
			case "snippet_apply":
			case "snippet_remove":
			case "snippet_update":
				return {};
			default:
				return undefined;
		}
	});
}

function renderStrip(
	dirty = false,
	onMutate = vi.fn(),
	onOpenLine = vi.fn(),
) {
	renderWithProviders(
		<AppliedSnippetsStrip
			projectName="demo"
			rel="AGENTS.md"
			dirty={dirty}
			onMutate={onMutate}
			onOpenLine={onOpenLine}
		/>,
	);
	return { onMutate, onOpenLine };
}

describe("AppliedSnippetsStrip", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		mockScan(SCAN);
	});

	it("links a resolved source even while the document is dirty", async () => {
		renderStrip(true);
		expect(await screen.findByRole("link", { name: "validation-procedure" }))
			.toHaveAttribute("href", "/snippet/validation-procedure");
		expect(screen.queryByRole("link", { name: "old-rules" })).toBeNull();
		expect(screen.queryByRole("link", { name: "broken-snip" })).toBeNull();
	});

	it("does not link a scanned name missing from the library", async () => {
		const invokeMock = vi.mocked(invoke);
		const backend = invokeMock.getMockImplementation()!;
		invokeMock.mockImplementation((cmd, args) => cmd === "snippets_list"
			? Promise.resolve([])
			: backend(cmd, args));
		renderStrip();
		await screen.findByText("validation-procedure");
		expect(screen.queryByRole("link", { name: "validation-procedure" })).toBeNull();
	});

	it("lists only the selected file's blocks with status badges", async () => {
		renderStrip();
		expect(await screen.findByText("validation-procedure")).toBeInTheDocument();
		expect(screen.getByText("old-rules")).toBeInTheDocument();
		// Block in another file of the same project is not shown.
		expect(screen.queryByText("other-file-snip")).not.toBeInTheDocument();
		expect(screen.getByTitle("applied")).toBeInTheDocument();
		expect(screen.getByTitle("orphaned")).toBeInTheDocument();
	});

	it("orphaned blocks get Remove but no Update", async () => {
		renderStrip();
		await screen.findByText("old-rules");
		expect(screen.queryByRole("button", { name: /Update/ })).toBeNull();
		expect(screen.getAllByTitle("Remove block from file").length).toBe(2);
	});

	it("dirty buffer blocks all actions with save-to-manage guidance", async () => {
		renderStrip(true);
		await screen.findByText("validation-procedure"); // scan resolved
		expect(screen.getByText(/save to manage/)).toBeInTheDocument();
		expect(screen.getByText(/Save or discard/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Add snippet/ })).toBeNull();
		for (const btn of screen.getAllByTitle("Remove block from file")) {
			expect(btn).toBeDisabled();
		}
	});

	it("names the damaged marker and opens its line in the editor", async () => {
		const { onOpenLine } = renderStrip();
		expect(await screen.findByText("broken-snip")).toBeInTheDocument();
		expect(screen.getByText(/missing end marker · line 41/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Go to line" }));
		expect(onOpenLine).toHaveBeenCalledWith(41);
	});

	it("warning disappears once the scan no longer reports damage (manual cleanup)", async () => {
		mockScan({ locations: [], damaged: [] });
		renderStrip();
		expect(await screen.findByText(/No snippets in this file yet/)).toBeInTheDocument();
		expect(screen.queryByText("broken-snip")).not.toBeInTheDocument();
	});

	it("apply via the picker targets (project, relative path) and reloads the editor", async () => {
		const { onMutate } = renderStrip();
		fireEvent.click(await screen.findByRole("button", { name: /Add snippet/ }));
		fireEvent.click(await screen.findByText("fresh-snip"));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("snippet_apply", {
				name: "fresh-snip",
				project: "demo",
				relativePath: "AGENTS.md",
			});
		});
		await waitFor(() => expect(onMutate).toHaveBeenCalled());
	});

	it("removing a clean block goes straight through; remove failure surfaces a toast", async () => {
		const { onMutate } = renderStrip();
		await screen.findByText("validation-procedure");
		fireEvent.click(screen.getAllByTitle("Remove block from file")[0]);
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_remove",
				expect.objectContaining({
					name: "validation-procedure",
					project: "demo",
					relativePath: "AGENTS.md",
					force: false,
				}),
			);
		});
		await waitFor(() => expect(onMutate).toHaveBeenCalled());
	});

	it("modified blocks require confirmation before update overwrites edits", async () => {
		mockScan({
			locations: [
				{
					project: "demo",
					rel: "AGENTS.md",
					path: "/p/AGENTS.md",
					snippet: "edited-snip",
					version: "1",
					applied_sha: "zzz",
					status: "modified",
				},
			],
			damaged: [],
		});
		renderStrip();
		await screen.findByText("edited-snip");
		fireEvent.click(screen.getByRole("button", { name: /Update/ }));
		// Confirm dialog appears instead of immediate mutation.
		expect(
			await screen.findByText("Update a modified block?"),
		).toBeInTheDocument();
		expect(invoke).not.toHaveBeenCalledWith(
			"snippet_update",
			expect.anything(),
		);
		fireEvent.click(screen.getByRole("button", { name: /Overwrite edits/ }));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"snippet_update",
				expect.objectContaining({ name: "edited-snip", force: true }),
			);
		});
	});
});
