import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useAutocomplete } from "@/lib/useAutocomplete";
import { SuggestionDropdown } from "@/components/SuggestionDropdown";
import { TagInput } from "@/components/snippets/TagInput";

// ── Harness that renders a single-line combobox via the hook + dropdown ──────
function Combobox({
  items,
  onPick,
}: {
  items: string[];
  onPick: (v: string) => void;
}) {
  const [value, setValue] = useState("");
  const ac = useAutocomplete({
    query: value,
    items,
    onPick: (v) => {
      setValue(v);
      onPick(v);
    },
  });
  return (
    <div className="autocomplete-wrap">
      <input
        aria-label="combo"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => ac.show()}
        onKeyDown={(e) => ac.handleKeyDown(e)}
      />
      <SuggestionDropdown ac={ac} />
    </div>
  );
}

const POOL = ["Bash(git status*)", "Bash(git push:*)", "Bash(npm:*)"];

describe("useAutocomplete", () => {
  it("filters the pool by substring and shows matches on focus/typing", async () => {
    const user = userEvent.setup();
    render(<Combobox items={POOL} onPick={() => {}} />);
    await user.click(screen.getByLabelText("combo"));
    // Empty query on focus → browse all.
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.keyboard("git");
    await waitFor(() =>
      expect(screen.getAllByRole("option")).toHaveLength(2),
    );
    expect(screen.getByText("Bash(git status*)")).toBeInTheDocument();
    expect(screen.getByText("Bash(git push:*)")).toBeInTheDocument();
    expect(screen.queryByText("Bash(npm:*)")).toBeNull();
  });

  it("ranks prefix matches ahead of infix matches", async () => {
    const user = userEvent.setup();
    render(
      <Combobox items={["Bash(git push:*)", "push-notify"]} onPick={() => {}} />,
    );
    await user.click(screen.getByLabelText("combo"));
    await user.keyboard("push");
    const options = await screen.findAllByRole("option");
    // "push-notify" starts with the query, so it ranks first.
    expect(options[0]).toHaveTextContent("push-notify");
  });

  it("commits the highlighted item with ArrowDown then Enter", async () => {
    const user = userEvent.setup();
    const picked = vi.fn();
    render(<Combobox items={POOL} onPick={picked} />);
    await user.click(screen.getByLabelText("combo"));
    await user.keyboard("git");
    await user.keyboard("{ArrowDown}"); // highlight first match
    await user.keyboard("{Enter}");
    expect(picked).toHaveBeenCalledWith("Bash(git status*)");
  });

  it("hides the exact-match candidate (nothing to complete)", async () => {
    const user = userEvent.setup();
    render(<Combobox items={POOL} onPick={() => {}} />);
    await user.click(screen.getByLabelText("combo"));
    await user.keyboard("Bash(npm:*)");
    await waitFor(() =>
      expect(screen.queryByText("Bash(npm:*)")).toBeNull(),
    );
  });

  it("closes the menu on Escape", async () => {
    const user = userEvent.setup();
    render(<Combobox items={POOL} onPick={() => {}} />);
    await user.click(screen.getByLabelText("combo"));
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
  });
});

// ── TagInput: the type-to-filter behaviour over existing tags ────────────────
describe("TagInput type-to-filter", () => {
  function Host({ suggestions }: { suggestions: string[] }) {
    const [tags, setTags] = useState<string[]>([]);
    return (
      <TagInput tags={tags} onChange={setTags} suggestions={suggestions} />
    );
  }

  it("filters existing tags as you type and adds the highlighted one", async () => {
    const user = userEvent.setup();
    render(<Host suggestions={["android", "codex", "ci"]} />);
    const input = screen.getByPlaceholderText("add tags…");
    await user.click(input);
    await user.keyboard("c");
    // Only "codex" and "ci" match "c".
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["codex", "ci"]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("shows the dropdown on focus and hides it on blur", async () => {
    const user = userEvent.setup();
    render(<Host suggestions={["android", "codex"]} />);
    const input = screen.getByPlaceholderText("add tags…");
    // Focus with an empty draft browses all existing tags.
    await user.click(input);
    expect(
      screen.getByRole("listbox", { name: "Existing tags" }),
    ).toBeInTheDocument();
    // Blurring away closes it (a plain blur, not a suggestion mousedown).
    fireEvent.blur(input);
    await waitFor(() =>
      expect(
        screen.queryByRole("listbox", { name: "Existing tags" }),
      ).toBeNull(),
    );
  });

  it("does not suggest a tag already applied", async () => {
    const user = userEvent.setup();
    render(<Host suggestions={["android", "codex"]} />);
    const input = screen.getByPlaceholderText("add tags…");
    // Add android by typing it fully + Enter (no highlight → adds draft).
    await user.click(input);
    await user.keyboard("android{Enter}");
    // Re-focus and browse; android should be gone from suggestions.
    await user.click(screen.getByPlaceholderText("add tag…"));
    await waitFor(() => {
      const opts = screen.queryAllByRole("option");
      expect(opts.some((o) => o.textContent === "android")).toBe(false);
    });
  });
});
