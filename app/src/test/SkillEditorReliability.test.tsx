import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import {
	screen,
	fireEvent,
	waitFor,
	act,
	render,
	cleanup,
} from "@testing-library/react";
import { afterEach } from "vitest";
import { Routes, Route } from "react-router-dom";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { estimateTokens } from "@/lib/estimateTokens";
import {
	renderWithProviders,
	makeQueryClient,
	sampleRegistry,
} from "./helpers";
import { SkillEditor } from "@/screens/SkillEditor";
import { CodeAreaEdit } from "@/components/CodeArea";

// Spy on the exact BPE encoder while keeping the cheap byte estimate + the
// formatter real, so we can prove `encode()` only runs on the debounce tick.
const EXACT_SENTINEL = 4242; // formatTokens(4242) === "4.2K"
vi.mock("@/lib/estimateTokens", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/estimateTokens")>();
	return { ...actual, estimateTokens: vi.fn(() => EXACT_SENTINEL) };
});

/** Override read_registry / read_skill_document while chaining every other
 *  command to the default setup.ts implementation (harness_list, hub_cmd, …). */
function overrideInvoke(
	handlers: Record<string, (args?: unknown) => Promise<unknown>>,
) {
	const mock = vi.mocked(invoke);
	const prev = mock.getMockImplementation();
	mock.mockImplementation(((cmd: string, args?: unknown) => {
		const h = handlers[cmd];
		if (h) return h(args);
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

function renderEditor(route = "/skill/brainstorm") {
	return renderWithProviders(
		<Routes>
			<Route path="/skill/:name" element={<SkillEditor />} />
			<Route path="/" element={<div>LIBRARY HOME</div>} />
		</Routes>,
		{ client: makeQueryClient(), initialRoute: route },
	);
}

describe("SkillEditor — debounced token counter (B3-03)", () => {
	beforeEach(() => vi.mocked(estimateTokens).mockClear());

	it("updates the footer from the cheap byte estimate on each keystroke and runs the exact encode only after a debounce", async () => {
		overrideInvoke({
			read_registry: () => Promise.resolve(sampleRegistry),
			read_skill_document: () =>
				Promise.resolve({
					name: "brainstorm",
					description: "Init",
					body: "Body",
				}),
		});

		const { container } = renderEditor();

		// Wait for the body to load into the CodeMirror editor.
		await waitFor(() =>
			expect(
				document.querySelector(".cm-content")?.textContent ?? "",
			).toContain("Body"),
		);
		// The initial mount schedules one debounced exact-encode; let it fire.
		await waitFor(() => expect(estimateTokens).toHaveBeenCalled());

		const footer = () =>
			container.querySelector('[title*="estimate"]') as HTMLElement;

		// Clean slate — assert typing does NOT trigger a synchronous encode.
		vi.mocked(estimateTokens).mockClear();
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "hello world" } });

		// Immediately: the footer reflects the cheap byte estimate (11 bytes → ~3),
		// and the expensive encoder has NOT run yet.
		expect(estimateTokens).not.toHaveBeenCalled();
		expect(footer().textContent).toMatch(/desc ~3\b/);

		// After the debounce settles the exact encoder runs and the sentinel shows.
		await waitFor(() => expect(estimateTokens).toHaveBeenCalled());
		await waitFor(() => expect(footer().textContent).toMatch(/desc ~4\.2K/));
	});
});

describe("SkillEditor — registry-error escape (B3-14)", () => {
	it("renders a Back-to-library action instead of an infinite spinner when the registry query errors", async () => {
		overrideInvoke({
			read_registry: () => Promise.reject(new Error("registry unavailable")),
			read_skill_document: () =>
				Promise.resolve({ name: "brainstorm", description: "", body: "" }),
		});

		renderEditor();

		const back = await screen.findByRole("button", { name: /back to library/i });
		fireEvent.click(back);
		await waitFor(() =>
			expect(screen.getByText("LIBRARY HOME")).toBeTruthy(),
		);
	});
});

describe("CodeArea — undo history isolation across documents (B3-11)", () => {
	afterEach(cleanup);

	function HistoryHarness({ keyed }: { keyed: boolean }) {
		const [docKey, setDocKey] = useState("A");
		const [text, setText] = useState("alpha");
		return (
			<>
				<button
					onClick={() => {
						setDocKey("B");
						setText("bravo");
					}}
				>
					switch
				</button>
				<CodeAreaEdit
					key={keyed ? docKey : "static"}
					content={text}
					onChange={setText}
				/>
			</>
		);
	}

	function viewIn(container: HTMLElement): EditorView {
		const el = container.querySelector(".cm-editor") as HTMLElement;
		return EditorView.findFromDOM(el)!;
	}

	function undo(view: EditorView) {
		runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "z", ctrlKey: true }),
			"editor",
		);
	}

	it("keying the editor by document identity gives a fresh history — ⌘Z after switching skills does not restore the prior skill", () => {
		const { container } = render(<HistoryHarness keyed />);
		const viewA = viewIn(container);
		// An edit in skill A, recorded in A's history.
		act(() => {
			viewA.dispatch({ changes: { from: 5, insert: "-edit" } });
		});
		expect(viewA.state.doc.toString()).toBe("alpha-edit");

		// Navigate to skill B → the keyed editor remounts with a fresh view.
		fireEvent.click(screen.getByText("switch"));
		const viewB = viewIn(container);
		expect(viewB).not.toBe(viewA);
		expect(viewB.state.doc.toString()).toBe("bravo");

		// Undo must be a no-op: B's history is empty, A's edit cannot bleed in.
		act(() => undo(viewB));
		expect(viewB.state.doc.toString()).toBe("bravo");
	});

	it("without the key the reused view leaks A's history into B (regression the key fixes)", () => {
		const { container } = render(<HistoryHarness keyed={false} />);
		const view = viewIn(container);
		act(() => {
			view.dispatch({ changes: { from: 5, insert: "-edit" } });
		});
		fireEvent.click(screen.getByText("switch"));
		// Same view, doc replaced to "bravo" via reconciliation (a history entry).
		expect(view.state.doc.toString()).toBe("bravo");
		act(() => undo(view));
		// The reused history reverts to A's content — the bleed the fix prevents.
		expect(view.state.doc.toString()).toContain("alpha");
	});
});
