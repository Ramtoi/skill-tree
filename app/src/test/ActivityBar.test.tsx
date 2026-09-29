import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityBar, ACTIVITY_COLOR_INDEX } from "@/screens/usage/ActivityBar";
import { identityColor } from "@/components/charts/chartColors";
import type { UsageActivityCounts } from "@/features/usage/usageAnalyticsTypes";

const ZERO: UsageActivityCounts = {
  read: 0,
  edit: 0,
  verify: 0,
  operate: 0,
  delegate: 0,
  skill: 0,
  external: 0,
};

function legendLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".comp-bar-legend-label")).map(
    (el) => el.textContent ?? "",
  );
}

function swatchColor(container: HTMLElement, label: string): string | undefined {
  const items = Array.from(container.querySelectorAll(".comp-bar-legend-item"));
  const item = items.find((el) => el.querySelector(".comp-bar-legend-label")?.textContent === label);
  return item?.querySelector<HTMLElement>(".comp-bar-swatch")?.style.background;
}

describe("ActivityBar", () => {
  it("the class→token mapping is index-fixed", () => {
    expect(ACTIVITY_COLOR_INDEX).toEqual({
      read: 0,
      edit: 1,
      verify: 2,
      operate: 3,
      delegate: 4,
      skill: 5,
      external: 6,
    });
  });

  it("a zero-count class is absent from the legend while every other class keeps its color", () => {
    const activity: UsageActivityCounts = {
      ...ZERO,
      read: 3,
      edit: 0,
      verify: 1,
      skill: 2,
    };
    const { container } = render(<ActivityBar activity={activity} ariaLabel="Activity mix" />);
    const labels = legendLabels(container);
    expect(labels).not.toContain("Edit");
    expect(labels).not.toContain("Operate");
    expect(labels).not.toContain("Delegate");
    expect(labels).not.toContain("External");
    expect(labels).toEqual(["Read", "Verify", "Skill"]);

    expect(swatchColor(container, "Read")).toBe(identityColor(ACTIVITY_COLOR_INDEX.read));
    expect(swatchColor(container, "Verify")).toBe(identityColor(ACTIVITY_COLOR_INDEX.verify));
    expect(swatchColor(container, "Skill")).toBe(identityColor(ACTIVITY_COLOR_INDEX.skill));
  });

  it("a class dropping to zero does not re-hue the classes that follow it", () => {
    // `verify` and `skill` keep the SAME color whether or not `edit` (index 1,
    // ranked before them) is present — the index is a property of the class,
    // never of its position in the rendered (filtered) list.
    const withEdit: UsageActivityCounts = { ...ZERO, edit: 5, verify: 1, skill: 2 };
    const withoutEdit: UsageActivityCounts = { ...ZERO, verify: 1, skill: 2 };

    const a = render(<ActivityBar activity={withEdit} ariaLabel="With edit" />);
    const verifyColorWithEdit = swatchColor(a.container, "Verify");
    const skillColorWithEdit = swatchColor(a.container, "Skill");
    a.unmount();

    const b = render(<ActivityBar activity={withoutEdit} ariaLabel="Without edit" />);
    const verifyColorWithoutEdit = swatchColor(b.container, "Verify");
    const skillColorWithoutEdit = swatchColor(b.container, "Skill");

    expect(verifyColorWithEdit).toBe(verifyColorWithoutEdit);
    expect(skillColorWithEdit).toBe(skillColorWithoutEdit);
  });

  it("renders the optional note", () => {
    const { getByText } = render(
      <ActivityBar activity={{ ...ZERO, read: 1 }} ariaLabel="Activity mix" note={<span>median 42%</span>} />,
    );
    expect(getByText("median 42%")).toBeTruthy();
  });
});
