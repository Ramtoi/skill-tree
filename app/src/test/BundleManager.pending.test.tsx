import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { BundleManager } from "@/screens/BundleManager";
import type { Registry } from "@/types";
import {
  renderWithProviders,
  primeRegistry,
  makeQueryClient,
  deferredInvoke,
} from "./helpers";

const bundleRegistry: Registry = {
  version: "1",
  hub_path: "~/h",
  skills: {
    s1: {
      version: "1.0.0",
      description: "Only via b1.",
      source: "~/h/skills/s1",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
    },
  },
  projects: { p1: { path: "/p1", bundles: ["b1"], enabled: [] } },
  bundles: {
    b1: { description: "B1", icon: "📦", scope: "project-specific", skills: ["s1"] },
  },
};

function renderBundle() {
  const client = makeQueryClient();
  primeRegistry(client, bundleRegistry);
  renderWithProviders(
    <Routes>
      <Route path="/bundle/:name" element={<BundleManager />} />
    </Routes>,
    { client, initialRoute: "/bundle/b1" },
  );
  return client;
}

const isBundleDelete = (cmd: string, args?: unknown) =>
  cmd === "hub_cmd" &&
  Array.isArray((args as { args?: string[] } | undefined)?.args) &&
  (args as { args: string[] }).args[0] === "bundle" &&
  (args as { args: string[] }).args[1] === "delete";

describe("BundleManager delete — pending feedback", () => {
  it("busies + disables the confirm while the delete is in flight and re-enables on failure", async () => {
    const gate = deferredInvoke(isBundleDelete);
    const user = userEvent.setup();
    renderBundle();

    await user.click(screen.getByRole("button", { name: /Delete bundle…/ }));
    const confirm = screen.getByRole("button", { name: "Delete bundle" });
    expect(confirm).not.toBeDisabled();

    await user.click(confirm);

    // While the delete command hangs, the confirm is busy/disabled and the
    // Cancel is disabled too (the dialog is non-dismissable mid-write).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete bundle" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    // On failure the dialog re-enables so the user can retry or cancel.
    gate.reject(new Error("delete failed"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete bundle" }),
      ).not.toBeDisabled(),
    );
  });
});
