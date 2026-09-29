import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import {
	Sources,
	computeSourceImpact,
	syncSummary,
	bundleUpdateLines,
} from "@/screens/Sources";
import type { GitSourceConfig, Registry } from "@/types";

// ─── Fixture ────────────────────────────────────────────────────────────────
// Four git sources, one of each interesting state, plus a second external skill
// so counts/sort have something to order. Built on sampleRegistry so the shared
// local skills + the `android` bundle stay in play.

// A spy left installed by a failed assertion earlier in this file must not
// leak into the next test (TA-1-d9f4 / R7).
afterEach(() => {
	vi.restoreAllMocks();
});

const multiSource: Registry = {
	...sampleRegistry,
	skills: {
		...sampleRegistry.skills,
		"design-token-lint": {
			version: "2.1.0",
			description: "External: design-token lint rules.",
			source: "~/.skill-hub/sources/design-system/worktree/skills/design-token-lint",
			type: "claude-skill",
			scope: "portable",
			upstream: "git@github.com:acme/design-system.git",
			managed: "external",
			origin: {
				source: "design-system",
				source_type: "git",
				path: "skills/design-token-lint",
				ref: "5f1c0aa",
			},
		},
		"design-token-docs": {
			version: "2.1.0",
			description: "External: design-token reference.",
			source: "~/.skill-hub/sources/design-system/worktree/skills/design-token-docs",
			type: "claude-skill",
			scope: "portable",
			upstream: "git@github.com:acme/design-system.git",
			managed: "external",
			origin: {
				source: "design-system",
				source_type: "git",
				path: "skills/design-token-docs",
				ref: "5f1c0aa",
			},
		},
	},
	sources: {
		"org-skills": {
			type: "git",
			name: "Org Skills",
			url: "git@github.com:org/skills.git",
			branch: "main",
			path: "skills",
			status: "update-available",
			current_ref: "abc123",
			remote_ref: "def456",
			last_synced_at: "2026-05-21T16:38:00Z",
			error: null,
		},
		"design-system": {
			type: "git",
			name: "Design System",
			url: "git@github.com:acme/design-system.git",
			branch: "main",
			status: "up-to-date",
			last_synced_at: "2026-05-22T09:00:00Z",
			error: null,
		},
		"partner-skills": {
			type: "git",
			name: "Partner Skills",
			url: "git@github.com:partner/agent-skills.git",
			status: "error",
			last_synced_at: "2026-04-01T09:00:00Z",
			error: "git fetch failed: Permission denied (publickey).",
		},
		"legacy-pack": {
			type: "git",
			name: "Legacy Pack",
			enabled: false,
			url: "git@github.com:me/legacy-skills.git",
			status: "up-to-date",
			last_synced_at: "2026-03-01T09:00:00Z",
			error: null,
		},
	},
};

/** Same fixture plus a bundle that FOLLOWS `design-system` — its membership is
 *  the source's to decide, so hand-editing it must be refused in the UI. */
const linkedRegistry: Registry = {
	...multiSource,
	bundles: {
		...multiSource.bundles,
		"ds-pack": {
			description: "Everything Design System ships",
			icon: "🔗",
			scope: "project-specific",
			skills: ["design-token-lint"],
			source: "design-system",
		},
	},
};

/**
 * The impact the mocked CLI reports. DELIBERATELY different from what
 * `computeSourceImpact` derives from `multiSource` (1 skill / 1 bundle /
 * 1 project) — otherwise a silently-broken parse would fall back to the local
 * numbers and the assertion would pass for the wrong reason.
 */
const CLI_IMPACT = {
	skills: ["android-compose-ui", "org-lint", "org-review"],
	bundles: ["android", "org-core"],
	projects: ["example-app", "moon-base"],
};
const CLI_IMPACT_SENTENCE = "3 skills across 2 bundles, 2 projects";

/** …and the payload is followed by real auto-sync chatter on stdout, which a
 *  bare `JSON.parse` would choke on. */
function toggleOutput(id: string, enabled: boolean, extra: object = {}): string {
	return `${JSON.stringify({
		source: { id },
		enabled,
		changed: true,
		impact: CLI_IMPACT,
		...extra,
	})}\nSyncing...\nsync complete`;
}

/** hub_cmd argv captured across a test, plus a mock that answers the
 *  source enable/disable JSON contract. `hubOverride` lets a test replace the
 *  reply for one command (e.g. the doctor-failed-but-write-landed path). */
function mockHub(
	registry: Registry = multiSource,
	hubOverride?: (
		a: string[],
	) => { success: boolean; output: string } | undefined,
) {
	const calls: string[][] = [];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return registry;
		if (cmd === "hub_cmd") {
			const a = (args as { args: string[] }).args;
			calls.push(a);
			const overridden = hubOverride?.(a);
			if (overridden) return overridden;
			if (a[0] === "source" && a[1] === "list") {
				return { success: true, output: '{"sources":[],"errors":[]}' };
			}
			if (a[0] === "source" && (a[1] === "disable" || a[1] === "enable")) {
				return {
					success: true,
					output: toggleOutput(a[2], a[1] === "enable"),
				};
			}
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
	return calls;
}

function cardNames(): string[] {
	return Array.from(document.querySelectorAll(".source-card")).map(
		(el) => el.querySelector(".source-card-name")?.textContent ?? "",
	);
}

function renderSources() {
	return renderWithProviders(
		<>
			<Sources />
			<ToastContainer />
		</>,
		{ client: makeQueryClient(), initialRoute: "/sources" },
	);
}

/** Open the SCREEN header's overflow menu (cards have their own) and fire the
 *  bulk "Sync all updates" action. */
async function openSyncAll() {
	const trigger = document.querySelector<HTMLElement>(
		'.main-header-right [data-testid="overflow-trigger"]',
	)!;
	fireEvent.click(trigger);
	fireEvent.click(
		await screen.findByRole("menuitem", { name: "Sync all updates" }),
	);
}

async function openMenu(sourceName: string) {
	fireEvent.click(
		await screen.findByRole("button", { name: `Actions for ${sourceName}` }),
	);
}

beforeEach(() => {
	window.localStorage.clear();
	useAppStore.setState({ toasts: [] });
});

// ─── Toolbar: search ────────────────────────────────────────────────────────

describe("Sources — search", () => {
	it("narrows the list by name, id, and URL", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");
		expect(cardNames().length).toBeGreaterThan(4);

		const search = screen.getByPlaceholderText(
			"Search sources by name, id, or URL…",
		);
		fireEvent.change(search, { target: { value: "design" } });
		await waitFor(() => expect(cardNames()).toHaveLength(1));
		expect(cardNames()[0]).toContain("Design System");

		// Matches the id, not just the display name.
		fireEvent.change(search, { target: { value: "legacy-pack" } });
		await waitFor(() => expect(cardNames()).toHaveLength(1));
		expect(cardNames()[0]).toContain("Legacy Pack");

		// Matches the remote URL.
		fireEvent.change(search, { target: { value: "partner/agent-skills" } });
		await waitFor(() => expect(cardNames()).toHaveLength(1));
		expect(cardNames()[0]).toContain("Partner Skills");
	});

	it("shows a no-match empty state rather than an empty page", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");
		fireEvent.change(
			screen.getByPlaceholderText("Search sources by name, id, or URL…"),
			{ target: { value: "zzzz-nothing" } },
		);
		expect(await screen.findByText("No matching sources")).toBeInTheDocument();
	});

	it("does not auto-focus its search box", async () => {
		// The command-layer + hooks e2e journeys start from /sources precisely
		// because no input holds focus there — window chords must stay live.
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");
		expect(document.activeElement?.tagName).not.toBe("INPUT");
	});
});

// ─── Toolbar: filter chips with counts ──────────────────────────────────────

describe("Sources — filter chips double as overview stats", () => {
	it("labels each facet with its count", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");

		const chipCount = (label: string) =>
			screen
				.getByRole("button", { name: new RegExp(`^${label}`) })
				.querySelector(".count")?.textContent;

		// 2 built-ins + 4 git sources.
		expect(chipCount("All")).toBe("6");
		expect(chipCount("Git")).toBe("4");
		expect(chipCount("Built-in")).toBe("2");
		expect(chipCount("Updates")).toBe("1");
		expect(chipCount("Errors")).toBe("1");
		expect(chipCount("Disabled")).toBe("1");
	});

	it("filters by type", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");

		fireEvent.click(screen.getByRole("button", { name: /^Built-in/ }));
		await waitFor(() => expect(cardNames()).toHaveLength(2));
		expect(cardNames().join(" ")).toContain("Local");

		fireEvent.click(screen.getByRole("button", { name: /^Git/ }));
		await waitFor(() => expect(cardNames()).toHaveLength(4));
		expect(cardNames().join(" ")).not.toContain("Starter Pack");
	});

	it("filters by status, and the chip toggles back off", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");

		fireEvent.click(screen.getByRole("button", { name: /^Errors/ }));
		await waitFor(() => expect(cardNames()).toHaveLength(1));
		expect(cardNames()[0]).toContain("Partner Skills");

		fireEvent.click(screen.getByRole("button", { name: /^Disabled/ }));
		await waitFor(() => expect(cardNames()).toHaveLength(1));
		expect(cardNames()[0]).toContain("Legacy Pack");

		fireEvent.click(screen.getByRole("button", { name: /^Disabled/ }));
		await waitFor(() => expect(cardNames().length).toBeGreaterThan(1));
	});
});

// ─── Toolbar: sort ──────────────────────────────────────────────────────────

describe("Sources — sort", () => {
	it("orders by skill count and persists the choice", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");

		fireEvent.change(screen.getByLabelText("Sort sources"), {
			target: { value: "skills" },
		});
		await waitFor(() =>
			// Local (3 local skills) and design-system (2) lead; the empty git
			// sources trail.
			expect(cardNames()[0]).toContain("Local"),
		);
		expect(cardNames()[1]).toContain("Design System");
		expect(window.localStorage.getItem("st:sources:sort")).toBe("skills");
	});

	it("orders by last-synced, newest first, never-synced last", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");

		fireEvent.change(screen.getByLabelText("Sort sources"), {
			target: { value: "synced" },
		});
		await waitFor(() => expect(cardNames()[0]).toContain("Design System"));
		const names = cardNames();
		expect(names[1]).toContain("Org Skills");
		expect(names[2]).toContain("Partner Skills");
		expect(names[3]).toContain("Legacy Pack");
		// Built-ins never sync — they sort to the end, not the front.
		expect(names.slice(4).join(" ")).toContain("Local");
	});

	it("orders by status with the attention-first ranking", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");

		fireEvent.change(screen.getByLabelText("Sort sources"), {
			target: { value: "status" },
		});
		await waitFor(() => expect(cardNames()[0]).toContain("Partner Skills"));
		expect(cardNames()[1]).toContain("Org Skills");
	});

	it("restores a persisted sort on mount", async () => {
		window.localStorage.setItem("st:sources:sort", "status");
		mockHub();
		renderSources();
		await screen.findByText("Partner Skills");
		expect(cardNames()[0]).toContain("Partner Skills");
		expect((screen.getByLabelText("Sort sources") as HTMLSelectElement).value).toBe(
			"status",
		);
	});
});

// ─── Card ───────────────────────────────────────────────────────────────────

describe("Sources — card content", () => {
	it("shows the display name plus the id when they differ", async () => {
		mockHub();
		renderSources();
		const card = (await screen.findByText("Org Skills")).closest(".source-card")!;
		expect(within(card as HTMLElement).getByText("org-skills")).toBeInTheDocument();
	});

	it("marks a disabled source without hiding what it still owns", async () => {
		mockHub();
		renderSources();
		const card = (await screen.findByText("Legacy Pack")).closest(
			".source-card",
		) as HTMLElement;
		expect(card.getAttribute("data-off")).toBe("true");
		expect(within(card).getByText("Disabled")).toBeInTheDocument();
		expect(
			within(card).getByText(
				"Skills stay registered — not synced to projects while disabled.",
			),
		).toBeInTheDocument();
	});

	it("lists the bundles that carry this source's skills", async () => {
		mockHub();
		renderSources();
		const bundles = await screen.findByTestId("source-bundles-org-skills");
		// android carries android-compose-ui, which org-skills owns.
		expect(within(bundles).getByText("android")).toBeInTheDocument();
	});

	it("renders 'In bundles' on BundleChip (emoji square), never the old dot", async () => {
		mockHub();
		renderSources();
		const bundles = await screen.findByTestId("source-bundles-org-skills");
		const chip = within(bundles).getByText("android").closest(".bundle-chip") as HTMLElement;
		expect(chip.querySelector(".icon")).not.toBeNull();
		expect(chip.querySelector(".chip")).toBeNull();
		expect(chip.querySelector(".dot")).toBeNull();
	});

	it("renders the Imported skills list on the shared Chip atom, with a ScopeBadge gem", async () => {
		mockHub();
		renderSources();
		const card = (await screen.findByText("Design System")).closest(
			".source-card",
		) as HTMLElement;
		const chip = within(card)
			.getByText("design-token-lint")
			.closest(".chip") as HTMLElement;
		expect(within(chip).getByText("P")).toBeInTheDocument(); // ScopeBadge: portable
		// A plain skill (not mcp-server) renders no kind mark (R1).
		expect(chip.querySelector(".kind-mark")).toBeNull();
	});

	it("marks a following bundle, and keeps it listed even while empty", async () => {
		// An empty linked bundle shares no skills with the source yet — the LINK
		// is the relationship, so the chip (and its marker) must still show.
		// REVIEW-B #4: the bundle's own icon is deliberately NOT 🔗 — the old
		// assertion coincidentally matched the fixture's icon emoji instead of
		// the actual follows marker, so a following bundle with any other icon
		// would have passed the test while rendering no marker at all.
		const emptyLinked: Registry = {
			...multiSource,
			bundles: {
				...multiSource.bundles,
				"ds-pack": {
					description: "Everything Design System ships",
					icon: "📦",
					scope: "project-specific",
					skills: [],
					source: "design-system",
				},
			},
		};
		mockHub(emptyLinked);
		renderSources();
		const bundles = await screen.findByTestId("source-bundles-design-system");
		// The follows marker is now a rendered `link` glyph — `BundleChip`'s
		// `trailing` slot (COMPONENTS.md §Bundle chip) — visible at rest, not
		// just a tooltip on a wrapping `<span>`.
		const chip = within(bundles)
			.getByText("ds-pack")
			.closest(".bundle-chip") as HTMLElement;
		expect(
			within(chip).getByTitle("ds-pack follows this source"),
		).toBeInTheDocument();
		expect(chip.querySelector('svg[role="img"]')).not.toBeNull();
	});

	it("no longer paints status on a left rail", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");
		// The retheme deleted `.source-card::before`; identity rides the --id-*
		// ramp on the card background instead, and status lives on badges.
		const card = document.querySelector(".source-card") as HTMLElement;
		expect(card.style.getPropertyValue("--src-accent")).toMatch(
			/^var\(--id-[0-7]\)$/,
		);
	});
});

// ─── Keyboard ───────────────────────────────────────────────────────────────

describe("Sources — keyboard list nav", () => {
	it("j/k moves the active row and Enter collapses its detail", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");
		const list = document.querySelector(".source-list") as HTMLElement;
		expect(list.getAttribute("role")).toBe("listbox");

		const first = list.querySelector(".source-card") as HTMLElement;
		expect(first.getAttribute("data-listnav-active")).toBe("true");
		expect(first.querySelector(".source-card-detail")).not.toBeNull();

		fireEvent.keyDown(list, { key: "Enter" });
		await waitFor(() =>
			expect(first.querySelector(".source-card-detail")).toBeNull(),
		);

		fireEvent.keyDown(list, { key: "j" });
		await waitFor(() =>
			expect(
				(list.querySelectorAll(".source-card")[1] as HTMLElement).getAttribute(
					"data-listnav-active",
				),
			).toBe("true"),
		);
	});

	it("marks the active row with data-listnav-active, never data-selected", async () => {
		// The active-row ring in App.css keys off `data-listnav-active`. A
		// `[data-selected]` selector would be dead: nothing ever emits it.
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");
		expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);
		expect(
			document.querySelectorAll('.source-card[data-listnav-active="true"]'),
		).toHaveLength(1);
	});

	it("keeps a row focusable when a filter shrinks the list under the active index", async () => {
		mockHub();
		renderSources();
		await screen.findByText("Org Skills");
		const list = document.querySelector(".source-list") as HTMLElement;

		// Walk to the last row…
		fireEvent.keyDown(list, { key: "End" });
		await waitFor(() =>
			expect(
				document.querySelectorAll('.source-card[data-listnav-active="true"]'),
			).toHaveLength(1),
		);

		// …then filter down to one card. Without the clamp in useListNav the
		// active index strands past the end and the listbox goes dead.
		fireEvent.change(
			screen.getByPlaceholderText("Search sources by name, id, or URL…"),
			{ target: { value: "legacy" } },
		);
		await waitFor(() => expect(cardNames()).toHaveLength(1));
		expect(
			document.querySelectorAll('.source-card[data-listnav-active="true"]'),
		).toHaveLength(1);
	});

	it("activates a kebab item with Enter instead of collapsing the card", async () => {
		// useListNav's container keydown claims Enter and preventDefaults it; the
		// open menu panel must win, or every kebab action is keyboard-dead.
		const calls = mockHub();
		renderSources();
		await openMenu("Org Skills");
		const items = await screen.findAllByRole("menuitem");
		const rename = items.find((el) => el.textContent?.includes("Rename"))!;
		await waitFor(() => expect(document.activeElement).toBe(rename));

		// The menu panel is a `document.body` portal (OverflowMenu), so it is no
		// longer a DOM descendant of the card — found by its own name instead.
		const card = (await screen.findByText("Org Skills")).closest(
			".source-card",
		) as HTMLElement;
		expect(card.querySelector(".source-card-detail")).not.toBeNull();

		// KEYBOARD, not click — a click would pass even with the bug present.
		fireEvent.keyDown(rename, { key: "Enter" });

		expect(await screen.findByLabelText("Source display name")).toBeInTheDocument();
		// …and the card behind the menu did NOT toggle its detail.
		expect(card.querySelector(".source-card-detail")).not.toBeNull();
		expect(calls.some((c) => c[1] === "disable")).toBe(false);
	});
});

// ─── Flows ──────────────────────────────────────────────────────────────────

describe("Sources — rename", () => {
	it("issues `source edit --name` and reports success", async () => {
		const calls = mockHub();
		renderSources();
		await openMenu("Org Skills");
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));

		const input = await screen.findByLabelText("Source display name");
		fireEvent.change(input, { target: { value: "Acme Pack" } });
		fireEvent.click(screen.getByRole("button", { name: "Save name" }));

		await waitFor(() =>
			expect(
				calls.find((c) => c[0] === "source" && c[1] === "edit"),
			).toBeTruthy(),
		);
		expect(calls.find((c) => c[1] === "edit")).toEqual([
			"source",
			"edit",
			"org-skills",
			"--name",
			"Acme Pack",
			"--json",
		]);
		expect(await screen.findByText('Renamed to "Acme Pack"')).toBeInTheDocument();
	});

	it("keeps Save inert until the name actually changes", async () => {
		mockHub();
		renderSources();
		await openMenu("Org Skills");
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
		expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
	});
});

describe("Sources — disable / enable", () => {
	it("runs immediately, states the impact, and undo re-enables", async () => {
		const calls = mockHub();
		renderSources();
		await openMenu("Org Skills");
		fireEvent.click(await screen.findByRole("menuitem", { name: "Disable source" }));

		await waitFor(() =>
			expect(calls.some((c) => c[1] === "disable")).toBe(true),
		);
		expect(calls.find((c) => c[1] === "disable")).toEqual([
			"source",
			"disable",
			"org-skills",
			"--json",
		]);
		// No confirm dialog stands between the user and a reversible action.
		expect(screen.queryByRole("dialog")).toBeNull();

		// The toast spells out what stopped flowing, using the CLI's OWN impact
		// numbers (3/2/2) — not the 1/1/1 the registry-derived fallback yields —
		// so the parse of the payload (behind trailing sync chatter) is pinned.
		expect(
			await screen.findByText(`Disabled Org Skills — ${CLI_IMPACT_SENTENCE}`),
		).toBeInTheDocument();
		expect(
			computeSourceImpact(multiSource, "org-skills").skills,
		).not.toHaveLength(CLI_IMPACT.skills.length);

		await userEvent.click(screen.getByText("Undo"));
		await waitFor(() => expect(calls.some((c) => c[1] === "enable")).toBe(true));
		expect(calls.find((c) => c[1] === "enable")).toEqual([
			"source",
			"enable",
			"org-skills",
			"--json",
		]);
	});

	it("offers Enable on an already-disabled source", async () => {
		const calls = mockHub();
		renderSources();
		await openMenu("Legacy Pack");
		fireEvent.click(await screen.findByRole("menuitem", { name: "Enable source" }));
		await waitFor(() => expect(calls.some((c) => c[1] === "enable")).toBe(true));
		expect(calls.find((c) => c[1] === "enable")?.[2]).toBe("legacy-pack");
	});

	it("never offers disable/remove for a built-in source", async () => {
		mockHub();
		renderSources();
		await openMenu("Local");
		expect(screen.queryByRole("menuitem", { name: "Disable source" })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "Remove source…" })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "Rename…" })).toBeNull();
	});

	it("still offers Undo when the write landed but the follow-up sync failed", async () => {
		// `hub source disable` writes the registry, THEN auto-syncs; a doctor
		// danger finding makes the whole command exit non-zero even though the
		// toggle happened. Reporting "couldn't disable" (and eating the Undo)
		// would be a lie about the registry.
		const calls = mockHub(multiSource, (a) =>
			a[0] === "source" && a[1] === "disable"
				? {
						success: false,
						output: toggleOutput(a[2], false, {
							errors: ["doctor: 1 danger finding in example-app"],
						}),
					}
				: undefined,
		);
		renderSources();
		await openMenu("Org Skills");
		fireEvent.click(await screen.findByRole("menuitem", { name: "Disable source" }));

		// Presented as done, with the impact and a live Undo…
		expect(
			await screen.findByText(`Disabled Org Skills — ${CLI_IMPACT_SENTENCE}`),
		).toBeInTheDocument();
		expect(screen.queryByText("Couldn't disable source")).toBeNull();

		// …plus an honest note about what the sync found.
		expect(await screen.findByText("Sync reported findings")).toBeInTheDocument();
		expect(
			screen.getByText("doctor: 1 danger finding in example-app"),
		).toBeInTheDocument();

		await userEvent.click(screen.getByText("Undo"));
		await waitFor(() => expect(calls.some((c) => c[1] === "enable")).toBe(true));
	});

	it("reports a genuine failure with the CLI's message, not the raw JSON", async () => {
		mockHub(multiSource, (a) =>
			a[0] === "source" && a[1] === "disable"
				? {
						success: false,
						output: '{"source": null, "errors": ["unknown source: org-skills"]}',
					}
				: undefined,
		);
		renderSources();
		await openMenu("Org Skills");
		fireEvent.click(await screen.findByRole("menuitem", { name: "Disable source" }));

		expect(await screen.findByText("Couldn't disable source")).toBeInTheDocument();
		expect(screen.getByText("unknown source: org-skills")).toBeInTheDocument();
		// The raw payload never reaches the user, and there is no undo to offer.
		expect(screen.queryByText(/"errors"/)).toBeNull();
		expect(screen.queryByText("Undo")).toBeNull();
	});
});

describe("Sources — bundle from source", () => {
	it("creates a bundle with exactly this source's skills", async () => {
		const calls = mockHub();
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);

		const name = await screen.findByLabelText("Bundle name");
		expect((name as HTMLInputElement).value).toBe("design-system");
		fireEvent.change(screen.getByLabelText("Bundle description"), {
			target: { value: "Design tokens" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create bundle" }));

		await waitFor(() => expect(calls.some((c) => c[1] === "new")).toBe(true));
		// Following the source is the default, so `--source` rides along.
		expect(calls.find((c) => c[1] === "new")).toEqual([
			"bundle",
			"new",
			"design-system",
			"--skills",
			"design-token-lint,design-token-docs",
			"--description",
			"Design tokens",
			"--icon",
			"📦",
			"--source",
			"design-system",
			"--json",
		]);
	});

	// GRILL #12 — a second `.source-imported-chip` consumer: the modal's own
	// "Skills captured" list moves to the shared `Chip` atom too. REVIEW-B #5:
	// this list passes no `onClick` — it's a read-only preview, not a picker —
	// so the chips render as non-interactive `<span>`s, not inert, tab-reachable
	// `<button>`s.
	it("renders the captured-skills list on the shared Chip atom, as non-interactive spans", async () => {
		mockHub();
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);
		const modal = await screen.findByRole("dialog");
		const captured = within(modal)
			.getByText("design-token-lint")
			.closest(".source-imported-list") as HTMLElement;
		expect(within(captured).queryAllByRole("button")).toHaveLength(0);
		expect(captured.querySelectorAll(".chip")).toHaveLength(2);
		expect(captured.querySelector(".source-imported-chip")).toBeNull();
	});

	/**
	 * B7 — "Add skills to bundle…" with no bundles defined told the user to
	 * "create a bundle from this source instead" and then gave them nothing to
	 * click. The instruction and the affordance now match: the CTA hands
	 * straight off to the create-bundle-from-source flow.
	 */
	it("turns the no-bundles state into a hand-off, not a dead end", async () => {
		mockHub({ ...multiSource, bundles: {} });
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Add skills to bundle…" }),
		);

		expect(await screen.findByText("No bundles yet")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("add-to-bundle-create"));

		// The create-bundle-from-source modal takes over, pre-filled for this source.
		const name = await screen.findByLabelText("Bundle name");
		expect((name as HTMLInputElement).value).toBe("design-system");
		expect(screen.queryByText("No bundles yet")).not.toBeInTheDocument();
	});

	it("drops --source when the follow toggle is turned off", async () => {
		const calls = mockHub();
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);

		const toggle = await screen.findByLabelText("Keep in sync with source");
		expect(toggle).toBeChecked();
		// Snapshot copy is the OFF story; the linked copy is the ON story.
		expect(
			screen.getByText(/This bundle follows Design System/),
		).toBeInTheDocument();
		fireEvent.click(toggle);
		expect(
			screen.getByText(/captures the source's skills as they are right now/),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Create bundle" }));
		await waitFor(() => expect(calls.some((c) => c[1] === "new")).toBe(true));
		const argv = calls.find((c) => c[1] === "new") ?? [];
		expect(argv).not.toContain("--source");
		expect(argv).toContain("--json");
		// design.md Decisions #8: the write and its auto-sync run in one
		// process, reported through `bundle-new:<name>` (BundleFromSourceModal.tsx).
		expect(
			Processes.list().find((p) => p.target === "bundle-new:design-system"),
		).toBeDefined();
	});

	it("closes on a landed write whose auto-sync reported findings", async () => {
		// The registry write landed (`created: true`) but the doctor exited
		// non-zero — the old code threw the whole log at the user and left the
		// dialog open on a bundle that already existed.
		mockHub(multiSource, (a) =>
			a[0] === "bundle" && a[1] === "new"
				? {
						success: false,
						output: `${JSON.stringify({
							bundle: {
								name: "design-system",
								skills: ["design-token-lint"],
								source: "design-system",
							},
							created: true,
							errors: ["doctor: 1 danger finding in example-app"],
							// …and the auto-sync chatter that follows carries BRACES, so a
							// scan-to-the-last-`}` parse would swallow the wrong text.
						})}\nSyncing {example-app} → /Users/dev/{proj}\nwrote .claude/settings.json {ok}`,
					}
				: undefined,
		);
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Create bundle" }));

		expect(
			await screen.findByText(/Bundle "design-system" created/),
		).toBeInTheDocument();
		expect(screen.getByText("Sync reported findings")).toBeInTheDocument();
		expect(
			screen.getByText("doctor: 1 danger finding in example-app"),
		).toBeInTheDocument();
		// Dialog gone; no raw log dumped into a toast.
		await waitFor(() =>
			expect(screen.queryByLabelText("Bundle name")).toBeNull(),
		);
		expect(screen.queryByText(/Syncing 3 projects/)).toBeNull();
	});

	it("surfaces the CLI's warnings verbatim when a linked bundle is global", async () => {
		// The write SUCCEEDED — `warnings` are the CLI's non-fatal notes, and a
		// global-scope linked bundle (every project silently gets its skills) is
		// exactly the kind the user has to act on later.
		mockHub(multiSource, (a) =>
			a[0] === "bundle" && a[1] === "new"
				? {
						success: true,
						output: `${JSON.stringify({
							bundle: {
								name: "design-system",
								skills: ["design-token-lint"],
								scope: "global",
								source: "design-system",
							},
							created: true,
							warnings: [
								"bundle 'design-system' is scope: global and follows 'design-system' — every project gets its skills automatically",
								"dropped 1 skill(s) 'design-system' does not own: stray-skill",
							],
							errors: [],
						})}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
					}
				: undefined,
		);
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Create bundle" }));

		// Created — and the warnings ride alongside in ONE toast, verbatim.
		expect(
			await screen.findByText(/Bundle "design-system" created/),
		).toBeInTheDocument();
		expect(screen.getByText("Bundle warnings")).toBeInTheDocument();
		expect(
			screen.getByText(
				"bundle 'design-system' is scope: global and follows 'design-system' — every project gets its skills automatically · dropped 1 skill(s) 'design-system' does not own: stray-skill",
			),
		).toBeInTheDocument();
		// A warning is not a sync finding — that channel stays quiet.
		expect(screen.queryByText("Sync reported findings")).toBeNull();
	});

	it("stays quiet when the CLI reports no warnings", async () => {
		mockHub(multiSource, (a) =>
			a[0] === "bundle" && a[1] === "new"
				? {
						success: true,
						output: JSON.stringify({
							bundle: { name: "design-system", skills: [], source: null },
							created: true,
							warnings: [],
							errors: [],
						}),
					}
				: undefined,
		);
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Create bundle" }));

		await screen.findByText(/Bundle "design-system" created/);
		expect(screen.queryByText("Bundle warning")).toBeNull();
		expect(screen.queryByText("Bundle warnings")).toBeNull();
	});

	it("reports a genuine creation failure with the CLI's own message", async () => {
		mockHub(multiSource, (a) =>
			a[0] === "bundle" && a[1] === "new"
				? {
						success: false,
						output: '{"bundle": null, "errors": ["unknown skill: ghost"]}',
					}
				: undefined,
		);
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Create bundle" }));

		expect(await screen.findByText("Couldn't create bundle")).toBeInTheDocument();
		expect(screen.getByText("unknown skill: ghost")).toBeInTheDocument();
		// Nothing was created, so the dialog stays open for a retry.
		expect(screen.getByLabelText("Bundle name")).toBeInTheDocument();
	});

	it("hides the follow toggle for a built-in source", async () => {
		mockHub();
		renderSources();
		await openMenu("Local");
		const item = screen.queryByRole("menuitem", {
			name: "Create bundle from source…",
		});
		// Built-ins only offer the flow when they own skills; when they do, the
		// dialog must not offer a link (there is no upstream to follow).
		if (item) {
			fireEvent.click(item);
			await screen.findByLabelText("Bundle name");
			expect(screen.queryByLabelText("Keep in sync with source")).toBeNull();
		}
	});

	it("refuses a name that already exists", async () => {
		mockHub();
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "Create bundle from source…",
			}),
		);
		fireEvent.change(await screen.findByLabelText("Bundle name"), {
			target: { value: "android" },
		});
		const create = screen.getByRole("button", { name: "Create bundle" });
		expect(create).toHaveAttribute("aria-disabled", "true");
		expect(create).toHaveAttribute(
			"title",
			"A bundle named android already exists.",
		);
	});
});

describe("Sources — add skills to an existing bundle", () => {
	it("unions the source's skills onto the bundle's current membership", async () => {
		const calls = mockHub();
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Add skills to bundle…" }),
		);

		const row = await screen.findByTestId("add-to-bundle-android");
		fireEvent.click(within(row).getByRole("button", { name: "Add" }));

		await waitFor(() => expect(calls.some((c) => c[1] === "update")).toBe(true));
		// android already holds rt-android-expert + android-compose-ui; the two
		// design-system skills are appended, order preserved.
		expect(calls.find((c) => c[1] === "update")).toEqual([
			"bundle",
			"update",
			"android",
			"--skills",
			"rt-android-expert,android-compose-ui,design-token-lint,design-token-docs",
			"--json",
		]);
		// The write and its auto-sync run under one process (design.md
		// Decisions #8), its own verb so it never collides with a per-skill
		// `bundle-add:<bundle>:<skill>` target (AddSourceToBundleModal.tsx).
		expect(
			Processes.list().find((p) => p.target === "bundle-add-source:android"),
		).toBeDefined();
	});

	it("refuses to hand-edit a bundle that follows a source", async () => {
		mockHub(linkedRegistry);
		renderSources();
		await openMenu("Design System");
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Add skills to bundle…" }),
		);

		const row = await screen.findByTestId("add-to-bundle-ds-pack");
		expect(row).toHaveAttribute("data-linked", "true");
		expect(
			within(row).getByText("follows design-system — managed automatically"),
		).toBeInTheDocument();
		const add = within(row).getByRole("button", { name: "Add" });
		expect(add).toHaveAttribute("aria-disabled", "true");

		// An unlinked bundle in the same list stays actionable.
		const free = await screen.findByTestId("add-to-bundle-android");
		expect(within(free).getByRole("button", { name: "Add" })).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);
	});
});

// ─── Source sync: what actually moved ───────────────────────────────────────

describe("Sources — sync payload summary", () => {
	it("summarises imported / updated / missing counts", () => {
		expect(
			syncSummary({
				added: ["a", "b"],
				changed: ["c"],
				removed_upstream: ["d"],
			}),
		).toBe("2 imported, 1 updated, 1 missing upstream");
		// Bare counts are tolerated too (backend may report numbers).
		expect(syncSummary({ added: 3 })).toBe("3 imported");
		expect(syncSummary({ added: [], changed: [] })).toBe("already up to date");
		expect(syncSummary(null)).toBe("registry updated");
	});

	it("renders one line per reconciled linked bundle", () => {
		expect(
			bundleUpdateLines({
				bundle_updates: [
					{ bundle: "ds-pack", added: ["a", "b"], removed: ["c"] },
					{ bundle: "other", added: [], removed: ["z"] },
				],
			}),
		).toEqual(["bundle ds-pack: +2 −1", "bundle other: −1"]);
		expect(bundleUpdateLines({})).toEqual([]);
	});

	it("toasts the bundle reconcile after a source sync", async () => {
		mockHub(linkedRegistry, (a) =>
			a[0] === "source" && a[1] === "sync"
				? {
						success: true,
						output: `${JSON.stringify({
							ok: true,
							added: ["new-lint"],
							changed: [],
							removed_upstream: [],
							bundle_updates: [
								{ bundle: "ds-pack", added: ["new-lint"], removed: [] },
							],
						})}\nSyncing {ds-pack} → /Users/dev/{proj}\nsync complete {ok}`,
					}
				: undefined,
		);
		renderSources();
		await screen.findByText("Design System");
		const card = Array.from(
			document.querySelectorAll<HTMLElement>(".source-card"),
		).find((el) => el.textContent?.includes("Design System"))!;
		fireEvent.click(within(card).getByRole("button", { name: "Sync" }));

		expect(await screen.findByText("Synced Design System")).toBeInTheDocument();
		expect(screen.getByText("bundle ds-pack: +1")).toBeInTheDocument();
	});

	it("treats a landed sync whose auto-sync failed as success-with-warning", async () => {
		// `source sync` writes the registry and THEN auto-syncs. The sync payload
		// carries no `errors` key, so a raw-log fallback here would put the whole
		// auto-sync transcript on the process card.
		mockHub(linkedRegistry, (a) =>
			a[0] === "source" && a[1] === "sync"
				? {
						success: false,
						output: `${JSON.stringify({
							ok: true,
							added: ["new-lint"],
							changed: [],
							removed_upstream: [],
							bundle_updates: [
								{ bundle: "ds-pack", added: ["new-lint"], removed: [] },
							],
							error: "doctor: 1 danger finding in example-app",
						})}\nSyncing {example-app} → /Users/dev/{proj}\nwrote settings.json {ok}`,
					}
				: undefined,
		);
		renderSources();
		await screen.findByText("Design System");
		const card = Array.from(
			document.querySelectorAll<HTMLElement>(".source-card"),
		).find((el) => el.textContent?.includes("Design System"))!;
		fireEvent.click(within(card).getByRole("button", { name: "Sync" }));

		// The reconcile is still reported…
		expect(await screen.findByText("Synced Design System")).toBeInTheDocument();
		expect(screen.getByText("bundle ds-pack: +1")).toBeInTheDocument();
		// …alongside the finding, and never the raw log.
		expect(screen.getByText("Sync reported findings")).toBeInTheDocument();
		expect(
			screen.getByText("doctor: 1 danger finding in example-app"),
		).toBeInTheDocument();
		expect(screen.queryByText(/wrote settings\.json/)).toBeNull();
	});

	it("reports a genuine sync failure concisely, with no landed-work toast", async () => {
		mockHub(linkedRegistry, (a) =>
			a[0] === "source" && a[1] === "sync"
				? {
						success: false,
						output:
							'{"ok": false, "error": "git fetch failed: Permission denied (publickey)."}\naborted',
					}
				: undefined,
		);
		renderSources();
		await screen.findByText("Design System");
		const card = Array.from(
			document.querySelectorAll<HTMLElement>(".source-card"),
		).find((el) => el.textContent?.includes("Design System"))!;
		fireEvent.click(within(card).getByRole("button", { name: "Sync" }));

		// The concise CLI message reaches the process card…
		expect(
			await screen.findByText(
				"git fetch failed: Permission denied (publickey).",
			),
		).toBeInTheDocument();
		// …and nothing claims work landed.
		expect(screen.queryByText("Synced Design System")).toBeNull();
		expect(screen.queryByText("Sync reported findings")).toBeNull();
	});

	it("counts only landed runs in sync-all, and names the failures", async () => {
		// org-skills is the one `update-available` ENABLED source in the fixture;
		// make it fail and the toolbar must not claim a success.
		mockHub(multiSource, (a) =>
			a[0] === "source" && a[1] === "sync"
				? {
						success: false,
						output: '{"ok": false, "error": "git fetch failed"}',
					}
				: undefined,
		);
		renderSources();
		await screen.findByText("Org Skills");
		await openSyncAll();

		expect(await screen.findByText("0 sources synced, 1 failed")).toBeInTheDocument();
	});

	it("never bulk-syncs a disabled source", async () => {
		// legacy-pack is disabled; mark it update-available so only the enabled
		// filter can keep it out of the loop.
		const withDisabledUpdate: Registry = {
			...multiSource,
			sources: {
				...multiSource.sources,
				"legacy-pack": {
					...(multiSource.sources!["legacy-pack"] as GitSourceConfig),
					status: "update-available",
				},
			},
		};
		const calls = mockHub(withDisabledUpdate, (a) =>
			a[0] === "source" && a[1] === "sync"
				? { success: true, output: '{"ok": true, "added": []}' }
				: undefined,
		);
		renderSources();
		await screen.findByText("Legacy Pack");
		await openSyncAll();

		await waitFor(() =>
			expect(calls.some((c) => c[0] === "source" && c[1] === "sync")).toBe(true),
		);
		const synced = calls
			.filter((c) => c[0] === "source" && c[1] === "sync")
			.map((c) => c[2]);
		expect(synced).toContain("org-skills");
		expect(synced).not.toContain("legacy-pack");
	});
});

// ─── Impact helper ──────────────────────────────────────────────────────────

describe("computeSourceImpact", () => {
	it("reports the skills, bundles, and projects a source reaches", () => {
		const impact = computeSourceImpact(multiSource, "org-skills");
		expect(impact.skills).toEqual(["android-compose-ui"]);
		expect(impact.bundles).toEqual(["android"]);
		expect(impact.projects).toEqual(["example-app"]);
	});

	it("is empty for a source nothing depends on", () => {
		const impact = computeSourceImpact(multiSource, "partner-skills");
		expect(impact).toEqual({ skills: [], bundles: [], projects: [] });
	});
});
