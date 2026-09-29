import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUsagePeriodSelection } from "@/screens/usage/useUsagePeriodSelection";
import { adjacentUsagePeriod, periodFromKey } from "@/screens/usage/usagePeriod";

const route = vi.hoisted(() => ({ params: new URLSearchParams("day=2026-07-14"), setParams: vi.fn(), navigate: vi.fn() }));
vi.mock("react-router-dom", () => ({ useSearchParams: () => [route.params, route.setParams], useNavigate: () => route.navigate }));

describe("period selection during a pending URL transition", () => {
  beforeEach(() => { route.params = new URLSearchParams("day=2026-07-14"); vi.clearAllMocks(); });

  it("switches period kind, replaces stale period params and preserves unrelated filters", () => {
    route.params = new URLSearchParams("day=2026-07-14&filter=codex");
    const { result } = renderHook(useUsagePeriodSelection);
    act(() => result.current.selectPeriodKey("2026-07-14", "week"));
    expect(result.current.selectedPeriod).toEqual(periodFromKey("week", "2026-07-13"));
    const update = route.setParams.mock.calls[route.setParams.mock.calls.length - 1][0] as (params: URLSearchParams) => URLSearchParams;
    expect(update(route.params).toString()).toBe("filter=codex&week=2026-07-13");
    act(() => result.current.selectPeriodKey("2026-07", "month"));
    expect(result.current.selectedPeriod?.key).toBe("2026-07");
    expect(result.current.selectedPeriod?.kind).toBe("month");
  });

  it("rejects ambiguous period URLs and accepts month deep links", () => {
    route.params = new URLSearchParams("day=2026-07-14&week=2026-07-13");
    const { result, rerender } = renderHook(useUsagePeriodSelection);
    expect(result.current.selectedPeriod).toBeNull();
    route.params = new URLSearchParams("month=2024-02");
    rerender();
    expect(result.current.selectedPeriod?.until).toBe("2024-02-29");
  });

  it("applies rapid next/previous navigation before the URL has rendered", () => {
    const { result } = renderHook(useUsagePeriodSelection);
    act(() => result.current.setSelectedPeriod(adjacentUsagePeriod(result.current.selectedPeriod!, 1)));
    expect(result.current.selectedPeriod?.key).toBe("2026-07-15");
    act(() => result.current.setSelectedPeriod(adjacentUsagePeriod(result.current.selectedPeriod!, -1)));
    expect(result.current.selectedPeriod?.key).toBe("2026-07-14");
    act(() => result.current.setSelectedPeriod(null));
    expect(result.current.selectedPeriod).toBeNull();
  });

  it("follows an externally changed or invalid URL date", () => {
    const { result, rerender } = renderHook(useUsagePeriodSelection);
    route.params = new URLSearchParams("day=2026-07-13");
    rerender();
    expect(result.current.selectedPeriod?.key).toBe("2026-07-13");
    route.params = new URLSearchParams("day=2026-02-30");
    rerender();
    expect(result.current.selectedPeriod).toBeNull();
  });
});
