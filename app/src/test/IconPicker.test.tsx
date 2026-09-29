import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  IconPicker,
  DEFAULT_ICON_CHOICES,
  isValidIcon,
} from "@/components/IconPicker";

describe("IconPicker", () => {
  it("renders one tile per choice plus the any-emoji slot", () => {
    render(<IconPicker value="📦" onChange={() => {}} />);
    for (const opt of DEFAULT_ICON_CHOICES) {
      expect(
        screen.getByRole("button", { name: `Use ${opt}` }),
      ).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Custom icon")).toBeInTheDocument();
    // One uniform, adaptive grid — no detached preview tile beside it.
    expect(document.querySelectorAll(".icon-picker-grid")).toHaveLength(1);
    expect(document.querySelectorAll(".icon-picker-option")).toHaveLength(
      DEFAULT_ICON_CHOICES.length,
    );
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

  it("emits the chosen emoji when a tile is clicked", async () => {
    const onChange = vi.fn();
    render(<IconPicker value="📦" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Use ⚡" }));
    expect(onChange).toHaveBeenCalledWith("⚡");
  });

  it("accepts any emoji typed into the custom slot", () => {
    const onChange = vi.fn();
    render(<IconPicker value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Custom icon"), {
      target: { value: "🚀" },
    });
    expect(onChange).toHaveBeenCalledWith("🚀");
  });

  it("treats a multi-codepoint emoji as one grapheme", () => {
    const onChange = vi.fn();
    render(<IconPicker value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Custom icon"), {
      target: { value: "👨‍👩‍👧" },
    });
    expect(onChange).toHaveBeenCalledWith("👨‍👩‍👧");
  });

  it("rejects plain text and two-emoji input, and says so", () => {
    const onChange = vi.fn();
    render(<IconPicker value="📦" onChange={onChange} />);
    const input = screen.getByLabelText("Custom icon");

    fireEvent.change(input, { target: { value: "hello" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("One emoji, please")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "🚀🔥" } });
    expect(onChange).not.toHaveBeenCalled();

    // Clearing the slot clears the complaint.
    fireEvent.change(input, { target: { value: "" } });
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("gives a custom selection its own selected tile in the grid", () => {
    render(<IconPicker value="🦊" onChange={() => {}} />);
    const tiles = document.querySelectorAll(".icon-picker-option");
    expect(tiles).toHaveLength(DEFAULT_ICON_CHOICES.length + 1);
    const custom = screen.getByRole("button", { name: "Use 🦊" });
    expect(custom).toHaveAttribute("aria-pressed", "true");
    expect(custom).toHaveAttribute("data-custom", "true");
  });

  it("validates icons the same way the tiles do", () => {
    expect(isValidIcon("📦")).toBe(true);
    expect(isValidIcon("🛠️")).toBe(true);
    expect(isValidIcon(" 🦊 ")).toBe(true);
    expect(isValidIcon("")).toBe(false);
    expect(isValidIcon("x")).toBe(false);
    expect(isValidIcon("ab")).toBe(false);
    expect(isValidIcon("bundle")).toBe(false);
    expect(isValidIcon("📦📦")).toBe(false);
  });

  it("accepts the emoji that carry no pictographic codepoint", () => {
    // A flag is two regional indicators; a keycap is digit + VS16 + U+20E3.
    // Both are one grapheme, and both are perfectly good bundle icons.
    expect(isValidIcon("🇩🇪")).toBe(true);
    expect(isValidIcon("1️⃣")).toBe(true);
    // ZWJ sequences and skin-tone modifiers keep working.
    expect(isValidIcon("👨‍👩‍👧")).toBe(true);
    expect(isValidIcon("👍🏽")).toBe(true);
    // Two flags is still two graphemes.
    expect(isValidIcon("🇩🇪🇫🇷")).toBe(false);
  });

  it("lets a flag through the custom slot", () => {
    const onChange = vi.fn();
    render(<IconPicker value="📦" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Custom icon"), {
      target: { value: "🇩🇪" },
    });
    expect(onChange).toHaveBeenCalledWith("🇩🇪");
  });
});
