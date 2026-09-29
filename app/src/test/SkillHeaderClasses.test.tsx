import { it, expect, vi, afterEach } from "vitest";
import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";
import { SkillHeaderClasses } from "@/components/skillEditor/SkillHeaderClasses";
import type { ClassificationContribution } from "@/lib/skillClassification";

// `SkillHeaderClasses` has no vitest importer today. The journey
// `skill-header-classes.journey.spec.ts` stays for its real-width geometry
// (widths 1100/1800/760, the resize walk), but the two non-geometry checks
// it also carries get a component-test counterpart here so the behavior is
// caught without a browser: "skill header fits classes on resize and
// exposes every class on hover and keyboard" (~:3, the hover/keyboard half)
// and "fitting classes have no overflow control" (~:49).

const ITEMS: ClassificationContribution[] = [
	{ value: "implementation", provenance: "direct", contributors: [] },
	{ value: "backend", provenance: "assigned", contributors: [] },
	{ value: "frontend", provenance: "indirect", contributors: [] },
	{ value: "android", provenance: "direct", contributors: [] },
	{ value: "review", provenance: "indirect", contributors: [] },
];

/**
 * The component decides overflow purely from `getBoundingClientRect` widths
 * read inside a `useLayoutEffect` (never CSS): it sums the hidden
 * `.skill-header-class-measure-value` row's per-chip widths against the
 * visible strip's own width, and reserves the trailing
 * `.skill-header-classes-more` chip's width as the "..." budget. jsdom lays
 * out nothing (TESTS.md §6), so every real element reports a 0×0 rect unless
 * a test fakes it — this mocks exactly the rects the component itself reads,
 * nothing about the CSS that would produce them in a browser.
 */
function mockMeasurements(opts: { availableWidth: number; chipWidth: number; moreWidth?: number }) {
	const { availableWidth, chipWidth, moreWidth = 32 } = opts;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
		this: HTMLElement,
	) {
		const empty = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
		if (this.classList.contains("skill-header-classes") && !this.classList.contains("skill-header-classes-measure")) {
			return { ...empty, width: availableWidth };
		}
		if (this.classList.contains("skill-header-classes-more")) {
			return { ...empty, width: moreWidth };
		}
		if (this.classList.contains("skill-header-class-measure-value")) {
			return { ...empty, width: chipWidth };
		}
		return empty;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	cleanup();
});

it("exposes every class on hover and keyboard focus when classes overflow", () => {
	// 5 chips at 150px each (750px) against a 300px strip forces overflow —
	// only the first chip fits alongside the reserved "..." budget.
	mockMeasurements({ availableWidth: 300, chipWidth: 150 });

	render(<SkillHeaderClasses items={ITEMS} onInspect={() => {}} />);

	const more = screen.getByRole("button", { name: "Show all classes" });
	expect(more).toBeVisible();
	expect(screen.queryByRole("dialog", { name: "All classes" })).not.toBeInTheDocument();

	// Hover opens the panel and lists every item, not just the ones that fit.
	fireEvent.mouseEnter(more);
	const hoverPanel = screen.getByRole("dialog", { name: "All classes" });
	expect(hoverPanel).toBeVisible();
	for (const item of ITEMS) {
		expect(within(hoverPanel).getByRole("button", { name: new RegExp(`^${item.value},`) })).toBeVisible();
	}

	fireEvent.mouseLeave(more);
	fireEvent.blur(more);

	// Keyboard focus (no relatedTarget inside the popover) opens it too.
	fireEvent.focus(more);
	const focusPanel = screen.getByRole("dialog", { name: "All classes" });
	expect(focusPanel).toBeVisible();
	for (const item of ITEMS) {
		expect(within(focusPanel).getByRole("button", { name: new RegExp(`^${item.value},`) })).toBeVisible();
	}
});

it("fitting classes have no overflow control", () => {
	// 5 chips at 40px each (200px) fit inside a 1000px strip with room to
	// spare — no chip needs to be hidden behind "...".
	mockMeasurements({ availableWidth: 1000, chipWidth: 40 });

	render(<SkillHeaderClasses items={ITEMS} onInspect={() => {}} />);

	expect(screen.queryByRole("button", { name: "Show all classes" })).not.toBeInTheDocument();
	for (const item of ITEMS) {
		expect(screen.getByRole("button", { name: new RegExp(`^${item.value},`) })).toBeVisible();
	}
});
