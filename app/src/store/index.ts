import { create } from "zustand";
import { invoke } from "@/lib/ipc";
import type { Toast, ToastKind, RecentItem } from "@/types";
import type { AgentsCapability } from "@/lib/subagents";
import { type Tweaks, readTweaks, writeTweaks } from "@/lib/tweaks";
import { markTipsDone, TOUR } from "@/lib/tips";

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
  /** Sub-agent capability (from `harness_list` → `emit_schema().agents`).
   *  Optional so pre-multi-harness fixtures/payloads stay assignable. */
  agents?: AgentsCapability;
}

interface AppStore {
  paletteOpen: boolean;
  /** When the palette opens straight into a verb stage (chord/ctx.openPalette). */
  paletteInitialVerb: string | null;
  /** `?` shortcut cheatsheet overlay. */
  cheatsheetOpen: boolean;
  /** First-run tips-tour overlay + its current step index. */
  tipsOpen: boolean;
  tipsStep: number;
  /** Set true when the bootstrap wizard finishes a genuinely FRESH install
   *  (zero pre-existing skills). Gates the tips-tour auto-start so a populated
   *  pre-bootstrap-version upgrade never triggers the tour. */
  freshBootstrapCompleted: boolean;
  /** Captured chord prefix while a multi-key chord is pending (e.g. "g"). */
  chordPending: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: Date | null;
  toasts: Toast[];
  recentlyVisited: RecentItem[];
  degradedMode: boolean;
  mutating: boolean;
  /** Number of Tauri commands currently in flight (maintained by `@/lib/ipc`'s
   *  `invoke` wrapper). Drives the StatusBar's debounced global busy indicator. */
  inFlight: number;
  harnesses: HarnessStatus[];
  updateInfo: UpdateInfo | null;
  updateStatus: UpdateStatus;
  updateProgress: number;
  /** Single source of truth for the Tweaks panel state (density/rail/demos). */
  tweaks: Tweaks;

  openPalette: (verbId?: string) => void;
  closePalette: () => void;
  clearPaletteInitialVerb: () => void;
  openCheatsheet: () => void;
  closeCheatsheet: () => void;
  /** Open the tips tour, resetting to the first step. */
  openTips: () => void;
  /** Close the tour; `markDone` persists `st:tips:done` (skip / complete). */
  closeTips: (markDone: boolean) => void;
  nextTip: () => void;
  prevTip: () => void;
  /** Mark that a fresh-install bootstrap just completed (drives tour auto-start). */
  setFreshBootstrapCompleted: (v: boolean) => void;
  setChordPending: (prefix: string | null) => void;
  setSyncStatus: (status: SyncStatus) => void;
  setLastSyncedAt: (date: Date) => void;
  /** Back-compat: split "title — body" into the richer toast shape. */
  addToast: (kind: ToastKind, message: string) => void;
  /** Push a fully-specified toast (duration / action / explicit body). */
  pushToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  addRecentlyVisited: (item: RecentItem) => void;
  setDegradedMode: (v: boolean) => void;
  setMutating: (v: boolean) => void;
  /** Register a command as started (increment the in-flight counter). */
  beginInFlight: () => void;
  /** Register a command as settled (decrement, clamped at 0). */
  endInFlight: () => void;
  setHarnesses: (h: HarnessStatus[]) => void;
  rescanHarnesses: () => Promise<void>;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setUpdateStatus: (status: UpdateStatus) => void;
  setUpdateProgress: (pct: number) => void;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
}

/** Split a legacy "title — body" toast string into title + optional body. */
function splitMessage(message: string): { title: string; body?: string } {
  const idx = message.indexOf(" — ");
  if (idx === -1) return { title: message };
  return { title: message.slice(0, idx), body: message.slice(idx + 3) };
}

export const useAppStore = create<AppStore>((set) => ({
  paletteOpen: false,
  paletteInitialVerb: null,
  cheatsheetOpen: false,
  tipsOpen: false,
  tipsStep: 0,
  freshBootstrapCompleted: false,
  chordPending: null,
  syncStatus: "idle",
  lastSyncedAt: null,
  toasts: [],
  recentlyVisited: [],
  degradedMode: false,
  mutating: false,
  inFlight: 0,
  harnesses: [],
  updateInfo: null,
  updateStatus: "idle",
  updateProgress: 0,
  tweaks: readTweaks(),

  openPalette: (verbId?: string) =>
    set({ paletteOpen: true, paletteInitialVerb: verbId ?? null }),
  closePalette: () => set({ paletteOpen: false, paletteInitialVerb: null }),
  clearPaletteInitialVerb: () => set({ paletteInitialVerb: null }),
  openCheatsheet: () => set({ cheatsheetOpen: true }),
  closeCheatsheet: () => set({ cheatsheetOpen: false }),
  openTips: () => set({ tipsOpen: true, tipsStep: 0 }),
  closeTips: (markDone) => {
    if (markDone) markTipsDone();
    set({ tipsOpen: false });
  },
  nextTip: () =>
    set((s) => ({ tipsStep: Math.min(s.tipsStep + 1, TOUR.length - 1) })),
  prevTip: () => set((s) => ({ tipsStep: Math.max(s.tipsStep - 1, 0) })),
  setFreshBootstrapCompleted: (v) => set({ freshBootstrapCompleted: v }),
  setChordPending: (prefix) => set({ chordPending: prefix }),
  setSyncStatus: (status) => set({ syncStatus: status }),
  setLastSyncedAt: (date) => set({ lastSyncedAt: date }),
  setMutating: (v) => set({ mutating: v }),
  beginInFlight: () => set((s) => ({ inFlight: s.inFlight + 1 })),
  endInFlight: () => set((s) => ({ inFlight: Math.max(0, s.inFlight - 1) })),
  setHarnesses: (h) => set({ harnesses: h }),
  setUpdateInfo: (info) => set({ updateInfo: info }),
  setUpdateStatus: (status) => set({ updateStatus: status }),
  setUpdateProgress: (pct) => set({ updateProgress: pct }),
  rescanHarnesses: async () => {
    try {
      const list = await invoke<HarnessStatus[]>("harness_list");
      // Never let the store hold a nullish list (a mocked/empty reply would make
      // every `harnesses.*` read throw); coerce to an array.
      set({ harnesses: list ?? [] });
    } catch (err) {
      console.warn("harness_list failed", err);
    }
  },

  addToast: (kind, message) =>
    set((s) => ({
      toasts: [
        ...s.toasts,
        { id: crypto.randomUUID(), kind, ...splitMessage(message) },
      ],
    })),

  pushToast: (toast) =>
    set((s) => ({
      toasts: [...s.toasts, { id: crypto.randomUUID(), ...toast }],
    })),

  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setTweak: (key, value) =>
    set((s) => {
      const next = { ...s.tweaks, [key]: value };
      writeTweaks(next);
      return { tweaks: next };
    }),

  addRecentlyVisited: (item) =>
    set((s) => {
      const filtered = s.recentlyVisited.filter(
        (r) => !(r.type === item.type && r.name === item.name)
      );
      return { recentlyVisited: [item, ...filtered].slice(0, 4) };
    }),

  setDegradedMode: (v) => set({ degradedMode: v }),
}));
