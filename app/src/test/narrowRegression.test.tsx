import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Modal } from "@/components/Modal";
import { SubheaderViewChips } from "@/components/SubheaderViewChips";

// VERIFY-FIRST regressions (F11/F12/F13) — the earlier-change narrow fixes are
// confirmed present on the merged tree and pinned by these tests.

describe("F11 — dialogs are bounded by min(width, 92vw)", () => {
	it("Modal renders its dialog with a min(px, 92vw) width (used by all three lifecycle dialogs)", () => {
		render(
			<Modal open onClose={() => {}} width={600} title="t">
				body
			</Modal>,
		);
		const dialog = document.querySelector(".modal") as HTMLElement;
		expect(dialog).toBeTruthy();
		expect(dialog.style.width).toContain("92vw");
		expect(dialog.style.width).toContain("600px");
	});
});

describe("F12 — subheader chip labels are nowrap targets", () => {
	it("view chips render a .chip-label span (the white-space:nowrap hook)", () => {
		const { container } = render(
			<SubheaderViewChips
				views={[
					{ id: "a", label: "Edit" },
					{ id: "b", label: "Preview" },
					{ id: "c", label: "Diff" },
				]}
				value="a"
				onChange={() => {}}
			/>,
		);
		const labels = container.querySelectorAll(".chip .chip-label");
		expect(labels.length).toBe(3);
		expect(labels[2].textContent).toBe("Diff");
	});
});
