import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route, useLocation } from "react-router-dom";
import { EditorView } from "@codemirror/view";

import { SubagentEditor } from "@/screens/SubagentEditor";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
	mockCommands,
} from "./helpers";
import type { Registry } from "@/types";

// ─── Fixture: sampleRegistry plus a registered `code-review` skill so a
// sub-agent body can carry a real reference (F5). ───────────────────────────
const refsRegistry: Registry = {
	...sampleRegistry,
	skills: {
		...sampleRegistry.skills,
		"code-review": {
			version: "1.0.0",
			description: "Review code for correctness and cleanup.",
			source: "~/skill-hub/skills/code-review",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			managed: "local",
		},
	},
};

const harnesses = [
	{
		id: "claude-code",
		label: "Claude Code",
		installed: true,
		on_globally: true,
		agents: { supported: true },
	},
];

const baseSafe = {
	description: "Reviews code.",
	model: "sonnet",
	tools_mode: "allowlist",
	tools: ["Read", "Glob", "Grep", "Skill"],
	disallowed_tools: [],
	allow_skill_discovery: true,
	skills: [],
	color: "blue",
};

const userShow = {
	name: "code-reviewer",
	scope: "user",
	file: "code-reviewer.md",
	exists: true,
	safe: { ...baseSafe, name: "code-reviewer" },
	advanced_yaml: "",
	body: "Follow `code-review` before merging.",
	disabled: false,
	drift: [],
	link: null,
	validation: { valid: true, warnings: [] },
};

const projectShow = {
	name: "deploy-bot",
	scope: "project",
	file: "deploy-bot.md",
	exists: true,
	safe: { ...baseSafe, name: "deploy-bot" },
	advanced_yaml: "",
	body: "Follow `code-review` before merging.",
	disabled: false,
	drift: [],
	link: null,
	validation: { valid: true, warnings: [] },
};

function mockInvoke(show: typeof userShow) {
	mockCommands({
		read_registry: refsRegistry,
		harness_list: harnesses,
		subagent_show: show,
		subagent_attachable_skills: [],
		subagent_skill_usage: {},
		read_search_corpus: { skills: {}, snippets: {} },
	});
}

/** Probes the current route after a reference click navigates away — same
 *  trick `SkillRefsSection.test.tsx` uses. */
function TargetProbe() {
	const location = useLocation();
	return (
		<div>
			<span data-testid="target-path">
				{location.pathname}
				{location.search}
			</span>
			<span data-testid="target-state">{JSON.stringify(location.state)}</span>
		</div>
	);
}

function renderEditor(
	show: typeof userShow,
	props: { scope: "user" | "project"; project: string | null; name: string },
	onBack: () => void = vi.fn(),
) {
	mockInvoke(show);
	const client = makeQueryClient();
	primeRegistry(client, refsRegistry);
	const utils = renderWithProviders(
		<Routes>
			<Route
				path="*"
				element={
					<>
						<SubagentEditor {...props} onBack={onBack} />
						<TargetProbe />
					</>
				}
			/>
		</Routes>,
		{ client, initialRoute: "/harness/claude-code" },
	);
	return { ...utils, onBack };
}

/** Type into the mounted CodeMirror the way the user would, without a caret —
 *  same helper `SkillFilesPanel.test.tsx` uses to dirty a buffer. */
function editBody(container: HTMLElement, insert: string) {
	const el = container.querySelector(".code-area--edit") as HTMLElement;
	const view = EditorView.findFromDOM(el)!;
	view.dispatch({ changes: { from: 0, insert } });
}

beforeEach(() => {
	window.localStorage.clear();
});

describe("SubagentEditor references", () => {
	it("[32] renders References below the skills attach block for a body mentioning a registered skill", async () => {
		renderEditor(userShow, { scope: "user", project: null, name: "code-reviewer" });

		const skillsSection = await screen.findByTestId("side-section-skills");
		const refsSectionHead = await screen.findByTestId("side-section-refs");
		expect(refsSectionHead.closest("section")).toHaveTextContent("References");
		expect(
			skillsSection.compareDocumentPosition(refsSectionHead) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.getByTestId("skill-ref-row-out-code-review")).toHaveTextContent(
			"code-review",
		);
	});

	it("[33] a row click carries the user-scope back target", async () => {
		renderEditor(userShow, { scope: "user", project: null, name: "code-reviewer" });

		await screen.findByTestId("side-section-refs");
		await userEvent.click(screen.getByTestId("skill-ref-row-out-code-review"));

		await waitFor(() =>
			expect(screen.getByTestId("target-path")).toHaveTextContent(
				"/skill/code-review",
			),
		);
		const state = JSON.parse(screen.getByTestId("target-state").textContent || "null");
		expect(state.from.path).toBe("/harness/claude-code?agent=code-reviewer");
	});

	it("[33] a row click carries the project-scope back target", async () => {
		renderEditor(projectShow, {
			scope: "project",
			project: "moon-base",
			name: "deploy-bot",
		});

		await screen.findByTestId("side-section-refs");
		await userEvent.click(screen.getByTestId("skill-ref-row-out-code-review"));

		await waitFor(() =>
			expect(screen.getByTestId("target-path")).toHaveTextContent(
				"/skill/code-review",
			),
		);
		const state = JSON.parse(screen.getByTestId("target-state").textContent || "null");
		expect(state.from.path).toBe("/project/moon-base?tab=subagents");
	});

	it("[34] a dirty draft raises the leave confirm on both a ref click and the back arrow", async () => {
		const { container, onBack } = renderEditor(userShow, {
			scope: "user",
			project: null,
			name: "code-reviewer",
		});

		await waitFor(() =>
			expect(
				container.querySelector(".code-area--edit .cm-content")?.textContent,
			).toContain("code-review"),
		);
		editBody(container, "DRAFT ");

		await screen.findByTestId("side-section-refs");
		await userEvent.click(screen.getByTestId("skill-ref-row-out-code-review"));
		expect(await screen.findByText("Leave without saving?")).toBeVisible();
		expect(screen.getByTestId("target-path")).not.toHaveTextContent(
			"/skill/code-review",
		);
		await userEvent.click(screen.getByRole("button", { name: "Stay" }));
		await waitFor(() =>
			expect(screen.queryByText("Leave without saving?")).toBeNull(),
		);

		await userEvent.click(screen.getByRole("button", { name: "Back to Sub-agents" }));
		expect(await screen.findByText("Leave without saving?")).toBeVisible();
		expect(onBack).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Leave" }));
		await waitFor(() => expect(onBack).toHaveBeenCalled());
	});
});
