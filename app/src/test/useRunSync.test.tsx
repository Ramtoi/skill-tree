import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useRunSync } from "@/hooks/useRunSync";
import { makeDeferred } from "./helpers";

function syncCallCount(): number {
	return vi
		.mocked(invoke)
		.mock.calls.filter(
			([cmd, payload]) =>
				cmd === "hub_cmd" &&
				(payload as { args?: string[] } | undefined)?.args?.[0] === "sync",
		).length;
}

describe("useRunSync — re-entry guard (B3-04)", () => {
	it("spawns exactly one hub sync when triggered twice in the same tick", async () => {
		// Hold the sync dispatch in-flight so the second synchronous trigger
		// races the first before any store re-render could clear the guard.
		const gate = makeDeferred();
		vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
			if (
				cmd === "hub_cmd" &&
				(args as { args?: string[] } | undefined)?.args?.[0] === "sync"
			) {
				return gate.promise;
			}
			return Promise.resolve(undefined);
		}) as never);

		const { result } = renderHook(() => useRunSync());

		await act(async () => {
			const first = result.current();
			const second = result.current();
			gate.resolve({ success: true, output: "" });
			await Promise.all([first, second]);
		});

		expect(syncCallCount()).toBe(1);
	});
});
