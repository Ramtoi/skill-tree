import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import {
  invalidateRegistry,
  invalidateRegistryDerived,
  invalidateUsageComposition,
} from "@/lib/invalidate";

describe("usage composition invalidation", () => {
  it("stales both read families for registry writes without scanning", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);

    await invalidateRegistry(client);

    const keys = invalidate.mock.calls.flatMap(([arg]) => (arg ? [arg.queryKey] : []));
    expect(keys).toContainEqual(["usage", "project"]);
    expect(keys).toContainEqual(["usage", "footprint"]);
    expect(keys).not.toContainEqual([
      "usage",
      "scan-sessions",
    ]);
  });

  it("stales both read families for agent-doc composition writes", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);

    await invalidateUsageComposition(client);

    expect(invalidate.mock.calls.flatMap(([arg]) => (arg ? [arg.queryKey] : []))).toEqual([
      ["usage", "project"],
      ["usage", "footprint"],
    ]);
  });
});

describe("invalidateRegistryDerived", () => {
  it("invalidates everything invalidateRegistry does except the registry key itself", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);

    await invalidateRegistryDerived(client);

    const keys = invalidate.mock.calls.flatMap(([arg]) => (arg ? [arg.queryKey] : []));
    expect(keys).not.toContainEqual(qk.registry());
    // The rest of REGISTRY_WRITE_KEYS, plus the companion/invocation/usage
    // families `invalidateRegistry` also stales.
    expect(keys).toContainEqual(qk.syncReport());
    expect(keys).toContainEqual(qk.hooks.doctor());
    expect(keys).toContainEqual(qk.skillCompanionsAll());
    expect(keys).toContainEqual(qk.invocationAll());
  });

  it("invalidateRegistry invalidates the registry key exactly once, then reuses the derived set", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);

    await invalidateRegistry(client);

    const keys = invalidate.mock.calls.flatMap(([arg]) => (arg ? [arg.queryKey] : []));
    expect(keys.filter((k) => JSON.stringify(k) === JSON.stringify(qk.registry()))).toHaveLength(1);
    expect(keys).toContainEqual(qk.skillCompanionsAll());
  });
});
