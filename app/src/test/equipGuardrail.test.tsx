import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { useAppStore } from "@/store";
import { useSkillProjectEquip, useBundleProjectEquip } from "@/hooks/useEquip";
import { primeRegistry, sampleRegistry } from "./helpers";
import type { EquipTarget } from "@/components/EquipPicker";
import type { MissingRef, SyncReportEnvelope } from "@/lib/syncFreshness";

// Drives the REAL equip hooks (useEquip.ts) rather than mocking the guardrail
// itself, so this file exercises the actual wiring: `hub_cmd` → the fresh
// `sync_report` fetch (grill B1) → the guardrail toast → its `Equip N` action
// → another `hub_cmd --with-refs` → invalidate → a result toast.

function envelopeWith(projects: Record<string, { missing_refs?: MissingRef[] }>): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-09-04T00:00:00Z",
			registry_sha256: "abc",
			registry_mtime: 0,
			ok: true,
			global: {
				skipped: [],
				skills: { writes: 0, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
			projects: Object.fromEntries(
				Object.entries(projects).map(([name, p]) => [
					name,
					{
						ts: "2026-09-04T00:00:00Z",
						ok: true,
						errors: [],
						writes: 0,
						removed: 0,
						affinity_skips: [],
						...p,
					},
				]),
			),
		},
		registry_current: { sha256: "abc", mtime: 0 },
	};
}

function wrapper({ children }: { children: React.ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const TARGET: EquipTarget = { id: "example-app", name: "example-app", state: "off" };

/** hub_cmd args recorded by the shared mock, plus a running call sequence
 *  (cmd names in invocation order, with a distinct "hub_cmd:resolved" entry
 *  pushed only once the mocked `hub_cmd` call actually settles) so a test can
 *  assert `sync_report` was called only after `hub_cmd` resolved — not just
 *  invoked. `hubCmdGate` lets a test hold `hub_cmd` open to prove the ordering
 *  for real; it defaults to an already-resolved promise so every other test
 *  behaves as before. */
function mockInvoke(
	syncReportReply: () => SyncReportEnvelope | null,
	hubCmdGate: Promise<void> = Promise.resolve(),
) {
	const hubCmdArgs: string[][] = [];
	const callSeq: string[] = [];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		callSeq.push(cmd);
		if (cmd === "sync_report") return syncReportReply();
		if (cmd === "hub_cmd") {
			hubCmdArgs.push((args as { args: string[] }).args);
			const hubArgs = (args as { args: string[] }).args;
			if (hubArgs[0] === "enable") await hubCmdGate;
			callSeq.push("hub_cmd:resolved");
			if (hubArgs[0] === "usage" && hubArgs[1] === "footprint") {
				return { success: true, output: JSON.stringify({ ok: true, project: "example-app", harnesses: {}, window: 30, last_scan_at: null }) };
			}
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
	return { hubCmdArgs, callSeq };
}

beforeEach(() => {
	queryClient.clear();
	useAppStore.setState({ toasts: [] });
	primeRegistry(queryClient, sampleRegistry);
});

describe("equip guardrail — wired into the app's equip paths", () => {
	it("fetches the sync report after hub_cmd resolves and reflects the second payload", async () => {
		const clean = envelopeWith({ "example-app": { missing_refs: [] } });
		const flagged = envelopeWith({
			"example-app": { missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }] },
		});
		// A stale cache entry a naive `getQueryData` peek would return.
		queryClient.setQueryData(qk.syncReport(), clean);

		// Hold `hub_cmd` open so the assertion below can fail for the bug it
		// names: if the guardrail overlapped the two reads, `sync_report`
		// would already show up in `callSeq` while `hub_cmd` is still gated.
		let releaseHubCmd!: () => void;
		const gate = new Promise<void>((r) => (releaseHubCmd = r));
		const { callSeq } = mockInvoke(() => flagged, gate);

		const { result } = renderHook(() => useSkillProjectEquip("rt-android-expert"), { wrapper });
		let equip!: Promise<void>;
		act(() => {
			equip = result.current(TARGET, "on");
		});

		expect(callSeq).toContain("hub_cmd");
		expect(callSeq).not.toContain("sync_report");

		releaseHubCmd();
		await act(async () => {
			await equip;
		});

		expect(callSeq.indexOf("sync_report")).toBeGreaterThan(callSeq.indexOf("hub_cmd:resolved"));

		const guardToast = useAppStore
			.getState()
			.toasts.find((t) => t.kind === "info" && t.title.includes("needs-global"));
		expect(guardToast).toBeDefined();
	});

	it("equipping through useSkillProjectEquip pushes the guardrail toast", async () => {
		const flagged = envelopeWith({
			"example-app": {
				missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }],
			},
		});
		mockInvoke(() => flagged);

		const { result } = renderHook(() => useSkillProjectEquip("rt-android-expert"), { wrapper });
		await act(async () => {
			await result.current(TARGET, "on");
		});

		const infoToasts = useAppStore.getState().toasts.filter((t) => t.kind === "info");
		expect(infoToasts).toHaveLength(1);
		expect(infoToasts[0].title).toBe("rt-android-expert references needs-global");
	});

	it("the toast action runs one enable --with-refs, invalidates, and reports the result", async () => {
		const flagged = envelopeWith({
			"example-app": {
				missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }],
			},
		});
		const { hubCmdArgs } = mockInvoke(() => flagged);
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useSkillProjectEquip("rt-android-expert"), { wrapper });
		await act(async () => {
			await result.current(TARGET, "on");
		});

		const guardToast = useAppStore.getState().toasts.find((t) => t.kind === "info");
		expect(guardToast?.action?.label).toBe("Equip 1");

		invalidateSpy.mockClear();
		await act(async () => {
			await guardToast!.action!.onClick();
		});

		const withRefsCalls = hubCmdArgs.filter((a) => a.includes("--with-refs"));
		expect(withRefsCalls).toEqual([
			[
				"enable",
				"rt-android-expert",
				"--project",
				"example-app",
				"--with-refs",
				"--skill-only",
			],
		]);
		expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: qk.registry() }));
		expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: qk.syncReport() }));

		const resultToast = useAppStore
			.getState()
			.toasts.find((t) => t.kind === "success" && t.title === "Equipped 1 on example-app");
		expect(resultToast).toBeDefined();
	});

	it("a bundle apply announces once for the whole bundle", async () => {
		const flagged = envelopeWith({
			"example-app": {
				missing_refs: [
					{ skill: "rt-android-expert", refs: ["needs-global"] },
					{ skill: "android-compose-ui", refs: ["proof-it"] },
				],
			},
		});
		const { hubCmdArgs } = mockInvoke(() => flagged);

		const { result } = renderHook(() => useBundleProjectEquip("android"), { wrapper });
		await act(async () => {
			await result.current(TARGET, "on");
		});

		const infoToasts = useAppStore.getState().toasts.filter((t) => t.kind === "info");
		expect(infoToasts).toHaveLength(1);
		expect(infoToasts[0].title).toBe("android references 2 skills");

		await act(async () => {
			await infoToasts[0].action!.onClick();
		});

		const withRefsCalls = hubCmdArgs.filter((a) => a.includes("--with-refs"));
		expect(withRefsCalls).toHaveLength(2);
		expect(withRefsCalls).toContainEqual([
			"enable",
			"rt-android-expert",
			"--project",
			"example-app",
			"--with-refs",
			"--skill-only",
		]);
		expect(withRefsCalls).toContainEqual([
			"enable",
			"android-compose-ui",
			"--project",
			"example-app",
			"--with-refs",
			"--skill-only",
		]);
	});

	it("an equip with nothing missing pushes only the success toast", async () => {
		const clean = envelopeWith({ "example-app": { missing_refs: [] } });
		mockInvoke(() => clean);

		const { result } = renderHook(() => useSkillProjectEquip("rt-android-expert"), { wrapper });
		await act(async () => {
			await result.current(TARGET, "on");
		});

		const toasts = useAppStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].kind).toBe("success");
	});
});
