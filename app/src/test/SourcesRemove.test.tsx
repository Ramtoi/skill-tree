import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { Sources } from "@/screens/Sources";

/**
 * B1-03: the git-source removal (destructive — unequips its skills everywhere,
 * no undo) must route through the app's ConfirmDialog primitive, never the
 * native `window.confirm`.
 */
describe("Sources — remove-source ConfirmDialog", () => {
	let removeArgs: string[] | null;

	beforeEach(() => {
		removeArgs = null;
		vi.mocked(invoke).mockReset();
		vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
			if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
			if (cmd === "hub_cmd") {
				const a = (args as { args: string[] }).args;
				if (a[0] === "source" && a[1] === "list")
					return Promise.resolve({ success: true, output: '{"sources":[],"errors":[]}' });
				if (a[0] === "source" && a[1] === "remove") {
					removeArgs = a;
					return Promise.resolve({ success: true, output: "" });
				}
				return Promise.resolve({ success: true, output: "" });
			}
			return Promise.resolve(undefined);
		});
	});

	it("opens a destructive ConfirmDialog with blast radius — no window.confirm", async () => {
		const confirmSpy = vi.spyOn(window, "confirm");
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/sources",
		});

		// The org-skills git source card renders its trash Remove button.
		const removeBtn = await screen.findByRole("button", {
			name: "Remove source…",
		});
		fireEvent.click(removeBtn);

		// A real dialog opens (not the native browser confirm).
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent(/Remove source "Org Skills"\?/);
		// Blast radius: org-skills owns exactly one skill (android-compose-ui).
		expect(dialog).toHaveTextContent(/1 skill/);
		expect(confirmSpy).not.toHaveBeenCalled();

		// Destructive confirm button.
		const confirmBtn = screen.getByRole("button", { name: "Remove source" });
		expect(confirmBtn.className).toMatch(/danger/);
		confirmSpy.mockRestore();
	});

	it("cancel keeps the source (no removal invoke)", async () => {
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/sources",
		});
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove source…" }),
		);
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(removeArgs).toBeNull();
		// The source card is still present.
		expect(
			screen.getByRole("button", { name: "Remove source…" }),
		).toBeInTheDocument();
	});

	it("confirm fires the removal invoke with the unequip mode", async () => {
		const confirmSpy = vi.spyOn(window, "confirm");
		renderWithProviders(<Sources />, {
			client: makeQueryClient(),
			initialRoute: "/sources",
		});
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove source…" }),
		);
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "Remove source" }));

		await waitFor(() => expect(removeArgs).not.toBeNull());
		expect(removeArgs).toEqual([
			"source",
			"remove",
			"org-skills",
			"--mode",
			"unequip",
			"--json",
		]);
		expect(confirmSpy).not.toHaveBeenCalled();
		confirmSpy.mockRestore();
	});
});
