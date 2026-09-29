// PR3 unit C — the Loadout's per-card missing-refs badge and the
// `.missing-refs-banner` (plans/3-project.md §2 "The badge" / "The banner",
// §6 loadoutMissingRefs.test.tsx). Both surfaces read the evidence-based
// `missing_refs` finding from the last sync report — no client-side
// predictive twin (app/src/lib/missingRefs.ts).

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";
import type {
	MissingRef,
	SyncAffinitySkip,
	SyncReportEnvelope,
} from "@/lib/syncFreshness";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
} from "./helpers";

// One project ("moon-base", matching the plan's worked examples) with three
// equipped skills: a plain skill, a control with nothing wrong, and a
// codex-only skill that never reaches this claude-only project's harnesses
// (used to test the leading-slot priority when both badges apply).
const registry = {
	version: "1",
	hub_path: "~",
	skills: {
		"rt-android-expert": {
			version: "1.0.0",
			description: "Android compose planner",
			source: "~/skills/rt-android-expert",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
		},
		"first-ref": { scope: "portable", description: "First reference" },
		"second-ref": { scope: "portable", description: "Second reference" },
		portable1: {
			version: "1.0.0",
			description: "Portable skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
		},
		"codex-only": {
			version: "1.0.0",
			description: "Codex-only skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			harnesses: ["codex"],
		},
	},
	projects: {
		"moon-base": {
			path: "/moon-base",
			bundles: [],
			enabled: ["rt-android-expert", "portable1", "codex-only"],
		},
	},
	bundles: {},
	harnesses_global: ["claude-code"],
} as unknown as Registry;

function makeEnvelope(
	missingRefs: MissingRef[],
	affinitySkips: SyncAffinitySkip[] = [],
): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-09-04T00:00:00Z",
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
					ts: "2026-09-04T00:00:00Z",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: affinitySkips,
					missing_refs: missingRefs,
				},
			},
		},
		registry_current: { sha256: "x", mtime: 0 },
	} as unknown as SyncReportEnvelope;
}

function renderMoonBase(envelope?: SyncReportEnvelope) {
	const fallback = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(async (cmd, args) => {
		if (cmd === "read_registry") return registry;
		if (cmd === "sync_report") return envelope ?? null;
		return fallback?.(cmd, args);
	});
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
	return renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
		</Routes>,
		{ client, initialRoute: "/project/moon-base" },
	);
}

describe("Loadout missing-refs badge + banner (PR3 unit C)", () => {
	it("badges an equipped skill whose references are missing", () => {
		renderMoonBase(
			makeEnvelope([{ skill: "rt-android-expert", refs: ["needs-global"] }]),
		);

		const flaggedCard = screen
			.getByText("rt-android-expert")
			.closest(".project-loadout-row")!;
		const badge = flaggedCard.querySelector(".skill-missing-refs-badge");
		expect(badge).toBeInTheDocument();
		const title = badge!.getAttribute("title") ?? "";
		expect(title).toContain("needs-global");
		expect(title).toContain("moon-base");

		const cleanCard = screen.getByText("portable1").closest(".project-loadout-row")!;
		expect(cleanCard.querySelector(".skill-missing-refs-badge")).toBeNull();
	});

	it("keeps the affinity badge in the leading slot when both apply", () => {
		renderMoonBase(
			makeEnvelope([{ skill: "codex-only", refs: ["proof-it"] }]),
		);

		const card = screen.getByText("codex-only").closest(".project-loadout-row")!;
		// The affinity badge (more severe: this skill reaches no agent at all)
		// keeps the leading slot, which lives in the card's glyph cluster…
		expect(
			card.querySelector(".resource-badges .skill-affinity-badge"),
		).toBeInTheDocument();
		expect(
			card.querySelector(".resource-glyph .skill-missing-refs-badge"),
		).toBeNull();
		// …and the missing-refs badge is demoted into the ordinary badges slot.
		expect(
			card.querySelector(".resource-badges .skill-missing-refs-badge"),
		).toBeInTheDocument();
	});

	it("reviews references without writing and equips only the confirmed selection", async () => {
		const user = userEvent.setup();
		renderMoonBase(makeEnvelope([
			{ skill: "rt-android-expert", refs: ["first-ref", "second-ref"] },
			{ skill: "portable1", refs: ["first-ref"] },
		]));
		const writes = () => vi.mocked(invoke).mock.calls.filter(([cmd, args]) =>
			cmd === "hub_cmd" && (args as { args: string[] }).args[0] === "enable");
		await user.click(screen.getByRole("button", { name: "Review missing skills" }));
		const dialog = screen.getByRole("dialog", { name: "Missing skills" });
		expect(writes()).toHaveLength(0);
		expect(within(dialog).getAllByRole("checkbox", { name: "Select first-ref" })).toHaveLength(1);
		const firstRow = within(dialog).getByRole("checkbox", { name: "Select first-ref" }).closest(".missing-skills-row")!;
		expect(within(firstRow as HTMLElement).getByText("rt-android-expert", { selector: "strong" })).toBeInTheDocument();
		expect(within(firstRow as HTMLElement).getByText("~/skills/rt-android-expert/SKILL.md")).toBeInTheDocument();
		expect(within(firstRow as HTMLElement).getByText("portable1", { selector: "strong" })).toBeInTheDocument();
		expect(within(firstRow as HTMLElement).getByText("Source path unavailable")).toBeInTheDocument();
		expect(within(dialog).getByRole("button", { name: "Equip 0 selected skills" })).toBeDisabled();
		await user.click(within(dialog).getByRole("checkbox", { name: "Select second-ref" }));
		expect(writes()).toHaveLength(0);
		await user.click(within(dialog).getByRole("button", { name: "Equip 1 selected skill" }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual(["hub_cmd", { args: ["enable", "second-ref", "--project", "moon-base", "--skill-only"] }]);
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("cancels a selection without equipping", async () => {
		const user = userEvent.setup();
		renderMoonBase(makeEnvelope([{ skill: "portable1", refs: ["first-ref"] }]));
		await user.click(screen.getByRole("button", { name: "Review missing skills" }));
		await user.click(screen.getByRole("checkbox", { name: "Select first-ref" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Review missing skills" }));
		expect(screen.getByRole("checkbox", { name: "Select first-ref" })).not.toBeChecked();
	});

	it("keeps partial success out of retries and locks selection during a write", async () => {
		const user = userEvent.setup();
		renderMoonBase(makeEnvelope([{ skill: "portable1", refs: ["first-ref", "second-ref", "deleted-ref"] }]));
		const fallback = vi.mocked(invoke).getMockImplementation();
		const attempted: string[] = [];
		let release: (() => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (cmd, args) => {
			const argv = (args as { args?: string[] })?.args;
			if (cmd === "hub_cmd" && argv?.[0] === "enable") {
				attempted.push(argv[1]);
				if (attempted.length === 1) await new Promise<void>((resolve) => { release = resolve; });
				return attempted.length === 2 ? { success: false, output: "Write failed" } : { success: true, output: "" };
			}
			return fallback?.(cmd, args);
		});
		await user.click(screen.getByRole("button", { name: "Review missing skills" }));
		expect(screen.getByRole("checkbox", { name: "Select deleted-ref" })).toBeDisabled();
		await user.click(screen.getByRole("checkbox", { name: "Select all available skills" }));
		await user.click(screen.getByRole("button", { name: "Equip 2 selected skills" }));
		expect(screen.getByRole("checkbox", { name: "Select second-ref" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		release?.();
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("1 skill was equipped"));
		expect(screen.getByRole("checkbox", { name: "Select first-ref" })).toBeDisabled();
		expect(screen.getByRole("checkbox", { name: "Select second-ref" })).toBeChecked();
		await user.click(await screen.findByRole("button", { name: "Equip 1 selected skill" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(attempted).toEqual(["first-ref", "second-ref", "second-ref"]);
	});

	it("renders no banner and no badge for a clean project", () => {
		renderMoonBase(makeEnvelope([]));

		expect(document.querySelector(".missing-refs-banner")).toBeNull();
		expect(document.querySelector(".skill-missing-refs-badge")).toBeNull();
	});
});
