import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Disclosure } from "@/components/Disclosure";

describe("Disclosure", () => {
  it("uses native details semantics and unfolds locally", () => {
    render(<Disclosure summary="Why"><span>Evidence</span></Disclosure>);
    const details = screen.getByText("Why").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Evidence")).not.toBeVisible();
    fireEvent.click(screen.getByText("Why"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Evidence")).toBeVisible();
  });
});
