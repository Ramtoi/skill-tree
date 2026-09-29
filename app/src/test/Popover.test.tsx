import { useRef, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Popover } from "@/components/Popover";

/** A minimal host: a trigger button anchors the popover, `open` is real
 *  React state so `onClose` closing it is observable. */
function Host({ onCloseSpy }: { onCloseSpy?: () => void }) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={anchorRef} type="button">
        Trigger
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          onCloseSpy?.();
        }}
        anchorRef={anchorRef}
        label="Test popover"
      >
        <button type="button">First</button>
        <button type="button">Second</button>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  it("renders portalled to document.body as a labelled dialog", () => {
    render(<Host />);
    const panel = screen.getByRole("dialog", { name: "Test popover" });
    expect(panel.parentElement).toBe(document.body);
  });

  it("focuses the first focusable element inside the panel on open", () => {
    vi.useFakeTimers();
    try {
      render(<Host />);
      vi.runAllTimers();
      expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Escape calls onClose", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    const panel = screen.getByRole("dialog", { name: "Test popover" });
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Test popover" })).toBeNull();
  });

  it("restores focus to the anchor after Escape closes it", () => {
    vi.useFakeTimers();
    try {
      render(<Host />);
      vi.runAllTimers(); // the initial focus-into-panel rAF
      const panel = screen.getByRole("dialog", { name: "Test popover" });
      fireEvent.keyDown(panel, { key: "Escape" });
      vi.runAllTimers(); // the restore-focus rAF
      expect(screen.getByRole("button", { name: "Trigger" })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an outside mousedown calls onClose", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    fireEvent.mouseDown(document.body);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("a mousedown inside the panel does not call onClose", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "First" }));
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Test popover" })).toBeInTheDocument();
  });

  it("a mousedown on the anchor does not call onClose", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Trigger" }));
    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  it("Tab from the first control to the second keeps the popover open (not every Tab is an exit)", async () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    screen.getByRole("button", { name: "First" }).focus();

    await userEvent.tab();

    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Test popover" })).toBeInTheDocument();
  });

  it("Tab past the last control closes the popover", async () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    // A trailing focusable sentinel, appended directly to `document.body` so
    // it lands AFTER the portalled panel in DOM order — otherwise there is
    // nothing past the panel's last control for `userEvent.tab()` (or a real
    // browser) to move focus INTO, and with no focus change there is no
    // blur/focusout for the popover to detect as a tab-out.
    const after = document.createElement("button");
    after.textContent = "After";
    document.body.appendChild(after);
    try {
      // The popover moves focus to its first control in a
      // `requestAnimationFrame` callback after mount. Let that land before
      // moving focus ourselves: if it fired during the awaited `tab()` below,
      // focus would snap back to "First" and the tab would stay inside the
      // panel (no focusout, no close). That race made this test flake on CI.
      await waitFor(() => expect(screen.getByRole("button", { name: "First" })).toHaveFocus());
      screen.getByRole("button", { name: "Second" }).focus();

      await userEvent.tab();

      expect(onCloseSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog", { name: "Test popover" })).toBeNull();
      expect(after).toHaveFocus();
    } finally {
      document.body.removeChild(after);
    }
  });

  it("a scroll whose target is inside the panel does not close it (the nested Select's own scrollIntoView)", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    const panel = screen.getByRole("dialog", { name: "Test popover" });
    const inner = screen.getByRole("button", { name: "First" });

    fireEvent.scroll(inner);
    fireEvent.scroll(panel);

    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  it("a scroll that moves the anchor closes it", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    const anchor = screen.getByRole("button", { name: "Trigger" });
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({ ...anchor.getBoundingClientRect(), top: 50 });
    fireEvent.scroll(document);

    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores a queued scroll when its position already includes that scroll", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);
    fireEvent.scroll(document);
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Test popover" })).toBeInTheDocument();
  });

  it("a window resize closes it", () => {
    const onCloseSpy = vi.fn();
    render(<Host onCloseSpy={onCloseSpy} />);

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    function ClosedHost() {
      const anchorRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div>
          <button ref={anchorRef} type="button">
            Trigger
          </button>
          <Popover open={false} onClose={() => {}} anchorRef={anchorRef} label="Closed popover">
            <button type="button">Hidden</button>
          </Popover>
        </div>
      );
    }
    render(<ClosedHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
