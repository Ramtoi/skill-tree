import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect, useState, type ReactNode } from "react";
import {
	render,
	screen,
	fireEvent,
	cleanup,
	waitFor,
} from "@testing-library/react";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";

function Harness({
	dirty = false,
	saveDisabled = false,
	onSave = () => {},
	readOnly = false,
	initialMode = "edit" as DocMode,
	detailsAttention = null as
		| { level: "error" | "warning"; count?: number }
		| null,
	headerActions,
}: {
	dirty?: boolean;
	saveDisabled?: boolean;
	onSave?: () => void;
	readOnly?: boolean;
	initialMode?: DocMode;
	detailsAttention?: { level: "error" | "warning"; count?: number } | null;
	headerActions?: ReactNode;
}) {
	const [content, setContent] = useState("# hello\n\nbody");
	const [mode, setMode] = useState<DocMode>(initialMode);
	return (
		<DocumentEditorShell
			content={content}
			onContentChange={setContent}
			readOnly={readOnly}
			mode={mode}
			onModeChange={setMode}
			diffOriginal={"# hello\n\nbody"}
			dirty={dirty}
			onSave={onSave}
			saveDisabled={saveDisabled}
			detailsAttention={detailsAttention}
			headerActions={headerActions}
			toolbar={<div className="md-toolbar" data-testid="toolbar" />}
			sidePanel={<div data-testid="side-panel">SIDE</div>}
			dangerZone={<div data-testid="danger">DANGER</div>}
			splitStorageKey="test:shell"
		/>
	);
}

beforeEach(() => cleanup());

describe("DocumentEditorShell", () => {
	it("renders the toolbar, side panel, and danger-zone slots", () => {
		render(<Harness />);
		expect(screen.getByTestId("toolbar")).toBeInTheDocument();
		expect(screen.getByTestId("side-panel")).toBeInTheDocument();
		expect(screen.getByTestId("danger")).toBeInTheDocument();
	});

	// One band, not two: the formatting verbs lead the bar's LEFT cluster (at the
	// gutter) and the mode chips sit in the RIGHT cluster ahead of Save — not a
	// second strip above the body.
	it("anchors the toolbar left and the mode chips right, ahead of Save", () => {
		const { container } = render(<Harness />);
		const left = container.querySelector(".doc-editor-bar-left")!;
		const right = container.querySelector(".doc-editor-bar-right")!;
		const toolbar = screen.getByTestId("toolbar");
		expect(left.contains(toolbar)).toBe(true);
		expect(left.firstElementChild).toBe(toolbar);
		const tablist = container.querySelector('[role="tablist"]')!;
		expect(right.contains(tablist)).toBe(true);
		const save = screen.getByRole("button", { name: /Save/ });
		expect(
			tablist.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// The body column carries no strip of its own any more.
		expect(container.querySelector(".editor-main")!.contains(toolbar)).toBe(false);
	});

	// The Details panel runs from the header down: the bar is INSIDE the editor
	// column (the split's left pane), never a full-width band above the split.
	it("keeps the bar inside the editor column beside a full-height side panel", () => {
		const { container } = render(<Harness />);
		const pane = container.querySelector(".doc-editor-pane")!;
		const bar = container.querySelector(".doc-editor-bar")!;
		const side = screen.getByTestId("side-panel");
		expect(pane.contains(bar)).toBe(true);
		expect(pane.contains(container.querySelector(".editor-main")!)).toBe(true);
		expect(pane.contains(side)).toBe(false);
		// Both panes hang off the same split.
		const split = pane.closest(".editor-grid")!;
		expect(split.contains(side)).toBe(true);
	});

	it("shows the toolbar only while the caret can be edited (edit/split)", () => {
		render(<Harness />);
		expect(screen.getByTestId("toolbar")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
		expect(screen.queryByTestId("toolbar")).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
		expect(screen.queryByTestId("toolbar")).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
		expect(screen.getByTestId("toolbar")).toBeInTheDocument();
	});

	it("hides the toolbar for a read-only document", () => {
		render(<Harness readOnly />);
		expect(screen.queryByTestId("toolbar")).toBeNull();
	});

	// The standalone UNSAVED pill was replaced by a dot ON the Save button, so
	// the unsaved state lives where the fix for it is (one affordance).
	it("carries the unsaved state as a dot on Save, not a separate pill", () => {
		const { container, rerender } = render(<Harness dirty={false} />);
		expect(screen.queryByText("UNSAVED")).toBeNull();
		expect(container.querySelector(".btn-signal")).toBeNull();
		expect(screen.getByRole("button", { name: /Saved/ })).toBeDisabled();

		rerender(<Harness dirty={true} />);
		// The pill is gone for good — it must not come back alongside the dot.
		expect(screen.queryByText("UNSAVED")).toBeNull();
		const save = screen.getByRole("button", { name: /Save/ });
		expect(save.className).toContain("btn-signal-dot");
		expect(container.querySelector(".btn-signal")).not.toBeNull();
		expect(save).toHaveAttribute("title", "Unsaved changes");
	});

	// The document loads async, so its content lands as a prop change AFTER
	// mount. That reconciliation must NOT be reported as a user edit — otherwise
	// every editor comes up already dirty and the Save dot is permanently lit.
	it("does not report an externally-driven content change as an edit", async () => {
		const onContentChange = vi.fn();
		function Loader() {
			const [content, setContent] = useState("");
			// Stand in for the async read_skill_document resolution.
			useEffect(() => {
				setContent("# loaded from disk\n");
			}, []);
			return (
				<DocumentEditorShell
					content={content}
					onContentChange={onContentChange}
					mode="edit"
					onModeChange={() => {}}
					diffOriginal=""
					dirty={false}
					onSave={() => {}}
					splitStorageKey="test:shell-loader"
				/>
			);
		}
		const { container } = render(<Loader />);
		await waitFor(() =>
			expect(container.querySelector(".cm-content")?.textContent).toContain(
				"loaded from disk",
			),
		);
		expect(onContentChange).not.toHaveBeenCalled();
	});

	it("renders headerActions in the bar, before the Save button", () => {
		const { container } = render(
			<Harness
				dirty
				headerActions={<button data-testid="export-action">Export</button>}
			/>,
		);
		const action = screen.getByTestId("export-action");
		expect(action).toBeInTheDocument();
		const right = container.querySelector(".doc-editor-bar-right");
		expect(right?.contains(action)).toBe(true);
		// Ordering matters: document verbs sit left of the primary Save.
		const buttons = Array.from(
			right!.querySelectorAll<HTMLElement>("button"),
		);
		const save = screen.getByRole("button", { name: /Save/ });
		expect(buttons.indexOf(action)).toBeLessThan(buttons.indexOf(save));
	});

	it("keeps headerActions visible in read-only mode (where Save is hidden)", () => {
		render(
			<Harness
				readOnly
				headerActions={<button data-testid="export-action">Export</button>}
			/>,
		);
		expect(screen.getByTestId("export-action")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
	});

	it("⌘S calls onSave when dirty and not saveDisabled", () => {
		const onSave = vi.fn();
		render(<Harness dirty onSave={onSave} />);
		fireEvent.keyDown(window, { key: "s", metaKey: true });
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("⌘S does NOT save when not dirty", () => {
		const onSave = vi.fn();
		render(<Harness dirty={false} onSave={onSave} />);
		fireEvent.keyDown(window, { key: "s", metaKey: true });
		expect(onSave).not.toHaveBeenCalled();
	});

	it("⌘S does NOT save when saveDisabled", () => {
		const onSave = vi.fn();
		render(<Harness dirty saveDisabled onSave={onSave} />);
		fireEvent.keyDown(window, { key: "s", metaKey: true });
		expect(onSave).not.toHaveBeenCalled();
	});

	it("mode chips switch the editor pane", () => {
		const { container } = render(<Harness />);
		// Preview chip → the preview pane renders (renderMarkdown → .md-prose).
		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
		expect(container.querySelector(".code-area--preview")).toBeTruthy();
		// Diff chip → the diff pane renders.
		fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
		expect(container.querySelector(".code-area--diff")).toBeTruthy();
	});

	it("does not offer the split chip when the pane is narrow (gated by width)", () => {
		// jsdom's ResizeObserver is a no-op stub → measured width is 0 → not wide.
		render(<Harness />);
		expect(screen.queryByRole("tab", { name: "Split" })).toBeNull();
	});

	// C1: at 520 the bar's two clusters could not share one row, and the action
	// cluster was painted ON TOP of the trailing mode chip — Diff sliced in half,
	// Split unreachable. Nothing may be dropped or covered: every offered mode
	// stays present AND clickable while the actions stay in their own cluster
	// (the bar wraps them onto a second row).
	it("keeps every offered mode chip reachable alongside the action cluster", async () => {
		const realRO = globalThis.ResizeObserver;
		// Report a pane wide enough that all four modes (incl. Split) are offered.
		// Delivered async: the shell re-measures synchronously right after
		// `observe()` (jsdom reports 0), so a sync callback would be overwritten.
		class WideRO {
			constructor(private cb: ResizeObserverCallback) {}
			observe(target: Element) {
				setTimeout(() => {
					this.cb(
						[
							{
								target,
								contentRect: { width: 900 },
							} as unknown as ResizeObserverEntry,
						],
						this as unknown as ResizeObserver,
					);
				}, 0);
			}
			unobserve() {}
			disconnect() {}
		}
		globalThis.ResizeObserver = WideRO as unknown as typeof ResizeObserver;
		try {
			const { container } = render(
				<Harness
					dirty
					headerActions={<button data-testid="export-action">Export</button>}
				/>,
			);

			await screen.findByRole("tab", { name: "Split" });

			const left = container.querySelector(".doc-editor-bar-left")!;
			const right = container.querySelector(".doc-editor-bar-right")!;
			// Two sibling clusters — neither nests in (and so neither can cover) the
			// other; the bar is what wraps them.
			expect(left.parentElement).toBe(right.parentElement);
			expect(left.contains(right)).toBe(false);

			for (const label of ["Edit", "Preview", "Diff", "Split"]) {
				const tab = screen.getByRole("tab", { name: label });
				expect(right.contains(tab)).toBe(true);
				fireEvent.click(tab);
				// role=tab carries selection via aria-selected; aria-pressed is a
				// role=button attribute and was invalid on a tab.
				expect(tab).toHaveAttribute("aria-selected", "true");
				expect(tab).not.toHaveAttribute("aria-pressed");
			}
			// The actions did not displace a mode chip to make room.
			expect(right.contains(screen.getByTestId("export-action"))).toBe(true);
			expect(right.contains(screen.getByRole("button", { name: /Save/ }))).toBe(
				true,
			);
		} finally {
			globalThis.ResizeObserver = realRO;
		}
	});

	it("hides the Save button in read-only mode", () => {
		render(<Harness readOnly />);
		expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
	});

	// B4b-02: the collapsed Details tab must reflect a blocking/attention state.
	// The shell stamps `data-details-attention` (which the CSS renders as a dot on
	// the reopen tab) and exposes an accessible live-region announcement.
	it("surfaces a details-attention signal when a level is passed", () => {
		const { container, rerender } = render(<Harness />);
		const shell = () => container.querySelector(".doc-editor-shell");
		expect(shell()?.getAttribute("data-details-attention")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();

		rerender(<Harness detailsAttention={{ level: "error" }} />);
		expect(shell()?.getAttribute("data-details-attention")).toBe("error");
		expect(screen.getByRole("status")).toBeInTheDocument();

		rerender(<Harness detailsAttention={{ level: "warning" }} />);
		expect(shell()?.getAttribute("data-details-attention")).toBe("warning");

		rerender(<Harness detailsAttention={null} />);
		expect(shell()?.getAttribute("data-details-attention")).toBeNull();
	});
});
