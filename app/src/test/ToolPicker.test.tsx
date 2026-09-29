import { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToolPicker } from "@/components/ToolPicker";
import { hookToolGroups } from "@/lib/hookCatalog";
import { focusScreenSearch } from "@/lib/focusScreenSearch";
import { sampleRegistry } from "./helpers";
import type { Registry } from "@/types";

// The tool picker replaced a flat ~50-checkbox grid (hook-editor-redesign D2).
// Progressive disclosure only works if the things it hides stay REACHABLE — a
// token that is collapsed AND unfindable is worse than the wall it replaced,
// because the user concludes the vocabulary doesn't contain it and reaches for
// the raw-matcher escape hatch instead.

const GROUPS = hookToolGroups(sampleRegistry as Registry);

function Harness({ initial = [] as string[] }) {
	const [value, setValue] = useState<string[]>(initial);
	return (
		<>
			<ToolPicker value={value} onChange={setValue} groups={GROUPS} />
			<div data-testid="value">{value.join(",")}</div>
		</>
	);
}

const value = () => screen.getByTestId("value").textContent;

describe("ToolPicker — groups + collapse", () => {
	afterEach(cleanup);

	it("opens with Common expanded and every other group collapsed", () => {
		render(<Harness />);
		// Common is the curated 90% list — it is the whole point of the group.
		expect(screen.getByRole("checkbox", { name: "Edit" })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Bash" })).toBeInTheDocument();
		// A member of a non-Common group is not rendered until it is expanded.
		expect(screen.queryByRole("checkbox", { name: "NotebookEdit" })).toBeNull();
		expect(
			screen.getByRole("button", { name: /Files/ }),
		).toHaveAttribute("aria-expanded", "false");
	});

	it("expanding a group reveals its tools and the header reports the count", () => {
		render(<Harness />);
		fireEvent.click(screen.getByRole("button", { name: /Files/ }));
		expect(screen.getByRole("checkbox", { name: "NotebookEdit" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Files/ })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("a group header shows selected/total once something in it is picked", () => {
		render(<Harness initial={["NotebookEdit"]} />);
		// 1 of the 3 Files tools is selected — the count has to say so while the
		// group is COLLAPSED, or the selection is invisible.
		expect(screen.getByRole("button", { name: /Files/ })).toHaveTextContent("1/3");
	});
});

describe("ToolPicker — filter", () => {
	afterEach(cleanup);

	it("finds a token buried in a collapsed group (the collapse is never a hiding place)", () => {
		render(<Harness />);
		expect(screen.queryByRole("checkbox", { name: "mcp__fs-mcp" })).toBeNull();
		fireEvent.change(screen.getByPlaceholderText("Filter tools…"), {
			target: { value: "fs-mcp" },
		});
		expect(screen.getByRole("checkbox", { name: "mcp__fs-mcp" })).toBeInTheDocument();
		// Non-matching groups drop out entirely rather than showing empty headers.
		expect(screen.queryByRole("checkbox", { name: "Edit" })).toBeNull();
	});

	it("is case-insensitive and reports an honest empty state", () => {
		render(<Harness />);
		const filter = screen.getByPlaceholderText("Filter tools…");
		fireEvent.change(filter, { target: { value: "websearch" } });
		expect(screen.getByRole("checkbox", { name: "WebSearch" })).toBeInTheDocument();

		fireEvent.change(filter, { target: { value: "zzzz" } });
		expect(screen.getByText(/No tool matches/)).toBeInTheDocument();
	});

	it("keeps a selected-but-filtered-out tool visible as a chip", () => {
		render(<Harness initial={["Edit"]} />);
		fireEvent.change(screen.getByPlaceholderText("Filter tools…"), {
			target: { value: "websearch" },
		});
		// The chip row is the source of truth for "what this hook matches"; a
		// filter must never make the picker misreport the saved selection.
		expect(screen.getByRole("button", { name: "Remove Edit" })).toBeInTheDocument();
	});
});

describe("ToolPicker — selection", () => {
	afterEach(cleanup);

	it("selecting a tool adds a removable chip and the chip removes it again", () => {
		render(<Harness />);
		expect(screen.getByText(/No tools selected yet/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("checkbox", { name: "Bash" }));
		expect(value()).toBe("Bash");
		const remove = screen.getByRole("button", { name: "Remove Bash" });

		fireEvent.click(remove);
		expect(value()).toBe("");
		expect(screen.getByRole("checkbox", { name: "Bash" })).not.toBeChecked();
	});

	it("preserves selection ORDER (it is what gets written to the registry)", () => {
		render(<Harness />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Write" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Bash" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Edit" }));
		expect(value()).toBe("Write,Bash,Edit");
	});

	it("de-selecting one tool leaves the others alone", () => {
		render(<Harness initial={["Edit", "Write", "Bash"]} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Write" }));
		expect(value()).toBe("Edit,Bash");
	});

	it("disabled: no remove affordance and toggling changes nothing", () => {
		function Disabled() {
			const [v, setV] = useState<string[]>(["Edit"]);
			return (
				<>
					<ToolPicker value={v} onChange={setV} groups={GROUPS} disabled />
					<div data-testid="value">{v.join(",")}</div>
				</>
			);
		}
		render(<Disabled />);
		expect(screen.queryByRole("button", { name: "Remove Edit" })).toBeNull();
		fireEvent.click(screen.getByRole("checkbox", { name: "Bash" }));
		expect(value()).toBe("Edit");
	});
});

describe("ToolPicker — the `/` hint is not decorative", () => {
	afterEach(cleanup);

	it("registers the filter as the screen search so `/` actually focuses it", () => {
		const { container } = render(<Harness />);
		// COMPONENTS.md: a rendered `/` kbd hint has to work. The picker's filter
		// is the only search box the hook editor shows, and it exists exactly when
		// the picker does.
		expect(container.querySelector(".tool-picker .slash")).not.toBeNull();
		expect(focusScreenSearch(container)).toBe(true);
		expect(document.activeElement).toBe(
			container.querySelector(".tool-picker-search input"),
		);
	});
});
