import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { Routes, Route } from "react-router-dom";
import { RemotesScreen } from "@/screens/RemotesScreen";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
} from "./helpers";

/** The detail view reads `useParams().id`, so detail tests must mount the
 *  component behind a matching route (mirrors the real HashRouter wiring). */
const RoutedRemotes = (
	<Routes>
		<Route path="/remotes" element={<RemotesScreen />} />
		<Route path="/remote/:id" element={<RemotesScreen />} />
	</Routes>
);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const remoteList = [
	{
		id: "hermes-main",
		connector: "hermes",
		sync_enabled: true,
		apply_global_bundles: false,
		ssh_host: "hermes@moon-base",
		bundles: ["openspec"],
		enabled: ["brainstorm"],
	},
	{
		id: "worker-pool",
		connector: "hermes",
		sync_enabled: false,
		apply_global_bundles: false,
		ssh_host: "hermes@worker-01",
		bundles: [],
		enabled: [],
	},
];

const remoteShow = {
	id: "hermes-main",
	connector: "hermes",
	ssh_host: "hermes@moon-base",
	host_key_pinned: true,
	secret_ref: "skill-hub:hermes-main",
	home: "~/.hermes",
	sync_enabled: true,
	apply_global_bundles: false,
	bundles: ["openspec"],
	enabled: ["brainstorm"],
	resolved_skills: ["brainstorm"],
};

const remoteDiff = {
	remote: "hermes-main",
	actions: [
		{ name: "brainstorm", kind: "skill", action: "noop", drift: "in-sync" },
		{
			name: "code-review",
			kind: "skill",
			action: "SKIP_remote_drifted",
			drift: "remote-drifted",
		},
		{
			name: "openspec-apply",
			kind: "skill",
			action: "SKIP_conflict",
			drift: "conflict",
		},
		{ name: "MEMORY.md", kind: "agent_doc", action: "noop", drift: "in-sync" },
	],
};

const remoteScan = {
	remote: "hermes-main",
	candidates: [
		{
			name: "curator-notes",
			ref: "skills/curator-notes",
			sha256: "aa11",
			category: "NEW",
			origin: "remote:hermes-main",
		},
	],
};

/** Wire invoke so the remote commands return the fixtures, recording calls. */
function mockRemotes(overrides: Record<string, unknown> = {}) {
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "remote_list":
				return remoteList;
			case "remote_show":
				return remoteShow;
			case "remote_diff":
			case "remote_health":
				return remoteDiff;
			case "remote_scan_imports":
				return remoteScan;
			case "remote_sync":
			case "remote_resolve":
			case "remote_disable":
			case "remote_enable":
			case "remote_set_apply_global":
			case "remote_remove":
			case "remote_clear":
			case "remote_import_skill":
			case "remote_add":
			case "remote_setup_key":
			case "remote_push_doc":
				return { success: true, output: "ok" };
			case "remote_list_docs":
				return {
					remote: "hermes-main",
					ok: true,
					docs: [
						{ name: "SOUL.md", present: true, sha256: "s", managed: false },
						{ name: "MEMORY.md", present: true, sha256: "m", managed: false },
						{ name: "USER.md", present: false, sha256: null, managed: false },
					],
				};
			case "remote_fetch_doc":
				return { doc: "MEMORY.md", ok: true, content: "doc body", sha256: "x" };
			case "remote_doctor":
				return { findings: [], danger_count: 0 };
			case "remote_fetch_host_key":
				return { fingerprint: "SHA256:test", detail: "host key fetched" };
			default:
				return undefined;
		}
	}) as never);
	Object.assign(globalThis, overrides);
}

beforeEach(() => {
	mockRemotes();
});

describe("RemotesScreen — list", () => {
	it("renders every registered remote with its sync state", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });

		expect(await screen.findByText("hermes-main")).toBeInTheDocument();
		expect(screen.getByText("worker-pool")).toBeInTheDocument();
		// One on, one off.
		expect(screen.getByText("sync on")).toBeInTheDocument();
		expect(screen.getByText("sync off")).toBeInTheDocument();
	});

	it("header counts 'configured' (honest, config-only) not 'connected'", async () => {
		mockRemotes();
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		expect(await screen.findByText("2 configured")).toBeInTheDocument();
	});

	it("each card surfaces a lazy health chip (never amber); auth-fail → error", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			switch (cmd) {
				case "remote_list":
					return remoteList;
				case "remote_health":
					// reachable but not authenticated → the error channel.
					return { reachable: true, authenticated: false, ok: false };
				default:
					return undefined;
			}
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		await screen.findByText("hermes-main");
		const chips = await screen.findAllByText("auth failed");
		expect(chips.length).toBeGreaterThan(0);
		expect(
			chips[0].closest(".remote-health-chip")?.getAttribute("data-tone"),
		).toBe("error");
	});

	it("a failed health probe reads 'check failed' (neutral), not a stuck 'checking…'", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_list") return remoteList;
			if (cmd === "remote_health") throw new Error("ssh down");
			return undefined;
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		await screen.findByText("hermes-main");
		const chips = await screen.findAllByText("check failed");
		expect(
			chips[0].closest(".remote-health-chip")?.getAttribute("data-tone"),
		).toBe("neutral");
	});

	it("shows an empty state with no remotes", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) =>
			cmd === "remote_list" ? [] : undefined) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		expect(await screen.findByText("No remotes yet")).toBeInTheDocument();
	});

	it("force-sync from a card invokes remote_sync with force", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		const card = (await screen.findByText("hermes-main")).closest(
			".remote-card",
		) as HTMLElement;
		await userEvent.click(
			within(card).getByRole("button", { name: /Force sync/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_sync", {
				id: "hermes-main",
				force: true,
			}),
		);
	});
});

describe("RemotesScreen — detail drift surface", () => {
	it("renders each drift status and the resolve actions for drifted artifacts", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});

		// Health chip (ready remote = connected).
		expect(await screen.findByText("connected")).toBeInTheDocument();
		// Drift badges for every status present.
		expect(screen.getByText("remote-drifted")).toBeInTheDocument();
		expect(screen.getByText("conflict")).toBeInTheDocument();
		expect(screen.getAllByText("in sync").length).toBeGreaterThan(0);
		// Drift callout counts the actionable artifacts (drifted + conflict = 2).
		expect(
			screen.getByText(/need.* a decision/i),
		).toBeInTheDocument();
	});

	it("a remote-drifted artifact offers Pull/Push/Keep-remote → remote_resolve", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");

		// Find the row for the drifted skill.
		const driftRow = screen.getByText("code-review").closest(".remote-drift-row")!;
		const pull = within(driftRow as HTMLElement).getByRole("button", {
			name: /Pull/i,
		});
		await userEvent.click(pull);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_resolve", {
				id: "hermes-main",
				artifact: "code-review",
				op: "pull",
				kind: "skill",
			}),
		);
	});

	it("a conflict artifact offers keep-local mapping to the keep-local op", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		const row = screen.getByText("openspec-apply").closest(".remote-drift-row")!;
		await userEvent.click(
			within(row as HTMLElement).getByRole("button", { name: /Keep local/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_resolve", {
				id: "hermes-main",
				artifact: "openspec-apply",
				op: "keep-local",
				kind: "skill",
			}),
		);
	});

	it("import candidates are provenance-labeled and adopt via remote_import_skill", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		// The import scan is LAZY — candidates don't load until the user clicks
		// "Scan for importable skills" (one on-demand SSH call).
		await userEvent.click(
			screen.getByRole("button", { name: /Scan for importable skills/i }),
		);
		expect(await screen.findByText("curator-notes")).toBeInTheDocument();
		expect(screen.getByText("remote:hermes-main")).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /^Import$/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_import_skill", {
				id: "hermes-main",
				name: "curator-notes",
			}),
		);
	});
});

describe("RemotesScreen — per-remote actions", () => {
	it("disable-sync from the overflow menu invokes remote_disable", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		// Open the overflow (kebab) menu.
		await userEvent.click(screen.getByRole("button", { name: /More actions/i }));
		await userEvent.click(
			await screen.findByText(/Disable auto-sync/i),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_disable", {
				id: "hermes-main",
			}),
		);
	});

	it("opening an agent doc shows a 'full file' size line so a small doc doesn't read as truncated", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		// remote_list_docs marks SOUL/MEMORY present; click the MEMORY.md tab.
		const tab = (await screen.findAllByText("MEMORY.md"))
			.map((n) => n.closest(".remote-doc-tab"))
			.find(Boolean) as HTMLElement;
		await userEvent.click(tab);
		// Fetched content is "doc body" (8 bytes, 1 line) → completeness line.
		const note = await screen.findByText(/full file/i);
		expect(note).toHaveTextContent(/8 B/);
		expect(note).toHaveTextContent(/1 line/);
	});

	it("'Global skills off' toggle invokes remote_set_apply_global(enabled=true)", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		// Fixture has apply_global_bundles=false → toggle reads "Global skills off".
		const toggle = await screen.findByRole("button", {
			name: /Global skills off/i,
		});
		await userEvent.click(toggle);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_set_apply_global", {
				id: "hermes-main",
				enabled: true,
			}),
		);
	});

	it("Force sync shows a spinner + disables itself while in-flight, sparing other buttons", async () => {
		// Gate remote_sync on a promise we control so the pending state is observable
		// (the default mock resolves instantly, flashing the spinner away).
		let release!: () => void;
		const gate = new Promise<{ success: boolean; output: string }>((res) => {
			release = () => res({ success: true, output: "ok" });
		});
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_sync") return gate;
			if (cmd === "read_registry") return sampleRegistry;
			if (cmd === "remote_list") return remoteList;
			if (cmd === "remote_show") return remoteShow;
			if (cmd === "remote_diff" || cmd === "remote_health") return remoteDiff;
			if (cmd === "remote_list_docs")
				return { remote: "hermes-main", ok: true, docs: [] };
			return undefined;
		}) as never);

		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		const sync = await screen.findByRole("button", { name: /Force sync/i });
		expect(sync).not.toHaveClass("is-loading");
		await userEvent.click(sync);

		// The clicked button spins + disables and relabels.
		const spinning = await screen.findByRole("button", { name: /Syncing/i });
		expect(spinning).toHaveClass("is-loading");
		expect(spinning).toBeDisabled();
		expect(spinning.querySelector(".lds-spinner")).toBeTruthy();
		// A different control is locked (busy) but must NOT show its own spinner —
		// only the clicked action animates.
		const recheck = screen.getByRole("button", { name: /Re-check/i });
		expect(recheck).not.toHaveClass("is-loading");

		release();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /Force sync/i }),
			).not.toHaveClass("is-loading"),
		);
	});

	it("resolving one drift row spins only that op, not the row's other actions", async () => {
		let release!: () => void;
		const gate = new Promise<{ success: boolean; output: string }>((res) => {
			release = () => res({ success: true, output: "ok" });
		});
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_resolve") return gate;
			if (cmd === "read_registry") return sampleRegistry;
			if (cmd === "remote_list") return remoteList;
			if (cmd === "remote_show") return remoteShow;
			if (cmd === "remote_diff" || cmd === "remote_health") return remoteDiff;
			if (cmd === "remote_list_docs")
				return { remote: "hermes-main", ok: true, docs: [] };
			return undefined;
		}) as never);

		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		const row = screen
			.getByText("code-review")
			.closest(".remote-drift-row") as HTMLElement;
		const pull = within(row).getByRole("button", { name: /Pull/i });
		const push = within(row).getByRole("button", { name: /Push/i });
		await userEvent.click(pull);

		await waitFor(() =>
			expect(within(row).getByRole("button", { name: /Pulling/i })).toHaveClass(
				"is-loading",
			),
		);
		// The sibling Push action in the SAME row must not spin.
		expect(push).not.toHaveClass("is-loading");

		release();
		await waitFor(() =>
			expect(within(row).getByRole("button", { name: /Pull/i })).not.toHaveClass(
				"is-loading",
			),
		);
	});

	it("remove asks for confirmation, then invokes remote_remove", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		await userEvent.click(screen.getByRole("button", { name: /More actions/i }));
		await userEvent.click(await screen.findByText(/Remove remote/i));
		// Confirm modal appears; the box is explicitly NOT touched (copy in modal).
		expect(
			await screen.findByText(/The remote box is/i),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_remove", {
				id: "hermes-main",
			}),
		);
	});
});
