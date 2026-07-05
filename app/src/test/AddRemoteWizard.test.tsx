import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { AddRemoteWizard } from "@/components/remotes/AddRemoteWizard";
import { renderWithProviders } from "./helpers";

beforeEach(() => {
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		switch (cmd) {
			case "remote_fetch_host_key":
				return {
					fingerprint: "SHA256:TESTfingerprintTESTfingerprintTESTfinger00",
					detail: "host key fetched",
				};
			case "remote_setup_key":
			case "remote_add":
				return { success: true, output: "ok" };
			case "remote_diff":
				return { remote: "hermes-main", actions: [] };
			default:
				return undefined;
		}
	}) as never);
});

describe("AddRemoteWizard", () => {
	it("step 1 shows a selectable Hermes card and a disabled future-type placeholder", () => {
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		expect(screen.getByText("Hermes")).toBeInTheDocument();
		// The placeholder card is disabled (its button cannot be activated).
		const placeholder = screen.getByText("More connectors").closest("button")!;
		expect(placeholder).toBeDisabled();
		expect(screen.getByText("soon")).toBeInTheDocument();
	});

	it("Next is gated until a connector is picked", async () => {
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		expect(screen.getByRole("button", { name: /^Next$/i })).toBeDisabled();
		await userEvent.click(screen.getByText("Hermes"));
		expect(screen.getByRole("button", { name: /^Next$/i })).toBeEnabled();
	});

	it("the host-key step gates Next until the fingerprint is fetched AND confirmed", async () => {
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		// Step 1 → 2
		await userEvent.click(screen.getByText("Hermes"));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		// Step 2: fill endpoint
		await userEvent.type(
			screen.getByPlaceholderText("hermes-main"),
			"hermes-main",
		);
		await userEvent.type(
			screen.getByPlaceholderText("hermes@moon-base"),
			"hermes@moon-base",
		);
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));

		// Step 3: TOFU host-key — Next disabled until fetch + confirm.
		expect(screen.getByRole("button", { name: /^Next$/i })).toBeDisabled();
		await userEvent.click(
			screen.getByRole("button", { name: /Fetch host key/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_fetch_host_key", {
				host: "hermes@moon-base",
			}),
		);
		// Live fingerprint shown in `.remote-fpr`. No documented hint ships by
		// default (KNOWN_FINGERPRINTS is empty), so no eyeball-match line renders.
		await screen.findByText((_c, el) => el?.classList.contains("remote-fpr") ?? false);
		expect(screen.getAllByText(/SHA256:TESTfi/).length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText(/matches/i)).not.toBeInTheDocument();
		// Still gated until the confirm checkbox is ticked.
		expect(screen.getByRole("button", { name: /^Next$/i })).toBeDisabled();
		await userEvent.click(screen.getByRole("checkbox"));
		expect(screen.getByRole("button", { name: /^Next$/i })).toBeEnabled();
	});

	it("the credentials step runs the confirmed one-time ssh-copy-id", async () => {
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		await userEvent.click(screen.getByText("Hermes"));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		await userEvent.type(
			screen.getByPlaceholderText("hermes-main"),
			"hermes-main",
		);
		await userEvent.type(
			screen.getByPlaceholderText("hermes@moon-base"),
			"hermes@moon-base",
		);
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		await userEvent.click(
			screen.getByRole("button", { name: /Fetch host key/i }),
		);
		await screen.findByText((_c, el) => el?.classList.contains("remote-fpr") ?? false);
		await userEvent.click(screen.getByRole("checkbox"));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));

		// Step 4: credentials — run ssh-copy-id (the single box write).
		await userEvent.click(
			screen.getByRole("button", { name: /Run ssh-copy-id/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_setup_key", {
				sshHost: "hermes@moon-base",
			}),
		);
	});

	it("the final step registers the remote with the pinned key + runs a health check", async () => {
		const onCreated = vi.fn();
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={onCreated} />,
		);
		// Walk all the way through.
		await userEvent.click(screen.getByText("Hermes"));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		await userEvent.type(
			screen.getByPlaceholderText("hermes-main"),
			"hermes-main",
		);
		await userEvent.type(
			screen.getByPlaceholderText("hermes@moon-base"),
			"hermes@moon-base",
		);
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		await userEvent.click(
			screen.getByRole("button", { name: /Fetch host key/i }),
		);
		await screen.findByText((_c, el) => el?.classList.contains("remote-fpr") ?? false);
		await userEvent.click(screen.getByRole("checkbox"));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		// Step 4: confirm credentials.
		await userEvent.click(screen.getByRole("checkbox"));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		// Step 5: create.
		await userEvent.click(
			screen.getByRole("button", { name: /Create remote/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"remote_add",
				expect.objectContaining({
					id: "hermes-main",
					connector: "hermes",
					sshHost: "hermes@moon-base",
					hostKey: "SHA256:TESTfingerprintTESTfingerprintTESTfinger00",
				}),
			),
		);
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("hermes-main"));
	});
});
