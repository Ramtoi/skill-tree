import { create } from "zustand";

export interface UsageLoadoutDelta {
	project: string;
	before: number;
	after: number;
	delta: number;
}

interface UsageLoadoutDeltaState {
	deltas: Record<string, UsageLoadoutDelta>;
	publish: (project: string, before: number, after: number) => void;
	clear: (project: string) => void;
}

export const useUsageLoadoutDeltaStore = create<UsageLoadoutDeltaState>((set) => ({
	deltas: {},
	publish: (project, before, after) => set((state) => ({
		deltas: { ...state.deltas, [project]: { project, before, after, delta: after - before } },
	})),
	clear: (project) => set((state) => {
		const deltas = { ...state.deltas };
		delete deltas[project];
		return { deltas };
	}),
}));

export const publishUsageLoadoutDelta = (project: string, before: number, after: number) =>
	useUsageLoadoutDeltaStore.getState().publish(project, before, after);
export const clearUsageLoadoutDelta = (project: string) =>
	useUsageLoadoutDeltaStore.getState().clear(project);
export const useUsageLoadoutDelta = (project: string) =>
	useUsageLoadoutDeltaStore((state) => state.deltas[project] ?? null);

/** Cleanup seam for ProjectWorkspace. */
export function useClearUsageLoadoutDelta(project: string): () => void {
	return () => clearUsageLoadoutDelta(project);
}
