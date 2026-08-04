import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IconPicker, DEFAULT_ICON_CHOICES } from "@/components/IconPicker";

describe("IconPicker", () => {
  it("renders a quick-pick button per choice plus a custom input", () => {
    render(<IconPicker value="📦" onChange={() => {}} />);
    for (const opt of DEFAULT_ICON_CHOICES) {
      expect(
        screen.getByRole("button", { name: `Use ${opt}` }),
      ).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Custom icon")).toBeInTheDocument();
  });

  it("marks the active choice via aria-pressed", () => {
    render(<IconPicker value="🤖" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Use 🤖" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Use 📦" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("emits the chosen emoji when a quick-pick is clicked", async () => {
    const onChange = vi.fn();
    render(<IconPicker value="📦" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Use ⚡" }));
    expect(onChange).toHaveBeenCalledWith("⚡");
  });

  it("emits custom free-text input", () => {
    const onChange = vi.fn();
    render(<IconPicker value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Custom icon"), {
      target: { value: "🚀" },
    });
    expect(onChange).toHaveBeenCalledWith("🚀");
  });
});
