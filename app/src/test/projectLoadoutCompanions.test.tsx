// ships-with wave 2, wave D — the project Loadout's `COMPANIONS_PENDING`
// banner (plans/2.md §Approach 10, D11/A16): pending `ships_with` companions
// read from the last sync report's `projects.<p>.companions` record — never a
// client-side prediction, the same evidence-based posture as
// `loadoutMissingRefs.test.tsx`'s missing-refs banner (same status-line +
// one-gate-routed-action LAYOUT). Milestone-6 review fixes (R13-R16):
// the noun counts every pending companion, never the skills that own them
// (R13); a pending name that resolves to no equipped skill still renders as
// a name-only line with no action, never silently dropped (R14); a companion
// name shared by two skills resolves to BOTH, never just the first — the
// current flat (not skill-grouped) I7 shape makes this the only honest read
// (R15); the banner is its OWN neutral `.companions-pending-banner` class,
// never the amber `.missing-refs-banner` — a pending provision is neither
// direct-equip provenance nor a risk severity (R16/A24).

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";
import type { ReconcileProjectRecord, ShipsWith } from "@/lib/companions";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";
import { makeQueryClient, primeRegistry, renderWithProviders } from "./helpers";

// Five companion-shipping skills to check that every name stays visible: `orch-direct`/`orch-c`/`orch-d`/`orch-e` are
// equipped via `project.enabled`; `orch-bundled` is reached ONLY via
// `companions-bundle` (W9/A22 — never appears in `enabled`). Each skill's
// companion NAMES are unique (`<id>-hook`/`<id>-agent`) — a shared name
// across skills would make the resolution test ambiguous on purpose, which
// is not what it is testing.
function shipsWithFor(id: string): ShipsWith {
	return {
		agents: [`${id}-agent`],
		hooks: [
			{
				name: `${id}-hook`,
				event: "PreToolUse",
				tools: [],
				command: "scripts/hook.sh",
				activation: "always",
			},
		],
		permissions: { allow: [], deny: [`Bash(${id}:*)`], ask: [] },
	};
}

function companionSkill(id: string, description: string) {
	return {
		version: "1.0.0",
		description,
		source: "",
		type: "claude-skill",
		scope: "portable",
		upstream: null,
		ships_with: shipsWithFor(id),
	};
}

// R15: two equipped skills that both declare a hook of the SAME name — the
// only way to exercise "a shared companion name resolves to every owning
// skill, not the first" against the CURRENT flat (not skill-grouped) I7
// shape (see the resolution comment below).
const SHARED_HOOK: ShipsWith = {
	hooks: [
		{
			name: "shared-hook",
			event: "PreToolUse",
			tools: [],
			command: "scripts/shared-hook.sh",
			activation: "always",
		},
	],
};

const registry = {
	version: "1",
	hub_path: "~",
	skills: {
		"orch-direct": companionSkill("orch-direct", "Direct companion skill"),
		"orch-bundled": companionSkill("orch-bundled", "Bundle-only companion skill"),
		"orch-c": companionSkill("orch-c", "Companion skill C"),
		"orch-d": companionSkill("orch-d", "Companion skill D"),
		"orch-e": companionSkill("orch-e", "Companion skill E"),
		"orch-shared-a": {
			version: "1.0.0",
			description: "Shares a hook name with orch-shared-b",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			ships_with: SHARED_HOOK,
		},
		"orch-shared-b": {
			version: "1.0.0",
			description: "Shares a hook name with orch-shared-a",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			ships_with: SHARED_HOOK,
		},
		plain: {
			version: "1.0.0",
			description: "Plain skill, no companions",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
		},
	},
	projects: {
		"moon-base": {
			path: "/moon-base",
			bundles: ["companions-bundle"],
			enabled: [
				"orch-direct",
				"orch-c",
				"orch-d",
				"orch-e",
				"orch-shared-a",
				"orch-shared-b",
				"plain",
			],
		},
	},
	bundles: {
		"companions-bundle": {
			description: "",
			icon: "📦",
			scope: "project-specific",
			skills: ["orch-bundled"],
		},
	},
	harnesses_global: ["claude-code"],
} as unknown as Registry;

function makeEnvelope(
	companions: ReconcileProjectRecord | undefined,
): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-09-05T00:00:00Z",
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
				"moon-base": {
					ts: "2026-09-05T00:00:00Z",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [],
					missing_refs: [],
					...(companions ? { companions } : {}),
				},
			},
		},
		registry_current: { sha256: "x", mtime: 0 },
	} as unknown as SyncReportEnvelope;
}

function record(pending: string[]): ReconcileProjectRecord {
	return { pending, stale_removed: [], reattached: [], drift: [], missing_refs: [] };
}

function renderMoonBase(envelope?: SyncReportEnvelope) {
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
	if (envelope) client.setQueryData(["syncReport"], envelope);
	return renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
		</Routes>,
		{ client, initialRoute: "/project/moon-base" },
	);
}

function argsOf(payload: unknown): string[] {
	return (payload as { args?: string[] } | undefined)?.args ?? [];
}

describe("Loadout COMPANIONS_PENDING banner (ships-with wave 2, wave D)", () => {
	it("renders no banner when the sync report carries no companions record", () => {
		renderMoonBase(makeEnvelope(undefined));
		expect(screen.queryByTestId("companions-pending-banner")).toBeNull();
	});

	it("renders no banner when the companions record has nothing pending", () => {
		renderMoonBase(makeEnvelope(record([])));
		expect(screen.queryByTestId("companions-pending-banner")).toBeNull();
	});

	it("names the pending skills and counts them, untruncated at or under three", () => {
		renderMoonBase(makeEnvelope(record(["orch-c", "orch-d"])));

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).toContain("2 pending companions");
		expect(banner.textContent).toContain("orch-c");
		expect(banner.textContent).toContain("orch-d");
		expect(banner.textContent).not.toContain("more");
		// The action provisions every named skill.
		expect(
			screen.getByRole("button", { name: "Provision all 2" }),
		).toBeInTheDocument();
	});

	it("shows every pending skill and offers a single Provision action", () => {
		renderMoonBase(
			makeEnvelope(
				record(["orch-direct", "orch-bundled", "orch-c", "orch-d", "orch-e"]),
			),
		);

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).toContain("5 pending companions");
		// Every affected skill remains inspectable.
		expect(banner.textContent).toContain("orch-bundled");
		expect(banner.textContent).toContain("orch-c");
		expect(banner.textContent).toContain("orch-d");
		expect(banner.textContent).toContain("orch-direct");
		expect(banner.textContent).toContain("orch-e");
		expect(
			screen.getByRole("button", { name: "Provision all 5" }),
		).toBeInTheDocument();
	});

	it("resolves a pending COMPANION name (not a skill name) back to its owning skill", () => {
		// `orch-direct-hook` is a hook orch-direct declares, not a skill in its
		// own right — the reconcile record is a flat list, not skill-grouped
		// (ships_with_reconcile.py's plan_reconcile). The banner must still
		// name the OWNING skill so `Provision` has a real one to call.
		renderMoonBase(makeEnvelope(record(["orch-direct-hook"])));

		expect(
			screen.getByRole("button", { name: "Provision orch-direct" }),
		).toBeInTheDocument();
	});

	it("R13: counts every pending companion, never the number of skills that own them", () => {
		// Three companions, one owning skill: the noun must read "3", not "1".
		renderMoonBase(
			makeEnvelope(
				record(["orch-direct-hook", "orch-direct-agent", "Bash(orch-direct:*)"]),
			),
		);

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).toContain("3 pending companions");
		expect(banner.textContent).toContain("orch-direct");
		// Only the resolved SKILL name is named in the sentence — not the raw
		// companion names, which would read as three unrelated items.
		expect(banner.textContent).not.toContain("orch-direct-hook");
		expect(
			screen.getByRole("button", { name: "Provision orch-direct" }),
		).toBeInTheDocument();
	});

	it("R14: never drops evidence — a pending name matching no equipped skill still renders, name-only", () => {
		renderMoonBase(makeEnvelope(record(["ghost-skill"])));

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).toContain("1 pending companion");
		expect(banner.textContent).toContain("ghost-skill");
		expect(banner.textContent).toContain("re-sync");
		// No real skill to call `equipWithGate` with — no action, ever.
		expect(screen.queryByRole("button", { name: /^Provision/ })).toBeNull();
	});

	it("R15: a companion name shared by two skills resolves to BOTH, not just the first", () => {
		renderMoonBase(makeEnvelope(record(["shared-hook"])));

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).toContain("orch-shared-a");
		expect(banner.textContent).toContain("orch-shared-b");
		expect(
			screen.getByRole("button", { name: "Provision all 2" }),
		).toBeInTheDocument();
	});

	it("R16: the banner is the neutral sibling class, never the amber missing-refs-banner", () => {
		renderMoonBase(makeEnvelope(record(["orch-c"])));

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner).toHaveClass("companions-pending-banner");
		expect(banner).not.toHaveClass("missing-refs-banner");
	});

	it("uses the singular wording and the skill's own name for one pending skill", () => {
		renderMoonBase(makeEnvelope(record(["orch-c"])));

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).toContain("1 pending companion");
		expect(banner.textContent).not.toContain("1 pending companions");
		expect(
			screen.getByRole("button", { name: "Provision orch-c" }),
		).toBeInTheDocument();
	});

	it("names the bundle-only consequence for a skill reached only via a bundle (W9/A22)", () => {
		renderMoonBase(makeEnvelope(record(["orch-bundled"])));

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).toContain("Bundle skills stay applied via bundle");
	});

	it("never mentions the bundle-only clause for a directly-equipped pending skill", () => {
		renderMoonBase(makeEnvelope(record(["orch-c"])));

		const banner = screen.getByTestId("companions-pending-banner");
		expect(banner.textContent).not.toContain("Bundle skills stay applied via bundle");
	});

	it("Provision is gate-routed: one plain `enable`, no --with-companions/--skill-only", async () => {
		renderMoonBase(makeEnvelope(record(["orch-c"])));

		fireEvent.click(screen.getByRole("button", { name: "Provision orch-c" }));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({
					args: ["enable", "orch-c", "--project", "moon-base", "--json"],
				}),
			),
		);

		// Never a raw force-flagged call — the consequence dialog is the
		// consent (A22/C1); `force` is reserved for the disable-undo replay.
		const enableCalls = vi
			.mocked(invoke)
			.mock.calls.filter(
				([cmd, payload]) => cmd === "hub_cmd" && argsOf(payload)[0] === "enable",
			);
		for (const [, payload] of enableCalls) {
			expect(argsOf(payload)).not.toContain("--with-companions");
			expect(argsOf(payload)).not.toContain("--skill-only");
		}
	});
});
