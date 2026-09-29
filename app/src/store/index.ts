import { create } from "zustand";
import { invoke } from "@/lib/ipc";
import { RECENT_TYPES, type Toast, type ToastKind, type RecentItem } from "@/types";
import type { AgentsCapability } from "@/lib/subagents";
import { type Tweaks, readTweaks, writeTweaks } from "@/lib/tweaks";
import { markTipsDone, TOUR } from "@/lib/tips";

import { createFeedbackSlice, type FeedbackSlice } from "./feedback";

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
  /** Absolute path of the harness's user-global instruction doc (from
   *  `harness_list`), or null/undefined when it declares none. */
  global_doc?: string | null;
  /** Whether that global-doc file currently exists on disk. */
  global_doc_exists?: boolean;
  /** Absolute config directory (`detect.dir` from the harness schema), or
   *  null/undefined when it declares none. Distinct from `path`, which
   *  prefers a resolved binary and only falls back to this same dir when
   *  none is on PATH — this field always names the config dir, even when a
   *  binary WAS found. Drives the "Open in Finder" affordance. */
  config_dir?: string | null;
  /** Harness-relative project skill directory from the harness schema. */
  project_skills_dir?: string | null;
}

export type SettingsCategory = "appearance" | "agents" | "worktrees" | "usage" | "backup" | "remotes";

interface AppStore extends FeedbackSlice {
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
  /** "Set up later" on the bootstrap wizard's FIRST decision: the runtime is
   *  fine, the user just wants to look around before answering. Kept separate
   *  from `degradedMode` (which means "Python/the backend is broken") because
   *  that flag also silences the first-run tour and forces the remote
   *  connector catalog offline — punishments for a deferral that earned none.
   *  Session-only on purpose: the wizard returns on next launch. */
  bootstrapDeferred: boolean;
  mutating: boolean;
  /** Number of Tauri commands currently in flight (maintained by `@/lib/ipc`'s
   *  `invoke` wrapper). Drives the StatusBar's debounced global busy indicator. */
  inFlight: number;
  harnesses: HarnessStatus[];
  updateInfo: UpdateInfo | null;
  updateStatus: UpdateStatus;
  updateProgress: number;
  /** Single source of truth for the Appearance settings state. */
  tweaks: Tweaks;
  /** Session-only Settings overlay state. Draft values remain in its mounted controller. */
  settingsOpen: boolean;
  settingsCategory: SettingsCategory;
  /** Most recent local-storage failure, if a preference could not persist. */
  tweaksPersistenceError: string | null;
  harnessesError: string | null;
  harnessScans: number;

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
  openSettings: (category?: SettingsCategory) => void;
  closeSettings: () => void;
  setSettingsCategory: (category: SettingsCategory) => void;
  setSyncStatus: (status: SyncStatus) => void;
  setLastSyncedAt: (date: Date) => void;
  /** Back-compat: split "title — body" into the richer toast shape. */
  addToast: (kind: ToastKind, message: string) => void;
  /** Push a fully-specified toast (duration / action / explicit body). */
  pushToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  addRecentlyVisited: (item: RecentItem) => void;
  setDegradedMode: (v: boolean) => void;
  setBootstrapDeferred: (v: boolean) => void;
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

// ─── Recent strip ────────────────────────────────────────────────────────────
// The Recent chips outlive the session: closing the app and coming back to an
// empty strip is the single most common "where was I" complaint. Persisted as a
// plain array under one key, read once at store construction.

export const RECENT_KEY = "st:recent";
/** Eight chips is what the sticky strip can scroll through without becoming a
 *  second, worse Library. Was 4 — too short to survive one detour. */
export const RECENT_CAP = 8;

const RECENT_TYPE_SET = new Set<string>(RECENT_TYPES);

/** Router sentinels (`/project/__none__` from a `useParams` fallback, and
 *  friends) are route-shaped but name no entity. They must never become a chip
 *  that navigates to a screen saying "not found". */
const SENTINEL_NAME = /^__.*__$/;

/** A recorded item is only worth keeping if its kind still has a route and its
 *  name could name something. Everything else is dropped silently — a stored
 *  chip from an older build must not crash or mislead the current one. */
export function isValidRecent(item: unknown): item is RecentItem {
  if (!item || typeof item !== "object") return false;
  const { type, name } = item as { type?: unknown; name?: unknown };
  if (typeof type !== "string" || !RECENT_TYPE_SET.has(type)) return false;
  if (typeof name !== "string" || name === "") return false;
  return !SENTINEL_NAME.test(name);
}

export function readRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecent).slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

export function writeRecent(items: RecentItem[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    /* localStorage unavailable (private window, quota) — chips stay in-session */
  }
}

/** Split a legacy "title — body" toast string into title + optional body. */
function splitMessage(message: string): { title: string; body?: string } {
  const idx = message.indexOf(" — ");
  if (idx === -1) return { title: message };
  return { title: message.slice(0, idx), body: message.slice(idx + 3) };
}

export const useAppStore = create<AppStore>((set, get, api) => ({
  ...createFeedbackSlice(set, get, api),
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
  recentlyVisited: readRecent(),
  degradedMode: false,
  bootstrapDeferred: false,
  mutating: false,
  inFlight: 0,
  harnesses: [],
  updateInfo: null,
  updateStatus: "idle",
  updateProgress: 0,
  tweaks: readTweaks(),
  settingsOpen: false,
  settingsCategory: "appearance",
  tweaksPersistenceError: null,
  harnessesError: null,
  harnessScans: 0,

  openPalette: (verbId?: string) =>
    set((s) => s.feedbackOpen ? {} : { paletteOpen: true, paletteInitialVerb: verbId ?? null }),
  closePalette: () => set({ paletteOpen: false, paletteInitialVerb: null }),
  clearPaletteInitialVerb: () => set({ paletteInitialVerb: null }),
  openCheatsheet: () => set({ cheatsheetOpen: true }),
  closeCheatsheet: () => set({ cheatsheetOpen: false }),
  openTips: () => set((s) => (s.settingsOpen || s.feedbackOpen) ? {} : { tipsOpen: true, tipsStep: 0 }),
  closeTips: (markDone) => {
    if (markDone) markTipsDone();
    set({ tipsOpen: false });
  },
  nextTip: () =>
    set((s) => ({ tipsStep: Math.min(s.tipsStep + 1, TOUR.length - 1) })),
  prevTip: () => set((s) => ({ tipsStep: Math.max(s.tipsStep - 1, 0) })),
  setFreshBootstrapCompleted: (v) => set({ freshBootstrapCompleted: v }),
  setChordPending: (prefix) => set({ chordPending: prefix }),
  openSettings: (category) =>
    set((s) => {
      if (s.tipsOpen || s.feedbackOpen) return {};
      // Local modal state lives with its owner, so use the mounted modal
      // marker as the final shell-level guard. Palette is intentionally
      // allowed because its action is the supported handoff into Settings.
      if (typeof document !== "undefined") {
        if (document.querySelector('.app[data-gate="true"]')) return {};
        const competing = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
        ).some((dialog) => !dialog.classList.contains("palette") && !dialog.classList.contains("settings-dialog"));
        if (competing) return {};
      }
      return {
      settingsOpen: true,
      settingsCategory: category ?? s.settingsCategory,
      // A palette handoff is atomic: Settings never renders beneath it.
      paletteOpen: false,
      paletteInitialVerb: null,
      cheatsheetOpen: false,
      };
    }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsCategory: (category) => set({ settingsCategory: category }),
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
    set((s) => ({ harnessScans: s.harnessScans + 1 }));
    try {
      const list = await invoke<HarnessStatus[]>("harness_list");
      // Never let the store hold a non-array (a mocked/empty/malformed reply
      // would make every `harnesses.*` read throw); coerce to an array.
      set({ harnesses: Array.isArray(list) ? list : [], harnessesError: null });
    } catch (err) {
      console.warn("harness_list failed", err);
      set({ harnessesError: String(err) });
    } finally {
      set((s) => ({ harnessScans: Math.max(0, s.harnessScans - 1) }));
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
      const persisted = writeTweaks(next);
      return {
        tweaks: next,
        tweaksPersistenceError: persisted
          ? null
          : "Couldn’t save appearance preferences. They will stay active for this session.",
      };
    }),

  addRecentlyVisited: (item) =>
    set((s) => {
      // Last line of defence. The writers already gate on the registry, but the
      // route-driven recorder cannot: it sees `/project/__none__` before any
      // screen has a chance to say the project does not exist.
      if (!isValidRecent(item)) return {};
      const filtered = s.recentlyVisited.filter(
        (r) => !(r.type === item.type && r.name === item.name),
      );
      const recentlyVisited = [item, ...filtered].slice(0, RECENT_CAP);
      writeRecent(recentlyVisited);
      return { recentlyVisited };
    }),

  setDegradedMode: (v) => set({ degradedMode: v }),

  setBootstrapDeferred: (v) => set({ bootstrapDeferred: v }),
}));
