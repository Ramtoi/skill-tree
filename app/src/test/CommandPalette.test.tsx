import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { CommandPalette } from "@/components/CommandPalette";
import { useAppStore } from "@/store";
import { renderWithProviders, makeQueryClient, primeRegistry } from "./helpers";

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
});
