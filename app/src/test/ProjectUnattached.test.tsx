import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { StatusBar } from "@/components/StatusBar";
import type { Registry } from "@/types";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";
import {
	makeQueryClient,
	mockSyncReport,
	primeRegistry,
	renderWithProviders,
} from "./helpers";

// F1: a project restored on a different machine — the recorded path does not
// exist here, so `hub restore` (and, independently, a later `hub sync`) mark
// it `path_unresolved`. The sync report's own record still reports `ok:
// true, quarantined: <reason>` (skipping it is expected, not a failure).
const registry: Registry = {
	version: "1",
	hub_path: "~",
	skills: {},
	projects: {
		alpha: { path: "/restored/alpha", bundles: [], enabled: [], path_unresolved: true },
	},
	bundles: {},
} as unknown as Registry;

function quarantinedEnvelope(): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-09-23T18:11:14Z",
			registry_sha256: "same",
			registry_mtime: 0,
			ok: true,
			global: {
				skipped: [],
				skills: { writes: 0, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
			projects: {
				alpha: {
					ts: "2026-09-23T18:11:14Z",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [],
					quarantined: "path_unresolved (restored from a backup) — run `hub project edit-path <name> <path>`",
				},
			},
		},
		registry_current: { sha256: "same", mtime: 0 },
	};
}

describe("Project details: no local directory attached (F1/A6)", () => {
	it("keeps saved permissions reviewable before attachment", async () => {
		const client = makeQueryClient();
		primeRegistry(client, registry);
		client.setQueryData(["permissions", "project", "alpha"], {
			allow: [{ kind: "allow", pattern: "Read(saved-resource)", origin: "project" }],
			deny: [], ask: [], hooks: [], sandbox_mode: null, approval_policy: null,
			project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [],
		});
		renderWithProviders(<Routes><Route path="/project/:name" element={<ProjectWorkspace />} /></Routes>, {
			client, initialRoute: "/project/alpha?tab=permissions",
		});
		expect(await screen.findByDisplayValue("Read(saved-resource)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Save settings/i })).toBeInTheDocument();
		expect(screen.getByText(/Saved permissions remain in the loadout/)).toBeInTheDocument();
	});

	function renderAlpha(envelope: SyncReportEnvelope) {
		const client = makeQueryClient();
		primeRegistry(client, registry);
		mockSyncReport(envelope);
		client.setQueryData(["syncReport"], envelope);
		renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
				<Route path="/recovery" element={<div data-testid="recovery-stub">recovery</div>} />
			</Routes>,
			{ client, initialRoute: "/project/alpha" },
		);
		return client;
	}

	it("shows the unattached banner and never claims the project is in sync", async () => {
		renderAlpha(quarantinedEnvelope());
		expect(await screen.findByText(/No local directory attached\./)).toBeInTheDocument();
		expect(screen.getByText(/no directory attached/i)).toBeInTheDocument();
		// Never the healthy "in sync" verdict for a quarantined project.
		expect(screen.queryByText("in sync")).toBeNull();
	});

	it("Attach directory navigates to /recovery", async () => {
		renderAlpha(quarantinedEnvelope());
		await screen.findByText(/No local directory attached\./);
		await userEvent.click(screen.getByRole("button", { name: /Attach directory/i }));
		expect(screen.getByTestId("recovery-stub")).toBeInTheDocument();
	});

	it("shows no unattached banner for an ordinary attached project", async () => {
		const attached: Registry = {
			...registry,
			projects: { alpha: { path: "/restored/alpha", bundles: [], enabled: [] } },
		} as unknown as Registry;
		const client = makeQueryClient();
		primeRegistry(client, attached);
		mockSyncReport(null);
		client.setQueryData(["syncReport"], null);
		renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
			{ client, initialRoute: "/project/alpha" },
		);
		await screen.findByText("alpha");
		expect(screen.queryByText(/No local directory attached\./)).toBeNull();
	});
});

describe("StatusBar sync-report drawer: quarantined row (F1/F3)", () => {
	it("shows a 'no directory' pip and an Attach directory link, never counted as an error", async () => {
		const env = quarantinedEnvelope();
		const client = makeQueryClient();
		primeRegistry(client, registry);
		mockSyncReport(env);
		client.setQueryData(["syncReport"], env);
		renderWithProviders(
			<Routes>
				<Route path="*" element={<StatusBar />} />
				<Route path="/recovery" element={<div data-testid="recovery-stub">recovery</div>} />
			</Routes>,
			{ client },
		);

		await userEvent.click(screen.getByTitle("Show sync report"));
		const row = screen.getByText("alpha").closest(".srd-row-head") as HTMLElement;
		expect(row).not.toBeNull();
		expect(within(row).getByText("no directory")).toBeInTheDocument();
		expect(within(row).queryByText(/error/)).toBeNull();

		await userEvent.click(row);
		expect(
			screen.getByRole("button", { name: /Attach directory/i }),
		).toBeInTheDocument();
	});

	it("dedupes a missing-source error's symlink + invocation stages into one item (F3)", async () => {
		const env = quarantinedEnvelope();
		env.report.projects.alpha = {
			ts: "t",
			ok: false,
			errors: [
				{ stage: "symlink", message: "source missing: ~/.skill-hub/skills/diagnosing-bugs" },
				{
					stage: "invocation",
					message: "source missing: ~/.skill-hub/skills/diagnosing-bugs",
					skill: "diagnosing-bugs",
					harnesses: ["claude-code"],
				},
			],
			writes: 0,
			removed: 0,
			affinity_skips: [],
		};
		const client = makeQueryClient();
		primeRegistry(client, registry);
		mockSyncReport(env);
		client.setQueryData(["syncReport"], env);
		renderWithProviders(
			<Routes><Route path="*" element={<StatusBar />} /></Routes>,
			{ client },
		);

		await userEvent.click(screen.getByTitle("Show sync report"));
		const row = screen.getByText("alpha").closest(".srd-row-head") as HTMLElement;
		expect(within(row).getByText("1 error")).toBeInTheDocument();

		await userEvent.click(row);
		// One root-cause line, both raw stage diagnostics still inspectable.
		expect(screen.getAllByText(/source missing: ~\/\.skill-hub\/skills\/diagnosing-bugs/)).toHaveLength(1);
		expect(screen.getByText("symlink")).toBeInTheDocument();
		expect(screen.getByText("invocation")).toBeInTheDocument();
	});
});
