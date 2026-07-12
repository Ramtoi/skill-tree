import { describe, it, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { useDisableNativeTextAssist } from "@/lib/nativeTextAssist";

// A minimal host that mounts the hook, plus a toggle to add a field after mount
// (exercises the MutationObserver path for dynamically rendered inputs).
function Host() {
  useDisableNativeTextAssist();
  const [extra, setExtra] = useState(false);
  return (
    <div>
      <input data-testid="text" type="text" defaultValue="my-skill" />
      <input data-testid="search" type="search" />
      <textarea data-testid="area" defaultValue="body" />
      <input data-testid="checkbox" type="checkbox" />
      <input data-testid="optin" type="text" data-native-assist="true" />
      <button onClick={() => setExtra(true)}>add</button>
      {extra && <input data-testid="late" type="text" />}
    </div>
  );
}

function assertDisabled(el: HTMLElement) {
  expect(el.getAttribute("autocorrect")).toBe("off");
  expect(el.getAttribute("autocapitalize")).toBe("off");
  expect(el.getAttribute("spellcheck")).toBe("false");
}

describe("useDisableNativeTextAssist", () => {
  it("disables autocorrect/autocapitalize/spellcheck on text inputs and textareas", () => {
    render(<Host />);
    assertDisabled(screen.getByTestId("text"));
    assertDisabled(screen.getByTestId("search"));
    assertDisabled(screen.getByTestId("area"));
  });

  it("leaves non-text inputs (checkbox) untouched", () => {
    render(<Host />);
    const cb = screen.getByTestId("checkbox");
    expect(cb.getAttribute("autocorrect")).toBeNull();
    expect(cb.getAttribute("autocapitalize")).toBeNull();
  });

  it("honors the data-native-assist opt-out", () => {
    render(<Host />);
    const optin = screen.getByTestId("optin");
    expect(optin.getAttribute("autocorrect")).toBeNull();
    expect(optin.getAttribute("spellcheck")).toBeNull();
  });

  it("disables assist on inputs added after mount (observer path)", async () => {
    render(<Host />);
    expect(screen.queryByTestId("late")).toBeNull();
    act(() => {
      screen.getByText("add").click();
    });
    await waitFor(() => {
      const late = screen.getByTestId("late");
      assertDisabled(late);
    });
  });
});
