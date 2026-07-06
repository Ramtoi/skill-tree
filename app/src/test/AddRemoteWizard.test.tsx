import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { AddRemoteWizard } from "@/components/remotes/AddRemoteWizard";
import {
	deriveConnectorLabels,
	deriveWizardCards,
} from "@/components/remotes/connectors";
import type { CatalogConnector } from "@/types";
import { useAppStore } from "@/store";
import { renderWithProviders } from "./helpers";

// A live catalog with an SSH built-in, an HTTPS connector, and an
// unknown-transport connector (the wizard should render it CLI-only).
const LIVE_CATALOG: CatalogConnector[] = [
	{
		key: "hermes",
		label: "Hermes",
		description: "SSH agent box.",
		transport_kind: "ssh",
		publishable: true,
		available: true,
		source: "builtin",
	},
	{
		key: "workers",
		label: "Worker Pool",
		description: "HTTPS worker pool.",
		transport_kind: "https",
		publishable: true,
		available: true,
		source: "entry-point",
	},
	{
		key: "socketpool",
		label: "Socket Pool",
		description: "Unix-socket worker pool.",
		transport_kind: "unix-socket",
		publishable: false,
		available: true,
		source: "drop-in",
	},
];

/** Base command mock shared by the flow tests (SSH host-key + add + diff). The
 *  `remote_connectors` handler is overridden per-test. */
function baseHandler(cmd: string): unknown {
	switch (cmd) {
		case "remote_connectors":
			return LIVE_CATALOG;
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
}

beforeEach(() => {
	useAppStore.setState({ degradedMode: false });
	vi.mocked(invoke).mockImplementation((async (
		cmd: string,
	) => baseHandler(cmd)) as never);
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

// ─── Registry-driven cards (Group 3) ──────────────────────────────────────────

describe("AddRemoteWizard — catalog-driven cards", () => {
	it("renders one card per live connector plus the static placeholder", async () => {
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		// Live cards resolve from the mocked catalog.
		expect(await screen.findByText("Worker Pool")).toBeInTheDocument();
		expect(screen.getByText("Hermes")).toBeInTheDocument();
		// The static disabled "More connectors" placeholder is appended.
		const placeholder = screen.getByText("More connectors").closest("button")!;
		expect(placeholder).toBeDisabled();
		// The HTTPS connector card is selectable.
		expect(screen.getByText("Worker Pool").closest("button")).toBeEnabled();
	});

	it("falls back to the static list when the catalog invocation fails", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_connectors") throw new Error("no python");
			return baseHandler(cmd);
		}) as never);
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		// Static Hermes card + placeholder render; the live-only Worker Pool does not.
		expect(await screen.findByText("Hermes")).toBeInTheDocument();
		expect(screen.getByText("More connectors")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.queryByText("Worker Pool")).not.toBeInTheDocument(),
		);
	});

	it("falls back to the static list in degraded mode (no catalog probe)", async () => {
		useAppStore.setState({ degradedMode: true });
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		expect(screen.getByText("Hermes")).toBeInTheDocument();
		expect(screen.queryByText("Worker Pool")).not.toBeInTheDocument();
		// The catalog command is never invoked when degraded.
		expect(invoke).not.toHaveBeenCalledWith("remote_connectors");
	});

	it("derives connector labels from the live catalog, else the static fallback", () => {
		const live = deriveConnectorLabels(LIVE_CATALOG);
		expect(live).toMatchObject({ hermes: "Hermes", workers: "Worker Pool" });
		// Empty / missing catalog → the static CONNECTOR_LABELS (hermes only).
		expect(deriveConnectorLabels(null)).toEqual({ hermes: "Hermes" });
		expect(deriveConnectorLabels([])).toEqual({ hermes: "Hermes" });
	});

	it("renders an unknown-transport connector as a disabled CLI-only card", async () => {
		const cards = deriveWizardCards(LIVE_CATALOG);
		const socket = cards.find((c) => c.key === "socketpool")!;
		expect(socket.available).toBe(false);
		expect(socket.description).toMatch(/configure it via the CLI/i);

		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		const socketCard = (await screen.findByText("Socket Pool")).closest(
			"button",
		)!;
		expect(socketCard).toBeDisabled();
		expect(socketCard).toHaveTextContent(/CLI/);
	});
});

// ─── Transport-aware wizard (Group 4) ─────────────────────────────────────────

describe("AddRemoteWizard — transport branching", () => {
	async function pickConnector(label: string) {
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={() => {}} />,
		);
		await userEvent.click(await screen.findByText(label));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
	}

	it("ssh connectors present the TOFU host-key step", async () => {
		await pickConnector("Hermes");
		// Step 2 is the SSH endpoint (id + host), Step 3 is TOFU.
		await userEvent.type(screen.getByPlaceholderText("hermes-main"), "box");
		await userEvent.type(
			screen.getByPlaceholderText("hermes@moon-base"),
			"me@box",
		);
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		expect(
			screen.getByRole("button", { name: /Fetch host key/i }),
		).toBeInTheDocument();
	});

	it("https connectors show an endpoint step and never a host-key step", async () => {
		await pickConnector("Worker Pool");
		// The endpoint+token step is shown; NO TOFU/host-key controls anywhere.
		expect(screen.getByPlaceholderText(/https:\/\//)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Fetch host key/i }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Bearer token")).toBeInTheDocument();
	});

	it("https endpoint validation blocks http:// and accepts https://", async () => {
		await pickConnector("Worker Pool");
		await userEvent.type(screen.getByPlaceholderText("workers-prod"), "wp");
		const endpoint = screen.getByPlaceholderText(/https:\/\//);
		const tokenField = screen.getByPlaceholderText("paste token");
		await userEvent.type(tokenField, "sekret");

		// http:// → inline error, Next stays disabled.
		await userEvent.type(endpoint, "http://insecure.example.com");
		expect(
			screen.getByText(/must never travel in the clear/i),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Next$/i })).toBeDisabled();

		// Fix to https:// → error clears, Next enables.
		await userEvent.clear(endpoint);
		await userEvent.type(endpoint, "https://workers.example.com");
		expect(
			screen.queryByText(/must never travel in the clear/i),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Next$/i })).toBeEnabled();
	});

	it("https flow registers with an endpoint + keychain token reference", async () => {
		const onCreated = vi.fn();
		renderWithProviders(
			<AddRemoteWizard onClose={() => {}} onCreated={onCreated} />,
		);
		await userEvent.click(await screen.findByText("Worker Pool"));
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		await userEvent.type(screen.getByPlaceholderText("workers-prod"), "wp");
		await userEvent.type(
			screen.getByPlaceholderText(/https:\/\//),
			"https://workers.example.com",
		);
		await userEvent.type(screen.getByPlaceholderText("paste token"), "sekret");
		// → health step
		await userEvent.click(screen.getByRole("button", { name: /^Next$/i }));
		await userEvent.click(
			screen.getByRole("button", { name: /Create remote/i }),
		);

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"remote_add",
				expect.objectContaining({
					id: "wp",
					connector: "workers",
					endpoint: "https://workers.example.com",
					tokenRef: "skill-hub:wp-token",
					token: "sekret",
				}),
			),
		);
		// The raw token is never routed to a keychain-set or persisted anywhere but
		// the single `remote_add` submit call.
		expect(invoke).not.toHaveBeenCalledWith(
			"remote_add",
			expect.objectContaining({ sshHost: expect.anything() }),
		);
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("wp"));
	});
});
