import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { PresetsSheet } from "@/components/PresetsSheet";
import { BUILTIN_PRESETS } from "@/lib/permissionPresets";
import { DEFAULT_ICON_CHOICES } from "@/components/IconPicker";
import { useAppStore } from "@/store";
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

// ─── write paths: createUserPreset, deleteUserPreset, updateUserPreset ─────
// None of the tests above reach `permissions presets new` (~:161),
// `deleteUserPreset` (~:187) or `updateUserPreset` (~:217) — the CLI write
// paths behind the create form, the danger-zone delete and the edit-form
// save/add-rule controls.

const USER_PRESET_REGISTRY: Registry = {
	...sampleRegistry,
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

/** Mocks `invoke` for `hub_cmd`'s `permissions presets …` arm, and keeps
 *  `read_registry` answering with the SAME `registry` reference the query
 *  cache is primed with below. `staleTime: 0` means every write path's
 *  `invalidateRegistry()` (and React Query's own mount-time revalidation)
 *  triggers a background refetch; returning the identical object each time
 *  lets structural sharing keep the cached reference stable, so the sheet's
 *  own "presets changed → reset to view" effect never fires from a refetch
 *  that changed nothing. */
function installPresetWrites(opts: {
	registry?: Registry;
	result?: (cmdArgs: string[]) => { success: boolean; output: string };
}) {
	const registry = opts.registry ?? USER_PRESET_REGISTRY;
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return registry;
		if (cmd === "hub_cmd") {
			const cmdArgs = ((args as { args?: string[] })?.args) ?? [];
			if (cmdArgs[0] === "permissions" && cmdArgs[1] === "presets") {
				return opts.result ? opts.result(cmdArgs) : { success: true, output: "" };
			}
		}
		return undefined;
	}) as never);
	return registry;
}

/** Primes the query cache with `registry` synchronously (no fetch in
 *  flight), THEN renders — sidesteps the `undefined → registry` reference
 *  flip a first, un-primed fetch would otherwise cause mid-test. */
function renderSheetLive(opts: { registry: Registry; currentRules?: Rule[] }) {
	const client = makeQueryClient();
	primeRegistry(client, opts.registry);
	return renderWithProviders(
		<PresetsSheet
			open
			scope={{ kind: "global" }}
			currentRules={opts.currentRules ?? []}
			onApplyRules={() => {}}
			onClose={() => {}}
		/>,
		{ client },
	);
}

describe("PresetsSheet — createUserPreset", () => {
	it("sends `permissions presets new <slug> --name <name> --icon <icon>`, and a success closes the create form with a toast", async () => {
		const registry = installPresetWrites({ registry: { ...sampleRegistry } });
		renderSheetLive({ registry });
		await screen.findByText("Permission Presets");

		fireEvent.click(screen.getByRole("button", { name: /New preset/ }));
		fireEvent.change(screen.getByPlaceholderText("My custom preset"), {
			target: { value: "My Tools" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("hub_cmd", {
				args: [
					"permissions",
					"presets",
					"new",
					"my-tools",
					"--name",
					"My Tools",
					"--icon",
					DEFAULT_ICON_CHOICES[0],
				],
			}),
		);
		await waitFor(() =>
			expect(screen.queryByText("Create preset")).not.toBeInTheDocument(),
		);
		expect(
			useAppStore.getState().toasts.some((t) => t.title === "Created preset my-tools"),
		).toBe(true);
	});

	it("shows a failure toast and keeps the create form open when runHubCmd rejects", async () => {
		const registry = installPresetWrites({
			registry: { ...sampleRegistry },
			result: (cmdArgs) =>
				cmdArgs[2] === "new"
					? { success: false, output: "a preset with this id already exists" }
					: { success: true, output: "" },
		});
		renderSheetLive({ registry });
		await screen.findByText("Permission Presets");

		fireEvent.click(screen.getByRole("button", { name: /New preset/ }));
		fireEvent.change(screen.getByPlaceholderText("My custom preset"), {
			target: { value: "Git Safe" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(
				useAppStore.getState().toasts.some((t) => t.title === "Couldn't create preset"),
			).toBe(true),
		);
		expect(screen.getByText("Create preset")).toBeInTheDocument();
	});
});

describe("PresetsSheet — deleteUserPreset", () => {
	async function openEditFor(name: RegExp) {
		await screen.findByText("Permission Presets");
		fireEvent.click(await screen.findByRole("button", { name }));
		fireEvent.click(screen.getByLabelText("Edit preset"));
	}

	it("sends `permissions presets delete <id>`, and a success re-anchors to a built-in with a toast", async () => {
		const registry = installPresetWrites({});
		renderSheetLive({ registry });
		await openEditFor(/My tools/);

		fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("hub_cmd", {
				args: ["permissions", "presets", "delete", "my-tools"],
			}),
		);
		expect(
			useAppStore.getState().toasts.some((t) => t.title === "Deleted preset my-tools"),
		).toBe(true);
		// Re-anchored to a built-in preset's detail view (edit form is gone).
		await waitFor(() => expect(screen.queryByText("Edit preset")).not.toBeInTheDocument());
	});

	it("shows a failure toast and stays on the preset when runHubCmd rejects", async () => {
		const registry = installPresetWrites({
			result: (cmdArgs) =>
				cmdArgs[2] === "delete"
					? { success: false, output: "preset is in use" }
					: { success: true, output: "" },
		});
		renderSheetLive({ registry });
		await openEditFor(/My tools/);

		fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));

		await waitFor(() =>
			expect(
				useAppStore.getState().toasts.some((t) => t.title === "Couldn't delete preset"),
			).toBe(true),
		);
	});
});

describe("PresetsSheet — updateUserPreset", () => {
	async function openEditFor(name: RegExp) {
		await screen.findByText("Permission Presets");
		fireEvent.click(await screen.findByRole("button", { name }));
		fireEvent.click(screen.getByLabelText("Edit preset"));
	}

	it("sends `permissions presets update <id> --add-rule <pattern>`, and a success clears the input", async () => {
		const registry = installPresetWrites({});
		renderSheetLive({ registry });
		await openEditFor(/My tools/);

		const ruleInput = screen.getByLabelText("New rule pattern");
		fireEvent.change(ruleInput, { target: { value: "Bash(npm test*)" } });
		fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("hub_cmd", {
				args: ["permissions", "presets", "update", "my-tools", "--add-rule", "Bash(npm test*)"],
			}),
		);
		await waitFor(() => expect((ruleInput as HTMLInputElement).value).toBe(""));
		// The success path never raises the failure toast.
		expect(
			useAppStore.getState().toasts.some((t) => t.title === "Couldn't update preset"),
		).toBe(false);
	});

	it("shows a failure toast when runHubCmd rejects an update", async () => {
		const registry = installPresetWrites({
			result: (cmdArgs) =>
				cmdArgs[2] === "update"
					? { success: false, output: "invalid rule pattern" }
					: { success: true, output: "" },
		});
		renderSheetLive({ registry });
		await openEditFor(/My tools/);

		const ruleInput = screen.getByLabelText("New rule pattern");
		fireEvent.change(ruleInput, { target: { value: "Bash(npm test*)" } });
		fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

		await waitFor(() =>
			expect(
				useAppStore.getState().toasts.some((t) => t.title === "Couldn't update preset"),
			).toBe(true),
		);
	});
});
