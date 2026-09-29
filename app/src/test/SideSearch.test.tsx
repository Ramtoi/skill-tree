import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SideGroup } from "@/components/nav/SidePrimitives";

function SearchGroup({ label, initiallyCollapsed = false, initialQuery = "" }: { label: string; initiallyCollapsed?: boolean; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  return <SideGroup title={label} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}
    search={{ label, value: query, onChange: setQuery }}>
    <span>{query ? "Matching rows" : "All rows"}</span>
  </SideGroup>;
}

describe("navigator search disclosure", () => {
  it.each(["bundles", "snippets", "skills", "hooks", "sources", "remotes", "cloud apps"])(
    "%s opens from a collapsed header, clears, and returns focus on Escape", (label) => {
      render(<SearchGroup label={label} initiallyCollapsed />);
      const toggle = screen.getByRole("button", { name: `Search ${label}` });
      expect(screen.queryByRole("textbox")).toBeNull();
      fireEvent.click(toggle);
      const input = screen.getByRole("textbox", { name: `Search ${label}` });
      expect(input).toHaveFocus();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.change(input, { target: { value: "rules" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).toHaveValue("");
      expect(input).toHaveFocus();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(toggle).toHaveFocus();
      expect(screen.getByText("All rows")).toBeVisible();
    },
  );

  it.each(["clear button", "Escape"])("keeps a retained search open after %s", (action) => {
    render(<SearchGroup label="snippets" initialQuery="rules" />);
    const input = screen.getByRole("textbox");
    input.focus();
    if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("preserves search on collapse and keeps focus in the field after clearing", () => {
    render(<SearchGroup label="snippets" />);
    fireEvent.click(screen.getByRole("button", { name: "Search snippets" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "rules" } });
    fireEvent.click(screen.getByRole("button", { name: "snippets" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search snippets" }));
    expect(screen.getByRole("textbox")).toHaveValue("rules");
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveFocus();
  });
});
