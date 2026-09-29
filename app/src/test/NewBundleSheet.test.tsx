import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

import { NewBundleSheet } from "@/components/NewBundleSheet";
import { Processes } from "@/store/processes";
import { deferredInvoke, renderWithProviders } from "./helpers";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  for (const p of Processes.list()) Processes.dismiss(p.id);
});

describe("NewBundleSheet", () => {
  it("renders nothing when closed", () => {
    renderWithProviders(<NewBundleSheet open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the form fields and defaults scope to portable", () => {
    renderWithProviders(<NewBundleSheet open onClose={() => {}} />);
    expect(screen.getByPlaceholderText("my-bundle-name")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "portable" })).toBeChecked();
  });

  it("disables the submit button while the name is empty", () => {
    renderWithProviders(<NewBundleSheet open onClose={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Create bundle" }),
    ).toBeDisabled();
  });

  it("invokes `bundle new … --skills \"\"` and navigates on success", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <>
        <NewBundleSheet open onClose={onClose} />
        <LocationProbe />
      </>,
    );

    await userEvent.type(
      screen.getByPlaceholderText("my-bundle-name"),
      "my-bundle",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create bundle" }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const call = vi
      .mocked(invoke)
      .mock.calls.find(([cmd]) => cmd === "hub_cmd");
    expect(call).toBeTruthy();
    const args = (call?.[1] as { args: string[] }).args;
    expect(args.slice(0, 5)).toEqual([
      "bundle",
      "new",
      "my-bundle",
      "--skills",
      "",
    ]);
    const scopeIdx = args.indexOf("--scope");
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(args[scopeIdx + 1]).toBe("portable");
    // The payload is what lets a doctor-failed auto-sync be told apart from a
    // failed creation.
    expect(args).toContain("--json");

    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/bundle/my-bundle"),
    );
  });

  it("invokes `bundle new … --scope global` after picking global", async () => {
    const onClose = vi.fn();
    renderWithProviders(<NewBundleSheet open onClose={onClose} />);

    await userEvent.type(
      screen.getByPlaceholderText("my-bundle-name"),
      "everywhere-bundle",
    );
    await userEvent.click(screen.getByRole("radio", { name: "global" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Create bundle" }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const call = vi
      .mocked(invoke)
      .mock.calls.find(([cmd]) => cmd === "hub_cmd");
    const args = (call?.[1] as { args: string[] }).args;
    const scopeIdx = args.indexOf("--scope");
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(args[scopeIdx + 1]).toBe("global");
  });

  it("tracks the write as a process with target bundle-new:<name>", async () => {
    const gate = deferredInvoke((cmd) => cmd === "hub_cmd");
    const onClose = vi.fn();
    renderWithProviders(<NewBundleSheet open onClose={onClose} />);

    await userEvent.type(
      screen.getByPlaceholderText("my-bundle-name"),
      "tracked-bundle",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create bundle" }),
    );

    await waitFor(() => {
      const p = Processes.list().find(
        (p) => p.target === "bundle-new:tracked-bundle",
      );
      expect(p).toBeDefined();
      expect(p!.status).toBe("running");
    });

    await act(async () => {
      gate.resolve({
        success: true,
        output: JSON.stringify({
          bundle: { name: "tracked-bundle", skills: [], source: null },
          created: true,
        }),
      });
    });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const settled = Processes.list().find(
      (p) => p.target === "bundle-new:tracked-bundle",
    );
    expect(settled?.status).toBe("success");
  });

  it("still creates + navigates when the auto-sync reports findings", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "hub_cmd") {
        return {
          success: false,
          output: `${JSON.stringify({
            bundle: { name: "warny", skills: [], source: null },
            created: true,
            errors: ["doctor: 1 danger finding in example-app"],
          })}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
        };
      }
      return undefined;
    }) as never);
    const onClose = vi.fn();
    renderWithProviders(
      <>
        <NewBundleSheet open onClose={onClose} />
        <LocationProbe />
      </>,
    );

    await userEvent.type(screen.getByPlaceholderText("my-bundle-name"), "warny");
    await userEvent.click(screen.getByRole("button", { name: "Create bundle" }));

    // The bundle exists — closing and navigating is the truthful outcome.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/bundle/warny"),
    );
  });

  it("passes the picked icon through to --icon", async () => {
    const onClose = vi.fn();
    renderWithProviders(<NewBundleSheet open onClose={onClose} />);

    await userEvent.type(
      screen.getByPlaceholderText("my-bundle-name"),
      "robo-bundle",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Icon:/ }));
    await userEvent.click(screen.getByRole("button", { name: "Use 🤖" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Create bundle" }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const call = vi
      .mocked(invoke)
      .mock.calls.find(([cmd]) => cmd === "hub_cmd");
    const args = (call?.[1] as { args: string[] }).args;
    const iconIdx = args.indexOf("--icon");
    expect(iconIdx).toBeGreaterThan(-1);
    expect(args[iconIdx + 1]).toBe("🤖");
  });

  it("keeps the sheet open and does not navigate when the command fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "hub_cmd") {
        return { success: false, output: "Bundle 'dupe' already exists." };
      }
      return undefined;
    });
    const onClose = vi.fn();
    renderWithProviders(<NewBundleSheet open onClose={onClose} />);

    await userEvent.type(
      screen.getByPlaceholderText("my-bundle-name"),
      "dupe",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create bundle" }),
    );

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "hub_cmd",
        expect.anything(),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the emoji picker on Escape without closing the dialog", async () => {
    renderWithProviders(<NewBundleSheet open onClose={() => {}} />);

    // Wait for the Sheet's own initial-focus effect (into the name field) to
    // land before opening the picker: racing that effect against the
    // picker's own focus-on-open would fire the Sheet's "steal focus back
    // into the dialog" behaviour while the picker's search input holds
    // focus, closing the picker via its focus-out guard. A real user's
    // click always lands well after that first-paint effect settles.
    await waitFor(() =>
      expect(screen.getByPlaceholderText("my-bundle-name")).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Icon:/ }));
    expect(
      screen.getByRole("dialog", { name: "Pick an icon" }),
    ).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: "Pick an icon" }),
    ).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "New bundle" }),
    ).toBeInTheDocument();
  });

  it("returns focus to the icon trigger after Escape closes the picker", async () => {
    renderWithProviders(<NewBundleSheet open onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("my-bundle-name")).toHaveFocus(),
    );
    const trigger = screen.getByRole("button", { name: /^Icon:/ });
    await userEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Pick an icon" }),
    ).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("focuses the icon trigger after Enter picks a tile", async () => {
    renderWithProviders(<NewBundleSheet open onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("my-bundle-name")).toHaveFocus(),
    );
    const trigger = screen.getByRole("button", { name: /^Icon:/ });
    await userEvent.click(trigger);
    // Wait for the picker's OWN initial-focus effect (into its search input)
    // to land before moving focus ourselves: racing it would let that effect
    // steal focus back off the tile right as Enter is pressed.
    await waitFor(() =>
      expect(screen.getByLabelText("Search emoji")).toHaveFocus(),
    );

    // The default icon (📦) is the picker's roving tile — no arrow-key hop
    // needed to reach it.
    const tile = screen.getByRole("button", { name: "Use 📦" });
    act(() => tile.focus());
    await userEvent.keyboard("{Enter}");

    expect(
      screen.queryByRole("dialog", { name: "Pick an icon" }),
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
