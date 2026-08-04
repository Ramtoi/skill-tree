import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { PresetsSheet } from "@/components/PresetsSheet";
import { BUILTIN_PRESETS } from "@/lib/permissionPresets";
import type { Registry } from "@/types";
import type { Rule, Scope } from "@/types/permissions";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
} from "./helpers";

const GIT_SAFE = BUILTIN_PRESETS.find((p) => p.id === "git-safe")!;

function noopRegistry(): Registry {
	return { ...sampleRegistry };
}

function setupSheet(opts: {
	currentRules?: Rule[];
	registry?: Registry;
	scope?: Scope;
	onApplyRules?: (rules: Rule[]) => void;
	onClose?: () => void;
}) {
	const client = makeQueryClient();
	primeRegistry(client, opts.registry ?? noopRegistry());
	const result = renderWithProviders(
		<PresetsSheet
			open={true}
			scope={opts.scope ?? { kind: "global" }}
			currentRules={opts.currentRules ?? []}
			onApplyRules={opts.onApplyRules ?? (() => {})}
			onClose={opts.onClose ?? (() => {})}
		/>,
		{ client },
	);
	return { ...result, client };
}

describe("PresetsSheet — rendering", () => {
	it("renders the title and both built-in presets", () => {
		setupSheet({});
		expect(screen.getByText("Permission Presets")).toBeInTheDocument();
		// "Git (safe)" appears twice — in the left list and the active right
		// panel header. Use getAllByText to assert both exist.
		expect(screen.getAllByText("Git (safe)").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("Android Gradle")).toBeInTheDocument();
	});

	it("opens with the first built-in preset (git-safe) selected", () => {
		setupSheet({});
		// git-safe is the active row → its description is in the right panel.
		expect(
			screen.getByText(/Non-destructive git inspection commands/i),
		).toBeInTheDocument();
	});

	it("returns null when open=false", () => {
		const { container } = renderWithProviders(
			<PresetsSheet
				open={false}
				scope={{ kind: "global" }}
				currentRules={[]}
				onApplyRules={() => {}}
				onClose={() => {}}
			/>,
		);
		expect(container.firstChild).toBeNull();
	});
});

describe("PresetsSheet — toggle + apply", () => {
	it("apply button count matches the number of defaults", () => {
		setupSheet({});
		const defaultCount = GIT_SAFE.rules.filter(
			(r) => r.enabledByDefault,
		).length;
		expect(
			screen.getByRole("button", {
				name: new RegExp(`Apply ${defaultCount} rule`),
			}),
		).toBeInTheDocument();
	});

	it("unchecking a rule decrements the apply count", () => {
		setupSheet({});
		const defaultCount = GIT_SAFE.rules.filter(
			(r) => r.enabledByDefault,
		).length;
		const checkbox = screen.getByLabelText("Toggle Bash(git log*)");
		expect(checkbox).toBeChecked();
		fireEvent.click(checkbox);
		expect(checkbox).not.toBeChecked();
		expect(
			screen.getByRole("button", {
				name: new RegExp(`Apply ${defaultCount - 1} rule`),
			}),
		).toBeInTheDocument();
	});

	it("Apply button is disabled when all rules are unchecked", () => {
		setupSheet({});
		for (const r of GIT_SAFE.rules) {
			const cb = screen.getByLabelText(`Toggle ${r.pattern}`) as HTMLInputElement;
			if (cb.checked) fireEvent.click(cb);
		}
		const applyBtn = screen.getByRole("button", { name: /Apply rules/i });
		expect(applyBtn).toBeDisabled();
	});

	it("clicking Apply invokes onApplyRules with exactly the checked rules", () => {
		const onApply = vi.fn();
		const onClose = vi.fn();
		setupSheet({ onApplyRules: onApply, onClose });
		// Uncheck everything first
		for (const r of GIT_SAFE.rules) {
			const cb = screen.getByLabelText(`Toggle ${r.pattern}`) as HTMLInputElement;
			if (cb.checked) fireEvent.click(cb);
		}
		// Re-check exactly two
		fireEvent.click(screen.getByLabelText("Toggle Bash(git status*)"));
		fireEvent.click(screen.getByLabelText("Toggle Bash(git log*)"));
		fireEvent.click(
			screen.getByRole("button", { name: /Apply 2 rules/i }),
		);
		expect(onApply).toHaveBeenCalledTimes(1);
		const arg = onApply.mock.calls[0][0] as Rule[];
		expect(arg.map((r) => r.pattern).sort()).toEqual([
			"Bash(git log*)",
			"Bash(git status*)",
		]);
		// All emitted rules are `allow` kind.
		expect(arg.every((r) => r.kind === "allow")).toBe(true);
		// Sheet closes after apply.
		expect(onClose).toHaveBeenCalled();
	});

	it("Select all checks every selectable rule", () => {
		setupSheet({});
		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		for (const r of GIT_SAFE.rules) {
			const cb = screen.getByLabelText(`Toggle ${r.pattern}`) as HTMLInputElement;
			expect(cb).toBeChecked();
		}
	});

	it("Select defaults restores the enabledByDefault checkboxes", () => {
		setupSheet({});
		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		// Now defaults: git fetch is off by default
		fireEvent.click(screen.getByRole("button", { name: "Select defaults" }));
		const fetchCb = screen.getByLabelText(
			"Toggle Bash(git fetch*)",
		) as HTMLInputElement;
		expect(fetchCb).not.toBeChecked();
		const logCb = screen.getByLabelText(
			"Toggle Bash(git log*)",
		) as HTMLInputElement;
		expect(logCb).toBeChecked();
	});
});

describe("PresetsSheet — already added detection", () => {
	it("renders an already-present rule as disabled with an indicator", () => {
		setupSheet({
			currentRules: [{ pattern: "Bash(git log*)", kind: "allow" }],
		});
		const cb = screen.getByLabelText(
			"Toggle Bash(git log*)",
		) as HTMLInputElement;
		expect(cb).toBeDisabled();
		// The row carries an "already added" indicator (multiple may exist if more
		// pre-existing rules are present; here only one).
		expect(screen.getByText(/already added/i)).toBeInTheDocument();
	});

	it("excludes already-added rules from the Apply count", () => {
		setupSheet({
			currentRules: [{ pattern: "Bash(git log*)", kind: "allow" }],
		});
		const defaultCount = GIT_SAFE.rules.filter(
			(r) => r.enabledByDefault,
		).length;
		// git log was a default, so apply count drops by one.
		expect(
			screen.getByRole("button", {
				name: new RegExp(`Apply ${defaultCount - 1} rule`),
			}),
		).toBeInTheDocument();
	});
});

describe("PresetsSheet — edit affordances", () => {
	it("built-in presets show no edit affordance", () => {
		setupSheet({});
		// The active preset is git-safe (built-in).
		expect(screen.queryByLabelText("Edit preset")).not.toBeInTheDocument();
	});

	it("user presets show an edit button", async () => {
		const reg: Registry = {
			...noopRegistry(),
			permission_presets: {
				"my-tools": {
					name: "My tools",
					description: "personal helpers",
					icon: "🔧",
					category: "custom",
					rules: [
						{
							pattern: "Bash(npm run *)",
							kind: "allow",
							description: "npm scripts",
							enabled_by_default: true,
						},
					],
				},
			},
		};
		setupSheet({ registry: reg });
		// Switch to the user preset.
		fireEvent.click(screen.getByRole("button", { name: /My tools/ }));
		expect(screen.getByLabelText("Edit preset")).toBeInTheDocument();
	});
});

describe("PresetsSheet — snapshot", () => {
	it("matches the git-safe baseline structure (no edit controls)", () => {
		const { container } = renderWithProviders(
			<PresetsSheet
				open={true}
				scope={{ kind: "global" }}
				currentRules={[]}
				onApplyRules={() => {}}
				onClose={() => {}}
			/>,
		);
		const sheet = container.querySelector(".presets-sheet");
		// Snapshot the structural body — built-ins have no edit-btn anywhere
		// in the active detail panel.
		expect(sheet?.querySelector(".presets-edit-btn")).toBeNull();
		expect(
			within(container as HTMLElement)
				.queryAllByRole("button", { name: /Edit preset/i })
				.length,
		).toBe(0);
		// Snapshot the rule pattern set.
		const patterns = Array.from(
			container.querySelectorAll(".presets-rule-pattern"),
		).map((n) => n.textContent);
		expect(patterns).toMatchSnapshot();
	});
});
