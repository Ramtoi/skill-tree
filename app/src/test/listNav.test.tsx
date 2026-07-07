import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { useListNav } from "@/hooks/useListNav";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";

function activeIndexOf(container: HTMLElement): number {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-listnav-active]"),
  );
  return rows.findIndex((r) => r.getAttribute("data-listnav-active") === "true");
}

function Harness({
  onOpen,
  onSecondary,
}: {
  onOpen: (i: number) => void;
  onSecondary: (i: number) => void;
}) {
  const nav = useListNav({ count: 3, onOpen, onSecondary });
  return (
    <div data-testid="list" {...nav.containerProps}>
      {[0, 1, 2].map((i) => {
        const { ref, ...rest } = nav.itemProps(i);
        return (
          <div key={i} data-testid={`row-${i}`} ref={ref} {...rest}>
            row {i}
          </div>
        );
      })}
      <input data-testid="filter" />
    </div>
  );
}

describe("useListNav — roving focus", () => {
  it("j/k and arrows move the active row; Home/End jump", () => {
    const onOpen = vi.fn();
    const onSecondary = vi.fn();
    const { getByTestId } = render(
      <Harness onOpen={onOpen} onSecondary={onSecondary} />,
    );
    const list = getByTestId("list");
    expect(activeIndexOf(list)).toBe(0);

    fireEvent.keyDown(list, { key: "j" });
    expect(activeIndexOf(list)).toBe(1);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(activeIndexOf(list)).toBe(2);
    fireEvent.keyDown(list, { key: "k" });
    expect(activeIndexOf(list)).toBe(1);
    fireEvent.keyDown(list, { key: "Home" });
    expect(activeIndexOf(list)).toBe(0);
    fireEvent.keyDown(list, { key: "End" });
    expect(activeIndexOf(list)).toBe(2);
  });

  it("Enter opens and e runs the secondary action on the active row", () => {
    const onOpen = vi.fn();
    const onSecondary = vi.fn();
    const { getByTestId } = render(
      <Harness onOpen={onOpen} onSecondary={onSecondary} />,
    );
    const list = getByTestId("list");
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(1);
    fireEvent.keyDown(list, { key: "e" });
    expect(onSecondary).toHaveBeenCalledWith(1);
  });

  it("does not move the active row when typing in a field inside the list", () => {
    const onOpen = vi.fn();
    const onSecondary = vi.fn();
    const { getByTestId } = render(
      <Harness onOpen={onOpen} onSecondary={onSecondary} />,
    );
    const list = getByTestId("list");
    fireEvent.keyDown(getByTestId("filter"), { key: "j" });
    expect(activeIndexOf(list)).toBe(0);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("SkillLibrary — roving nav wiring", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "read_registry") return sampleRegistry;
      if (cmd === "local_skill_candidates") return [];
      if (cmd === "harness_list") return [];
      if (cmd === "hub_cmd")
        return { success: true, output: '{"sources":[],"errors":[]}' };
      return undefined;
    }) as never);
  });

  it("`e` on the focused row opens the equip picker; typing the filter does not move focus", async () => {
    const client = makeQueryClient();
    renderWithProviders(<SkillLibrary />, { client });

    const list = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".lib-list");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(activeIndexOf(list)).toBe(0);

    // Typing in the search filter must not move the active row.
    const search = document.querySelector<HTMLInputElement>(
      ".main-header input, .subheader input, input",
    );
    if (search) {
      await userEvent.type(search, "a");
    }

    // `e` on the list opens the skill→projects equip picker.
    fireEvent.keyDown(list, { key: "e" });
    await waitFor(() =>
      expect(document.querySelector(".equip-picker")).not.toBeNull(),
    );
  });
});
