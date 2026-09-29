import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/ipc";
import { usePermissionsDraft } from "@/hooks/usePermissionsDraft";
import type { NormalizedPermissions } from "@/types/permissions";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));

const permissions: NormalizedPermissions = {
	allow: [{ kind: "allow", pattern: "Read", origin: "project" }],
	deny: [],
	ask: [],
	hooks: [],
	sandbox_mode: null,
	approval_policy: null,
	project_trust: null,
	additional_dirs: [],
	extras: {},
	_unmanaged: [],
};

function renderDraft() {
	return renderHook(() => usePermissionsDraft({
		scope: { kind: "project", name: "example" },
		personalActive: false,
		permsData: permissions,
		invalidatePerms: vi.fn(),
		onFilterKind: vi.fn(),
		onFilterAll: vi.fn(),
		onFocusTarget: vi.fn(),
	}), { wrapper: StrictMode });
}

describe("permissions saved feedback lifetime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(invoke).mockImplementation(async (command) =>
			command === "permissions_show"
				? { ...permissions, allow: [] }
				: { changed: true, normalized: permissions },
		);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("clears saved feedback after 2.2 seconds while mounted", async () => {
		const { result } = renderDraft();
		await act(() => result.current.doSave());
		expect(result.current.savedJustNow).toBe(true);
		act(() => vi.advanceTimersByTime(2200));
		expect(result.current.savedJustNow).toBe(false);
	});

	it.each(["save", "move to global"] as const)(
		"cancels saved feedback on unmount after %s",
		async (operation) => {
			const { result, unmount } = renderDraft();
			await act(() => operation === "save"
				? result.current.doSave()
				: result.current.demoteRuleToGlobal("allow", 0));
			expect(result.current.savedJustNow).toBe(true);
			expect(vi.getTimerCount()).toBe(1);
			unmount();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("MCP batch permissions", () => {
 beforeEach(() => { vi.mocked(invoke).mockReset(); });
 it("validates actual decision kinds and saves the complete explicit payload", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "permissions_validate" ? { ok: true, error: null } : { changed: true, normalized: (args as { payload: NormalizedPermissions }).payload, sync_rc: 1 });
  const { result } = renderDraft();
  await act(async () => {
   const next = await result.current.applyMcpChanges([{ server: "calendar", decision: "ask" }, { server: "calendar", tool: "remove", decision: "deny" }]);
   expect(next).not.toBeNull();
   await result.current.doSaveDraft(next!);
  });
  expect(invoke).toHaveBeenCalledWith("permissions_validate", { pattern: "mcp__calendar", kind: "ask" });
  expect(invoke).toHaveBeenCalledWith("permissions_validate", { pattern: "mcp__calendar__remove", kind: "deny" });
  expect(invoke).toHaveBeenCalledWith("permissions_set", expect.objectContaining({ scope: { kind: "project", name: "example" }, personal: false, payload: expect.objectContaining({ allow: [{ pattern: "Read", kind: "allow" }], ask: [{ pattern: "mcp__calendar", kind: "ask" }], deny: [{ pattern: "mcp__calendar__remove", kind: "deny" }] }) }));
  expect(result.current.dirty).toBe(false);
  expect(result.current.lastSyncRc).toBe(1);
 });
 it("rejects invalid batches without partial changes and allows corrected retry", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ok: false, error: "bad target" }).mockResolvedValue({ ok: true, error: null });
  const { result } = renderDraft();
  await act(async () => { expect(await result.current.applyMcpChanges([{ server: "calendar", decision: "ask" }])).toBeNull(); });
  expect(result.current.draft?.ask).toEqual([]);
  expect(result.current.saveError).toBe("bad target");
  await act(async () => { expect(await result.current.applyMcpChanges([{ server: "calendar", decision: "ask" }])).not.toBeNull(); });
  expect(result.current.saveError).toBeNull();
  expect(result.current.validation).toEqual({});
 });
 it("locks duplicate batches during validation and retains dirty state after a failed save", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderDraft();
  let pending!: Promise<NormalizedPermissions | null>;
  act(() => { pending = result.current.applyMcpChanges([{ server: "calendar", decision: "deny" }]); });
  expect(result.current.applyingMcp).toBe(true);
  await act(async () => { expect(await result.current.applyMcpChanges([{ server: "other", decision: "ask" }])).toBeNull(); });
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ok: true, error: null }); await pending; });
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
  await act(async () => { expect(await result.current.doSaveDraft(result.current.draft!)).toBe(false); });
  expect(result.current.dirty).toBe(true);
  expect(result.current.draft?.deny[0].pattern).toBe("mcp__calendar");
  expect(result.current.saveError).toContain("disk full");
 });
 it("does not apply a delayed batch after changing project tiers", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result, rerender } = renderHook(({ personal }) => usePermissionsDraft({ scope: { kind: "project", name: "example" }, personalActive: personal, permsData: permissions, invalidatePerms: vi.fn(), onFilterKind: vi.fn(), onFilterAll: vi.fn(), onFocusTarget: vi.fn() }), { initialProps: { personal: false } });
  let pending!: Promise<NormalizedPermissions | null>;
  act(() => { pending = result.current.applyMcpChanges([{ server: "calendar", decision: "allow" }]); });
  rerender({ personal: true });
  await act(async () => { finish({ ok: true, error: null }); expect(await pending).toBeNull(); });
  expect(result.current.draft?.allow).toEqual(permissions.allow);
 });
});
