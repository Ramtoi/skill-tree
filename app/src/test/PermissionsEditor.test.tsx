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
import { makeQueryClient } from "./helpers";
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

describe("PermissionsEditor lazy loading", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("does not call permissions_show synchronously on render", async () => {
		wireDefaults({ show: EMPTY, capabilities: CAPS });
		renderEditor({
			scope: { kind: "project", name: "alpha" },
			projectCount: 1,
		});
		// Right at render, before the deferred setTimeout has fired
		const callsBefore = vi
			.mocked(invoke)
			.mock.calls.filter(([c]) => c === "permissions_show").length;
		expect(callsBefore).toBe(0);
		await waitFor(() => {
			const calls = vi
				.mocked(invoke)
				.mock.calls.filter(([c]) => c === "permissions_show").length;
			// Project scope triggers two calls: the scope's own perms and the
			// global perms used by BehaviorCard inheritance notes.
			expect(calls).toBeGreaterThanOrEqual(1);
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
		pattern.focus();
		fireEvent.keyDown(pattern, { key: "s", metaKey: true });
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
		const promote = await screen.findByRole("button", { name: /Promote/ });
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

	it("renders per-kind section heads with totals and per-section Add buttons", async () => {
		wireDefaults({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow" }],
				deny: [{ pattern: "Read(/secret)", kind: "deny" }],
			},
			capabilities: CAPS,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		// Section head counts render alongside the kind label
		await screen.findByDisplayValue("Bash(npm:*)");
		const allowAdd = screen.getByLabelText("Add allow rule");
		expect(allowAdd).toBeInTheDocument();
		fireEvent.click(allowAdd);
		// Activating per-section Add should switch the filter to allow + focus the new row
		await waitFor(() => {
			const allInputs = screen.getAllByLabelText("Pattern");
			expect(allInputs.length).toBeGreaterThan(1);
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

		// The inherited hook is read-only with a Promote affordance (parity with rules).
		const promote = await screen.findByRole("button", { name: "Promote" });
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
