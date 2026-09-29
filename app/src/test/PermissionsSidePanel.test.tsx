import { join } from "node:path";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";

import { PermissionsEditor } from "@/components/PermissionsEditor";
import { expectOnlySidePanelSections } from "./helpers/disclosureGuard";
import { makeQueryClient } from "./helpers";
import type {
	Capabilities,
	NormalizedPermissions,
	PermissionsShowGlobal,
} from "@/types/permissions";

const SIDE_PANEL_SOURCE_FILES = [
	join(process.cwd(), "src", "components", "permissions", "PermissionsSidePanel.tsx"),
	join(process.cwd(), "src", "components", "permissions", "PermissionSettingRow.tsx"),
	join(process.cwd(), "src", "components", "permissions", "CodexRulesSection.tsx"),
	join(process.cwd(), "src", "components", "permissions", "CommandSimulator.tsx"),
];

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

// claude-code only, no `sandbox_mode`/`approval_policy`/`project_trust` — the
// single-installed-harness fixture (d).
const SOLE_CAPS: Capabilities = {
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
	vi.mocked(invoke).mockImplementation(
		async (cmd: string): Promise<unknown> => {
			switch (cmd) {
				case "permissions_show":
					return show;
				case "permissions_capabilities":
					return capabilities;
				case "permissions_risks_schema":
					return [];
				case "permissions_validate":
					return { ok: true, error: null };
				case "permissions_doctor":
					return { findings: [], danger_count: 0 };
				case "permissions_recent_imports":
					return [];
				default:
					return undefined;
			}
		},
	);
}

function renderEditor(props: React.ComponentProps<typeof PermissionsEditor>) {
	const client = makeQueryClient();
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<PermissionsEditor {...props} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("PermissionsSidePanel — harness selector", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("the tab strip filters the rule list AND switches the panel view (a)", async () => {
		const caps: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
			codex: ["tool_allowlist", "tool_denylist", "tool_ask"],
		};
		wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Read(src/**)", kind: "allow" }] },
			capabilities: caps,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Read(src/**)");
		expect(document.querySelector(".perm-side")).toHaveAttribute(
			"data-view",
			"all",
		);

		fireEvent.click(screen.getByRole("button", { name: "Codex" }));

		// Codex is Bash-only (HARNESS_PATTERN_SUPPORT) — a Read(...) rule drops
		// out of the filtered list.
		await waitFor(() => {
			expect(screen.queryByDisplayValue("Read(src/**)")).toBeNull();
		});
		expect(document.querySelector(".perm-side")).toHaveAttribute(
			"data-view",
			"codex",
		);
		// The tab strip is glyph-only — the HARNESS fact row is what names the
		// active mode.
		expect(screen.getByTestId("perm-side-harness-name")).toHaveTextContent(
			"Codex",
		);
	});

	it("single installed harness: no tab strip, settings render flat (d)", async () => {
		wireDefaults({ show: EMPTY, capabilities: SOLE_CAPS });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByText("additional_dirs");
		expect(document.querySelector(".perm-harness-tabs")).toBeNull();
		expect(screen.queryByText(/^ONLY /)).toBeNull();
		expect(screen.queryByText("SHARED")).toBeNull();
		// The HARNESS fact row names the mode even with no strip to switch it.
		expect(screen.getByTestId("perm-side-harness-name")).toHaveTextContent(
			"Claude Code",
		);
	});
});

describe("PermissionsSidePanel — Codex rules file (b)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders a table (no <pre>) and Copy Starlark writes the exact prefix_rule lines", async () => {
		const caps: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
			codex: ["tool_allowlist", "tool_denylist", "tool_ask", "sandbox_mode"],
		};
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		wireDefaults({
			show: {
				...EMPTY,
				allow: [{ pattern: "Bash(npm:*)", kind: "allow" }],
				ask: [{ pattern: "Bash(git push:*)", kind: "ask" }],
			},
			capabilities: caps,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Bash(npm:*)");
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));

		const preview = await screen.findByTestId("codex-rules-preview");
		expect(preview.querySelector("pre")).toBeNull();
		expect(preview.querySelectorAll(".perm-codex-row")).toHaveLength(2);
		expect(within(preview).getByText("prompt")).toBeInTheDocument();
		expect(within(preview).getByText("allow")).toBeInTheDocument();

		fireEvent.click(
			within(preview).getByRole("button", { name: /Copy Starlark/ }),
		);
		await waitFor(() => expect(writeText).toHaveBeenCalled());
		expect(writeText.mock.calls[0][0]).toBe(
			[
				'prefix_rule(pattern = ["npm"], decision = "allow")',
				'prefix_rule(pattern = ["git", "push"], decision = "prompt")',
				"",
			].join("\n"),
		);
	});
});

describe("PermissionsSidePanel — Codex trust plaque (c)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	const caps: Capabilities = {
		"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
		codex: ["tool_allowlist", "tool_denylist", "tool_ask"],
	};

	it("renders in the All view already — it must not depend on a filter click", async () => {
		wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: caps,
		});
		renderEditor({
			scope: { kind: "project", name: "alpha" },
			projectCount: 1,
		});
		await screen.findByDisplayValue("Bash(npm:*)");
		expect(document.querySelector(".perm-side")).toHaveAttribute(
			"data-view",
			"all",
		);
		expect(await screen.findByTestId("codex-trust-plaque")).toBeInTheDocument();
	});

	it("stays visible after switching to the Codex tab", async () => {
		wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: caps,
		});
		renderEditor({
			scope: { kind: "project", name: "alpha" },
			projectCount: 1,
		});
		await screen.findByDisplayValue("Bash(npm:*)");
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		expect(await screen.findByTestId("codex-trust-plaque")).toBeInTheDocument();
	});

	it("does not render for global scope", async () => {
		wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: caps,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Bash(npm:*)");
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		await screen.findByTestId("codex-rules-preview");
		expect(screen.queryByTestId("codex-trust-plaque")).toBeNull();
	});
});

describe("PermissionsSidePanel — disclosure guard (e)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("only SidePanelSection toggles exist, in both the All and a harness view", async () => {
		const caps: Capabilities = {
			"claude-code": [
				"tool_allowlist",
				"tool_denylist",
				"tool_ask",
				"hooks",
				"additional_directories",
			],
			codex: ["tool_allowlist", "tool_denylist", "tool_ask", "sandbox_mode"],
		};
		wireDefaults({
			show: { ...EMPTY, allow: [{ pattern: "Bash(npm:*)", kind: "allow" }] },
			capabilities: caps,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByDisplayValue("Bash(npm:*)");
		const panel = document.querySelector(".perm-side") as HTMLElement;

		// All view: simulate, shared, syntax.
		expectOnlySidePanelSections(panel, 3, SIDE_PANEL_SOURCE_FILES);

		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		await screen.findByTestId("codex-rules-preview");

		// Codex harness view: simulate, settings, codex-rules, syntax.
		expectOnlySidePanelSections(panel, 4, SIDE_PANEL_SOURCE_FILES);
	});
});

describe("PermissionsSidePanel — hooks row (f)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders the hooks row in a harness view only when that harness has the hooks capability", async () => {
		const caps: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask", "hooks"],
			codex: ["tool_allowlist", "tool_denylist", "tool_ask"],
		};
		wireDefaults({
			show: { ...EMPTY, hooks: [{ event: "PreToolUse", matcher: "Bash", command: "echo hi" }] },
			capabilities: caps,
		});
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findAllByText("ALLOW");
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		await waitFor(() => {
			expect(document.querySelector(".perm-side")).toHaveAttribute(
				"data-view",
				"codex",
			);
		});
		// codex has no `hooks` capability — no pointer row in its view.
		expect(screen.queryByTestId("hooks-link-card")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
		await waitFor(() => {
			expect(document.querySelector(".perm-side")).toHaveAttribute(
				"data-view",
				"claude-code",
			);
		});
		expect(screen.getByTestId("hooks-link-card")).toBeInTheDocument();
	});
});

describe("PermissionsSidePanel — ONLY-group settings stack, not a row (regression)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders every ONLY-group setting as a full-block sibling inside one [data-group=\"only\"] container, and the label shows", async () => {
		const caps: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
			codex: [
				"tool_allowlist",
				"tool_denylist",
				"tool_ask",
				"sandbox_mode",
				"approval_policy",
				"project_trust",
			],
		};
		wireDefaults({ show: EMPTY, capabilities: caps });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findAllByText("ALLOW");
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		await screen.findByText("sandbox_mode");

		// The sub-group label renders even though it's the ONLY populated group
		// (SHARED has nothing) — the earlier bug swallowed this label visually.
		expect(screen.getByText("ONLY CODEX")).toBeInTheDocument();

		const group = document.querySelector('[data-group="only"]');
		expect(group).not.toBeNull();
		const settingRows = Array.from(
			(group as HTMLElement).querySelectorAll(".perm-setting"),
		);
		expect(settingRows).toHaveLength(3);
		// Every row is a direct child of the group wrapper — a SIBLING of the
		// `.equip-group` label, never nested inside it (nesting them made every
		// row a flex ITEM of the label's row instead of a stacked block).
		for (const row of settingRows) {
			expect(row.parentElement).toBe(group);
		}
		const label = (group as HTMLElement).querySelector(".equip-group");
		expect(label).not.toBeNull();
		expect(label?.contains(settingRows[0])).toBe(false);
	});
});

describe("PermissionsSidePanel — zero installed harnesses (fix-3)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders all four settings as live controls under All — never hidden", async () => {
		wireDefaults({ show: EMPTY, capabilities: {} });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findByText("sandbox_mode");
		expect(screen.getByText("approval_policy")).toBeInTheDocument();
		expect(screen.getByText("project_trust")).toBeInTheDocument();
		expect(screen.getByText("additional_dirs")).toBeInTheDocument();
		// A live control, not a placeholder.
		expect(
			screen.getByRole("combobox", { name: "sandbox_mode" }),
		).toBeInTheDocument();
		expect(document.querySelector(".perm-harness-tabs")).toBeNull();
	});
});

describe("PermissionsSidePanel — rule 11: a staged setting edit force-opens Settings", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("changing sandbox_mode force-opens the section and disables its toggle — the body stays visible even if you try to collapse it", async () => {
		const caps: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
			codex: [
				"tool_allowlist",
				"tool_denylist",
				"tool_ask",
				"sandbox_mode",
			],
		};
		wireDefaults({ show: EMPTY, capabilities: caps });
		renderEditor({ scope: { kind: "global" }, projectCount: 0 });
		await screen.findAllByText("ALLOW");
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		await screen.findByText("sandbox_mode");

		const toggle = screen.getByTestId("side-section-settings");
		expect(toggle).not.toBeDisabled();

		fireEvent.click(screen.getByRole("combobox", { name: "sandbox_mode" }));
		fireEvent.click(screen.getByRole("option", { name: /workspace-write/ }));

		await waitFor(() => expect(toggle).toBeDisabled());
		expect(screen.getByText("unsaved")).toBeInTheDocument();

		// A press while forced is a no-op: the body stays visible, the section
		// stays expanded.
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("sandbox_mode")).toBeInTheDocument();
	});
});
