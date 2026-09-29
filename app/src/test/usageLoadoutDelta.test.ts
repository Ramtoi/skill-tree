import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearUsageLoadoutDelta,
	publishUsageLoadoutDelta,
	useUsageLoadoutDelta,
	useUsageLoadoutDeltaStore,
} from "@/store/usageLoadoutDelta";

describe("usage loadout delta store (G4)", () => {
	beforeEach(() => {
		useUsageLoadoutDeltaStore.setState({ deltas: {} });
	});

	it("publishes after minus before and selects null when absent", () => {
		expect(useUsageLoadoutDeltaStore.getState().deltas).toEqual({});
		publishUsageLoadoutDelta("moon-base", 100, 137);
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]).toEqual({
			project: "moon-base", before: 100, after: 137, delta: 37,
		});
		expect(useUsageLoadoutDeltaStore.getState().deltas["missing"] ?? null).toBeNull();
	});

	it("replaces one project record, clears it, and keeps projects separate", () => {
		publishUsageLoadoutDelta("moon-base", 90, 120);
		publishUsageLoadoutDelta("moon-base", 120, 101);
		publishUsageLoadoutDelta("sun-station", 12, 20);
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"]?.delta).toBe(-19);
		expect(useUsageLoadoutDeltaStore.getState().deltas["sun-station"]?.delta).toBe(8);
		clearUsageLoadoutDelta("moon-base");
		expect(useUsageLoadoutDeltaStore.getState().deltas["moon-base"] ?? null).toBeNull();
		expect(useUsageLoadoutDeltaStore.getState().deltas["sun-station"]?.delta).toBe(8);
	});

	it("the selector hook publishes a record, then clears back to null", () => {
		const { result } = renderHook(() => useUsageLoadoutDelta("moon-base"));
		expect(result.current).toBeNull();
		act(() => publishUsageLoadoutDelta("moon-base", 40, 55));
		expect(result.current).toEqual({
			project: "moon-base", before: 40, after: 55, delta: 15,
		});
		act(() => clearUsageLoadoutDelta("moon-base"));
		expect(result.current).toBeNull();
	});
});
