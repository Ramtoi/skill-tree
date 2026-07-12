import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { Routes, Route } from "react-router-dom";
import { RemotesScreen, invalidateRemotes } from "@/screens/RemotesScreen";
import { buildRemoteBundleTargets } from "@/hooks/useEquipTargets";
import { queryClient } from "@/lib/queryClient";
import { useAppStore } from "@/store";
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
		// Health is no longer probed eagerly — click the resting chip to run it.
		for (const c of screen.getAllByText("check health")) await userEvent.click(c);
		const chips = await screen.findAllByText("auth failed");
		expect(chips.length).toBeGreaterThan(0);
		expect(
			chips[0].closest(".remote-health-chip")?.getAttribute("data-tone"),
		).toBe("error");
	});

	it("does NOT fire a health probe on mount — chip rests on 'check health' until asked", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		await screen.findByText("hermes-main");
		// The expensive SSH probe must not run just because the list mounted (B1-01).
		expect(invoke).not.toHaveBeenCalledWith(
			"remote_health",
			expect.anything(),
		);
		// Every card shows an honest resting chip, never a fake "checking…".
		expect(screen.getAllByText("check health").length).toBeGreaterThan(0);
		expect(screen.queryByText("checking…")).not.toBeInTheDocument();
		// Clicking the chip explicitly triggers the probe.
		await userEvent.click(screen.getAllByText("check health")[0]);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_health", {
				id: "hermes-main",
			}),
		);
	});

	it("a danger doctor finding surfaces a risk banner on the list", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_list") return remoteList;
			if (cmd === "remote_doctor")
				return {
					findings: [
						{
							remote: "hermes-main",
							code: "host-key-mismatch",
							severity: "danger",
							detail:
								"live host key SHA256:X != pinned SHA256:Y — possible MITM",
						},
					],
					danger_count: 1,
				};
			return undefined;
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		await screen.findByText("hermes-main");
		const banner = await screen.findByTestId("remote-doctor-banner");
		expect(banner).toHaveAttribute("data-tone", "error");
		expect(within(banner).getByText(/attention/i)).toBeInTheDocument();
		// The affected remote is a jump link inside the banner.
		expect(within(banner).getByText("hermes-main")).toBeInTheDocument();
	});

	it("a clean doctor rollup shows no risk banner", async () => {
		// Default mock: remote_doctor → { findings: [], danger_count: 0 }.
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		await screen.findByText("hermes-main");
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_doctor"),
		);
		expect(screen.queryByTestId("remote-doctor-banner")).not.toBeInTheDocument();
	});

	it("a failed health probe reads a NEUTRAL 'check failed — retry' button that re-probes (F5)", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_list") return remoteList;
			if (cmd === "remote_health") throw new Error("ssh down");
			return undefined;
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		await screen.findByText("hermes-main");
		for (const c of screen.getAllByText("check health")) await userEvent.click(c);
		// The failed probe is a stable NEUTRAL chip — never a stuck "checking…".
		const chips = await screen.findAllByText(/check failed — retry/);
		expect(
			chips[0].closest(".remote-health-chip")?.getAttribute("data-tone"),
		).toBe("neutral");
		// It stays a BUTTON (not a dead-end span) so the user can retry.
		const retry = chips[0].closest("button");
		expect(retry).not.toBeNull();
		// Clicking it re-fires the health probe (was a dead end before F5).
		vi.mocked(invoke).mockClear();
		await userEvent.click(retry as HTMLElement);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_health", {
				id: "hermes-main",
			}),
		);
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

	it("surfaces the remote doctor findings section (filtered to this remote)", async () => {
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
				case "remote_list_docs":
					return { remote: "hermes-main", ok: true, docs: [] };
				case "remote_doctor":
					return {
						findings: [
							{
								remote: "hermes-main",
								code: "unresolved-drift",
								severity: "warning",
								detail: "2 artifact(s) drifted/conflicting and skipped",
							},
							{
								remote: "worker-pool",
								code: "host-key-mismatch",
								severity: "danger",
								detail: "possible MITM on another box",
							},
						],
						danger_count: 1,
					};
				default:
					return undefined;
			}
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		const section = await screen.findByTestId("remote-risks");
		// F1: the doctor is disabled on a cold detail open (cache empty here), so
		// the findings load only after the explicit Re-check trigger.
		await userEvent.click(
			within(section).getByRole("button", { name: /Re-check/i }),
		);
		// This remote's finding renders (code + human explanation)…
		expect(
			await within(section).findByText("unresolved-drift"),
		).toBeInTheDocument();
		expect(
			within(section).getByText(/drifted or conflicting/i),
		).toBeInTheDocument();
		// …and the OTHER remote's danger is filtered out of this detail.
		expect(
			within(section).queryByText("host-key-mismatch"),
		).not.toBeInTheDocument();
	});

	it("a cold detail open does NOT run the fleet-wide doctor; Re-check is the explicit trigger (F1)", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		// The doctor sweeps EVERY remote with ~3 SSH ops each — it must NOT fire
		// just because a detail page was deep-linked (the disabled query holds
		// whatever the list cached).
		expect(invoke).not.toHaveBeenCalledWith("remote_doctor");
		// The Risks section still renders, resting on an honest "not checked yet"
		// (a compact hint, not a spinner) so the trigger stays reachable.
		const section = screen.getByTestId("remote-risks");
		expect(
			within(section).getByTestId("remote-risks-unchecked"),
		).toBeInTheDocument();
		// Re-check is the explicit trigger → NOW it runs the doctor.
		await userEvent.click(
			within(section).getByRole("button", { name: /Re-check/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_doctor"),
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
		// Other controls are locked (busy) but must NOT show their own spinner —
		// only the clicked action animates. (Both the Risks + Sync-status sections
		// carry a Re-check now, so assert none of them spins.)
		for (const recheck of screen.getAllByRole("button", { name: /Re-check/i })) {
			expect(recheck).not.toHaveClass("is-loading");
		}

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

describe("RemotesScreen — detail header + loading affordances", () => {
	afterEach(() => {
		// Reset the global store's sync flag so one test's "syncing" doesn't leak.
		useAppStore.setState({ syncStatus: "idle" });
	});

	it("renders the Equip… button and the Global-skills toggle as a harmonized pair", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");

		const equip = screen.getByRole("button", { name: /Equip…/i });
		const toggle = screen.getByRole("button", { name: /Global skills off/i });
		// The action button is a standard `.btn`; the toggle is the bespoke pill.
		// They must live side-by-side in the SAME SectionHeader right slot so they
		// read as a pair.
		expect(equip).toHaveClass("btn");
		expect(toggle).toHaveClass("remote-applyglobal-toggle");
		const rightSlot = equip.closest(".section-right");
		expect(rightSlot).not.toBeNull();
		expect(rightSlot).toContainElement(toggle);
	});

	it("the connector tag + health chip sit in the header-right status cluster (not the title meta)", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		const chip = await screen.findByText("connected");
		const cluster = chip.closest(".remote-header-status");
		expect(cluster).not.toBeNull();
		// The cluster lives in the header-right column, centered with Force sync.
		expect(cluster!.closest(".main-header-right")).not.toBeNull();
		// The connector tag is a sibling in the same cluster.
		expect(within(cluster as HTMLElement).getByText(/hermes/i)).toBeInTheDocument();
	});

	it("shows a page-level loading state while the initial diff/health probe is pending", async () => {
		// Gate remote_diff so isLoading stays true and the loading UI is observable.
		let releaseDiff!: () => void;
		const diffGate = new Promise((res) => {
			releaseDiff = () => res(remoteDiff);
		});
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_diff" || cmd === "remote_health") return diffGate;
			if (cmd === "read_registry") return sampleRegistry;
			if (cmd === "remote_list") return remoteList;
			if (cmd === "remote_show") return remoteShow;
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

		// Health chip reads "checking…" (not a stale "unreachable") while pending.
		const chip = await screen.findByText("checking…");
		expect(chip.closest(".remote-health-chip")).toHaveAttribute("data-loading");
		// The Sync-status section shows a loading placeholder, not "No plan available".
		expect(
			screen.getByText(/Checking the box for drift/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/No plan available/i)).not.toBeInTheDocument();

		releaseDiff();
		expect(await screen.findByText("connected")).toBeInTheDocument();
		expect(
			screen.queryByText(/Checking the box for drift/i),
		).not.toBeInTheDocument();
	});

	it("reflects an in-flight GLOBAL sync with a subtle 'syncing…' indicator", async () => {
		useAppStore.setState({ syncStatus: "syncing" });
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		const syncing = await screen.findByText("syncing…");
		expect(syncing.closest(".remote-syncing-chip")).not.toBeNull();

		// When the global sync settles, the indicator disappears.
		act(() => useAppStore.setState({ syncStatus: "idle" }));
		await waitFor(() =>
			expect(screen.queryByText("syncing…")).not.toBeInTheDocument(),
		);
	});
});

// ─── R3/R4/R5/R8 — not-set-up classification + recovery actions ───────────────

const homeMissingHealth = {
	remote: "hermes-main",
	reachable: true,
	authenticated: true,
	host_key_match: true,
	ready: false,
	ok: false,
	detail_kind: "home_missing",
	detail: "connected, but ~/.hermes not found — is Hermes installed on this box?",
};

describe("RemotesScreen — not-set-up + recovery", () => {
	it("home-missing card chip reads a NEUTRAL 'not set up' (never red/amber)", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "remote_list") return remoteList;
			if (cmd === "remote_health") return homeMissingHealth;
			return undefined;
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<RemotesScreen />, { client, initialRoute: "/remotes" });
		await screen.findByText("hermes-main");
		for (const c of screen.getAllByText("check health")) await userEvent.click(c);
		const chips = await screen.findAllByText("not set up");
		expect(chips.length).toBeGreaterThan(0);
		expect(
			chips[0].closest(".remote-health-chip")?.getAttribute("data-tone"),
		).toBe("neutral");
	});

	it("home-missing detail shows a NEUTRAL banner with the Hermes-install hint and no dead-end key button", async () => {
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
					return homeMissingHealth;
				default:
					return undefined;
			}
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		// "not set up" appears in BOTH the header chip and the banner — target the
		// banner element specifically.
		await waitFor(() =>
			expect(
				document.querySelector(".remote-health-banner"),
			).not.toBeNull(),
		);
		const banner = document.querySelector(
			".remote-health-banner",
		) as HTMLElement;
		expect(banner.getAttribute("data-tone")).toBe("neutral");
		expect(banner.textContent).toMatch(/Hermes/i);
		// The box is already authenticated + key-matched, so "Install key on box"
		// (ssh-copy-id) would be a no-op dead end — it must NOT be offered here.
		expect(
			within(banner).queryByRole("button", { name: /Install key on box/i }),
		).toBeNull();
		// A non-dead-end recovery affordance (Re-check) stays reachable.
		expect(
			within(banner).getByRole("button", { name: /Re-check/i }),
		).toBeInTheDocument();
	});

	it("Re-pin refuses a differing pin, then re-invokes with yes after confirm", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string, args: unknown) => {
			const a = args as { yes?: boolean } | undefined;
			switch (cmd) {
				case "read_registry":
					return sampleRegistry;
				case "remote_list":
					return remoteList;
				case "remote_show":
					return remoteShow;
				case "remote_diff":
				case "remote_health":
					return remoteDiff; // ready
				case "remote_pin":
					return a?.yes
						? {
								remote: "hermes-main",
								pinned: true,
								changed: true,
								new_pin: "SHA256:NEWKEY",
							}
						: {
								remote: "hermes-main",
								refused: true,
								reason: "differing-pin",
								old_pins: ["SHA256:OLDKEY"],
								new_pin: "SHA256:NEWKEY",
							};
				default:
					return undefined;
			}
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		await userEvent.click(screen.getByRole("button", { name: /More actions/i }));
		await userEvent.click(await screen.findByText(/Re-pin host key/i));
		// First call WITHOUT yes → refused → a confirm dialog shows both fingerprints.
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_pin", {
				id: "hermes-main",
				yes: false,
			}),
		);
		expect(await screen.findByText("SHA256:OLDKEY")).toBeInTheDocument();
		expect(screen.getByText("SHA256:NEWKEY")).toBeInTheDocument();
		// Confirming re-invokes with yes:true.
		await userEvent.click(
			screen.getByRole("button", { name: /Re-pin \(I trust this key\)/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_pin", {
				id: "hermes-main",
				yes: true,
			}),
		);
	});

	it("Install key on box surfaces a persistent panel + copyable fallback on failure", async () => {
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
				case "remote_setup_key":
					return {
						success: false,
						output: "ssh-copy-id to hermes@moon-base failed: Permission denied.",
					};
				default:
					return undefined;
			}
		}) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedRemotes, {
			client,
			initialRoute: "/remote/hermes-main",
		});
		await screen.findByText("connected");
		await userEvent.click(screen.getByRole("button", { name: /More actions/i }));
		await userEvent.click(await screen.findByText(/Install key on box/i));
		expect(
			await screen.findByText(/Permission denied/i),
		).toBeInTheDocument();
		expect(
			screen.getByText("ssh-copy-id hermes@moon-base"),
		).toBeInTheDocument();
	});
});

// ─── F2 — remediation refreshes the doctor rollup ─────────────────────────────

describe("invalidateRemotes (F2)", () => {
	afterEach(() => queryClient.clear());

	it("marks the remote-doctor rollup stale so a remediation refreshes findings", async () => {
		// Seed the shared singleton client (the one invalidateRemotes targets).
		queryClient.setQueryData(["remote-doctor"], { findings: [], danger_count: 0 });
		queryClient.setQueryData(["remotes"], []);
		expect(
			queryClient.getQueryState(["remote-doctor"])?.isInvalidated,
		).toBe(false);

		await invalidateRemotes("hermes-main");

		// The doctor rollup is now invalidated (so the active list observer
		// refetches fresh findings after sync/resolve/re-pin) …
		expect(
			queryClient.getQueryState(["remote-doctor"])?.isInvalidated,
		).toBe(true);
		// … alongside the remotes + the per-remote keys it already touched.
		expect(queryClient.getQueryState(["remotes"])?.isInvalidated).toBe(true);
	});
});

// ─── B4b — remote equip bundle-count pluralization ────────────────────────────

describe("remote equip pluralization (B4b)", () => {
	it("a one-skill bundle reads '1 skill', not '1 skills'", () => {
		const registry = {
			...sampleRegistry,
			bundles: {
				essentials: {
					description: "",
					icon: "📦",
					scope: "project-specific",
					skills: ["brainstorm"],
				},
				android: sampleRegistry.bundles.android,
			},
		} as unknown as typeof sampleRegistry;
		const targets = buildRemoteBundleTargets({ bundles: [] }, registry);
		const essentials = targets.find((t) => t.id === "essentials")!;
		const android = targets.find((t) => t.id === "android")!;
		expect(essentials.meta).toBe("1 skill");
		expect(android.meta).toBe("2 skills");
	});
});
