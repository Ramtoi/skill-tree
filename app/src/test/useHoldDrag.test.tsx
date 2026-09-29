import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHoldDrag } from "@/hooks/useHoldDrag";

function mount() {
  const callbacks = { onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn() };
  const open = vi.fn();
  function Row() {
    const drag = useHoldDrag(callbacks);
    return <div onClickCapture={drag.onClickCapture}>
      <div data-testid="row" onPointerDown={(e) => drag.onPointerDown(e, "skill")}>
        <div className="resource-row" role="button" tabIndex={0} onClick={open} onKeyDown={() => {}}>Skill<button>Equip</button><input aria-label="Name" /><div className="resource-detail">Details</div></div>
      </div>
    </div>;
  }
  const view = render(<Row />);
  return { ...callbacks, open, ...view, row: screen.getByTestId("row") };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", class extends MouseEvent { pointerId = 1; isPrimary = true; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const point = { pointerId: 1, button: 0, clientX: 20, clientY: 20 };
describe("hold-to-drag", () => {
  it("preserves short clicks and cancels early movement for text selection", () => {
    const row = mount();
    fireEvent.pointerDown(row.row, point);
    fireEvent.pointerUp(document, point);
    act(() => vi.advanceTimersByTime(300));
    fireEvent.click(screen.getByRole("button", { name: "Skill Equip Details" }), { detail: 1 });
    expect(row.open).toHaveBeenCalledOnce();
    fireEvent.pointerDown(row.row, point);
    fireEvent.pointerMove(document, { ...point, clientX: 40 });
    act(() => vi.advanceTimersByTime(300));
    expect(row.onStart).not.toHaveBeenCalled();
    expect(row.onEnd).not.toHaveBeenCalled();
  });

  it("picks up after a hold, commits once and suppresses the release click", () => {
    const row = mount();
    fireEvent.pointerDown(row.row, point);
    act(() => vi.advanceTimersByTime(250));
    expect(row.onStart).toHaveBeenCalledWith("skill");
    fireEvent.pointerMove(document, { ...point, clientY: 90 });
    fireEvent.pointerUp(document, { ...point, clientY: 90 });
    fireEvent.click(screen.getByText("Skill"), { detail: 1 });
    expect(row.onEnd).toHaveBeenCalledExactlyOnceWith("skill", { x: 20, y: 90 });
    expect(row.open).not.toHaveBeenCalled();
  });

  it.each(["Escape", "pointercancel", "blur"])("cancels on %s without committing", (reason) => {
    const row = mount();
    fireEvent.pointerDown(row.row, point);
    act(() => vi.advanceTimersByTime(250));
    fireEvent.pointerMove(document, { ...point, clientY: 90 });
    if (reason === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (reason === "blur") fireEvent.blur(window);
    else fireEvent.pointerCancel(document, point);
    fireEvent.pointerUp(document, point);
    expect(row.onEnd).toHaveBeenCalledExactlyOnceWith("skill", null);
  });

  it("ignores buttons, fields, details and secondary clicks", () => {
    const row = mount();
    for (const target of [screen.getByText("Equip"), screen.getByLabelText("Name"), screen.getByText("Details")]) {
      fireEvent.pointerDown(target, point);
      act(() => vi.advanceTimersByTime(300));
      fireEvent.pointerUp(document, point);
    }
    fireEvent.pointerDown(row.row, { ...point, button: 2 });
    act(() => vi.advanceTimersByTime(300));
    expect(row.onStart).not.toHaveBeenCalled();
  });

  it("cancels a hold on unmount and does not commit a stationary pickup", () => {
    const row = mount();
    fireEvent.pointerDown(row.row, point);
    act(() => vi.advanceTimersByTime(250));
    fireEvent.pointerUp(document, point);
    expect(row.onEnd).toHaveBeenCalledWith("skill", null);
    fireEvent.pointerDown(row.row, point);
    row.unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(row.onStart).toHaveBeenCalledOnce();
  });
});
