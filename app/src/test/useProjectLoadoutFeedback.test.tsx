import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useProjectLoadoutFeedback, staticFootprintTokens } from "@/hooks/useProjectLoadoutFeedback";
import { estimateTokens } from "@/lib/estimateTokens";
import { qk } from "@/lib/queryKeys";
import { useAppStore } from "@/store";
import {
	publishUsageLoadoutDelta,
	useUsageLoadoutDeltaStore,
} from "@/store/usageLoadoutDelta";
import type { UsageFootprintPayload } from "@/features/usage/usageAnalyticsTypes";
import { makeQueryClient } from "./helpers";

const lines = {
	claude: "brainstorm: brainstorm ideas (.claude/skills/brainstorm)",
	codex: "brainstorm: brainstorm ideas (.agents/skills/brainstorm)",
	pi: "brainstorm: brainstorm ideas (.pi/skills/brainstorm)",
	};

function footprint(project: string, skillLines = [lines.claude]): UsageFootprintPayload {
	const skillsText = skillLines.join("\n");
	return {
		ok: true,
		project,
		harnesses: {
			"claude-code": {
				parts: [
					{ part: "agent_docs", label: "Agent docs", text: "real agent document", bytes: 19 },
					{ part: "skills", label: "Skills", text: skillsText, bytes: skillsText.length },
				],
				unknown: [], bytes_total: 19 + skillsText.length, approx_tokens: 0,
				skill_lines: skillLines.map((text, index) => ({ key: `skill-${index}`, text, bytes: text.length })),
			},
		},
		window: 30,
		last_scan_at: "2026-09-08T00:00:00Z",
	};
}

function wrapperFor(client: ReturnType<typeof makeQueryClient>) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function toastTitles() {
	return useAppStore.getState().toasts.map((toast) => toast.title);
}

describe("useProjectLoadoutFeedback (D16.7/D16.8)", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		useUsageLoadoutDeltaStore.setState({ deltas: {} });
	});

	it("composes direct and bundle success details into one capped toast", async () => {
		const client = makeQueryClient();
		let current = footprint("moon-base", [lines.claude]);
		vi.mocked(invoke).mockImplementation(((command: string, payload: { args?: string[] }) =>
			command === "hub_cmd" && payload.args?.[0] === "usage"
				? Promise.resolve({ success: true, output: JSON.stringify(current) })
				: Promise.resolve({ success: true, output: "" })) as never);
		client.setQueryDefaults(qk.usageFootprint("moon-base"), { queryFn: () => current });
		client.setQueryData(qk.usageFootprint("moon-base"), current);
		const { result } = renderHook(() => useProjectLoadoutFeedback("moon-base"), {
			wrapper: wrapperFor(client),
		});
		const before = staticFootprintTokens(current)!;
		const afterPayload = footprint("moon-base", [lines.claude, lines.codex, lines.pi]);
		current = afterPayload;
		await act(async () => {
			await result.current({
				title: "Equipped brainstorm on moon-base",
				write: async () => undefined,
				details: [
					`adds ~${estimateTokens(lines.claude)} tokens to every Claude Code session`,
					`adds ~${estimateTokens(lines.codex)} tokens to every Codex session`,
					`and ${Object.keys(afterPayload.harnesses).length + 2} more`,
				],
			});
		});
		const toast = useAppStore.getState().toasts[useAppStore.getState().toasts.length - 1]!;
		expect(toastTitles()).toHaveLength(1);
		expect(toast.body?.split("\n")).toHaveLength(3);
		expect(toast.body).toContain("Claude Code");
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta)
			.toBe(staticFootprintTokens(afterPayload)! - before);

		current = footprint("moon-base", [lines.claude, lines.codex]);
		await act(async () => {
			await result.current({
				title: "Applied android on moon-base",
				write: async () => undefined,
				details: [
					`adds ~${estimateTokens(lines.claude)} tokens to every Claude Code session`,
					`adds ~${estimateTokens(lines.codex)} tokens to every Codex session`,
				],
			});
		});
		expect(toastTitles()).toHaveLength(2);
	});

	it("publishes signed equip, reduction, Undo reverse, and no failed delta", async () => {
		const client = makeQueryClient();
		let current = footprint("moon-base");
		vi.mocked(invoke).mockImplementation(((command: string, payload: { args?: string[] }) =>
			command === "hub_cmd" && payload.args?.[0] === "usage"
				? Promise.resolve({ success: true, output: JSON.stringify(current) })
				: Promise.resolve({ success: true, output: "" })) as never);
		client.setQueryDefaults(qk.usageFootprint("moon-base"), { queryFn: () => current });
		client.setQueryData(qk.usageFootprint("moon-base"), current);
		const { result } = renderHook(() => useProjectLoadoutFeedback("moon-base"), {
			wrapper: wrapperFor(client),
		});
		const before = staticFootprintTokens(current)!;
		current = footprint("moon-base", [lines.claude, lines.codex]);
		await act(async () => {
			await result.current({ title: "Equipped skill on moon-base", write: async () => { client.setQueryData(qk.usageFootprint("moon-base"), current); } });
		});
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta)
			.toBe(staticFootprintTokens(current)! - before);

		client.setQueryData(qk.usageFootprint("moon-base"), footprint("moon-base", [lines.claude, lines.codex]));
		const reduced = footprint("moon-base", []);
		current = reduced;
		await act(async () => {
			await result.current({ title: "Unequipped skill from moon-base", write: async () => { client.setQueryData(qk.usageFootprint("moon-base"), current); } });
		});
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta)
			.toBe(staticFootprintTokens(reduced)! - staticFootprintTokens(footprint("moon-base", [lines.claude, lines.codex]) )!);

		const undo = async () => {
			current = footprint("moon-base", [lines.claude, lines.codex]);
			client.setQueryData(qk.usageFootprint("moon-base"), current);
		};
		client.setQueryData(qk.usageFootprint("moon-base"), reduced);
		const toast = useAppStore.getState().toasts[useAppStore.getState().toasts.length - 1]!;
		await act(async () => {
			await result.current({ title: "Removed skill from moon-base", write: async () => { client.setQueryData(qk.usageFootprint("moon-base"), reduced); }, undo });
		});
		const undoToast = useAppStore.getState().toasts[useAppStore.getState().toasts.length - 1]!;
		await act(async () => { await undoToast.actions?.[0]?.onClick(); });
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta).toBeGreaterThan(0);
		expect(toast).toBeDefined();

		const published = useUsageLoadoutDeltaStore.getState().deltas["moon-base"];
		await expect(act(async () => {
			await result.current({ title: "Failed equip", write: async () => { throw new Error("nope"); } });
		})).rejects.toThrow("nope");
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]).toEqual(published);
	});

	it("keeps a delta published outside the route and does not create one for scan refetch", () => {
		publishUsageLoadoutDelta("moon-base", 20, 34);
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta).toBe(14);
		// A scan updates query data, not this mutation-owned store.
		const client = makeQueryClient();
		client.setQueryData(qk.usageFootprint("moon-base"), footprint("moon-base", [lines.claude, lines.codex]));
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta).toBe(14);
		expect(useUsageLoadoutDeltaStore.getState().deltas["other"] ?? null).toBeNull();
	});

	it("resolves as success when the post-write footprint refresh fails", async () => {
		const client = makeQueryClient();
		const current = footprint("moon-base");
		client.setQueryData(qk.registry(), { projects: {} });
		const invalidate = vi.spyOn(client, "invalidateQueries");
		let reads = 0;
		vi.mocked(invoke).mockImplementation(((command: string, payload: { args?: string[] }) => {
			if (command === "hub_cmd" && payload.args?.[0] === "usage") {
				reads += 1;
				if (reads === 1) return Promise.resolve({ success: true, output: JSON.stringify(current) });
				return Promise.reject(new Error("footprint unavailable"));
			}
			return Promise.resolve({ success: true, output: "" });
		}) as never);
		const { result } = renderHook(() => useProjectLoadoutFeedback("moon-base"), {
			wrapper: wrapperFor(client),
		});
		await act(async () => {
			await expect(result.current({ title: "Equipped skill on moon-base", write: async () => undefined }))
				.resolves.toBeUndefined();
		});
		expect(toastTitles()).toEqual(["Equipped skill on moon-base"]);
		expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: qk.registry() }));
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]).toBeUndefined();
	});

	it("reads a cold footprint before and after an equip and publishes its cost delta", async () => {
		const client = makeQueryClient();
		let current = footprint("moon-base", []);
		let reads = 0;
		vi.mocked(invoke).mockImplementation(((command: string, payload: { args?: string[] }) => {
			if (command === "hub_cmd" && payload.args?.[0] === "usage") {
				reads += 1;
				return Promise.resolve({ success: true, output: JSON.stringify(current) });
			}
			return Promise.resolve({ success: true, output: "" });
		}) as never);
		const { result } = renderHook(() => useProjectLoadoutFeedback("moon-base"), {
			wrapper: wrapperFor(client),
		});
		await act(async () => {
			await result.current({
				title: "Equipped brainstorm on moon-base",
				write: async () => { current = footprint("moon-base", [lines.claude]); },
			});
		});
		expect(reads).toBe(2);
		expect(useAppStore.getState().toasts[useAppStore.getState().toasts.length - 1]?.body)
			.toMatch(/adds ~\d+ tokens to every/);
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta)
			.toBe(staticFootprintTokens(current)! - staticFootprintTokens(footprint("moon-base", []))!);
	});
});
