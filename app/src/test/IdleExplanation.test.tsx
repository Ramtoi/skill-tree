import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IdleExplanation } from "@/screens/project/IdleExplanation";
import type { UsageFinding, UsageUtilizationRow } from "@/features/usage/usageAnalyticsTypes";

const finding = (moves: UsageFinding["moves"]): UsageFinding => ({
  id: "idle-demo", kind: "idle", project: "demo", observation: "This skill is quiet.",
  numbers: { sessions: 6 }, moves, review: { area: "loadout", project: "demo", highlight: [] },
});
const row: UsageUtilizationRow = { key: "demo", count: 0, you: 0, model: 0, script: 0, last_used_at: null, trail: [], footprint_bytes: 0, harnesses: [], sessions_with_skill: 6, idle: true };

describe("IdleExplanation", () => {
  it("uses payload move labels and focuses the card control without writing", () => {
    render(<MemoryRouter><div className="skill-card"><button data-testid="skill-card-unequip" /><IdleExplanation finding={finding([{ label: "Unequip", kind: "unequip", targets: [] }])} row={row} skillKey="demo" projectName="demo" tokens={null} canUnequip canOverrideInvocation={false} /></div></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Explain idle skill" }));
    expect(screen.getByRole("button", { name: "Unequip" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }));
    expect(document.activeElement).toHaveAttribute("data-testid", "skill-card-unequip");
  });

  it("keeps a click inside the panel from reaching the card's own click handler", () => {
    const onCard = vi.fn();
    render(
      <MemoryRouter>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the card stands in for SkillCard's role="button" root */}
        <div className="skill-card" onClick={onCard}>
          <button data-testid="skill-card-unequip" />
          <IdleExplanation finding={finding([{ label: "Unequip", kind: "unequip", targets: [] }])} row={row} skillKey="demo" projectName="demo" tokens={null} canUnequip canOverrideInvocation={false} />
        </div>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Explain idle skill" }));
    fireEvent.click(screen.getByText(/This skill is quiet/));
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }));
    expect(onCard).not.toHaveBeenCalled();
    expect(document.activeElement).toHaveAttribute("data-testid", "skill-card-unequip");
  });

  it("does not render unknown moves and includes the blind spot", () => {
    render(<MemoryRouter><IdleExplanation finding={finding([{ label: "Do not use", kind: "unknown", targets: [] }])} row={row} skillKey="demo" projectName="demo" tokens={null} canUnequip={false} canOverrideInvocation={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Explain idle skill" }));
    expect(screen.queryByRole("button", { name: "Do not use" })).toBeNull();
    expect(screen.getByText(/counts invocations, not influence/)).toBeInTheDocument();
  });
});
