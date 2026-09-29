import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { NavPanel } from "@/components/NavPanel";
import { StatusBar } from "@/components/StatusBar";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
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
	it("renders a dot data-state for each of the five states", () => {
		for (const state of ["fresh", "stale", "unknown", "error", "quarantined"] as Freshness[]) {
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
		// The panel is contextual: project rows render on the projects section.
		renderWithProviders(<NavPanel />, {
			client,
			initialRoute: "/project/example-app",
		});
		// The pin lives in a sibling button, so address the nav button itself.
		const row = document.querySelector(".side-item-main") as HTMLElement;
		expect(within(row).getByText("example-app")).toBeInTheDocument();
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
		expect(link).toBeEnabled();
  expect(screen.getByTitle("Open bundle core")).toBeInTheDocument();
		// …and NOT the amber direct marker (◆).
		expect(screen.queryByText("◆")).toBeNull();
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
		expect(screen.getByText(/won't reach\s+any harness/)).toBeInTheDocument();
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


it("does not call restored unattached projects in sync from an older healthy report", async () => {
  const env = drawerEnvelope();
  const prev = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) =>
    cmd === "sync_report" ? env : prev?.(cmd as never, args as never)) as never);
  const client = makeQueryClient();
  const registry: Registry = { version: "1", skills: {}, bundles: {}, projects: {
    "example-app": { path: "/historical/app", enabled: [], bundles: [], path_unresolved: true },
  }};
  primeRegistry(client, registry);
  client.setQueryData(["syncReport"], env);
  renderWithProviders(<StatusBar />, { client });
  expect(await screen.findByText("registry changed — re-sync")).toBeVisible();
  expect(screen.queryByText("registry · in sync")).not.toBeInTheDocument();
});

it("keeps a global sync failure visible when every project delivered", async () => {
  const env = drawerEnvelope();
  env.report.ok = false;
  env.report.global.permissions = { ok: false, errors: ["global permissions failed"] };
  const prev = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) =>
    cmd === "sync_report" ? env : prev?.(cmd as never, args as never)) as never);
  const client = makeQueryClient();
  primeRegistry(client);
  client.setQueryData(["syncReport"], env);
  renderWithProviders(<StatusBar />, { client });
  expect(await screen.findByText("registry · last sync failed")).toBeVisible();
});
