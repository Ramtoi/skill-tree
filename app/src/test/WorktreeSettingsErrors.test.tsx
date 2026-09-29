import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { WorktreeSettings } from "@/components/settings/WorktreeSettings";
import { renderWithProviders } from "./helpers";

const defaults = {
  location: "shared-directory" as const,
  base_dir: "~/Dev/worktrees",
  access_enabled: false,
  include_in_backup: false,
};

function reply(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    configured: true,
    defaults,
    preview: null,
    error: null,
    ...over,
  };
}

function renderSettings() {
  renderWithProviders(
    <WorktreeSettings
      draft={null}
      onDraftChange={() => {}}
      onPendingChange={() => {}}
      onNavigate={() => {}}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("WorktreeSettings read failures", () => {
  it("does not present defaults as editable until a failed read is retried successfully", async () => {
    let reads = 0;
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command !== "hub_cmd") return undefined;
      const cliArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      if (cliArgs[2] === "show") {
        reads += 1;
        if (reads === 1) {
          return {
            success: false,
            output: JSON.stringify({
              ok: false,
              configured: false,
              defaults,
              preview: null,
              error: { code: "read_failed", message: "registry unavailable" },
            }),
          };
        }
        return { success: true, output: JSON.stringify(reply()) };
      }
      if (cliArgs[2] === "preview") {
        return {
          success: true,
          output: JSON.stringify({
            ...reply(),
            preview: { path: "/Users/dev/Dev/worktrees/my-project", access_enabled: false, missing_directory: true },
          }),
        };
      }
      return { success: true, output: "" };
    });
    renderSettings();

    expect(await screen.findByRole("alert")).toHaveTextContent(/registry unavailable/);
    expect(screen.queryByRole("textbox", { name: "Base directory" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save defaults" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("textbox", { name: "Base directory" })).toHaveValue(defaults.base_dir);
    expect(reads).toBe(2);
  });
});
