import { it, expect, vi, beforeEach } from "vitest";
import { screen, within, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders } from "./helpers";
import { UsagePinnedSessionsRoute } from "@/screens/usage/UsagePinnedSessionsRoute";
import type { InspectionPin, InspectionScope } from "@/features/usage/usageInspectionTypes";

function scope(total: number): InspectionScope {
	return {
		tokens: { input: total, output: 0, cache_creation: 0, cache_read: 0, total, status: "available" },
		cost: { currency: "USD", value: 0, status: "known" },
		timing: { first_at: null, last_at: null, active_ms: 0, status: "observed" },
	};
}

// `/usage/pinned` has no test today.

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-router-dom")>();
	return { ...actual, useNavigate: () => navigateSpy };
});

function installPins(payload: {
	items?: InspectionPin[];
	evidence?: { status: "complete" | "partial"; notices: string[] };
}) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "hub_cmd") {
			const cmdArgs = ((args as { args?: string[] })?.args) ?? [];
			if (cmdArgs[0] === "usage" && cmdArgs[1] === "pin" && cmdArgs[2] === "list") {
				return {
					success: true,
					output: JSON.stringify({
						ok: true,
						schema_version: 1,
						items: payload.items ?? [],
						next_after: null,
						evidence: payload.evidence ?? { status: "complete", notices: [] },
					}),
				};
			}
		}
		return undefined;
	}) as never);
}

const ROOT_PIN: InspectionPin = {
	harness: "claude-code",
	session_id: "root-1",
	root_session_id: "root-1",
	run_id: null,
	root_type: "session",
	breadcrumb: [],
	status: "available",
	scopes: { own: scope(120), subtree: scope(340) },
};

const AGENT_PIN: InspectionPin = {
	harness: "codex",
	session_id: "child-1",
	root_session_id: "root-2",
	run_id: "run:9f3a1b2c",
	root_type: "agent",
	breadcrumb: [{ label: "Main session", status: "available" }],
	status: "available",
};

beforeEach(() => {
	navigateSpy.mockClear();
});

it("renders the pinned roots and agent subtrees from the mocked command payload", async () => {
	installPins({ items: [ROOT_PIN, AGENT_PIN] });
	renderWithProviders(<UsagePinnedSessionsRoute />);

	const items = await screen.findAllByRole("listitem");
	expect(items).toHaveLength(2);

	const rootItem = items.find((el) => within(el).queryByText("Pinned session"));
	expect(rootItem).toBeTruthy();
	expect(within(rootItem!).getByText(/claude-code · session · available/)).toBeVisible();
	expect(within(rootItem!).getByText(/Own 120/)).toBeVisible();
	expect(within(rootItem!).getByText(/Subtree 340/)).toBeVisible();

	const agentItem = items.find((el) => within(el).queryByText(/Agent ·/));
	expect(agentItem).toBeTruthy();
	expect(within(agentItem!).getByText(/Agent · run:9f3a/)).toBeVisible();
	expect(within(agentItem!).getByText(/codex · agent subtree · available/)).toBeVisible();
});

it("shows the breadcrumb trail for an agent pin and its Open parent control navigates to the root session", async () => {
	const multiCrumbAgent: InspectionPin = {
		...AGENT_PIN,
		breadcrumb: [
			{ label: "Main session", status: "available" },
			{ label: "Sub task", status: "available" },
		],
	};
	installPins({ items: [multiCrumbAgent] });
	renderWithProviders(<UsagePinnedSessionsRoute />);

	const nav = await screen.findByRole("navigation", { name: "Pinned session breadcrumb" });
	expect(within(nav).getByText("Main session")).toBeVisible();
	expect(within(nav).getByText("Sub task")).toBeVisible();

	fireEvent.click(within(nav).getByRole("button", { name: "Open parent" }));
	expect(navigateSpy).toHaveBeenCalledWith(
		`/usage/session/${encodeURIComponent(multiCrumbAgent.root_session_id)}?harness=${encodeURIComponent(multiCrumbAgent.harness)}`,
		expect.anything(),
	);
});

it("shows the unavailable-parent evidence state when the pins payload reports partial evidence", async () => {
	installPins({
		items: [ROOT_PIN],
		evidence: { status: "partial", notices: ["Some pinned sessions could not be read."] },
	});
	renderWithProviders(<UsagePinnedSessionsRoute />);

	const alert = await screen.findByText("Some pinned records are unavailable.");
	expect(alert.closest('[role="alert"]')).toBeVisible();
	expect(screen.getByText("Some pinned sessions could not be read.")).toBeVisible();
});
