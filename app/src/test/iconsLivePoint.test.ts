import { describe, it, expect } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { ICONS } from "@/components/icons";

/** Glyphs that participate in the live-point accent (COMPONENTS.md §Icons >
 *  Live-point accent). Each must tag one charged detail (or one symmetric
 *  pair) with className "ic-live". */
const SECTION_KEYS = [
  "library",
  "project",
  "source",
  "snippet",
  "hook",
  "permissions",
  "harness",
  "remote",
  "usage",
  // Backup joined the rail, so the archive crate owes a live point too.
  "archive",
  "command",
  "tweaks",
] as const;

interface Collected {
  type: string;
  props: Record<string, unknown>;
}

function collect(node: ReactNode, out: Collected[] = []): Collected[] {
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "string") out.push({ type: el.type, props: el.props });
  const children = el.props.children as ReactNode | ReactNode[] | undefined;
  for (const child of Array.isArray(children) ? children : [children]) {
    collect(child, out);
  }
  return out;
}

const livePoints = (key: string) =>
  collect(ICONS[key]).filter((e) => e.props.className === "ic-live");

describe("live-point contract (ic-live)", () => {
  it("every section glyph tags one charged detail (or one symmetric pair)", () => {
    for (const key of SECTION_KEYS) {
      const live = livePoints(key);
      expect(live.length, `${key} live points`).toBeGreaterThanOrEqual(1);
      expect(live.length, `${key} live points`).toBeLessThanOrEqual(2);
    }
  });

  it("bundle intentionally has no live point yet", () => {
    // Bundles is not a rail destination; the gem cluster stays uniform. If a
    // live point is added later, promote "bundle" into the loop above.
    expect(livePoints("bundle").length).toBe(0);
  });

  it("open-path live details declare fill so the CSS fill-in never lands on them", () => {
    // The CSS rule `.ic-live:not([fill])` translucently fills SELECTED live
    // details. That is only correct for closed shapes — an open path with a
    // computed fill grows a phantom lasso. Contract: every ic-live <path>
    // either sets a fill attribute (none/currentColor) or is a closed
    // subpath (its `d` ends segments with Z).
    for (const key of Object.keys(ICONS)) {
      for (const el of collect(ICONS[key])) {
        if (el.props.className !== "ic-live") continue;
        if (el.type !== "path") continue; // polygon/circle/rect are closed by nature
        const d = String(el.props.d ?? "");
        const closed = /z\s*$/i.test(d.trim());
        expect(
          closed || el.props.fill !== undefined,
          `${key}: open ic-live path "${d}" must set fill`,
        ).toBe(true);
      }
    }
  });
});
