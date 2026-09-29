import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Route, Routes } from "react-router-dom";

import { CloudAppsSection } from "@/components/cloud/CloudAppsSection";
import { CloudTarget } from "@/screens/CloudTarget";
import { CLOUD_TARGET_CATALOG, driftCluster, parseHubJson } from "@/lib/cloud";
import { useAppStore } from "@/store";
import { renderWithProviders, sampleRegistry } from "./helpers";
import type { Registry } from "@/types";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(async () => undefined),
	revealItemInDir: vi.fn(async () => undefined),
}));

const NOTES = [
	"The ZIP must contain the skill folder as its root — `<skill>/SKILL.md`.",
	"MCP servers are NOT uploadable here: claude.ai only talks to REMOTE connectors.",
];

const TARGETS = [
	{
		id: "claude-ai",
		label: "claude.ai",
		upload_url: "https://claude.ai/customize/skills",
		upload_path: "Customize > Skills > + > Create skill (upload the .zip)",
		supports: ["skill"],
		notes: NOTES,
		equipped: 3,
		drift: { new: 1, changed: 1, up_to_date: 1, missing: 0, orphaned: 0 },
		last_exported: "2026-08-17T09:12:00",
	},
	{
		id: "chatgpt-web",
		label: "ChatGPT (web)",
		upload_url: "https://chatgpt.com",
		upload_path: "Plugins > Skills > Create > Upload from your computer",
		supports: ["skill"],
		notes: ["ChatGPT reads the same SKILL.md package format."],
		equipped: 0,
		drift: { new: 0, changed: 0, up_to_date: 0, missing: 0, orphaned: 0 },
		last_exported: null,
	},
];

const STATUS = {
	target: "claude-ai",
	label: "claude.ai",
	upload_url: "https://claude.ai/customize/skills",
	upload_path: "Customize > Skills > + > Create skill (upload the .zip)",
	last_exported: "2026-08-17T09:12:00",
	notes: NOTES,
	skills: [
		{
			skill: "brainstorm",
			status: "new",
			sha256: "sha-a",
			exported_sha256: null,
			exported_at: null,
			zip_name: "brainstorm.zip",
			lint: ["description is 214 chars — claude.ai truncates at 200"],
		},
		{
			skill: "rt-android-expert",
			status: "changed",
			sha256: "sha-b",
			exported_sha256: "sha-old",
			exported_at: "2026-08-12T18:40:00",
			zip_name: "rt-android-expert.zip",
			lint: [],
		},
		{
			skill: "android-compose-ui",
			status: "up_to_date",
			sha256: "sha-c",
			exported_sha256: "sha-c",
			exported_at: "2026-08-17T09:12:00",
			zip_name: "android-compose-ui.zip",
			lint: [],
		},
	],
	orphaned: [
		{
			skill: "legacy-widget",
			sha256: "sha-x",
			exported_at: "2026-07-30T11:05:00",
			zip_name: "legacy-widget.zip",
		},
	],
	unsupported: [{ skill: "fs-mcp", reason: "MCP server — cloud targets only accept skill ZIPs" }],
	summary: {
		equipped: 3,
		new: 1,
		changed: 1,
		up_to_date: 1,
		missing: 0,
		orphaned: 1,
		unsupported: 1,
		lint_warnings: 1,
	},
};

const EXPORT_RESULT = {
	target: "claude-ai",
	label: "claude.ai",
	upload_url: "https://claude.ai/customize/skills",
	upload_path: "Customize > Skills > + > Create skill (upload the .zip)",
	out_dir: "/Users/dev/.skill-hub/exports/claude-ai",
	results: [
		{
			skill: "brainstorm",
			zip_path: "/Users/dev/.skill-hub/exports/claude-ai/brainstorm.zip",
			sha256: "sha-a",
			files: 3,
			status_before: "new",
			lint: [],
		},
		{
			skill: "rt-android-expert",
			zip_path: "/Users/dev/.skill-hub/exports/claude-ai/rt-android-expert.zip",
			sha256: "sha-b",
			files: 5,
			status_before: "changed",
			lint: [],
		},
	],
	pruned: [],
	unsupported: [],
	errors: [],
	notes: NOTES,
};

const HARNESSES_WITH_DESKTOP = [
	{ id: "claude-code", label: "Claude Code", installed: true },
	{
		id: "codex",
		label: "Codex",
		installed: true,
		also_serves: ["ChatGPT desktop app"],
	},
];

const HARNESSES_PLAIN = [
	{ id: "claude-code", label: "Claude Code", installed: true },
	{ id: "codex", label: "Codex", installed: true },
];

/** The annotation present but the harness absent — ChatGPT.app on disk says
 *  nothing on its own, since an uninstalled codex writes no `~/.agents/skills`. */
const HARNESSES_DESKTOP_UNINSTALLED = [
	{ id: "claude-code", label: "Claude Code", installed: true },
	{
		id: "codex",
		label: "Codex",
		installed: false,
		also_serves: ["ChatGPT desktop app"],
	},
];

/** Registry with the `cloud:` block the detail screen reads for equip state. */
const cloudRegistry: Registry = {
	...sampleRegistry,
	cloud: { "claude-ai": { bundles: ["android"], enabled: ["brainstorm"] } },
};

interface HubCall {
	args: string[];
}

/** Route every `hub_cmd` the cloud surface makes; collect the argv for
 *  assertions and let anything else fall through to the setup.ts defaults. */
function mockCloudCli(overrides: {
	harnesses?: unknown;
	exportOk?: boolean;
	exportOutput?: string;
	equipOk?: boolean;
	statusOutput?: string;
} = {}) {
	const calls: HubCall[] = [];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return cloudRegistry;
		if (cmd !== "hub_cmd") return undefined;
		const argv = ((args as { args?: string[] })?.args ?? []) as string[];
		calls.push({ args: argv });
		if (argv[0] === "cloud" && argv[1] === "targets")
			return { success: true, output: JSON.stringify(TARGETS) };
		if (argv[0] === "cloud" && argv[1] === "status")
			return {
				success: true,
				output: overrides.statusOutput ?? JSON.stringify(STATUS),
			};
		if (argv[0] === "cloud" && argv[1] === "equip")
			return {
				success: overrides.equipOk !== false,
				output: overrides.equipOk === false ? "Unknown skill" : "{}",
			};
		if (argv[0] === "cloud" && argv[1] === "export")
			return {
				success: overrides.exportOk !== false,
				output:
					overrides.exportOutput ?? JSON.stringify(EXPORT_RESULT),
			};
		if (argv[0] === "harness" && argv[1] === "list")
			return {
				success: true,
				output: JSON.stringify(overrides.harnesses ?? HARNESSES_PLAIN),
			};
		return { success: true, output: "" };
	}) as never);
	return calls;
}

function renderDetail() {
	return renderWithProviders(
		<Routes>
			<Route path="/cloud/:id" element={<CloudTarget />} />
		</Routes>,
		{ initialRoute: "/cloud/claude-ai" },
	);
}

beforeEach(() => {
	useAppStore.setState({ toasts: [] });
	vi.mocked(openUrl).mockClear();
	vi.mocked(revealItemInDir).mockClear();
});

describe("cloud drift grammar", () => {
	it("maps every status to its own channel, and never to amber", async () => {
		const { CLOUD_STATUS_META } = await import("@/lib/cloud");
		expect(CLOUD_STATUS_META.up_to_date.channel).toBe("ok");
		expect(CLOUD_STATUS_META.new.channel).toBe("info");
		// `changed` is transitional → neutral + motion, NOT amber (amber is
		// provenance-only, COMPONENTS.md §Accents).
		expect(CLOUD_STATUS_META.changed.channel).toBe("neutral");
		expect(CLOUD_STATUS_META.changed.motion).toBe("pulse");
		expect(CLOUD_STATUS_META.missing.channel).toBe("neutral");
		expect(CLOUD_STATUS_META.orphaned.channel).toBe("neutral");
		expect(
			Object.values(CLOUD_STATUS_META).some((m) => m.channel === "warn"),
		).toBe(false);
		// The label never says "synced" — hub only knows the last export.
		expect(CLOUD_STATUS_META.up_to_date.label).toBe("up to date");
	});

	it("collapses an all-settled target to one badge and skips the zeros", () => {
		expect(
			driftCluster({ new: 0, changed: 0, up_to_date: 4, missing: 0, orphaned: 0 }, 4),
		).toEqual([{ status: "up_to_date", count: 4 }]);
		expect(
			driftCluster({ new: 2, changed: 1, up_to_date: 3, missing: 0, orphaned: 0 }, 6),
		).toEqual([
			{ status: "changed", count: 1 },
			{ status: "new", count: 2 },
		]);
		// Nothing equipped → no badge at all (the card says so in words).
		expect(
			driftCluster({ new: 0, changed: 0, up_to_date: 0, missing: 0, orphaned: 0 }, 0),
		).toEqual([]);
	});

	it("never lets an equipped-but-missing skill collapse to an empty cluster", () => {
		// The bug: `missing` was left out of the rollup, so a target whose one
		// equipped skill had lost its source dir rendered "equipped 1" beside
		// "Nothing equipped yet".
		expect(
			driftCluster({ new: 0, changed: 0, up_to_date: 0, missing: 1, orphaned: 0 }, 1),
		).toEqual([{ status: "missing", count: 1 }]);
	});

	it("parses a top-level ARRAY payload, which parseCliJson cannot", () => {
		expect(parseHubJson<{ id: string }[]>('warning: x\n[{"id":"claude-ai"}]')).toEqual([
			{ id: "claude-ai" },
		]);
	});
});

describe("Cloud apps section", () => {
	it("renders one card per target with its drift cluster", async () => {
		mockCloudCli();
		renderWithProviders(<CloudAppsSection />);

		expect(await screen.findByText("claude.ai")).toBeInTheDocument();
		expect(screen.getByText("ChatGPT (web)")).toBeInTheDocument();
		expect(screen.getByText("3 skills")).toBeInTheDocument();

		const drift = screen.getByTestId("cloud-drift-claude-ai");
		expect(drift).toHaveTextContent("1 changed");
		expect(drift).toHaveTextContent("1 new");

		// Nothing equipped reads as words, not a zero-count badge.
		expect(screen.getByTestId("cloud-drift-chatgpt-web")).toHaveTextContent(
			"Nothing equipped yet",
		);
	});

	it("shows the ChatGPT desktop card only when a harness also serves it", async () => {
		mockCloudCli({ harnesses: HARNESSES_WITH_DESKTOP });
		const { unmount } = renderWithProviders(<CloudAppsSection />);
		const card = await screen.findByTestId("chatgpt-desktop-card");
		expect(card).toHaveTextContent("Managed automatically via the Codex harness");
		expect(card).toHaveTextContent("~/.agents/skills");
		unmount();

		mockCloudCli({ harnesses: HARNESSES_PLAIN });
		renderWithProviders(<CloudAppsSection />);
		expect(await screen.findByText("claude.ai")).toBeInTheDocument();
		expect(screen.queryByTestId("chatgpt-desktop-card")).toBeNull();
	});

	it("hides the desktop card when the annotating harness is not installed", async () => {
		// An uninstalled harness writes nothing, so "managed automatically" would
		// be a flat lie — the worst failure mode this card has.
		mockCloudCli({ harnesses: HARNESSES_DESKTOP_UNINSTALLED });
		renderWithProviders(<CloudAppsSection />);
		expect(await screen.findByText("claude.ai")).toBeInTheDocument();
		expect(screen.queryByTestId("chatgpt-desktop-card")).toBeNull();
	});

	it("tells the user the ONE thing that reaches the desktop app", async () => {
		// It reads `~/.agents/skills`, the GLOBAL skills dir — a project equip
		// writes `<repo>/.agents/skills` and never lands there.
		mockCloudCli({ harnesses: HARNESSES_WITH_DESKTOP });
		renderWithProviders(<CloudAppsSection />);
		const card = await screen.findByTestId("chatgpt-desktop-card");
		expect(card).toHaveTextContent("scope: global");
		expect(card).toHaveTextContent("<repo>/.agents/skills");
		expect(card).not.toHaveTextContent("Equip skills through a project, not here");
	});

	it("puts the last export on the card, and says `never` when there is none", async () => {
		mockCloudCli();
		renderWithProviders(<CloudAppsSection />);
		await screen.findByText("claude.ai");
		const claude = screen.getByTestId("cloud-last-exported-claude-ai");
		expect(claude).not.toHaveTextContent("never");
		// The raw stamp stays on hover; the glance gets a relative time.
		expect(claude).toHaveAttribute("title", "2026-08-17T09:12:00");
		expect(screen.getByTestId("cloud-last-exported-chatgpt-web")).toHaveTextContent(
			"never",
		);
	});

	it("gives cloud its own glyph instead of borrowing scope.global's globe", async () => {
		const { ICONS } = await import("@/components/icons");
		expect(ICONS.cloud).toBeDefined();
		expect(ICONS.cloud).not.toBe(ICONS.globe);
	});
});

describe("Cloud target detail", () => {
	it("lists each equipped skill with its badge and surfaces lints inline", async () => {
		mockCloudCli();
		renderDetail();

		const list = await screen.findByTestId("cloud-skill-list");
		expect(list).toHaveTextContent("brainstorm");
		expect(list).toHaveTextContent("new");
		expect(list).toHaveTextContent("changed");
		expect(list).toHaveTextContent("up to date");
		// The lint is advisory: rendered as text on the row, blocking nothing.
		expect(list).toHaveTextContent(
			"description is 214 chars — claude.ai truncates at 200",
		);
		// Orphans and refused entries get their own honest sections.
		expect(screen.getByText("legacy-widget")).toBeInTheDocument();
		expect(screen.getByText("fs-mcp")).toBeInTheDocument();
		// The product's limits are quoted verbatim from the backend.
		expect(screen.getByTestId("cloud-notes")).toHaveTextContent(
			"MCP servers are NOT uploadable here",
		);
		// A `new` row must NOT also spell "never exported": the badge already
		// says it, and the duplicate cost the row its meta slot.
		expect(list).not.toHaveTextContent("never exported");
	});

	/**
	 * B6 — with nothing equipped, "Export & open …" exports nothing, and left
	 * live it visually outranked the one action that actually moves the user
	 * forward. It must be inert AND say why, with equip carrying the screen.
	 */
	it("holds the export primary shut at zero equipped, and says why", async () => {
		mockCloudCli({
			statusOutput: JSON.stringify({
				...STATUS,
				skills: [],
				orphaned: [],
				unsupported: [],
				summary: {
					equipped: 0,
					new: 0,
					changed: 0,
					up_to_date: 0,
					missing: 0,
					orphaned: 0,
					unsupported: 0,
					lint_warnings: 0,
				},
			}),
		});
		renderDetail();

		const primary = await screen.findByTestId("cloud-export");
		await waitFor(() =>
			expect(primary).toHaveAttribute("aria-disabled", "true"),
		);
		// Soft-disabled: still discoverable, and the reason is on the control.
		expect(primary).toHaveAttribute(
			"title",
			expect.stringContaining("Equip a bundle or a skill first"),
		);

		// Clicking it does nothing — no export command leaves the screen.
		fireEvent.click(primary);
		expect(useAppStore.getState().toasts).toHaveLength(0);

		// The equip CTA is the live next step.
		const equip = screen.getByRole("button", { name: /Equip bundles or skills/i });
		expect(equip).not.toHaveAttribute("aria-disabled", "true");
	});

	it("keeps the manual upload step on the screen, not only in a toast", async () => {
		mockCloudCli();
		renderDetail();

		// Export throws the user out to Finder and a browser tab, so the one step
		// hub cannot perform has to survive that round trip.
		const howto = await screen.findByTestId("cloud-howto");
		expect(howto).toHaveTextContent("Upload each ZIP yourself");
		expect(howto).toHaveTextContent(
			"Customize > Skills > + > Create skill (upload the .zip)",
		);
		expect(howto).toHaveTextContent("has no API to sync into");
	});

	it("equips a skill through `hub cloud equip` with the target's argv", async () => {
		const calls = mockCloudCli();
		renderDetail();

		fireEvent.click(await screen.findByRole("button", { name: /Equip…/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Skills" }));

		// `brainstorm` sits in the target's `enabled` list → a direct, toggleable
		// edge (a via-bundle skill is read-only and would offer no toggle).
		const toggle = await screen.findByLabelText(/Unequip claude.ai brainstorm/);
		fireEvent.click(toggle);

		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c.args.join(" ") ===
						"cloud equip claude-ai --kind skill --name brainstorm --state off",
				),
			).toBe(true),
		);
	});

	it("equips a bundle with --kind bundle", async () => {
		const calls = mockCloudCli();
		renderDetail();

		fireEvent.click(await screen.findByRole("button", { name: /Equip…/ }));
		const toggle = await screen.findByLabelText(/Unequip claude.ai android/);
		fireEvent.click(toggle);

		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c.args.join(" ") ===
						"cloud equip claude-ai --kind bundle --name android --state off",
				),
			).toBe(true),
		);
	});

	it("exports, then opens the upload page and reveals the export folder", async () => {
		const calls = mockCloudCli();
		renderDetail();

		// Wait for the status to land so the primary is live (it stays inert only
		// once we KNOW nothing is equipped).
		await screen.findByTestId("cloud-skill-list");
		const primary = screen.getByTestId("cloud-export");
		expect(primary).toHaveTextContent("Export & open claude.ai");
		fireEvent.click(primary);

		await waitFor(() =>
			expect(
				calls.some((c) => c.args.join(" ") === "cloud export claude-ai --json"),
			).toBe(true),
		);
		await waitFor(() =>
			// A built ZIP, never the folder: a revealed folder is what the user
			// drags, and claude.ai rejects a directory ("must have a .zip ext").
			expect(revealItemInDir).toHaveBeenCalledWith(
				"/Users/dev/.skill-hub/exports/claude-ai/brainstorm.zip",
			),
		);
		expect(openUrl).toHaveBeenCalledWith("https://claude.ai/customize/skills");

		// One info toast summarising the count and where the ZIPs landed.
		await waitFor(() => {
			const toasts = useAppStore.getState().toasts;
			expect(toasts.some((t) => t.title === "Exported 2 skills for claude.ai")).toBe(
				true,
			);
			expect(
				toasts.some((t) =>
					(t.body ?? "").includes("/Users/dev/.skill-hub/exports/claude-ai"),
				),
			).toBe(true);
		});
		// Reversible + cheap: nothing asks for confirmation.
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("reports a failed export as an error toast and opens nothing", async () => {
		mockCloudCli({ exportOk: false, exportOutput: "no such target" });
		renderDetail();

		await screen.findByTestId("cloud-skill-list");
		fireEvent.click(screen.getByTestId("cloud-export"));
		await waitFor(() =>
			expect(
				useAppStore
					.getState()
					.toasts.some((t) => t.title === "Couldn't export to claude.ai"),
			).toBe(true),
		);
		expect(openUrl).not.toHaveBeenCalled();
		expect(revealItemInDir).not.toHaveBeenCalled();
	});

	it("reports a PARTIAL export honestly, in one toast", async () => {
		// The CLI now exits non-zero when `errors` is non-empty but still prints
		// the full payload, so the payload — not the exit code — decides the copy.
		// The old path fired a green "Exported 1 skill" and then an error toast
		// underneath it: two toasts contradicting each other.
		mockCloudCli({
			exportOk: false,
			exportOutput: JSON.stringify({
				...EXPORT_RESULT,
				results: [EXPORT_RESULT.results[0]],
				errors: ["rt-android-expert: Permission denied"],
			}),
		});
		renderDetail();

		await screen.findByTestId("cloud-skill-list");
		fireEvent.click(screen.getByTestId("cloud-export"));

		await waitFor(() => {
			const toasts = useAppStore.getState().toasts;
			expect(
				toasts.some((t) => t.title === "Exported 1 of 2 skills for claude.ai"),
			).toBe(true);
			expect(toasts.some((t) => (t.body ?? "").includes("Permission denied"))).toBe(
				true,
			);
		});
		// Exactly one toast, and it is NOT the success one.
		expect(useAppStore.getState().toasts).toHaveLength(1);
		expect(
			useAppStore
				.getState()
				.toasts.some((t) => t.title === "Exported 1 skill for claude.ai"),
		).toBe(false);
		// Something WAS built, so the folder + upload page are still worth opening.
		await waitFor(() => expect(revealItemInDir).toHaveBeenCalled());
	});

	it("does not throw the user at an empty folder when nothing built", async () => {
		mockCloudCli({
			exportOk: false,
			exportOutput: JSON.stringify({
				...EXPORT_RESULT,
				results: [],
				errors: ["brainstorm: source directory not found: /gone"],
			}),
		});
		renderDetail();

		await screen.findByTestId("cloud-skill-list");
		fireEvent.click(screen.getByTestId("cloud-export"));

		await waitFor(() =>
			expect(
				useAppStore
					.getState()
					.toasts.some((t) => t.title === "Couldn't export to claude.ai"),
			).toBe(true),
		);
		expect(revealItemInDir).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
	});

	it("gives orphans their own section, with the ZIP the next export deletes", async () => {
		mockCloudCli();
		renderDetail();

		await screen.findByTestId("cloud-skill-list");
		const orphan = screen.getByText("legacy-widget").closest(".cloud-skill-row");
		expect(orphan).not.toBeNull();
		expect(orphan).toHaveTextContent("legacy-widget.zip");
		expect(orphan).toHaveTextContent("orphaned");
		// The half hub cannot do is stated, not implied: deleting our ZIP does
		// not remove the skill from the product.
		expect(
			screen.getByText(/remove them inside claude.ai yourself/),
		).toBeInTheDocument();
	});

	it("banners an unreadable export-state sidecar instead of lying about drift", async () => {
		// Fail-open: a corrupt sidecar reads as empty, so every skill reports
		// `new`. That is only honest if the screen says WHY.
		const warning =
			"export state at /Users/dev/.skill-hub/state/cloud/claude-ai.json was unreadable and was treated as empty — every skill reads as `new`.";
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "read_registry") return cloudRegistry;
			if (cmd !== "hub_cmd") return undefined;
			const argv = ((args as { args?: string[] })?.args ?? []) as string[];
			if (argv[1] === "targets")
				return { success: true, output: JSON.stringify(TARGETS) };
			if (argv[1] === "status")
				return {
					success: true,
					output: JSON.stringify({ ...STATUS, warnings: [warning] }),
				};
			return { success: true, output: "" };
		}) as never);
		const { container } = renderDetail();

		await screen.findByTestId("cloud-skill-list");
		const banner = container.querySelector(".cloud-warning");
		expect(banner).not.toBeNull();
		expect(banner).toHaveTextContent("was unreadable and was treated as empty");
	});
});

describe("cloud catalog", () => {
	it("mirrors the two fixed backend targets (palette entries derive from it)", () => {
		expect(CLOUD_TARGET_CATALOG.map((t) => t.id)).toEqual([
			"claude-ai",
			"chatgpt-web",
		]);
	});
});
