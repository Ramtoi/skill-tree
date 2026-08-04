import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

import { NewBundleSheet } from "@/components/NewBundleSheet";
import { renderWithProviders } from "./helpers";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe("NewBundleSheet", () => {
  it("renders nothing when closed", () => {
    const { container } = renderWithProviders(
      <NewBundleSheet open={false} onClose={() => {}} />,
    );
    expect(container.querySelector(".palette")).toBeNull();
  });

  it("renders the form fields and defaults scope to project-specific", () => {
    renderWithProviders(<NewBundleSheet open onClose={() => {}} />);
    expect(screen.getByPlaceholderText("my-bundle-name")).toBeInTheDocument();
    const scope = screen.getByRole("combobox") as HTMLSelectElement;
    expect(scope.value).toBe("project-specific");
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
    expect(args).toContain("--scope");

    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/bundle/my-bundle"),
    );
  });

  it("passes the picked icon through to --icon", async () => {
    const onClose = vi.fn();
    renderWithProviders(<NewBundleSheet open onClose={onClose} />);

    await userEvent.type(
      screen.getByPlaceholderText("my-bundle-name"),
      "robo-bundle",
    );
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
});
