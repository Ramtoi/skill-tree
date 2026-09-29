import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { RecoveryRepositoryPicker } from "@/components/recovery/RecoveryRepositoryPicker";
import { renderWithProviders } from "./helpers";

it("retries an unavailable repository list without changing the search", async () => {
  let reads = 0;
  vi.mocked(invoke).mockImplementation((async (command: string) => {
    if (command === "recovery_command") {
      reads++;
      return reads === 1 ? { ok: false, error: "GitHub is offline", error_kind: "offline" }
        : { ok: true, repositories: [{ full_name: "org/recovered", url: "https://github.com/org/recovered.git" }] };
    }
  }) as never);
  renderWithProviders(<RecoveryRepositoryPicker open project="dev" onClose={vi.fn()} />);
  await userEvent.click(await screen.findByText("Retry repository list"));
  expect(await screen.findByText("org/recovered")).toBeVisible();
});

it("lets an explicit local selection choose among ambiguous remotes", async () => {
  const close = vi.fn();
  vi.mocked(invoke).mockImplementation((async (command: string, payload: { args?: string[] }) => {
    if (command === "pick_directory") return "/fixture/checkout";
    if (command === "recovery_command") {
      if (payload.args?.[0] === "attach") return payload.args.includes("upstream")
        ? { ok: true } : { ok: false, error: { code: "ambiguous_remote", message: "Choose origin or upstream" } };
      return { ok: true, repositories: [] };
    }
  }) as never);
  renderWithProviders(<RecoveryRepositoryPicker open project="dev" onClose={close} />);
  await userEvent.click(screen.getByRole("tab", { name: /local/i }));
  await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await userEvent.click(screen.getByTestId("recovery-attach-local-folder"));
  expect(await screen.findByText(/Choose origin or upstream/)).toBeVisible();
  await userEvent.type(screen.getByLabelText("Git remote, if needed"), "upstream");
  await userEvent.click(screen.getByTestId("recovery-attach-local-folder"));
  expect(close).toHaveBeenCalledOnce();
});

it("can load accessible repositories beyond the bounded first chunk", async () => {
  let extended = false;
  vi.mocked(invoke).mockImplementation((async (command: string, payload: { args?: string[] }) => {
    if (command !== "recovery_command") return;
    if (payload.args?.includes("--fetch-more")) extended = true;
    return { ok: true, truncated: !extended, repositories: extended
      ? [{ full_name: "large-org/later-repository", url: "https://github.com/large-org/later-repository.git" }] : [] };
  }) as never);
  renderWithProviders(<RecoveryRepositoryPicker open project="dev" onClose={vi.fn()} />);
  await userEvent.click(await screen.findByText("Load more repositories"));
  expect(await screen.findByText("large-org/later-repository")).toBeVisible();
});
