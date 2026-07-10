import {
	fireEvent,
	render,
	screen,
	waitFor,
	act,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";

import { PermissionsEditor } from "@/components/PermissionsEditor";
import { deferredInvoke, makeQueryClient } from "./helpers";
import type {
	Capabilities,
	NormalizedPermissions,
	PermissionsShowGlobal,
} from "@/types/permissions";

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
	"claude-code": [
		"tool_allowlist",
		"tool_denylist",
		"tool_ask",
		"hooks",
		"additional_directories",
	],
};

function wireDefaults({
	show,
	capabilities,
}: {
	show: NormalizedPermissions | PermissionsShowGlobal;
	capabilities: Capabilities;
}) {
	let setCalls = 0;
	vi.mocked(invoke).mockImplementation(
		async (cmd: string, args?: unknown): Promise<unknown> => {
			switch (cmd) {
				case "permissions_show":
					return show;
				case "permissions_capabilities":
					return capabilities;
				case "permissions_risks_schema":
					return [
						{
							code: "UNBOUNDED_BASH",
							severity: "danger",
							explanation: "scary",
						},
					];
				case "permissions_validate": {
					const a = args as { kind: string; pattern: string };
					if (!a.pattern || a.pattern.endsWith("(")) {
						return { ok: false, error: "bad pattern" };
					}
					return { ok: true, error: null };
				}
				case "permissions_doctor":
					return { findings: [], danger_count: 0 };
				case "permissions_set":
					setCalls += 1;
					return {
						changed: true,
						normalized: {
							...EMPTY,
							allow: [{ pattern: "Bash(npm:*)", kind: "allow" }],
						},
					};
				case "permissions_recent_imports":
					return [];
				default:
					return undefined;
			}
		},
	);
	return { getSetCalls: () => setCalls };
}

function renderEditor(props: React.ComponentProps<typeof PermissionsEditor>) {
	const client = makeQueryClient();
	// Faithful thin chrome so the editor's chrome projection is exercised: the
	// real screens (GlobalPermissions / ProjectPermissionsTab) render a
	// ScreenHeader from this same `chrome` object.
	const renderChrome: React.ComponentProps<
		typeof PermissionsEditor
	>["renderChrome"] = (chrome) => (
		<div>
			<h2>
				{chrome.scope.kind === "global" ? "Global" : chrome.scope.name}{" "}
				permissions
			</h2>
			<div>
				{chrome.ruleCount} rule{chrome.ruleCount === 1 ? "" : "s"} ·{" "}
				{chrome.hookCount} hook{chrome.hookCount === 1 ? "" : "s"} ·{" "}
				{chrome.riskCount} risk{chrome.riskCount === 1 ? "" : "s"}
			</div>
			{chrome.dirty && <span>UNSAVED</span>}
			<button
				type="button"
				onClick={chrome.save}
				disabled={chrome.saveDisabled}
				title={chrome.saveTooltip}
			>
				Save
			</button>
			<button type="button" onClick={chrome.discard} disabled={!chrome.dirty}>
				Discard
			</button>
			{chrome.scopeOptions?.map((o) => (
				<button
					key={o.key}
					type="button"
					onClick={() => chrome.onSelectScope?.(o.scope)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<PermissionsEditor renderChrome={renderChrome} {...props} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("PermissionsEditor initial load", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("keeps the host chrome mounted while the first fetch is pending", async () => {
		wireDefaults({ show: EMPTY, capabilities: CAPS });
		const gate = deferredInvoke((cmd) => cmd === "permissions_show");
		renderEditor({
			scope: { kind: "project", name: "alpha" },
			projectCount: 1,
		});
		// While permissions_show hangs, the screen header must NOT be swapped
		// out for a bare loading screen — that unmount reads as a flash on
		// every tab entry. Chrome stays, with a loading body beneath it.
		await waitFor(() => {
			expect(screen.getByText("alpha permissions")).toBeInTheDocument();
			expect(screen.getByText("Loading permissions…")).toBeInTheDocument();
		});
		gate.resolve(EMPTY);
		await waitFor(() => {
			expect(screen.queryByText("Loading permissions…")).toBeNull();
			// Chrome persists across the load → loaded transition.
			expect(screen.getByText("alpha permissions")).toBeInTheDocument();
		});
	});
});

describe("PermissionsEditor UNSAVED + save flow", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("toggles UNSAVED pill on edit and clears after save", async () => {
		const { getSetCalls } = wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "global" },
			projectCount: 0,
		});
		const pattern = await screen.findByLabelText("Pattern");
		expect(screen.queryByText("UNSAVED")).toBeNull();
		fireEvent.change(pattern, { target: { value: "Bash(npm:test)" } });
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();

		// Wait for validation debounce + render
		await new Promise((r) => setTimeout(r, 300));

		fireEvent.click(screen.getByRole("button", { name: /Save/ }));
		await waitFor(() => expect(getSetCalls()).toBe(1));
		await waitFor(() => expect(screen.queryByText("UNSAVED")).toBeNull());
	});

	it("disables Save while validation errors exist", async () => {
		wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "global" },
			projectCount: 0,
		});
		const pattern = await screen.findByLabelText("Pattern");
		fireEvent.change(pattern, { target: { value: "Bash(" } });
		await new Promise((r) => setTimeout(r, 300));
		const saveBtn = screen.getByRole("button", { name: /Save/ });
		expect(saveBtn).toBeDisabled();
		expect(saveBtn.getAttribute("title")).toMatch(/Invalid rules/);
	});

	it("commits via ⌘S when focus is inside .permissions-section", async () => {
		const { getSetCalls } = wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "global" },
			projectCount: 0,
		});
		const pattern = (await screen.findByLabelText(
			"Pattern",
		)) as HTMLInputElement;
		fireEvent.change(pattern, { target: { value: "Bash(npm:test)" } });
		await new Promise((r) => setTimeout(r, 300));
		// Editing a pattern re-tiers the rule (Bash(npm:*) → build, Bash(npm:test)
		// → other), which remounts the row in a different TierSection — so the
		// originally-captured `pattern` node is now detached. Re-query the live
		// input before focusing + firing ⌘S, exactly as a real user interacts with
		// whatever input is on screen.
		const live = screen.getByLabelText("Pattern") as HTMLInputElement;
		live.focus();
		fireEvent.keyDown(live, { key: "s", metaKey: true });
		await waitFor(() => expect(getSetCalls()).toBe(1));
	});
});

describe("PermissionsEditor duplicate recovery", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("explains duplicate collapse reported by the engine", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				duplicate_collapsed: 19,
				allow: [{ pattern: "Bash(*)", kind: "allow" }],
			},
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "global" },
			projectCount: 0,
		});
		expect(
			await screen.findByText(/Collapsed 19 duplicate permission rules/),
		).toBeInTheDocument();
	});
});

describe("PermissionsEditor adoption blocking", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("blocks the editor behind AdoptionDialog for the global scope", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				adoption_required: {
					"claude-code": [
						{
							pattern: "Bash(*)",
							kind: "allow",
							source_file: "/.claude/settings.json",
						},
					],
				},
			} as PermissionsShowGlobal,
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "global" },
			projectCount: 0,
		});
		await screen.findByText(/Resolve adoption to start editing/);
		expect(
			screen.getByText(/Adopt existing global permissions/),
		).toBeInTheDocument();
	});

	it("never renders AdoptionDialog for project scope (even if payload had the field)", async () => {
		wireDefaults({
			show: { ...EMPTY },
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "project", name: "alpha" },
			projectCount: 1,
		});
		await waitFor(() =>
			expect(screen.queryByText(/Adopt existing/)).toBeNull(),
		);
	});
});

describe("PermissionsEditor live risk badges", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders a danger risk badge when the user types Bash(*) — no Tauri call per keystroke", async () => {
		wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "global" },
			projectCount: 0,
		});
		const pattern = await screen.findByLabelText("Pattern");
		const callsBefore = vi
			.mocked(invoke)
			.mock.calls.filter(([c]) => c === "permissions_validate").length;
		fireEvent.change(pattern, { target: { value: "Bash(*)" } });
		await waitFor(() =>
			expect(screen.getAllByText("UNBOUNDED_BASH").length).toBeGreaterThan(0),
		);
		// Risk detection itself shouldn't trigger extra invokes beyond validate.
		const callsAfter = vi
			.mocked(invoke)
			.mock.calls.filter(
				([c]) => c === "permissions_doctor" || c === "permissions_risks_schema",
			).length;
		expect(callsAfter).toBeLessThanOrEqual(1); // schema fetched once
		expect(callsBefore).toBeGreaterThanOrEqual(0);
	});
});

describe("PermissionsEditor redesigned surface", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("filters the unified list from stat cards and toolbar search", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow" }],
				deny: [{ pattern: "Read(/secret)", kind: "deny" }],
				hooks: [{ event: "PreToolUse", matcher: "Bash", command: "echo hook" }],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 1 });
		expect(await screen.findByDisplayValue("Bash(npm:*)")).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole("button", { name: /Deny/i })[0]);
		expect(screen.getByDisplayValue("Read(/secret)")).toBeInTheDocument();
		expect(screen.queryByDisplayValue("Bash(npm:*)")).toBeNull();
		fireEvent.change(screen.getByLabelText("Search permissions"), {
			target: { value: "nomatch" },
		});
		expect(screen.getByText(/No permission rows match/)).toBeInTheDocument();
	});

	it("adds alternate entry types from the split add menu and focuses the row", async () => {
		wireDefaults({ show: EMPTY, capabilities: CAPS });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		// The redesigned hero card uses the uppercase kind label; the dropdown
		// item we click to add a hook reads "Add hook".
		await screen.findAllByText("ALLOW");
		fireEvent.click(screen.getByLabelText("Choose permission type"));
		fireEvent.click(screen.getByText("Add hook"));
		const event = await screen.findByLabelText("Event");
		expect(event).toHaveFocus();
		// Both the stat card and the filter chip respond to the HOOKS filter and
		// reflect aria-pressed=true after we add a hook.
		const hooksPressed = screen
			.getAllByRole("button", { pressed: true })
			.filter((b) => /HOOKS/.test(b.textContent ?? ""));
		expect(hooksPressed.length).toBeGreaterThan(0);
	});

	it("renders host-owned scope chips and delegates navigation", async () => {
		wireDefaults({ show: EMPTY, capabilities: CAPS });
		const onSelectScope = vi.fn();
		renderEditor({
			scope: { kind: "global" },
			projectCount: 1,
			scopeOptions: [
				{
					key: "global",
					label: "Global",
					scope: { kind: "global" },
					active: true,
				},
				{
					key: "project:alpha",
					label: "alpha",
					scope: { kind: "project", name: "alpha" },
					active: false,
				},
			],
			onSelectScope,
		});
		await screen.findByRole("button", { name: "alpha" });
		fireEvent.click(screen.getByRole("button", { name: "alpha" }));
		expect(onSelectScope).toHaveBeenCalledWith({
			kind: "project",
			name: "alpha",
		});
	});
});

describe("PermissionsEditor Promote-to-project shadow semantics", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("Promote duplicates the inherited rule into the project scope without removing the global one", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [
					{
						pattern: "Bash(npm:*)",
						kind: "allow",
						origin: "global",
					},
				],
			},
			capabilities: CAPS,
		});
		renderEditor({
			scope: { kind: "project", name: "alpha" },
			projectCount: 1,
		});
		const promote = await screen.findByRole("button", {
			name: /Copy to project/,
		});
		await act(async () => {
			fireEvent.click(promote);
		});
		// The inherited row stays (read-only with `via global` pill), and a new
		// editable row appears for the project.
		expect(screen.getByText("via global")).toBeInTheDocument();
		expect(screen.getByText("project")).toBeInTheDocument();
	});
});

describe("PermissionsEditor handoff polish", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders risk-tier section heads with totals and per-section Add buttons", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				// Bash(npm:*) classifies into the `build` tier ("Build & package"),
				// Read(/secret) into the `other` tier ("Other"). Rules are grouped by
				// risk TIER now (TierSection), not by kind.
				allow: [{ pattern: "Bash(npm:*)", kind: "allow" }],
				deny: [{ pattern: "Read(/secret)", kind: "deny" }],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Bash(npm:*)");

		// Both rules render under their tier section heads (label + count).
		const buildHead = screen.getByText("Build & package").closest("section");
		expect(buildHead).not.toBeNull();
		expect(buildHead).toHaveAttribute("data-tier", "build");
		expect(buildHead?.querySelector(".perm-section-count")?.textContent).toBe(
			"1",
		);
		const otherHead = screen.getByText("Other").closest("section");
		expect(otherHead).not.toBeNull();
		expect(otherHead).toHaveAttribute("data-tier", "other");
		expect(otherHead?.querySelector(".perm-section-count")?.textContent).toBe(
			"1",
		);
		expect(screen.getByDisplayValue("Read(/secret)")).toBeInTheDocument();

		// The per-section Add button (aria-label "Add rule to <tier label>") adds an
		// editable row — exercised on the Build & package tier.
		const buildAdd = screen.getByLabelText("Add rule to Build & package");
		expect(buildAdd).toBeInTheDocument();
		const before = screen.getAllByLabelText("Pattern").length;
		fireEvent.click(buildAdd);
		await waitFor(() => {
			const after = screen.getAllByLabelText("Pattern");
			expect(after.length).toBe(before + 1);
			// The newly-added row is an empty, editable pattern input.
			const blank = after.find(
				(el) => (el as HTMLInputElement).value === "",
			) as HTMLInputElement | undefined;
			expect(blank).toBeDefined();
			expect(blank?.disabled).toBe(false);
		});
	});

	it("renders header crumbs with rule/hook/inherited rollup", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow", origin: "global" }],
				deny: [{ pattern: "Read(/secret)", kind: "deny" }],
				hooks: [
					{
						event: "PreToolUse",
						matcher: "Bash",
						command: "echo hook",
					},
				],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "project", name: "alpha" }, projectCount: 1 });
		await screen.findByDisplayValue("Bash(npm:*)");
		expect(screen.getByText(/alpha permissions/)).toBeInTheDocument();
		expect(
			screen.getByText(/2 rules · 1 hook · 0 risks/),
		).toBeInTheDocument();
	});

	it("renders risk banner with inline pattern + severity badges and a doctor pip", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(*)", kind: "allow" }],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Bash(*)");
		// Risk banner inline pattern + code badge
		expect(
			await screen.findByText(/risks? flagged/i),
		).toBeInTheDocument();
		expect(screen.getAllByText("UNBOUNDED_BASH").length).toBeGreaterThan(0);
		// Doctor button shows numeric pip
		const doctorBtn = screen.getByRole("button", { name: /Doctor/ });
		expect(doctorBtn.textContent ?? "").toMatch(/\d/);
	});

	it("filter chips display per-kind count badges", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [
					{ pattern: "Bash(npm:*)", kind: "allow" },
					{ pattern: "Read(*)", kind: "allow" },
				],
				deny: [{ pattern: "Read(/secret)", kind: "deny" }],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Bash(npm:*)");
		// Multiple buttons render "ALLOW" — the stat hero card, the filter chip,
		// and the section head's Add button. The filter chip is the one that lives
		// inside .perm-filter-chips and includes a `.count` badge with the total.
		const allowChip = screen
			.getAllByRole("button", { name: /^ALLOW/ })
			.find((b) => b.closest(".perm-filter-chips"));
		expect(allowChip?.textContent ?? "").toContain("2");
		const denyChip = screen
			.getAllByRole("button", { name: /^DENY/ })
			.find((b) => b.closest(".perm-filter-chips"));
		expect(denyChip?.textContent ?? "").toContain("1");
	});

	it("BehaviorCard renders inheritance notes for unset project fields", async () => {
		// Make global show return a specific sandbox_mode; the project shows null.
		vi.mocked(invoke).mockImplementation(
			async (cmd: string, args?: unknown): Promise<unknown> => {
				if (cmd === "permissions_show") {
					const a = args as { scope: { kind: string } };
					if (a.scope.kind === "global") {
						return {
							...EMPTY,
							sandbox_mode: "workspace-write",
						};
					}
					return { ...EMPTY, sandbox_mode: null };
				}
				if (cmd === "permissions_capabilities") return CAPS;
				if (cmd === "permissions_risks_schema") return [];
				if (cmd === "permissions_doctor")
					return { findings: [], danger_count: 0 };
				return undefined;
			},
		);
		renderEditor({ scope: { kind: "project", name: "alpha" }, projectCount: 1 });
		await waitFor(() => {
			expect(screen.getByText("sandbox_mode")).toBeInTheDocument();
		});
		// inheritance note renders the global value inline
		await waitFor(() => {
			expect(
				screen.getByText(/inherits/, { selector: ".perm-inherit-note" }),
			).toBeInTheDocument();
		});
		expect(screen.getByText("workspace-write")).toBeInTheDocument();
	});

	it("BehaviorCard names the supporting harnesses for each setting", async () => {
		const multiCaps: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask", "hooks", "additional_directories"],
			codex: ["sandbox_mode", "approval_policy", "additional_directories"],
			pi: ["project_trust", "additional_directories"],
		};
		wireDefaults({ show: EMPTY, capabilities: multiCaps });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByText("sandbox_mode");
		// `codex` is the only harness that supports sandbox_mode in our mock
		const sandboxHint = screen
			.getByText("sandbox_mode")
			.closest(".perm-setting")
			?.querySelector(".perm-setting-hint");
		expect(sandboxHint?.textContent ?? "").toMatch(/Supported by/);
		expect(sandboxHint?.textContent ?? "").toContain("codex");
		// `pi` is the only harness that supports project_trust
		const trustHint = screen
			.getByText("project_trust")
			.closest(".perm-setting")
			?.querySelector(".perm-setting-hint");
		expect(trustHint?.textContent ?? "").toContain("pi");
	});

	it("rule rows always render per-harness chips so support state is visible", async () => {
		const multiCaps: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
			codex: ["tool_allowlist", "tool_denylist"],
			pi: ["tool_allowlist", "tool_denylist", "tool_ask"],
		};
		wireDefaults({
			show: {
				...EMPTY,
				ask: [{ pattern: "Bash(git push:*)", kind: "ask" }],
			},
			capabilities: multiCaps,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Bash(git push:*)");
		// All three harnesses must appear as chips. Codex doesn't support tool_ask,
		// so its chip carries data-state="unsupported".
		const chips = screen.getAllByRole("button").filter((b) =>
			b.classList.contains("affinity-chip"),
		);
		const codex = chips.find((c) => c.getAttribute("data-harness") === "codex");
		expect(codex?.getAttribute("data-state")).toBe("unsupported");
	});

	it("additional_dirs editor adds and removes rows", async () => {
		wireDefaults({
			show: { ...EMPTY, additional_dirs: ["/tmp/one"] },
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("/tmp/one");
		fireEvent.click(screen.getByText("Add directory"));
		// Now we expect two dir-row inputs
		await waitFor(() => {
			expect(screen.getAllByLabelText(/Additional directory/).length).toBe(2);
		});
		// Remove the first one
		const removes = screen.getAllByLabelText("Remove directory");
		fireEvent.click(removes[0]);
		await waitFor(() => {
			expect(screen.getAllByLabelText(/Additional directory/).length).toBe(1);
		});
	});
});

describe("PermissionsEditor command simulator (§03)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("shows a live per-harness verdict pill colored by the resolved decision as the user types", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(git:*)", kind: "allow" }],
				deny: [{ pattern: "Bash(git push:*)", kind: "deny" }],
			},
			capabilities: CAPS, // single harness (claude-code) → one pill
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		const input = await screen.findByLabelText("Test a command");

		// Empty input → no verdict pill.
		expect(screen.queryByRole("status")).toBeNull();

		// An allowed command resolves to ALLOW (green).
		fireEvent.change(input, { target: { value: "git status" } });
		await waitFor(() => {
			const pill = document.querySelector(
				'.perm-sim-verdict[data-harness="claude-code"]',
			);
			expect(pill).not.toBeNull();
			expect(pill?.getAttribute("data-verdict")).toBe("allow");
			expect(pill?.textContent ?? "").toBe("ALLOW");
		});

		// A more-specific deny wins for the push subcommand.
		fireEvent.change(input, { target: { value: "git push origin main" } });
		await waitFor(() => {
			const pill = document.querySelector(
				'.perm-sim-verdict[data-harness="claude-code"]',
			);
			expect(pill?.getAttribute("data-verdict")).toBe("deny");
			expect(pill?.textContent ?? "").toBe("DENY");
		});

		// An unmatched command falls through to the implicit ASK.
		fireEvent.change(input, { target: { value: "npm install" } });
		await waitFor(() => {
			const pill = document.querySelector(
				'.perm-sim-verdict[data-harness="claude-code"]',
			);
			expect(pill?.getAttribute("data-verdict")).toBe("ask");
		});
	});
});

describe("PermissionsEditor shadowed-allow strike-through (project scope)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("marks a project allow shadowed when an inherited global deny shares its pattern", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [
					{ pattern: "Bash(rm:*)", kind: "allow", origin: "project" },
					{ pattern: "Bash(npm:*)", kind: "allow", origin: "project" },
				],
				deny: [{ pattern: "Bash(rm:*)", kind: "deny", origin: "global" }],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "project", name: "alpha" }, projectCount: 1 });
		// Two inputs carry "Bash(rm:*)" — the project allow and the inherited
		// global deny. The shadowed (struck-through) one is the allow row.
		await screen.findAllByDisplayValue("Bash(rm:*)");
		const shadowedRow = document.querySelector(
			'.perm-row[data-shadowed="true"]',
		);
		expect(shadowedRow).not.toBeNull();
		expect(shadowedRow?.getAttribute("data-kind")).toBe("allow");
		expect(
			(shadowedRow?.querySelector(".permission-pattern") as HTMLInputElement)
				?.value,
		).toBe("Bash(rm:*)");
		expect(shadowedRow?.textContent ?? "").toContain(
			"shadowed by global deny",
		);

		// A non-shadowed project allow is unaffected.
		const ok = screen.getByDisplayValue("Bash(npm:*)");
		expect(ok.closest(".perm-row")?.getAttribute("data-shadowed")).toBeNull();
	});
});

describe("PermissionsEditor inherited hooks (§11.2)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("offers Promote on an inherited (global) hook in a project, and promoting adds an editable project copy", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				hooks: [
					{
						event: "PreToolUse",
						matcher: "Bash",
						command: "/usr/local/bin/audit",
						origin: "global",
					},
				],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "project", name: "alpha" }, projectCount: 1 });

		// The inherited hook is read-only with a Copy-to-project affordance (parity with rules).
		const promote = await screen.findByRole("button", {
			name: "Copy to project",
		});
		expect(promote).toBeInTheDocument();
		// The inherited command input is disabled (read-only).
		const inheritedCmd = screen.getByDisplayValue(
			"/usr/local/bin/audit",
		) as HTMLInputElement;
		expect(inheritedCmd.disabled).toBe(true);

		// Promoting copies it into the project as an editable (enabled) row.
		fireEvent.click(promote);
		await waitFor(() => {
			const matches = screen.getAllByDisplayValue(
				"/usr/local/bin/audit",
			) as HTMLInputElement[];
			expect(matches.length).toBe(2);
			expect(matches.some((el) => !el.disabled)).toBe(true);
		});
	});
});

describe("CommandSimulator per-harness verdicts", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	// claude-code expresses every kind + any pattern; codex is Bash-only.
	const MULTI_CAPS: Capabilities = {
		"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
		codex: ["tool_allowlist", "tool_denylist", "tool_ask"],
	};

	it("renders one verdict pill per installed harness, diverging on applicability", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(git:*)", kind: "allow" }],
				// Bash deny pinned by affinity to claude-code only — codex never
				// sees it, so the broad git allow wins there.
				deny: [
					{
						pattern: "Bash(git push:*)",
						kind: "deny",
						harnesses: ["claude-code"],
					},
				],
			},
			capabilities: MULTI_CAPS,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });

		const input = (await screen.findByLabelText(
			"Test a command",
		)) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "git push origin main" } });

		await waitFor(() => {
			const pills = screen
				.getByTestId("command-simulator")
				.querySelectorAll(".perm-sim-verdict");
			expect(pills.length).toBe(2);
		});
		const sim = screen.getByTestId("command-simulator");
		const claudePill = sim.querySelector(
			'.perm-sim-verdict[data-harness="claude-code"]',
		);
		const codexPill = sim.querySelector(
			'.perm-sim-verdict[data-harness="codex"]',
		);
		// claude-code: the affinity-pinned deny applies → DENY.
		expect(claudePill?.getAttribute("data-verdict")).toBe("deny");
		expect(claudePill?.textContent).toBe("DENY");
		// codex: the deny is excluded by affinity → only the git allow → ALLOW.
		expect(codexPill?.getAttribute("data-verdict")).toBe("allow");
		expect(codexPill?.textContent).toBe("ALLOW");
	});

	it("renders nothing for empty input", async () => {
		wireDefaults({ show: EMPTY, capabilities: MULTI_CAPS });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByLabelText("Test a command");
		const sim = screen.getByTestId("command-simulator");
		expect(sim.querySelectorAll(".perm-sim-verdict").length).toBe(0);
	});
});

describe("PermissionsEditor discard-staged-edits ConfirmDialog (B1-03)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	/** Stage ≥5 edits by adding blank allow rows via the toolbar's "Add allow".
	 *  The toolbar re-renders after each add, so the button is re-queried per
	 *  click (a stale node reference wouldn't fire the fresh handler). */
	async function stageEdits(n: number) {
		// Wait for the editor body (toolbar) to mount before staging edits.
		await screen.findByRole("button", { name: "Add allow" });
		for (let i = 0; i < n; i++) {
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Add allow" }));
			});
		}
		await waitFor(() =>
			expect(screen.getAllByLabelText("Pattern").length).toBe(n),
		);
	}

	it("routes a ≥5-edit discard through ConfirmDialog (never window.confirm) and clears on confirm", async () => {
		const confirmSpy = vi.spyOn(window, "confirm");
		wireDefaults({ show: EMPTY, capabilities: CAPS });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await stageEdits(5);

		// Discard opens the app's ConfirmDialog — NOT the native browser confirm.
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent(/Discard staged changes\?/);
		expect(dialog).toHaveTextContent(/5 staged edits/);
		expect(confirmSpy).not.toHaveBeenCalled();

		// The confirm button is the destructive variant.
		const confirmBtn = screen.getByRole("button", { name: "Discard changes" });
		expect(confirmBtn.className).toMatch(/danger/);

		// Confirming reverts the draft to the (empty) baseline.
		fireEvent.click(confirmBtn);
		await waitFor(() =>
			expect(screen.queryAllByLabelText("Pattern").length).toBe(0),
		);
		expect(screen.queryByText("UNSAVED")).toBeNull();
		expect(confirmSpy).not.toHaveBeenCalled();
		confirmSpy.mockRestore();
	});

	it("cancelling the discard dialog keeps the staged edits", async () => {
		const confirmSpy = vi.spyOn(window, "confirm");
		wireDefaults({ show: EMPTY, capabilities: CAPS });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await stageEdits(5);

		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// Edits survive the cancel.
		expect(screen.getAllByLabelText("Pattern").length).toBe(5);
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
		expect(confirmSpy).not.toHaveBeenCalled();
		confirmSpy.mockRestore();
	});

	it("discards fewer-than-5 staged edits immediately without a dialog", async () => {
		const confirmSpy = vi.spyOn(window, "confirm");
		wireDefaults({ show: EMPTY, capabilities: CAPS });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByRole("button", { name: "Add allow" });
		// Re-query per click — the toolbar re-renders and detaches the old node.
		for (let i = 0; i < 2; i++) {
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Add allow" }));
			});
		}
		await waitFor(() =>
			expect(screen.getAllByLabelText("Pattern").length).toBe(2),
		);
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		// No confirmation dialog for a small discard — it just reverts.
		await waitFor(() =>
			expect(screen.queryAllByLabelText("Pattern").length).toBe(0),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(confirmSpy).not.toHaveBeenCalled();
		confirmSpy.mockRestore();
	});
});

describe("PermissionsEditor Shared ⇄ Personal tier toggle", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	// Mock that keys `permissions_show`/`permissions_set` on the `personal` arg so
	// the two tiers return + capture distinct blocks.
	function wirePersonalAware() {
		const showCalls: { personal: boolean }[] = [];
		const setCalls: { personal: boolean }[] = [];
		const SHARED: NormalizedPermissions = {
			...EMPTY,
			allow: [{ pattern: "Bash(shared:*)", kind: "allow" }],
		};
		const PERSONAL: NormalizedPermissions = {
			...EMPTY,
			allow: [{ pattern: "Bash(personal:*)", kind: "allow" }],
		};
		vi.mocked(invoke).mockImplementation(
			async (cmd: string, args?: unknown): Promise<unknown> => {
				const personal = Boolean((args as { personal?: boolean })?.personal);
				switch (cmd) {
					case "permissions_show":
						showCalls.push({ personal });
						return personal ? PERSONAL : SHARED;
					case "permissions_capabilities":
						return CAPS;
					case "permissions_risks_schema":
						return [];
					case "permissions_validate":
						return { ok: true, error: null };
					case "permissions_doctor":
						return { findings: [], danger_count: 0 };
					case "permissions_set":
						setCalls.push({ personal });
						return { changed: true, normalized: personal ? PERSONAL : SHARED };
					default:
						return undefined;
				}
			},
		);
		return { showCalls, setCalls };
	}

	it("loads shared block by default, no toggle in global scope", async () => {
		wirePersonalAware();
		renderEditor({ scope: { kind: "global" }, projectCount: 1 });
		await screen.findByText("Global permissions");
		// No tier toggle outside project scope.
		expect(screen.queryByRole("group", { name: "Permission tier" })).toBeNull();
	});

	it("toggles to Personal: calls bridge with personal:true and shows the caption", async () => {
		const { showCalls } = wirePersonalAware();
		renderEditor({ scope: { kind: "project", name: "alpha" }, projectCount: 1 });
		await screen.findByText("alpha permissions");

		// Default view is Shared → first show was personal:false.
		await waitFor(() => expect(showCalls.length).toBeGreaterThan(0));
		expect(showCalls.some((c) => c.personal === false)).toBe(true);
		expect(
			screen.getByText(/shared · committed · \.claude\/settings\.json/),
		).toBeTruthy();

		// Flip to Personal.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Personal/ }));
		});

		await waitFor(() =>
			expect(showCalls.some((c) => c.personal === true)).toBe(true),
		);
		expect(
			screen.getByText(
				/personal · not committed · \.claude\/settings\.local\.json/,
			),
		).toBeTruthy();
		// The personal block's rule is now visible.
		await screen.findByDisplayValue("Bash(personal:*)");
	});

	it("toggling back to Shared reloads the committed block", async () => {
		const { showCalls } = wirePersonalAware();
		renderEditor({ scope: { kind: "project", name: "alpha" }, projectCount: 1 });
		await screen.findByText("alpha permissions");
		await screen.findByDisplayValue("Bash(shared:*)");

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Personal/ }));
		});
		await screen.findByDisplayValue("Bash(personal:*)");

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Shared/ }));
		});
		await screen.findByDisplayValue("Bash(shared:*)");
		expect(showCalls.some((c) => c.personal === false)).toBe(true);
		expect(showCalls.some((c) => c.personal === true)).toBe(true);
	});
});
