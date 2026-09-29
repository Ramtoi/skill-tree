import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackButton } from "../components/BackButton";

describe("BackButton", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("shows the destination after hover, stays over the tooltip, and dismisses with Escape", () => {
    vi.useFakeTimers();
    render(<BackButton title="Back to Library" />);
    const button = screen.getByRole("button", { name: "Back to Library" });
    fireEvent.mouseEnter(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => { vi.advanceTimersByTime(350); });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Back to Library");
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(tooltip);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on keyboard focus and closes on blur or navigation", () => {
    render(<BackButton title="Back to Hooks" />);
    const button = screen.getByRole("button", { name: "Back to Hooks" });
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Back to Hooks");
    fireEvent.blur(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(button);
    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("names an icon-only return by its destination and invokes the existing handler", () => {
    const onBack = vi.fn();
    render(<BackButton title="Back to Library" onClick={onBack} />);
    const button = screen.getByRole("button", { name: "Back to Library" });
    expect(button).not.toHaveAttribute("title");
    fireEvent.click(button);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps a wizard's visible label and blocks return while disabled", () => {
    const onBack = vi.fn();
    const { rerender } = render(<BackButton disabled onClick={onBack}>Back</BackButton>);
    const button = screen.getByRole("button", { name: "Back" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onBack).not.toHaveBeenCalled();
    rerender(<BackButton onClick={onBack}>Back</BackButton>);
    fireEvent.click(button);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
