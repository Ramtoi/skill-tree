import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EmojiPicker } from "@/components/emoji/EmojiPicker";
import { EMOJI_GROUPS } from "@/components/emoji/emojiData";
import { isValidIcon } from "@/components/IconPicker";

describe("EmojiPicker", () => {
  // The default (no-query) view renders every group's full tile grid at
  // once (~500 tiles total, per the brief — no virtualization); that's
  // legitimately heavier than the default 5s budget under a loaded machine.
  it(
    "renders every group head and the Suggested tiles",
    () => {
      render(<EmojiPicker value="📦" onPick={() => {}} onClose={() => {}} />);
      for (const group of EMOJI_GROUPS) {
        expect(screen.getByText(group.label)).toBeInTheDocument();
      }
      for (const entry of EMOJI_GROUPS[0]!.entries) {
        expect(
          screen.getByRole("button", { name: `Use ${entry.char}` }),
        ).toBeInTheDocument();
      }
    },
  );

  it("typing 'robot' leaves the 🤖 tile and hides the tabs", async () => {
    render(<EmojiPicker value="📦" onPick={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Search emoji"), "robot");

    expect(
      screen.getByRole("button", { name: "Use 🤖" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(document.querySelectorAll(".emoji-picker-tile")).toHaveLength(1);
  });

  it("typing an emoji not in the set shows a data-typed tile", async () => {
    const onPick = vi.fn();
    render(<EmojiPicker value="📦" onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Search emoji"), "🦊");

    const tile = screen.getByRole("button", { name: "Use 🦊" });
    expect(tile).toHaveAttribute("data-typed");
    await userEvent.click(tile);
    expect(onPick).toHaveBeenCalledWith("🦊");
  });

  it("typing 'zzzz' shows the empty state", async () => {
    render(<EmojiPicker value="📦" onPick={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Search emoji"), "zzzz");

    expect(document.querySelector(".emoji-picker-empty")).toBeInTheDocument();
    expect(screen.getByText(/No emoji match/)).toBeInTheDocument();
  });

  it(
    "ArrowDown from the search focuses the first tile; ArrowRight moves to the second",
    async () => {
      render(<EmojiPicker value="📦" onPick={() => {}} onClose={() => {}} />);
      const search = screen.getByLabelText("Search emoji");
      search.focus();
      await userEvent.keyboard("{ArrowDown}");

      const first = EMOJI_GROUPS[0]!.entries[0]!;
      const second = EMOJI_GROUPS[0]!.entries[1]!;
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `Use ${first.char}` }),
      );

      await userEvent.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `Use ${second.char}` }),
      );
    },
  );

  it("every EMOJI_GROUPS entry passes isValidIcon; no duplicate chars within a group", () => {
    for (const group of EMOJI_GROUPS) {
      const seen = new Set<string>();
      for (const entry of group.entries) {
        expect(isValidIcon(entry.char)).toBe(true);
        expect(seen.has(entry.char)).toBe(false);
        seen.add(entry.char);
      }
    }
  });

  it("no char repeats across groups", () => {
    const total = EMOJI_GROUPS.reduce((n, g) => n + g.entries.length, 0);
    const uniqueChars = new Set(EMOJI_GROUPS.flatMap((g) => g.entries.map((e) => e.char)));
    expect(uniqueChars.size).toBe(total);
  });

  it(
    "exactly one tile has tabIndex 0 with no query (roving tabindex)",
    () => {
      render(<EmojiPicker value="📦" onPick={() => {}} onClose={() => {}} />);
      const tiles = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".emoji-picker-tile"),
      );
      const tabbable = tiles.filter((t) => t.tabIndex === 0);
      expect(tabbable).toHaveLength(1);
    },
  );

  it(
    "ArrowDown from the last Suggested row lands on the Tools tile in the same column",
    async () => {
      render(<EmojiPicker value="📦" onPick={() => {}} onClose={() => {}} />);
      const suggested = EMOJI_GROUPS.find((g) => g.id === "suggested")!;
      const tools = EMOJI_GROUPS.find((g) => g.id === "tools")!;
      const lastRowStart = Math.floor((suggested.entries.length - 1) / 8) * 8;
      const col = suggested.entries.length - 1 - lastRowStart;
      const startEntry = suggested.entries[lastRowStart + col]!;
      const expectedEntry = tools.entries[Math.min(col, tools.entries.length - 1)]!;

      act(() => screen.getByRole("button", { name: `Use ${startEntry.char}` }).focus());
      await userEvent.keyboard("{ArrowDown}");

      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `Use ${expectedEntry.char}` }),
      );
    },
  );

  it("pasting two emoji shows the two-emoji message, not the generic no-match", async () => {
    render(<EmojiPicker value="📦" onPick={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Search emoji"), "🤖🦊");

    expect(screen.getByText("One emoji at a time.")).toBeInTheDocument();
    expect(screen.queryByText(/No emoji match/)).toBeNull();
  });
});
