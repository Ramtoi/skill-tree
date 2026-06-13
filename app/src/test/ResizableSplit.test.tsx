import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResizableSplit } from "@/components/ResizableSplit";

function renderLeft(storageKey = "st:test:left") {
	return render(
		<ResizableSplit
			storageKey={storageKey}
			defaultLeftPx={304}
			minLeftPx={220}
			maxLeftPx={600}
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
			left={<div>L</div>}
			right={<div>R</div>}
		/>,
	);
}

function grid(): HTMLElement {
	return document.querySelector(".resizable-split") as HTMLElement;
}

describe("ResizableSplit", () => {
	beforeEach(() => {
		window.localStorage.clear();
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
});
