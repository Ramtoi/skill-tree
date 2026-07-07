import { describe, it, expect, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { KEYMAP, hintForBindingId } from "@/lib/keymap";
import { ShortcutCheatsheet } from "@/components/ShortcutCheatsheet";
import { useAppStore } from "@/store";
import { renderWithProviders } from "./helpers";

describe("keymap registry — single source of truth", () => {
  beforeEach(() => {
    useAppStore.getState().closeCheatsheet();
  });

  it("every registry entry exposes a callable run handler", () => {
    for (const b of KEYMAP) {
      expect(typeof b.run).toBe("function");
      expect(b.id).toBeTruthy();
      expect(b.hint).toBeTruthy();
      expect(b.keys.length).toBeGreaterThan(0);
    }
    // ids are unique
    const ids = KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hintForBindingId returns the entry hint (and empty for unknown)", () => {
    expect(hintForBindingId("nav.permissions")).toBe("g ⇧p");
    expect(hintForBindingId("create.skill")).toBe("c s");
    expect(hintForBindingId("nope")).toBe("");
  });

  it("cheatsheet ↔ registry is bidirectional (no orphan hint, no missing entry)", () => {
    renderWithProviders(<ShortcutCheatsheet />);
    act(() => useAppStore.getState().openCheatsheet());

    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".cheatsheet-row[data-binding-id]"),
    );

    // Forward: every rendered registry row maps to a real entry with the exact hint.
    const rendered = new Map<string, string>();
    for (const row of rows) {
      const id = row.getAttribute("data-binding-id")!;
      const entry = KEYMAP.find((b) => b.id === id);
      expect(entry, `orphan cheatsheet row for ${id}`).toBeDefined();
      const hint = row.querySelector(".cheatsheet-hint")?.textContent ?? "";
      expect(hint).toBe(entry!.hint.split(" ").join(""));
      rendered.set(id, hint);
    }

    // Reverse: every registry entry is rendered.
    for (const b of KEYMAP) {
      expect(rendered.has(b.id), `missing cheatsheet row for ${b.id}`).toBe(true);
    }

    // The static Global block is present but NOT counted as registry entries.
    const staticRows = document.querySelectorAll('.cheatsheet-row[data-static="true"]');
    expect(staticRows.length).toBeGreaterThan(0);
    for (const r of Array.from(staticRows)) {
      expect(r.hasAttribute("data-binding-id")).toBe(false);
    }
  });
});
