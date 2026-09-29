import { useSkillClassificationEditor } from "@/hooks/useSkillClassificationEditor";
import { sampleRegistry } from "./helpers";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import { hubCmd } from "@/lib/hubCmd";
import { useSkillClassificationUpdate, useSkillRefsGraph } from "@/hooks/useSkillClassification";

vi.mock("@/lib/hubCmd", () => ({ hubCmd: vi.fn() }));
const { invalidations } = vi.hoisted(() => ({ invalidations: vi.fn(async (client: QueryClient) => { void client; }) }));
vi.mock("@/lib/invalidate", () => ({ invalidateRegistry: invalidations }));
const mockedHub = vi.mocked(hubCmd);
const wrapper = (client: QueryClient) => ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

describe("classification hooks", () => {
	beforeEach(() => { mockedHub.mockReset(); });
	it("orders editor assigned chips while the reference graph is pending", () => {
		mockedHub.mockImplementation(() => new Promise(() => {}));
		const registry = structuredClone(sampleRegistry);
		registry.skills.brainstorm.classification = { classes: ["Zulu", "beta", "Alpha"] };
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderHook(() => useSkillClassificationEditor("brainstorm", registry, { label: "Library", path: "/" }, vi.fn()), { wrapper: wrapper(client) });
		expect(view.result.current.classificationContributions.classes.map((item) => item.value)).toEqual(["Alpha", "beta", "Zulu"]);
	});
	it("reads the complete graph and preserves cold failure", async () => {
		mockedHub.mockResolvedValue({ success: true, output: '{"edges":[]}' });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderHook(() => useSkillRefsGraph(), { wrapper: wrapper(client) });
		await waitFor(() => expect(view.result.current.data).toEqual({ edges: [] }));
		expect(mockedHub).toHaveBeenCalledWith(["skill", "refs", "--json"]);
	});
	it("reports a cold graph command failure without data", async () => {
		mockedHub.mockResolvedValue({ success: false, output: "offline" });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderHook(() => useSkillRefsGraph(), { wrapper: wrapper(client) });
		await waitFor(() => expect(view.result.current.isError).toBe(true));
		expect(view.result.current.data).toBeUndefined();
	});
	it("keeps cached graph data when a refetch fails", async () => {
		mockedHub.mockResolvedValueOnce({ success: true, output: '{"edges":[]}' }).mockRejectedValueOnce(new Error("offline"));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
		const view = renderHook(() => useSkillRefsGraph(), { wrapper: wrapper(client) });
		await waitFor(() => expect(view.result.current.data).toEqual({ edges: [] }));
		let attempt: Awaited<ReturnType<typeof view.result.current.refetch>>;
		await act(async () => { attempt = await view.result.current.refetch(); });
		expect(view.result.current.data).toEqual({ edges: [] });
		expect(attempt!.isError).toBe(true);
	});
	it("serializes single fields, queues them, and recovers after failure", async () => {
		mockedHub.mockResolvedValueOnce({ success: false, output: "bad" }).mockResolvedValue({ success: true, output: "" });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderHook(() => useSkillClassificationUpdate("demo"), { wrapper: wrapper(client) });
		let first: Promise<void>; let second: Promise<void>;
		act(() => { first = view.result.current.update("classes", ["A", "B"]); second = view.result.current.update("maturity", "trusted"); });
		await act(async () => { await expect(first!).rejects.toThrow("bad"); });
		await act(async () => { await expect(second!).resolves.toBeUndefined(); });
		expect(mockedHub.mock.calls.map((call) => call[0])).toEqual([
			["set-meta", "demo", "--classes-json", '["A","B"]'],
			["set-meta", "demo", "--maturity", "trusted"],
		]);
		expect(invalidations).toHaveBeenCalledTimes(2);
		expect(invalidations.mock.calls.every(([client]) => client instanceof QueryClient)).toBe(true);
	});
});
