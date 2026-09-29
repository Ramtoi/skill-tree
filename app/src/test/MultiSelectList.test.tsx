import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MultiSelectList } from "@/components/MultiSelectList";

function options() {
	return [
		{ id: "a", label: "Alpha", selected: true },
		{ id: "b", label: "Beta", selected: false },
		{ id: "c", label: "Gamma", selected: false, disabled: true, title: "locked" },
	];
}

describe("MultiSelectList", () => {
	it("is a listbox with one option per row, aria-selected reflecting the caller's state", () => {
		const onToggle = vi.fn();
		render(<MultiSelectList label="Test list" options={options()} onToggle={onToggle} />);

		const list = screen.getByRole("listbox", { name: "Test list" });
		expect(list).toHaveAttribute("aria-multiselectable", "true");
		const rows = screen.getAllByRole("option");
		expect(rows).toHaveLength(3);
		expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute(
			"aria-selected",
			"false",
		);
	});

	it("requires an accessible name so two lists never share one", () => {
		render(<MultiSelectList label="Harnesses" options={options()} onToggle={vi.fn()} />);
		expect(screen.getByRole("listbox", { name: "Harnesses" })).toBeInTheDocument();
	});

	it("a click toggles the row", () => {
		const onToggle = vi.fn();
		render(<MultiSelectList label="Test list" options={options()} onToggle={onToggle} />);
		fireEvent.click(screen.getByRole("option", { name: "Beta" }));
		expect(onToggle).toHaveBeenCalledWith("b");
	});

	it("a disabled row never toggles, on click or keyboard, but stays focusable with its title", () => {
		const onToggle = vi.fn();
		render(<MultiSelectList label="Test list" options={options()} onToggle={onToggle} />);
		const gamma = screen.getByRole("option", { name: "Gamma" });
		expect(gamma).toHaveAttribute("aria-disabled", "true");
		expect(gamma).toHaveAttribute("title", "locked");
		expect(gamma).toHaveAttribute("tabindex", "-1"); // not the roving cursor by default, but reachable

		fireEvent.click(gamma);
		expect(onToggle).not.toHaveBeenCalled();

		fireEvent.focus(gamma);
		fireEvent.keyDown(gamma, { key: "Enter" });
		expect(onToggle).not.toHaveBeenCalled();
		fireEvent.keyDown(gamma, { key: " " });
		expect(onToggle).not.toHaveBeenCalled();
	});

	describe("keyboard — roving tabindex", () => {
		it("ArrowDown/ArrowUp move focus; only the focused row is tabbable", () => {
			render(<MultiSelectList label="Test list" options={options()} onToggle={vi.fn()} />);
			const [alpha, beta] = screen.getAllByRole("option");
			expect(alpha).toHaveAttribute("tabindex", "0");
			expect(beta).toHaveAttribute("tabindex", "-1");

			fireEvent.keyDown(alpha, { key: "ArrowDown" });
			expect(beta).toHaveAttribute("tabindex", "0");
			expect(alpha).toHaveAttribute("tabindex", "-1");

			fireEvent.keyDown(beta, { key: "ArrowUp" });
			expect(alpha).toHaveAttribute("tabindex", "0");
		});

		it("Home/End jump to the first/last row", () => {
			render(<MultiSelectList label="Test list" options={options()} onToggle={vi.fn()} />);
			const rows = screen.getAllByRole("option");
			fireEvent.keyDown(rows[0], { key: "End" });
			expect(rows[2]).toHaveAttribute("tabindex", "0");
			fireEvent.keyDown(rows[2], { key: "Home" });
			expect(rows[0]).toHaveAttribute("tabindex", "0");
		});

		it("Space and Enter toggle the focused (enabled) row", () => {
			const onToggle = vi.fn();
			render(<MultiSelectList label="Test list" options={options()} onToggle={onToggle} />);
			const [alpha] = screen.getAllByRole("option");
			fireEvent.keyDown(alpha, { key: " " });
			expect(onToggle).toHaveBeenCalledWith("a");
			fireEvent.keyDown(alpha, { key: "Enter" });
			expect(onToggle).toHaveBeenCalledTimes(2);
		});

		it("ArrowDown at the last row and ArrowUp at the first are no-ops (clamped, not wrapped)", () => {
			render(<MultiSelectList label="Test list" options={options()} onToggle={vi.fn()} />);
			const rows = screen.getAllByRole("option");
			// Move the cursor away from the first row before pressing ArrowUp,
			// so the clamp assertion below can't pass merely because the cursor
			// never left row 0 (a deleted ArrowUp handler would leave it there
			// too, since End+Home already parks it back at row 0).
			fireEvent.keyDown(rows[0], { key: "End" });
			fireEvent.keyDown(rows[2], { key: "Home" });
			expect(rows[0]).toHaveAttribute("tabindex", "0");
			fireEvent.keyDown(rows[0], { key: "ArrowUp" });
			expect(rows[0]).toHaveAttribute("tabindex", "0");
			fireEvent.keyDown(rows[0], { key: "End" });
			fireEvent.keyDown(rows[2], { key: "ArrowDown" });
			expect(rows[2]).toHaveAttribute("tabindex", "0");
		});
	});

	it("renders the glyph and meta slots when given", () => {
		render(
			<MultiSelectList
				label="Test list"
				onToggle={vi.fn()}
				options={[
					{
						id: "a",
						label: "Alpha",
						selected: true,
						glyph: <span data-testid="glyph">G</span>,
						meta: <span data-testid="meta">will fire</span>,
					},
				]}
			/>,
		);
		expect(screen.getByTestId("glyph")).toBeInTheDocument();
		expect(screen.getByTestId("meta")).toBeInTheDocument();
	});
});
