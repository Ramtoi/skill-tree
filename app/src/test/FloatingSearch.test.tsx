import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { FloatingSearch, type FloatingSearchKindOption } from "@/components/FloatingSearch";
import type { SearchKind } from "@/lib/unifiedSearch";
import { focusScreenSearch } from "@/lib/focusScreenSearch";

const KIND_OPTIONS: FloatingSearchKindOption[] = [
  { value: "all", label: "ALL", icon: "library", count: 8 },
  { value: "skill", label: "SKILLS", icon: "skill", count: 0 },
  { value: "mcp", label: "MCP", icon: "mcp", count: 0 },
  { value: "bundle", label: "BUNDLES", icon: "bundle", count: 8 },
  { value: "snippet", label: "SNIPPETS", icon: "snippet", count: 0 },
];

interface HarnessProps {
  onCommit?: () => boolean;
  onKindChange?: (k: SearchKind | "all") => void;
  onMove?: (delta: 1 | -1) => void;
  onFocusCursor?: () => boolean;
  context?: {
    icon: string;
    label: string;
    onClear: () => void;
    testid: string;
  };
  initialKind?: SearchKind | "all";
  initialValue?: string;
}

function Harness({
  onCommit,
  onKindChange,
  onMove,
  onFocusCursor,
  context,
  initialKind = "all",
  initialValue = "",
}: HarnessProps) {
  const [value, setValue] = useState(initialValue);
  const [kind, setKind] = useState<SearchKind | "all">(initialKind);
  return (
    <FloatingSearch
      value={value}
      onChange={setValue}
      placeholder="Search…"
      kinds={KIND_OPTIONS}
      activeKind={kind}
      onKindChange={(k) => {
        setKind(k);
        onKindChange?.(k);
      }}
      onCommit={onCommit}
      onMove={onMove}
      onFocusCursor={onFocusCursor}
      context={context}
      screenSearch
    />
  );
}

function root() {
  return screen.getByTestId("floating-search");
}
function input() {
  return screen.getByTestId("floating-search-input");
}
function kindsRow() {
  return screen.getByTestId("floating-search-kinds");
}

describe("FloatingSearch", () => {
  it("1. at rest: idle, closed, no kinds row", () => {
    render(<Harness />);
    expect(root()).toHaveAttribute("data-state", "idle");
    expect(root()).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("floating-search-kinds")).toBeNull();
  });

  it("2. focusing opens the stack: kinds row with one chip per option, each with its count", () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(root()).toHaveAttribute("data-state", "focused");
    const chips = within(kindsRow()).getAllByRole("button");
    expect(chips).toHaveLength(KIND_OPTIONS.length);
    for (const opt of KIND_OPTIONS) {
      const chip = within(kindsRow()).getByRole("button", { name: new RegExp(`^${opt.label}`) });
      expect(within(chip).getByText(String(opt.count))).toBeInTheDocument();
    }
  });

  it("3. typing renders no listbox and no hit rows — every result lives in the host's own body (§11)", async () => {
    render(<Harness />);
    await userEvent.type(input(), "item");
    expect(root()).toHaveAttribute("data-state", "typing");
    expect(screen.queryByTestId("floating-search-hits")).toBeNull();
    expect(screen.queryByTestId("floating-search-hit")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("4. onCommit fires on Enter with a non-empty query; preventDefault only when it returns true", async () => {
    const onCommit = vi.fn(() => true);
    render(<Harness onCommit={onCommit} />);
    fireEvent.focus(input());
    const noQueryEvent = fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(noQueryEvent).toBe(true); // not prevented

    await userEvent.type(input(), "item");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("5. Enter does not preventDefault when onCommit declines (returns false)", async () => {
    const onCommit = vi.fn(() => false);
    render(<Harness onCommit={onCommit} />);
    await userEvent.type(input(), "item");
    const result = fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(result).toBe(true); // default NOT prevented — nothing was focused
  });

  it("6. Esc ladder: clear query -> reset kind -> blur", async () => {
    render(<Harness initialKind="bundle" />);
    fireEvent.focus(input());
    await userEvent.type(input(), "item");
    expect(root()).toHaveAttribute("data-state", "typing");

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveValue("");
    expect(input()).toHaveFocus();
    expect(root()).toHaveAttribute("data-state", "focused");
    expect(root()).toHaveAttribute("data-active-kind", "bundle");

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(root()).toHaveAttribute("data-active-kind", "all");
    expect(input()).toHaveFocus();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).not.toHaveFocus();
  });

  it("6b. Esc from a focused kind chip blurs the CHIP, not the (unfocused) input (M2)", () => {
    render(<Harness />);
    fireEvent.focus(input());
    const allChip = within(kindsRow()).getByRole("button", { name: /^ALL/ });
    allChip.focus();
    expect(allChip).toHaveFocus();

    fireEvent.keyDown(allChip, { key: "Escape" });
    expect(allChip).not.toHaveFocus();
    expect(input()).not.toHaveFocus();
    expect(root()).toHaveAttribute("data-state", "idle");
  });

  it("7. clicking a kind chip switches the filter; the active chip is aria-pressed", () => {
    const onKindChange = vi.fn();
    render(<Harness onKindChange={onKindChange} />);
    fireEvent.focus(input());
    fireEvent.click(within(kindsRow()).getByRole("button", { name: /^BUNDLES/ }));
    expect(onKindChange).toHaveBeenCalledWith("bundle");
    expect(within(kindsRow()).getByRole("button", { name: /^BUNDLES/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("8. screenSearch stamps data-screen-search and focusScreenSearch() lands on this input", () => {
    const { container } = render(<Harness />);
    expect(input().closest("[data-screen-search]")).not.toBeNull();
    expect(focusScreenSearch(container)).toBe(true);
    expect(input()).toHaveFocus();
  });

  it("9. the clear button appears only with a value, is labelled, and clears", async () => {
    render(<Harness />);
    expect(screen.queryByLabelText("Clear search")).toBeNull();
    await userEvent.type(input(), "item");
    const clear = screen.getByLabelText("Clear search");
    await userEvent.click(clear);
    expect(input()).toHaveValue("");
  });

  it("10. the kind pill shows whenever a kind is active — even idle — names the mode (m9), and clears it", () => {
    render(<Harness initialKind="bundle" />);
    expect(root()).toHaveAttribute("data-state", "idle");
    const pill = screen.getByTestId("floating-search-kind-pill");
    expect(pill).toHaveTextContent("BUNDLES");
    expect(pill).toHaveAttribute("aria-label", "Kind: bundles. Clear filter.");
    fireEvent.click(pill);
    expect(root()).toHaveAttribute("data-active-kind", "all");
    expect(screen.queryByTestId("floating-search-kind-pill")).toBeNull();
  });

  it("10b. the kind pill's mousedown is default-prevented (M3) — a click never leaves focusWithin stuck", () => {
    render(<Harness initialKind="bundle" />);
    const pill = screen.getByTestId("floating-search-kind-pill");
    const mdEvent = fireEvent.mouseDown(pill);
    expect(mdEvent).toBe(false); // preventDefault() was called
  });

  it("10c. Backspace in an empty input clears the inline context filter", () => {
    const onClear = vi.fn();
    render(
      <Harness
        context={{ icon: "bundle", label: "ramtoi", onClear, testid: "bundle-context-pill" }}
      />,
    );
    fireEvent.focus(input());

    const event = fireEvent.keyDown(input(), { key: "Backspace" });

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(event).toBe(false);
  });

  it("11. the kind row is a roving tab stop: only the pressed chip is tabbable, arrows move + press", () => {
    render(<Harness />);
    fireEvent.focus(input());
    const allChip = within(kindsRow()).getByRole("button", { name: /^ALL/ });
    const skillsChip = within(kindsRow()).getByRole("button", { name: /^SKILLS/ });
    expect(allChip).toHaveAttribute("tabindex", "0");
    expect(skillsChip).toHaveAttribute("tabindex", "-1");

    allChip.focus();
    fireEvent.keyDown(allChip, { key: "ArrowRight" });
    expect(skillsChip).toHaveFocus();
    expect(root()).toHaveAttribute("data-active-kind", "skill");
  });

  it("11b. Enter on a focused kind chip does NOT commit (M1)", async () => {
    const onCommit = vi.fn(() => true);
    render(<Harness onCommit={onCommit} />);
    await userEvent.type(input(), "item");
    const allChip = within(kindsRow()).getByRole("button", { name: /^ALL/ });
    allChip.focus();

    fireEvent.keyDown(allChip, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("12. data-focus tracks focusWithin independently of data-state (M5): a value survives blur, focus does not", async () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(root()).toHaveAttribute("data-focus", "true");
    await userEvent.type(input(), "item");
    expect(root()).toHaveAttribute("data-state", "typing");
    expect(root()).toHaveAttribute("data-focus", "true");

    fireEvent.blur(input());
    expect(root()).toHaveAttribute("data-state", "typing"); // value still present
    expect(root()).toHaveAttribute("data-focus", "false"); // but no longer focused
  });

  // ─── S2/S3/G3/G5: the arrow-cursor + kind-cycle + Tab-to-cursor contract ──

  it("13. ArrowDown/ArrowUp from the focused input call onMove(±1) and preventDefault", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    fireEvent.focus(input());

    const downEvent = fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(onMove).toHaveBeenCalledWith(1);
    expect(downEvent).toBe(false); // preventDefault() was called

    const upEvent = fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(onMove).toHaveBeenCalledWith(-1);
    expect(upEvent).toBe(false);
  });

  it("14. ArrowLeft/ArrowRight from the focused input cycle activeKind through `kinds` in order (S3)", () => {
    const onKindChange = vi.fn();
    render(<Harness onKindChange={onKindChange} initialKind="all" />);
    fireEvent.focus(input());

    fireEvent.keyDown(input(), { key: "ArrowRight" });
    expect(onKindChange).toHaveBeenLastCalledWith("skill");
    fireEvent.keyDown(input(), { key: "ArrowRight" });
    expect(onKindChange).toHaveBeenLastCalledWith("mcp");
  });

  it("14a. ArrowRight from the LAST kind (SNIPPETS) wraps to ALL (S3/G12)", () => {
    const onKindChange = vi.fn();
    render(<Harness onKindChange={onKindChange} initialKind="snippet" />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowRight" });
    expect(onKindChange).toHaveBeenLastCalledWith("all");
  });

  it("14c. ArrowLeft from the FIRST kind (ALL) wraps to SNIPPETS (S3/G12)", () => {
    const onKindChange = vi.fn();
    render(<Harness onKindChange={onKindChange} initialKind="all" />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowLeft" });
    expect(onKindChange).toHaveBeenLastCalledWith("snippet");
  });

  it("14b. focus stays in the input after an arrow-driven kind cycle (S3)", () => {
    render(<Harness />);
    input().focus(); // real DOM focus — fireEvent.focus() alone never moves document.activeElement
    fireEvent.keyDown(input(), { key: "ArrowRight" });
    expect(input()).toHaveFocus();
  });

  it("15. G5: ArrowLeft/ArrowRight on a FOCUSED CHIP cycles exactly once via its own roving handler — never double-cycled by the input's handler", () => {
    const onKindChange = vi.fn();
    render(<Harness onKindChange={onKindChange} />);
    fireEvent.focus(input());
    const allChip = within(kindsRow()).getByRole("button", { name: /^ALL/ });
    allChip.focus();

    fireEvent.keyDown(allChip, { key: "ArrowRight" });
    expect(onKindChange).toHaveBeenCalledTimes(1);
    expect(onKindChange).toHaveBeenCalledWith("skill");
  });

  it("16. Tab from the focused input calls onFocusCursor and preventDefault()s only when it returns true", () => {
    const onFocusCursor = vi.fn(() => true);
    render(<Harness onFocusCursor={onFocusCursor} />);
    fireEvent.focus(input());
    const tabEvent = fireEvent.keyDown(input(), { key: "Tab" });
    expect(onFocusCursor).toHaveBeenCalledTimes(1);
    expect(tabEvent).toBe(false); // preventDefault() was called
  });

  it("16b. Tab falls through to native behaviour when onFocusCursor returns false (nothing to focus)", () => {
    const onFocusCursor = vi.fn(() => false);
    render(<Harness onFocusCursor={onFocusCursor} />);
    fireEvent.focus(input());
    const tabEvent = fireEvent.keyDown(input(), { key: "Tab" });
    expect(onFocusCursor).toHaveBeenCalledTimes(1);
    expect(tabEvent).toBe(true); // default NOT prevented
  });

  it("16c. Shift+Tab is always left native — onFocusCursor is never called", () => {
    const onFocusCursor = vi.fn(() => true);
    render(<Harness onFocusCursor={onFocusCursor} />);
    fireEvent.focus(input());
    const tabEvent = fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(onFocusCursor).not.toHaveBeenCalled();
    expect(tabEvent).toBe(true);
  });

  // ─── Grill MAJOR 1: a modifier on arrow/Tab/Enter means native caret/
  // selection behaviour (⌥←/→, ⌘←/→, ⇧-arrow) — none of it is hijacked ──

  it("17. Shift+ArrowLeft does not cycle the kind and is not prevented (native selection)", () => {
    const onKindChange = vi.fn();
    render(<Harness onKindChange={onKindChange} initialKind="bundle" />);
    fireEvent.focus(input());
    const evt = fireEvent.keyDown(input(), { key: "ArrowLeft", shiftKey: true });
    expect(onKindChange).not.toHaveBeenCalled();
    expect(evt).toBe(true); // not prevented
  });

  it("18. Alt+ArrowRight does not cycle the kind and is not prevented (native word jump)", () => {
    const onKindChange = vi.fn();
    render(<Harness onKindChange={onKindChange} initialKind="all" />);
    fireEvent.focus(input());
    const evt = fireEvent.keyDown(input(), { key: "ArrowRight", altKey: true });
    expect(onKindChange).not.toHaveBeenCalled();
    expect(evt).toBe(true); // not prevented
  });

  it("19. Shift+ArrowDown does not call onMove", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    fireEvent.focus(input());
    const evt = fireEvent.keyDown(input(), { key: "ArrowDown", shiftKey: true });
    expect(onMove).not.toHaveBeenCalled();
    expect(evt).toBe(true); // not prevented
  });

  it("20. Cmd+Enter does not commit", async () => {
    const onCommit = vi.fn(() => true);
    render(<Harness onCommit={onCommit} />);
    await userEvent.type(input(), "item");
    const evt = fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(evt).toBe(true);
  });

  it("21. Ctrl+Tab does not call onFocusCursor", () => {
    const onFocusCursor = vi.fn(() => true);
    render(<Harness onFocusCursor={onFocusCursor} />);
    fireEvent.focus(input());
    const evt = fireEvent.keyDown(input(), { key: "Tab", ctrlKey: true });
    expect(onFocusCursor).not.toHaveBeenCalled();
    expect(evt).toBe(true);
  });

  it("22. idle shows the `/` kbd hint; focus hides it; a value shows the clear button instead", async () => {
    render(<Harness />);
    expect(within(root()).getByText("/")).toBeInTheDocument();
    expect(screen.queryByLabelText("Clear search")).toBeNull();

    fireEvent.focus(input());
    expect(within(root()).queryByText("/")).toBeNull();

    await userEvent.type(input(), "item");
    expect(within(root()).queryByText("/")).toBeNull();
    expect(screen.getByLabelText("Clear search")).toBeInTheDocument();
  });
});
