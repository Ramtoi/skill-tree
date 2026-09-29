import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { Routes, Route } from "react-router-dom";
import App from "@/App";
import { RemoteDetail } from "@/components/remotes/RemoteDetail";
import { renderWithProviders, makeQueryClient, primeRegistry, sampleRegistry } from "./helpers";
import type { Registry } from "@/types";

// App calls getCurrentWindow() for fullscreen tracking — stub it for the one
// full-App-root test below (inert for everything else in this file).
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isFullscreen: () => Promise.resolve(false),
		onResized: () => Promise.resolve(() => {}),
		setFullscreen: () => Promise.resolve(),
	}),
}));

// B5 — "Skills on this remote": the merged Equipped + Sync-status + MCP
// sections. Fixtures below deliberately mirror mocks/tauriCore.ts's shape
// (union of 4 resolved skills + old-helper (orphan) + fs-mcp (mcp) = 6) but
// are LOCAL to this file per the harness contract — this suite must never
// depend on `mocks/tauriCore.ts` (owned by B2).

const registry: Registry = {
	...sampleRegistry,
	skills: {
		...sampleRegistry.skills,
		"deep-research": {
			version: "0.2.0",
			description: "Deep multi-source research.",
			source: "~/skill-hub/skills/deep-research",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "local",
		},
		"openspec-apply": {
			version: "0.5.0",
			description: "Implement tasks from an OpenSpec change end to end.",
			source: "~/skill-hub/skills/openspec-apply",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "local",
		},
		"code-review": {
			version: "1.2.0",
			description: "Review a diff for correctness and simplification.",
			source: "~/skill-hub/skills/code-review",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "local",
		},
	},
};

const remoteList = [
	{
		id: "hermes-main",
		connector: "hermes",
		sync_enabled: true,
		apply_global_bundles: false,
		ssh_host: "hermes@moon-base",
		bundles: [],
		enabled: ["brainstorm", "deep-research"],
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
	bundles: [],
	enabled: ["brainstorm", "deep-research"],
	resolved_skills: ["brainstorm", "deep-research", "openspec-apply", "code-review"],
};

// old-helper: tracked by the diff plan but NOT in the registry — the orphan
// case. fs-mcp: an mcp-server that IS in the registry (sampleRegistry) but
// not in resolved_skills — both must still surface in the merged list.
const remoteDiffFull = {
	remote: "hermes-main",
	actions: [
		{ name: "brainstorm", kind: "skill", action: "noop", drift: "in-sync" },
		{ name: "deep-research", kind: "skill", action: "fast_forward", drift: "local-ahead" },
		{ name: "code-review", kind: "skill", action: "SKIP_remote_drifted", drift: "remote-drifted" },
		{ name: "openspec-apply", kind: "skill", action: "SKIP_conflict", drift: "conflict" },
		{ name: "old-helper", kind: "skill", action: "remove", drift: "orphaned" },
		{ name: "fs-mcp", kind: "mcp", action: "fast_forward", drift: "local-ahead" },
		{ name: "MEMORY.md", kind: "agent_doc", action: "SKIP_remote_drifted", drift: "remote-drifted" },
		{ name: "SOUL.md", kind: "agent_doc", action: "noop", drift: "in-sync" },
	],
};

function mockRemotes(diff: unknown = remoteDiffFull) {
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		switch (cmd) {
			case "read_registry":
				return registry;
			case "remote_list":
				return remoteList;
			case "remote_show":
				return remoteShow;
			case "remote_diff":
			case "remote_health":
				return diff;
			case "remote_resolve":
				return { success: true, output: "ok" };
			case "remote_list_docs":
				return { remote: "hermes-main", ok: true, docs: [] };
			case "remote_doctor":
				return { findings: [], danger_count: 0 };
			default:
				return undefined;
		}
	}) as never);
}

const RoutedDetail = (
	<Routes>
		<Route
			path="/remote/:id"
			element={<RemoteDetail id="hermes-main" onBack={() => {}} />}
		/>
	</Routes>
);

function renderDetail() {
	const client = makeQueryClient();
	primeRegistry(client, registry);
	return renderWithProviders(RoutedDetail, { client, initialRoute: "/remote/hermes-main" });
}

describe("RemoteDetail — the merged 'Skills on this remote' list (B5)", () => {
	it("merges Equipped + Sync-status + MCP into one list — union of 6, no Sync status / MCP servers headers", async () => {
		mockRemotes();
		renderDetail();

		// "old-helper" only ever renders once the diff plan has loaded — the
		// honest way to wait for the union, not the section header (which
		// renders with the resolved-only count of 4 until then).
		expect(await screen.findByText("old-helper")).toBeInTheDocument();
		expect(screen.getByText("fs-mcp")).toBeInTheDocument();
		const section = screen.getByText("Skills on this remote");
		// REVIEW-B #9: a bare `getByText("6")` matches any lone "6" on the page —
		// scope it to this section header's own `.section-count`.
		expect(
			section.closest(".section-header")?.querySelector(".section-count")
				?.textContent,
		).toBe("6");
		expect(screen.queryByText("Sync status")).not.toBeInTheDocument();
		expect(screen.queryByText("MCP servers")).not.toBeInTheDocument();
		expect(section.closest(".remote-section")).not.toBeNull();
	});

	it("keeps a drifted row's resolve actions visible without hover; an in-sync row's stay hover-only", async () => {
		mockRemotes();
		renderDetail();
		await screen.findByText("old-helper");

		const drifted = screen.getByText("code-review").closest(".resource-row") as HTMLElement;
		expect(drifted).toHaveAttribute("data-drift", "needs-resolve");
		expect(within(drifted).getByRole("button", { name: /Pull/i })).toBeInTheDocument();

		const settled = screen.getByText("brainstorm").closest(".resource-row") as HTMLElement;
		expect(settled).not.toHaveAttribute("data-drift");
	});

	it("with actions:undefined no row carries a drift badge, and 'Drift plan unavailable' renders", async () => {
		mockRemotes({ remote: "hermes-main" }); // no `actions` key
		renderDetail();

		expect(await screen.findByText(/Drift plan unavailable/i)).toBeInTheDocument();
		const row = screen.getByText("brainstorm").closest(".resource-row") as HTMLElement;
		expect(row.querySelector(".status-badge")).toBeNull();
		// The rows are still there — a missing plan is a hint above the list, not
		// instead of it.
		expect(screen.getByText("code-review")).toBeInTheDocument();
	});

	it("with actions:[] every row reads in-sync, and 'Everything in sync' renders above the still-present rows", async () => {
		mockRemotes({ remote: "hermes-main", actions: [] });
		renderDetail();

		expect(await screen.findByText(/Everything in sync/i)).toBeInTheDocument();
		const row = screen.getByText("brainstorm").closest(".resource-row") as HTMLElement;
		expect(within(row).getByText("in sync")).toBeInTheDocument();
		expect(screen.getByText("code-review")).toBeInTheDocument();
	});

	it("the 'N artifacts need a decision' callout stays page-level and counts skills+MCP+docs (4)", async () => {
		mockRemotes();
		renderDetail();
		const callout = await screen.findByText(/need.*a decision/i);
		expect(callout.textContent).toMatch(/^4 artifacts/);
		// It renders ABOVE the merged section, not inside it.
		const section = screen.getByText("Skills on this remote").closest(".remote-section")!;
		expect(section.contains(callout)).toBe(false);
	});

	it("a remote unit shows a drift badge and none of the library's own badges", async () => {
		mockRemotes();
		renderDetail();
		await screen.findByText("old-helper");

		const row = screen.getByText("code-review").closest(".resource-row") as HTMLElement;
		expect(within(row).getByText("remote-drifted")).toBeInTheDocument();
		expect(row.querySelector(".equipped-pip")).toBeNull();
		expect(row.querySelector(".invocation-badge")).toBeNull();
		expect(row.querySelector('[title="Preview"]')).toBeNull();
	});
});

describe("RemoteDetail — resolve click never navigates (GRILL #3)", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	it("clicking Pull calls remote_resolve and leaves window.location.hash unchanged", async () => {
		window.location.hash = "#/remote/hermes-main";
		// The full app (real HashRouter) is the only way this assertion means
		// anything — `renderWithProviders`'s MemoryRouter never touches
		// `window.location`, so a click-sink regression there wouldn't move it
		// either way. Wrap (not replace) the suite-default mock so the
		// python/bootstrap gates the shell needs stay answered.
		const prev = vi.mocked(invoke).getMockImplementation();
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			switch (cmd) {
				case "read_registry":
					return registry;
				case "remote_list":
					return remoteList;
				case "remote_show":
					return remoteShow;
				case "remote_diff":
				case "remote_health":
					return remoteDiffFull;
				case "remote_resolve":
					return { success: true, output: "ok" };
				case "remote_list_docs":
					return { remote: "hermes-main", ok: true, docs: [] };
				case "remote_doctor":
					return { findings: [], danger_count: 0 };
				default:
					return prev?.(cmd as never, args as never);
			}
		}) as never);

		const client = makeQueryClient();
		primeRegistry(client, registry);
		render(
			<QueryClientProvider client={client}>
				<App />
			</QueryClientProvider>,
		);

		const row = await screen.findByText("code-review");
		const pull = within(row.closest(".resource-row") as HTMLElement).getByRole("button", {
			name: /Pull/i,
		});
		const before = window.location.hash;
		await userEvent.click(pull);

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("remote_resolve", {
				id: "hermes-main",
				artifact: "code-review",
				op: "pull",
				kind: "skill",
			}),
		);
		expect(window.location.hash).toBe(before);
	});
});
