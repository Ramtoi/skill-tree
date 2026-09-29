import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useUsagePrefs } from "@/screens/usage/useUsagePrefs";
import { readUsagePreferences, parseEurRate } from "@/lib/usagePreferences";
import { useUsagePreferences } from "@/store/usagePreferences";

it("shares display preferences live while preserving each consumer's filters", () => {
  const { result } = renderHook(() => ({ a: useUsagePrefs(), b: useUsagePrefs() }));
  act(() => result.current.b.setRange("7d"));
  act(() => result.current.b.setHarness("codex"));
  act(() => result.current.a.setCurrency("EUR"));
  expect(result.current.b.currency).toBe("EUR");
  act(() => result.current.b.setEurRate(0.92));
  expect(result.current.a.eurRate).toBe(0.92);
  act(() => result.current.a.setOnlinePricing(true));
  expect(result.current.b.onlinePricing).toBe(true);
  expect(result.current.b.range).toBe("7d");
  expect(result.current.b.harness).toBe("codex");
  expect(result.current.a.range).toBe("all");
});

it("hydrates legacy keys and validates comma rates without accepting trailing text", () => {
  localStorage.setItem("st:usage:currency", "EUR");
  localStorage.setItem("st:usage:eurRate", "0,95");
  localStorage.setItem("st:usage:onlinePricing", "true");
  expect(readUsagePreferences()).toEqual({ currency: "EUR", eurRate: 0.95, onlinePricing: true });
  expect(parseEurRate("0,92")).toBe(0.92);
  expect(parseEurRate("0.92abc")).toBeUndefined();
  expect(parseEurRate("0.09")).toBeUndefined();
  expect(parseEurRate("5.01")).toBeUndefined();
});

it("retains session preferences and reports unavailable persistence", () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  try {
    useUsagePreferences.getState().setCurrency("EUR");
    expect(useUsagePreferences.getState().currency).toBe("EUR");
    expect(useUsagePreferences.getState().persistenceError).toMatch(/session only/);
  } finally {
    write.mockRestore();
  }
});
