import { describe, expect, it, vi } from "vitest";
import { screen, render, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu";

describe("OverflowMenu switch", () => {
  it("keeps the menu open and activates once from native Space and Enter", async () => {
    const onChange = vi.fn();
    render(<OverflowMenu items={[{ label: "Global", switch: { checked: false, onChange } }]} />);
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Global" });
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("roves around a disabled switch, guards busy changes, and escapes", async () => {
    const onChange = vi.fn();
    render(<OverflowMenu items={[{ label: "Locked", disabled: true, switch: { checked: false, onChange } }, { label: "Global", switch: { checked: false, busy: true, onChange } }, { label: "Action", onClick: onChange }]} />);
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    const action = screen.getByRole("menuitem", { name: "Action" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "Global" })));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(action);
    const busy = screen.getByRole("menuitemcheckbox", { name: "Global" });
    fireEvent.click(busy);
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("OverflowMenu scroll guard", () => {
  // Finding B: a scroll ANYWHERE used to close the menu unconditionally
  // (scroll anchoring moves an ancestor's scrollTop without moving the
  // trigger, which is exactly what a busy sequential Playwright run
  // produces). Must FAIL before the trigger-rect guard is added.
  it("a scroll with an unchanged trigger rect keeps the menu open", async () => {
    render(<OverflowMenu items={[{ label: "Action", onClick: vi.fn() }]} />);
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.scroll(document);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a scroll that moves the trigger rect closes the menu", async () => {
    render(<OverflowMenu items={[{ label: "Action", onClick: vi.fn() }]} />);
    const trigger = screen.getByTestId("overflow-trigger");
    await userEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // The guard reads the wrapping `.overflow-menu` div's rect (`wrapRef`),
    // not the trigger button's own rect.
    const wrap = trigger.closest(".overflow-menu") as HTMLElement;
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue({
      ...wrap.getBoundingClientRect(),
      top: 50,
      left: 50,
    } as DOMRect);
    fireEvent.scroll(document);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a scroll targeted inside the panel does not close the menu", async () => {
    render(<OverflowMenu items={[{ label: "Action", onClick: vi.fn() }]} />);
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    const panel = screen.getByRole("menu");

    fireEvent.scroll(panel);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a resize still closes the menu even with an unchanged trigger rect", async () => {
    render(<OverflowMenu items={[{ label: "Action", onClick: vi.fn() }]} />);
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent(window, new Event("resize"));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("rerendering with a new items array (same labels) keeps item DOM identity and enabled state", async () => {
    const onClick = vi.fn();
    const items = (): OverflowMenuItem[] => [
      { label: "First", onClick },
      { label: "Second", onClick },
    ];
    const { rerender } = render(<OverflowMenu items={items()} />);
    await userEvent.click(screen.getByTestId("overflow-trigger"));
    const first = screen.getByRole("menuitem", { name: "First" });
    const second = screen.getByRole("menuitem", { name: "Second" });

    rerender(<OverflowMenu items={items()} />);

    expect(screen.getByRole("menuitem", { name: "First" })).toBe(first);
    expect(screen.getByRole("menuitem", { name: "Second" })).toBe(second);
    expect(first).toBeEnabled();
    expect(second).toBeEnabled();
  });
});
