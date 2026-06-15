import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IconRail } from "@/components/IconRail";
import { renderWithProviders, makeQueryClient, primeRegistry } from "./helpers";
import { useAppStore } from "@/store";

describe("IconRail", () => {
  it("shows logo and the six destinations + two utilities", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client });
    expect(screen.getByTitle("Skill Tree")).toBeInTheDocument();
    expect(screen.getByTitle("Library")).toBeInTheDocument();
    expect(screen.getByTitle("Projects")).toBeInTheDocument();
    expect(screen.getByTitle("Sources")).toBeInTheDocument();
    expect(screen.getByTitle("Snippets")).toBeInTheDocument();
    expect(screen.getByTitle("Permissions")).toBeInTheDocument();
    expect(screen.getByTitle("Harnesses")).toBeInTheDocument();
    expect(screen.getByTitle("Command palette (⌘K)")).toBeInTheDocument();
    expect(screen.getByTitle("Tweaks")).toBeInTheDocument();
  });

  it("no longer has Bundles or Sync rail buttons", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client });
    expect(screen.queryByTitle("Bundles")).toBeNull();
    expect(screen.queryByTitle("Sync")).toBeNull();
  });

  it("marks Library aria-current on root route", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/" });
    expect(screen.getByTitle("Library").getAttribute("aria-current")).toBe("true");
  });

  it("marks Library aria-current on /bundle/* route", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/bundle/android" });
    expect(screen.getByTitle("Library").getAttribute("aria-current")).toBe("true");
  });

  it("marks Projects aria-current on /project/* route", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/project/example-app" });
    expect(screen.getByTitle("Projects").getAttribute("aria-current")).toBe("true");
  });

  it("marks Permissions aria-current on /permissions and uses a non-cog icon", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/permissions" });
    const perms = screen.getByTitle("Permissions");
    expect(perms.getAttribute("aria-current")).toBe("true");
    // The shield glyph is distinct from the cog (Tweaks). The cog's defining
    // marker is its 8 radial ticks path; the shield must not contain it.
    const cogPath = "M8 1.5v2M8 12.5v2";
    expect(perms.querySelector(`path[d^="${cogPath}"]`)).toBeNull();
    const tweaks = screen.getByTitle("Tweaks");
    expect(tweaks.querySelector(`path[d^="${cogPath}"]`)).not.toBeNull();
  });

  it("clicking the command-palette button opens the palette", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client });
    await userEvent.click(screen.getByTitle("Command palette (⌘K)"));
    expect(useAppStore.getState().paletteOpen).toBe(true);
    useAppStore.getState().closePalette();
  });

  it("Projects with no registered projects opens the palette", async () => {
    const client = makeQueryClient();
    // Empty registry — no projects, so the Projects rail button falls back to the palette.
    client.setQueryData(["registry"], {
      harnesses_global: [],
      projects: {},
      bundles: {},
      skills: {},
      sources: {},
    });
    useAppStore.setState({ recentlyVisited: [] });
    renderWithProviders(<IconRail />, { client });
    await userEvent.click(screen.getByTitle("Projects"));
    expect(useAppStore.getState().paletteOpen).toBe(true);
    useAppStore.getState().closePalette();
  });
});
