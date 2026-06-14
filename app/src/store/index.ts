import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Toast, RecentItem } from "@/types";

type SyncStatus = "idle" | "syncing" | "synced" | "error";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateInfo {
  version: string;
  notes?: string;
}

export interface HarnessStatus {
  id: string;
  label: string;
  installed: boolean;
  on_globally: boolean;
  used_by_projects: string[];
  /** Resolved binary path or config dir (best-effort). */
  path?: string | null;
  /** Version string from `<bin> --version` (best-effort). */
  version?: string | null;
}

interface AppStore {
  paletteOpen: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: Date | null;
  toasts: Toast[];
  recentlyVisited: RecentItem[];
  degradedMode: boolean;
  mutating: boolean;
  harnesses: HarnessStatus[];
  updateInfo: UpdateInfo | null;
  updateStatus: UpdateStatus;
  updateProgress: number;

  openPalette: () => void;
  closePalette: () => void;
  setSyncStatus: (status: SyncStatus) => void;
  setLastSyncedAt: (date: Date) => void;
  addToast: (type: Toast["type"], message: string) => void;
  removeToast: (id: string) => void;
  addRecentlyVisited: (item: RecentItem) => void;
  setDegradedMode: (v: boolean) => void;
  setMutating: (v: boolean) => void;
  setHarnesses: (h: HarnessStatus[]) => void;
  rescanHarnesses: () => Promise<void>;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setUpdateStatus: (status: UpdateStatus) => void;
  setUpdateProgress: (pct: number) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  paletteOpen: false,
  syncStatus: "idle",
  lastSyncedAt: null,
  toasts: [],
  recentlyVisited: [],
  degradedMode: false,
  mutating: false,
  harnesses: [],
  updateInfo: null,
  updateStatus: "idle",
  updateProgress: 0,

  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  setSyncStatus: (status) => set({ syncStatus: status }),
  setLastSyncedAt: (date) => set({ lastSyncedAt: date }),
  setMutating: (v) => set({ mutating: v }),
  setHarnesses: (h) => set({ harnesses: h }),
  setUpdateInfo: (info) => set({ updateInfo: info }),
  setUpdateStatus: (status) => set({ updateStatus: status }),
  setUpdateProgress: (pct) => set({ updateProgress: pct }),
  rescanHarnesses: async () => {
    try {
      const list = await invoke<HarnessStatus[]>("harness_list");
      set({ harnesses: list });
    } catch (err) {
      console.warn("harness_list failed", err);
    }
  },

  addToast: (type, message) =>
    set((s) => ({
      toasts: [
        ...s.toasts,
        { id: crypto.randomUUID(), type, message },
      ],
    })),

  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  addRecentlyVisited: (item) =>
    set((s) => {
      const filtered = s.recentlyVisited.filter(
        (r) => !(r.type === item.type && r.name === item.name)
      );
      return { recentlyVisited: [item, ...filtered].slice(0, 4) };
    }),

  setDegradedMode: (v) => set({ degradedMode: v }),
}));
