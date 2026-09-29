import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageTrail } from "@/components/UsageTrail";

describe("UsageTrail", () => {
  it("renders one rect per day, including zero baseline ticks", () => {
    const values = Array.from({ length: 30 }, (_, index) => (index === 10 ? 4 : 0));
    render(<UsageTrail values={values} ariaLabel="skill usage" />);
    expect(screen.getByRole("img", { name: "skill usage" }).querySelectorAll("rect")).toHaveLength(30);
  });

  it("uses the row maximum for scale and CSS colors", () => {
    render(<UsageTrail values={[0, 2, 4]} ariaLabel="usage" height={20} />);
    const rects = screen.getByRole("img").querySelectorAll("rect");
    expect(rects[1].getAttribute("height")).toBe("10");
    expect(rects[0].getAttribute("fill")).toBe("var(--border)");
    expect(rects[2].getAttribute("fill")).toContain("var(--ctx)");
  });
});
