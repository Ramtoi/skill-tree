import { create } from "zustand";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { UNDO_TOAST_DURATION_MS } from "@/hooks/useUndoableAction";
import {
  moveSection,
  orderStorageKey,
  readSectionOrder,
  reconcileOrder,
} from "@/lib/projectLoadoutOrder";
import {
  sectionKey,
  type LoadoutSection,
  type SectionRef,
} from "@/lib/projectLoadout";

interface OrderState {
  edits: Record<string, number>;
  edit: (path: string) => number;
  values: Record<string, SectionRef[] | null>;
  set: (path: string, value: SectionRef[] | null) => void;
}
export const useLoadoutOrderStore = create<OrderState>((set, get) => ({
  edits: {},
  edit: (path) => {
    const revision = (get().edits[path] ?? 0) + 1;
    set((state) => ({ edits: { ...state.edits, [path]: revision } }));
    return revision;
  },
  values: {},
  set: (path, value) =>
    set((state) => ({ values: { ...state.values, [path]: value } })),
}));
function read(path: string) {
  try {
    return readSectionOrder(localStorage.getItem(orderStorageKey(path)));
  } catch {
    return null;
  }
}
function save(path: string, value: SectionRef[] | null): boolean {
  useLoadoutOrderStore.getState().set(path, value);
  try {
    if (value === null) localStorage.removeItem(orderStorageKey(path));
    else
      localStorage.setItem(
        orderStorageKey(path),
        JSON.stringify({ version: 1, sections: value }),
      );
    return true;
  } catch {
    return false;
  }
}
export function migrateProjectLoadoutOrder(from: string, to: string): boolean {
  if (from === to) return true;
  const memory = useLoadoutOrderStore.getState().values[from];
  const value = memory === undefined ? read(from) : memory;
  if (!save(to, value)) return false;
  useLoadoutOrderStore.getState().edit(from);
  return save(from, null);
}
export function removeProjectLoadoutOrder(path: string) {
  useLoadoutOrderStore.getState().edit(path);
  return save(path, null);
}

export function useProjectLoadoutOrder(
  path: string,
  sections: LoadoutSection[],
) {
  const saved = useLoadoutOrderStore((state) => state.values[path]);
  const toast = useToast();
  const current = useRef({ path, sections });
  current.current = { path, sections };
  useEffect(() => {
    if (useLoadoutOrderStore.getState().values[path] === undefined)
      useLoadoutOrderStore.getState().set(path, read(path));
  }, [path]);
  const canonical = sections.map((section) => section.ref);
  const override = saved === undefined ? read(path) : saved;
  const refs = reconcileOrder(override, canonical);
  const canonicalKey = JSON.stringify(canonical);
  useEffect(() => {
    if (
      override !== null &&
      JSON.stringify(override) !== JSON.stringify(refs)
    ) {
      if (!save(path, refs))
        toast.error(
          "Layout kept for this session",
          "Could not save the updated section list.",
        );
    }
    // Canonical identity changes trigger reconciliation; content-only edits do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, canonicalKey, saved]);
  const byKey = new Map(
    sections.map((section) => [sectionKey(section.ref), section]),
  );
  function persist(value: SectionRef[] | null) {
    const saved = save(path, value);
    if (!saved)
      toast.error(
        "Layout kept for this session",
        "Couldn't save section order on this machine.",
      );
    return saved;
  }
  function change(value: SectionRef[] | null, label: string) {
    const before = override;
    const revision = useLoadoutOrderStore.getState().edit(path);
    const persisted = persist(value);
    toast.push({
      kind: persisted ? "success" : "info",
      title: persisted ? label : "Section order changed for this session",
      duration: UNDO_TOAST_DURATION_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (
            revision !== useLoadoutOrderStore.getState().edits[path] ||
            current.current.path !== path
          )
            return;
          useLoadoutOrderStore.getState().edit(path);
          persist(
            before === null
              ? null
              : reconcileOrder(
                  before,
                  current.current.sections.map((section) => section.ref),
                ),
          );
        },
      },
    });
  }
  return {
    sections: refs.map((ref) => byKey.get(sectionKey(ref))!),
    custom: override !== null,
    move: (key: string, before?: string) =>
      change(
        moveSection(refs, key, before),
        "Section order saved on this machine",
      ),
    reset: () => change(null, "Following bundle section order"),
  };
}
