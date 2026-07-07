import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useChords } from "@/hooks/useChords";
import { KEYMAP, type KeymapCtx } from "@/lib/keymap";
import { useAppStore } from "@/store";

function makeCtx(): KeymapCtx {
  return {
    navigate: vi.fn(),
    openPalette: vi.fn(),
    lastProjectRoute: vi.fn(() => "/project/example-app"),
    firstBundleRoute: vi.fn(() => "/bundle/android"),
  };
}

function Harness({ ctx }: { ctx: KeymapCtx }) {
  useChords(KEYMAP, ctx);
  return <input data-testid="field" />;
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("useChords", () => {
  beforeEach(() => {
    useAppStore.getState().setChordPending(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("g then l navigates to Library", () => {
    const ctx = makeCtx();
    render(<Harness ctx={ctx} />);
    press("g");
    expect(useAppStore.getState().chordPending).toBe("g");
    press("l");
    expect(ctx.navigate).toHaveBeenCalledWith("/");
    expect(useAppStore.getState().chordPending).toBeNull();
  });

  it("c then s starts the new-skill flow", () => {
    const ctx = makeCtx();
    render(<Harness ctx={ctx} />);
    press("c");
    press("s");
    expect(ctx.navigate).toHaveBeenCalledWith("/?new=1");
  });

  it("shift-qualified g ⇧p is distinct from g p", () => {
    const ctx = makeCtx();
    render(<Harness ctx={ctx} />);
    press("g");
    // Browsers fire a lone `Shift` keydown before `P` — it must NOT cancel the
    // pending prefix (regression guard for the modifier-swallow bug).
    press("Shift");
    press("P");
    expect(ctx.navigate).toHaveBeenCalledWith("/permissions");

    (ctx.navigate as ReturnType<typeof vi.fn>).mockClear();
    press("g");
    press("p");
    expect(ctx.navigate).toHaveBeenCalledWith("/project/example-app");
  });

  it("is inert while a text field is focused (no navigation)", () => {
    const ctx = makeCtx();
    const { getByTestId } = render(<Harness ctx={ctx} />);
    (getByTestId("field") as HTMLInputElement).focus();
    press("g");
    expect(useAppStore.getState().chordPending).toBeNull();
    press("l");
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it("clears a pending prefix after the timeout", () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    render(<Harness ctx={ctx} />);
    press("g");
    expect(useAppStore.getState().chordPending).toBe("g");
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(useAppStore.getState().chordPending).toBeNull();
    // A stale second key does not re-trigger the chord.
    press("l");
    expect(ctx.navigate).not.toHaveBeenCalled();
  });
});
