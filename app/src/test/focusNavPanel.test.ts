import { describe, it, expect, afterEach } from "vitest";
import { focusNavPanel } from "@/lib/focusNavPanel";

// Mirrors `focusScreenSearch.test.ts` — a small, independently-testable
// helper the `g ⇧n` chord calls (spec §3.2/§8.4).

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusNavPanel", () => {
  it("returns false on an empty DOM (no .app-side at all)", () => {
    expect(focusNavPanel()).toBe(false);
  });

  it("returns false when the aside is inert", () => {
    document.body.innerHTML = `
      <aside class="app-side" inert>
        <button data-side-row tabindex="0">row</button>
      </aside>
    `;
    expect(focusNavPanel()).toBe(false);
  });

  it("returns false when the aside is not rendered (offsetParent === null — jsdom's default, same as display:none)", () => {
    document.body.innerHTML = `
      <aside class="app-side">
        <button data-side-row tabindex="0">row</button>
      </aside>
    `;
    // jsdom never computes layout, so `offsetParent` is null here by default —
    // exactly the state a `display:none` ancestor produces in a real browser.
    expect(focusNavPanel()).toBe(false);
  });

  it("returns false when there is no tabbable row yet", () => {
    document.body.innerHTML = `<aside class="app-side"></aside>`;
    const aside = document.querySelector(".app-side") as HTMLElement;
    Object.defineProperty(aside, "offsetParent", { value: document.body, configurable: true });
    expect(focusNavPanel()).toBe(false);
  });

  it("focuses the tabindex-0 row and returns true when the aside is rendered", () => {
    document.body.innerHTML = `
      <aside class="app-side">
        <button data-side-row tabindex="-1">first</button>
        <button data-side-row tabindex="0">active</button>
      </aside>
    `;
    const aside = document.querySelector(".app-side") as HTMLElement;
    // Simulate "actually laid out" for jsdom, which never computes layout.
    Object.defineProperty(aside, "offsetParent", { value: document.body, configurable: true });
    expect(focusNavPanel()).toBe(true);
    expect(document.activeElement?.textContent).toBe("active");
  });
});
