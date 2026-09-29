import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CheckoutDiscoveryPicker } from "@/components/remotes/CheckoutDiscoveryPicker";
import { renderWithProviders } from "./helpers";

const candidates = [
  { path: "/Users/me/app", matches: [{ source_project: "app", source_remote: "origin", destination_remote: "origin", checkout_path: "/Users/me/app" }] },
  { path: "/Users/me/app-copy", matches: [{ source_project: "app", source_remote: "origin", destination_remote: "upstream", checkout_path: "/Users/me/app-copy" }] },
];

it("keeps project choices unchecked and replaces an ambiguous checkout", async () => {
  const user = userEvent.setup();
  const choose = vi.fn();
  renderWithProviders(<CheckoutDiscoveryPicker candidates={candidates} onDiscover={vi.fn()} onChoose={choose} />);
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes.every(box => !(box as HTMLInputElement).checked)).toBe(true);
  await user.click(boxes[0]);
  await user.click(boxes[1]);
  expect((boxes[0] as HTMLInputElement).checked).toBe(false);
  expect((boxes[1] as HTMLInputElement).checked).toBe(true);
  expect(choose).toHaveBeenLastCalledWith(candidates[1], candidates[1].matches[0]);
});

it("shows progress, partial scan recovery, and an empty result", () => {
  renderWithProviders(<CheckoutDiscoveryPicker busy partial candidates={[]} error="Scan failed" onDiscover={vi.fn()} onChoose={vi.fn()} />);
  expect(screen.getByText(/Scanning/)).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Scan failed");
  expect(screen.getByText(/scan reached its limit/i)).toBeInTheDocument();
});

it("keeps failed selections for a retry after partial confirmation", async () => {
  const user = userEvent.setup();
  const confirm = vi.fn().mockResolvedValue({ app: "Receiver rejected this checkout." });
  renderWithProviders(<CheckoutDiscoveryPicker candidates={candidates} onDiscover={vi.fn()} onChoose={vi.fn()} onConfirm={confirm} />);
  await user.click(screen.getAllByRole("checkbox")[0]);
  await user.click(screen.getByRole("button", { name: /Confirm selected mappings/ }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
  expect(screen.getAllByText(/Receiver rejected this checkout/).length).toBeGreaterThan(0);
});


it("chooses one source remote when both identify the same repository", async () => {
  const user = userEvent.setup();
  const match = candidates[0].matches[0];
  const confirm = vi.fn().mockResolvedValue({});
  renderWithProviders(<CheckoutDiscoveryPicker candidates={[{ ...candidates[0], matches: [
    match, { ...match, source_remote: "upstream" },
  ] }]} onDiscover={vi.fn()} onChoose={vi.fn()} onConfirm={confirm} />);
  await user.click(screen.getAllByRole("checkbox")[1]);
  expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Confirm selected mappings (1)" }));
  expect(confirm).toHaveBeenCalledWith([{ ...match, source_remote: "upstream" }]);
});
