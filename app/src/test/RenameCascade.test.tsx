import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes, useLocation } from "react-router-dom";
import { SkillEditor } from "@/screens/SkillEditor";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import {
	renderWithProviders,
	sampleRegistry,
	primeRegistry,
	makeQueryClient,
	deferredInvoke,
} from "./helpers";
import type { RenamePlan, RenameResult } from "@/types/renameRefs";

/** Renders the current location's pathname — proves a navigation actually
 *  landed. Same pattern `SnippetRename.test.tsx` uses for its own rename. */
function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{loc.pathname}</div>;
}

function renderEditor(route = "/skill/brainstorm") {
	const client = makeQueryClient();
	primeRegistry(client);
	return renderWithProviders(
		<>
			<LocationProbe />
			<Routes>
				<Route path="/skill/:name" element={<SkillEditor />} />
			</Routes>
		</>,
		{ client, initialRoute: route },
	);
}

function basePlan(overrides: Partial<RenamePlan> = {}): RenamePlan {
	return {
		dry_run: true,
		old: "brainstorm",
		new: "brainstorm-plus",
		referrers: { skills: [], snippets: [], agent_docs: [] },
		skipped: [],
		totals: {
			skills: 0,
			snippets: 0,
			agent_docs: 0,
			projects: 0,
			library_refs: 0,
			agent_doc_refs: 0,
			refs: 0,
			skipped: 0,
			files: 0,
		},
		...overrides,
	};
}

/** `orchestrate` + its `references/waves.md` sibling (skills, 4 refs), one
 *  snippet (1 ref), one agent-doc file in one project (2 refs) — the exact
 *  shape plans/3.md's dry-run example uses, minus the `deliver-it` row. */
const REFS_PLAN: RenamePlan = basePlan({
	referrers: {
		skills: [
			{ name: "orchestrate", count: 3 },
			{ name: "orchestrate/references/waves.md", count: 1 },
		],
		snippets: [{ name: "android-conventions", count: 1 }],
		agent_docs: [
			{ project: "moon-base", rel: "AGENTS.md", path: "/Users/x/moon-base/AGENTS.md", count: 2 },
		],
	},
	skipped: [],
	totals: {
		skills: 2,
		snippets: 1,
		agent_docs: 1,
		projects: 1,
		library_refs: 5,
		agent_doc_refs: 2,
		refs: 7,
		skipped: 0,
		files: 4,
	},
});

const PLAN_NO_AGENT_DOCS: RenamePlan = basePlan({
	referrers: { skills: [{ name: "orchestrate", count: 3 }], snippets: [], agent_docs: [] },
	totals: {
		skills: 1,
		snippets: 0,
		agent_docs: 0,
		projects: 0,
		library_refs: 3,
		agent_doc_refs: 0,
		refs: 3,
		skipped: 0,
		files: 1,
	},
});

function cleanResult(): RenameResult {
	return {
		renamed: true,
		old: "brainstorm",
		new: "brainstorm-plus",
		rewritten: [
			{ kind: "skill", name: "orchestrate", count: 3 },
			{ kind: "skill", name: "orchestrate/references/waves.md", count: 1 },
			{ kind: "snippet", name: "android-conventions", count: 1, version: 5 },
		],
		skipped: [],
		errors: [],
		snippets_outdated: [],
		agent_docs_requested: false,
	};
}

interface Call {
	cmd: string;
	args: unknown;
}

/** Answers every `invoke` the editor needs to mount (`read_skill_document`,
 *  `check_python`, `harness_list`, `skill_files_list`) plus `hub_cmd`/
 *  `save_skill_full`, and records every call. `hubCmd` overrides one argv
 *  shape at a time — anything it returns `undefined` for falls back to a
 *  benign `{success: true, output: ""}` (mirrors `setup.ts`'s own default). */
function mockBackend(
	hubCmd?: (args: string[]) => { success: boolean; output: string } | undefined,
	saveSkill?: (args: unknown) => string | Promise<string>,
): Call[] {
	const calls: Call[] = [];
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_skill_document") {
			const { name } = (args as { name: string }) ?? { name: "" };
			return { name, description: sampleRegistry.skills[name]?.description ?? "", body: "Body" };
		}
		if (cmd === "check_python") return true;
		if (cmd === "harness_list") return [];
		if (cmd === "skill_files_list") {
			return {
				root: "/tmp/skills/brainstorm",
				files: [{ rel: "SKILL.md", size: 4, kind: "markdown", editable: true, reason: null }],
				truncated: false,
			};
		}
		if (cmd === "hub_cmd") {
			const a = (args as { args: string[] }).args;
			calls.push({ cmd: "hub_cmd", args: a });
			const r = hubCmd?.(a);
			return r ?? { success: true, output: "" };
		}
		if (cmd === "save_skill_full") {
			calls.push({ cmd: "save_skill_full", args });
			if (saveSkill) return saveSkill(args);
			return (args as { document: { name: string } }).document.name;
		}
		return undefined;
	}) as never);
	return calls;
}

async function loadEditor(route = "/skill/brainstorm") {
	renderEditor(route);
	await waitFor(() =>
		expect(document.querySelector(".cm-content")?.textContent ?? "").toContain("Body"),
	);
}

/** Opens the header's inline name field, types `newName`, and commits with
 *  Enter — the staging half of a rename (⌘S / Save is what actually writes).
 *  Matched by a prefix regex, not a fixed name, because a SECOND open's
 *  accessible name carries whatever was staged by the first (V4). */
async function stageRename(newName: string) {
	const trigger = await screen.findByRole("button", { name: /^Rename skill name:/ });
	await userEvent.click(trigger);
	const field = screen.getByRole("textbox", { name: "Skill name" });
	await userEvent.clear(field);
	await userEvent.type(field, newName);
	await userEvent.keyboard("{Enter}");
}

function saveButton() {
	return screen.getByRole("button", { name: (name) => name.replace(/ ⌘S$/, "") === "Save" });
}

function hubCmdCalls(calls: Call[]): string[][] {
	return calls.filter((c) => c.cmd === "hub_cmd").map((c) => c.args as string[]);
}

describe("SkillEditor — rename cascade", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [] });
		for (const p of Processes.list()) Processes.dismiss(p.id);
	});

	it("V1: nothing to say → no dialog, save_skill_full runs exactly as today", async () => {
		const calls = mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(basePlan()) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await waitFor(() => expect(calls.some((c) => c.cmd === "save_skill_full")).toBe(true));
		expect(calls.filter((c) => c.cmd === "save_skill_full")).toHaveLength(1);
		expect(screen.queryByTestId("rename-refs-dialog")).toBeNull();
	});

	it("V2: referrers → dialog opens, grouped with the right counts and rows", async () => {
		mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(REFS_PLAN) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		expect(await screen.findByTestId("rename-refs-dialog")).toBeInTheDocument();
		expect(screen.getByTestId("rename-refs-group-skills")).toHaveTextContent("SKILLS · 2");
		expect(screen.getByTestId("rename-refs-group-snippets")).toHaveTextContent("SNIPPETS · 1");
		expect(screen.getByTestId("rename-refs-group-agent-docs")).toHaveTextContent(
			"AGENT DOCS · 1 file in 1 project",
		);
		expect(screen.getAllByTestId("rename-refs-row")).toHaveLength(4);
		expect(screen.getByText("orchestrate/references/waves.md")).toBeInTheDocument();
	});

	it("V3: disclosure-only dialog (zero refs, one skip)", async () => {
		const plan = basePlan({
			skipped: [{ kind: "skill", name: "android-compose-ui", reason: "source-managed", count: 2 }],
			totals: { ...basePlan().totals, skipped: 2 },
		});
		mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run") ? { success: true, output: JSON.stringify(plan) } : undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		expect(await screen.findByTestId("rename-refs-dialog")).toBeInTheDocument();
		expect(screen.getByText("Nothing can be rewritten automatically.")).toBeInTheDocument();
		const rewriteBtn = screen.getByTestId("rename-refs-rewrite");
		expect(rewriteBtn).toHaveTextContent("Rename");
		expect(rewriteBtn).not.toHaveTextContent("Rename and rewrite");
		expect(screen.getByTestId("rename-refs-skipped")).toHaveTextContent("android-compose-ui");
	});

	it("V4: toggle default — unchecked on open, and unchecked again on a second open", async () => {
		mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(REFS_PLAN) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		const toggle = await screen.findByTestId("rename-refs-agent-docs");
		expect(toggle).not.toBeChecked();
		await userEvent.click(toggle);
		expect(toggle).toBeChecked();
		await userEvent.click(screen.getByTestId("rename-refs-cancel"));

		await stageRename("brainstorm-plus2");
		await userEvent.click(saveButton());
		expect(await screen.findByTestId("rename-refs-agent-docs")).not.toBeChecked();
	});

	it("V5: toggle disabled at zero agent-doc refs, with the empty-copy sub-line", async () => {
		mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(PLAN_NO_AGENT_DOCS) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		expect(await screen.findByTestId("rename-refs-agent-docs")).toBeDisabled();
		expect(screen.getByText("No agent doc names this skill.")).toBeInTheDocument();
	});

	it("V6: confirm label tracks the toggle", async () => {
		mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(REFS_PLAN) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		const rewriteBtn = await screen.findByTestId("rename-refs-rewrite");
		expect(rewriteBtn).toHaveTextContent("Rename and rewrite 5");
		await userEvent.click(screen.getByTestId("rename-refs-agent-docs"));
		expect(rewriteBtn).toHaveTextContent("Rename and rewrite 7");
	});

	it("V7: the snippet note renders under SNIPPETS before any click", async () => {
		mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(REFS_PLAN) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		expect(await screen.findByTestId("rename-refs-snippet-note")).toHaveTextContent(
			"Applied copies in your projects will read outdated until you update them.",
		);
	});

	it("V8: Cancel writes nothing — no rewrite call, no save, name stays staged", async () => {
		const calls = mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(REFS_PLAN) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-cancel"));

		expect(screen.queryByTestId("rename-refs-dialog")).toBeNull();
		expect(hubCmdCalls(calls).some((a) => a.includes("--rewrite-refs"))).toBe(false);
		expect(calls.some((c) => c.cmd === "save_skill_full")).toBe(false);
		// The staged name stays staged — still on screen (title AND crumb both
		// show it, so this is a non-empty existence check, not a single node).
		expect(screen.getAllByText("brainstorm-plus").length).toBeGreaterThan(0);
	});

	it("V9: confirm sends exact argv, then save_skill_full with the new name; Save stays non-busy through review", async () => {
		const calls = mockBackend((a) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: true, output: JSON.stringify(cleanResult()) };
			return undefined;
		});
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		expect(saveButton()).not.toHaveAttribute("aria-busy", "true");

		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));
		await waitFor(() => expect(hubCmdCalls(calls).some((a) => a.includes("--rewrite-refs"))).toBe(true));
		const renameArgv = hubCmdCalls(calls).find((a) => a.includes("--rewrite-refs"));
		expect(renameArgv).toEqual(["rename", "brainstorm", "brainstorm-plus", "--rewrite-refs", "--json"]);

		await waitFor(() => expect(calls.some((c) => c.cmd === "save_skill_full")).toBe(true));
		const saveCall = calls.find((c) => c.cmd === "save_skill_full");
		expect((saveCall!.args as { name: string; document: { name: string } }).name).toBe("brainstorm-plus");
		expect((saveCall!.args as { document: { name: string } }).document.name).toBe("brainstorm-plus");
	});

	it("V9b: the agent-docs toggle adds --rewrite-agent-docs to the argv", async () => {
		const calls = mockBackend((a) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: true, output: JSON.stringify(cleanResult()) };
			return undefined;
		});
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await userEvent.click(await screen.findByTestId("rename-refs-agent-docs"));
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));
		await waitFor(() => expect(hubCmdCalls(calls).some((a) => a.includes("--rewrite-refs"))).toBe(true));
		const renameArgv = hubCmdCalls(calls).find((a) => a.includes("--rewrite-refs"));
		expect(renameArgv).toEqual([
			"rename",
			"brainstorm",
			"brainstorm-plus",
			"--rewrite-refs",
			"--rewrite-agent-docs",
			"--json",
		]);
	});

	it("V10: a second ⌘S while the dialog is open fires no new hub_cmd", async () => {
		const calls = mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(REFS_PLAN) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		const before = calls.length;
		fireEvent.keyDown(window, { key: "s", metaKey: true });
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.length).toBe(before);
	});

	it("V11: live steps — row 1 busy then done as the rewrite resolves; row 2 busy until the reload lands", async () => {
		mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run")
				? { success: true, output: JSON.stringify(REFS_PLAN) }
				: undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");

		// Two gates so the flow parks between the two steps for a stable
		// assertion window — gating only the rewrite call would let the whole
		// confirm→write→navigate chain finish inside one `act`, past both
		// intermediate DOM states.
		const rewriteGate = deferredInvoke(
			(cmd, args) => cmd === "hub_cmd" && (args as { args: string[] }).args.includes("--rewrite-refs"),
		);
		const saveGate = deferredInvoke((cmd) => cmd === "save_skill_full");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));

		await waitFor(() => {
			const steps = screen.getAllByTestId("rename-refs-step");
			expect(steps[0]).toHaveAttribute("data-state", "busy");
		});
		expect(screen.getByTestId("rename-refs-cancel")).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByTestId("rename-refs-rewrite")).toBeDisabled();

		await act(async () => {
			rewriteGate.resolve({ success: true, output: JSON.stringify(cleanResult()) });
		});
		await waitFor(() => {
			const steps = screen.getAllByTestId("rename-refs-step");
			expect(steps[0]).toHaveAttribute("data-state", "done");
			expect(steps[1]).toHaveAttribute("data-state", "busy");
		});

		await act(async () => {
			saveGate.resolve("brainstorm-plus");
		});
		await waitFor(() => expect(screen.queryByTestId("rename-refs-dialog")).toBeNull());
	});

	it("V12: clean success closes the dialog and navigates to the new route", async () => {
		mockBackend((a) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: true, output: JSON.stringify(cleanResult()) };
			return undefined;
		});
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));

		await waitFor(() => expect(screen.queryByTestId("rename-refs-dialog")).toBeNull());
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm-plus"));
	});

	it("V13: a skip with zero errors keeps the dialog open; Done navigates", async () => {
		const resultWithSkip: RenameResult = {
			...cleanResult(),
			skipped: [{ kind: "skill", name: "android-compose-ui", reason: "source-managed", count: 2 }],
		};
		mockBackend((a) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: true, output: JSON.stringify(resultWithSkip) };
			return undefined;
		});
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));

		await screen.findByTestId("rename-refs-done");
		expect(screen.getByTestId("rename-refs-dialog")).toBeInTheDocument();
		expect(screen.getByText(/android-compose-ui/)).toBeInTheDocument();

		await userEvent.click(screen.getByTestId("rename-refs-done"));
		await waitFor(() => expect(screen.queryByTestId("rename-refs-dialog")).toBeNull());
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm-plus"));
	});

	it("V14: an exit-2 payload with errors — path/message/hint show, title is past tense, Done navigates", async () => {
		const failResult: RenameResult = {
			renamed: true,
			old: "brainstorm",
			new: "brainstorm-plus",
			rewritten: [{ kind: "skill", name: "orchestrate", count: 3 }],
			skipped: [],
			errors: [
				{
					kind: "agent_doc",
					name: "moon-base/AGENTS.md",
					path: "/Users/x/moon-base/AGENTS.md",
					error: "[Errno 13] Permission denied",
					hint: "its mirror partner moon-base/CLAUDE.md was rewritten",
				},
			],
			snippets_outdated: [],
			agent_docs_requested: false,
		};
		mockBackend((a) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: false, output: JSON.stringify(failResult) };
			return undefined;
		});
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));

		const errorsBlock = await screen.findByTestId("rename-refs-errors");
		expect(errorsBlock).toHaveTextContent("/Users/x/moon-base/AGENTS.md");
		expect(errorsBlock).toHaveTextContent("[Errno 13] Permission denied");
		expect(errorsBlock).toHaveTextContent("its mirror partner moon-base/CLAUDE.md was rewritten");
		expect(document.querySelector(".modal-title")?.textContent).toBe("Renamed to brainstorm-plus");

		await userEvent.click(screen.getByTestId("rename-refs-done"));
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm-plus"));
	});

	it("V15: a snippets_outdated link navigates to the snippet without the unsaved-changes prompt", async () => {
		const resultWithSnippet: RenameResult = {
			...cleanResult(),
			snippets_outdated: ["android-conventions"],
			skipped: [{ kind: "agent_doc", name: "moon-base/docs/AGENTS.md", reason: "snippet-owned", count: 1 }],
		};
		mockBackend((a) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: true, output: JSON.stringify(resultWithSnippet) };
			return undefined;
		});
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));

		const link = await screen.findByTestId("rename-refs-snippet-link");
		expect(link).toHaveTextContent("android-conventions");
		await userEvent.click(link);

		expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/android-conventions"));
	});

	it("V16: a failing dry-run still saves through the normal path with a warning toast; no dialog", async () => {
		const calls = mockBackend((a) =>
			a[0] === "rename" && a.includes("--dry-run") ? { success: false, output: "boom" } : undefined,
		);
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());

		await waitFor(() => expect(calls.some((c) => c.cmd === "save_skill_full")).toBe(true));
		expect(screen.queryByTestId("rename-refs-dialog")).toBeNull();
		await waitFor(() => {
			const titles = useAppStore.getState().toasts.map((t) => t.title);
			expect(titles).toContain("Could not check for references");
		});
	});

	it("V17: a subprocess crash (non-zero exit, no parseable payload) → failed state; save_skill_full is never called", async () => {
		const calls = mockBackend((a) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: false, output: "hub rename: unexpected crash\nTraceback (most recent call last):\nboom" };
			return undefined;
		});
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));

		await screen.findByTestId("rename-refs-close");
		expect(calls.some((c) => c.cmd === "save_skill_full")).toBe(false);
	});

	it("V18: a document save failure after rename discloses the completed rename", async () => {
		const backend = (a: string[]) => {
			if (a[0] === "rename" && a.includes("--dry-run")) return { success: true, output: JSON.stringify(REFS_PLAN) };
			if (a[0] === "rename" && a.includes("--rewrite-refs"))
				return { success: true, output: JSON.stringify(cleanResult()) };
			return undefined;
		};
		const calls = mockBackend(backend, () => Promise.reject(new Error("document save failed")));
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));

		const saveError = await screen.findByTestId("rename-refs-save-error");
		expect(document.querySelector(".modal-title")?.textContent).toBe(
			"Renamed to brainstorm-plus, but saving the document failed",
		);
		expect(saveError).toHaveTextContent("document save failed");
		expect(saveError).toHaveTextContent("Your edits are still in this editor. Leaving without saving loses them.");
		expect(screen.queryByText("Rename failed")).toBeNull();
		const callsBeforeStay = calls.length;
		await userEvent.click(screen.getByTestId("rename-refs-stay"));
		await waitFor(() => expect(screen.queryByTestId("rename-refs-dialog")).toBeNull());
		expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm");
		expect(calls).toHaveLength(callsBeforeStay);

		cleanup();
		mockBackend(backend, () => Promise.reject(new Error("document save failed")));
		await loadEditor();
		await stageRename("brainstorm-plus");
		await userEvent.click(saveButton());
		await screen.findByTestId("rename-refs-dialog");
		await userEvent.click(screen.getByTestId("rename-refs-rewrite"));
		await screen.findByTestId("rename-refs-save-error");
		await userEvent.click(screen.getByTestId("rename-refs-open-renamed"));
		await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm-plus"));
	});
});
