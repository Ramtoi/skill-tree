import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
	useRecoveryAttach,
	useRecoveryGithubRepos,
	useRecoveryRestoreSource,
	useRecoverySkipProject,
	useRecoverySync,
} from "@/hooks/useRecovery";
import { makeQueryClient } from "./helpers";

/**
 * Mandatory item from parent's integration findings: the mutation hooks
 * themselves — not just a mocked component — must reject a genuine
 * command-level refusal (`{ok:false, error:{code,message}}`) and MUST NOT
 * reject a row-level partial outcome (`{ok:false}` with no `error`, or a
 * `results[]` array with a mixed ok/not-ok). These exercise `useRecovery`'s
 * hooks directly against `invoke`, the same seam the real Rust bridge uses.
 */

function wrapper({ children }: { children: React.ReactNode }) {
	return <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>;
}

describe("useRecovery — structured ok:false handling", () => {
	it("useRecoverySkipProject rejects a command-level refusal with the CLI's own message", async () => {
		vi.mocked(invoke).mockResolvedValue({
			ok: false,
			error: { code: "unknown_project", message: "unknown project 'ghost'" },
		} as never);

		const { result } = renderHook(() => useRecoverySkipProject(), { wrapper });

		await expect(
			act(async () => {
				await result.current.mutateAsync({ project: "ghost" });
			}),
		).rejects.toThrow("unknown project 'ghost'");
	});

	it("useRecoveryAttach rejects an ambiguous_remote refusal with the CLI's own message", async () => {
		vi.mocked(invoke).mockResolvedValue({
			ok: false,
			error: {
				code: "ambiguous_remote",
				message: "'/dev/multi-remote' has multiple remotes (origin, upstream) — pass --remote to choose one",
			},
		} as never);

		const { result } = renderHook(() => useRecoveryAttach(), { wrapper });

		await expect(
			act(async () => {
				await result.current.mutateAsync({ project: "dev", path: "/dev/multi-remote" });
			}),
		).rejects.toThrow(/multiple remotes/);
	});

	it("useRecoveryRestoreSource resolves normally on a partial-batch outcome (ok:false, no top-level error)", async () => {
		vi.mocked(invoke).mockResolvedValue({
			ok: false,
			results: [
				{ source: "a", ok: true, detail: null },
				{ source: "b", ok: false, detail: "clone failed" },
			],
		} as never);

		const { result } = renderHook(() => useRecoveryRestoreSource(), { wrapper });

		let resolved: unknown;
		await act(async () => {
			resolved = await result.current.mutateAsync("all");
		});

		expect(resolved).toMatchObject({ ok: false, results: expect.any(Array) });
	});

	it("useRecoverySync resolves normally on a partial delivery (ok:false, error:null) — never throws away the counts", async () => {
		vi.mocked(invoke).mockResolvedValue({
			ok: false,
			counts: { success: 1, skipped: 0, failed: 1 },
			failed_projects: ["dev"],
			global_failures: [],
			error: null,
		} as never);

		const { result } = renderHook(() => useRecoverySync(), { wrapper });

		let resolved: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
		await act(async () => {
			resolved = await result.current.mutateAsync();
		});

		expect(resolved?.counts).toEqual({ success: 1, skipped: 0, failed: 1 });
		expect(resolved?.failedProjects).toEqual(["dev"]);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
	});

	it("keeps sync error counts in the structured result", async () => {
		vi.mocked(invoke).mockResolvedValue({ ok: false, counts: { success: 1, skipped: 2, failed: 3 },
			failed_projects: ["dev"], global_failures: [], error: "sync exited 1" } as never);
		const { result } = renderHook(() => useRecoverySync(), { wrapper });
		await act(async () => {
			const response = await result.current.mutateAsync();
			expect(response.counts).toEqual({ success: 1, skipped: 2, failed: 3 });
			expect(response.error).toBe("sync exited 1");
		});
	});

	it("preserves GitHub authentication guidance in a structured read result", async () => {
		vi.mocked(invoke).mockResolvedValue({ ok: false, repositories: [],
			error_kind: "unauthenticated", error: "gh is not authenticated" } as never);
		const { result } = renderHook(() => useRecoveryGithubRepos("", 1, true), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.errorKind).toBe("unauthenticated");
		expect(result.current.data?.error).toBe("gh is not authenticated");
	});
});
