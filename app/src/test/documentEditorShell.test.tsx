import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
}: {
	dirty?: boolean;
	saveDisabled?: boolean;
	onSave?: () => void;
	readOnly?: boolean;
	initialMode?: DocMode;
	detailsAttention?: { level: "error" | "warning"; count?: number } | null;
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

	it("shows the UNSAVED pill iff dirty", () => {
		const { rerender } = render(<Harness dirty={false} />);
		expect(screen.queryByText("UNSAVED")).toBeNull();
		rerender(<Harness dirty={true} />);
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
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
