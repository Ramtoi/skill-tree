import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
} from "./helpers";

// A claude-only project with a codex-only skill equipped directly.
const registry = {
	version: "1",
	hub_path: "~",
	skills: {
		"codex-only": {
			version: "1.0.0",
			description: "Codex-only skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			harnesses: ["codex"],
		},
		portable1: {
			version: "1.0.0",
			description: "Portable skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
		},
	},
	projects: {
		alpha: { path: "/a", bundles: [], enabled: ["codex-only", "portable1"] },
	},
	bundles: {},
	harnesses_global: ["claude-code"],
} as unknown as Registry;

function renderAlpha(envelope?: SyncReportEnvelope) {
	useAppStore.setState({
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
			},
			{
				id: "codex",
				label: "Codex",
				installed: false,
				on_globally: false,
				used_by_projects: [],
			},
		],
	});
	const client = makeQueryClient();
	primeRegistry(client, registry);
	if (envelope) client.setQueryData(["syncReport"], envelope);
	renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
		</Routes>,
		{ client, initialRoute: "/project/alpha" },
	);
	return client;
}

describe("Affinity mismatch surfacing (M8)", () => {
	it("badges an equipped skill whose affinity excludes the project's effective harnesses", () => {
		renderAlpha();
		// codex-only won't sync (project effective = [claude-code]).
		expect(screen.getByText(/won't sync here/i)).toBeInTheDocument();
	});

	it("does not badge a skill with no affinity", () => {
		renderAlpha();
		// Only ONE badge — the codex-only one; portable1 has no affinity.
		expect(screen.getAllByText(/won't sync here/i)).toHaveLength(1);
	});

	it("shows the project banner when the sync report records affinity_skips", () => {
		const envelope: SyncReportEnvelope = {
			report: {
				schema_version: 1,
				generated_at: "",
				registry_sha256: "x",
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
						ts: "2026-07-01T00:00:00Z",
						ok: true,
						errors: [],
						writes: 0,
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
			registry_current: { sha256: "x", mtime: 0 },
		};
		renderAlpha(envelope);
		expect(screen.getByText(/won't reach any agent/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Configure harnesses/i }),
		).toBeInTheDocument();
	});

	it("shows no banner when the report has no affinity_skips", () => {
		renderAlpha();
		expect(screen.queryByText(/won't reach any agent/i)).toBeNull();
	});
});
