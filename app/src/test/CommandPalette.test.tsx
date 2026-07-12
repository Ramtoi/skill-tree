import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { CommandPalette } from "@/components/CommandPalette";
import { useAppStore } from "@/store";
import {
  renderWithProviders,
  makeQueryClient,
  primeRegistry,
  sampleRegistry,
} from "./helpers";
import type { Registry } from "@/types";

/** A registry with many skills, guaranteeing the root list exceeds the 24-item
 *  no-query cap so the "+N more" truncation affordance renders (B1-07). */
function bigRegistry(): Registry {
  const skills: Registry["skills"] = {};
  for (let i = 0; i < 30; i++) {
    const n = String(i).padStart(2, "0");
    skills[`zzskill-${n}`] = {
      version: "1.0.0",
      description: `Skill ${n}`,
      source: `~/skill-hub/skills/zzskill-${n}`,
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
    };
  }
  return { ...sampleRegistry, skills };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

describe("CommandPalette (new design)", () => {
  beforeEach(() => {
    useAppStore.getState().closePalette();
  });

  it("renders nothing when closed", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<CommandPalette />, { client });
    expect(container.querySelector(".palette")).toBeNull();
  });

  it("renders grouped sections with counts when open and shows hint column", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    useAppStore.getState().openPalette();

    await waitFor(() =>
      expect(document.querySelector(".palette")).not.toBeNull(),
    );

    // Action group present
    expect(screen.getByText(/Actions ·/)).toBeInTheDocument();
    // Bundles group present
    expect(screen.getByText(/Bundles ·/)).toBeInTheDocument();
    // Skills group present
    expect(screen.getByText(/Skills ·/)).toBeInTheDocument();
    // Projects group present
    expect(screen.getByText(/Projects ·/)).toBeInTheDocument();

    // Footer keybind legend
    expect(screen.getByText(/navigate$/)).toBeInTheDocument();
    expect(screen.getAllByText(/open/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/dismiss$/)).toBeInTheDocument();
  });

  it("filters items via substring match", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    useAppStore.getState().openPalette();

    await waitFor(() => expect(document.querySelector(".palette input")).not.toBeNull());

    const input = document.querySelector(".palette input") as HTMLInputElement;
    await userEvent.type(input, "brain");

    // Should still see "brainstorm" — exact match (skill name) survives filter
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
  });

  it("New bundle action navigates to /?addBundle=1", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <CommandPalette />
        <LocationProbe />
      </>,
      { client },
    );
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );

    const input = document.querySelector(".palette input") as HTMLInputElement;
    await userEvent.type(input, "New bundle");
    await userEvent.click(screen.getByText("New bundle"));

    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/?addBundle=1"),
    );
  });

  it("Add project action navigates to /?addProject=1 (C1)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <CommandPalette />
        <LocationProbe />
      </>,
      { client },
    );
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );

    const input = document.querySelector(".palette input") as HTMLInputElement;
    await userEvent.type(input, "Add project");
    await userEvent.click(screen.getByText("Add project"));

    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/?addProject=1"),
    );
  });

  it("Esc closes the palette", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    useAppStore.getState().openPalette();
    await waitFor(() => expect(document.querySelector(".palette")).not.toBeNull());

    const input = document.querySelector(".palette input") as HTMLInputElement;
    input.focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".palette")).toBeNull());
  });

  it.each([
    ["Open permissions", "/permissions"],
    ["Open sources", "/sources"],
    ["Open remotes", "/remotes"],
  ])("%s navigates to %s", async (label, path) => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <CommandPalette />
        <LocationProbe />
      </>,
      { client },
    );
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );
    const input = document.querySelector(".palette input") as HTMLInputElement;
    await userEvent.type(input, label);
    await userEvent.click(screen.getByText(label));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(path));
  });

  it("shows a non-interactive '+N more' row when the root list truncates, arrow nav skips it, and narrowing removes it (B1-07)", async () => {
    const client = makeQueryClient();
    primeRegistry(client, bigRegistry());
    renderWithProviders(<CommandPalette />, { client });
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );

    // Empty query → the list is capped at 24, so the overflow hint appears.
    const more = await screen.findByText(/more — keep typing to narrow/);
    expect(more).toBeInTheDocument();
    // It is not a selectable palette item (no arrow-nav / Enter target).
    expect(more.closest(".palette-item")).toBeNull();
    expect(more).toHaveAttribute("aria-hidden", "true");

    // Arrow-nav down past every item never lands on the hint row (it can't hold
    // data-active because it is not a .palette-item).
    const input = document.querySelector(".palette input") as HTMLInputElement;
    input.focus();
    for (let i = 0; i < 40; i++) {
      await userEvent.keyboard("{ArrowDown}");
    }
    expect(
      document.querySelector(".palette-item[data-active='true']"),
    ).not.toBeNull();
    expect(screen.getByText(/more — keep typing to narrow/).getAttribute("data-active")).toBeNull();

    // Narrowing below the cap removes the hint.
    await userEvent.type(input, "zzskill-1");
    await waitFor(() =>
      expect(screen.queryByText(/more — keep typing to narrow/)).toBeNull(),
    );
    expect(screen.getByText("zzskill-10")).toBeInTheDocument();
  });

  it("lists a Configure entry per installed harness and navigates to its config", async () => {
    useAppStore.setState({
      harnesses: [
        { id: "claude-code", label: "Claude Code", installed: true },
        { id: "codex", label: "Codex", installed: false },
      ] as never,
    });
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <CommandPalette />
        <LocationProbe />
      </>,
      { client },
    );
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );
    const input = document.querySelector(".palette input") as HTMLInputElement;
    await userEvent.type(input, "Configure");
    expect(screen.getByText("Configure Claude Code")).toBeInTheDocument();
    expect(screen.queryByText("Configure Codex")).toBeNull();
    await userEvent.click(screen.getByText("Configure Claude Code"));
    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/harness/claude-code"),
    );
  });

  // ── B2-01: keyboard navigation of the primary command surface ───────────────
  // The app is power-user-first, yet ↓/↑ roving, Enter-to-run, and the
  // hover→active sync were entirely unguarded. These pin the whole keyboard path.

  /** Narrow the palette to a deterministic, ordered list of "Open …" actions so
   *  index math is stable. Query "open" matches the `Open project…` verb (idx 0)
   *  then the six `Open <destination>` actions in registration order:
   *  library(1) · harnesses(2) · snippets(3) · permissions(4) · sources(5) · remotes(6). */
  async function openWithFilter(input: HTMLInputElement, filter: string) {
    input.focus();
    await userEvent.type(input, filter);
  }

  it("ArrowDown roves the active row and Enter runs it (B2-01)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <CommandPalette />
        <LocationProbe />
      </>,
      { client },
    );
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );
    const input = document.querySelector(".palette input") as HTMLInputElement;
    await openWithFilter(input, "open");

    // Typing reset the active row to 0 → the first item is active.
    const itemsAt = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".palette-item"));
    await waitFor(() =>
      expect(itemsAt()[0].getAttribute("data-active")).toBe("true"),
    );

    // ArrowDown ×2 → the THIRD item (index 2 = "Open harnesses") is active,
    // and it is the sole active row.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    const items = itemsAt();
    expect(items[2].getAttribute("data-active")).toBe("true");
    expect(
      items.filter((el) => el.getAttribute("data-active") === "true"),
    ).toHaveLength(1);
    expect(items[2]).toHaveTextContent("Open harnesses");

    // Enter runs the active item → navigates to its route.
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/harnesses"),
    );
    // …and the palette closed.
    expect(document.querySelector(".palette")).toBeNull();
  });

  it("ArrowUp clamps at the top edge (index never goes negative) (B2-01)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );
    const input = document.querySelector(".palette input") as HTMLInputElement;
    await openWithFilter(input, "open");

    // Already at the top → ArrowUp is a no-op, first row stays active.
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(".palette-item"),
    );
    expect(items[0].getAttribute("data-active")).toBe("true");
  });

  it("hovering a row syncs it to the active index; keyboard continues from there (B2-01)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    useAppStore.getState().openPalette();
    await waitFor(() =>
      expect(document.querySelector(".palette input")).not.toBeNull(),
    );
    const input = document.querySelector(".palette input") as HTMLInputElement;
    await openWithFilter(input, "open");

    // Hover a row far from the keyboard cursor (index 0) → it becomes active.
    const remotes = screen.getByText("Open remotes").closest(".palette-item")!;
    fireEvent.mouseEnter(remotes);
    await waitFor(() =>
      expect(remotes.getAttribute("data-active")).toBe("true"),
    );
    // Exactly one row is active — the hover moved the cursor, it didn't add one.
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(".palette-item"),
      ).filter((el) => el.getAttribute("data-active") === "true"),
    ).toHaveLength(1);

    // Keyboard resumes from the hovered position: ArrowUp lands on "Open sources".
    await userEvent.keyboard("{ArrowUp}");
    const sources = screen.getByText("Open sources").closest(".palette-item")!;
    expect(sources.getAttribute("data-active")).toBe("true");
    expect(remotes.getAttribute("data-active")).toBe("false");
  });
});
