import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidePanelSection, readSectionState } from "@/components/SidePanelSection";

// `forceOpen` must not be a live control that quietly mutates persisted
// state. While forced, a press on the head is a no-op — it neither flips
// the section closed nor writes the reader's own preference — and once the
// force lifts, the LAST real toggle (or the stored preference) is what the
// reader sees, not whatever the forced state happened to be. `aria-expanded`
// must always match the real (visible) state.

const KEY = "st:test:sections";

describe("SidePanelSection — forceOpen", () => {
	beforeEach(() => localStorage.clear());

	it("shows the body and a truthful aria-expanded while forced, even if the user never opened it", () => {
		render(
			<SidePanelSection id="advanced" title="Advanced" defaultOpen={false} forceOpen>
				<div>body content</div>
			</SidePanelSection>,
		);
		const head = screen.getByTestId("side-section-advanced");
		expect(head).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("body content")).toBeInTheDocument();
	});

	it("disables the toggle while forced and names why", () => {
		render(
			<SidePanelSection id="advanced" title="Advanced" defaultOpen={false} forceOpen>
				<div>body content</div>
			</SidePanelSection>,
		);
		const head = screen.getByTestId("side-section-advanced");
		expect(head).toBeDisabled();
		expect(head).toHaveAttribute(
			"title",
			"Has unsaved changes — stays open until saved.",
		);
	});

	it("forced section: click does not persist, section stays open, and after force lifts the stored preference wins", () => {
		const { rerender } = render(
			<SidePanelSection
				id="advanced"
				title="Advanced"
				defaultOpen={false}
				forceOpen
				storageKey={KEY}
			>
				<div>body content</div>
			</SidePanelSection>,
		);

		const head = screen.getByTestId("side-section-advanced");
		expect(head).toHaveAttribute("aria-expanded", "true");
		expect(head).toBeDisabled();
		expect(screen.getByText("body content")).toBeInTheDocument();

		// A press while forced is a no-op: nothing persists, the section stays
		// open, `aria-expanded` stays honest. (`disabled` means a real browser
		// would never even dispatch the click — fired here anyway to prove the
		// handler itself is inert, not just unreachable.)
		fireEvent.click(head);
		expect(head).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("body content")).toBeInTheDocument();
		expect(readSectionState(KEY)).toEqual({});

		// Force lifts — the reader never toggled it, so the persisted map is
		// still empty and `defaultOpen={false}` wins: closed.
		rerender(
			<SidePanelSection
				id="advanced"
				title="Advanced"
				defaultOpen={false}
				forceOpen={false}
				storageKey={KEY}
			>
				<div>body content</div>
			</SidePanelSection>,
		);
		expect(screen.getByTestId("side-section-advanced")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(screen.queryByText("body content")).toBeNull();
	});

	it("a real toggle while NOT forced does persist, and survives a later force/unforce cycle", () => {
		const { rerender } = render(
			<SidePanelSection
				id="advanced"
				title="Advanced"
				defaultOpen={false}
				forceOpen={false}
				storageKey={KEY}
			>
				<div>body content</div>
			</SidePanelSection>,
		);

		fireEvent.click(screen.getByTestId("side-section-advanced"));
		expect(screen.getByText("body content")).toBeInTheDocument();
		expect(readSectionState(KEY)).toEqual({ advanced: true });

		// Force engages, then lifts — the reader's own "open" preference
		// (persisted above) is what remains, not the forced state's shadow.
		rerender(
			<SidePanelSection
				id="advanced"
				title="Advanced"
				defaultOpen={false}
				forceOpen
				storageKey={KEY}
			>
				<div>body content</div>
			</SidePanelSection>,
		);
		rerender(
			<SidePanelSection
				id="advanced"
				title="Advanced"
				defaultOpen={false}
				forceOpen={false}
				storageKey={KEY}
			>
				<div>body content</div>
			</SidePanelSection>,
		);
		expect(screen.getByTestId("side-section-advanced")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("a real (non-forced) toggle still writes through and persists", () => {
		render(
			<SidePanelSection id="settings" title="Settings" defaultOpen={false} storageKey={KEY}>
				<div>body content</div>
			</SidePanelSection>,
		);
		fireEvent.click(screen.getByTestId("side-section-settings"));
		expect(readSectionState(KEY)).toEqual({ settings: true });
		expect(screen.getByTestId("side-section-settings")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});
});
