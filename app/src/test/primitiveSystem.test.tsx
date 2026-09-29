import { useState } from "react";
import { readAppCss } from "./readAppCss";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { Toggle } from "@/components/Toggle";
import { Field } from "@/components/Field";
import { Button } from "@/components/Button";
import { StatusBadge } from "@/components/StatusBadge";
import { StatePill } from "@/components/StatePill";
import { Chip, Chips } from "@/components/Chips";
import { OverflowMenu } from "@/components/OverflowMenu";
import { Modal, ConfirmDialog } from "@/components/Modal";
import { ToastContainer } from "@/components/Toast";
import { UNDO_TOAST_DURATION_MS } from "@/hooks/useUndoableAction";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useTweaks } from "@/hooks/useTweaks";
import { focusScreenSearch, isTextEntryTarget } from "@/lib/focusScreenSearch";
import { useAppStore } from "@/store";

const css = readAppCss();

beforeEach(() => {
  useAppStore.setState({
    toasts: [],
    settingsOpen: false,
    settingsCategory: "appearance",
    tweaks: {
      density: "default",
      showRail: true,
      railExpanded: false,
      showNav: true,
      demoError: false,
    },
  });
});

// ─── Toggle ─────────────────────────────────────────────────────────────────
describe("Toggle", () => {
  it("toggles on Space from the keyboard and fires onChange", async () => {
    function H() {
      const [on, setOn] = useState(false);
      return <Toggle checked={on} onChange={setOn} ariaLabel="flag" />;
    }
    render(<H />);
    const input = screen.getByRole("checkbox", { name: "flag" });
    input.focus();
    await userEvent.keyboard(" ");
    expect((input as HTMLInputElement).checked).toBe(true);
  });

  it("renders the on-state via the brand skin (data-checked), never green/blue", () => {
    const { container } = render(
      <Toggle checked onChange={() => {}} ariaLabel="x" />,
    );
    expect(container.querySelector(".toggle[data-checked]")).toBeTruthy();
    // CSS contract: checked skin uses --anchor (the brand channel).
    expect(css).toMatch(/\.toggle-checkbox\[data-checked\] \.toggle-skin[\s\S]*?var\(--anchor\)/);
  });

  it("applies the indeterminate DOM property (checkbox variant)", () => {
    render(<Toggle checked={false} indeterminate onChange={() => {}} ariaLabel="tri" />);
    const input = screen.getByRole("checkbox", { name: "tri" }) as HTMLInputElement;
    expect(input.indeterminate).toBe(true);
  });

  it("clicking the label toggles (label wraps the control)", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Enable" />);
    await userEvent.click(screen.getByText("Enable"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

// ─── Field validation ────────────────────────────────────────────────────────
describe("Field validation contract", () => {
  it("sets aria-invalid on the control and renders the error inline", () => {
    render(
      <Field label="Name" error="Required">
        <input aria-label="name-input" />
      </Field>,
    );
    expect(screen.getByLabelText("name-input")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });

  it("Button.disabledReason keeps the reason discoverable while inert", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled disabledReason="Fix the name field" onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAttribute("title", "Fix the name field");
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

// ─── StatusBadge ──────────────────────────────────────────────────────────────
describe("StatusBadge", () => {
  it("carries state via channel and never the brand violet", () => {
    const channels = ["ok", "info", "warn", "error", "neutral"] as const;
    for (const ch of channels) {
      const { container, unmount } = render(<StatusBadge channel={ch}>{ch}</StatusBadge>);
      const el = container.querySelector(".status-badge")!;
      expect(el.getAttribute("data-channel")).toBe(ch);
      unmount();
    }
    // CSS contract: no status-badge channel maps to the brand accent.
    const badgeBlock = css.slice(css.indexOf(".status-badge"), css.indexOf(".status-badge") + 900);
    expect(badgeBlock).not.toMatch(/data-channel[\s\S]*?var\(--anchor\)/);
    expect(badgeBlock).not.toMatch(/data-channel[\s\S]*?var\(--ctx\)/);
  });

  it("pulse motion is expressed as data-motion (dropped under reduced-motion in CSS)", () => {
    const { container } = render(
      <StatusBadge channel="info" motion="pulse" shape="dot" />,
    );
    expect(container.querySelector('.status-badge[data-motion="pulse"]')).toBeTruthy();
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*?data-motion="pulse"[\s\S]*?animation: none/);
  });

  it("StatePill is a StatusBadge preset (composes the base)", () => {
    const { container } = render(<StatePill state="unsaved">UNSAVED</StatePill>);
    const el = container.querySelector(".status-badge.state-pill")!;
    expect(el).toBeTruthy();
    expect(el.getAttribute("data-channel")).toBe("warn");
  });
});

// ─── Button ───────────────────────────────────────────────────────────────────
describe("Button disabled contract", () => {
  /**
   * Violet means pressable. A disabled primary that keeps its violet fill is a
   * control lying about itself, and the grey label sitting on that translucent
   * slab measured 1.9:1 — the exact text ("Use this repository", "Store token")
   * that tells an unsure user what the control is for.
   *
   * Both spellings of disabled are covered because `disabledReason` deliberately
   * keeps the button focusable (`aria-disabled`) rather than using the native
   * attribute, so a rule written only against `:disabled` would miss every
   * soft-disabled control — which is most of them on the backup surfaces.
   *
   * jsdom applies no stylesheet, so the DOM half and the CSS half are asserted
   * separately: the component must emit the hooks, the stylesheet must
   * neutralise them.
   */
  it("emits both disabled spellings so the CSS can catch either", () => {
    const { container, rerender } = render(
      <Button variant="primary" disabled>Use this repository</Button>,
    );
    expect(container.querySelector(".btn-primary")).toHaveAttribute("disabled");

    rerender(
      <Button variant="primary" disabled disabledReason="Paste a token first">
        Store token
      </Button>,
    );
    const soft = container.querySelector(".btn-primary")!;
    expect(soft).toHaveAttribute("aria-disabled", "true");
    expect(soft).not.toHaveAttribute("disabled");
  });

  it("drops primary and danger out of the accent channel when inert", () => {
    const at = css.indexOf(".btn-primary:disabled:not(.is-loading)");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    for (const sel of [
      ".btn-primary:disabled",
      '.btn-primary[aria-disabled="true"]',
      ".btn-danger:disabled",
      '.btn-danger[aria-disabled="true"]',
    ]) {
      expect(rule).toContain(sel);
    }
    // Neutral surface, readable label, no accent fill or glow left behind.
    expect(rule).toContain("background: var(--bg-2)");
    expect(rule).toContain("color: var(--fg-mute)");
    expect(rule).toContain("box-shadow: none");
    expect(rule).not.toContain("--anchor");
    expect(rule).not.toContain("--red");
    // Declared AFTER the blanket fade, or the same-specificity fade wins and
    // the label goes back to 40%-opacity grey on grey.
    expect(at).toBeGreaterThan(css.indexOf(".btn:disabled,"));
  });

  it("leaves a busy button its colour — its own mutation is still in flight", () => {
    const at = css.indexOf(".btn-primary:disabled:not(.is-loading)");
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain(":not(.is-loading)");
    const { container } = render(<Button variant="primary" busy>Back up now</Button>);
    expect(container.querySelector(".btn-primary.is-loading")).toBeTruthy();
  });
});

// ─── Chip ─────────────────────────────────────────────────────────────────────
describe("Chip surface", () => {
  it("wraps the label so it can never wrap to a second line", () => {
    render(
      <Chips>
        <Chip>Agent Docs</Chip>
      </Chips>,
    );
    const label = screen.getByText("Agent Docs");
    expect(label.className).toContain("chip-label");
    expect(css).toMatch(/\.chip \{[\s\S]*?white-space: nowrap/);
  });

  it("defines an edge-fade scroll cue that appears only when the strip scrolls", () => {
    // Pure-CSS scroll-shadow (background-attachment: local + scroll) → the cue
    // is painted only when the strip actually overflows.
    expect(css).toMatch(/\.main-subheader-left \{[\s\S]*?background:[\s\S]*?local[\s\S]*?scroll/);
  });
});

// ─── ScreenHeader `/` hotkey ──────────────────────────────────────────────────
describe("Screen search `/` hotkey selector", () => {
  it("focuses the search input when it lives in the subheader", () => {
    document.body.innerHTML = `
      <div class="main-header"></div>
      <div class="main-subheader">
        <div class="main-subheader-left">
          <div class="search-input"><input aria-label="lib-search" /></div>
        </div>
      </div>`;
    expect(focusScreenSearch()).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(".main-subheader input"));
  });

  it("returns false when no screen search exists", () => {
    document.body.innerHTML = `<div class="main-header"></div>`;
    expect(focusScreenSearch()).toBe(false);
  });

  // The `/` hotkey must not fire while the user is typing. `useChords` and
  // `useListNav` have always guarded contenteditable; App.tsx's `/` handler did
  // not, so typing `/` inside a CodeMirror editor yanked focus to the screen
  // search. It only stayed invisible while no editor screen HAD a screen search
  // — the hook editor's tool filter is one, which is how it surfaced.
  it("treats contenteditable (CodeMirror) as text entry, not just input/textarea", () => {
    document.body.innerHTML = `
      <input id="i" />
      <textarea id="t"></textarea>
      <div id="cm" contenteditable="true"><span id="cm-line">x</span></div>
      <div id="plain"></div>`;
    const at = (id: string) => document.getElementById(id);
    expect(isTextEntryTarget(at("i"))).toBe(true);
    expect(isTextEntryTarget(at("t"))).toBe(true);
    expect(isTextEntryTarget(at("cm"))).toBe(true);
    // …including a keystroke whose target is a child of the editable host.
    expect(isTextEntryTarget(at("cm-line"))).toBe(true);
    // A non-editable element is still fair game for a bare-key hotkey.
    expect(isTextEntryTarget(at("plain"))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

// ─── OverflowMenu keyboard nav ────────────────────────────────────────────────
describe("OverflowMenu keyboard", () => {
  it("opens with focus on the first item, ArrowDown/End move, Enter activates", async () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <OverflowMenu
        items={[
          { label: "Alpha", onClick: a },
          { label: "Beta", onClick: b },
        ]}
      />,
    );
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    const items = screen.getAllByRole("menuitem");
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "End" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    // Enter activates the focused item (native button → click).
    await userEvent.keyboard("{Enter}");
    expect(a).toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("Enter activates the item once and never reaches an enclosing listbox", async () => {
    // An OverflowMenu can live inside a `useListNav` listbox (a Sources card).
    // That container's keydown ALSO claims Enter and preventDefaults it, which
    // would otherwise leave every menu item keyboard-dead.
    const a = vi.fn();
    const containerEnter = vi.fn();
    render(
      <div
        role="listbox"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            containerEnter();
          }
        }}
      >
        <OverflowMenu items={[{ label: "Alpha", onClick: a }]} />
      </div>,
    );
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    const item = screen.getByRole("menuitem");
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(document.activeElement).toBe(item));

    fireEvent.keyDown(item, { key: "Enter" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(containerEnter).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger on Esc", async () => {
    render(<OverflowMenu items={[{ label: "Alpha", onClick: () => {} }]} />);
    const trigger = screen.getByTestId("overflow-trigger");
    await userEvent.click(trigger);
    const item = screen.getByRole("menuitem");
    fireEvent.keyDown(item, { key: "Escape" });
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  // B1 (side-panels wave 2b audit): the panel used to be a plain `position:
  // absolute` child of `.overflow-menu`, clipped by any scrolling ancestor
  // (the snippet Applied-to well capped at 420px). It is now a portal.
  it("portals the open panel to document.body, not the wrapper", async () => {
    const { container } = render(
      <div className="scroll-clipper" style={{ overflow: "hidden" }}>
        <OverflowMenu items={[{ label: "Alpha", onClick: () => {} }]} />
      </div>,
    );
    expect(container.querySelector(".overflow-menu-panel")).toBeNull();
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    const panel = screen.getByRole("menu");
    expect(panel.parentElement).toBe(document.body);
    expect(container.querySelector(".overflow-menu-panel")).toBeNull();
  });

  it("closes and returns focus to the trigger on a scroll that moves it", async () => {
    render(<OverflowMenu items={[{ label: "Alpha", onClick: () => {} }]} />);
    const trigger = screen.getByTestId("overflow-trigger");
    await userEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // A scroll that leaves the trigger in place keeps the menu open
    // (OverflowMenu.test.tsx); one that moves it closes the menu.
    const wrap = trigger.closest(".overflow-menu") as HTMLElement;
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue({ ...wrap.getBoundingClientRect(), top: 50, left: 50 } as DOMRect);
    fireEvent.scroll(window);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

// ─── Modal / ConfirmDialog ────────────────────────────────────────────────────
describe("Modal overlay", () => {
  it("traps Tab within the dialog and closes on Esc", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} aria-label="T" dismissable>
        <button>first</button>
        <button>last</button>
      </Modal>,
    );
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * Consent whose substance is a LIST cannot be given before the list has been
   * seen. The restore dialog enumerated hook commands, the connector code this
   * app imports and executes, and the files replaced outside the library — and
   * clipped mid-item at the scroll edge with the destructive confirm live
   * underneath, the typed-RESTORE field itself below the fold.
   *
   * jsdom reports every scroll metric as 0, which is exactly the "body does not
   * scroll" case: the gate must be OPEN then, or a short plan in a tall window
   * would arrive with a permanently dead button. The blocked case is driven by
   * stubbing the metrics the effect reads.
   */
  it("does not gate a confirm whose body does not scroll", () => {
    render(
      <ConfirmDialog open requireScrollToEnd onClose={() => {}} onConfirm={() => {}} title="T" body={<p>short</p>} />,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.queryByTestId("confirm-scroll-gate")).toBeNull();
  });

  it("holds the confirm until the body is scrolled to its end", () => {
    const define = (el: Element, values: Record<string, number>) => {
      for (const [k, v] of Object.entries(values)) {
        Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
      }
    };
    const { rerender } = render(
      <ConfirmDialog
        open
        requireScrollToEnd
        scrollGateLabel="Read to the end of the list first"
        onClose={() => {}}
        onConfirm={() => {}}
        title="T"
        body={<p>long</p>}
      />,
    );
    const body = document.querySelector(".modal-body")!;
    define(body, { scrollHeight: 1200, clientHeight: 400, scrollTop: 0 });
    // Re-run the effect with the stubbed metrics in place.
    rerender(
      <ConfirmDialog
        open
        requireScrollToEnd
        scrollGateLabel="Read to the end of the list first"
        onClose={() => {}}
        onConfirm={() => {}}
        title="T"
        body={<p>long!</p>}
      />,
    );

    const confirm = screen.getByRole("button", { name: /Confirm/ });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    // The reason is ON the dialog, not in a tooltip nobody will hover.
    expect(screen.getByTestId("confirm-scroll-gate")).toHaveTextContent(
      "Read to the end of the list first",
    );

    // Reaching the end releases it — with 2px of slack, because sub-pixel
    // layout leaves scrollTop a hair short of the arithmetic maximum and a
    // button that stays dead at the literal bottom is the worst failure here.
    define(body, { scrollTop: 799 });
    fireEvent.scroll(body);
    expect(confirm).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByTestId("confirm-scroll-gate")).toBeNull();
  });

  it("leaves ungated confirms alone (the gate is opt-in)", () => {
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="T" body={<p>x</p>} />,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("dismissable: mousedown on the backdrop closes; mousedown inside the dialog does not (B2-06)", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} aria-label="Dismissable" dismissable>
        <button>inner</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    const backdrop = document.querySelector(".modal-backdrop") as HTMLElement;

    // A press that starts AND ends on the backdrop itself dismisses.
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    // A press originating inside the dialog (target !== backdrop) must NOT close,
    // even though the event bubbles up to the backdrop's handler. This guards the
    // e.target === e.currentTarget check that prevents text-select drags from
    // dismissing.
    onClose.mockClear();
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismissable={false}: Esc is inert, no close button, backdrop is inert (B2-06)", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Blocking" dismissable={false}>
        <button>proceed</button>
      </Modal>,
    );
    // No close (X) button in the header for a blocking flow.
    expect(document.querySelector(".modal-close")).toBeNull();

    // Esc does not close.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // Backdrop click does not close either.
    fireEvent.mouseDown(document.querySelector(".modal-backdrop") as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders as role=dialog with aria-modal and constrains width to min(x,92vw)", () => {
    render(
      <Modal open onClose={() => {}} title="Sized" width={480}>
        body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect((dialog as HTMLElement).style.width).toBe("min(480px, 92vw)");
  });

  it("restores focus to the opener when closed", async () => {
    function H() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="R">
            <button onClick={() => setOpen(false)}>close</button>
          </Modal>
        </>
      );
    }
    render(<H />);
    const opener = screen.getByTestId("opener");
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "close" }));
    await act(async () => {});
    expect(document.activeElement).toBe(opener);
  });

  it("ConfirmDialog danger tone shows a red confirm + blast radius and fires onConfirm", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Delete?"
        tone="danger"
        confirmLabel="Delete bundle"
        blastRadius={<div>3 projects affected</div>}
      />,
    );
    expect(screen.getByText("3 projects affected")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Delete bundle" });
    expect(confirm.className).toContain("btn-danger");
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
  });

  it("ConfirmDialog busy disables the confirm + shows a spinner", () => {
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="Go" busy confirmLabel="Run" />,
    );
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });
});

// ─── Toast ────────────────────────────────────────────────────────────────────
describe("Toast system", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("error toasts linger longer than success/info toasts", () => {
    vi.useFakeTimers();
    useAppStore.getState().pushToast({ kind: "error", title: "boom" });
    useAppStore.getState().pushToast({ kind: "info", title: "fyi" });
    render(<ToastContainer />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText("fyi")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3300);
    });
    // info (3200) gone, error (6000) still present
    expect(screen.queryByText("fyi")).not.toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("info toasts use the blue channel (not amber)", () => {
    expect(css).toMatch(/\.toast\.toast-info \.toast-icon \{ color: var\(--blue\)/);
  });

  it("error toasts assert (role=alert); success/info stay polite (role=status) (B1-10)", () => {
    useAppStore.getState().pushToast({ kind: "error", title: "Failed to equip" });
    useAppStore.getState().pushToast({ kind: "success", title: "Equipped" });
    render(<ToastContainer />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to equip");
    expect(screen.getByRole("status")).toHaveTextContent("Equipped");
  });

  it("a 7s undoable toast survives 5s and dismisses after its duration (B3-13)", () => {
    vi.useFakeTimers();
    useAppStore.getState().pushToast({ kind: "success", title: "Equipped android", duration: 7000 });
    render(<ToastContainer />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Still present well past the 3.2s success default — the undo path lives on.
    expect(screen.getByText("Equipped android")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.queryByText("Equipped android")).not.toBeInTheDocument();
  });

  it("the undo window is bounded by the toast: once it auto-dismisses, the Undo button is gone (B2-07)", () => {
    vi.useFakeTimers();
    // The documented contract: there is NO undo store — the undo window is
    // exactly the toast's visible duration. This pins the conjunction the other
    // suites miss: after the undoable success toast expires, the Undo affordance
    // is no longer offered (a sticky/persisted undo would fail here).
    useAppStore.getState().pushToast({
      kind: "success",
      title: "Equipped android",
      duration: UNDO_TOAST_DURATION_MS,
      action: { label: "Undo", onClick: () => {} },
    });
    render(<ToastContainer />);
    // The window is open while the toast is up.
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();

    // Advance just past the undo-toast lifetime (no hover → the timer runs).
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_DURATION_MS + 100);
    });
    // Toast gone → so is the undo affordance. The window has closed.
    expect(screen.queryByText("Equipped android")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("hovering a toast pauses auto-dismiss; leaving resumes it (B3-13)", () => {
    vi.useFakeTimers();
    useAppStore.getState().pushToast({ kind: "success", title: "Equipped android", duration: 7000 });
    render(<ToastContainer />);
    const toast = screen.getByRole("status");
    // Hover before the timer elapses.
    act(() => {
      vi.advanceTimersByTime(1000);
      fireEvent.mouseEnter(toast);
    });
    // Advance far past the full duration while hovered — still present.
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(screen.getByText("Equipped android")).toBeInTheDocument();
    // Leaving resumes the countdown from the ~6s that remained.
    act(() => {
      fireEvent.mouseLeave(toast);
    });
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(screen.queryByText("Equipped android")).not.toBeInTheDocument();
  });

  it("renders a close button and an action slot that fire", async () => {
    const action = vi.fn();
    render(<ToastContainer />);
    act(() => {
      useAppStore.getState().pushToast({ kind: "success", title: "Done", action: { label: "Undo", onClick: action } });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(action).toHaveBeenCalled();
    // Undo also dismissed the toast
    expect(screen.queryByText("Done")).not.toBeInTheDocument();

    act(() => {
      useAppStore.getState().pushToast({ kind: "info", title: "Note" });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Note")).not.toBeInTheDocument();
  });

  it("honors an explicit duration", () => {
    vi.useFakeTimers();
    useAppStore.getState().pushToast({ kind: "success", title: "quick", duration: 1000 });
    render(<ToastContainer />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText("quick")).not.toBeInTheDocument();
  });
});

// ─── Appearance store single source of truth ─────────────────────────────────
describe("Appearance settings", () => {
  it("toggling Show icon rail in Settings updates the shared store live", async () => {
    const { renderWithProviders, makeQueryClient, primeRegistry } = await import("./helpers");
    function RailProbe() {
      const [t] = useTweaks();
      return <div data-testid="probe" data-rail={t.showRail ? "true" : "false"} />;
    }
    const client = makeQueryClient();
    primeRegistry(client);
    useAppStore.setState({ settingsOpen: true, settingsCategory: "appearance" });
    renderWithProviders(
      <>
        <RailProbe />
        <SettingsDialog />
      </>,
      { client },
    );
    expect(screen.getByTestId("probe")).toHaveAttribute("data-rail", "true");
    await userEvent.click(screen.getByRole("checkbox", { name: "Show icon rail" }));
    expect(screen.getByTestId("probe")).toHaveAttribute("data-rail", "false");
  });

  it("Rail labels is Settings' secondary affordance for the rail chevron", async () => {
    const { renderWithProviders, makeQueryClient, primeRegistry } = await import("./helpers");
    function LabelsProbe() {
      const [t] = useTweaks();
      return (
        <div data-testid="probe" data-expanded={t.railExpanded ? "true" : "false"} />
      );
    }
    const client = makeQueryClient();
    primeRegistry(client);
    useAppStore.setState({ settingsOpen: true, settingsCategory: "appearance" });
    renderWithProviders(
      <>
        <LabelsProbe />
        <SettingsDialog />
      </>,
      { client },
    );
    expect(screen.getByTestId("probe")).toHaveAttribute("data-expanded", "false");
    await userEvent.click(screen.getByRole("checkbox", { name: "Rail labels" }));
    expect(screen.getByTestId("probe")).toHaveAttribute("data-expanded", "true");
  });
});

// ─── Command palette destinations ─────────────────────────────────────────────
describe("Command palette destinations", () => {
  it("lists Permissions / Sources / Remotes and navigates on Enter", async () => {
    const { CommandPalette } = await import("@/components/CommandPalette");
    const { useLocation } = await import("react-router-dom");
    const { renderWithProviders, makeQueryClient, primeRegistry } = await import("./helpers");

    function LocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc">{loc.pathname}</div>;
    }
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <LocationProbe />
        <CommandPalette />
      </>,
      { client },
    );
    act(() => useAppStore.getState().openPalette());

    const input = await screen.findByPlaceholderText(/Jump to skill/);
    await userEvent.type(input, "perm");
    expect(screen.getByText("Open permissions")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("loc")).toHaveTextContent("/permissions");
  });
});
