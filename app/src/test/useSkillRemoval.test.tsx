import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { removalConfirmBody, useSkillRemoval } from "@/hooks/useSkillRemoval";
import { makeQueryClient, sampleRegistry } from "./helpers";
import { qk } from "@/lib/queryKeys";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";

function wrapperFor(registry: Registry = sampleRegistry) {
	const client = makeQueryClient();
	client.setQueryData(qk.registry(), registry);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
}

function mockHubCmd(handler: (cmdArgs: string[]) => { success: boolean; output: string }) {
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "hub_cmd") {
			const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
			return Promise.resolve(handler(cmdArgs));
		}
		// `staleTime: 0` means every query is stale on mount, so `useRegistry`
		// refetches in the background even though `setQueryData` already
		// primed it — answer it so react-query doesn't complain about an
		// `undefined` queryFn result.
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		return Promise.resolve(undefined);
	}) as never);
}

describe("useSkillRemoval — confirm gating", () => {
	it("an unequipped skill goes straight through: no pending confirm, busy true then false", async () => {
		mockHubCmd((cmdArgs) => {
			if (cmdArgs[0] === "archive") {
				return { success: true, output: JSON.stringify({ ok: true, archived: [{ name: "fs-mcp", moved: true, references: {} }], undo: ["unarchive", "fs-mcp"] }) };
			}
			return { success: true, output: "" };
		});
		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSkillRemoval(), { wrapper });

		let ok = false;
		await act(async () => {
			ok = await result.current.archive(["fs-mcp"]);
		});

		expect(ok).toBe(true);
		expect(result.current.pending).toBeNull();
		expect(result.current.busy).toBe(false);
	});

	it("a skill equipped via a bundle opens a pending confirm and waits for it", async () => {
		mockHubCmd((cmdArgs) => {
			if (cmdArgs[0] === "archive") {
				return { success: true, output: JSON.stringify({ ok: true, archived: [], undo: [] }) };
			}
			return { success: true, output: "" };
		});
		// `android-compose-ui` is a member of the `android` bundle in sampleRegistry.
		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSkillRemoval(), { wrapper });

		let settled = false;
		let ok: boolean | null = null;
		act(() => {
			void result.current.archive(["android-compose-ui"]).then((v) => {
				ok = v;
				settled = true;
			});
		});

		await waitFor(() => expect(result.current.pending).not.toBeNull());
		expect(result.current.pending!.refs.bundles).toContain("android");
		expect(result.current.busy).toBe(false); // not yet confirmed

		act(() => {
			result.current.confirm();
		});

		await waitFor(() => expect(settled).toBe(true));
		expect(ok).toBe(true);
		expect(result.current.pending).toBeNull();
	});

	it("cancel resolves false and never calls archive", async () => {
		const calls: string[][] = [];
		mockHubCmd((cmdArgs) => {
			calls.push(cmdArgs);
			return { success: true, output: JSON.stringify({ ok: true, archived: [], undo: [] }) };
		});
		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSkillRemoval(), { wrapper });

		let ok: boolean | null = null;
		act(() => {
			void result.current.archive(["android-compose-ui"]).then((v) => (ok = v));
		});
		await waitFor(() => expect(result.current.pending).not.toBeNull());

		act(() => {
			result.current.cancel();
		});

		await waitFor(() => expect(ok).toBe(false));
		expect(calls.some((c) => c[0] === "archive")).toBe(false);
	});

	it("alwaysConfirm forces the dialog even for an unequipped skill", async () => {
		mockHubCmd(() => ({ success: true, output: JSON.stringify({ ok: true, archived: [], undo: [] }) }));
		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSkillRemoval(), { wrapper });

		act(() => {
			void result.current.archive(["fs-mcp"], { alwaysConfirm: true });
		});
		await waitFor(() => expect(result.current.pending).not.toBeNull());
	});
});

describe("useSkillRemoval — undo wiring", () => {
	it("the success toast's Undo action calls unarchive and onUndone", async () => {
		let unarchiveCalled = false;
		mockHubCmd((cmdArgs) => {
			if (cmdArgs[0] === "archive") {
				return {
					success: true,
					output: JSON.stringify({ ok: true, archived: [], undo: ["unarchive", "fs-mcp"] }),
				};
			}
			if (cmdArgs[0] === "unarchive") {
				unarchiveCalled = true;
				return { success: true, output: JSON.stringify({ ok: true, restored: ["fs-mcp"], skipped: [] }) };
			}
			return { success: true, output: "" };
		});
		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSkillRemoval(), { wrapper });

		let onUndoneCalled = false;
		await act(async () => {
			await result.current.archive(["fs-mcp"], {
				onUndone: () => {
					onUndoneCalled = true;
				},
			});
		});

		const toasts = useAppStore.getState().toasts;
		const toast = toasts[toasts.length - 1];
		expect(toast?.title).toBe("Archived fs-mcp");
		expect(toast?.action?.label).toBe("Undo");

		await act(async () => {
			toast!.action!.onClick();
			// `runUndo` fires an unawaited async IIFE — flush it.
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(unarchiveCalled).toBe(true);
		expect(onUndoneCalled).toBe(true);
	});
});

describe("useSkillRemoval — failure path", () => {
	it("a failing archive resolves false, toasts an error with no Undo action, and clears busy", async () => {
		mockHubCmd((cmdArgs) => {
			if (cmdArgs[0] === "archive") {
				return {
					success: false,
					output:
						"error: already archived (pending undo record) for: fs-mcp — run `hub unarchive fs-mcp` first",
				};
			}
			return { success: true, output: "" };
		});
		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSkillRemoval(), { wrapper });

		let ok: boolean | null = null;
		await act(async () => {
			ok = await result.current.archive(["fs-mcp"]);
		});

		expect(ok).toBe(false);
		expect(result.current.busy).toBe(false);

		const toasts = useAppStore.getState().toasts;
		const toast = toasts[toasts.length - 1];
		expect(toast?.kind).toBe("error");
		expect(toast?.action).toBeUndefined();
	});
});

describe("removalConfirmBody", () => {
	it("single skill: states the reference counts, the consequence, and the undo window", () => {
		const body = removalConfirmBody({
			names: ["ds-tokens"],
			verb: "forget",
			refs: { projects: ["example-app"], bundles: [], remotes: [], cloud: [] },
		});
		expect(body).toBe(
			"ds-tokens is equipped in 1 project and 0 bundles. Forgetting removes it from " +
				"the registry and un-equips it everywhere below. You can undo from the toast for 7 seconds.",
		);
	});

	it("archive verb uses the gerund \"Archiving\"", () => {
		const body = removalConfirmBody({
			names: ["rt-android-expert"],
			verb: "archive",
			refs: { projects: [], bundles: ["android"], remotes: [], cloud: [] },
		});
		expect(body).toContain("rt-android-expert is equipped in 0 projects and 1 bundle.");
		expect(body).toContain("Archiving removes it");
	});

	it("batch: names every skill up front", () => {
		const body = removalConfirmBody({
			names: ["ds-tokens", "diagnose"],
			verb: "forget",
			refs: { projects: ["example-app"], bundles: [], remotes: [], cloud: [] },
		});
		expect(body).toBe("2 skills will be forgotten: ds-tokens, diagnose.");
	});
});

describe("useSkillRemoval — busy", () => {
	it("is true only between confirm-accept and settle", async () => {
		let resolveArchive!: (v: { success: boolean; output: string }) => void;
		vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
			if (cmd === "hub_cmd") {
				const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
				if (cmdArgs[0] === "archive") {
					return new Promise((resolve) => {
						resolveArchive = resolve;
					});
				}
			}
			return Promise.resolve({ success: true, output: "" });
		}) as never);

		const { wrapper } = wrapperFor();
		const { result } = renderHook(() => useSkillRemoval(), { wrapper });

		expect(result.current.busy).toBe(false);
		let donePromise: Promise<boolean>;
		act(() => {
			donePromise = result.current.archive(["fs-mcp"]);
		});
		await waitFor(() => expect(result.current.busy).toBe(true));

		act(() => {
			resolveArchive({ success: true, output: JSON.stringify({ ok: true, archived: [], undo: [] }) });
		});
		await act(async () => {
			await donePromise;
		});
		expect(result.current.busy).toBe(false);
	});
});
