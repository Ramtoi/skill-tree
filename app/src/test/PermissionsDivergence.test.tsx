/**
 * Divergence surfacing + reconcile drawer (permissions-divergence-fixes 5.5).
 *
 * The banner renders only when `permissions_show` reports drift (staleness or
 * unmanaged native rules); the reconcile drawer is backed by the transactional
 * `permissions_reconcile_*` commands, collapses previously-kept candidates,
 * marshals un-keep decisions, and applies only explicitly staged choices.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";

import { PermissionsEditor } from "@/components/PermissionsEditor";
import { ImportMergeDialog } from "@/components/ImportMergeDialog";
import { makeQueryClient } from "./helpers";
import type {
	Capabilities,
	ImportCandidateSet,
	NormalizedPermissions,
	PermissionsDivergence,
} from "@/types/permissions";

// `PatternText` (ImportMergeDialog) splits a pattern across `.tool`/`.inner`
// sibling spans so the tool prefix can be dimmed, which means no element
// holds the full pattern as an OWN text-node child — a plain
// `getByText("Bash(cargo:*)")` can't match it (DOM Testing Library only
// looks at direct text-node children, not descendants). A function matcher
// reading `element.textContent` is the documented way around that.
function patternText(pattern: string) {
	return (_content: string, element: Element | null) =>
		element?.tagName === "CODE" &&
		element.classList.contains("reconcile-pattern") &&
		element.textContent === pattern;
}

const EMPTY: NormalizedPermissions = {
	allow: [],
	deny: [],
	ask: [],
	hooks: [],
	sandbox_mode: null,
	approval_policy: null,
	project_trust: null,
	additional_dirs: [],
	extras: {},
	_unmanaged: [],
};

const CAPS: Capabilities = {
	"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
};

const DIVERGENCE: PermissionsDivergence = {
	unmanaged_count: 3,
	stale: true,
	last_written_at: "2026-08-26T12:06:51Z",
	harnesses: { "claude-code": { unmanaged: 3, stale: true } },
};

function wire({
	divergence,
	candidates,
}: {
	divergence?: PermissionsDivergence | null;
	candidates?: ImportCandidateSet;
} = {}) {
	const applyCalls: unknown[] = [];
	vi.mocked(invoke).mockImplementation(
		async (cmd: string, args?: unknown): Promise<unknown> => {
			switch (cmd) {
				case "permissions_show":
					return { ...EMPTY, divergence: divergence ?? null };
				case "permissions_capabilities":
					return CAPS;
				case "permissions_risks_schema":
					return [];
				case "permissions_doctor":
					return { findings: [], danger_count: 0 };
				case "permissions_recent_imports":
					return [];
				case "permissions_reconcile_candidates":
					return (
						candidates ?? {
							scope_kind: "global",
							project: null,
							merged: [],
							conflicts: [],
							un_importable: [],
						}
					);
				case "permissions_reconcile_apply":
					applyCalls.push(args);
					return {
						imported: 0,
						dropped: 0,
						kept: 0,
						conflicts_resolved: 0,
						synced_files: [],
					};
				default:
					return undefined;
			}
		},
	);
	return { applyCalls };
}

function renderEditor() {
	const client = makeQueryClient();
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<PermissionsEditor
					scope={{ kind: "global" }}
					projectCount={0}
					renderChrome={() => null}
				/>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe("PermissionsDivergenceBanner", () => {
	it("renders nothing when there is no divergence payload", async () => {
		wire({ divergence: null });
		renderEditor();
		await screen.findByLabelText("Permission rows");
		expect(screen.queryByText(/unmanaged native rule/)).toBeNull();
		expect(screen.queryByText(/Registry changed/)).toBeNull();
	});

	it("renders nothing when in sync with zero unmanaged rules", async () => {
		wire({
			divergence: {
				unmanaged_count: 0,
				stale: false,
				last_written_at: "2026-08-26T12:06:51Z",
				harnesses: { "claude-code": { unmanaged: 0, stale: false } },
			},
		});
		renderEditor();
		await screen.findByLabelText("Permission rows");
		expect(screen.queryByText(/unmanaged native rule/)).toBeNull();
		expect(screen.queryByText(/Registry changed/)).toBeNull();
	});

	it("shows staleness + unmanaged count and opens the reconcile drawer", async () => {
		wire({ divergence: DIVERGENCE });
		renderEditor();
		await screen.findByText(/Registry changed since the last native write/);
		expect(screen.getByText(/3 unmanaged native rules/)).toBeInTheDocument();
		expect(screen.getByText("Sync now")).toBeInTheDocument();

		fireEvent.click(screen.getByText("Review →"));
		// The drawer opens and issues the reconcile discovery call.
		await waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith(
				"permissions_reconcile_candidates",
				expect.anything(),
			),
		);
	});

	it("unknown staleness (null) with unmanaged rules shows only the count", async () => {
		wire({
			divergence: {
				unmanaged_count: 2,
				stale: null,
				last_written_at: null,
				harnesses: { "claude-code": { unmanaged: 2, stale: null } },
			},
		});
		renderEditor();
		await screen.findByText(/2 unmanaged native rules/);
		expect(screen.queryByText(/Registry changed/)).toBeNull();
		expect(screen.queryByText("Sync now")).toBeNull();
	});
});

const CANDIDATES: ImportCandidateSet = {
	scope_kind: "global",
	project: null,
	merged: [
		{
			pattern: "Bash(cargo:*)",
			kind: "allow",
			harnesses: null,
			kept: false,
			sources: [
				{
					harness: "claude-code",
					source: "settings.json",
					file: "/u/.claude/settings.json",
				},
			],
		},
		{
			pattern: "Bash(session:*)",
			kind: "allow",
			harnesses: null,
			kept: false,
			sources: [
				{
					harness: "claude-code",
					source: "settings.local.json",
					file: "/repo/.claude/settings.local.json",
				},
			],
		},
		{
			pattern: "Bash(*)",
			kind: "allow",
			harnesses: null,
			kept: true,
			sources: [
				{
					harness: "claude-code",
					source: "settings.json",
					file: "/u/.claude/settings.json",
				},
			],
		},
	],
	conflicts: [
		{ pattern: "Bash(npm:*)", options: { allow: ["claude-code"], ask: ["codex"] } },
	],
	un_importable: [],
};

function renderDialog(applied = () => {}) {
	return render(
		<ImportMergeDialog
			open
			scope={{ kind: "global" }}
			onClose={() => {}}
			onApplied={applied}
		/>,
	);
}

describe("Reconcile drawer (ImportMergeDialog)", () => {
	it("splits kept candidates into a collapsed group", async () => {
		wire({ candidates: CANDIDATES });
		renderDialog();
		await screen.findByText(patternText("Bash(cargo:*)"));
		// Kept rule hidden behind the toggle, not in the importable list.
		expect(screen.queryByText(patternText("Bash(*)"))).toBeNull();
		const toggle = screen.getByTestId("import-kept-toggle");
		expect(toggle).toHaveTextContent("Previously kept (1)");
		fireEvent.click(toggle);
		expect(screen.getByText(patternText("Bash(*)"))).toBeInTheDocument();
	});

	it("labels session-accepted (settings.local.json) candidates", async () => {
		wire({ candidates: CANDIDATES });
		renderDialog();
		await screen.findByText(patternText("Bash(cargo:*)"));
		fireEvent.click(screen.getByTestId("import-specific-toggle"));
		expect(screen.getByText("session-accepted")).toBeInTheDocument();
	});

	it("applies only the staged merged and conflict decisions", async () => {
		const { applyCalls } = wire({ candidates: CANDIDATES });
		renderDialog();
		await screen.findByText(patternText("Bash(npm:*)"));

		const apply = screen.getByRole("button", { name: "Apply selected" });
		expect(apply).toBeDisabled();

		const cargoRow = screen
			.getByText(patternText("Bash(cargo:*)"))
			.closest('[data-testid="import-merged-row"]') as HTMLElement;
		fireEvent.click(within(cargoRow).getByRole("radio", { name: "Import" }));
		const conflictRow = screen.getByTestId("import-conflict-row");
		fireEvent.click(within(conflictRow).getByRole("radio", { name: "allow" }));
		expect(apply).not.toBeDisabled();

		fireEvent.click(apply);
		await waitFor(() => expect(applyCalls.length).toBe(1));
		const { decisions } = applyCalls[0] as { decisions: unknown[] };
		expect(decisions).toContainEqual({
			pattern: "Bash(cargo:*)",
			action: "import",
			kind: "allow",
		});
		expect(decisions).toContainEqual({
			pattern: "Bash(npm:*)",
			action: "import",
			kind: "allow",
		});
		// Kept rule untouched → no decision for it.
		expect(
			(decisions as { pattern: string }[]).filter((d) => d.pattern === "Bash(*)"),
		).toHaveLength(0);
	});

	it("marshals un-keep decisions for kept rules", async () => {
		const { applyCalls } = wire({
			candidates: { ...CANDIDATES, conflicts: [] },
		});
		renderDialog();
		await screen.findByTestId("import-kept-toggle");
		fireEvent.click(screen.getByTestId("import-kept-toggle"));
		fireEvent.click(screen.getByText("un-keep"));
		expect(screen.getByText("will re-surface")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
		await waitFor(() => expect(applyCalls.length).toBe(1));
		const { decisions } = applyCalls[0] as { decisions: unknown[] };
		expect(decisions).toContainEqual({
			pattern: "Bash(*)",
			action: "unkeep",
			kind: "allow",
		});
	});

	it("surfaces an apply failure without closing", async () => {
		wire({ candidates: { ...CANDIDATES, conflicts: [], merged: CANDIDATES.merged.slice(0, 1) } });
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === "permissions_reconcile_candidates")
				return { ...CANDIDATES, conflicts: [], merged: CANDIDATES.merged.slice(0, 1) };
			if (cmd === "permissions_reconcile_apply")
				throw new Error("injected transaction failure");
			return undefined;
		});
		renderDialog();
		await screen.findByText(patternText("Bash(cargo:*)"));
		const cargoRow = screen
			.getByText(patternText("Bash(cargo:*)"))
			.closest('[data-testid="import-merged-row"]') as HTMLElement;
		fireEvent.click(within(cargoRow).getByRole("radio", { name: "Import" }));
		fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
		await screen.findByRole("alert");
		expect(screen.getByRole("alert")).toHaveTextContent(
			/injected transaction failure/,
		);
		// Dialog still open (Apply still visible) — user can retry or close it.
		expect(
			screen.getByRole("button", { name: "Apply selected" }),
		).toBeInTheDocument();
	});
});
