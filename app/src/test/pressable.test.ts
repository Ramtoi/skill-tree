import { describe, it, expect, vi } from "vitest";
import { pressable, clickSink, stopEvent } from "@/lib/pressable";

function keyEvent(key: string) {
  return {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as import("react").KeyboardEvent;
}

function clickEvent() {
  return { stopPropagation: vi.fn() } as unknown as import("react").MouseEvent;
}

describe("pressable()", () => {
  it("returns {} when onPress is undefined", () => {
    expect(pressable(undefined)).toEqual({});
  });

  it("wires role=button and tabIndex=0 by default", () => {
    const props = pressable(() => {}) as { role: string; tabIndex: number };
    expect(props.role).toBe("button");
    expect(props.tabIndex).toBe(0);
  });

  it("Enter calls onPress and preventDefault", () => {
    const onPress = vi.fn();
    const props = pressable(onPress) as { onKeyDown: (e: unknown) => void };
    const e = keyEvent("Enter");
    props.onKeyDown(e);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect((e as { preventDefault: () => void }).preventDefault).toHaveBeenCalled();
  });

  it('Space (" ") calls onPress and preventDefault', () => {
    const onPress = vi.fn();
    const props = pressable(onPress) as { onKeyDown: (e: unknown) => void };
    const e = keyEvent(" ");
    props.onKeyDown(e);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect((e as { preventDefault: () => void }).preventDefault).toHaveBeenCalled();
  });

  it("a non-activation key does not call onPress", () => {
    const onPress = vi.fn();
    const props = pressable(onPress) as { onKeyDown: (e: unknown) => void };
    props.onKeyDown(keyEvent("Escape"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("click calls onPress", () => {
    const onPress = vi.fn();
    const props = pressable(onPress) as { onClick: (e: unknown) => void };
    props.onClick(clickEvent());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("isolate: true also calls stopPropagation on click and keydown", () => {
    const onPress = vi.fn();
    const props = pressable(onPress, { isolate: true }) as {
      onClick: (e: unknown) => void;
      onKeyDown: (e: unknown) => void;
    };
    const clickE = clickEvent();
    props.onClick(clickE);
    expect((clickE as { stopPropagation: () => void }).stopPropagation).toHaveBeenCalled();

    const keyE = keyEvent("Enter");
    props.onKeyDown(keyE);
    expect((keyE as { stopPropagation: () => void }).stopPropagation).toHaveBeenCalled();
  });

  it("without isolate, stopPropagation is not called", () => {
    const onPress = vi.fn();
    const props = pressable(onPress) as {
      onClick: (e: unknown) => void;
    };
    const clickE = clickEvent();
    props.onClick(clickE);
    expect((clickE as { stopPropagation: () => void }).stopPropagation).not.toHaveBeenCalled();
  });

  it("disabled: true yields tabIndex -1 and no call", () => {
    const onPress = vi.fn();
    const props = pressable(onPress, { disabled: true }) as {
      tabIndex: number;
      onClick: (e: unknown) => void;
      onKeyDown: (e: unknown) => void;
    };
    expect(props.tabIndex).toBe(-1);
    props.onClick(clickEvent());
    props.onKeyDown(keyEvent("Enter"));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("clickSink()", () => {
  it("returns a presentation role + the stopEvent handler", () => {
    const sink = clickSink();
    expect(sink.role).toBe("presentation");
    expect(sink.onClick).toBe(stopEvent);
  });
});

describe("stopEvent()", () => {
  it("calls stopPropagation", () => {
    const e = { stopPropagation: vi.fn() };
    stopEvent(e);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
