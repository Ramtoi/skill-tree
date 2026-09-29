import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDroppedSkillFlow } from "@/hooks/useDroppedSkillFlow";
import { makeQueryClient, sampleRegistry } from "./helpers";
import { qk } from "@/lib/queryKeys";
import type { BackTarget } from "@/lib/backTarget";
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
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		return Promise.resolve(undefined);
	}) as never);
}

// Finding 6: `useDroppedSkillFlow`'s undo callback compared
// `currentHashPath()` (which strips any query string) against `back.path`
// AS-IS — a Library referrer's `back.path` may now carry `?q=…` (wave 2),
// so the comparison never matched and the undo silently failed to navigate
// back. The fix strips `back.path` the same way before comparing.
describe("useDroppedSkillFlow — undo navigation with a query-string referrer", () => {
	// This test drives `window.location.hash` directly (the only way to
	// exercise `currentHashPath()`'s real source outside a HashRouter-mounted
	// app) — reset it so a later test file's own hash-sensitive assertions
	// never see this test's leftover value.
	afterEach(() => {
		window.location.hash = "";
	});

	it("undo of 'forget' with a /?q=an referrer still returns to the skill", async () => {
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
			if (cmdArgs[0] === "source" && cmdArgs[1] === "dropped") {
				return { success: true, output: JSON.stringify({ ok: true, skills: [] }) };
			}
			return { success: true, output: "{}" };
		});

		const back: BackTarget = { label: "Library", path: "/?q=an", crumbs: ["library"] };
		const navigate = vi.fn();
		const onRemoved = vi.fn();
		const { wrapper } = wrapperFor();
		const { result } = renderHook(
			() =>
				useDroppedSkillFlow({
					routeName: "fs-mcp",
					sourceMissing: false,
					back,
					navigate,
					onRemoved,
				}),
			{ wrapper },
		);

		// The browser is currently showing the Library at "/?q=an" — the state
		// `doRemove`'s `onRemoved` callback would typically have navigated to
		// once the archive landed. `currentHashPath()` reads this directly
		// (`window.location.hash`), independent of the test's MemoryRouter.
		window.location.hash = "#/?q=an";

		await act(async () => {
			await result.current.doRemove();
		});
		expect(onRemoved).toHaveBeenCalledTimes(1);

		// Trigger the undo path — same wiring `useSkillRemoval.test.tsx` uses:
		// find the toast's "Undo" action and click it.
		const { useAppStore } = await import("@/store");
		const toasts = useAppStore.getState().toasts;
		const toast = toasts[toasts.length - 1];
		expect(toast?.action?.label).toBe("Undo");

		await act(async () => {
			toast!.action!.onClick();
			await Promise.resolve();
			await Promise.resolve();
		});

		await waitFor(() => expect(unarchiveCalled).toBe(true));
		expect(navigate).toHaveBeenCalledWith(
			"/skill/fs-mcp",
			expect.objectContaining({ state: expect.objectContaining({ from: back }) }),
		);
	});
});
