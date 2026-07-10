import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	applySnippet,
	createSnippet,
	deleteSnippet,
	removeSnippet,
	updateSnippet,
	updateSnippetEverywhere,
	useInvalidateSnippets,
	useSnippetScan,
	useSnippets,
} from "@/hooks/useSnippets";
import type { SnippetInfo, SnippetScanResult } from "@/types/snippets";
import { makeQueryClient } from "./helpers";

const SNIPPET: SnippetInfo = {
	name: "validation-procedure",
	description: "Validation steps",
	tags: ["workflow"],
	version: 2,
	created: "",
	updated: "",
	hash: "abc123def456",
	usage: { count: 1, summary: "applied", outdated_count: 0 },
};

const SCAN: SnippetScanResult = {
	locations: [
		{
			project: "demo",
			rel: "AGENTS.md",
			path: "/p/AGENTS.md",
			snippet: "validation-procedure",
			version: "2",
			applied_sha: "abc123def456",
			status: "applied",
		},
	],
	damaged: [],
};

function wrapperFor(client = makeQueryClient()) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { wrapper, client };
}

describe("useSnippets data layer", () => {
	it("useSnippets fetches the library with tag/query filters", async () => {
		vi.mocked(invoke).mockResolvedValue([SNIPPET]);
		const { wrapper } = wrapperFor();
		const { result } = renderHook(
			() => useSnippets({ tag: "workflow", query: "valid" }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toEqual([SNIPPET]);
		expect(invoke).toHaveBeenCalledWith("snippets_list", {
			tag: "workflow",
			query: "valid",
		});
	});

	it("useSnippetScan fetches scan-derived locations", async () => {
		vi.mocked(invoke).mockResolvedValue(SCAN);
		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSnippetScan({ project: "demo" }), {
			wrapper,
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.locations[0]?.status).toBe("applied");
		expect(invoke).toHaveBeenCalledWith("snippet_status", {
			name: null,
			project: "demo",
		});
	});

	it("createSnippet / deleteSnippet marshal their args", async () => {
		vi.mocked(invoke).mockResolvedValue(SNIPPET);
		await createSnippet({ name: "x", tags: ["a", "b"], body: "Body" });
		expect(invoke).toHaveBeenCalledWith("snippet_new", {
			name: "x",
			description: null,
			tags: ["a", "b"],
			body: "Body",
		});
		await deleteSnippet({ name: "x", force: true });
		expect(invoke).toHaveBeenCalledWith("snippet_delete", {
			name: "x",
			force: true,
		});
	});

	it("apply/remove/update target (project, relative path) — never absolute", async () => {
		vi.mocked(invoke).mockResolvedValue({});
		await applySnippet({ name: "x", project: "demo" });
		expect(invoke).toHaveBeenCalledWith("snippet_apply", {
			name: "x",
			project: "demo",
			relativePath: null,
		});
		await removeSnippet({
			name: "x",
			project: "demo",
			relativePath: "sub/AGENTS.md",
			force: true,
		});
		expect(invoke).toHaveBeenCalledWith("snippet_remove", {
			name: "x",
			project: "demo",
			relativePath: "sub/AGENTS.md",
			force: true,
		});
		await updateSnippet({ name: "x", project: "demo" });
		expect(invoke).toHaveBeenCalledWith("snippet_update", {
			name: "x",
			project: "demo",
			relativePath: null,
			all: false,
			force: false,
		});
	});

	it("updateSnippetEverywhere uses --all without force", async () => {
		vi.mocked(invoke).mockResolvedValue({
			action: "update-everywhere",
			snippet: "x",
			refreshed: [],
			skipped: [],
		});
		await updateSnippetEverywhere({ name: "x" });
		expect(invoke).toHaveBeenCalledWith("snippet_update", {
			name: "x",
			project: null,
			relativePath: null,
			all: true,
			force: false,
		});
	});

	it("useInvalidateSnippets invalidates snippets, scans, and agent-docs", async () => {
		const { wrapper, client } = wrapperFor();
		const spy = vi.spyOn(client, "invalidateQueries");
		const { result } = renderHook(() => useInvalidateSnippets(), { wrapper });
		result.current();
		const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
		expect(keys).toEqual(
			expect.arrayContaining(["snippets", "snippet", "snippet-scan", "agent-docs"]),
		);
	});
});
