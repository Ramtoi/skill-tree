import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { CodeAreaEdit } from "@/components/CodeArea";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";

afterEach(cleanup);

describe("editor ergonomics — search", () => {
	it("⌘F opens the CodeMirror search panel", () => {
		const { container } = render(
			<CodeAreaEdit content={"alpha\nbeta\ngamma"} onChange={() => {}} />,
		);
		const editorEl = container.querySelector(".cm-editor") as HTMLElement;
		const view = EditorView.findFromDOM(editorEl)!;
		expect(view).toBeTruthy();
		// No panel until the search shortcut fires.
		expect(container.querySelector(".cm-panel.cm-search")).toBeNull();
		// Run the actual editor keymap for ⌘F/Ctrl-F (CM maps Mod→Ctrl on non-mac,
		// which is jsdom's platform) — this exercises the wired searchKeymap binding.
		const evt = new KeyboardEvent("keydown", { key: "f", ctrlKey: true });
		const handled = runScopeHandlers(view, evt, "editor");
		expect(handled).toBe(true);
		expect(container.querySelector(".cm-panel.cm-search")).toBeTruthy();
	});
});

describe("editor ergonomics — soft wrap", () => {
	function WrapHarness() {
		const [wrap, setWrap] = useState(true);
		const [content, setContent] = useState("a very long line here");
		return (
			<>
				<button onClick={() => setWrap((w) => !w)}>toggle</button>
				<CodeAreaEdit content={content} onChange={setContent} softWrap={wrap} />
			</>
		);
	}

	it("toggling soft-wrap flips wrapping and preserves content", () => {
		const { container } = render(<WrapHarness />);
		const content = () => container.querySelector(".cm-content") as HTMLElement;
		// Default on → the wrapping class is present.
		expect(content().classList.contains("cm-lineWrapping")).toBe(true);
		const before = content().textContent;
		fireEvent.click(screen.getByText("toggle"));
		expect(content().classList.contains("cm-lineWrapping")).toBe(false);
		// Content survives the reconfigure (no remount / data loss).
		expect(content().textContent).toBe(before);
	});
});

describe("editor ergonomics — split gate", () => {
	function ShellHarness({ initialMode = "edit" as DocMode }) {
		const [content, setContent] = useState("# hi\n\nbody");
		const [mode, setMode] = useState<DocMode>(initialMode);
		return (
			<DocumentEditorShell
				content={content}
				onContentChange={setContent}
				mode={mode}
				onModeChange={setMode}
				diffOriginal="# hi\n\nbody"
				dirty={false}
				onSave={() => {}}
				sidePanel={<div>side</div>}
				splitStorageKey="test:split"
			/>
		);
	}

	it("offers split and renders both panes when the pane is wide", () => {
		// The shell primes its width from getBoundingClientRect (jsdom returns 0).
		// Stub a wide rect so the gate opens; the no-op ResizeObserver stays.
		const origRect = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function () {
			return { width: 1200, height: 600, top: 0, left: 0, right: 1200, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
		};
		try {
			const { container } = render(<ShellHarness />);
			const splitTab = screen.getByRole("tab", { name: "Split" });
			expect(splitTab).toBeTruthy();
			fireEvent.click(splitTab);
			// Both an editor and a preview render side by side.
			expect(container.querySelector(".code-area--edit")).toBeTruthy();
			expect(container.querySelector(".code-area--preview")).toBeTruthy();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = origRect;
		}
	});

	it("hides the split chip when the pane is narrow", () => {
		render(<ShellHarness />);
		expect(screen.queryByRole("tab", { name: "Split" })).toBeNull();
	});
});
