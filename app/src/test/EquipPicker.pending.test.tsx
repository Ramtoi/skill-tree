import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EquipPicker, type EquipTarget } from "@/components/EquipPicker";
import { renderWithProviders, makeDeferred } from "./helpers";

const targets: EquipTarget[] = [
  { id: "proj-a", name: "proj-a", state: "off" },
  { id: "proj-b", name: "proj-b", state: "off" },
];

function boxFor(subject: string, target: string) {
  return screen.getByRole("checkbox", { name: `Equip ${subject} ${target}` });
}

describe("EquipPicker pending state", () => {
  it("disables only the toggled row while its mutation is in flight; siblings stay live", async () => {
    const gate = makeDeferred<void>();
    const user = userEvent.setup();
    renderWithProviders(
      <EquipPicker
        subject={{ kind: "skill", name: "mysk" }}
        targets={targets}
        variant="inline"
        onToggle={() => gate.promise}
      />,
    );

    const a = boxFor("mysk", "proj-a");
    const b = boxFor("mysk", "proj-b");
    expect(a).not.toBeDisabled();

    await user.click(a);

    // The clicked row's toggle is disabled + its option marked pending…
    expect(a).toBeDisabled();
    const optA = document.getElementById("equip-opt-proj-a");
    expect(optA?.getAttribute("data-pending")).toBe("true");
    // …while the sibling stays interactive.
    expect(b).not.toBeDisabled();

    // Resolving the mutation clears the pending state.
    gate.resolve();
    await waitFor(() => expect(a).not.toBeDisabled());
    expect(
      document.getElementById("equip-opt-proj-a")?.getAttribute("data-pending"),
    ).toBeNull();
  });

  it("reverts the optimistic toggle when the mutation rejects", async () => {
    const gate = makeDeferred<void>();
    const user = userEvent.setup();
    renderWithProviders(
      <EquipPicker
        subject={{ kind: "skill", name: "mysk" }}
        targets={targets}
        variant="inline"
        onToggle={() => gate.promise}
      />,
    );

    const a = boxFor("mysk", "proj-a");
    expect(a).not.toBeChecked();
    await user.click(a);
    // Optimistically flipped ON while pending.
    expect(a).toBeChecked();
    expect(a).toBeDisabled();

    gate.reject(new Error("nope"));

    // Reverts to OFF and re-enables once the rejection settles.
    await waitFor(() => expect(boxFor("mysk", "proj-a")).not.toBeChecked());
    expect(boxFor("mysk", "proj-a")).not.toBeDisabled();
  });

  it("keeps a via-bundle row read-only (no toggle) regardless of pending", () => {
    renderWithProviders(
      <EquipPicker
        subject={{ kind: "skill", name: "mysk" }}
        targets={[
          {
            id: "proj-c",
            name: "proj-c",
            state: "via-bundle",
            providedBy: [{ name: "android", href: "/bundle/android" }],
          },
        ]}
        variant="inline"
        onToggle={() => makeDeferred<void>().promise}
      />,
    );
    const opt = document.getElementById("equip-opt-proj-c");
    expect(opt).not.toBeNull();
    expect(within(opt as HTMLElement).queryByRole("checkbox")).toBeNull();
  });
});
