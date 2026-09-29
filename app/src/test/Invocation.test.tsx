import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
} from "./helpers";
import { readAppCss } from "./readAppCss";
import { defaultImpl } from "./setup";
import { InvocationBadge } from "@/components/InvocationBadge";
import { InvocationOutcomes } from "@/components/InvocationOutcomes";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { invocationMock } from "@/mocks/invocation";
import { SkillInvocationOverride } from "@/components/SkillInvocationOverride";
import { qk } from "@/lib/queryKeys";
import { TriggeringPicker } from "@/components/TriggeringPicker";
import { ScopeBadge } from "@/components/Tag";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { queryClient } from "@/lib/queryClient";
import { SkillEditor } from "@/screens/SkillEditor";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import {
	INVOCATION_CONSEQUENCE,
	INVOCATION_CONFLICTED_TOOLTIP,
	INVOCATION_GLOBAL_OVERRIDE_REASON,
	INVOCATION_MCP_REASON,
	INVOCATION_EXTERNAL_REASON,
	invocationConsequence,
	invocationOutcomeLabel,
	invocationSummary,
} from "@/lib/invocation";
import type { Registry } from "@/types";
import type { InvocationMode, InvocationStatus } from "@/lib/invocation";

// ─── InvocationBadge render rules ────────────────────────────────────────────

describe("InvocationBadge", () => {
	it("shows an explicit Auto override while leaving the library default quiet", () => {
		renderWithProviders(<InvocationBadge invocation="auto" requested className="invocation-override-badge" />);
		expect(screen.getByText("Auto requested").closest(".invocation-override-badge")).not.toBeNull();
	});
	it("renders nothing for auto / absent (deviation-only)", () => {
		const { container: c1 } = renderWithProviders(<InvocationBadge />);
		expect(c1.querySelector(".invocation-badge")).toBeNull();
		const { container: c2 } = renderWithProviders(
			<InvocationBadge invocation="auto" />,
		);
		expect(c2.querySelector(".invocation-badge")).toBeNull();
	});

	it("renders an info badge for user-only with the consequence tooltip", () => {
		const { container } = renderWithProviders(
			<InvocationBadge invocation="user-only" />,
		);
		const badge = container.querySelector(".invocation-badge");
		expect(badge).not.toBeNull();
		expect(badge!.getAttribute("data-channel")).toBe("info");
		expect(badge!.getAttribute("title")).toBe(INVOCATION_CONSEQUENCE["user-only"]);
	});

	it("renders a neutral badge for model-only", () => {
		const { container } = renderWithProviders(
			<InvocationBadge invocation="model-only" />,
		);
		const badge = container.querySelector(".invocation-badge");
		expect(badge!.getAttribute("data-channel")).toBe("neutral");
		expect(badge!.getAttribute("title")).toBe(
			INVOCATION_CONSEQUENCE["model-only"],
		);
	});

	it("renders a warn badge for conflicted", () => {
		const { container } = renderWithProviders(
			<InvocationBadge invocation="conflicted" />,
		);
		const badge = container.querySelector(".invocation-badge");
		expect(badge!.getAttribute("data-channel")).toBe("warn");
		expect(badge!.getAttribute("title")).toMatch(/contradiction/i);
	});

	it("never uses the brand violet channel", () => {
		for (const inv of ["user-only", "model-only", "conflicted"]) {
			const { container } = renderWithProviders(
				<InvocationBadge invocation={inv} />,
			);
			const badge = container.querySelector(".invocation-badge");
			expect(badge!.getAttribute("data-channel")).not.toBe("violet");
		}
	});
});

describe("TriggeringPicker target preview", () => {
	it("previews hover and focus without changing the selected mode or saving", () => {
		const onPreview = vi.fn();
		const onPick = vi.fn();
		renderWithProviders(
			<TriggeringPicker invocation="auto" onPick={onPick} onPreview={onPreview} />,
		);
		const userOnly = screen.getByRole("radio", { name: "User-only" });
		const userOnlyChip = userOnly.closest("label")!;

		fireEvent.mouseEnter(userOnlyChip);
		expect(onPreview).toHaveBeenLastCalledWith("user-only");
		expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
		expect(onPick).not.toHaveBeenCalled();

		fireEvent.mouseLeave(userOnlyChip);
		expect(onPreview).toHaveBeenLastCalledWith(null);
		fireEvent.focus(userOnly);
		expect(onPreview).toHaveBeenLastCalledWith("user-only");
		fireEvent.blur(userOnly);
		expect(onPreview).toHaveBeenLastCalledWith(null);
	});
});

describe("InvocationOutcomes", () => {
	const status: InvocationStatus = {
		ok: true,
		skill: "research",
		project: "alpha",
		library: "user-only",
		effective: "user-only",
		targets: ["codex", "opencode"],
		overridden_projects: [],
		outcomes: [
			{
				skill: "research",
				harness: "codex",
				requested_mode: "user-only",
				mode_origin: "library",
				capability_profile: "codex-native",
				support: "enforced",
				implicit_behavior: "disabled",
				explicit_behavior: "available",
				mechanism: "agents/openai.yaml policy.allow_implicit_invocation",
				limitations: [],
				delivery: "applied",
			},
			{
				skill: "research",
				harness: "opencode",
				requested_mode: "user-only",
				mode_origin: "library",
				capability_profile: "unknown",
				support: "unknown",
				implicit_behavior: "unknown",
				explicit_behavior: "unknown",
				mechanism: "unverified",
				limitations: [],
				delivery: "failed",
				reason: "Invocation support could not be verified.",
			},
		],
		previews: {
			auto: [],
			"user-only": [],
			"model-only": [],
		},
	};

	it("summarizes actual behavior instead of promising the requested restriction", () => {
		const codex = status.outcomes[0];
		expect(invocationSummary(codex, "user-only")).toBe("Manual invocation only");
		expect(invocationSummary(codex, "auto")).toBe("Manual only, set by source");
		expect(invocationSummary({ ...codex, support: "unsupported", implicit_behavior: "enabled" }, "model-only"))
			.toBe("Manual invocation stays available");
		expect(invocationSummary({ ...codex, support: "unknown" }, "user-only")).toBe("Behavior not verified");
		expect(invocationSummary({ ...codex, delivery: "not-targeted" }, "user-only")).toBe("Excluded by target selection");
	});

	it("uses pending previews until the requested mode has persisted delivery", () => {
		const preview = { ...status, previews: { ...status.previews, "user-only": [status.outcomes[0]] } };
		renderWithProviders(
			<InvocationOutcomes
				status={{ ...preview, effective: "auto", outcomes: [] }}
				mode="user-only"
				installedHarnesses={["codex"]}
			/>,
		);
		expect(screen.getByText("Will apply on sync")).toBeInTheDocument();
	});

	it("keeps a failed delivery visible and reports no-target states", () => {
		renderWithProviders(
			<InvocationOutcomes status={status} mode="user-only" installedHarnesses={[]} />,
		);
		expect(screen.getByText("No harness receives this skill here.")).toBeInTheDocument();

		renderWithProviders(<InvocationOutcomes status={status} mode="user-only" />);
		expect(screen.getByText("Delivery failed")).toBeInTheDocument();
		expect(screen.getByText("Enforced")).toBeInTheDocument();
	});

	it("keeps unsupported and unknown capability above pending delivery", () => {
		const unsupported = status.outcomes[0];
		const pendingUnsupported = { ...unsupported, support: "unsupported" as const, delivery: "pending" as const };
		expect(invocationOutcomeLabel(pendingUnsupported)).toEqual({ label: "Unsupported", channel: "warn" });
		expect(invocationConsequence(pendingUnsupported, "model-only")).toMatch(/Codex has no verified Model-only setting/);

		const unknown = { ...status.outcomes[1], harness: "codex", support: "unknown" as const, delivery: "pending" as const };
		expect(invocationOutcomeLabel(unknown)).toEqual({ label: "Not verified", channel: "neutral" });
		expect(invocationConsequence(unknown, "auto")).toMatch(/Codex/);
	});

	it("discloses retained delivery evidence on keyboard focus, and dismisses it with Escape", async () => {
		const failed = { ...status.outcomes[0], requested_mode: "model-only", delivery: "failed" as const,
			applied_mode: "user-only", reason: "The source policy is invalid." };
		renderWithProviders(<InvocationOutcomes mode="model-only"
			status={{ ...status, effective: "model-only", targets: ["codex"], outcomes: [failed] }} />);
		expect(screen.getByText("Still using User-only")).toBeInTheDocument();
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		await userEvent.tab();
		expect(screen.getByRole("tooltip")).toHaveTextContent("Last applied mode: User-only.");
		expect(screen.getByRole("tooltip")).toHaveTextContent("The source policy is invalid.");
		fireEvent.scroll(window);
		expect(screen.getByRole("tooltip")).toHaveTextContent("Last applied mode: User-only.");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("allows a valid project override to resolve a conflicted library", () => {
		renderWithProviders(
			<InvocationOutcomes
				status={{ ...status, library: "conflicted", effective: "user-only" }}
				mode="user-only"
				installedHarnesses={["codex"]}
			/>,
		);
		expect(screen.queryByText(INVOCATION_CONFLICTED_TOOLTIP)).not.toBeInTheDocument();
		expect(screen.getByText("Enforced")).toBeInTheDocument();
	});

	it("restores inherited conflict when leaving an unsaved override preview", async () => {
		const client = makeQueryClient();
		client.setQueryDefaults(qk.invocation("research", "alpha"), { staleTime: Infinity });
		client.setQueryData(qk.invocation("research", "alpha"), { ...status, library: "conflicted", effective: "conflicted" });
		const onPick = vi.fn();
		renderWithProviders(<SkillInvocationOverride skillName="research" projectName="alpha"
			libraryInvocation="conflicted" scope="portable" onPick={onPick} />, { client });
		await userEvent.click(screen.getByTestId("skill-card-invocation"));
		expect(screen.getByText(INVOCATION_CONFLICTED_TOOLTIP)).toBeInTheDocument();
		fireEvent.mouseEnter(screen.getByRole("menuitemradio", { name: /Model-only/ }));
		expect(screen.queryByText(INVOCATION_CONFLICTED_TOOLTIP)).not.toBeInTheDocument();
		fireEvent.mouseLeave(screen.getByRole("menu", { name: "Triggering override" }));
		expect(screen.getByText(INVOCATION_CONFLICTED_TOOLTIP)).toBeInTheDocument();
		expect(onPick).not.toHaveBeenCalled();
	});

	it("returns to the saved override after focus leaves a preview", async () => {
		const client = makeQueryClient();
		client.setQueryDefaults(qk.invocation("research", "alpha"), { staleTime: Infinity });
		client.setQueryData(qk.invocation("research", "alpha"), status);
		renderWithProviders(<SkillInvocationOverride skillName="research" projectName="alpha"
			libraryInvocation="auto" override="user-only" scope="portable" onPick={vi.fn()} />, { client });
		await userEvent.click(screen.getByTestId("skill-card-invocation"));
		fireEvent.focus(screen.getByRole("menuitemradio", { name: /Model-only/ }));
		expect(screen.queryByText("Enforced")).not.toBeInTheDocument();
		fireEvent.blur(screen.getByRole("menu", { name: "Triggering override" }), { relatedTarget: null });
		expect(screen.getByText("Enforced")).toBeInTheDocument();
	});

	it.each(["resize", "scroll"])("returns keyboard focus when %s closes the menu", async (event) => {
		const client = makeQueryClient();
		client.setQueryDefaults(qk.invocation("research", "alpha"), { staleTime: Infinity });
		client.setQueryData(qk.invocation("research", "alpha"), status);
		const { container } = renderWithProviders(<div className="workspace-main">
			<SkillInvocationOverride skillName="research" projectName="alpha"
				libraryInvocation="auto" scope="portable" onPick={vi.fn()} />
		</div>, { client });
		const trigger = screen.getByTestId("skill-card-invocation");
		await userEvent.click(trigger);
		await userEvent.tab();
		expect(screen.getByRole("menuitemradio", { name: /Inherit/ })).toHaveFocus();
		if (event === "resize") fireEvent(window, new Event("resize"));
		else {
			const workspace = container.querySelector(".workspace-main")!;
			fireEvent.scroll(workspace);
			expect(screen.getByRole("menu")).toBeInTheDocument();
			// Finding B: `scrollTop` alone (jsdom does no real layout, so the
			// trigger's own rect never moves) used to be enough to close the
			// menu — exactly the scroll-anchoring false positive from a busy
			// sequential Playwright run. Only an actual trigger rect change
			// closes it now.
			vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
				...trigger.getBoundingClientRect(),
				top: 999,
			} as DOMRect);
			workspace.scrollTop = 40;
			fireEvent.scroll(workspace);
		}
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	// Finding B (regression guard, must FAIL before the fix in step 4): a
	// `.workspace-main` scrollTop change with an UNCHANGED trigger rect must
	// not close the menu — the old `scrollTop` comparison closed on this
	// alone, which is exactly what scroll anchoring produces.
	it("keeps the menu open when .workspace-main scrolls but the trigger rect hasn't moved", async () => {
		const client = makeQueryClient();
		client.setQueryDefaults(qk.invocation("research", "alpha"), { staleTime: Infinity });
		client.setQueryData(qk.invocation("research", "alpha"), status);
		const { container } = renderWithProviders(<div className="workspace-main">
			<SkillInvocationOverride skillName="research" projectName="alpha"
				libraryInvocation="auto" scope="portable" onPick={vi.fn()} />
		</div>, { client });
		const trigger = screen.getByTestId("skill-card-invocation");
		await userEvent.click(trigger);
		expect(screen.getByRole("menu")).toBeInTheDocument();

		const workspace = container.querySelector(".workspace-main")!;
		workspace.scrollTop = 40;
		fireEvent.scroll(workspace);

		expect(screen.getByRole("menu")).toBeInTheDocument();
	});
});

// ─── invocationNative scene fidelity ─────────────────────────────────────────
// invocation-axis.journey.spec.ts's `invocationNative` table (~:163, "native
// invocation reports … after saving User-only") and the width sweep at
// ~:238 (`?invocationNative=all`) each pick one scene and read its outcome
// rows through a full editor render + a real save. This renders the outcome
// list for every enumerated scene value `app/src/mocks/invocation.ts`
// branches on and checks only the thing a scene flag can get wrong before
// any UI interaction: which harnesses `invocationMock` claims are
// available (`targets`), and that `InvocationOutcomes` renders exactly one
// row per claimed harness.

describe("invocationNative scene availability", () => {
	const nativeRegistry: Registry = {
		version: "1",
		hub_path: "~",
		skills: {
			brainstorm: {
				version: "1.0.0",
				description: "Brainstorm a feature.",
				source: "",
				type: "claude-skill",
				scope: "portable",
				upstream: null,
				managed: "local",
			},
		},
		projects: {},
		bundles: {},
	} as unknown as Registry;

	afterEach(() => {
		window.history.replaceState({}, "", "/");
	});

	it.each([
		["all", ["claude-code", "codex", "pi", "opencode"]],
		["none", []],
		["codex", ["codex"]],
		["yaml-failure", ["codex"]],
		["opencode-command", ["opencode"]],
		["opencode-shared", ["opencode"]],
		["opencode-unknown", ["opencode"]],
		[null, ["claude-code", "codex", "opencode"]],
	] as const)("scene %s claims %j as available and InvocationOutcomes renders exactly those rows", async (scene, expected) => {
		window.history.replaceState({}, "", scene ? `/?invocationNative=${scene}` : "/");
		const status = invocationMock(nativeRegistry, "brainstorm");
		expect(status.targets).toEqual(expected);

		const { container } = renderWithProviders(
			<InvocationOutcomes status={status} mode={status.effective as InvocationMode} />,
		);

		if (expected.length === 0) {
			expect(
				screen.getByText("No harness receives this skill here."),
			).toBeInTheDocument();
			return;
		}
		const rows = container.querySelectorAll(".invocation-outcome-row");
		expect(rows).toHaveLength(expected.length);
		const renderedHarnesses = [...container.querySelectorAll(".invocation-outcome-harness")].map(
			(el) => el.textContent,
		);
		expect(renderedHarnesses).toEqual(expected.map((harness) => harnessLabel(harness)));
	});
});

// ─── ScopeBadge reach tooltips ───────────────────────────────────────────────

describe("ScopeBadge reach tooltips", () => {
	it("shows the full per-project reach sentence for portable (not the bare word)", () => {
		const { container } = renderWithProviders(<ScopeBadge scope="portable" />);
		const badge = container.querySelector(".scope-badge")!;
		expect(badge.getAttribute("title")).toMatch(/Per-project — equip it where/);
		expect(badge.getAttribute("title")).toMatch(/intent label/);
		expect(badge.getAttribute("title")).not.toBe("PORTABLE");
	});

	it("shows the everywhere sentence for global without the intent note", () => {
		const { container } = renderWithProviders(<ScopeBadge scope="global" />);
		const title = container.querySelector(".scope-badge")!.getAttribute("title");
		expect(title).toMatch(/Everywhere — active in every project/);
		expect(title).not.toMatch(/intent label/);
	});

	it("frames project scope as intent-only per-project", () => {
		const { container } = renderWithProviders(
			<ScopeBadge scope="project-specific" />,
		);
		const title = container.querySelector(".scope-badge")!.getAttribute("title");
		expect(title).toMatch(/built for one specific project/);
		expect(title).toMatch(/intent label/);
	});
});

// ─── Library invocation filter facet ─────────────────────────────────────────

const libraryRegistry: Registry = {
	version: "1",
	hub_path: "~",
	skills: {
		"triggered-user": {
			version: "1.0.0",
			description: "user only skill",
			source: "",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			invocation: "user-only",
		},
		"triggered-auto": {
			version: "1.0.0",
			description: "auto skill",
			source: "",
			type: "claude-skill",
			scope: "global",
			upstream: null,
		},
		"triggered-conflicted": {
			version: "1.0.0",
			description: "conflicted skill",
			source: "",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			invocation: "conflicted",
		},
	},
	projects: {},
	bundles: {},
} as unknown as Registry;

describe("SkillLibrary invocation filter facet", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "read_registry") return libraryRegistry;
			if (cmd === "local_skill_candidates") return [];
			if (cmd === "harness_list") return [];
			if (cmd === "hub_cmd")
				return { success: true, output: '{"sources":[],"errors":[]}' };
			return undefined;
		}) as never);
	});

	it("badges the deviating row and leaves the auto row quiet", () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		const userRow = screen
			.getByText("triggered-user")
			.closest(".resource-row")!;
		const autoRow = screen
			.getByText("triggered-auto")
			.closest(".resource-row")!;
		expect(userRow.querySelector(".invocation-badge")).not.toBeNull();
		expect(autoRow.querySelector(".invocation-badge")).toBeNull();
	});

	it("filters the list to the chosen effective library mode", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		// Both visible before filtering.
		expect(screen.getByText("triggered-auto")).toBeInTheDocument();

		// TRIGGER is inline in the subheader at the jsdom default width — no
		// Filter popover to open first.
		await userEvent.click(screen.getByRole("button", { name: "User-only" }));

		expect(screen.getByText("triggered-user")).toBeInTheDocument();
		expect(screen.queryByText("triggered-auto")).toBeNull();
	});

	it("the auto facet matches skills with no invocation key", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		await userEvent.click(screen.getByRole("button", { name: "Auto" }));

		expect(screen.getByText("triggered-auto")).toBeInTheDocument();
		expect(screen.queryByText("triggered-user")).toBeNull();
	});

	it("the auto facet excludes conflicted skills (conflicted is its own facet)", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		await userEvent.click(screen.getByRole("button", { name: "Auto" }));

		expect(screen.getByText("triggered-auto")).toBeInTheDocument();
		expect(screen.queryByText("triggered-conflicted")).toBeNull();
	});

	it("the conflicted facet shows only conflicted skills", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		await userEvent.click(screen.getByRole("button", { name: "Conflicted" }));

		expect(screen.getByText("triggered-conflicted")).toBeInTheDocument();
		expect(screen.queryByText("triggered-auto")).toBeNull();
		expect(screen.queryByText("triggered-user")).toBeNull();
	});
});

// ─── SkillEditor Triggering picker ───────────────────────────────────────────

const editorRegistry: Registry = {
	version: "1",
	hub_path: "~",
	skills: {
		"local-skill": {
			version: "1.0.0",
			description: "a local skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "local",
		},
		"ext-skill": {
			version: "1.0.0",
			description: "external skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: "git@github.com:org/skills.git",
			managed: "external",
			origin: { source: "org", source_type: "git", path: "skills/ext-skill", ref: "a" },
		},
		"mcp-skill": {
			version: "1.0.0",
			description: "an mcp server",
			source: "",
			type: "mcp-server",
			scope: "global",
			upstream: null,
			managed: "local",
		},
		"conflicted-skill": {
			version: "1.0.0",
			description: "conflicted skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "local",
			invocation: "conflicted",
		},
	},
	projects: {},
	bundles: {},
} as unknown as Registry;

function setupEditorInvoke(calls: string[][]) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return editorRegistry;
		if (cmd === "read_skill_document") {
			const { name } = (args as { name: string }) ?? { name: "" };
			return {
				name,
				description: editorRegistry.skills[name]?.description ?? "",
				body: `# ${name}\nhello`,
			};
		}
		if (cmd === "check_python") return true;
		if (cmd === "harness_list") return [];
		if (cmd === "subagent_skill_usage") return {};
		if (cmd === "hub_cmd") {
			calls.push((args as { args?: string[] })?.args ?? []);
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
}

function renderEditor(
	initialRoute: string,
	client = makeQueryClient(),
	navigationTarget?: string,
) {
	client.setQueryData(["python"], {
		ok: true,
		reason: "none",
		detail: null,
		python: "/usr/bin/python3",
	});
	client.setQueryData(["registry"], editorRegistry);
	return renderWithProviders(
		<>
			{navigationTarget && <Link to={navigationTarget}>Open external skill</Link>}
			<Routes>
				<Route path="/skill/:name" element={<SkillEditor />} />
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute },
	);
}

/** TRIGGERING is collapsed by default now (1 of 64 skills has ever changed it),
 *  so every assertion about the radio cards opens the disclosure first. */
async function openTriggering() {
	await userEvent.click(await screen.findByTestId("side-section-runtime"));
}

describe("SkillEditor Triggering picker", () => {
	it("saves the chosen mode via set-meta --invocation", async () => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		renderEditor("/skill/local-skill");
		await openTriggering();

		const radio = await screen.findByRole("radio", { name: /User-only/ });
		expect(radio).not.toBeDisabled();
		await userEvent.click(radio);

		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c[0] === "set-meta" &&
						c[1] === "local-skill" &&
						c[2] === "--invocation" &&
						c[3] === "user-only",
				),
			).toBe(true),
		);
	});

	it("renders a conflicted skill with no false Auto selection", async () => {
		setupEditorInvoke([]);
		renderEditor("/skill/conflicted-skill");
		await openTriggering();
		const group = screen.getByRole("radiogroup", { name: "Triggering" });
		expect(within(group).getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
		expect(screen.getByText(/Both invocation flags are set/)).toBeInTheDocument();
	});

	it("does not carry pending triggering state across navigation", async () => {
		let finish!: (result: { success: boolean; output: string }) => void;
		const pending = new Promise<{ success: boolean; output: string }>((resolve) => {
			finish = resolve;
		});
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		const fallback = vi.mocked(invoke).getMockImplementation()!;
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			const command = (args as { args?: string[] })?.args;
			if (cmd === "hub_cmd" && command?.[0] === "set-meta") return pending;
			return fallback(cmd, args as never);
		}) as never);
		renderEditor("/skill/local-skill", makeQueryClient(), "/skill/ext-skill");
		await openTriggering();
		await userEvent.click(screen.getByRole("radio", { name: "User-only" }));
		await userEvent.click(screen.getByRole("link", { name: "Open external skill" }));
		await waitFor(() => expect(screen.getByText("external skill")).toBeInTheDocument());
		const group = screen.getByRole("radiogroup", { name: "Triggering" });
		expect(group).not.toHaveAttribute("aria-busy");
		for (const radio of within(group).getAllByRole("radio")) expect(radio).toBeDisabled();
		expect(within(group).getByRole("radio", { name: "Auto" })).toBeChecked();
		finish({ success: true, output: "" });
		await waitFor(() =>
			expect(screen.getByText("Changed triggering to User-only")).toBeInTheDocument(),
		);
		expect(group).not.toHaveAttribute("aria-busy");
		expect(screen.queryByText("synced")).toBeNull();
		expect(screen.queryByText("saved")).toBeNull();
		expect(within(group).getByRole("radio", { name: "Auto" })).toBeChecked();
	});

	it("confirms a clean save as synced", async () => {
		const calls: string[][] = [];
		const registry = structuredClone(editorRegistry);
		setupEditorInvoke(calls);
		const fallback = vi.mocked(invoke).getMockImplementation()!;
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "read_registry") return structuredClone(registry);
			const command = (args as { args?: string[] })?.args;
			if (cmd === "hub_cmd" && command?.[0] === "set-meta") {
				registry.skills["local-skill"].invocation = "user-only";
				return { success: true, output: "", stdout: "✓ synced\n", stderr: "" };
			}
			return fallback(cmd, args as never);
		}) as never);
		queryClient.clear();
		useAppStore.setState({ toasts: [] });
		renderEditor("/skill/local-skill", queryClient);
		await openTriggering();

		await userEvent.click(screen.getByRole("radio", { name: "User-only" }));

		await waitFor(() => expect(screen.getByText("synced")).toBeInTheDocument());
		expect(screen.getByText("Changed triggering to User-only")).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "User-only" })).toBeChecked();
	});

	it("keeps the saved mode and explains a trailing sync failure", async () => {
		const calls: string[][] = [];
		const registry = structuredClone(editorRegistry);
		setupEditorInvoke(calls);
		const fallback = vi.mocked(invoke).getMockImplementation()!;
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "read_registry") return structuredClone(registry);
			const command = (args as { args?: string[] })?.args;
			if (cmd === "hub_cmd" && command?.[0] === "set-meta") {
				registry.skills["local-skill"].invocation = "user-only";
				return {
					success: true,
					output: "",
					stdout: "✗ sync completed with danger findings\n",
					stderr:
						"  ! auto-sync exited with rc 2 (doctor danger findings) — the mutation itself succeeded\n",
				};
			}
			return fallback(cmd, args as never);
		}) as never);
		queryClient.clear();
		useAppStore.setState({ toasts: [] });
		renderEditor("/skill/local-skill", queryClient);
		await openTriggering();

		await userEvent.click(screen.getByRole("radio", { name: "User-only" }));

		await waitFor(() => expect(screen.getByText("saved")).toBeInTheDocument());
		expect(screen.getByRole("radio", { name: "User-only" })).toBeChecked();
		expect(screen.getByText("✗ sync completed with danger findings. Run hub sync to retry.")).toBeInTheDocument();
		expect(screen.getByText("Changed triggering to User-only").closest(".toast")).toHaveClass("toast-info");
		expect(
			useAppStore.getState().toasts.find(
				(toast) => toast.title === "Changed triggering to User-only",
			)?.duration,
		).toBe(6000);
	});

	// invocation-axis.journey.spec.ts ":155" kept only the "codex" scene as a
	// browser row (real navigation/click) — the other four opencode/yaml
	// scenes never needed a real browser, only the outcome-label mapping
	// (app/src/lib/invocation.ts) reacting to a saved User-only mode, so this
	// pins that here instead.
	it("each invocationNative scene reports its outcome label after saving User-only", async () => {
		for (const [scene, label] of [
			["opencode-command", "Enforced"],
			["opencode-shared", "Unsupported"],
			["opencode-unknown", "Not verified"],
			["yaml-failure", "Delivery failed"],
		] as const) {
			window.history.replaceState({}, "", `/?invocationNative=${scene}`);
			const registry = structuredClone(editorRegistry);
			const calls: string[][] = [];
			setupEditorInvoke(calls);
			const fallback = vi.mocked(invoke).getMockImplementation()!;
			vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
				if (cmd === "read_registry") return structuredClone(registry);
				// The real harness_list (not setupEditorInvoke's `[]`), with only
				// the scene's own harness installed — the mocked VISUAL_MOCK
				// server (tauriCore.ts "harness_list") does the same for a live
				// invocationNative scene, so only the scene's harness gets a real
				// row instead of every other installed harness reading
				// "Not verified".
				if (cmd === "harness_list") {
					const list = (await defaultImpl("harness_list")) as { id: string; installed: boolean }[];
					const only = scene.startsWith("opencode") ? "opencode" : "codex";
					return list.map((h) => ({ ...h, installed: h.id === only }));
				}
				const command = (args as { args?: string[] })?.args;
				if (cmd === "hub_cmd" && command?.[0] === "set-meta") {
					registry.skills["local-skill"].invocation = "user-only";
					return { success: true, output: "" };
				}
				if (cmd === "hub_cmd" && command?.[0] === "skill" && command?.[1] === "invocation") {
					return { success: true, output: JSON.stringify(invocationMock(registry, "local-skill")) };
				}
				return fallback(cmd, args as never);
			}) as never);
			queryClient.clear();
			useAppStore.setState({ toasts: [], harnesses: undefined });
			const { container } = renderEditor("/skill/local-skill", queryClient);
			const runtimeHead = await within(container).findByTestId("side-section-runtime");
			if (runtimeHead.getAttribute("aria-expanded") !== "true") await userEvent.click(runtimeHead);

			await userEvent.click(await within(container).findByRole("radio", { name: "User-only" }));
			await waitFor(() =>
				expect(within(container).getByRole("radio", { name: "User-only" })).toBeChecked(),
			);
			await waitFor(() => {
				const outcomes = container.querySelector(".invocation-outcomes");
				expect(outcomes).not.toBeNull();
				expect(within(outcomes as HTMLElement).queryByText("Preview")).toBeNull();
			});
			const outcomes = container.querySelector(".invocation-outcomes") as HTMLElement;
			const statusLabels = [...outcomes.querySelectorAll(".invocation-outcome-row .status-badge-label")].map(
				(node) => node.textContent,
			);
			expect.soft(statusLabels, scene).toEqual([label]);

			cleanup();
			window.history.replaceState({}, "", "/");
		}
	});

	it("rolls back the optimistic choice when the write is rejected", async () => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		const fallback = vi.mocked(invoke).getMockImplementation()!;
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			const command = (args as { args?: string[] })?.args;
			if (cmd === "hub_cmd" && command?.[0] === "set-meta") {
				return { success: false, output: "error: write refused" };
			}
			return fallback(cmd, args as never);
		}) as never);
		queryClient.clear();
		useAppStore.setState({ toasts: [] });
		renderEditor("/skill/local-skill", queryClient);
		await openTriggering();

		await userEvent.click(screen.getByRole("radio", { name: "User-only" }));

		await waitFor(() => expect(screen.getByText("Couldn't change triggering")).toBeInTheDocument());
		expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
		expect(screen.getByText("error: write refused")).toBeInTheDocument();
		expect(screen.getByText("Couldn't change triggering").closest(".toast")).toHaveClass("toast-error");
		expect(screen.queryByText("saved")).toBeNull();
		expect(screen.queryByText("synced")).toBeNull();
	});

	it.each([true, false])("shows the requested option busy and recovers after success=%s", async (success) => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		const fallback = vi.mocked(invoke).getMockImplementation()!;
		let finish!: (result: { success: boolean; output: string }) => void;
		const pending = new Promise<{ success: boolean; output: string }>((resolve) => { finish = resolve; });
		const registry = structuredClone(editorRegistry);
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			if (cmd === "read_registry") return structuredClone(registry);
			const command = (args as { args?: string[] })?.args;
			if (cmd === "hub_cmd" && command?.[0] === "set-meta") {
				calls.push(command);
				return pending;
			}
			return fallback(cmd, args as never);
		}) as never);
		queryClient.clear();
		renderEditor("/skill/local-skill", queryClient);
		await openTriggering();
		const group = screen.getByRole("radiogroup", { name: "Triggering" });
		const requested = within(group).getByRole("radio", { name: "User-only" });
		const saved = within(group).getByRole("radio", { name: "Auto" });
		await userEvent.click(requested);
		expect(group).toHaveAttribute("aria-busy", "true");
		expect(requested).toHaveAttribute("aria-busy", "true");
		expect(requested.closest("label")).toHaveClass("is-loading");
		expect(requested.closest("label")?.querySelector(".lds-spinner")).not.toBeNull();
		expect(requested).toBeChecked();
		expect(saved).not.toBeChecked();
		expect(saved).not.toHaveAttribute("aria-busy");
		for (const radio of within(group).getAllByRole("radio")) expect(radio).toBeDisabled();
		await userEvent.click(within(group).getByRole("radio", { name: "Model-only" }));
		expect(calls.filter((command) => command[0] === "set-meta")).toHaveLength(1);
		if (success) registry.skills["local-skill"].invocation = "user-only";
		finish({ success, output: success ? "" : "write failed" });
		await waitFor(() => expect(group).not.toHaveAttribute("aria-busy"));
		expect(requested).not.toBeDisabled();
		expect(requested.closest("label")).not.toHaveClass("is-loading");
		expect(success ? requested : saved).toBeChecked();
	});

	it("disables the picker for an external skill with the ownership reason", async () => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		renderEditor("/skill/ext-skill");
		await openTriggering();

		const radio = await screen.findByRole("radio", { name: /User-only/ });
		expect(radio).toBeDisabled();
		expect(screen.getByText(INVOCATION_EXTERNAL_REASON)).toBeInTheDocument();
	});

	it("disables the picker for an MCP server with the mcp reason", async () => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		renderEditor("/skill/mcp-skill");
		await openTriggering();

		const radio = await screen.findByRole("radio", { name: /Auto/ });
		expect(radio).toBeDisabled();
		expect(screen.getByText(INVOCATION_MCP_REASON)).toBeInTheDocument();
	});
});

// ─── ProjectWorkspace override control ───────────────────────────────────────

function workspaceRegistry(): Registry {
	return {
		version: "1",
		hub_path: "~",
		skills: {
			"portable-a": {
				version: "1.0.0",
				description: "portable skill",
				source: "",
				type: "claude-skill",
				scope: "portable",
				upstream: null,
			},
			"global-b": {
				version: "1.0.0",
				description: "global skill",
				source: "",
				type: "claude-skill",
				scope: "global",
				upstream: null,
			},
		},
		projects: {
			alpha: {
				path: "/a",
				bundles: [],
				enabled: ["portable-a", "global-b"],
			},
		},
		bundles: {},
		harnesses_global: ["claude-code"],
	} as unknown as Registry;
}

function setupWorkspace(
	client = makeQueryClient(),
	reg: Registry = workspaceRegistry(),
) {
	const calls: string[][] = [];
	useAppStore.setState({
		toasts: [],
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
			},
		],
	});
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return reg;
		if (cmd === "sync_report") return null;
		if (cmd === "project_scan_candidates") return [];
		if (cmd === "path_exists") return false;
		if (cmd === "harness_list") return useAppStore.getState().harnesses;
		if (cmd === "hub_cmd") {
			const a = (args as { args?: string[] })?.args ?? [];
			calls.push(a);
			if (a[0] === "project" && a[1] === "invocation") {
				const proj = reg.projects[a[2]];
				const skill = a[4];
				const mode = a[6];
				const overrides = { ...(proj.invocation_overrides ?? {}) };
				if (mode === "inherit") delete overrides[skill];
				else overrides[skill] = mode as "auto" | "user-only" | "model-only";
				proj.invocation_overrides = overrides;
				client.setQueryData(["registry"], structuredClone(reg));
			}
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
	primeRegistry(client, reg);
	renderWithProviders(
		<>
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute: "/project/alpha" },
	);
	return { calls, reg };
}

describe("ProjectWorkspace invocation override control", () => {
	beforeEach(() => window.localStorage.clear());

	it("sets a per-project override and shows an undo toast, then undo clears it", async () => {
		const { calls } = setupWorkspace();

		const card = (await screen.findByText("portable-a")).closest(
			".project-loadout-row",
		)! as HTMLElement;
		await userEvent.click(within(card).getByRole("button", { name: /Show .* details/ }));
		await userEvent.click(
			within(card).getByTitle("Set per-project triggering"),
		);
		await userEvent.click(screen.getByRole("menuitemradio", { name: /User-only/ }));

		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c[0] === "project" &&
						c[1] === "invocation" &&
						c[2] === "alpha" &&
						c[4] === "portable-a" &&
						c[6] === "user-only",
				),
			).toBe(true),
		);

		// Undo toast → inverse verb clears the override (--mode inherit).
		await waitFor(() => expect(screen.getByText("Undo")).toBeInTheDocument());
		await userEvent.click(screen.getByText("Undo"));
		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c[0] === "project" &&
						c[1] === "invocation" &&
						c[4] === "portable-a" &&
						c[6] === "inherit",
				),
			).toBe(true),
		);
	});

	it("disables the control for a global-scope skill with the precedence explanation", async () => {
		setupWorkspace();

		const card = (await screen.findByText("global-b")).closest(
			".project-loadout-row",
		)! as HTMLElement;
		await userEvent.click(within(card).getByRole("button", { name: /Show .* details/ }));
		await userEvent.click(
			within(card).getByTitle("Set per-project triggering"),
		);

		expect(screen.getByText(INVOCATION_GLOBAL_OVERRIDE_REASON)).toBeInTheDocument();
		// No settable radio options are offered for a gated skill.
		expect(screen.queryByRole("menuitemradio")).toBeNull();
	});

	// B2 (decision 4): the at-rest badge is "an override exists", distinct from
	// InvocationBadge's deviation-only rule — and the trigger itself now lives
	// in the hover-revealed `.resource-detail` cluster, not in `meta`. A render
	// concern, so it renders with the override already set — the *setting*
	// path (the mutation itself) is what "sets a per-project override…" above
	// already pins via the `calls` array.
	it("shows the at-rest override badge only when overridden, and moves the trigger into .resource-detail, not meta", async () => {
		const overridden = workspaceRegistry();
		overridden.projects.alpha.invocation_overrides = {
			"portable-a": "user-only",
		};
		setupWorkspace(makeQueryClient(), overridden);

		const overriddenCard = (
			await screen.findByText("portable-a")
		).closest(".project-loadout-row")! as HTMLElement;
		const badge = overriddenCard.querySelector(".invocation-override-badge");
		expect(badge).not.toBeNull();
		expect(badge!.textContent).toContain("User-only");

		await userEvent.click(within(overriddenCard).getByRole("button", { name: /Show .* details/ }));
		const trigger = overriddenCard.querySelector(
			".invocation-override-trigger",
		)!;
		expect(
			overriddenCard.querySelector(".resource-cardhead")?.contains(trigger),
		).toBeFalsy();
		expect(
			overriddenCard.querySelector(".resource-detail")?.contains(trigger),
		).toBe(true);

		// The un-overridden sibling card shows no badge.
		const quietCard = screen.getByText("global-b").closest(".project-loadout-row")!;
		expect(quietCard.querySelector(".invocation-override-badge")).toBeNull();

		// invocation-axis.journey.spec.ts "workspace override stays visible
		// when its details are collapsed" (~:126): collapsing the card again
		// unmounts the trigger (it lives in `.resource-detail`), but the
		// at-rest badge — which lives in the always-visible card head — stays.
		await userEvent.click(within(overriddenCard).getByRole("button", { name: /Hide .* details/ }));
		expect(overriddenCard.querySelector(".invocation-override-trigger")).toBeNull();
		expect(overriddenCard.querySelector(".invocation-override-badge")).not.toBeNull();
	});

	// GRILL #7: the trigger is hover-revealed, so closing the menu without
	// restoring focus strands a keyboard user when :focus-within ends.
	it("restores focus to the trigger after a keyboard pick, and after Escape", async () => {
		setupWorkspace();

		const card = (await screen.findByText("portable-a")).closest(
			".project-loadout-row",
		)! as HTMLElement;
		await userEvent.click(within(card).getByRole("button", { name: /Show .* details/ }));
		const trigger = within(card).getByTitle("Set per-project triggering");

		await userEvent.click(trigger);
		await userEvent.click(screen.getByRole("menuitemradio", { name: /User-only/ }));
		await waitFor(() => expect(document.activeElement).toBe(trigger));

		await userEvent.click(trigger);
		expect(screen.getByRole("menu")).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});

// ─── invocation-override menu stacking (CSS) ─────────────────────────────────
//
// jsdom doesn't run a layout/paint engine, so the actual clipping bug can't be
// reproduced here (it was caught interactively: every .resource-card already
// carries `position: relative`, so all grid siblings sit at the same
// z-index:auto stacking level and paint in DOM order — the loadout grid row
// below silently painted OVER an open dropdown's lower items, eating clicks
// meant for "Auto"/"User-only"/"Model-only"). Pin the CSS contract that fixes
// it: the hosting card must lift above its siblings while its menu is open.
describe("invocation-override menu stacking (CSS)", () => {
	it("lifts the hosting card above sibling grid cards while its menu is open", () => {
		const css = readAppCss();
		expect(css).toMatch(
			/\.skill-card:has\(\.invocation-override-menu\)\s*\{[^}]*z-index:\s*var\(--z-popover-local\)/,
		);
	});
});

// ─── .skill-card .card-actions — the hover-reveal cluster (GRILL #1) ────────
//
// `.resource-card .resource-actions` is `display: contents` — no box to hide
// — so the trigger's hover reveal rides its own named cluster. Pin the CSS
// contract: fade-only, and all three reveal selectors present.
describe(".skill-card .card-actions reveal (CSS)", () => {
	it("declares opacity: 0 at rest and reveals on hover, focus-within and :has(menu)", () => {
		const css = readAppCss();
		expect(css).toMatch(/\.skill-card \.card-actions\s*\{[^}]*opacity:\s*0/);
		expect(css).toMatch(
			/\.skill-card:hover \.card-actions,?\s*[\s\S]{0,120}?opacity:\s*1/,
		);
		expect(css).toContain(".skill-card:hover .card-actions");
		expect(css).toContain(".skill-card:focus-within .card-actions");
		expect(css).toContain(
			".skill-card:has(.invocation-override-menu) .card-actions",
		);
		// The struck earlier-draft rule (`.resource-actions` has no box to
		// reveal on a card) must never come back.
		expect(css).not.toMatch(
			/\.skill-card:has\(\.invocation-override-menu\)\s*\.resource-actions/,
		);
	});
});

// ─── .invocation-override-badge fade-out — the deliberate swap (REVIEW-B #1) ─
//
// The at-rest badge and the hover-revealed trigger share one corner. Pin
// that the badge fades OUT under the exact same trio that fades the trigger
// cluster IN, so the two are never both painted.
describe(".invocation-override-badge fade-out (CSS)", () => {
	it("fades out under the same hover/focus-within/:has(menu) trio that reveals .card-actions", () => {
		const css = readAppCss();
		expect(css).toMatch(
			/\.skill-card:hover \.invocation-override-badge,?\s*[\s\S]{0,160}?opacity:\s*0/,
		);
		expect(css).toContain(".skill-card:hover .invocation-override-badge");
		expect(css).toContain(
			".skill-card:focus-within .invocation-override-badge",
		);
		expect(css).toContain(
			".skill-card:has(.invocation-override-menu) .invocation-override-badge",
		);
	});
});

// ─── remote drift rows keep their resolve actions hover-independent (REVIEW-B #9)
//
// `.resource-actions` is hover-revealed by default (rows-cards.css) — wrong
// for a drift decision the user must act on. Pin the CSS-text contract next
// to the `.card-actions` one above: jsdom can assert the rule text, real
// verification of the reveal is the visual/e2e pass.
describe(".remote-detail [data-drift=needs-resolve] actions stay visible (CSS)", () => {
	it("declares display: inline-flex for a needs-resolve row's actions, independent of hover", () => {
		const css = readAppCss();
		expect(css).toMatch(
			/\.remote-detail \.resource-row\[data-drift="needs-resolve"\] \.resource-actions\s*\{[^}]*display:\s*inline-flex/,
		);
	});
});
