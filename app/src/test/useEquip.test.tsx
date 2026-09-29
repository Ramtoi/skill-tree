import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSkillProjectEquip, useBundleProjectEquip } from "@/hooks/useEquip";
import { queryClient } from "@/lib/queryClient";
import { useAppStore } from "@/store";
import { qk } from "@/lib/queryKeys";
import type { UsageFootprintPayload } from "@/features/usage/usageAnalyticsTypes";
import type { EquipTarget } from "@/components/EquipPicker";
import type { MissingRef, SyncReportEnvelope } from "@/lib/syncFreshness";
import { primeRegistry, sampleRegistry } from "./helpers";

const target: EquipTarget = { id: "example-app", name: "example-app", state: "off" };

function footprint(skillLines: string[]): UsageFootprintPayload {
	const skillsText = skillLines.join("\n");
	return {
		ok: true, project: "example-app", window: 30, last_scan_at: "2026-09-08T00:00:00Z",
		harnesses: { "claude-code": {
			parts: [
				{ part: "agent_docs", label: "Agent docs", text: "real agent document", bytes: 19 },
				{ part: "skills", label: "Skills", text: skillsText, bytes: skillsText.length },
			],
			unknown: [], bytes_total: 19 + skillsText.length, approx_tokens: 0,
			skill_lines: skillLines.map((text, index) => ({ key: `skill-${index}`, text, bytes: text.length })),
		} },
	};
}

function report(missing_refs: MissingRef[] = []): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-09-08T00:00:00Z",
			registry_sha256: "test",
			registry_mtime: 0,
			ok: true,
			global: {
				skipped: [], skills: { writes: 0, removed: 0 }, mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] }, remotes: { attempted: 0, alarming: 0 },
			},
			projects: { "example-app": {
				ts: "2026-09-08T00:00:00Z", ok: true, errors: [], writes: 0, removed: 0,
				affinity_skips: [], missing_refs,
			} },
		},
		registry_current: { sha256: "test", mtime: 0 },
	};
}

function renderEquipHook(hook: () => (target: EquipTarget, next: "on" | "off") => Promise<void>) {
	return renderHook(hook, {
		wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
	});
}

describe("useEquip composed feedback (D16.7/G3)", () => {
	beforeEach(() => {
		queryClient.clear();
		primeRegistry(queryClient, sampleRegistry);
		useAppStore.setState({ toasts: [] });
		vi.mocked(invoke).mockImplementation(((command: string) => {
			if (command === "sync_report") return Promise.resolve(report());
			if (command === "hub_cmd") return Promise.resolve({ success: true, output: "" });
			return Promise.resolve(undefined);
		}) as never);
	});

	it("ordinary direct equip produces exactly one composed success toast", async () => {
		const { result } = renderEquipHook(() => useSkillProjectEquip("rt-android-expert"));
		await act(async () => { await result.current(target, "on"); });
		const toasts = useAppStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].kind).toBe("success");
	});

	it("bundle apply also produces exactly one composed toast", async () => {
		const { result } = renderEquipHook(() => useBundleProjectEquip("android"));
		await act(async () => { await result.current(target, "on"); });
		expect(useAppStore.getState().toasts).toHaveLength(1);
	});

	it("missing references keep cost detail and ordered Equip N action without a second announcement", async () => {
		const refs = [{ skill: "rt-android-expert", refs: ["needs-global", "proof-it"] }];
		let current = footprint([]);
		queryClient.setQueryDefaults(qk.usageFootprint("example-app"), { queryFn: () => current });
		queryClient.setQueryData(qk.usageFootprint("example-app"), current);
		vi.mocked(invoke).mockImplementation(((command: string, payload: { args?: string[] }) => {
			if (command === "sync_report") return Promise.resolve(report(refs));
			if (command === "hub_cmd") {
				if (payload.args?.[0] === "usage") {
					return Promise.resolve({ success: true, output: JSON.stringify(current) });
				}
				current = footprint(["rt-android-expert: Android planner (.claude/skills/rt-android-expert)"]);
				return Promise.resolve({ success: true, output: "" });
			}
			return Promise.resolve(undefined);
		}) as never);
		const { result } = renderEquipHook(() => useSkillProjectEquip("rt-android-expert"));
		await act(async () => { await result.current(target, "on"); });
		const toasts = useAppStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		const toast = toasts[0];
		expect(toast.body).toMatch(/adds ~\d+ tokens to every/);
		expect(toast.actions?.map((action) => action.label)).toEqual(["Undo", "Equip 2"]);
		expect(toast.action?.label).toBe("Equip 2");
		await act(async () => { await toast.actions?.[1]?.onClick(); });
		expect(useAppStore.getState().toasts).toHaveLength(2);
		expect(useAppStore.getState().toasts[1]?.title).toBe("Equipped 2 on example-app");
	});
});
