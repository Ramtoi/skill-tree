import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "@/components/Select";

const OPTIONS = [
	{ value: "global", label: "global", hint: "Everywhere" },
	{ value: "portable", label: "portable", hint: "Per-project" },
	{ value: "project-specific", label: "project-specific" },
] as const;

type V = (typeof OPTIONS)[number]["value"];

function renderSelect(value: V = "global", onChange = vi.fn<(v: V) => void>()) {
	const utils = render(
		<Select value={value} options={OPTIONS} onChange={onChange} label="Scope" title="reach" />,
	);
	return { ...utils, onChange, trigger: screen.getByRole("combobox", { name: "Scope" }) };
}

describe("Select", () => {
	it("is a closed button carrying the current value, with no menu in the DOM", () => {
		const { trigger } = renderSelect();
		expect(trigger).toHaveTextContent("global");
		expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(trigger).toHaveAttribute("title", "reach");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("opens on click, marks the chosen option, and picks with a click", async () => {
		const { trigger, onChange } = renderSelect();
		await userEvent.click(trigger);
		const list = screen.getByRole("listbox", { name: "Scope" });
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(3);
		expect(options[0]).toHaveAttribute("aria-selected", "true");
		expect(options[1]).toHaveAttribute("aria-selected", "false");
		expect(list).toHaveTextContent("Per-project");
		await userEvent.click(options[1]);
		expect(onChange).toHaveBeenCalledWith("portable");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("does not fire onChange when the current value is re-picked", async () => {
		const { trigger, onChange } = renderSelect();
		await userEvent.click(trigger);
		await userEvent.click(screen.getAllByRole("option")[0]);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("steers with the keyboard while the trigger keeps focus", async () => {
		const { trigger, onChange } = renderSelect("portable");
		trigger.focus();
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		// Cursor starts on the current value.
		const active = () => screen.getAllByRole("option").findIndex((o) => o.hasAttribute("data-active"));
		expect(active()).toBe(1);
		expect(trigger.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(active()).toBe(2);
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(active()).toBe(0);
		fireEvent.keyDown(trigger, { key: "End" });
		expect(active()).toBe(2);
		fireEvent.keyDown(trigger, { key: "Home" });
		expect(active()).toBe(0);
		// Typeahead jumps to the next label starting with the letter.
		fireEvent.keyDown(trigger, { key: "p" });
		expect(active()).toBe(1);
		fireEvent.keyDown(trigger, { key: "p" });
		expect(active()).toBe(2);
		fireEvent.keyDown(trigger, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith("project-specific");
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(document.activeElement).toBe(trigger);
	});

	it("Escape and an outside press close without picking", async () => {
		const { trigger, onChange } = renderSelect();
		trigger.focus();
		fireEvent.keyDown(trigger, { key: " " });
		expect(screen.getByRole("listbox")).toBeInTheDocument();
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		fireEvent.keyDown(trigger, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		await userEvent.click(trigger);
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("stays shut when disabled", async () => {
		render(<Select value="global" options={OPTIONS} onChange={vi.fn()} label="Scope" disabled />);
		const trigger = screen.getByRole("combobox", { name: "Scope" });
		expect(trigger).toBeDisabled();
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("owns the keyboard while open: a typeahead letter never reaches the window", async () => {
		const seen: string[] = [];
		const spy = (e: KeyboardEvent) => seen.push(e.key);
		window.addEventListener("keydown", spy);
		const { trigger } = renderSelect();
		trigger.focus();
		fireEvent.keyDown(trigger, { key: "g" }); // closed: falls through
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		fireEvent.keyDown(trigger, { key: "g" }); // open: a `g …` chord must not arm
		fireEvent.keyDown(trigger, { key: "/" });
		window.removeEventListener("keydown", spy);
		expect(seen).toEqual(["g", "ArrowDown"]); // closed keys fall through (the window ignores ArrowDown)
	});

	it("focuses the trigger on a mouse open, so the keys work in WKWebView", async () => {
		const { trigger } = renderSelect();
		fireEvent.click(trigger);
		expect(document.activeElement).toBe(trigger);
		expect(screen.getByRole("listbox")).toBeInTheDocument();
	});

	// AUDIT M8: a value outside `options` (a backend vocabulary the frontend's
	// hand-maintained mirror hasn't caught up with) used to silently render
	// `options[0]`'s label — a WRONG value on screen while the form state
	// still holds the real one.
	describe("a value outside the option set (AUDIT M8)", () => {
		it("shows the RAW value, never the first option's label", () => {
			const { trigger } = renderSelect("archived" as V);
			expect(trigger).toHaveTextContent("archived");
			expect(trigger).not.toHaveTextContent("global");
			expect(trigger).toHaveAttribute("data-unknown", "true");
		});

		it("marks no option as selected, and picking a real one still fires onChange", async () => {
			const { trigger, onChange } = renderSelect("archived" as V);
			await userEvent.click(trigger);
			for (const opt of screen.getAllByRole("option")) {
				expect(opt).toHaveAttribute("aria-selected", "false");
			}
			await userEvent.click(screen.getByRole("option", { name: /^portable\b/ }));
			expect(onChange).toHaveBeenCalledWith("portable");
		});

		it("every in-set value is unaffected (data-unknown absent)", () => {
			const { trigger } = renderSelect("portable");
			expect(trigger).not.toHaveAttribute("data-unknown");
			expect(trigger).toHaveTextContent("portable");
		});
	});

	describe("upward flip near the bottom of the screen", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("renders no menu at all — and so no data-placement — while closed", () => {
			renderSelect();
			expect(screen.queryByRole("listbox")).toBeNull();
			expect(document.querySelector("[data-placement]")).toBeNull();
		});

		it("defaults to bottom placement", async () => {
			const { trigger } = renderSelect();
			await userEvent.click(trigger);
			expect(screen.getByRole("listbox")).toHaveAttribute("data-placement", "bottom");
		});

		function rect(partial: Partial<DOMRect>): DOMRect {
			return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {}, ...partial };
		}

		// Keyed off the tag rather than call order — `getBoundingClientRect`
		// may be read for other elements along the way (e.g. `scrollIntoView`
		// machinery), and call-order pairing would be fragile against that.
		function mockRects(trigger: Partial<DOMRect>, menu: Partial<DOMRect>) {
			vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
				this: Element,
			) {
				if (this.tagName === "BUTTON") return rect(trigger);
				if (this.tagName === "UL") return rect(menu);
				return rect({});
			});
		}

		it("flips to top when the trigger sits near the bottom and the menu would overflow", async () => {
			mockRects(
				{ top: window.innerHeight - 40, bottom: window.innerHeight - 20 },
				{ height: 200 },
			);
			const { trigger } = renderSelect();
			await userEvent.click(trigger);
			expect(screen.getByRole("listbox")).toHaveAttribute("data-placement", "top");
		});

		it("stays bottom when the trigger is near the top with no room above, even if it overflows below", async () => {
			mockRects({ top: 10, bottom: 30 }, { height: 5000 });
			const { trigger } = renderSelect();
			await userEvent.click(trigger);
			expect(screen.getByRole("listbox")).toHaveAttribute("data-placement", "bottom");
		});
	});

	describe("a leading icon (opt.leading)", () => {
		const withLeading = [
			{ value: "a", label: "alpha", leading: <span data-testid="lead-a">A</span> },
			{ value: "b", label: "beta" },
		] as const;

		it("renders in the option row for an option that carries one", async () => {
			render(<Select value="a" options={withLeading} onChange={vi.fn()} label="Pick" />);
			await userEvent.click(screen.getByRole("combobox", { name: "Pick" }));
			const options = screen.getAllByRole("option");
			expect(within(options[0]).getByTestId("lead-a")).toBeInTheDocument();
			expect(options[0]).toHaveAttribute("data-leading", "");
		});

		it("options without one carry no leading cell", async () => {
			render(<Select value="a" options={withLeading} onChange={vi.fn()} label="Pick" />);
			await userEvent.click(screen.getByRole("combobox", { name: "Pick" }));
			const options = screen.getAllByRole("option");
			expect(options[1]).not.toHaveAttribute("data-leading");
			expect(options[1].querySelector(".select-option-leading")).toBeNull();
		});

		it("is decorative — the option's accessible name stays the label", async () => {
			// The wrapper cell carries `aria-hidden`, so a caller passing a node
			// with its own text/label (not just a decorative HarnessGlyph) can
			// never make an option announce as "A alpha".
			const noisy = [
				{ value: "a", label: "alpha", leading: <span aria-label="Alpha brand">A</span> },
			] as const;
			render(<Select value="a" options={noisy} onChange={vi.fn()} label="Pick" />);
			await userEvent.click(screen.getByRole("combobox", { name: "Pick" }));
			const option = screen.getByRole("option");
			expect(option).toHaveAccessibleName("alpha");
			expect(option.querySelector(".select-option-leading")).toHaveAttribute("aria-hidden", "true");
		});

		it("keeps aria-activedescendant pointing at the option's own id past the extra cell", async () => {
			render(<Select value="a" options={withLeading} onChange={vi.fn()} label="Pick" />);
			const trigger = screen.getByRole("combobox", { name: "Pick" });
			await userEvent.click(trigger);
			const options = screen.getAllByRole("option");
			expect(trigger).toHaveAttribute("aria-activedescendant", options[0].id);
			fireEvent.keyDown(trigger, { key: "ArrowDown" });
			expect(trigger).toHaveAttribute("aria-activedescendant", options[1].id);
		});

		it("shows the selected option's leading node on the closed trigger", () => {
			const { container, rerender } = render(
				<Select value="a" options={withLeading} onChange={vi.fn()} label="Pick" />,
			);
			const trigger = screen.getByRole("combobox", { name: "Pick" });
			expect(within(trigger).getByTestId("lead-a")).toBeInTheDocument();

			// Selecting the option with no leading node drops the trigger's cell.
			rerender(<Select value="b" options={withLeading} onChange={vi.fn()} label="Pick" />);
			expect(container.querySelector(".select-trigger-leading")).toBeNull();
		});
	});
});
