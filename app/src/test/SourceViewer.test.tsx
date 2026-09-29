import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourceViewer, type SourceFile } from "@/components/hooks/SourceViewer";

// Wave D: SourceViewer is the extraction of the built-in file-tab strip +
// read-only body panel — shared by the built-in's real source AND a command
// hook's detected script file(s). These tests pin the CONTRACT (tabs, arrow
// nav, null-body fallback, resetKey) independent of either call site.

const TWO_FILES: SourceFile[] = [
	{ id: "a", label: "a.sh", body: "#!/bin/bash\necho a\n" },
	{ id: "b", label: "b.sh", body: "#!/bin/bash\necho b\n" },
];

describe("SourceViewer", () => {
	it("renders nothing for an empty file list", () => {
		const { container } = render(
			<SourceViewer files={[]} idPrefix="empty" ariaLabel="empty files" />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders one tab per file, the first selected, its body in the panel", async () => {
		render(<SourceViewer files={TWO_FILES} idPrefix="src" ariaLabel="Files" />);

		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((t) => t.textContent)).toEqual(["a.sh", "b.sh"]);
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");

		const panel = screen.getByRole("tabpanel");
		expect(panel).toHaveAttribute("id", "src-panel");
		expect(tabs[0]).toHaveAttribute("aria-controls", "src-panel");
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo a"),
		);
	});

	it("clicking a tab swaps the displayed body", async () => {
		render(<SourceViewer files={TWO_FILES} idPrefix="src" ariaLabel="Files" />);
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo a"),
		);

		fireEvent.click(screen.getByRole("tab", { name: "b.sh" }));
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo b"),
		);
		expect(screen.getByRole("tab", { name: "b.sh" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("Right/Left arrow keys move the selection and focus, wrapping at the ends", async () => {
		render(<SourceViewer files={TWO_FILES} idPrefix="src" ariaLabel="Files" />);
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo a"),
		);

		const first = screen.getByRole("tab", { name: "a.sh" });
		fireEvent.keyDown(first, { key: "ArrowRight" });
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo b"),
		);
		const second = screen.getByRole("tab", { name: "b.sh" });
		expect(second).toHaveAttribute("aria-selected", "true");
		expect(second).toHaveFocus();

		// Wraps past the last file back to the first.
		fireEvent.keyDown(second, { key: "ArrowRight" });
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo a"),
		);
		expect(screen.getByRole("tab", { name: "a.sh" })).toHaveFocus();

		fireEvent.keyDown(screen.getByRole("tab", { name: "a.sh" }), { key: "ArrowLeft" });
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo b"),
		);
		expect(screen.getByRole("tab", { name: "b.sh" })).toHaveFocus();
	});

	it("a null body renders the default unreadable fallback, not an empty editor", () => {
		render(
			<SourceViewer
				files={[{ id: "a", label: "a.sh", body: null }]}
				idPrefix="src"
				ariaLabel="Files"
			/>,
		);
		expect(screen.getByText("Could not read a.sh.")).toBeInTheDocument();
		expect(screen.getByRole("tabpanel")).not.toHaveClass("hook-script-body");
		expect(document.querySelector(".cm-content")).toBeNull();
	});

	it("a null body honors a custom missingText over the default fallback", () => {
		render(
			<SourceViewer
				files={[
					{ id: "a", label: "example-app", body: null, missingText: "Not present in example-app." },
				]}
				idPrefix="src"
				ariaLabel="Files"
			/>,
		);
		expect(screen.getByText("Not present in example-app.")).toBeInTheDocument();
		expect(screen.queryByText("Could not read example-app.")).toBeNull();
	});

	it("resets the selected tab to the first file when resetKey changes", async () => {
		const { rerender } = render(
			<SourceViewer files={TWO_FILES} idPrefix="src" ariaLabel="Files" resetKey="hook-a" />,
		);
		await waitFor(() =>
			expect(document.querySelector(".cm-content")?.textContent).toContain("echo a"),
		);
		fireEvent.click(screen.getByRole("tab", { name: "b.sh" }));
		await waitFor(() =>
			expect(screen.getByRole("tab", { name: "b.sh" })).toHaveAttribute(
				"aria-selected",
				"true",
			),
		);

		rerender(
			<SourceViewer files={TWO_FILES} idPrefix="src" ariaLabel="Files" resetKey="hook-b" />,
		);
		await waitFor(() =>
			expect(screen.getByRole("tab", { name: "a.sh" })).toHaveAttribute(
				"aria-selected",
				"true",
			),
		);
	});
});
