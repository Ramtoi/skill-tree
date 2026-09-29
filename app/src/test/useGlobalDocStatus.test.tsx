import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";

import {
	useGlobalDocStatus,
	docStatusFor,
	type GlobalDocStatusRow,
} from "@/hooks/useGlobalDocStatus";
import { parseHubJson } from "@/lib/cloud";
import { parseCliJson } from "@/lib/skillPack";
import { makeQueryClient } from "./helpers";

/** The data layer under `useGlobalDocStatus` / the doc editor's link verbs:
 *  `hub harness doc …` answers on STDOUT even when it exits non-zero (the
 *  conflict payload is an exit-2 answer, not a crash — see the Rust
 *  `combine_streams` contract), and the payload can be followed by chatter or
 *  carry closing brackets inside a user-written preview string. Every one of
 *  those has to survive the parse. */

function setup(result: unknown) {
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		if (cmd === "hub_cmd") return result;
		return undefined;
	}) as never);
	const client = makeQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook(() => useGlobalDocStatus(), { wrapper });
}

const ROWS: GlobalDocStatusRow[] = [
	{
		harness: "claude-code",
		label: "Claude Code",
		path: "/home/test/.claude/CLAUDE.md",
		state: "source",
		follows: null,
		followers: ["codex"],
		bytes: 24,
	},
	{
		harness: "codex",
		label: "Codex",
		path: "/home/test/.codex/AGENTS.md",
		state: "follows",
		follows: "claude-code",
		followers: [],
		bytes: null,
	},
];

describe("useGlobalDocStatus", () => {
	it("parses the top-level array payload", async () => {
		const { result } = setup({ success: true, output: JSON.stringify(ROWS) });
		await waitFor(() => expect(result.current.data).toEqual(ROWS));
		expect(docStatusFor(result.current.data, "codex")?.follows).toBe(
			"claude-code",
		);
		expect(docStatusFor(result.current.data, "nope")).toBeUndefined();
	});

	it("parses a payload followed by trailing CLI chatter", async () => {
		// `parseCliJson` cannot do this one — it scans from the first `{`, which
		// on an array payload is the first ROW. `parseHubJson` is why the hook
		// reaches for `lib/cloud` instead.
		const { result } = setup({
			success: true,
			output: `${JSON.stringify(ROWS)}\nReconciled on next sync\n`,
		});
		await waitFor(() => expect(result.current.data).toEqual(ROWS));
	});

	it("parses an empty scan", async () => {
		const { result } = setup({ success: true, output: "[]\n" });
		await waitFor(() => expect(result.current.data).toEqual([]));
	});

	it("an empty stdout is an error, not an empty list", async () => {
		// Silently answering `[]` here would render every harness as "not
		// created" — a confident lie. The query must fail instead.
		const { result } = setup({ success: true, output: "" });
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeUndefined();
	});

	it("a stderr-only failure surfaces the CLI's own message", async () => {
		const { result } = setup({
			success: false,
			output: "python3: command not found\n",
			stdout: "",
			stderr: "python3: command not found\n",
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(String(result.current.error)).toContain("command not found");
	});

	it("a non-zero exit is an error even when stdout parses", async () => {
		const { result } = setup({ success: false, output: JSON.stringify(ROWS) });
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeUndefined();
	});
});

describe("doc-link payload parsing (parseCliJson on link/unlink)", () => {
	it("survives a preview holding brackets, braces, quotes and newlines", () => {
		// The conflict `preview` is the OTHER harness's own markdown — arbitrary
		// user text. A naive "cut at the last }" would mangle this.
		const preview =
			'# Mine\n\n- keep [this] {and} "that"\n\n```json\n{"a": [1, 2]}\n```\n';
		const payload = {
			error: "conflict",
			harness: "codex",
			existing_bytes: preview.length,
			preview,
		};
		const parsed = parseCliJson<{ preview: string; error: string }>(
			JSON.stringify(payload),
		);
		expect(parsed.error).toBe("conflict");
		expect(parsed.preview).toBe(preview);
	});

	it("survives a preview with brackets AND trailing chatter after the payload", () => {
		const preview = "keep [this] {and} that\n";
		const text = `${JSON.stringify({ error: "conflict", preview })}\nsynced 1 project\n`;
		expect(parseCliJson<{ preview: string }>(text).preview).toBe(preview);
	});

	it("throws with the raw text when nothing parses", () => {
		expect(() => parseCliJson("Traceback (most recent call last)")).toThrow(
			/Traceback/,
		);
		expect(() => parseCliJson("")).toThrow(/empty response/);
	});

	it("parseHubJson keeps an array payload whose strings contain `]`", () => {
		const rows = [{ ...ROWS[0], label: "Claude [beta]" }];
		expect(parseHubJson<typeof rows>(JSON.stringify(rows))).toEqual(rows);
	});
});
