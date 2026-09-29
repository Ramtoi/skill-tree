import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResizableSplit } from "@/components/ResizableSplit";

function renderLeft(storageKey = "st:test:left") {
	return render(
		<ResizableSplit
			storageKey={storageKey}
			defaultLeftPx={304}
			minLeftPx={220}
			maxLeftPx={600}
			paneLabel="Map"
			left={<div>L</div>}
			right={<div>R</div>}
		/>,
	);
}

function renderRight(storageKey = "st:test:right") {
	return render(
		<ResizableSplit
			storageKey={storageKey}
			fixedPane="right"
			defaultRightPx={360}
			minRightPx={280}
			maxRightPx={560}
			paneLabel="Details"
			left={<div>L</div>}
			right={<div>R</div>}
		/>,
	);
}

function grid(): HTMLElement {
	return document.querySelector(".resizable-split") as HTMLElement;
}

/**
 * jsdom has no real layout: `getBoundingClientRect().width` is always 0, so the
 * component's synchronous ResizeObserver prime keeps `tooNarrow` false (docked).
 * To exercise auto-collapse we stub the prototype's getBoundingClientRect so the
 * container reports a concrete width — the smallest seam that drives the real
 * `containerWidth < fixedPx + minMainPx` branch through its production path.
 */
function setContainerWidth(width: number) {
	vi
		.spyOn(HTMLDivElement.prototype, "getBoundingClientRect")
		.mockReturnValue({
			width,
			height: 600,
			top: 0,
			left: 0,
			right: width,
			bottom: 600,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect);
}

describe("ResizableSplit", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("left-fixed (default) puts the fixed px in the first column", () => {
		renderLeft();
		expect(grid().style.gridTemplateColumns).toBe("304px 6px 1fr");
	});

	it("right-fixed puts the fixed px in the last column", () => {
		renderRight();
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 360px");
	});

	it("re-clamps a stale stored value above max on mount (left)", () => {
		window.localStorage.setItem("st:test:left", "9999");
		renderLeft();
		expect(grid().style.gridTemplateColumns).toBe("600px 6px 1fr");
	});

	it("re-clamps a stale stored value below min on mount (right)", () => {
		window.localStorage.setItem("st:test:right", "10");
		renderRight();
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 280px");
	});

	it("restores a valid stored value", () => {
		window.localStorage.setItem("st:test:right", "420");
		renderRight();
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 420px");
	});

	it("ArrowRight grows the left pane and persists (left-fixed)", () => {
		renderLeft();
		const handle = screen.getByRole("separator");
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(grid().style.gridTemplateColumns).toBe("312px 6px 1fr");
		expect(window.localStorage.getItem("st:test:left")).toBe("312");
	});

	it("ArrowLeft shrinks the left pane (left-fixed)", () => {
		renderLeft();
		const handle = screen.getByRole("separator");
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(grid().style.gridTemplateColumns).toBe("296px 6px 1fr");
	});

	it("ArrowLeft grows the right pane (right-fixed) — splitter moves left", () => {
		renderRight();
		const handle = screen.getByRole("separator");
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 368px");
		expect(window.localStorage.getItem("st:test:right")).toBe("368");
	});

	it("ArrowRight shrinks the right pane (right-fixed)", () => {
		renderRight();
		const handle = screen.getByRole("separator");
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 352px");
	});

	it("Home/End jump to the fixed pane's min/max", () => {
		renderRight();
		const handle = screen.getByRole("separator");
		fireEvent.keyDown(handle, { key: "End" });
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 560px");
		fireEvent.keyDown(handle, { key: "Home" });
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 280px");
	});

	it("aria-valuenow reflects the fixed pane width", () => {
		renderRight();
		const handle = screen.getByRole("separator");
		expect(handle.getAttribute("aria-valuenow")).toBe("360");
		expect(handle.getAttribute("aria-valuemin")).toBe("280");
		expect(handle.getAttribute("aria-valuemax")).toBe("560");
	});

	// ── Collapse / auto-collapse behavior ──────────────────────────────────

	it("docks (resizable, no reopen tab) when the container is wide enough", () => {
		// 360 fixed + 440 minMain = 800; container 1440 ≥ 800 → docked.
		setContainerWidth(1440);
		renderRight();
		expect(grid().classList.contains("is-docked")).toBe(true);
		expect(screen.getByRole("separator")).toBeInTheDocument();
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 360px");
		expect(
			document.querySelector(".resizable-split-reopen"),
		).toBeNull();
		// Collapse affordance is present while docked-open.
		expect(
			screen.getByRole("button", { name: /collapse details/i }),
		).toBeInTheDocument();
	});

	it("auto-collapses when container width < fixedPx + minMainPx (right-fixed)", () => {
		// 360 + 440 = 800; container 520 < 800 → tooNarrow.
		setContainerWidth(520);
		renderRight();
		expect(grid().classList.contains("is-collapsed")).toBe(true);
		// Main takes the single full-width column; no crushed 1-char fixed column.
		expect(grid().style.gridTemplateColumns).toBe("1fr");
		// No resize handle while overlaid/collapsed.
		expect(screen.queryByRole("separator")).toBeNull();
		// A reopen tab is visible at the edge.
		const tab = screen.getByRole("button", { name: /open details/i });
		expect(tab).toBeInTheDocument();
		expect(tab.className).toContain("rs-right");
	});

	it("auto-collapses for a left-fixed pane too, with a left-edge tab", () => {
		// 304 + 440 = 744; container 600 < 744 → tooNarrow.
		setContainerWidth(600);
		renderLeft();
		expect(grid().classList.contains("is-collapsed")).toBe(true);
		const tab = screen.getByRole("button", { name: /open map/i });
		expect(tab.className).toContain("rs-left");
	});

	it("opens an overlay (with scrim) when the reopen tab is clicked while too narrow", () => {
		setContainerWidth(520);
		renderRight();
		const tab = screen.getByRole("button", { name: /open details/i });
		fireEvent.click(tab);
		// Overlay pane is rendered, scrim present, main still full width.
		const overlay = document.querySelector(".resizable-split-overlay");
		expect(overlay).not.toBeNull();
		expect(document.querySelector(".resizable-split-scrim")).not.toBeNull();
		expect(grid().style.gridTemplateColumns).toBe("1fr");
		// Overlay width is clamped to <= containerWidth - 48.
		const w = Number.parseInt((overlay as HTMLElement).style.width, 10);
		expect(w).toBeLessThanOrEqual(520 - 48);
		expect(w).toBeGreaterThanOrEqual(280); // >= min
	});

	it("closes the overlay via the scrim and via Escape", () => {
		setContainerWidth(520);
		renderRight();
		fireEvent.click(screen.getByRole("button", { name: /open details/i }));
		expect(document.querySelector(".resizable-split-overlay")).not.toBeNull();
		// Scrim click closes.
		fireEvent.click(
			document.querySelector(".resizable-split-scrim") as HTMLElement,
		);
		expect(document.querySelector(".resizable-split-overlay")).toBeNull();
		// Reopen, then Escape closes.
		fireEvent.click(screen.getByRole("button", { name: /open details/i }));
		expect(document.querySelector(".resizable-split-overlay")).not.toBeNull();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(document.querySelector(".resizable-split-overlay")).toBeNull();
	});

	it("manual collapse hides the fixed pane, persists, and a reopen tab restores it (docked)", () => {
		setContainerWidth(1440);
		renderRight("st:test:collapse");
		// Collapse.
		fireEvent.click(
			screen.getByRole("button", { name: /collapse details/i }),
		);
		expect(grid().classList.contains("is-collapsed")).toBe(true);
		expect(grid().style.gridTemplateColumns).toBe("1fr");
		expect(screen.queryByRole("separator")).toBeNull();
		expect(window.localStorage.getItem("st:test:collapse:collapsed")).toBe("1");
		// Reopen tab restores the docked grid.
		fireEvent.click(screen.getByRole("button", { name: /open details/i }));
		expect(grid().classList.contains("is-docked")).toBe(true);
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 360px");
		expect(window.localStorage.getItem("st:test:collapse:collapsed")).toBe("0");
	});

	it("restores a persisted collapsed=1 choice on mount (docked + collapsed)", () => {
		setContainerWidth(1440);
		window.localStorage.setItem("st:test:persisted:collapsed", "1");
		render(
			<ResizableSplit
				storageKey="st:test:persisted"
				fixedPane="right"
				defaultRightPx={360}
				minRightPx={280}
				maxRightPx={560}
				paneLabel="Details"
				left={<div>L</div>}
				right={<div>R</div>}
			/>,
		);
		expect(grid().classList.contains("is-collapsed")).toBe(true);
		expect(
			screen.getByRole("button", { name: /open details/i }),
		).toBeInTheDocument();
	});

	it("keeps resize working while docked + open (collapsible default)", () => {
		setContainerWidth(1440);
		renderRight();
		const handle = screen.getByRole("separator");
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(grid().style.gridTemplateColumns).toBe("1fr 6px 368px");
		expect(window.localStorage.getItem("st:test:right")).toBe("368");
	});

	it("collapsible={false} never collapses even when narrow", () => {
		setContainerWidth(300);
		render(
			<ResizableSplit
				storageKey="st:test:nocollapse"
				fixedPane="right"
				defaultRightPx={360}
				minRightPx={280}
				maxRightPx={560}
				collapsible={false}
				left={<div>L</div>}
				right={<div>R</div>}
			/>,
		);
		expect(grid().classList.contains("is-docked")).toBe(true);
		expect(screen.getByRole("separator")).toBeInTheDocument();
		expect(
			document.querySelector(".resizable-split-collapse"),
		).toBeNull();
	});
});
