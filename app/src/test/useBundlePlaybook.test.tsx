import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { useBundleMembership } from "@/hooks/useBundleMembership";
import { useBundlePlaybook } from "@/hooks/useBundlePlaybook";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";
import { makeDeferred, primeRegistry } from "./helpers";

const registry: Registry = {
	version: "1",
	projects: {},
	skills: { alpha: {} as never, beta: {} as never },
	bundles: {
		pack: {
			description: "Pack",
			icon: "📦",
			skills: ["alpha"],
			playbook: [
				{ id: "named", title: "Named", skills: [] },
				{ id: "unsectioned", title: "", skills: ["alpha"] },
			],
		},
	},
};

function setup() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 60_000, staleTime: 0 } },
	});
	primeRegistry(client, structuredClone(registry));
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const view = renderHook(() => {
		const membership = useBundleMembership("pack");
		return { membership, playbook: useBundlePlaybook("pack", membership.enqueue) };
	}, { wrapper });
	return { ...view, client };
}

function landed(bundle: Registry["bundles"][string]) {
	return { success: true, output: JSON.stringify({ bundle, changed: true, errors: [] }) };
}

describe("useBundlePlaybook", () => {
	beforeEach(() => vi.clearAllMocks());

	it("serializes rapid layout and membership edits over the latest cache", async () => {
		const first = makeDeferred<unknown>();
		const second = makeDeferred<unknown>();
		vi.mocked(invoke).mockImplementation(((cmd: string, args?: { args?: string[] }) => {
			if (cmd !== "hub_cmd") return Promise.resolve(undefined);
			return args?.args?.includes("--playbook") ? first.promise : second.promise;
		}) as never);
		const view = setup();
		const layout = view.result.current.playbook.mutate(
			{ kind: "editSection", id: "named", field: "guidance", value: "Start" },
			"Edited",
			false,
		);
		const membership = view.result.current.membership.add("beta");
		await waitFor(() => expect(vi.mocked(invoke).mock.calls).toHaveLength(1));
		first.resolve(landed(registry.bundles.pack));
		await waitFor(() => expect(vi.mocked(invoke).mock.calls).toHaveLength(2));
		const membershipArgs = vi.mocked(invoke).mock.calls[1][1] as { args?: string[] };
		expect(membershipArgs.args).toEqual(expect.arrayContaining(["--skills", "alpha,beta"]));
		second.resolve(landed(view.client.getQueryData<Registry>(["registry"])!.bundles.pack));
		await expect(layout).resolves.toBeUndefined();
		await expect(membership).resolves.toBeUndefined();
	});

	it("restores only the failed layout and allows the next write to succeed", async () => {
		const first = makeDeferred<unknown>();
		vi.mocked(invoke).mockImplementation(((cmd: string) =>
			cmd === "hub_cmd" ? first.promise : Promise.resolve(undefined)) as never);
		const view = setup();
		const failed = view.result.current.playbook.mutate(
			{ kind: "editSection", id: "named", field: "guidance", value: "Bad" },
			"Edited",
			false,
		);
		await waitFor(() => expect(vi.mocked(invoke).mock.calls).toHaveLength(1));
		first.reject(new Error("write failed"));
		await expect(failed).rejects.toThrow("write failed");
		expect(view.client.getQueryData<Registry>(["registry"])!.bundles.pack.playbook?.[0].guidance).toBeUndefined();
		const next = makeDeferred<unknown>();
		vi.mocked(invoke).mockImplementation(((cmd: string) =>
			cmd === "hub_cmd" ? next.promise : Promise.resolve(undefined)) as never);
		const succeeded = view.result.current.playbook.mutate(
			{ kind: "editSection", id: "named", field: "guidance", value: "Good" },
			"Edited",
			false,
		);
		await waitFor(() => expect(vi.mocked(invoke).mock.calls).toHaveLength(1));
		next.resolve(landed(view.client.getQueryData<Registry>(["registry"])!.bundles.pack));
		await expect(succeeded).resolves.toBeUndefined();
		expect(view.client.getQueryData<Registry>(["registry"])!.bundles.pack.playbook?.[0].guidance).toBe("Good");
	});

	it("undoes a layout edit after a later membership edit without losing membership", async () => {
		vi.mocked(invoke).mockImplementation(((cmd: string) => {
			if (cmd !== "hub_cmd") return Promise.resolve(undefined);
			return Promise.resolve(landed(registry.bundles.pack));
		}) as never);
		const view = setup();
		await act(async () => {
			await view.result.current.playbook.mutate(
				{ kind: "editSection", id: "named", field: "guidance", value: "Start" },
				"Edited",
			);
		});
		await act(async () => { await view.result.current.membership.add("beta"); });
		const toastList = useAppStore.getState().toasts;
		const toast = toastList[toastList.length - 1];
		expect(toast?.action).toBeTruthy();
		await act(async () => { toast?.action?.onClick(); await Promise.resolve(); });
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const bundle = view.client.getQueryData<Registry>(["registry"])!.bundles.pack;
		expect(bundle.skills).toEqual(["alpha", "beta"]);
		expect(bundle.playbook?.[0].guidance).toBe("");
	});
});
