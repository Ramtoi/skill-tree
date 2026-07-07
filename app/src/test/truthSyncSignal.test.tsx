import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { NavPanel } from "@/components/NavPanel";
import { StatusBar } from "@/components/StatusBar";
import { CommandPalette } from "@/components/CommandPalette";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { BundleManager } from "@/screens/BundleManager";
import { useAppStore } from "@/store";
import type { Freshness, SyncReportEnvelope } from "@/lib/syncFreshness";
import type { Registry } from "@/types";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
} from "./helpers";

// ─── F3: FreshnessBadge renders each state ────────────────────────────────────
describe("FreshnessBadge", () => {
	it("renders a dot data-state for each of the four states", () => {
		for (const state of ["fresh", "stale", "unknown", "error"] as Freshness[]) {
			const { container, unmount } = renderWithProviders(
				<FreshnessBadge state={state} />,
			);
			const dot = container.querySelector(".fresh-dot");
			expect(dot?.getAttribute("data-state")).toBe(state);
			// Label present by default (kept even under reduced motion — only the
			// pulse is a CSS concern, which stale carries via data-state).
			expect(container.querySelector(".fresh-label")?.textContent?.length).toBeGreaterThan(0);
			unmount();
		}
	});

	it("omits the label when label={false}", () => {
		const { container } = renderWithProviders(
			<FreshnessBadge state="stale" label={false} />,
		);
		expect(container.querySelector(".fresh-label")).toBeNull();
		expect(container.querySelector('.fresh-dot[data-state="stale"]')).not.toBeNull();
	});
});

// ─── F7: NavPanel badge = resolved active-skill count ─────────────────────────
describe("NavPanel project badge", () => {
	beforeEach(() => {
		window.localStorage.removeItem("st:sb:pinned");
		window.localStorage.removeItem("st:sb:collapsed");
		useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
	});

	it("shows resolveActiveSkills().length (bundles ∪ enabled), not enabled+bundles", () => {
		const client = makeQueryClient();
		primeRegistry(client); // example-app: android bundle (2) ∪ brainstorm = 3
		renderWithProviders(<NavPanel />, { client });
		const row = screen.getByRole("button", { name: /example-app/i });
		expect(within(row).getByText("3")).toBeInTheDocument();
	});
});

// ─── F4: a global-bundle skill is via-bundle, not DIRECT ──────────────────────
const globalBundleRegistry: Registry = {
	version: "1",
	hub_path: "~/h",
	skills: {
		gskill: {
			version: "1.0.0",
			description: "Provided only by a global bundle.",
			source: "~/h/skills/gskill",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		},
	},
	projects: { p1: { path: "/p1", bundles: [], enabled: [] } },
	bundles: {
		core: {
			description: "Global core",
			icon: "🌍",
			scope: "global",
			skills: ["gskill"],
		},
	},
};

describe("ProjectWorkspace provenance", () => {
	function renderWorkspace(registry: Registry, route: string) {
		useAppStore.setState({
			harnesses: [
				{
					id: "claude-code",
					label: "Claude Code",
					installed: true,
					on_globally: true,
					used_by_projects: [],
				},
			],
		});
		const client = makeQueryClient();
		primeRegistry(client, registry);
		renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
			{ client, initialRoute: route },
		);
	}

	it("shows a global-bundle skill as via <bundle>, never as DIRECT", async () => {
		renderWorkspace(globalBundleRegistry, "/project/p1");
		await waitFor(() =>
			expect(screen.getByText("gskill")).toBeInTheDocument(),
		);
		// via-bundle link to the providing global bundle…
		const link = screen.getByRole("button", { name: "core" });
		expect(link).toHaveClass("via-bundle-link");
		// …and NOT the amber direct badge.
		expect(screen.queryByText("◆ DIRECT")).toBeNull();
		// Global bundle also surfaces in the read-only cluster.
		expect(screen.getByText(/Global · auto-applied/)).toBeInTheDocument();
	});
});

// ─── F8: StatusBar drawer per-project rows + affinity-skip line ───────────────
function drawerEnvelope(): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-07-05T14:32:10Z",
			registry_sha256: "same",
			registry_mtime: 1,
			ok: true,
			global: {
				skipped: [],
				skills: { writes: 1, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
			projects: {
				"example-app": {
					ts: "2026-07-05T14:32:10Z",
					ok: true,
					errors: [],
					writes: 4,
					removed: 0,
					affinity_skips: [
						{
							skill: "codex-only",
							skill_harnesses: ["codex"],
							project_harnesses: ["claude-code"],
						},
					],
				},
			},
		},
		registry_current: { sha256: "same", mtime: 1 },
	};
}

describe("StatusBar sync-report drawer", () => {
	it("opens on the chip, lists projects, and expands the affinity-skip line", async () => {
		const env = drawerEnvelope();
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) =>
			cmd === "sync_report" ? env : prev?.(cmd as never, args as never)) as never);
		const client = makeQueryClient();
		primeRegistry(client);
		client.setQueryData(["syncReport"], env);
		renderWithProviders(<StatusBar />, { client });

		await userEvent.click(screen.getByTitle("Show sync report"));
		expect(document.querySelector(".sync-report-drawer")).not.toBeNull();

		const row = screen.getByText("example-app").closest(".srd-row-head") as HTMLElement;
		expect(row).not.toBeNull();
		expect(within(row).getByText(/skipped/)).toBeInTheDocument();

		await userEvent.click(row);
		expect(screen.getByText(/won't reach any agent/)).toBeInTheDocument();
	});

	it("shows an honest empty state when no report exists", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		client.setQueryData(["syncReport"], null);
		renderWithProviders(<StatusBar />, { client });

		await userEvent.click(screen.getByTitle("Show sync report"));
		expect(screen.getByText(/No sync recorded yet/)).toBeInTheDocument();
	});
});

// ─── F9: BundleManager delete-confirm blast radius + keyboard remove ──────────
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

describe("BundleManager safety", () => {
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

	it("delete routes through a confirm naming projects + skills that deactivate", async () => {
		renderBundle();
		// Danger-zone delete button opens the confirm (not an un-guarded delete).
		await userEvent.click(screen.getByRole("button", { name: /Delete bundle…/ }));
		expect(screen.getByText(/Delete bundle "b1"\?/)).toBeInTheDocument();
		expect(screen.getByText(/will deactivate/)).toBeInTheDocument();
		expect(screen.getByText(/p1 → s1/)).toBeInTheDocument();
	});

	it("Backspace on a focused skill card removes it from the bundle", async () => {
		renderBundle();
		const card = document.querySelector(".bundle-skill-card") as HTMLElement;
		expect(card).not.toBeNull();
		expect(document.querySelectorAll(".bundle-skill-card").length).toBe(1);
		card.focus();
		fireEvent.keyDown(card, { key: "Backspace" });
		await waitFor(() =>
			expect(screen.getByText(/Empty bundle/)).toBeInTheDocument(),
		);
		expect(document.querySelectorAll(".bundle-skill-card").length).toBe(0);
	});
});

// ─── F10 → ux-command-layer: palette hints are now TRUE registry chords ───────
// Change 1 stripped fake chord hints because no chord system existed. With
// ux-command-layer the keymap registry exists, so an action with a registered
// chord shows its REAL, working hint (still honest: the shown keybind fires).
describe("CommandPalette honesty", () => {
	beforeEach(() => useAppStore.getState().closePalette());

	it("renders the true registry chord on wired actions and keeps informational hints", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<CommandPalette />, { client });
		useAppStore.getState().openPalette();
		await waitFor(() =>
			expect(document.querySelector(".palette")).not.toBeNull(),
		);

		// "New skill" now shows its real, backing chord (create.skill = "c s").
		const actionItem = screen
			.getByText("New skill")
			.closest(".palette-item") as HTMLElement;
		expect(actionItem.querySelector(".hint")?.textContent).toBe("c s");

		// A skill result still carries its informational hint (scope).
		const skillItem = screen
			.getByText("brainstorm")
			.closest(".palette-item") as HTMLElement;
		expect(skillItem.querySelector(".hint")?.textContent).toBe("global");

		useAppStore.getState().closePalette();
	});
});
