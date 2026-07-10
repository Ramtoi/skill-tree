import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { KEYMAP, hintForBindingId, type KeymapCtx } from "@/lib/keymap";
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

// ── B2-02: every chord's run() lands on its EXACT target ──────────────────────
// A route rename (e.g. `/harnesses`→`/harness`) or a fat-fingered handler must
// fail loudly. The expected map is written out by hand so it is an independent
// second source of truth — not derived from the same handler under test. An
// unmapped new binding also fails (`EXPECTED[id]` is undefined), forcing this
// table to be updated whenever a chord is added.
describe("keymap route targets (B2-02)", () => {
  /** Independent expectation per binding id. `navigate` = react-router target;
   *  `cheatsheet` = opens the `?` overlay via the store (no navigation). */
  const EXPECTED: Record<
    string,
    { navigate?: string; cheatsheet?: boolean }
  > = {
    "nav.library": { navigate: "/" },
    "nav.project": { navigate: "/project/example-app" },
    "nav.bundles": { navigate: "/bundle/android" },
    "nav.harnesses": { navigate: "/harnesses" },
    "nav.sources": { navigate: "/sources" },
    "nav.snippets": { navigate: "/snippets" },
    "nav.remotes": { navigate: "/remotes" },
    "nav.permissions": { navigate: "/permissions" },
    "create.skill": { navigate: "/?new=1" },
    "create.bundle": { navigate: "/?addBundle=1" },
    "help.cheatsheet": { cheatsheet: true },
  };

  function makeCtx(): KeymapCtx {
    return {
      navigate: vi.fn(),
      openPalette: vi.fn(),
      // Non-empty routes so goProject/goBundle take the navigate branch.
      lastProjectRoute: vi.fn(() => "/project/example-app"),
      firstBundleRoute: vi.fn(() => "/bundle/android"),
    };
  }

  beforeEach(() => {
    useAppStore.getState().closeCheatsheet();
  });

  it.each(KEYMAP.map((b) => [b.id, b] as const))(
    "%s dispatches to its declared target",
    (id, binding) => {
      const spec = EXPECTED[id];
      expect(
        spec,
        `KEYMAP entry "${id}" has no expected target — add it to EXPECTED so its route/action is pinned`,
      ).toBeDefined();

      const ctx = makeCtx();
      binding.run(ctx);

      if (spec.navigate !== undefined) {
        expect(ctx.navigate).toHaveBeenCalledTimes(1);
        expect(ctx.navigate).toHaveBeenCalledWith(spec.navigate);
        expect(ctx.openPalette).not.toHaveBeenCalled();
        expect(useAppStore.getState().cheatsheetOpen).toBe(false);
      }
      if (spec.cheatsheet) {
        expect(useAppStore.getState().cheatsheetOpen).toBe(true);
        expect(ctx.navigate).not.toHaveBeenCalled();
      }
    },
  );

  it("goProject / goBundle fall back to the palette when no route exists", () => {
    const ctx: KeymapCtx = {
      navigate: vi.fn(),
      openPalette: vi.fn(),
      lastProjectRoute: vi.fn(() => ""),
      firstBundleRoute: vi.fn(() => ""),
    };
    KEYMAP.find((b) => b.id === "nav.project")!.run(ctx);
    KEYMAP.find((b) => b.id === "nav.bundles")!.run(ctx);
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.openPalette).toHaveBeenCalledTimes(2);
  });
});
